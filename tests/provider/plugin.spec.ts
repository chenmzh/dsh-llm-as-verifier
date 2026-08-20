import { describe, expect, it, vi } from 'vitest'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { TrajectoryAdapter, VerifierTrackerId } from 'dsh-llm-as-verifier/core'
import type {
  AgentStep,
  CanonicalTrajectory,
  VerifierCandidate,
} from 'dsh-llm-as-verifier/core'
import {
  DEFAULT_VERIFIER_API_KEY_ENV,
  DEFAULT_VERIFIER_BASE_URL,
  DEFAULT_VERIFIER_TRANSPORT,
  LLMAsVerifierPlugin,
  probeFailureReason,
  resolveConfig,
  VERIFIER_MODEL,
  VerifierBackendError,
} from 'dsh-llm-as-verifier/provider'
import type {
  Config,
  LLMAsVerifierPluginOptions,
  VerifierGateway,
  WorkerRequest,
} from 'dsh-llm-as-verifier/provider'

class FakeGateway implements VerifierGateway {
  readonly requests: WorkerRequest[] = []
  readonly dispose = vi.fn(async () => {})
  responses: unknown[] = []
  delaysMs: number[] = []

  async request(request: WorkerRequest): Promise<unknown> {
    this.requests.push(request)
    const delayMs = this.delaysMs.shift()
    if (delayMs !== undefined) await new Promise(resolve => setTimeout(resolve, delayMs))
    const response = this.responses.shift()
    if (response instanceof Error) throw response
    if (typeof response === 'object' && response !== null && 'throwValue' in response) {
      throw response.throwValue
    }
    return response
  }
}

describe('capability failure classification', () => {
  it('reports missing Python runtime dependencies without leaking import details', () => {
    expect(probeFailureReason(new VerifierBackendError(
      'ModuleNotFoundError',
      "No module named 'llm_verifier'",
    ))).toBe('PYTHON_DEPENDENCY_MISSING')
    expect(probeFailureReason(new VerifierBackendError(
      'ImportError',
      'cannot import a transitive dependency from a local path',
    ))).toBe('PYTHON_DEPENDENCY_MISSING')
  })
})

const usage = {
  calls: 2,
  input_tokens: 10,
  cached_input_tokens: 3,
  output_tokens: 4,
  reasoning_tokens: 1,
}

const selectionResponse = (
  scores: readonly [number, number],
  operationUsage: typeof usage = usage,
): Record<string, unknown> => ({
  selected_index: scores[0] >= scores[1] ? 0 : 1,
  scores,
  ranking: scores[0] >= scores[1] ? [0, 1] : [1, 0],
  usage: operationUsage,
})

const selectionTelemetryResponse = (
  scores: readonly number[],
  calls: number,
  comparisons: number,
  plannedCalls = calls,
): Record<string, unknown> => {
  const ranking = scores.map((_, index) => index)
    .sort((left, right) => scores[right]! - scores[left]! || left - right)
  return {
    selected_index: ranking[0],
    scores,
    ranking,
    usage: {
      calls,
      input_tokens: calls * 10,
      cached_input_tokens: calls * 3,
      output_tokens: calls * 4,
      reasoning_tokens: calls,
    },
    details: {
      telemetry: {
        comparisons,
        planned_comparisons: comparisons,
        planned_verifier_calls: plannedCalls,
        criteria_count: 1,
        n_evaluations: 1,
      },
    },
  }
}

const step = (index: number, message = `step ${index}`): AgentStep => ({
  index,
  turn: 1,
  step: index,
  assistantMessage: message,
  tools: [],
})

const trajectory = (answer: string): CanonicalTrajectory => ({
  steps: [step(1, answer)],
  finalAnswer: answer,
  outcome: { kind: 'completed' },
})

function setup(
  gateway: FakeGateway,
  overrides: Partial<LLMAsVerifierPluginOptions> = {},
): LLMAsVerifierPlugin {
  return new LLMAsVerifierPlugin({
    gateway,
    adapter: new TrajectoryAdapter({ maxFieldBytes: 1_000, maxTrajectoryBytes: 10_000 }),
    maxWorkers: 1,
    criteria: { Correctness: 'Did it work?', Verification: 'Was it tested?' },
    nEvaluations: 4,
    pivots: 2,
    confidence: { mediumGap: 0.03, highGap: 0.10, targetLevel: 'high' },
    adaptive: {
      enabled: false,
      stages: [{
        nEvaluations: 1,
        criteria: { Correctness: 'Did it work?', Verification: 'Was it tested?' },
      }],
    },
    budget: { maxCalls: 32, maxLatencyMs: 45_000 },
    strict: false,
    progress: { enabled: true, nEvaluations: 1 },
    logger: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  })
}

describe('LLMAsVerifierPlugin', () => {
  it('scores canonical steps through llm_verifier.track and maps metadata', async () => {
    const gateway = new FakeGateway()
    gateway.responses.push({ score: 0.82, usage, details: { checkpoint_steps: [1] } })
    const result = await setup(gateway).score('Fix the bug', trajectory('done'))
    expect(result).toMatchObject({
      score: 0.82,
      metadata: {
        backend: 'llm-as-a-verifier',
        model: VERIFIER_MODEL,
        usage: {
          calls: 2,
          inputTokens: 10,
          cachedInputTokens: 3,
          outputTokens: 4,
          reasoningTokens: 1,
        },
        details: { checkpoint_steps: [1] },
      },
    })
    expect(result.metadata.latencyMs).toBeTypeOf('number')
    expect(gateway.requests[0]).toMatchObject({
      operation: 'score',
      problem: 'Fix the bug',
      model: VERIFIER_MODEL,
      n_evaluations: 4,
    })
    expect(gateway.requests[0]!.steps).toEqual([
      expect.stringContaining('Assistant:\ndone'),
      'Final answer:\ndone',
    ])

    gateway.responses.push({ score: 0.5 }, { score: 0.6 })
    await setup(gateway).score('task', { steps: [step(1, 'only step')] })
    const adapter = new TrajectoryAdapter({ maxFieldBytes: 1_000, maxTrajectoryBytes: 10_000 })
    vi.spyOn(adapter, 'serializeStep').mockReturnValue('Final answer:\nalready present')
    await setup(gateway, { adapter }).score('task', {
      steps: [step(1)],
      finalAnswer: 'already present',
    })
    expect(gateway.requests.at(-2)!.steps).toEqual([expect.stringContaining('only step')])
    expect(gateway.requests.at(-1)!.steps).toEqual(['Final answer:\nalready present'])
  })

  it('maps pairwise candidates in order and reports the preferred index', async () => {
    const gateway = new FakeGateway()
    gateway.responses.push({ scores: [0.2, 0.8], usage })
    const result = await setup(gateway).compare('task', trajectory('A'), trajectory('B'))
    expect(result.scores).toEqual([0.2, 0.8])
    expect(result.preferredIndex).toBe(1)
    expect(gateway.requests[0]).toMatchObject({
      operation: 'compare',
    })
    expect(gateway.requests[0]?.candidate_a).toEqual(expect.stringContaining('A'))
    expect(gateway.requests[0]?.candidate_b).toEqual(expect.stringContaining('B'))
  })

  it('preserves original identity and returns the validated selected index', async () => {
    const gateway = new FakeGateway()
    gateway.responses.push({
      selected_index: 1,
      scores: [0.25, 0.75],
      ranking: [1, 0],
      usage,
      details: { n_comparisons: 3 },
    })
    const originals = [{ name: 'a' }, { name: 'b' }]
    const candidates: VerifierCandidate<{ name: string }>[] = originals.map(original => ({
      original,
      trajectory: trajectory(original.name),
    }))
    const result = await setup(gateway).select('task', candidates)
    expect(result.selectedIndex).toBe(1)
    expect(result.bestCandidate).toBe(originals[1])
    expect(result.selectedTrajectory).toBe(candidates[1]!.trajectory)
    expect(result.ranking).toEqual([1, 0])
    expect(result.confidence).toEqual({
      level: 'high',
      topScore: 0.75,
      secondScore: 0.25,
      scoreGap: 0.5,
      needsMoreVerification: false,
    })
    expect(result.verification).toMatchObject({
      adaptive: false,
      stagesExecuted: 1,
      stoppedReason: 'fixed',
    })
  })

  it('reports full relative separation when selection has one candidate', async () => {
    const gateway = new FakeGateway()
    gateway.responses.push({
      selected_index: 0,
      scores: [0.4],
      ranking: [0],
    })
    const original = { name: 'only' }
    const result = await setup(gateway).select('task', [{
      original,
      trajectory: trajectory('only'),
    }])
    expect(result.bestCandidate).toBe(original)
    expect(result.confidence).toEqual({
      level: 'high',
      topScore: 0.4,
      scoreGap: 1,
      needsMoreVerification: false,
    })
  })

  it('keeps fixed low-confidence selection to one operation', async () => {
    const gateway = new FakeGateway()
    gateway.responses.push(selectionResponse([0.501, 0.499]))
    const result = await setup(gateway).select('task', [0, 1].map(original => ({
      original, trajectory: trajectory(String(original)),
    })))
    expect(result.confidence).toMatchObject({ level: 'low', needsMoreVerification: true })
    expect(result.verification?.stoppedReason).toBe('fixed')
    expect(gateway.requests).toHaveLength(1)
  })

  it('stops adaptive verification after a high-confidence first stage', async () => {
    const gateway = new FakeGateway()
    gateway.responses.push(selectionResponse([0.81, 0.42]))
    const plugin = setup(gateway, {
      adaptive: {
        enabled: true,
        stages: [
          { nEvaluations: 1, criteria: { Correctness: 'Did it work?' } },
          { nEvaluations: 2, criteria: { Correctness: 'Did it work?' } },
        ],
      },
    })
    const candidates = [0, 1].map(original => ({
      original, trajectory: trajectory(String(original)),
    }))
    const result = await plugin.select('task', candidates)
    expect(result.confidence).toMatchObject({
      level: 'high', needsMoreVerification: false,
    })
    expect(result.confidence?.scoreGap).toBeCloseTo(0.39)
    expect(result.verification).toMatchObject({
      adaptive: true, stagesExecuted: 1, stoppedReason: 'confident',
    })
    expect(gateway.requests.map(request => request.operation)).toEqual(['select', 'release_cache'])
  })

  it('can treat medium relative confidence as sufficient without calling it correctness probability', async () => {
    const gateway = new FakeGateway()
    gateway.responses.push(selectionResponse([0.525, 0.475]))
    const criteria = { Correctness: 'Did it work?' }
    const result = await setup(gateway, {
      confidence: { mediumGap: 0.03, highGap: 0.10, targetLevel: 'medium' },
      adaptive: {
        enabled: true,
        stages: [1, 2].map(nEvaluations => ({ nEvaluations, criteria })),
      },
    }).select('task', [0, 1].map(original => ({
      original, trajectory: trajectory(String(original)),
    })))
    expect(result.confidence).toMatchObject({
      level: 'medium', needsMoreVerification: false, topScore: 0.525, secondScore: 0.475,
    })
    expect(result.verification?.stoppedReason).toBe('confident')
    expect(JSON.parse(JSON.stringify(result.confidence))).toEqual(result.confidence)
  })

  it('escalates a low-confidence stage and stops when the next stage resolves it', async () => {
    const gateway = new FakeGateway()
    gateway.responses.push(
      selectionResponse([0.501, 0.499]),
      selectionResponse([0.8, 0.2], { ...usage, calls: 3 }),
    )
    const criteria = { Correctness: 'Did it work?' }
    const plugin = setup(gateway, {
      adaptive: {
        enabled: true,
        stages: [
          { nEvaluations: 1, criteria },
          { nEvaluations: 2, criteria },
          { nEvaluations: 4, criteria },
        ],
      },
    })
    const result = await plugin.select('task', [0, 1].map(original => ({
      original, trajectory: trajectory(String(original)),
    })))
    expect(result.confidence).toMatchObject({ level: 'high' })
    expect(result.confidence?.scoreGap).toBeCloseTo(0.6)
    expect(result.verification).toMatchObject({
      stagesExecuted: 2,
      stoppedReason: 'confident',
      usage: { calls: 5, inputTokens: 20, outputTokens: 8, reasoningTokens: 2 },
    })
    const selections = gateway.requests.filter(request => request.operation === 'select')
    expect(selections).toHaveLength(2)
    expect(selections.map(request => request.n_evaluations)).toEqual([1, 2])
    expect(selections[0]!.cache_id).toBeTypeOf('string')
    expect(selections[1]!.cache_id).toBe(selections[0]!.cache_id)
    expect(gateway.requests.at(-1)).toEqual({
      operation: 'release_cache', cache_id: selections[0]!.cache_id,
    })
  })

  it('reports unresolved confidence after all adaptive stages', async () => {
    const gateway = new FakeGateway()
    gateway.responses.push(
      selectionResponse([0.501, 0.499]),
      selectionResponse([0.51, 0.49]),
      selectionResponse([0.5001, 0.4999]),
    )
    const criteria = { Correctness: 'Did it work?' }
    const result = await setup(gateway, {
      adaptive: {
        enabled: true,
        stages: [1, 2, 4].map(nEvaluations => ({ nEvaluations, criteria })),
      },
    }).select('task', [0, 1].map(original => ({
      original, trajectory: trajectory(String(original)),
    })))
    expect(result.confidence).toMatchObject({ level: 'low', needsMoreVerification: true })
    expect(result.verification).toMatchObject({
      stagesExecuted: 3, stoppedReason: 'stages_exhausted',
    })
  })

  it('does not escalate a clear top-two result because lower-ranked candidates are close', async () => {
    const gateway = new FakeGateway()
    gateway.responses.push(selectionTelemetryResponse([0.8, 0.65, 0.649], 6, 6))
    const result = await setup(gateway, {
      reasoningEffort: 'low',
      adaptive: {
        enabled: true,
        strategy: 'top-two',
        stages: [],
        top2GapThreshold: 0.08,
        additionalEvaluations: 1,
        maxExtraCalls: 8,
        escalationReasoningEffort: 'high',
      },
    }).select('task', [0, 1, 2].map(original => ({
      original, trajectory: trajectory(String(original)),
    })))
    expect(gateway.requests.map(request => request.operation)).toEqual(['select', 'release_cache'])
    expect(gateway.requests[0]).toMatchObject({ reasoning_effort: 'low' })
    expect(result.verification).toMatchObject({
      stoppedReason: 'confident',
      baseline: {
        comparisons: 6,
        reasoningEffort: 'low',
        usage: { calls: 6, reasoningTokens: 6 },
      },
      adaptiveDecision: {
        strategy: 'top-two',
        stage1Top1: 0,
        stage1Top2: 1,
        escalationTriggered: false,
        extraComparisons: 0,
        finalWinnerChanged: false,
        finalRankingChanged: false,
      },
    })
    expect(result.verification?.adaptiveDecision?.stage1Gap).toBeCloseTo(0.15)
  })

  it('escalates only the top pair in both slot orientations and separates its cost', async () => {
    const gateway = new FakeGateway()
    gateway.responses.push(
      selectionTelemetryResponse([0.501, 0.499, 0.1], 6, 6),
      selectionTelemetryResponse([0.4, 0.6, 0.1], 2, 2),
    )
    const result = await setup(gateway, {
      reasoningEffort: 'low',
      adaptive: {
        enabled: true,
        strategy: 'top-two',
        stages: [],
        top2GapThreshold: 0.08,
        additionalEvaluations: 1,
        maxExtraCalls: 8,
        escalationReasoningEffort: 'high',
      },
    }).select('task', [0, 1, 2].map(original => ({
      original, trajectory: trajectory(String(original)),
    })))
    const operations = gateway.requests.map(request => request.operation)
    expect(operations).toEqual(['select', 'select_escalation', 'release_cache'])
    expect(gateway.requests[1]).toMatchObject({
      reasoning_effort: 'high',
      baseline_n_evaluations: 4,
      n_evaluations: 1,
      adaptive_pairs: [[0, 1], [1, 0]],
    })
    expect(gateway.requests[1]!.cache_id).toBe(gateway.requests[0]!.cache_id)
    expect(result.selectedIndex).toBe(1)
    expect(result.verification).toMatchObject({
      usage: { calls: 8, reasoningTokens: 8 },
      baseline: { comparisons: 6, reasoningEffort: 'low', usage: { calls: 6 } },
      escalation: { comparisons: 2, reasoningEffort: 'high', usage: { calls: 2 } },
      adaptiveDecision: {
        escalationTriggered: true,
        escalationReason: 'top2_gap',
        extraComparisons: 2,
        finalWinnerChanged: true,
        finalRankingChanged: true,
      },
    })
  })

  it.each([
    ['max extra calls', {}, 1, 'max_extra_calls'],
    ['operation call budget', { maxCallsPerOperation: 7 }, 8, 'max_calls'],
  ] as const)('retains the valid baseline when %s blocks top-two escalation', async (
    _name,
    operationBudget,
    maxExtraCalls,
    stoppedReason,
  ) => {
    const gateway = new FakeGateway()
    gateway.responses.push(selectionTelemetryResponse([0.501, 0.499], 6, 3, 6))
    const result = await setup(gateway, {
      adaptive: {
        enabled: true,
        strategy: 'top-two',
        stages: [],
        top2GapThreshold: 0.08,
        additionalEvaluations: 1,
        maxExtraCalls,
        escalationReasoningEffort: 'high',
      },
      budget: { maxCalls: 32, maxLatencyMs: 45_000, ...operationBudget },
    }).select('task', [0, 1].map(original => ({
      original, trajectory: trajectory(String(original)),
    })))
    expect(result.selectedIndex).toBe(0)
    expect(result.scores).toEqual([0.501, 0.499])
    expect(result.verification).toMatchObject({
      stoppedReason,
      adaptiveDecision: {
        escalationTriggered: false,
        escalationReason: 'top2_gap',
        escalationSkippedReason: stoppedReason,
        extraComparisons: 0,
      },
    })
    expect(gateway.requests.map(request => request.operation)).toEqual(['select', 'release_cache'])
  })

  it('estimates escalation conservatively when the backend omits usage', async () => {
    const gateway = new FakeGateway()
    gateway.responses.push(
      { selected_index: 0, scores: [0.501, 0.499], ranking: [0, 1] },
      { selected_index: 0, scores: [0.8, 0.2], ranking: [0, 1] },
    )
    const criteria = { Correctness: 'Did it work?' }
    const result = await setup(gateway, {
      adaptive: {
        enabled: true,
        stages: [1, 2].map(nEvaluations => ({ nEvaluations, criteria })),
      },
      budget: {
        maxCalls: 32,
        maxLatencyMs: 45_000,
        maxInputTokens: 100,
        maxOutputTokens: 100,
        maxReasoningTokens: 100,
      },
    }).select('task', [0, 1].map(original => ({
      original, trajectory: trajectory(String(original)),
    })))
    expect(result.verification).toMatchObject({
      stagesExecuted: 2,
      stoppedReason: 'confident',
    })
    expect(result.verification?.usage).toBeUndefined()
  })

  it('fails open when a directly constructed adaptive plugin has no stages', async () => {
    const gateway = new FakeGateway()
    gateway.responses.push({})
    const result = await setup(gateway, {
      adaptive: { enabled: true, stages: [] },
    }).select('task', [0].map(original => ({
      original, trajectory: trajectory(String(original)),
    })))
    expect(result.selectedIndex).toBe(0)
    expect(result.metadata.failure).toMatchObject({ code: 'VERIFIER_FAILURE' })
    expect(result.verification).toMatchObject({
      stagesExecuted: 0,
      stoppedReason: 'stages_exhausted',
    })
    expect(gateway.requests[0]).toMatchObject({ operation: 'release_cache' })
  })

  it('contains selection-cache cleanup failure after a successful stage', async () => {
    const gateway = new FakeGateway()
    gateway.responses.push(
      selectionResponse([0.8, 0.2]),
      new Error('cleanup unavailable'),
    )
    const logger = { info: vi.fn(), warn: vi.fn() }
    const result = await setup(gateway, {
      adaptive: {
        enabled: true,
        stages: [{ nEvaluations: 1, criteria: { Correctness: 'Did it work?' } }],
      },
      logger,
    }).select('task', [0, 1].map(original => ({
      original, trajectory: trajectory(String(original)),
    })))
    expect(result.selectedIndex).toBe(0)
    expect(result.metadata.failure).toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('operation=release_cache'),
      'llm-as-a-verifier',
      VERIFIER_MODEL,
      'VERIFIER_FAILURE',
      'cleanup unavailable',
    )
  })

  it('preserves a partial ranking when call or latency budget blocks escalation', async () => {
    const criteria = { Correctness: 'Did it work?' }
    const adaptive = {
      enabled: true,
      stages: [1, 2].map(nEvaluations => ({ nEvaluations, criteria })),
    } as const
    const candidates = [0, 1].map(original => ({
      original, trajectory: trajectory(String(original)),
    }))

    const callGateway = new FakeGateway()
    callGateway.responses.push(selectionResponse([0.501, 0.499]))
    const callLimited = await setup(callGateway, {
      adaptive,
      budget: { maxCalls: 3, maxLatencyMs: 45_000 },
    }).select('task', candidates)
    expect(callLimited.selectedIndex).toBe(0)
    expect(callLimited.scores).toEqual([0.501, 0.499])
    expect(callLimited.verification?.stoppedReason).toBe('max_calls')
    expect(callGateway.requests.filter(request => request.operation === 'select')).toHaveLength(1)

    const latencyGateway = new FakeGateway()
    latencyGateway.delaysMs.push(12)
    latencyGateway.responses.push(selectionResponse([0.501, 0.499], { ...usage, calls: 1 }))
    const latencyLimited = await setup(latencyGateway, {
      adaptive,
      budget: { maxCalls: 32, maxLatencyMs: 15 },
    }).select('task', candidates)
    expect(latencyLimited.selectedIndex).toBe(0)
    expect(latencyLimited.verification?.stoppedReason).toBe('max_latency')
    expect(latencyGateway.requests.filter(request => request.operation === 'select')).toHaveLength(1)
  })

  it.each([
    ['maxInputTokens', 15, 'max_input_tokens'],
    ['maxOutputTokens', 7, 'max_output_tokens'],
    ['maxReasoningTokens', 1, 'max_reasoning_tokens'],
  ] as const)('stops before escalation at the %s budget', async (field, limit, reason) => {
    const gateway = new FakeGateway()
    gateway.responses.push(selectionResponse([0.501, 0.499]))
    const criteria = { Correctness: 'Did it work?' }
    const result = await setup(gateway, {
      adaptive: {
        enabled: true,
        stages: [1, 2].map(nEvaluations => ({ nEvaluations, criteria })),
      },
      budget: { maxCalls: 32, maxLatencyMs: 45_000, [field]: limit },
    }).select('task', [0, 1].map(original => ({
      original, trajectory: trajectory(String(original)),
    })))
    expect(result.verification?.stoppedReason).toBe(reason)
    expect(gateway.requests.filter(request => request.operation === 'select')).toHaveLength(1)
  })

  it('retains the last successful stage when a later verifier stage fails open', async () => {
    const gateway = new FakeGateway()
    gateway.responses.push(
      selectionResponse([0.501, 0.499]),
      new Error('stage two unavailable'),
    )
    const criteria = { Correctness: 'Did it work?' }
    const result = await setup(gateway, {
      adaptive: {
        enabled: true,
        stages: [1, 2].map(nEvaluations => ({ nEvaluations, criteria })),
      },
    }).select('task', [0, 1].map(original => ({
      original, trajectory: trajectory(String(original)),
    })))
    expect(result.selectedIndex).toBe(0)
    expect(result.scores).toEqual([0.501, 0.499])
    expect(result.confidence).toMatchObject({ level: 'low', needsMoreVerification: true })
    expect(result.verification).toMatchObject({
      stagesExecuted: 2,
      stoppedReason: 'verifier_error',
      stages: [
        { confidence: { level: 'low' } },
        { failure: { code: 'VERIFIER_FAILURE', message: 'stage two unavailable' } },
      ],
    })
    expect(result.metadata.failure?.code).toBe('VERIFIER_FAILURE')
  })

  it('feeds progress steps in order, scores the trajectory, then resets the tracker', async () => {
    const gateway = new FakeGateway()
    gateway.responses.push(
      { score: 0.1, step_index: 1, usage },
      { score: 0.6, step_index: 2, usage },
      { score: 0.9, usage },
      { usage },
    )
    const plugin = setup(gateway)
    const trackerId = VerifierTrackerId('session:1')
    const first = await plugin.onStepEnd('task', { steps: [step(1)] }, step(1), { trackerId })
    const second = await plugin.onStepEnd(
      'task',
      { steps: [step(1), step(2)] },
      step(2),
      { trackerId },
    )
    const final = await plugin.onTrajectoryEnd('task', trajectory('done'), { trackerId })
    expect([first?.score, second?.score, final.score]).toEqual([0.1, 0.6, 0.9])
    expect(gateway.requests.map(request => request.operation)).toEqual([
      'progress', 'progress', 'score', 'reset',
    ])
    expect(gateway.requests.slice(0, 2).map(request => request.step)).toEqual([
      expect.stringContaining('step 1'),
      expect.stringContaining('step 2'),
    ])
  })

  it('returns fail-open results and the first original candidate on backend failure', async () => {
    const gateway = new FakeGateway()
    gateway.responses.push(
      new VerifierBackendError('MissingAPIKeyError', 'No API key configured'),
      new Error('selection unavailable'),
    )
    const logger = { info: vi.fn(), warn: vi.fn() }
    const plugin = setup(gateway, { logger })
    const scoreResult = await plugin.score('task', trajectory('a'))
    expect(scoreResult.score).toBeUndefined()
    expect(scoreResult.metadata.failure).toEqual({
      code: 'MissingAPIKeyError', message: 'No API key configured',
    })
    const originals = [{ id: 0 }, { id: 1 }]
    const selection = await plugin.select('task', originals.map(original => ({
      original, trajectory: trajectory(String(original.id)),
    })))
    expect(selection.selectedIndex).toBe(0)
    expect(selection.bestCandidate).toBe(originals[0])
    expect(selection.metadata.failure?.code).toBe('VERIFIER_FAILURE')
    expect(logger.info).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      'verifier: backend=%s model=%s verificationFailed=true fallbackCandidate=%d retainedPartial=%s failureCode=%s',
      'llm-as-a-verifier',
      VERIFIER_MODEL,
      0,
      'false',
      'VERIFIER_FAILURE',
    )
  })

  it('applies fail-open and strict policy to score-position capability failures', async () => {
    const probeDetails = {
      model: VERIFIER_MODEL,
      finish_reason: 'stop',
      output_tokens: 10,
      reasoning_tokens: 4,
      logprobs_present: false,
      score_token_present: true,
      failure_reason: 'LOGPROBS_UNAVAILABLE',
    }
    const failure = new VerifierBackendError(
      'VerifierCapabilityError',
      'Missing usable A-T probabilities at <score_A>',
      probeDetails,
    )
    const gateway = new FakeGateway()
    gateway.responses.push(failure, failure)
    await expect(setup(gateway).score('task', trajectory('a'))).resolves.toMatchObject({
      metadata: {
        failure: { code: 'VerifierCapabilityError' },
        details: probeDetails,
      },
    })
    await expect(setup(gateway, { strict: true }).score('task', trajectory('a')))
      .rejects.toBe(failure)
  })

  it('propagates verifier and response-validation failures in strict mode', async () => {
    const gateway = new FakeGateway()
    gateway.responses.push(new Error('backend down'), { score: 2, usage })
    const plugin = setup(gateway, { strict: true })
    await expect(plugin.score('task', trajectory('a'))).rejects.toThrow('backend down')
    await expect(plugin.score('task', trajectory('a'))).rejects.toThrow('score must be')
  })

  it('keeps progress optional and handles missing tracker ids safely', async () => {
    const gateway = new FakeGateway()
    const disabled = setup(gateway, { progress: { enabled: false, nEvaluations: 1 } })
    await expect(disabled.onStepEnd('task', trajectory('a'), step(1))).resolves.toBeUndefined()
    const result = await setup(gateway).onStepEnd('task', trajectory('a'), step(1))
    expect(result?.metadata.failure?.code).toBe('VERIFIER_FAILURE')
    await expect(setup(gateway, { strict: true }).onStepEnd('task', trajectory('a'), step(1)))
      .rejects.toThrow('requires context.trackerId')
  })

  it('retains every explicit provider setting', () => {
    expect(resolveConfig({
      model: VERIFIER_MODEL,
      baseURL: 'https://verifier.example/v1',
      apiKeyEnv: 'CUSTOM_VERIFIER_KEY',
      transport: 'deepseek-native',
      criteria: { A: 'a' },
      maxWorkers: 2,
      reasoningEffort: 'low',
      strict: true,
      pythonExecutable: 'python',
      workingDirectory: '/work',
      timeoutMs: 10,
      workerGraceMs: 11,
      maxStderrBytes: 12,
      maxResponseBytes: 13,
      maxFieldBytes: 14,
      maxTrajectoryBytes: 15,
      scorePrefillMaxTokens: 16,
      confidence: { mediumGap: 0.04, highGap: 0.2, targetLevel: 'medium' },
      adaptive: {
        enabled: true,
        strategy: 'top-two',
        stages: [
          { nEvaluations: 1, criteria: ['A'] },
          { nEvaluations: 3, criteria: ['A'] },
        ],
        top2GapThreshold: 0.07,
        additionalEvaluations: 2,
        maxExtraCalls: 6,
        escalationReasoningEffort: 'high',
      },
      budget: {
        maxCalls: 17,
        maxLatencyMs: 18,
        maxInputTokens: 19,
        maxOutputTokens: 20,
        maxReasoningTokens: 21,
      },
      progressTracking: { enabled: true, nEvaluations: 3 },
    })).toMatchObject({
      maxWorkers: 2,
      reasoningEffort: 'low',
      strict: true,
      scorePrefillMaxTokens: 16,
      confidence: { mediumGap: 0.04, highGap: 0.2, targetLevel: 'medium' },
      adaptive: {
        enabled: true,
        strategy: 'top-two',
        stages: [
          { nEvaluations: 1, criteria: { A: 'a' } },
          { nEvaluations: 3, criteria: { A: 'a' } },
        ],
        top2GapThreshold: 0.07,
        additionalEvaluations: 2,
        maxExtraCalls: 6,
        escalationReasoningEffort: 'high',
      },
      budget: {
        maxCalls: 17,
        maxLatencyMs: 18,
        maxInputTokens: 19,
        maxOutputTokens: 20,
        maxReasoningTokens: 21,
      },
      progressTracking: { enabled: true, nEvaluations: 3 },
    })
  })

  it('validates selection responses and empty candidate input', async () => {
    const gateway = new FakeGateway()
    const plugin = setup(gateway)
    await expect(plugin.select('task', [])).rejects.toThrow('at least one candidate')
    gateway.responses.push({ selected_index: 3, scores: [0.5], ranking: [0], usage })
    const original = { id: 0 }
    const result = await plugin.select('task', [{ original, trajectory: trajectory('a') }])
    expect(result.bestCandidate).toBe(original)
    expect(result.metadata.failure?.code).toBe('VERIFIER_FAILURE')
  })

  it.each([
    null,
    { score: 'high' },
    { score: Number.NaN },
    { score: -0.1 },
    { score: 1.1 },
    { score: 0.5, usage: 'many' },
    { score: 0.5, usage: { ...usage, calls: -1 } },
    { score: 0.5, usage: { ...usage, calls: 1.5 } },
    { score: 0.5, details: Number.POSITIVE_INFINITY },
    { score: 0.5, details: { invalid: () => undefined } },
  ])('rejects malformed score response %#', async (response) => {
    const gateway = new FakeGateway()
    gateway.responses.push(response)
    await expect(setup(gateway, { strict: true }).score('task', trajectory('a'))).rejects.toThrow()
  })

  it('accepts finite JSON details, omitted usage, final-answer fallback, and max workers', async () => {
    const gateway = new FakeGateway()
    gateway.responses.push(
      { score: 0, details: null },
      { score: 1, details: ['text', true, 2, { nested: null }] },
      { score: 0.5 },
    )
    const plugin = setup(gateway, { strict: true, maxWorkers: 3 })
    await expect(plugin.score('task', { steps: [], finalAnswer: 'answer' })).resolves.toMatchObject({
      score: 0,
      metadata: { details: null },
    })
    await expect(plugin.score('task', trajectory('a'))).resolves.toMatchObject({ score: 1 })
    await expect(plugin.score('task', trajectory('a'))).resolves.toMatchObject({ score: 0.5 })
    expect(gateway.requests[0]).toMatchObject({ max_workers: 3, steps: ['Final answer:\nanswer'] })
  })

  it.each([
    null,
    { scores: 'bad' },
    { scores: [0.2] },
    { scores: [0.2, 2] },
  ])('rejects malformed comparison response %#', async (response) => {
    const gateway = new FakeGateway()
    gateway.responses.push(response)
    await expect(setup(gateway, { strict: true }).compare(
      'task', trajectory('a'), trajectory('b'),
    )).rejects.toThrow()
  })

  it('maps a first-candidate preference and preserves ties without a preference', async () => {
    const gateway = new FakeGateway()
    gateway.responses.push({ scores: [0.8, 0.2] }, { scores: [0.5, 0.5] })
    const plugin = setup(gateway, { strict: true })
    await expect(plugin.compare('task', trajectory('a'), trajectory('b'))).resolves.toMatchObject({
      preferredIndex: 0,
    })
    const tied = await plugin.compare('task', trajectory('a'), trajectory('b'))
    expect(tied.preferredIndex).toBeUndefined()
    expect(tied.scores).toEqual([0.5, 0.5])
  })

  it('returns comparison failure metadata in fail-open mode', async () => {
    const gateway = new FakeGateway()
    gateway.responses.push(new Error('compare unavailable'))
    const result = await setup(gateway).compare('task', trajectory('a'), trajectory('b'))
    expect(result.scores).toBeUndefined()
    expect(result.metadata.failure).toMatchObject({
      code: 'VERIFIER_FAILURE', message: 'compare unavailable',
    })
  })

  it.each([
    null,
    { selected_index: '0', scores: [0.5, 0.5], ranking: [0, 1] },
    { selected_index: -1, scores: [0.5, 0.5], ranking: [0, 1] },
    { selected_index: 2, scores: [0.5, 0.5], ranking: [0, 1] },
    { selected_index: 0, scores: 'bad', ranking: [0, 1] },
    { selected_index: 0, scores: [0.5], ranking: [0, 1] },
    { selected_index: 0, scores: [0.5, 0.5], ranking: 'bad' },
    { selected_index: 0, scores: [0.5, 0.5], ranking: [0] },
    { selected_index: 0, scores: [0.5, 0.5], ranking: [0, 0] },
    { selected_index: 0, scores: [0.5, 0.5], ranking: [0, 2] },
    { selected_index: 0, scores: [0.5, 0.5], ranking: [0, 1.5] },
  ])('rejects malformed selection response %#', async (response) => {
    const gateway = new FakeGateway()
    gateway.responses.push(response)
    const candidates = [0, 1].map(original => ({ original, trajectory: trajectory(String(original)) }))
    await expect(setup(gateway, { strict: true }).select('task', candidates)).rejects.toThrow()
  })

  it('classifies timeout, cancellation, and non-Error failures', async () => {
    const gateway = new FakeGateway()
    gateway.responses.push(
      new DOMException('late', 'TimeoutError'),
      new DOMException('cancel', 'AbortError'),
      { throwValue: 'plain failure' },
    )
    const plugin = setup(gateway)
    expect((await plugin.score('task', trajectory('a'))).metadata.failure?.code).toBe('VERIFIER_TIMEOUT')
    expect((await plugin.score('task', trajectory('a'))).metadata.failure?.code).toBe('VERIFIER_ABORTED')
    expect((await plugin.score('task', trajectory('a'))).metadata.failure).toEqual({
      code: 'VERIFIER_FAILURE', message: 'plain failure',
    })
  })

  it('falls back to the current step for a malformed progress response', async () => {
    const gateway = new FakeGateway()
    gateway.responses.push({ score: 0.4, step_index: 1.5 })
    const result = await setup(gateway).onStepEnd(
      'task', trajectory('a'), step(3), { trackerId: VerifierTrackerId('tracker') },
    )
    expect(result).toMatchObject({
      stepIndex: 3,
      metadata: { failure: { code: 'VERIFIER_FAILURE' } },
    })
  })

  it('scores without a tracker and contains tracker reset failures', async () => {
    const gateway = new FakeGateway()
    gateway.responses.push(
      { score: 0.9 },
      { score: 0.8 },
      new DOMException('cancelled reset', 'AbortError'),
    )
    const plugin = setup(gateway)
    await expect(plugin.onTrajectoryEnd('task', trajectory('a'))).resolves.toMatchObject({ score: 0.9 })
    await expect(plugin.onTrajectoryEnd(
      'task', trajectory('b'), { trackerId: VerifierTrackerId('tracker') },
    )).resolves.toMatchObject({ score: 0.8 })
  })
})

describe('verifier provider configuration', () => {
  it.each([
    ['https://api.deepseek.com', undefined, 'deepseek-native'],
    ['https://api.deepseek.com/v1/', undefined, 'deepseek-native'],
    ['https://example-proxy.test/v1', undefined, 'openai-compatible'],
    ['https://example-proxy.test/v1', 'deepseek-native', 'deepseek-native'],
    ['https://api.deepseek.com', 'openai-compatible', 'openai-compatible'],
  ] as const)('resolves %s with %s transport to %s', (baseURL, transport, expected) => {
    expect(DEFAULT_VERIFIER_TRANSPORT).toBe('auto')
    expect(resolveConfig({
      baseURL,
      ...(transport === undefined ? {} : { transport }),
      criteria: { A: 'a' },
    }).transport).toBe(expected)
  })

  it('resolves defaults while remaining opt-in at composition level', () => {
    expect(VERIFIER_MODEL).toBe('deepseek-v4-flash')
    expect(DEFAULT_VERIFIER_BASE_URL).toBe('https://api.deepseek.com')
    expect(DEFAULT_VERIFIER_API_KEY_ENV).toBe('DEEPSEEK_API_KEY')
    expect(resolveConfig({
      criteria: { ' Correctness ': ' Works ' },
    })).toMatchObject({
      model: 'deepseek-v4-flash',
      baseURL: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      transport: 'deepseek-native',
      capabilityProbe: { maxTokens: 1_024, retryMaxTokens: 2_048 },
      scorePrefillMaxTokens: 2_048,
      maxWorkers: 4,
      reasoningEffort: 'high',
      confidence: { mediumGap: 0.03, highGap: 0.10, targetLevel: 'high' },
      adaptive: {
        enabled: false,
        strategy: 'staged',
        stages: [
          { nEvaluations: 1 },
          { nEvaluations: 2 },
          { nEvaluations: 4 },
        ],
        top2GapThreshold: 0.10,
        additionalEvaluations: 1,
        maxExtraCalls: 8,
        escalationReasoningEffort: 'high',
      },
      budget: { maxCalls: 32, maxLatencyMs: 45_000 },
      criteria: { Correctness: 'Works' },
      nEvaluations: 1,
      pivots: 2,
      strict: true,
      progressTracking: { enabled: false, nEvaluations: 1 },
    })
  })

  it('uses the launch environment endpoint only when config omits baseURL', () => {
    const environment = createLaunchEnvironmentSnapshot([{
      source: 'project-env',
      path: '/workspace/.env',
      values: { VERIFIER_BASE_URL: 'https://environment-verifier.test/v1' },
    }])
    expect(resolveConfig({ criteria: { A: 'a' } }, environment)).toMatchObject({
      baseURL: 'https://environment-verifier.test/v1',
      transport: 'openai-compatible',
    })
    expect(resolveConfig({
      baseURL: 'https://api.deepseek.com',
      criteria: { A: 'a' },
    }, environment)).toMatchObject({
      baseURL: 'https://api.deepseek.com',
      transport: 'deepseek-native',
    })
  })

  it.each([
    { model: 'other-model', criteria: { A: 'a' } },
    { criteria: { A: 'a' }, baseURL: ' ' },
    { criteria: { A: 'a' }, transport: 'invalid' },
    { criteria: { A: 'a' }, apiKeyEnv: ' ' },
    { criteria: {} },
    { criteria: { '': 'a' } },
    { criteria: { A: '' } },
    { criteria: { A: 'a' }, nEvaluations: 0 },
    { criteria: { A: 'a' }, pivots: 1.5 },
    { criteria: { A: 'a' }, pythonExecutable: ' ' },
    { criteria: { A: 'a' }, workingDirectory: ' ' },
    { criteria: { A: 'a' }, maxWorkers: Number.MAX_SAFE_INTEGER + 1 },
    { criteria: { A: 'a' }, reasoningEffort: 'max' },
    { criteria: { A: 'a' }, timeoutMs: 0 },
    { criteria: { A: 'a' }, capabilityProbe: { maxTokens: 0 } },
    { criteria: { A: 'a' }, capabilityProbe: { retryMaxTokens: 1.5 } },
    { criteria: { A: 'a' }, capabilityProbe: { maxTokens: 2_048, retryMaxTokens: 1_024 } },
    { criteria: { A: 'a' }, scorePrefillMaxTokens: 0 },
    { criteria: { A: 'a' }, confidence: { mediumGap: -0.1 } },
    { criteria: { A: 'a' }, confidence: { highGap: 1.1 } },
    { criteria: { A: 'a' }, confidence: { mediumGap: 0.5, highGap: 0.4 } },
    { criteria: { A: 'a' }, confidence: { targetLevel: 'low' } },
    { criteria: { A: 'a' }, adaptive: { enabled: true, stages: [] } },
    { criteria: { A: 'a' }, adaptive: { enabled: true, strategy: 'other' } },
    { criteria: { A: 'a' }, adaptive: { enabled: true, top2GapThreshold: 1.1 } },
    { criteria: { A: 'a' }, adaptive: { enabled: true, additionalEvaluations: 0 } },
    { criteria: { A: 'a' }, adaptive: { enabled: true, maxExtraCalls: 0 } },
    { criteria: { A: 'a' }, adaptive: { enabled: true, escalationReasoningEffort: 'max' } },
    { criteria: { A: 'a' }, adaptive: { enabled: true, stages: [{ nEvaluations: 0 }] } },
    { criteria: { A: 'a' }, adaptive: { enabled: true, stages: [{ nEvaluations: 1, criteria: [] }] } },
    { criteria: { A: 'a' }, adaptive: { enabled: true, stages: [{ nEvaluations: 1, criteria: ['B'] }] } },
    { criteria: { A: 'a' }, adaptive: { enabled: true, stages: [
      { nEvaluations: 2 }, { nEvaluations: 1 },
    ] } },
    { criteria: { A: 'a' }, budget: { maxCalls: 0 } },
    { criteria: { A: 'a' }, budget: { maxLatencyMs: 0 } },
    { criteria: { A: 'a' }, budget: { maxOutputTokens: 1.5 } },
    { criteria: { A: 'a' }, budget: { maxCallsPerOperation: 0 } },
    { criteria: { A: 'a' }, budget: { maxComparisons: 1.5 } },
  ])('rejects invalid config %#', (config) => {
    expect(() => resolveConfig(config as unknown as Config)).toThrow()
  })
})

describe('worker and verifier separation', () => {
  it.each([
    { model: 'gpt-worker', provider: 'openai', baseURL: 'https://worker-a.example/v1', maxWorkers: 8 },
    { model: 'claude-worker', provider: 'anthropic', baseURL: 'https://worker-b.example/v1', maxWorkers: 4 },
    { model: 'local-worker', provider: 'local', baseURL: 'http://127.0.0.1:8000/v1', maxWorkers: 2 },
    { model: 'deepseek-v4-flash', provider: 'deepseek', baseURL: 'https://worker-c.example/v1', maxWorkers: 6 },
  ])('leaves $provider worker configuration and client identity unchanged', async (workerConfig) => {
    const workerClient = {}
    const worker = { ...workerConfig, client: workerClient }
    const before = { ...workerConfig }
    const gateway = new FakeGateway()
    gateway.responses.push({
      selected_index: 0,
      scores: [0.9, 0.1],
      ranking: [0, 1],
    })
    const plugin = setup(gateway, { maxWorkers: 4 })
    await plugin.select('task', [
      { original: { worker, id: 0 }, trajectory: trajectory('a') },
      { original: { worker, id: 1 }, trajectory: trajectory('b') },
    ])
    expect(worker).toMatchObject(before)
    expect(worker.client).toBe(workerClient)
    expect(worker.client).not.toBe(gateway)
    expect(gateway.requests[0]).toMatchObject({
      model: VERIFIER_MODEL,
      max_workers: 4,
    })
  })
})

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import VerifierRuntime, { runBestOfN, VerifierTrackerId } from 'dsh-llm-as-verifier/core'
import type {
  CanonicalTrajectory,
  VerifierCandidate,
  VerifierPlugin,
  VerifierSelectionSignal,
  VerifierSelectionDispatcher,
} from 'dsh-llm-as-verifier/core'

const trajectory = (answer: string): CanonicalTrajectory => ({
  steps: [{ index: 1, turn: 1, step: 1, assistantMessage: answer, tools: [] }],
  finalAnswer: answer,
  outcome: { kind: 'completed' },
})

describe('VerifierRuntime', () => {
  it('is inert without a configured provider', async () => {
    const runtime = new VerifierRuntime(new Context(), { enabled: true, plugin: 'fake' })
    expect(() => VerifierTrackerId('')).toThrow('must not be empty')
    expect(runtime.current).toBeUndefined()
    expect(runtime.supports('score')).toBe(false)
    await expect(runtime.onStepEnd('task', trajectory('a'), trajectory('a').steps[0]!)).resolves.toBeUndefined()
    await expect(runtime.onTrajectoryEnd('task', trajectory('a'))).resolves.toBeUndefined()
    expect(() => runtime.score('task', trajectory('a'))).toThrow('no enabled plugin is selected')
  })

  it('keeps a registered plugin bypassed while disabled', async () => {
    const score = vi.fn(async () => ({ score: 1, metadata: { backend: 'fake', latencyMs: 1 } }))
    const runtime = new VerifierRuntime(new Context(), { enabled: false, plugin: 'fake' })
    runtime.register({ id: 'fake', score }, { displayName: 'Fake verifier' })

    expect(runtime.plugins()).toEqual([{ id: 'fake', displayName: 'Fake verifier', available: true }])
    expect(runtime.current).toBeUndefined()
    expect(runtime.supports('score')).toBe(false)
    await expect(runtime.onStepEnd('task', trajectory('a'), trajectory('a').steps[0]!)).resolves.toBeUndefined()
    expect(score).not.toHaveBeenCalled()
    expect(() => runtime.score('task', trajectory('a'))).toThrow('no enabled plugin is selected')
  })

  it('registers optional capabilities and removes only its own registration', async () => {
    const runtime = new VerifierRuntime(new Context(), { enabled: true, plugin: 'fake' })
    expect(() => runtime.register({ id: ' ' })).toThrow('id must be non-empty')
    const plugin: VerifierPlugin = {
      id: 'fake',
      score: vi.fn(async () => ({ score: 0.75, metadata: { backend: 'fake', latencyMs: 1 } })),
      select: async <T>(_task: string, candidates: readonly VerifierCandidate<T>[]) => ({
        selectedIndex: 0,
        selectedTrajectory: candidates[0]!.trajectory,
        bestCandidate: candidates[0]!.original,
        metadata: { backend: 'fake', latencyMs: 1 },
      }),
    }
    const dispose = runtime.register(plugin)
    expect(runtime.current).toBe(plugin)
    expect(runtime.supports('score')).toBe(true)
    expect(runtime.supports('compare')).toBe(false)
    await expect(runtime.score('task', trajectory('a'))).resolves.toMatchObject({ score: 0.75 })
    const candidate = { id: 1 }
    await expect(runtime.select('task', [{ original: candidate, trajectory: trajectory('a') }]))
      .resolves.toMatchObject({ bestCandidate: candidate })
    expect(() => runtime.compare('task', trajectory('a'), trajectory('b')))
      .toThrow('does not support compare')
    expect(() => runtime.register({ id: 'fake' })).toThrow('already registered')
    dispose()
    dispose()
    expect(runtime.current).toBeUndefined()
  })

  it('emits a data-minimized selection observation and contains observer failures', async () => {
    const ctx = new Context()
    const runtime = new VerifierRuntime(ctx, { enabled: true, plugin: 'fake' })
    runtime.register({
      id: 'fake',
      model: 'verifier-model',
      select: async <T>(_task: string, candidates: readonly VerifierCandidate<T>[]) => ({
        selectedIndex: 1,
        selectedTrajectory: candidates[1]!.trajectory,
        bestCandidate: candidates[1]!.original,
        scores: [0.2, 0.8],
        ranking: [1, 0],
        metadata: { backend: 'fake', latencyMs: 2 },
      }),
    })
    const signals: VerifierSelectionSignal[] = []
    ctx.on('verifier/selection', (signal) => { signals.push(signal) })
    const candidates = [
      { original: { secret: 'first' }, trajectory: trajectory('private first') },
      { original: { secret: 'second' }, trajectory: trajectory('private second') },
    ]
    const result = await runtime.select('private task', candidates, {
      evaluation: { runId: 'run', taskId: 'task', outcome: { status: 'unknown' } },
    })
    expect(result.bestCandidate).toBe(candidates[1]!.original)
    const signal = signals.at(0)
    if (signal === undefined) throw new Error('expected one selection signal')
    expect(signals).toHaveLength(1)
    expect(signal.verifierId).toBe('fake')
    expect(signal.model).toBe('verifier-model')
    expect(signal.candidateCount).toBe(2)
    expect(signal.selection).toMatchObject({ selectedIndex: 1, scores: [0.2, 0.8], ranking: [1, 0] })
    expect(signal.evaluation).toMatchObject({ runId: 'run', taskId: 'task' })
    expect(JSON.stringify(signals)).not.toContain('private task')
    expect(JSON.stringify(signals)).not.toContain('private first')
    expect(JSON.stringify(signals)).not.toContain('second')

    ctx.on('verifier/selection', () => { throw new Error('observer failed') })
    await expect(runtime.select('task', candidates)).resolves.toMatchObject({ selectedIndex: 1 })
  })
})

describe('runBestOfN', () => {
  it('keeps generation separate and preserves selected candidate identity', async () => {
    const originals = [{ id: 0 }, { id: 1 }, { id: 2 }]
    let selectCalls = 0
    const select: NonNullable<VerifierSelectionDispatcher['select']> = async <T>(
      _task: string, candidates: readonly VerifierCandidate<T>[],
    ) => {
      selectCalls += 1
      return {
        selectedIndex: 2,
        selectedTrajectory: candidates[2]!.trajectory,
        bestCandidate: candidates[2]!.original,
        scores: [0.1, 0.3, 0.9],
        ranking: [2, 1, 0],
        metadata: { backend: 'fake', latencyMs: 1 },
      }
    }
    const run = vi.fn(async (index: number) => originals[index]!)
    const result = await runBestOfN({
      task: 'choose',
      n: 3,
      run,
      adapt: candidate => trajectory(String(candidate.id)),
      verifier: { id: 'fake', select },
    })
    expect(run.mock.calls.map(call => call[0])).toEqual([0, 1, 2])
    expect(selectCalls).toBe(1)
    expect(result.bestCandidate).toBe(originals[2])
    expect(result.selectedTrajectory.finalAnswer).toBe('2')
  })

  it('accepts the runtime dispatcher so normal DSH selection emits observations', async () => {
    const ctx = new Context()
    const runtime = new VerifierRuntime(ctx, { enabled: true, plugin: 'fake' })
    runtime.register({
      id: 'fake',
      select: async <T>(_task: string, candidates: readonly VerifierCandidate<T>[]) => ({
        selectedIndex: 0,
        selectedTrajectory: candidates[0]!.trajectory,
        bestCandidate: candidates[0]!.original,
        metadata: { backend: 'fake', latencyMs: 1 },
      }),
    })
    const observed = vi.fn()
    ctx.on('verifier/selection', observed)
    await runBestOfN({
      task: 'choose',
      n: 2,
      run: async index => ({ index }),
      adapt: candidate => trajectory(String(candidate.index)),
      verifier: runtime,
    })
    expect(observed).toHaveBeenCalledOnce()
    expect(observed.mock.calls[0]?.[0]).toMatchObject({ verifierId: 'fake', candidateCount: 2 })
  })

  it('rejects invalid counts and missing selection before generating candidates', async () => {
    const run = vi.fn(async () => ({ id: 0 }))
    const base = {
      task: 'choose',
      run,
      adapt: (candidate: { id: number }) => trajectory(String(candidate.id)),
    }
    await expect(runBestOfN({ ...base, n: 0, verifier: {} })).rejects.toThrow('positive safe integer')
    await expect(runBestOfN({ ...base, n: 1, verifier: { id: 'score-only' } }))
      .rejects.toThrow('does not support candidate selection')
    expect(run).not.toHaveBeenCalled()
  })

  it('checks cancellation before and after rollouts finish', async () => {
    const before = new AbortController()
    before.abort(new Error('before'))
    const runBefore = vi.fn(async () => ({ id: 0 }))
    await expect(runBestOfN({
      task: 'choose',
      n: 1,
      run: runBefore,
      adapt: candidate => trajectory(String(candidate.id)),
      verifier: { select: vi.fn() },
      context: { signal: before.signal },
    })).rejects.toThrow('before')
    expect(runBefore).not.toHaveBeenCalled()

    const after = new AbortController()
    const select = vi.fn()
    await expect(runBestOfN({
      task: 'choose',
      n: 1,
      run: async () => {
        after.abort(new Error('after'))
        return { id: 0 }
      },
      adapt: candidate => trajectory(String(candidate.id)),
      verifier: { select },
      context: { signal: after.signal },
    })).rejects.toThrow('after')
    expect(select).not.toHaveBeenCalled()
  })
})

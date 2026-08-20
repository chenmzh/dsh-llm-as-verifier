/** Generic verifier implementation backed by the optional Python package. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {
  AgentStep,
  CanonicalTrajectory,
  TrajectoryAdapter,
  VerificationFailure,
  VerificationMetadata,
  VerifierCallContext,
  VerifierCandidate,
  VerifierAdaptiveDecision,
  VerifierComparisonResult,
  VerifierConfidenceLevel,
  VerifierPlugin,
  VerifierProgressResult,
  VerifierScoreResult,
  VerifierSelectionConfidence,
  VerifierSelectionCost,
  VerifierSelectionResult,
  VerifierReasoningEffort,
  VerifierStageResult,
  VerifierStopReason,
  VerifierTokenUsage,
} from 'dsh-llm-as-verifier/core'
import { VerifierBackendError } from './gateway.ts'
import type { VerifierGateway, WorkerRequest } from './gateway.ts'

/** The only model this provider sends to its verifier endpoint. */
export const VERIFIER_MODEL = 'deepseek-v4-flash' as const

/** Progress configuration after plugin config defaults are resolved. */
export interface LLMAsVerifierProgressOptions {
  readonly enabled: boolean
  readonly nEvaluations: number
}

/** Relative score-gap interpretation for candidate selection. */
export interface LLMAsVerifierConfidenceOptions {
  readonly mediumGap: number
  readonly highGap: number
  readonly targetLevel: 'medium' | 'high'
}

/** One cumulative adaptive selection plan. */
export interface LLMAsVerifierAdaptiveStage {
  readonly nEvaluations: number
  readonly criteria: Readonly<Record<string, string>>
}

/** Optional staged selection behavior. */
export interface LLMAsVerifierAdaptiveOptions {
  readonly enabled: boolean
  readonly strategy?: 'staged' | 'top-two'
  readonly stages: readonly LLMAsVerifierAdaptiveStage[]
  readonly top2GapThreshold?: number
  readonly additionalEvaluations?: number
  readonly maxExtraCalls?: number
  readonly escalationReasoningEffort?: VerifierReasoningEffort
}

/** Verifier-only limits checked before another adaptive stage starts. */
export interface LLMAsVerifierBudgetOptions {
  readonly maxCalls: number
  readonly maxLatencyMs: number
  readonly maxInputTokens?: number
  readonly maxOutputTokens?: number
  readonly maxReasoningTokens?: number
  readonly maxCallsPerOperation?: number
  readonly maxComparisons?: number
}

/** Construction options independent of Cordis loading. */
export interface LLMAsVerifierPluginOptions {
  readonly gateway: VerifierGateway
  readonly adapter: TrajectoryAdapter
  readonly criteria: Readonly<Record<string, string>>
  readonly nEvaluations: number
  readonly pivots: number
  readonly maxWorkers: number
  readonly reasoningEffort?: VerifierReasoningEffort
  readonly confidence: LLMAsVerifierConfidenceOptions
  readonly adaptive: LLMAsVerifierAdaptiveOptions
  readonly budget: LLMAsVerifierBudgetOptions
  readonly strict: boolean
  readonly progress: LLMAsVerifierProgressOptions
  readonly logger?: Pick<Context['logger'], 'info' | 'warn'>
}

interface ParsedResult<T> {
  readonly value: T
  readonly usage: VerifierTokenUsage | undefined
  readonly details: VerificationMetadata['details'] | undefined
}

interface OperationSuccess<T> {
  readonly ok: true
  readonly value: T
  readonly metadata: VerificationMetadata
}

interface OperationFailure {
  readonly ok: false
  readonly metadata: VerificationMetadata & { readonly failure: VerificationFailure }
}

type OperationResult<T> = OperationSuccess<T> | OperationFailure

interface SelectionValue {
  readonly selectedIndex: number
  readonly scores: readonly number[]
  readonly ranking: readonly number[]
}

const BACKEND = 'llm-as-a-verifier'

const CONFIDENCE_ORDER: Readonly<Record<VerifierConfidenceLevel, number>> = {
  low: 0,
  medium: 1,
  high: 2,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finiteScore(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`verifier-llm-as-verifier: ${field} must be a finite number in [0, 1]`)
  }
  return value
}

function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`verifier-llm-as-verifier: ${field} must be a safe integer`)
  }
  return value
}

function usage(value: unknown): VerifierTokenUsage | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('verifier-llm-as-verifier: usage must be an object')
  const read = (field: string): number => {
    const count = value[field]
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`verifier-llm-as-verifier: usage.${field} must be a non-negative safe integer`)
    }
    return count
  }
  return {
    calls: read('calls'),
    inputTokens: read('input_tokens'),
    cachedInputTokens: read('cached_input_tokens'),
    outputTokens: read('output_tokens'),
    reasoningTokens: read('reasoning_tokens'),
  }
}

function isJsonValue(value: unknown): value is VerificationMetadata['details'] {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function details(value: unknown): VerificationMetadata['details'] | undefined {
  if (value === undefined) return undefined
  if (!isJsonValue(value)) throw new Error('verifier-llm-as-verifier: details must be finite JSON data')
  return value
}

function baseResult(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('verifier-llm-as-verifier: worker result must be an object')
  return value
}

function failureOf(error: unknown): VerificationFailure {
  if (error instanceof VerifierBackendError) {
    return { code: error.code, message: error.message }
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return { code: 'VERIFIER_TIMEOUT', message: 'Verifier request timed out' }
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { code: 'VERIFIER_ABORTED', message: 'Verifier request was aborted' }
  }
  return {
    code: 'VERIFIER_FAILURE',
    message: error instanceof Error ? error.message : String(error),
  }
}

function combineUsage(
  left: VerifierTokenUsage | undefined,
  right: VerifierTokenUsage | undefined,
): VerifierTokenUsage | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return {
    calls: left.calls + right.calls,
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  }
}

function selectionConfidence(
  scores: readonly number[],
  policy: LLMAsVerifierConfidenceOptions,
): VerifierSelectionConfidence {
  const ordered = [...scores].sort((left, right) => right - left)
  const topScore = ordered[0] as number
  const secondScore = ordered[1]
  const scoreGap = secondScore === undefined ? 1 : topScore - secondScore
  const level: VerifierConfidenceLevel = scoreGap >= policy.highGap
    ? 'high'
    : scoreGap >= policy.mediumGap ? 'medium' : 'low'
  return {
    level,
    topScore,
    ...(secondScore === undefined ? {} : { secondScore }),
    scoreGap,
    needsMoreVerification: CONFIDENCE_ORDER[level] < CONFIDENCE_ORDER[policy.targetLevel],
  }
}

function stageWork(stage: LLMAsVerifierAdaptiveStage): Set<string> {
  return new Set(Object.keys(stage.criteria).flatMap(name => (
    Array.from({ length: stage.nEvaluations }, (_, repetition) => `${name}\u0000${repetition}`)
  )))
}

function estimateUsage(
  current: VerifierTokenUsage | undefined,
  completedUnits: number,
  additionalUnits: number,
): VerifierTokenUsage {
  const ratio = additionalUnits / completedUnits
  const estimate = (value: number): number => Math.ceil(value * ratio)
  return {
    calls: Math.max(1, estimate(current?.calls ?? 1)),
    inputTokens: estimate(current?.inputTokens ?? 0),
    cachedInputTokens: estimate(current?.cachedInputTokens ?? 0),
    outputTokens: estimate(current?.outputTokens ?? 0),
    reasoningTokens: estimate(current?.reasoningTokens ?? 0),
  }
}

function budgetStopReason(
  current: VerifierTokenUsage | undefined,
  latencyMs: number,
  estimated: VerifierTokenUsage,
  estimatedLatencyMs: number,
  budget: LLMAsVerifierBudgetOptions,
): VerifierStopReason | undefined {
  if ((current?.calls ?? 0) + estimated.calls > budget.maxCalls) return 'max_calls'
  if (latencyMs + estimatedLatencyMs > budget.maxLatencyMs) return 'max_latency'
  if (
    budget.maxInputTokens !== undefined
    && (current?.inputTokens ?? 0) + estimated.inputTokens > budget.maxInputTokens
  ) return 'max_input_tokens'
  if (
    budget.maxOutputTokens !== undefined
    && (current?.outputTokens ?? 0) + estimated.outputTokens > budget.maxOutputTokens
  ) return 'max_output_tokens'
  if (
    budget.maxReasoningTokens !== undefined
    && (current?.reasoningTokens ?? 0) + estimated.reasoningTokens > budget.maxReasoningTokens
  ) return 'max_reasoning_tokens'
  return undefined
}

function telemetryNumber(metadata: VerificationMetadata, field: string): number | undefined {
  const details = metadata.details
  if (!isRecord(details) || !isRecord(details.telemetry)) return undefined
  const value = details.telemetry[field]
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function selectionCost(
  metadata: VerificationMetadata,
  reasoningEffort: VerifierReasoningEffort,
): VerifierSelectionCost {
  return {
    latencyMs: metadata.latencyMs,
    comparisons: telemetryNumber(metadata, 'comparisons') ?? 0,
    ...(metadata.usage === undefined ? {} : { usage: metadata.usage }),
    reasoningEffort,
  }
}

/** `llm_verifier` scoring, comparison, selection, and progress as one optional plugin. */
export class LLMAsVerifierPlugin implements VerifierPlugin {
  readonly id = BACKEND
  readonly model = VERIFIER_MODEL
  private readonly options: LLMAsVerifierPluginOptions

  /** @param options Backend, adapter, policy, and observability settings. */
  constructor(options: LLMAsVerifierPluginOptions) {
    this.options = options
  }

  async score(
    task: string,
    trajectory: CanonicalTrajectory,
    context?: VerifierCallContext,
  ): Promise<VerifierScoreResult> {
    const steps = trajectory.steps.map(step => this.options.adapter.serializeStep(step))
    if (trajectory.finalAnswer !== undefined) {
      const finalAnswer = `Final answer:\n${trajectory.finalAnswer}`
      if (!steps.includes(finalAnswer)) steps.push(finalAnswer)
    }
    const result = await this.execute('score', 1, {
      operation: 'score',
      problem: task,
      steps,
      ...this.workerOptions(this.options.nEvaluations),
    }, context, (raw) => {
      const record = baseResult(raw)
      return {
        value: finiteScore(record.score, 'score'),
        usage: usage(record.usage),
        details: details(record.details),
      }
    })
    if (!result.ok) return { metadata: result.metadata }
    return { score: result.value, metadata: result.metadata }
  }

  async compare(
    task: string,
    candidateA: CanonicalTrajectory,
    candidateB: CanonicalTrajectory,
    context?: VerifierCallContext,
  ): Promise<VerifierComparisonResult> {
    const result = await this.execute('compare', 2, {
      operation: 'compare',
      problem: task,
      candidate_a: this.options.adapter.serialize(candidateA),
      candidate_b: this.options.adapter.serialize(candidateB),
      criteria: this.options.criteria,
      ...this.workerOptions(this.options.nEvaluations),
    }, context, (raw) => {
      const record = baseResult(raw)
      if (!Array.isArray(record.scores) || record.scores.length !== 2) {
        throw new Error('verifier-llm-as-verifier: compare scores must contain two entries')
      }
      const scores: [number, number] = [
        finiteScore(record.scores[0], 'scores[0]'),
        finiteScore(record.scores[1], 'scores[1]'),
      ]
      return { value: scores, usage: usage(record.usage), details: details(record.details) }
    })
    if (!result.ok) return { metadata: result.metadata }
    const preferredIndex = result.value[0] === result.value[1]
      ? undefined
      : result.value[0] > result.value[1] ? 0 : 1
    return {
      scores: result.value,
      ...(preferredIndex === undefined ? {} : { preferredIndex }),
      metadata: result.metadata,
    }
  }

  async select<T>(
    task: string,
    candidates: readonly VerifierCandidate<T>[],
    context?: VerifierCallContext,
  ): Promise<VerifierSelectionResult<T>> {
    if (candidates.length === 0) throw new Error('verifier-llm-as-verifier: select needs at least one candidate')
    const stableCandidates = [...candidates]
    const serializedCandidates = stableCandidates.map(candidate => (
      this.options.adapter.serialize(candidate.trajectory)
    ))
    if (this.options.adaptive.enabled && this.options.adaptive.strategy === 'top-two') {
      return this.selectTopTwo(task, stableCandidates, serializedCandidates, context)
    }
    const adaptive = this.options.adaptive.enabled
    const plans: readonly LLMAsVerifierAdaptiveStage[] = adaptive
      ? this.options.adaptive.stages
      : [{ nEvaluations: this.options.nEvaluations, criteria: this.options.criteria }]
    const cacheId = adaptive ? randomUUID() : undefined
    const stages: VerifierStageResult[] = []
    let aggregateUsage: VerifierTokenUsage | undefined
    let aggregateLatencyMs = 0
    let lastValue: SelectionValue | undefined
    let terminalMetadata: VerificationMetadata | undefined
    let confidence: VerifierSelectionConfidence | undefined
    let stoppedReason: VerifierStopReason = adaptive ? 'stages_exhausted' : 'fixed'

    try {
      for (const [stageIndex, plan] of plans.entries()) {
        const result = await this.execute('select', stableCandidates.length, {
          operation: 'select',
          problem: task,
          candidates: serializedCandidates,
          criteria: plan.criteria,
          pivots: this.options.pivots,
          ...(cacheId === undefined ? {} : { cache_id: cacheId }),
          ...this.workerOptions(plan.nEvaluations),
        }, context, raw => this.parseSelection(raw, stableCandidates.length))
        aggregateLatencyMs += result.metadata.latencyMs
        aggregateUsage = combineUsage(aggregateUsage, result.metadata.usage)
        terminalMetadata = result.metadata
        if (!result.ok) {
          stoppedReason = 'verifier_error'
          stages.push({
            index: stageIndex + 1,
            nEvaluations: plan.nEvaluations,
            criteria: Object.keys(plan.criteria),
            latencyMs: result.metadata.latencyMs,
            failure: result.metadata.failure,
          })
          break
        }

        lastValue = result.value
        confidence = selectionConfidence(result.value.scores, this.options.confidence)
        stages.push({
          index: stageIndex + 1,
          nEvaluations: plan.nEvaluations,
          criteria: Object.keys(plan.criteria),
          latencyMs: result.metadata.latencyMs,
          ...(result.metadata.usage === undefined ? {} : { usage: result.metadata.usage }),
          confidence,
        })
        this.options.logger?.info(
          'verifier: backend=%s model=%s stage=%d nEvaluations=%d criteria=%s calls=%d latencyMs=%d scoreGap=%s confidence=%s',
          BACKEND,
          this.model,
          stageIndex + 1,
          plan.nEvaluations,
          JSON.stringify(Object.keys(plan.criteria)),
          result.metadata.usage?.calls ?? 0,
          Math.round(result.metadata.latencyMs),
          String(confidence.scoreGap),
          confidence.level,
        )
        if (!confidence.needsMoreVerification) {
          stoppedReason = adaptive ? 'confident' : 'fixed'
          break
        }
        const next = plans[stageIndex + 1]
        if (next === undefined) {
          stoppedReason = adaptive ? 'stages_exhausted' : 'fixed'
          break
        }
        const completedWork = stageWork(plan)
        const additionalUnits = [...stageWork(next)].filter(key => !completedWork.has(key)).length
        const estimatedUsage = estimateUsage(aggregateUsage, completedWork.size, additionalUnits)
        const estimatedLatencyMs = Math.max(
          1,
          aggregateLatencyMs * additionalUnits / completedWork.size,
        )
        const budgetReason = budgetStopReason(
          aggregateUsage,
          aggregateLatencyMs,
          estimatedUsage,
          estimatedLatencyMs,
          this.options.budget,
        )
        if (budgetReason !== undefined) {
          stoppedReason = budgetReason
          break
        }
      }
    } finally {
      if (cacheId !== undefined) await this.releaseSelectionCache(cacheId)
    }

    const selectedIndex = lastValue?.selectedIndex ?? 0
    const selected = stableCandidates[selectedIndex] as VerifierCandidate<T>
    const metadataSource = terminalMetadata ?? this.failureMetadata(
      aggregateLatencyMs,
      new Error('verifier-llm-as-verifier: no verification stage ran'),
      'select',
    )
    const metadata: VerificationMetadata = {
      ...metadataSource,
      latencyMs: aggregateLatencyMs,
      ...(aggregateUsage === undefined ? {} : { usage: aggregateUsage }),
    }
    const loggedScores = lastValue?.scores ?? []
    const loggedConfidence = confidence?.level ?? 'unavailable'
    if (metadata.failure === undefined) {
      this.options.logger?.info(
        'verifier: backend=%s model=%s candidates=%d selected=%d scores=%s confidence=%s stages=%d stop=%s',
        BACKEND,
        this.model,
        stableCandidates.length,
        selectedIndex,
        JSON.stringify(loggedScores),
        loggedConfidence,
        stages.length,
        stoppedReason,
      )
    } else {
      this.options.logger?.warn(
        'verifier: backend=%s model=%s verificationFailed=true fallbackCandidate=%d retainedPartial=%s failureCode=%s',
        BACKEND,
        this.model,
        selectedIndex,
        String(lastValue !== undefined),
        metadata.failure.code,
      )
    }
    return {
      selectedIndex,
      selectedTrajectory: selected.trajectory,
      bestCandidate: selected.original,
      ...(lastValue === undefined ? {} : { scores: lastValue.scores, ranking: lastValue.ranking }),
      ...(confidence === undefined ? {} : { confidence }),
      verification: {
        adaptive,
        stagesExecuted: stages.length,
        latencyMs: aggregateLatencyMs,
        ...(aggregateUsage === undefined ? {} : { usage: aggregateUsage }),
        stoppedReason,
        stages,
      },
      metadata,
    }
  }

  async onStepEnd(
    task: string,
    _trajectory: CanonicalTrajectory,
    step: AgentStep,
    context?: VerifierCallContext,
  ): Promise<VerifierProgressResult | undefined> {
    if (!this.options.progress.enabled) return undefined
    if (context?.trackerId === undefined) {
      const error = new Error('verifier-llm-as-verifier: progress tracking requires context.trackerId')
      if (this.options.strict) throw error
      return {
        stepIndex: step.index,
        metadata: this.failureMetadata(0, error),
      }
    }
    const result = await this.execute('progress', 1, {
      operation: 'progress',
      problem: task,
      tracker_id: context.trackerId,
      step: this.options.adapter.serializeStep(step),
      ...this.workerOptions(this.options.progress.nEvaluations),
    }, context, (raw) => {
      const record = baseResult(raw)
      return {
        value: {
          score: finiteScore(record.score, 'score'),
          stepIndex: integer(record.step_index, 'step_index'),
        },
        usage: usage(record.usage),
        details: details(record.details),
      }
    })
    const stepIndex = result.ok ? result.value.stepIndex : step.index
    this.options.logger?.info(
      'verifier: backend=%s model=%s progressStep=%d progress=%s',
      BACKEND,
      this.model,
      stepIndex,
      String(result.ok ? result.value.score : 'unavailable'),
    )
    return {
      stepIndex,
      ...(result.ok ? { score: result.value.score } : {}),
      metadata: result.metadata,
    }
  }

  async onTrajectoryEnd(
    task: string,
    trajectory: CanonicalTrajectory,
    context?: VerifierCallContext,
  ): Promise<VerifierScoreResult> {
    try {
      return await this.score(task, trajectory, context)
    } finally {
      if (context?.trackerId !== undefined) await this.resetTracker(context)
    }
  }

  private async selectTopTwo<T>(
    task: string,
    candidates: readonly VerifierCandidate<T>[],
    serializedCandidates: readonly string[],
    context: VerifierCallContext | undefined,
  ): Promise<VerifierSelectionResult<T>> {
    const reasoningEffort = this.options.reasoningEffort ?? 'high'
    const gapThreshold = this.options.adaptive.top2GapThreshold
      ?? this.options.confidence.highGap
    const additionalEvaluations = this.options.adaptive.additionalEvaluations ?? 1
    const maxExtraCalls = this.options.adaptive.maxExtraCalls ?? 8
    const escalationReasoningEffort = this.options.adaptive.escalationReasoningEffort ?? 'high'
    const cacheId = randomUUID()
    const stages: VerifierStageResult[] = []
    let aggregateUsage: VerifierTokenUsage | undefined
    let aggregateLatencyMs = 0
    let lastValue: SelectionValue | undefined
    let terminalMetadata: VerificationMetadata | undefined
    let confidence: VerifierSelectionConfidence | undefined
    let baselineCost: VerifierSelectionCost | undefined
    let escalationCost: VerifierSelectionCost | undefined
    let stoppedReason: VerifierStopReason = 'stages_exhausted'
    let escalationTriggered = false
    let escalationReason: 'top2_gap' | undefined
    let escalationSkippedReason: VerifierStopReason | undefined
    let stage1Ranking: readonly number[] = []
    let stage1Top1 = 0
    let stage1Top2: number | undefined
    let stage1Gap = 1
    let extraComparisons = 0

    try {
      const baseline = await this.execute('select', candidates.length, {
        operation: 'select',
        problem: task,
        candidates: serializedCandidates,
        criteria: this.options.criteria,
        pivots: this.options.pivots,
        cache_id: cacheId,
        ...this.workerOptions(this.options.nEvaluations),
      }, context, raw => this.parseSelection(raw, candidates.length))
      aggregateLatencyMs = baseline.metadata.latencyMs
      aggregateUsage = baseline.metadata.usage
      terminalMetadata = baseline.metadata
      baselineCost = selectionCost(baseline.metadata, reasoningEffort)
      if (!baseline.ok) {
        stoppedReason = 'verifier_error'
        stages.push({
          index: 1,
          nEvaluations: this.options.nEvaluations,
          criteria: Object.keys(this.options.criteria),
          latencyMs: baseline.metadata.latencyMs,
          failure: baseline.metadata.failure,
        })
      } else {
        lastValue = baseline.value
        confidence = selectionConfidence(baseline.value.scores, this.options.confidence)
        stage1Ranking = baseline.value.ranking
        const baselineTop1 = baseline.value.ranking[0]
        if (baselineTop1 === undefined) {
          throw new Error('verifier-llm-as-verifier: baseline ranking must contain a winner')
        }
        stage1Top1 = baselineTop1
        stage1Top2 = baseline.value.ranking[1]
        const top1Score = baseline.value.scores[stage1Top1]
        const top2Score = stage1Top2 === undefined
          ? undefined
          : baseline.value.scores[stage1Top2]
        if (top1Score === undefined || (stage1Top2 !== undefined && top2Score === undefined)) {
          throw new Error('verifier-llm-as-verifier: baseline ranking references a missing score')
        }
        stage1Gap = top2Score === undefined ? 1 : top1Score - top2Score
        stages.push({
          index: 1,
          nEvaluations: this.options.nEvaluations,
          criteria: Object.keys(this.options.criteria),
          latencyMs: baseline.metadata.latencyMs,
          ...(baseline.metadata.usage === undefined ? {} : { usage: baseline.metadata.usage }),
          confidence,
        })

        if (stage1Top2 === undefined || stage1Gap >= gapThreshold) {
          stoppedReason = 'confident'
        } else {
          escalationReason = 'top2_gap'
          const top2 = stage1Top2
          const adaptivePairs = Array.from(
            { length: additionalEvaluations },
            () => [[stage1Top1, top2], [top2, stage1Top1]] as const,
          ).flat()
          extraComparisons = adaptivePairs.length
          const baselinePlannedComparisons = telemetryNumber(
            baseline.metadata,
            'planned_comparisons',
          ) ?? Math.max(1, baselineCost.comparisons)
          const baselinePlannedCalls = telemetryNumber(
            baseline.metadata,
            'planned_verifier_calls',
          ) ?? Math.max(1, baseline.metadata.usage?.calls ?? baselinePlannedComparisons)
          const baselineCriteria = telemetryNumber(baseline.metadata, 'criteria_count')
            ?? Object.keys(this.options.criteria).length
          const baselineEvaluations = telemetryNumber(baseline.metadata, 'n_evaluations')
            ?? this.options.nEvaluations
          const requestsPerJob = baselinePlannedCalls / Math.max(
            1,
            baselinePlannedComparisons * baselineCriteria * baselineEvaluations,
          )
          const plannedExtraCalls = Math.ceil(
            extraComparisons * baselineCriteria * requestsPerJob,
          )
          let skipReason: VerifierStopReason | undefined
          if (plannedExtraCalls > maxExtraCalls) {
            skipReason = 'max_extra_calls'
          } else if (
            this.options.budget.maxCallsPerOperation !== undefined
            && (aggregateUsage?.calls ?? 0) + plannedExtraCalls
              > this.options.budget.maxCallsPerOperation
          ) {
            skipReason = 'max_calls'
          } else if (
            this.options.budget.maxComparisons !== undefined
            && baselineCost.comparisons + extraComparisons > this.options.budget.maxComparisons
          ) {
            skipReason = 'max_comparisons'
          } else {
            const estimatedUsage = estimateUsage(
              aggregateUsage,
              Math.max(1, aggregateUsage?.calls ?? baselinePlannedCalls),
              plannedExtraCalls,
            )
            const estimatedLatencyMs = Math.max(
              1,
              aggregateLatencyMs * plannedExtraCalls
                / Math.max(1, aggregateUsage?.calls ?? baselinePlannedCalls),
            )
            skipReason = budgetStopReason(
              aggregateUsage,
              aggregateLatencyMs,
              estimatedUsage,
              estimatedLatencyMs,
              this.options.budget,
            )
          }

          if (skipReason !== undefined) {
            stoppedReason = skipReason
            escalationSkippedReason = skipReason
          } else {
            escalationTriggered = true
            const escalation = await this.execute('select_escalation', candidates.length, {
              operation: 'select_escalation',
              problem: task,
              candidates: serializedCandidates,
              criteria: this.options.criteria,
              pivots: this.options.pivots,
              cache_id: cacheId,
              baseline_n_evaluations: this.options.nEvaluations,
              adaptive_pairs: adaptivePairs,
              ...this.workerOptions(1, escalationReasoningEffort),
            }, context, raw => this.parseSelection(raw, candidates.length))
            aggregateLatencyMs += escalation.metadata.latencyMs
            aggregateUsage = combineUsage(aggregateUsage, escalation.metadata.usage)
            terminalMetadata = escalation.metadata
            escalationCost = selectionCost(
              escalation.metadata,
              escalationReasoningEffort,
            )
            if (!escalation.ok) {
              stoppedReason = 'verifier_error'
              stages.push({
                index: 2,
                nEvaluations: additionalEvaluations,
                criteria: Object.keys(this.options.criteria),
                latencyMs: escalation.metadata.latencyMs,
                failure: escalation.metadata.failure,
              })
            } else {
              lastValue = escalation.value
              confidence = selectionConfidence(escalation.value.scores, this.options.confidence)
              stages.push({
                index: 2,
                nEvaluations: additionalEvaluations,
                criteria: Object.keys(this.options.criteria),
                latencyMs: escalation.metadata.latencyMs,
                ...(escalation.metadata.usage === undefined
                  ? {}
                  : { usage: escalation.metadata.usage }),
                confidence,
              })
              stoppedReason = confidence.needsMoreVerification ? 'stages_exhausted' : 'confident'
            }
          }
        }
      }
    } finally {
      await this.releaseSelectionCache(cacheId)
    }

    const selectedIndex = lastValue === undefined ? 0 : lastValue.selectedIndex
    const selected = candidates[selectedIndex] as VerifierCandidate<T>
    const metadataSource = terminalMetadata
    const metadata: VerificationMetadata = {
      ...metadataSource,
      latencyMs: aggregateLatencyMs,
      ...(aggregateUsage === undefined ? {} : { usage: aggregateUsage }),
    }
    const finalRanking = lastValue?.ranking ?? stage1Ranking
    const adaptiveDecision: VerifierAdaptiveDecision = {
      strategy: 'top-two',
      stage1Top1,
      ...(stage1Top2 === undefined ? {} : { stage1Top2 }),
      stage1Gap,
      escalationTriggered,
      ...(escalationReason === undefined ? {} : { escalationReason }),
      ...(escalationSkippedReason === undefined ? {} : { escalationSkippedReason }),
      extraComparisons: escalationTriggered ? extraComparisons : 0,
      finalWinnerChanged: lastValue !== undefined && lastValue.selectedIndex !== stage1Top1,
      finalRankingChanged: stage1Ranking.length > 0 && (
        finalRanking.length !== stage1Ranking.length
        || finalRanking.some((candidate, index) => candidate !== stage1Ranking[index])
      ),
    }
    this.options.logger?.info(
      'verifier: backend=%s model=%s adaptive=top-two stage1Gap=%s escalated=%s extraCalls=%d winnerChanged=%s stop=%s',
      BACKEND,
      this.model,
      String(stage1Gap),
      String(escalationTriggered),
      escalationCost?.usage?.calls ?? 0,
      String(adaptiveDecision.finalWinnerChanged),
      stoppedReason,
    )
    return {
      selectedIndex,
      selectedTrajectory: selected.trajectory,
      bestCandidate: selected.original,
      ...(lastValue === undefined ? {} : { scores: lastValue.scores, ranking: lastValue.ranking }),
      ...(confidence === undefined ? {} : { confidence }),
      verification: {
        adaptive: true,
        stagesExecuted: stages.length,
        latencyMs: aggregateLatencyMs,
        ...(aggregateUsage === undefined ? {} : { usage: aggregateUsage }),
        stoppedReason,
        stages,
        baseline: baselineCost,
        ...(escalationCost === undefined ? {} : { escalation: escalationCost }),
        adaptiveDecision,
      },
      metadata,
    }
  }

  private workerOptions(
    nEvaluations: number,
    reasoningEffort = this.options.reasoningEffort ?? 'high',
  ): Record<string, unknown> {
    return {
      model: VERIFIER_MODEL,
      n_evaluations: nEvaluations,
      max_workers: this.options.maxWorkers,
      reasoning_effort: reasoningEffort,
      ...(this.options.budget.maxCallsPerOperation === undefined
        ? {}
        : { max_calls_per_operation: this.options.budget.maxCallsPerOperation }),
      ...(this.options.budget.maxComparisons === undefined
        ? {}
        : { max_comparisons: this.options.budget.maxComparisons }),
    }
  }

  private parseSelection(raw: unknown, count: number): ParsedResult<SelectionValue> {
    const record = baseResult(raw)
    const selectedIndex = integer(record.selected_index, 'selected_index')
    if (selectedIndex < 0 || selectedIndex >= count) {
      throw new Error('verifier-llm-as-verifier: selected_index is outside the candidate list')
    }
    if (!Array.isArray(record.scores) || record.scores.length !== count) {
      throw new Error('verifier-llm-as-verifier: scores must match the candidate count')
    }
    if (!Array.isArray(record.ranking) || record.ranking.length !== count) {
      throw new Error('verifier-llm-as-verifier: ranking must match the candidate count')
    }
    const scores = record.scores.map((value, index) => finiteScore(value, `scores[${index}]`))
    const ranking = record.ranking.map((value, index) => integer(value, `ranking[${index}]`))
    if (new Set(ranking).size !== count || ranking.some(index => index < 0 || index >= count)) {
      throw new Error('verifier-llm-as-verifier: ranking must be a candidate-index permutation')
    }
    return {
      value: { selectedIndex, scores, ranking },
      usage: usage(record.usage),
      details: details(record.details),
    }
  }

  private async execute<T>(
    operation: string,
    candidateCount: number,
    request: WorkerRequest,
    context: VerifierCallContext | undefined,
    parse: (raw: unknown) => ParsedResult<T>,
  ): Promise<OperationResult<T>> {
    const started = performance.now()
    try {
      const parsed = parse(await this.options.gateway.request(request, context))
      const metadata: VerificationMetadata = {
        backend: BACKEND,
        model: this.model,
        latencyMs: performance.now() - started,
        ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
        ...(parsed.details === undefined ? {} : { details: parsed.details }),
      }
      const workerTelemetry = isRecord(parsed.details) && isRecord(parsed.details.telemetry)
        ? parsed.details.telemetry
        : {}
      this.options.logger?.info(
        'verifier: backend=%s model=%s operation=%s candidates=%d latencyMs=%d tokenUsage=%s telemetry=%s',
        BACKEND,
        this.model,
        operation,
        candidateCount,
        Math.round(metadata.latencyMs),
        JSON.stringify(metadata.usage ?? {}),
        JSON.stringify(workerTelemetry),
      )
      return { ok: true, value: parsed.value, metadata }
    } catch (error) {
      if (this.options.strict) throw error
      return {
        ok: false,
        metadata: this.failureMetadata(performance.now() - started, error, operation),
      }
    }
  }

  private failureMetadata(
    latencyMs: number,
    error: unknown,
    operation = 'progress',
  ): VerificationMetadata & { readonly failure: VerificationFailure } {
    const failure = failureOf(error)
    const backendDetails = error instanceof VerifierBackendError
      ? details(error.details)
      : undefined
    this.options.logger?.warn(
      'verifier: backend=%s model=%s operation=%s latencyMs=%d failureCode=%s message=%s',
      BACKEND,
      this.model,
      operation,
      Math.round(latencyMs),
      failure.code,
      failure.message,
    )
    return {
      backend: BACKEND,
      model: this.model,
      latencyMs,
      failure,
      ...(backendDetails === undefined ? {} : { details: backendDetails }),
    }
  }

  private async resetTracker(context: VerifierCallContext): Promise<void> {
    try {
      await this.options.gateway.request({
        operation: 'reset',
        tracker_id: context.trackerId,
      }, context)
    } catch (error) {
      const failure = failureOf(error)
      this.options.logger?.warn(
        'verifier: backend=%s model=%s operation=reset failureCode=%s message=%s',
        BACKEND,
        this.model,
        failure.code,
        failure.message,
      )
    }
  }

  private async releaseSelectionCache(cacheId: string): Promise<void> {
    try {
      await this.options.gateway.request({ operation: 'release_cache', cache_id: cacheId })
    } catch (error) {
      const failure = failureOf(error)
      this.options.logger?.warn(
        'verifier: backend=%s model=%s operation=release_cache failureCode=%s message=%s',
        BACKEND,
        this.model,
        failure.code,
        failure.message,
      )
    }
  }
}

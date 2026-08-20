/** Privacy-minimized local evaluation records for completed verifier selections. */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, type FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type {
  VerifierEvaluationOutcome,
  VerifierSelectionCost,
  VerifierSelectionSignal,
  VerifierTokenUsage,
} from 'dsh-llm-as-verifier/core'

/** Current append-only evaluation record version. */
export const VERIFIER_EVALUATION_SCHEMA_VERSION = 1 as const

/** Independent outcome serialized without verifier-derived correctness claims. */
export type StoredEvaluationOutcome =
  | { readonly status: 'unknown' }
  | {
    readonly status: 'graded'
    readonly source: string
    readonly success?: boolean
    readonly score?: number
  }

/** One candidate's hashed trajectory reference and independent outcome. */
export interface StoredCandidateEvaluation {
  readonly index: number
  readonly trajectory_reference_sha256?: string
  readonly outcome: StoredEvaluationOutcome
}

/** Baseline or escalation cost retained for offline policy analysis. */
export interface StoredSelectionCost {
  readonly comparisons: number
  readonly verifier_calls: number
  readonly input_tokens: number
  readonly cached_input_tokens: number
  readonly output_tokens: number
  readonly reasoning_tokens: number
  readonly latency_ms: number
}

/** Versioned, data-minimized observation of one completed selection operation. */
export interface VerifierEvaluationRecord {
  readonly schema_version: typeof VERIFIER_EVALUATION_SCHEMA_VERSION
  readonly record_id: string
  readonly run_id: string
  readonly task_id: string
  readonly timestamp: string
  readonly task_metadata: {
    readonly task_type: string
    readonly source: string
    readonly candidate_count: number
  }
  readonly verifier: {
    readonly backend: string
    readonly model?: string
    readonly endpoint_id?: string
    readonly reasoning_effort?: string
    readonly criteria_count?: number
    readonly n_evaluations?: number
    readonly pivots?: number
    readonly max_workers?: number
  }
  readonly selection: {
    readonly ranking?: readonly number[]
    readonly scores?: readonly number[]
    readonly winner_index: number
    readonly top2_gap?: number
    readonly failure_code?: string
  }
  readonly cost: {
    readonly planned_comparisons?: number
    readonly planned_verifier_calls?: number
    readonly comparisons: number
    readonly verifier_calls: number
    readonly input_tokens: number
    readonly cached_input_tokens: number
    readonly output_tokens: number
    readonly reasoning_tokens: number
    readonly latency_ms: number
    readonly baseline?: StoredSelectionCost
    readonly escalation?: StoredSelectionCost
  }
  readonly adaptive_shadow?: {
    readonly policy: 'top-two'
    readonly threshold: number
    readonly top2_gap: number
    readonly would_trigger: boolean
  }
  readonly adaptive_actual?: {
    readonly strategy: 'staged' | 'top-two'
    readonly stage1_winner_index: number
    readonly stage1_top2_index?: number
    readonly stage1_gap: number
    readonly escalation_triggered: boolean
    readonly extra_comparisons: number
    readonly final_winner_changed: boolean
    readonly final_ranking_changed: boolean
  }
  readonly outcome: StoredEvaluationOutcome
  readonly candidates: readonly StoredCandidateEvaluation[]
}

/** Shadow-policy settings that never dispatch another verifier operation. */
export interface AdaptiveShadowOptions {
  readonly enabled: boolean
  readonly top2GapThreshold: number
}

/** Inputs for projecting one runtime selection signal into schema version one. */
export interface EvaluationRecordOptions {
  readonly adaptiveShadow: AdaptiveShadowOptions
  readonly now?: () => Date
  readonly randomId?: () => string
}

/** Warning-only logger used by the append queue. */
export interface EvaluationWriterLogger {
  /** @param message Complete local persistence failure diagnostic. */
  warn(message: string): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function telemetry(signal: VerifierSelectionSignal): Record<string, unknown> {
  const details = signal.selection.metadata.details
  if (!isRecord(details) || !isRecord(details.telemetry)) return {}
  return details.telemetry
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function safeToken(value: unknown): string {
  if (typeof value !== 'string') return 'unknown'
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(value)) return 'unknown'
  return /(?:authorization|bearer|password|secret|token|api[_-]?key)|^sk-/i.test(value)
    ? 'unknown'
    : value
}

function safeEndpoint(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const parsed = new URL(value)
    return parsed.origin
  } catch {
    return value === 'configured-verifier-endpoint' ? value : undefined
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function storedOutcome(outcome: VerifierEvaluationOutcome | undefined): StoredEvaluationOutcome {
  if (outcome === undefined || outcome.status === 'unknown') return { status: 'unknown' }
  const score = finiteNumber(outcome.score)
  return {
    status: 'graded',
    source: safeToken(outcome.source),
    ...(outcome.success === undefined ? {} : { success: outcome.success }),
    ...(score === undefined ? {} : { score }),
  }
}

function usage(signal: VerifierSelectionSignal): VerifierTokenUsage {
  return signal.selection.verification?.usage
    ?? signal.selection.metadata.usage
    ?? { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 }
}

function storedCost(cost: VerifierSelectionCost | undefined): StoredSelectionCost | undefined {
  if (cost === undefined) return undefined
  const costUsage = cost.usage
    ?? { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 }
  return {
    comparisons: cost.comparisons,
    verifier_calls: costUsage.calls,
    input_tokens: costUsage.inputTokens,
    cached_input_tokens: costUsage.cachedInputTokens,
    output_tokens: costUsage.outputTokens,
    reasoning_tokens: costUsage.reasoningTokens,
    latency_ms: cost.latencyMs,
  }
}

function scoreGap(scores: readonly number[] | undefined): number | undefined {
  if (scores === undefined || scores.length < 2) return scores?.length === 1 ? 1 : undefined
  const ordered = scores.filter(Number.isFinite).sort((left, right) => right - left)
  const top = ordered.at(0)
  const second = ordered.at(1)
  return top === undefined || second === undefined ? undefined : top - second
}

/**
 * Project one completed selection into the local schema. Task text, candidate
 * objects, trajectories, metadata details, and credential values are never copied.
 * @param signal Data-minimized runtime selection signal.
 * @param options Shadow-policy and deterministic test hooks.
 * @returns Versioned evaluation record ready for JSONL serialization.
 */
export function buildVerifierEvaluationRecord(
  signal: VerifierSelectionSignal,
  options: EvaluationRecordOptions,
): VerifierEvaluationRecord {
  const facts = telemetry(signal)
  const recordId = (options.randomId ?? randomUUID)()
  const evaluation = signal.evaluation
  const scores = signal.selection.scores?.map((score) => {
    if (!Number.isFinite(score)) throw new TypeError('verifier evaluation scores must be finite')
    return score
  })
  const gap = signal.selection.confidence?.scoreGap ?? scoreGap(scores)
  const tokenUsage = usage(signal)
  const adaptive = signal.selection.verification?.adaptiveDecision
  const baselineCost = storedCost(signal.selection.verification?.baseline)
  const escalationCost = storedCost(signal.selection.verification?.escalation)
  const candidateInputs = new Map(evaluation?.candidates?.map(candidate => [candidate.index, candidate]))
  const candidates = Array.from({ length: signal.candidateCount }, (_, index): StoredCandidateEvaluation => {
    const candidate = candidateInputs.get(index)
    return {
      index,
      ...(candidate?.trajectoryReference === undefined
        ? {}
        : { trajectory_reference_sha256: digest(candidate.trajectoryReference) }),
      outcome: storedOutcome(candidate?.outcome),
    }
  })
  const endpoint = safeEndpoint(facts.endpoint)
  const reasoningEffort = safeToken(facts.reasoning_effort)
  const criteriaCount = nonNegativeInteger(facts.criteria_count)
  const nEvaluations = nonNegativeInteger(facts.n_evaluations)
  const pivots = nonNegativeInteger(facts.pivots)
  const maxWorkers = nonNegativeInteger(facts.max_workers)
  const plannedComparisons = nonNegativeInteger(facts.planned_comparisons)
  const plannedVerifierCalls = nonNegativeInteger(facts.planned_verifier_calls)
  return {
    schema_version: VERIFIER_EVALUATION_SCHEMA_VERSION,
    record_id: recordId,
    run_id: digest(evaluation?.runId ?? recordId),
    task_id: digest(evaluation?.taskId ?? evaluation?.runId ?? recordId),
    timestamp: (options.now ?? (() => new Date()))().toISOString(),
    task_metadata: {
      task_type: safeToken(evaluation?.taskType),
      source: safeToken(evaluation?.source),
      candidate_count: signal.candidateCount,
    },
    verifier: {
      backend: safeToken(signal.verifierId),
      ...(signal.model === undefined ? {} : { model: safeToken(signal.model) }),
      ...(endpoint === undefined ? {} : { endpoint_id: endpoint }),
      ...(reasoningEffort === 'unknown' ? {} : { reasoning_effort: reasoningEffort }),
      ...(criteriaCount === undefined ? {} : { criteria_count: criteriaCount }),
      ...(nEvaluations === undefined ? {} : { n_evaluations: nEvaluations }),
      ...(pivots === undefined ? {} : { pivots }),
      ...(maxWorkers === undefined ? {} : { max_workers: maxWorkers }),
    },
    selection: {
      ...(signal.selection.ranking === undefined ? {} : { ranking: [...signal.selection.ranking] }),
      ...(scores === undefined ? {} : { scores }),
      winner_index: signal.selection.selectedIndex,
      ...(gap === undefined ? {} : { top2_gap: gap }),
      ...(signal.selection.metadata.failure === undefined
        ? {}
        : { failure_code: safeToken(signal.selection.metadata.failure.code) }),
    },
    cost: {
      ...(plannedComparisons === undefined ? {} : { planned_comparisons: plannedComparisons }),
      ...(plannedVerifierCalls === undefined ? {} : { planned_verifier_calls: plannedVerifierCalls }),
      comparisons: nonNegativeInteger(facts.comparisons)
        ?? signal.selection.verification?.baseline?.comparisons
        ?? 0,
      verifier_calls: tokenUsage.calls,
      input_tokens: tokenUsage.inputTokens,
      cached_input_tokens: tokenUsage.cachedInputTokens,
      output_tokens: tokenUsage.outputTokens,
      reasoning_tokens: tokenUsage.reasoningTokens,
      latency_ms: signal.selection.verification?.latencyMs ?? signal.selection.metadata.latencyMs,
      ...(baselineCost === undefined ? {} : { baseline: baselineCost }),
      ...(escalationCost === undefined ? {} : { escalation: escalationCost }),
    },
    ...(options.adaptiveShadow.enabled && gap !== undefined
      ? {
        adaptive_shadow: {
          policy: 'top-two' as const,
          threshold: options.adaptiveShadow.top2GapThreshold,
          top2_gap: gap,
          would_trigger: signal.candidateCount > 1 && gap < options.adaptiveShadow.top2GapThreshold,
        },
      }
      : {}),
    ...(adaptive === undefined
      ? {}
      : {
        adaptive_actual: {
          strategy: adaptive.strategy,
          stage1_winner_index: adaptive.stage1Top1,
          ...(adaptive.stage1Top2 === undefined ? {} : { stage1_top2_index: adaptive.stage1Top2 }),
          stage1_gap: adaptive.stage1Gap,
          escalation_triggered: adaptive.escalationTriggered,
          extra_comparisons: adaptive.extraComparisons,
          final_winner_changed: adaptive.finalWinnerChanged,
          final_ranking_changed: adaptive.finalRankingChanged,
        },
      }),
    outcome: storedOutcome(evaluation?.outcome),
    candidates,
  }
}

/**
 * Process-local serialized JSONL appender. One random file per plugin instance
 * avoids cross-process append contention; disposal drains queued records.
 */
export class VerifierEvaluationJsonlWriter {
  private readonly directory: string
  private readonly filename: string
  private tail = Promise.resolve()
  private handle: FileHandle | undefined

  /**
   * @param path Local directory for private evaluation files.
   * @param logger Warning-only failure sink.
   * @param now Deterministic filename clock for tests.
   * @param randomId Deterministic filename id for tests.
   */
  constructor(
    path: string,
    private readonly logger: EvaluationWriterLogger,
    now: () => Date = () => new Date(),
    randomId: () => string = randomUUID,
  ) {
    this.directory = resolve(path)
    this.filename = `verifier-runs-${now().toISOString().slice(0, 10)}-${randomId()}.jsonl`
  }

  /**
   * Queue one complete line without delaying the selection result.
   * @param record Privacy-minimized schema-v1 record.
   */
  append(record: VerifierEvaluationRecord): void {
    const line = `${JSON.stringify(record)}\n`
    this.tail = this.tail.then(async () => {
      const handle = await this.open()
      await handle.appendFile(line, { encoding: 'utf8' })
    }).catch((error: unknown) => {
      this.logger.warn(`verifier-observer: evaluation record persistence failed; selection remains valid: ${String(error)}`)
    })
  }

  /** Drain queued records and close the private file. */
  async close(): Promise<void> {
    await this.tail
    if (this.handle === undefined) return
    try {
      await this.handle.close()
    } catch (error) {
      this.logger.warn(`verifier-observer: evaluation file close failed: ${String(error)}`)
    } finally {
      this.handle = undefined
    }
  }

  private async open(): Promise<FileHandle> {
    if (this.handle !== undefined) return this.handle
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    this.handle = await open(join(this.directory, this.filename), 'ax', 0o600)
    return this.handle
  }
}

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue, Session, TurnEndReason } from '@deepseek-ai/dsh-session'

/** Opaque identifier for one verifier progress-tracking stream. */
export type VerifierTrackerId = Branded<'VerifierTrackerId'>

/**
 * Creates a non-empty verifier tracker identifier.
 *
 * @param value Stable identifier scoped to one trajectory.
 * @returns Branded tracker identifier.
 */
export function VerifierTrackerId(value: string): VerifierTrackerId {
  if (value.length === 0) {
    throw new Error('Verifier tracker identifiers must not be empty')
  }
  return value as VerifierTrackerId
}

/** Stable, provider-neutral facts about one verification failure. */
export interface VerificationFailure {
  /** Failure class or backend code when one is available. */
  readonly code: string
  /** Sanitized diagnostic that never includes a trajectory or credential value. */
  readonly message: string
}

/** Verifier token accounting reported by a backend operation. */
export interface VerifierTokenUsage {
  readonly calls: number
  readonly inputTokens: number
  readonly cachedInputTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
}

/** DeepSeek-native reasoning effort selected for one verifier operation. */
export type VerifierReasoningEffort = 'off' | 'low' | 'high'

/** Selection certainty derived from relative verifier ranking signals. */
export type VerifierConfidenceLevel = 'low' | 'medium' | 'high'

/** Relative certainty of one candidate selection, not correctness probability. */
export interface VerifierSelectionConfidence {
  readonly level: VerifierConfidenceLevel
  readonly topScore: number
  /** Runner-up score, absent when only one candidate exists. */
  readonly secondScore?: number
  readonly scoreGap: number
  /** Whether the configured policy recommends another verification stage. */
  readonly needsMoreVerification: boolean
}

/** Why candidate verification stopped after its last completed stage. */
export type VerifierStopReason =
  | 'confident'
  | 'fixed'
  | 'max_calls'
  | 'max_latency'
  | 'max_input_tokens'
  | 'max_output_tokens'
  | 'max_reasoning_tokens'
  | 'max_extra_calls'
  | 'max_comparisons'
  | 'stages_exhausted'
  | 'verifier_error'

/** Observable outcome of one completed candidate-verification stage. */
export interface VerifierStageResult {
  readonly index: number
  readonly nEvaluations: number
  readonly criteria: readonly string[]
  readonly latencyMs: number
  readonly usage?: VerifierTokenUsage
  readonly confidence?: VerifierSelectionConfidence
  /** Failure facts when this stage started but produced no ranking. */
  readonly failure?: VerificationFailure
}

/** Cost of the baseline or targeted escalation portion of one selection. */
export interface VerifierSelectionCost {
  readonly latencyMs: number
  readonly comparisons: number
  readonly usage?: VerifierTokenUsage
  readonly reasoningEffort?: VerifierReasoningEffort
}

/** Observable top-two adaptive decision for one selection. */
export interface VerifierAdaptiveDecision {
  readonly strategy: 'staged' | 'top-two'
  readonly stage1Top1: number
  /** Runner-up index, absent for a single-candidate selection. */
  readonly stage1Top2?: number
  readonly stage1Gap: number
  readonly escalationTriggered: boolean
  readonly escalationReason?: 'top2_gap'
  /** Reason a needed escalation retained the baseline result. */
  readonly escalationSkippedReason?: VerifierStopReason
  readonly extraComparisons: number
  readonly finalWinnerChanged: boolean
  readonly finalRankingChanged: boolean
}

/** Adaptive or fixed verification work performed for one selection. */
export interface VerifierSelectionVerification {
  readonly adaptive: boolean
  readonly stagesExecuted: number
  readonly latencyMs: number
  readonly usage?: VerifierTokenUsage
  readonly stoppedReason: VerifierStopReason
  readonly stages: readonly VerifierStageResult[]
  /** Baseline PPT work, separated from optional targeted escalation. */
  readonly baseline?: VerifierSelectionCost
  /** Decision-relevant top-pair work when escalation ran. */
  readonly escalation?: VerifierSelectionCost
  /** Top-two trigger and outcome when the provider uses adaptive selection. */
  readonly adaptiveDecision?: VerifierAdaptiveDecision
}

/** Metadata common to score, comparison, selection, and progress results. */
export interface VerificationMetadata {
  /** Stable verifier implementation id. */
  readonly backend: string
  /** Verifier model when the implementation uses one. */
  readonly model?: string
  /** Wall-clock operation latency. */
  readonly latencyMs: number
  /** Backend token accounting when exposed. */
  readonly usage?: VerifierTokenUsage
  /** Failure facts on a fail-open result. */
  readonly failure?: VerificationFailure
  /** Additional bounded JSON facts owned by the verifier implementation. */
  readonly details?: JsonValue
}

/** One tool invocation and its committed observation. */
export interface CanonicalToolInteraction {
  readonly callId: string
  readonly name: string
  readonly input: JsonValue | string
  readonly output?: string
  readonly evidence?: string
  readonly error?: VerificationFailure
}

/** One provider-neutral agent step reconstructed from durable session events. */
export interface AgentStep {
  /** One-based position in the complete trajectory. */
  readonly index: number
  readonly turn: number
  readonly step: number
  /** User-visible assistant text; reasoning blocks are excluded. */
  readonly assistantMessage?: string
  /** Tool calls in model order with their committed outputs. */
  readonly tools: readonly CanonicalToolInteraction[]
}

/** Verifier-facing trajectory detached from DeepSeek transport details. */
export interface CanonicalTrajectory {
  readonly steps: readonly AgentStep[]
  /** Last user-visible assistant response in the represented events. */
  readonly finalAnswer?: string
  /** Last committed turn outcome in the represented events. */
  readonly outcome?: TurnEndReason
}

/** Independent evidence attached by a caller; verifier output never populates this value. */
export type VerifierEvaluationOutcome =
  | { readonly status: 'unknown' }
  | {
    readonly status: 'graded'
    /** Stable non-secret identifier for the independent grader or test source. */
    readonly source: string
    /** Binary outcome when the external source exposes one. */
    readonly success?: boolean
    /** Finite external quality score when the source exposes one. */
    readonly score?: number
  }

/** Independent outcome and optional durable reference for one candidate. */
export interface VerifierCandidateEvaluation {
  readonly index: number
  /** Opaque reference that evaluation logging hashes before persistence. */
  readonly trajectoryReference?: string
  readonly outcome: VerifierEvaluationOutcome
}

/** Optional data-minimized correlation and ground-truth inputs for observational logging. */
export interface VerifierEvaluationContext {
  /** Opaque run identifier; local logging stores only its digest. */
  readonly runId?: string
  /** Opaque task identifier; local logging stores only its digest. */
  readonly taskId?: string
  /** Lightweight caller-owned category, for example `coding`; invalid tokens become `unknown`. */
  readonly taskType?: string
  /** Lightweight caller-owned source token; invalid tokens become `unknown`. */
  readonly source?: string
  /** Independent outcome for the selected run, or `unknown` when no grader exists. */
  readonly outcome?: VerifierEvaluationOutcome
  /** Candidate-level references and independent outcomes when the caller has them. */
  readonly candidates?: readonly VerifierCandidateEvaluation[]
}

/** Optional same-process context supplied to a verifier operation. */
export interface VerifierCallContext {
  readonly signal?: AbortSignal
  /** Stable per-trajectory key for stateful progress implementations. */
  readonly trackerId?: VerifierTrackerId
  /** Non-secret correlation fields for logs and backend metadata. */
  readonly labels?: Readonly<Record<string, string>>
  /** Observation-only correlation and external outcome data; never sent as verifier evidence. */
  readonly evaluation?: VerifierEvaluationContext
}

/** Runtime dispatch context; the generic runtime consumes `session` before calling a provider. */
export interface VerifierDispatchContext extends VerifierCallContext {
  /** Session whose durable verifier mode governs this operation. */
  readonly session?: Session
}

/** Final completion score. A fail-open result has no score and carries metadata.failure. */
export interface VerifierScoreResult {
  readonly score?: number
  readonly metadata: VerificationMetadata
}

/** Pairwise preference scores in candidate order. */
export interface VerifierComparisonResult {
  readonly scores?: readonly [number, number]
  readonly preferredIndex?: 0 | 1
  readonly metadata: VerificationMetadata
}

/** Original candidate paired with its verifier-facing trajectory. */
export interface VerifierCandidate<T> {
  readonly original: T
  readonly trajectory: CanonicalTrajectory
}

/** Best-of-N selection retaining the exact original candidate objects. */
export interface VerifierSelectionResult<T> {
  readonly selectedIndex: number
  readonly selectedTrajectory: CanonicalTrajectory
  readonly bestCandidate: T
  readonly scores?: readonly number[]
  readonly ranking?: readonly number[]
  /** Relative ranking certainty when selection produced candidate scores. */
  readonly confidence?: VerifierSelectionConfidence
  /** Stage, cost, latency, and stopping facts when the provider exposes them. */
  readonly verification?: VerifierSelectionVerification
  readonly metadata: VerificationMetadata
}

/** Selection fields safe for same-process observers; candidate objects and trajectories are absent. */
export interface VerifierSelectionObservation {
  readonly selectedIndex: number
  readonly scores?: readonly number[]
  readonly ranking?: readonly number[]
  readonly confidence?: VerifierSelectionConfidence
  readonly verification?: VerifierSelectionVerification
  readonly metadata: VerificationMetadata
}

/** Post-selection signal emitted by the generic runtime after a provider returns successfully. */
export interface VerifierSelectionSignal {
  readonly verifierId: string
  readonly model?: string
  readonly candidateCount: number
  readonly selection: VerifierSelectionObservation
  readonly evaluation?: VerifierEvaluationContext
}

/** Online progress measurement after one committed agent step. */
export interface VerifierProgressResult {
  readonly stepIndex: number
  readonly score?: number
  readonly metadata: VerificationMetadata
}

/**
 * Optional verification operations supplied by one implementation.
 * Implementations expose only the capabilities they support; the runtime
 * reports an unsupported operation instead of requiring no-op methods.
 */
export interface VerifierPlugin {
  readonly id: string
  readonly model?: string

  score?(
    task: string,
    trajectory: CanonicalTrajectory,
    context?: VerifierCallContext,
  ): Promise<VerifierScoreResult>

  compare?(
    task: string,
    candidateA: CanonicalTrajectory,
    candidateB: CanonicalTrajectory,
    context?: VerifierCallContext,
  ): Promise<VerifierComparisonResult>

  select?<T>(
    task: string,
    candidates: readonly VerifierCandidate<T>[],
    context?: VerifierCallContext,
  ): Promise<VerifierSelectionResult<T>>

  onStepEnd?(
    task: string,
    trajectory: CanonicalTrajectory,
    step: AgentStep,
    context?: VerifierCallContext,
  ): Promise<VerifierProgressResult | undefined>

  onTrajectoryEnd?(
    task: string,
    trajectory: CanonicalTrajectory,
    context?: VerifierCallContext,
  ): Promise<VerifierScoreResult | undefined>
}

/** Capability names available through {@link VerifierPlugin}. */
export type VerifierCapability = 'score' | 'compare' | 'select' | 'onStepEnd' | 'onTrajectoryEnd'

/** Configuration metadata published by one verifier Service Provider. */
export interface VerifierPluginDescriptor {
  /** Stable selection id stored in the verifier settings section. */
  readonly id: string
  /** Human-readable name for configuration surfaces. */
  readonly displayName: string
  /** Provider-owned settings namespace, when it exposes one. */
  readonly settingsNamespace?: string
  /** Credential references a configuration surface may describe and manage. */
  readonly credentialRefs?: readonly string[]
  /** Whether the provider can currently accept verifier operations. */
  readonly available: boolean
}

/** Safe result of a provider-owned verifier capability probe. */
export type VerifierCapabilityProbeResult =
  | {
    readonly supported: true
    readonly plugin: string
    readonly model: string
    readonly endpointOrigin: string
    readonly logprobsPresent: boolean
    readonly scorePositionFound: boolean
    readonly scaleDistributionRecoverable: boolean
    readonly latencyMs: number
  }
  | {
    readonly supported: false
    readonly plugin: string
    readonly reason: string
  }

/** Directory metadata and optional privileged probe supplied with a verifier implementation. */
export interface VerifierPluginRegistration {
  readonly displayName?: string
  readonly settingsNamespace?: string
  readonly credentialRefs?: readonly string[]
  readonly probe?: (signal?: AbortSignal) => Promise<VerifierCapabilityProbeResult>
}

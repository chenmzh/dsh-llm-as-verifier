/** Optional `llm_verifier` Service Provider for DeepSeek Harness. */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { TrajectoryAdapter } from 'dsh-llm-as-verifier/core'
import type {
  AgentStep, CanonicalTrajectory, VerifierCallContext, VerifierCandidate,
  VerifierCapabilityProbeResult, VerifierComparisonResult, VerifierPlugin,
  VerifierProgressResult, VerifierScoreResult, VerifierSelectionResult,
} from 'dsh-llm-as-verifier/core'
import { PythonVerifierGateway, VerifierBackendError } from './gateway.ts'
import type { VerifierGateway } from './gateway.ts'
import { LLMAsVerifierPlugin, VERIFIER_MODEL } from './plugin.ts'

export * from './gateway.ts'
export * from './plugin.ts'

/** Cordis plugin name used in loader diagnostics. */
export const name = 'verifier-llm-as-verifier'

/** Services required to publish the provider and launch its optional runtime. */
export const inject = ['credentials', 'subprocess', 'verifier']

const DEFAULT_N_EVALUATIONS = 1
const DEFAULT_PIVOTS = 2
const DEFAULT_MAX_WORKERS = 4
const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_GRACE_MS = 2_000
const DEFAULT_MAX_STDERR_BYTES = 65_536
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576
const DEFAULT_MAX_FIELD_BYTES = 65_536
const DEFAULT_MAX_TRAJECTORY_BYTES = 524_288
const DEFAULT_CAPABILITY_PROBE_MAX_TOKENS = 1_024
const DEFAULT_CAPABILITY_PROBE_RETRY_MAX_TOKENS = 2_048
const DEFAULT_SCORE_PREFILL_MAX_TOKENS = 2_048
const DEFAULT_MEDIUM_CONFIDENCE_GAP = 0.03
const DEFAULT_HIGH_CONFIDENCE_GAP = 0.10
const DEFAULT_ADAPTIVE_MAX_CALLS = 32
const DEFAULT_ADAPTIVE_MAX_LATENCY_MS = 45_000
/** Read live abort state across awaits without treating it as synchronously immutable. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}


/** Settings namespace owned by the LLM-as-a-Verifier provider. */
export const VERIFIER_LLM_SETTINGS_NAMESPACE = settingsNamespace('verifier-llm-as-verifier')

const DEFAULT_ADAPTIVE_STAGES = [1, 2, 4] as const

/** Official endpoint used when the verifier has no explicit endpoint. */
export const DEFAULT_VERIFIER_BASE_URL = 'https://api.deepseek.com'

/** Verifier endpoint name resolved through the launch environment snapshot. */
export const VERIFIER_BASE_URL_ENV = 'VERIFIER_BASE_URL'

/** Default verifier-only credential reference. */
export const DEFAULT_VERIFIER_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** Endpoint transport selection before automatic resolution. */
export type VerifierTransport = 'auto' | 'deepseek-native' | 'openai-compatible'

/** Transport modes sent to the verifier worker after endpoint resolution. */
export type ResolvedVerifierTransport = Exclude<VerifierTransport, 'auto'>

/** DeepSeek-native reasoning effort applied by the verifier client. */
export type VerifierReasoningEffort = 'off' | 'low' | 'high'

/** Default transport selection derives native behavior only from the official endpoint. */
export const DEFAULT_VERIFIER_TRANSPORT: VerifierTransport = 'auto'

/** Bounded first-use verifier capability probe settings. */
export interface CapabilityProbeConfig {
  /** Initial output budget for the short score-token probe. Default 1024. */
  maxTokens?: number
  /** Single retry output budget after reasoning exhaustion. Default 2048. */
  retryMaxTokens?: number
}

/** Optional online progress measurement settings. */
export interface ProgressTrackingConfig {
  /** Whether post-step hooks call `ProgressTracker.update`. Default false. */
  enabled?: boolean
  /** Repeated evaluations per progress point. Default one. */
  nEvaluations?: number
}

/** Relative selection-certainty policy. Verifier scores are not correctness probabilities. */
export interface ConfidenceConfig {
  /** Minimum gap for medium selection confidence. Default 0.03. */
  mediumGap?: number
  /** Minimum gap for high selection confidence. Default 0.10. */
  highGap?: number
  /** Confidence level that stops adaptive verification. Default high. */
  targetLevel?: 'medium' | 'high'
}

/** One cumulative adaptive verification plan. */
export interface AdaptiveStageConfig {
  /** Repeated evaluations available at this stage. */
  nEvaluations: number
  /** Configured criterion names used at this stage; omission uses all criteria. */
  criteria?: string[]
}

/** Staged selection policy; omission preserves fixed verification behavior. */
export interface AdaptiveVerificationConfig {
  /** Whether candidate selection may escalate through stages. Default false. */
  enabled?: boolean
  /** Escalation policy. Default `staged` preserves cumulative PPT stages. */
  strategy?: 'staged' | 'top-two'
  /** Cumulative stages. Default evaluation counts are 1, 2, and 4. */
  stages?: AdaptiveStageConfig[]
  /** Top-two score gap below which targeted escalation runs. Defaults to `confidence.highGap`. */
  top2GapThreshold?: number
  /** Additional slot-symmetric top-pair evaluation rounds. Default one. */
  additionalEvaluations?: number
  /** Maximum verifier calls reserved for targeted escalation. Default eight. */
  maxExtraCalls?: number
  /** Reasoning effort for targeted escalation. Default high. */
  escalationReasoningEffort?: VerifierReasoningEffort
}

/** Verification-only spending limits checked between adaptive stages. */
export interface VerificationBudgetConfig {
  /** Maximum verifier model calls. Default 32. */
  maxCalls?: number
  /** Maximum verifier stage latency in milliseconds. Default 45000. */
  maxLatencyMs?: number
  /** Optional maximum non-cached input tokens. */
  maxInputTokens?: number
  /** Optional maximum output tokens. */
  maxOutputTokens?: number
  /** Optional maximum reasoning tokens. */
  maxReasoningTokens?: number
  /** Optional preflight ceiling for one worker operation's estimated API calls. */
  maxCallsPerOperation?: number
  /** Optional preflight ceiling for one selection operation's logical comparisons. */
  maxComparisons?: number
}

/** Loader configuration for the optional verifier provider. */
export interface Config {
  /** Fixed verifier model; the only accepted value is `deepseek-v4-flash`. */
  model?: typeof VERIFIER_MODEL
  /** Verifier endpoint; falls back to $VERIFIER_BASE_URL, then the official endpoint. */
  baseURL?: string
  /** Verifier-only credential reference. Default `DEEPSEEK_API_KEY`. */
  apiKeyEnv?: string
  /** Verifier request transport. `auto` uses native mode only for the official endpoint. */
  transport?: VerifierTransport
  /** Verifier-only first-use score-logprob probe budgets. */
  capabilityProbe?: CapabilityProbeConfig
  /** Output budget for generic-endpoint score-tag prefill requests. Default 2048. */
  scorePrefillMaxTokens?: number
  /** Named evaluation criteria used by pairwise comparison and selection. */
  criteria: Record<string, string>
  /** Repeated pairwise/final evaluations. Default one. */
  nEvaluations?: number
  /** Pivot count for Best-of-N selection. Default two. */
  pivots?: number
  /** Python verifier concurrency, independent from rollout concurrency. Default four. */
  maxWorkers?: number
  /** DeepSeek-native verifier reasoning effort. Default high. */
  reasoningEffort?: VerifierReasoningEffort
  /** Relative selection-certainty thresholds. */
  confidence?: ConfidenceConfig
  /** Optional staged Best-of-N verification. Omission keeps one fixed plan. */
  adaptive?: AdaptiveVerificationConfig
  /** Adaptive verification-only call, latency, and token limits. */
  budget?: VerificationBudgetConfig
  /** Propagate verifier failures instead of returning fail-open results. Default true. */
  strict?: boolean
  /** Python executable resolved through `ctx.subprocess`. Default `python3`. */
  pythonExecutable?: string
  /** Worker directory and `.env` lookup base. Default process working directory. */
  workingDirectory?: string
  /** Per-operation verifier deadline in milliseconds. Default 180000. */
  timeoutMs?: number
  /** Worker SIGTERM-to-kill grace in milliseconds. Default 2000. */
  workerGraceMs?: number
  /** Retained worker stderr diagnostic bound. Default 65536 bytes. */
  maxStderrBytes?: number
  /** Maximum JSON response size accepted from the worker. Default 1048576 bytes. */
  maxResponseBytes?: number
  /** Maximum retained assistant/tool field size. Default 65536 bytes. */
  maxFieldBytes?: number
  /** Maximum serialized candidate size. Default 524288 bytes. */
  maxTrajectoryBytes?: number
  /** Online progress settings. */
  progressTracking?: ProgressTrackingConfig
}

const CapabilityProbeConfig: z<CapabilityProbeConfig> = z.object({
  maxTokens: z.number().step(1).min(1).default(DEFAULT_CAPABILITY_PROBE_MAX_TOKENS),
  retryMaxTokens: z.number().step(1).min(1).default(DEFAULT_CAPABILITY_PROBE_RETRY_MAX_TOKENS),
})

const ProgressTrackingConfig: z<ProgressTrackingConfig> = z.object({
  enabled: z.boolean().default(false),
  nEvaluations: z.number().step(1).min(1).default(1),
})

const ConfidenceConfig: z<ConfidenceConfig> = z.object({
  mediumGap: z.number().min(0).max(1).default(DEFAULT_MEDIUM_CONFIDENCE_GAP),
  highGap: z.number().min(0).max(1).default(DEFAULT_HIGH_CONFIDENCE_GAP),
  targetLevel: z.union(['medium', 'high'] as const).default('high'),
})

const AdaptiveStageConfig: z<AdaptiveStageConfig> = z.object({
  nEvaluations: z.number().step(1).min(1).required(),
  criteria: z.array(z.string()).default(undefined as unknown as string[]),
})

const AdaptiveVerificationConfig: z<AdaptiveVerificationConfig> = z.object({
  enabled: z.boolean().default(false),
  strategy: z.union(['staged', 'top-two'] as const).default('staged'),
  stages: z.array(AdaptiveStageConfig).default(
    DEFAULT_ADAPTIVE_STAGES.map(nEvaluations => ({ nEvaluations })),
  ),
  top2GapThreshold: z.number().min(0).max(1),
  additionalEvaluations: z.number().step(1).min(1).default(1),
  maxExtraCalls: z.number().step(1).min(1).default(8),
  escalationReasoningEffort: z.union(['off', 'low', 'high'] as const).default('high'),
})

const VerificationBudgetConfig: z<VerificationBudgetConfig> = z.object({
  maxCalls: z.number().step(1).min(1).default(DEFAULT_ADAPTIVE_MAX_CALLS),
  maxLatencyMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS)
    .default(DEFAULT_ADAPTIVE_MAX_LATENCY_MS),
  maxCallsPerOperation: z.number().step(1).min(1),
  maxComparisons: z.number().step(1).min(1),
  maxInputTokens: z.number().step(1).min(1),
  maxOutputTokens: z.number().step(1).min(1),
  maxReasoningTokens: z.number().step(1).min(1),
})

export const Config: z<Config> = z.object({
  model: z.const(VERIFIER_MODEL).default(VERIFIER_MODEL),
  baseURL: z.string().default(DEFAULT_VERIFIER_BASE_URL),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_VERIFIER_API_KEY_ENV),
  transport: z.union(['auto', 'deepseek-native', 'openai-compatible'] as const)
    .default(DEFAULT_VERIFIER_TRANSPORT),
  capabilityProbe: CapabilityProbeConfig.default({}),
  scorePrefillMaxTokens: z.number().step(1).min(1).default(DEFAULT_SCORE_PREFILL_MAX_TOKENS),
  criteria: z.dict(z.string()).required(),
  nEvaluations: z.number().step(1).min(1).default(DEFAULT_N_EVALUATIONS),
  pivots: z.number().step(1).min(1).default(DEFAULT_PIVOTS),
  maxWorkers: z.number().step(1).min(1).default(DEFAULT_MAX_WORKERS),
  reasoningEffort: z.union(['off', 'low', 'high'] as const).default('high'),
  confidence: ConfidenceConfig.default({}),
  adaptive: AdaptiveVerificationConfig.default({}),
  budget: VerificationBudgetConfig.default({}),
  strict: z.boolean().default(true),
  pythonExecutable: z.string().default('python3'),
  workingDirectory: z.string().default(process.cwd()),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_TIMEOUT_MS),
  workerGraceMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_GRACE_MS),
  maxStderrBytes: z.number().step(1).min(1).default(DEFAULT_MAX_STDERR_BYTES),
  maxResponseBytes: z.number().step(1).min(1).default(DEFAULT_MAX_RESPONSE_BYTES),
  maxFieldBytes: z.number().step(1).min(1).default(DEFAULT_MAX_FIELD_BYTES),
  maxTrajectoryBytes: z.number().step(1).min(1).default(DEFAULT_MAX_TRAJECTORY_BYTES),
  progressTracking: ProgressTrackingConfig.default({}),
})

interface ResolvedConfig {
  readonly model: typeof VERIFIER_MODEL
  readonly baseURL: string
  readonly apiKeyEnv: string
  readonly transport: ResolvedVerifierTransport
  readonly capabilityProbe: {
    readonly maxTokens: number
    readonly retryMaxTokens: number
  }
  readonly scorePrefillMaxTokens: number
  readonly criteria: Readonly<Record<string, string>>
  readonly nEvaluations: number
  readonly pivots: number
  readonly maxWorkers: number
  readonly reasoningEffort: VerifierReasoningEffort
  readonly confidence: {
    readonly mediumGap: number
    readonly highGap: number
    readonly targetLevel: 'medium' | 'high'
  }
  readonly adaptive: {
    readonly enabled: boolean
    readonly strategy: 'staged' | 'top-two'
    readonly stages: readonly {
      readonly nEvaluations: number
      readonly criteria: Readonly<Record<string, string>>
    }[]
    readonly top2GapThreshold: number
    readonly additionalEvaluations: number
    readonly maxExtraCalls: number
    readonly escalationReasoningEffort: VerifierReasoningEffort
  }
  readonly budget: {
    readonly maxCalls: number
    readonly maxLatencyMs: number
    readonly maxInputTokens?: number
    readonly maxOutputTokens?: number
    readonly maxReasoningTokens?: number
    readonly maxCallsPerOperation?: number
    readonly maxComparisons?: number
  }
  readonly strict: boolean
  readonly pythonExecutable: string
  readonly workingDirectory: string
  readonly timeoutMs: number
  readonly workerGraceMs: number
  readonly maxStderrBytes: number
  readonly maxResponseBytes: number
  readonly maxFieldBytes: number
  readonly maxTrajectoryBytes: number
  readonly progressTracking: {
    readonly enabled: boolean
    readonly nEvaluations: number
  }
}

function positiveInteger(name: string, value: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`verifier-llm-as-verifier: ${name} must be a positive safe integer no greater than ${maximum}`)
  }
  return value
}

function optionalPositiveInteger(name: string, value: number | undefined): number | undefined {
  return value === undefined ? undefined : positiveInteger(name, value)
}

function reasoningEffort(name: string, value: unknown): VerifierReasoningEffort {
  if (value !== 'off' && value !== 'low' && value !== 'high') {
    throw new Error(`verifier-llm-as-verifier: ${name} is invalid`)
  }
  return value
}

/**
 * Resolve every default and validate programmatic config before publication.
 * @param config Raw loader or direct-call configuration.
 * @param environment Optional immutable launch environment used for endpoint fallback.
 * @returns Detached settings used for the provider lifetime.
 */
export function resolveConfig(
  config: Config,
  environment?: LaunchEnvironmentSnapshot,
): ResolvedConfig {
  const configuredModel: unknown = config.model
  if (configuredModel !== undefined && configuredModel !== VERIFIER_MODEL) {
    throw new Error('verifier-llm-as-verifier: model must be deepseek-v4-flash')
  }
  const configuredBaseURL = config.baseURL
    ?? environment?.get(VERIFIER_BASE_URL_ENV)?.value
    ?? DEFAULT_VERIFIER_BASE_URL
  const baseURL = configuredBaseURL.trim()
  if (baseURL === '') throw new Error('verifier-llm-as-verifier: baseURL must be non-empty')
  const apiKeyEnv = (config.apiKeyEnv ?? DEFAULT_VERIFIER_API_KEY_ENV).trim()
  if (apiKeyEnv === '') throw new Error('verifier-llm-as-verifier: apiKeyEnv must be non-empty')
  const requestedTransport: unknown = config.transport ?? DEFAULT_VERIFIER_TRANSPORT
  if (
    requestedTransport !== 'auto'
    && requestedTransport !== 'deepseek-native'
    && requestedTransport !== 'openai-compatible'
  ) {
    throw new Error('verifier-llm-as-verifier: transport is invalid')
  }
  const validTransport: VerifierTransport = requestedTransport
  const normalizedBaseURL = baseURL.toLowerCase().replace(/\/+$/, '')
  const transport: ResolvedVerifierTransport = validTransport === 'auto'
    ? normalizedBaseURL === DEFAULT_VERIFIER_BASE_URL || normalizedBaseURL === `${DEFAULT_VERIFIER_BASE_URL}/v1`
      ? 'deepseek-native'
      : 'openai-compatible'
    : validTransport
  const capabilityProbeMaxTokens = positiveInteger(
    'capabilityProbe.maxTokens',
    config.capabilityProbe?.maxTokens ?? DEFAULT_CAPABILITY_PROBE_MAX_TOKENS,
  )
  const capabilityProbeRetryMaxTokens = positiveInteger(
    'capabilityProbe.retryMaxTokens',
    config.capabilityProbe?.retryMaxTokens ?? DEFAULT_CAPABILITY_PROBE_RETRY_MAX_TOKENS,
  )
  if (capabilityProbeRetryMaxTokens <= capabilityProbeMaxTokens) {
    throw new Error(
      'verifier-llm-as-verifier: capabilityProbe.retryMaxTokens must exceed capabilityProbe.maxTokens',
    )
  }
  const scorePrefillMaxTokens = positiveInteger(
    'scorePrefillMaxTokens',
    config.scorePrefillMaxTokens ?? DEFAULT_SCORE_PREFILL_MAX_TOKENS,
  )
  const criteria = Object.fromEntries(Object.entries(config.criteria).map(([rawName, rawDescription]) => {
    const criterionName = rawName.trim()
    const description = rawDescription.trim()
    if (criterionName === '' || description === '') {
      throw new Error('verifier-llm-as-verifier: criteria names and descriptions must be non-empty')
    }
    return [criterionName, description]
  }))
  if (Object.keys(criteria).length === 0) {
    throw new Error('verifier-llm-as-verifier: criteria must contain at least one entry')
  }
  const mediumGap = config.confidence?.mediumGap ?? DEFAULT_MEDIUM_CONFIDENCE_GAP
  const highGap = config.confidence?.highGap ?? DEFAULT_HIGH_CONFIDENCE_GAP
  if (!Number.isFinite(mediumGap) || mediumGap < 0 || mediumGap > 1) {
    throw new Error('verifier-llm-as-verifier: confidence.mediumGap must be in [0, 1]')
  }
  if (!Number.isFinite(highGap) || highGap < 0 || highGap > 1) {
    throw new Error('verifier-llm-as-verifier: confidence.highGap must be in [0, 1]')
  }
  if (highGap < mediumGap) {
    throw new Error('verifier-llm-as-verifier: confidence.highGap must not be less than mediumGap')
  }
  const configuredTargetLevel: unknown = config.confidence?.targetLevel ?? 'high'
  if (configuredTargetLevel !== 'medium' && configuredTargetLevel !== 'high') {
    throw new Error('verifier-llm-as-verifier: confidence.targetLevel is invalid')
  }
  const targetLevel = configuredTargetLevel
  const configuredReasoningEffort = reasoningEffort(
    'reasoningEffort',
    config.reasoningEffort ?? 'high',
  )
  const configuredAdaptiveStrategy: unknown = config.adaptive?.strategy ?? 'staged'
  if (configuredAdaptiveStrategy !== 'staged' && configuredAdaptiveStrategy !== 'top-two') {
    throw new Error('verifier-llm-as-verifier: adaptive.strategy is invalid')
  }
  const top2GapThreshold = config.adaptive?.top2GapThreshold ?? highGap
  if (!Number.isFinite(top2GapThreshold) || top2GapThreshold < 0 || top2GapThreshold > 1) {
    throw new Error('verifier-llm-as-verifier: adaptive.top2GapThreshold must be in [0, 1]')
  }
  const additionalEvaluations = positiveInteger(
    'adaptive.additionalEvaluations',
    config.adaptive?.additionalEvaluations ?? 1,
  )
  const maxExtraCalls = positiveInteger(
    'adaptive.maxExtraCalls',
    config.adaptive?.maxExtraCalls ?? 8,
  )
  const escalationReasoningEffort = reasoningEffort(
    'adaptive.escalationReasoningEffort',
    config.adaptive?.escalationReasoningEffort ?? 'high',
  )
  const configuredStages: readonly AdaptiveStageConfig[] = config.adaptive?.stages
    ?? DEFAULT_ADAPTIVE_STAGES.map(nEvaluations => ({ nEvaluations }))
  if (configuredStages.length === 0) {
    throw new Error('verifier-llm-as-verifier: adaptive.stages must contain at least one stage')
  }
  let previousWork = new Set<string>()
  const adaptiveStages = configuredStages.map((stage, stageIndex) => {
    const nEvaluations = positiveInteger(`adaptive.stages[${stageIndex}].nEvaluations`, stage.nEvaluations)
    const names = (stage.criteria ?? Object.keys(criteria)).map(name => name.trim())
    if (names.length === 0 || new Set(names).size !== names.length) {
      throw new Error(`verifier-llm-as-verifier: adaptive.stages[${stageIndex}].criteria must be unique and non-empty`)
    }
    const stageCriteria = Object.fromEntries(names.map((criterionName) => {
      const description = criteria[criterionName]
      if (criterionName === '' || description === undefined) {
        throw new Error(
          `verifier-llm-as-verifier: adaptive.stages[${stageIndex}] references unknown criterion ${JSON.stringify(criterionName)}`,
        )
      }
      return [criterionName, description]
    }))
    const work = new Set(
      Object.keys(stageCriteria).flatMap(name => (
        Array.from({ length: nEvaluations }, (_, repetition) => `${name}\u0000${repetition}`)
      )),
    )
    if (stageIndex > 0 && (
      previousWork.size >= work.size
      || [...previousWork].some(key => !work.has(key))
    )) {
      throw new Error('verifier-llm-as-verifier: adaptive stages must add to all preceding work')
    }
    previousWork = work
    return { nEvaluations, criteria: stageCriteria }
  })
  const maxInputTokens = optionalPositiveInteger('budget.maxInputTokens', config.budget?.maxInputTokens)
  const maxOutputTokens = optionalPositiveInteger('budget.maxOutputTokens', config.budget?.maxOutputTokens)
  const maxReasoningTokens = optionalPositiveInteger(
    'budget.maxReasoningTokens',
    config.budget?.maxReasoningTokens,
  )
  const maxCallsPerOperation = optionalPositiveInteger(
    'budget.maxCallsPerOperation',
    config.budget?.maxCallsPerOperation,
  )
  const maxComparisons = optionalPositiveInteger(
    'budget.maxComparisons',
    config.budget?.maxComparisons,
  )
  const pythonExecutable = (config.pythonExecutable ?? 'python3').trim()
  if (pythonExecutable === '') throw new Error('verifier-llm-as-verifier: pythonExecutable must be non-empty')
  const workingDirectory = (config.workingDirectory ?? process.cwd()).trim()
  if (workingDirectory === '') throw new Error('verifier-llm-as-verifier: workingDirectory must be non-empty')
  return {
    model: VERIFIER_MODEL,
    baseURL,
    apiKeyEnv,
    transport,
    capabilityProbe: {
      maxTokens: capabilityProbeMaxTokens,
      retryMaxTokens: capabilityProbeRetryMaxTokens,
    },
    scorePrefillMaxTokens,
    criteria,
    nEvaluations: positiveInteger('nEvaluations', config.nEvaluations ?? DEFAULT_N_EVALUATIONS),
    pivots: positiveInteger('pivots', config.pivots ?? DEFAULT_PIVOTS),
    maxWorkers: positiveInteger('maxWorkers', config.maxWorkers ?? DEFAULT_MAX_WORKERS),
    reasoningEffort: configuredReasoningEffort,
    confidence: { mediumGap, highGap, targetLevel },
    adaptive: {
      enabled: config.adaptive?.enabled ?? false,
      strategy: configuredAdaptiveStrategy,
      stages: adaptiveStages,
      top2GapThreshold,
      additionalEvaluations,
      maxExtraCalls,
      escalationReasoningEffort,
    },
    budget: {
      maxCalls: positiveInteger('budget.maxCalls', config.budget?.maxCalls ?? DEFAULT_ADAPTIVE_MAX_CALLS),
      maxLatencyMs: positiveInteger(
        'budget.maxLatencyMs',
        config.budget?.maxLatencyMs ?? DEFAULT_ADAPTIVE_MAX_LATENCY_MS,
        MAX_TIMER_DELAY_MS,
      ),
      ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(maxReasoningTokens === undefined ? {} : { maxReasoningTokens }),
      ...(maxCallsPerOperation === undefined ? {} : { maxCallsPerOperation }),
      ...(maxComparisons === undefined ? {} : { maxComparisons }),
    },
    strict: config.strict ?? true,
    pythonExecutable,
    workingDirectory,
    timeoutMs: positiveInteger('timeoutMs', config.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMER_DELAY_MS),
    workerGraceMs: positiveInteger('workerGraceMs', config.workerGraceMs ?? DEFAULT_GRACE_MS, MAX_TIMER_DELAY_MS),
    maxStderrBytes: positiveInteger('maxStderrBytes', config.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES),
    maxResponseBytes: positiveInteger('maxResponseBytes', config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES),
    maxFieldBytes: positiveInteger('maxFieldBytes', config.maxFieldBytes ?? DEFAULT_MAX_FIELD_BYTES),
    maxTrajectoryBytes: positiveInteger(
      'maxTrajectoryBytes',
      config.maxTrajectoryBytes ?? DEFAULT_MAX_TRAJECTORY_BYTES,
    ),
    progressTracking: {
      enabled: config.progressTracking?.enabled ?? false,
      nEvaluations: positiveInteger(
        'progressTracking.nEvaluations',
        config.progressTracking?.nEvaluations ?? 1,
      ),
    },
  }
}

/**
 * Resolve Python, register one verifier, and own its worker lifecycle.
 * @param ctx Plugin context carrying verifier, subprocess, and credentials.
 * @param config Loader or direct-call configuration.
 */
function resolveBundledWorkerPath(): string {
  const candidates = [
    new URL('../worker.py', import.meta.url),
    new URL('../../worker.py', import.meta.url),
  ]
  const worker = candidates.find((candidate) => existsSync(fileURLToPath(candidate))) ?? new URL('../worker.py', import.meta.url)
  return fileURLToPath(worker)
}

interface ProviderGeneration {
  readonly resolved: ResolvedConfig
  readonly gateway: VerifierGateway
  readonly plugin: LLMAsVerifierPlugin
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
async function createGeneration(
  ctx: Context,
  config: Config,
  signal: AbortSignal,
): Promise<ProviderGeneration> {
  const resolved = resolveConfig(config, launchEnvironmentOf(ctx))
  const executable = await ctx.subprocess.resolveExecutable(resolved.pythonExecutable, undefined, signal)
  signal.throwIfAborted()
  const gateway = new PythonVerifierGateway(ctx, {
    executable,
    workerPath: resolveBundledWorkerPath(),
    cwd: resolved.workingDirectory,
    baseURL: resolved.baseURL,
    apiKeyEnv: resolved.apiKeyEnv,
    transport: resolved.transport,
    capabilityProbeMaxTokens: resolved.capabilityProbe.maxTokens,
    capabilityProbeRetryMaxTokens: resolved.capabilityProbe.retryMaxTokens,
    scorePrefillMaxTokens: resolved.scorePrefillMaxTokens,
    timeoutMs: resolved.timeoutMs,
    graceMs: resolved.workerGraceMs,
    maxStderrBytes: resolved.maxStderrBytes,
    maxResponseBytes: resolved.maxResponseBytes,
  })
  const adapter = new TrajectoryAdapter({
    maxFieldBytes: resolved.maxFieldBytes,
    maxTrajectoryBytes: resolved.maxTrajectoryBytes,
  })
  return {
    resolved,
    gateway,
    plugin: new LLMAsVerifierPlugin({
      gateway,
      adapter,
      criteria: resolved.criteria,
      nEvaluations: resolved.nEvaluations,
      pivots: resolved.pivots,
      maxWorkers: resolved.maxWorkers,
      reasoningEffort: resolved.reasoningEffort,
      confidence: resolved.confidence,
      adaptive: resolved.adaptive,
      budget: resolved.budget,
      strict: resolved.strict,
      progress: resolved.progressTracking,
      logger: ctx.logger,
    }),
  }
}
function probeFailureReason(error: unknown): string {
  if (error instanceof VerifierBackendError) {
    const reason = error.details?.failure_reason
    if (typeof reason === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(reason)) return reason
    if (error.code === 'VerifierCapabilityError') return 'LOGPROBS_UNAVAILABLE'
    if (error.code === 'VerifierProbeInconclusive') return 'PROBE_INCONCLUSIVE'
  }
  return 'REQUEST_FAILED'
}
async function testGeneration(
  ctx: Context,
  generation: ProviderGeneration,
  signal?: AbortSignal,
): Promise<VerifierCapabilityProbeResult> {
  const plugin = generation.plugin.id
  const credential = await ctx.credentials.resolve(credentialRef(generation.resolved.apiKeyEnv))
  if (credential === undefined) return { supported: false, plugin, reason: 'MISSING_CREDENTIAL' }
  const started = performance.now()
  try {
    const raw = await generation.gateway.request({ operation: 'capability' }, signal === undefined ? undefined : { signal })
    const capability = isRecord(raw) && isRecord(raw.capability) ? raw.capability : undefined
    const evidence = capability !== undefined && isRecord(capability.score_evidence)
      ? capability.score_evidence
      : undefined
    if (capability === undefined || capability.failure_reason !== 'SUPPORTED') {
      return { supported: false, plugin, reason: 'PROBE_INCONCLUSIVE' }
    }
    return {
      supported: true,
      plugin,
      model: VERIFIER_MODEL,
      endpointOrigin: new URL(generation.resolved.baseURL).origin,
      logprobsPresent: capability.logprobs_present === true,
      scorePositionFound: capability.score_token_present === true,
      scaleDistributionRecoverable: evidence?.score_distribution_extractable === true,
      latencyMs: Math.round(performance.now() - started),
    }
  } catch (error) {
    return { supported: false, plugin, reason: probeFailureReason(error) }
  }
}
/**
 * Register the provider directory entry and keep its implementation synchronized with live settings.
 * @param ctx Plugin context carrying verifier, subprocess, credentials, and optional settings.
 * @param config Loader or direct-call configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const lifecycle = new AbortController()
  const stopSetupCancellation = ctx.on('internal/plugin', (fiber) => {
    if (fiber === ctx.fiber && fiber.uid === null) {
      lifecycle.abort(new Error('verifier-llm-as-verifier setup disposed'))
    }
  })
  let source: () => Config = () => config
  let applied = source()
  let generation: ProviderGeneration
  try {
    generation = await createGeneration(ctx, applied, lifecycle.signal)
  } finally {
    stopSetupCancellation()
  }
  let rebuild = Promise.resolve()
  const ensureGeneration = async (): Promise<ProviderGeneration> => {
    const desired = source()
    if (desired === applied) return generation
    rebuild = rebuild.then(async () => {
      const latest = source()
      if (latest === applied || isAborted(lifecycle.signal)) return
      try {
        const next = await createGeneration(ctx, latest, lifecycle.signal)
        const previous = generation
        generation = next
        applied = latest
        await previous.gateway.dispose()
      } catch (error) {
        if (isAborted(lifecycle.signal)) return
        ctx.logger.error('verifier-llm-as-verifier: keeping the last good configuration after reload failed')
        ctx.logger.error(error)
      }
    })
    await rebuild
    return generation
  }
  installSettingsSection(ctx, VERIFIER_LLM_SETTINGS_NAMESPACE, Config, config, {
    setSource: (next) => { source = next },
    validate: (value) => { resolveConfig(value, launchEnvironmentOf(ctx)) },
    onChange: () => { void ensureGeneration() },
  })
  await ensureGeneration()
  const live: VerifierPlugin = {
    id: generation.plugin.id,
    model: VERIFIER_MODEL,
    score: async (task: string, trajectory: CanonicalTrajectory, call?: VerifierCallContext) =>
      (await ensureGeneration()).plugin.score(task, trajectory, call),
    compare: async (
      task: string,
      candidateA: CanonicalTrajectory,
      candidateB: CanonicalTrajectory,
      call?: VerifierCallContext,
    ): Promise<VerifierComparisonResult> =>
      (await ensureGeneration()).plugin.compare(task, candidateA, candidateB, call),
    select: async <T>(
      task: string,
      candidates: readonly VerifierCandidate<T>[],
      call?: VerifierCallContext,
    ): Promise<VerifierSelectionResult<T>> =>
      (await ensureGeneration()).plugin.select(task, candidates, call),
    onStepEnd: async (
      task: string,
      trajectory: CanonicalTrajectory,
      step: AgentStep,
      call?: VerifierCallContext,
    ): Promise<VerifierProgressResult | undefined> =>
      (await ensureGeneration()).plugin.onStepEnd(task, trajectory, step, call),
    onTrajectoryEnd: async (
      task: string,
      trajectory: CanonicalTrajectory,
      call?: VerifierCallContext,
    ): Promise<VerifierScoreResult | undefined> =>
      (await ensureGeneration()).plugin.onTrajectoryEnd(task, trajectory, call),
  }
  ctx.effect(() => {
    const unregister = ctx.verifier.register(live, {
      displayName: 'LLM-as-a-Verifier',
      settingsNamespace: VERIFIER_LLM_SETTINGS_NAMESPACE,
      credentialRefs: [DEFAULT_VERIFIER_API_KEY_ENV],
      probe: async signal => testGeneration(ctx, await ensureGeneration(), signal),
    })
    return async () => {
      unregister()
      lifecycle.abort(new Error('verifier-llm-as-verifier disposed'))
      await rebuild
      await generation.gateway.dispose()
    }
  }, 'verifier-llm-as-verifier.register')
}

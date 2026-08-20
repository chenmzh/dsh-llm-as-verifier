/** Generic verifier service, canonical trajectory adapter, and Best-of-N helper. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {
  AgentStep,
  CanonicalTrajectory,
  VerifierCallContext,
  VerifierCandidate,
  VerifierCapability,
  VerifierComparisonResult,
  VerifierPlugin,
  VerifierCapabilityProbeResult,
  VerifierPluginDescriptor,
  VerifierPluginRegistration,
  VerifierProgressResult,
  VerifierScoreResult,
  VerifierSelectionResult,
  VerifierSelectionSignal,
} from './types.ts'

export * from './types.ts'
export * from './trajectory.ts'
export * from './best-of-n.ts'

/** Settings namespace controlling whether verification participates in eligible orchestration. */
export const VERIFIER_SETTINGS_NAMESPACE = settingsNamespace('verifier')

/** User-owned verifier selection, independent of Worker model and rollout configuration. */
export interface VerifierSettings {
  /** Master switch; false makes the runtime expose no active implementation. */
  enabled: boolean
  /** Selected provider id, or null while none is selected. */
  plugin: string | null
}

/** Loader configuration; omitted fields preserve the inert defaults. */
export interface Config {
  /** Master switch; defaults to false. */
  enabled?: boolean
  /** Selected provider id; defaults to null. */
  plugin?: string | null
}

interface RegisteredVerifier {
  readonly plugin: VerifierPlugin
  readonly descriptor: VerifierPluginDescriptor
  readonly probe?: (signal?: AbortSignal) => Promise<VerifierCapabilityProbeResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    verifier: VerifierRuntime
  }

  interface Events {
    /**
     * Data-minimized observation after candidate selection succeeds. Candidate
     * objects, canonical trajectories, and task text are deliberately absent.
     * Listener failures are contained and never replace the selected result.
     * @param signal Verifier identity, candidate count, selection telemetry, and caller-supplied external outcomes.
     * @mode emit
     */
    'verifier/selection'(signal: VerifierSelectionSignal): void
  }
}

/** Single active verifier implementation with optional capability dispatch. */
export class VerifierRuntime extends Service {
  static Config: z<Config> = z.object({
    enabled: z.boolean().default(false),
    plugin: z.union([z.string(), z.const(null)]).default(null),
  })

  private readonly providers = new Map<string, RegisteredVerifier>()
  private source: () => Config

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'verifier')
    const entry: VerifierSettings = {
      enabled: config.enabled ?? false,
      plugin: config.plugin ?? null,
    }
    this.source = () => entry
    installSettingsSection(ctx, VERIFIER_SETTINGS_NAMESPACE, VerifierRuntime.Config, entry, {
      setSource: (source) => { this.source = source },
      onChange: () => {},
    })
  }

  /** Current selected verifier implementation, or `undefined` while disabled, unselected, or unavailable. */
  get current(): VerifierPlugin | undefined {
    const selection = this.source()
    if (!selection.enabled || selection.plugin == null) return undefined
    return this.providers.get(selection.plugin)?.plugin
  }

  /**
   * Register one verifier implementation and its configuration metadata.
   * @param plugin - implementation and its supported optional operations.
   * @param registration - display, settings, credential, and probe metadata.
   * @returns disposer that removes exactly this registration.
   * @throws when the id is empty or already registered.
   */
  register(plugin: VerifierPlugin, registration: VerifierPluginRegistration = {}): () => void {
    if (plugin.id.trim() === '') throw new Error('verifier: plugin id must be non-empty')
    if (this.providers.has(plugin.id)) throw new Error(`verifier: plugin "${plugin.id}" is already registered`)
    const provider: RegisteredVerifier = {
      plugin,
      descriptor: {
        id: plugin.id,
        displayName: registration.displayName ?? plugin.id,
        ...(registration.settingsNamespace === undefined ? {} : { settingsNamespace: registration.settingsNamespace }),
        ...(registration.credentialRefs === undefined ? {} : { credentialRefs: [...registration.credentialRefs] }),
        available: true,
      },
      ...(registration.probe === undefined ? {} : { probe: registration.probe }),
    }
    this.providers.set(plugin.id, provider)
    return () => {
      if (this.providers.get(plugin.id) === provider) this.providers.delete(plugin.id)
    }
  }

  /**
   * List registered implementations for configuration surfaces.
   * @returns Detached provider descriptors in registration order.
   */
  plugins(): VerifierPluginDescriptor[] {
    return [...this.providers.values()].map(({ descriptor }) => ({
      ...descriptor,
      ...(descriptor.credentialRefs === undefined ? {} : { credentialRefs: [...descriptor.credentialRefs] }),
    }))
  }

  /**
   * Run one provider's Host-owned capability probe.
   * @param pluginId Provider id from the directory.
   * @param signal Optional caller cancellation.
   * @returns Browser-safe capability facts or a stable failure reason.
   */
  testCapability(pluginId: string, signal?: AbortSignal): Promise<VerifierCapabilityProbeResult> {
    const provider = this.providers.get(pluginId)
    if (provider?.probe === undefined) {
      return Promise.resolve({ supported: false, plugin: pluginId, reason: 'PLUGIN_UNAVAILABLE' })
    }
    return provider.probe(signal)
  }

  /**
   * Test whether the current implementation exposes one optional operation.
   * @param capability Operation to inspect.
   * @returns Whether the operation can be dispatched.
   */
  supports(capability: VerifierCapability): boolean {
    const plugin = this.current
    return plugin !== undefined && typeof plugin[capability] === 'function'
  }

  /**
   * Dispatch final scoring to the configured implementation.
   * @param task Task the trajectory attempted.
   * @param trajectory Completed canonical trajectory.
   * @param context Optional cancellation and correlation fields.
   * @returns Structured score or fail-open metadata.
   */
  score(task: string, trajectory: CanonicalTrajectory, context?: VerifierCallContext): Promise<VerifierScoreResult> {
    return this.requireCapability('score').score(task, trajectory, context)
  }

  /**
   * Dispatch pairwise comparison to the configured implementation.
   * @param task Task both candidates attempted.
   * @param candidateA First canonical candidate.
   * @param candidateB Second canonical candidate.
   * @param context Optional cancellation and correlation fields.
   * @returns Scores and optional preferred candidate index.
   */
  compare(
    task: string,
    candidateA: CanonicalTrajectory,
    candidateB: CanonicalTrajectory,
    context?: VerifierCallContext,
  ): Promise<VerifierComparisonResult> {
    return this.requireCapability('compare').compare(task, candidateA, candidateB, context)
  }

  /**
   * Dispatch Best-of-N selection while preserving original candidates.
   * @param task Task every candidate attempted.
   * @param candidates Original results paired with canonical trajectories.
   * @param context Optional cancellation and correlation fields.
   * @returns Selection retaining the chosen original object.
   */
  async select<T>(
    task: string,
    candidates: readonly VerifierCandidate<T>[],
    context?: VerifierCallContext,
  ): Promise<VerifierSelectionResult<T>> {
    const plugin = this.requireCapability('select')
    const result = await plugin.select(task, candidates, context)
    const signal: VerifierSelectionSignal = {
      verifierId: plugin.id,
      ...(plugin.model === undefined ? {} : { model: plugin.model }),
      candidateCount: candidates.length,
      selection: {
        selectedIndex: result.selectedIndex,
        ...(result.scores === undefined ? {} : { scores: result.scores }),
        ...(result.ranking === undefined ? {} : { ranking: result.ranking }),
        ...(result.confidence === undefined ? {} : { confidence: result.confidence }),
        ...(result.verification === undefined ? {} : { verification: result.verification }),
        metadata: result.metadata,
      },
      ...(context?.evaluation === undefined ? {} : { evaluation: context.evaluation }),
    }
    try {
      this.ctx.emit('verifier/selection', signal)
    } catch (error) {
      this.ctx.logger.warn(`verifier: selection observer failed; selected result remains valid: ${String(error)}`)
    }
    return result
  }

  /**
   * Dispatch an optional post-step measurement.
   * @param task Task the trajectory is attempting.
   * @param trajectory Canonical trajectory through this step.
   * @param step Newly committed canonical step.
   * @param context Optional tracker, cancellation, and correlation fields.
   * @returns Progress measurement, or undefined when unsupported.
   */
  onStepEnd(
    task: string,
    trajectory: CanonicalTrajectory,
    step: AgentStep,
    context?: VerifierCallContext,
  ): Promise<VerifierProgressResult | undefined> {
    return this.current?.onStepEnd?.(task, trajectory, step, context) ?? Promise.resolve(undefined)
  }

  /**
   * Dispatch an optional completed-trajectory measurement.
   * @param task Task the trajectory attempted.
   * @param trajectory Completed canonical trajectory.
   * @param context Optional tracker, cancellation, and correlation fields.
   * @returns Final measurement, or undefined when unsupported.
   */
  onTrajectoryEnd(
    task: string,
    trajectory: CanonicalTrajectory,
    context?: VerifierCallContext,
  ): Promise<VerifierScoreResult | undefined> {
    return this.current?.onTrajectoryEnd?.(task, trajectory, context) ?? Promise.resolve(undefined)
  }

  private requireCapability<K extends 'score' | 'compare' | 'select'>(
    capability: K,
  ): VerifierPlugin & Required<Pick<VerifierPlugin, K>> {
    const plugin = this.current
    if (plugin === undefined) throw new Error('verifier: no enabled plugin is selected')
    if (plugin[capability] === undefined) {
      throw new Error(`verifier "${plugin.id}" does not support ${capability}`)
    }
    return plugin as VerifierPlugin & Required<Pick<VerifierPlugin, K>>
  }
}

export default VerifierRuntime

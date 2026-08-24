/** Generic verifier service, canonical trajectory adapter, and Best-of-N helper. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-commands'
import type { Session } from '@deepseek-ai/dsh-session'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {
  AgentStep,
  CanonicalTrajectory,
  VerifierCallContext,
  VerifierCandidate,
  VerifierCapability,
  VerifierDispatchContext,
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
import { effectiveVerifierMode, isVerifierSessionMode } from './session-mode.ts'

export * from './types.ts'
export * from './trajectory.ts'
export * from './session-mode.ts'
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

const VERIFIER_COMMAND_USAGE = 'Usage: /verifier [on|off|default|status]'

/** Remove the runtime-owned session before provider dispatch. */
function providerContext(context: VerifierDispatchContext | undefined): VerifierCallContext | undefined {
  if (context === undefined) return undefined
  return {
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(context.trackerId === undefined ? {} : { trackerId: context.trackerId }),
    ...(context.labels === undefined ? {} : { labels: context.labels }),
    ...(context.evaluation === undefined ? {} : { evaluation: context.evaluation }),
  }
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
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: 'verifier',
        description: 'Show or switch verifier use for this session',
        input: { hint: '[on|off|default|status]' },
        handler: ({ agent, rawInput }) => {
          const requested = rawInput.trim()
          if (requested === '' || requested === 'status') {
            return { kind: 'success', text: this.describe(agent.session) }
          }
          if (!isVerifierSessionMode(requested)) {
            return { kind: 'error', text: VERIFIER_COMMAND_USAGE }
          }
          return { kind: 'success', text: this.describe(agent.session, requested) }
        },
      })
    })
  }

  /** Current selected verifier implementation, or `undefined` while disabled, unselected, or unavailable. */
  get current(): VerifierPlugin | undefined {
    const selection = this.source()
    if (!selection.enabled || selection.plugin == null) return undefined
    return this.providers.get(selection.plugin)?.plugin
  }

  /**
   * Resolve the selected implementation for one session.
   * @param session Session whose durable mode may disable dispatch.
   * @returns The configured implementation, or `undefined` while globally or locally inactive.
   */
  currentFor(session?: Session): VerifierPlugin | undefined {
    const plugin = this.current
    if (plugin === undefined || session === undefined) return plugin
    return effectiveVerifierMode(session.events) === 'off' ? undefined : plugin
  }

  /**
   * Report whether one session can dispatch verifier work.
   * @param session Session whose durable mode participates in resolution.
   * @returns Whether a globally enabled, available provider is active for the session.
   */
  enabledFor(session: Session): boolean {
    return this.currentFor(session) !== undefined
  }

  /**
   * Render current session mode and effective availability for the human command result.
   * @param session Session whose durable mode is reported.
   * @param override Accepted mode whose command completion is still being recorded.
   * @returns Human-readable effective state and its controlling reason.
   */
  private describe(session: Session, override?: 'default' | 'on' | 'off'): string {
    const mode = override ?? effectiveVerifierMode(session.events)
    const selection = this.source()
    const effective = mode !== 'off' && this.current !== undefined ? 'on' : 'off'
    const reason = !selection.enabled
      ? 'global verifier is disabled'
      : selection.plugin == null
        ? 'no verifier plugin is selected'
        : this.providers.has(selection.plugin)
          ? `plugin ${selection.plugin}`
          : `plugin ${selection.plugin} is unavailable`
    return `Verifier ${effective} for this session (mode ${mode}; ${reason}).`
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
   * @param session Optional session whose durable mode participates in resolution.
   * @returns Whether the operation can be dispatched.
   */
  supports(capability: VerifierCapability, session?: Session): boolean {
    const plugin = this.currentFor(session)
    return plugin !== undefined && typeof plugin[capability] === 'function'
  }

  /**
   * Dispatch final scoring to the configured implementation.
   * @param task Task the trajectory attempted.
   * @param trajectory Completed canonical trajectory.
   * @param context Optional cancellation and correlation fields.
   * @returns Structured score or fail-open metadata.
   */
  score(task: string, trajectory: CanonicalTrajectory, context?: VerifierDispatchContext): Promise<VerifierScoreResult> {
    return this.requireCapability('score', context?.session).score(task, trajectory, providerContext(context))
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
    context?: VerifierDispatchContext,
  ): Promise<VerifierComparisonResult> {
    return this.requireCapability('compare', context?.session).compare(
      task,
      candidateA,
      candidateB,
      providerContext(context),
    )
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
    context?: VerifierDispatchContext,
  ): Promise<VerifierSelectionResult<T>> {
    const plugin = this.requireCapability('select', context?.session)
    const result = await plugin.select(task, candidates, providerContext(context))
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
    context?: VerifierDispatchContext,
  ): Promise<VerifierProgressResult | undefined> {
    return this.currentFor(context?.session)?.onStepEnd?.(
      task,
      trajectory,
      step,
      providerContext(context),
    ) ?? Promise.resolve(undefined)
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
    context?: VerifierDispatchContext,
  ): Promise<VerifierScoreResult | undefined> {
    return this.currentFor(context?.session)?.onTrajectoryEnd?.(
      task,
      trajectory,
      providerContext(context),
    ) ?? Promise.resolve(undefined)
  }

  private requireCapability<K extends 'score' | 'compare' | 'select'>(
    capability: K,
    session?: Session,
  ): VerifierPlugin & Required<Pick<VerifierPlugin, K>> {
    const plugin = this.currentFor(session)
    if (plugin === undefined) throw new Error('verifier: no enabled plugin is selected')
    if (plugin[capability] === undefined) {
      throw new Error(`verifier "${plugin.id}" does not support ${capability}`)
    }
    return plugin as VerifierPlugin & Required<Pick<VerifierPlugin, K>>
  }
}

export default VerifierRuntime

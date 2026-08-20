/** Post-commit session lifecycle Consumer for optional trajectory verification. */

import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  TrajectoryAdapter,
  VerifierTrackerId,
} from 'dsh-llm-as-verifier/core'
import type {
  AgentStep,
  CanonicalTrajectory,
  VerifierProgressResult,
  VerifierScoreResult,
} from 'dsh-llm-as-verifier/core'
import {
  buildVerifierEvaluationRecord,
  VerifierEvaluationJsonlWriter,
} from './evaluation.ts'

export * from './evaluation.ts'

/** Cordis plugin name used in loader diagnostics. */
export const name = 'verifier-observer'

/** The generic verifier runtime consumed by this plugin. */
export const inject = ['verifier']

const DEFAULT_MAX_FIELD_BYTES = 65_536
const DEFAULT_MAX_TRAJECTORY_BYTES = 524_288
const DEFAULT_EVALUATION_PATH = '.verifier-runs'
const DEFAULT_SHADOW_GAP = 0.08

/** Settings namespace owned by the verifier observer. */
export const VERIFIER_OBSERVER_SETTINGS_NAMESPACE = settingsNamespace('verifier-observer')

/** Observation-only top-two trigger projection. */
export interface AdaptiveShadowConfig {
  /** Record what top-two escalation would do without making another verifier call. Default false. */
  enabled?: boolean
  /** Score gap below which shadow policy reports an escalation. Default 0.08. */
  top2GapThreshold?: number
}

/** Private local evaluation-record settings. */
export interface EvaluationLoggingConfig {
  /** Append selection observations to local JSONL. Default false. */
  enabled?: boolean
  /** Local output directory. Default `.verifier-runs`. */
  path?: string
  /** Optional zero-call adaptive-policy observation. */
  adaptiveShadow?: AdaptiveShadowConfig
}

/** Adapter bounds for session-lifecycle verification. */
export interface Config {
  /** Maximum retained assistant/tool field size. Default 65536 bytes. */
  maxFieldBytes?: number
  /** Maximum serialized candidate size. Default 524288 bytes. */
  maxTrajectoryBytes?: number
  /** Optional privacy-minimized selection records; disabled by default. */
  evaluationLogging?: EvaluationLoggingConfig
}

export const Config: z<Config> = z.object({
  maxFieldBytes: z.number().step(1).min(1).default(DEFAULT_MAX_FIELD_BYTES),
  maxTrajectoryBytes: z.number().step(1).min(1).default(DEFAULT_MAX_TRAJECTORY_BYTES),
  evaluationLogging: z.object({
    enabled: z.boolean().default(false),
    path: z.string().default(DEFAULT_EVALUATION_PATH),
    adaptiveShadow: z.object({
      enabled: z.boolean().default(false),
      top2GapThreshold: z.number().min(0).max(1).default(DEFAULT_SHADOW_GAP),
    }),
  }),
})

/** Signal emitted after one committed step receives a progress measurement. */
export interface VerifierProgressSignal {
  readonly session: Session
  readonly task: string
  readonly trajectory: CanonicalTrajectory
  readonly step: AgentStep
  readonly result: VerifierProgressResult
}

/** Signal emitted after one committed turn receives a final measurement. */
export interface VerifierTrajectorySignal {
  readonly session: Session
  readonly task: string
  readonly trajectory: CanonicalTrajectory
  readonly result: VerifierScoreResult
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Auxiliary progress measurement after one durable step boundary.
     * Listener policy remains separate from measurement.
     * @param signal Session, canonical evidence, step, and verifier result.
     * @mode emit
     */
    'verifier/progress'(signal: VerifierProgressSignal): void
    /**
     * Auxiliary final measurement after one durable turn boundary.
     * @param signal Session, canonical evidence, and verifier result.
     * @mode emit
     */
    'verifier/trajectory'(signal: VerifierTrajectorySignal): void
  }
}

function positiveInteger(name: keyof Config, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`verifier-observer: ${name} must be a positive safe integer`)
  }
  return value
}

/**
 * Observe committed session boundaries and dispatch optional verifier hooks.
 * @param ctx Plugin context carrying the generic verifier runtime.
 * @param config Adapter bounds; programmatic calls receive the same defaults as Loader calls.
 */
export function apply(ctx: Context, config: Config = {}): void {
  let source: () => Config = () => config
  const validate = (value: Config): void => {
    const path = value.evaluationLogging?.path ?? DEFAULT_EVALUATION_PATH
    if (path.trim() === '') throw new Error('verifier-observer: evaluationLogging.path must be non-empty')
    const threshold = value.evaluationLogging?.adaptiveShadow?.top2GapThreshold ?? DEFAULT_SHADOW_GAP
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new Error('verifier-observer: evaluationLogging.adaptiveShadow.top2GapThreshold must be in [0, 1]')
    }
  }
  validate(config)
  installSettingsSection(ctx, VERIFIER_OBSERVER_SETTINGS_NAMESPACE, Config, config, {
    setSource: (next) => { source = next },
    validate,
    onChange: () => {},
  })
  const adapter = new TrajectoryAdapter({
    maxFieldBytes: positiveInteger(
      'maxFieldBytes',
      config.maxFieldBytes ?? DEFAULT_MAX_FIELD_BYTES,
    ),
    maxTrajectoryBytes: positiveInteger(
      'maxTrajectoryBytes',
      config.maxTrajectoryBytes ?? DEFAULT_MAX_TRAJECTORY_BYTES,
    ),
  })
  const queues = new WeakMap<Session, Promise<void>>()
  const pending = new Set<Promise<void>>()
  const writers = new Map<string, VerifierEvaluationJsonlWriter>()
  ctx.on('verifier/selection', (signal) => {
    const evaluation = source().evaluationLogging
    if (evaluation?.enabled !== true) return
    const path = evaluation.path ?? DEFAULT_EVALUATION_PATH
    let writer = writers.get(path)
    if (writer === undefined) {
      writer = new VerifierEvaluationJsonlWriter(path, ctx.logger)
      writers.set(path, writer)
    }
    writer.append(buildVerifierEvaluationRecord(signal, {
      adaptiveShadow: {
        enabled: evaluation.adaptiveShadow?.enabled ?? false,
        top2GapThreshold: evaluation.adaptiveShadow?.top2GapThreshold ?? DEFAULT_SHADOW_GAP,
      },
    }))
  })
  ctx.effect(() => async () => {
    await Promise.all([...writers.values()].map(writer => writer.close()))
  }, 'verifier-observer.evaluation-drain')

  const enqueue = (session: Session, work: () => Promise<void>): void => {
    const previous = queues.get(session) ?? Promise.resolve()
    const queued = previous.then(work).catch((error: unknown) => {
      ctx.logger.warn(
        `verifier-observer: session "${session.id}" measurement failed; trajectory remains valid: ${String(error)}`,
      )
    })
    queues.set(session, queued)
    pending.add(queued)
    void queued.then(() => {
      pending.delete(queued)
      if (queues.get(session) === queued) queues.delete(session)
    })
  }

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'step/end' && event.type !== 'turn/end') return
    const events = session.events
    const turn = event.data.turn
    const task = adapter.taskForTurn(events, turn)
    if (task === undefined) {
      ctx.logger.warn(`verifier-observer: session "${session.id}" turn ${turn} has no user task; measurement skipped`)
      return
    }
    const trajectory = adapter.adaptTurn(events, turn)
    const context = {
      trackerId: VerifierTrackerId(`${session.id}:${turn}`),
      labels: { sessionId: session.id, turn: String(turn) },
    }

    if (event.type === 'step/end') {
      const step = trajectory.steps.find(candidate => candidate.step === event.data.step)
      if (step === undefined) {
        ctx.logger.warn(
          `verifier-observer: session "${session.id}" turn ${turn} step ${event.data.step} has no canonical step; measurement skipped`,
        )
        return
      }
      enqueue(session, async () => {
        const result = await ctx.verifier.onStepEnd(task, trajectory, step, context)
        if (result !== undefined) ctx.emit('verifier/progress', { session, task, trajectory, step, result })
      })
      return
    }

    enqueue(session, async () => {
      const result = await ctx.verifier.onTrajectoryEnd(task, trajectory, context)
      if (result !== undefined) ctx.emit('verifier/trajectory', { session, task, trajectory, result })
    })
  })

  ctx.effect(() => async () => {
    await Promise.all(pending)
  }, 'verifier-observer.drain')
}

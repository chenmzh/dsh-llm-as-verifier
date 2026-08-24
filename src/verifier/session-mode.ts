/** Durable per-session verifier participation policy. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** How one session overrides the deployment verifier switch. */
export type VerifierSessionMode = 'default' | 'on' | 'off'

/** Every accepted session verifier mode, in command-advertisement order. */
export const VERIFIER_SESSION_MODES: readonly VerifierSessionMode[] = ['default', 'on', 'off']

/**
 * Test a command token before it participates in session policy.
 * @param value Candidate mode token.
 * @returns Whether the token is a known verifier session mode.
 */
export function isVerifierSessionMode(value: string): value is VerifierSessionMode {
  return VERIFIER_SESSION_MODES.some(mode => mode === value)
}

/**
 * Fold the last successfully completed verifier-mode command from a session log.
 * @param events Session events in log order.
 * @returns The last explicit mode, or `default` before the first switch.
 */
export function effectiveVerifierMode(events: readonly SessionEvent[]): VerifierSessionMode {
  const outcomes = new Map<string, 'success' | 'error'>()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type === 'command/done') {
      outcomes.set(event.data.commandId, event.data.kind)
      continue
    }
    if (event.type !== 'command/run'
      || event.data.name !== 'verifier'
      || event.data.args === undefined
      || outcomes.get(event.data.commandId) !== 'success') continue
    const mode = event.data.args.trim()
    if (isVerifierSessionMode(mode)) return mode
  }
  return 'default'
}

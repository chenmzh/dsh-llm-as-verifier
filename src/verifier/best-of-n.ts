import type {
  CanonicalTrajectory,
  VerifierCallContext,
  VerifierCandidate,
  VerifierSelectionResult,
} from './types.ts'

/** Selection dispatcher accepted by generation-independent Best-of-N orchestration. */
export interface VerifierSelectionDispatcher {
  readonly id?: string
  select?<T>(
    task: string,
    candidates: readonly VerifierCandidate<T>[],
    context?: VerifierCallContext,
  ): Promise<VerifierSelectionResult<T>>
}

/** Inputs for generation-independent Best-of-N orchestration. */
export interface BestOfNOptions<T> {
  readonly task: string
  readonly n: number
  /** Produce one independent completed candidate. */
  readonly run: (index: number, signal?: AbortSignal) => Promise<T>
  /** Adapt the completed candidate without changing its identity. */
  readonly adapt: (candidate: T, index: number) => CanonicalTrajectory
  /** Provider or {@link VerifierRuntime}-compatible dispatcher; the runtime also emits observation signals. */
  readonly verifier: VerifierSelectionDispatcher
  readonly context?: VerifierCallContext
}

/**
 * Generate N candidates independently, then ask only the verifier to select.
 * Generation remains owned by the caller and original candidate identities are
 * retained in the returned result.
 * @param options - task, rollout callback, adapter, verifier, and cancellation.
 * @returns verifier selection retaining every original candidate by identity.
 */
export async function runBestOfN<T>(options: BestOfNOptions<T>): Promise<VerifierSelectionResult<T>> {
  if (!Number.isSafeInteger(options.n) || options.n < 1) {
    throw new Error('verifier Best-of-N: n must be a positive safe integer')
  }
  if (options.verifier.select === undefined) {
    throw new Error(`verifier "${options.verifier.id ?? 'dispatcher'}" does not support candidate selection`)
  }
  options.context?.signal?.throwIfAborted()
  const originals = await Promise.all(
    Array.from({ length: options.n }, (_, index) => options.run(index, options.context?.signal)),
  )
  options.context?.signal?.throwIfAborted()
  const candidates: VerifierCandidate<T>[] = originals.map((original, index) => ({
    original,
    trajectory: options.adapt(original, index),
  }))
  return options.verifier.select(options.task, candidates, options.context)
}

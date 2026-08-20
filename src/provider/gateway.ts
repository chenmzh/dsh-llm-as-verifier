/** Managed subprocess transport for the optional Python verifier runtime. */

import { createHash } from 'node:crypto'
import type { Writable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { VerifierCallContext } from 'dsh-llm-as-verifier/core'
import type { ResolvedVerifierTransport } from './index.ts'

/** JSON request fields accepted by the bundled Python worker. */
export type WorkerRequest = Readonly<Record<string, unknown>> & { readonly operation: string }

/** Backend-declared verifier failure returned over an intact worker transport. */
export class VerifierBackendError extends Error {
  /** Backend exception class or stable error code. */
  readonly code: string
  /** Bounded backend-owned diagnostics when the worker supplied them. */
  readonly details: Readonly<Record<string, unknown>> | undefined

  /**
   * @param code Backend exception class or stable error code.
   * @param message Sanitized backend diagnostic.
   * @param details Bounded backend-owned diagnostics.
   */
  constructor(code: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message)
    this.name = 'VerifierBackendError'
    this.code = code
    this.details = details
  }
}

/** Minimal gateway consumed by {@link LLMAsVerifierPlugin}; tests replace it without Python. */
export interface VerifierGateway {
  /**
   * Execute one verifier worker operation.
   * @param request Operation and provider-neutral payload.
   * @param context Optional cancellation and correlation fields.
   * @returns Untrusted worker result for caller-owned validation.
   */
  request(request: WorkerRequest, context?: VerifierCallContext): Promise<unknown>

  /** Stop the owned worker process tree. */
  dispose(): Promise<void>
}

/** Resolved host and process settings for one Python gateway. */
export interface PythonVerifierGatewayOptions {
  readonly executable: string
  readonly workerPath: string
  readonly cwd: string
  readonly baseURL: string
  readonly apiKeyEnv: string
  readonly transport: ResolvedVerifierTransport
  readonly timeoutMs: number
  readonly capabilityProbeMaxTokens: number
  readonly capabilityProbeRetryMaxTokens: number
  readonly scorePrefillMaxTokens: number
  readonly graceMs: number
  readonly maxStderrBytes: number
  readonly maxResponseBytes: number
}

interface PendingResponse {
  readonly id: number
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly cleanup: () => void
}

function asError(error: unknown): Error {
  /* v8 ignore next -- owned stream and process promises reject with Error; coercion defends the generic interfaces. */
  return error instanceof Error ? error : new Error(String(error))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** One live, single-request-at-a-time JSON-lines connection. */
class WorkerConnection {
  private readonly stdin: Writable
  private readonly handle: SubprocessHandle
  private buffer = ''
  private pending: PendingResponse | undefined
  private failure: Error | undefined
  readonly closed: Promise<void>

  constructor(ctx: Context, options: PythonVerifierGatewayOptions, env: NodeJS.ProcessEnv) {
    this.handle = ctx.subprocess.spawn({
      argv: [options.executable, '-u', options.workerPath],
      cwd: options.cwd,
      env,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: options.maxStderrBytes },
      },
      graceMs: options.graceMs,
    })
    if (this.handle.stdin === undefined || this.handle.stdout === undefined) {
      this.handle.terminate()
      throw new Error('verifier-llm-as-verifier: subprocess dropped a piped protocol stream')
    }
    this.stdin = this.handle.stdin
    /* v8 ignore next -- Node delivers pipe write failures to the callback exercised below; the event is defensive. */
    this.stdin.on('error', (error) => { this.fail(error) })
    this.handle.stdout.on('data', (chunk: Buffer) => { this.onData(chunk, options.maxResponseBytes) })
    this.closed = this.handle.done.then(
      (outcome) => {
        this.fail(new Error(
          `verifier-llm-as-verifier: worker exited (code ${String(outcome.exitCode)}, signal ${String(outcome.signal)})`,
        ))
      },
      /* v8 ignore next -- managed subprocess handles settle with an exit outcome; rejection defends other providers. */
      (error: unknown) => { this.fail(asError(error)) },
    )
  }

  /** Send one request; the gateway serializes calls before reaching this method. */
  request(id: number, payload: WorkerRequest, signal: AbortSignal): Promise<unknown> {
    /* v8 ignore next -- the gateway discards failed connections before another request can reach them. */
    if (this.failure !== undefined) return Promise.reject(this.failure)
    /* v8 ignore next 3 -- the gateway's promise tail admits only one request to a connection. */
    if (this.pending !== undefined) {
      return Promise.reject(new Error('verifier-llm-as-verifier: worker already has a pending request'))
    }
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        this.handle.terminate()
        /* v8 ignore next -- timeout and caller abort signals always carry an Error reason. */
        this.fail(asError(signal.reason ?? new Error('verifier request aborted')))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
      this.pending = { id, resolve, reject, cleanup }
      /* v8 ignore next 4 -- closes the race between the gateway preflight and listener registration. */
      if (signal.aborted) {
        onAbort()
        return
      }
      /* v8 ignore start -- an OS-level pipe race is required for a write callback failure. */
      this.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (error?: Error | null) => {
        if (error !== undefined && error !== null) this.fail(error)
      })
      /* v8 ignore stop */
    })
  }

  /** Terminate and await the complete owned process tree. */
  async dispose(): Promise<void> {
    this.handle.terminate()
    await this.handle.waitForExit()
    await this.closed
  }

  private onData(chunk: Buffer, maxResponseBytes: number): void {
    this.buffer += chunk.toString('utf8')
    if (Buffer.byteLength(this.buffer, 'utf8') > maxResponseBytes) {
      this.handle.terminate()
      this.fail(new Error('verifier-llm-as-verifier: worker response exceeded maxResponseBytes'))
      return
    }
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line !== '') this.onLine(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private onLine(line: string): void {
    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch {
      this.handle.terminate()
      this.fail(new Error('verifier-llm-as-verifier: worker returned malformed JSON'))
      return
    }
    const pending = this.pending
    if (pending === undefined || !isRecord(frame) || frame.id !== pending.id || typeof frame.ok !== 'boolean') {
      this.handle.terminate()
      this.fail(new Error('verifier-llm-as-verifier: worker returned an invalid response envelope'))
      return
    }
    if (frame.ok) {
      this.pending = undefined
      pending.cleanup()
      pending.resolve(frame.result)
      return
    }
    const error = frame.error
    const errorDetails = isRecord(error) ? error.details : undefined
    if (
      !isRecord(error)
      || typeof error.code !== 'string'
      || typeof error.message !== 'string'
      || (errorDetails !== undefined && !isRecord(errorDetails))
    ) {
      this.handle.terminate()
      this.fail(new Error('verifier-llm-as-verifier: worker returned an invalid error envelope'))
      return
    }
    this.pending = undefined
    pending.cleanup()
    pending.reject(new VerifierBackendError(error.code, error.message, errorDetails))
  }

  private fail(error: Error): void {
    this.failure ??= error
    const pending = this.pending
    if (pending === undefined) return
    this.pending = undefined
    pending.cleanup()
    pending.reject(this.failure)
  }
}

/** Persistent Python worker gateway with per-operation credential resolution. */
export class PythonVerifierGateway implements VerifierGateway {
  private connection: WorkerConnection | undefined
  private credentialFingerprint: string | undefined
  private nextId = 1
  private tail: Promise<void> = Promise.resolve()

  /**
   * @param ctx Context carrying subprocess and credential services.
   * @param options Fully resolved process settings.
   */
  constructor(
    private readonly ctx: Context,
    private readonly options: PythonVerifierGatewayOptions,
  ) {}

  request(request: WorkerRequest, context?: VerifierCallContext): Promise<unknown> {
    const operation = async (): Promise<unknown> => await this.execute(request, context)
    const result = this.tail.then(operation, operation)
    this.tail = result.then(() => {}, () => {})
    return result
  }

  async dispose(): Promise<void> {
    await this.tail
    const connection = this.connection
    this.connection = undefined
    this.credentialFingerprint = undefined
    if (connection !== undefined) await connection.dispose()
  }

  private async execute(request: WorkerRequest, context?: VerifierCallContext): Promise<unknown> {
    context?.signal?.throwIfAborted()
    const { env, fingerprint } = await this.resolveEnvironment()
    context?.signal?.throwIfAborted()
    if (this.connection === undefined || fingerprint !== this.credentialFingerprint) {
      if (this.connection !== undefined) await this.connection.dispose()
      this.connection = new WorkerConnection(this.ctx, this.options, env)
      this.credentialFingerprint = fingerprint
    }

    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    const signal = context?.signal === undefined
      ? timeout
      : AbortSignal.any([context.signal, timeout])
    try {
      return await this.connection.request(this.nextId++, request, signal)
    } catch (error) {
      if (!(error instanceof VerifierBackendError)) {
        const failed = this.connection
        this.connection = undefined
        this.credentialFingerprint = undefined
        try {
          await failed.dispose()
        } catch {
          // The request's transport failure remains the authoritative diagnostic.
        }
      }
      throw error
    }
  }

  private async resolveEnvironment(): Promise<{ env: NodeJS.ProcessEnv; fingerprint: string }> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.options.apiKeyEnv))
    const env: NodeJS.ProcessEnv = {
      VERIFIER_BASE_URL: this.options.baseURL,
      VERIFIER_TRANSPORT: this.options.transport,
      VERIFIER_PROBE_MAX_TOKENS: String(this.options.capabilityProbeMaxTokens),
      VERIFIER_PROBE_RETRY_MAX_TOKENS: String(this.options.capabilityProbeRetryMaxTokens),
      VERIFIER_SCORE_PREFILL_MAX_TOKENS: String(this.options.scorePrefillMaxTokens),
    }
    const hash = createHash('sha256')
    hash.update(this.options.baseURL)
    hash.update('\0')
    hash.update(this.options.transport)
    hash.update('\0')
    hash.update(String(this.options.capabilityProbeMaxTokens))
    hash.update('\0')
    hash.update(String(this.options.capabilityProbeRetryMaxTokens))
    hash.update('\0')
    hash.update(String(this.options.scorePrefillMaxTokens))
    hash.update('\0')
    hash.update(this.options.apiKeyEnv)
    hash.update('\0')
    hash.update(resolved?.value ?? '')
    if (resolved !== undefined) env.VERIFIER_API_KEY = resolved.value
    return { env, fingerprint: hash.digest('hex') }
  }
}

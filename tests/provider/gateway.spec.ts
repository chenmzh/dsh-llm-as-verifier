import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CredentialProvider from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import VerifierRuntime from 'dsh-llm-as-verifier/core'
import {
  DEFAULT_VERIFIER_API_KEY_ENV,
  DEFAULT_VERIFIER_BASE_URL,
  PythonVerifierGateway,
  VerifierBackendError,
} from 'dsh-llm-as-verifier/provider'
import type { PythonVerifierGatewayOptions } from 'dsh-llm-as-verifier/provider'
import * as VerifierProvider from 'dsh-llm-as-verifier/provider'

type Response = Record<string, unknown> | string | undefined

class FakeCredentials extends CredentialProvider {
  readonly values = new Map<string, string>()

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return value === undefined ? undefined : { value, source: 'test' }
  }

  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    return { configured: this.values.has(ref), writable: true }
  }

  async set(ref: CredentialRef, value: string): Promise<void> {
    this.values.set(ref, value)
  }

  async unset(ref: CredentialRef): Promise<void> {
    this.values.delete(ref)
  }
}

class FakeHandle implements SubprocessHandle {
  readonly pid = 42
  readonly stdout: PassThrough | undefined
  readonly stdin: PassThrough | undefined
  readonly stderr = undefined
  readonly collected = {
    stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
  }
  readonly done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
  private finish!: (outcome: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
  terminated = false

  constructor(
    response: () => Response,
    streams = true,
  ) {
    this.stdout = streams ? new PassThrough() : undefined
    this.stdin = streams ? new PassThrough() : undefined
    this.done = new Promise((resolve) => { this.finish = resolve })
    let buffer = ''
    this.stdin?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>
        buffer = buffer.slice(newline + 1)
        const value = response()
        if (typeof value === 'string') this.stdout?.write(value)
        else if (value !== undefined) this.stdout?.write(`${JSON.stringify({ id: request.id, ...value })}\n`)
        newline = buffer.indexOf('\n')
      }
    })
  }

  terminate(): void {
    if (this.terminated) return
    this.terminated = true
    this.finish({ exitCode: null, signal: 'SIGTERM' })
  }

  async waitForExit(): Promise<boolean> {
    await this.done
    return true
  }
}

class FakeSubprocess extends SubprocessRuntime {
  readonly specs: SubprocessSpawnSpec[] = []
  readonly handles: FakeHandle[] = []
  readonly responses: Response[] = []
  streams = true

  async resolveExecutable(command: string): Promise<string> {
    return `/resolved/${command}`
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec)
    const handle = new FakeHandle(() => this.responses.shift(), this.streams)
    this.handles.push(handle)
    return handle
  }

  async spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    throw new Error('not implemented')
  }
}

const options = (overrides: Partial<PythonVerifierGatewayOptions> = {}): PythonVerifierGatewayOptions => ({
  executable: '/resolved/python3',
  workerPath: '/package/worker.py',
  cwd: '/workspace',
  baseURL: 'https://verifier.example/v1',
  apiKeyEnv: 'VERIFIER_TEST_KEY',
  transport: 'openai-compatible',
  capabilityProbeMaxTokens: 1_024,
  capabilityProbeRetryMaxTokens: 2_048,
  scorePrefillMaxTokens: 2_048,
  timeoutMs: 1_000,
  graceMs: 10,
  maxStderrBytes: 100,
  maxResponseBytes: 1_000,
  ...overrides,
})

async function setup(overrides?: Partial<PythonVerifierGatewayOptions>): Promise<{
  gateway: PythonVerifierGateway
  credentials: FakeCredentials
  subprocess: FakeSubprocess
}> {
  const ctx = new Context()
  await ctx.plugin(FakeCredentials)
  await ctx.plugin(FakeSubprocess)
  return {
    gateway: new PythonVerifierGateway(ctx, options(overrides)),
    credentials: ctx.credentials as FakeCredentials,
    subprocess: ctx.subprocess as FakeSubprocess,
  }
}

describe('PythonVerifierGateway', () => {
  it('forwards only resolved credential references and reuses a healthy worker', async () => {
    const { gateway, credentials, subprocess } = await setup()
    credentials.values.set('VERIFIER_TEST_KEY', 'secret-one')
    subprocess.responses.push(
      { ok: true, result: { score: 0.4 } },
      { ok: true, result: { score: 0.5 } },
      { ok: true, result: { score: 0.6 } },
    )
    await expect(gateway.request({ operation: 'score' })).resolves.toEqual({ score: 0.4 })
    await expect(gateway.request({ operation: 'score' })).resolves.toEqual({ score: 0.5 })
    expect(subprocess.specs).toHaveLength(1)
    expect(subprocess.specs[0]).toMatchObject({
      argv: ['/resolved/python3', '-u', '/package/worker.py'],
      cwd: '/workspace',
      env: {
        VERIFIER_BASE_URL: 'https://verifier.example/v1',
        VERIFIER_TRANSPORT: 'openai-compatible',
        VERIFIER_PROBE_MAX_TOKENS: '1024',
        VERIFIER_PROBE_RETRY_MAX_TOKENS: '2048',
        VERIFIER_SCORE_PREFILL_MAX_TOKENS: '2048',
        VERIFIER_API_KEY: 'secret-one',
      },
    })

    credentials.values.set('VERIFIER_TEST_KEY', 'secret-two')
    await expect(gateway.request({ operation: 'score' })).resolves.toEqual({ score: 0.6 })
    expect(subprocess.specs).toHaveLength(2)
    expect(subprocess.handles[0]!.terminated).toBe(true)
    expect(subprocess.specs[1]!.env).toEqual({
      VERIFIER_BASE_URL: 'https://verifier.example/v1',
      VERIFIER_TRANSPORT: 'openai-compatible',
      VERIFIER_PROBE_MAX_TOKENS: '1024',
      VERIFIER_PROBE_RETRY_MAX_TOKENS: '2048',
      VERIFIER_SCORE_PREFILL_MAX_TOKENS: '2048',
      VERIFIER_API_KEY: 'secret-two',
    })
    await gateway.dispose()
    expect(subprocess.handles[1]!.terminated).toBe(true)
  })

  it('resolves the default verifier credential independently of Worker configuration', async () => {
    const { gateway, credentials, subprocess } = await setup({
      baseURL: DEFAULT_VERIFIER_BASE_URL,
      apiKeyEnv: DEFAULT_VERIFIER_API_KEY_ENV,
      transport: 'deepseek-native',
    })
    credentials.values.set('DEEPSEEK_API_KEY', 'verifier-secret')
    subprocess.responses.push({ ok: true, result: { score: 0.4 } })
    await expect(gateway.request({ operation: 'score' })).resolves.toEqual({ score: 0.4 })
    expect(subprocess.specs[0]!.env).toEqual({
      VERIFIER_BASE_URL: 'https://api.deepseek.com',
      VERIFIER_TRANSPORT: 'deepseek-native',
      VERIFIER_PROBE_MAX_TOKENS: '1024',
      VERIFIER_PROBE_RETRY_MAX_TOKENS: '2048',
      VERIFIER_SCORE_PREFILL_MAX_TOKENS: '2048',
      VERIFIER_API_KEY: 'verifier-secret',
    })
    expect(subprocess.specs[0]!.env).not.toHaveProperty('DEEPSEEK_API_KEY')
    await gateway.dispose()
  })

  it('passes explicit native transport only to the verifier worker', async () => {
    const { gateway, credentials, subprocess } = await setup({
      baseURL: 'https://api.deepseek.com',
      transport: 'deepseek-native',
    })
    credentials.values.set('VERIFIER_TEST_KEY', 'secret')
    subprocess.responses.push({ ok: true, result: { score: 0.4 } })
    await expect(gateway.request({ operation: 'score' })).resolves.toEqual({ score: 0.4 })
    expect(subprocess.specs[0]!.env).toEqual({
      VERIFIER_BASE_URL: 'https://api.deepseek.com',
      VERIFIER_TRANSPORT: 'deepseek-native',
      VERIFIER_PROBE_MAX_TOKENS: '1024',
      VERIFIER_PROBE_RETRY_MAX_TOKENS: '2048',
      VERIFIER_SCORE_PREFILL_MAX_TOKENS: '2048',
      VERIFIER_API_KEY: 'secret',
    })
    await gateway.dispose()
  })

  it('ignores empty protocol lines before a valid response frame', async () => {
    const { gateway, subprocess } = await setup()
    subprocess.responses.push('\n{"id":1,"ok":true,"result":{"score":0.5}}\n')
    await expect(gateway.request({ operation: 'score' })).resolves.toEqual({ score: 0.5 })
    await gateway.dispose()
  })

  it('maps structured backend failures without replacing the healthy worker', async () => {
    const { gateway, subprocess } = await setup()
    subprocess.responses.push(
      {
        ok: false,
        error: {
          code: 'VerifierProbeInconclusive', message: 'probe exhausted',
          details: { failure_reason: 'OUTPUT_BUDGET_EXHAUSTED', output_tokens: 1_024 },
        },
      },
      { ok: true, result: { score: 0.7 } },
    )
    await expect(gateway.request({ operation: 'score' }))
      .rejects.toEqual(new VerifierBackendError(
        'VerifierProbeInconclusive', 'probe exhausted',
        { failure_reason: 'OUTPUT_BUDGET_EXHAUSTED', output_tokens: 1_024 },
      ))
    await expect(gateway.request({ operation: 'score' })).resolves.toEqual({ score: 0.7 })
    expect(subprocess.specs).toHaveLength(1)
    await gateway.dispose()
  })

  it.each([
    ['invalid error details', '{"id":1,"ok":false,"error":{"code":"E","message":"m","details":[]}}\n', 'invalid error envelope'],
    ['non-object error', '{"id":1,"ok":false,"error":"failed"}\n', 'invalid error envelope'],
    ['malformed JSON', 'not-json\n', 'malformed JSON'],
    ['wrong id', '{"id":999,"ok":true,"result":{}}\n', 'invalid response envelope'],
    ['invalid error', '{"id":1,"ok":false,"error":{}}\n', 'invalid error envelope'],
  ])('rejects %s and tears down the worker', async (_name, response, message) => {
    const { gateway, subprocess } = await setup()
    subprocess.responses.push(response)
    await expect(gateway.request({ operation: 'score' })).rejects.toThrow(message)
    expect(subprocess.handles[0]!.terminated).toBe(true)
    await gateway.dispose()
  })

  it('rejects oversized responses and missing protocol streams', async () => {
    const first = await setup({ maxResponseBytes: 8 })
    first.subprocess.responses.push('0123456789')
    await expect(first.gateway.request({ operation: 'score' })).rejects.toThrow('exceeded maxResponseBytes')

    const second = await setup()
    second.subprocess.streams = false
    await expect(second.gateway.request({ operation: 'score' })).rejects.toThrow('dropped a piped protocol stream')
    expect(second.subprocess.handles[0]!.terminated).toBe(true)
    await second.gateway.dispose()
  })

  it('aborts and times out a pending request without leaving its process tree alive', async () => {
    const aborted = await setup()
    aborted.subprocess.responses.push(undefined)
    const controller = new AbortController()
    const request = aborted.gateway.request({ operation: 'score' }, { signal: controller.signal })
    await new Promise(resolve => setImmediate(resolve))
    controller.abort(new Error('cancel verifier'))
    await expect(request).rejects.toThrow('cancel verifier')
    expect(aborted.subprocess.handles[0]!.terminated).toBe(true)

    const timed = await setup({ timeoutMs: 5 })
    timed.subprocess.responses.push(undefined)
    await expect(timed.gateway.request({ operation: 'score' })).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(timed.subprocess.handles[0]!.terminated).toBe(true)
  })

  it('disposes safely before a worker has started', async () => {
    const { gateway } = await setup()
    await expect(gateway.dispose()).resolves.toBeUndefined()
  })

  it('registers lazily through Cordis configuration and unregisters on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeCredentials)
    await ctx.plugin(FakeSubprocess)
    await ctx.plugin(VerifierRuntime, { enabled: true, plugin: 'llm-as-a-verifier' })
    expect(ctx.verifier.current).toBeUndefined()
    const fiber = await ctx.plugin(VerifierProvider, {
      baseURL: 'https://custom-verifier.example/v1',
      apiKeyEnv: 'CUSTOM_VERIFIER_KEY',
      criteria: { Correctness: 'Did it work?' },
      maxWorkers: 2,
      pythonExecutable: 'python3',
      workingDirectory: '/workspace',
    })
    expect(ctx.verifier.current).toMatchObject({
      id: 'llm-as-a-verifier',
      model: 'deepseek-v4-flash',
    })
    expect((ctx.subprocess as FakeSubprocess).specs).toHaveLength(0)
    await fiber.dispose()
    expect(ctx.verifier.current).toBeUndefined()

    const defaultWorkersFiber = await ctx.plugin(VerifierProvider, {
      criteria: { Correctness: 'Did it work?' },
      pythonExecutable: 'python3',
      workingDirectory: '/workspace',
    })
    expect(ctx.verifier.current).toMatchObject({ model: 'deepseek-v4-flash' })
    await defaultWorkersFiber.dispose()
    expect(ctx.verifier.current).toBeUndefined()
  })

  it('aborts executable resolution when provider setup is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeCredentials)
    await ctx.plugin(FakeSubprocess)
    await ctx.plugin(VerifierRuntime, { enabled: true, plugin: 'llm-as-a-verifier' })
    const lookupStarted = Promise.withResolvers<AbortSignal>()
    vi.spyOn(ctx.subprocess, 'resolveExecutable').mockImplementation(async (_command, _env, signal) => {
      if (signal === undefined) throw new Error('missing setup signal')
      lookupStarted.resolve(signal)
      return await new Promise<string>((_resolve, reject) => {
        const onAbort = (): void => {
          reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      })
    })

    const loading = ctx.plugin(VerifierProvider, {
      model: 'deepseek-v4-flash',
      criteria: { Correctness: 'Did it work?' },
    })
    const signal = await lookupStarted.promise
    const unrelated = await ctx.plugin(() => {})
    await unrelated.dispose()
    expect(signal.aborted).toBe(false)
    const disposing = loading.dispose()
    await expect(loading).rejects.toThrow('verifier-llm-as-verifier setup disposed')
    await expect(disposing).resolves.toBeUndefined()
    expect(signal.aborted).toBe(true)
    await ctx.fiber.dispose()
  })
})

const bundledWorkerPath = fileURLToPath(new URL('../../worker.py', import.meta.url))

const fakeVerifierModule = String.raw`
import math
import os
from . import fine_grained_reward as reward

_USAGE = {
    "calls": 0,
    "input_tokens": 0,
    "cached_input_tokens": 0,
    "output_tokens": 0,
    "reasoning_tokens": 0,
}

class ppt:
    @staticmethod
    def bradley_terry(reward_a, reward_b):
        return 1.0 / (1.0 + math.exp(-(reward_a - reward_b)))


def token_usage():
    return _USAGE

def _resolve_criteria(criteria, ground_truth_note):
    assert ground_truth_note is None
    return "", [
        {"id": name, "name": name, "description": description}
        for name, description in criteria.items()
    ]

def default_max_workers():
    return 3

score_pair_criterion = reward.score_pair_criterion
`

function fakeRewardModule(withLogprobs: boolean): string {
  return String.raw`
import os
from types import SimpleNamespace

class Completions:
    def create(self, *args, **kwargs):
        assert kwargs["model"] == "deepseek-v4-flash"
        assert kwargs["logprobs"] is True
        assert kwargs["top_logprobs"] == 20
        valid_a = [
            SimpleNamespace(token="A", logprob=0.0),
            SimpleNamespace(token=">A", logprob=-0.2),
            SimpleNamespace(token=" Answer", logprob=-0.5),
        ] if ${withLogprobs ? 'True' : 'False'} else []
        valid_b = [
            SimpleNamespace(token="T", logprob=0.0),
            SimpleNamespace(token=">T", logprob=-0.2),
            SimpleNamespace(token=" Test", logprob=-0.75),
        ] if ${withLogprobs ? 'True' : 'False'} else []
        invalid = [SimpleNamespace(token="The", logprob=0.0)]
        positions = [
            SimpleNamespace(token="<score_A>", logprob=0.0, top_logprobs=invalid),
            SimpleNamespace(token="A", logprob=0.0, top_logprobs=valid_a),
            SimpleNamespace(token="</score_A>", logprob=0.0, top_logprobs=invalid),
            SimpleNamespace(token="<score_B", logprob=0.0, top_logprobs=invalid),
            SimpleNamespace(token=">T", logprob=0.0, top_logprobs=valid_b),
            SimpleNamespace(token="</score_B>", logprob=0.0, top_logprobs=invalid),
        ]
        return SimpleNamespace(
            model="deepseek-v4-flash",
            usage=SimpleNamespace(
                prompt_tokens=8,
                completion_tokens=1,
            ),
            choices=[SimpleNamespace(
                finish_reason="stop",
                message=SimpleNamespace(
                    content="<score_A>A</score_A>\n<score_B>T</score_B>"
                ),
                logprobs=SimpleNamespace(content=positions),
            )],
        )

def score_pair_criterion(client, problem, candidate_a, candidate_b,
                         criterion, ground_truth_note, model, images):
    assert problem == "task"
    assert (candidate_a, candidate_b) in (("a", "b"), ("b", "a"))
    assert criterion == {
        "id": "Correctness",
        "name": "Correctness",
        "description": "works",
    }
    assert ground_truth_note == ""
    assert model == "deepseek-v4-flash"
    assert images is None
    response = client.chat.completions.create(
        model="worker-model",
        logprobs=False,
        top_logprobs=1,
    )
    choice = response.choices[0]
    tokens = [position.token for position in choice.logprobs.content]
    position_logprobs = [
        [(alternative.token, alternative.logprob) for alternative in position.top_logprobs]
        for position in choice.logprobs.content
    ]
    scores = (
        extract_score(choice.message.content, tokens, position_logprobs, "<score_A>"),
        extract_score(choice.message.content, tokens, position_logprobs, "<score_B>"),
    )
    return scores if candidate_a == "a" else tuple(reversed(scores))


class Client:
    def __init__(self):
        self.chat = SimpleNamespace(completions=Completions())

def create_openai_client(*, base_url, api_key):
    assert base_url == os.environ["EXPECTED_VERIFIER_BASE_URL"]
    assert api_key == "verifier-secret"
    return Client()
`
}

async function runBundledWorker(
  withLogprobs: boolean,
  requestModel = 'gpt-worker',
): Promise<Record<string, unknown>> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-verifier-worker-'))
  const packageDir = join(root, 'llm_verifier')
  await mkdir(packageDir)
  await writeFile(join(packageDir, '__init__.py'), fakeVerifierModule)
  await writeFile(join(packageDir, 'fine_grained_reward.py'), fakeRewardModule(withLogprobs))
  await writeFile(join(packageDir, 'progress.py'), 'def extract_progress_scores(*args):\n    return []\n')
  try {
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const baseURL = 'https://custom-verifier.example/v1'
      const child = spawn('python3', ['-u', bundledWorkerPath], {
        env: {
          ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
          PYTHONPATH: root,
          VERIFIER_BASE_URL: baseURL,
          VERIFIER_API_KEY: 'verifier-secret',
          EXPECTED_VERIFIER_BASE_URL: baseURL,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
      child.on('error', reject)
      child.on('close', () => {
        try {
          resolve(JSON.parse(stdout.trim()) as Record<string, unknown>)
        } catch {
          reject(new Error(`worker returned invalid output: ${stdout}; stderr: ${stderr}`))
        }
      })
      child.stdin.end(`${JSON.stringify({
        id: 1,
        operation: 'compare',
        problem: 'task',
        candidate_a: 'a',
        candidate_b: 'b',
        criteria: { Correctness: 'works' },
        model: requestModel,
        n_evaluations: 2,
        max_workers: 3,
      })}\n`)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('bundled DSV4 verifier worker', () => {
  it.each(['gpt-worker', 'claude-worker', 'local-worker', 'deepseek-v4-flash'])(
    'keeps the %s strategy separate from the fixed verifier client',
    async (workerModel) => {
      const response = await runBundledWorker(true, workerModel)
      if (response.ok !== true) throw new Error(JSON.stringify(response))
      expect(response).toMatchObject({
        ok: true,
        result: { scores: [1, 0] },
      })
    },
  )

  it('retains every direct comparison and raw-versus-normalized score evidence', async () => {
    const response = await runBundledWorker(true)
    const result = response.result as {
      details: {
        comparisons: Array<Record<string, unknown>>
        scheduled_comparisons: Array<Record<string, unknown>>
      }
    }
    expect(result.details.comparisons).toHaveLength(2)
    expect(result.details.comparisons).toMatchObject([
      {
        comparison_id: 'direct-0-c0-r0',
        phase: 'direct',
        candidate_a: 0,
        candidate_b: 1,
        slot_order: { slot_a: 0, slot_b: 1 },
        criterion: { id: 'Correctness', name: 'Correctness' },
        repetition: 0,
        reward_a: 1,
        reward_b: 0,
        raw_delta: 1,
        status: 'success',
        score_a: {
          raw_alternatives: [
            {
              token: 'A',
              normalized_letter: 'A',
              retained: true,
            },
            {
              token: '>A',
              normalized_letter: 'A',
              retained: false,
              discard_reason: 'duplicate_lower_probability',
            },
            {
              token: ' Answer',
              normalized_letter: null,
              retained: false,
            },
          ],
          normalized_scale: [{ letter: 'A', probability: 1 }],
          raw_alternative_count: 3,
          mapped_scale_token_count: 2,
          unique_scale_letter_count: 1,
          discarded_alternative_count: 2,
          scale_mass: 1,
          expected_reward: 1,
        },
        score_b: {
          raw_alternatives: [
            {
              token: 'T',
              normalized_letter: 'T',
              retained: true,
            },
            {
              token: '>T',
              normalized_letter: 'T',
              retained: false,
            },
            {
              token: ' Test',
              normalized_letter: null,
              retained: false,
            },
          ],
          normalized_scale: [{ letter: 'T', probability: 1 }],
          expected_reward: 0,
        },
        finish_reasons: ['stop'],
        usage: {
          calls: 1,
          input_tokens: 8,
          output_tokens: 1,
        },
      },
      {
        comparison_id: 'direct-0-c0-r1',
        slot_order: { slot_a: 1, slot_b: 0 },
        repetition: 1,
        reward_a: 1,
        reward_b: 0,
      },
    ])
    expect(result.details.scheduled_comparisons).toMatchObject([
      {
        comparison_id: 'direct-0',
        job_ids: ['direct-0-c0-r0', 'direct-0-c0-r1'],
        reward_a: 1,
        reward_b: 0,
      },
    ])
    const first = result.details.comparisons[0] as {
      score_a: { discarded_probability_mass: number }
      bradley_terry_preference: number
    }
    expect(first.score_a.discarded_probability_mass).toBeGreaterThan(0)
    expect(first.bradley_terry_preference).toBeCloseTo(0.7310585786)
  })

  it('returns a capability error instead of text-only scoring without logprobs', async () => {
    const response = await runBundledWorker(false)
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'VerifierCapabilityError',
        details: { failure_reason: 'EMPTY_TOP_LOGPROBS' },
      },
    })
    expect(JSON.stringify(response)).toContain('unusable score-position logprobs at <score_A>')
  })
})

const workerHelperProbe = String.raw`
import importlib.util
import json
import os
import sys
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("dsh_verifier_worker", sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def capability_error(call):
    try:
        call()
    except worker.VerifierCapabilityError as error:
        return str(error)
    raise AssertionError("expected VerifierCapabilityError")


def capability_failure(call):
    try:
        call()
    except worker.VerifierCapabilityError as error:
        return {
            "message": str(error),
            "reason": error.reason,
            "details": error.details,
        }
    raise AssertionError("expected VerifierCapabilityError")


def diagnostic_position(token, alternatives):
    return SimpleNamespace(
        token=token,
        logprob=-0.01,
        top_logprobs=[
            SimpleNamespace(token=alternative, logprob=-index)
            for index, alternative in enumerate(alternatives)
        ],
    )


def alignment_diagnostic(tokens, alternatives):
    choice = SimpleNamespace(
        logprobs=SimpleNamespace(content=[
            diagnostic_position(token, alternatives.get(index, ["The"]))
            for index, token in enumerate(tokens)
        ])
    )
    return worker._score_position_diagnostics(choice, "<score_A>")


alignment_diagnostics = {
    "separate": alignment_diagnostic(
        ["<score_A>", "A", "</score_A>"],
        {1: ["A", " B", "The"]},
    ),
    "tag_suffix_fused": alignment_diagnostic(
        ["<score_A", ">A", "</score_A>"],
        {1: [">A", "> B", "The"]},
    ),
    "tag_and_score_fused": alignment_diagnostic(
        ["<score_A>A", "</score_A>"],
        {0: ["<score_A>A", "<score_A>B", "The"]},
    ),
    "score_and_closing_fused": alignment_diagnostic(
        ["<score_A>", "A</score_A>"],
        {1: ["A</score_A>", "B</score_A>", "The"]},
    ),
    "no_scale_alternatives": alignment_diagnostic(
        ["<score_A>", "A", "</score_A>"],
        {1: ["The", "Answer"]},
    ),
    "wrong_adjacent_position": alignment_diagnostic(
        ["<score_A>", "\n", "A", "</score_A>"],
        {1: ["\n", "The"], 2: ["A", " B"]},
    ),
    "ambiguous": alignment_diagnostic(
        ["<score_A>", "Answer", "</score_A>"],
        {1: ["Answer", "Agent"]},
    ),
}


valid_tokens = {
    token: worker._normalize_score_token(token)
    for token in ("A", " A", ">A", "> A", "a", "> t")
}
invalid_tokens = {
    token: worker._normalize_score_token(token)
    for token in ("The", "Answer", "Agent", "Test", ">Agent", "", "AA")
}
pair_tokens = ["<score_A>", " A", "</score_A>", "<score_B", "> T", "</score_B>"]
pair_logprobs = [
    [("The", 0.0)],
    [(" A", 0.0), ("Agent", -0.1)],
    [],
    [],
    [("> T", 0.0), ("Test", -0.1)],
    [],
]
pair_scores = [
    worker._strict_extract_score("", pair_tokens, pair_logprobs, "<score_A>"),
    worker._strict_extract_score("", pair_tokens, pair_logprobs, "<score_B>"),
]
unrelated_tokens = ["The", "And", "Agent", "Test"]
unrelated_logprobs = [[(token, 0.0)] for token in unrelated_tokens]
missing_a_logprobs = list(pair_logprobs)
missing_a_logprobs[1] = [("Agent", 0.0)]
missing_b_logprobs = list(pair_logprobs)
missing_b_logprobs[4] = [("Test", 0.0)]
empty_b_logprobs = list(pair_logprobs)
empty_b_logprobs[4] = []
no_top_b_logprobs = list(pair_logprobs)
no_top_b_logprobs[4] = [(worker._NO_TOP_LOGPROBS_TOKEN, 0.0)]
malformed_b_logprobs = list(pair_logprobs)
malformed_b_logprobs[4] = [("T", "not-a-logprob")]
progress_tokens = ["<c1>", "A", "</c1>", "<c2", "> T", "</c2>"]
progress_logprobs = [[], [("A", 0.0)], [], [], [("> T", 0.0)], []]
progress_scores = worker._strict_extract_progress_scores(
    "", progress_tokens, progress_logprobs, 2
)
progress_missing = list(progress_logprobs)
progress_missing[4] = [("Test", 0.0)]


class Completions:
    def __init__(self):
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(choices=[])


class Client:
    def __init__(self):
        self.completions = Completions()
        self.chat = SimpleNamespace(completions=self.completions)


generic_base = Client()
generic = worker._VerifierClient(generic_base, False)
generic.chat.completions.create(model="worker", logprobs=False, top_logprobs=1)
generic.chat.completions.create(
    model="worker",
    max_tokens=1,
    extra_body={"continue_final_message": True},
)
native_base = Client()
native = worker._VerifierClient(native_base, True)
native.chat.completions.create(
    model="worker",
    logprobs=False,
    top_logprobs=1,
    extra_body={"thinking": {"type": "enabled"}, "reasoning_effort": "high"},
)
environment_before_policy = dict(os.environ)
with native.request_policy("low"):
    native.chat.completions.create(
        model="worker",
        extra_body={"thinking": {"type": "enabled"}, "reasoning_effort": "high"},
    )
with native.request_policy("off"):
    native.chat.completions.create(model="worker")

print(json.dumps({
    "alignment_diagnostics": alignment_diagnostics,
    "valid_tokens": valid_tokens,
    "invalid_tokens": invalid_tokens,
    "pair_scores": pair_scores,
    "unrelated_error": capability_error(
        lambda: worker._strict_extract_score(
            "<score_A>A</score_A>", unrelated_tokens, unrelated_logprobs, "<score_A>"
        )
    ),
    "missing_a_error": capability_error(
        lambda: worker._strict_extract_score(
            "<score_A>A</score_A>", pair_tokens, missing_a_logprobs, "<score_A>"
        )
    ),
    "missing_b_error": capability_error(
        lambda: worker._strict_extract_score(
            "<score_B>T</score_B>", pair_tokens, missing_b_logprobs, "<score_B>"
        )
    ),
    "missing_b_failure": capability_failure(
        lambda: worker._strict_extract_score(
            "<score_B>T</score_B>", pair_tokens, missing_b_logprobs, "<score_B>"
        )
    ),
    "empty_b_failure": capability_failure(
        lambda: worker._strict_extract_score(
            "<score_B>T</score_B>", pair_tokens, empty_b_logprobs, "<score_B>"
        )
    ),
    "no_top_b_failure": capability_failure(
        lambda: worker._strict_extract_score(
            "<score_B>T</score_B>", pair_tokens, no_top_b_logprobs, "<score_B>"
        )
    ),
    "malformed_b_failure": capability_failure(
        lambda: worker._strict_extract_score(
            "<score_B>T</score_B>", pair_tokens, malformed_b_logprobs, "<score_B>"
        )
    ),
    "text_fallback_error": capability_error(
        lambda: worker._strict_extract_score(
            "<score_A>A</score_A>", None, None, "<score_A>"
        )
    ),
    "progress_scores": progress_scores,
    "progress_error": capability_error(
        lambda: worker._strict_extract_progress_scores(
            "<c1>A</c1><c2>T</c2>", progress_tokens, progress_missing, 2
        )
    ),
    "generic_native": generic._llm_verifier_deepseek,
    "generic_kwargs": generic_base.completions.calls[0],
    "generic_prefill_kwargs": generic_base.completions.calls[1],
    "native_native": native._llm_verifier_deepseek,
    "native_kwargs": native_base.completions.calls[0],
    "native_low_kwargs": native_base.completions.calls[1],
    "native_off_kwargs": native_base.completions.calls[2],
    "reasoning_policy_mutated_environment": dict(os.environ) != environment_before_policy,
}))
`

async function runWorkerHelperProbe(): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn('python3', ['-c', workerHelperProbe, bundledWorkerPath], {
      env: process.env.PATH === undefined ? {} : { PATH: process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`worker helper probe failed: ${stderr}`))
        return
      }
      resolve(JSON.parse(stdout.trim()) as Record<string, unknown>)
    })
  })
}

const capabilityProbeScript = String.raw`
import importlib.util
import json
import os
import sys
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("dsh_verifier_worker_probe", sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def probe_response(*, finish_reason, content, output_tokens, reasoning_tokens, logprobs):
    invalid = [SimpleNamespace(token="Agent", logprob=0.0)]
    valid = [SimpleNamespace(token="A", logprob=0.0)]
    if logprobs == "missing":
        score_logprobs = None
    else:
        alternatives = valid if logprobs == "valid" else invalid
        score_logprobs = SimpleNamespace(content=[
            SimpleNamespace(token="<score_A>", logprob=0.0, top_logprobs=invalid),
            SimpleNamespace(token="A", logprob=0.0, top_logprobs=alternatives),
            SimpleNamespace(token="</score_A>", logprob=0.0, top_logprobs=invalid),
        ])
    return SimpleNamespace(
        model="deepseek-v4-flash",
        usage=SimpleNamespace(
            prompt_tokens=12,
            prompt_tokens_details=SimpleNamespace(cached_tokens=0),
            completion_tokens=output_tokens,
            completion_tokens_details=SimpleNamespace(
                reasoning_tokens=reasoning_tokens
            ),
        ),
        choices=[SimpleNamespace(
            finish_reason=finish_reason,
            message=SimpleNamespace(content=content),
            logprobs=score_logprobs,
        )],
    )


def classify(response, max_tokens=1024, attempt=1):
    try:
        return {
            "kind": "supported",
            "details": worker._classify_probe_response(
                response,
                max_tokens=max_tokens,
                attempt=attempt,
            ),
        }
    except (worker.VerifierProbeInconclusive, worker.VerifierCapabilityError) as error:
        return {
            "kind": type(error).__name__,
            "reason": error.reason,
            "message": str(error),
            "details": error.details,
        }


exhausted = classify(probe_response(
    finish_reason="length",
    content="",
    output_tokens=128,
    reasoning_tokens=128,
    logprobs="missing",
), max_tokens=128)
supported = classify(probe_response(
    finish_reason="stop",
    content="<score_A>A</score_A>",
    output_tokens=9,
    reasoning_tokens=4,
    logprobs="valid",
))
missing_logprobs = classify(probe_response(
    finish_reason="stop",
    content="<score_A>A</score_A>",
    output_tokens=9,
    reasoning_tokens=4,
    logprobs="missing",
))
no_score = classify(probe_response(
    finish_reason="stop",
    content="A",
    output_tokens=9,
    reasoning_tokens=4,
    logprobs="valid",
))
malformed_logprobs = classify(probe_response(
    finish_reason="stop",
    content="<score_A>A</score_A>",
    output_tokens=9,
    reasoning_tokens=4,
    logprobs="malformed",
))

incomplete_response = probe_response(
    finish_reason="stop",
    content="<score_A>A</score_A>",
    output_tokens=9,
    reasoning_tokens=0,
    logprobs="valid",
)
incomplete_response.choices[0].logprobs.content = [
    SimpleNamespace(
        token=">",
        logprob=-0.000001,
        top_logprobs=[
            SimpleNamespace(token=worker._NO_TOP_LOGPROBS_TOKEN, logprob=0.0),
        ],
    ),
    SimpleNamespace(
        token="<｜end▁of▁sentence｜>",
        logprob=0.0,
        top_logprobs=[
            SimpleNamespace(token=worker._NO_TOP_LOGPROBS_TOKEN, logprob=0.0),
        ],
    ),
]
incomplete_stream = classify(incomplete_response)



def exhausted_error(max_tokens, attempt):
    details = {
        "model": "deepseek-v4-flash",
        "finish_reason": "length",
        "input_tokens": 12,
        "cached_input_tokens": 0,
        "output_tokens": max_tokens,
        "reasoning_tokens": max_tokens,
        "logprobs_present": False,
        "score_token_present": False,
        "failure_reason": "OUTPUT_BUDGET_EXHAUSTED",
        "probe_attempt": attempt,
        "probe_max_tokens": max_tokens,
    }
    return worker.VerifierProbeInconclusive(
        worker.PROBE_INCONCLUSIVE,
        reason="OUTPUT_BUDGET_EXHAUSTED",
        details=details,
    )


original_probe = worker._probe_capability
retry_calls = []


def retry_probe(module, max_tokens, attempt):
    retry_calls.append(max_tokens)
    if attempt == 1:
        raise exhausted_error(max_tokens, attempt)
    return dict(supported["details"])


worker._capability_results.clear()
worker._probe_capability = retry_probe
try:
    retry_result = worker._ensure_capability(None)
    cached_result = worker._ensure_capability(None)
finally:
    worker._probe_capability = original_probe

cache_probe_calls = []


def cache_probe(module, max_tokens, attempt):
    cache_probe_calls.append((worker.VERIFIER_MODEL, os.environ.get("VERIFIER_BASE_URL")))
    return dict(supported["details"])


worker._capability_results.clear()
worker._probe_capability = cache_probe
os.environ["VERIFIER_BASE_URL"] = worker.DEFAULT_VERIFIER_BASE_URL
os.environ["VERIFIER_API_KEY"] = "cache-key-secret"
original_model = worker.VERIFIER_MODEL
try:
    cache_first = worker._ensure_capability(None)
    cache_second = worker._ensure_capability(None)
    os.environ["VERIFIER_BASE_URL"] = "https://other-verifier.test/v1"
    cache_changed_endpoint = worker._ensure_capability(None)
    worker.VERIFIER_MODEL = "deepseek-v4-flash-test-identity"
    cache_changed_model = worker._ensure_capability(None)
    cache_keys = [str(key) for key in worker._capability_results]
finally:
    worker.VERIFIER_MODEL = original_model
    os.environ.pop("VERIFIER_API_KEY", None)
    os.environ.pop("VERIFIER_BASE_URL", None)
    worker._probe_capability = original_probe

exhausted_calls = []


def always_exhausted(module, max_tokens, attempt):
    exhausted_calls.append(max_tokens)
    raise exhausted_error(max_tokens, attempt)


worker._capability_results.clear()
worker._probe_capability = always_exhausted
try:
    try:
        worker._ensure_capability(None)
    except worker.VerifierProbeInconclusive as error:
        twice_exhausted = {
            "kind": type(error).__name__,
            "reason": error.reason,
            "message": str(error),
            "details": error.details,
        }
    else:
        raise AssertionError("expected bounded probe exhaustion")
finally:
    worker._probe_capability = original_probe

os.environ["VERIFIER_TEST_SECRET"] = "probe-secret-value"
safe_message = worker._safe_message(
    RuntimeError("request rejected probe-secret-value")
)
del os.environ["VERIFIER_TEST_SECRET"]

print(json.dumps({
    "exhausted": exhausted,
    "supported": supported,
    "missing_logprobs": missing_logprobs,
    "no_score": no_score,
    "malformed_logprobs": malformed_logprobs,
    "incomplete_stream": incomplete_stream,
    "retry_calls": retry_calls,
    "retry_result": retry_result,
    "cached_result": cached_result,
    "cache_probe_calls": cache_probe_calls,
    "cache_first": cache_first,
    "cache_second": cache_second,
    "cache_changed_endpoint": cache_changed_endpoint,
    "cache_changed_model": cache_changed_model,
    "cache_keys": cache_keys,
    "exhausted_calls": exhausted_calls,
    "twice_exhausted": twice_exhausted,
    "safe_message": safe_message,
}))
`

async function runCapabilityProbe(): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn('python3', ['-c', capabilityProbeScript, bundledWorkerPath], {
      env: process.env.PATH === undefined ? {} : { PATH: process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`capability probe helper failed: ${stderr}`))
        return
      }
      resolve(JSON.parse(stdout.trim()) as Record<string, unknown>)
    })
  })
}

const selectionCacheProbeScript = String.raw`
import importlib.util
import json
import math
import os
import sys

spec = importlib.util.spec_from_file_location("dsh_verifier_worker_cache", sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class FakePPT:
    @staticmethod
    def ring_cycle(candidate_count, unused_rng):
        assert candidate_count == 2
        return [(0, 1), (1, 0)]

    @staticmethod
    def bradley_terry(reward_a, reward_b):
        return 1.0 / (1.0 + math.exp(-(reward_a - reward_b)))

    @staticmethod
    def select_pivots(wins, counts, pivot_count):
        assert pivot_count == 1
        return [max(range(2), key=lambda index: (wins[index] / counts[index], -index))]

    @staticmethod
    def pivot_round_pairs(candidate_count, pivots):
        assert candidate_count == 2
        pivot = pivots[0]
        return [(1 - pivot, pivot)]


class FakeModule:
    ppt = FakePPT

    def __init__(self):
        self.usage = {
            "calls": 0,
            "input_tokens": 0,
            "cached_input_tokens": 0,
            "output_tokens": 0,
            "reasoning_tokens": 0,
        }
        self.call_ids = []

    def token_usage(self):
        return dict(self.usage)

    def default_max_workers(self):
        return 1

    def _resolve_criteria(self, criteria, ground_truth_note):
        assert ground_truth_note is None
        return "", [
            {"id": name, "name": name, "description": description}
            for name, description in criteria.items()
        ]

    def score_pair_criterion(self, client, problem, trace_a, trace_b,
                             criterion, ground_truth_note, model, images):
        assert client is verifier_client
        assert problem == "task"
        assert criterion["id"] == "Correctness"
        assert ground_truth_note == ""
        assert model == worker.VERIFIER_MODEL
        assert images is None
        comparison_id = worker._current_comparison()["comparison_id"]
        self.call_ids.append(comparison_id)
        self.usage["calls"] += 1
        if comparison_id.startswith("ring-0-"):
            return 0.9, 0.1
        if comparison_id.startswith("ring-1-"):
            return 0.2, 0.8
        if comparison_id.startswith("pivot-0-"):
            return 0.4, 0.6
        if comparison_id.startswith("adaptive-0-"):
            return 0.7, 0.3
        if comparison_id.startswith("adaptive-1-"):
            return 0.2, 0.8
        raise AssertionError(f"unexpected comparison {comparison_id}")


module = FakeModule()
class VerifierClient:
    def __init__(self):
        self.policy = worker._VerifierRequestPolicy()

    def request_policy(self, effort):
        return self.policy.use(effort)


verifier_client = VerifierClient()
worker._module = lambda: module
capability_calls = 0


def ensure_capability(unused):
    global capability_calls
    capability_calls += 1
    if capability_calls == 1:
        module.usage.update({
            "calls": module.usage["calls"] + 1,
            "input_tokens": module.usage["input_tokens"] + 8,
            "output_tokens": module.usage["output_tokens"] + 2,
        })
        return {"failure_reason": "SUPPORTED", "cache_hit": False}
    return {"failure_reason": "SUPPORTED", "cache_hit": True}


worker._ensure_capability = ensure_capability
worker._client = lambda: verifier_client
cache_id = "adaptive-cache-test"
cache_path = worker._selection_cache_path(cache_id)
try:
    os.remove(cache_path)
except FileNotFoundError:
    pass

base_request = {
    "operation": "select",
    "problem": "task",
    "candidates": ["a", "b"],
    "criteria": {"Correctness": "works"},
    "model": worker.VERIFIER_MODEL,
    "n_evaluations": 1,
    "pivots": 1,
    "max_workers": 1,
}
no_cache = worker._select_candidates(module, base_request, None)
no_cache_call_ids = list(module.call_ids)
module.call_ids.clear()
module.usage["calls"] = 0

first = worker._execute({**base_request, "cache_id": cache_id})
first_call_ids = list(module.call_ids)
module.call_ids.clear()
escalation = worker._execute({
    **base_request,
    "operation": "select_escalation",
    "cache_id": cache_id,
    "baseline_n_evaluations": 1,
    "n_evaluations": 1,
    "adaptive_pairs": [[0, 1], [1, 0]],
    "reasoning_effort": "high",
})
escalation_call_ids = list(module.call_ids)
module.call_ids.clear()
second = worker._execute({
    **base_request,
    "n_evaluations": 2,
    "cache_id": cache_id,
})
second_call_ids = list(module.call_ids)
existed_before_release = os.path.exists(cache_path)
released = worker._execute({"operation": "release_cache", "cache_id": cache_id})

try:
    worker._select_candidates(module, {
        **base_request,
        "operation": "select_escalation",
        "baseline_n_evaluations": 1,
        "adaptive_pairs": [[0, 1], [1, 0]],
    }, worker._selection_cache_path("missing-baseline-cache"))
except RuntimeError as error:
    missing_baseline_error = str(error)
else:
    raise AssertionError("targeted escalation accepted a missing baseline cache")

try:
    worker._execute({**base_request, "max_calls_per_operation": 2})
except worker.VerifierBudgetError as error:
    budget_error = {"message": str(error), "details": error.details}
else:
    raise AssertionError("operation budget accepted an oversized selection")

try:
    worker._selection_cache_path("../escape")
except ValueError as error:
    invalid_error = str(error)
else:
    raise AssertionError("invalid cache id was accepted")

print(json.dumps({
    "no_cache": no_cache,
    "no_cache_call_ids": no_cache_call_ids,
    "first": first,
    "first_call_ids": first_call_ids,
    "escalation": escalation,
    "escalation_call_ids": escalation_call_ids,
    "second_usage": second["usage"],
    "first_telemetry": first["details"]["telemetry"],
    "second_telemetry": second["details"]["telemetry"],
    "capability_calls": capability_calls,
    "budget_error": budget_error,
    "second_call_ids": second_call_ids,
    "existed_before_release": existed_before_release,
    "exists_after_release": os.path.exists(cache_path),
    "release_usage": released["usage"],
    "missing_baseline_error": missing_baseline_error,
    "invalid_error": invalid_error,
}))
`

async function runSelectionCacheProbe(): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn('python3', ['-c', selectionCacheProbeScript, bundledWorkerPath], {
      env: process.env.PATH === undefined ? {} : { PATH: process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`selection cache helper failed: ${stderr}`))
        return
      }
      resolve(JSON.parse(stdout.trim()) as Record<string, unknown>)
    })
  })
}

describe('phase-stable selection aggregation', () => {
  it('retains every ring and pivot occurrence with and without a cache', async () => {
    const result = await runSelectionCacheProbe()
    expect(result.no_cache_call_ids).toEqual([
      'ring-0-c0-r0',
      'ring-1-c0-r0',
      'pivot-0-c0-r0',
    ])
    expect(result.first_call_ids).toEqual(result.no_cache_call_ids)
    expect(result.second_call_ids).toEqual([
      'ring-0-c0-r1',
      'ring-1-c0-r1',
      'pivot-0-c0-r1',
    ])
    expect(result.escalation_call_ids).toEqual([
      'adaptive-0-c0-r0',
      'adaptive-1-c0-r0',
    ])
    expect(result.escalation).toMatchObject({
      details: {
        n_comparisons: 2,
        comparisons: [
          { comparison_id: 'adaptive-0-c0-r0', cached: false },
          { comparison_id: 'adaptive-1-c0-r0', cached: false },
        ],
        telemetry: {
          operation: 'select_escalation',
          planned_comparisons: 2,
          planned_verifier_calls: 2,
          comparisons: 2,
          verifier_calls: 2,
          reasoning_effort: 'high',
        },
      },
      usage: { calls: 2 },
    })
    expect(result.no_cache).toMatchObject({
      selected_index: 0,
      details: {
        n_comparisons: 3,
        scheduled_comparisons: [
          {
            comparison_id: 'ring-0',
            reward_a: 0.9,
            reward_b: 0.1,
            job_ids: ['ring-0-c0-r0'],
          },
          {
            comparison_id: 'ring-1',
            reward_a: 0.2,
            reward_b: 0.8,
            job_ids: ['ring-1-c0-r0'],
          },
          {
            comparison_id: 'pivot-0',
            reward_a: 0.4,
            reward_b: 0.6,
            job_ids: ['pivot-0-c0-r0'],
          },
        ],
      },
    })
    expect(result.first).toMatchObject({
      selected_index: 0,
      scores: (result.no_cache as { scores: number[] }).scores,
      usage: { calls: 3 },
    })
    const scheduled = (
      result.no_cache as {
        details: { scheduled_comparisons: Array<{ reward_a: number; reward_b: number }> }
      }
    ).details.scheduled_comparisons
    expect(scheduled).toHaveLength(3)
    expect(scheduled.every(item => item.reward_a !== 0.5 && item.reward_b !== 0.5)).toBe(true)
    expect(result.second_usage).toMatchObject({ calls: 3 })
    expect(result.existed_before_release).toBe(true)
    expect(result.exists_after_release).toBe(false)
    expect(result.first_telemetry).toMatchObject({
      operation: 'select',
      endpoint: 'https://api.deepseek.com',
      candidate_count: 2,
      criteria_count: 1,
      n_evaluations: 1,
      planned_comparisons: 3,
      planned_verifier_calls: 3,
      comparisons: 3,
      verifier_calls: 3,
      max_workers: 1,
      capability_probe: {
        executed: true,
        cached: false,
        usage: { calls: 1, input_tokens: 8, output_tokens: 2 },
      },
    })
    expect(result.second_telemetry).toMatchObject({
      n_evaluations: 2,
      planned_verifier_calls: 6,
      verifier_calls: 3,
      capability_probe: {
        executed: false,
        cached: true,
        usage: { calls: 0 },
      },
    })
    expect(result.capability_calls).toBe(3)
    expect(result.budget_error).toMatchObject({
      details: {
        failure_reason: 'MAX_CALLS_PER_OPERATION',
        planned_verifier_calls: 3,
      },
    })
    expect(result.release_usage).toMatchObject({ calls: 0 })
    expect(result.missing_baseline_error).toContain('baseline comparison missing')
    expect(result.invalid_error).toContain('bounded identifier characters')
  })
})

describe('DSV4 capability probe classification', () => {
  it('treats reasoning-only length completion as inconclusive', async () => {
    const result = await runCapabilityProbe()
    expect(result.exhausted).toMatchObject({
      kind: 'VerifierProbeInconclusive',
      reason: 'OUTPUT_BUDGET_EXHAUSTED',
      details: {
        finish_reason: 'length',
        output_tokens: 128,
        reasoning_tokens: 128,
        logprobs_present: false,
        score_token_present: false,
      },
    })
    expect(JSON.stringify(result.exhausted)).toContain('does not prove')
  })

  it('distinguishes supported, unavailable, missing-score, and malformed responses', async () => {
    const result = await runCapabilityProbe()
    expect(result.supported).toMatchObject({
      kind: 'supported',
      details: {
        failure_reason: 'SUPPORTED',
        logprobs_present: true,
        score_token_present: true,
        score_evidence: {
          chosen_score_text: 'A',
          score_tokenization_class: 'SEPARATE_SCORE_TOKEN',
          score_distribution_extractable: true,
          score_position_candidates: [{
            position: 1,
            chosen_token: 'A',
          }],
          distribution: {
            expected_reward: 1,
          },
        },
      },
    })
    expect(result.missing_logprobs).toMatchObject({
      kind: 'VerifierCapabilityError',
      reason: 'LOGPROBS_UNAVAILABLE',
    })
    expect(result.no_score).toMatchObject({
      kind: 'VerifierProbeInconclusive',
      reason: 'NO_SCORE_TOKEN',
    })
    expect(result.malformed_logprobs).toMatchObject({
      kind: 'VerifierCapabilityError',
      reason: 'NO_VALID_SCALE_TOKEN',
      details: {
        score_evidence: {
          chosen_score_text: 'A',
          score_tokenization_class: 'TOP_LOGPROBS_MISSING_SCALE_ALTERNATIVES',
          score_distribution_extractable: false,
          extraction: { failure_reason: 'NO_VALID_SCALE_TOKEN' },
        },
      },
    })
    expect(result.incomplete_stream).toMatchObject({
      kind: 'VerifierCapabilityError',
      reason: 'NO_SCORE_POSITION',
      details: {
        logprobs_present: true,
        score_token_present: true,
        score_evidence: {
          chosen_score_text: null,
          score_tokenization_class: 'INCOMPLETE_CHOSEN_TOKEN_STREAM',
          score_distribution_extractable: false,
          chosen_token_text_matches_message: false,
          score_position_candidates: [],
          token_window: [{
            position: 0,
            chosen_token: '>',
            raw_top_logprobs: [{
              token: '__DSH_NO_TOP_LOGPROBS__',
              status: 'discarded',
              discard_reason: 'no_top_logprobs',
            }],
          }, {
            position: 1,
            chosen_token: '<｜end▁of▁sentence｜>',
            raw_top_logprobs: [{
              token: '__DSH_NO_TOP_LOGPROBS__',
              status: 'discarded',
              discard_reason: 'no_top_logprobs',
            }],
          }],
          extraction: { failure_reason: 'NO_SCORE_POSITION' },
        },
      },
    })
  })

  it('retries one exhausted probe, caches success, and bounds repeated exhaustion', async () => {
    const result = await runCapabilityProbe()
    expect(result.retry_calls).toEqual([1_024, 2_048])
    expect((result.retry_result as Record<string, unknown>).cache_hit).toBe(false)
    expect((result.cached_result as Record<string, unknown>).cache_hit).toBe(true)
    expect(result.cache_probe_calls).toHaveLength(3)
    expect(result.cache_first).toMatchObject({ cache_hit: false })
    expect(result.cache_second).toMatchObject({ cache_hit: true })
    expect(result.cache_changed_endpoint).toMatchObject({ cache_hit: false })
    expect(result.cache_changed_model).toMatchObject({ cache_hit: false })
    expect(JSON.stringify(result.cache_keys)).not.toContain('cache-key-secret')
    expect(result.cache_probe_calls).toEqual([
      ['deepseek-v4-flash', 'https://api.deepseek.com'],
      ['deepseek-v4-flash', 'https://other-verifier.test/v1'],
      ['deepseek-v4-flash-test-identity', 'https://other-verifier.test/v1'],
    ])
    expect(result.exhausted_calls).toEqual([1_024, 2_048])
    expect(result.twice_exhausted).toMatchObject({
      kind: 'VerifierProbeInconclusive',
      reason: 'OUTPUT_BUDGET_EXHAUSTED',
      details: { probe_budgets: [1_024, 2_048] },
    })
  })

  it('redacts credential values from probe errors', async () => {
    const result = await runCapabilityProbe()
    expect(result.safe_message).toBe('request rejected <redacted>')
    expect(JSON.stringify(result)).not.toContain('probe-secret-value')
  })
})


describe('strict score-position extraction', () => {
  it('accepts only complete A-T token spellings', async () => {
    const result = await runWorkerHelperProbe()
    expect(result.valid_tokens).toEqual({
      A: 'A',
      ' A': 'A',
      '>A': 'A',
      '> A': 'A',
      a: 'A',
      '> t': 'T',
    })
    expect(result.invalid_tokens).toEqual({
      The: null,
      Answer: null,
      Agent: null,
      Test: null,
      '>Agent': null,
      '': null,
      AA: null,
    })
  })

  it('reports score payload fusion and adjacent-position alignment without changing extraction', async () => {
    const result = await runWorkerHelperProbe()
    const diagnostics = result.alignment_diagnostics as Record<string, {
      chosen_score_text: string
      score_tokenization_class: string
      score_distribution_extractable: boolean
      score_position_candidates: Array<{
        position: number
        chosen_token: string
        raw_top_logprobs: Array<{
          token: string
          normalized_letter: string | null
          status: string
          discard_reason: string | null
        }>
      }>
      token_window: Array<{ position: number; chosen_token: string }>
    }>

    expect(diagnostics.separate).toMatchObject({
      chosen_score_text: 'A',
      score_tokenization_class: 'SEPARATE_SCORE_TOKEN',
      score_distribution_extractable: true,
      score_position_candidates: [{
        position: 1,
        chosen_token: 'A',
        raw_top_logprobs: [
          { token: 'A', normalized_letter: 'A', status: 'candidate', discard_reason: null },
          { token: ' B', normalized_letter: 'B', status: 'candidate', discard_reason: null },
          {
            token: 'The',
            normalized_letter: null,
            status: 'discarded',
            discard_reason: 'not_scale_token',
          },
        ],
      }],
    })
    expect(diagnostics.tag_suffix_fused).toMatchObject({
      score_tokenization_class: 'TAG_SUFFIX_FUSED',
      score_distribution_extractable: true,
    })
    expect(diagnostics.tag_and_score_fused).toMatchObject({
      score_tokenization_class: 'TAG_AND_SCORE_FUSED',
      score_distribution_extractable: false,
    })
    expect(diagnostics.score_and_closing_fused).toMatchObject({
      score_tokenization_class: 'SCORE_AND_CLOSING_TAG_FUSED',
      score_distribution_extractable: false,
    })
    expect(diagnostics.no_scale_alternatives).toMatchObject({
      score_tokenization_class: 'TOP_LOGPROBS_MISSING_SCALE_ALTERNATIVES',
      score_distribution_extractable: false,
    })
    expect(diagnostics.wrong_adjacent_position).toMatchObject({
      score_tokenization_class: 'POSITION_ALIGNMENT_UNKNOWN',
      score_distribution_extractable: true,
      score_position_candidates: [
        { position: 1, chosen_token: '\n' },
        { position: 2, chosen_token: 'A' },
      ],
    })
    expect(diagnostics.ambiguous).toMatchObject({
      chosen_score_text: 'Answer',
      score_tokenization_class: 'TOP_LOGPROBS_MISSING_SCALE_ALTERNATIVES',
      score_distribution_extractable: false,
    })
    expect(diagnostics.separate?.token_window).toHaveLength(3)
  })

  it('uses both pairwise score positions and ignores valid-looking words elsewhere', async () => {
    const result = await runWorkerHelperProbe()
    expect(result.pair_scores).toEqual([1, 0])
    expect(result.unrelated_error).toContain('Missing usable A-T probabilities at <score_A>')
    expect(result.missing_a_error).toContain('Missing usable A-T probabilities at <score_A>')
    expect(result.missing_b_error).toContain('Missing usable A-T probabilities at <score_B>')
  })

  it('classifies unusable score_B probability data without text fallback', async () => {
    const result = await runWorkerHelperProbe()
    expect(result.missing_b_failure).toMatchObject({
      reason: 'NO_VALID_SCALE_TOKEN',
      details: {
        failure_reason: 'NO_VALID_SCALE_TOKEN',
        score_position: '<score_B>',
      },
    })
    expect(result.empty_b_failure).toMatchObject({
      reason: 'EMPTY_TOP_LOGPROBS',
      details: { score_position: '<score_B>' },
    })
    expect(result.no_top_b_failure).toMatchObject({
      reason: 'NO_TOP_LOGPROBS',
      details: { score_position: '<score_B>' },
    })
    expect(result.malformed_b_failure).toMatchObject({
      reason: 'MALFORMED_LOGPROBS',
      details: { score_position: '<score_B>' },
    })
  })

  it('blocks literal-text fallback and validates every progress checkpoint', async () => {
    const result = await runWorkerHelperProbe()
    expect(result.text_fallback_error).toContain('Missing usable A-T probabilities at <score_A>')
    expect(result.progress_scores).toEqual([0, 1])
    expect(result.progress_error).toContain('Missing usable A-T probabilities at <c2>')
  })

  it('keeps generic requests standard while preserving explicit native behavior', async () => {
    const result = await runWorkerHelperProbe()
    expect(result.generic_native).toBe(false)
    expect(result.generic_kwargs).toEqual({
      model: 'deepseek-v4-flash',
      logprobs: true,
      top_logprobs: 20,
    })
    expect(result.generic_prefill_kwargs).toEqual({
      model: 'deepseek-v4-flash',
      max_tokens: 2_048,
      logprobs: true,
      top_logprobs: 20,
      extra_body: { continue_final_message: true },
    })
    expect(result.native_native).toBe(true)
    expect(result.native_kwargs).toEqual({
      model: 'deepseek-v4-flash',
      logprobs: true,
      top_logprobs: 20,
      extra_body: { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
    })
    expect(result.native_low_kwargs).toEqual({
      model: 'deepseek-v4-flash',
      logprobs: true,
      top_logprobs: 20,
      extra_body: { thinking: { type: 'enabled' }, reasoning_effort: 'low' },
    })
    expect(result.native_off_kwargs).toEqual({
      model: 'deepseek-v4-flash',
      logprobs: true,
      top_logprobs: 20,
      extra_body: { thinking: { type: 'disabled' } },
    })
    expect(result.reasoning_policy_mutated_environment).toBe(false)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import VerifierRuntime from 'dsh-llm-as-verifier/core'
import type { VerifierCandidate, VerifierPlugin } from 'dsh-llm-as-verifier/core'
import * as VerifierObserver from 'dsh-llm-as-verifier/observer'

async function setup(plugin?: VerifierPlugin, config: VerifierObserver.Config = {}): Promise<{
  ctx: Context
  observerFiber: Awaited<ReturnType<Context['plugin']>>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(VerifierRuntime, { enabled: plugin !== undefined, plugin: plugin?.id ?? null })
  if (plugin !== undefined) ctx.verifier.register(plugin)
  const observerFiber = await ctx.plugin(VerifierObserver, config)
  return { ctx, observerFiber }
}

const selectionPlugin = (selectCalls: { value: number }): VerifierPlugin => ({
  id: 'fake-selector',
  model: 'deepseek-v4-flash',
  select: async <T>(_task: string, candidates: readonly VerifierCandidate<T>[]) => {
    selectCalls.value += 1
    return {
      selectedIndex: 0,
      selectedTrajectory: candidates[0]!.trajectory,
      bestCandidate: candidates[0]!.original,
      scores: [0.52, 0.48],
      ranking: [0, 1],
      metadata: {
        backend: 'fake-selector',
        model: 'deepseek-v4-flash',
        latencyMs: 12,
        usage: {
          calls: 3,
          inputTokens: 100,
          cachedInputTokens: 40,
          outputTokens: 50,
          reasoningTokens: 30,
        },
        details: {
          telemetry: {
            endpoint: 'https://api.deepseek.com',
            criteria_count: 1,
            n_evaluations: 1,
            pivots: 2,
            max_workers: 4,
            reasoning_effort: 'high',
            planned_comparisons: 2,
            planned_verifier_calls: 3,
            comparisons: 2,
          },
        },
      },
    }
  },
})

const candidate = (answer: string) => ({
  original: { answer },
  trajectory: {
    steps: [{ index: 1, turn: 1, step: 1, assistantMessage: answer, tools: [] }],
    finalAnswer: answer,
    outcome: { kind: 'completed' as const },
  },
})

async function readEvaluationRecords(directory: string): Promise<Array<Record<string, unknown>>> {
  const files = await readdir(directory)
  expect(files).toHaveLength(1)
  const text = await readFile(join(directory, files[0]!), 'utf8')
  return text.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
}

function appendStep(session: ReturnType<Context['sessions']['create']>, step: number, answer: string): void {
  session.append('step/start', { turn: 1, step })
  session.append('assistant/message', {
    turn: 1,
    step,
    message: createMessage({
      role: 'assistant',
      source: { kind: 'model', provider: 'mock', model: 'mock' },
      content: [{ type: 'text', text: answer }],
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step })
}

describe('verifier-observer', () => {
  it('delivers committed steps in order and emits independent measurement signals', async () => {
    const order: number[] = []
    const plugin: VerifierPlugin = {
      id: 'fake',
      onStepEnd: async (_task, _trajectory, step) => {
        if (step.index === 1) await new Promise(resolve => setTimeout(resolve, 5))
        order.push(step.index)
        return {
          stepIndex: step.index,
          score: step.index / 10,
          metadata: { backend: 'fake', latencyMs: 1 },
        }
      },
      onTrajectoryEnd: async () => ({ score: 0.9, metadata: { backend: 'fake', latencyMs: 1 } }),
    }
    const { ctx } = await setup(plugin)
    const progress: number[] = []
    ctx.on('verifier/progress', (signal) => { progress.push(signal.step.index) })
    const completed = new Promise<void>((resolve) => {
      ctx.on('verifier/trajectory', (signal) => {
        expect(signal.task).toBe('solve it')
        expect(signal.trajectory.steps).toHaveLength(2)
        expect(signal.result.score).toBe(0.9)
        resolve()
      })
    })

    const session = ctx.sessions.create(SessionId('observed'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: 'solve it' }],
    }), { surfaceOp: 'append' })
    appendStep(session, 1, 'working')
    appendStep(session, 2, 'done')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await completed
    expect(order).toEqual([1, 2])
    expect(progress).toEqual([1, 2])
    expect(session.events.at(-1)).toMatchObject({ type: 'turn/end' })
  })

  it('leaves the normal session path unchanged without a registered verifier', async () => {
    const { ctx, observerFiber } = await setup()
    const onProgress = vi.fn()
    ctx.on('verifier/progress', onProgress)
    const session = ctx.sessions.create(SessionId('disabled'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: 'task' }],
    }), { surfaceOp: 'append' })
    appendStep(session, 1, 'answer')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await observerFiber.dispose()
    expect(onProgress).not.toHaveBeenCalled()
    expect(session.events.at(-1)).toMatchObject({ type: 'turn/end' })
  })

  it('contains hook failures after commit and skips turns without a human task', async () => {
    const onStepEnd = vi.fn(async () => { throw new Error('progress failed') })
    const onTrajectoryEnd = vi.fn(async () => { throw new Error('score failed') })
    const plugin: VerifierPlugin = { id: 'broken', onStepEnd, onTrajectoryEnd }
    const { ctx, observerFiber } = await setup(plugin)

    const skipped = ctx.sessions.create(SessionId('skipped'))
    skipped.append('turn/start', { turn: 1 })
    appendStep(skipped, 1, 'answer')
    skipped.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const contained = ctx.sessions.create(SessionId('contained'))
    contained.append('turn/start', { turn: 1 })
    contained.append('user/message', createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: 'task' }],
    }), { surfaceOp: 'append' })
    appendStep(contained, 1, 'answer')
    contained.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await observerFiber.dispose()
    expect(onStepEnd).toHaveBeenCalledOnce()
    expect(onTrajectoryEnd).toHaveBeenCalledOnce()
    expect(contained.events.at(-1)).toMatchObject({ type: 'turn/end' })
  })

  it('skips a committed step that has no canonical start evidence', async () => {
    const onStepEnd = vi.fn()
    const plugin: VerifierPlugin = { id: 'fake', onStepEnd }
    const { ctx, observerFiber } = await setup(plugin)
    const session = ctx.sessions.create(SessionId('missing-step'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: 'task' }],
    }), { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    await observerFiber.dispose()
    expect(onStepEnd).not.toHaveBeenCalled()
  })

  it('fails loud on invalid adapter bounds', async () => {
    const ctx = new Context()
    await ctx.plugin(VerifierRuntime)
    expect(() => { VerifierObserver.apply(ctx, { maxFieldBytes: 0 }) }).toThrow('maxFieldBytes')
    expect(() => { VerifierObserver.apply(ctx, { maxTrajectoryBytes: 1.5 }) }).toThrow('maxTrajectoryBytes')
    expect(() => { VerifierObserver.apply(ctx, { maxTrajectoryBytes: 100 }) }).not.toThrow()
    expect(() => { VerifierObserver.apply(ctx) }).not.toThrow()
    await expect(ctx.plugin(VerifierObserver, { maxFieldBytes: 0 })).rejects.toThrow('maxFieldBytes')
    await expect(ctx.plugin(VerifierObserver, { maxTrajectoryBytes: 0 })).rejects.toThrow('maxTrajectoryBytes')
    await expect(ctx.plugin(VerifierObserver, { maxFieldBytes: 1.5 })).rejects.toThrow('maxFieldBytes')
  })

  it('writes no evaluation file while observational logging is disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-verifier-observer-disabled-'))
    const path = join(root, 'records')
    try {
      const calls = { value: 0 }
      const { ctx, observerFiber } = await setup(selectionPlugin(calls), {
        evaluationLogging: { enabled: false, path },
      })
      await ctx.verifier.select('private task', [candidate('a'), candidate('b')])
      await observerFiber.dispose()
      await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(calls.value).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('persists one versioned redacted record with external outcomes and zero-call shadow policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-verifier-observer-record-'))
    const path = join(root, 'records')
    const secret = 'sk-fixture-secret-value'
    try {
      const calls = { value: 0 }
      const { ctx, observerFiber } = await setup(selectionPlugin(calls), {
        evaluationLogging: {
          enabled: true,
          path,
          adaptiveShadow: { enabled: true, top2GapThreshold: 0.08 },
        },
      })
      await ctx.verifier.select(`task includes ${secret}`, [
        candidate(`raw trajectory ${secret}`),
        candidate('other private trajectory'),
      ], {
        evaluation: {
          runId: `Authorization: Bearer ${secret}`,
          taskId: `OPENAI_API_KEY=${secret}`,
          taskType: 'coding',
          source: secret,
          outcome: { status: 'unknown' },
          candidates: [
            {
              index: 0,
              trajectoryReference: `/private/repository/${secret}`,
              outcome: { status: 'graded', source: 'test-suite', success: true, score: 1 },
            },
            { index: 1, outcome: { status: 'graded', source: 'test-suite', success: false, score: 0 } },
          ],
        },
      })
      await observerFiber.dispose()
      const record = (await readEvaluationRecords(path)).at(0)
      if (record === undefined) throw new Error('expected one evaluation record')
      expect(record).toMatchObject({
        schema_version: 1,
        task_metadata: { task_type: 'coding', source: 'unknown', candidate_count: 2 },
        verifier: {
          backend: 'fake-selector',
          model: 'deepseek-v4-flash',
          endpoint_id: 'https://api.deepseek.com',
          reasoning_effort: 'high',
          n_evaluations: 1,
          pivots: 2,
          max_workers: 4,
        },
        selection: { ranking: [0, 1], scores: [0.52, 0.48], winner_index: 0 },
        cost: {
          planned_comparisons: 2,
          planned_verifier_calls: 3,
          comparisons: 2,
          verifier_calls: 3,
          input_tokens: 100,
          cached_input_tokens: 40,
          output_tokens: 50,
          reasoning_tokens: 30,
          latency_ms: 12,
        },
        adaptive_shadow: { policy: 'top-two', threshold: 0.08, would_trigger: true },
        outcome: { status: 'unknown' },
        candidates: [
          expect.objectContaining({
            index: 0,
            outcome: { status: 'graded', source: 'test-suite', success: true, score: 1 },
          }),
          { index: 1, outcome: { status: 'graded', source: 'test-suite', success: false, score: 0 } },
        ],
      })
      const firstCandidate = (record.candidates as Array<Record<string, unknown>>).at(0)
      expect(firstCandidate?.trajectory_reference_sha256).toMatch(/^[0-9a-f]{64}$/)
      expect((record.selection as { top2_gap: number }).top2_gap).toBeCloseTo(0.04)
      expect((record.adaptive_shadow as { top2_gap: number }).top2_gap).toBeCloseTo(0.04)
      const serialized = JSON.stringify(record)
      expect(serialized).not.toContain(secret)
      expect(serialized).not.toContain('Authorization')
      expect(serialized).not.toContain('API_KEY')
      expect(serialized).not.toContain('raw trajectory')
      expect(calls.value).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('contains persistence failures after returning a valid selection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-verifier-observer-failure-'))
    const blocked = join(root, 'not-a-directory')
    try {
      await writeFile(blocked, 'occupied')
      const calls = { value: 0 }
      const { ctx, observerFiber } = await setup(selectionPlugin(calls), {
        evaluationLogging: { enabled: true, path: blocked },
      })
      await expect(ctx.verifier.select('task', [candidate('a'), candidate('b')]))
        .resolves.toMatchObject({ selectedIndex: 0 })
      await expect(observerFiber.dispose()).resolves.toBeUndefined()
      expect(calls.value).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('serializes concurrent selection records into complete JSONL lines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-verifier-observer-concurrent-'))
    const path = join(root, 'records')
    try {
      const calls = { value: 0 }
      const { ctx, observerFiber } = await setup(selectionPlugin(calls), {
        evaluationLogging: { enabled: true, path },
      })
      await Promise.all(Array.from({ length: 20 }, (_, index) => ctx.verifier.select(
        'task',
        [candidate(`a-${index}`), candidate(`b-${index}`)],
        { evaluation: { runId: `run-${index}`, taskId: `task-${index}` } },
      )))
      await observerFiber.dispose()
      const records = await readEvaluationRecords(path)
      expect(records).toHaveLength(20)
      expect(new Set(records.map(record => record.record_id))).toHaveLength(20)
      expect(calls.value).toBe(20)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

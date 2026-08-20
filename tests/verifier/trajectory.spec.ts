import { describe, expect, it } from 'vitest'
import {
  CallId,
  createMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { boundUtf8, TrajectoryAdapter } from 'dsh-llm-as-verifier/core'

const adapter = (): TrajectoryAdapter => new TrajectoryAdapter({
  maxFieldBytes: 1_000,
  maxTrajectoryBytes: 10_000,
})

function appendAssistant(session: Session, turn: number, step: number, text: string): void {
  session.append('assistant/message', {
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      source: { kind: 'model', provider: 'mock', model: 'mock' },
      content: [
        { type: 'reasoning', text: 'private chain of thought' },
        { type: 'text', text },
        {
          type: 'image',
          attachment: {
            attachmentId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as never,
            mediaType: 'image/png', bytes: 1, width: 1, height: 1,
          },
        },
        { type: 'tool-call', id: CallId('c1'), name: 'read', arguments: '{}' },
      ],
    }),
  }, { surfaceOp: 'append' })
}

describe('TrajectoryAdapter', () => {
  it('rejects unsafe bounds and keeps UTF-8 truncation within the configured bytes', () => {
    expect(() => new TrajectoryAdapter({ maxFieldBytes: 0, maxTrajectoryBytes: 1 }))
      .toThrow('maxFieldBytes')
    expect(() => new TrajectoryAdapter({ maxFieldBytes: 1, maxTrajectoryBytes: 1.5 }))
      .toThrow('maxTrajectoryBytes')
    expect(boundUtf8('short', 10)).toBe('short')
    expect(boundUtf8('abcdefghijklmnopqrstuvwxyz', 8)).toBe('abcdefgh')
    const bounded = boundUtf8(`开始${'x'.repeat(80)}结束`, 40)
    expect(Buffer.byteLength(bounded, 'utf8')).toBeLessThanOrEqual(40)
    expect(bounded).toContain('truncated')
    expect(bounded.startsWith('开始')).toBe(true)
    expect(bounded.endsWith('结束')).toBe(true)
  })

  it('adapts committed evidence without provider reasoning or wire payloads', () => {
    const session = Session.create(SessionId('trajectory'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Inspect and fix the file' }],
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    appendAssistant(session, 1, 1, 'I inspected the file.')
    session.append('tool/call', {
      turn: 1, step: 1, callId: CallId('c1'), name: 'read', arguments: '{"path":"a.ts"}',
    })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('c1'),
        isError: true,
        content: [
          { type: 'text', text: 'file contents' },
          {
            type: 'image',
            attachment: {
              attachmentId: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as never,
              mediaType: 'image/png', bytes: 1, width: 1, height: 1,
            },
          },
        ],
      }),
      error: { name: 'ReadError', code: 'E_READ' },
      meta: { files: ['a.ts'], changed: false },
    }, { surfaceOp: 'append' })
    session.append('tool/call', {
      turn: 1, step: 1, callId: CallId('c2'), name: 'shell', arguments: '{not-json',
    })
    session.append('tool/call', {
      turn: 1, step: 1, callId: CallId('c3'), name: 'empty', arguments: '',
    })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    session.append('turn/start', { turn: 2 })
    session.append('user/message', createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: 'Now run tests' }],
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 2, step: 1 })
    appendAssistant(session, 2, 1, 'All tests pass.')
    session.append('step/end', { turn: 2, step: 1 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

    const result = adapter().adapt(session.events)
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0]).toMatchObject({
      index: 1,
      turn: 1,
      step: 1,
      assistantMessage: 'I inspected the file.\n[image attachment omitted]',
      tools: [
        {
          callId: 'c1',
          name: 'read',
          input: { path: 'a.ts' },
          output: 'file contents\n[image attachment omitted]',
          error: { code: 'E_READ', message: 'ReadError' },
        },
        { callId: 'c2', input: '{not-json' },
        { callId: 'c3', input: {} },
      ],
    })
    expect(result.steps[0]!.tools[0]!.evidence).toContain('a.ts')
    expect(result.finalAnswer).toBe('All tests pass.\n[image attachment omitted]')
    expect(result.outcome).toEqual({ kind: 'completed' })
    expect(JSON.stringify(result)).not.toContain('private chain of thought')

    const rendered = adapter().serialize(result)
    expect(rendered).toContain('Tool: read')
    expect(rendered).toContain('Tool error: E_READ: ReadError')
    expect(rendered).toContain('Run outcome')

    const secondTurn = adapter().adaptTurn(session.events, 2)
    expect(secondTurn.steps).toHaveLength(1)
    expect(secondTurn.steps[0]!.index).toBe(1)
    expect(adapter().taskForTurn(session.events, 2)).toBe('Now run tests')
    expect(adapter().taskForTurn(session.events, 99)).toBe('Now run tests')
  })

  it('returns empty values when no human task or visible model evidence exists', () => {
    const session = Session.create(SessionId('empty-trajectory'))
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        source: { kind: 'model', provider: 'mock', model: 'mock' },
        content: [{ type: 'reasoning', text: 'hidden' }],
      }),
    }, { surfaceOp: 'append' })
    expect(adapter().adapt(session.events)).toEqual({
      steps: [{ index: 1, turn: 1, step: 1, tools: [] }],
    })
    expect(adapter().taskForTurn(session.events, 1)).toBeUndefined()
    expect(adapter().serializeStep({ index: 1, turn: 1, step: 1, tools: [] }))
      .toContain('Agent step 1')
    expect(adapter().serialize({ steps: [] })).toBe('')
  })

  it('skips unmatched, empty, and future event content without inventing evidence', () => {
    const session = Session.create(SessionId('partial-trajectory'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: '' }],
    }), { surfaceOp: 'append' })
    appendAssistant(session, 1, 9, 'unmatched assistant')
    session.append('tool/call', {
      turn: 1, step: 9, callId: CallId('missing-step'), name: 'read', arguments: '{}',
    })
    session.append('tool/result', {
      turn: 1,
      step: 9,
      message: createToolResultMessage({
        callId: CallId('missing-step'), isError: false, content: [{ type: 'text', text: 'ignored' }],
      }),
    }, { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        source: { kind: 'model', provider: 'mock', model: 'mock' },
        content: [{ type: 'future-content' } as never],
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('unknown-call'), isError: false, content: [{ type: 'text', text: '' }],
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', {
      turn: 1, step: 1, callId: CallId('empty-result'), name: 'read', arguments: '{}',
    })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('empty-result'), isError: false, content: [{ type: 'text', text: '' }],
      }),
    }, { surfaceOp: 'append' })

    expect(adapter().adapt(session.events)).toEqual({
      steps: [{
        index: 1, turn: 1, step: 1, tools: [{ callId: 'empty-result', name: 'read', input: {} }],
      }],
    })
    expect(adapter().taskForTurn(session.events, 1)).toBeUndefined()
  })
})

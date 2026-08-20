import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue, SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  AgentStep,
  CanonicalToolInteraction,
  CanonicalTrajectory,
  VerificationFailure,
} from './types.ts'

/** Required output bounds for canonical trajectory rendering. */
export interface TrajectoryAdapterOptions {
  /** Maximum UTF-8 bytes retained for one assistant, tool-output, or metadata field. */
  readonly maxFieldBytes: number
  /** Maximum UTF-8 bytes sent to a verifier for one complete trajectory. */
  readonly maxTrajectoryBytes: number
}

interface MutableToolInteraction {
  callId: string
  name: string
  input: JsonValue | string
  output?: string
  evidence?: string
  error?: VerificationFailure
}

interface MutableStep {
  index: number
  turn: number
  step: number
  assistantMessage?: string
  tools: MutableToolInteraction[]
}

/** Validate one positive safe-integer byte limit. */
function positiveLimit(name: keyof TrajectoryAdapterOptions, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`verifier trajectory adapter: ${name} must be a positive safe integer`)
  }
  return value
}

/** Longest code-point prefix whose UTF-8 encoding fits one byte budget. */
function utf8Prefix(text: string, maxBytes: number): string {
  let bytes = 0
  let result = ''
  for (const character of text) {
    const width = Buffer.byteLength(character, 'utf8')
    if (bytes + width > maxBytes) break
    result += character
    bytes += width
  }
  return result
}

/** Longest code-point suffix whose UTF-8 encoding fits one byte budget. */
function utf8Suffix(text: string, maxBytes: number): string {
  let bytes = 0
  const result: string[] = []
  for (const character of Array.from(text).reverse()) {
    const width = Buffer.byteLength(character, 'utf8')
    if (bytes + width > maxBytes) break
    result.push(character)
    bytes += width
  }
  return result.reverse().join('')
}

/**
 * Bound UTF-8 text while retaining evidence from both ends.
 * @param text Text to retain.
 * @param maxBytes Maximum encoded byte length.
 * @returns Original or bounded text.
 */
export function boundUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const marker = Buffer.from('\n[… truncated …]\n', 'utf8')
  if (marker.length >= maxBytes) return utf8Prefix(text, maxBytes)
  const available = maxBytes - marker.length
  const head = Math.ceil(available / 2)
  const tail = Math.floor(available / 2)
  return utf8Prefix(text, head)
    + marker.toString('utf8')
    + utf8Suffix(text, tail)
}

/** Visible text from nested content blocks, excluding private reasoning. */
function visibleText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'tool-result':
        parts.push(visibleText(block.content))
        break
      case 'image':
        parts.push('[image attachment omitted]')
        break
      case 'reasoning':
      case 'tool-call':
        break
      default:
        break
    }
  }
  return parts.filter(Boolean).join('\n')
}

/** Parse model tool arguments without losing malformed input. */
function parseToolInput(raw: string): JsonValue | string {
  if (raw === '') return {}
  try {
    return JSON.parse(raw) as JsonValue
  } catch {
    return raw
  }
}

/** Stable JSON text for bounded tool evidence. */
function renderJson(value: JsonValue): string {
  return JSON.stringify(value, null, 2)
}

/** Key for one step inside a turn. */
function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`
}

/**
 * Adapter from the durable provider-neutral session log to verifier values.
 * Raw chunks, request headers, model provenance, and reasoning blocks never
 * enter the canonical trajectory.
 */
export class TrajectoryAdapter {
  /** Validated serialization byte limits. */
  readonly options: TrajectoryAdapterOptions

  constructor(options: TrajectoryAdapterOptions) {
    this.options = {
      maxFieldBytes: positiveLimit('maxFieldBytes', options.maxFieldBytes),
      maxTrajectoryBytes: positiveLimit('maxTrajectoryBytes', options.maxTrajectoryBytes),
    }
  }

  /**
   * Reconstruct committed steps, tool evidence, the final visible answer, and
   * the latest turn outcome.
   * @param events - complete or bounded durable session event sequence.
   * @returns detached canonical trajectory.
   */
  adapt(events: readonly SessionEvent[]): CanonicalTrajectory {
    const steps: MutableStep[] = []
    const byKey = new Map<string, MutableStep>()
    let finalAnswer: string | undefined
    let outcome: CanonicalTrajectory['outcome']

    for (const event of events) {
      switch (event.type) {
        case 'step/start': {
          const step: MutableStep = {
            index: steps.length + 1,
            turn: event.data.turn,
            step: event.data.step,
            tools: [],
          }
          steps.push(step)
          byKey.set(stepKey(step.turn, step.step), step)
          break
        }
        case 'assistant/message': {
          const step = byKey.get(stepKey(event.data.turn, event.data.step))
          if (step === undefined) break
          const text = visibleText(event.data.message.content)
          if (text === '') break
          step.assistantMessage = boundUtf8(text, this.options.maxFieldBytes)
          finalAnswer = step.assistantMessage
          break
        }
        case 'tool/call': {
          const step = byKey.get(stepKey(event.data.turn, event.data.step))
          if (step === undefined) break
          step.tools.push({
            callId: event.data.callId,
            name: event.data.name,
            input: parseToolInput(event.data.arguments),
          })
          break
        }
        case 'tool/result': {
          const step = byKey.get(stepKey(event.data.turn, event.data.step))
          if (step === undefined) break
          const callId = event.data.message.source.callId
          const tool = step.tools.find(candidate => candidate.callId === callId)
          if (tool === undefined) break
          const output = visibleText(event.data.message.content)
          if (output !== '') tool.output = boundUtf8(output, this.options.maxFieldBytes)
          if (event.data.meta !== undefined) {
            tool.evidence = boundUtf8(renderJson(event.data.meta), this.options.maxFieldBytes)
          }
          if (event.data.error !== undefined) {
            tool.error = {
              code: event.data.error.code,
              message: event.data.error.name,
            }
          }
          break
        }
        case 'turn/end':
          outcome = event.data.reason
          break
        default:
          break
      }
    }

    return {
      steps: steps.map(step => this.freezeStep(step)),
      ...(finalAnswer === undefined ? {} : { finalAnswer }),
      ...(outcome === undefined ? {} : { outcome: structuredClone(outcome) }),
    }
  }

  /**
   * Reconstruct only one turn from a multi-turn session log.
   * @param events Durable session events containing the requested turn.
   * @param turn Turn number to retain.
   * @returns canonical trajectory whose step indexes restart at one.
   */
  adaptTurn(events: readonly SessionEvent[], turn: number): CanonicalTrajectory {
    return this.adapt(events.filter((event) => {
      switch (event.type) {
        case 'step/start':
        case 'assistant/message':
        case 'tool/call':
        case 'tool/result':
        case 'turn/end':
          return event.data.turn === turn
        default:
          return false
      }
    }))
  }

  /**
   * Infer the human task admitted for one turn, falling back to the latest
   * earlier human prompt for imported or resumed logs.
   * @param events - durable session events.
   * @param turn - turn whose task is required.
   * @returns bounded task text, or `undefined` when the log has no human text.
   */
  taskForTurn(events: readonly SessionEvent[], turn: number): string | undefined {
    let currentTurn = 0
    let latest: string | undefined
    let inTurn: string | undefined
    for (const event of events) {
      if (event.type === 'turn/start') currentTurn = event.data.turn
      if (event.type !== 'user/message' || event.data.source.kind !== 'user') continue
      const text = visibleText(event.data.content)
      if (text === '') continue
      latest = text
      if (currentTurn === turn) inTurn = text
    }
    const task = inTurn ?? latest
    return task === undefined ? undefined : boundUtf8(task, this.options.maxFieldBytes)
  }

  /**
   * Render one canonical step for online progress tracking.
   * @param step Canonical step to render.
   * @returns Bounded readable evidence.
   */
  serializeStep(step: AgentStep): string {
    const lines = [`Agent step ${step.index} (turn ${step.turn}, step ${step.step})`]
    if (step.assistantMessage !== undefined) lines.push(`Assistant:\n${step.assistantMessage}`)
    for (const tool of step.tools) {
      lines.push(`Tool: ${tool.name}`)
      lines.push(`Input:\n${typeof tool.input === 'string' ? tool.input : renderJson(tool.input)}`)
      if (tool.output !== undefined) lines.push(`Output:\n${tool.output}`)
      if (tool.evidence !== undefined) lines.push(`Tool evidence:\n${tool.evidence}`)
      if (tool.error !== undefined) lines.push(`Tool error: ${tool.error.code}: ${tool.error.message}`)
    }
    return boundUtf8(lines.join('\n\n'), this.options.maxTrajectoryBytes)
  }

  /**
   * Render a complete candidate without raw provider payloads.
   * @param trajectory Canonical trajectory to render.
   * @returns Bounded readable candidate text.
   */
  serialize(trajectory: CanonicalTrajectory): string {
    const sections = trajectory.steps.map(step => this.serializeStep(step))
    if (trajectory.finalAnswer !== undefined) sections.push(`Final answer:\n${trajectory.finalAnswer}`)
    if (trajectory.outcome !== undefined) sections.push(`Run outcome:\n${renderJson(trajectory.outcome as JsonValue)}`)
    return boundUtf8(sections.join('\n\n===\n\n'), this.options.maxTrajectoryBytes)
  }

  private freezeStep(step: MutableStep): AgentStep {
    const tools: CanonicalToolInteraction[] = step.tools.map(tool => ({
      callId: tool.callId,
      name: tool.name,
      input: structuredClone(tool.input),
      ...(tool.output === undefined ? {} : { output: tool.output }),
      ...(tool.evidence === undefined ? {} : { evidence: tool.evidence }),
      ...(tool.error === undefined ? {} : { error: { ...tool.error } }),
    }))
    return {
      index: step.index,
      turn: step.turn,
      step: step.step,
      ...(step.assistantMessage === undefined ? {} : { assistantMessage: step.assistantMessage }),
      tools,
    }
  }
}

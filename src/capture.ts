/**
 * The read-only `llm/stream` tee.
 *
 * The reviewer's response exists only as a chunk stream. This module wraps
 * that stream with a pass-through that records reasoning text, the final text
 * block, and the terminal finish. It never replaces, short-circuits, or
 * replays a chunk: every chunk the upstream produced reaches the consumer
 * unchanged, including `finish` chunks carrying `error` or `aborted`.
 *
 * The defensive boundary is narrow on purpose. Only failures in the RECORDING
 * path are swallowed; a failure thrown by the upstream iterator propagates to
 * the consumer exactly as before. A lost record is acceptable; a changed
 * review outcome is not.
 *
 * @module @dsh-electron/dsh-auto-review-panel/capture
 */

import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type {
  ReviewDecision,
  ReviewFinish,
  ReviewOutput,
  ReviewRecord,
  ReviewRisk,
  ReviewSections,
} from './contract.ts'

/** The message-owned part of one capture, copied from the matched request. */
export interface ReviewCaptureInput {
  readonly provider: string
  readonly model: string
  readonly requestText: string
  readonly sections: ReviewSections
}

/** The tee's recording destination. */
export interface ReviewCaptureSink {
  /** Observe one chunk. May throw; the tee contains that failure. */
  push(chunk: StreamChunk): void
  /** Finalize the capture. May throw; the tee contains that failure. */
  finish(): void
}

/** One accumulated content block while the stream is live. */
interface LiveBlock {
  type: string
  text: string
}

/** A parsed reviewer response. */
interface ParsedReviewOutput {
  readonly risk?: ReviewRisk
  readonly decision?: ReviewDecision
  readonly reason?: string
}

/** Count members in the raw top-level JSON object (duplicate detection). */
function topLevelMemberCount(text: string): number {
  const syntax = text.replace(/"(?:\\.|[^"\\])*"/gs, '')
  let depth = 0
  let count = 0
  for (const char of syntax) {
    switch (char) {
      case '{':
      case '[':
        depth += 1
        break
      case '}':
      case ']':
        depth -= 1
        break
      case ':':
        if (depth === 1) count += 1
    }
  }
  return count
}

/**
 * Parse the closed `{risk, decision, reason?}` protocol.
 *
 * This mirrors the upstream protocol's accepted shapes exactly. Anything else
 * becomes `decision: 'error'`; the raw text stays on the record either way.
 * @param text - the final text block.
 * @returns the parsed verdict, or an error decision.
 */
export function parseReviewDecision(text: string): ParsedReviewOutput {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { decision: 'error' }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { decision: 'error' }
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (topLevelMemberCount(text) !== keys.length) return { decision: 'error' }

  const risk = record['risk']
  const decision = record['decision']
  if (keys.length === 2 && decision === 'allow' && (risk === 'low' || risk === 'medium')) {
    return { risk, decision: 'allow' }
  }
  if (keys.length === 2 && decision === 'deny' && (risk === 'medium' || risk === 'high')) {
    return { risk, decision: 'deny' }
  }
  if (decision === 'deny'
    && (risk === 'medium' || risk === 'high')
    && keys.length === 3
    && Object.hasOwn(record, 'reason')
    && typeof record['reason'] === 'string') {
    return { risk, decision: 'deny', reason: record['reason'] }
  }
  return { decision: 'error' }
}

/** Recursively freeze one plain JSON value. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key])
  return Object.freeze(value)
}

/**
 * One in-flight review stream.
 *
 * Chunks are accumulated without interpreting provider-specific structure:
 * block indexes are tracked first-seen, and a `block-end` payload is
 * authoritative for its block's text. The final text block becomes
 * `output.rawText`; every reasoning block is retained in order.
 */
export class StreamingReviewCapture implements ReviewCaptureSink {
  readonly #input: ReviewCaptureInput
  readonly #id: string
  readonly #capturedAt: string
  readonly #emit: (record: ReviewRecord) => void
  readonly #blocks = new Map<number, LiveBlock>()
  readonly #order: number[] = []
  #finish: ReviewFinish | undefined
  #finished = false

  /**
   * @param input - request fields copied verbatim from the matched review.
   * @param id - host-minted record identity.
   * @param capturedAt - host timestamp for the observation.
   * @param emit - receives the completed record exactly once.
   */
  constructor(
    input: ReviewCaptureInput,
    id: string,
    capturedAt: string,
    emit: (record: ReviewRecord) => void,
  ) {
    this.#input = input
    this.#id = id
    this.#capturedAt = capturedAt
    this.#emit = emit
  }

  /** Observe one upstream chunk. */
  push(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'block-start':
        this.#touch(chunk.index, chunk.blockType)
        return
      case 'text-delta': {
        const block = this.#touch(chunk.index, 'text')
        if (block.type !== 'reasoning') block.type = 'text'
        block.text += chunk.text
        return
      }
      case 'reasoning-delta': {
        const block = this.#touch(chunk.index, 'reasoning')
        if (block.type !== 'text') block.type = 'reasoning'
        block.text += chunk.text
        return
      }
      case 'block-end': {
        const block = this.#touch(chunk.index, chunk.block.type)
        block.type = chunk.block.type
        if (chunk.block.type === 'text' || chunk.block.type === 'reasoning') {
          block.text = chunk.block.text
        }
        return
      }
      case 'finish':
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
          this.#finish = {
            kind: chunk.reason.kind,
            code: chunk.reason.failure.code,
            message: chunk.reason.failure.message,
          }
        }
        return
      default:
        return
    }
  }

  /** Finalize and emit the record. Emitted exactly once. */
  finish(): void {
    if (this.#finished) return
    this.#finished = true
    const rawText = this.#lastText()
    const parsed = parseReviewDecision(rawText)
    const output: ReviewOutput = {
      ...(parsed.risk === undefined ? {} : { risk: parsed.risk }),
      ...(parsed.decision === undefined ? {} : { decision: parsed.decision }),
      ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
      rawText,
    }
    const record: ReviewRecord = {
      id: this.#id,
      capturedAt: this.#capturedAt,
      provider: this.#input.provider,
      model: this.#input.model,
      requestText: this.#input.requestText,
      sections: this.#input.sections,
      reasoning: this.#reasoning(),
      output,
      ...(this.#finish === undefined ? {} : { finish: this.#finish }),
    }
    this.#emit(deepFreeze(record))
  }

  /** The final text block in stream order, verbatim; empty when absent. */
  #lastText(): string {
    let text = ''
    for (const index of this.#order) {
      const block = this.#blocks.get(index)
      if (block?.type === 'text') text = block.text
    }
    return text
  }

  /** Every reasoning block in stream order. */
  #reasoning(): readonly string[] {
    const reasoning: string[] = []
    for (const index of this.#order) {
      const block = this.#blocks.get(index)
      if (block?.type === 'reasoning') reasoning.push(block.text)
    }
    return reasoning
  }

  /** Find or create one block while preserving first-seen order. */
  #touch(index: number, type: string): LiveBlock {
    const existing = this.#blocks.get(index)
    if (existing !== undefined) return existing
    const block: LiveBlock = { type, text: '' }
    this.#blocks.set(index, block)
    this.#order.push(index)
    return block
  }
}

/**
 * Wrap one upstream stream with a recording sink.
 *
 * Every chunk is forwarded exactly once. Sink failures are contained here;
 * upstream iteration failures keep propagating after the sink is finalized, so
 * a reviewer's failure semantics never change. Finalization runs in `finally`,
 * which also means a partial capture is recorded when the consumer stops early
 * or the upstream throws.
 * @param source - the real stream returned by `next()`.
 * @param sink - the recording destination.
 * @returns the pass-through stream.
 */
export async function* teeReviewStream(
  source: AsyncIterable<StreamChunk>,
  sink: ReviewCaptureSink,
): AsyncGenerator<StreamChunk> {
  try {
    for await (const chunk of source) {
      try {
        sink.push(chunk)
      } catch {
        // Recording is best-effort; the review stream is not.
      }
      yield chunk
    }
  } finally {
    try {
      sink.finish()
    } catch {
      // A lost record must never affect the call being reviewed.
    }
  }
}

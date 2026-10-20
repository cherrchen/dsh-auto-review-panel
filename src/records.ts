/**
 * The host-side review record buffer.
 *
 * Two rings, one owner: a per-session cap over correlated records and a global
 * cap over everything, including records whose `tools/pre-execute` anchor was
 * never reached (a `deny + never` review is exactly that case, and it is the
 * highest-risk batch). A record is deep-frozen when it enters the buffer;
 * correlation never mutates it in place — it replaces it with a new frozen
 * record at the same position.
 *
 * @module @dsh-electron/dsh-auto-review-panel/records
 */

import type {
  ReviewCorrelation,
  ReviewRecord,
  ReviewRecordSummary,
} from './contract.ts'

/** Default global ring capacity. */
export const DEFAULT_GLOBAL_CAPACITY = 200

/** Default per-session ring capacity. */
export const DEFAULT_SESSION_CAPACITY = 50

/** Maximum characters of a deny reason kept in one list row. */
export const SUMMARY_REASON_LIMIT = 160

/** Buffer construction options. */
export interface ReviewRecordBufferOptions {
  readonly globalCapacity?: number
  readonly sessionCapacity?: number
}

/**
 * Recursively freeze one plain JSON value.
 * @param value - the value to freeze in place.
 * @returns the same value, frozen through every nested object and array.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return Object.freeze(value)
}

/** Maximum characters of an action preview kept in one list row. */
export const SUMMARY_PREVIEW_LIMIT = 160

/** Shorten one list-row reason without inventing content. */
function summarizeReason(reason: string): string {
  return reason.length <= SUMMARY_REASON_LIMIT
    ? reason
    : `${reason.slice(0, SUMMARY_REASON_LIMIT - 3)}...`
}

/**
 * Argument member names checked first for the row preview, in priority
 * order: the identifying argument for exec-style calls is `command`, for
 * file calls `path`. Falling back to the first string member keeps the
 * projection honest for tools whose shape is not listed here.
 */
const PREVIEW_KEYS = ['command', 'file_path', 'filePath', 'path', 'file', 'filename', 'fileName', 'target', 'url', 'query', 'cwd'] as const

/** Project `pendingAction.arguments` onto one list-row preview line. */
function summarizeActionPreview(args: unknown): string | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
  const record = args as Record<string, unknown>
  let text: string | undefined
  for (const key of PREVIEW_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') { text = value; break }
  }
  if (text === undefined) {
    for (const value of Object.values(record)) {
      if (typeof value === 'string' && value.trim() !== '') { text = value; break }
    }
  }
  if (text === undefined) return undefined
  const line = text.trim().split('\n', 1)[0]!.trim()
  if (line === '') return undefined
  return line.length <= SUMMARY_PREVIEW_LIMIT
    ? line
    : `${line.slice(0, SUMMARY_PREVIEW_LIMIT - 3)}...`
}

/** Project one full record onto the list row. */
export function summarizeRecord(record: ReviewRecord): ReviewRecordSummary {
  const reason = record.output.reason
  const preview = summarizeActionPreview(record.sections.pendingAction.arguments)
  return {
    id: record.id,
    capturedAt: record.capturedAt,
    action: {
      ...(record.sections.pendingAction.name === undefined ? {} : { name: record.sections.pendingAction.name }),
      ...(record.sections.pendingAction.mode === undefined ? {} : { mode: record.sections.pendingAction.mode }),
      ...(preview === undefined ? {} : { preview }),
    },
    ...(record.output.risk === undefined ? {} : { risk: record.output.risk }),
    ...(record.output.decision === undefined ? {} : { decision: record.output.decision }),
    ...(reason === undefined ? {} : { reason: summarizeReason(reason) }),
    ...(record.finish === undefined ? {} : { finish: record.finish }),
    correlated: record.correlation !== undefined,
  }
}

/**
 * The two-capacity review store.
 *
 * Records are returned newest first for the list surface. Session filtering
 * always keeps uncorrelated records: they are the ones a session-scoped view
 * must never hide.
 */
export class ReviewRecordBuffer {
  readonly #globalCapacity: number
  readonly #sessionCapacity: number
  readonly #records: ReviewRecord[] = []

  constructor(options: ReviewRecordBufferOptions = {}) {
    this.#globalCapacity = options.globalCapacity ?? DEFAULT_GLOBAL_CAPACITY
    this.#sessionCapacity = options.sessionCapacity ?? DEFAULT_SESSION_CAPACITY
  }

  /** Number of records currently held across every session. */
  get size(): number {
    return this.#records.length
  }

  /**
   * Add one record, freezing it and enforcing both ring caps.
   * @param record - the complete capture.
   * @returns the frozen record as stored.
   */
  add(record: ReviewRecord): ReviewRecord {
    const frozen = deepFreeze(record)
    this.#records.push(frozen)
    this.#enforceGlobal()
    this.#enforceSession(frozen.correlation?.sessionId)
    return frozen
  }

  /**
   * Attach the correlation anchor to one record.
   *
   * The frozen record is replaced, never mutated, so every snapshot a reader
   * already holds stays stable. An already-correlated record keeps its first
   * anchor.
   * @param id - record identity.
   * @param correlation - session, call, and downstream decision.
   * @returns the new frozen record, or undefined when the id is unknown.
   */
  correlate(id: string, correlation: ReviewCorrelation): ReviewRecord | undefined {
    const index = this.#records.findIndex(record => record.id === id)
    if (index < 0) return undefined
    const current = this.#records[index]
    if (current === undefined || current.correlation !== undefined) return current
    const updated = deepFreeze({ ...current, correlation })
    this.#records[index] = updated
    this.#enforceSession(correlation.sessionId)
    return updated
  }

  /**
   * Read one record by identity.
   * @param id - record identity.
   * @returns the frozen record, or undefined when evicted/unknown.
   */
  get(id: string): ReviewRecord | undefined {
    return this.#records.find(record => record.id === id)
  }

  /**
   * Every held record, oldest first. The returned array is a copy; the
   * records themselves are frozen.
   */
  all(): readonly ReviewRecord[] {
    return [...this.#records]
  }

  /**
   * Records visible under one session filter, newest first.
   *
   * With a `sessionId`, the result is that session's correlated records plus
   * every uncorrelated record — the `deny + never` batch has no sessionId and
   * must remain visible.
   * @param sessionId - optional session identity.
   * @returns matching records, newest first.
   */
  list(sessionId?: string): readonly ReviewRecord[] {
    const selected = sessionId === undefined
      ? this.#records
      : this.#records.filter(record =>
        record.correlation === undefined || record.correlation.sessionId === sessionId)
    return [...selected].reverse()
  }

  /** List rows for one session filter, newest first. */
  summaries(sessionId?: string): readonly ReviewRecordSummary[] {
    return this.list(sessionId).map(summarizeRecord)
  }

  /** Number of correlated records held for one session. */
  sessionSize(sessionId: string): number {
    return this.#records.filter(record => record.correlation?.sessionId === sessionId).length
  }

  /** Drop the oldest records until the global cap holds. */
  #enforceGlobal(): void {
    while (this.#records.length > this.#globalCapacity) this.#records.shift()
  }

  /** Drop this session's oldest correlated record until its cap holds. */
  #enforceSession(sessionId: string | undefined): void {
    if (sessionId === undefined) return
    while (this.sessionSize(sessionId) > this.#sessionCapacity) {
      const index = this.#records.findIndex(record => record.correlation?.sessionId === sessionId)
      if (index < 0) return
      this.#records.splice(index, 1)
    }
  }
}

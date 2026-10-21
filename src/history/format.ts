/**
 * The on-disk line format of the review-history log.
 *
 * Every file is append-only JSONL under `<root>/`: `sessions/<key>.jsonl` per
 * session and one global `unassigned.jsonl`. The first line is always the
 * header; everything after it is `record` (a complete capture), `patch` (the
 * `correlation`/`hostOutcome` increment of an already-written record), or
 * `delete` (the unassigned tombstone a correlation leaves behind). Readers
 * fold lines in order and skip ones that do not parse — a crashed append
 * leaves at most one torn tail line.
 *
 * `schema` is the file format version: the `v1` directory holds schema 1
 * files, and a future incompatible format moves to `v2` with a migration
 * instead of rewriting old files in place.
 *
 * @module @dsh-electron/dsh-auto-review-panel/history/format
 */

import { createHash } from 'node:crypto'
import type {
  ReviewCorrelation,
  ReviewHostOutcome,
  ReviewRecord,
  ReviewRecordSummary,
} from '../contract.ts'
import type { ReviewSessionIdentity } from './contract.ts'

/** The schema version this build writes and reads. */
export const HISTORY_SCHEMA = 1

/**
 * One log file's header — always the first line. `sessionId` is the owning
 * session verbatim, or `null` on the unassigned bucket.
 */
export interface HistoryHeader {
  readonly type: 'header'
  readonly schema: number
  readonly sessionId: string | null
  readonly session?: ReviewSessionIdentity
}

/** The mutable slice a `patch` line carries: outcome increments, never a summary change. */
export interface HistoryPatch {
  readonly correlation?: ReviewCorrelation
  readonly hostOutcome?: ReviewHostOutcome
}

/** One decoded log line. */
export type HistoryLine =
  | HistoryHeader
  | { readonly type: 'record'; readonly record: ReviewRecord }
  | { readonly type: 'patch'; readonly id: string; readonly patch: HistoryPatch }
  | { readonly type: 'delete'; readonly id: string }

/** Whether one unknown value is a JSON object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read a header's optional `session` identity, field by field: a malformed
 * member degrades to no identity (the file is then trusted), never to a
 * partially-garbage triple that could misjudge a live session.
 */
function readIdentity(value: unknown): ReviewSessionIdentity | undefined {
  if (!isRecord(value)) return undefined
  const createdAt = value['createdAt']
  const isSeeded = value['isSeeded']
  const cwd = value['cwd']
  if (typeof createdAt !== 'number' || typeof isSeeded !== 'boolean') return undefined
  if (cwd !== undefined && typeof cwd !== 'string') return undefined
  return { createdAt, isSeeded, ...(cwd === undefined ? {} : { cwd }) }
}

/** Encode one line exactly as it lands on disk. */
export function encodeLine(line: HistoryLine): string {
  return `${JSON.stringify(line)}\n`
}

/**
 * Decode one line, tolerating a trailing newline. Returns `undefined` for
 * anything that is not a well-formed log line — callers count and skip,
 * because a torn tail or a corrupted row must never lose the lines around it.
 */
export function decodeLine(text: string): HistoryLine | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  switch (value['type']) {
    case 'header': {
      const schema = value['schema']
      const sessionId = value['sessionId']
      if (typeof schema !== 'number' || !Number.isInteger(schema)) return undefined
      if (sessionId !== null && typeof sessionId !== 'string') return undefined
      const session = readIdentity(value['session'])
      const header: HistoryHeader = {
        type: 'header',
        schema,
        sessionId,
        ...(session === undefined ? {} : { session }),
      }
      return header
    }
    case 'record': {
      const record = value['record']
      // The checks stop at what the fold actually dereferences — `summary` and
      // `get` must survive a line whose members are merely partial.
      if (!isRecord(record)
        || typeof record['id'] !== 'string'
        || typeof record['capturedAt'] !== 'string'
        || !isRecord(record['sections'])
        || !isRecord(record['sections']['pendingAction'])
        || !isRecord(record['output'])) return undefined
      return { type: 'record', record: record as unknown as ReviewRecord }
    }
    case 'patch': {
      const id = value['id']
      const patch = value['patch']
      if (typeof id !== 'string' || !isRecord(patch)) return undefined
      return { type: 'patch', id, patch: patch as HistoryPatch }
    }
    case 'delete': {
      const id = value['id']
      if (typeof id !== 'string') return undefined
      return { type: 'delete', id }
    }
    default:
      return undefined
  }
}

/**
 * The filename a session's log lives under: `s_` + base64url(sessionId) for
 * ordinary ids, `h_` + sha256 when the encoding would exceed
 * {@link MAX_SESSION_KEY_LENGTH}. The key is only a filename — the header
 * carries the sessionId verbatim, so hashed keys lose nothing.
 */
export function encodeSessionKey(sessionId: string): string {
  const encoded = `s_${Buffer.from(sessionId, 'utf8').toString('base64url')}`
  if (encoded.length <= MAX_SESSION_KEY_LENGTH) return encoded
  return `h_${createHash('sha256').update(sessionId, 'utf8').digest('hex')}`
}

/** Longest session key before the store falls back to the hashed form. */
export const MAX_SESSION_KEY_LENGTH = 120

/** Whether one filename is a live session log (not a `.stale-`/`.corrupt-` aside). */
export function isSessionFileName(name: string): boolean {
  return (name.startsWith('s_') || name.startsWith('h_')) && name.endsWith('.jsonl')
}

/** The `list` cursor — `<capturedAt>|<id>` of the last row of a page. */
export function formatCursor(entry: { readonly capturedAt: string; readonly id: string }): string {
  return `${entry.capturedAt}|${entry.id}`
}

/**
 * Parse one `before` cursor. ISO timestamps and record ids never contain
 * `|`, so the first separator is the boundary. Returns `undefined` for a
 * malformed value.
 */
export function parseCursor(before: string): { readonly capturedAt: string; readonly id: string } | undefined {
  const sep = before.indexOf('|')
  if (sep <= 0 || sep === before.length - 1) return undefined
  return { capturedAt: before.slice(0, sep), id: before.slice(sep + 1) }
}

/**
 * Newest-first ordering for merged summaries: `capturedAt` descending, `id`
 * descending as the tiebreak so pagination has a total order.
 */
export function compareSummariesDesc(
  left: Pick<ReviewRecordSummary, 'capturedAt' | 'id'>,
  right: Pick<ReviewRecordSummary, 'capturedAt' | 'id'>,
): number {
  if (left.capturedAt !== right.capturedAt) return left.capturedAt < right.capturedAt ? 1 : -1
  return left.id === right.id ? 0 : left.id < right.id ? 1 : -1
}

/** Whether one summary is strictly older than the cursor — the next page's inclusion test. */
export function isOlderThanCursor(
  entry: Pick<ReviewRecordSummary, 'capturedAt' | 'id'>,
  cursor: { readonly capturedAt: string; readonly id: string },
): boolean {
  return entry.capturedAt < cursor.capturedAt
    || (entry.capturedAt === cursor.capturedAt && entry.id < cursor.id)
}

/**
 * Whether a persisted file's identity disagrees with the live session's.
 * Only a file that actually carries an identity can contradict the live one —
 * a header written without it (the host could not read `Session.header` at
 * append time) is trusted, as is the absent identity of a cold session.
 */
export function identityMismatch(header: HistoryHeader, identity: ReviewSessionIdentity): boolean {
  const session = header.session
  if (session === undefined) return false
  return session.createdAt !== identity.createdAt
    || session.isSeeded !== identity.isSeeded
    || session.cwd !== identity.cwd
}

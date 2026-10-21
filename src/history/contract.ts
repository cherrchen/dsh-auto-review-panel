/**
 * The persistence seam between the capture host and the on-disk history
 * store.
 *
 * The types here are the host-side contract only; the wire-facing retention
 * shape (`ReviewHistoryRetention`, `DEFAULT_RETENTION`) lives in the shared
 * `../contract.ts` because the client settings page needs it, and this module
 * re-exports it so history internals have a single import site.
 *
 * Persistence is a bypass audit log: `upsert` is fire-and-forget, every read
 * degrades to empty rather than throwing into a panel endpoint, and nothing
 * here can ever affect a review outcome.
 *
 * @module @dsh-electron/dsh-auto-review-panel/history/contract
 */

import type {
  PanelMaintenance,
  PanelStatsValue,
  ReviewHistoryRetention,
  ReviewRecord,
  ReviewRecordSummary,
} from '../contract.ts'

export { DEFAULT_RETENTION } from '../contract.ts'
export type { ReviewHistoryRetention } from '../contract.ts'

/**
 * The session identity a session file's header carries, read verbatim from
 * the live `Session.header`. A persisted file answers for exactly one session
 * lifecycle: when a live session's header disagrees, the file belongs to an
 * expired lifecycle and is renamed aside before the next write rather than
 * allowed to misattribute new evidence.
 */
export interface ReviewSessionIdentity {
  readonly createdAt: number
  readonly cwd?: string
  readonly isSeeded: boolean
}

/** `stats` result — identical to the channel's `PanelStatsValue`. */
export type ReviewHistoryStats = PanelStatsValue

/** `maintain()` result — identical to the channel's `PanelMaintenance`. */
export type ReviewHistoryMaintenance = PanelMaintenance

/** What `clear()` removed; `settings.json` is not history and survives. */
export interface ReviewHistoryClearResult {
  readonly removedSessions: number
  readonly removedBytes: number
}

/**
 * The persistence seam consumed by the capture host and the panel channel.
 *
 * `upsert` is deliberately synchronous and returns nothing: persistence is a
 * fire-and-forget side channel, so a storage failure must never propagate
 * into the capture path. Reads are async because they serialize behind the
 * same per-file write queues (read-your-writes).
 */
export interface ReviewHistory {
  /**
   * Persist one record's current truth.
   *
   * An uncorrelated record appends to the global unassigned log; a correlated
   * one appends to its session file (full record the first time, a `patch`
   * carrying `hostOutcome`/`correlation` afterwards) and tombstones the
   * unassigned copy. `identity` is the live session's header triple; absent
   * means the caller could not read it — a cold session is trusted.
   * @param record - the complete record as the buffer holds it.
   * @param identity - the live session identity, when readable.
   */
  upsert(record: ReviewRecord, identity?: ReviewSessionIdentity): void
  /**
   * The persisted summaries one session may see: its own session file plus
   * the always-visible unassigned batch, deduplicated by id (the session copy
   * wins), newest first. Returns empty when persistence is unavailable or the
   * session file belongs to an expired lifecycle. There is no unscoped read:
   * restoration is per-session by design, and an unscoped `list` never fans
   * out across session files.
   */
  summaries(sessionId: string, identity?: ReviewSessionIdentity): Promise<readonly ReviewRecordSummary[]>
  /**
   * One full persisted record. `sessionId` scopes the search: absent means
   * only the unassigned log can answer. Returns `undefined` for unknown or
   * lifecycle-stale ids.
   */
  get(sessionId: string | undefined, id: string, identity?: ReviewSessionIdentity): Promise<ReviewRecord | undefined>
  /** The store's health report for the `stats` endpoint and the settings page. */
  stats(): Promise<ReviewHistoryStats>
  /**
   * Persist the new retention and run one maintenance pass against it.
   * @returns post-write stats plus what the maintenance pass did.
   */
  updateSettings(retention: ReviewHistoryRetention): Promise<{ stats: ReviewHistoryStats; maintenance: ReviewHistoryMaintenance }>
  /** Delete every history file (session logs, unassigned, stale/corrupt asides); `settings.json` survives. */
  clear(): Promise<ReviewHistoryClearResult>
  /** Await the write queues of one session's files (or all files). */
  flush(sessionId?: string): Promise<void>
  /** Drain every queue and stop accepting writes. */
  close(): Promise<void>
}

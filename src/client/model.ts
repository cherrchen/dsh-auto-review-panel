/**
 * The panel's view model: every derivation the view renders, in pure
 * functions. The panel is a pure consumer — nothing here adjudicates,
 * re-scores, or fills a gap the host left; an absent field stays absent.
 *
 * @module @dsh-electron/dsh-auto-review-panel/client/model
 */

import type { PanelListValue, PanelStatus, ReviewDecision, ReviewRecord, ReviewRecordSummary, ReviewRisk } from '../contract.ts'

/** What the polling source last observed over the channel. */
export type PanelSnapshot =
  | { readonly phase: 'loading' }
  | { readonly phase: 'failed' }
  | { readonly phase: 'ready'; readonly value: PanelListValue }

/** The four empty states, named by the requirement's numbering. */
export type EmptyState = 'reviewer-unavailable' | 'not-auto' | 'channel-missing' | 'no-records'

/** The verdict chip's four kinds; `failed` is an abnormal reviewer finish. */
export type VerdictChip = 'allow' | 'deny' | 'error' | 'failed'

/**
 * The lightweight list filters: each multi-select keeps the rows whose
 * value is among the chosen options, and an unset or empty set filters
 * nothing. A record the host left without the field matches no chosen
 * option — an absent field stays absent, never counted as a match.
 *
 * `from`/`to` are `<input type="datetime-local">` values (local wall-clock,
 * no zone), converted to absolute instants only while filtering. Bounds are
 * inclusive; an unparsable bound filters nothing, and a record whose
 * `capturedAt` cannot be parsed never matches an active range.
 */
export interface ListFilters {
  readonly risk?: readonly ReviewRisk[]
  readonly decision?: readonly ReviewDecision[]
  /** Exact `action.name` values; options come from the records actually listed. */
  readonly tool?: readonly string[]
  readonly from?: string
  readonly to?: string
}

/** The Auto preset identity, mirroring the host's AUTO_PRESET. */
export const AUTO_PRESET_NAME = 'auto'

/**
 * The chip one row carries: an abnormal finish wins over the parsed verdict
 * (a failed reviewer cannot also have a decision worth displaying), and a
 * record with neither shows `failed` — never a guessed verdict.
 * @param summary - one list row.
 * @returns the chip kind.
 */
export function chipOf(summary: ReviewRecordSummary): VerdictChip {
  if (summary.finish !== undefined) return 'failed'
  return summary.decision ?? 'failed'
}

/**
 * The reason line one row carries: the host-truncated deny reason, or the
 * protocol's honest "no reason" note.
 * @param summary - one list row.
 * @returns the reason text, or undefined when the protocol carries none.
 */
export function reasonOf(summary: ReviewRecordSummary): string | undefined {
  return summary.reason
}

/**
 * Pick the empty state, or undefined when records may render.
 *
 * Order matters: a missing channel outranks reviewer availability (nothing
 * else can be read), and a session that is not Auto outranks "no records"
 * only while the host could say so — an absent `sessionPreset` falls into
 * `no-records`, as the contract requires.
 * @param snapshot - the last channel observation.
 * @returns the empty state to show.
 */
export function emptyStateOf(snapshot: PanelSnapshot): EmptyState | undefined {
  if (snapshot.phase === 'failed') return 'channel-missing'
  if (snapshot.phase !== 'ready') return undefined
  const status: PanelStatus = snapshot.value.status
  if (!status.reviewerAvailable) return 'reviewer-unavailable'
  if (status.sessionPreset !== undefined && status.sessionPreset !== AUTO_PRESET_NAME) return 'not-auto'
  if (snapshot.value.records.length === 0) return 'no-records'
  return undefined
}

/** The two display groups: this session's correlated records, then the always-visible uncorrelated batch. */
export interface RecordGroups {
  readonly correlated: readonly ReviewRecordSummary[]
  readonly uncorrelated: readonly ReviewRecordSummary[]
}

/** One `datetime-local` value as an absolute instant; NaN when unset or malformed. */
function instantOf(value: string | undefined): number {
  return value === undefined || value === '' ? Number.NaN : new Date(value).getTime()
}

/**
 * Split one list into its two display groups. The host's session filter
 * already keeps every uncorrelated record; grouping is purely presentational.
 * @param records - the newest-first host list.
 * @param filters - the active lightweight filters.
 * @returns the two groups, each still newest first.
 */
export function groupSummaries(records: readonly ReviewRecordSummary[], filters: ListFilters = {}): RecordGroups {
  const from = instantOf(filters.from)
  const to = instantOf(filters.to)
  const passTime = (capturedAt: string): boolean => {
    if (Number.isNaN(from) && Number.isNaN(to)) return true
    const instant = new Date(capturedAt).getTime()
    if (Number.isNaN(instant)) return false
    return (Number.isNaN(from) || instant >= from) && (Number.isNaN(to) || instant <= to)
  }
  const pass = (record: ReviewRecordSummary): boolean =>
    (filters.risk === undefined || filters.risk.length === 0
      || (record.risk !== undefined && filters.risk.includes(record.risk)))
    && (filters.decision === undefined || filters.decision.length === 0
      || (record.decision !== undefined && filters.decision.includes(record.decision)))
    && (filters.tool === undefined || filters.tool.length === 0
      || (record.action.name !== undefined && filters.tool.includes(record.action.name)))
    && passTime(record.capturedAt)
  return {
    correlated: records.filter(record => record.correlated && pass(record)),
    uncorrelated: records.filter(record => !record.correlated && pass(record)),
  }
}

/** Format one record timestamp for the list row (HH:MM:SS local). */
export function rowTime(iso: string): string {
  const time = new Date(iso)
  return Number.isNaN(time.getTime()) ? iso : time.toLocaleTimeString()
}

/**
 * The waterfall outcome line for the detail overview: the downstream decision
 * verbatim, plus the denial's error code when the downstream `deny` carried
 * one (`AUTO_REVIEW_DENIED` for a reviewer refusal).
 * @param record - the full record.
 * @returns the line, or undefined when the anchor never reached the call.
 */
export function downstreamOf(record: ReviewRecord): string | undefined {
  const correlation = record.correlation
  if (correlation === undefined) return undefined
  const info = correlation.denialInfo
  return info === undefined
    ? correlation.downstreamDecision
    : `${correlation.downstreamDecision} · ${info.code}`
}

/**
 * The host-disposition line for the detail overview, composed from Session
 * event evidence: the logged tool/result identity and the approval outcome.
 * Codes and outcome names are protocol vocabulary — shown verbatim, never
 * translated.
 * @param record - the full record.
 * @param labels - the two localized fragments (executed / approval prompt).
 * @returns the line, or undefined when no Session event evidence attached.
 */
export function hostOutcomeOf(
  record: ReviewRecord,
  labels: { readonly completed: string; readonly approval: string },
): string | undefined {
  const outcome = record.hostOutcome
  if (outcome === undefined) return undefined
  const parts: string[] = []
  const result = outcome.toolResult
  if (result !== undefined) {
    parts.push(result.isError
      ? (result.code ?? result.name ?? 'error')
      : labels.completed)
  }
  if (outcome.approval !== undefined) {
    parts.push(outcome.approval.outcome === undefined
      ? labels.approval
      : `${labels.approval} → ${outcome.approval.outcome}`)
  }
  return parts.length === 0 ? undefined : parts.join(' · ')
}

/**
 * The session-bound records source.
 *
 * One ObservableSnapshot per Session the pane shows: it polls the newest
 * `list` page on a fixed interval while subscribed and publishes a new
 * immutable snapshot only when the answer moved. The channel has no push
 * endpoint in v1 — polling is the documented substitute (requirements §4.2
 * open question). A failed call does not hide a previously good list; it
 * flips the phase so the view can show the channel-missing state. A call
 * that never answers is given up on after the request timeout, so one hung
 * request cannot wedge the source.
 *
 * Pagination is the deliberate exception to liveness (requirements §4.5):
 * `loadOlder()` appends strictly-older pages and pauses the poll — a live
 * refresh while paging could move the cursor boundary and punch a hole in
 * the middle of the list. `refresh()` drops the older pages and resumes.
 * A `list` that comes back empty clears the loaded older pages: a history
 * wipe shows up on the next poll, not after a manual restart.
 *
 * @module @dsh-electron/dsh-auto-review-panel/client/source
 */

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { PanelListValue, ReviewRecordSummary } from '../contract.ts'
import type { PanelListApi } from './panel-client.ts'
import type { PanelSnapshot } from './model.ts'

/** Default polling interval for the push-free channel. */
export const POLL_INTERVAL_MS = 3000

/** How long one list call may take before the source abandons it. */
export const REQUEST_TIMEOUT_MS = 10_000

/** Rows one `loadOlder` page carries. */
export const OLDER_PAGE_SIZE = 200

/** One polling source's dependencies, injectable for tests. */
export interface RecordsSourceOptions {
  readonly intervalMs?: number
  readonly timeoutMs?: number
  /** Page size for `loadOlder`; defaults to {@link OLDER_PAGE_SIZE}. */
  readonly olderPageSize?: number
}

/** A records source with refresh and history paging for the view. */
export interface RecordsSource extends ObservableSnapshot<PanelSnapshot> {
  /** Drop the older pages, resume polling, and refetch the newest page. */
  refresh(): void
  /**
   * Fetch the next strictly-older page and pause polling. No-op while a page
   * is in flight, when the first page has not landed, or when the host says
   * no older entries exist.
   */
  loadOlder(): void
}

/** The page block of one `list` answer, retained for the merged snapshot. */
type PageCursor = PanelListValue['page']

/** The merged newest-first snapshot the source publishes while ready. */
function mergePage(
  first: PanelListValue,
  older: readonly ReviewRecordSummary[],
  olderPage: PageCursor | undefined,
): PanelListValue {
  if (older.length === 0) return first
  const seen = new Set(first.records.map(record => record.id))
  const additions = older.filter(record => !seen.has(record.id))
  return {
    ...first,
    records: [...first.records, ...additions],
    page: olderPage ?? first.page,
  }
}

/**
 * Build the session-bound polling source.
 * @param api - the panel channel face, or undefined when no Connection exists.
 * @param sessionId - the session this pane displays.
 * @param options - interval and clock.
 * @returns the observable source; identical snapshot references between
 *   unchanged polls keep the framework's memoization honest.
 */
export function createRecordsSource(
  api: PanelListApi | undefined,
  sessionId: string,
  options: RecordsSourceOptions = {},
): RecordsSource {
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const olderPageSize = options.olderPageSize ?? OLDER_PAGE_SIZE
  let snapshot: PanelSnapshot = api === undefined ? { phase: 'failed' } : { phase: 'loading' }
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setInterval> | undefined

  /** The newest first-page answer the source holds. */
  let first: PanelListValue | undefined
  /** Strictly-older rows loaded through `loadOlder`, page order (newest→oldest). */
  let older: readonly ReviewRecordSummary[] = []
  /** The page cursor the last `loadOlder` answer carried; feeds the next call. */
  let olderPage: PageCursor | undefined
  /** Wire content of the last published snapshot, for change detection. */
  let lastEncoded: string | undefined
  /**
   * Generation counter `refresh()` bumps so a `loadOlder` answer that was in
   * flight across the reset cannot resurrect rows from the abandoned walk.
   */
  let epoch = 0
  let polling = false
  let loadingOlder = false

  const publish = (next: PanelSnapshot): void => {
    if (next === snapshot) return
    snapshot = next
    for (const listener of listeners) listener()
  }

  /** Race one call against the request timeout. */
  const request = async <T>(call: Promise<T>): Promise<T> => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        call,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('auto review panel: request timed out')), timeoutMs)
        }),
      ])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }

  /** Publish the merged first-page + older-rows snapshot when it moved. */
  const publishMerged = (value: PanelListValue): void => {
    const encoded = JSON.stringify(value)
    if (encoded === lastEncoded && snapshot.phase === 'ready') return
    lastEncoded = encoded
    publish({ phase: 'ready', value, live: true })
  }

  const poll = async (): Promise<void> => {
    // While older pages are loaded the poll pauses: refetching the newest
    // page under a moving cursor boundary could silently skip records the
    // next `loadOlder` page would then never see. `refresh()` is the resume.
    if (api === undefined || polling || loadingOlder || olderPage !== undefined) return
    polling = true
    try {
      const value = await request(api.list(sessionId))
      const hadRecords = (first?.records.length ?? 0) > 0 || older.length > 0
      first = value
      // A wiped history shows up as an empty first page: the loaded older
      // rows are all gone, so the pause state and the rows drop together.
      if (value.records.length === 0 && hadRecords) {
        older = []
        olderPage = undefined
      }
      publishMerged(mergePage(value, older, olderPage))
    } catch {
      publish({ phase: 'failed' })
    } finally {
      polling = false
    }
  }

  const start = (): void => {
    if (timer !== undefined) return
    void poll()
    timer = setInterval(() => void poll(), intervalMs)
  }

  const stop = (): void => {
    if (timer === undefined) return
    clearInterval(timer)
    timer = undefined
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      start()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stop()
      }
    },
    refresh() {
      // Back to the newest page: older rows and the pause flag drop, the
      // change detection resets so an identical answer still republishes —
      // `refresh` after `failed` must leave `failed` even when the wire
      // content would serialize identically.
      epoch += 1
      older = []
      olderPage = undefined
      lastEncoded = undefined
      void poll()
    },
    loadOlder() {
      if (api === undefined || loadingOlder) return
      const base = olderPage ?? first?.page
      if (base === undefined || !base.hasMore || base.before === undefined) return
      const before = base.before
      const atEpoch = epoch
      loadingOlder = true
      void request(api.list(sessionId, { before, limit: olderPageSize }))
        .then(page => {
          if (atEpoch !== epoch) return
          const seen = new Set([...(first?.records ?? []).map(record => record.id), ...older.map(record => record.id)])
          const additions = page.records.filter(record => !seen.has(record.id))
          older = [...older, ...additions]
          olderPage = page.page
          const value = first === undefined ? page : mergePage(first, older, olderPage)
          lastEncoded = JSON.stringify(value)
          publish({ phase: 'ready', value, live: false })
        }, () => {
          // One failed page loses nothing already loaded; the button simply
          // retries against the same cursor on the next click.
        })
        .finally(() => {
          loadingOlder = false
        })
    },
  }
}

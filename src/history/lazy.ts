/**
 * The lazy {@link ReviewHistory} the capture host holds.
 *
 * The plugin row cannot do filesystem work at construction time: `boot()` is
 * synchronous, an absent history root is a legitimate configuration, and a
 * persistence failure must never be allowed to look like a capture failure.
 * This wrapper therefore resolves `DSH_HOME`, creates the file operations,
 * and opens the store on a one-shot promise; every call either waits for it
 * or degrades quietly — `upsert` is fire-and-forget, reads return empty, and
 * `stats` reports `available: false`.
 *
 * `updateSettings` and `clear` are the deliberate exception: they rethrow the
 * store's failure so the settings endpoints can answer honestly instead of
 * pretending a write succeeded.
 *
 * @module @dsh-electron/dsh-auto-review-panel/history/lazy
 */

import type { ReviewHistoryRetention, ReviewRecord, ReviewRecordSummary } from '../contract.ts'
import { DEFAULT_RETENTION } from '../contract.ts'
import type {
  ReviewHistory,
  ReviewHistoryClearResult,
  ReviewHistoryStats,
  ReviewSessionIdentity,
} from './contract.ts'
import { createFileOps, resolveHistoryRoot, type HistoryEnv, type HistoryLocation } from './paths.ts'
import { ReviewHistoryStore } from './store.ts'

/** Options for {@link LazyReviewHistory}. */
export interface LazyReviewHistoryOptions {
  /** Environment to read `DSH_HOME` from; defaults to the live process env. */
  readonly env?: HistoryEnv
  /** Warning sink forwarded to the store. */
  readonly warn?: (message: string) => void
}

/**
 * A {@link ReviewHistory} that opens its store on first use and fails soft
 * everywhere except the two settings mutations the UI must see honestly.
 */
export class LazyReviewHistory implements ReviewHistory {
  readonly #location: Promise<HistoryLocation>
  readonly #store: Promise<ReviewHistoryStore | undefined>

  constructor(options: LazyReviewHistoryOptions = {}) {
    const env = options.env ?? process.env
    this.#location = resolveHistoryRoot(env).catch(() => ({
      root: '',
      display: `~/.dsh/auto-review-panel/v1`,
    }))
    this.#store = this.#location
      .then(async location => {
        if (location.root === '') return undefined
        const ops = await createFileOps()
        return ReviewHistoryStore.open({
          root: location.root,
          display: location.display,
          ops,
          ...(options.warn === undefined ? {} : { warn: options.warn }),
        })
      })
      .catch(() => undefined)
  }

  /** The store once ready, or `undefined` when persistence is unavailable. */
  async #ready(): Promise<ReviewHistoryStore | undefined> {
    const store = await this.#store
    return store !== undefined && store.available ? store : undefined
  }

  /** The stats shape persistence failure degrades to. */
  async #unavailableStats(): Promise<ReviewHistoryStats> {
    const location = await this.#location
    const store = await this.#store
    return {
      available: false,
      location: location.display,
      settings: store?.stats !== undefined ? (await store.stats()).settings : DEFAULT_RETENTION,
      sessions: 0,
      bytes: 0,
      ...(store?.lastError === undefined ? {} : { lastError: store.lastError }),
    }
  }

  /** Fire-and-forget persist; nothing escapes into the capture path. */
  upsert(record: ReviewRecord, identity?: ReviewSessionIdentity): void {
    void this.#store.then(store => {
      try {
        store?.upsert(record, identity)
      } catch {
        // The store already contains its failures; this is only a belt.
      }
    }, () => {})
  }

  /** Persisted summaries for a session view; empty when unavailable. */
  async summaries(sessionId: string, identity?: ReviewSessionIdentity): Promise<readonly ReviewRecordSummary[]> {
    const store = await this.#ready()
    return store === undefined ? [] : store.summaries(sessionId, identity)
  }

  /** One persisted record; `undefined` when absent or unavailable. */
  async get(sessionId: string | undefined, id: string, identity?: ReviewSessionIdentity): Promise<ReviewRecord | undefined> {
    const store = await this.#ready()
    return store === undefined ? undefined : store.get(sessionId, id, identity)
  }

  /** Store health; an absent or failed store reports `available: false`. */
  async stats(): Promise<ReviewHistoryStats> {
    const store = await this.#store
    if (store === undefined || !store.available) return this.#unavailableStats()
    return store.stats()
  }

  /** Persist retention + maintain; the failure rethrows for an honest `failure`. */
  async updateSettings(retention: ReviewHistoryRetention) {
    const store = await this.#ready()
    if (store === undefined) {
      throw new Error('review history persistence is unavailable')
    }
    return store.updateSettings(retention)
  }

  /** Delete every history file; the failure rethrows for an honest `failure`. */
  async clear(): Promise<ReviewHistoryClearResult> {
    const store = await this.#ready()
    if (store === undefined) {
      throw new Error('review history persistence is unavailable')
    }
    return store.clear()
  }

  /** Drain the queues for one session (or all), a no-op when unavailable. */
  async flush(sessionId?: string): Promise<void> {
    const store = await this.#store
    await store?.flush(sessionId).catch(() => {})
  }

  /** Drain and stop the store. */
  async close(): Promise<void> {
    const store = await this.#store.catch(() => undefined)
    await store?.close().catch(() => {})
  }
}

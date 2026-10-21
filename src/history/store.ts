/**
 * The on-disk review-history store.
 *
 * One append-only JSONL file per session under `<root>/sessions/`, plus a
 * global `unassigned.jsonl` for captures that never earned a correlation
 * anchor. Writes are serialized per file through a promise chain — and,
 * when `@deepseek-ai/dsh-atomic-write` resolves, through a cross-process
 * `<file>.lock` — while reads fold lines on demand and cache the projected
 * summaries against the file's `mtimeMs`/`size`.
 *
 * The failure contract is the bypass rule: a store that cannot open its root
 * reports `available: false` and serves nothing; a single failed append is
 * swallowed into `warn` and the next write still tries; a corrupted file is
 * renamed aside (`.corrupt-<stamp>`) and read as empty; a file whose header
 * belongs to an expired session lifecycle is read as empty and renamed aside
 * (`.stale-<stamp>`) before the next write. None of it touches a verdict.
 *
 * @module @dsh-electron/dsh-auto-review-panel/history/store
 */

import { createReadStream } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import type { ReviewRecord, ReviewRecordSummary } from '../contract.ts'
import { deepFreeze, summarizeRecord } from '../records.ts'
import type {
  ReviewHistory,
  ReviewHistoryClearResult,
  ReviewHistoryMaintenance,
  ReviewHistoryRetention,
  ReviewHistoryStats,
  ReviewSessionIdentity,
} from './contract.ts'
import { DEFAULT_RETENTION } from '../contract.ts'
import {
  compareSummariesDesc,
  decodeLine,
  encodeLine,
  encodeSessionKey,
  HISTORY_SCHEMA,
  identityMismatch,
  isSessionFileName,
  type HistoryHeader,
  type HistoryLine,
  type HistoryPatch,
} from './format.ts'
import type { HistoryFileOps } from './paths.ts'

/** The unassigned bucket's file and its slot key. */
const UNASSIGNED_KEY = 'unassigned'
const UNASSIGNED_FILE = 'unassigned.jsonl'
const SESSIONS_DIR = 'sessions'
const SETTINGS_FILE = 'settings.json'
const SETTINGS_SCHEMA = 1

/**
 * `unassigned.jsonl` is compacted once its `delete` tombstones exceed either
 * bound: an absolute dead-line count, or the count of still-live records —
 * whichever comes first.
 */
const DEAD_LINE_LIMIT = 200

/** Per-file state: the write queue plus the stat-validated summary cache. */
interface FileSlot {
  readonly key: string
  readonly path: string
  queue: Promise<void>
  cache: FileCache | undefined
  /** Header schema this build cannot read — the file is never written. */
  foreign: boolean
  /** Whether the `foreign` warning already fired. */
  foreignWarned: boolean
}

/** The cached fold of one file: summaries only, never full records. */
interface FileCache {
  exists: boolean
  mtimeMs: number
  size: number
  header: HistoryHeader | undefined
  /** Live records' projected rows keyed by id, in file order. */
  summaries: Map<string, ReviewRecordSummary>
  /** Ids that already carry a full `record` line — later upserts become patches. */
  written: Set<string>
  /** `delete` tombstones observed (unassigned compaction pressure). */
  dead: number
  /** Lines that failed to parse and were skipped. */
  bad: number
}

/** The fold result: `status` decides how the caller may treat the file. */
interface Folded {
  status: 'missing' | 'ready' | 'corrupt' | 'foreign'
  header?: HistoryHeader
  summaries: Map<string, ReviewRecordSummary>
  records?: Map<string, ReviewRecord>
  written: Set<string>
  dead: number
  bad: number
}

/** Store construction options. */
export interface ReviewHistoryStoreOptions {
  /** Absolute history root (already resolved). */
  readonly root: string
  /** Symbolic display spelling for `stats.location`. */
  readonly display: string
  /** The file operations from `createFileOps`. */
  readonly ops: HistoryFileOps
  /** One-warning-per-event sink; defaults to `console.warn`. */
  readonly warn?: (message: string) => void
  /** Clock for `.stale-`/`.corrupt-` stamps; defaults to `Date.now`. */
  readonly now?: () => number
}

/** Whether one fs failure is plain absence. */
function isAbsent(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'ENOENT'
}

/** Read one file's lines; stream failures surface after the loop, never as an unhandled 'error' event. */
async function* readLines(path: string): AsyncGenerator<string> {
  const input = createReadStream(path, { encoding: 'utf8' })
  let failure: unknown
  input.on('error', error => { failure = failure ?? error })
  try {
    const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
    rl.on('error', error => { failure = failure ?? error })
    for await (const line of rl) {
      if (line !== '') yield line
    }
  } finally {
    input.destroy()
  }
  if (failure !== undefined) throw failure
}

/** The header a fresh file is created with. */
function headerLine(sessionId: string | null, identity: ReviewSessionIdentity | undefined): HistoryHeader {
  return {
    type: 'header',
    schema: HISTORY_SCHEMA,
    sessionId,
    ...(identity === undefined ? {} : { session: identity }),
  }
}

/** Merge a `patch` line's defined members onto a full record. */
function applyPatch(record: ReviewRecord, patch: HistoryPatch): ReviewRecord {
  return {
    ...record,
    ...(patch.correlation === undefined ? {} : { correlation: patch.correlation }),
    ...(patch.hostOutcome === undefined ? {} : { hostOutcome: patch.hostOutcome }),
  }
}

/**
 * The {@link ReviewHistory} implementation backed by the filesystem.
 *
 * Construct through {@link ReviewHistoryStore.open}: the root is created and
 * `settings.json` loaded there, and a root that cannot be used marks the
 * store unavailable rather than throwing.
 */
export class ReviewHistoryStore implements ReviewHistory {
  readonly #root: string
  readonly #display: string
  readonly #ops: HistoryFileOps
  readonly #warn: (message: string) => void
  readonly #now: () => number
  readonly #slots = new Map<string, FileSlot>()
  #settings = DEFAULT_RETENTION
  #available = true
  #closed = false
  #lastError: string | undefined

  private constructor(options: ReviewHistoryStoreOptions) {
    this.#root = options.root
    this.#display = options.display
    this.#ops = options.ops
    this.#warn = options.warn ?? (message => console.warn(message))
    this.#now = options.now ?? Date.now
  }

  /** Whether the root is usable; `false` means the panel runs memory-only. */
  get available(): boolean {
    return this.#available
  }

  /** The last failure the store swallowed. */
  get lastError(): string | undefined {
    return this.#lastError
  }

  /**
   * Create the root, load `settings.json`, and return the store.
   * @param options - the resolved root, ops, and sinks.
   */
  static async open(options: ReviewHistoryStoreOptions): Promise<ReviewHistoryStore> {
    const store = new ReviewHistoryStore(options)
    await store.#init()
    return store
  }

  async #init(): Promise<void> {
    try {
      await mkdir(join(this.#root, SESSIONS_DIR), { recursive: true, mode: 0o700 })
      this.#settings = await this.#loadSettings()
    } catch (error) {
      this.#available = false
      this.#noteError('open', error)
    }
  }

  /** Read `settings.json`; unreadable or malformed input degrades to the defaults. */
  async #loadSettings() {
    let raw: string
    try {
      raw = await readFile(join(this.#root, SETTINGS_FILE), 'utf8')
    } catch (error) {
      if (!isAbsent(error)) this.#noteError('settings', error)
      return DEFAULT_RETENTION
    }
    try {
      const parsed = JSON.parse(raw) as { retention?: Record<string, unknown> }
      const retention = parsed?.retention
      if (retention === null || typeof retention !== 'object') return DEFAULT_RETENTION
      const field = (name: string): number => {
        const value = retention[name]
        return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
      }
      return {
        maxRecordsPerSession: field('maxRecordsPerSession'),
        maxSessions: field('maxSessions'),
        maxTotalMegabytes: field('maxTotalMegabytes'),
      }
    } catch {
      this.#warn('auto review panel: settings.json is not parseable; default retention in use')
      return DEFAULT_RETENTION
    }
  }

  /** The slot one file lives behind, created on first touch. */
  #slotFor(key: string): FileSlot {
    let slot = this.#slots.get(key)
    if (slot === undefined) {
      const path = key === UNASSIGNED_KEY
        ? join(this.#root, UNASSIGNED_FILE)
        : join(this.#root, SESSIONS_DIR, `${key}.jsonl`)
      slot = { key, path, queue: Promise.resolve(), cache: undefined, foreign: false, foreignWarned: false }
      this.#slots.set(key, slot)
    }
    return slot
  }

  /**
   * Serialize one mutation behind the file's queue and (when available) its
   * cross-process lock. A failure is recorded, warned once, and swallowed —
   * the next write still tries.
   */
  #enqueue(slot: FileSlot, op: () => Promise<void>): Promise<void> {
    const task = slot.queue
      .then(() => this.#ops.locked(slot.path, op))
      .catch(error => this.#noteError(slot.key, error))
    slot.queue = task
    return task
  }

  /** Record a swallowed failure for `stats.lastError` and the warn channel. */
  #noteError(where: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.#lastError = `${where}: ${message}`
    this.#warn(`auto review panel: history write at ${where} failed: ${message}`)
  }

  /**
   * Stat-and-fold one file on demand, reusing the cache while `mtimeMs`/`size`
   * say nothing moved.
   * @param slot - the file's slot.
   * @param identity - the live session identity, when readable. Only session
   *   files are checked; a mismatch marks the file `stale`.
   * @returns what the caller may do with the file.
   */
  async #ensureFresh(slot: FileSlot, identity: ReviewSessionIdentity | undefined): Promise<'missing' | 'ready' | 'foreign' | 'stale'> {
    let st
    try {
      st = await stat(slot.path)
    } catch (error) {
      if (!isAbsent(error)) throw error
      st = undefined
    }
    if (st === undefined || st.size === 0) {
      slot.foreign = false
      slot.foreignWarned = false
      slot.cache = undefined
      return 'missing'
    }
    if (slot.foreign) return 'foreign'
    const cached = slot.cache
    if (cached !== undefined && cached.exists && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return identity !== undefined && cached.header !== undefined && identityMismatch(cached.header, identity)
        ? 'stale'
        : 'ready'
    }
    const folded = await this.#fold(slot, false)
    if (folded.status === 'corrupt') {
      await this.#renameAside(slot, 'corrupt')
      return 'missing'
    }
    if (folded.status === 'missing') return 'missing'
    slot.cache = {
      exists: true,
      mtimeMs: st.mtimeMs,
      size: st.size,
      header: folded.header,
      summaries: folded.summaries,
      written: folded.written,
      dead: folded.dead,
      bad: folded.bad,
    }
    if (folded.status === 'foreign') {
      slot.foreign = true
      return 'foreign'
    }
    return identity !== undefined && folded.header !== undefined && identityMismatch(folded.header, identity)
      ? 'stale'
      : 'ready'
  }

  /**
   * Fold one file's lines into summaries (and full records when asked).
   * The first line must be a header — a file without one is `corrupt`; a
   * header naming a schema this build cannot read is `foreign` and must
   * never be overwritten.
   */
  async #fold(slot: FileSlot, keepRecords: boolean): Promise<Folded> {
    const folded: Folded = {
      status: 'missing',
      summaries: new Map(),
      written: new Set(),
      dead: 0,
      bad: 0,
      ...(keepRecords ? { records: new Map<string, ReviewRecord>() } : {}),
    }
    let lineNo = 0
    try {
      for await (const raw of readLines(slot.path)) {
        lineNo += 1
        const line = decodeLine(raw)
        if (line === undefined) {
          if (lineNo === 1) return { ...folded, status: 'corrupt' }
          folded.bad += 1
          continue
        }
        if (lineNo === 1) {
          if (line.type !== 'header') return { ...folded, status: 'corrupt' }
          if (line.schema !== HISTORY_SCHEMA) {
            return { ...folded, status: 'foreign', header: line }
          }
          folded.header = line
          folded.status = 'ready'
          continue
        }
        if (folded.status === 'missing') return { ...folded, status: 'corrupt' }
        this.#applyLine(folded, line)
      }
    } catch (error) {
      if (isAbsent(error)) return { ...folded, status: 'missing' }
      throw error
    }
    // A zero-line file (crash between create and header write) reads as missing.
    return lineNo === 0 ? { ...folded, status: 'missing' } : folded
  }

  /** Apply one decoded line to an in-progress fold. */
  #applyLine(folded: Folded, line: HistoryLine): void {
    switch (line.type) {
      case 'record': {
        const summary = summarizeRecord(line.record)
        folded.summaries.set(line.record.id, summary)
        folded.written.add(line.record.id)
        folded.records?.set(line.record.id, line.record)
        return
      }
      case 'patch': {
        const existing = folded.summaries.get(line.id)
        if (existing !== undefined && line.patch.correlation !== undefined) {
          folded.summaries.set(line.id, { ...existing, correlated: true })
        }
        const record = folded.records?.get(line.id)
        if (record !== undefined) folded.records?.set(line.id, applyPatch(record, line.patch))
        return
      }
      case 'delete': {
        folded.summaries.delete(line.id)
        // A tombstone counts against compaction pressure even when the
        // record it names never landed in this file.
        folded.dead += 1
        folded.records?.delete(line.id)
        return
      }
      default:
        return
    }
  }

  /**
   * Fold one file keeping only the record with `id` — `get` streams the file
   * and never holds a second full record.
   */
  async #foldOne(slot: FileSlot, id: string): Promise<ReviewRecord | undefined> {
    let current: ReviewRecord | undefined
    try {
      for await (const raw of readLines(slot.path)) {
        const line = decodeLine(raw)
        if (line === undefined || line.type === 'header') continue
        if (line.type === 'record' && line.record.id === id) current = line.record
        else if (line.type === 'patch' && line.id === id && current !== undefined) {
          current = applyPatch(current, line.patch)
        } else if (line.type === 'delete' && line.id === id) current = undefined
      }
    } catch (error) {
      if (!isAbsent(error)) throw error
    }
    return current === undefined ? undefined : deepFreeze(current)
  }

  /**
   * The append primitive: validate the file, rename stale bytes aside, create
   * a fresh file with its header when missing, then append the line and fold
   * it into the cache.
   * @returns whether the line landed.
   */
  async #appendLine(
    slot: FileSlot,
    sessionId: string | null,
    identity: ReviewSessionIdentity | undefined,
    build: (cache: FileCache | undefined) => HistoryLine,
  ): Promise<boolean> {
    let state = await this.#ensureFresh(slot, identity)
    if (state === 'foreign') {
      if (!slot.foreignWarned) {
        slot.foreignWarned = true
        this.#warn(`auto review panel: ${slot.path} uses an unrecognized schema; leaving it untouched`)
      }
      return false
    }
    if (state === 'stale') {
      await this.#renameAside(slot, 'stale')
      state = 'missing'
    }
    const line = build(slot.cache)
    const encoded = encodeLine(line)
    if (state === 'missing') {
      const header = headerLine(sessionId, identity)
      await this.#ops.writeAtomic(slot.path, `${encodeLine(header)}${encoded}`)
      slot.cache = {
        exists: true,
        mtimeMs: 0,
        size: 0,
        header,
        summaries: new Map(),
        written: new Set(),
        dead: 0,
        bad: 0,
      }
    } else {
      await appendFile(slot.path, encoded, 'utf8')
    }
    this.#applyToCache(slot, line)
    await this.#restat(slot)
    return true
  }

  /** Fold one committed line into the cache without re-reading the file. */
  #applyToCache(slot: FileSlot, line: HistoryLine): void {
    const cache = slot.cache
    if (cache === undefined || !cache.exists) return
    const folded: Folded = {
      status: 'ready',
      summaries: cache.summaries,
      written: cache.written,
      dead: cache.dead,
      bad: cache.bad,
    }
    this.#applyLine(folded, line)
    cache.dead = folded.dead
    cache.bad = folded.bad
  }

  /** Refresh the cache's validity stamp after a write. */
  async #restat(slot: FileSlot): Promise<void> {
    const cache = slot.cache
    if (cache === undefined) return
    try {
      const st = await stat(slot.path)
      cache.mtimeMs = st.mtimeMs
      cache.size = st.size
      cache.exists = true
    } catch {
      // Leave the old stamp; the next stat comparison simply re-folds.
    }
  }

  /** Move `slot`'s file aside as `<name>.<kind>-<stamp>`, preserving its bytes. */
  async #renameAside(slot: FileSlot, kind: 'stale' | 'corrupt'): Promise<void> {
    const target = `${slot.path}.${kind}-${this.#now().toString(36)}`
    try {
      await rename(slot.path, target)
      if (kind === 'corrupt') {
        this.#warn(`auto review panel: ${slot.path} was unreadable; renamed to ${target}`)
      }
    } catch (error) {
      if (!isAbsent(error)) throw error
    }
    slot.cache = undefined
    slot.foreign = false
    slot.foreignWarned = false
  }

  /**
   * Persist one record's current truth (fire-and-forget — see
   * {@link ReviewHistory.upsert}).
   */
  upsert(record: ReviewRecord, identity?: ReviewSessionIdentity): void {
    if (this.#closed || !this.#available) return
    const sessionId = record.correlation?.sessionId
    if (sessionId === undefined) {
      const slot = this.#slotFor(UNASSIGNED_KEY)
      this.#enqueue(slot, async () => {
        await this.#appendLine(slot, null, undefined, () => ({ type: 'record', record }))
      })
      return
    }
    const slot = this.#slotFor(encodeSessionKey(sessionId))
    let wrote = false
    const write = this.#enqueue(slot, async () => {
      wrote = await this.#appendLine(slot, sessionId, identity, cache =>
        cache?.written.has(record.id) === true
          ? {
              type: 'patch',
              id: record.id,
              patch: {
                ...(record.correlation === undefined ? {} : { correlation: record.correlation }),
                ...(record.hostOutcome === undefined ? {} : { hostOutcome: record.hostOutcome }),
              },
            }
          : { type: 'record', record })
    })
    // The tombstone goes to the unassigned queue AFTER the session copy
    // commits: a crash in the window leaves a duplicate (readers dedupe by
    // id), never a record deleted from the only file that held it.
    const unassigned = this.#slotFor(UNASSIGNED_KEY)
    this.#enqueue(unassigned, async () => {
      await write
      if (!wrote) return
      await this.#appendLine(unassigned, null, undefined, () => ({ type: 'delete', id: record.id }))
      await this.#collectUnassigned(unassigned)
    })
  }

  /** Compact the unassigned log once its tombstones outlive their purpose. */
  async #collectUnassigned(slot: FileSlot): Promise<void> {
    if (slot.cache === undefined || !slot.cache.exists) return
    if (slot.cache.dead <= DEAD_LINE_LIMIT && slot.cache.dead <= slot.cache.summaries.size) return
    await this.#compact(slot)
  }

  /**
   * Rewrite one file keeping `keep` newest records (all live records when
   * undefined) — tombstones, torn lines and evicted rows all drop out.
   * Callers hold the lock/queue; compaction itself does not re-acquire them.
   */
  async #compact(slot: FileSlot, keep?: number): Promise<number> {
    const folded = await this.#fold(slot, true)
    if (folded.status !== 'ready' || folded.header === undefined) return 0
    const records = [...(folded.records?.values() ?? [])]
    const kept = keep === undefined || records.length <= keep
      ? records
      : records.slice(records.length - keep)
    if (kept.length === records.length && folded.dead === 0 && folded.bad === 0) return 0
    const body = [encodeLine(folded.header), ...kept.map(record => encodeLine({ type: 'record', record }))]
    await this.#ops.writeAtomic(slot.path, body.join(''))
    const summaries = new Map<string, ReviewRecordSummary>()
    for (const record of kept) summaries.set(record.id, summarizeRecord(record))
    slot.cache = {
      exists: true,
      mtimeMs: 0,
      size: 0,
      header: folded.header,
      summaries,
      written: new Set(kept.map(record => record.id)),
      dead: 0,
      bad: 0,
    }
    await this.#restat(slot)
    return records.length - kept.length
  }

  /** The merged persisted view one session sees — own file plus unassigned. */
  async summaries(sessionId: string, identity?: ReviewSessionIdentity): Promise<readonly ReviewRecordSummary[]> {
    if (!this.#available) return []
    const slot = this.#slotFor(encodeSessionKey(sessionId))
    const unassigned = this.#slotFor(UNASSIGNED_KEY)
    await Promise.allSettled([slot.queue, unassigned.queue])
    const merged = new Map<string, ReviewRecordSummary>()
    try {
      if (await this.#ensureFresh(slot, identity) === 'ready' && slot.cache !== undefined) {
        for (const [id, summary] of slot.cache.summaries) merged.set(id, summary)
      }
    } catch (error) {
      this.#noteError(slot.key, error)
    }
    try {
      if (await this.#ensureFresh(unassigned, undefined) === 'ready' && unassigned.cache !== undefined) {
        for (const [id, summary] of unassigned.cache.summaries) {
          if (!merged.has(id)) merged.set(id, summary)
        }
      }
    } catch (error) {
      this.#noteError(unassigned.key, error)
    }
    return [...merged.values()].sort(compareSummariesDesc)
  }

  /** One full persisted record, deep-frozen before it leaves the store. */
  async get(sessionId: string | undefined, id: string, identity?: ReviewSessionIdentity): Promise<ReviewRecord | undefined> {
    if (!this.#available) return undefined
    const slots = sessionId === undefined
      ? [this.#slotFor(UNASSIGNED_KEY)]
      : [this.#slotFor(encodeSessionKey(sessionId)), this.#slotFor(UNASSIGNED_KEY)]
    for (const slot of slots) {
      await slot.queue.catch(() => {})
      try {
        if (await this.#ensureFresh(slot, identity) !== 'ready') continue
        const record = await this.#foldOne(slot, id)
        if (record !== undefined) return record
      } catch (error) {
        this.#noteError(slot.key, error)
      }
    }
    return undefined
  }

  /** The store's health report. */
  async stats(): Promise<ReviewHistoryStats> {
    if (!this.#available) {
      return {
        available: false,
        location: this.#display,
        settings: this.#settings,
        sessions: 0,
        bytes: 0,
        ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
      }
    }
    await this.#quiesce()
    const files = await this.#sessionFiles()
    let bytes = 0
    for (const file of files) bytes += file.size
    bytes += await this.#fileSize(join(this.#root, UNASSIGNED_FILE))
    return {
      available: true,
      location: this.#display,
      settings: this.#settings,
      sessions: files.length,
      bytes,
      ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
    }
  }

  /** Persist new retention, then run one maintenance pass against it. */
  async updateSettings(retention: ReviewHistoryRetention): Promise<{ stats: ReviewHistoryStats; maintenance: ReviewHistoryMaintenance }> {
    if (!this.#available) {
      return { stats: await this.stats(), maintenance: { compactedSessions: 0, removedSessions: 0, removedRecords: 0 } }
    }
    const content = `${JSON.stringify({ schema: SETTINGS_SCHEMA, retention })}\n`
    await this.#ops.writeAtomic(join(this.#root, SETTINGS_FILE), content)
    this.#settings = retention
    const maintenance = await this.maintain()
    return { stats: await this.stats(), maintenance }
  }

  /**
   * One retention pass: per-session compaction, unassigned compaction, then
   * session-count and total-size eviction, oldest file first on both.
   */
  async maintain(): Promise<ReviewHistoryMaintenance> {
    await this.#quiesce()
    const warnings: string[] = []
    let compactedSessions = 0
    let removedSessions = 0
    let removedRecords = 0
    if (!this.#available) return { compactedSessions, removedSessions, removedRecords }

    const perSession = this.#settings.maxRecordsPerSession
    let files = await this.#sessionFiles()
    if (perSession > 0) {
      for (const file of files) {
        const slot = this.#slotFor(file.key)
        const removed = await this.#ops.locked(slot.path, async () => {
          try {
            if (await this.#ensureFresh(slot, undefined) !== 'ready') return 0
            return await this.#compact(slot, perSession)
          } catch (error) {
            this.#noteError(slot.key, error)
            return 0
          }
        })
        if (removed > 0) {
          compactedSessions += 1
          removedRecords += removed
        }
      }
    }

    const unassigned = this.#slotFor(UNASSIGNED_KEY)
    await this.#ops.locked(unassigned.path, async () => {
      try {
        if (await this.#ensureFresh(unassigned, undefined) === 'ready'
          && unassigned.cache !== undefined
          && (unassigned.cache.dead > DEAD_LINE_LIMIT || unassigned.cache.dead > unassigned.cache.summaries.size)) {
          removedRecords += await this.#compact(unassigned)
        }
      } catch (error) {
        this.#noteError(unassigned.key, error)
      }
    })

    const maxSessions = this.#settings.maxSessions
    if (maxSessions > 0 && files.length > maxSessions) {
      const excess = files.slice(0, files.length - maxSessions)
      for (const file of excess) {
        removedRecords += await this.#removeSessionFile(file)
        removedSessions += 1
      }
      files = files.slice(excess.length)
    }

    const maxBytes = this.#settings.maxTotalMegabytes
    if (maxBytes > 0) {
      const limitBytes = maxBytes * 1024 * 1024
      let total = files.reduce((sum, file) => sum + file.size, 0)
        + await this.#fileSize(join(this.#root, UNASSIGNED_FILE))
      for (const file of files) {
        if (total <= limitBytes) break
        if (file.size > limitBytes) {
          warnings.push(`${file.name} alone exceeds the total-size cap; kept`)
          continue
        }
        removedRecords += await this.#removeSessionFile(file)
        removedSessions += 1
        total -= file.size
      }
      if (total > limitBytes) {
        warnings.push(`total size ${total} bytes remains above the ${maxBytes} MB cap`)
      }
    }
    return { compactedSessions, removedSessions, removedRecords, ...(warnings.length === 0 ? {} : { warnings }) }
  }

  /** Live session files on disk, oldest mtime first. */
  async #sessionFiles(): Promise<readonly { key: string; name: string; path: string; mtimeMs: number; size: number }[]> {
    const dir = join(this.#root, SESSIONS_DIR)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (error) {
      if (isAbsent(error)) return []
      throw error
    }
    const files: { key: string; name: string; path: string; mtimeMs: number; size: number }[] = []
    for (const name of names) {
      if (!isSessionFileName(name)) continue
      const path = join(dir, name)
      try {
        const st = await stat(path)
        if (!st.isFile()) continue
        files.push({ key: name.slice(0, -'.jsonl'.length), name, path, mtimeMs: st.mtimeMs, size: st.size })
      } catch (error) {
        if (!isAbsent(error)) this.#noteError(name, error)
      }
    }
    return files.sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name))
  }

  /** Remove one session file and drop its slot state; returns its live count. */
  async #removeSessionFile(file: { key: string; path: string; size: number }): Promise<number> {
    const slot = this.#slots.get(file.key)
    let live = 0
    if (slot !== undefined) {
      try {
        if (await this.#ensureFresh(slot, undefined) === 'ready' && slot.cache !== undefined) {
          live = slot.cache.summaries.size
        }
      } catch (error) {
        this.#noteError(file.key, error)
      }
    } else {
      const folded = await this.#fold({ key: file.key, path: file.path, queue: Promise.resolve(), cache: undefined, foreign: false, foreignWarned: false }, false)
      live = folded.summaries.size
    }
    try {
      await rm(file.path, { force: true })
    } catch (error) {
      if (!isAbsent(error)) {
        this.#noteError(file.key, error)
        return 0
      }
    }
    if (slot !== undefined) {
      slot.cache = undefined
      slot.foreign = false
      slot.foreignWarned = false
    }
    return live
  }

  /** One file's size, or zero when absent/unreadable. */
  async #fileSize(path: string): Promise<number> {
    try {
      const st = await stat(path)
      return st.isFile() ? st.size : 0
    } catch {
      return 0
    }
  }

  /** Every history artifact — live logs and stale/corrupt asides; never settings.json. */
  async #historyArtifacts(dir: string): Promise<readonly string[]> {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (error) {
      if (isAbsent(error)) return []
      throw error
    }
    return names.filter(name =>
      name.endsWith('.jsonl') || /\.jsonl\.(?:stale|corrupt)-/u.test(name))
  }

  /** Delete every persisted record; `settings.json` is not history and survives. */
  async clear(): Promise<ReviewHistoryClearResult> {
    await this.#quiesce()
    let removedSessions = 0
    let removedBytes = 0
    const dir = join(this.#root, SESSIONS_DIR)
    for (const name of await this.#historyArtifacts(dir)) {
      const path = join(dir, name)
      const size = await this.#fileSize(path)
      try {
        await rm(path, { force: true })
        removedBytes += size
        if (isSessionFileName(name)) removedSessions += 1
      } catch (error) {
        this.#noteError(name, error)
      }
    }
    for (const name of await this.#historyArtifacts(this.#root)) {
      const path = join(this.#root, name)
      const size = await this.#fileSize(path)
      try {
        await rm(path, { force: true })
        removedBytes += size
      } catch (error) {
        this.#noteError(name, error)
      }
    }
    for (const slot of this.#slots.values()) {
      slot.cache = undefined
      slot.foreign = false
      slot.foreignWarned = false
    }
    return { removedSessions, removedBytes }
  }

  /** Await the write queues of one session's files, or every file's. */
  async flush(sessionId?: string): Promise<void> {
    if (sessionId !== undefined) {
      await Promise.allSettled([
        this.#slotFor(encodeSessionKey(sessionId)).queue,
        this.#slotFor(UNASSIGNED_KEY).queue,
      ])
      await this.#quiesce()
      return
    }
    await this.#quiesce()
  }

  /** Drain every queue and stop accepting writes. */
  async close(): Promise<void> {
    this.#closed = true
    await this.#quiesce()
  }

  /** Await every slot's queue — the point where all issued writes have landed. */
  async #quiesce(): Promise<void> {
    await Promise.allSettled([...this.#slots.values()].map(slot => slot.queue))
  }
}

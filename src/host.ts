/**
 * The review capture host: the pure core behind the panel service.
 *
 * It owns the three M1 behaviors and nothing else:
 *
 * 1. the `llm/stream` observation — fingerprint, tee, immutable record;
 * 2. the `tools/pre-execute` correlation anchor — AUTO-only in-flight table,
 *    exact name/arguments/mode matching, ambiguity refused;
 * 3. the read-only `PANEL_CHANNEL` endpoint body — `list` and `get`.
 *
 * Keeping the core free of cordis makes every behavior directly testable and,
 * more importantly, keeps the observation seams replaceable: the service row
 * wires real host services into this object, and the tests wire fixtures.
 *
 * @module @dsh-electron/dsh-auto-review-panel/host
 */

import { randomUUID } from 'node:crypto'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import {
  StreamingReviewCapture,
  teeReviewStream,
} from './capture.ts'
import { matchReviewRequest } from './compat/review-fingerprint.ts'
import type {
  PanelClearRequest,
  PanelClearValue,
  PanelListRequest,
  PanelListValue,
  PanelRpcResult,
  PanelStatsValue,
  PanelStatus,
  PanelUpdateSettingsRequest,
  PanelUpdateSettingsValue,
  ReviewActionMode,
  ReviewHistoryRetention,
  ReviewHostOutcome,
  ReviewRecord,
  ReviewRecordSummary,
} from './contract.ts'
import { DEFAULT_RETENTION } from './contract.ts'
import type { ReviewHistory, ReviewHistoryClearResult, ReviewSessionIdentity } from './history/contract.ts'
import {
  compareSummariesDesc,
  formatCursor,
  isOlderThanCursor,
  parseCursor,
} from './history/format.ts'
import { ReviewRecordBuffer, type ReviewRecordBufferOptions } from './records.ts'

/** The `permissionPresets` surface the host actually reads. */
export interface PanelPermissionPresets {
  readonly names: readonly string[]
  current(session: Session): string
}

/** The `sessions` surface the host actually reads. */
export interface PanelSessions {
  get(id: SessionId): Session | undefined
}

/**
 * The `tools/pre-execute` shape the correlation anchor reads. The real
 * `ToolExecution` is structurally compatible; tests can build it without a
 * registry token.
 */
export interface ReviewExecutionLike {
  readonly name: string
  readonly arguments: unknown
  readonly callId: string
  readonly parent?: unknown
  readonly agent?: {
    readonly session: {
      readonly id: string
    }
  }
}

/** Host construction options. */
export interface ReviewCaptureHostOptions {
  readonly permissionPresets: PanelPermissionPresets
  readonly sessions: PanelSessions
  /** The canonical Auto preset identity (`AUTO_PRESET`). */
  readonly autoPreset: string
  /** The reserved `run_code` transport name the reviewer never reviews. */
  readonly runCodeName: string
  /**
   * Enumerate the mounted loader entry names (package specifiers). Optional:
   * the About line shows the reviewer package only when the host can read it.
   */
  readonly listPluginNames?: () => readonly string[]
  /**
   * Enumerate the tool names one session's agent can see. Optional: the tool
   * filter shows registry options only when the host can read the registry.
   */
  readonly listToolNames?: (sessionId: string) => readonly string[]
  /**
   * The persistence seam. Absent means memory-only mode: capture, correlation
   * and the read endpoints behave exactly as before, and `stats` reports
   * `available: false`.
   */
  readonly history?: ReviewHistory
  readonly now?: () => string
  readonly createId?: () => string
  readonly globalCapacity?: number
  readonly sessionCapacity?: number
}

/** Host diagnostics that never enter the panel UI. */
export interface ReviewCaptureDiagnostics {
  /** Streams that started with the policy header but failed the rest. */
  readonly suspectedReviewStreams: number
}

/**
 * One Session event as the `session/event` listener hands it over. The shape
 * is read structurally: the approval pair lives in a plugin-merged
 * `SessionEventMap` member this package does not import.
 */
export interface SessionEventLike {
  readonly type: string
  readonly data: unknown
}

/**
 * The call index key for one session-scoped callId. The NUL separator cannot
 * appear in a JSON-sourced identifier, so no id content can forge a boundary.
 */
function callKey(sessionId: string, callId: string): string {
  return `${sessionId}\0${callId}`
}

/** One exec inside the AUTO-only correlation table. */
interface TrackedExecution {
  readonly name: string
  readonly mode: ReviewActionMode
  readonly argumentsKey: string
  readonly sessionId: string
  readonly callId: string
}

/** Whether one unknown value is a JSON object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Compare lossless-JSON arguments the way the reviewer logged them. */
function jsonKey(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

/** One endpoint failure. */
function failure(code: string, message: string, details: object): PanelRpcResult<never> {
  return { ok: false, error: { code, message, details } }
}

/** Read the optional `list` payload. */
function readListRequest(payload: unknown): PanelListRequest | undefined {
  if (payload === undefined || payload === null) return {}
  if (!isRecord(payload)) return undefined
  const sessionId = payload['sessionId']
  const before = payload['before']
  const limit = payload['limit']
  if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length === 0)) return undefined
  if (before !== undefined && typeof before !== 'string') return undefined
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0)) return undefined
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(before === undefined ? {} : { before }),
    ...(limit === undefined ? {} : { limit }),
  }
}

/** Read the required `get` payload. */
function readGetRequest(payload: unknown): { readonly id: string; readonly sessionId?: string } | undefined {
  if (!isRecord(payload)) return undefined
  const id = payload['id']
  const sessionId = payload['sessionId']
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length === 0)) return undefined
  return { id, ...(sessionId === undefined ? {} : { sessionId }) }
}

/**
 * Read the `update-settings` payload. Every retention axis must be a
 * non-negative integer; `0` means unlimited.
 */
function readRetention(value: unknown): ReviewHistoryRetention | undefined {
  if (!isRecord(value)) return undefined
  const field = (name: string): number | undefined => {
    const axis = value[name]
    return typeof axis === 'number' && Number.isInteger(axis) && axis >= 0 ? axis : undefined
  }
  const maxRecordsPerSession = field('maxRecordsPerSession')
  const maxSessions = field('maxSessions')
  const maxTotalMegabytes = field('maxTotalMegabytes')
  if (maxRecordsPerSession === undefined || maxSessions === undefined || maxTotalMegabytes === undefined) {
    return undefined
  }
  return { maxRecordsPerSession, maxSessions, maxTotalMegabytes }
}

/** Read the `update-settings` request. */
function readUpdateSettingsRequest(payload: unknown): PanelUpdateSettingsRequest | undefined {
  if (!isRecord(payload)) return undefined
  const retention = readRetention(payload['retention'])
  return retention === undefined ? undefined : { retention }
}

/** Read the `clear` payload: `confirm` must be exactly `true`. */
function readClearRequest(payload: unknown): PanelClearRequest | undefined {
  if (!isRecord(payload)) return undefined
  return payload['confirm'] === true ? { confirm: true } : undefined
}

/** The default `list` page size when the request carries no `limit`. */
const DEFAULT_PAGE_LIMIT = 200
/** The largest page one `list` serves regardless of the requested limit. */
const MAX_PAGE_LIMIT = 500

/** Whether two tracked executions are the same reviewed action. */
function sameExecution(left: TrackedExecution, right: TrackedExecution): boolean {
  return left.name === right.name
    && left.mode === right.mode
    && left.argumentsKey === right.argumentsKey
}

/**
 * The M1 host core.
 */
export class ReviewCaptureHost {
  /** The two-ring record store. */
  readonly buffer: ReviewRecordBuffer
  readonly #permissionPresets: PanelPermissionPresets
  readonly #sessions: PanelSessions
  readonly #autoPreset: string
  readonly #runCodeName: string
  readonly #listPluginNames: () => readonly string[]
  readonly #listToolNames: ((sessionId: string) => readonly string[]) | undefined
  readonly #now: () => string
  readonly #createId: () => string
  readonly #inFlight = new Set<TrackedExecution>()
  /**
   * The persistence seam — a fire-and-forget audit log under the history
   * root. `undefined` means memory-only mode; the capture path reads it as
   * absent either way.
   */
  readonly #history: ReviewHistory | undefined
  /**
   * callKey → record id, for Session-event outcome evidence. Bounded by the
   * global ring: an index entry is only useful while its record survives.
   */
  readonly #recordByCall = new Map<string, string>()
  readonly #callIndexBound: number
  /** approval request id → callKey, while an `asked` awaits its `decided`. */
  readonly #approvals = new Map<string, string>()
  /**
   * Outcome evidence awaiting its correlation anchor. The approval pair is
   * appended inside upstream's `ask`, i.e. *before* `next()` resolves and the
   * record correlates — accumulating here instead of requiring the anchor to
   * exist makes evidence order-independent. Entries merge into the record at
   * `correlate()`; keys that never correlate are dropped by the size bound.
   */
  readonly #pendingOutcomes = new Map<string, ReviewHostOutcome>()
  /**
   * Records once seen in an ambiguous match. Ambiguity is permanent for that
   * record: a later exec with the same name/arguments must not claim it after
   * the competing exec happens to finish first. Markers are pruned once their
   * records leave the buffer — only a live record needs the protection, and
   * an unpruned set would grow for the life of the process.
   */
  readonly #ambiguousRecords = new Set<string>()
  #suspectedReviewStreams = 0

  constructor(options: ReviewCaptureHostOptions) {
    this.#permissionPresets = options.permissionPresets
    this.#sessions = options.sessions
    this.#autoPreset = options.autoPreset
    this.#runCodeName = options.runCodeName
    this.#listPluginNames = options.listPluginNames ?? (() => [])
    this.#listToolNames = options.listToolNames
    this.#now = options.now ?? (() => new Date().toISOString())
    // Persisted records outlive one process, so the default id must be
    // unique ACROSS processes — a monotonic counter would collide the moment
    // two lives of the same host each captured a `review-1`.
    this.#createId = options.createId ?? (() => `review-${randomUUID()}`)
    this.#history = options.history
    const bufferOptions: ReviewRecordBufferOptions = {
      ...(options.globalCapacity === undefined ? {} : { globalCapacity: options.globalCapacity }),
      ...(options.sessionCapacity === undefined ? {} : { sessionCapacity: options.sessionCapacity }),
    }
    this.buffer = new ReviewRecordBuffer(bufferOptions)
    this.#callIndexBound = this.buffer.globalCapacity
  }

  /** Host-only diagnostics; never exposed over the panel channel. */
  get diagnostics(): ReviewCaptureDiagnostics {
    return { suspectedReviewStreams: this.#suspectedReviewStreams }
  }

  /**
   * Observe one `llm/stream` call.
   *
   * A fingerprint miss returns the upstream stream untouched. A match wraps it
   * in the tee; if any part of the capture setup fails, the upstream stream is
   * still returned unchanged.
   * @param options - the request the waterfall saw.
   * @param next - resolves the real stream.
   * @returns the consumer's stream.
   */
  stream(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    let match
    try {
      match = matchReviewRequest(options)
    } catch {
      return next()
    }
    if (match.kind === 'none') return next()
    if (match.kind === 'suspected') {
      this.#suspectedReviewStreams += 1
      return next()
    }

    let capture: StreamingReviewCapture
    try {
      const id = this.#createId()
      const capturedAt = this.#now()
      capture = new StreamingReviewCapture({
        provider: options.provider,
        model: options.model,
        requestText: match.requestText,
        sections: match.sections,
      }, id, capturedAt, record => {
        this.buffer.add(record)
        this.#persist(record)
        this.#pruneAmbiguity()
      })
    } catch {
      return next()
    }
    return teeReviewStream(next(), capture)
  }

  /**
   * The correlation anchor.
   *
   * The listener returns the downstream decision unchanged and never throws
   * for its own reasons. It tracks only executions the upstream reviewer would
   * have reviewed: an agent is present, the call is not the outer `run_code`
   * transport, and the session's current preset is Auto. Where in the
   * waterfall it sits is the composition's choice — the host code is
   * identical either way.
   * @param exec - the pending execution.
   * @param next - the rest of the pre-execute waterfall.
   * @returns the downstream decision, verbatim.
   */
  async preExecute(
    exec: ReviewExecutionLike,
    next: () => Promise<PreToolDecision>,
  ): Promise<PreToolDecision> {
    let tracked: TrackedExecution | undefined
    try {
      tracked = this.#beginTracking(exec)
    } catch {
      tracked = undefined
    }

    let decision: PreToolDecision
    try {
      decision = await next()
    } catch (error) {
      if (tracked !== undefined) this.#inFlight.delete(tracked)
      throw error
    }

    try {
      if (tracked !== undefined) this.#associate(tracked, decision)
    } catch {
      // Correlation is best-effort; the call decision is not ours to change.
    } finally {
      if (tracked !== undefined) this.#inFlight.delete(tracked)
    }
    return decision
  }

  /**
   * Dispatch one panel endpoint.
   *
   * The read endpoints merge the in-memory ring with persisted history:
   * memory answers for the live process (and wins every dedupe), the store
   * answers for what survived a restart. `list` is keyset-paginated over the
   * merged newest-first order; `get` falls through to the persisted record
   * only when the id is memory-resident nowhere.
   * @param endpoint - `list`, `get`, `stats`, `update-settings` or `clear`.
   * @param payload - endpoint-owned request object.
   * @returns the carrier-neutral envelope.
   */
  async handle(endpoint: unknown, payload: unknown): Promise<PanelRpcResult<unknown>> {
    if (endpoint === 'list') {
      const request = readListRequest(payload)
      if (request === undefined) {
        return failure('panel/bad-request', 'list expects { sessionId?: string, before?: string, limit?: number }', { endpoint: 'list' })
      }
      const cursor = request.before === undefined ? undefined : parseCursor(request.before)
      if (request.before !== undefined && cursor === undefined) {
        return failure('panel/bad-request', 'list.before expects a "capturedAt|id" cursor', { endpoint: 'list' })
      }
      // A session-less `list` stays memory-only by design: persisted history
      // is restored per session ("仅按会话恢复"), so an unscoped view never
      // fans out across session files.
      const merged = request.sessionId === undefined
        ? this.buffer.summaries(undefined)
        : await this.#mergedSummaries(request.sessionId)
      const filtered = cursor === undefined ? merged : merged.filter(entry => isOlderThanCursor(entry, cursor))
      const limit = Math.min(request.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT)
      const page = filtered.slice(0, limit)
      const last = page[page.length - 1]
      const value: PanelListValue = {
        records: page,
        status: this.#status(request.sessionId),
        page: {
          hasMore: filtered.length > page.length,
          ...(last === undefined ? {} : { before: formatCursor(last) }),
        },
      }
      return { ok: true, value }
    }
    if (endpoint === 'get') {
      const request = readGetRequest(payload)
      if (request === undefined) {
        return failure('panel/bad-request', 'get expects { id: string, sessionId?: string }', { endpoint: 'get' })
      }
      const record = this.buffer.get(request.id) ?? await this.#persistedGet(request.sessionId, request.id)
      if (record === undefined) {
        return failure('review-record-not-found', `No review record with id "${request.id}"`, { id: request.id })
      }
      return { ok: true, value: record }
    }
    if (endpoint === 'stats') {
      return { ok: true, value: await this.#safeStats() }
    }
    if (endpoint === 'update-settings') {
      const request = readUpdateSettingsRequest(payload)
      if (request === undefined) {
        return failure('panel/bad-request', 'update-settings expects { retention: { maxRecordsPerSession, maxSessions, maxTotalMegabytes } }', { endpoint: 'update-settings' })
      }
      if (this.#history === undefined) {
        return failure('panel/persistence-unavailable', 'history persistence is unavailable', { endpoint: 'update-settings' })
      }
      try {
        const value: PanelUpdateSettingsValue = await this.#history.updateSettings(request.retention)
        return { ok: true, value }
      } catch {
        return failure('panel/persistence-unavailable', 'history persistence is unavailable', { endpoint: 'update-settings' })
      }
    }
    if (endpoint === 'clear') {
      const request = readClearRequest(payload)
      if (request === undefined) {
        return failure('panel/bad-request', 'clear expects { confirm: true }', { endpoint: 'clear' })
      }
      if (this.#history === undefined) {
        return failure('panel/persistence-unavailable', 'history persistence is unavailable', { endpoint: 'clear' })
      }
      try {
        const cleared = await this.clearHistory()
        const value: PanelClearValue = { ...cleared, stats: await this.#safeStats() }
        return { ok: true, value }
      } catch {
        return failure('panel/persistence-unavailable', 'history persistence is unavailable', { endpoint: 'clear' })
      }
    }
    return failure('panel/unknown-endpoint', `Unknown panel endpoint: ${String(endpoint)}`, {
      endpoint: typeof endpoint === 'string' ? endpoint : null,
    })
  }

  /**
   * Persist one record's current truth.
   *
   * The store contract already swallows its failures; the try/catch here is
   * only a belt so a misbehaving foreign implementation cannot reach the
   * capture path either. Uncorrelated records carry no live identity to
   * check — only a correlated write passes one.
   */
  #persist(record: ReviewRecord): void {
    try {
      const identity = record.correlation === undefined
        ? undefined
        : this.#identityFor(record.correlation.sessionId)
      this.#history?.upsert(record, identity)
    } catch {
      // Persistence is a bypass: nothing it does may touch capture.
    }
  }

  /** The live session's header triple for lifecycle validation, when readable. */
  #identityFor(sessionId: string): ReviewSessionIdentity | undefined {
    try {
      const header = this.#sessions.get(sessionId as SessionId)?.header
      if (header === undefined) return undefined
      return {
        createdAt: header.createdAt,
        isSeeded: header.isSeeded,
        ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
      }
    } catch {
      return undefined
    }
  }

  /**
   * Memory + persisted summaries for one `list` call, merged newest-first.
   * Memory answers first and wins every id dedupe — its records are the live
   * ones. `before`/`limit` then page the merged order.
   */
  async #mergedSummaries(sessionId: string): Promise<readonly ReviewRecordSummary[]> {
    const memory = this.buffer.summaries(sessionId)
    const history = this.#history
    if (history === undefined) return memory
    let persisted: readonly ReviewRecordSummary[]
    try {
      persisted = await history.summaries(sessionId, this.#identityFor(sessionId))
    } catch {
      return memory
    }
    if (persisted.length === 0) return memory
    const seen = new Set(memory.map(summary => summary.id))
    const merged = [...memory]
    for (const summary of persisted) {
      if (!seen.has(summary.id)) {
        seen.add(summary.id)
        merged.push(summary)
      }
    }
    return merged.sort(compareSummariesDesc)
  }

  /** The persisted copy of one id, or `undefined`. */
  async #persistedGet(sessionId: string | undefined, id: string): Promise<ReviewRecord | undefined> {
    const history = this.#history
    if (history === undefined) return undefined
    try {
      return await history.get(sessionId, id, sessionId === undefined ? undefined : this.#identityFor(sessionId))
    } catch {
      return undefined
    }
  }

  /**
   * Wipe history completely: the persisted logs AND the in-memory rings plus
   * every index that could repoint into them. The `clear` endpoint calls
   * this — removing only the files would let the next `list` resurrect the
   * records the user just asked to delete.
   * @returns what the store removed.
   */
  async clearHistory(): Promise<ReviewHistoryClearResult> {
    this.buffer.clear()
    this.#recordByCall.clear()
    this.#approvals.clear()
    this.#pendingOutcomes.clear()
    this.#ambiguousRecords.clear()
    this.#inFlight.clear()
    if (this.#history === undefined) {
      return { removedSessions: 0, removedBytes: 0 }
    }
    return this.#history.clear()
  }

  /** Drain one session's write queues — the `session/flush` barrier's body. */
  async flushPersistence(sessionId: string): Promise<void> {
    await this.#history?.flush(sessionId)
  }

  /** Drain every write queue; called at service disposal. */
  async closePersistence(): Promise<void> {
    await this.#history?.close()
  }

  /** `stats` never fails: an absent or throwing store reports memory-only. */
  async #safeStats(): Promise<PanelStatsValue> {
    const history = this.#history
    if (history === undefined) {
      return { available: false, settings: DEFAULT_RETENTION, sessions: 0, bytes: 0 }
    }
    try {
      return await history.stats()
    } catch {
      return { available: false, settings: DEFAULT_RETENTION, sessions: 0, bytes: 0 }
    }
  }

  /** Build the `list` status block. */
  #status(sessionId: string | undefined): PanelStatus {
    const reviewerAvailable = this.#reviewerAvailable()
    const sessionPreset = sessionId === undefined ? undefined : this.#sessionPreset(sessionId)
    const reviewerPackage = this.#reviewerPackage()
    const tools = this.#toolNames(sessionId)
    return {
      reviewerAvailable,
      ...(sessionPreset === undefined ? {} : { sessionPreset }),
      ...(reviewerPackage === undefined ? {} : { reviewerPackage }),
      ...(tools === undefined ? {} : { tools }),
    }
  }

  /**
   * The tool names the session's agent can see, read from the live registry.
   * The reserved `run_code` transport is excluded: the reviewer skips it, so
   * an option for it could never match a record.
   */
  #toolNames(sessionId: string | undefined): readonly string[] | undefined {
    if (sessionId === undefined || this.#listToolNames === undefined) return undefined
    try {
      const names = new Set<string>()
      for (const name of this.#listToolNames(sessionId)) {
        if (name.length > 0 && name !== this.#runCodeName) names.add(name)
      }
      return [...names].sort((left, right) => left.localeCompare(right))
    } catch {
      return undefined
    }
  }

  /**
   * The mounted reviewer bundle's loader entry name: the first entry whose
   * name names an auto-review bundle. Absent when the loader surface cannot
   * be read or nothing matches — the client then shows no package line.
   */
  #reviewerPackage(): string | undefined {
    try {
      return this.#listPluginNames().find(name =>
        name.includes('auto-review') && !name.includes('auto-review-panel'))
    } catch {
      return undefined
    }
  }

  /**
   * Whether the Auto preset is currently advertised.
   *
   * An unreadable catalog is NOT treated as "bundle absent": the requirement
   * maps an undecidable catalog onto the "no records yet" empty state, so the
   * conservative answer here is true.
   */
  #reviewerAvailable(): boolean {
    try {
      return this.#permissionPresets.names.includes(this.#autoPreset)
    } catch {
      return true
    }
  }

  /** The session's current preset, absent when unknown or unreadable. */
  #sessionPreset(sessionId: string): string | undefined {
    try {
      const session = this.#sessions.get(sessionId as SessionId)
      if (session === undefined) return undefined
      return this.#permissionPresets.current(session)
    } catch {
      return undefined
    }
  }

  /** Add one reviewed execution to the in-flight table. */
  #beginTracking(exec: ReviewExecutionLike): TrackedExecution | undefined {
    const agent = exec.agent
    if (agent === undefined) return undefined
    if (exec.parent === undefined && exec.name === this.#runCodeName) return undefined

    let preset: string
    try {
      preset = this.#permissionPresets.current(agent.session as unknown as Session)
    } catch {
      return undefined
    }
    if (preset !== this.#autoPreset) return undefined

    const argumentsKey = jsonKey(exec.arguments)
    if (argumentsKey === undefined) return undefined
    const tracked: TrackedExecution = {
      name: exec.name,
      mode: exec.parent === undefined ? 'native' : 'ptc-inner',
      argumentsKey,
      sessionId: agent.session.id,
      callId: exec.callId,
    }
    this.#inFlight.add(tracked)
    return tracked
  }

  /**
   * Attach the anchor when exactly one record and exactly one in-flight exec
   * agree. Any ambiguity leaves the record uncorrelated.
   */
  #associate(tracked: TrackedExecution, decision: PreToolDecision): void {
    const pending = this.buffer.all().filter(record =>
      record.correlation === undefined
      && !this.#ambiguousRecords.has(record.id)
      && this.#matches(record, tracked))
    let peers = 0
    for (const other of this.#inFlight) {
      if (sameExecution(other, tracked)) peers += 1
    }
    if (pending.length !== 1 || peers !== 1) {
      // Remember the ambiguity itself: if the competing exec settles later,
      // it must not be allowed to claim one of these records by elimination.
      for (const record of pending) this.#ambiguousRecords.add(record.id)
      return
    }
    const [record] = pending
    if (record === undefined) return
    const correlated = this.buffer.correlate(record.id, {
      sessionId: tracked.sessionId,
      callId: tracked.callId,
      downstreamDecision: decision.kind,
      ...(decision.kind === 'deny' && decision.info !== undefined
        ? { denialInfo: {
            name: decision.info.name, code: decision.info.code,
            ...(typeof decision.info.reason === 'string' ? { reason: decision.info.reason } : {}),
          } }
        : {}),
    })
    if (correlated !== undefined) {
      while (this.#recordByCall.size >= this.#callIndexBound) {
        const oldest = this.#recordByCall.keys().next().value
        if (oldest === undefined) break
        this.#recordByCall.delete(oldest)
      }
      this.#recordByCall.set(callKey(tracked.sessionId, tracked.callId), correlated.id)
      // The approval pair is appended *before* `next()` resolves — evidence
      // collected under this callKey merges into the fresh anchor.
      const pending = this.#pendingOutcomes.get(callKey(tracked.sessionId, tracked.callId))
      const record = pending === undefined
        ? correlated
        : this.buffer.attachHostOutcome(correlated.id, pending) ?? correlated
      if (pending !== undefined) {
        this.#pendingOutcomes.delete(callKey(tracked.sessionId, tracked.callId))
      }
      this.#persist(record)
    }
  }

  /**
   * Observe one `session/event` dispatch for host-disposition evidence.
   *
   * Three Session events carry the outcome the reviewer decision does not:
   * `tool/result` logs the call's durable result (a reviewer denial arrives
   * as `AutoReviewDeniedError`/`AUTO_REVIEW_DENIED`), and the
   * `approval/asked` + `approval/decided` pair logs the human approval an
   * upstream `ask` routed through. Evidence reaches a record only through the
   * correlation anchor's callId — collected early, merged at `correlate()` —
   * and an event matching no call is ignored, never synthesized.
   *
   * This observer never throws: a malformed event or a lost race drops one
   * evidence field at worst.
   * @param sessionId - the session the event was appended to.
   * @param event - the logged event, read structurally.
   */
  observeSessionEvent(sessionId: string, event: SessionEventLike): void {
    try {
      if (event.type === 'tool/result') this.#observeToolResult(sessionId, event.data)
      else if (event.type === 'approval/asked') this.#observeApprovalAsked(sessionId, event.data)
      else if (event.type === 'approval/decided') this.#observeApprovalDecided(event.data)
    } catch {
      // Evidence is best-effort; a malformed event drops itself.
    }
  }

  /**
   * Drop ambiguity markers whose records no longer live in the buffer. A
   * marker only has to outlive its record, and the global ring is the only
   * path that can evict an uncorrelated record — so pruning on every add
   * keeps the set bounded by the records it protects.
   */
  #pruneAmbiguity(): void {
    if (this.#ambiguousRecords.size === 0) return
    const live = new Set<string>()
    for (const record of this.buffer.all()) live.add(record.id)
    for (const id of this.#ambiguousRecords) {
      if (!live.has(id)) this.#ambiguousRecords.delete(id)
    }
  }

  /**
   * Merge evidence into the record pinned to one call; when no record is
   * pinned yet (the approval pair arrives before correlation), accumulate
   * the evidence for `correlate()` to merge. A callKey that is never
   * correlated keeps its evidence pending until the bound drops it — it can
   * never land on an uncorrelated record, which is exactly the contract.
   */
  #patchOutcome(key: string, patch: (outcome: ReviewHostOutcome) => ReviewHostOutcome): void {
    const id = this.#recordByCall.get(key)
    if (id === undefined) {
      if (this.#pendingOutcomes.size >= this.#callIndexBound) this.#pendingOutcomes.delete(this.#pendingOutcomes.keys().next().value!)
      this.#pendingOutcomes.set(key, patch(this.#pendingOutcomes.get(key) ?? {}))
      return
    }
    const record = this.buffer.get(id)
    if (record === undefined) {
      this.#recordByCall.delete(key)
      return
    }
    const updated = this.buffer.attachHostOutcome(id, patch(record.hostOutcome ?? {}))
    if (updated !== undefined) this.#persist(updated)
  }

  /** The `tool/result` event carries the durable outcome of one call. */
  #observeToolResult(sessionId: string, data: unknown): void {
    if (!isRecord(data)) return
    const message = data['message']
    if (!isRecord(message)) return
    const callId = message['toolCallId']
    if (typeof callId !== 'string') return
    const error = isRecord(data['error']) ? data['error'] : undefined
    this.#patchOutcome(callKey(sessionId, callId), outcome => ({
      ...outcome,
      toolResult: {
        isError: message['isError'] === true,
        ...(error === undefined ? {} : {
          ...(typeof error['name'] === 'string' ? { name: error['name'] } : {}),
          ...(typeof error['code'] === 'string' ? { code: error['code'] } : {}),
          ...(typeof error['reason'] === 'string' ? { reason: error['reason'] } : {}),
        }),
      },
    }))
  }

  /** `approval/asked` opens the human-approval audit for one call. */
  #observeApprovalAsked(sessionId: string, data: unknown): void {
    if (!isRecord(data)) return
    const id = data['id']
    const callId = data['callId']
    if (typeof id !== 'string' || typeof callId !== 'string') return
    const key = callKey(sessionId, callId)
    if (this.#approvals.size >= this.#callIndexBound) this.#approvals.delete(this.#approvals.keys().next().value!)
    this.#approvals.set(id, key)
    this.#patchOutcome(key, outcome => ({ ...outcome, approval: outcome.approval ?? {} }))
  }

  /** `approval/decided` closes the audit pair opened by `asked`. */
  #observeApprovalDecided(data: unknown): void {
    if (!isRecord(data)) return
    const id = data['id']
    const outcome = data['outcome']
    if (typeof id !== 'string' || typeof outcome !== 'string') return
    const key = this.#approvals.get(id)
    if (key === undefined) return
    this.#approvals.delete(id)
    this.#patchOutcome(key, current => ({
      ...current,
      approval: { ...current.approval, outcome },
    }))
  }

  /** Whether one captured PENDING_ACTION is this exact execution. */
  #matches(record: ReviewRecord, tracked: TrackedExecution): boolean {
    const action = record.sections.pendingAction
    return action.name === tracked.name
      && action.mode === tracked.mode
      && jsonKey(action.arguments) === tracked.argumentsKey
  }
}

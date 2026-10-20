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

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import {
  StreamingReviewCapture,
  teeReviewStream,
} from './capture.ts'
import { matchReviewRequest } from './compat/review-fingerprint.ts'
import type {
  PanelListRequest,
  PanelListValue,
  PanelRpcResult,
  PanelStatus,
  ReviewActionMode,
  ReviewHostOutcome,
  ReviewRecord,
} from './contract.ts'
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
  if (sessionId === undefined) return {}
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  return { sessionId }
}

/** Read the required `get` payload. */
function readGetRequest(payload: unknown): { readonly id: string } | undefined {
  if (!isRecord(payload)) return undefined
  const id = payload['id']
  return typeof id === 'string' && id.length > 0 ? { id } : undefined
}

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
  readonly #now: () => string
  readonly #createId: () => string
  readonly #inFlight = new Set<TrackedExecution>()
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
  #recordCounter = 0

  constructor(options: ReviewCaptureHostOptions) {
    this.#permissionPresets = options.permissionPresets
    this.#sessions = options.sessions
    this.#autoPreset = options.autoPreset
    this.#runCodeName = options.runCodeName
    this.#listPluginNames = options.listPluginNames ?? (() => [])
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#createId = options.createId ?? (() => `review-${++this.#recordCounter}`)
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
   * @param endpoint - `list` or `get`.
   * @param payload - endpoint-owned request object.
   * @returns the carrier-neutral envelope.
   */
  handle(endpoint: unknown, payload: unknown): PanelRpcResult<unknown> {
    if (endpoint === 'list') {
      const request = readListRequest(payload)
      if (request === undefined) {
        return failure('panel/bad-request', 'list expects { sessionId?: string }', { endpoint: 'list' })
      }
      const value: PanelListValue = {
        records: this.buffer.summaries(request.sessionId),
        status: this.#status(request.sessionId),
      }
      return { ok: true, value }
    }
    if (endpoint === 'get') {
      const request = readGetRequest(payload)
      if (request === undefined) {
        return failure('panel/bad-request', 'get expects { id: string }', { endpoint: 'get' })
      }
      const record = this.buffer.get(request.id)
      if (record === undefined) {
        return failure('review-record-not-found', `No review record with id "${request.id}"`, { id: request.id })
      }
      return { ok: true, value: record }
    }
    return failure('panel/unknown-endpoint', `Unknown panel endpoint: ${String(endpoint)}`, {
      endpoint: typeof endpoint === 'string' ? endpoint : null,
    })
  }

  /** Build the `list` status block. */
  #status(sessionId: string | undefined): PanelStatus {
    const reviewerAvailable = this.#reviewerAvailable()
    const sessionPreset = sessionId === undefined ? undefined : this.#sessionPreset(sessionId)
    const reviewerPackage = this.#reviewerPackage()
    return {
      reviewerAvailable,
      ...(sessionPreset === undefined ? {} : { sessionPreset }),
      ...(reviewerPackage === undefined ? {} : { reviewerPackage }),
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
      if (pending !== undefined) {
        this.#pendingOutcomes.delete(callKey(tracked.sessionId, tracked.callId))
        this.buffer.attachHostOutcome(correlated.id, pending)
      }
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
    this.buffer.attachHostOutcome(id, patch(record.hostOutcome ?? {}))
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

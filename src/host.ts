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
  DownstreamDecision,
  PanelListRequest,
  PanelListValue,
  PanelRpcResult,
  PanelStatus,
  ReviewActionMode,
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
  readonly #now: () => string
  readonly #createId: () => string
  readonly #inFlight = new Set<TrackedExecution>()
  /**
   * Records once seen in an ambiguous match. Ambiguity is permanent for that
   * record: a later exec with the same name/arguments must not claim it after
   * the competing exec happens to finish first.
   */
  readonly #ambiguousRecords = new Set<string>()
  #suspectedReviewStreams = 0
  #recordCounter = 0

  constructor(options: ReviewCaptureHostOptions) {
    this.#permissionPresets = options.permissionPresets
    this.#sessions = options.sessions
    this.#autoPreset = options.autoPreset
    this.#runCodeName = options.runCodeName
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#createId = options.createId ?? (() => `review-${++this.#recordCounter}`)
    const bufferOptions: ReviewRecordBufferOptions = {
      ...(options.globalCapacity === undefined ? {} : { globalCapacity: options.globalCapacity }),
      ...(options.sessionCapacity === undefined ? {} : { sessionCapacity: options.sessionCapacity }),
    }
    this.buffer = new ReviewRecordBuffer(bufferOptions)
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
      })
    } catch {
      return next()
    }
    return teeReviewStream(next(), capture)
  }

  /**
   * The append-side correlation anchor.
   *
   * The listener returns the downstream decision unchanged and never throws
   * for its own reasons. It tracks only executions the upstream reviewer would
   * have reviewed: an agent is present, the call is not the outer `run_code`
   * transport, and the session's current preset is Auto.
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
      if (tracked !== undefined) this.#associate(tracked, decision.kind)
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
    return {
      reviewerAvailable,
      ...(sessionPreset === undefined ? {} : { sessionPreset }),
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
  #associate(tracked: TrackedExecution, downstreamDecision: DownstreamDecision): void {
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
    this.buffer.correlate(record.id, {
      sessionId: tracked.sessionId,
      callId: tracked.callId,
      downstreamDecision,
    })
  }

  /** Whether one captured PENDING_ACTION is this exact execution. */
  #matches(record: ReviewRecord, tracked: TrackedExecution): boolean {
    const action = record.sections.pendingAction
    return action.name === tracked.name
      && action.mode === tracked.mode
      && jsonKey(action.arguments) === tracked.argumentsKey
  }
}

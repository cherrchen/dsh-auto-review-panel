/**
 * The panel's client for `PANEL_CHANNEL`.
 *
 * Same seam as the multi-root panel: the host registers
 * `connection.rpc.handle(PANEL_CHANNEL, …)` and this module calls it. The
 * envelope is parsed at the boundary — a transport failure and a host that
 * answers a different shape both become a `PanelError` the view maps onto
 * the channel-missing empty state.
 *
 * M4 splits the face in two: the session panel needs only `PanelListApi`
 * (`list`/`get`); the plugin-manager settings page gets `PanelSettingsApi`
 * (`stats`/`updateSettings`/`clear`). `PanelApi` is both.
 *
 * @module @dsh-electron/dsh-auto-review-panel/client/panel-client
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import {
  PANEL_CHANNEL,
  type PanelClearValue,
  type PanelListRequest,
  type PanelListValue,
  type PanelRpcResult,
  type PanelStatsValue,
  type PanelUpdateSettingsValue,
  type ReviewHistoryRetention,
  type ReviewRecord,
} from '../contract.ts'

/** The Connection result shape this plugin consumes. */
type ChannelResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown }

/** A failure the panel renders as an empty state or an inline notice. */
export class PanelError extends Error {
  /**
   * @param code - `unavailable` for transport/absent-channel failures, or the
   *   host's own failure code.
   * @param message - the host's fallback text.
   */
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'PanelError'
  }
}

/** Whether one unknown value is a JSON object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Read the host's `{code, message}` failure, or re-wrap it. */
function failureOf(error: unknown): PanelError {
  if (isRecord(error) && typeof error['code'] === 'string' && typeof error['message'] === 'string') {
    return new PanelError(error['code'], error['message'])
  }
  return new PanelError('unavailable', 'the host answered with an unreadable failure')
}

/** Whether one value is a valid `ReviewHistoryRetention` triple. */
function isRetention(value: unknown): value is ReviewHistoryRetention {
  const axis = (name: string): boolean =>
    typeof (value as Record<string, unknown>)[name] === 'number'
    && Number.isInteger((value as Record<string, unknown>)[name])
    && ((value as Record<string, unknown>)[name] as number) >= 0
  return isRecord(value)
    && axis('maxRecordsPerSession')
    && axis('maxSessions')
    && axis('maxTotalMegabytes')
}

/** Boundary check for `list`'s value, pagination block included. */
function isListValue(value: unknown): value is PanelListValue {
  return isRecord(value)
    && Array.isArray(value['records'])
    && isRecord(value['status'])
    && typeof value['status']['reviewerAvailable'] === 'boolean'
    && isRecord(value['page'])
    && typeof value['page']['hasMore'] === 'boolean'
}

/** Boundary check for `get`'s value. */
function isReviewRecord(value: unknown): value is ReviewRecord {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['requestText'] === 'string'
    && isRecord(value['sections'])
    && isRecord(value['output'])
}

/** Boundary check for `stats`' value. */
function isStatsValue(value: unknown): value is PanelStatsValue {
  return isRecord(value)
    && typeof value['available'] === 'boolean'
    && isRetention(value['settings'])
    && typeof value['sessions'] === 'number'
    && typeof value['bytes'] === 'number'
}

/** Boundary check for `update-settings`' value. */
function isUpdateSettingsValue(value: unknown): value is PanelUpdateSettingsValue {
  return isRecord(value)
    && isStatsValue(value['stats'])
    && isRecord(value['maintenance'])
    && typeof value['maintenance']['compactedSessions'] === 'number'
    && typeof value['maintenance']['removedSessions'] === 'number'
    && typeof value['maintenance']['removedRecords'] === 'number'
}

/** Boundary check for `clear`'s value. */
function isClearValue(value: unknown): value is PanelClearValue {
  return isRecord(value)
    && typeof value['removedSessions'] === 'number'
    && typeof value['removedBytes'] === 'number'
    && isStatsValue(value['stats'])
}

/** The `list` call's optional paging arguments. */
export interface PanelListOptions {
  /** Return only entries strictly older than this cursor. */
  readonly before?: string
  /** Maximum rows the page carries. */
  readonly limit?: number
}

/**
 * The list half of the channel face: what the session-bound panel consumes.
 * `list` returns one page; `get` returns `undefined` for a record the host
 * no longer holds anywhere.
 */
export interface PanelListApi {
  list(sessionId: string, options?: PanelListOptions, signal?: AbortSignal): Promise<PanelListValue>
  get(id: string, sessionId?: string, signal?: AbortSignal): Promise<ReviewRecord | undefined>
}

/**
 * The settings half of the channel face: what the row's configuration page
 * consumes — health, retention write, and the full-history wipe.
 */
export interface PanelSettingsApi {
  stats(signal?: AbortSignal): Promise<PanelStatsValue>
  updateSettings(retention: ReviewHistoryRetention, signal?: AbortSignal): Promise<PanelUpdateSettingsValue>
  clear(signal?: AbortSignal): Promise<PanelClearValue>
}

/** The whole channel face — both halves. */
export interface PanelApi extends PanelListApi, PanelSettingsApi {}

/**
 * Build the panel API over a Connection handle.
 * @param connection - the client Connection service.
 * @returns the endpoint caller, every failure normalized to `PanelError`.
 */
export function createPanelApi(connection: ConnectionHandle): PanelApi {
  const call = async (endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> => {
    let result: ChannelResult
    try {
      result = await connection.rpc.call(PANEL_CHANNEL, endpoint, payload, signal) as PanelRpcResult<unknown>
    } catch (error: unknown) {
      throw new PanelError('unavailable', error instanceof Error ? error.message : String(error))
    }
    if (!result.ok) throw failureOf(result.error)
    return result.value
  }
  return {
    async list(sessionId, options, signal) {
      const payload: PanelListRequest = {
        sessionId,
        ...(options?.before === undefined ? {} : { before: options.before }),
        ...(options?.limit === undefined ? {} : { limit: options.limit }),
      }
      const value = await call('list', payload, signal)
      if (!isListValue(value)) throw new PanelError('panel/bad-response', 'list answered a different shape')
      return value
    },
    async get(id, sessionId, signal) {
      try {
        const value = await call('get', { id, ...(sessionId === undefined ? {} : { sessionId }) }, signal)
        if (isReviewRecord(value)) return value
        throw new PanelError('panel/bad-response', 'get answered a different shape')
      } catch (error) {
        if (error instanceof PanelError && error.code === 'review-record-not-found') return undefined
        throw error
      }
    },
    async stats(signal) {
      const value = await call('stats', {}, signal)
      if (!isStatsValue(value)) throw new PanelError('panel/bad-response', 'stats answered a different shape')
      return value
    },
    async updateSettings(retention, signal) {
      const value = await call('update-settings', { retention }, signal)
      if (!isUpdateSettingsValue(value)) {
        throw new PanelError('panel/bad-response', 'update-settings answered a different shape')
      }
      return value
    },
    async clear(signal) {
      const value = await call('clear', { confirm: true }, signal)
      if (!isClearValue(value)) throw new PanelError('panel/bad-response', 'clear answered a different shape')
      return value
    },
  }
}

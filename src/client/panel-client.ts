/**
 * The panel's client for `PANEL_CHANNEL`.
 *
 * Same seam as the multi-root panel: the host registers
 * `connection.rpc.handle(PANEL_CHANNEL, …)` and this module calls it. The
 * envelope is parsed at the boundary — a transport failure and a host that
 * answers a different shape both become a `PanelError` the view maps onto
 * the channel-missing empty state.
 *
 * @module @dsh-electron/dsh-auto-review-panel/client/panel-client
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import {
  PANEL_CHANNEL,
  type PanelListRequest,
  type PanelListValue,
  type PanelRpcResult,
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

/** Boundary check for `list`'s value. */
function isListValue(value: unknown): value is PanelListValue {
  return isRecord(value)
    && Array.isArray(value['records'])
    && isRecord(value['status'])
    && typeof value['status']['reviewerAvailable'] === 'boolean'
}

/** Boundary check for `get`'s value. */
function isReviewRecord(value: unknown): value is ReviewRecord {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['requestText'] === 'string'
    && isRecord(value['sections'])
    && isRecord(value['output'])
}

/**
 * The callable face the inject factory hands to the view: `list` returns
 * `undefined` where no channel could be mounted (no Connection service), and
 * `get` returns `undefined` for an evicted record.
 */
export interface PanelApi {
  list(sessionId: string, signal?: AbortSignal): Promise<PanelListValue>
  get(id: string, signal?: AbortSignal): Promise<ReviewRecord | undefined>
}

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
    async list(sessionId, signal) {
      const payload: PanelListRequest = { sessionId }
      const value = await call('list', payload, signal)
      if (!isListValue(value)) throw new PanelError('panel/bad-response', 'list answered a different shape')
      return value
    },
    async get(id, signal) {
      try {
        const value = await call('get', { id }, signal)
        if (isReviewRecord(value)) return value
        throw new PanelError('panel/bad-response', 'get answered a different shape')
      } catch (error) {
        if (error instanceof PanelError && error.code === 'review-record-not-found') return undefined
        throw error
      }
    },
  }
}

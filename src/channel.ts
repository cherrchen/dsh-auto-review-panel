/**
 * The panel's Connection channel.
 *
 * The channel is a soft seam: a headless composition has no `connection` or
 * `webServer`, so the `ctx.inject` callback never runs and capture keeps
 * working with no panel — absence is not an error. The service is read from
 * `ctx.root` for the same reason the multi-root panel does it: `rpc.handle`
 * resolves `webServer` as a property of the context the service was read
 * from, and a sibling row's service is not visible from this plugin's fiber.
 *
 * @module @dsh-electron/dsh-auto-review-panel/channel
 */

import type { Context } from '@deepseek-ai/cordis'
import { PANEL_CHANNEL, type PanelRpcResult } from './contract.ts'
import type { ReviewCaptureHost } from './host.ts'

/** The host Connection surface this channel actually uses. */
export interface PanelConnection {
  readonly rpc: {
    handle(
      channel: string,
      handler: (endpoint: string, payload: unknown) => Promise<PanelRpcResult<unknown>>,
    ): () => Promise<void>
  }
}

/**
 * Mount `PANEL_CHANNEL` when this composition has both a Connection and its
 * web carrier. The returned disposer is owned by the injected fiber.
 * @param ctx - the panel service's context.
 * @param host - the endpoint body.
 */
export function mountPanelChannel(ctx: Context, host: ReviewCaptureHost): void {
  ctx.inject(['connection', 'webServer'], connectionCtx => {
    const connection = connectionCtx.root.get('connection') as unknown as PanelConnection | undefined
    const rpc = connection === undefined || connection === null
      ? undefined
      : (connection as { rpc?: { handle?: unknown } }).rpc
    if (rpc === undefined || typeof rpc.handle !== 'function') {
      try {
        ctx.logger.warn('auto review panel: connection resolved without rpc.handle; PANEL_CHANNEL is not mounted')
      } catch {
        // Logging must not be the reason a headless composition fails to boot.
      }
      return
    }
    const target = connection as PanelConnection
    const dispose = target.rpc.handle(PANEL_CHANNEL, async (endpoint, payload) =>
      host.handle(endpoint, payload))
    return () => {
      void dispose()
    }
  })
}

/**
 * The panel's Connection channel.
 *
 * The channel is a soft seam: a headless composition has no `connection` or
 * `webServer`, so the `ctx.inject` callback never runs and capture keeps
 * working with no panel — absence is not an error. Which physical route
 * carries `PANEL_CHANNEL` is the host's business; the seam discovery itself
 * lives in `src/compat/panel-channel.ts` because it probes upstream shape
 * (ADR-0001 keeps version-coupled code there).
 *
 * @module @dsh-electron/dsh-auto-review-panel/channel
 */

import type { Context } from '@deepseek-ai/cordis'
import { mountPanelChannelSeam, type PanelChannelMount } from './compat/panel-channel.ts'
import { PANEL_CHANNEL } from './contract.ts'
import type { ReviewCaptureHost } from './host.ts'

/**
 * Mount `PANEL_CHANNEL` when this composition has both a Connection and its
 * web carrier. The returned disposer is owned by the injected fiber.
 * @param ctx - the panel service's context.
 * @param host - the endpoint body.
 */
export function mountPanelChannel(ctx: Context, host: ReviewCaptureHost): void {
  ctx.inject(['connection', 'webServer'], connectionCtx => {
    let mount: PanelChannelMount | undefined
    try {
      mount = mountPanelChannelSeam(
        connectionCtx.get('connection'),
        connectionCtx.get('webServer'),
        PANEL_CHANNEL,
        (endpoint, payload) => host.handle(endpoint, payload),
      )
    } catch {
      // A host whose route registry refuses the registration is a soft
      // failure: the panel reports the channel-missing state, boot continues.
      mount = undefined
    }
    if (mount === undefined) {
      try {
        ctx.logger.warn('auto review panel: no Connection channel seam accepted PANEL_CHANNEL; the panel reports a missing channel')
      } catch {
        // Logging must not be the reason a headless composition fails to boot.
      }
      return
    }
    return () => {
      void mount.dispose()
    }
  })
}

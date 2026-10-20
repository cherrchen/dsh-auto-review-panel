/**
 * `auto-review-panel`: the panel's host half.
 *
 * The review surface's host-side owner. It injects `autoReviewPanelCompat`,
 * so on a refused installation the row simply does not start and the bundle
 * degrades to "plugin not installed".
 *
 * Today the row provides only the `autoReviewPanel` service key — the review
 * channel and the surface's host endpoints land with the panel feature.
 *
 * @module @dsh-electron/dsh-auto-review-panel/panel
 */

import { Service } from '@deepseek-ai/cordis'
import type {} from './compat.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    autoReviewPanel: AutoReviewPanelService
  }
}

/**
 * The `ctx.autoReviewPanel` service: the host-side owner of the review
 * surface. The compatibility verdict is exposed read-only so the panel's
 * endpoints can always say which release they are running against.
 */
export default class AutoReviewPanelService extends Service {
  static inject = ['autoReviewPanelCompat']

  /** The single DSH release this composition started under. */
  get release(): string | undefined {
    return this.ctx.autoReviewPanelCompat.release
  }
}

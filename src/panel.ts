/**
 * `auto-review-panel`: the panel's host half.
 *
 * The review surface's host-side owner. It injects `autoReviewPanelCompat`,
 * so on a refused installation the row simply does not start and the bundle
 * degrades to "plugin not installed".
 *
 * `llm` and `tools` are deliberately absent from `inject`: this row only
 * subscribes to their event names. `llm` is an optional peer, and putting it
 * in `inject` would turn a legal headless composition (no LLM mounted) into a
 * silently missing panel row. With neither service present the listeners
 * never fire, which is exactly the "no review data" state the panel reports.
 *
 * @module @dsh-electron/dsh-auto-review-panel/panel
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { AUTO_PRESET } from '@deepseek-ai/dsh-permission-presets'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { RUN_CODE_NAME, type PreToolDecision, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from './compat.ts'
import { mountPanelChannel } from './channel.ts'
import { ReviewCaptureHost, type ReviewExecutionLike } from './host.ts'

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
  static inject = ['autoReviewPanelCompat', 'permissionPresets', 'sessions']

  /** The capture core; exposed for diagnostics and for the M2 client seam. */
  readonly host: ReviewCaptureHost

  constructor(ctx: Context) {
    super(ctx, 'autoReviewPanel')
    this.host = new ReviewCaptureHost({
      permissionPresets: ctx.permissionPresets,
      sessions: ctx.sessions,
      autoPreset: AUTO_PRESET,
      runCodeName: RUN_CODE_NAME,
      listPluginNames: () => {
        try {
          const names: string[] = []
          for (const runtime of ctx.root.registry.values()) {
            const fibers = (runtime as { fibers?: Iterable<{ entry?: { options?: { name?: unknown } } }> }).fibers
            if (fibers === undefined) continue
            for (const fiber of fibers) {
              const name = fiber.entry?.options?.name
              if (typeof name === 'string') names.push(name)
            }
          }
          return names
        } catch {
          return []
        }
      },
    })

    // Both observation listeners use the default append position: the
    // `llm/stream` tee only records while forwarding every chunk and error
    // unchanged, and `session/event` evidence lands only on records the
    // correlation anchor already pinned.
    ctx.on('llm/stream', (options, next) => this.host.stream(options, next))
    ctx.on('session/event', (session: Session, event: SessionEvent) =>
      this.host.observeSessionEvent(String(session.id), event))

    // The correlation listener is prepended one macrotask after mount:
    // cordis runs the LAST-registered prepend listener first, and mount-time
    // registrations (the reviewer's own prepend, the jobs guards) all land
    // before any tool execution can exist — a timer-bound registration is
    // therefore measurably ahead of them while still preceding the first
    // possible exec. When another fiber prepends later the listener degrades
    // to the behind-reviewer position: unreachable `deny + never` execs
    // simply stay uncorrelated, exactly the fallback the buffer model already
    // covers. Listener order is not a public contract; the composition smoke
    // asserts the observed order, it is never assumed.
    ctx.effect(() => {
      let off: (() => boolean) | undefined
      const timer = setTimeout(() => {
        off = ctx.on('tools/pre-execute',
          async (exec: ToolExecution, next: () => Promise<PreToolDecision>) =>
            this.host.preExecute(exec as ReviewExecutionLike, next), { prepend: true })
      }, 0)
      return () => {
        clearTimeout(timer)
        void off?.()
      }
    })

    mountPanelChannel(ctx, this.host)
  }

  /** The single DSH release this composition started under. */
  get release(): string | undefined {
    return this.ctx.autoReviewPanelCompat.release
  }
}

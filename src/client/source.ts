/**
 * The session-bound records source.
 *
 * One ObservableSnapshot per Session the pane shows: it polls `list` on a
 * fixed interval while subscribed and publishes a new immutable snapshot only
 * when the answer moved. The channel has no push endpoint in v1 — polling is
 * the documented substitute (requirements §4.2 open question). A failed call
 * does not hide a previously good list; it flips the phase so the view can
 * show the channel-missing state.
 *
 * @module @dsh-electron/dsh-auto-review-panel/client/source
 */

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { PanelApi } from './panel-client.ts'
import type { PanelSnapshot } from './model.ts'

/** Default polling interval for the push-free channel. */
export const POLL_INTERVAL_MS = 3000

/** One polling source's dependencies, injectable for tests. */
export interface RecordsSourceOptions {
  readonly intervalMs?: number
  readonly now?: () => number
}

/** A records source with an explicit one-shot refresh for the toolbar. */
export interface RecordsSource extends ObservableSnapshot<PanelSnapshot> {
  /** Poll immediately, outside the interval. */
  refresh(): void
}

/**
 * Build the session-bound polling source.
 * @param api - the panel channel face, or undefined when no Connection exists.
 * @param sessionId - the session this pane displays.
 * @param options - interval and clock.
 * @returns the observable source; identical snapshot references between
 *   unchanged polls keep the framework's memoization honest.
 */
export function createRecordsSource(
  api: PanelApi | undefined,
  sessionId: string,
  options: RecordsSourceOptions = {},
): RecordsSource {
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS
  let snapshot: PanelSnapshot = api === undefined ? { phase: 'failed' } : { phase: 'loading' }
  let lastValue: string | undefined
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setInterval> | undefined
  let inFlight = false

  const publish = (next: PanelSnapshot): void => {
    if (next === snapshot) return
    snapshot = next
    for (const listener of listeners) listener()
  }

  const poll = async (): Promise<void> => {
    if (api === undefined || inFlight) return
    inFlight = true
    try {
      const value = await api.list(sessionId)
      // Identity on the wire content, not the envelope: equal answers must not
      // churn the subscription, unequal ones must always republish.
      const encoded = JSON.stringify(value)
      if (encoded !== lastValue) {
        lastValue = encoded
        publish({ phase: 'ready', value })
      } else if (snapshot.phase !== 'ready') {
        publish({ phase: 'ready', value })
      }
    } catch {
      publish({ phase: 'failed' })
    } finally {
      inFlight = false
    }
  }

  const start = (): void => {
    if (timer !== undefined) return
    void poll()
    timer = setInterval(() => void poll(), intervalMs)
  }

  const stop = (): void => {
    if (timer === undefined) return
    clearInterval(timer)
    timer = undefined
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      start()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stop()
      }
    },
    refresh() {
      void poll()
    },
  }
}

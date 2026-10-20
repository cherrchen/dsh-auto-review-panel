/**
 * Browser half of the auto review panel plugin.
 *
 * Two registrations, mirroring the session-inspector mount: the tab TYPE
 * (`sidebarRightTabs.register`, static face) and the keyed tab BODY under
 * `sidebar.right.pane.tab`. The body is session-scoped: the framework calls
 * the inject factory with the pane's Session identity, and the face carries
 * the session-bound records source, the `get` endpoint, and a manual
 * refresh.
 *
 * `slots.inject` stays the soft seam: the body registers only where a
 * sidebar-right declares the slot.
 *
 * @module @dsh-electron/dsh-auto-review-panel/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the CLIENT faces that publish the services this half injects.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { AutoReviewPanel, type PanelInjected } from './AutoReviewPanel.tsx'
import { createPanelApi } from './panel-client.ts'
import { createRecordsSource } from './source.ts'
import { NS, en, zh } from './locales.ts'
import { STYLES } from './styles.ts'

export { PANEL_CHANNEL } from '../contract.ts'

/** This plugin's identity in the tab system and slot dispatch. */
const TAB_ID = '@dsh-electron/dsh-auto-review-panel'

/** The id of the `<style>` element carrying this plugin's sheet. */
const STYLE_ELEMENT_ID = 'auto-review-panel-styles'

/**
 * The client-side services the surface consumes. `slots`/`locale`/`connection`
 * were already declared; M2 adds the two-stage tab mount
 * (`sidebarRightTabs`). `connection` stays in `inject` for the type face and
 * is also read optionally through `ctx.get` — a composition without it (or
 * with it absent at eval time) shows the channel-missing empty state.
 */
export const inject = [
  'slots', 'locale', 'connection', 'sidebarRightTabs',
]

/**
 * Register the localized tab type, its keyed pane body, and the panel sheet.
 * @param ctx - the client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'auto-review-panel: dictionaries')
  ctx.effect(() => {
    let element = document.getElementById(STYLE_ELEMENT_ID)
    if (element === null) {
      element = document.createElement('style')
      element.id = STYLE_ELEMENT_ID
      element.textContent = STYLES
      document.head.append(element)
    }
    return () => { element?.remove() }
  }, 'auto-review-panel: styles')

  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: 'auto-review',
    title: () => t('tab.title'),
    guide: [{ id: 'open', order: 60, title: () => t('tab.title'), description: () => t('tab.description') }],
  }), 'auto-review-panel: sidebar tab')

  const read = (name: string): unknown => (ctx as { get(key: string): unknown }).get(name)
  const connection = read('connection') as ConnectionHandle | undefined
  const api = connection === undefined ? undefined : createPanelApi(connection)

  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: TAB_ID,
    locale: NS,
    inject: (sessionId: string): PanelInjected => {
      const records = createRecordsSource(api, sessionId)
      return {
        hooks: { records },
        getRecord: async (id, signal) => api === undefined ? undefined : api.get(id, signal),
        refresh: () => records.refresh(),
      }
    },
  }, AutoReviewPanel))
}

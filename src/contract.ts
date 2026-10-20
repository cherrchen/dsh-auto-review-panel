/**
 * Wire contract shared by the host and client halves.
 *
 * `PANEL_CHANNEL` names the Connection channel the panel client opens to reach
 * the host-side `auto-review-panel` service. Both halves import it from here so
 * the spelling has exactly one home; the client bundle inlines it at build
 * time.
 *
 * @module @dsh-electron/dsh-auto-review-panel/contract
 */

/** The Connection channel between the panel client and the host service. */
export const PANEL_CHANNEL = '/auto-review-panel'

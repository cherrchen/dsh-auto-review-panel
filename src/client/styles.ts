/**
 * The panel's sheet, injected as one `<style>` element for the plugin's
 * lifetime (same mechanism as the multi-root panel's STYLES).
 *
 * @module @dsh-electron/dsh-auto-review-panel/client/styles
 */

export const STYLES = `
.arp-panel { display: flex; flex-direction: column; height: 100%; overflow: auto; font-size: 12px; }
.arp-header { display: flex; align-items: center; gap: 8px; padding: 6px 8px; flex-wrap: wrap; }
.arp-link { color: var(--dsh-link, #6ea8fe); }
.arp-filter { display: flex; align-items: center; gap: 4px; }
.arp-header-actions { display: flex; gap: 4px; flex: none; }
.arp-header-icon { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; flex: none; border: none; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; line-height: 1; }
.arp-header-icon:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.arp-time-range { display: flex; align-items: center; gap: 4px; flex: 1 1 0; min-width: 0; }
.arp-time-field { display: inline-flex; align-items: center; gap: 3px; flex: 0 1 auto; min-width: 0; }
.arp-time-field-label { flex: none; opacity: 0.7; font-size: 11px; }
.arp-time-input { flex: 0 1 auto; width: auto; min-width: 0; height: 28px; padding: 0 4px; box-sizing: border-box; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 11px; }
.arp-time-input:hover { background: var(--dsw-alias-interactive-bg-hover); }
.arp-time-input:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); }
body[data-ds-dark-theme] .arp-time-input { color-scheme: dark; }
.arp-list { overflow: auto; }
.arp-group-title { padding: 6px 8px 2px; font-weight: 600; opacity: 0.7; }
.arp-row { display: flex; flex-direction: column; gap: 2px; width: 100%; text-align: left; padding: 5px 8px; background: none; border: none; cursor: pointer; font: inherit; color: inherit; }
.arp-row:hover { background: var(--dsh-hover, rgba(255,255,255,0.05)); }
.arp-row-line { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.arp-row-sub { opacity: 0.7; }
.arp-row-time { opacity: 0.6; white-space: nowrap; font-size: 11px; flex-shrink: 0; }
.arp-row-action { display: flex; align-items: center; gap: 5px; min-width: 0; }
.arp-row-name { font-weight: 600; white-space: nowrap; }
.arp-row-preview-line { opacity: 0.85; font-family: monospace; font-size: 11px; }
.arp-row-preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.85; font-family: monospace; flex: 1 1 auto; min-width: 0; }
.arp-row-verdicts { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.arp-badge { font-size: 10px; padding: 0 4px; border-radius: 3px; border: 1px solid var(--dsh-border, #444); opacity: 0.8; }
.arp-risk-dot { border-radius: 3px; padding: 0 4px; }
.arp-risk-low { background: #4caf50; }
.arp-risk-medium { background: #ff9800; }
.arp-risk-high { background: #f44336; }
.arp-risk-none { background: #666; }
.arp-chip { font-size: 10px; padding: 0 6px; border-radius: 8px; white-space: nowrap; }
.arp-chip-allow { background: rgba(76,175,80,0.2); color: #6fc173; }
.arp-chip-deny { background: rgba(244,67,54,0.2); color: #ef6357; }
.arp-chip-error { background: rgba(255,152,0,0.2); color: #ffb74d; }
.arp-chip-failed { background: rgba(158,158,158,0.2); color: #bdbdbd; }
.arp-row-reason { grid-column: 1 / -1; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.arp-empty { padding: 16px 12px; }
.arp-empty-title { font-weight: 600; margin-bottom: 6px; }
.arp-empty-body { opacity: 0.8; line-height: 1.5; }
.arp-loading { padding: 16px 12px; opacity: 0.6; }
.arp-detail { padding: 8px; overflow: auto; display: flex; flex-direction: column; height: 100%; }
.arp-detail-bar { display: flex; justify-content: space-between; margin-bottom: 6px; }
.arp-overview { max-height: 30%; overflow: auto; flex-shrink: 0; }
.arp-tabs { display: flex; gap: 20px; margin-top: 8px; flex-shrink: 0; }
.arp-tab { position: relative; padding: 0 0 7px; border: none; background: transparent; font-size: 12px; line-height: 16px; font-weight: 500; color: var(--dsw-alias-label-tertiary, rgba(128,128,128,0.9)); cursor: pointer; }
.arp-tab::after { content: ''; position: absolute; right: 0; bottom: 0; left: 0; height: 2px; border-radius: 2px; background: transparent; }
.arp-tab-active { color: var(--dsw-alias-label-primary, inherit); }
.arp-tab-active::after { background: var(--dsw-alias-fill-brand, #4a80f0); }
.arp-tab-panel { flex: 1; overflow: auto; padding-top: 6px; }
.arp-verdict { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.arp-verdict-reason { flex-basis: 100%; line-height: 1.5; }
.arp-facts { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 8px 0 0; }
.arp-facts dt { opacity: 0.6; }
.arp-facts dd { margin: 0; }
.arp-section-title { padding: 6px 0; cursor: pointer; font-weight: 600; }
.arp-section-body { padding-bottom: 8px; }
.arp-entry { margin: 4px 0; }
.arp-entry-title { cursor: pointer; opacity: 0.85; padding: 2px 0; }
.arp-pre { margin: 4px 0; padding: 6px; background: var(--dsh-code-bg, rgba(255,255,255,0.04)); border-radius: 4px; overflow: auto; max-height: 320px; font-size: 11px; white-space: pre-wrap; word-break: break-word; }
.arp-text { white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
.arp-mono { font-family: monospace; font-size: 11px; word-break: break-word; }
.arp-items { margin: 0; padding-left: 18px; }
.arp-none { opacity: 0.5; }
.arp-about { width: min(720px, 100%); font-size: 12px; }
.arp-about p { font-size: 12px; line-height: 1.5; }
.arp-about-content { overflow: auto; max-height: 70vh; }
.arp-about-subtitle { font-weight: 600; margin: 8px 0 4px; }
.arp-about-body { opacity: 0.85; line-height: 1.5; }
.arp-about-policy { overflow: auto; }
.arp-list-footer { display: flex; flex-direction: column; gap: 6px; padding: 8px; }
.arp-paused { opacity: 0.7; line-height: 1.4; }
.arp-load-older { align-self: flex-start; }
.arp-settings { display: flex; flex-direction: column; gap: 12px; padding: 4px 0; font-size: 12px; }
.arp-settings-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 16px; }
.arp-settings-fields.arp-settings-fields.arp-settings-fields > * + * { border-top: 0; }
.arp-settings-loading { opacity: 0.6; }
.arp-settings-intro { margin: 0; opacity: 0.85; line-height: 1.5; }
.arp-settings-location { display: flex; align-items: baseline; gap: 8px; }
.arp-settings-location-label { font-weight: 600; flex: none; }
.arp-settings-location-value { font-family: monospace; font-size: 11px; opacity: 0.85; word-break: break-all; }
.arp-settings-actions { display: flex; gap: 8px; }
.arp-settings-usage { display: flex; align-items: baseline; gap: 8px; }
.arp-settings-usage-label { font-weight: 600; flex: none; }
.arp-settings-usage-line { opacity: 0.85; }
.arp-settings-danger { margin-top: 4px; }
.arp-settings-clear { border-color: var(--dsw-alias-border-l3); color: #ef6357; }
.arp-settings-unavailable { opacity: 0.85; line-height: 1.5; }
.arp-settings-last-error { display: block; margin-top: 4px; font-family: monospace; font-size: 11px; opacity: 0.7; }
`

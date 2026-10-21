/**
 * The plugin-manager row configuration page for `auto-review-panel`.
 *
 * Registered under `plugins.row.config` with the key
 * `@dsh-electron/dsh-auto-review-panel#auto-review-panel`. The page owns the
 * three retention axes (`0` means unlimited — the shipped default), a usage
 * readout, and the one dangerous action, "clear all history", behind a
 * confirmation dialog. It is a plain consumer of the channel's settings
 * endpoints: `form` (the host's `ConfigPageForm`) is deliberately ignored —
 * this plugin's settings are its own runtime data, not profile config, so no
 * `ctx.settings` schema and no schemastery dependency are involved.
 *
 * The soft seam: when the channel is absent (`api === undefined`) the page
 * still renders — disabled, with the channel-missing notice — and when the
 * plugin-manager client package itself is absent this entry simply never
 * renders; the sidebar tab is unaffected either way.
 *
 * @module @dsh-electron/dsh-auto-review-panel/client/settings
 */

import { createElement, useCallback, useEffect, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { Button, Modal, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PanelStatsValue, ReviewHistoryRetention } from '../contract.ts'
import { DEFAULT_RETENTION } from '../contract.ts'
import type { PanelSettingsApi } from './panel-client.ts'
import type { NS, Key } from './locales.ts'

/** The `plugins.row.config` key of this bundle's `auto-review-panel` row. */
export const ROW_CONFIG_KEY = '@dsh-electron/dsh-auto-review-panel#auto-review-panel'

/** The inject face `index.ts` hands the page: the settings half of the API. */
export interface RetentionSettingsInjected {
  readonly api?: PanelSettingsApi
}

/** Composed props for the row's configuration entry. */
export type RetentionSettingsProps =
  & PluginConfigViewProps
  & InjectFace<RetentionSettingsInjected>
  & PropsLocale<typeof NS>

type T = (key: Key, params?: Record<string, unknown>) => string

const e = createElement

/** One draft field: the raw input text plus whether it currently parses. */
interface Draft {
  readonly text: string
  readonly valid: boolean
}

/** Read one field's text as a non-negative integer draft. */
function draftOf(text: string): Draft {
  const trimmed = text.trim()
  const value = trimmed === '' ? Number.NaN : Number(trimmed)
  return { text, valid: Number.isInteger(value) && value >= 0 }
}

/** The three retention axes as editable drafts. */
interface Drafts {
  maxRecordsPerSession: Draft
  maxSessions: Draft
  maxTotalMegabytes: Draft
}

/** Seed drafts from a stats value. */
function draftsOf(settings: ReviewHistoryRetention): Drafts {
  const field = (value: number): Draft => ({ text: String(value), valid: true })
  return {
    maxRecordsPerSession: field(settings.maxRecordsPerSession),
    maxSessions: field(settings.maxSessions),
    maxTotalMegabytes: field(settings.maxTotalMegabytes),
  }
}

/** Whether every draft parses and at least one differs from the applied settings. */
function dirtyAndValid(drafts: Drafts, applied: ReviewHistoryRetention): boolean {
  if (!drafts.maxRecordsPerSession.valid || !drafts.maxSessions.valid || !drafts.maxTotalMegabytes.valid) {
    return false
  }
  return Number(drafts.maxRecordsPerSession.text.trim()) !== applied.maxRecordsPerSession
    || Number(drafts.maxSessions.text.trim()) !== applied.maxSessions
    || Number(drafts.maxTotalMegabytes.text.trim()) !== applied.maxTotalMegabytes
}

/** The retention a fully-valid draft set describes. */
function retentionOf(drafts: Drafts): ReviewHistoryRetention {
  return {
    maxRecordsPerSession: Number(drafts.maxRecordsPerSession.text.trim()),
    maxSessions: Number(drafts.maxSessions.text.trim()),
    maxTotalMegabytes: Number(drafts.maxTotalMegabytes.text.trim()),
  }
}

/** Format a byte count for the usage line (KiB/MiB/GiB, one decimal). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB'] as const
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

/** What one maintenance pass reports back after a save. */
function maintenanceLine(maintenance: { compactedSessions: number; removedSessions: number; removedRecords: number }, t: T): string | undefined {
  if (maintenance.compactedSessions === 0 && maintenance.removedSessions === 0 && maintenance.removedRecords === 0) {
    return undefined
  }
  return t('settings.maintenance', {
    compacted: maintenance.compactedSessions,
    removedSessions: maintenance.removedSessions,
    removedRecords: maintenance.removedRecords,
  })
}

/** One labelled numeric field with its help line and invalid marker. */
function RetentionField({ label, help, draft, disabled, onChange, t }: {
  readonly label: string
  readonly help: string
  readonly draft: Draft
  readonly disabled: boolean
  readonly onChange: (text: string) => void
  readonly t: T
}): ReactNode {
  return e('label', { className: `arp-settings-field${draft.valid ? '' : ' arp-settings-invalid'}` },
    e('span', { className: 'arp-settings-label' }, label),
    e('input', {
      type: 'number',
      min: 0,
      step: 1,
      inputMode: 'numeric',
      className: 'arp-settings-input',
      value: draft.text,
      disabled,
      onChange: (event: { currentTarget: { value: string } }) => onChange(event.currentTarget.value),
    }),
    e('span', { className: 'arp-settings-help' },
      draft.valid ? help : t('settings.invalid')))
}

/** The `view: 'page'` body — only rendered once stats have loaded. */
function SettingsPage({ api, stats, onStats, t }: {
  readonly api: PanelSettingsApi
  readonly stats: PanelStatsValue
  readonly onStats: (next: PanelStatsValue) => void
  readonly t: T
}): ReactNode {
  const [drafts, setDrafts] = useState<Drafts>(() => draftsOf(stats.settings))
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | undefined>()
  const [confirming, setConfirming] = useState(false)
  const [clearing, setClearing] = useState(false)

  // Reseed drafts only when the applied settings change underneath us (a save
  // round-trip or a fresh stats read) and the user has not edited — dirty
  // fields are never silently overwritten.
  const [applied, setApplied] = useState(stats.settings)
  useEffect(() => {
    if (stats.settings !== applied) {
      setApplied(stats.settings)
      setDrafts(current =>
        dirtyAndValid(current, applied) ? current : draftsOf(stats.settings))
    }
  }, [stats.settings, applied])

  const writable = stats.available
  const dirty = dirtyAndValid(drafts, stats.settings)
  const allValid = drafts.maxRecordsPerSession.valid && drafts.maxSessions.valid && drafts.maxTotalMegabytes.valid

  const save = useCallback(() => {
    if (!allValid || saving) return
    setSaving(true)
    setNotice(undefined)
    void api.updateSettings(retentionOf(drafts))
      .then(result => {
        onStats(result.stats)
        setNotice(maintenanceLine(result.maintenance, t) ?? t('settings.saved'))
      }, () => setNotice(t('settings.error')))
      .finally(() => setSaving(false))
  }, [api, drafts, allValid, saving, onStats, t])

  const resetAll = useCallback(() => {
    setDrafts(draftsOf(DEFAULT_RETENTION))
  }, [])

  const runClear = useCallback(() => {
    if (clearing) return
    setClearing(true)
    void api.clear()
      .then(result => {
        setConfirming(false)
        onStats(result.stats)
        setNotice(t('settings.cleared', {
          sessions: result.removedSessions,
          bytes: formatBytes(result.removedBytes),
        }))
      }, () => {
        setConfirming(false)
        setNotice(t('settings.error'))
      })
      .finally(() => setClearing(false))
  }, [api, clearing, onStats, t])

  const field = (key: keyof Drafts, labelKey: Key, helpKey: Key): ReactNode =>
    e(RetentionField, {
      label: t(labelKey),
      help: t(helpKey),
      draft: drafts[key],
      disabled: !writable || saving || clearing,
      onChange: (text: string) =>
        setDrafts(current => ({ ...current, [key]: draftOf(text) })),
      t,
    })

  return e('div', { className: 'arp-settings' },
    e('p', { className: 'arp-settings-intro' }, t('settings.intro')),
    e('div', { className: 'arp-settings-location' },
      e('span', { className: 'arp-settings-location-label' }, t('settings.location')),
      e('code', { className: 'arp-settings-location-value' },
        stats.location ?? t('settings.locationUnknown'))),
    !stats.available
      ? e('div', { className: 'arp-settings-unavailable' },
          t('settings.unavailable'),
          stats.lastError === undefined ? null
            : e('span', { className: 'arp-settings-last-error' }, stats.lastError))
      : null,
    e('div', { className: 'arp-settings-fields' },
      field('maxRecordsPerSession', 'settings.perSession', 'settings.perSessionHelp'),
      field('maxSessions', 'settings.sessions', 'settings.sessionsHelp'),
      field('maxTotalMegabytes', 'settings.totalMegabytes', 'settings.totalMegabytesHelp')),
    e('div', { className: 'arp-settings-actions' },
      e(Button, {
        variant: 'primary',
        size: 'sm',
        disabled: !writable || !dirty || saving || clearing,
        onClick: save,
      }, saving ? t('settings.saving') : t('settings.save')),
      e(Button, {
        variant: 'outline',
        size: 'sm',
        disabled: !writable || saving || clearing,
        onClick: resetAll,
      }, t('settings.resetAll'))),
    e('div', { className: 'arp-settings-usage' },
      e('span', { className: 'arp-settings-usage-label' }, t('settings.usage')),
      e('span', { className: 'arp-settings-usage-line' },
        t('settings.usageLine', { sessions: stats.sessions, bytes: formatBytes(stats.bytes) }))),
    e('div', { className: 'arp-settings-danger' },
      e(Button, {
        variant: 'outline',
        size: 'sm',
        className: 'arp-settings-clear',
        disabled: !writable || saving || clearing,
        onClick: () => setConfirming(true),
      }, t('settings.clear'))),
    notice === undefined ? null : e('div', { className: 'arp-settings-notice' }, notice),
    e(Modal, {
      open: confirming,
      onClose: () => { if (!clearing) setConfirming(false) },
      title: t('settings.clearTitle'),
      closeLabel: t('settings.clearCancel'),
      description: t('settings.clearBody'),
      className: 'arp-settings-clear-modal',
      footer: e('div', { className: 'arp-settings-clear-actions' },
        e(Button, {
          variant: 'outline',
          size: 'sm',
          disabled: clearing,
          onClick: () => setConfirming(false),
        }, t('settings.clearCancel')),
        e(Button, {
          variant: 'primary',
          size: 'sm',
          className: 'arp-settings-clear-confirm',
          disabled: clearing,
          onClick: runClear,
        }, clearing ? t('settings.clearing') : t('settings.clearConfirm'))),
    }))
}

/** The `page` body once a channel exists: stats load, then the form. */
function SettingsRoot({ api, t }: { readonly api: PanelSettingsApi; readonly t: T }): ReactNode {
  const [stats, setStats] = useState<PanelStatsValue | undefined>()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    void api.stats().then(
      value => { if (alive) setStats(value) },
      () => { if (alive) setFailed(true) },
    )
    return () => { alive = false }
  }, [api])

  if (failed) {
    return e('div', { className: 'arp-settings' },
      e('div', { className: 'arp-settings-unavailable' }, t('settings.error')))
  }
  if (stats === undefined) {
    return e('div', { className: 'arp-settings arp-settings-loading' },
      e(TextShimmer, { active: true, children: t('list.loading') }))
  }
  return e(SettingsPage, { api, stats, onStats: setStats, t })
}

/** The row's configuration entry: a one-liner in `summary`, the page in `page`. */
export function RetentionSettings(props: RetentionSettingsProps): ReactNode {
  const { view, api, t } = props

  // `summary` is a pure one-liner — it never reaches a hook, so a host that
  // only wants the text can render the entry without mounting the page.
  if (view === 'summary') return t('settings.summary')
  if (api === undefined) {
    return e('div', { className: 'arp-settings' },
      e('div', { className: 'arp-settings-unavailable' }, t('settings.channelMissing')))
  }
  return e(SettingsRoot, { api, t })
}

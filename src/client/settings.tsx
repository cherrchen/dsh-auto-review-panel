/**
 * The plugin-manager bundle configuration page for `auto-review-panel`.
 *
 * Registered under `plugins.bundle.config` with the package name as its key,
 * so it renders on this plugin's package detail page. The page owns the
 * three retention axes (`0` means unlimited — the shipped default), a usage
 * readout, and the one dangerous action, "clear all history", behind a
 * `RiskConfirmation` acknowledgement. It is a plain consumer of the
 * channel's settings endpoints: `form` (the host's `ConfigPageForm`) is
 * deliberately ignored — this plugin's settings are its own runtime data,
 * not profile config, so no `ctx.settings` schema and no `SettingsFormModel`
 * scope are involved; the shared `SettingsForm`/`SettingsValueField`
 * primitives supply the staged-draft chrome over our own draft state.
 *
 * The soft seam: when the channel is absent (`api === undefined`) the page
 * still renders — disabled, with the channel-missing notice — and when the
 * plugin-manager client package itself is absent this entry simply never
 * renders; the sidebar tab is unaffected either way.
 *
 * @module @dsh-electron/dsh-auto-review-panel/client/settings
 */

import { createElement, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import {
  Button,
  PathLabel,
  RiskConfirmation,
  SettingsForm,
  SettingsValueField,
  TextShimmer,
  Toast,
  fileSizeText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PanelStatsValue, ReviewHistoryRetention } from '../contract.ts'
import { DEFAULT_RETENTION } from '../contract.ts'
import type { PanelSettingsApi } from './panel-client.ts'
import type { NS, Key } from './locales.ts'

/** The `plugins.bundle.config` key — this bundle's package name. */
export const BUNDLE_CONFIG_KEY = '@dsh-electron/dsh-auto-review-panel'

/** The inject face `index.ts` hands the page: the settings half of the API. */
export interface RetentionSettingsInjected {
  readonly api?: PanelSettingsApi
}

/** Composed props for the bundle's configuration entry. */
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

/** Whether any staged text differs from the applied settings. */
function isDirty(drafts: Drafts, applied: ReviewHistoryRetention): boolean {
  return drafts.maxRecordsPerSession.text.trim() !== String(applied.maxRecordsPerSession)
    || drafts.maxSessions.text.trim() !== String(applied.maxSessions)
    || drafts.maxTotalMegabytes.text.trim() !== String(applied.maxTotalMegabytes)
}

/** Whether every draft parses. */
function allValid(drafts: Drafts): boolean {
  return drafts.maxRecordsPerSession.valid && drafts.maxSessions.valid && drafts.maxTotalMegabytes.valid
}

/** The retention a fully-valid draft set describes. */
function retentionOf(drafts: Drafts): ReviewHistoryRetention {
  return {
    maxRecordsPerSession: Number(drafts.maxRecordsPerSession.text.trim()),
    maxSessions: Number(drafts.maxSessions.text.trim()),
    maxTotalMegabytes: Number(drafts.maxTotalMegabytes.text.trim()),
  }
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

/** One transient notice the toast surfaces. */
interface Notice {
  readonly seq: number
  readonly text: string
  readonly tone?: 'success' | undefined
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
  const [saveFailed, setSaveFailed] = useState(false)
  const noticeSeq = useRef(0)
  const [notice, setNotice] = useState<Notice | undefined>()
  const [confirming, setConfirming] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [clearing, setClearing] = useState(false)

  // Reseed drafts only when the applied settings change underneath us (a save
  // round-trip or a fresh stats read) and the user has not edited — dirty
  // fields are never silently overwritten.
  const [applied, setApplied] = useState(stats.settings)
  useEffect(() => {
    if (stats.settings !== applied) {
      setApplied(stats.settings)
      setDrafts(current =>
        isDirty(current, applied) ? current : draftsOf(stats.settings))
    }
  }, [stats.settings, applied])

  const say = useCallback((text: string, tone?: 'success') => {
    noticeSeq.current += 1
    setNotice({ seq: noticeSeq.current, text, tone })
  }, [])

  const writable = stats.available
  const disabled = !writable || saving || clearing
  const edit = useCallback((key: keyof Drafts) => (text: string) => {
    setSaveFailed(false)
    setDrafts(current => ({ ...current, [key]: draftOf(text) }))
  }, [])
  const resetField = useCallback((key: keyof Drafts) => () => {
    setSaveFailed(false)
    setDrafts(current => ({ ...current, [key]: draftOf('0') }))
  }, [])

  const discard = useCallback(() => {
    setSaveFailed(false)
    setDrafts(draftsOf(applied))
  }, [applied])

  const save = useCallback(() => {
    if (!allValid(drafts) || saving) return
    setSaving(true)
    setSaveFailed(false)
    void api.updateSettings(retentionOf(drafts))
      .then(result => {
        onStats(result.stats)
        say(maintenanceLine(result.maintenance, t) ?? t('settings.saved'), 'success')
      }, () => setSaveFailed(true))
      .finally(() => setSaving(false))
  }, [api, drafts, saving, onStats, t, say])

  const resetAll = useCallback(() => {
    setSaveFailed(false)
    setDrafts(draftsOf(DEFAULT_RETENTION))
  }, [])

  const runClear = useCallback(() => {
    if (clearing) return
    setClearing(true)
    void api.clear()
      .then(result => {
        setConfirming(false)
        setAcknowledged(false)
        onStats(result.stats)
        say(t('settings.cleared', {
          sessions: result.removedSessions,
          bytes: fileSizeText(result.removedBytes),
        }), 'success')
      }, () => {
        setConfirming(false)
        setAcknowledged(false)
        say(t('settings.error'))
      })
      .finally(() => setClearing(false))
  }, [api, clearing, onStats, t, say])

  const field = (key: keyof Drafts, labelKey: Key, helpKey: Key): ReactNode =>
    e(SettingsValueField, {
      key,
      id: `arp-settings-${key}`,
      label: t(labelKey),
      hint: t(helpKey),
      text: drafts[key].text,
      numeric: true,
      overridden: drafts[key].text.trim() !== '0',
      invalid: !drafts[key].valid,
      overriddenLabel: t('settings.overridden'),
      resetLabel: t('settings.reset'),
      invalidLabel: t('settings.invalid'),
      disabled,
      onEdit: edit(key),
      onReset: resetField(key),
    })

  return e('div', { className: 'arp-settings' },
    e('p', { className: 'arp-settings-intro' }, t('settings.intro')),
    e('div', { className: 'arp-settings-location' },
      e('span', { className: 'arp-settings-location-label' }, t('settings.location')),
      e(PathLabel, {
        className: 'arp-settings-location-value',
        path: stats.location ?? t('settings.locationUnknown'),
      })),
    !stats.available && stats.lastError !== undefined
      ? e('div', { className: 'arp-settings-unavailable' },
          `${t('settings.lastError')}: `,
          e('span', { className: 'arp-settings-last-error' }, stats.lastError))
      : null,
    e(SettingsForm, {
      state: {
        available: true,
        writable,
        dirty: isDirty(drafts, applied),
        invalid: !allValid(drafts),
        saving,
        failed: saveFailed,
      },
      labels: {
        unavailable: t('settings.unavailable'),
        readOnly: t('settings.readOnly'),
        saveFailed: t('settings.error'),
        save: t('settings.save'),
        saving: t('settings.saving'),
      },
      onSave: save,
      onDiscard: discard,
      children: e('div', { className: 'arp-settings-fields' },
        field('maxRecordsPerSession', 'settings.perSession', 'settings.perSessionHelp'),
        field('maxSessions', 'settings.sessions', 'settings.sessionsHelp'),
        field('maxTotalMegabytes', 'settings.totalMegabytes', 'settings.totalMegabytesHelp')),
    }),
    e('div', { className: 'arp-settings-actions' },
      e(Button, {
        variant: 'outline',
        size: 'sm',
        disabled,
        onClick: resetAll,
      }, t('settings.resetAll'))),
    e('div', { className: 'arp-settings-usage' },
      e('span', { className: 'arp-settings-usage-label' }, t('settings.usage')),
      e('span', { className: 'arp-settings-usage-line' },
        t('settings.usageLine', { sessions: stats.sessions, bytes: fileSizeText(stats.bytes) }))),
    e('div', { className: 'arp-settings-danger' },
      e(Button, {
        variant: 'outline',
        size: 'sm',
        className: 'arp-settings-clear',
        disabled,
        onClick: () => setConfirming(true),
      }, t('settings.clear'))),
    e(RiskConfirmation, {
      open: confirming,
      title: t('settings.clearTitle'),
      description: t('settings.clearBody'),
      acknowledgeLabel: t('settings.clearAcknowledge'),
      cancelLabel: t('settings.clearCancel'),
      closeLabel: t('about.close'),
      confirmLabel: clearing ? t('settings.clearing') : t('settings.clearConfirm'),
      acknowledged,
      disabled: clearing,
      onAcknowledgedChange: setAcknowledged,
      onCancel: () => { if (!clearing) { setConfirming(false); setAcknowledged(false) } },
      onConfirm: runClear,
    }),
    notice === undefined ? null : e(Toast, {
      key: notice.seq,
      text: notice.text,
      ...(notice.tone === 'success' ? { tone: 'success' as const } : {}),
      onDone: () => setNotice(current => current?.seq === notice.seq ? undefined : current),
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

/** The bundle's configuration entry: a one-liner in `summary`, the page in `page`. */
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

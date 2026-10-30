/**
 * The Auto Review panel body for `sidebar.right.pane.tab`.
 *
 * Pure consumer of the injected face: the session-bound `useRecords` hook
 * drives the list, `getRecord`/`refresh` arrive as plain
 * callbacks, and `t` is the locale seat. Nothing here judges, re-scores, or
 * caches host state — a field the channel did not send renders as absent.
 *
 * Disclosure discipline (requirements §4.3): list rows carry exactly five
 * fields, the detail opens on the verdict card alone, and REVIEW_POLICY
 * appears exactly once — inside the header's About dialog. Controls come
 * from `dsh-client-ui-primitives`; the only bespoke elements are layout
 * containers and the row body text.
 *
 * @module @dsh-electron/dsh-auto-review-panel/client/AutoReviewPanel
 */

import { createElement, useCallback, useRef, useState, type ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  Button,
  DisclosureRow,
  IconChevronDownOutlineRegular,
  IconCloseOutlineRegular,
  IconInfoOutlineRegular,
  IconRefreshOutlineRegular,
  JsonTree,
  Menu,
  Modal,
  Tag,
  TextShimmer,
  Tooltip,
  type JsonTreeLabels,
  type MenuEntry,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReviewDecision, ReviewRecord, ReviewRecordSummary, ReviewRisk } from '../contract.ts'
import {
  chipOf,
  downstreamOf,
  emptyStateOf,
  groupSummaries,
  hostOutcomeOf,
  reasonOf,
  rowTime,
  type EmptyState,
  type ListFilters,
  type PanelSnapshot,
  type VerdictChip,
} from './model.ts'
import { NS, type Key } from './locales.ts'

/** The inject face the registration builds per Session. */
export interface PanelInjected {
  readonly hooks: {
    /** Session-bound polling source over `list`. */
    readonly records: ObservableSnapshot<PanelSnapshot>
  }
  /** One-shot `get`; undefined for an evicted record. */
  readonly getRecord: (id: string, signal?: AbortSignal) => Promise<ReviewRecord | undefined>
  /** Out-of-interval poll for the toolbar; also exits the paused paging state. */
  readonly refresh: () => void
  /** Append the next strictly-older history page and pause auto-refresh. */
  readonly loadOlder: () => void
}

/** Composed props the slot framework hands this component. */
export type AutoReviewPanelProps =
  & { readonly sessionId: SessionId }
  & InjectFace<PanelInjected>
  & PropsLocale<typeof NS>

type T = (key: Key, params?: Record<string, unknown>) => string

const e = createElement

/** risk → Tag tone (low green, medium amber, high red). */
const RISK_TONE: Record<ReviewRisk, TagTone> = { low: 'success', medium: 'warning', high: 'danger' }

/** verdict chip → Tag tone. */
const CHIP_TONE: Record<VerdictChip, TagTone> = {
  allow: 'success',
  deny: 'danger',
  error: 'warning',
  failed: 'neutral',
}

/**
 * One list row: tool name plus its argument preview and mode badge on the
 * left, the risk and verdict tags on the right; the reason carries the
 * second line, with the capture time at its far end.
 */
function RecordRow({ record, onOpen, t }: {
  readonly record: ReviewRecordSummary
  readonly onOpen: (id: string) => void
  readonly t: T
}): ReactNode {
  const chip = chipOf(record)
  const mode = record.action.mode === 'ptc-inner' ? t('mode.ptc-inner') : t('mode.native')
  const preview = record.action.preview
  return e('button', { className: 'arp-row', type: 'button', onClick: () => onOpen(record.id) },
    e('span', { className: 'arp-row-line' },
      e('span', { className: 'arp-row-action' },
        e('span', { className: 'arp-row-name' }, record.action.name ?? '—'),
        e(Tag, { tone: 'outline', className: 'arp-badge' }, mode)),
      e('span', { className: 'arp-row-verdicts' },
        record.risk === undefined ? null
          : e(Tag, { tone: RISK_TONE[record.risk], className: `arp-risk-tag arp-risk-${record.risk}` }, t(`risk.${record.risk}` as Key)),
        e(Tag, { tone: CHIP_TONE[chip], className: `arp-chip arp-chip-${chip}` }, t(`chip.${chip}` as Key)))),
    preview === undefined ? null
      : e('span', { className: 'arp-row-line arp-row-preview-line' },
          e('span', { className: 'arp-row-preview', title: preview }, preview)),
    e('span', { className: 'arp-row-line arp-row-sub' },
      e('span', { className: 'arp-row-reason' }, reasonOf(record) ?? t('reason.none')),
      e('span', { className: 'arp-row-time' }, rowTime(record.capturedAt))))
}

/** The four honest empty states. */
function EmptyState({ state, status, t }: {
  readonly state: EmptyState
  readonly status: { sessionPreset?: string } | undefined
  readonly t: T
}): ReactNode {
  const preset = status?.sessionPreset
  return e('div', { className: `arp-empty arp-empty-${state}` },
    e('div', { className: 'arp-empty-title' }, t(`empty.${state}.title` as Key)),
    e('div', { className: 'arp-empty-body' },
      t(`empty.${state}.body` as Key, preset === undefined ? {} : { preset })))
}

/** One collapsible section on the shared disclosure state. */
function Section({ id, title, open, onToggle, children }: {
  readonly id: string
  readonly title: string
  readonly open: (id: string) => boolean
  readonly onToggle: (id: string) => void
  readonly children?: ReactNode
}): ReactNode {
  const expanded = open(id)
  return e('div', { className: 'arp-section' },
    e(DisclosureRow, {
      icon: null,
      title,
      open: expanded,
      expandable: true,
      expandOnRowClick: true,
      onToggle: () => onToggle(id),
      className: 'arp-section-row',
      titleClassName: 'arp-section-title',
    },
      expanded ? e('div', { className: 'arp-section-body' }, children) : null))
}

/** One FILTERED_HISTORY entry, shown by its original role/source kind. */
function historyLabel(entry: unknown): string {
  if (entry === null || typeof entry !== 'object') return typeof entry
  const record = entry as Record<string, unknown>
  const kind = typeof record['kind'] === 'string' ? record['kind'] : 'entry'
  const role = typeof record['role'] === 'string' ? record['role'] : undefined
  const source = record['source']
  const sourceKind = source !== null && typeof source === 'object' && !Array.isArray(source)
    && typeof (source as Record<string, unknown>)['kind'] === 'string'
    ? (source as Record<string, unknown>)['kind'] as string
    : undefined
  return [kind, role, sourceKind].filter(part => part !== undefined).join(' · ')
}

/** The argument members that identify one call in the overview. */
const ARG_TARGET_KEYS = ['command', 'file_path', 'filePath', 'path', 'file', 'filename', 'fileName'] as const

/**
 * The overview's argument lines: the identifying argument (command/path)
 * and the call's own description, each shown verbatim or absent.
 */
function argumentLines(args: unknown): { readonly target?: string; readonly description?: string } {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return {}
  const record = args as Record<string, unknown>
  const target = ARG_TARGET_KEYS
    .map(key => record[key])
    .find((value): value is string => typeof value === 'string' && value.trim() !== '')
  const description = record['description']
  return {
    ...(target === undefined ? {} : { target }),
    ...(typeof description === 'string' && description.trim() !== '' ? { description } : {}),
  }
}

/** The detail's four tab panels. */
type DetailTab = 'call' | 'context' | 'project' | 'result'

/**
 * The trajectory-style JSON view: the same `JsonTree` the inspector uses,
 * over any object/array member; scalar values fall back to verbatim text.
 */
function Json({ value, t }: { readonly value: unknown; readonly t: T }): ReactNode {
  const labels: JsonTreeLabels = {
    copyValue: t('copy.value'),
    copyJson: t('copy.json'),
    copyPath: t('copy.path'),
    copyPrettyJson: t('copy.prettyJson'),
    copyCompactJson: t('copy.compactJson'),
    copied: t('copied'),
    copyFailed: t('copy.failed'),
    collapseNode: t('json.collapse'),
    expandNode: t('json.expand'),
    copyButtonTitle: action => t('copy.optionsHint', { action }),
  }
  if (value === null || typeof value !== 'object') {
    return e('pre', { className: 'arp-pre' }, value === undefined ? '—' : String(value))
  }
  return e(JsonTree, {
    data: value as object | unknown[],
    label: t('detail.raw'),
    labels,
    copyable: false,
    expandTopLevel: true,
    className: 'arp-json',
  })
}

/**
 * The record detail: a compact overview card on top, then one tab body per
 * captured section — the same switcher style as the session view's
 * conversation/trajectory tabs.
 */
function RecordDetail({ record, onBack, t }: {
  readonly record: ReviewRecord
  readonly onBack: () => void
  readonly t: T
}): ReactNode {
  const chip = record.finish !== undefined ? 'failed' : record.output.decision ?? 'failed'
  const action = record.sections.pendingAction
  const args = argumentLines(action.arguments)
  const history = Array.isArray(record.sections.filteredHistory)
    ? record.sections.filteredHistory
    : (record.sections.history ?? [])
  const [tab, setTab] = useState<DetailTab>('call')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const open = (id: string): boolean => expanded.has(id)
  const toggle = (id: string): void =>
    setExpanded(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const fact = (key: string, label: string, value: string | undefined): ReactNode[] =>
    value === undefined ? [] : [e('dt', { key: `${key}-t` }, label), e('dd', { key: `${key}-d` }, value)]

  return e('div', { className: 'arp-detail' },
    e('div', { className: 'arp-detail-bar' },
      e(Button, { variant: 'ghost', size: 'sm', className: 'arp-link', onClick: onBack }, `‹ ${t('detail.back')}`)),
    e('div', { className: 'arp-overview' },
      e('div', { className: 'arp-verdict' },
        record.output.risk === undefined ? null
          : e(Tag, { tone: 'neutral', className: `arp-risk-dot arp-risk-${record.output.risk}` }, t(`risk.${record.output.risk}` as Key)),
        e(Tag, { tone: CHIP_TONE[chip], className: `arp-chip arp-chip-${chip}` }, t(`chip.${chip}` as Key)),
        record.output.reason === undefined ? e('div', { className: 'arp-verdict-reason' }, t('reason.none'))
          : e('div', { className: 'arp-verdict-reason' }, record.output.reason)),
      e('dl', { className: 'arp-facts' },
        ...fact('model', t('detail.model'), `${record.provider}/${record.model}`),
        ...fact('capturedAt', t('detail.capturedAt'), record.capturedAt),
        ...fact('tool', t('detail.tool'), action.name),
        ...fact('arguments', t('detail.arguments'), args.target),
        ...fact('description', t('detail.description'), args.description),
        ...fact('finish', t('detail.finish'),
          record.finish === undefined ? undefined
            : `${record.finish.kind}${record.finish.code === undefined ? '' : ` ${record.finish.code}`}${record.finish.message === undefined ? '' : ` — ${record.finish.message}`}`),
        ...fact('downstream', t('detail.downstream'), downstreamOf(record)),
        ...fact('host', t('detail.hostOutcome'),
          hostOutcomeOf(record, { completed: t('host.completed'), approval: t('host.approval') })))),
    e('div', { className: 'arp-tabs', role: 'tablist' },
      ([['call', 'detail.toolCall'], ['context', 'detail.context'], ['project', 'detail.project'], ['result', 'detail.result']] as const)
        .map(([value, key]) =>
          e('button', {
            key: value,
            type: 'button',
            role: 'tab',
            id: `arp-tab-${value}`,
            'aria-selected': tab === value,
            'aria-controls': `arp-panel-${value}`,
            className: `arp-tab${tab === value ? ' arp-tab-active' : ''}`,
            onClick: () => setTab(value),
          }, t(key as Key)))),
    e('div', { className: 'arp-tab-panel', role: 'tabpanel', id: `arp-panel-${tab}` },
      tab === 'call'
          ? e(Json, { value: action, t })
        : tab === 'context'
          ? (history.length === 0 ? e('div', { className: 'arp-none' }, '[]')
            : history.map((entry, index) =>
              e(Section, { key: `history-${index}`, id: `history-${index}`, title: historyLabel(entry), open, onToggle: toggle },
                e(Json, { value: entry, t }))))
        : tab === 'project'
          ? e('div', null,
              // The messages protocol folds project instructions into
              // constraint-role history entries; only ENVIRONMENT remains.
              record.sections.projectInstructions === undefined ? null
                : [e('div', { key: 'pi-t', className: 'arp-entry-title' }, 'PROJECT_INSTRUCTIONS'),
                    e(Json, { key: 'pi-v', value: record.sections.projectInstructions, t })],
              e('div', { className: 'arp-entry-title' }, 'ENVIRONMENT'),
              e(Json, { value: record.sections.environment, t }))
          : e('div', null,
              record.reasoning.length === 0 ? null
                : e(Section, { id: 'thinking', title: t('detail.thinking'), open, onToggle: toggle },
                    e('pre', { className: 'arp-pre' }, record.reasoning.join('\n\n'))),
              (() => {
                try {
                  return e(Json, { value: JSON.parse(record.output.rawText) as unknown, t })
                } catch {
                  return e('pre', { className: 'arp-pre' }, record.output.rawText)
                }
              })())))
}

/** One multi-select filter dropdown; the field label stays on the trigger, never an item. */
function MultiFilter({ label, options, selected, onChange }: {
  readonly label: string
  readonly options: readonly MenuEntry[]
  readonly selected: readonly string[]
  readonly onChange: (next: readonly string[]) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  return e(Menu, {
    open,
    onClose: () => setOpen(false),
    portal: true,
    align: 'start',
    items: options,
    selectedIds: selected,
    // Toggling keeps the list open — the owner, not the menu, decides to close.
    onSelect: (id: string) =>
      onChange(selected.includes(id) ? selected.filter(entry => entry !== id) : [...selected, id]),
    anchor: e(Button, {
      variant: 'outline',
      size: 'sm',
      'aria-haspopup': 'menu',
      'aria-expanded': open,
      onClick: () => setOpen(current => !current),
    }, selected.length === 0 ? label : `${label} ·${selected.length}`,
      e(IconChevronDownOutlineRegular, { size: 12 })),
  })
}

/**
 * The two local `datetime-local` bounds. Values are wall-clock strings with no
 * zone — the same shape the native control reads and writes — and the model
 * turns them into absolute instants only while filtering.
 */
function TimeRange({ from, to, onChange, t }: {
  readonly from: string | undefined
  readonly to: string | undefined
  readonly onChange: (next: { from?: string; to?: string }) => void
  readonly t: T
}): ReactNode {
  const bind = (key: 'from' | 'to') => (event: { readonly currentTarget: { readonly value: string } }) => {
    const value = event.currentTarget.value
    const nextFrom = key === 'from' ? value : from
    const nextTo = key === 'to' ? value : to
    const next: { from?: string; to?: string } = {}
    if (nextFrom !== undefined && nextFrom !== '') next.from = nextFrom
    if (nextTo !== undefined && nextTo !== '') next.to = nextTo
    onChange(next)
  }
  return e('div', { className: 'arp-time-range' },
    e('label', { className: 'arp-time-field' },
      e('span', { className: 'arp-time-field-label' }, t('filter.time.from')),
      e('input', {
        type: 'datetime-local',
        className: 'arp-time-input',
        'aria-label': t('filter.time.fromAria'),
        value: from ?? '',
        max: to === undefined || to === '' ? undefined : to,
        onChange: bind('from'),
      })),
    e('label', { className: 'arp-time-field' },
      e('span', { className: 'arp-time-field-label' }, t('filter.time.to')),
      e('input', {
        type: 'datetime-local',
        className: 'arp-time-input',
        'aria-label': t('filter.time.toAria'),
        value: to ?? '',
        min: from === undefined || from === '' ? undefined : from,
        onChange: bind('to'),
      })),
    from === undefined && to === undefined ? null
      : e(Tooltip, {
          label: t('filter.time.clear'),
          side: 'bottom',
          delayMs: 500,
          children: e('button', {
            type: 'button',
            className: 'arp-header-icon',
            'aria-label': t('filter.time.clear'),
            onClick: () => onChange({}),
          }, e(IconCloseOutlineRegular, { size: 14 })),
        }))
}

/** The header's About dialog: the single place REVIEW_POLICY appears. */
function About({ open, policy, reviewer, onClose, t }: {
  readonly open: boolean
  readonly policy: string | undefined
  /** The mounted reviewer bundle's loader entry name, when the host read it. */
  readonly reviewer: string | undefined
  readonly onClose: () => void
  readonly t: T
}): ReactNode {
  return e(Modal, {
    open,
    onClose,
    title: t('about.title'),
    closeLabel: t('about.close'),
    description: t('about.body', { package: reviewer ?? t('about.reviewer.unknown') }),
    className: 'arp-about',
    contentClassName: 'arp-about-content',
  },
    e('div', { className: 'arp-about-subtitle' }, t('about.policy')),
    policy === undefined
      ? e('div', { className: 'arp-about-body' }, t('about.policy.empty'))
      : e('pre', { className: 'arp-pre arp-about-policy' }, policy))
}

/** The session-bound panel body. */
export function AutoReviewPanel(props: AutoReviewPanelProps): ReactNode {
  const { useRecords, getRecord, refresh, loadOlder, t } = props
  const snapshot = useRecords(current => current)
  const [filters, setFilters] = useState<ListFilters>({})
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [detail, setDetail] = useState<ReviewRecord | undefined | 'missing'>()
  const [about, setAbout] = useState(false)
  const [policy, setPolicy] = useState<string | undefined>()

  // Each open bumps the request serial; a get that resolves late must not
  // overwrite the detail of a selection made after it.
  const detailRequest = useRef(0)

  const openRecord = useCallback((id: string) => {
    setSelectedId(id)
    setDetail(undefined)
    const request = ++detailRequest.current
    void getRecord(id).then(record => {
      if (request === detailRequest.current) setDetail(record ?? 'missing')
    }, () => {
      if (request === detailRequest.current) setDetail('missing')
    })
  }, [getRecord])

  const closeRecord = useCallback(() => {
    detailRequest.current += 1
    setSelectedId(undefined)
    setDetail(undefined)
  }, [])

  const openAbout = useCallback(() => {
    setAbout(true)
    if (policy !== undefined || snapshot.phase !== 'ready') return
    const first = snapshot.value.records[0]
    if (first === undefined) return
    void getRecord(first.id).then(record => {
      if (record !== undefined) setPolicy(record.sections.policy)
    }, () => {})
  }, [policy, snapshot, getRecord])

  if (selectedId !== undefined) {
    const record = detail
    const backButton = e(Button, { variant: 'ghost', size: 'sm', className: 'arp-link', onClick: closeRecord }, `‹ ${t('detail.back')}`)
    return e('div', { className: 'arp-panel' },
      // The back affordance stays mounted while a get is in flight — a slow or
      // hung host endpoint must not trap the user on the shimmer.
      record === undefined
        ? e('div', { className: 'arp-detail' }, backButton,
          e('div', { className: 'arp-loading' }, e(TextShimmer, { active: true, children: t('list.loading') })))
        : record === 'missing'
          ? e('div', { className: 'arp-detail' }, backButton,
              e('div', { className: 'arp-empty-body' }, t('detail.missing')))
          : e(RecordDetail, {
              record,
              onBack: closeRecord,
              t,
            }))
  }

  const state = emptyStateOf(snapshot)
  const groups = snapshot.phase === 'ready' ? groupSummaries(snapshot.value.records, filters) : undefined
  const status = snapshot.phase === 'ready' ? snapshot.value.status : undefined
  // Options are the host's live registry list plus every tool name the
  // loaded records actually carry — a restarted panel has history to filter
  // long before it has a registry answer — plus any still-selected value so
  // a tool that left the registry stays clearable.
  const registryTools = snapshot.phase === 'ready' ? snapshot.value.status.tools ?? [] : []
  const recordTools = snapshot.phase === 'ready'
    ? snapshot.value.records.flatMap(record => record.action.name === undefined ? [] : [record.action.name])
    : []
  const tools = [...new Set([...registryTools, ...recordTools, ...(filters.tool ?? [])])]
    .sort((left, right) => left.localeCompare(right))

  return e('div', { className: 'arp-panel' },
    e('div', { className: 'arp-header' },
      e(MultiFilter, {
        label: t('filter.risk'),
        options: [
          { id: 'low', label: t('filter.risk.low') },
          { id: 'medium', label: t('filter.risk.medium') },
          { id: 'high', label: t('filter.risk.high') },
        ],
        selected: filters.risk ?? [],
        onChange: (next: readonly string[]) =>
          setFilters(current => {
            const updated = { ...current }
            if (next.length === 0) delete updated.risk
            else updated.risk = next as readonly ReviewRisk[]
            return updated
          }),
      }),
      e(MultiFilter, {
        label: t('filter.decision'),
        options: [
          { id: 'allow', label: t('chip.allow') },
          { id: 'deny', label: t('chip.deny') },
          { id: 'error', label: t('chip.error') },
        ],
        selected: filters.decision ?? [],
        onChange: (next: readonly string[]) =>
          setFilters(current => {
            const updated = { ...current }
            if (next.length === 0) delete updated.decision
            else updated.decision = next as readonly ReviewDecision[]
            return updated
          }),
      }),
      e(MultiFilter, {
        label: t('filter.tool'),
        options: tools.map(name => ({ id: name, label: name })),
        selected: filters.tool ?? [],
        onChange: (next: readonly string[]) =>
          setFilters(current => {
            const updated = { ...current }
            if (next.length === 0) delete updated.tool
            else updated.tool = next
            return updated
          }),
      }),
      e(TimeRange, {
        from: filters.from,
        to: filters.to,
        onChange: next =>
          setFilters(current => {
            const updated = { ...current }
            if (next.from === undefined) delete updated.from
            else updated.from = next.from
            if (next.to === undefined) delete updated.to
            else updated.to = next.to
            return updated
          }),
        t,
      }),
      e('div', { className: 'arp-header-actions' },
        e(Tooltip, {
          label: t('list.refresh'),
          side: 'bottom',
          delayMs: 500,
          children: e('button', {
            type: 'button',
            className: 'arp-header-icon',
            'aria-label': t('list.refresh'),
            onClick: () => refresh(),
          }, e(IconRefreshOutlineRegular, { size: 16 })),
        }),
        e(Tooltip, {
          label: t('about.label'),
          side: 'bottom',
          delayMs: 500,
          children: e('button', {
            type: 'button',
            className: 'arp-header-icon',
            'aria-label': t('about.label'),
            onClick: openAbout,
          }, e(IconInfoOutlineRegular, { size: 16 })),
        }))),
    e(About, { open: about, policy, reviewer: status?.reviewerPackage, onClose: () => setAbout(false), t }),
    snapshot.phase === 'loading'
      ? e('div', { className: 'arp-loading' }, e(TextShimmer, { active: true, children: t('list.loading') }))
      : state !== undefined ? e(EmptyState, { state, status, t })
      : e('div', { className: 'arp-list' },
          groups !== undefined && groups.correlated.length > 0
            ? e('div', { className: 'arp-group' },
                e('div', { className: 'arp-group-title' }, t('group.session')),
                groups.correlated.map(record =>
                  e(RecordRow, { key: record.id, record, onOpen: openRecord, t })))
            : null,
          groups !== undefined && groups.uncorrelated.length > 0
            ? e('div', { className: 'arp-group' },
                e('div', { className: 'arp-group-title' }, t('group.uncorrelated')),
                groups.uncorrelated.map(record =>
                  e(RecordRow, { key: record.id, record, onOpen: openRecord, t })))
            : null,
          // History paging footer: `hasMore` offers the next older page; a
          // paused source (live === false) explains why the list no longer
          // auto-refreshes and how to return to the newest page.
          snapshot.phase === 'ready' && (snapshot.value.page.hasMore || !snapshot.live)
            ? e('div', { className: 'arp-list-footer' },
                snapshot.live ? null
                  : e('div', { className: 'arp-paused' }, t('list.paused')),
                snapshot.value.page.hasMore
                  ? e(Button, {
                      variant: 'outline',
                      size: 'sm',
                      className: 'arp-load-older',
                      onClick: () => loadOlder(),
                    }, t('list.loadOlder'))
                  : null)
            : null))
}

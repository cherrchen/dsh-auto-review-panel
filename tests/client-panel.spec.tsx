// @vitest-environment jsdom
/**
 * The client half, driven the way the browser drives it: the real client
 * entry is applied to a stub client context, the registered tab type and
 * pane body are observed, and every channel call is recorded.
 */

import { StrictMode, createElement, useMemo, useSyncExternalStore, type ReactElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PanelListValue, ReviewRecord, ReviewRecordSummary } from '../src/contract.ts'
import { PANEL_CHANNEL } from '../src/contract.ts'
import * as client from '../src/client/index.ts'
import { en, zh, type Key } from '../src/client/locales.ts'

const SESSION = 'session-1' as SessionId

/** One captured channel call. */
interface Call {
  readonly channel: string
  readonly endpoint: string
  readonly payload: unknown
}

/** One slot registration the plugin made. */
interface Registration {
  readonly options: {
    name: string
    key?: string
    locale?: string
    inject?: (sessionId: SessionId) => Record<string, unknown>
  }
  readonly component: (props: Record<string, unknown>) => ReactElement | null
}

/** Summary fixtures. */
function summary(overrides: Partial<ReviewRecordSummary> = {}): ReviewRecordSummary {
  return {
    id: 'r1',
    capturedAt: '2026-10-20T12:00:00.000Z',
    action: { name: 'read_file', mode: 'native', preview: 'README.md' },
    risk: 'low',
    decision: 'allow',
    correlated: true,
    ...overrides,
  }
}

/** A complete record for `get`. */
function record(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    id: 'r1',
    capturedAt: '2026-10-20T12:00:00.000Z',
    provider: 'deepseek',
    model: 'deepseek-chat',
    requestText: 'ENVIRONMENT\n\n{}',
    sections: {
      policy: 'REVIEW_POLICY\nfull policy text',
      environment: { cwd: '/work' },
      projectInstructions: [],
      filteredHistory: [
        { kind: 'user-message', role: 'human-instruction', source: { kind: 'user', rpcId: 'rpc-1' }, content: [] },
        { kind: 'current-root-instructions', role: 'constraint', source: { kind: 'multi-root-workspace' }, content: [] },
      ],
      pendingAction: { mode: 'native', name: 'read_file', arguments: { path: 'README.md' } },
    },
    reasoning: ['first thought'],
    output: { risk: 'low', decision: 'allow', rawText: '{"risk":"low","decision":"allow"}' },
    correlation: { sessionId: 'session-1', callId: 'call-1', downstreamDecision: 'allow' },
    ...overrides,
  }
}

function listValue(overrides: Partial<PanelListValue> = {}): PanelListValue {
  return {
    records: [summary()],
    status: { reviewerAvailable: true, sessionPreset: 'auto', reviewerPackage: '@deepseek-ai/dsh-experimental-auto-review' },
    ...overrides,
  }
}

/** Dictionary-driven translate for copy assertions. */
function makeT(dict: Record<string, string>) {
  return (key: string, params?: Record<string, unknown>) => {
    let text = dict[key] ?? key
    for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
    return text
  }
}

/** The stub client context, plus what the plugin did with it. */
function mount(options: {
  list?: () => PanelListValue
  listError?: () => unknown
  get?: (id: string) => unknown
  connection?: boolean
} = {}) {
  const calls: Call[] = []
  const registrations: Registration[] = []
  const tabs: { id: string; kind: string; title: () => string; guide?: unknown }[] = []
  const dict = makeT(zh as unknown as Record<string, string>)

  const connection = options.connection === false ? undefined : {
    rpc: {
      call: async (channel: string, endpoint: string, payload: unknown) => {
        calls.push({ channel, endpoint, payload })
        if (options.listError !== undefined) throw options.listError()
        if (endpoint === 'get') {
          const id = (payload as { id?: string }).id ?? ''
          return { ok: true, value: (options.get ?? (() => record()))(id) }
        }
        return { ok: true, value: (options.list ?? listValue)() }
      },
    },
  }
  const ctx = {
    effect: (callback: () => unknown) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register: () => () => {},
      bind: () => dict,
    },
    sidebarRightTabs: {
      register: (definition: { id: string; kind: string; title: () => string; guide?: unknown }) => {
        tabs.push(definition)
        return () => {}
      },
    },
    slots: {
      inject: (_name: string, callback: () => unknown) => {
        callback()
        return () => {}
      },
      register: (registrationOptions: Registration['options'], component: Registration['component']) => {
        registrations.push({ options: registrationOptions, component })
        return () => {}
      },
    },
    get: (name: string) => {
      if (name === 'connection') return connection
      return undefined
    },
  }

  client.apply(ctx as never)
  return { calls, registrations, tabs, dict }
}

/** Render the registered pane body for one session. */
function renderPane(harness: ReturnType<typeof mount>, sessionId: SessionId = SESSION) {
  const registration = harness.registrations.find(entry => entry.options.key === '@dsh-electron/dsh-auto-review-panel')
  expect(registration).toBeDefined()
  const face = registration!.options.inject!(sessionId)
  const source = (face['hooks'] as { records: { getSnapshot(): unknown; subscribe(l: () => void): () => void } }).records
  function Pane(): ReactElement {
    const subscribe = useMemo(() => source.subscribe.bind(source), [])
    const getSnapshot = useMemo(() => source.getSnapshot.bind(source), [])
    const snapshot = useSyncExternalStore(subscribe, getSnapshot)
    return createElement(registration!.component, {
      sessionId,
      useRecords: (selector: (value: unknown) => unknown) => selector(snapshot),
      getRecord: face['getRecord'],
      refresh: face['refresh'],
      t: harness.dict,
    })
  }
  return render(createElement(StrictMode, null, createElement(Pane)))
}

beforeEach(() => {
  document.head.innerHTML = ''
})
afterEach(() => {
  cleanup()
})

describe('two-stage mount', () => {
  it('registers the tab type and the keyed pane body', () => {
    const harness = mount()
    expect(harness.tabs).toHaveLength(1)
    expect(harness.tabs[0]).toMatchObject({ id: '@dsh-electron/dsh-auto-review-panel', kind: 'auto-review' })
    expect(harness.tabs[0]!.title()).toBe(zh['tab.title'])
    const registration = harness.registrations[0]
    expect(registration?.options).toMatchObject({
      name: 'sidebar.right.pane.tab',
      key: '@dsh-electron/dsh-auto-review-panel',
      locale: 'auto-review-panel',
    })
  })

  it('mounts About and refresh as icon buttons at the header right', async () => {
    const harness = mount()
    const { container } = renderPane(harness)
    await screen.findByText('read_file')
    const actions = container.querySelectorAll('.arp-header-actions button')
    expect(actions).toHaveLength(2)
    expect(container.querySelector('[aria-label="' + zh['about.label'] + '"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="' + zh['list.refresh'] + '"]')).not.toBeNull()
    expect(container.querySelectorAll('.arp-header-actions svg')).toHaveLength(2)
  })

  it('injects the session-bound face over PANEL_CHANNEL', async () => {
    const harness = mount()
    renderPane(harness)
    await waitFor(() => expect(harness.calls.some(call => call.endpoint === 'list')).toBe(true))
    const list = harness.calls.find(call => call.endpoint === 'list')!
    expect(list.channel).toBe(PANEL_CHANNEL)
    expect(list.payload).toEqual({ sessionId: 'session-1' })
  })
})

describe('the five-field list row', () => {
  it('lays out name+mode then preview then reason+time across three lines, tags on the right', async () => {
    const harness = mount({
      list: () => listValue({
        records: [summary({ risk: 'high', decision: 'deny', reason: 'sends credentials out' })],
      }),
    })
    const { container } = renderPane(harness)
    await screen.findByText('read_file')
    const row = container.querySelector('.arp-row')!
    // Three lines, no divider between rows.
    expect(row.children).toHaveLength(3)
    expect(row.querySelector('.arp-row-name')?.textContent).toBe('read_file')
    expect(row.querySelector('.arp-badge')?.textContent).toBe(zh['mode.native'])
    expect(row.querySelector('.arp-risk-tag.arp-risk-high')).not.toBeNull()
    expect(row.querySelector('.arp-chip')?.textContent).toBe(zh['chip.deny'])
    expect(row.querySelector('.arp-row-preview-line .arp-row-preview')?.textContent).toBe('README.md')
    const sub = row.querySelector('.arp-row-sub')!
    expect(sub.querySelector('.arp-row-reason')?.textContent).toBe('sends credentials out')
    expect(sub.querySelector('.arp-row-time')?.textContent).toBeTruthy()
  })

  it('shows the protocol note for an allow verdict', async () => {
    const harness = mount()
    const { container } = renderPane(harness)
    await screen.findByText('read_file')
    expect(container.querySelector('.arp-row-reason')?.textContent).toBe(zh['reason.none'])
  })

  it('marks a failed reviewer with the failed chip', async () => {
    const harness = mount({
      list: () => listValue({ records: [summary({ finish: { kind: 'error', code: 'RATE_LIMIT' } })] }),
    })
    const { container } = renderPane(harness)
    await screen.findByText('read_file')
    expect(container.querySelector('.arp-chip-failed')).not.toBeNull()
  })

  it('keeps the uncorrelated group visible under the session filter', async () => {
    const harness = mount({
      list: () => listValue({
        records: [
          summary({ id: 'r1', correlated: true }),
          summary({ id: 'r2', correlated: false, risk: 'high', decision: 'deny', reason: 'wipes /' }),
        ],
      }),
    })
    renderPane(harness)
    await screen.findByText(zh['group.uncorrelated'])
    expect(screen.getByText(zh['group.session'])).toBeTruthy()
    expect(screen.getByText('wipes /')).toBeTruthy()
  })

  it('filters by risk without hiding the mechanism', async () => {
    const harness = mount({
      list: () => listValue({
        records: [
          summary({ id: 'low', risk: 'low' }),
          summary({ id: 'high', risk: 'high', decision: 'deny', reason: 'r', action: { name: 'rm', mode: 'native' } }),
        ],
      }),
    })
    const { container } = renderPane(harness)
    await screen.findByText('rm')
    // The field label is the trigger, never a menu item.
    fireEvent.click(screen.getByText(zh['filter.risk']))
    expect(screen.queryByRole('menuitem', { name: zh['filter.risk'] })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: zh['filter.risk.high'] }))
    await waitFor(() => expect(container.querySelectorAll('.arp-row')).toHaveLength(1))
    expect(container.querySelector('.arp-row-name')?.textContent).toBe('rm')
  })
})

describe('the four empty states', () => {
  it.each([
    ['reviewer-unavailable', { records: [], status: { reviewerAvailable: false } }],
    ['not-auto', { records: [], status: { reviewerAvailable: true, sessionPreset: 'workspace-write' } }],
    ['no-records', { records: [], status: { reviewerAvailable: true, sessionPreset: 'auto' } }],
    ['no-records', { records: [], status: { reviewerAvailable: true } }],
  ] as const)('renders %s truthfully', async (state, list) => {
    const harness = mount({ list: () => listValue(list as PanelListValue) })
    renderPane(harness)
    await screen.findByText(zh[`empty.${state}.title` as Key])
    expect(document.querySelector(`.arp-empty-${state}`)).not.toBeNull()
  })

  it('reports the channel-missing state when the host endpoint is absent', async () => {
    const harness = mount({ connection: false })
    renderPane(harness)
    await screen.findByText(zh['empty.channel-missing.title'])
  })

  it('reports the channel-missing state when the call fails', async () => {
    const harness = mount({ listError: () => new Error('no handler') })
    renderPane(harness)
    await screen.findByText(zh['empty.channel-missing.title'])
  })
})

describe('the detail view', () => {
  async function openDetail(harness: ReturnType<typeof mount>) {
    const view = renderPane(harness)
    await screen.findByText('read_file')
    fireEvent.click(screen.getByText('read_file').closest('.arp-row')!)
    await waitFor(() => expect(harness.calls.some(call => call.endpoint === 'get')).toBe(true))
    await screen.findByText('deepseek/deepseek-chat')
    return view
  }

  it('fetches the record and shows the overview card plus the tab switcher', async () => {
    const harness = mount()
    const { container } = await openDetail(harness)
    expect(harness.calls.find(call => call.endpoint === 'get')?.payload).toEqual({ id: 'r1' })
    const overview = container.querySelector('.arp-overview')!
    expect(overview.textContent).toContain('deepseek/deepseek-chat')
    expect(overview.textContent).toContain('2026-10-20T12:00:00.000Z')
    expect(overview.textContent).toContain('read_file')
    expect(overview.textContent).toContain('README.md')
    const tabs = [...container.querySelectorAll('[role="tab"]')]
    expect(tabs.map(tab => tab.textContent)).toEqual([
      zh['detail.toolCall'], zh['detail.context'], zh['detail.project'], zh['detail.result'],
    ])
    // The default panel is tool_call, parsed by the JsonTree view.
    const panel = container.querySelector('[role="tabpanel"]')!
    expect(panel.textContent).toContain('name')
    expect(panel.textContent).toContain('read_file')
    expect(panel.textContent).toContain('README.md')
    expect(container.querySelectorAll('.arp-tab-panel')).toHaveLength(1)
  })

  it('shows FILTERED_HISTORY entries by their original kind/role without reclassification', async () => {
    const harness = mount()
    const { container } = await openDetail(harness)
    fireEvent.click(screen.getByRole('tab', { name: zh['detail.context'] }))
    const panel = container.querySelector('[role="tabpanel"]')!
    const titles = [...panel.querySelectorAll('.arp-section-title')].map(entry => entry.textContent)
    expect(titles.some(text => text?.includes('user-message') && text.includes('human-instruction'))).toBe(true)
    expect(titles.some(text => text?.includes('current-root-instructions'))).toBe(true)
  })

  it('keeps thinking folded behind 思考 and shows the raw output in 审查结果', async () => {
    const harness = mount()
    const { container } = await openDetail(harness)
    fireEvent.click(screen.getByRole('tab', { name: zh['detail.result'] }))
    const panel = container.querySelector('[role="tabpanel"]')!
    // 思考 is a collapsed disclosure; the parsed verdict fields follow it.
    expect(screen.getByText(zh['detail.thinking'])).toBeTruthy()
    expect(panel.textContent).not.toContain('first thought')
    expect(panel.textContent).toContain('risk')
    expect(panel.textContent).toContain('allow')
    fireEvent.click(screen.getByText(zh['detail.thinking']))
    await waitFor(() => expect(panel.textContent).toContain('first thought'))
  })

  it('shows the waterfall verdict and host outcome lines only when observed', async () => {
    const harness = mount({
      get: () => Promise.resolve(record({
        correlation: {
          sessionId: 'session-1',
          callId: 'call-1',
          downstreamDecision: 'deny',
          denialInfo: { name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED' },
        },
        hostOutcome: {
          toolResult: { isError: true, name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED' },
        },
      })),
    })
    const { container } = await openDetail(harness)
    const overview = container.querySelector('.arp-overview')!
    expect(overview.textContent).toContain(zh['detail.downstream'])
    expect(overview.textContent).toContain('deny · AUTO_REVIEW_DENIED')
    expect(overview.textContent).toContain(zh['detail.hostOutcome'])
    expect(overview.textContent).toContain('AUTO_REVIEW_DENIED')
  })

  it('renders the approval surface the upstream ask routed through', async () => {
    const harness = mount({
      get: () => Promise.resolve(record({
        hostOutcome: { approval: { outcome: 'allowed-once' } },
      })),
    })
    const { container } = await openDetail(harness)
    const overview = container.querySelector('.arp-overview')!
    expect(overview.textContent).toContain(`${zh['host.approval']} → allowed-once`)
  })

  it('omits both evidence lines when no anchor or event exists', async () => {
    const harness = mount({
      get: () => Promise.resolve(record({ correlation: undefined })),
    })
    const { container } = await openDetail(harness)
    const overview = container.querySelector('.arp-overview')!
    expect(overview.textContent).not.toContain(zh['detail.downstream'])
    expect(overview.textContent).not.toContain(zh['detail.hostOutcome'])
  })

  it('keeps the newer selection when an earlier get resolves late', async () => {
    const gates = new Map<string, PromiseWithResolvers<ReviewRecord>>()
    const harness = mount({
      list: () => listValue({
        records: [
          summary({ id: 'r1', action: { name: 'read_file', mode: 'native' } }),
          summary({ id: 'r2', action: { name: 'write_file', mode: 'native' } }),
        ],
      }),
      get: (id) => {
        const gate = Promise.withResolvers<ReviewRecord>()
        gates.set(id, gate)
        return gate.promise
      },
    })
    const { container } = renderPane(harness)
    await screen.findByText('read_file')
    fireEvent.click(screen.getByText('read_file').closest('.arp-row')!)
    // The still-loading detail can be left behind; its late answer must not win.
    fireEvent.click(await screen.findByRole('button', { name: `‹ ${zh['detail.back']}` }))
    fireEvent.click(screen.getByText('write_file').closest('.arp-row')!)
    gates.get('r2')!.resolve(record({ id: 'r2', provider: 'new-provider', model: 'new-model' }))
    await screen.findByText('new-provider/new-model')
    gates.get('r1')!.resolve(record({ id: 'r1', provider: 'stale-provider', model: 'stale-model' }))
    await waitFor(() => expect(screen.queryByText('stale-provider/stale-model')).toBeNull())
    expect(container.textContent).toContain('new-provider/new-model')
  })

  it('never renders REVIEW_POLICY inside the detail', async () => {
    const harness = mount()
    const { container } = await openDetail(harness)
    expect(container.textContent).not.toContain('REVIEW_POLICY')
  })

  it('shows REVIEW_POLICY exactly once — inside the About popover', async () => {
    const harness = mount()
    const { container } = renderPane(harness)
    await screen.findByText('read_file')
    fireEvent.click(screen.getByRole('button', { name: zh['about.label'] }))
    await waitFor(() => expect(container.textContent).toContain('REVIEW_POLICY\nfull policy text'))
    expect(container.querySelectorAll('.arp-about-policy')).toHaveLength(1)
    expect(container.textContent).toContain('@deepseek-ai/dsh-experimental-auto-review')
  })

})

describe('bilingual copy', () => {
  it('keeps the zh/en dictionaries in key parity', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('renders the English copy when the locale binds en', () => {
    const dict = makeT(en as unknown as Record<string, string>)
    expect(dict('tab.title')).toBe('Reviews')
    expect(dict('empty.no-records.title')).toBe('No review records yet')
  })
})

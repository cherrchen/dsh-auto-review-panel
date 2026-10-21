/**
 * The polling records source: subscribe starts the interval, the last
 * unsubscribe stops it, identical wire answers do not republish, and a
 * request that never resolves is abandoned at the timeout rather than
 * allowed to wedge every later poll.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PanelListValue, ReviewRecordSummary } from '../src/contract.ts'
import type { PanelListApi, PanelListOptions } from '../src/client/panel-client.ts'
import { createRecordsSource } from '../src/client/source.ts'

const LIST: PanelListValue = {
  records: [],
  status: { reviewerAvailable: true },
  page: { hasMore: false },
}

/** A PanelListApi with a stubbed list endpoint. */
function api(list: PanelListApi['list']): PanelListApi {
  return { list, get: async () => undefined }
}

/** One summary row; `id`/`capturedAt` order the pages. */
function row(id: string, capturedAt = '2026-10-20T12:00:00.000Z'): ReviewRecordSummary {
  return {
    id,
    capturedAt,
    action: { name: 'read_file', mode: 'native', preview: 'README.md' },
    risk: 'low',
    decision: 'allow',
    correlated: false,
  }
}

/** A list answer whose page block points one page older. */
function page(records: readonly ReviewRecordSummary[], hasMore = false, before?: string): PanelListValue {
  return {
    records: [...records],
    status: { reviewerAvailable: true },
    page: { hasMore, ...(before === undefined ? {} : { before }) },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the records source', () => {
  it('starts failed when no api exists', () => {
    const source = createRecordsSource(undefined, 'session-1')
    expect(source.getSnapshot().phase).toBe('failed')
  })

  it('publishes one ready snapshot for identical polls', async () => {
    vi.useFakeTimers()
    const source = createRecordsSource(api(async () => LIST), 'session-1', { intervalMs: 5 })
    let publishes = 0
    const unsubscribe = source.subscribe(() => { publishes += 1 })
    await vi.advanceTimersByTimeAsync(30)
    expect(source.getSnapshot().phase).toBe('ready')
    expect(publishes).toBe(1)
    unsubscribe()
  })

  it('publishes a failed phase on call failure and recovers on the next answer', async () => {
    vi.useFakeTimers()
    let calls = 0
    const source = createRecordsSource(api(() => {
      calls += 1
      return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(LIST)
    }), 'session-1', { intervalMs: 5 })
    const unsubscribe = source.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(source.getSnapshot().phase).toBe('failed')
    await vi.advanceTimersByTimeAsync(10)
    expect(source.getSnapshot().phase).toBe('ready')
    unsubscribe()
  })

  it('abandons a hung list call at the timeout instead of wedging the source', async () => {
    vi.useFakeTimers()
    let calls = 0
    const source = createRecordsSource(api(() => {
      calls += 1
      return calls === 1 ? new Promise<PanelListValue>(() => {}) : Promise.resolve(LIST)
    }), 'session-1', { intervalMs: 100, timeoutMs: 50 })
    const unsubscribe = source.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(10)
    expect(source.getSnapshot().phase).toBe('loading')
    await vi.advanceTimersByTimeAsync(60)
    expect(source.getSnapshot().phase).toBe('failed')
    await vi.advanceTimersByTimeAsync(100)
    expect(source.getSnapshot().phase).toBe('ready')
    unsubscribe()
  })
})

describe('history paging', () => {
  it('loadOlder appends the strictly-older page and pauses polling', async () => {
    vi.useFakeTimers()
    const seen: (PanelListOptions | undefined)[] = []
    const list: PanelListApi['list'] = async (_sessionId, options) => {
      seen.push(options)
      return options?.before === undefined
        ? page([row('r1')], true, '2026-10-20T12:00:00.000Z|r1')
        : page([row('r0', '2026-10-20T11:00:00.000Z')])
    }
    const source = createRecordsSource(api(list), 'session-1', { intervalMs: 5 })
    const unsubscribe = source.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    source.loadOlder()
    await vi.advanceTimersByTimeAsync(0)
    const snapshot = source.getSnapshot()
    expect(snapshot.phase).toBe('ready')
    if (snapshot.phase !== 'ready') throw new Error('expected ready')
    expect(snapshot.value.records.map(record => record.id)).toEqual(['r1', 'r0'])
    expect(snapshot.live).toBe(false)
    // The pause: no more list calls while older pages sit on screen.
    const callsAtPause = seen.length
    await vi.advanceTimersByTimeAsync(30)
    expect(seen).toHaveLength(callsAtPause)
    unsubscribe()
  })

  it('ignores loadOlder before the first page or after the cursor ran out', async () => {
    vi.useFakeTimers()
    let calls = 0
    const source = createRecordsSource(api(async () => {
      calls += 1
      return LIST
    }), 'session-1', { intervalMs: 5 })
    const sourceBare = source
    const unsubscribe = source.subscribe(() => {})
    // Never polled yet (first page in flight is unresolved-but-empty here
    // because the fake timers have not advanced); once it lands the page
    // reports hasMore: false — either way no cursor exists to page from.
    sourceBare.loadOlder()
    await vi.advanceTimersByTimeAsync(0)
    sourceBare.loadOlder()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    unsubscribe()
  })

  it('refresh drops the older rows, resumes the poll, and drops a stale older answer', async () => {
    vi.useFakeTimers()
    let releaseOlder: ((value: PanelListValue) => void) | undefined
    const list: PanelListApi['list'] = async (_sessionId, options) => {
      if (options?.before !== undefined) {
        return new Promise<PanelListValue>(resolve => { releaseOlder = resolve })
      }
      return page([row('r1')], true, '2026-10-20T12:00:00.000Z|r1')
    }
    const source = createRecordsSource(api(list), 'session-1', { intervalMs: 5 })
    const unsubscribe = source.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    source.loadOlder()
    await vi.advanceTimersByTimeAsync(0)
    // Refresh while the older page is in flight: the answer must not come back.
    source.refresh()
    releaseOlder?.(page([row('r0', '2026-10-20T11:00:00.000Z')]))
    await vi.advanceTimersByTimeAsync(10)
    const snapshot = source.getSnapshot()
    if (snapshot.phase !== 'ready') throw new Error('expected ready')
    expect(snapshot.value.records.map(record => record.id)).toEqual(['r1'])
    expect(snapshot.live).toBe(true)
    unsubscribe()
  })

  it('an empty first-page answer clears the loaded older rows after a wipe', async () => {
    vi.useFakeTimers()
    let wiped = false
    const list: PanelListApi['list'] = async (_sessionId, options) => {
      if (options?.before !== undefined) return page([row('r0', '2026-10-20T11:00:00.000Z')])
      return wiped ? page([]) : page([row('r1')], true, '2026-10-20T12:00:00.000Z|r1')
    }
    const source = createRecordsSource(api(list), 'session-1', { intervalMs: 5 })
    const unsubscribe = source.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    source.loadOlder()
    await vi.advanceTimersByTimeAsync(0)
    wiped = true
    source.refresh()
    await vi.advanceTimersByTimeAsync(10)
    const snapshot = source.getSnapshot()
    if (snapshot.phase !== 'ready') throw new Error('expected ready')
    expect(snapshot.value.records).toEqual([])
    expect(snapshot.live).toBe(true)
    unsubscribe()
  })

  it('keeps the loaded rows when one older page fails', async () => {
    vi.useFakeTimers()
    let failed = false
    const list: PanelListApi['list'] = async (_sessionId, options) => {
      if (options?.before !== undefined) {
        if (failed) throw new Error('boom')
        failed = true
        return page([row('r0', '2026-10-20T11:00:00.000Z')], true, '2026-10-20T11:00:00.000Z|r0')
      }
      return page([row('r1')], true, '2026-10-20T12:00:00.000Z|r1')
    }
    const source = createRecordsSource(api(list), 'session-1', { intervalMs: 5 })
    const unsubscribe = source.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    source.loadOlder()
    await vi.advanceTimersByTimeAsync(0)
    source.loadOlder()
    await vi.advanceTimersByTimeAsync(0)
    const snapshot = source.getSnapshot()
    if (snapshot.phase !== 'ready') throw new Error('expected ready')
    expect(snapshot.value.records.map(record => record.id)).toEqual(['r1', 'r0'])
    unsubscribe()
  })
})

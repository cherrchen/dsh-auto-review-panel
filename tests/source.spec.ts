/**
 * The polling records source: subscribe starts the interval, the last
 * unsubscribe stops it, identical wire answers do not republish, and a
 * request that never resolves is abandoned at the timeout rather than
 * allowed to wedge every later poll.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PanelListValue } from '../src/contract.ts'
import type { PanelApi } from '../src/client/panel-client.ts'
import { createRecordsSource } from '../src/client/source.ts'

const LIST: PanelListValue = {
  records: [],
  status: { reviewerAvailable: true },
}

/** A PanelApi with a stubbed list endpoint. */
function api(list: PanelApi['list']): PanelApi {
  return { list, get: async () => undefined }
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

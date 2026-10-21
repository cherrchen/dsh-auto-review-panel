/**
 * PANEL_CHANNEL endpoint shapes and headless degradation.
 *
 * `host.handle` is the carrier-neutral endpoint body; `mountPanelChannel` is
 * the soft seam that only mounts where a Connection and web carrier exist.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountPanelChannel } from '../src/channel.ts'
import type { PanelListValue, ReviewRecord } from '../src/contract.ts'
import { capture, makeHost } from './support/review-fixtures.ts'

function listValue(result: unknown): PanelListValue {
  expect(result).toMatchObject({ ok: true })
  if (typeof result !== 'object' || result === null || !('value' in result)) {
    throw new Error('expected an ok result')
  }
  return (result as { value: PanelListValue }).value
}

describe('panel endpoints', () => {
  it('list returns records newest first with the status block', async () => {
    const host = makeHost()
    await capture(host)
    const value = listValue(await host.handle('list', undefined))
    expect(value.records.map(record => record.id)).toEqual(['review-1'])
    expect(value.status).toEqual({ reviewerAvailable: true })
  })

  it('list under a session filter keeps uncorrelated records and adds sessionPreset', async () => {
    const host = makeHost()
    await capture(host)
    const value = listValue(await host.handle('list', { sessionId: 'session-1' }))
    expect(value.records.map(record => record.id)).toEqual(['review-1'])
    expect(value.status).toEqual({ reviewerAvailable: true, sessionPreset: 'auto' })
  })

  it('list under an unknown session omits sessionPreset', async () => {
    const host = makeHost()
    const value = listValue(await host.handle('list', { sessionId: 'ghost' }))
    expect(value.status).toEqual({ reviewerAvailable: true })
  })

  it('lists the live registry tools in the status, sorted and without run_code', async () => {
    const host = makeHost({ toolNames: ['run_code', 'read', 'bash', 'read'] })
    const value = listValue(await host.handle('list', { sessionId: 'session-1' }))
    expect(value.status.tools).toEqual(['bash', 'read'])
  })

  it('reports reviewerAvailable false when the Auto preset is not advertised', async () => {
    const host = makeHost({ names: ['workspace-write'] })
    const value = listValue(await host.handle('list', undefined))
    expect(value.status.reviewerAvailable).toBe(false)
  })

  it('keeps reviewerAvailable true when the preset catalog is unreadable', async () => {
    const names = new Proxy<readonly string[]>([], {
      get: () => {
        throw new Error('catalog unreadable')
      },
    })
    const host = makeHost({ names })
    const value = listValue(await host.handle('list', undefined))
    expect(value.status.reviewerAvailable).toBe(true)
  })

  it('rejects a malformed list payload', async () => {
    const host = makeHost()
    expect(await host.handle('list', { sessionId: 42 })).toMatchObject({
      ok: false,
      error: { code: 'panel/bad-request' },
    })
    expect(await host.handle('list', 'session-1')).toMatchObject({
      ok: false,
      error: { code: 'panel/bad-request' },
    })
  })

  it('get returns the frozen record by id and fails closed on a miss', async () => {
    const host = makeHost()
    await capture(host)
    const result = await host.handle('get', { id: 'review-1' })
    expect(result).toMatchObject({ ok: true })
    const record = (result as { value: ReviewRecord }).value
    expect(record.requestText).toContain('PENDING_ACTION')
    expect(Object.isFrozen(record)).toBe(true)

    expect(await host.handle('get', { id: 'nope' })).toMatchObject({
      ok: false,
      error: { code: 'review-record-not-found' },
    })
    expect(await host.handle('get', {})).toMatchObject({
      ok: false,
      error: { code: 'panel/bad-request' },
    })
  })

  it('rejects an unknown endpoint', async () => {
    const host = makeHost()
    expect(await host.handle('purge', {})).toMatchObject({
      ok: false,
      error: { code: 'panel/unknown-endpoint' },
    })
  })
})

describe('headless degradation', () => {
  it('mounts nothing and does not throw without connection and webServer', () => {
    const host = makeHost()
    const root = new Context()
    expect(() => mountPanelChannel(root, host)).not.toThrow()
    expect(root.get('connection')).toBeUndefined()
  })
})

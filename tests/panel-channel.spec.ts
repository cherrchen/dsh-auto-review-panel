/**
 * The panel channel's seam discovery (src/compat/panel-channel.ts).
 *
 * Two host seams can carry `PANEL_CHANNEL`: the Connection's own
 * `rpc.handle`, and — when that seam cannot resolve the web carrier in a
 * composed profile — a prefix route registered on `webServer` that reuses
 * `connection.admit` for the authentication fence. Both must decode the
 * browser's RPC envelope into the same endpoint body, and neither may mount
 * an unauthenticated route.
 */

import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mountPanelChannelSeam } from '../src/compat/panel-channel.ts'
import { PANEL_CHANNEL } from '../src/contract.ts'
import { capture, makeHost } from './support/review-fixtures.ts'

/** One captured response. */
interface CapturedResponse {
  status: number | undefined
  headers: Record<string, string> | undefined
  body: string
}

/** The request options a fake node request needs. */
interface FakeRequestOptions {
  readonly method?: string
  readonly url?: string
  readonly headers?: Record<string, string>
  readonly body?: string
}

/**
 * Build a node request stand-in: headers, an async-iterable body, and the
 * `destroy` the 413 path calls.
 */
function fakeRequest(options: FakeRequestOptions = {}): IncomingMessage {
  const chunks = options.body === undefined ? [] : [Buffer.from(options.body)]
  return {
    method: options.method ?? 'POST',
    url: options.url ?? `${PANEL_CHANNEL}/list`,
    headers: options.headers ?? { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
    destroy: () => {},
  } as unknown as IncomingMessage
}

/** Build a node response stand-in that records what the handler wrote. */
function fakeResponse(): { response: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: undefined, headers: undefined, body: '' }
  const response = {
    writeHead: (status: number, headers?: Record<string, string>) => {
      captured.status = status
      captured.headers = headers
      return response
    },
    end: (body?: string) => { captured.body = body ?? '' },
  }
  return { response: response as unknown as ServerResponse, captured }
}

/** One browser RPC envelope. */
function envelope(endpoint: string, payload: unknown, rpcId = 'rpc-1'): string {
  return JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload })
}

/** The web-server seam that captures every registered route. */
function routeSeam(routes: { kind: string; path: string; handler: unknown }[] = []) {
  return {
    register: (route: { kind: string; path: string; handler: unknown }) => {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
  }
}

describe('channel seam discovery', () => {
  it('prefers the connection channel seam and disposes through it', () => {
    let disposed = 0
    const channels: string[] = []
    const routes: { kind: string; path: string; handler: unknown }[] = []
    const mount = mountPanelChannelSeam({
      rpc: {
        handle: (channel: string) => {
          channels.push(channel)
          return async () => { disposed += 1 }
        },
      },
    }, routeSeam(routes), PANEL_CHANNEL, async () => ({ ok: true, value: null }))
    expect(mount?.seam).toBe('rpc')
    expect(channels).toEqual([PANEL_CHANNEL])
    expect(routes).toHaveLength(0)
    void mount?.dispose()
    expect(disposed).toBe(1)
  })

  it('falls back to a named route when the channel seam cannot resolve its web carrier', () => {
    const routes: { kind: string; path: string; handler: unknown }[] = []
    const mount = mountPanelChannelSeam({
      rpc: {
        handle: () => {
          throw new Error('cannot get property "webServer" without inject')
        },
      },
      admit: () => ({ peer: {} }),
    }, routeSeam(routes), PANEL_CHANNEL, async () => ({ ok: true, value: null }))
    expect(mount?.seam).toBe('route')
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: PANEL_CHANNEL })
    void mount?.dispose()
    expect(routes).toHaveLength(0)
  })

  it('mounts nothing without an authentication fence', () => {
    const routes: { kind: string; path: string; handler: unknown }[] = []
    const mount = mountPanelChannelSeam(
      { rpc: { handle: () => { throw new Error('no web carrier') } } },
      routeSeam(routes),
      PANEL_CHANNEL,
      async () => ({ ok: true, value: null }),
    )
    expect(mount).toBeUndefined()
    expect(routes).toHaveLength(0)
  })

  it('mounts nothing without a web carrier', () => {
    expect(mountPanelChannelSeam(
      { rpc: { handle: () => { throw new Error('no web carrier') } } },
      undefined,
      PANEL_CHANNEL,
      async () => ({ ok: true, value: null }),
    )).toBeUndefined()
    expect(mountPanelChannelSeam(undefined, routeSeam(), PANEL_CHANNEL, async () => ({ ok: true, value: null })))
      .toBeUndefined()
  })
})

describe('fallback route transport', () => {
  /** Mount the fallback over a real host and return its route handler. */
  async function fallbackRoute(admission: unknown = { peer: {} }) {
    const host = makeHost()
    await capture(host)
    const routes: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }[] = []
    const mount = mountPanelChannelSeam(
      { rpc: { handle: () => { throw new Error('cannot get property "webServer" without inject') } }, admit: () => admission },
      routeSeam(routes),
      PANEL_CHANNEL,
      (endpoint, payload) => host.handle(endpoint, payload),
    )
    expect(mount?.seam).toBe('route')
    const route = routes[0]
    if (route === undefined) throw new Error('expected a registered route')
    return { host, route, mount }
  }

  it('answers an admitted envelope with the same endpoint result the channel seam would', async () => {
    const { route } = await fallbackRoute()
    const { response, captured } = fakeResponse()
    await route.handler(fakeRequest({ body: envelope('list', { sessionId: 'session-1' }) }), response)
    expect(captured.status).toBe(200)
    expect(captured.headers).toMatchObject({ 'content-type': 'application/json' })
    const parsed = JSON.parse(captured.body) as { type: string; rpcId: string; result: { ok: boolean; value: { records: unknown[] } } }
    expect(parsed.type).toBe('server-response')
    expect(parsed.rpcId).toBe('rpc-1')
    expect(parsed.result.ok).toBe(true)
    expect(parsed.result.value.records).toHaveLength(1)
  })

  it('refuses an unauthenticated request before reading the body', async () => {
    const { route } = await fallbackRoute({ rejection: 401 })
    const { response, captured } = fakeResponse()
    await route.handler(fakeRequest({ body: envelope('list', {}) }), response)
    expect(captured.status).toBe(401)
    expect(captured.body).toBe('unauthorized')
  })

  it('answers an envelope whose method disagrees with the endpoint', async () => {
    const { route } = await fallbackRoute()
    const { response, captured } = fakeResponse()
    await route.handler(fakeRequest({ body: envelope('get', { id: 'review-1' }) }), response)
    expect(captured.status).toBe(200)
    const parsed = JSON.parse(captured.body) as { result: { ok: boolean; error: { code: string } } }
    expect(parsed.result).toMatchObject({ ok: false, error: { code: 'gateway/bad-request' } })
  })

  it('answers an unknown endpoint through the host body', async () => {
    const { route } = await fallbackRoute()
    const { response, captured } = fakeResponse()
    await route.handler(fakeRequest({ url: `${PANEL_CHANNEL}/purge`, body: envelope('purge', {}) }), response)
    expect(captured.status).toBe(200)
    const parsed = JSON.parse(captured.body) as { result: { ok: boolean; error: { code: string } } }
    expect(parsed.result).toMatchObject({ ok: false, error: { code: 'panel/unknown-endpoint' } })
  })

  it('rejects a non-POST request, a foreign path, and a non-JSON body', async () => {
    const { route } = await fallbackRoute()
    const cases: readonly [FakeRequestOptions, number][] = [
      [{ method: 'GET' }, 404],
      [{ url: '/somewhere-else/list' }, 404],
      [{ headers: { 'content-type': 'text/plain' }, body: envelope('list', {}) }, 415],
      [{ body: 'not json' }, 400],
    ]
    for (const [options, status] of cases) {
      const { response, captured } = fakeResponse()
      await route.handler(fakeRequest(options), response)
      expect(captured.status, JSON.stringify(options)).toBe(status)
    }
  })
})

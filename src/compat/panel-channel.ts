/**
 * The panel's Connection channel, mounted on whichever seam the host exposes.
 *
 * The panel speaks one wire contract — a `POST <channel>/<endpoint>` envelope
 * with a `{type: 'client-request', rpcId, method, payload}` body — but the host
 * offers more than one way to own it:
 *
 * 1. `connection.rpc.handle(channel, handler)` registers an authenticated
 *    channel prefix and returns its physical route. This is the seam the panel
 *    has always used, and it is preferred whenever it works.
 * 2. That seam stopped resolving its own `webServer` dependency when cordis
 *    changed service resolution to the definition site (4.0.6-alpha.2): the
 *    channel service's construction context never injects `webServer`, so
 *    `rpc.handle` throws `cannot get property "webServer" without inject` in
 *    any composed profile, where the web server is a sibling row. Nothing in
 *    that failure is release-specific to compare against, so this module
 *    probes it structurally and falls back to registering the same prefix
 *    route on `webServer` directly.
 *
 *    The fallback reuses the two host-owned pieces that still resolve: the
 *    connection's `admit()` (the browser/API credential and Host/Origin
 *    fence) and the web server's named-route registry. Only the envelope
 *    framing — which `rpc.handle` would otherwise own — is reproduced here,
 *    with the same status codes, failure codes, and response shape, because
 *    the browser client's `rpc.call` validates exactly that envelope.
 *
 * Both seams hand the decoded endpoint to the same handler, so the endpoint
 * body never learns which transport carried it. A composition that exposes
 * neither seam (headless, or a host without authentication) mounts nothing:
 * the panel degrades to its channel-missing empty state rather than exposing
 * an unauthenticated route.
 *
 * @module @dsh-electron/dsh-auto-review-panel/compat/panel-channel
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PanelRpcResult } from '../contract.ts'

/** The endpoint body both seams dispatch to. */
export interface PanelChannelHandler {
  (endpoint: string, payload: unknown): Promise<PanelRpcResult<unknown>>
}

/** The `ctx.connection` surface this module reads. */
export interface PanelConnectionSurface {
  readonly rpc?: { readonly handle?: unknown } | undefined
  readonly admit?: ((request: { readonly headers: unknown }) => unknown) | undefined
}

/** The named-route shape the fallback registers on `ctx.webServer`. */
export interface PanelChannelRoute {
  readonly kind: 'prefix'
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** The `ctx.webServer` surface this module reads. */
export interface PanelWebServerSurface {
  register(route: PanelChannelRoute): () => void
}

/** Which host seam owns the channel. */
export type PanelChannelSeam = 'rpc' | 'route'

/** A mounted channel. */
export interface PanelChannelMount {
  /** The seam that accepted the registration. */
  readonly seam: PanelChannelSeam
  /** Remove the channel and its physical route. */
  dispose(): void | Promise<void>
}

/** The largest request body the fallback buffers; panel payloads are tiny. */
const MAX_BODY_BYTES = 1024 * 1024

/** One endpoint path segment: the characters the browser client can send. */
const ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/u

/** Whether one unknown value is a JSON object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Compose one RPC response envelope, success or failure. */
function envelope(rpcId: string, result: PanelRpcResult<unknown>): string {
  return JSON.stringify({ type: 'server-response', rpcId, result })
}

/** Compose one failure result. */
function failure(code: string, message: string): PanelRpcResult<never> {
  return { ok: false, error: { code, message, details: {} } }
}

/**
 * The channel-relative endpoint of one request path, or `undefined` when the
 * path is not this channel's or a segment is not sendable.
 * @param channel - the absolute channel prefix, e.g. `/auto-review-panel`.
 * @param url - the request target.
 * @returns the endpoint, or `undefined`.
 */
function endpointOf(channel: string, url: string | undefined): string | undefined {
  let pathname: string
  try {
    pathname = new URL(url ?? '/', 'http://panel.internal').pathname
  } catch {
    return undefined
  }
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT.test(segment))) {
    return undefined
  }
  return endpoint
}

/** The rejection status of one admission outcome, or `undefined` when admitted. */
function rejectionOf(admission: unknown): 401 | 403 | undefined {
  if (!isRecord(admission)) return 403
  if (admission['rejection'] === 401 || admission['rejection'] === 403) return admission['rejection']
  return 'peer' in admission ? undefined : 403
}

/** Read one request body, or `undefined` when it exceeds the panel's cap. */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    received += buffer.byteLength
    if (received > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Write one JSON response body. */
function writeJson(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body)
}

/**
 * Serve one fallback-seam request with the framing `rpc.handle` would own.
 *
 * The order mirrors the host's own channel handler: admit, method and endpoint,
 * media type, JSON body, envelope, endpoint match, handler. A status code is
 * chosen for transport-level failures; an envelope-level failure answers with
 * the error envelope the browser client already knows.
 * @param connection - the host connection surface.
 * @param channel - the absolute channel prefix.
 * @param handle - the endpoint body.
 * @param req - the incoming request.
 * @param res - the response the handler owns.
 */
async function serveRoute(
  connection: PanelConnectionSurface,
  channel: string,
  handle: PanelChannelHandler,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const admission = connection.admit?.({ headers: req.headers })
  const rejection = rejectionOf(admission)
  if (rejection !== undefined) {
    res.writeHead(rejection)
    res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
    return
  }

  const endpoint = endpointOf(channel, req.url)
  if (req.method !== 'POST' || endpoint === undefined) {
    res.writeHead(404)
    res.end('not found')
    return
  }

  const rawType = req.headers['content-type']
  const mediaType = (Array.isArray(rawType) ? rawType[0] : rawType)?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    res.writeHead(415)
    res.end('content type must be application/json')
    return
  }

  const body = await readBody(req)
  if (body === undefined) {
    res.writeHead(413, { connection: 'close' })
    res.end()
    req.destroy()
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    res.writeHead(400)
    res.end('body is not JSON')
    return
  }

  const rawId = isRecord(parsed) ? parsed['rpcId'] : undefined
  const rpcId = typeof rawId === 'string' ? rawId : 'invalid-request'
  if (!isRecord(parsed)
    || parsed['type'] !== 'client-request'
    || typeof parsed['method'] !== 'string') {
    writeJson(res, 200, envelope(rpcId, failure('gateway/bad-request', 'invalid client-request message')))
    return
  }
  const method = parsed['method']
  if (method !== endpoint) {
    writeJson(res, 200, envelope(rpcId, failure(
      'gateway/bad-request',
      `method ${JSON.stringify(method)} does not match endpoint ${JSON.stringify(endpoint)}`,
    )))
    return
  }

  try {
    const result = await handle(endpoint, parsed['payload'])
    writeJson(res, 200, envelope(rpcId, result))
  } catch (error) {
    res.writeHead(500)
    res.end(`handler failure: ${String(error)}`)
  }
}

/**
 * Mount one channel on the host's best available seam.
 *
 * The structural probe is deliberate: `rpc.handle` is preferred because it
 * owns the channel's bookkeeping, but a host whose service-resolution
 * semantics hide `webServer` from that seam throws while registering. That
 * failure is caught — it is the probe — and the same prefix route is
 * registered on `webServer` instead, with `connection.admit` retaining the
 * authentication fence. A host exposing neither, or a connection without
 * `admit`, mounts nothing: an unauthenticated panel route is never a
 * degradation, it is a hole.
 * @param connection - the resolved `connection` service, or `undefined`.
 * @param webServer - the resolved `webServer` service, or `undefined`.
 * @param channel - the absolute channel prefix.
 * @param handle - the endpoint body.
 * @returns the mount, or `undefined` when no seam can carry it.
 */
export function mountPanelChannelSeam(
  connection: unknown,
  webServer: unknown,
  channel: string,
  handle: PanelChannelHandler,
): PanelChannelMount | undefined {
  const surface = isRecord(connection) ? connection as PanelConnectionSurface : undefined
  if (surface === undefined) return undefined

  const rpc = surface.rpc
  if (rpc !== undefined && typeof rpc.handle === 'function') {
    try {
      const dispose = (rpc.handle as (channel: string, handler: PanelChannelHandler) => unknown)
        .call(rpc, channel, (endpoint: string, payload: unknown) => handle(endpoint, payload))
      if (typeof dispose === 'function') {
        return { seam: 'rpc', dispose: () => void dispose() }
      }
    } catch {
      // The seam exists but cannot resolve the web carrier from this host's
      // service graph; the named-route fallback below is the supported path.
    }
  }

  const server = isRecord(webServer) ? webServer as unknown as PanelWebServerSurface : undefined
  if (server === undefined || typeof server.register !== 'function') return undefined
  if (typeof surface.admit !== 'function') return undefined

  const serverSeam = server
  const connectionSeam = surface
  const dispose = serverSeam.register({
    kind: 'prefix',
    path: channel,
    handler: (req, res) => serveRoute(connectionSeam, channel, handle, req, res),
  })
  if (typeof dispose !== 'function') return undefined
  return { seam: 'route', dispose: () => void dispose() }
}

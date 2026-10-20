/**
 * smoke:live — the real-composition acceptance run.
 *
 * Boots a REAL composed `web` profile in-process — the upstream base and
 * web-app bundles, the official `@deepseek-ai/dsh-experimental-auto-review`
 * (npm `next`, pinned at 0.2.1-rc.2), and this plugin installed through the
 * real `dsh plugin add` chain — then drives real `tools.execute` calls
 * through a scripted LLM adapter. The adapter only makes the reviewer's
 * verdict deterministic; every seam the panel depends on is the shipped one:
 * the real `llm/stream` waterfall, the real `tools/pre-execute` listener
 * order, the real Session log, the real `permissionPresets`/`approval`
 * services, and the real `PANEL_CHANNEL` over HTTP with the browser-token
 * exchange.
 *
 * Nothing here impersonates the review stream — the verdicts differ, the
 * plumbing does not.
 *
 * @module scripts/smoke-live
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChecker } from './lib/check.mjs'
import { bootProfile } from './lib/profile-boot.mjs'
import { removeScratchTree } from './lib/smoke-cleanup.mjs'
import {
  assertIsolatedHome,
  ensureProfileCopyImport,
  installPluginProfile,
  loadAppBoot,
  loadRuntimeModule,
  resolveScratchHome,
  runDsh,
} from './lib/dsh-runtime.mjs'

const OFFICIAL = '@deepseek-ai/dsh-experimental-auto-review'
const EXPECTED_RELEASE = '0.2.1-rc.2'
const PROFILE = 'arp-live'

const check = createChecker('live')
const home = resolveScratchHome(`live-${process.pid}`)
const keep = process.env.DSH_SMOKE_KEEP === '1'

/** Post one Connection RPC call the way the browser does: cookie + envelope. */
async function panelCall(origin, cookie, endpoint, payload) {
  const rpcId = `live-${Math.random().toString(36).slice(2)}`
  const response = await fetch(`${origin}/auto-review-panel/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }),
  })
  if (!response.ok) throw new Error(`panel call ${endpoint}: HTTP ${response.status}`)
  const envelope = await response.json()
  if (envelope.rpcId !== rpcId) throw new Error(`panel call ${endpoint}: rpcId mismatch`)
  return envelope.result
}

try {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  assertIsolatedHome(home)

  const app = await loadAppBoot()
  const dir = join(home, 'profiles', PROFILE)

  // `npm next` is the experimental channel — `latest` intentionally trails.
  const next = (await captureDshPkg()).trim()
  check.equal(next, EXPECTED_RELEASE, `npm dist-tag next resolves to ${EXPECTED_RELEASE}`, next)

  app.initProfile(dir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  ensureProfileCopyImport(home, PROFILE)

  const reviewerCode = await runDsh(['plugin', '--profile', PROFILE, 'add', `${OFFICIAL}@${EXPECTED_RELEASE}`], { DSH_HOME: home })
  check.equal(reviewerCode, 0, 'official auto-review installed through `dsh plugin add`', `exit ${reviewerCode}`)
  const pluginCode = await installPluginProfile(PROFILE, home)
  check.equal(pluginCode, 0, 'panel plugin installed through `dsh plugin add`', `exit ${pluginCode}`)

  const prepare = async (host, { installAnchor }) => {
    host.provide('profileContext', {
      name: PROFILE, dir, home,
      patchPath: join(dir, 'cordis.patch.yml'),
      installAnchor, cwd: process.cwd(),
      startedBundles: app.readProfileManifest('probe', dir).dsh.profile.bundles,
      overlays: [], telemetryDisabledEnv: undefined,
    })
    const { provideCmdline } = await loadRuntimeModule('@deepseek-ai/dsh-cmdline')
    provideCmdline(host, { args: ['--no-open', '--port', '0'], exit: () => {} })
  }

    console.log('[smoke:live] booting composed profile…')
    const { ctx } = await bootProfile(PROFILE, home, prepare)
    console.log('[smoke:live] profile booted')
  try {
    // M3-2 measured evidence, half one: the composed row order.
    const entries = [...ctx.loader.entries()]
    const reviewerRow = entries.findIndex(row => row.options?.name === OFFICIAL)
    const panelRow = entries.findIndex(row => row.options?.name === '@dsh-electron/dsh-auto-review-panel/panel')
    check.ok(reviewerRow >= 0, 'official reviewer row is mounted', String(reviewerRow))
    check.ok(panelRow >= 0, 'panel row is mounted', String(panelRow))
    check.ok(
      reviewerRow >= 0 && panelRow >= 0 && reviewerRow < panelRow,
      'reviewer row mounts before the panel row — our prepend listener lands first',
      `reviewer=${reviewerRow} panel=${panelRow}`,
    )
    check.ok(ctx.get('autoReviewPanel') !== undefined, 'autoReviewPanel service is live')
    check.ok(ctx.permissionPresets.names.includes('auto'), 'AUTO preset is advertised')

    const origin = (() => { try { return ctx.get('webServer')?.getOrigin() } catch { return undefined } })()
    check.ok(typeof origin === 'string', 'web server is listening', String(origin))
    const authenticatedUrl = ctx.get('connection')?.authenticatedUrl(origin)
    check.ok(typeof authenticatedUrl === 'string', 'connection mints a browser token URL')
    const login = await fetch(authenticatedUrl, { redirect: 'manual' })
    const cookie = (login.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? ''
    check.ok(login.status === 303 && cookie !== '', 'browser token exchange yields a session cookie', `status ${login.status}`)


    const { LlmAdapter, ToolCallId, createMessage } = await loadRuntimeModule('@deepseek-ai/dsh-llm')
    const { SessionId } = await loadRuntimeModule('@deepseek-ai/dsh-session')
    const { defineContentToolFixture } = await loadRuntimeModule('@deepseek-ai/dsh-tools')
    const { setApprovalPolicy } = await loadRuntimeModule('@deepseek-ai/dsh-user-approval')

    // Deterministic verdicts keyed on the pending call's `mark` argument.
    const reviewRequests = []
    class Scripted extends LlmAdapter {
      async *stream(options) {
        reviewRequests.push(options)
        const text = options.messages?.[0]?.content?.[0]?.text ?? ''
        const verdict = /"mark":\s*"deny"/u.test(text)
          ? '{"risk":"high","decision":"deny","reason":"live smoke denial"}'
          : /"mark":\s*"malformed"/u.test(text)
            ? 'this is not the verdict protocol'
            : /"mark":\s*"fail"/u.test(text)
              ? null
              : '{"risk":"low","decision":"allow"}'
        if (verdict === null) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'LIVE_SMOKE', message: 'scripted reviewer failure' } } }
          return
        }
        yield { type: 'block-start', index: 0, blockType: 'reasoning' }
        yield { type: 'reasoning-delta', index: 0, text: 'weighing the pending call' }
        yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'weighing the pending call' } }
        yield { type: 'block-start', index: 1, blockType: 'text' }
        yield { type: 'text-delta', index: 1, text: verdict }
        yield { type: 'block-end', index: 1, block: { type: 'text', text: verdict } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['live-smoke'], new Scripted())
    ctx.tools.register(defineContentToolFixture({
      name: 'live_smoke_probe',
      description: 'A harmless probe call for the live composition smoke',
      parameters: { file_path: { type: 'string' }, mark: { type: 'string' } },
      async execute(args) {
        return [{ type: 'text', text: `probed ${String(args.file_path ?? '')}` }]
      },
    }))

    const workdir = mkdtempSync(join(tmpdir(), 'arp-live-'))
    const session = ctx.sessions.create(SessionId('live-1'), { meta: { cwd: workdir } })
    ctx.permissionPresets.set(session, 'auto')
    check.equal(ctx.permissionPresets.current(session), 'auto', 'session switched to the Auto preset')
    const session2 = ctx.sessions.create(SessionId('live-2'), { meta: { cwd: workdir } })
    ctx.permissionPresets.set(session2, 'auto')
    const session3 = ctx.sessions.create(SessionId('live-3'), { meta: { cwd: workdir } })
    let turn = 0
    const call = async (mark, extraArgs = {}, target = session) => {
      turn += 1
      const id = ToolCallId(`live-${turn}`)
      const name = 'live_smoke_probe'
      const args = { file_path: `probe-${mark}`, mark, ...extraArgs }
      const agent = { id: target.id, session: target, ctx, options: {} }
      target.append('turn/start', { turn })
      session.append('request/header', {
        header: { config: { provider: 'live-smoke', model: 'scripted' }, tools: ctx.tools.schemas() },
        reason: turn === 1 ? 'initial' : 'change',
      })
      target.append('step/start', { turn, step: 1 })
      target.append('assistant/message', {
        turn, step: 1, stream: [],
        message: createMessage({
          role: 'assistant',
          source: { kind: 'model', provider: 'live-smoke', model: 'scripted' },
          content: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }],
        }),
      }, { surfaceOp: 'append' })
      const callEvent = target.append('tool/call', { turn, step: 1, callId: id, name, arguments: JSON.stringify(args) })
            console.log(`[smoke:live] turn ${turn}: executing ${name} mark=${args.mark}`)
      const result = await ctx.tools.execute({ callId: id, name, arguments: args, agent, signal: AbortSignal.timeout(30_000) })
      console.log(`[smoke:live] turn ${turn}: settled isError=${result.isError}`)
      return { result, callId: id, turn, callSeq: callEvent.seq, target }
    }

    /** Mirror agent-loop's appendToolResult so the Session carries the durable outcome. */
    const { createToolResultMessage } = await loadRuntimeModule('@deepseek-ai/dsh-llm')
    const logResult = (entry) => {
      entry.target.append('tool/result', {
        turn: entry.turn, step: 1,
        message: createToolResultMessage({ callId: entry.callId, content: entry.result.content, isError: entry.result.isError }),
        ...(entry.result.error?.info === undefined ? {} : { error: entry.result.error.info }),
      }, { surfaceOp: 'append', sourceEventSeqs: [entry.callSeq] })
      entry.target.append('turn/end', { turn: entry.turn, reason: { kind: 'completed' } })
    }

    // --- allow: reviewed, executed, correlated, executed outcome logged ---
    const allow = await call('allow')
    check.equal(allow.result.isError, false, 'allow verdict executes the call')
    logResult(allow)

    // --- deny + ask policy: upstream converts to the approval surface ---
    const ask = await call('deny-ask', { mark: 'deny' })
    check.equal(ask.result.isError, true, 'denied call does not execute under the ask policy')
    check.ok(
      ctx.sessions.get(session.id)?.log.some(event => event.type === 'approval/asked'),
      'the upstream ask reached the approval surface (approval/asked logged)',
    )
    logResult(ask)

    // --- deny + never policy: the final denial ---
    setApprovalPolicy(session, 'never')
    const denied = await call('deny-never', { mark: 'deny' })
    check.equal(denied.result.isError, true, 'denied call does not execute under the never policy')
    check.equal(
      denied.result.error?.info?.code, 'AUTO_REVIEW_DENIED',
      'the final denial carries AUTO_REVIEW_DENIED',
      JSON.stringify(denied.result.error),
    )
    logResult(denied)
    setApprovalPolicy(session, 'ask')

    // --- malformed verdict and reviewer failure both still record ---
    const malformed = await call('malformed')
    logResult(malformed)
    const failed = await call('fail')
    check.equal(failed.result.isError, true, 'a reviewer failure fails the call')
    logResult(failed)

    // --- empty-state evidence over the wire: ④ auto session, zero records ---
    const empty = await panelCall(origin, cookie, 'list', { sessionId: 'live-2' })
    check.equal(empty?.value?.records?.length, 0, 'empty state ④: an Auto session with no calls reports zero records')
    check.equal(empty?.value?.status?.sessionPreset, 'auto', 'empty state ④: status reports the Auto preset')
    const nonAuto = await panelCall(origin, cookie, 'list', { sessionId: String(session3.id) })
    check.ok(
      typeof nonAuto?.value?.status?.sessionPreset === 'string'
        && nonAuto.value.status.sessionPreset !== 'auto',
      'empty state ②: a non-Auto session reports its real preset',
      JSON.stringify(nonAuto?.value?.status),
    )

    // --- an exec whose downstream waterfall throws AFTER the review: the
    // record survives with the anchor honestly missing (a real failure mode —
    // a later listener exploding is exactly how a reviewed call can end with
    // no reachable correlation). A same-/cross-session concurrency attempt was
    // measured to serialize through the tool scheduler, so the appended
    // throwing listener is the deterministic honest path.
    const orphanOff = ctx.on('tools/pre-execute', (exec, next) => {
      if (exec.arguments?.mark === 'noreach') throw new Error('downstream listener exploded')
      return next()
    })
    const orphan = await call('noreach')
    orphanOff()
    check.equal(orphan.result.isError, true, 'a throwing downstream listener fails the call')
    logResult(orphan)

    check.equal(reviewRequests.length, 6, 'exactly one reviewer request per call', String(reviewRequests.length))

    // --- the real channel over HTTP ---
    const all = await panelCall(origin, cookie, 'list', {})
    check.equal(all?.ok, true, 'list endpoint answers over the wire')
    const records = all?.value?.records ?? []
    check.equal(records.length, 6, 'every reviewed call produced one record', String(records.length))
    check.equal(all?.value?.status?.reviewerAvailable, true, 'status reports the reviewer live')
    check.equal(all?.value?.status?.sessionPreset, undefined, 'unfiltered list carries no sessionPreset')


    const sessionList = await panelCall(origin, cookie, 'list', { sessionId: 'live-1' })
    const sessionRecords = sessionList?.value?.records ?? []
    check.equal(sessionList?.value?.status?.sessionPreset, 'auto', 'session status reports the Auto preset')
    check.equal(sessionRecords.length, 6, 'session filter keeps every record incl. the uncorrelated orphan', String(sessionRecords.length))

    // allow record: correlated, downstream allow, executed outcome.
    const allowRecord = records.find(record => record.decision === 'allow' && record.correlated === true)
    check.ok(allowRecord !== undefined, 'an allow record is correlated')
    const allowFull = (await panelCall(origin, cookie, 'get', { id: allowRecord?.id }))?.value
    check.equal(allowFull?.correlation?.downstreamDecision, 'allow', 'allow call correlated with downstream allow')
    check.equal(allowFull?.hostOutcome?.toolResult?.isError, false, 'executed outcome evidenced by tool/result')

    // ask record: downstreamDecision ask + approval evidence.
    const askRecord = records.find(record => record.action?.preview === 'probe-deny-ask' && record.correlated === true && record.decision === 'deny')
    const neverRow = records.find(record => record.action?.preview === 'probe-deny-never' && record.correlated === true && record.decision === 'deny')
    const askFull = (await panelCall(origin, cookie, 'get', { id: askRecord?.id }))?.value
    check.equal(askFull?.correlation?.downstreamDecision, 'ask', 'deny+ask surfaced as a downstream ask')
    check.ok(
      typeof askFull?.hostOutcome?.approval?.outcome === 'string',
      'the approval audit pair evidences a real outcome (unavailable or cancelled without an answerer)',
      JSON.stringify(askFull?.hostOutcome),
    )

    // deny+never record: THE M3-2 verdict — correlated only when prepend lands first.
    const neverFull = []
    for (const row of sessionRecords) {
      const full = (await panelCall(origin, cookie, 'get', { id: row.id }))?.value
      neverFull.push(full)
    }
    const neverDenied = neverFull.find(record =>
      record?.correlation?.downstreamDecision === 'deny'
      && record?.correlation?.denialInfo?.code === 'AUTO_REVIEW_DENIED')
    check.ok(
      neverDenied !== undefined,
      'deny+never record is correlated and carries AUTO_REVIEW_DENIED verbatim',
      JSON.stringify(sessionRecords.map(record => ({ id: record.id, decision: record.decision, correlated: record.correlated }))),
    )
    check.equal(neverDenied?.hostOutcome?.toolResult?.code, 'AUTO_REVIEW_DENIED', 'session log corroborates the denial identity')
    check.ok(neverDenied !== undefined && neverRow !== undefined, 'two correlated deny records exist (ask + never)')

    // malformed verdict → decision error; reviewer failure → finish error.
    check.ok(
      neverFull.some(record => record?.output?.decision === 'error'),
      'a malformed verdict records decision:error',
    )
    check.ok(
      neverFull.some(record => record?.finish?.kind === 'error'),
      'a reviewer stream failure records finish:error',
    )

    // the orphaned record stays uncorrelated yet remains visible under every
    // session filter — live proof of the always-visible uncorrelated batch.
    const uncorrelated = sessionRecords.filter(record => record.correlated === false)
    check.ok(uncorrelated.length >= 1, 'the orphaned record stays uncorrelated', String(uncorrelated.length))
    const otherList = await panelCall(origin, cookie, 'list', { sessionId: 'other-session' })
    const otherRecords = otherList?.value?.records ?? []
    check.ok(
      otherRecords.filter(record => record.correlated === false).length >= 1,
      'uncorrelated records stay visible under a foreign session filter',
      String(otherRecords.length),
    )
    check.equal(
      otherRecords.filter(record => record.correlated === true).length, 0,
      'a foreign session sees no correlated records',
    )
  } finally {
    await ctx.fiber.dispose()
  }

  // --- Phase 2: empty state ① — a real web profile without the reviewer ---
  const prepareProfile = (name, dir, cmdArgs) => async (host, { installAnchor }) => {
    host.provide('profileContext', {
      name, dir, home,
      patchPath: join(dir, 'cordis.patch.yml'),
      installAnchor, cwd: process.cwd(),
      startedBundles: app.readProfileManifest('probe', dir).dsh.profile.bundles,
      overlays: [], telemetryDisabledEnv: undefined,
    })
    const { provideCmdline } = await loadRuntimeModule('@deepseek-ai/dsh-cmdline')
    provideCmdline(host, { args: cmdArgs, exit: () => {} })
  }
  const plain = 'arp-plain'
  const plainDir = join(home, 'profiles', plain)
  app.initProfile(plainDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  ensureProfileCopyImport(home, plain)
  check.equal(await installPluginProfile(plain, home), 0, 'panel installed into the no-reviewer profile')
  const plainBoot = await bootProfile(plain, home, prepareProfile(plain, plainDir, ['--no-open', '--port', '0']))
  try {
    const plainCtx = plainBoot.ctx
    check.ok(plainCtx.get('autoReviewPanel') !== undefined, 'panel service live without the reviewer bundle')
    check.equal(plainCtx.permissionPresets.names.includes('auto'), false, 'AUTO preset absent without the reviewer')
    const plainOrigin = plainCtx.get('webServer')?.getOrigin()
    const plainLogin = await fetch(plainCtx.get('connection')?.authenticatedUrl(plainOrigin), { redirect: 'manual' })
    const plainCookie = (plainLogin.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? ''
    const plainList = await panelCall(plainOrigin, plainCookie, 'list', {})
    check.equal(plainList?.value?.status?.reviewerAvailable, false, 'empty state ①: status reports the reviewer absent')
  } finally {
    await plainBoot.ctx.fiber.dispose()
  }

  // --- Phase 3: headless composition — capture runs, no channel ---
  const headless = 'arp-headless'
  const headlessDir = join(home, 'profiles', headless)
  app.initProfile(headlessDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])
  ensureProfileCopyImport(home, headless)
  check.equal(await installPluginProfile(headless, home), 0, 'panel installed into the headless profile')
  const headlessBoot = await bootProfile(headless, home, prepareProfile(headless, headlessDir, []))
  try {
    const headlessCtx = headlessBoot.ctx
    check.ok(headlessCtx.get('autoReviewPanel') !== undefined, 'host capture runs without a Connection')
    check.equal(headlessCtx.get('connection'), undefined, 'headless composition has no connection — the channel is absent, not an error')
  } finally {
    await headlessBoot.ctx.fiber.dispose()
  }

  check.finish()
} finally {
  if (!keep) await removeScratchTree(home)
  else console.log(`[smoke:live] kept scratch home at ${home}`)
}

/** Resolve the npm `next` dist-tag of the official reviewer package. */
async function captureDshPkg() {
  const { spawn } = await import('node:child_process')
  const child = spawn('npm', ['view', `${OFFICIAL}@next`, 'version'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  const code = await new Promise((settle, fail) => {
    child.on('error', fail)
    child.on('close', value => settle(value ?? 1))
  })
  if (code !== 0) throw new Error(`npm view ${OFFICIAL}@next exited ${code}`)
  return stdout
}

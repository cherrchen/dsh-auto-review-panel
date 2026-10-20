// Hold a real composed live profile open for interactive acceptance:
// boots the web profile (official reviewer + panel), drives the scripted
// calls, then stays alive and prints the authenticated URL for browsing.
// Usage: DSH_LIVE_KEEP_HOME=<path> node scripts/live-demo.mjs  (reuses a kept
// smoke-live home when set, otherwise builds a fresh one).
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { bootProfile } from './lib/profile-boot.mjs'
import {
  ensureProfileCopyImport, installPluginProfile, loadAppBoot, loadRuntimeModule,
  resolveScratchHome, runDsh,
} from './lib/dsh-runtime.mjs'

const OFFICIAL = '@deepseek-ai/dsh-experimental-auto-review'
const PROFILE = 'arp-demo'
const home = process.env.DSH_LIVE_KEEP_HOME ?? resolveScratchHome(`demo-${process.pid}`)
const app = await loadAppBoot()
const dir = join(home, 'profiles', PROFILE)

if (process.env.DSH_LIVE_KEEP_HOME === undefined) {
  mkdirSync(home, { recursive: true })
  app.initProfile(dir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  ensureProfileCopyImport(home, PROFILE)
  if (await runDsh(['plugin', '--profile', PROFILE, 'add', `${OFFICIAL}@0.2.1-rc.2`], { DSH_HOME: home }) !== 0) process.exit(1)
  if (await installPluginProfile(PROFILE, home) !== 0) process.exit(1)
}

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
const { ctx } = await bootProfile(PROFILE, home, prepare)

const { LlmAdapter, ToolCallId, createMessage, createToolResultMessage } = await loadRuntimeModule('@deepseek-ai/dsh-llm')
const { SessionId } = await loadRuntimeModule('@deepseek-ai/dsh-session')
const { defineContentToolFixture } = await loadRuntimeModule('@deepseek-ai/dsh-tools')
const { setApprovalPolicy } = await loadRuntimeModule('@deepseek-ai/dsh-user-approval')

class Scripted extends LlmAdapter {
  async *stream(options) {
    const text = options.messages?.[0]?.content?.[0]?.text ?? ''
    const verdict = /"mark":\s*"deny"/u.test(text)
      ? '{"risk":"high","decision":"deny","reason":"sends credentials to an external host; the call is refused"}'
      : '{"risk":"low","decision":"allow"}'
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    yield { type: 'reasoning-delta', index: 0, text: 'weighing whether the pending call should run' }
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'weighing whether the pending call should run' } }
    yield { type: 'block-start', index: 1, blockType: 'text' }
    yield { type: 'text-delta', index: 1, text: verdict }
    yield { type: 'block-end', index: 1, block: { type: 'text', text: verdict } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
ctx.llm.registerAdapter(['live-demo'], new Scripted())
ctx.tools.register(defineContentToolFixture({
  name: 'demo_write_file',
  description: 'A harmless demo write',
  parameters: { file_path: { type: 'string' }, content: { type: 'string' }, mark: { type: 'string' } },
  async execute(args) { return [{ type: 'text', text: `wrote ${String(args.file_path)}` }] },
}))

const workdir = mkdtempSync(join(tmpdir(), 'arp-demo-'))
const session = ctx.sessions.create(SessionId('demo-1'), { meta: { cwd: workdir } })
ctx.permissionPresets.set(session, 'auto')
const agent = { id: session.id, session, ctx, options: {} }
let turn = 0
async function call(mark, file) {
  turn += 1
  const id = ToolCallId(`demo-${turn}`)
  const args = { file_path: file, content: 'demo', mark }
  session.append('turn/start', { turn })
  session.append('request/header', { header: { config: { provider: 'live-demo', model: 'scripted' }, tools: ctx.tools.schemas() }, reason: 'initial' })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    turn, step: 1, stream: [],
    message: createMessage({
      role: 'assistant', source: { kind: 'model', provider: 'live-demo', model: 'scripted' },
      content: [{ type: 'tool-call', id, name: 'demo_write_file', arguments: JSON.stringify(args) }],
    }),
  }, { surfaceOp: 'append' })
  const callEvent = session.append('tool/call', { turn, step: 1, callId: id, name: 'demo_write_file', arguments: JSON.stringify(args) })
  const result = await ctx.tools.execute({ callId: id, name: 'demo_write_file', arguments: args, agent, signal: AbortSignal.timeout(30_000) })
  session.append('tool/result', {
    turn, step: 1,
    message: createToolResultMessage({ callId: id, content: result.content, isError: result.isError }),
    ...(result.error?.info === undefined ? {} : { error: result.error.info }),
  }, { surfaceOp: 'append', sourceEventSeqs: [callEvent.seq] })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  console.log(`[demo] ${file}: isError=${result.isError}`)
}

await call('allow', '/tmp/notes.md')
await call('allow', '/tmp/report.md')
setApprovalPolicy(session, 'never')
await call('deny', '/etc/shadow')
setApprovalPolicy(session, 'ask')
await call('deny', '/etc/hosts')  // ask → no answerer → cancelled after timeout

const origin = ctx.get('webServer').getOrigin()
const url = ctx.get('connection').authenticatedUrl(origin)
console.log(`\n[demo] browse: ${url}`)
console.log('[demo] session id: demo-1 — select it, then open the 审查面板 sidebar tab')
console.log('[demo] holding the profile open; Ctrl-C to stop')
for (;;) await pause(60_000)

/**
 * smoke:compose — the composition acceptance test.
 *
 * It drives the real plugin install chain (`dsh plugin --profile <name> add`),
 * dumps two composed profiles with `dsh --dump-config` — one with the plugin
 * and one without — and asserts that the ONLY difference is the three inserted
 * rows.
 *
 * This is the structural gate. The upstream patch semantics warn and skip on an
 * id that no longer matches, so "the insert silently did nothing" is a real
 * failure mode; comparing a baseline dump against the patched one is what turns
 * it into a hard failure here instead of a surprise at runtime.
 *
 * The run is always isolated: it uses a scratch `$DSH_HOME` and refuses to touch
 * the operator's real one.
 *
 * @module scripts/smoke-compose
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { createChecker } from './lib/check.mjs'
import { assertIsolatedHome, captureDsh, ensureProfileCopyImport, installPluginProfile, REPO_ROOT, resolveScratchHome, runDsh } from './lib/dsh-runtime.mjs'

const PLUGIN_NAME = '@dsh-electron/dsh-auto-review-panel'
const INSERTED = [
  // The compatibility gate comes first: the panel host half injects
  // `autoReviewPanelCompat`, so a harness whose DSH release is not on the
  // allowlist mounts none of them.
  'auto-review-panel-compat',
  // The review surface's host-side owner.
  'auto-review-panel',
  // The client-graph anchor: mounted at the bare package name so the web
  // client-module scan reads this package's `dsh.client` declaration.
  'auto-review-panel-client',
]

const check = createChecker('compose')
const home = resolveScratchHome(`compose-${process.pid}`)
const keep = process.env.DSH_SMOKE_KEEP === '1'

/** The dump must be a YAML array of rows; `!!js` tag warnings are expected. */
function parseDump(text, label) {
  const rows = parse(text, { logLevel: 'silent' })
  if (!Array.isArray(rows)) throw new Error(`${label}: --dump-config did not print a YAML array`)
  return rows
}

function byId(rows) {
  const map = new Map()
  for (const row of rows) if (row !== null && typeof row === 'object' && typeof row.id === 'string') map.set(row.id, row)
  return map
}

async function dump(profile) {
  const result = await captureDsh(['--profile', profile, '--dump-config'], { DSH_HOME: home })
  check.ok(result.code === 0, `dsh --profile ${profile} --dump-config exits 0`, result.stderr.trim())
  check.ok(!result.stderr.includes('not found'), `dsh reports no unmatched patch rows for ${profile}`, result.stderr.trim())
  return { rows: parseDump(result.stdout, profile), stderr: result.stderr }
}

try {
  if (!existsSync(join(REPO_ROOT, 'lib', 'index.js'))) throw new Error('lib/ is missing — run `pnpm build` before the smoke')

  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  assertIsolatedHome(home)

  const baselineProfile = 'arp-baseline'
  const pluginProfile = 'arp-plugin'

  console.log(`[smoke:compose] scratch home: ${home}`)
  // Copy import lands before `plugin install` materializes store references —
  // the hardlink preflight counts every multi-link file under the home.
  ensureProfileCopyImport(home, baselineProfile)
  const initCode = await runDsh(['plugin', '--profile', baselineProfile, 'install'], { DSH_HOME: home })
  check.ok(initCode === 0, 'baseline profile initialized without the plugin', `exit ${initCode}`)

  // `smoke:packed` sets DSH_SMOKE_PLUGIN_SOURCE to the packed tarball, so the
  // same composition assertion runs against the shipped artifact.
  const addCode = await installPluginProfile(pluginProfile, home, process.env.DSH_SMOKE_PLUGIN_SOURCE ?? undefined)
  check.ok(addCode === 0, 'plugin installed into a profile through `dsh plugin add`', `exit ${addCode}`)

  const baseline = await dump(baselineProfile)
  const composed = await dump(pluginProfile)

  const composedRows = byId(composed.rows)

  // 1. The baseline really is the untouched composition.
  check.ok(baseline.rows.length > 0, 'baseline mounts the upstream row set', `rows: ${baseline.rows.length}`)

  // 2. The plugin's rows are present, enabled, and point at this package.
  const insertedIds = composed.rows
    .filter(row => INSERTED.includes(row?.id))
    .map(row => row.id)
  check.equal(insertedIds, INSERTED, `exactly the ${INSERTED.length} plugin rows were inserted, in order`)
  for (const id of INSERTED) {
    const row = composedRows.get(id)
    check.ok(
      row?.name === PLUGIN_NAME || row?.name?.startsWith(`${PLUGIN_NAME}/`) === true,
      `${id} resolves inside ${PLUGIN_NAME}`,
      String(row?.name),
    )
    check.ok(row?.disabled !== true, `${id} is enabled`)
  }

  // 3. Every other row is untouched, in the same order.
  const composedWithoutInserted = composed.rows.filter(row => !INSERTED.includes(row?.id))
  check.equal(composedWithoutInserted.length, baseline.rows.length, 'the composed tree adds no rows beyond the plugin rows')
  check.equal(
    composedWithoutInserted.map(row => row?.id),
    baseline.rows.map(row => row?.id),
    'row order is unchanged',
  )
  const changed = []
  for (const [index, before] of baseline.rows.entries()) {
    const after = composedWithoutInserted[index]
    if (JSON.stringify(before) !== JSON.stringify(after)) changed.push(after?.id)
  }
  check.equal(changed, [], 'no upstream row differs')

  check.finish()
} finally {
  if (!keep && process.env.DSH_SMOKE_KEEP !== '1') rmSync(home, { recursive: true, force: true })
  else console.log(`[smoke:compose] kept scratch home at ${home}`)
}

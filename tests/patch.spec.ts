/**
 * Composition invariants of the bundle patch.
 *
 * The patch is the whole mechanism by which this plugin mounts itself into a
 * profile. Two failure modes are silent upstream — a name that does not
 * resolve only fails at boot, and the client-graph anchor is silently absent
 * when the bare-package-name row is missing — so this suite pins both against
 * the manifest this repository ships.
 *
 * The end-to-end counterpart (an actual composed dump) lives in
 * `scripts/smoke-compose.mjs`.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { REPO_ROOT } from './support/repo-root.ts'

interface Row {
  id?: string
  name?: string
  disabled?: boolean
  insert?: Row[]
  config?: unknown
  [key: string]: unknown
}

function readYaml(path: string): unknown {
  return parse(readFileSync(path, 'utf8'), {
    // `!!js` tags are evaluated by the host loader; this spec only needs the
    // expression to survive as a string.
    customTags: [{
      tag: 'tag:yaml.org,2002:js',
      resolve: (value: string) => value,
    }],
  })
}

const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  name: string
  exports: Record<string, unknown>
  dsh?: { bundle?: { patch?: string } }
}

const patchPath = join(REPO_ROOT, manifest.dsh?.bundle?.patch ?? 'cordis.patch.yml')
const patchRows = readYaml(patchPath) as Row[]
const inserted = patchRows.flatMap(row => row.insert ?? [])

describe('bundle declaration', () => {
  it('declares the patch this repository ships', () => {
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })
})

describe('inserted rows', () => {
  it('inserts the compat gate, the panel host half, and the client-graph anchor', () => {
    expect(inserted.map(row => row.id)).toEqual([
      'auto-review-panel-compat',
      'auto-review-panel',
      'auto-review-panel-client',
    ])
  })

  it('places the compat gate before every row that injects it', () => {
    const ids = inserted.map(row => row.id)
    const gate = ids.indexOf('auto-review-panel-compat')
    expect(gate).toBe(0)
    for (const gated of ['auto-review-panel']) {
      expect(ids.indexOf(gated), `${gated} must come after the gate`).toBeGreaterThan(gate)
    }
  })

  it('names entries that this package actually exports', () => {
    for (const row of inserted) {
      expect(typeof row.name).toBe('string')
      const name = row.name as string
      // The client-graph anchor mounts the package root itself: the web
      // client-module scan reads `dsh.client` only from a bare-package-name
      // row, so `auto-review-panel-client` must NOT be a subpath.
      if (name === manifest.name) {
        expect(Object.keys(manifest.exports)).toContain('.')
        continue
      }
      expect(name.startsWith(`${manifest.name}/`), `${name} must be a subpath of this package`).toBe(true)
      const subpath = `.${name.slice(manifest.name.length)}`
      expect(Object.keys(manifest.exports), `${subpath} must be declared in package.json exports`).toContain(subpath)
    }
  })

  it('anchors the client graph with a bare-package-name row', () => {
    const anchor = inserted.find(row => row.id === 'auto-review-panel-client')
    expect(anchor?.name).toBe(manifest.name)
  })
})

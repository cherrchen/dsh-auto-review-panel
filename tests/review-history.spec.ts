/**
 * The durable review-history store: append-only JSONL under
 * `auto-review-panel/v1/`, per-session files plus `unassigned.jsonl`,
 * session-lifecycle validation, retention, and fail-soft reads.
 *
 * These tests run the REAL {@link ReviewHistoryStore} against a temp dir —
 * the file format is the feature, so only `createFileOps` and `now` are
 * injected. Host integration covers the same code through `handle`.
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PanelListValue, ReviewRecord, ReviewHistoryRetention } from '../src/contract.ts'
import { DEFAULT_RETENTION } from '../src/contract.ts'
import { encodeLine, encodeSessionKey } from '../src/history/format.ts'
import { createFileOps, type HistoryFileOps } from '../src/history/paths.ts'
import { LazyReviewHistory } from '../src/history/lazy.ts'
import { ReviewHistoryStore } from '../src/history/store.ts'
import type { ReviewSessionIdentity } from '../src/history/contract.ts'
import { capture, execution, makeHost, runExecution } from './support/review-fixtures.ts'

const IDENTITY: ReviewSessionIdentity = { createdAt: 1760000000000, isSeeded: false, cwd: '/work' }

/** One complete record; the shape `summarizeRecord` and `get` dereference. */
function record(id: string, overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    id,
    capturedAt: '2026-10-20T12:00:00.000Z',
    provider: 'deepseek',
    model: 'deepseek-chat',
    requestText: 'PENDING_ACTION\n\n{}',
    sections: {
      policy: 'REVIEW_POLICY',
      environment: { cwd: '/work' },
      projectInstructions: [],
      filteredHistory: [],
      pendingAction: { mode: 'native', name: 'read_file', arguments: { path: 'README.md' } },
    },
    reasoning: [],
    output: { risk: 'low', decision: 'allow', rawText: '{"risk":"low","decision":"allow"}' },
    ...overrides,
  }
}

/** One record correlated to a session. */
function correlated(id: string, sessionId = 'session-1'): ReviewRecord {
  return record(id, {
    correlation: { sessionId, callId: `call-${id}`, downstreamDecision: 'allow' },
  })
}

interface TestStore {
  readonly dir: string
  readonly store: ReviewHistoryStore
  readonly warnings: string[]
  /** Path under the store root (`unassigned.jsonl`, `sessions/<key>.jsonl`, …). */
  path(...segments: string[]): string
}

const cleanupDirs: string[] = []
let ops: HistoryFileOps | undefined

/** A real store over a fresh temp dir. */
async function testStore(now?: () => number): Promise<TestStore> {
  const dir = await mkdtemp(join(tmpdir(), 'arp-history-'))
  cleanupDirs.push(dir)
  ops ??= await createFileOps()
  const warnings: string[] = []
  const store = await ReviewHistoryStore.open({
    root: dir,
    display: 'test-root',
    ops,
    warn: message => warnings.push(message),
    ...(now === undefined ? {} : { now }),
  })
  return { dir, store, warnings, path: (...segments) => join(dir, ...segments) }
}

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

describe('the history store', () => {
  it('appends an uncorrelated record to unassigned.jsonl and serves it in every session view', async () => {
    const t = await testStore()
    t.store.upsert(record('r1'))
    await t.store.flush()
    const file = JSON.parse(`[${(await readFile(t.path('unassigned.jsonl'), 'utf8')).trim().split('\n').join(',')}]`) as unknown[]
    expect(file[0]).toMatchObject({ type: 'header', schema: 1, sessionId: null })
    expect(file[1]).toMatchObject({ type: 'record', record: { id: 'r1' } })
    expect(await t.store.summaries('session-x')).toHaveLength(1)
    expect(await t.store.summaries('other')).toHaveLength(1)
  })

  it('correlates into the session file and removes the unassigned copy', async () => {
    const t = await testStore()
    t.store.upsert(record('r1'))
    t.store.upsert(correlated('r1'))
    await t.store.flush()
    const sessionFile = await readFile(t.path('sessions', `${encodeSessionKey('session-1')}.jsonl`), 'utf8')
    expect(sessionFile).toContain('"type":"record"')
    // The tombstone deletes the unassigned copy — and immediately triggers
    // compaction (one tombstone, zero live rows), so the file folds back to
    // its header. Either way, no `record` line for r1 may survive there.
    const unassigned = await readFile(t.path('unassigned.jsonl'), 'utf8')
    expect(unassigned).not.toContain('"type":"record"')
    const summaries = await t.store.summaries('session-1')
    expect(summaries.map(summary => summary.id)).toEqual(['r1'])
  })

  it('writes a patch line for the second write of a correlated record', async () => {
    const t = await testStore()
    t.store.upsert(correlated('r1'))
    t.store.upsert(correlated('r1', 'session-1'))
    await t.store.flush()
    const lines = (await readFile(t.path('sessions', `${encodeSessionKey('session-1')}.jsonl`), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(3) // header + record + patch
    expect(JSON.parse(lines[2]!)).toMatchObject({
      type: 'patch',
      id: 'r1',
      patch: { correlation: { sessionId: 'session-1' } },
    })
  })

  it('restores records after a restart — a fresh store folds the same files', async () => {
    const t = await testStore()
    t.store.upsert(correlated('r1'), IDENTITY)
    t.store.upsert(record('r9'))
    await t.store.flush()
    const reopened = await ReviewHistoryStore.open({
      root: t.dir, display: 'test-root', ops: ops!,
    })
    const summaries = await reopened.summaries('session-1', IDENTITY)
    expect(summaries.map(summary => summary.id).sort()).toEqual(['r1', 'r9'])
    const restored = await reopened.get('session-1', 'r1', IDENTITY)
    expect(restored).toMatchObject({ id: 'r1', correlation: { sessionId: 'session-1' } })
    expect(Object.isFrozen(restored)).toBe(true)
  })

  it('refuses an expired-lifecycle session file: a mismatched identity hides and replaces it', async () => {
    const stamps: number[] = []
    let tick = 0
    const t = await testStore(() => ++tick + (stamps.push(0), 0))
    t.store.upsert(correlated('r1'), IDENTITY)
    await t.store.flush()
    const different: ReviewSessionIdentity = { createdAt: 999, isSeeded: true, cwd: '/elsewhere' }
    expect(await t.store.summaries('session-1', different)).toEqual([])
    expect(await t.store.get('session-1', 'r1', different)).toBeUndefined()
    // The next write rotates the stale bytes aside instead of appending.
    t.store.upsert(correlated('r2'), different)
    await t.store.flush()
    const names = await readdir(t.path('sessions'))
    expect(names.some(name => name.includes('.stale-'))).toBe(true)
    const summaries = await t.store.summaries('session-1', different)
    expect(summaries.map(summary => summary.id)).toEqual(['r2'])
  })

  it('never overwrites a foreign-schema file', async () => {
    const t = await testStore()
    const path = t.path('sessions', `${encodeSessionKey('session-1')}.jsonl`)
    const foreign = `${encodeLine({ type: 'header', schema: 99, sessionId: 'session-1' })}${encodeLine({ type: 'record', record: record('r1') })}`
    await writeFile(path, foreign)
    t.store.upsert(correlated('r2'), IDENTITY)
    await t.store.flush()
    expect(await readFile(path, 'utf8')).toBe(foreign)
    expect(t.warnings.some(message => message.includes('unrecognized schema'))).toBe(true)
  })

  it('renames a corrupt file aside and recovers on the next write', async () => {
    const t = await testStore()
    const path = t.path('sessions', `${encodeSessionKey('session-1')}.jsonl`)
    await writeFile(path, '{"type":"record","record":{}}\n')
    expect(await t.store.summaries('session-1')).toEqual([])
    t.store.upsert(correlated('r2'), IDENTITY)
    await t.store.flush()
    const names = await readdir(t.path('sessions'))
    expect(names.some(name => name.includes('.corrupt-'))).toBe(true)
    expect(await t.store.summaries('session-1', IDENTITY)).toHaveLength(1)
  })

  it('skips malformed interior lines without losing the file', async () => {
    const t = await testStore()
    const path = t.path('unassigned.jsonl')
    await writeFile(path, `${encodeLine({ type: 'header', schema: 1, sessionId: null })}${encodeLine({ type: 'record', record: record('r1') })}not-json\n`)
    expect((await t.store.summaries('s')).map(summary => summary.id)).toEqual(['r1'])
  })

  it('enforces the per-session record cap through update-settings maintenance', async () => {
    const t = await testStore()
    for (const id of ['r1', 'r2', 'r3']) {
      t.store.upsert(correlated(id, 'session-1'), IDENTITY)
      await t.store.flush()
    }
    const retention: ReviewHistoryRetention = { ...DEFAULT_RETENTION, maxRecordsPerSession: 2 }
    const { maintenance } = await t.store.updateSettings(retention)
    expect(maintenance).toMatchObject({ compactedSessions: 1, removedRecords: 1 })
    const kept = await t.store.summaries('session-1', IDENTITY)
    expect(kept.map(summary => summary.id)).toEqual(['r3', 'r2'])
    // settings.json landed; a reopen sees the same retention.
    const reopened = await ReviewHistoryStore.open({ root: t.dir, display: 'x', ops: ops! })
    expect((await reopened.stats()).settings).toEqual(retention)
  })

  it('evicts the oldest session files under the session-count cap', async () => {
    const t = await testStore()
    t.store.upsert(correlated('old', 'session-old'))
    await t.store.flush()
    await new Promise(resolve => setTimeout(resolve, 20))
    t.store.upsert(correlated('new', 'session-new'))
    await t.store.flush()
    const { maintenance } = await t.store.updateSettings({ ...DEFAULT_RETENTION, maxSessions: 1 })
    expect(maintenance.removedSessions).toBe(1)
    const names = await readdir(t.path('sessions'))
    expect(names).toEqual([`${encodeSessionKey('session-new')}.jsonl`])
  })

  it('clear removes every history file and keeps settings.json', async () => {
    const t = await testStore()
    t.store.upsert(correlated('r1'), IDENTITY)
    t.store.upsert(record('r9'))
    await t.store.updateSettings({ ...DEFAULT_RETENTION, maxSessions: 5 })
    const cleared = await t.store.clear()
    expect(cleared.removedSessions).toBe(1)
    expect(cleared.removedBytes).toBeGreaterThan(0)
    expect(await readdir(t.path('sessions'))).toEqual([])
    expect(await readdir(t.dir)).toEqual(['sessions', 'settings.json'].sort())
    expect(await t.store.summaries('session-1')).toEqual([])
  })

  it('reports availability, settings, and file accounting through stats', async () => {
    const t = await testStore()
    t.store.upsert(correlated('r1'), IDENTITY)
    await t.store.flush()
    const stats = await t.store.stats()
    expect(stats).toMatchObject({ available: true, location: 'test-root', sessions: 1, settings: DEFAULT_RETENTION })
    expect(stats.bytes).toBeGreaterThan(0)
  })

  it('unscoped get answers only from the unassigned log', async () => {
    const t = await testStore()
    t.store.upsert(correlated('r1'), IDENTITY)
    t.store.upsert(record('r9'))
    await t.store.flush()
    expect(await t.store.get(undefined, 'r9')).toMatchObject({ id: 'r9' })
    expect(await t.store.get(undefined, 'r1')).toBeUndefined()
    expect(await t.store.get('session-1', 'r1', IDENTITY)).toMatchObject({ id: 'r1' })
  })
})

describe('the lazy history seam', () => {
  it('queues a write issued before the store finished opening', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arp-lazy-'))
    cleanupDirs.push(dir)
    const history = new LazyReviewHistory({ env: { DSH_HOME: dir } })
    history.upsert(correlated('r1'), IDENTITY)
    await history.flush()
    expect(await history.summaries('session-1', IDENTITY)).toHaveLength(1)
    await history.close()
  })

  it('degrades to unavailable when the root cannot be a directory', async () => {
    const blocker = join(await mkdtemp(join(tmpdir(), 'arp-block-')), 'not-a-dir')
    cleanupDirs.push(join(blocker, '..'))
    await writeFile(blocker, 'file, not a directory')
    const history = new LazyReviewHistory({ env: { DSH_HOME: join(blocker, 'inside') } })
    const stats = await history.stats()
    expect(stats.available).toBe(false)
    await expect(history.updateSettings(DEFAULT_RETENTION)).rejects.toThrow('unavailable')
    await expect(history.clear()).rejects.toThrow('unavailable')
    // Reads and fire-and-forget writes still cost nothing.
    expect(await history.summaries('s')).toEqual([])
    history.upsert(record('r1'))
    await history.flush()
    await history.close()
  })
})

describe('host integration', () => {
  it('persists a captured record and serves it through list after the memory copy is gone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arp-host-'))
    cleanupDirs.push(dir)
    const history = new LazyReviewHistory({ env: { DSH_HOME: dir } })
    const host = makeHost({ history, globalCapacity: 1, sessionCapacity: 1 })
    await capture(host)
    await history.flush()
    await capture(host) // evicts review-1 from the ring
    await history.flush()
    const result = await host.handle('list', { sessionId: 'session-1' })
    expect(result).toMatchObject({ ok: true })
    const value = (result as { value: { records: { id: string }[] } }).value
    expect(value.records.map(record => record.id)).toEqual(['review-2', 'review-1'])
    const get = await host.handle('get', { id: 'review-1', sessionId: 'session-1' })
    expect(get).toMatchObject({ ok: true })
    await history.close()
  })

  it('persists correlation and host outcome as they land', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arp-host-'))
    cleanupDirs.push(dir)
    const history = new LazyReviewHistory({ env: { DSH_HOME: dir } })
    const host = makeHost({ history })
    await capture(host)
    await runExecution(host, execution())
    await history.flush()
    const persisted = await history.get('session-1', 'review-1', IDENTITY)
    expect(persisted).toMatchObject({ correlation: { sessionId: 'session-1', callId: 'call-1' } })
    await history.close()
  })

  it('never lets a misbehaving history touch capture or correlation', async () => {
    const hostile = new Proxy<Record<string, unknown>>({}, {
      get: () => () => {
        throw new Error('store explodes')
      },
    })
    const host = makeHost({ history: hostile as never })
    const chunks = await capture(host)
    expect(chunks.length).toBeGreaterThan(0)
    await runExecution(host, execution())
    const list = await host.handle('list', { sessionId: 'session-1' })
    expect(list).toMatchObject({ ok: true })
  })

  it('clear endpoint wipes disk and memory together', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arp-host-'))
    cleanupDirs.push(dir)
    const history = new LazyReviewHistory({ env: { DSH_HOME: dir } })
    const host = makeHost({ history })
    await capture(host)
    await history.flush()
    expect(await host.handle('clear', {})).toMatchObject({
      ok: false, error: { code: 'panel/bad-request' },
    })
    const cleared = await host.handle('clear', { confirm: true })
    expect(cleared).toMatchObject({ ok: true })
    expect(await host.handle('list', { sessionId: 'session-1' })).toMatchObject({
      ok: true, value: { records: [] },
    })
    await history.close()
  })

  it('update-settings validates the retention triple', async () => {
    const host = makeHost({ history: new LazyReviewHistory({ env: { DSH_HOME: await mkdtemp(join(tmpdir(), 'arp-host-')) } }) })
    expect(await host.handle('update-settings', { retention: { maxRecordsPerSession: -1, maxSessions: 0, maxTotalMegabytes: 0 } }))
      .toMatchObject({ ok: false, error: { code: 'panel/bad-request' } })
    expect(await host.handle('update-settings', {}))
      .toMatchObject({ ok: false, error: { code: 'panel/bad-request' } })
  })

  it('update-settings and clear fail honestly when no persistence exists', async () => {
    const host = makeHost()
    expect(await host.handle('update-settings', { retention: DEFAULT_RETENTION }))
      .toMatchObject({ ok: false, error: { code: 'panel/persistence-unavailable' } })
    expect(await host.handle('clear', { confirm: true }))
      .toMatchObject({ ok: false, error: { code: 'panel/persistence-unavailable' } })
  })

  it('stats degrades to memory-only shape without persistence', async () => {
    const host = makeHost()
    const result = await host.handle('stats', {})
    expect(result).toMatchObject({ ok: true, value: { available: false } })
  })

  it('list pages over the merged memory+disk view with a stable cursor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'arp-host-'))
    cleanupDirs.push(dir)
    const history = new LazyReviewHistory({ env: { DSH_HOME: dir } })
    // Host A captures three records; host B is the "restart" — fresh memory,
    // same persistence.
    const first = makeHost({ history })
    await capture(first)
    await capture(first)
    await capture(first)
    await history.flush()
    const restarted = makeHost({ history })
    const firstPage = await restarted.handle('list', { sessionId: 'session-1', limit: 2 })
    expect(firstPage).toMatchObject({ ok: true })
    const page1 = (firstPage as { value: PanelListValue }).value
    expect(page1.records.map(record => record.id)).toEqual(['review-3', 'review-2'])
    expect(page1.page).toMatchObject({ hasMore: true })
    const secondPage = await restarted.handle('list', {
      sessionId: 'session-1',
      limit: 2,
      before: page1.page.before,
    })
    const page2 = (secondPage as { value: PanelListValue }).value
    expect(page2.records.map(record => record.id)).toEqual(['review-1'])
    expect(page2.page.hasMore).toBe(false)
    await history.close()
  })

  it('rejects a malformed before cursor', async () => {
    const host = makeHost()
    expect(await host.handle('list', { sessionId: 'session-1', before: 'not-a-cursor' }))
      .toMatchObject({ ok: false, error: { code: 'panel/bad-request' } })
  })
})

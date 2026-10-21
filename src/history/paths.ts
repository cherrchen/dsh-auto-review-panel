/**
 * Where the history lives and how it is written.
 *
 * The root resolves through `@deepseek-ai/dsh-home-paths` when that optional
 * peer is installed — it is loaded through a dynamic `import()`, never a
 * static one, so an installation without it is legal and falls back to
 * `$DSH_HOME`/`~/.dsh` directly. The same on-demand load applies to
 * `@deepseek-ai/dsh-atomic-write`: with it, appends and compactions hold a
 * cross-process `<file>.lock` and every rewrite goes through its atomic
 * rename; without it the store degrades to in-process serialization plus a
 * temp-file rename, which is exactly the documented weak spot (two profiles
 * sharing one home then race as last-writer-wins).
 *
 * @module @dsh-electron/dsh-auto-review-panel/history/paths
 */

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** The directory layout version under the history root — `v1` holds schema 1. */
export const HISTORY_DIR_NAME = 'auto-review-panel/v1'

/** A resolved history root: the absolute path plus its symbolic display form. */
export interface HistoryLocation {
  /** Absolute directory the store opens. */
  readonly root: string
  /**
   * Symbolic spelling for the settings page and `stats.location` — the same
   * contract `dshHomeDisplay` gives upstream (`~/.dsh` or `$DSH_HOME`), never
   * a machine path.
   */
  readonly display: string
}

/** The file-shape operations the store needs, resolved once. */
export interface HistoryFileOps {
  /** Replace `file` with `content` atomically, `0o600` file / `0o700` dirs. */
  writeAtomic(file: string, content: string | Uint8Array): Promise<void>
  /**
   * Serialize one read-modify-write cycle on `file`. With `dsh-atomic-write`
   * this is the cross-process `<file>.lock`; without it the per-file write
   * queue is the only serialization (`crossProcess === false`).
   */
  locked<T>(file: string, operation: () => Promise<T>): Promise<T>
  /** Whether `locked` actually excludes other processes. */
  readonly crossProcess: boolean
}

/** The env variables this module reads, injectable for tests. */
export type HistoryEnv = Record<string, string | undefined>

/**
 * Resolve the history root through the optional `dsh-home-paths` peer.
 * @param env - the environment to read `DSH_HOME` from.
 * @returns the absolute root and its symbolic display spelling.
 */
export async function resolveHistoryRoot(env: HistoryEnv = process.env): Promise<HistoryLocation> {
  const suffix = HISTORY_DIR_NAME
  try {
    const paths = await import('@deepseek-ai/dsh-home-paths')
    const home = paths.resolveDshHome(undefined, env)
    return { root: join(home, ...suffix.split('/')), display: `${paths.dshHomeDisplay(home)}/${suffix}` }
  } catch {
    const override = env['DSH_HOME']?.trim()
    const root = override === undefined || override === '' ? join(homedir(), '.dsh') : override
    return {
      root: join(root, ...suffix.split('/')),
      display: `${override === undefined || override === '' ? '~/.dsh' : '$DSH_HOME'}/${suffix}`,
    }
  }
}

/**
 * The fallback atomic write: exclusive temp file in the same directory, then
 * rename — the same commit discipline `writeFileAtomic` implements, minus its
 * Windows retry window.
 */
async function writeAtomicFallback(file: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(temp, content, { mode: 0o600 })
  try {
    await rename(temp, file)
  } catch (error) {
    try {
      const { rm } = await import('node:fs/promises')
      await rm(temp, { force: true })
    } catch {
      // The temp is debris; the rename failure is the diagnosis that matters.
    }
    throw error
  }
}

/**
 * Resolve the file operations through the optional `dsh-atomic-write` peer,
 * falling back to in-process-only coordination when it is absent.
 */
export async function createFileOps(): Promise<HistoryFileOps> {
  try {
    const atomic = await import('@deepseek-ai/dsh-atomic-write')
    return {
      crossProcess: true,
      writeAtomic: (file, content) => atomic.writeFileAtomic(file, content, { mode: 0o600, dirMode: 0o700 }),
      locked: (file, operation) => atomic.withFileLock(file, operation),
    }
  } catch {
    return {
      crossProcess: false,
      writeAtomic: writeAtomicFallback,
      locked: (_file, operation) => operation(),
    }
  }
}

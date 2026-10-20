/**
 * Shared repository-path fixture.
 *
 * @module tests/support/repo-root
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root (this file lives in `tests/support/`). */
export const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))

/**
 * The DSH compatibility contract.
 *
 * Three properties are pinned here, because each of them is a way the contract
 * could quietly stop being a contract:
 *
 * 1. the allowlist is a list of EXACT versions, and the release this suite runs
 *    against is on it — a suite passing against an unverified release is the
 *    exact failure this whole mechanism exists to prevent;
 * 2. `package.json`'s `peerDependencies` say the same thing as the allowlist —
 *    npm metadata that over-promises is what started this work;
 * 3. incomplete, mixed and unsupported installations are each refused, loudly,
 *    with the offending versions named.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertSupportedInstallation, DshCompatUnsupportedError } from '../src/compat.ts'
import {
  classifyInstallation,
  compatEnforcement,
  CORE_PACKAGES,
  HOST_SERVICE_PACKAGES,
  OPTIONAL_CORE_PACKAGES,
  readInstalledVersion,
  REQUIRED_CORE_PACKAGES,
  RUNTIME_OPTIONAL_PACKAGES,
  SUPPORTED_DSH_RELEASES,
  type VersionReader,
} from '../src/compat/dsh-version.ts'
import { REPO_ROOT } from './support/repo-root.ts'

/** A reader that reports one version for everything, then applies overrides. */
function reader(base: string | undefined, overrides: Record<string, string | undefined> = {}): VersionReader {
  return name => (name in overrides ? overrides[name] : base)
}

const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  peerDependencies: Record<string, string>
  devDependencies: Record<string, string>
}

describe('the supported release list', () => {
  it('is a non-empty list of exact versions, not ranges', () => {
    expect(SUPPORTED_DSH_RELEASES.length).toBeGreaterThan(0)
    for (const release of SUPPORTED_DSH_RELEASES) {
      expect(release, `${release} must be an exact version`).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/)
    }
  })

  it('has no duplicate entries', () => {
    expect([...new Set(SUPPORTED_DSH_RELEASES)]).toEqual([...SUPPORTED_DSH_RELEASES])
  })

  it('inspects every package this plugin couples to, required before optional', () => {
    expect(CORE_PACKAGES).toEqual([...REQUIRED_CORE_PACKAGES, ...OPTIONAL_CORE_PACKAGES])
    expect(new Set(CORE_PACKAGES).size).toBe(CORE_PACKAGES.length)
  })

  it('partitions the optional packages by who would load the resolved copy', () => {
    // Every optional package is either loaded by this plugin at run time (its
    // resolved copy testifies wherever it lives) or consumed only as a mounted
    // host service (only a copy outside this package's own root testifies).
    const partitioned = [...RUNTIME_OPTIONAL_PACKAGES, ...HOST_SERVICE_PACKAGES]
    expect([...partitioned].sort()).toEqual([...OPTIONAL_CORE_PACKAGES].sort())
    expect(new Set(partitioned).size).toBe(partitioned.length)
  })
})

/**
 * Whether this run is an upgrade probe.
 *
 * The two lanes ask different questions of the installed release, so exactly one
 * of the two cases below applies:
 *
 * - the normal lane asserts the installation IS supported, which is what makes
 *   the rest of the suite valid evidence for the allowlist;
 * - the upgrade lane runs against a candidate that is deliberately not on the
 *   allowlist yet, so it asserts only that warn mode let it through — and that
 *   even warn mode still refuses a tree that mixes releases.
 */
const upgradeLane = compatEnforcement() === 'warn'

describe('the release this suite runs against', () => {
  it.skipIf(upgradeLane)('is on the allowlist, with every core package agreeing on it', () => {
    const report = classifyInstallation()
    expect(report.message).toContain('auto review panel')
    expect(report.verdict).toBe('supported')
    expect(report.release).toBeDefined()
    expect(SUPPORTED_DSH_RELEASES).toContain(report.release)
  })

  it.skipIf(!upgradeLane)('is a candidate the warn mode deliberately let through', () => {
    const report = classifyInstallation()
    expect(['unsupported', 'supported']).toContain(report.verdict)
    expect(() => assertSupportedInstallation(report, 'warn')).not.toThrow()
  })

  it('is the version the manifest pins for development', () => {
    const report = classifyInstallation()
    expect(report.release ?? manifest.devDependencies['@deepseek-ai/dsh']).toBe(manifest.devDependencies['@deepseek-ai/dsh'])
  })

  it('resolves through the same peer copy the plugin will call at runtime', () => {
    for (const name of REQUIRED_CORE_PACKAGES) {
      expect(readInstalledVersion(name), `${name} must resolve`).toBeTypeOf('string')
    }
  })
})

describe('host-service package inspection', () => {
  it('ignores a host-service package whose only resolution lands inside this package\'s own root', () => {
    // devDependencies place a private copy of every host-service package inside
    // this checkout; none of them may testify — the composition's copy is the
    // only one that can execute.
    for (const name of HOST_SERVICE_PACKAGES) {
      expect(readInstalledVersion(name), `${name} must not testify from inside the plugin tree`).toBeUndefined()
    }
  })

  it('keeps the runtime-optional bucket empty while no optional peer is imported at run time', () => {
    expect(RUNTIME_OPTIONAL_PACKAGES).toEqual([])
  })

  it('does not let a private dsh-llm copy testify — the plugin never imports it at run time', () => {
    // `dsh-llm` arrives only as the mounted `llm` service and ambient types;
    // the copy inside this checkout is the devDependency, not the
    // composition's, so it must be read as absent.
    expect(readInstalledVersion('@deepseek-ai/dsh-llm')).toBeUndefined()
  })
})

describe('peerDependencies and the allowlist agree', () => {
  it('declares exactly the allowlisted releases for every dsh peer', () => {
    const expected = SUPPORTED_DSH_RELEASES.join(' || ')
    for (const [name, range] of Object.entries(manifest.peerDependencies)) {
      if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
      expect(range, `peerDependencies["${name}"]`).toBe(expected)
    }
  })

  it('declares every required core package as a peer', () => {
    for (const name of REQUIRED_CORE_PACKAGES) {
      expect(manifest.peerDependencies, `${name} must be a peer`).toHaveProperty(name)
    }
  })
})

describe('an installation that cannot be judged', () => {
  it('is incomplete when a required package is absent, and names it', () => {
    const report = classifyInstallation(reader('0.2.1-rc.2', { '@deepseek-ai/dsh-tools': undefined }))
    expect(report.verdict).toBe('incomplete')
    expect(report.message).toContain('@deepseek-ai/dsh-tools')
  })

  it('stays supported when only an optional package is absent', () => {
    const release = SUPPORTED_DSH_RELEASES[0]
    const report = classifyInstallation(reader(release, { '@deepseek-ai/dsh-client-connection': undefined }))
    expect(report.verdict).toBe('supported')
    expect(report.release).toBe(release)
  })
})

describe('a mixed installation', () => {
  it('is refused when two required packages disagree, and both releases are named', () => {
    const report = classifyInstallation(reader('0.2.1-rc.2', { '@deepseek-ai/dsh-tools': '0.2.1-rc.1' }))
    expect(report.verdict).toBe('mixed')
    expect(report.message).toContain('0.2.1-rc.2')
    expect(report.message).toContain('0.2.1-rc.1')
  })

  it('is refused when an OPTIONAL package disagrees, not just a required one', () => {
    const report = classifyInstallation(reader('0.2.1-rc.2', { '@deepseek-ai/dsh-agent-instructions': '0.2.1-rc.1' }))
    expect(report.verdict).toBe('mixed')
  })

  it('reports the inspected inventory so the odd package out is visible', () => {
    const report = classifyInstallation(reader('0.2.1-rc.2', { '@deepseek-ai/dsh-tools': '0.2.1-rc.1' }))
    expect(report.message).toContain('@deepseek-ai/dsh-tools 0.2.1-rc.1')
  })
})

describe('an unsupported release', () => {
  it('is refused even when every package agrees on it', () => {
    const report = classifyInstallation(reader('0.9.9'))
    expect(report.verdict).toBe('unsupported')
    expect(report.release).toBe('0.9.9')
  })

  it('names the installed release, the allowlist, and where to recover', () => {
    const report = classifyInstallation(reader('0.9.9'))
    expect(report.message).toContain('0.9.9')
    expect(report.message).toContain('0.2.1-rc.2')
    expect(report.message).toContain('unsupported-dsh-release')
  })

  it('is refused for a release BELOW the allowlist too, not just above it', () => {
    expect(classifyInstallation(reader('0.2.1-alpha.5')).verdict).toBe('unsupported')
  })
})

describe('the gate policy', () => {
  it('lets a supported installation through without a warning', () => {
    const report = classifyInstallation(reader(SUPPORTED_DSH_RELEASES[0]))
    expect(assertSupportedInstallation(report, 'enforce')).toBeUndefined()
  })

  it('refuses an unsupported installation under enforce, carrying the report', () => {
    const report = classifyInstallation(reader('0.9.9'))
    expect(() => assertSupportedInstallation(report, 'enforce'))
      .toThrowError(DshCompatUnsupportedError)
    try {
      assertSupportedInstallation(report, 'enforce')
      expect.unreachable('the gate must throw')
    } catch (error) {
      expect((error as DshCompatUnsupportedError).report.verdict).toBe('unsupported')
    }
  })

  it('refuses a mixed installation under enforce', () => {
    const report = classifyInstallation(reader('0.2.1-rc.2', { '@deepseek-ai/dsh-tools': '0.2.1-rc.1' }))
    expect(() => assertSupportedInstallation(report, 'enforce')).toThrow(DshCompatUnsupportedError)
  })

  it('still refuses a mixed installation under warn', () => {
    const report = classifyInstallation(reader('0.2.1-rc.2', { '@deepseek-ai/dsh-tools': '0.2.1-rc.1' }))
    expect(() => assertSupportedInstallation(report, 'warn')).toThrow(DshCompatUnsupportedError)
  })

  it('still refuses an incomplete installation under warn', () => {
    const report = classifyInstallation(reader('0.2.1-rc.2', { '@deepseek-ai/dsh-tools': undefined }))
    expect(() => assertSupportedInstallation(report, 'warn')).toThrow(DshCompatUnsupportedError)
  })

  it('lets an unsupported-but-coherent release through under warn, with a marked warning', () => {
    const report = classifyInstallation(reader('0.9.9'))
    const warning = assertSupportedInstallation(report, 'warn')
    expect(warning).toContain('DSH_AUTO_REVIEW_PANEL_COMPAT=warn')
    expect(warning).toContain('0.2.1-rc.2')
  })
})

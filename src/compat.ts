/**
 * `auto-review-panel-compat`: the startup gate that turns the DSH
 * compatibility contract from documentation into a precondition.
 *
 * Every widened-authority row of this bundle injects `autoReviewPanelCompat`.
 * Cordis will not start a plugin whose injected service is absent, so this row
 * is what decides whether they run at all:
 *
 * ```text
 * compat check passes  →  ctx.autoReviewPanelCompat exists  →  the gated rows start
 * compat check fails   →  the row throws                    →  they never start
 * ```
 *
 * The gate is a plain `apply` and not a `Service` subclass mounted directly:
 * the check has to be able to fail BEFORE the service exists. A `Service`
 * constructor has already run `super(ctx, name)` — and therefore already
 * claimed the service key — by the time it could inspect anything.
 *
 * The verdict itself, and the allowlist it is judged against, live in
 * `./compat/dsh-version.ts`. This module owns only the reaction to it.
 *
 * @module @dsh-electron/dsh-auto-review-panel/compat
 */

import { Context, Service } from '@deepseek-ai/cordis'
import {
  classifyInstallation,
  compatEnforcement,
  COMPAT_ENFORCEMENT_ENV,
  SUPPORTED_DSH_RELEASES,
  type CompatEnforcement,
  type CompatReport,
} from './compat/dsh-version.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    autoReviewPanelCompat: AutoReviewPanelCompatService
  }
}

/**
 * Raised when the installed DSH release is not one this plugin is verified
 * against. It is thrown from `apply`, so it surfaces as a plugin load failure
 * with the full diagnosis attached — never as a silently degraded review
 * surface.
 */
export class DshCompatUnsupportedError extends Error {
  /** The report that produced the refusal. */
  readonly report: CompatReport

  constructor(report: CompatReport) {
    super(report.message)
    this.name = 'DshCompatUnsupportedError'
    this.report = report
  }
}

/**
 * The `ctx.autoReviewPanelCompat` service: the resolved compatibility verdict,
 * held where the gated rows can read it.
 *
 * It intentionally exposes no per-version capability flags. The adapters under
 * `./compat/` detect the shape they need STRUCTURALLY — whether a return value
 * is a thenable, which export name a module carries — because a structural
 * probe also survives upstream reshaping something within one release, while a
 * version comparison does not. The release string here is for the gate and for
 * diagnostics.
 */
export class AutoReviewPanelCompatService extends Service {
  /** The verdict this composition started under. */
  readonly report: CompatReport

  constructor(ctx: Context, report: CompatReport) {
    super(ctx, 'autoReviewPanelCompat')
    this.report = report
  }

  /** The single DSH release every inspected core package agreed on. */
  get release(): string | undefined {
    return this.report.release
  }

  /** Whether the installation is on the allowlist. */
  get supported(): boolean {
    return this.report.verdict === 'supported'
  }
}

/** This row needs nothing: it is the thing everything else waits for. */
export const inject: string[] = []

/**
 * Apply the gate policy to one report.
 *
 * Under `DSH_AUTO_REVIEW_PANEL_COMPAT=warn` exactly one verdict is relaxed: an
 * `unsupported` release that every inspected package agrees on. That is the
 * only shape the upgrade smoke probes — a coherent tree on a release the
 * allowlist does not name yet, which is how a release earns its place there.
 * `mixed` and `incomplete` describe an installation the contract cannot judge
 * at all, so they are refused in either mode; production deployments leave the
 * variable unset and get the refusal for everything.
 * @param report - the verdict to act on.
 * @param enforcement - how to react to a non-`supported` verdict.
 * @returns the warning to log, or `undefined` when there is nothing to say.
 * @throws {DshCompatUnsupportedError} when refusing to run.
 */
export function assertSupportedInstallation(
  report: CompatReport,
  enforcement: CompatEnforcement,
): string | undefined {
  if (report.verdict === 'supported') return undefined
  // `warn` relaxes exactly one verdict: a coherent installation on a release
  // the allowlist does not name yet — the only thing the upgrade lane probes.
  // `mixed` and `incomplete` describe an installation the contract cannot judge
  // at all, so they are refused in either mode.
  if (enforcement === 'enforce' || report.verdict !== 'unsupported') throw new DshCompatUnsupportedError(report)
  return `${report.message}\n\nProceeding anyway because ${COMPAT_ENFORCEMENT_ENV}=warn. `
    + 'This is an upgrade-smoke mode: a review surface is about to be mounted on an '
    + 'upstream release shape that has not been verified on this release. Supported releases: '
    + `${SUPPORTED_DSH_RELEASES.join(', ')}.`
}

/**
 * Judge the installation, then either refuse to provide the service or provide
 * it.
 * @param ctx - the row's context.
 */
export function apply(ctx: Context): void {
  const report = classifyInstallation()
  const warning = assertSupportedInstallation(report, compatEnforcement())
  if (warning !== undefined) ctx.logger.warn(warning)
  ctx.plugin(AutoReviewPanelCompatService, report)
}

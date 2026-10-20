/**
 * Barrel for the auto review panel bundle's host half.
 *
 * The loader mounts the plugin's responsibilities through the subpath entries
 * declared in `package.json` and `cordis.patch.yml` (`./compat`, `./panel`);
 * this entry carries only the no-op `apply` below. The patch still inserts a
 * row with THIS specifier (the bare package name) because the web
 * client-module scan reads a package's `dsh.client` declaration solely from a
 * loader row mounted at its package root — subpath rows are never client
 * rows — so without that row the browser is never served `lib/client.js` and
 * the sidebar footer action never registers. The barrel itself stays
 * side-effect free so tests can import the whole public surface from a single
 * specifier.
 *
 * @module @dsh-electron/dsh-auto-review-panel
 */

export { DshCompatUnsupportedError, AutoReviewPanelCompatService, assertSupportedInstallation } from './compat.ts'
export { PANEL_CHANNEL } from './contract.ts'
export {
  classifyInstallation,
  compatEnforcement,
  CORE_PACKAGES,
  HOST_SERVICE_PACKAGES,
  OPTIONAL_CORE_PACKAGES,
  readInstalledVersion,
  REQUIRED_CORE_PACKAGES,
  RUNTIME_OPTIONAL_PACKAGES,
  SUPPORTED_DSH_RELEASES,
} from './compat/dsh-version.ts'
export type {
  CompatEnforcement,
  CompatReport,
  CompatVerdict,
  InspectedPackage,
  SupportedDshRelease,
  VersionReader,
} from './compat/dsh-version.ts'

/**
 * Carrier plugin face for the bare-package-name loader row (see the module
 * doc). It deliberately provides nothing: every host responsibility is owned
 * by a subpath entry, and this row exists only so the web client-module scan
 * can locate the package root and read its `dsh.client` declaration.
 */
export const inject: string[] = []

export function apply(): void {}

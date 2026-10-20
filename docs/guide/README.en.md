# User Guide

中文：[README.md](./README.md)

The user-facing guide: the top-level README covers the "how"; this guide fills in the "why" and the exact semantics, for the moments the defaults don't cover.

## Contents

- [Why the supported matrix is an exact list](#why-the-supported-matrix-is-an-exact-list)
- [What the composition actually does](#what-the-composition-actually-does)
- [Differences between install sources](#differences-between-install-sources)

## Why the supported matrix is an exact list

Both halves of this plugin sit on seams upstream makes **no semver promise** for: the client slot names, the Connection channel, and the composition rows' mount semantics. So `peerDependencies` names only the releases that have actually been through the full verification, and startup checks again: if the host's release is not on the list, or several `@deepseek-ai/dsh-*` packages disagree about which release they are, the gated `auto-review-panel` row **does not start**, the composition degrades to "this plugin is not installed", and one explanatory line is logged. To diagnose, see [troubleshooting](../troubleshooting/unsupported-dsh-release.md); for the reasoning, [ADR-0001](../decisions/ADR-0001-dsh-compat-contract.md).

## What the composition actually does

`cordis.patch.yml` does exactly one thing: it inserts this plugin's three rows into the upstream bundle — the compatibility gate, the panel's host half, and the client-graph anchor mounted at the bare package name. It **disables nothing** upstream: the panel is an observation surface and replaces no existing capability. What each row is for — and why the bare-name row cannot be skipped — is covered by [troubleshooting](../troubleshooting/client-bundle-not-in-boot-graph.md) and `tests/patch.spec.ts`.

## Differences between install sources

- **npm / tarball (once published)**: pre-built artifacts, ready to use.
- **GitHub**: delivers source code, built automatically during `add` by the package's own `prepare` script (a direct bundle of `src/`, no type-checking), so `allowBuilds` has to cover this package itself. With no ref the install tracks the head of `main`; a version ref like `#vX.Y.Z` pins the content.
- **From source**: pnpm `link:` links the local checkout; dependencies are already installed in this repository and no `allowBuilds` is needed — but `pnpm build` must run first to produce `lib/` (not tracked by Git).

When running DSH from a source checkout, `dsh` is not on PATH — replace `dsh` in the commands with `pnpm dsh`.

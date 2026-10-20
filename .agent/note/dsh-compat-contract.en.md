# Agent Note: The DSH Compatibility Contract

中文：[dsh-compat-contract.md](./dsh-compat-contract.md)

This repository turned "which upstream releases this plugin supports" into a code contract. This note records the pitfalls a future Agent is most likely to hit.

## Single source of truth

`SUPPORTED_DSH_RELEASES` in `src/compat/dsh-version.ts`. It, every `@deepseek-ai/dsh*` entry in `peerDependencies` (an `a || b` exact-version or), the `devDependencies` development pin, and the actually installed tree in `node_modules` must **agree in all four places**; `pnpm compat:check` (`scripts/check-dsh-compat.mjs`) fails on any drift, and CI runs it before lint.

## How the gate affects tests

`auto-review-panel-compat` is the first row in `cordis.patch.yml`; the `auto-review-panel` row carries `inject: ['autoReviewPanelCompat']`. Cordis will not start a row whose injected service is missing — so on a refused verdict the panel row does not exist and the composition degrades to "plugin not installed". In a spec, `await mountCompat(ctx)` (`tests/support/compat.ts`) must run before mounting a gated row, otherwise you get the misleading `ctx.get('…') is undefined` — that is the gate working, not a bug.

## Adapter-layer rules

- Version differences live only in `src/compat/`; business code makes no version checks.
- Probe **structure**, never version strings: which export exists, whether the return is thenable, which method name is present.
- Optional packages come in two classes: `RUNTIME_OPTIONAL_PACKAGES` (packages this plugin actually `import()`s at run time — a copy inside the plugin's own root still testifies) and `HOST_SERVICE_PACKAGES` (consumed only as host-mounted services/types — only a copy outside the plugin's root testifies). Letting a host-service package testify wrongly makes a `link:` install read this repo's own devDependencies as the host's release and verdict a coherent host as `mixed`.
- Optional peers are consumed through dynamic `import()` only, never a static value import; "package absent" and "package present but failed to evaluate" are different diagnoses and must not be collapsed.

## The upgrade lane

`upgrade.yml` runs the full matrix weekly on a candidate release under `DSH_AUTO_REVIEW_PANEL_COMPAT=warn`:

- **The upgrade lane is its only legitimate caller.** Production deployments, user-facing docs, and making a red check go away are not.
- `warn` relaxes `unsupported` only; `mixed` and `incomplete` remain fail-closed.
- A green run is evidence a candidate *could* be supported, never the authorization. Promotion means a human edits `SUPPORTED_DSH_RELEASES` + `peerDependencies` and lands it as a reviewed change.

Local reproduction: `node scripts/upgrade-dsh.mjs <version>` (repin) → `pnpm install --no-frozen-lockfile --config.minimumReleaseAge=0` → `DSH_AUTO_REVIEW_PANEL_COMPAT=warn pnpm verify:all` → restore with `git checkout -- package.json pnpm-workspace.yaml pnpm-lock.yaml`. **Careful**: the restore command reverts those three files to HEAD entirely — commit or stash any uncommitted manifest changes before running an upgrade probe.

## Quiet pitfalls

- **`pnpm verify:all` excludes `compat:check` on purpose**: the upgrade lane must run the full matrix on an unlisted release. CI runs it separately before lint; check contract integrity locally with `pnpm compat:check`.
- **`pnpm test` depends on `pnpm build`**: `tests/client-bundle.spec.ts` asserts the built `lib/client.js` bytes; `lib/` is not in git, so a clean checkout must build first.
- **Cordis follows the dsh pin**: `upgrade-dsh.mjs` repoints the cordis dev pin to the exact floor the candidate `dsh` declares — two cordis copies in one tree break module-local Symbol identity and silently break tool scheduling.
- **The client anchor row mounts the bare package name**: `auto-review-panel-client`'s `name` is `@dsh-electron/dsh-auto-review-panel` (not a subpath) — the upstream client graph reads `dsh.client` only from bare-name rows. See [troubleshooting](../../docs/troubleshooting/client-bundle-not-in-boot-graph.md).

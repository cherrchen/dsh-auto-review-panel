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
- Optional packages come in two classes: `RUNTIME_OPTIONAL_PACKAGES` (packages this plugin actually `import()`s at run time — a copy inside the plugin's own root still testifies) and `HOST_SERVICE_PACKAGES` (consumed only as host-mounted services/types — only a copy outside the plugin's root testifies). Letting a host-service package testify wrongly makes a `link:` install read this repo's own devDependencies as the host's release and verdict a coherent host as `mixed`. `RUNTIME_OPTIONAL_PACKAGES` currently holds `dsh-atomic-write` + `dsh-home-paths` (M4 persistence dynamically `import()`s them in `src/history/paths.ts`, and a copy inside the plugin root really executes); `dsh-llm`, `dsh-agent` and friends are consumed only as mounted services or types and live in `HOST_SERVICE_PACKAGES`. A peer moves into the first bucket only when the plugin genuinely `import()`s it at run time.
- Optional peers are consumed through dynamic `import()` or as types only, never a static value import; "package absent" and "package present but failed to evaluate" are different diagnoses and must not be collapsed.

## The channel seam: rpc.handle vs a webServer named route

The physical registration of `PANEL_CHANNEL` lives in `src/compat/panel-channel.ts`. It first tries `connection.rpc.handle`; once cordis 4.0.6-alpha.2 (DSH 0.2.2-alpha.3+) resolves service properties at the **definition site**, that API's internal `owner.webServer` read hits Connection's own fiber (`inject: ['credentials']`) and throws `cannot get property "webServer" without inject` in a real composition — no upstream production code calls it, so only third-party plugins see the regression. The fallback registers the same prefix named route on `webServer`: authentication still goes through `connection.admit()` (no `admit` means no mount — an unauthenticated route is never a degradation), and the RPC envelope framing matches `rpc.handle` item by item (404/415/400/413 statuses, `gateway/bad-request`, `{type:'server-response',rpcId,result}`).

**Do not** "fix" this with version comparison or by deleting the fallback: the probe *is* the structural try/catch (which API actually registers), so older releases take the first path and newer ones land on the second automatically.

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
- **An allowlisted release must be published to npm first**: each CI matrix leg runs `upgrade-dsh.mjs` + `pnpm install` for its version, so an unpublished release 404s at install. Build the upstream tag in an isolated directory and link it to verify first (typecheck / build / the unit suite / the composition and packed smokes), but the dev pin, lockfile, and release-age entries move only after publication; `compat:check` requires the pin to be a member of the allowlist, not the newest member. `0.2.2-rc.2` is in exactly that state now.
- **The client anchor row mounts the bare package name**: `auto-review-panel-client`'s `name` is `@dsh-electron/dsh-auto-review-panel` (not a subpath) — the upstream client graph reads `dsh.client` only from bare-name rows. See [troubleshooting](../../docs/troubleshooting/client-bundle-not-in-boot-graph.md).

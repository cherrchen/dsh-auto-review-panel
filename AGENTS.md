# AGENTS.md

## Purpose

This file defines repository-wide instructions for Coding Agents working on this project.

More specific instructions may later be introduced by nested `AGENTS.md` files inside individual modules.

## Before Making Changes

Before modifying the repository:

1. Read this file.
2. Read `docs/README.md`.
3. Read documentation relevant to the task.
4. Inspect the current repository state instead of assuming documentation is perfectly up to date.
5. Prefer extending existing conventions over introducing parallel structures.
6. Check `.agent/note/` for relevant project knowledge when applicable.

## Documentation

Documentation is part of the implementation.

When a change affects documented behavior, architecture, workflows, interfaces, engineering decisions, or development processes, update the corresponding documentation in the same change.

Do not keep important project knowledge only in chat history, issue comments, or temporary Agent context.

## Documentation Locations

- `docs/requirements/` — requirements
- `docs/architecture/` — architecture and system design
- `docs/decisions/` — Architecture Decision Records
- `docs/plans/` — active and completed implementation plans
- `docs/development/` — development workflow and engineering practices
- `docs/reference/` — stable technical reference
- `docs/troubleshooting/` — recurring problems and verified solutions
- `.agent/note/` — durable Agent-oriented project knowledge
- `.agent/templates/` — templates used by Coding Agents
- `.agent/skills/documentation/SKILL.md` — documentation maintenance rules
- `CHANGELOG.md` / `CHANGELOG.en.md` — the user-visible changes of every released version, one section per release. This is the only home for "what changed in version X": the roadmap progress ledger owns release *state*, the CHANGELOG owns release *content*. Each release updates it before the tag is created (see `docs/development/release-workflow.md`).

## Documentation Maintenance

Documentation maintenance rules are defined in:

`.agent/skills/documentation/SKILL.md`

When creating, modifying, moving, or deleting project documentation, follow the Documentation Skill.

## Documentation Validation

Before completing changes that affect documentation, run the repository documentation check.

Use the canonical package script:

`docs:check`

The package manager adopted by this repository is pnpm, so the command is:

```bash
pnpm docs:check
```

A change with failing documentation checks is incomplete.

## Source of Truth

Avoid duplicating the same information across multiple documents.

Each important concept should have one canonical location.

Other documents should link to that source instead of copying its contents.

## Bilingual Documentation

Chinese is the primary documentation language.

For documents that require bilingual maintenance:

- `<name>.md` is the canonical Chinese version.
- `<name>.en.md` is the corresponding English version.

The two files are treated as one logical document: when you update one, check whether the other needs to be synchronized, and vice versa. If the two versions ever conflict, the Chinese version wins — fix the English version. Do not produce low-quality machine translation; the English version should read naturally and accurately express the meaning of the Chinese version.

All README documents and formal documents under `.agent/note/` must follow this convention. Do not create empty `.en.md` files for other document types unless bilingual maintenance is actually needed.

The changelog is maintained as a bilingual pair too (`CHANGELOG.md` / `CHANGELOG.en.md`): it is a user-facing document that ships inside the npm tarball alongside both READMEs, so an English reader must not hit a Chinese-only release history. Other types — ADRs, plans, reference, and troubleshooting entries — stay Chinese-only unless a real need appears.

## Current Project State

The project is an out-of-tree DSH plugin bundle (`@dsh-electron/dsh-auto-review-panel`) that gives the Auto permission preset's reviewer — Auto Review — a visible panel surface, without modifying any upstream package.

The repository's first release (`v0.1.0`) is prepared: review-record capture, host-outcome evidence, the sidebar.right panel, and per-session record persistence (`<DSH_HOME>/auto-review-panel/v1/` JSONL, retention settings page, keyset pagination) are implemented and verified against the real composed profile (`pnpm smoke:live`, official reviewer `@deepseek-ai/dsh-experimental-auto-review@0.2.1-rc.2` from npm `next`, including on-disk and restart-recovery assertions). Progress, numbering and release state have exactly one home: the progress ledger in `docs/plans/completed/2026-10-20-auto-review-panel.md`. The user-visible changes of each released version have exactly one home as well: `CHANGELOG.md` / `CHANGELOG.en.md`, which every release updates in the same change.

Nine invariants that must survive future changes:

1. **The client-graph anchor stays.** The web client-module scan reads this package's `dsh.client` only from a loader row mounted at the bare package name — subpath rows are never client rows. `cordis.patch.yml` must keep the `auto-review-panel-client` row (`name` = the bare package name, backed by the barrel's no-op `apply`), or `lib/client.js` never reaches the browser and the sidebar contribution silently disappears. See `docs/troubleshooting/client-bundle-not-in-boot-graph.md`.
2. **The compatibility gate is a precondition, not a diagnostic.** `auto-review-panel` injects `autoReviewPanelCompat`, and cordis will not start a row whose injected service is missing — so an unsupported or mixed installation makes the row simply not exist. Keep that injection on any new row that reads host services; a refused gate must degrade to "plugin not installed", never to a dead or half-mounted profile. Version-dependent code belongs only in `src/compat/`, and it must probe *structure* (which export exists? is the return thenable?) rather than compare version strings; packages the plugin never loads at run time (host-mounted services, type-only peers) must not testify from a plugin-private copy — see `HOST_SERVICE_PACKAGES` vs `RUNTIME_OPTIONAL_PACKAGES` in `src/compat/dsh-version.ts`.
3. **The panel never adjudicates.** It is a read surface over the official Auto Review's state: no second reviewer, no extra `tools/pre-execute` listener, no wrapping of `llm/stream`, no prompt-text matching, and no re-scoring of risk. If the surface cannot observe a verdict through a supported seam, it shows nothing rather than guessing. High-risk denials and medium-risk authorization semantics are upstream's contract, never reimplemented here — see `docs/reference/upstream-auto-review.md`.
4. **`DSH_AUTO_REVIEW_PANEL_COMPAT=warn` has exactly one legitimate caller: the upgrade lane.** `mixed` and `incomplete` verdicts are refused even under `warn`; only a coherent-but-unlisted `unsupported` release is let through, loudly. Never set it in production, in docs aimed at users, or to make a red check go away.
5. **Promoting a release is a human act.** A green upgrade lane is evidence a release *could* be supported — it never edits `SUPPORTED_DSH_RELEASES` or `peerDependencies` on its own. The promotion diff is reviewed like any other change.
6. **peers and the allowlist move together.** `SUPPORTED_DSH_RELEASES`, every `@deepseek-ai/dsh*` entry in `peerDependencies`, the devDependency pin, and the installed tree must agree; `pnpm compat:check` fails when any pair drifts. Never widen one without the other.
7. **Optional peers load on demand, never at import time.** `@deepseek-ai/dsh-llm` and the other optional packages are consumed through dynamic `import()` (or not at all); a static value import would turn an optional peer into a hard dependency and make an absent-but-legal installation look broken. "Package missing" and "package failed to evaluate" are different diagnoses and must not be collapsed.
8. **History is a side-channel audit log.** Persistence failures may lose records but must never change capture, tool execution, or upstream adjudication: `ReviewHistory.upsert()` is fire-and-forget, reads fail soft to empty/unavailable, and no write may ever block the review path. Correlated records are written to the session file *before* the `unassigned.jsonl` tombstone, so a crash can duplicate but never erase the only copy. Session-file headers carry the live `Session.header` identity triple; a stale lifecycle's file is renamed aside, never attributed to a new session — and a foreign schema file is never overwritten. See `src/history/` and `docs/decisions/ADR-0004-review-record-persistence.md`.
9. **The settings page is a soft seam.** The single `plugins.bundle.config` contribution (keyed by the package name, rendered on the package detail page) is a `ctx.slots.inject` registration: when the plugin-manager client is absent the sidebar tab must still work, and `stats`/`update-settings`/`clear` must degrade honestly (`available:false` / `panel/persistence-unavailable`) rather than break. Retention defaults to unlimited (`0` on all three axes); `clear` removes history files and in-memory records but keeps `settings.json`.

## Build, Test, and Verification

The canonical gate list, in CI order:

```bash
pnpm compat:check   # allowlist / peers / dev pin / installed tree agree
pnpm lint           # oxlint
pnpm typecheck      # tsc -p tsconfig.host.json && tsc -p tsconfig.client.json, noEmit
pnpm build          # declarations + tsdown bundle (host ESM + browser client)
pnpm test           # vitest; asserts the BUILT lib/ artifacts, so build first
pnpm smoke          # smoke:compose — real `dsh plugin add` into a scratch $DSH_HOME
pnpm pack:check     # tarball members, exports targets, patch-referenced modules
pnpm smoke:packed   # the composition smoke against the packed tarball
pnpm docs:check     # documentation structure check
```

`pnpm verify:all` runs the same list minus `compat:check`, deliberately: the upgrade lane must run the full matrix on a candidate the allowlist does not yet contain.

Details live in `docs/development/plugin-development-workflow.md`; when the two disagree, the package scripts are the source of truth (and the doc is stale — fix it in the same change).

## Upstream Coupling Constraints

- Never modify any package in the upstream repository (deepseek-harness). All deliverables are out-of-tree, installed through `dsh plugin add` or composed via the bundle patch.
- Import only through package entry points. Never deep-import `pkg/src/*`: the published tarballs do not ship those files (see `docs/decisions/ADR-0002-upstream-coupling-policy.md`).
- `@deepseek-ai/dsh*` packages are `peerDependencies` at exact allowlisted versions — the host provides the single copy the plugin runs against.
- The DSH development pin is `0.2.1-rc.3`; the allowlist is `src/compat/dsh-version.ts`'s `SUPPORTED_DSH_RELEASES`.

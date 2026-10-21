# User Guide

中文：[README.md](./README.md)

The user-facing guide: the top-level README covers the "how"; this guide fills in the "why" and the exact semantics, for the moments the defaults don't cover.

## Contents

- [Why the supported matrix is an exact list](#why-the-supported-matrix-is-an-exact-list)
- [What the composition actually does](#what-the-composition-actually-does)
- [Where review history lives, and for how long](#where-review-history-lives-and-for-how-long)
- [Differences between install sources](#differences-between-install-sources)

## Why the supported matrix is an exact list

Both halves of this plugin sit on seams upstream makes **no semver promise** for: the client slot names, the Connection channel, and the composition rows' mount semantics. So `peerDependencies` names only the releases that have actually been through the full verification, and startup checks again: if the host's release is not on the list, or several `@deepseek-ai/dsh-*` packages disagree about which release they are, the gated `auto-review-panel` row **does not start**, the composition degrades to "this plugin is not installed", and one explanatory line is logged. To diagnose, see [troubleshooting](../troubleshooting/unsupported-dsh-release.md); for the reasoning, [ADR-0001](../decisions/ADR-0001-dsh-compat-contract.md).

## What the composition actually does

`cordis.patch.yml` does exactly one thing: it inserts this plugin's three rows into the upstream bundle — the compatibility gate, the panel's host half, and the client-graph anchor mounted at the bare package name. It **disables nothing** upstream: the panel is an observation surface and replaces no existing capability. What each row is for — and why the bare-name row cannot be skipped — is covered by [troubleshooting](../troubleshooting/client-bundle-not-in-boot-graph.md) and `tests/patch.spec.ts`.

## Where review history lives, and for how long

Every review the panel captures — full request text, the four parsed sections, reasoning, verdict, and `hostOutcome` evidence — is persisted as **plaintext JSONL** under `<DSH_HOME>/auto-review-panel/v1/` (`~/.dsh/auto-review-panel/v1/` by default, overridable via the `$DSH_HOME` environment variable). The directory is `0700`, files `0600`; the UI shows the location in symbolic form (`~/.dsh/…` / `$DSH_HOME/…`).

- **Survives restarts**: history is restored per session — open a session under the same `$DSH_HOME` and its records are listed again, even if Auto Review has been disabled or the session no longer runs the Auto preset (records in hand beat every empty state).
- **Uncorrelated records stay globally visible**: calls the upstream reviewer stops with `deny + never` never reach session correlation; those records — the riskiest batch — land in `unassigned.jsonl` and appear in every session view.
- **Unlimited by default**: the three retention axes — records per session / sessions kept / total megabytes — all ship as `0` = unlimited. To tighten: plugin manager → this plugin's row → `auto-review-panel` Configure page; saving applies immediately and runs one maintenance pass (compaction, oldest-session eviction, total-size trimming).
- **Clearing**: "Clear all history" at the bottom of the same page (behind a confirmation dialog) removes every history file plus the in-memory records; retention settings are kept. Losing history never breaks the plugin — persistence is a pure side channel and no write failure can change a review or a tool execution.
- **Privacy boundary**: the on-disk content includes the complete request text and reasoning sent to the reviewer — plaintext, not encrypted, never uploaded. Treat it as a local sensitive file on shared machines; if you cannot keep it, set "records per session" low or keep the axes at `0` and clear periodically (there is no "persistence off" switch — the panel reads history through the same path).
- **No cross-session browser**: the session-less view shows only the current process's in-memory records — per-session restore is a deliberate boundary (see [ADR-0004](../decisions/ADR-0004-review-record-persistence.md)).

## Differences between install sources

- **npm / tarball (once published)**: pre-built artifacts, ready to use.
- **GitHub**: delivers source code, built automatically during `add` by the package's own `prepare` script (a direct bundle of `src/`, no type-checking), so `allowBuilds` has to cover this package itself. With no ref the install tracks the head of `main`; a version ref like `#vX.Y.Z` pins the content.
- **From source**: pnpm `link:` links the local checkout; dependencies are already installed in this repository and no `allowBuilds` is needed — but `pnpm build` must run first to produce `lib/` (not tracked by Git).

When running DSH from a source checkout, `dsh` is not on PATH — replace `dsh` in the commands with `pnpm dsh`.

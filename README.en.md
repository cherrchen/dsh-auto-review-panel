<div align="center">

# dsh-auto-review-panel

[中文](./README.md) | English

</div>

## Overview

Under DSH (DeepSeek Harness)'s Auto permission preset, the Auto Review reviewer adjudicates every tool call in the background — allow, pass, or deny — yet those verdicts are nearly invisible to the user: an approved call goes through silently, and a denied one leaves only a result message.

This plugin is an out-of-tree extension that modifies no upstream code and gives Auto Review **a visible panel**: it surfaces the reviewer's verdicts, risk levels, and rationale in the sidebar, so "why was this call approved or denied" is no longer a black box you can only guess at from session messages.

- **Read-only presentation, no verdict changes**: the panel is a UI/transport surface over the review state, not a second reviewer. Authorization policy, risk grading, and source classification belong entirely to the official Auto Review (see the [upstream survey](./docs/reference/upstream-auto-review.md)); this plugin never decides, intercepts, or recomputes a call — review content is captured through a read-only `llm/stream` observation seam — a fingerprint miss simply records nothing and never fabricates ([ADR-0003](./docs/decisions/ADR-0003-review-record-capture.md)).
- **Host/client halves**: the host half carries the channel that reads review state; the browser half renders it into the sidebar. The two halves talk over DSH's Connection channel — no private HTTP surface.
- **Absent config means absent plugin**: when the host's DSH release is not on the allowlist, or core packages mix releases, the plugin's rows simply do not start and the composition degrades to "plugin not installed" — a deliberate fail-closed, see [ADR-0001](./docs/decisions/ADR-0001-dsh-compat-contract.md).

The first release `v0.1.0` is ready: review-record capture, host-outcome evidence, and the sidebar.right panel have all landed, verified by `smoke:live` in a real composition against the official `@deepseek-ai/dsh-experimental-auto-review@0.2.1-rc.2` (npm `next`). Progress and release state live in the [roadmap progress ledger](./docs/plans/completed/2026-10-20-auto-review-panel.md#进度总账).

## Requirements

**Using this plugin**: one of the DSH releases in the table below (exact match, not a range). `dsh plugin` handles installation; no local Node toolchain is needed.

| DSH line | Supported releases |
| --- | --- |
| `0.2.1` | `0.2.1-rc.2` |

When the host's DSH release is not listed, or `@deepseek-ai/dsh-*` packages disagree on a version, the plugin does not start and behaves exactly as if it were not installed.

**Building from source / contributing**: Node.js `^22.19.0 || >=24`, pnpm `11.25.0` (enable via corepack); the development pin is DSH `0.2.1-rc.2`.

**Platforms**: macOS, Linux, Windows — the panel is a UI surface with no platform-specific execution semantics; the Windows CI lane is parked by default and can be enabled through the `DSH_WINDOWS_CI` repository variable when the panel grows platform-dependent behavior.

## Installation

The plugin is not yet published to npm. Only local-source installation is currently supported:

```sh
git clone https://github.com/cherrchen/dsh-auto-review-panel.git
cd dsh-auto-review-panel
export CI=true
pnpm install
pnpm build
dsh plugin --profile web add /path/to/repo
```

> [!TIP]
> When `dsh` is not on PATH (e.g. running DSH from a source checkout), replace `dsh` in the commands with `pnpm dsh`.

**Prerequisite**: this plugin only visualizes decisions an existing reviewer already made — it reviews nothing itself. For the panel to show anything, enable the official `@deepseek-ai/dsh-experimental-auto-review` first (it ships with the installation, off by default); if your installation does not carry it, install the exact `0.2.1-rc.2` explicitly — not the stale `latest`, and run the session under the Auto preset — missing either leaves the panel permanently empty.

## Development commands

Self-checks:

```sh
pnpm lint && pnpm typecheck
pnpm build
pnpm test
pnpm smoke
pnpm docs:check
```

Install into a DSH runtime and verify the composition:

```sh
dsh plugin --profile web add /path/to/repo
dsh --profile web --dump-config | grep -A3 'auto-review-panel'
```

Expected output:

```text
# == @dsh-electron/dsh-auto-review-panel
- id: auto-review-panel-compat
  name: '@dsh-electron/dsh-auto-review-panel/compat'
- id: auto-review-panel
  name: '@dsh-electron/dsh-auto-review-panel/panel'
- id: auto-review-panel-client
  name: '@dsh-electron/dsh-auto-review-panel'
```

All three plugin rows are mounted: `auto-review-panel-compat` is the boot gate, `auto-review-panel` is the panel's host half (it injects `autoReviewPanelCompat`, so a refused gate means it never starts), and `auto-review-panel-client` is mounted at the bare package name — the only anchor from which the web client graph reads this package's `dsh.client` declaration.

## Project structure

```text
.
├── src/
│   ├── compat.ts                    the auto-review-panel-compat boot gate (version allowlist and mixed-install verdicts)
│   ├── compat/dsh-version.ts        the compatibility contract itself: SUPPORTED_DSH_RELEASES, core-package lists, classification
│   ├── panel.ts                     the panel's host half: the autoReviewPanel service row (the review channel lands with the surface)
│   ├── client/                      browser half: the sidebar slot contribution lands with the surface
│   └── index.ts                     public-surface barrel; its no-op apply also backs the bare-name client-graph anchor row
├── tests/                           compatibility verdicts, patch invariants, client-artifact shape
├── scripts/                         smokes (compose / packed), compat-contract check, pack gate, upgrade flow, lefthook installer
└── docs/                            requirements, architecture, ADRs, plans, development workflow, troubleshooting
```

## Contributing

Issues and PRs are welcome:

1. Read [`AGENTS.md`](./AGENTS.md) (repository rules) and the [development workflow](./docs/development/plugin-development-workflow.md) (environment, commands, runtime support matrix, upgrade flow) first.
2. Branch from `main`; commit messages follow conventional commits (`feat` / `fix` / `perf` / `refactor` + scope), see the existing history.
3. Before opening a PR, all of the following must pass locally: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm docs:check`, `pnpm smoke` (CI runs them in the same order, build before test).
4. Changes that affect behavior must update the corresponding documents under `docs/` in the same change; keep the bilingual READMEs in sync; add an ADR for engineering decisions with trade-offs.
5. Hard constraint: **do not modify any package in the upstream repository (deepseek-harness)**; the plugin is strictly an out-of-tree extension.

## Known limitations

- Records live only in memory: nothing persists across a process restart, and records without a `correlation.callId` anchor stay honestly in the "uncorrelated" group with no host-outcome evidence.
- The support matrix is an exact-version allowlist: when the host release is unlisted, or core packages mix releases, the gated `auto-review-panel` row **does not start** and the composition degrades to "plugin not installed" ([ADR-0001](./docs/decisions/ADR-0001-dsh-compat-contract.md)).
- The official Auto Review exposes no dedicated data feed for a panel: verdicts and rationale must be read through existing host-side seams, and if upstream changes those seams' shape, only the adaptation layer or the upgrade lane can notice — this plugin makes no cross-version semantic guarantee ([upstream survey](./docs/reference/upstream-auto-review.md)).

## Documentation

Long-term project documentation lives in [`docs/`](./docs/README.md):

- [CHANGELOG](./CHANGELOG.md)
- [User guide](./docs/guide/README.md)
- [Requirements](./docs/requirements/auto-review-panel.md)
- [Upstream Auto Review survey](./docs/reference/upstream-auto-review.md)
- [Architecture Decision Records](./docs/decisions/README.md)
- [Plans](./docs/plans/README.md)
- [Development workflow](./docs/development/plugin-development-workflow.md)
- [Troubleshooting](./docs/troubleshooting/README.md)

Repository rules for Coding Agents are defined in [`AGENTS.md`](./AGENTS.md).

## License

[MIT](./LICENSE)

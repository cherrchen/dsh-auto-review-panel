# Changelog

This file records the user-visible changes of every **released** version.

中文: [CHANGELOG.md](./CHANGELOG.md)

- Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).
- Installation, supported upstream runtimes, and known limitations are in the [README](./README.md).
- Per-release implementation evidence, numbering, and release state live in the [roadmap progress ledger](./docs/plans/completed/2026-10-20-auto-review-panel.md#进度总账); GitHub Release bodies are generated from commit history by `scripts/release-notes.mjs` and are the complete raw list beyond this file.

## [Unreleased]

### Added

- Repository initialization: the out-of-tree bundle skeleton (the `auto-review-panel-compat` boot gate, the `auto-review-panel` host service row, and the `auto-review-panel-client` bare-package-name client-graph anchor), split host/client builds (tsdown + tsc declarations), the DSH compatibility contract (the `0.2.1-rc.2` exact-version allowlist, the supported/unsupported/mixed/incomplete verdicts, the `warn` upgrade lane), the composition smoke and pack gate, the CI / release / upgrade / diag workflows, the lefthook local commit hooks, and the bilingual README / CHANGELOG plus the docs tree.

- Review record capture (M1): a read-only `llm/stream` tee identifies the official Auto Review's review streams by structural fingerprint; records keep the full review request verbatim (`requestText`/`sections`), the original reasoning, the verdict output (`risk`/`decision`/`reason`/`rawText`), and `finish` anomalies; a `tools/pre-execute` in-flight table pins `correlation{sessionId, callId, downstreamDecision, denialInfo?}` by exact PENDING_ACTION match — ambiguity is left uncorrelated rather than guessed; a dual ring buffer (50 per session / 200 globally, re-confirmed by measurement).
- Host outcome evidence (M3): a `session/event` observer reads `tool/result` plus the `approval/asked`/`approval/decided` audit pair and attaches `hostOutcome{toolResult?, approval?}` to correlated records — `AUTO_REVIEW_DENIED` is evidenced at both the decision and the durable-log layer for `deny+never`, and the human-approval outcome of `deny+ask` is shown verbatim; records without a callId anchor are never evidenced.
- Panel UI (M2/M3): a new "Auto Review" tab in `sidebar.right` — a list (tool name + mode · risk/verdict tags · argument preview · rationale + time, grouped by current session / uncorrelated, with risk/decision filters) plus a detail view (overview card + four tabs — pending action, review context, project environment, review result — rendered through `JsonTree`); the four empty states are distinguished honestly (reviewer not enabled / non-Auto session / channel absent / no records yet); bilingual zh/en copy.
- Review record persistence (M4): the complete review artifact — full request text, the four parsed sections, reasoning, verdict, correlation, and host-outcome evidence — is persisted as append-only JSONL under `<DSH_HOME>/auto-review-panel/v1/` (one `sessions/*.jsonl` per session plus a global `unassigned.jsonl`), restored per session across `dsh` restarts, and stays visible after Auto Review is disabled or the session leaves the Auto preset; writes go through atomic writes and file locks (with automatic fallback when the optional upstream packages are absent) and `session/flush` acts as the persistence barrier; no storage failure can affect capture, tool execution, or adjudication.
- Retention and clearing (M4): the `auto-review-panel` configuration page on this plugin's row in the plugin manager offers three retention axes (records per session / sessions kept / total megabytes — all default to `0` = unlimited) and a confirmed "clear all history"; the panel list gains a "load older" keyset pagination that pauses auto-refresh while paging.
- Acceptance: `pnpm smoke:live` runs the full §6 matrix in a real composed web/headless profile with the official `@deepseek-ai/dsh-experimental-auto-review@0.2.1-rc.2` from npm `next`, including on-disk files, the stats/settings endpoints, and restart-recovery assertions.

# Changelog

This file records the user-visible changes of every **released** version.

中文: [CHANGELOG.md](./CHANGELOG.md)

- Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).
- Installation, supported upstream runtimes, and known limitations are in the [README](./README.md).
- Per-release implementation evidence, numbering, and release state live in the [roadmap progress ledger](./docs/plans/active/2026-10-20-auto-review-panel.md#进度总账); GitHub Release bodies are generated from commit history by `scripts/release-notes.mjs` and are the complete raw list beyond this file.

## [Unreleased]

### Added

- Repository initialization: the out-of-tree bundle skeleton (the `auto-review-panel-compat` boot gate, the `auto-review-panel` host service row, and the `auto-review-panel-client` bare-package-name client-graph anchor), the host/client split build (tsdown + tsc declarations), the DSH compatibility code contract (exact-version allowlist `0.2.1-rc.2`, mixed/incomplete/unsupported verdicts, the `warn` upgrade lane), the composition smoke and pack gate, the CI / release / upgrade / diag workflows, lefthook local commit hooks, and bilingual README / CHANGELOG plus the docs documentation system.

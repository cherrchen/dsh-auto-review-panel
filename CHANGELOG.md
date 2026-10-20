# Changelog

本文件记录每个**已发布**版本对使用者可见的变更。

English: [CHANGELOG.en.md](./CHANGELOG.en.md)

- 格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
- 安装方式、受支持的上游运行时与已知限制见 [README](./README.md)。
- 每个版本的实施证据、编号口径与发布状态见[路线图 §进度总账](./docs/plans/active/2026-10-20-auto-review-panel.md#进度总账)；GitHub Release 的正文由 `scripts/release-notes.mjs` 从 commit 历史生成，是本文件之外的完整原始清单。

## [Unreleased]

### Added

- 仓库初始化：out-of-tree bundle 骨架（`auto-review-panel-compat` 启动门禁、`auto-review-panel` 宿主服务行、`auto-review-panel-client` 裸包名 client 图锚点），host/client 分半构建（tsdown + tsc 声明），DSH 兼容性代码契约（精确版本 allowlist `0.2.1-rc.2`、混装/缺包/不支持三态判定、`warn` 升级车道），组合冒烟与打包门禁，CI / release / upgrade / diag 工作流，lefthook 本地提交钩子，双语 README / CHANGELOG 与 docs 文档体系。

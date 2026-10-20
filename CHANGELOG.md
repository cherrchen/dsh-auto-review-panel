# Changelog

本文件记录每个**已发布**版本对使用者可见的变更。

English: [CHANGELOG.en.md](./CHANGELOG.en.md)

- 格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
- 安装方式、受支持的上游运行时与已知限制见 [README](./README.md)。
- 每个版本的实施证据、编号口径与发布状态见[路线图 §进度总账](./docs/plans/completed/2026-10-20-auto-review-panel.md#进度总账)；GitHub Release 的正文由 `scripts/release-notes.mjs` 从 commit 历史生成，是本文件之外的完整原始清单。

## [Unreleased]

### Added

- 仓库初始化：out-of-tree bundle 骨架（`auto-review-panel-compat` 启动门禁、`auto-review-panel` 宿主服务行、`auto-review-panel-client` 裸包名 client 图锚点），host/client 分半构建（tsdown + tsc 声明），DSH 兼容性代码契约（精确版本 allowlist `0.2.1-rc.2`、混装/缺包/不支持三态判定、`warn` 升级车道），组合冒烟与打包门禁，CI / release / upgrade / diag 工作流，lefthook 本地提交钩子，双语 README / CHANGELOG 与 docs 文档体系。

- 审查记录捕获（M1）：`llm/stream` 只读 tee + 结构指纹识别官方 Auto Review 的审查流；记录保留审查请求全文（`requestText`/`sections` 逐字）、reasoning 原文、裁决输出（`risk`/`decision`/`reason`/`rawText`）与 `finish` 异常；`tools/pre-execute` 在飞表按 PENDING_ACTION 精确回填 `correlation{sessionId, callId, downstreamDecision, denialInfo?}`，歧义宁可不关联；双环形缓冲（每会话 50 / 全局 200，实测复核保留）。
- 宿主结局佐证（M3）：`session/event` 观察 `tool/result` 与 `approval/asked`/`approval/decided`，向已关联记录回填 `hostOutcome{toolResult?, approval?}`——`deny+never` 的 `AUTO_REVIEW_DENIED` 在裁决层与日志层双重佐证，`deny+ask` 的人工审批结局如实呈现；无 callId 锚的记录永不佐证。
- 面板 UI（M2/M3）：`sidebar.right` 新增「自动审查」面板——列表（工具名+mode · risk/裁决标签 · 参数预览 · 依据+时间，分「当前会话/未关联」两组，risk/decision 筛选）+ 详情（概览卡 + `工具调用`/`审查上下文`/`项目环境`/`审查结果` 四 tab，`JsonTree` 呈现原文）；四种空态如实区分（reviewer 未启用 / 非 Auto 会话 / 通道缺席 / 尚无记录）；zh/en 双语。
- 验收：`pnpm smoke:live` 以官方 `@deepseek-ai/dsh-experimental-auto-review@0.2.1-rc.2`（npm `next`）在真实组合 web/headless profile 上跑通 §6 全项（49 项断言）。

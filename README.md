<div align="center">

# dsh-auto-review-panel

中文 | [English](./README.en.md)

</div>

## 项目简介

DSH（DeepSeek Harness）的 Auto 权限预设由 Auto Review 审查器在后台裁决每一次工具调用——允许、放行还是拒绝——但这些裁决对使用者几乎不可见：调用被放行时悄无声息，被拒绝时只有一条结果消息。

本插件是一个不修改上游任何代码的外部扩展，给 Auto Review 装上**一块看得见的面板**：把审查器的判定、风险等级与依据呈现在侧栏里，让"这次调用为什么被放行/拒绝"不再是一个只能从会话消息里猜的黑盒。

- **只读呈现，不改裁决**：面板是审查状态的一个 UI/传输面，不是第二个审查器。授权策略、风险分级与来源分类完全由官方 Auto Review 负责（语义见[上游调研](./docs/reference/upstream-auto-review.md)），本插件不裁决、不拦截、不重算任何调用——审查内容经 `llm/stream` 的只读观察接缝捕获——指纹匹配不上即不记录，绝不误报（[ADR-0003](./docs/decisions/ADR-0003-review-record-capture.md)）。
- **历史按会话持久化**：审查记录落盘到 `<DSH_HOME>/auto-review-panel/v1/`（默认 `~/.dsh/auto-review-panel/v1/`），`dsh` 重启后按会话恢复；Auto Review 已停用、或会话不再用 Auto preset 时历史照常展示；未关联记录（上游 `deny+never` 拦截的批次）在任何会话视图恒可见。默认不限量，留存上限与清理入口在插件管理页本插件条目的配置页（见[用户指南](./docs/guide/README.md#审查历史存在哪里存多久)与 [ADR-0004](./docs/decisions/ADR-0004-review-record-persistence.md)）。
- **host/client 分半**：宿主半部承载审查状态的读取通道，浏览器半部把它渲染进侧栏；两半之间走 DSH 的 Connection 通道，不私开 HTTP 面。
- **不配等于没装**：宿主 DSH 版本不在支持清单上、或核心包混装时，插件行不启动，组合退化为"没装这个插件"——这是刻意的 fail-closed，见 [ADR-0001](./docs/decisions/ADR-0001-dsh-compat-contract.md)。

首个版本 `v0.1.0` 已就绪：审查记录捕获、宿主结局佐证、`sidebar.right` 面板与按会话持久化均已落地，并在真实组合上经 `pnpm smoke:live` 对照官方 `@deepseek-ai/dsh-experimental-auto-review@0.2.1-rc.2`（npm `next`）验收（含落盘与重启恢复）。进度与发布状态见[路线图 §进度总账](./docs/plans/completed/2026-10-20-auto-review-panel.md#进度总账)。

## 环境要求

**使用本插件**：一个下表中的 DSH 版本（精确匹配，不是范围）。`dsh plugin` 负责安装，无需本地 Node 工具链。

| DSH 系列 | 受支持的版本 |
| --- | --- |
| `0.2.1` | `0.2.1-rc.2` |

DSH 版本不在表内、或 `@deepseek-ai/dsh-*` 各包版本不一致时，插件不会启动，行为等同没装。

**从源码构建 / 贡献**：Node.js `^22.19.0 || >=24`，pnpm `11.25.0`（建议经 corepack 启用）；开发 pin 的 DSH 为 `0.2.1-rc.2`。

**运行平台**：macOS、Linux、Windows——面板是 UI 面，无平台特定执行语义；Windows CI 腿默认停放，面板出现平台相关行为时再由仓库变量 `DSH_WINDOWS_CI` 启用。

## 安装

插件尚未发布到 npm。当前仅支持从本地源码安装：

```sh
git clone https://github.com/cherrchen/dsh-auto-review-panel.git
cd dsh-auto-review-panel
export CI=true
pnpm install
pnpm build
dsh plugin --profile web add /path/to/repo
```

> [!TIP]
> `dsh` 不在 PATH 里时（例如用源码仓库跑 DSH），把命令里的 `dsh` 换成 `pnpm dsh`。

**前置条件**：本插件只观察已有审查器的裁决，自身不审查。要看到内容，需先在插件管理器启用官方 `@deepseek-ai/dsh-experimental-auto-review`（它随安装附带、默认关闭）；若当前安装未附带，再显式安装精确版 `0.2.1-rc.2`，勿用滞后的 `latest`，并让会话选择 Auto preset——两者缺一，面板将恒为空。

## 运行方法

开发自检：

```sh
pnpm lint && pnpm typecheck
pnpm build
pnpm test
pnpm smoke
pnpm docs:check
```

安装进 DSH 运行时并验证组合：

```sh
dsh plugin --profile web add /path/to/repo
dsh --profile web --dump-config | grep -A3 'auto-review-panel'
```

预期输出：

```text
# == @dsh-electron/dsh-auto-review-panel
- id: auto-review-panel-compat
  name: '@dsh-electron/dsh-auto-review-panel/compat'
- id: auto-review-panel
  name: '@dsh-electron/dsh-auto-review-panel/panel'
- id: auto-review-panel-client
  name: '@dsh-electron/dsh-auto-review-panel'
```

即插件自身的三行全部挂载：`auto-review-panel-compat` 是启动门禁，`auto-review-panel` 是面板的宿主半部（持有 `autoReviewPanelCompat`，门禁不过即不启动），`auto-review-panel-client` 挂在裸包名上、是 web 客户端图读取 `dsh.client` 声明的唯一锚点。

## 项目结构

```text
.
├── src/
│   ├── compat.ts                    auto-review-panel-compat 启动门禁（版本 allowlist 与混装判定）
│   ├── compat/dsh-version.ts        兼容性契约本体：SUPPORTED_DSH_RELEASES、核心包清单、分类与判定
│   ├── compat/review-fingerprint.ts 官方 Auto Review 请求的结构指纹
│   ├── capture.ts                   llm/stream 只读 tee 与裁决协议解析
│   ├── host.ts                      捕获核心：在飞关联、宿主结局佐证、通道端点体
│   ├── channel.ts                   PANEL_CHANNEL 挂载（connection.rpc.handle，软接缝）
│   ├── records.ts                   双环形记录缓冲与列表投影
│   ├── history/                     按会话 JSONL 持久化（contract/format/paths/store/lazy）
│   ├── contract.ts                  host/client 共享 wire 契约
│   ├── panel.ts                     面板的宿主半部：autoReviewPanel 服务行
│   ├── client/                      浏览器半部：面板组件、轮询数据源、留存设置页、文案与样式
│   └── index.ts                     公共面 barrel；其空 apply 同时承载裸包名的 client 图锚点行
├── tests/                           宿主捕获/缓冲/通道、兼容性判定、patch 不变量、client 面板与制品形态
├── scripts/                         冒烟（compose / packed / live）、兼容性契约检查、打包门禁、升级流程、lefthook 安装器
└── docs/                            需求、架构、决策记录（ADR）、计划、开发工作流、故障排查
```

## 贡献指南

欢迎 Issue 与 PR：

1. 先读 [`AGENTS.md`](./AGENTS.md)（仓库级规则）与[开发工作流](./docs/development/plugin-development-workflow.md)（环境、命令、运行时支持矩阵、升级流程）。
2. 从 `main` 拉分支；提交信息遵循 conventional commits（`feat` / `fix` / `perf` / `refactor` + scope），参见现有历史。
3. PR 前本地必须全部通过：`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm docs:check`、`pnpm smoke`（CI 按同序执行，先 build 后 test）。
4. 影响行为的变更需同批更新 `docs/` 下的对应文档；README 保持中英双语同步；有取舍的工程决策请新增 ADR。
5. 硬约束：**不修改上游仓库（deepseek-harness）任何包**；插件只做 out-of-tree 扩展。

## 已知限制

- 记录以**明文** JSONL 落盘在 `<DSH_HOME>/auto-review-panel/v1/`：含审查请求全文与推理原文，不加密、不上传——共享机器请按本地敏感文件对待；没有"关闭持久化"开关（面板的读路径经同一存储）。
- 不做跨会话历史浏览：无会话视图只显示当前进程内存里的记录；未关联记录（没有 `correlation.callId` 锚）如实显示在「未关联」组、无宿主结局佐证。
- 支持矩阵是精确版本 allowlist：宿主版本不在清单上、或核心包混装了不同版本时，被门禁的 `auto-review-panel` 行**不启动**，组合退化为"没装这个插件"（[ADR-0001](./docs/decisions/ADR-0001-dsh-compat-contract.md)）。
- 官方 Auto Review 不提供专用的面板数据源接口：审查判定与原因需要从宿主侧的既有接缝读取，上游一旦改变这些接缝的形状，只能由适配层或升级车道发现——本插件不承诺跨版本的语义直通（[上游调研](./docs/reference/upstream-auto-review.md)）。

## 文档

项目长期文档位于 [`docs/`](./docs/README.md)：

- [版本变更记录（CHANGELOG）](./CHANGELOG.md)
- [用户指南](./docs/guide/README.md)
- [需求](./docs/requirements/auto-review-panel.md)
- [上游 Auto Review 调研](./docs/reference/upstream-auto-review.md)
- [决策记录（ADR）](./docs/decisions/README.md)
- [计划](./docs/plans/README.md)
- [开发工作流](./docs/development/plugin-development-workflow.md)
- [常见问题排查](./docs/troubleshooting/README.md)

Coding Agent 的仓库级规则定义于 [`AGENTS.md`](./AGENTS.md)。

## 许可证

[MIT](./LICENSE)

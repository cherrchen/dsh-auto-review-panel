# Auto Review Panel 开发路径与进度总账

> 状态：进行中 | 日期：2026-10-20
> 本文档同时是路线图与**进度总账**——进度、编号与发布状态的唯一真源。需求见[开发需求](../../requirements/auto-review-panel.md)，上游依据见[调研](../../reference/upstream-auto-review.md)，兼容性契约见 [ADR-0001](../../decisions/ADR-0001-dsh-compat-contract.md)。

## 进度总账

| 阶段 | 内容 | 状态 | 发布 |
| --- | --- | --- | --- |
| 初始化 | bundle 骨架（compat/panel/client-anchor 三行）、兼容性契约、host/client 构建、tests、组合冒烟、打包门禁、lefthook、CI/release/upgrade/diag 工作流、docs 体系、双语 README/CHANGELOG | 完成（2026-10-20） | 未发版（`v0.0.0`） |
| M1 | 面板面：审查状态读取通道（宿主半部）+ `sidebar.footer.action` 入口与面板视图（客户端半部） | 未开始 | — |

### 初始化（2026-10-20）

本仓库从 `dsh-plugin-multi-root-workspace` 的项目结构与工程约定整体初始化而来，**结构对齐**包括：根 README/CHANGELOG 双语对、AGENTS.md、`.agent/`（note 双语对、templates、documentation skill）、docs 九分区（requirements/architecture/decisions/plans/development/guide/reference/troubleshooting + plans active/completed）、lefthook 提交钩子（`scripts/install-lefthook.mjs` + `lefthook.yml` + `pnpm hooks:install` 手动安装）、`.github/workflows/`（ci / release / upgrade / diag）、pnpm `11.25.0` + Node `^22.19.0 || >=24`、tsdown 双 face 构建、vitest + oxlint、`compat:check` 静态门禁、`pack:check` / `smoke:packed` 打包门禁、`upgrade-dsh.mjs` 升级车道。

**刻意不复制**的 multi-root 专有部分：fs/sandbox provider 替换与方言 grant 拼装、root 注册表与 lease、`/workspace-folders` 命令、Windows runner/broker、journey e2e、Auto Review companion fork——它们属于那个插件的职责，不属于本插件。

插件行（`cordis.patch.yml` 的 insert，恰好三行）：

| id | name | 职责 |
| --- | --- | --- |
| `auto-review-panel-compat` | `…/compat` | 启动门禁：`classifyInstallation()` 判定，`unsupported`/`mixed`/`incomplete` 抛 `DshCompatUnsupportedError` |
| `auto-review-panel` | `…/panel` | 面板宿主半部：`autoReviewPanel` 服务键（inject `autoReviewPanelCompat`；审查通道随 M1 落地） |
| `auto-review-panel-client` | 裸包名 | client 图锚点：web 客户端图只从裸包名行读 `dsh.client`（troubleshooting 有完整机制说明） |

**验证证据（2026-10-20）**：`pnpm verify:all` 全绿——lint / typecheck / build（`lib/index.js`、`lib/panel.js`、`lib/compat.js` + `lib/client.js` 闭包工厂）/ vitest 39 通过 / `smoke:compose` 17 项通过（真实 `dsh plugin add` 后 `--dump-config` 逐字节对照：恰好三行插入、上游行零改动）/ `pack:check`（tarball 19 成员齐全、import 图闭合）/ `smoke:packed` 对打包产物复跑组合冒烟通过；`pnpm compat:check` 与 `pnpm docs:check` 独立通过。

**一处对参考仓库约定的偏离**：`postinstall` 自动装钩子在 npm 包里是错的——`dsh plugin add` 安装的 tarball 会把 `postinstall` 当构建脚本拦下（`ERR_PNPM_IGNORED_BUILDS`），`smoke:packed` 已实测复现。改为 `pnpm hooks:install` 手动安装，消费者零副作用。

## M1：面板面（未开始）

> 目标是第一个对外可见的能力：侧栏入口 + 审查状态呈现。需求细节与验收标准见[需求文档 §3/§5](../../requirements/auto-review-panel.md)。

- 宿主半部：经 `tools/pre-execute`（只读观察，不裁决）或等价接缝捕获"某调用进入审查"与"其结果"；经 Connection 通道暴露读端点。观察不到裁决时字段留空，绝不本地重算。
- 客户端半部：`sidebar.footer.action` 入口 + 面板视图；"观察到了调用"与"裁决结果"是两个独立字段，缺一则如实显示；无活动时空态。
- 交付前必须追加的验证：通道端到端断言、面板渲染单测、`smoke:compose` 继续逐字节对照。

## 里程碑纪律

- 每个 M 有对应的 `plans/active|completed/YYYY-MM-DD-mN-*.md`；完成即迁移到 `completed/` 并在本表标注"随 `vX.Y.Z` 发版"。
- 发版由 tag 触发（`pnpm release <kind> --tag`）；发版前先把本表与 CHANGELOG 同步，三者同批提交（见[发版流程](../../development/release-workflow.md)）。

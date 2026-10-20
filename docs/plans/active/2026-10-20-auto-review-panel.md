# Auto Review Panel 开发路径与进度总账

> 状态：进行中 | 日期：2026-10-20
> 本文档同时是路线图与**进度总账**——进度、编号与发布状态的唯一真源。需求见[开发需求](../../requirements/auto-review-panel.md)，上游依据见[调研](../../reference/upstream-auto-review.md)，兼容性契约见 [ADR-0001](../../decisions/ADR-0001-dsh-compat-contract.md)。

## 进度总账

| 阶段 | 内容 | 状态 | 发布 |
| --- | --- | --- | --- |
| 初始化 | bundle 骨架（compat/panel/client-anchor 三行）、兼容性契约、host/client 构建、tests、组合冒烟、打包门禁、lefthook、CI/release/upgrade/diag 工作流、docs 体系、双语 README/CHANGELOG | 完成（2026-10-20） | 未发版（`v0.0.0`） |
| M1 | 审查记录捕获（宿主半部）：`llm/stream` 只读 tee + 结构指纹 + `pre-execute` 关联锚（`downstreamDecision`）+ 环形缓冲 + `PANEL_CHANNEL` list/get 端点 | 完成（2026-10-20） | — |
| M2 | sidebar.right 面板（客户端半部）：tab 类型注册 + `sidebar.right.pane.tab` 面板体、列表/详情、四种空态、双语 | 完成（2026-10-20） | — |
| M3 | 打磨与首发：关联/结局佐证增强、缓冲实测调参、真实组合验收、演示 GIF、首版发版 | 未开始 | `v0.1.0` |

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

## M1：审查记录捕获（宿主半部，完成 2026-10-20）

> 目标：把死在 `classifyRisk` 里的审查数据变成宿主侧的结构化记录流。需求细节、失败语义与验收标准见[需求文档 §4/§6](../../requirements/auto-review-panel.md)，接缝决策见 [ADR-0003](../../decisions/ADR-0003-review-record-capture.md)。

- `llm/stream` listener：结构指纹（`REVIEW_POLICY` 节头 + 四节文本 + `temperature === 0` + `sessionId`/`purpose` 均缺席），`next()` 后返回 tee 包装 iterable；记录路径异常吞掉、上游 error/abort chunk 原样透传。
- 记录模型：`{id, capturedAt, provider, model, requestText, sections{policy, environment, projectInstructions, filteredHistory, pendingAction}, reasoning[], output{risk?,decision?,reason?,rawText}, finish?, correlation?{sessionId, callId, downstreamDecision}}`；环形缓冲每会话 50 / 全局 200。
- `tools/pre-execute`（append）：AUTO preset 在飞表；`name`+`arguments` 精确匹配回填 `{sessionId, callId}` 与 `downstreamDecision`（`PreToolDecision["kind"]`，本 listener 之后的决定，可能≠reviewer decision；上游产生的 ask 不会出现在这里，下游自己的 ask 会）；歧义不关联。
- `PANEL_CHANNEL`：`list(sessionId?) → {records, status{reviewerAvailable, sessionPreset?}}`（**按会话过滤时未关联记录恒含**）/`get(id)` 只读端点；`connection.rpc.handle` 机制（`ctx.root` 读法照搬 multi-root）。
- panel 行的服务注入方式：`static inject` 只放**真正调其 API** 的服务——`autoReviewPanelCompat`（门禁）+ `permissionPresets`（`current()` 过滤 AUTO / `names` 判 reviewerAvailable）+ `sessions`（`get(sessionId)` 取 Session 供 `sessionPreset`）；三者均为本行启动必需；后两者来自 required 核心包，`autoReviewPanelCompat` 是本插件的门禁服务。`llm`/`tools` 只用于 `ctx.on('llm/stream')` / `ctx.on('tools/pre-execute')` 的事件名，**不进 inject**——`llm` 是 optional peer，缺席组合里 compat 仍判 supported、面板照常启动（此时无审查流，空态①如实兜底）；若把 llm 放进 static inject，缺 llm 的组合会变成「判定 supported 但行不启动且无空态可看」的静默不一致。`connection`/`webServer` 走 scoped `ctx.inject([…], ctx => ctx.root.get('connection'))`——headless 无它们，照搬 multi-root 的 `ctx.root` 读法。
- `requestText` 为 user 消息逐字、`sections.policy` 为 `options.system` 逐字——两者重组即审查请求全文，验收"逐字等于审查请求"由此可执行。
- 交付物随 M1 收拢 `docs/architecture/auto-review-panel.md`：缓冲/通道/空态判定的 host↔client 数据流（现分散于需求 §4 与本计划，ADR-0003 只覆盖捕获接缝）。
- 验证：指纹正/负例（含普通对话、compaction、session-title 不误记）、**fork 形状 reviewUserText 的解析 fixture**、tee 故障注入不影响裁决且上游 error 透传、reviewer failed/aborted 落 `finish`、关联正确/歧义拒绝、通道形状、headless 降级。

**验证证据（2026-10-20）**：`pnpm verify:all` 全绿——lint / typecheck / build / vitest 98 通过（`review-capture.spec.ts` 指纹正负例 + fork fixture + tee 双侧故障注入 + error/aborted 落 `finish` + 关联与歧义拒绝；`review-records.spec.ts` 双环帽与会话过滤恒含未关联；`review-channel.spec.ts` list/get 形状、status 两态、bad-request/unknown-endpoint、headless 不挂通道不炸）/ `smoke:compose` 17 项 / `pack:check` 25 成员 / `smoke:packed`；`compat:check` 与 `docs:check` 独立通过。架构文档 [`docs/architecture/auto-review-panel.md`](../../architecture/auto-review-panel.md) 同批收拢数据流/通道/空态判定。

## M2：sidebar.right 面板（客户端半部，完成 2026-10-20）

> 目标：逐条检索、阅读审查记录——第一个用户可见能力。形态对齐 session-inspector，信息密度按[需求 §4.3 精简原则](../../requirements/auto-review-panel.md)收敛。

- `sidebarRightTabs.register({ id, kind, title, guide })` + `sidebar.right.pane.tab` 槽注册；会话经 `ctx.sessions.binding` 绑定；`inject` 扩到 `sidebarRightTabs`/`sessions`（导航另加 `uiSession`/`uiConversation`，最小可行为准）；`dsh.client.inject` 加 `@deepseek-ai/dsh-client-ui-sidebar-right`。
- 列表行恰五字段：时间 · 工具名+mode 徽标 · risk 色点 · 裁决 chip（allow/deny/error/failed）· 依据行；会话过滤默认当前会话，**"未关联"组恒可见**；risk/decision 轻量筛选。
- 详情渐进披露：默认只展开裁决卡；其余（历史/约束/环境/模型原文）折叠；REVIEW_POLICY 只在 About；不重复轨迹工具卡——关联成功时提供"在轨迹中定位该调用"导航。
- 四种空态如实区分：reviewer bundle 未启用/未安装（经 Auto preset 目录探测）、会话非 Auto、通道缺席、尚无记录。
- 验证：tab 注册、五字段列表行、默认展开面核查、空态四态、双语；端到端用真实 AUTO 会话验收（official bundle 精确版 `0.2.1-rc.2`）。

**验证证据（2026-10-20）**：`pnpm verify:all` 全绿——lint / typecheck / build（`lib/client.js` 33.6 kB 闭包工厂）/ vitest 119 通过（新增 `client-panel.spec.tsx` 21 项：两阶段挂载、通道 (channel, endpoint, payload) 三元组、五字段行结构与 allow 协议文案、failed chip、未关联组恒可见、risk/decision 多选下拉（字段名不进选项）、图标按钮位、四种空态逐一复现〔① `reviewerAvailable:false`、② `sessionPreset:'workspace-write'`、③ connection 缺席与调用失败两路、④ 空记录含 `sessionPreset` 缺席并入〕、详情仅裁决卡默认展开、FILTERED_HISTORY 原始 kind/role 呈现、REVIEW_POLICY 只在 About、zh/en 键集对齐）/ `smoke:compose` 17 项 / `pack:check` / `smoke:packed`；`compat:check` 与 `docs:check` 独立通过。架构文档 §5 同批收拢客户端数据流。

**如实边界**：轨迹定位整体撤销——0.2.1-rc.2 下可见 tab 切换与 call 级 focus 都走 `conversation.session` 私有 inject 面的 store actions，公开服务面没有写口；持久化偏好与 DOM 手势两条绕路要么只对重挂载生效、要么依赖私有 DOM 契约，均达不到"点击即达"的真实效果。按"无可靠接缝宁可不提供"原则，`inspectCall`/`navigation.ts` 及其 inject（`uiSession`/`uiConversation`/sessions 绑定、`uiWorkspace`/`configForms` 可选读）整体移除，不再提供该按钮。

## M3：打磨与首发（未开始）

- 宿主处置佐证（Session 事件对照 `AUTO_REVIEW_DENIED` 错误码、ask 转人工的呈现——ask 在 v1 不显示）、重试/多流呈现策略、缓冲上限实测调参；评估 prepend pending-exec registry 提升 deny+never 关联率（listener 顺序非公开契约，需实测）。
- 完整走一遍真实 web 组合人工验收（official `@deepseek-ai/dsh-experimental-auto-review@0.2.1-rc.2` 精确版 + Auto preset 会话）+ 演示 GIF（README）。
- CHANGELOG 首发条目 + `pnpm release` → `v0.1.0`。

## 里程碑纪律

- 每个 M 有对应的 `plans/active|completed/YYYY-MM-DD-mN-*.md`；完成即迁移到 `completed/` 并在本表标注"随 `vX.Y.Z` 发版"。
- 发版由 tag 触发（`pnpm release <kind> --tag`）；发版前先把本表与 CHANGELOG 同步，三者同批提交（见[发版流程](../../development/release-workflow.md)）。

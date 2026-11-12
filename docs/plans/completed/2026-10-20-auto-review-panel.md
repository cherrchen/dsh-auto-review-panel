# Auto Review Panel 开发路径与进度总账

> 状态：已完成 | 日期：2026-10-20
> 本文档同时是路线图与**进度总账**——进度、编号与发布状态的唯一真源。需求见[开发需求](../../requirements/auto-review-panel.md)，上游依据见[调研](../../reference/upstream-auto-review.md)，兼容性契约见 [ADR-0001](../../decisions/ADR-0001-dsh-compat-contract.md)。

## 进度总账

| 阶段 | 内容 | 状态 | 发布 |
| --- | --- | --- | --- |
| 初始化 | bundle 骨架（compat/panel/client-anchor 三行）、兼容性契约、host/client 构建、tests、组合冒烟、打包门禁、lefthook、CI/release/upgrade/diag 工作流、docs 体系、双语 README/CHANGELOG | 完成（2026-10-20） | 未发版（`v0.0.0`） |
| M1 | 审查记录捕获（宿主半部）：`llm/stream` 只读 tee + 结构指纹 + `pre-execute` 关联锚（`downstreamDecision`）+ 环形缓冲 + `PANEL_CHANNEL` list/get 端点 | 完成（2026-10-20） | — |
| M2 | sidebar.right 面板（客户端半部）：tab 类型注册 + `sidebar.right.pane.tab` 面板体、列表/详情、四种空态、双语 | 完成（2026-10-20） | — |
| M3 | 打磨与首发：关联/结局佐证增强、缓冲实测调参、真实组合验收、演示 GIF、首版发版 | **已完成**（2026-10-21） | `v0.1.0` |
| M4 | 审查记录按会话持久化：per-session JSONL 日志（`DSH_HOME/auto-review-panel/v1/`）、留存设置页（`plugins.bundle.config`）、分页；重启后历史按会话恢复 | **已完成**（2026-10-21） | 随 `v0.1.0` |

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
- 记录模型：`{id, capturedAt, provider, model, requestText, sections{policy, environment, projectInstructions, filteredHistory, pendingAction}, reasoning[], output{risk?,decision?,reason?,rawText}, finish?, correlation?{sessionId, callId, downstreamDecision, denialInfo?}, hostOutcome?{toolResult?, approval?}}`；环形缓冲每会话 50 / 全局 200（M3 实测复核保留）。
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

## M3：打磨与首发（已完成，2026-10-21）

- 宿主处置佐证已落地：`correlation.denialInfo`（上游 `deny` 的 `info` 逐字，实测拿到 `AutoReviewDeniedError`/`AUTO_REVIEW_DENIED`）+ `hostOutcome`（`tool/result` 结局与 `approval/asked`/`approval/decided` 审批审计对，经 `session/event` 观察；仅 `correlation.callId` 已知的记录可获佐证，事件早到时暂存待 `correlate()` 并入）。`ask` 转人工以"宿主结局"行呈现在详情概览——`ask` 仍不是 reviewer decision，不进裁决 chip。
- prepend 关联机制经真实组合**实测采纳**：cordis prepend 是"最后注册者最先"，而上游在自己挂载期的 `ctx.effect` 里注册——本插件延迟一个 macrotask 的 prepend 实测落在其前，`deny+never` 由此获得 `correlation` 与 `AUTO_REVIEW_DENIED`；顺序不利时如实退回未关联（顺序非公开契约，机制与退路见架构文档 §3.1）。
- 缓冲上限实测复核通过：单条记录驻留约 2 KiB（JSON 投影约 16 KiB），全局 200 帽下约 0.3 MiB——每会话 50 / 全局 200 按证据保留。
- 真实组合端到端验收通过：`pnpm smoke:live` 49/49（官方 `@deepseek-ai/dsh-experimental-auto-review@0.2.1-rc.2` 自 npm `next` 经真实 `dsh plugin add` 装入真 web profile，脚本化 adapter 定判、其余全走真实管线：真 waterfall 顺序、真 Session 日志、真审批服务、真 `PANEL_CHANNEL` HTTP + 浏览器 token 交换）。覆盖：allow 记录逐字、deny+ask（`downstreamDecision:'ask'` + approval outcome）、deny+never（关联 + `AUTO_REVIEW_DENIED` 双佐证）、malformed→`decision:error`、reviewer 断流→`finish:error`、下游 listener 炸掉的孤儿记录如实未关联且在外会话过滤下恒可见、空态①（无 reviewer 的 web profile）②（非 Auto 会话）④（Auto 零记录）经 wire 实测、headless 组合不挂通道宿主不炸。
- **验收口径说明**：脚本化 adapter 只决定 reviewer 裁决内容，捕获/关联/佐证/通道全走正式管线；同会话与跨会话的并发 exec 经实测被工具调度器串行化，歧义路径（双同形在飞）在真实组合中无法确定复现，由单测覆盖；空态③（通道缺席）由单测与 headless 相位（无 connection）覆盖。
- 首版 `v0.1.0`：`pnpm release 0.1.0` 已写版本号；CHANGELOG 双语条目已收拢（tag 推送即发布，见发版流程）。

## M4：审查记录按会话持久化（已完成，2026-10-21）

> 计划文档：[2026-10-21-m4-review-record-persistence.md](./2026-10-21-m4-review-record-persistence.md)；决策见 [ADR-0004](../../decisions/ADR-0004-review-record-persistence.md)；行为契约见需求 §4.4 与架构 §2.1。

- **布局与格式**：`<DSH_HOME>/auto-review-panel/v1/` 下 `sessions/<key>.jsonl`（`header` + `record`/`patch` 行）+ `unassigned.jsonl`（未关联记录全局集合，`delete` 行移除已关联项）+ `settings.json`（留存设置，`clear` 不删）；目录 `0700`、文件 `0600`；损坏/过期文件改名 `.corrupt-<stamp>`/`.stale-<stamp>` 保留字节，外来 schema 标记 foreign 不覆写。
- **写路径**：捕获先入 unassigned；`correlate()` 先写会话文件再 tombstone unassigned（崩溃窗口只允许重复，不允许只有 tombstone 没有正文）；`attachHostOutcome()` 落 `patch` 行。每文件一条 promise 链串行化；`session/flush` 事件排空屏障；`ctx.effect` 里 `close()`。
- **会话身份**：文件 header 携 `Session.header` 的 `{createdAt, cwd, isSeeded}`；live 会话逐字段不符 → 文件视为旧生命周期改名 aside；冷会话信任文件——sessionId 复用不会把新记录归到旧会话。
- **动态依赖**：`@deepseek-ai/dsh-atomic-write`（temp+rename、`withFileLock`）与 `@deepseek-ai/dsh-home-paths`（`resolveDshHome`/`dshHomeDisplay`）均动态导入、缺席合法退化（进程内串行 + `rename`；`$DSH_HOME` 展开 + `~/.dsh` 兜底）——两包入 `RUNTIME_OPTIONAL_PACKAGES` 而非 peer。
- **端点**：通道扩到五个——`list`（`before`/`limit` 键集分页，默认 200 上限 500）、`get`（内存未命中落盘回查）、`stats`（`available:false` 退化、符号化 `location`）、`update-settings`（非负整数、`0`=不限、`bad-request`/`persistence-unavailable` 语义）、`clear`（`confirm:true` 门闩，删历史文件+内存缓冲、留 `settings.json`）。sessionId 缺席的 `list` 只回内存——无跨会话浏览（ADR-0004 边界）。
- **客户端**：列表 `loadOlder` 分页状态机（`first`/`older`/`olderPage`/`live` + epoch 防 refresh↔loadOlder 竞态），翻页暂停轮询并显示提示、刷新恢复；空态优先级「有记录 > reviewer 缺席 > 非 Auto > 在线无记录」（持久化历史压过①②④）；tool 筛选项并入已加载记录的 `action.name`；插件管理页 `plugins.bundle.config`（键为包名 `@dsh-electron/dsh-auto-review-panel`）贡献 `view:'page'` 留存设置页——三轴编辑（`SettingsForm`/`SettingsValueField`）、`PathLabel` 位置、`fileSizeText` 用量、重置、`RiskConfirmation` 勾选确认清理、`Toast` 通知；plugin-manager 缺席时软跳过。
- **如实边界**：硬杀最多丢最后一个 flush 屏障前的写窗口；单文件自身超总量上限保留并回报 warning 不截断；外国 schema 文件永不覆写——未来升级格式需读侧先懂；无"关闭持久化"开关（面板读历史走同一路径）。
- **验证**：`vitest run` 9 文件 172 通过 1 跳过（`review-history.spec.ts` 24 项：JSONL 往返、header 身份校验、stale/corrupt/foreign 处理、unassigned tombstone 与压实、留存三轴、clear/flush/close、分页游标稳定性；`review-channel.spec.ts` 扩到 stats/update-settings/clear 与分页形状；`source.spec.ts` 分页状态机与竞态；`client-panel.spec.tsx` loadOlder/footer/暂停提示；`client-bundle.spec.ts` plugin-manager 注入声明；`compat.spec.ts` runtime-optional 分区）。`smoke:live` 实测持久化断言：文件落盘、stats/settings 端点经 wire、清理生效、**重启恢复**（同 `$DSH_HOME` 的 plain profile——无 reviewer——仍能列出完整历史含未关联组）。`pnpm verify:all` + `compat:check` + `docs:check` 全绿。

## 兼容性验收记录

### 2026-10-25：rc.3 支持提升

- 开发基线提升至 `0.2.1-rc.3`，保留原有 rc.2 支持；精确支持清单仍以 [`SUPPORTED_DSH_RELEASES`](../../../src/compat/dsh-version.ts) 为唯一真源。peer 声明、开发依赖、lockfile 与 release-age 精确条目同步更新，cordis 保持 `4.0.5`。
- 上游接缝复核见[Auto Review 调研补充](../../reference/upstream-auto-review.md#rc3-复核2026-10-25)。无新增运行时适配分支；`smoke:live` 改为从实际 CLI 运行时解析 DSH 精确版本，安装同版本官方 reviewer，避免 npm `next` 移动使旧版回归失效。
- rc.3 在候选车道通过完整验证后，以正式 enforce 门禁重跑：`pnpm compat:check`、`pnpm verify:all` 全部通过（9 个测试文件，174 通过 / 1 个候选车道专用测试跳过；源码与 packed 组合各 17 项通过）；`pnpm smoke:live` 69/69，通过真实 reviewer 的 allow、deny+ask、deny+never、故障、空态、持久化、清理与重启恢复。
- rc.2 回归在隔离源码副本中经 `node scripts/upgrade-dsh.mjs 0.2.1-rc.2` 重建统一安装树，以正式 enforce 门禁跑 `pnpm compat:check`、`pnpm verify:all` 与 `pnpm smoke:live`：同样 174 通过 / 1 跳过、源码与 packed 组合各 17 项通过、实时验收 69/69。隔离副本已清理，主工作区依赖未切回旧版。
- 本地验证平台为 macOS arm64 / Node.js `24.18.0`；Linux、Windows 与浏览器人工交互未在本次本地验收覆盖。CI 继续从支持清单派生版本矩阵；Windows 腿仍按原有开关控制。
- 主工作区已移除候选 probe overrides，保持 rc.3 开发基线；本次不创建发布 tag。

### 2026-11-11：0.2.2-alpha.3 / 0.2.2-rc.1 支持提升

- 支持清单扩展为 `0.2.1-rc.2` … `0.2.2-rc.1`；开发基线与 cordis pin 提升到 `0.2.2-rc.1` / `4.1.0`。rc.1 相对 alpha.3 只改包版本号（上游标签间源码一致），但两个版本各按精确 pin 跑过完整矩阵。
- 上游差异与插件应对（详见[上游调研 §0.2.2-alpha.3 / 0.2.2-rc.1 复核](../../reference/upstream-auto-review.md#022alpha3--022rc1-复核2026-11-11)）：
  - **审查流身份**：alpha.3 起 reviewer 在请求上声明 `purpose: 'auto-review'` 并携带被审查会话的 `sessionId`。指纹从"两字段都必须缺席"改成按自报 purpose 识别（foreign purpose / 无 purpose 却带 sessionId → suspected），记录模型与关联语义不变——身份字段只用于识别，不替代 `tools/pre-execute` 关联锚。
  - **通道注册回归**：cordis 4.0.6-alpha.2 的服务解析改为定义站点后，`connection.rpc.handle` 内部解析 `owner.webServer` 在真实组合中失败（`cannot get property "webServer" without inject`），PANEL_CHANNEL 注册不上。新增 `src/compat/panel-channel.ts`：先试 `rpc.handle`，失败则用 `connection.admit()` 认证围栏 + `webServer` 同名 prefix 路由，RPC 信封 framing 与上游逐项对齐；缺认证围栏时不挂通道（空态③如实兜底）。
  - base patch 的 `fs-observation-policy`/`tool-fs` 行调整、客户端 `ui-sidebar-right`/`ui-primitives`/`ui-plugin-manager` 的增量、`dsh-llm` 的 purpose 类型与 `util/values` 重写均不改变本插件使用的接缝（逐项记录在上游调研）。
- 验证（macOS arm64 / Node.js `24.18.0`，各版本先以 `DSH_AUTO_REVIEW_PANEL_COMPAT=warn` 跑升级车道，提升后以正式 enforce 门禁复跑）：
  - `0.2.2-alpha.3`：`pnpm verify:all` 全绿（10 个测试文件，197 通过 / 1 跳过；源码与 packed 组合各 17 项通过）；`pnpm smoke:live` 69/69。
  - `0.2.2-rc.1`：`pnpm verify:all` 全绿（同 197 通过 / 1 跳过；组合与 packed 各 17 项）；`pnpm smoke:live` 69/69；提升后 `pnpm compat:check`、`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm smoke`、`pnpm pack:check`、`pnpm smoke:packed`、`pnpm docs:check` 全部通过。
  - 新增单测：messages 协议 + review purpose/sessionId 命中、sections 协议 + review purpose 命中、purpose/sessionId 组合负例；通道接缝（优先 rpc、回退命名路由、无认证不挂、信封 framing 与状态码）8 项。
  - alpha.2 回归：在隔离 worktree 中把 pin 切回 `0.2.2-alpha.2`（旧版 `rpc.handle` 接缝 + 无身份指纹），`compat:check`、`verify:all`（199 通过 / 1 跳过；组合与 packed 各 17 项）与 `smoke:live` 69/69 全部通过。该复现必须沿用 alpha.2 时代的 lockfile：`upgrade-dsh.mjs` 只钉 DSH 包与 cordis，`cordis-plugin-loader`/`-include` 的 `~1.0.7-alpha.1`/`~1.0.11-alpha.1` 范围会解析到 alpha.2 伙伴版本，与 cordis `4.0.6-alpha.1` 的 peer 不匹配、profile 起不来——这是升级车道复现旧版本的既有限制（`verify:all` 与组合冒烟不受影响），不是本插件的行为变化。
- 主工作区移除候选 probe overrides，保持 `0.2.2-rc.1` 开发基线；本次不创建发布 tag。

### 2026-11-11：0.2.2-rc.2 支持

- 支持清单扩展为 `0.2.1-rc.2` … `0.2.2-rc.2`；`0.2.2-rc.2` 的 npm 产物尚未发布（registry 上 `@deepseek-ai/dsh` 的最新发布仍是 `0.2.2-rc.1`），因此开发 pin、lockfile 与 release-age 精确条目都保持在 `0.2.2-rc.1`——把 manifest 指向一个不可安装的版本会破坏 `pnpm install --frozen-lockfile` 与整条 CI 主车道。发布后按升级车道把 pin 重指到 rc.2，rc.2 的矩阵腿即可转绿。
- 上游差异与插件应对（详见[上游调研 §0.2.2-rc.2 复核](../../reference/upstream-auto-review.md#0222-rc2-复核2026-11-11)）：`auto-review`/`permission-presets` 仅版本号变化；`dsh-tools` 的 guard/deny 结构化身份与 `dsh-session` 的批量 append 都是附加面；`dsh-llm` 的错误基类迁移与 retry policy 调整不改变 `llm/stream` 签名；客户端 `Menu` 定位重写、`hoc` 槽、`ui-plugin-manager` 的 `update` 字段与 `sidebar.panel.icon` factory（`sidebar.panellist` 移入其下）均不触及本插件注册面。结论：无新增运行时适配分支。
- 验证（macOS arm64 / Node.js `24.18.0`；上游 `dsh-v0.2.2-rc.2` 以 `git archive` 解出到隔离目录，构建 host libraries 与 client 声明后，把本仓库依赖链接到该树）：
  - `pnpm typecheck`（host + client）、`pnpm build` 通过；
  - 单测 10 个文件、200 通过 / 1 个候选车道专用测试跳过；
  - `pnpm compat:check`（临时把开发 pin 与安装树都指向 rc.2）通过；
  - `pnpm smoke:compose` 17/17、`pnpm pack:check` 通过、`pnpm smoke:packed` 17/17（`DSH_CLI` 指向 rc.2 构建产物）；
  - `pnpm lint`、`pnpm docs:check` 通过。
  - `pnpm smoke:live` 未执行：脚本要求官方 reviewer 与宿主同版本的 npm 产物，`@deepseek-ai/dsh-experimental-auto-review@0.2.2-rc.2` 同样尚未发布；发布后在正式 pin 上补跑（见下节）。
- 主工作区最终保持 `0.2.2-rc.1` 安装树与开发 pin；本次不创建发布 tag。

### 2026-11-12：0.2.2-rc.2 发布后提升为开发基线

- `@deepseek-ai/dsh@0.2.2-rc.2` 与 `@deepseek-ai/dsh-experimental-auto-review@0.2.2-rc.2` 已在 npm（`next` dist-tag），上一节留下的发布前置条件解除。
- 按升级车道把开发 pin、lockfile 与 release-age 精确条目从 `0.2.2-rc.1` 重指到 `0.2.2-rc.2`（`node scripts/upgrade-dsh.mjs 0.2.2-rc.2` + `pnpm install --no-frozen-lockfile --config.minimumReleaseAge=0`）；cordis 仍为 `4.1.0`。探针产出的临时 workspace overrides 已移除，`pnpm install --frozen-lockfile` 在正式配置下通过。
- rc.2 相对 rc.1 新引入的 13 个包（`dsh-error`、`dsh-agent-team`、`dsh-tool-agent-team`、`dsh-office-kit`、`dsh-terminal-panel`、`dsh-fs-patch`、`dsh-mcp-manager`、`dsh-util-ripgrep`、`dsh-tool-office` 与四个客户端包）补入 `minimumReleaseAgeExclude` 的精确条目——它们没有更早版本的豁免可用，缺条目会让 frozen install 的发布年龄校验失败。
- 验证（macOS arm64 / Node.js `24.18.0`，正式 enforce 门禁）：`pnpm compat:check`（允许清单 / peers / 开发 pin / 安装树四者一致，均为 `0.2.2-rc.2`）、`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm test`（10 个文件，200 通过 / 1 个候选车道专用跳过）、`pnpm smoke:compose` 17/17、`pnpm pack:check`、`pnpm smoke:packed` 17/17、`pnpm docs:check` 全部通过；`pnpm smoke:live` 69/69——以官方 reviewer `@deepseek-ai/dsh-experimental-auto-review@0.2.2-rc.2` 覆盖 allow、deny+ask、deny+never、故障、空态、持久化、清理与重启恢复。
- 本次不创建发布 tag。

## 里程碑纪律

- 每个 M 有对应的 `plans/active|completed/YYYY-MM-DD-mN-*.md`；完成即迁移到 `completed/` 并在本表标注"随 `vX.Y.Z` 发版"。
- 发版由 tag 触发（`pnpm release <kind> --tag`）；发版前先把本表与 CHANGELOG 同步，三者同批提交（见[发版流程](../../development/release-workflow.md)）。

# 开发需求文档：DSH Auto Review Panel（out-of-tree 插件，不改上游）

> 状态：v1——需求定稿（捕获方案已按上游源码逐行核实）。进度与发布状态的唯一真源见[路线图 §进度总账](../plans/completed/2026-10-20-auto-review-panel.md#进度总账)。| 日期：2026-10-20
> **硬约束：不得修改上游仓库（deepseek-harness）中任何包**——全部产物是外部插件/bundle，通过 `dsh plugin add` 或 profile patch 组合安装。
> 事实依据：[upstream-auto-review.md](../reference/upstream-auto-review.md)（上游 Auto Review `0.2.1-rc.2` 调研）；捕获决策：[ADR-0003](../decisions/ADR-0003-review-record-capture.md)

## 1. 需求陈述

Auto 权限预设下，每一次工具执行都先经 Auto Review 审查器裁决：审查器为这次调用组装一份**五分区审查上下文**（固定策略 + 环境 + 项目约束 + 带角色标注的历史 + 待审动作），走 `ctx.llm.stream` 发一次独立请求，解析 `{risk, decision, reason?}` 后放行、转人工或拒绝。

这套裁决的**过程与依据对使用者完全不可见**：审查请求不进 Session 日志（上游源码注释原话："This review prompt is sent only through ctx.llm.stream and never enters a Session log"），轨迹里只有工具卡的最终结果，开发者信息面板（`@deepseek-ai/dsh-experimental-inspector-profile` 组合的 session-inspector）也读不到审查上下文与裁决。放行无声无息，拒绝只剩一条 `AUTO_REVIEW_DENIED` 错误码。使用者无法回答：审查器刚才看到了什么？按什么依据判的？为什么这次拒绝/放行？

**前置条件**：官方 `@deepseek-ai/dsh-experimental-auto-review` bundle 已启用（它随安装附带、默认关闭，主路径是在插件管理器直接启用附带版本；当前安装未附带时才显式安装精确版 `0.2.1-rc.2`——npm 上 `latest` 滞后勿用），且会话使用 Auto preset——两个前提缺一，审查器根本不存在，面板天然无数据。

本插件补足这块可视化：在 `sidebar.right` 注入一个面板 tab（形态对齐 session-inspector），按条检索、阅读每一次 auto-review 的**上下文、裁决与依据**，同时：

- 面板是**只读观察面**，绝不裁决、不拦截、不重做任何一次调用；
- 授权策略、风险分级与来源分类完全由官方审查器负责，本插件不引入第二个审查器、不伪造结论；
- UI 以**精简与可读**为第一原则——对齐 inspector 的挂载形态，不模仿其信息堆积；默认只呈现裁决与依据，其余渐进披露。

本插件同时覆盖官方 `@deepseek-ai/dsh-experimental-auto-review` 与 multi-root 仓库的 Auto Review fork——两者走同一条 `ctx.llm.stream` 审查路径，观察接缝相同。

## 2. 审查器实际产生什么（上游源码核实）

每次被审查的调用，`classifyRisk` 产生并在随后丢弃以下数据（上游 `packages/experimental/auto-review/src/index.ts`，基线 `687f282e`）：

| 数据 | 内容 | 存活期 |
| --- | --- | --- |
| `ReviewSnapshot` | `{provider, model, cwd, projectInstructions, history, action}`——对应请求的四个数据分区：ENVIRONMENT（effective cwd）、PROJECT_INSTRUCTIONS（`agent-instructions` 来源、constraint 角色）、FILTERED_HISTORY（human/direct-parent/constraint/checkpoint/fact 角色标注的用户消息与历史工具调用）、PENDING_ACTION（模式、名字、schema、参数） | 冻结后仅用于渲染请求文本 |
| 审查请求 | `system: REVIEW_POLICY`（固定五段策略全文）+ 单条 user 消息（四节文本）+ `temperature: 0`，经 `ctx.llm.stream(options)` | 请求对象 deepFreeze，不进任何日志 |
| 审查响应 | 0..n 个 reasoning 块 + 恰好一个 text 块（`{"risk","decision","reason"?}`） | `readDecision` 消费后丢弃 |
| 裁决结局 | reviewer decision 只有 allow/deny（allow 协议禁带 reason）；其后宿主处置：allow → `next()` 透传；deny + `ask` → 上游自己把 downstream 的 allow 转成 ask（**上游产生的 ask 不经过 append listener**；下游 listener 自己仍可能返回 ask）；deny + `never` → 直接拒绝（持久化 `AUTO_REVIEW_DENIED`）；reviewer 故障/abort → `finish` chunk 的 `error`/`aborted` + code/message | 仅 deny 的错误码落进工具结果；ask 只存在于上游 listener 自己的返回值里 |

**结论：全部审查数据在 `ctx.llm.stream` 一次调用内产生并消亡。** Session 事件里只有结局残迹（deny 的错误码、ask 的审批提示）；allow 完全无声。

## 3. 可观察接缝评估

| 接缝 | 能拿到 | 拿不到 | 结论 |
| --- | --- | --- | --- |
| `llm/stream` waterfall（只读 tee） | 审查请求全文（五分区逐字）+ 全部响应 chunk（reasoning + 裁决 JSON） | 无 session/callId 身份 | **主数据通道**——唯一能拿到全保真审查内容的公开接缝；需结构指纹识别审查流 |
| `tools/pre-execute` listener（延迟一个 macrotask 的 prepend） | `exec` 全貌（agent/session、callId、mode、name、args）+ 上游返回的决定本身（含 deny 的 `info` 逐字） | listener 顺序非公开契约——更晚 prepend 的纤维会排到它前面 | **关联锚**——给记录回填 sessionId/callId/downstreamDecision/denialInfo；顺序不利时退回"上游之后"位置，deny+never 重新如实未关联 |
| Session 事件（`session/event` 观察） | `tool/result` 的持久结局（deny 的 `AUTO_REVIEW_DENIED` info 逐字）、`approval/asked`+`approval/decided` 审批审计对 | allow 结局之外的任何佐证；无 callId 锚的事件 | **佐证**——只回填 `hostOutcome` 到已关联记录，未关联记录永不佐证 |
| fork 上游审查器 | 内部精确事件 | 覆盖不了官方插件；fork 全量同步成本 | **不做**——见非目标 |

## 4. 功能需求

### 4.1 审查记录捕获（宿主半部）

- **`llm/stream` 只读 tee**：listener 识别审查流后 `next()` 取真 stream，返回"边转发边记录"的包装 iterable；options 与 chunk 只读，绝不替换、短路或重发。识别用**结构指纹**而非版本字符串：`options.system` 以 `REVIEW_POLICY` 节头开头；恰一条 user 消息且其文本含 `ENVIRONMENT` / `PROJECT_INSTRUCTIONS` / `FILTERED_HISTORY` / `PENDING_ACTION` 四个节头；`temperature === 0`；`options.sessionId` 与 `options.purpose` 均缺席（上游 reviewer 不设身份字段，`purpose` 联合类型无 review 值）。指纹不匹配 → 不识别 → 不记录——普通对话流不匹配是**正常路径**，指纹失配绝不产生任何用户可见信号。
- **tee 的防御边界**：吞掉的只有**记录路径自身**的异常——上游 stream 的 `error`/`aborted` finish chunk 与普通 chunk 一律原样透传（否则就改了 reviewer 的失败语义）；记录失败最坏丢一条记录，绝不影响裁决。
- **`tools/pre-execute` 关联 listener（prepend，挂载后延迟一个 macrotask）**：维护"AUTO preset + 有 agent"的在飞执行表；`llm/stream` 记录完成后按 PENDING_ACTION 的 `name` + `arguments` 精确匹配回填 `{sessionId, callId, downstreamDecision, denialInfo?}`。prepend 前置使 `next()` 包进整个上游 reviewer：上游返回的决定（deny+never 的 `denied()`、deny+ask 的 `askUser`）即 `downstreamDecision`，上游 deny 携带的 `info`（`AutoReviewDeniedError`/`AUTO_REVIEW_DENIED`/`reason`）逐字落进 `correlation.denialInfo`。**延迟注册的依据见架构文档 §3.1 实测结论**：service 构造期或 `ctx.effect` 同步注册都会被上游反超；延迟一个 macrotask 在实测组合中落在最前。若某纤维更晚 prepend（顺序非公开契约），listener 退回"上游之后"：此时 deny+never / reviewer failed 的 exec 不再到达，记录仍以 PENDING_ACTION 自持完整、关联字段如实缺席。
- **宿主结局佐证（`session/event`）**：`tool/result`（callId 匹配）回填 `hostOutcome.toolResult {isError, name?, code?, reason?}`；`approval/asked`/`approval/decided`（经 `callId` 与 requestId 桥接）回填 `hostOutcome.approval {outcome, reason?}`。佐证只能落在已有 `correlation.callId` 的记录上——事件早于关联落位时暂存，`correlate()` 时并入；匹配不上的一律丢弃，未关联记录如实无佐证（**ask 的审批面只呈现在详情"宿主结局"行——`ask` 本身不是 reviewer decision，不进裁决 chip**）。
- **记录缓冲**：每会话与全局双上限的环形缓冲（每会话 50 / 全局 200 条，超长丢弃最旧）；记录落缓冲即不可变；`id` 由宿主铸造。上限经长跑实测复核：单条记录驻留约 2 KiB（JSON 投影约 16 KiB），200 全局帽下全量驻留约 0.3 MiB——两个上限按证据保留不变。
- **响应解析**：末个 text 块按上游协议解析 `{risk, decision, reason?}`（allow 协议禁带 reason）；解析失败裁决记 `error` 并保留原始尾部文本（`output.rawText` **始终**保存——"模型原文"的数据源）。`finish` chunk 为 `error`/`aborted` 时记录 `finish: {kind, code?, message?}`——reviewer 失败也必须留下记录，否则用户只在轨迹看到工具失败而面板空白。
- **记录模型**（契约见 `src/contract.ts`）：`{id, capturedAt, provider, model, requestText, sections{policy, environment, projectInstructions, filteredHistory, pendingAction}, reasoning[], output{risk?, decision?, reason?, rawText}, finish?, correlation?{sessionId, callId, downstreamDecision, denialInfo?}, hostOutcome?{toolResult?, approval?}}`——`policy` 为 `options.system` 逐字、`requestText` 为 user 消息文本逐字，两者重组即审查请求全文（"逐字"验收由此可执行）；`sections` 是解析后的结构面（含四个数据节的对象形式），UI 消费它、`requestText` 留作对照与审计。

### 4.2 面板通道

- `connection.rpc.handle(PANEL_CHANNEL, …)` 提供端点，机制与 multi-root 面板通道同构（`ctx.inject(['connection','webServer'])` + 从 `ctx.root` 读 connection）。`list`/`get` 只读；`stats`/`update-settings`/`clear` 是设置与清理面，持久化不可用时如实回 `panel/persistence-unavailable`（stats 退化回 `available:false` 而非报错）。
- 端点：
  - `list(sessionId?, before?, limit?)` → `{ records: Summary[], status: {…}, page: {hasMore, before?} }`——`reviewerAvailable` 由 `permissionPresets.names` 是否含 AUTO preset 判定（AUTO 只在 `registerAuto()` 存活期出现），`sessionPreset` 为 `sessionId` 会话的当前 preset（`sessions.get` + `permissionPresets.current` 两步，host 端须捕获 `current()` 异常）；`sessionPreset` 缺失（未知 session / projection 不可用）时 client 并入空态④。空态①②④由 client 据此推导，不必注入 `permissionPresets`。`before` 是 `capturedAt|id` 键集游标，`limit` 默认 200、上限 500；records 恒为最新在前。
  - **`list(sessionId)` 的返回恒含 `correlation` 缺席的"未关联"记录**——deny+never 恰是最高风险的那批，会话过滤不得漏掉它们。sessionId 缺席时只返回进程内存视图（持久化按会话恢复，不扇出到无会话视图）。
  - `get(id, sessionId?)` → 完整记录；内存未命中时回落持久化。
  - `stats()` → `{available, location?, settings, sessions, bytes, lastError?}`；`location` 恒为符号化拼写（`~/.dsh/…` / `$DSH_HOME/…`），绝不暴露机器绝对路径。
  - `update-settings({retention:{maxRecordsPerSession,maxSessions,maxTotalMegabytes}})` → 三个轴均为非负整数、`0=不限`；成功返回 `{stats, maintenance}`；持久化不可用回 `panel/persistence-unavailable`。
  - `clear({confirm:true})` → 删除全部历史文件 + 当前内存记录，`settings.json` 保留；`confirm` 非 `true` 回 `panel/bad-request`。
- Summary = `{id, capturedAt, action.name, action.mode, risk?, decision?, reason 截断, finish?, correlated: boolean}`。
- 无 Connection 的组合（headless）：捕获与持久化照常运行，通道缺席即无面板——不是错误。

### 4.3 面板呈现（客户端半部）

`sidebarRightTabs.register({ id, kind: 'auto-review', title, guide })` 注册 tab 类型 + `ctx.slots.inject('sidebar.right.pane.tab', …)` 贡献面板体（两阶段注册，与 session-inspector 同构）；面板是会话域 slot 贡献，inject 收到槽位传入的 sessionId 即完成绑定。client `inject` 需求随此扩展：`slots`、`locale`、`connection`、`sidebarRightTabs`；`dsh.client.inject` 同步加 `@deepseek-ai/dsh-client-ui-sidebar-right` 与 `@deepseek-ai/dsh-client-ui-plugin-manager`（后者喂留存设置页，是软依赖——缺席时设置入口不出现、侧栏 tab 不受影响）。
- **列表**（每条审查一行，至多三行排版、行间无分割线）：第一行左侧 = 工具名 + mode 徽标（native/ptc-inner），右侧 = risk 标签 + 裁决 chip 两个着色 Tag（**allow/deny/error/failed 四种——`ask` 不是 reviewer decision 而是宿主处置，v1 不显示**）；第二行 = 标识性参数预览独占一行（exec 类为 `command`、文件类为 `path`/`file_path`，无字符串参数时该行如实缺席）；第三行 = 依据行（deny 的 reason 截断；allow 显示"协议不携带理由"，reasoning 在详情里）最右端时间。检索范围 v1：会话过滤（默认当前会话；**"未关联"组的记录恒可见**——deny+never 的记录没有 sessionId，恰是最高风险的那批）+ risk/decision/tool 轻量多选筛选 + 审查时间起止范围（闭区间；起点/终点各自可单独生效，起止倒置时如实无命中，可一键清除）；tool 选项 = 宿主从实时工具注册表读取的 `status.tools`（`ctx.tools.schemas(agent)`，agent 由 `ctx.agents.get(sessionId)` 定位；排除 reviewer 从不审查的 `run_code`）**并入已加载记录的 `action.name` 与当前选中值**——注册表是 live 会话的首选来源，历史名字只为"重启后的记录仍可筛选"服务，不预置静态清单、不作推断——上游工具名为 `read`/`write`/`edit`/`read_image`/`glob`/`grep`/`bash`/`pwsh`/`todo_write`/`web_*` 等，按组合挂载；注册表不可读时无选项如实降级；全文检索不留 v1。
- **详情**（概览 + tab 分区，与会话视图的"对话/轨迹"切换同构）：
  - 顶部概览卡（约 1/4 高度、内容驱动不写死）：risk 标签 + 裁决 chip + reason 全文（或 allow 的协议说明）+ `provider/model` 一行 + 审查时间 + 工具名 + `arguments` 的标识性参数（command/file_path）与 `description` 各一行 + `finish` 异常（如有）；
  - 四个 tab：`工具调用`（pendingAction）、`审查上下文`（FILTERED_HISTORY 逐条、**按原始 `role`/`source.kind` 展示不重分类**——multi-root fork 会渲染 `current-root-instructions` 等额外条目，原样呈现）、`项目环境`（PROJECT_INSTRUCTIONS 与 ENVIRONMENT 同一面板）、`审查结果`（`思考` 折叠块收 reasoning，`output.rawText` 按 JSON 解析呈现，解析失败按原文）。每个 tab 的内容用上游 `JsonTree` 可视化；REVIEW_POLICY 是固定策略文本，不在每条记录里展开——唯一露面处是面板 header 的帮助/信息 popover（About），其中同时标明当前挂载的审查器包名（`status.reviewerPackage`，读不出时如实缺席）。
- **精简原则**（可验收，见 §6）：默认列表行只含上述至多三行字段；详情默认落在 `工具调用` tab、其余面板不进 DOM（思考块仍折叠）；REVIEW_POLICY 仅在 About 出现一次；已在 session 轨迹可见的工具卡内容不重复呈现。
- **空态四种如实区分**：① Auto Review bundle 未启用/未安装（经 permission-presets 目录是否含 AUTO preset 判定；判定不了时并入④）——最常见的"面板永远空"原因，文案须直接指向启用方法；② 会话未用 Auto preset；③ web 组合中宿主未注册通道（如 Connection 未注入或注册失败——headless 组合下面板整体不存在，不属空态）；④ 审查器在线但尚无记录。**记录在手时一律渲染记录**——已持久化的历史优先于①②④（Auto Review 当前未启用、会话已不是 Auto 时历史照常展示）；③通道缺席例外，无通道无从取数。**没有"指纹未命中"态**——指纹失配不产生任何信号（依据见 ADR-0003 决策 3）；"疑似审查流"（system 以 `REVIEW_POLICY` 开头但其余不匹配）只进宿主诊断计数，不进 UI。
- **历史分页**：`page.hasMore` 时列表底部出现"加载更早"按钮，按 `before` 游标拉取严格更旧页；翻页期间暂停自动刷新（防游标边界空洞）并显示暂停提示，刷新回到最新。工具筛选项并入已加载记录的 `action.name`——重启后恢复的历史记录因此仍可筛选。
- **设置页**：插件管理页本插件条目 → `auto-review-panel` 行的 Configure 页提供三个留存轴（每会话记录数 / 保留会话数 / 总大小 MB；`0=不限`）、存储位置与用量、重置默认、以及经 Modal 确认的"清理全部历史"。
- **双语**：zh/en 走 `ctx.locale`，与宿主文案同源。

### 4.4 审查记录持久化

- **布局**：`<DSH_HOME>/auto-review-panel/v1/`（默认 `~/.dsh/…`，`$DSH_HOME` 覆盖；UI 只显示符号化拼写）。`sessions/<key>.jsonl` 每会话一份 append-only 日志（key 为 `s_`+base64url(sessionId)，超长退化 `h_`+sha256）；`unassigned.jsonl` 收未关联记录的全局集合（跨重启恒可见语义的延续）；`settings.json` 收留存设置，不属于历史、清理不删。目录 `0o700`、文件 `0o600`。
- **行格式**：首行 `header`（`schema:1` + `sessionId` + 可选 `session{createdAt,cwd,isSeeded}` 身份三元组，取自 `Session.header`）+ 后续 `record`（完整记录）/`patch`（`correlation`/`hostOutcome` 增量）/`delete`（仅 unassigned，关联后移除该 id）行。按序 fold：record 建立、patch 合并、delete 移除；半行/坏行跳过。
- **写路径**：捕获（未关联）→ append `unassigned.jsonl`；关联 → append 完整 record 到会话文件 + append `delete` 到 unassigned（崩溃窗口允许短暂重复，读侧按 id 去重、会话副本优先）；同一记录的后续 `hostOutcome` → append `patch`。全部经每文件一条 promise 链串行化；`session/flush` 事件作正常持久化屏障。
- **会话生命周期校验**：live 会话身份与文件 header 三元组逐字段不符 → 该文件视为过期生命周期，读取返回空、下一次写入前改名 `<key>.jsonl.stale-<stamp>` 后新建；冷会话（无 live Session）信任文件。`schema` 不识别 → 标记 foreign，读空、不覆写、warn 一次；首行非法 → 改名 `.corrupt-<stamp>`。
- **留存**（默认三轴全 0=不限）：`maxRecordsPerSession` 写完触发 per-session 压实保留最新 N；unassigned 死行累计超 200 或超 live 数时压实；`maxSessions`/`maxTotalMegabytes` 按文件 mtime 从旧到新淘汰（unassigned 不计入会话数；单文件自身超总量上限保留并回报 warning）。`update-settings` 落 `settings.json` 后立即跑一次 `maintain()`。
- **失败语义**：根目录不可用 → `available:false`，面板只显示内存记录、设置页禁用写操作；单次 append 失败 → 吞掉记 warn；文件损坏/外来 schema 如上；硬杀最多丢最后一个 flush 屏障前的写窗口。**任何持久化失败都不改变捕获、工具执行或上游裁决**。

### 4.5 失败语义（每条对应一条验收）

| 失败 | 面板行为 |
| --- | --- |
| tee 记录路径自身异常 | 吞掉、丢弃该记录；审查与调用不受影响（上游 stream 的 error/abort chunk 原样透传，绝不吞） |
| 审查流指纹未命中 | 不记录、无 UI 信号（普通流的正常路径）；`REVIEW_POLICY` 开头但余部不符的"疑似流"只进宿主诊断计数 |
| reviewer finish 为 error/aborted | 记录保留：`finish: {kind, code?, message?}`，列表/详情如实显示"审查失败" |
| PENDING_ACTION 无关联 exec | 记录保留；归入"未关联"组，不受会话过滤隐藏 |
| 宿主佐证无 callId 锚 | 事件丢弃；未关联记录如实无 `hostOutcome` |
| 裁决 JSON 不符协议 | `decision: error`，`rawText` 保留原文 |
| Connection 缺席 | 不挂通道；宿主捕获与持久化仍运行 |
| 历史根目录不可用/单写失败 | 吞掉记 warn；面板显示内存记录，`stats` 报 `available:false` + `lastError`，设置页禁用写操作 |
| 会话文件身份过期/损坏/外来 schema | 读取为空；stale/corrupt 改名保留字节，foreign 永不覆写 |

## 5. 非目标（任何阶段都不做）

- 不重实现 reviewer、不增加第二个审查入口、不伪造"上游拒了/放了"的结论、不接管 `ask` 的人工审批面。
- 不为拿裁决数据 fork 上游 auto-review 包（fork 覆盖不了官方插件，且会产生双重审查与双重费用；上游若提供正式 review 事件 API 再迁移——见调研 §可用扩展面）。
- 面板不提供"批准/拒绝"操作（v1 只读）。
- 不做跨会话历史浏览/跳转（仅按会话恢复）；不加密、不上传、不远程同步（明文落盘的隐私口径如实写入文档）。
- 不呈现非审查调用（非 Auto preset 无数据可记）。

## 6. 验收标准

宿主捕获：

- AUTO preset 会话执行一次 low-risk 调用后，缓冲里恰好多一条记录：`policy` 与 `options.system` 逐字一致、`sections` 四个数据节与 `requestText` 逐节一致、`decision: allow`、reasoning 原文完整、`output.rawText` 与原始输出逐字一致。
- `never` 下一次 high-risk 拒绝：记录含 `decision: deny` + reason；prepend 居前的组合中回填 `correlation{sessionId, callId, downstreamDecision: 'deny', denialInfo{AUTO_REVIEW_DENIED}}` 且 `hostOutcome.toolResult` 由日志二次佐证；顺序不利使 exec 未到达关联 listener 时记录仍完整、`correlation` 缺席，且该记录归入恒可见的"未关联"组。
- reviewer finish 为 `error`/`aborted`（如断流）：记录保留 `finish` 字段，不以缺省收尾。
- 非审查 LLM 流（普通 session 对话、compaction、session-title）不产生记录；指纹任一要素缺失不误记；fork 形状的 `reviewUserText`（ENVIRONMENT 含 multiRoot 字段、PROJECT_INSTRUCTIONS 含 `current-root-instructions` 条目）经同一指纹命中且解析无损。
- tee 故障注入（记录路径抛错）不改变任何一次审查的结局与 stream 消费；上游 stream 的 error chunk 原样到达消费者。
- 并发在飞 exec 下，记录与 exec 的关联不出现错配（同名同参的歧义宁可不关联）。

通道与面板：

- `list`/`get` 端点形状与契约一致；`list(sessionId)` 在按会话过滤时仍返回 `correlation` 缺席的未关联记录；`status.reviewerAvailable` 在 reviewer bundle 启停两侧如实翻转；headless 组合不挂通道、宿主不炸。
- sidebar.right 出现本面板 tab；列表→详情导航；四种空态分别可复现；zh/en 双语文案齐。
- 精简原则的可测项：列表行为规定的至多三行字段（工具名+mode 徽标 · risk/裁决两个着色标签 · 参数预览行 · 依据行+时间）；详情默认只渲染 `工具调用` 面板；REVIEW_POLICY 不出现在记录视图（仅 About）；面板不复制轨迹工具卡内容。

持久化：

- 一次审查的捕获、关联与 `hostOutcome` 佐证全部落盘：会话文件含 header + record + patch 行，`get` 读回的记录与内存一致（不可变）。
- 重启后按会话恢复：新进程（或同 `$DSH_HOME` 下的另一 profile）打开同 sessionId，`list(sessionId)` 返回完整持久化视图（含未关联组）；reviewer 缺席/会话非 Auto 时历史照常展示。
- `session/flush` 屏障排空该会话写队列；`stats`/`update-settings`/`clear` 端点形状与验收语义一致（负数留存 `bad-request`、`clear` 缺 `confirm:true` `bad-request`、无持久化 `persistence-unavailable`）。
- `stats.location` 为符号化拼写不泄绝对路径；`update-settings` 后立即 `maintain()`；`clear` 删历史文件与内存记录、`settings.json` 保留。
- 持久化不可用（根目录不可写等）时捕获/关联/裁决链不受影响；分页 `before` 游标翻页稳定、无重复 id；加载更早期间轮询暂停、刷新恢复。
- 真实组合验收使用 `@deepseek-ai/dsh-experimental-auto-review@0.2.1-rc.2`（npm `next`，**不要用 latest**——它停在旧版）。
- `pnpm verify:all` + `pnpm compat:check` + `pnpm docs:check` 全绿；`smoke:compose`/`smoke:packed` 通过。

## 7. 开放问题

- 记录推送：v1 用客户端轮询还是通道订阅（`rpc.handle` 支持事件推送的形态需按 connection 现状定）。轮询已落地；翻页期间暂停是刻意取舍（架构文档 §5）。
- ~~关联时机~~ **已收口（M3）**：prepend 延迟注册经真实组合实测采纳——`smoke:live` 断言 `deny+never` 回填 `correlation` 与 `denialInfo{AUTO_REVIEW_DENIED}`；机制与退路见架构文档 §3.1。
- ~~全局缓冲上限~~ **已收口（M3）**：长跑实测单条驻留约 2 KiB（16 KiB JSON），200 全局帽 ≈ 0.3 MiB，50/200 上限按证据保留。
- 「检索」的 v1 范围定为：会话过滤 + risk/decision/tool 多选筛选 + 审查时间起止范围；按工具名/参数的全文检索不在 v1。
- 「上下文维护」的 v1 范围定为：每条审查的最终快照（policy + 四节 + requestText）；跨调用的上下文演化/差分视图是另一个功能，不在本插件承诺内。

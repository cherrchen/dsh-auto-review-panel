# Auto Review Panel：宿主侧数据流与通道设计

> 状态：当前架构（随 M1 落地）。捕获接缝的取舍见 [ADR-0003](../decisions/ADR-0003-review-record-capture.md)；字段级契约见[需求 §4](../requirements/auto-review-panel.md)与 `src/contract.ts`。

本文档收拢三件事的唯一真源：审查记录从 `llm/stream` 到缓冲的数据流、`PANEL_CHANNEL` 通道形状、以及客户端空态所需事实如何在宿主侧产生。M2 的客户端只消费本文档描述的通道，不再新增宿主侧事实来源。

## 1. 数据流总览

```text
官方 reviewer (classifyRisk)
   │  ctx.llm.stream(options)          options: REVIEW_POLICY + 四节 user 文本 + temperature:0
   ▼
llm/stream waterfall ──► 本插件 listener（只读 tee）
   │  结构指纹命中 → teeReviewStream 包装返回的 iterable
   │  指纹失配/suspected → 原样返回（suspected 只进宿主诊断计数）
   ▼
StreamingReviewCapture      逐 chunk 累积 reasoning/text/finish，上游 error/aborted 原样透传
   │  流结束 → parseReviewDecision（镜像上游 {risk,decision,reason?} 协议）
   ▼
ReviewRecordBuffer          add() 即 deepFreeze；每会话 50 / 全局 200 双环形帽
   ▲
   │  correlate() 换入新冻结记录（不原地改）
tools/pre-execute listener（挂载后一个 macrotask 延迟的 prepend）
   AUTO preset 在飞表 + name/arguments/mode 精确匹配 → 回填 correlation{sessionId, callId, downstreamDecision, denialInfo?}
   ▲
   │  attachHostOutcome()（仅 correlation.callId 已知的记录）
session/event observer（tool/result、approval/asked、approval/decided）→ hostOutcome
   ▼
PANEL_CHANNEL（connection.rpc.handle）
   list(sessionId?) → {records: Summary[], status{reviewerAvailable, sessionPreset?}}
   get(id) → 完整 ReviewRecord
   ▼
M2 客户端面板（sidebar.right tab）
```

三条不变式贯穿全链路：

- **只读**：tee 逐 chunk 透传、绝不短路或重放；pre-execute 只追加观察、返回值原样；通道端点只读。
- **fail-closed**：读不出的字段如实缺席（`correlation`、`sessionPreset`、`finish`、解析不出的 `risk`/`reason`），绝不本地重算。
- **故障隔离**：记录路径自身异常全部吞掉（tee 的 `sink.push/finish`、buffer add、关联回填），上游异常原样传播——丢一条记录可接受，改变一次审查结局不可接受。

## 2. 缓冲模型

`ReviewRecordBuffer`（`src/records.ts`）两条容量独立作用：

- **全局 200**：覆盖一切记录，包括永远不会有 `correlation` 的 `deny + never` 批次——它们恰是最高风险记录，不能被会话帽漏管；
- **每会话 50**：只作用于已关联记录，在 `add()`/`correlate()` 时各执行一次。

落缓冲即 `deepFreeze`（含嵌套）。`correlate()` 以新冻结对象原位替换，读者已持有的快照不受影响；已关联记录保留首枚锚。

会话过滤规则：**`list(sessionId)` 恒含未关联记录**——`deny + never` 的 exec 到不了 append listener，这批记录没有 sessionId，却必须出现在任何会话视图里。列表行是 `summarizeRecord` 投影的紧凑行（时间、action name+mode、`preview`——`pendingAction.arguments` 里按 `command`/`path` 等键序取出的首个字符串成员一行截断、risk、decision、截断 160 字符的 reason、finish、correlated 标记），详情走 `get(id)` 取完整记录。

## 3. 关联锚与宿主佐证

### 3.1 listener 位置（M3-2 实测结论）

关联 listener 以 `{prepend: true}` 注册，但推迟到挂载后的第一个 macrotask（`ctx.effect` 内 `setTimeout`）。实测依据（`pnpm smoke:live` 断言，正式组合 `@deepseek-ai/dsh-experimental-auto-review@0.2.1-rc.2`）：

- cordis 让**最后注册的** prepend listener 跑在 waterfall 最前；
- 上游 reviewer 在自己行挂载时经 `ctx.effect` 注册 prepend——在本插件行（挂载顺序在其后）的 Service 构造器或 `ctx.effect` 里同步注册，都会**先于**上游落表，反而排到它后面；
- 推迟一个 macrotask 的注册晚于所有挂载期注册、又早于任何可能发生的 exec（exec 需要会话，会话不可能存在于挂载同步阶段）——实测 `deny + never` 的记录因此获得 `correlation` 与 `denialInfo: {code: 'AUTO_REVIEW_DENIED'}`。

listener 顺序不是公开契约：如果某个纤维比我们更晚 prepend，本 listener 退回"在上游之后"的位置，`deny + never` 重新不可见、记录如实保持未关联——缓冲模型本就覆盖这条退路。位置是断言出来的事实，不是假设。

### 3.2 在飞表与匹配

`src/host.ts` 维护"有 agent + 非外层 `run_code` + 会话当前 preset 为 Auto"的在飞执行表。exec 落锤（`next()` 返回）时，以 PENDING_ACTION 的 `name` + `mode` + `arguments`（`JSON.stringify` 无损比较，与上游 `sameJson` 同形）匹配未关联记录：

- 恰一条候选记录且恰一个在飞同形 exec → 回填 `correlation{sessionId, callId, downstreamDecision, denialInfo?}`；
- 任何歧义（多条记录对一个 exec、多个同形 exec 对一条记录）→ 不关联，且该记录记入永久歧义集——后落的竞争 exec 不得靠排除法认领它；
- `next()` 抛错 → 在飞项清掉、异常原样上抛，记录保留且如实未关联。

`downstreamDecision` 是**本 listener 观察到的下一段 waterfall 决定**（`PreToolDecision["kind"]`）。prepend 居前时它就是上游返回的决定本身——`deny + never` 时上游的 `denied()` 决定与 `info`（`AutoReviewDeniedError`/`AUTO_REVIEW_DENIED`/`reason`）逐字落进 `correlation.denialInfo`；`deny + ask` 时观察到 `ask`（协议仍记 `decision: deny`，宿主处置与 reviewer 裁决在契约层分列：`output.decision` vs `correlation.downstreamDecision`）。

### 3.3 宿主结局佐证（session/event）

`ctx.on('session/event')` 观察追加进 Session 日志的两类事件，只回填 `hostOutcome`、只在 `correlation.callId` 已知的记录上：

- `tool/result`（按 `message.toolCallId === callId` 匹配，message 先展开）→ `hostOutcome.toolResult {isError, name?, code?, reason?}`——`deny + never` 的 `AUTO_REVIEW_DENIED` 在日志侧被二次佐证；`name`/`code`/`reason` 取自事件 `error` 字段（`ToolResultError['info']`），verbatim；
- `approval/asked` 携带 `callId` → 建立 `requestId → callKey` 旁路索引并挂出空 `approval` 面 → `approval/decided` 同 requestId → `hostOutcome.approval {outcome, reason?}`——`ask` 转人工的真实结局（allowed-once / rejected / cancelled / unavailable），如实记录。

**佐证只属于已关联记录**：两类佐证都按 `callKey(sessionId, callId)` 寻址；事件早于关联落位（审批对在 `next()` 返回前就已入日志）时先进 `pendingOutcomes` 暂存，`correlate()` 时并入记录。`asked` 不携带 `callId` 或寻址不到任何锚的事件一律丢弃，绝不按工具名/会话猜给记录；`#approvals`/`#pendingOutcomes`/`#recordByCall` 的上限随全局环容量（默认 200）防泄漏；歧义标记集随记录逐出同步剪枝。未关联记录永远拿不到 `hostOutcome`——这是"佐证需要锚"的诚实边界。

## 4. 通道与空态事实

`PANEL_CHANNEL = '/auto-review-panel'`（`src/contract.ts`）经 `connection.rpc.handle` 挂载。挂载是软接缝：`ctx.inject(['connection','webServer'], ctx => ctx.root.get('connection'))`——`ctx.root` 读法照搬 multi-root，因为 `rpc.handle` 要把 `webServer` 解析为读取上下文上的属性，本插件 fiber 看不到兄弟行的服务。headless 组合没有这两个服务，回调不执行，捕获照常工作、通道缺席不是错误。

端点只有两个，返回值是 carrier-neutral 的 `{ok:true,value} | {ok:false,error}` 信封：

- `list({sessionId?})` → `{records, status}`；
- `get({id})` → 完整 `ReviewRecord`，未命中返回 `review-record-not-found`。

`status` 承载客户端选择空态所需的全部宿主事实：

| status 字段 | 来源 | 服务的空态 |
| --- | --- | --- |
| `reviewerAvailable` | `permissionPresets.names` 是否含 AUTO preset | ① reviewer bundle 未启用/未安装 |
| `sessionPreset?` | `sessions.get(sessionId)` + `permissionPresets.current(session)` | ② 会话非 Auto |

两个字段的读取都包在 `try` 里：**catalog 读不出时 `reviewerAvailable` 保守报 `true`**（需求把"判定不了"映射到空态④而非①）；`current()` 抛错或 session 未知时 `sessionPreset` 如实缺席，客户端并入空态④。空态③（宿主未挂通道）由客户端从"通道调用本身失败"推导，不经 status。

服务注入边界（`src/panel.ts` 的 `static inject`）只有 `autoReviewPanelCompat` + `permissionPresets` + `sessions` 三个**真正调 API** 的服务；`llm`/`tools` 仅作 `ctx.on` 事件名出现——`llm` 是 optional peer，进 inject 会让合法的缺 llm 组合静默丢行。compat 门禁注入同时保证被拒绝的安装退化为"插件未安装"而非半挂载。

## 5. 客户端半部（M2 落地）

两阶段挂载与 session-inspector 同构：`sidebarRightTabs.register({id: 包名, kind: 'auto-review', title, guide})` 注册 tab 类型；`ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({name, key: 包名, locale: NS, inject}))` 在同名 `id` 下贡献面板体——`inject` 是软接缝，侧栏不声明该槽位时面板体不出现而不是报错。

**会话绑定**：`sidebar.right.pane.tab` 是 session 作用域槽位，框架以 pane 会话身份调用 inject 工厂。每次注入产出 `PanelInjected`：

```ts
{
  hooks: { records: ObservableSnapshot<PanelSnapshot> }  // → 组件 useRecords
  getRecord(id)          // get 端点；逐出的记录如实 undefined
  refresh()              // 间隔外手动轮询
}
```

**数据源**：`createRecordsSource(api, sessionId)` 按 3s 间隔轮询 `list`（v1 无推送端点，需求 §4.2 开放问题允许轮询替代）；首个订阅者启动、最后退订停止；按线内容 JSON 判等，答案未动不重新发布。无 Connection 的组合（`ctx.get('connection')` 为 undefined）源直接置 `failed`，不再尝试。

**空态推导**（`emptyStateOf`，唯一判定点）：`failed` → ③通道缺席；`!reviewerAvailable` → ①bundle 未启用；`sessionPreset !== undefined && !== 'auto'` → ②非 Auto；`records` 为空 → ④尚无记录——`sessionPreset` 缺席按契约并入④。客户端不注入 `permissionPresets`，全部事实来自 status。`status.reviewerPackage` 是宿主经 `ctx.root.registry` 的 fiber `entry.options.name` 回读的挂载包名（`auto-review` 且非本包），About 弹层用它标明当前审查器；读不出时如实缺席。

**呈现纪律**：控件全部来自 `@deepseek-ai/dsh-client-ui-primitives`（Button/Tag/Menu/DisclosureRow/JsonTree/Modal/TextShimmer + 图标，seeded 模块表词、bundle 外部引用），自有 CSS 只负责布局与行排版；列表行至多三行、行间无分割线：第一行左侧 = 工具名 + mode 徽标，右侧 = risk 标签 + 裁决 chip 两个着色 Tag；第二行 = `preview` 参数预览独占一行；第三行 = 依据行，最右端时间。分"当前会话/未关联"两组（host 的会话过滤已恒含未关联，分组是纯呈现）；risk/decision 是两个多选下拉（字段名只作触发器文案、不进选项；选中几项显示几项，宿主未给的字段不算命中），无全文检索；刷新与 About 是 header 右侧两个图标按钮。详情是"概览 + tab"布局：顶部概览卡（max-height ~30%、可滚）放着色 Tag、`provider/model`、审查时间、工具名与 arguments 的标识参数/说明行；下方同会话视图的下划线 tab 条（role=tab 排 + 激活下划线，该条在上游为会话私有不导出）四个面板——`工具调用`（pendingAction）、`审查上下文`（FILTERED_HISTORY 按原始 `kind`/`role`/`source.kind` 逐条不重分类）、`项目环境`（PROJECT_INSTRUCTIONS+ENVIRONMENT 同一面板）、`审查结果`（`思考` 折叠块收 reasoning 原文、`output.rawText` 紧跟其后无标题）；每个面板先走上游 `JsonTree`（轨迹检查器同款组件，copy 菜单关闭）；仅活动面板进 DOM；REVIEW_POLICY 仅在 header About 弹出层出现（从最新一条记录的 `sections.policy` 读取，无记录时如实说明而非编造）。


**注入**：`inject = [slots, locale, connection, sidebarRightTabs]`；`connection` 是必需 inject——缺席组合里本插件的 client 行不启动、tab 不存在（与宿主门禁同型的"未安装"退化）；`ctx.get` 是防御性读法，覆盖 apply 之后服务被替换的形状漂移，通道缺席空态经调用失败到达而非经 Connection 缺席。`dsh.client.inject` 同步 `@deepseek-ai/dsh-client-ui-sidebar-right`。轨迹导航曾在本里程碑评估并撤销：可见 tab 切换走 `conversation.session` 私有 inject 面的 store actions（公开服务面无写口），call 级 focus 同理，无可靠接缝时宁可不提供按钮。

**文案**：双语 zh/en 走 `ctx.locale`（NS `auto-review-panel`），宿主侧零文案——记录、错误码、节名是共享词表。

## 6. 诊断面

指纹以 `REVIEW_POLICY` 开头但其余失配的流计入 `host.diagnostics.suspectedReviewStreams`，仅供宿主侧升级车道核对——不进通道、不进 UI。指纹失配本身不产生任何信号（ADR-0003 决策 3）。

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
tools/pre-execute listener（append）
   AUTO preset 在飞表 + name/arguments/mode 精确匹配 → 回填 correlation{sessionId, callId, downstreamDecision}
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

会话过滤规则：**`list(sessionId)` 恒含未关联记录**——`deny + never` 的 exec 到不了 append listener，这批记录没有 sessionId，却必须出现在任何会话视图里。列表行是 `summarizeRecord` 投影的五字段紧凑行（时间、action name+mode、risk、decision、截断 160 字符的 reason、finish、correlated 标记），详情走 `get(id)` 取完整记录。

## 3. 关联锚

`tools/pre-execute` append listener（`src/host.ts`）维护"有 agent + 非外层 `run_code` + 会话当前 preset 为 Auto"的在飞执行表。exec 落锤（`next()` 返回）时，以 PENDING_ACTION 的 `name` + `mode` + `arguments`（`JSON.stringify` 无损比较，与上游 `sameJson` 同形）匹配未关联记录：

- 恰一条候选记录且恰一个在飞同形 exec → 回填 `correlation{sessionId, callId, downstreamDecision}`；
- 任何歧义（多条记录对一个 exec、多个同形 exec 对一条记录）→ 不关联，且该记录记入永久歧义集——后落的竞争 exec 不得靠排除法认领它；
- `next()` 抛错 → 在飞项清掉、异常原样上抛。

`downstreamDecision` 是**本 listener 之后其余 waterfall 的决定**（`PreToolDecision["kind"]`），可能与 reviewer decision 不同；上游 reviewer 自己产生的 `ask` 发生在本 listener 之前，不可见——两个事实在契约层分列（`output.decision` vs `correlation.downstreamDecision`）。

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

## 5. 诊断面

指纹以 `REVIEW_POLICY` 开头但其余失配的流计入 `host.diagnostics.suspectedReviewStreams`，仅供宿主侧升级车道核对——不进通道、不进 UI。指纹失配本身不产生任何信号（ADR-0003 决策 3）。

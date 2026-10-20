# ADR-0003：审查记录经 llm/stream 只读 tee 捕获，pre-execute 只做关联

> 状态：已接受（决策已定，随 M1 实现生效）| 日期：2026-10-20
> 关联：[需求文档](../requirements/auto-review-panel.md)、[上游调研](../reference/upstream-auto-review.md)、[ADR-0001](ADR-0001-dsh-compat-contract.md)、[ADR-0002](ADR-0002-upstream-coupling-policy.md)

## 背景

面板要呈现的"审查上下文 + 裁决 + 依据"在官方审查器里全部产生并消亡于 `classifyRisk` 一次调用内：五分区快照只用于渲染 `ctx.llm.stream` 的请求文本，reasoning 与裁决 JSON 消费后丢弃，源码明确"never enters a Session log"。没有任何"审查事件"公开接口，deny 只在工具结果里留 `AUTO_REVIEW_DENIED` 错误码，allow 完全无声。要在不改上游、不 fork 的前提下拿到全保真记录，只能从既有 waterfall 上读。

## 决策

1. **主数据通道是 `llm/stream` waterfall 的只读 tee。** listener 先按**结构指纹**识别审查流：`options.system` 以 `REVIEW_POLICY` 节头开头；恰一条 user 消息且其文本含 `ENVIRONMENT` / `PROJECT_INSTRUCTIONS` / `FILTERED_HISTORY` / `PENDING_ACTION` 四个节头；`temperature === 0`；`options.sessionId` 与 `options.purpose` 均缺席（上游 reviewer 不设身份字段，`purpose` 联合类型亦无 review 值——这一缺席本身是识别要素）。命中后 `next()` 取真 stream，返回"边转发边记录"的包装 `AsyncIterable`：逐 chunk 记录（reasoning 文本、text 块、finish），透传不修改。据此得到五分区逐字内容（记录保留 `policy` 节全文、`requestText` user 文本逐字与 `output.rawText` 响应原文）、provider/model、reasoning、裁决原文、以及 `error`/`aborted` 的 finish 结局——是公开接缝里唯一全保真的来源。
2. **`tools/pre-execute` listener（append）只做关联锚，不是数据通道。** 它维护"AUTO preset + 有 agent"的在飞执行表，把 `exec` 的 `name`/`arguments` 与记录的 PENDING_ACTION 精确匹配，回填 `{sessionId, callId}` 与 **`downstreamDecision`**（`PreToolDecision["kind"]`：allow/deny/cancel/ask——本 listener 之后其余 listener 的决定，**下游自己产生的 `ask` 会出现**）。它拿不到 reviewer 结论——上游 prepend 先跑；deny+never 与 reviewer failed 时 `next()` 根本不被调用；上游 deny+ask 的 `ask` 产生在上游自己的返回值里，本 listener 位置永远看不到（会被记为下游的 `allow`）。所以本字段与 reviewer decision 是两个独立事实（reviewer allow、下游仍可 deny/ask），UI 不得混用。
3. **一切读不出的字段如实缺席，绝不本地重算。** 指纹未命中 → 不记录、**无 UI 信号**——指纹是对每条流的全有/全无匹配，普通对话流不匹配是正常路径，"这条本来是审查但没匹配上"无从得知，面板如实分①reviewer bundle 未启用（Auto preset 不在目录）②会话未用 Auto preset ③web 组合通道缺席 ④尚无记录四种空态；`system` 以 `REVIEW_POLICY` 开头但余部不符的"疑似审查流"只进宿主诊断计数，供升级车道与人肉排查，不冒充会话级结论。无关联 exec → 记录保留、归入恒可见的"未关联"组；裁决 JSON 不符协议 → `decision: error` 且 `rawText` 保留原文。
4. **tee 的防御边界是硬约束**：吞掉的只有**记录路径自身**的异常；上游 stream 的 `error`/`aborted` finish chunk 与普通 chunk 一律原样透传——吞掉它们等于改掉 reviewer 的失败语义。包装器绝不短路或重发。最坏丢一条记录，绝不影响任何一次裁决。

## 备选方案与拒绝理由

| 方案 | 拒绝理由 |
| --- | --- |
| fork 上游审查器，在 classifyRisk 内部直接发事件 | 覆盖不了官方插件（fork 只能替换自身）；fork 全量同步成本与双重审查风险换一个"更精确的时间戳"不值；上游若提供 review 事件 API 再迁移 |
| 只用 `tools/pre-execute` + Session 事件 | 拿不到裁决与上下文——这两个接缝里它们根本不存在；面板只剩"某调用经过了审查"，不满足需求 |
| 直接 import 上游 `REVIEW_POLICY` 常量做全等匹配 | 该常量未导出，私有文本复制进来就是分叉的事实源；结构指纹达到同等精度且如实降级 |
| 包装 `next()` 之外的 options 或注入假身份标记 | 破坏只读边界；审查请求 deepFreeze 也不允许 |

## 已知脆弱点与缓解

- **指纹随上游演进**：策略节头改名、请求形状变化 → 识别失效 → 面板空态（fail-closed，不报假数据）。升级车道（`upgrade.yml`）每周把捕获相关断言跑在候选版本上；指纹常量集中在 `src/compat/`（ADR-0001 第四条），升级时一处修改。
- **stream 无审查身份**：`GenerateOptions` 虽有可选 `sessionId`/`purpose`，但上游 reviewer 两者都不设、`purpose` 联合类型也没有 review 值——审查流在类型上与普通请求无法区分，身份只能由结构指纹给出，session/callId 只能由关联锚回填。同名同参歧义宁可不关联也不错配（验收标准要求）。
- **并发与重试**：一次 exec 可能产生多条匹配的审查流（provider 重试），或并发 exec 相互交错——记录按流计条，关联按 PENDING_ACTION 匹配；重试在 UI 上如实呈现为多条或带 attempt 标记（M1 内定）。

## 推论

- 本插件对官方插件与 multi-root fork 等效——fork 的 `reviewUserText` 节头、`REVIEW_POLICY`、单条 user 消息、`temperature: 0` 与官方逐字一致，同一指纹命中；fork 的增量（ENVIRONMENT 的 multiRoot 字段、`current-root-instructions` 条目）只进节内，UI 按原始 `role`/`source.kind` 展示不重分类。验收含 fork 形状的解析 fixture。
- 该 tee 是**观察身份**——它不裁决、不改请求、不在 `inject` 授权链上，与 fork 的"没有全局 LLM hook"约束不冲突：那条约束管的是 reviewer 路径，本插件永远不在那条路径上。
- 通道与面板只消费宿主缓冲里的记录；记录**不落盘**，进程重启清空（需要历史留存时另立项）。
- UI 的裁决 chip 只有 allow/deny/error/failed 四种——`ask` 是宿主处置（deny 后经人工审批），不是 reviewer decision，v1 不显示；宿主处置的呈现留 M3 用 Session 事件佐证。

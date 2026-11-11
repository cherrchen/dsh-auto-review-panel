# 上游 Auto Review 调研（`0.2.1-rc.2`）

调研日期：2026-10-20；复核至 `dsh-v0.2.2-rc.2`（2026-11-11），各版本增量见下方复核小节。本文记录已核实的上游源码事实，是面板面只读语义的边界依据；上游原始包为 `@deepseek-ai/dsh-experimental-auto-review`，源码位于上游仓库 `packages/experimental/auto-review`。

## 基线与证据范围

| 对象 | 本次核对基线 |
| --- | --- |
| 上游 | `dsh-v0.2.1-rc.2`，commit `687f282e8625c6b8d11ff58211a90524be2e4317` |
| 已安装运行时 | 调研时本仓库 devDependencies pin `0.2.1-rc.2`，从 `@deepseek-ai/dsh/package.json` 锚定解析的 tools、llm、permission-presets、session、agent 均为 `0.2.1-rc.2` |

上游源码链接均固定到该 commit。

## rc.3 复核（2026-10-25）

对比上游 `dsh-v0.2.1-rc.2` 与 `dsh-v0.2.1-rc.3`（commit `1f81c047fc48fa190a683e469daa699857e9afe8`）：`packages/experimental/auto-review` 仅包版本变化，源码与测试未改，以下审查语义仍适用。插件依赖的 tools、llm、permission-presets、session 与历史存储接缝没有实现变化；客户端侧栏新增菜单/固定项能力，plugin-manager 新增 `pluginNavigation.openList()`，本插件使用的 tab 注册、`sidebar.right.pane.tab` 与 `plugins.bundle.config` 接缝保持兼容，无需新增版本分支。

## rc.4 / rc.5 / 0.2.2-alpha.2 复核

- **rc.4、rc.5**：`packages/experimental/auto-review` 与本插件依赖的全部宿主接缝（permission-presets、session、tools、llm、approval、home-paths、atomic-write）均无相关实现变化，既有指纹与裁决协议原样适用。
- **0.2.2-alpha.2**：`auto-review` 重写为按条目的 `messages` 渲染协议——`system` 仍是 `REVIEW_POLICY`，`temperature` 仍为 0，仍不设 `sessionId`/`purpose`；但 `messages` 由"单条 user 消息四节"改为"多条 user 消息"：首条 `ENVIRONMENT\n{json}`，其后每条是一个保留 Session 条目（`user-message`/`tool-call`/`tool-schema` 三种 `kind` 的 JSON 对象），末条为待审 tool-call（`mode` ∈ `native`/`ptc-inner`、`name` 字符串、`arguments` 为原始 JSON 字符串）。待审动作的 `description`/`parameters` 不再内嵌，取自首条之前最近一个同 `mode`+`name` 的 `tool-schema` 条目。历史条目跨审查复用、逐条字节稳定，供 provider 前缀缓存。裁决响应协议（reasoning 块 + 单一 text 块 `{risk,decision,reason?}`）、`tools/pre-execute` 瀑布签名、deny/ask/failed 的结局语义不变；新增 reviewer 失败身份 `AutoReviewFailedError`/`AUTO_REVIEW_FAILED`（原仅 `AutoReviewDeniedError`/`AUTO_REVIEW_DENIED`）。
- **工具执行接缝**：`dsh-tools` 重构为 executor 架构——`tools.execute` 由单次调用形参改为 `ToolBatchInput {calls, signal, agent?, toolSet?, log?}`（`log` 令 executor 自行落盘 `tool/call`/`tool/result`），结果改为 `ToolBatchResult`；组合 bundle 挂载 `dsh-tool-executor-native`（root scope）。`RUN_CODE_NAME`、`ToolExecution`、`PreToolDecision`、`tools/pre-execute`、`tools/result`、`tools.schemas()` 公共面保持不变。测试fixture `defineContentToolFixture` 移入 `dsh-tool-testkit`，跨版本稳定入口为 `defineTool`（须显式声明 `output`）。
- **cordis**：0.2.2-alpha.2 需要 `~4.0.6-alpha.1`，peer 范围相应扩列。

## 0.2.2-alpha.3 / 0.2.2-rc.1 复核（2026-11-11）

对比 `dsh-v0.2.2-alpha.2`、`dsh-v0.2.2-alpha.3` 与 `dsh-v0.2.2-rc.1`（rc.1 的提交只改包版本号，源码与 alpha.3 相同）：

- **审查请求获得身份（alpha.3）**：`auto-review` 在 `GenerateOptions` 上新增 `sessionId: agent.session.id` 与 `purpose: 'auto-review'`（经 `LlmRequestPurposeMap` 声明）。`system`、`temperature: 0`、`messages` 的 `ENVIRONMENT`/保留条目渲染、裁决响应协议、`tools/pre-execute` 瀑布签名与 deny/ask/failed 结局语义均未变。这两个字段是**模型不可见的传输元数据**（provider 前缀缓存与路由键），不改变请求可见文本；面板指纹据此把"带 review purpose 的请求"与旧版"无身份请求"都识别为审查流。
- **cordis 4.0.6-alpha.2 / 4.1.0 的服务解析变更（alpha.3 起）**：服务属性读取改由**定义站点**（def site）裁决。`connection.rpc.handle` 内部要读取 `owner.webServer`，而 Connection 服务的定义站点是它自己的 fiber（`inject: ['credentials']`），组合里 `webServer` 是兄弟行——于是 `rpc.handle` 在真实 web profile 中抛 `cannot get property "webServer" without inject`，通道根本注册不上。上游自身没有生产代码调用该 API（只有测试在 root 上 `provide('webServer')` 的场景），所以这是 0.2.2-alpha.3 起对第三方插件暴露的真实回归。本插件在 `src/compat/panel-channel.ts` 里结构化探测：先试 `rpc.handle`，失败则用 `connection.admit()` 做认证围栏、直接在 `webServer` 上注册同一条 prefix 命名路由，并复刻 `rpc.handle` 的 RPC 信封 framing（状态码、`gateway/bad-request`、`{type:'server-response',rpcId,result}` 响应形状一致）。
- **组合 base patch（alpha.3）**：`dsh-base/cordis.patch.yml` 给 `fs-observation-policy` 加 `disabled: true`、给 `tool-fs` 加 `config.applyPatch: false`。本插件 patch 只追加自己的三行，组合冒烟对全量行做逐字节对照，不受影响。
- **客户端接缝（alpha.3）**：`ui-sidebar-right` 的 tab 注册面保持不变；新增 `SidebarRightTabInfo.panel.isFloating`、`openResource` 的 `destination`、`contextMenu.*` 槽与 `ctx.contextMenus` 注入，均为增量。`ui-primitives` 只新增导出（`MENU_TRANSITION_MS`、`useMarkdownDelegate`、`MarkdownMenuTarget`），`Menu` 新增可选 `disabledReason`，本插件使用的控件 API 不变。`ui-plugin-manager` 的改动集中在安装对话框的失败阶段与日志路径，`plugins.bundle.config` 贡献契约不变。
- **`dsh-llm` 的 `purpose` 类型（alpha.3）**：`GenerateOptions.purpose` 由固定联合改为 `LlmRequestPurposeMap` 声明键；构造请求的生产方须导入自己的包以加载 augmentation。本插件只读 `options.purpose`，按字符串比较（`'auto-review'`），不依赖该键是否在本地类型可见。
- **`util/values` 重写（alpha.3）**：本插件只把 `dsh-util-values` 作为宿主服务包版本证据，不导入其导出，无需适配。

当前支持版本以 [`SUPPORTED_DSH_RELEASES`](../../src/compat/dsh-version.ts) 为准；验证结果见[路线图兼容性验收记录](../plans/completed/2026-10-20-auto-review-panel.md#兼容性验收记录)。

## 0.2.2-rc.2 复核（2026-11-11）

对比 `dsh-v0.2.2-rc.1` 与 `dsh-v0.2.2-rc.2`（commit `ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c`）：

- **Auto Review 与 permission-presets**：两个包除 `package.json` 版本号外无源码变化；`REVIEW_POLICY`、`messages` 逐条目渲染协议、reviewer 自报的 `purpose: 'auto-review'`/`sessionId` 身份、裁决响应协议与 `tools/pre-execute` 瀑布签名全部原样适用。
- **`dsh-tools`**：`ToolGuard` 可返回 `string | {reason, info}`，`checkGuards` 相应返回结构化拒绝；`PreToolDecision` 的 `deny` 增加可选 `info`，审批拒绝携带 `ApprovalError` 身份（`APPROVAL_REJECTED`/`APPROVAL_CANCELLED`/`APPROVAL_UNAVAILABLE`），`tool/result` 的 `error` 可落该身份；取消后的未分类抛出也补 `ABORTED` 身份。本插件不注册 guard、不包装 pipeline，只读 `tools/pre-execute` 的 decisions 与 `session/event` 的 `tool/result`；新增 `info` 是附加证据字段，记录与呈现语义不变。
- **`dsh-session`**：新增批量 `append(inputs)` 与 `session.currentBatchPublication`，单事件 `append` 重构但契约不变——`session/event` 仍逐个事件派发（批量提交后在完整日志上依次发布）；新增 `team/mode` 已知事件类型。本插件只读观察既有事件，不批量写过 Session，不受影响。
- **`dsh-llm`**：`HarnessError` 迁到 `@deepseek-ai/dsh-error` 并由 `dsh-llm` 重导出（`dsh-llm` 的错误入口不变）；失败码收敛为 `LLM_FAILURE_CODES`/`LlmError.fromFailure`，retry policy 增加可重试码集合与字段下界，tool-update 投影按删除/新增重建声明。`llm/stream` waterfall 签名、`StreamChunk`/`GenerateOptions`（含 `purpose`/`sessionId`）与 finish 结局未变；插件只读 chunk 与 finish，类型仍从 `dsh-llm` 入口导入。
- **`dsh-agent` / `dsh-agent-loop`**：移除 `CreateAgentOptions.parentAgent`、`AgentRegistry.roots()` 与 `isOwnedBy()`，生命周期信号与取消路径调整。本插件从未使用这些 API，也不读取 agent 运行时父子关系。
- **客户端槽与控件**：`ui-slots` 新增 `hoc` 槽种类（增量，本插件只用 list/keyed）；`ui-primitives` 的 `Menu` 门户定位改由 CSS anchor positioning 承担（`anchorRef`/`anchorPoint` 取代 `getAnchorRect`，`useAnchoredPosition` 不再导出）——本插件的筛选菜单只用 `Menu portal` + `anchor`，仍受支持；`Modal` 新增可选 `tone`，`RiskConfirmation` 内部改用 `Checkbox`，`Checkbox` 新增可选 `modalAutofocus`，本插件使用的 `SettingsForm`/`SettingsValueField`/`PathLabel`/`JsonTree`/`Tooltip`/`Toast`/`Tag`/`Button`/`DisclosureRow` 导出签名未变；`ui-plugin-manager` 的 `plugins.bundle.config` 契约与 `PluginConfigViewProps` 未变，新增的 `PluginTabUpdate`、卡片 `update`/`statusNotRunning` 与 Git 更新流程都是其它消费面的增量。
- **侧栏与启动**：`ui-sidebar` 把 `sidebar.panellist` 改为 `sidebar.panel.icon` factory 能力、增加会话区滚动交接；`ui-sidebar-right` 仅样式调整——本插件的 `sidebarRightTabs.register` 与 `sidebar.right.pane.tab` 注册面不变。`client/web` 把非必需客户端条目的启动失败从“整页拒绝启动”改为逐条告警，必需条目集合（modules/session controller/renderer/layout/session/chat/sidebar）不含本插件；`client/modules` 对条目创建失败记录并继续。
- **组合与安装**：`app-boot` 的 bundle 平台声明开始接受 `wsl`，Harness-home `.env` 的允许项增加 DeepSeek 端点；`plugin-manager` 支持 Git 安装源的更新、`BundleInfo.updatable` 改为 `update: 'registry' | 'git'`、新增 `unexpected-package` 失败类别；`dsh-base` 的 `cordis.patch.yml` 改了点名（`dsh-deepseek-account-platform` → `dsh-deepseek-account`）并新增 `agent-team` 行。本插件 patch 以 `insert` 追加三行、不依赖这些行的 id 或顺序，组合冒烟在 rc.2 上仍断言“只多三行、其余逐字节相同”。
- **连接接缝**：`@deepseek-ai/dsh-client-connection` 只有包元数据变化，`rpc.handle` 的缺陷与 `src/compat/panel-channel.ts` 的 `webServer` 命名路由回退原样适用。

结论：`0.2.2-rc.2` 对本插件使用的接缝没有破坏性变化，无新增运行时适配分支；`SUPPORTED_DSH_RELEASES` 的扩展是对“该版本可以被支持”的人工提升。

## 审查入口与生命周期

| 接缝 | 已核实行为 | 源码 |
| --- | --- | --- |
| 注册入口 | 包入口只公开 `name`、`inject`、`apply`；`ReviewSnapshot`、快照构造、提示词与决策解析均非公开接口 | [auto-review/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/experimental/auto-review/src/index.ts) |
| 调用阶段 | 在置前的 `tools/pre-execute` listener 中审查；只审查有 agent 且当前 preset 为 Auto 的执行；外层 `run_code` 跳过，其已开始的 PTC inner calls 分别审查 | 同上 `apply` |
| 环境 | `workingDirectory.ensure(agent, signal)` 得到 effective cwd；`ENVIRONMENT` 只渲染 `{ cwd }` | 同上 `classifyRisk`、`reviewUserText` |
| 项目约束 | 只把可见 surface 中 `source.kind === 'agent-instructions'` 的 user message 放入 `PROJECT_INSTRUCTIONS`，标为 `constraint` | 同上 `isProjectInstruction`、`snapshotAutoReview` |
| 历史 | human、direct-parent、checkpoint 分别分类，其他 user 文本通常为 `fact`；保留历史工具调用的名字、参数 | 同上 `textRole`、`filteredUserEntries` |
| 排除内容 | 不继承主 agent 的 system message、assistant 正文/reasoning、tool results；`kind: 'tool'` 的 user message 也排除 | 同上 surface 遍历；[上游回归](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/experimental/auto-review/tests/auto-review.spec.ts) |
| 待审动作 | native schema 来自 request header，并与日志核对；PTC 使用可信执行元数据里的 binding schema，并核对持久化 dispatch 身份 | 同上 `nativeAction`、`ptcAction` |
| 模型请求 | 使用主 agent 当前 header 的 provider/model，固定 `REVIEW_POLICY`，冻结请求后直接调用 `ctx.llm.stream`；没有 tools schema 赋予 reviewer 主动读文件的能力 | 同上 `classifyRisk` |
| 拒绝/故障 | reviewer deny 在 `never` 下最终拒绝；`ask` 下只有后续 listener 允许时才交人工审批；格式错误、技术故障使调用失败 | 同上 `apply`、`failed` |
| 生命周期 | 卸载关闭准入、将存活 Auto session 迁移到 Full access，再中止并等待在途 review 结束，撤回 listener/contribution | 同上 `apply` |

与 `0.2.0-rc.2` 相比，关键差异是新增 `workingDirectory` 注入并使用 effective cwd，五分区与来源分类规则没有变化。因此不能把 `session.header.cwd` 当作 `0.2.1-rc.2` reviewer 的当前目录。

## 裁决语义（对面板呈现的含义）

| 概念 | 已核实语义 | 面板含义 |
| --- | --- | --- |
| 来源分类 | `human-instruction`、`direct-parent-instruction`、`constraint`、`checkpoint`、`fact` 五种；历史工具调用可建立 `fact`（如会话创建的清理目标），不能授权中风险动作 | 面板可以如实呈现"这次裁决参照了什么来源"，但**不能**把历史消息重分类成授权 |
| 风险裁决 | high-risk effects 必拒；medium-risk 需要当前显式授权且目标/范围精确；low/medium-allow 放行 | 面板呈现的是"裁决结果与依据"，不是"再次评分"；缺依据时留空 |
| 审查范围 | 只覆盖 Auto preset 下、有 agent 的执行；外层 `run_code` transport 不在审查内 | 面板不应把 `run_code` 显示为"被审查过" |
| 可见 surface | reviewer 读的是"可见 surface"上的消息集合，不含主 agent system message / assistant 正文 / tool results | 面板若呈现"审查参照的上下文"，只能引用同一集合，不能越界到 reviewer 看不到的内容 |

## 可用扩展面与局限

专用 Auto Review 面板数据接口目前不存在；这不同于"上游完全没有可扩展接缝"。

- `tools/pre-execute` 是公开 waterfall，可以增加只读观察 listener——但它看不到 reviewer 的结论（listener 自己的决定只有 `allow`/`deny`/`cancel`/`ask` 四种——`ask` 转人工审批），且 listener 顺序不属于公开契约；用它只能如实呈现"某调用进入了审查通道"，不能呈现"reviewer 怎么想"。
- [LLM runtime](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/src/index.ts) 有公开 `llm/stream` waterfall，允许观察/包装/短路 stream。可是 review 请求没有专用 purpose/session/action 标记，且 Auto 自己 deep-freeze 请求；`next()` 也没有替换 options 的参数。用它识别"哪条 stream 是 reviewer 的"依赖 listener 顺序、私有提示词形状、重入与 retry/replay 语义，**不能当作稳定的专用接口**——本插件只读观察、绝不短路或替换。
- 伪装成 `agent-instructions` 会占用上游 baseline/changes 协调来源；伪装 human 或 direct-parent 会错误提高权威，均不应采用。
- 在下游追加第二次独立 review 无法补齐上游第一次 review 的上下文，还会产生双重审查和费用——不是本插件的合法手段。
- 长期正确形态是上游提供正式的 review 事件/contribution API；在那之前面板只呈现"能稳定观察到的那部分"。

## 对面板的边界结论

1. 面板只读呈现"某次调用进入了审查、其结果是什么"；更深层的"为什么"取决于可观察接缝，观察不到时如实显示而非猜测。
2. 不重实现 reviewer、不增加第二个审查入口、不伪造结论。
3. reviewer 的五分区、来源分类、风险裁决是上游的契约，本插件不复制、不简化、不重新打分。

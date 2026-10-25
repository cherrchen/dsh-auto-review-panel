# 上游 Auto Review 调研（`0.2.1-rc.2`）

调研日期：2026-10-20。本文记录已核实的上游源码事实，是面板面只读语义的边界依据；上游原始包为 `@deepseek-ai/dsh-experimental-auto-review`，源码位于上游仓库 `packages/experimental/auto-review`。

## 基线与证据范围

| 对象 | 本次核对基线 |
| --- | --- |
| 上游 | `dsh-v0.2.1-rc.2`，commit `687f282e8625c6b8d11ff58211a90524be2e4317` |
| 已安装运行时 | 调研时本仓库 devDependencies pin `0.2.1-rc.2`，从 `@deepseek-ai/dsh/package.json` 锚定解析的 tools、llm、permission-presets、session、agent 均为 `0.2.1-rc.2` |

上游源码链接均固定到该 commit。

## rc.3 复核（2026-10-25）

对比上游 `dsh-v0.2.1-rc.2` 与 `dsh-v0.2.1-rc.3`（commit `1f81c047fc48fa190a683e469daa699857e9afe8`）：`packages/experimental/auto-review` 仅包版本变化，源码与测试未改，以下审查语义仍适用。插件依赖的 tools、llm、permission-presets、session 与历史存储接缝没有实现变化；客户端侧栏新增菜单/固定项能力，plugin-manager 新增 `pluginNavigation.openList()`，本插件使用的 tab 注册、`sidebar.right.pane.tab` 与 `plugins.bundle.config` 接缝保持兼容，无需新增版本分支。

当前支持版本以 [`SUPPORTED_DSH_RELEASES`](../../src/compat/dsh-version.ts) 为准；验证结果见[路线图兼容性验收记录](../plans/completed/2026-10-20-auto-review-panel.md#兼容性验收记录)。

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

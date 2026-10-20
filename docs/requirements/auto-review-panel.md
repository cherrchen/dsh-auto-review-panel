# 开发需求文档：DSH Auto Review Panel（out-of-tree 插件，不改上游）

> 状态：草稿——仓库初始化进行中（bundle 骨架、兼容性契约、构建/验证链已就位，面板面未开始）。进度与发布状态的唯一真源见[路线图 §进度总账](../plans/active/2026-10-20-auto-review-panel.md#进度总账)。| 日期：2026-10-20
> **硬约束：不得修改上游仓库（deepseek-harness）中任何包**——全部产物是外部插件/bundle，通过 `dsh plugin add` 或 profile patch 组合安装。
> 事实依据：[upstream-auto-review.md](../reference/upstream-auto-review.md)（上游 Auto Review `0.2.1-rc.2` 调研）；排期：[路线图](../plans/active/2026-10-20-auto-review-panel.md)

## 1. 需求陈述

Auto 权限预设下，每一次工具执行都先经过 Auto Review 审查器裁决：低风险放行、中风险按当前显式授权放行或拒绝、高风险一律拒绝。这套裁决对使用者几乎不可见——放行无声无息，拒绝只剩一条结果消息。

本插件把这套裁决**呈现**出来：在侧栏给出一块 Auto Review 面板，让使用者看到审查器正在做什么、刚才裁决了什么、依据是什么，同时：

- 面板是**只读观察面**，绝不裁决、不拦截、不重做任何一次调用；
- 授权策略、风险分级与来源分类完全由官方 Auto Review 负责，本插件不引入第二个审查器、不做提示词文本匹配、不包装 `llm/stream`；
- 读不到的裁决如实显示为"不可见"，绝不本地重算一份去冒充上游的判定。

## 2. 可行性结论（不改上游约束下）

**可行，且不需要任何上游私接缝，但接受一条明确的边界：面板看到的是"宿主能观察到的那部分审查状态"，不是 reviewer 的全部内部。**

可行依据（详见 [upstream-auto-review.md](../reference/upstream-auto-review.md)）：

1. **挂载机制是通用的**：外部 bundle 的 `dsh.bundle.patch` 会被 `dsh plugin add` 追加为组合层；insert 行即可让本插件的服务进入上下文——面板不需要 disable 任何上游行。
2. **观察通道存在**：`tools/pre-execute` 是公开 waterfall（可加只读观察 listener，不调 `next()` 的裁决面）、`llm/stream` 是公开 waterfall（可观察 stream——本插件只读不短路）、Connection 通道可承载面板与宿主半部之间的传输、`sidebar.footer.action` 槽位可挂面板入口。
3. **host/client 分半是成熟形态**：`dsh.client` 声明 + 裸包名锚点行 + `lib/client.js` 闭包工厂，是上游 Web 客户端图认可的唯一制品形态，本插件照搬。

边界（已写进风险与验收）：

- **裁决与原因需要经既有接缝获取**。上游没有"审查事件流"这一公开接口；面板呈现的深度取决于宿主半部能稳定观察到多少——`pre-execute` listener 只能看到调用（不能看到 reviewer 的结论），reviewer 的判定文本只存在于它自己的 LLM 请求/响应里。第一期的诚实范围：呈现"某次调用进入了审查、其结果是什么"，更深层的"为什么"取决于可观察到的接缝（见调研 §可用扩展面与局限）。
- **接缝无 semver 承诺**：槽位名、通道协议、listener 形状都是 pre-stable；兼容性契约（ADR-0001）与升级车道是本插件的前提，不是可选项。

## 3. 范围

### 初始化（当前阶段）

- bundle 骨架：`auto-review-panel-compat` 门禁行、`auto-review-panel` 宿主服务行、`auto-review-panel-client` 裸包名 client 图锚点行。
- 兼容性代码契约：精确版本 allowlist（当前 `0.2.1-rc.2`）、`unsupported` / `mixed` / `incomplete` 三态判定、`warn` 升级车道、`compat:check` 静态门禁。
- 构建/验证链：host/client 分半 tsc + tsdown 打包、vitest、组合冒烟（`smoke:compose`）、打包门禁（`pack:check` + `smoke:packed`）、lefthook 本地钩子、CI / release / upgrade / diag 工作流、双语 README / CHANGELOG 与 docs 文档体系。

### M1（首个里程碑，未开始）

- 宿主半部：`autoReviewPanel` 服务承载审查状态读取通道（`pre-execute` 观察 listener 或等价接缝），Connection 通道向浏览器半部提供读端点。
- 客户端半部：`sidebar.footer.action` 入口 + 面板视图，呈现当前会话里进入审查的调用与结果；无审查活动时给出诚实的空态。
- 验收：Auto preset 会话里发生一次被审查的调用后，面板在无需刷新的情况下呈现该次审查；拒绝与放行分别可辨。

### 非目标（任何阶段都不做）

- 不重实现 reviewer、不增加第二个审查入口、不伪造"上游拒了/放了"的结论。
- 不接管人工审批面（`ask` 模式的后续 listener 链属于上游）。
- 不为拿裁决数据去 fork 上游 auto-review 包（会产生双重审查与双重费用；若上游未来提供 review 事件接口再迁移）。

## 4. 风险

| 风险 | 后果 | 缓解 |
| --- | --- | --- |
| 观察接缝在 pre-stable 上游中改形 | 面板静默变空 | `src/compat/` 集中探测；`unsupported` 判定先于一切（ADR-0001）；升级车道按周探测 |
| `pre-execute` listener 与 reviewer 的顺序不可控 | 面板把"尚未裁决"误显示为"已放行" | 只呈现有结局的事实；"观察到了调用"与"裁决结果"是两个字段，缺一不可显示时如实留空 |
| 会话 resume / 压缩后历史不可回放 | 面板把过期状态当成当前 | 面板只呈现宿主半部此刻持有的状态；无状态时段显示空态而非猜测 |
| 用户把面板当成"第二个审查器"的期望 | 误以为能在面板里干预裁决 | 面板文案明示只读；不提供任何"批准/拒绝"按钮（第一期） |

## 5. 验收标准

- `dsh plugin add` 安装后 `--dump-config` 恰好多出三行（compat / panel / client-anchor），其余逐字节相同（`smoke:compose`）。
- 支持清单外或混装宿主上，插件行不启动且 profile 完好（兼容性契约）。
- `pnpm verify:all` 与 `pnpm compat:check`、`pnpm docs:check` 全绿。

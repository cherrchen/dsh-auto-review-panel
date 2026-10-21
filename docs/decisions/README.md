# 决策记录（Architecture Decision Records）

English: [README.en.md](./README.en.md)

## 这里存放什么

Architecture Decision Records（ADR），用于记录重要架构与工程决策：

- Context（背景）；
- Decision（决策）；
- Alternatives（备选方案）；
- Consequences（影响）。

## 不应该存放什么

- 未形成决策的讨论或提案；
- 日常开发计划（放入 `../plans/`）。

## 当前状态

- [ADR-0001-dsh-compat-contract.md](./ADR-0001-dsh-compat-contract.md) — DSH 兼容性代码契约：精确版本 allowlist、`auto-review-panel-compat` 启动门禁、混装 fail loud、`src/compat/` 适配层、升级车道不自动扩大矩阵（Accepted）。
- [ADR-0002-upstream-coupling-policy.md](./ADR-0002-upstream-coupling-policy.md) — 上游耦合策略：只允许包入口导入、精确 pin 版本、升级 smoke（Accepted）。
- [ADR-0003-review-record-capture.md](./ADR-0003-review-record-capture.md) — 审查记录经 `llm/stream` 只读 tee 捕获、`tools/pre-execute` 只做关联锚：结构指纹识别审查流、全保真观察、fail-closed 降级（Accepted）。
- [ADR-0004-review-record-persistence.md](./ADR-0004-review-record-persistence.md) — 审查记录自持 per-session append-only JSONL 持久化：`DSH_HOME/auto-review-panel/v1/` 下按会话分文件、旁路 fire-and-forget 写入、会话生命周期校验、留存放进插件管理页行配置（Accepted）。

不要提前创建空的 ADR 文件；仅在做出真实决策时新增。

## 推荐命名

```text
ADR-0001-short-title.md
ADR-0002-short-title.md
```

编号递增，标题使用小写中划线。

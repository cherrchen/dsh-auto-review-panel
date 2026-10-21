# 开发计划（Plans）

English: [README.en.md](./README.en.md)

## 这里存放什么

大型开发任务的实施计划，例如：

- feature；
- refactor；
- migration；
- architectural change。

## 目录结构

```text
active/     正在执行或尚未开始的计划
completed/  已完成的计划
```

任务完成后，将计划从 `active/` 迁移到 `completed/`：

```text
active/
→
completed/
```

有长期参考价值的计划不应删除。

## 不应该存放什么

- 小型任务的临时 TODO；
- 已被放弃且无参考价值的草稿（可直接删除）；
- 正式设计文档（放入 `../architecture/` 或使用 `../../.agent/templates/design.md`）。

## 当前状态

active：

- （空）

completed：

- [2026-10-20-auto-review-panel.md](./completed/2026-10-20-auto-review-panel.md) — Auto Review Panel 开发路径与**进度总账**：初始化、M1 审查记录捕获、M2 面板、M3 打磨与首发、M4 持久化，全部完成，随 `v0.1.0` 发版。
- [2026-10-21-m4-review-record-persistence.md](./completed/2026-10-21-m4-review-record-persistence.md) — M4：审查记录按会话持久化（per-session JSONL + 留存设置页 + 分页），已完成，随 `v0.1.0` 发版。

### 编号口径

- **M1 起**为路线图里程碑；初始化不属于里程碑编号。
- 唯一真源：[路线图的进度总账](./completed/2026-10-20-auto-review-panel.md#进度总账)。

## 推荐命名

使用小写中划线命名，例如：

```text
YYYY-MM-DD-<short-title>.md
```

可参考 `.agent/templates/plan.md` 模板。

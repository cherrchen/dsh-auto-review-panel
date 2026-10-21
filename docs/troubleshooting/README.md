# 故障排查（Troubleshooting）

English: [README.en.md](./README.en.md)

## 这里存放什么

已经验证、具有重复价值的问题处理经验，每条记录通常包括：

- Symptoms（症状）；
- Root Cause（根本原因）；
- Diagnostics（诊断方法）；
- Verified Solution（已验证的解决方案）。

## 不应该存放什么

不要把所有一次性报错都记录进来。

只有预期会复发、且排查成本较高的问题才值得记录。

## 当前状态

- [client bundle 不进 web 启动图：bundle patch 只挂子路径行](./client-bundle-not-in-boot-graph.md) — 侧栏槽位注册静默失效的根因与修复。
- [DSH 版本不在支持矩阵上](./unsupported-dsh-release.md) — `unsupported` / `mixed` / `incomplete` 三种判定、插件行不启动的原因，以及人工提升新版本的流程。
- [审查历史没落盘 / 重启后看不到记录](./review-history-missing.md) — 持久化不可用、stale/corrupt/foreign 文件、会话身份复用、留存误设与清理后为空的症状、诊断与已验证解法。

## 推荐命名

使用小写中划线命名，例如：

```text
<symptom-or-topic>.md
```

# 审查历史没落盘 / 重启后看不到记录

## 症状

出现下列任意一组：

- 面板里只有本次启动以来的记录，重启后历史为空；
- 插件管理页本插件条目 → `auto-review-panel` 行的 Configure 页显示"持久化当前不可用"（并附最近一次错误）；
- `stats` 端点回 `available: false`，`location` 给出符号化路径但读不到文件；
- `<DSH_HOME>/auto-review-panel/v1/` 目录根本不存在，或目录在但 `sessions/` 是空的。

## 根本原因

持久化是**旁路**：它只观察捕获结果，绝不影响审查本身（ADR-0004）。这意味着"历史缺席"的所有原因都发生在写路径之外——根目录建不了/写不了、会话身份校验不通过、文件被识别为损坏或外来 schema，最坏结果都是静默降级为内存-only，而不是报错中断审查。

可能的根因按常见度排序：

| 根因 | 特征 |
| --- | --- |
| `$DSH_HOME` 指向不可写位置 | `stats.lastError` 形如 `open: EACCES …`；设置页 Save/Clear 置灰 |
| 会话身份三元组不匹配（sessionId 被删除后复用） | 旧文件被改名 `<key>.jsonl.stale-<stamp>` 留在 `sessions/` 里，新会话从空文件起步 |
| 文件被识别为损坏（首行不是合法 header） | 文件改名 `.corrupt-<stamp>`，历史按空处理 |
| 文件 header 的 `schema` 不是本版本认识的 1 | 文件标记 foreign：读取为空、**永不覆写**，日志 warn 一次 |
| 进程被硬杀 | 最后一段未 `session/flush` 的写窗口丢失——正常退出屏障之外的窗口 |

## 诊断方法

1. 先看设置页的 **存储位置** 与 **最近一次错误**——`stats.location` 是符号化拼写（`~/.dsh/…` 或 `$DSH_HOME/…`），不是机器绝对路径。
2. 到该目录看文件：

   ```bash
   ls -la ~/.dsh/auto-review-panel/v1/
   ls -la ~/.dsh/auto-review-panel/v1/sessions/
   ```

   `.stale-*` / `.corrupt-*` 后缀的文件是被改名保留的旧字节——它们不会被读取，但也不会被删除（`clear` 会一并清掉）。
3. `sessions/<key>.jsonl` 的文件名是 sessionId 编码（`s_` + base64url），不是 sessionId 原文；`settings.json` 在同一目录、不属于历史、不会被清理删除。
4. 多进程共享同一 `$DSH_HOME` 时，注意 `@deepseek-ai/dsh-atomic-write` 缺席的退化：跨进程并发写是最后写者胜（进程内串行仍成立）。

## 已验证的解决方案

### 目录不可写

修正 `$DSH_HOME` 或该目录的权限（`0o700`/`0o600` 由插件维护）；下一次写入会重试——`LazyReviewHistory` 打开失败后读到的是 `available:false` 报告，不是卡死。

### 想看被改名保留的旧文件

`.stale-*` / `.corrupt-*` 是原样的 JSONL 字节，可直接读；改名是保留证据而非丢弃。要恢复可在备份后把文件名改回 `<key>.jsonl`（身份校验仍按 header 判定）。

### 上限误设/清理后为空

设置页的三个留存轴都是 `0=不限`——误设非 0 值会立即触发一次 `maintain()` 压实/淘汰。`clear` 需要 `{confirm:true}` 且不可撤销；清理只删历史文件，`settings.json` 里的留存设置保留。

### foreign schema（未来版本降级回来）

文件标记 foreign 后**永不覆写**；升级回认识该 schema 的版本即可恢复读取。日志里的 warn 只报一次。

## 不属于本条目的问题

- 面板整体缺席/侧栏没有 tab → [client bundle 不进 web 启动图](./client-bundle-not-in-boot-graph.md)；
- 插件完全不启动 → [DSH 版本不在支持矩阵上](./unsupported-dsh-release.md)；
- "当前一条新记录都没有"先查空态语义——Auto Review 未启用、会话非 Auto、或尚无记录（需求 §4.3 空态四种）。

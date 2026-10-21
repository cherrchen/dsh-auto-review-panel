# ADR-0004：审查记录自持 per-session append-only JSONL 持久化

> 状态：已接受（随 M4 实现生效）| 日期：2026-10-21
> 关联：[需求文档](../requirements/auto-review-panel.md)、[架构文档](../architecture/auto-review-panel.md)、[ADR-0003](ADR-0003-review-record-capture.md)、[ADR-0002](ADR-0002-upstream-coupling-policy.md)、[M4 计划](../plans/completed/2026-10-21-m4-review-record-persistence.md)

## 背景

M1–M3 的审查记录只活在 `ReviewRecordBuffer` 的进程内存里：`dsh` 一重启，历史全部消失。M4 要把捕获、关联、宿主佐证**逐字落盘**，重启后按会话恢复——同时守住两条既有底线：面板仍是只读观察面；持久化是旁路，存储失败最多丢历史，绝不影响一次审查的结局（ADR-0003 的故障隔离不变式延伸到磁盘）。

## 决策

1. **自持 per-session append-only JSONL 日志**，落在 `<DSH_HOME>/auto-review-panel/v1/`：`sessions/<key>.jsonl` 每会话一份（key 为 `s_` + base64url(sessionId)，超长退化 `h_` + sha256），`unassigned.jsonl` 收未关联记录的全局集合，`settings.json` 收留存设置。行格式 = 首行 `header`（schema + sessionId + 可选会话身份三元组）+ 后续 `record`/`patch`/`delete` 行；读取按序 fold，坏行跳过、`schema` 不识别的文件标记 foreign 永不覆写、损坏文件改名 `.corrupt-<stamp>` 保留字节。
2. **持久化是 fire-and-forget 旁路**：`ReviewHistory` 接口的 `upsert` 同步返回空，每文件一条 promise 链串行化；`session/flush` 事件作正常持久化屏障（上游会 await 监听者）。写失败吞掉并 warn 一次，读失败降级为空——`stats`/`update-settings`/`clear` 是仅有的诚实报告面（设置页必须看到 `available:false`）。
3. **会话生命周期校验**：header 存 `Session.header` 的 `createdAt/cwd/isSeeded` 三元组；live 会话身份与文件不符时读取返回空、下一次写入前把旧文件改名 `.stale-<stamp>` 再新建。冷会话（无 live Session）信任文件——这是"打开历史会话"的常规路径。
4. **留存放进插件管理页本行配置区**（`plugins.row.config`，key = `<包名>#<行id>`），不进 `ctx.settings`：设置是本插件的自持运行数据（JSONL 同目录的 `settings.json`），不是 profile 配置；该页的 `form` 参数刻意忽略，不引入 `schemastery` 依赖、不改 profile patch。注册经 `slots.inject` 延迟——plugin-manager 客户端缺席时入口不出现、侧栏 tab 不受影响。
5. **读取按会话恢复，不做跨会话浏览**：`list(sessionId)` 合并内存摘要与该会话的持久化视图（会话文件 + 恒可见的 `unassigned`），内存赢所有 id 去重；无 `sessionId` 的 `list` 保持内存专属——持久化会话不扇出到无会话视图。分页用 `capturedAt|id` 键集游标；客户端加载更早页后暂停轮询（防游标边界空洞），`refresh()` 回到最新。

## 备选方案与拒绝理由

| 方案 | 拒绝理由 |
| --- | --- |
| `ctx.storageDomain` 承载审查日志 | domain 层把 `open()` 时 `loadAll` 的快照作为权威内存状态常驻（与后端布局无关）；审计日志默认不限量时与内存双上限（50/200）冲突，且每条审查是可增长的审计产物而非可折叠的 KV projection |
| 写进 Session 日志（`appendPluginRecord`） | 上游限制该方法仅限 `packages/experimental/` 内插件调用，本仓库之外的插件明确不得调用（上游 README 已核实） |
| 整份 JSON 重写存储 | 每次写放大到全量记录，与 append-only 日志语义相悖；崩溃窗口更大 |
| SQLite（better-sqlite3 等） | 引入原生依赖与新的兼容面，换取本插件用不到的查询能力；JSONL 人可读、`grep` 可查、按行恢复成本低 |

## 推论与边界

- **隐私如实**：完整审查请求（项目约束、过滤历史、待审参数）与模型推理以明文落盘于本机 `~/.dsh`（或 `$DSH_HOME`）；不加密、不上传。清理入口在设置页，目录可整删。
- **多进程**：`@deepseek-ai/dsh-atomic-write` 可用时 append/compaction 持 `<file>.lock` 跨进程锁、重写走原子 rename；缺席时退化为进程内串行 + 临时文件 rename——两个 profile 共享同一 `$DSH_HOME` 时可能后写者胜（已记录的弱边界）。两个包经动态 `import()` 加载，是 RUNTIME_OPTIONAL 取证对象。
- **默认不限量**：三条留存轴（每会话条数 / 会话数 / 总 MB）默认全 0=不限；`update-settings` 落 `settings.json` 后立即跑一次 `maintain()`。
- **分页暂停是刻意取舍**：加载更早记录期间暂停自动刷新，直到 `refresh()` 回到最新——游标分页与实时刷新同时存在会在边界打出空洞。
- **硬杀**：最多丢最后一个 `session/flush` 屏障前的写窗口。

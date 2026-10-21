# M4：审查记录按会话持久化（随 `v0.1.0` 首发）

> 状态：已完成（实现、测试与 smoke 随本计划落地；门禁证据见[进度总账](./2026-10-20-auto-review-panel.md#进度总账)） | 日期：2026-10-21
> 前序：M1（捕获）/ M2（面板）/ M3（打磨与首发），进度、编号与发布状态的唯一真源见[进度总账](./2026-10-20-auto-review-panel.md#进度总账)。需求见[开发需求](../../requirements/auto-review-panel.md)，上游依据见[调研](../../reference/upstream-auto-review.md)。
> 已确认的产品口径（2026-10-21 与维护者核对）：
> - **仅按会话恢复**：每个 session 一份日志；打开该会话即可看到它自己的历史。不做跨会话浏览页。
> - **默认不设上限**；在插件管理页本插件条目的设置区可设置上限与快捷清理。
> - **落盘完整记录**（审查请求全文、四分区、reasoning、裁决、关联与宿主佐证）。
> - Auto Review 当前未启用、或会话已不是 Auto 时，**已有历史照常展示**；空态只在确实没有记录时出现。
> - 弃用 storage-domain、改为自持 per-session JSONL：**接受**（理由见 §2，ADR-0004 记录）。
> - 「未关联」组持久化后成为跨重启全局集合：**接受**，延续现有"未关联组恒可见"语义。

## 1. 目标

1. 记录不再只活在进程内存：捕获、关联、宿主佐证都落盘，`dsh` 重启后按 session 恢复。
2. 面板对"已打开过的会话"显示完整历史；不再要求 Auto Review 当前在线或本次进程产生过审查。
3. 历史默认不限量；用户在插件管理页的该行配置页设置留存上限并执行清理。
4. 不改变捕获/裁决语义：持久化是旁路，读写失败最多丢历史，绝不影响一次审查的结局。

非目标：

- 不做跨会话历史浏览/跳转；不展示其它会话的标题或记录列表。
- 不把记录写进 Session 日志（`appendPluginRecord` 仅限上游 experimental 包——上游 README 明确"本仓库之外的插件同样不得调用"，已核实）。
- 不使用 `storage-domain` 承载审查日志（见 §2）。
- 不加密、不上传、不做远程同步。

## 2. 核心决策（新增 ADR-0004）

**自持 per-session append-only JSONL 日志**，而不是 `ctx.storageDomain`：

- storage-domain 的 domain 层把 `open()` 时 `loadAll` 的快照作为权威内存状态持有（上游 `storage-domain/src/domain.ts`："authoritative in-memory state … constructed from a validated `loadAll` snapshot"）——与后端布局（single / per-record）无关，每条记录都常驻内存。审计日志默认不限量时会与内存上限（50/200）冲突。
- 每条审查是一个可增长的审计产物，不是可折叠的 KV projection；按 session 一份 append-only 日志最贴合"日志"语义。
- 会话日志本身没有可供外部插件写入的扩展点；`appendPluginRecord` 被上游限制在 `packages/experimental/`。

**设置项是插件自有的运行数据**，存 `settings.json`，由插件管理页的 `plugins.row.config` 自定义页编辑：

- 行配置 slot 的键是 `<包名>#<行 id>`（上游 `rowConfigKey()` 即 `${bundle}#${rowId}`，已核实），即 `@dsh-electron/dsh-auto-review-panel#auto-review-panel`；owner props 为 `{ view: 'summary' | 'page', form?: ConfigPageForm }`（已核实），`form` 忽略——该页不依赖 `ctx.settings` 的 volatile Config，避免引入 `schemastery` 依赖、也不改 profile patch。
- 设置与日志同目录，但不随"清理历史"删除；页面上可重置为默认值。

## 3. 存储布局与格式

### 3.1 路径

```text
<DSH_HOME>/auto-review-panel/v1/          # 默认 ~/.dsh/auto-review-panel/v1（$DSH_HOME 覆盖）
  sessions/<key>.jsonl                    # 每 session 一份
  unassigned.jsonl                        # 未关联记录的全局日志
  settings.json                           # 留存设置（schema 1）
```

- 根路径经 `@deepseek-ai/dsh-home-paths` 动态 `import()` 解析（`resolveDshHome()` / `dshHomeDisplay()`，均已核实存在）；该包缺席时回退到 `process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')`，显示名回退 `~/.dsh` / `$DSH_HOME`。
- 目录 `0o700`、文件 `0o600`（POSIX；Windows 由用户目录 ACL 兜底）。
- `key` 编码：`s_` + base64url(UTF-8 sessionId)；编码后超过 120 字符时改用 `h_` + sha256 hex。key 只做文件名，sessionId 原值存 header。
- `v1` 目录承载 schema 1；未来格式升级用 `v2` + 迁移，不原地改旧文件。

### 3.2 JSONL 行格式

第一行必须是 header：

```json
{"type":"header","schema":1,"sessionId":"session-1","session":{"createdAt":1750000000000,"cwd":"/work","isSeeded":false}}
```

后续行：

```json
{"type":"record","record":{ /* 完整 ReviewRecord */ }}
{"type":"patch","id":"review-…","patch":{"hostOutcome":{…}}}
{"type":"delete","id":"review-…"}          // 仅 unassigned 使用
```

- `record`：完整记录，捕获时写 unassigned，关联后写 session 文件。
- `patch`：`correlation` / `hostOutcome` 的增量；摘要不因 `hostOutcome` 变化。
- `delete`：关联后从 unassigned 中移除该 id 的标记。
- 读取时按顺序 fold：`record` 建立基础，`patch` 合并，`delete` 移除；末行可能是崩溃留下的半行，解析失败只跳过该行并计数。

### 3.3 摘要缓存与读取

- 每个文件缓存"可服务摘要"而不是完整记录：`{ mtimeMs, size, summaries: Map<id, ReviewRecordSummary>, sorted: ReviewRecordSummary[] | dirty, liveCount, deadCount }`。
- `summaries(sessionId)` 返回该 session 文件 + unassigned 文件的摘要并集（按 `capturedAt` 降序、id 次序），合并结果缓存到任一源变化为止。
- 摘要 fold 用 `summarizeRecord(record)`（来自 `src/records.ts`），`record` 行解析完立即投影、不保留完整对象。
- `get(sessionId, id)` 需要完整记录：按行流式读取目标文件，只保留匹配 id 的 record 与 patch，深冻结后返回；不保留整份文件。
- 读路径先 `await` 该文件的写队列（read-your-writes），再用 `stat` 判断缓存是否失效。
- 缓存按文件，不设全局上限；unlimited 的代价是摘要常驻（约数百字节/条），完整记录不常驻。

### 3.4 写入、压实与留存

写入全部经每文件一条 promise 链串行化：

- 捕获（未关联）→ append 到 `unassigned.jsonl`，更新 unassigned 缓存。
- 关联 → append 完整 record 到 session 文件，同时 append `delete` 到 unassigned，更新两侧缓存。
- 同一记录后续 `hostOutcome` → 只 append `patch` 到 session 文件（用 `#sessionWritten` 集合判断是否已写过完整 record）。
- 记录移动（unassigned → session）的崩溃窗口允许短暂重复；读取时按 id 去重，session 副本优先。

压实（compaction）：

- **per-session 上限**（`maxRecordsPerSession`，0=不限）：写完一条后若 `liveCount > limit`，对该文件做一次 compaction：流式 fold 完整记录，保留最新 N 条，原子重写 header + record 行。
- **unassigned 死行**：`delete` 累计超过 200 或超过 live 数时，在 `session/flush` 或下次写时 compaction，只保留 live 记录。
- **maxSessions**：按文件 mtime 从旧到新删除 session 文件，直到数量 ≤ 上限；unassigned 不计入。
- **maxTotalMegabytes**：按 mtime 从旧到新删除 session 文件，直到总量（含 unassigned）≤ 上限；单文件自身超限时保留并回报 warning，不递归切单条。
- 默认三个上限都是 0：不扫描、不压实、不删除。
- `update-settings` 写入后调用 `maintain()`：等待写队列、对每个 session 文件执行 per-session compaction、执行 session/总量淘汰；返回维护计数。

### 3.5 会话身份校验

- header 存 `session.createdAt/cwd/isSeeded`（来自 `Session.header`，已核实 `Session.header` 公开且字段一致；读不到就不写）。
- 读写时若宿主有 live `Session`，逐字段比较文件身份与 live 身份；不一致视为**过期会话生命周期**：读取返回空（不展示错误归属的证据），下一次写入前把旧文件改名为 `<key>.jsonl.stale-<stamp>`，再新建。
- 无 live Session（冷会话）时信任文件；这是"打开历史会话"的常规路径。
- sessionId 可能被外部删除后复用；上述校验即上游 projection-cache 同款防线。

### 3.6 失败语义

- 根目录不可创建/不可写：`available=false`，面板只显示内存记录；`stats` 回报原因，设置页禁用保存/清理。
- 单次 append 失败：吞掉并记一次 warn，内存/面板不受影响；后续写继续尝试。
- 文件损坏：改名为 `.corrupt-<stamp>` 保留字节，按空文件处理。
- header schema 不识别（未来版本）：标记为 foreign，读取为空、**不覆盖写入**，记 warn。
- 半行/坏行：跳过该行，保留其余记录。
- 硬杀进程：最多丢最后一个 flush 窗口；`session/flush` 监听器会等待该会话的写队列（上游 `session/flush` 会 await 所有 listener，已核实）。

### 3.7 多进程

- 可用 `@deepseek-ai/dsh-atomic-write` 的 `withFileLock` 时，append/compaction 在 `<file>.lock` 下执行；不可用时退化为进程内串行 + 临时文件 rename。
- 原子写统一用 `writeFileAtomic(file, content, { mode: 0o600, dirMode: 0o700 })`（导出已核实）；不可用时用 `writeFile(temp) + rename`。
- 两个 profile 共享 `DSH_HOME` 时，session 文件按 sessionId 隔离；`settings.json` 后写者胜。

## 4. 宿主实现

### 4.1 新增模块

| 文件 | 内容 |
| --- | --- |
| `src/history/contract.ts` | `ReviewHistory` 接口、`ReviewSessionIdentity`、`ReviewHistoryRetention`、`ReviewHistoryStats`、`ReviewHistoryMaintenance`、`ReviewHistoryClearResult`、默认值 `DEFAULT_RETENTION`。 |
| `src/history/format.ts` | `HISTORY_SCHEMA`、行编解码、`encodeSessionKey`、`parseCursor`/`formatCursor`、header/record/patch/delete 校验、fold 辅助。 |
| `src/history/paths.ts` | `resolveHistoryRoot()`（动态 import `dsh-home-paths` + 回退）、`createFileOps()`（动态 import `dsh-atomic-write` + 回退）、符号化 location。 |
| `src/history/store.ts` | `ReviewHistoryStore`：open、append/patch/delete、compact、maintain、stats、settings、clear、flush、close。 |
| `src/history/lazy.ts` | `LazyReviewHistory`：包一层 open promise，构造期不 await；所有方法 fail-soft。 |

`ReviewHistory` 接口（供 host 与测试使用）：

```ts
interface ReviewHistory {
  upsert(record: ReviewRecord, identity?: ReviewSessionIdentity): void
  summaries(sessionId: string, identity?: ReviewSessionIdentity): Promise<readonly ReviewRecordSummary[]>
  get(sessionId: string | undefined, id: string, identity?: ReviewSessionIdentity): Promise<ReviewRecord | undefined>
  stats(): Promise<ReviewHistoryStats>
  updateSettings(retention: ReviewHistoryRetention): Promise<{ stats: ReviewHistoryStats; maintenance: ReviewHistoryMaintenance }>
  clear(): Promise<ReviewHistoryClearResult>
  flush(sessionId?: string): Promise<void>
  close(): Promise<void>
}
```

### 4.2 `src/host.ts`

- `ReviewCaptureHostOptions` 新增 `history?: ReviewHistory`。
- `stream()` 的完成回调：`buffer.add(record)` 后 `#persist(record)`。
- `#associate()`：`buffer.correlate()` 得到新记录；若有 pending outcome，先 `attachHostOutcome`；持久化最终记录。
- `#patchOutcome()`：`attachHostOutcome` 返回新记录时持久化 patch。
- `#persist(record)`：按 `record.correlation?.sessionId` 取 live identity，`history?.upsert(record, identity)`，整段 try/catch。
- `handle()` 改为 `async`：
  - `list`：合并内存摘要 + `history.summaries(sessionId, identity)`，按 `capturedAt`/id 降序，过滤 cursor，取 `limit+1`，返回 `page {hasMore, before}`；`sessionId` 缺席时只返回内存（保持现状，不加载全部持久化会话）。
  - `get`：内存优先；否则 `history.get(sessionId, id, identity)`；`sessionId` 可选（客户端总会传）。
  - `stats` / `update-settings` / `clear`：委托 history；不可用时返回 `panel/persistence-unavailable`（stats 返回 `available:false`）。
- 新增 `clearHistory()`：`buffer.clear()` + 清空 `#recordByCall`/`#approvals`/`#pendingOutcomes`/`#ambiguousRecords`/`#inFlight` + `history.clear()`。
- 新增 `flushPersistence(sessionId)` / `closePersistence()`。
- 新增 `#sessionIdentity(sessionId)`：从 `sessions.get` 的 `Session.header` 读 `createdAt/cwd/isSeeded`，整段 try/catch。
- 默认 `createId` 改为 `review-${randomUUID()}`（来自 `node:crypto`），保证跨进程唯一；测试 fixture 仍注入确定性 id。
- `diagnostics` 可选加 `persistenceAvailable` / `persistenceLastError`（宿主侧，不进 UI）。

分页常量：`DEFAULT_LIST_LIMIT = 200`、`MAX_LIST_LIMIT = 500`；`readListRequest` 校验 `before` 为 `capturedAt|id` 形式、`limit` 为正整数或省略。

### 4.3 `src/records.ts`

- 导出 `deepFreeze`（供 history 的 `get` 使用）。
- `ReviewRecordBuffer.clear()`：清空 `#records`。
- `summarizeRecord` 保持导出，供 history 投影。

### 4.4 `src/panel.ts`

- 构造 `LazyReviewHistory` 并传给 `ReviewCaptureHost`；根路径/文件操作在 `Lazy` 内按需解析。
- `ctx.on('session/flush', async session => this.host.flushPersistence(String(session.id)))`。
- `ctx.effect(() => () => { void this.host.closePersistence() })`。
- 不再新增 Config schema；`static inject` 保持 `autoReviewPanelCompat` + `permissionPresets` + `sessions`。
- `llm`/`tools` 仍不进 inject。

### 4.5 `src/channel.ts`

- handler 已是 async；确认 `await host.handle(...)`，端点新增后无需改挂载逻辑。

### 4.6 `src/contract.ts`

新增/修改：

```ts
interface PanelListRequest { readonly sessionId?: string; readonly before?: string; readonly limit?: number }
interface PanelListValue { readonly records: readonly ReviewRecordSummary[]; readonly status: PanelStatus; readonly page: { readonly hasMore: boolean; readonly before?: string } }
interface PanelGetRequest { readonly id: string; readonly sessionId?: string }

interface ReviewHistoryRetention {
  readonly maxRecordsPerSession: number   // 0 = unlimited
  readonly maxSessions: number            // 0 = unlimited
  readonly maxTotalMegabytes: number      // 0 = unlimited
}
const DEFAULT_RETENTION: ReviewHistoryRetention

interface PanelStatsValue {
  readonly available: boolean
  readonly location?: string
  readonly settings: ReviewHistoryRetention
  readonly sessions: number
  readonly bytes: number
  readonly lastError?: string
}
interface PanelUpdateSettingsRequest { readonly retention: ReviewHistoryRetention }
interface PanelMaintenance { readonly compactedSessions: number; readonly removedSessions: number; readonly removedRecords: number }
interface PanelUpdateSettingsValue { readonly stats: PanelStatsValue; readonly maintenance: PanelMaintenance }
interface PanelClearRequest { readonly confirm: true }
interface PanelClearValue { readonly removedSessions: number; readonly removedBytes: number; readonly stats: PanelStatsValue }
```

**端点**：`list` / `get` / `stats` / `update-settings` / `clear`。`clear` 必须 `{confirm:true}`，否则 `panel/bad-request`。`update-settings` 的三个数必须为非负有限整数，否则 `panel/bad-request`。

### 4.7 兼容与依赖

- `src/compat/dsh-version.ts`：
  - `OPTIONAL_CORE_PACKAGES` 增加 `@deepseek-ai/dsh-home-paths`、`@deepseek-ai/dsh-atomic-write`。
  - `RUNTIME_OPTIONAL_PACKAGES` 增加同样两项（它们通过动态 `import()` 加载，private copy 会真正执行，必须纳入版本取证），并更新该数组"目前为空"的注释。
  - `CORE_PACKAGES` 自动包含；`HOST_SERVICE_PACKAGES` 不变。
- `package.json`：
  - `peerDependencies` 增加两项，版本与 allowlist 一致 `0.2.1-rc.2`；`peerDependenciesMeta` 标 optional。
  - `devDependencies` 增加两项 `0.2.1-rc.2`。
  - `dsh.client.inject` 增加 `@deepseek-ai/dsh-client-ui-plugin-manager`；`devDependencies` 增加同包 `0.2.1-rc.2`（客户端模块图与类型）。
  - 不引入 `schemastery`、不引入 `storage-domain`。
- `tsdown.config.ts`：无需改；peerDependencies 已被 `productionPackages` 外部化，动态 import 保留。
- `scripts/check-pack.mjs`：无需改（只跟踪相对 import；新代码都打进既有 `lib/panel.js` / `lib/client.js`）。

## 5. 客户端实现

### 5.1 `src/client/panel-client.ts`

- `PanelApi` 拆成 `PanelListApi`（`list`/`get`）与 `PanelSettingsApi`（`stats`/`updateSettings`/`clear`）；`PanelApi` 同时实现。
- `list(sessionId, options?: {before?: string; limit?: number}, signal?)`。
- `get(id, sessionId?, signal?)` → payload `{id, sessionId}`。
- `stats()` / `updateSettings(retention)` / `clear()`：边界校验 `PanelStatsValue`/`PanelUpdateSettingsValue`/`PanelClearValue`，失败归一为 `PanelError`。
- `isListValue` 增加 `page.hasMore` 布尔校验。

### 5.2 `src/client/source.ts`

- `PanelSnapshot` 的 ready 变体增加 `live: boolean`。
- 内部保留 `first: PanelListValue | undefined`、`older: ReviewRecordSummary[]`、`olderPage`、`live`。
- 自动轮询只在 `older` 为空时执行；`loadOlder()` 追加下一页后把 `live=false`（暂停自动刷新，避免分页边界在新增记录时出现空洞）。
- `refresh()` 清空 `older`、重置 `lastValue`、恢复轮询并立即拉第一页（回到最新）。
- `loadOlder()` 用 `first.page.before` 调 `list`；失败保留当前快照，不清空已加载页。
- 合并时按 id 去重，第一页优先；快照 `page` 使用 `olderPage ?? first.page`。
- 第一页 `records.length === 0` 且此前有记录时清空 `older`（清理历史的即时反映）。

### 5.3 `src/client/model.ts`

- `emptyStateOf` 顺序改为：`failed` → `loading` → **`records.length > 0` 直接返回 `undefined`** → `!reviewerAvailable` → 非 Auto → `no-records`。
- 历史记录因此优先于 reviewer 不可用/非 Auto 空态。
- 工具筛选选项改为 `status.tools ∪ 已加载记录的 action.name ∪ 当前选中值`；实时注册表仍是 live 会话的首选来源，历史选项只为可筛选服务，不做任何推断/重算。

### 5.4 `src/client/AutoReviewPanel.tsx`

- `PanelInjected` 增加 `loadOlder(): void`；`index.ts` 的 inject 工厂提供。
- 列表底部新增 footer：`snapshot.value.page.hasMore` 时渲染 `list.loadOlder` 按钮；`!snapshot.live` 时渲染 `list.paused` 提示（说明加载历史期间暂停自动刷新，点刷新回到最新）。
- `getRecord` 闭包传入 sessionId；组件签名不变。
- 刷新按钮继续调用 `refresh()`（回到最新）。

### 5.5 新增 `src/client/settings.tsx`

- 注册到 `plugins.row.config`，key 固定 `@dsh-electron/dsh-auto-review-panel#auto-review-panel`，`locale: NS`。
- owner props 实测为 `{ view: 'summary' | 'page', form?: ConfigPageForm }`；`t` 由注册项 `locale: NS` 绑定（`PropsLocale`），`api?: PanelApi` 经 inject face 传入；忽略 `form`。`summary` 返回 `t('settings.summary')`（该视图同时是条目描述的缺席回退）。
- `page` 内容：
  - 说明段 + 存储位置（来自 `stats.location`）。
  - 三个数字字段：每会话记录上限、保留会话数上限、总大小上限（MB）；`0 = 不限`；前端校验非负整数。
  - Save / Reset all：`api.updateSettings(retention)`；成功后用返回的 `stats` 刷新显示，并提示 maintenance 结果。
  - 使用量：`stats.sessions` / 格式化 `stats.bytes`；`available=false` 时显示不可用与 `lastError`。
  - "清理全部历史"危险按钮 → `Modal` 确认 → `api.clear()`；成功后刷新 stats，提示移除的会话数/字节数；提示清理也会清空当前内存记录、之后的审查继续记录。
  - 无 `api` 时显示通道不可用、禁用写操作。
- 页面自行管理 draft / dirty / saving / notice 状态；不依赖 `ctx.settings`。

### 5.6 `src/client/index.ts`

- 增加 `import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'`（slot 类型增强，仅类型）。
- 增加 `ROW_CONFIG_KEY` 常量与 `ctx.slots.inject('plugins.row.config', ...)` 注册，把 `api` 传入 `RetentionSettings`。
- 侧栏 tab 的两阶段注册不变。
- `dsh.client.inject` 增列 plugin-manager 是软依赖的证据（已核实）：浏览器侧 `arriveGraphRow` 对 `row.inject` 中不在图里的包**静默跳过**（`graphRows.get(packageName)` 为 `undefined` 即 continue），配合 `slots.inject` 的延迟注册——plugin-manager 缺席时设置页不出现、侧栏 tab 不受影响。

### 5.7 文案与样式

- `src/client/locales.ts`：新增 `list.loadOlder`、`list.paused`、`settings.*`（intro、三个字段 label/help、unlimitedHint、save/saving/saved/resetAll/invalid、usage/usageLine/location/locationUnknown/unavailable/channelMissing/error/lastError、clear/clearTitle/clearBody/clearCancel/clearConfirm/clearing/cleared/close、maintenance 摘要）。zh 为键真源，en 同步。
- `src/client/styles.ts`：新增 `.arp-list-footer`、`.arp-paused`、`.arp-settings*`（容器、字段、输入、帮助、动作、用量、提示、危险按钮）；输入高度/圆角/边框对齐现有筛选控件，深色主题 `color-scheme: dark`。

## 6. 测试与验证

### 6.1 新增/更新单测

- `tests/review-history.spec.ts`（新，临时目录真实 fs）：
  - header/record/patch/delete 的 append + fold；半行跳过；损坏文件改名。
  - session key 编码（普通/长 id）。
  - identity 一致/不一致/冷会话；过期文件读取为空、写入前改名。
  - `summaries` 合并 session + unassigned、去重、排序；`get` 返回完整记录并冻结。
  - compaction：per-session 上限保留最新 N；unassigned delete 后压实。
  - `maxSessions` / `maxTotalMegabytes` 淘汰；单文件超限回报 warning。
  - `settings.json` 默认值、读写、损坏回退；`clear` 只删历史不删设置。
  - 两个 store 实例共享同一目录：A 写、B 读；B 的 stat 失效后重新加载。
- `tests/review-channel.spec.ts`：
  - `handle` 全部改为 `await`；list 的 `page`、cursor、limit；get 带 sessionId。
  - stats/update-settings/clear 的成功与 bad-request；无 history 时 unavailable。
  - headless 不挂通道不变。
- `tests/review-capture.spec.ts` / `tests/support/review-fixtures.ts`：
  - `makeHost` 支持注入 fake `history`；断言 capture→correlate→hostOutcome 的 upsert 序列与 payload。
  - 默认 id 唯一性（可选：两个 host 默认 id 不相等）。
- `tests/review-records.spec.ts`：`buffer.clear()`。
- `tests/source.spec.ts`：
  - 第一页轮询；`loadOlder` 追加、去重、暂停轮询；`refresh` 清空旧页并恢复；loadOlder 失败保留快照。
- `tests/client-panel.spec.tsx`：
  - 空态新优先级：有记录 + `reviewerAvailable:false` / 非 Auto → 渲染记录；零记录仍四态。
  - 工具筛选含历史 action.name。
  - "Load older"按钮调用 `loadOlder`；暂停提示；刷新恢复。
  - 设置页：slot key 正确、summary/page 两视图、字段初值、Save 调 `updateSettings`、重复位、清理确认后调 `clear`、不可用/通道缺失。
  - zh/en 键集一致。
- `tests/client-bundle.spec.ts`：`dsh.client.inject` 含 plugin manager；闭包工厂形态不变。
- `tests/compat.spec.ts`：新 optional/runtime 包的版本取证与混装判定。
- `tests/patch.spec.ts`：仍恰好三行，key 常量与行 id 一致性（可选）。

### 6.2 集成/冒烟

- 新增 host 级集成测试：同一临时根目录构造 store/host A，捕获 + 关联 + tool/result + flush；构造 store/host B（模拟重启），断言 list 显示完整记录、get 返回 correlation/hostOutcome。
- `pnpm smoke:live` 增加：
  - 一次审查后 `<scratch DSH_HOME>/auto-review-panel/v1/sessions/*.jsonl` 存在且包含该记录 id。
  - `stats` 端点 `available:true`、`sessions >= 1`。
  - 既有 49 项不变。
- `pnpm smoke:compose` / `smoke:packed`：确认新 optional peer 不影响组合；packed tarball 仍完整。
- 手动真实组合：
  1. 安装构建产物到 web profile，跑 allow/deny 各一次。
  2. 检查日志文件与权限。
  3. 重启 dsh，打开同一会话：历史仍在，关联/佐证可见。
  4. 关闭 Auto Review 再开会话：历史仍展示。
  5. Plugins → 本 bundle → `auto-review-panel` 行 → Configure：设置上限、保存（旧文件被压实/淘汰）、清理全部（面板变空）。
  6. headless profile：无通道、捕获与持久化正常、不炸。

### 6.3 门禁

按顺序全绿：

```sh
pnpm compat:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm smoke
pnpm pack:check
pnpm smoke:packed
pnpm docs:check
```

## 7. 文档与发版同步（M4 随 `v0.1.0`）

- 新增 `docs/decisions/ADR-0004-review-record-persistence.md`：决策、备选（storage-domain / session log plugin record / 整份 JSON 重写 / SQLite）、后果；`docs/decisions/README.md` + `.en.md` 索引。
- 新增 `docs/guide`（或扩写现有 README）用户指南：日志位置、默认不限量、设置与清理入口、隐私（完整请求/推理明文落盘）、无跨会话浏览、未关联记录全局可见。
- 新增 `docs/troubleshooting/review-history-missing.md`：持久化不可用的症状/诊断、损坏文件、身份复用、上限误设、清理后为空；`docs/troubleshooting/README.md` + `.en.md` 索引。
- 更新 `docs/requirements/auto-review-panel.md`：
  - §4 新增"审查记录持久化"小节（路径、完整记录、默认不限量、设置/清理、分页、空态优先级、失败语义）。
  - §5 删除"记录不落盘"非目标（原文"另立项用 storage-domain"随之修订——本计划 §2 已论证弃用理由），改为"不做跨会话浏览/不加密"。
  - §6 增加验收项。
- 更新 `docs/architecture/auto-review-panel.md`：新增持久化数据流、JSONL 格式、摘要/完整记录读取、压实与留存、分页与暂停语义、设置页注册；更新 §4 端点表与 §5 空态顺序。
- 本文件即 M4 计划；完成后迁移到 `docs/plans/completed/`；`docs/plans/README.md` + `.en.md` 索引同步。
- 更新进度总账 `docs/plans/completed/2026-10-20-auto-review-panel.md`：
  - 总账 M4 行状态推进到完成（立项行已先于实施落账）。
  - 新增 M4 小节：决策、实现、验证证据、如实边界。
- 更新 `README.md` / `README.en.md`：
  - 功能介绍加"按会话历史，重启可读；设置页可限流/清理"。
  - 已知限制删除"只活在内存"；新增明文隐私、无跨会话浏览、未关联记录全局可见。
- 更新 `CHANGELOG.md` / `CHANGELOG.en.md`：`Unreleased` 下增加 M4 Added 条目（按会话持久化、分页、留存设置、清理、历史优先空态、完整记录）。
- 更新 `AGENTS.md`：当前状态句、构建/冒烟证据、以及两条不变式：
  - 历史是旁路审计日志，存储失败绝不改变裁决/捕获。
  - 设置页是软接缝：plugin manager 客户端缺席时侧栏 tab 仍工作。
- 更新 `docs/README.md` / `.en.md` 核心文档表（ADR-0004、新故障排查；M4 计划行已先于实施落位）。
- `package.json` 版本保持 `0.1.0`；不 bump、不打 tag（发版是人工动作）。

## 8. 风险与如实边界

- **隐私**：完整审查请求（含项目约束、过滤历史、待审参数）与模型推理以明文落盘。文档必须明确；不加密、不上传；用户可通过设置页或删除目录清理。
- **默认不限量**：日志随使用增长；设置页提供 usage 与上限；无上限时首次打开大历史会慢（摘要需 fold 一次），之后走缓存。
- **分页暂停**：加载更早记录后暂停自动刷新，避免游标边界空洞；刷新回到最新。这是刻意取舍。
- **多进程**：锁与原子写在 `dsh-atomic-write` 可用时成立；不可用时退化为进程内串行，跨进程并发写可能后写者胜。
- **sessionId 复用**：读取时按 header 身份校验隐藏过期数据；写入前把旧文件改名保留，不误归因。
- **未关联记录**：全局 `unassigned.jsonl`，在任何会话视图的"未关联"组可见；这是现有语义的延续（持久化后成为跨重启全局集合，已与维护者确认），也是 `deny+never` 证据不丢失的代价。
- **硬杀**：最后未 flush 的写窗口可能丢失；`session/flush` 是正常持久化屏障。
- **客户端耦合**：`dsh.client.inject` 增加 plugin manager 包；它是标准 web profile 的一部分。设置页是软注册，缺席时侧栏 tab 不受影响（机制证据见 §5.6；`smoke:compose`/`smoke:packed` 复核）。
- **不做**：跨会话浏览、导出、加密、按时间自动过期、按记录类型分级留存。

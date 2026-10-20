# 插件开发工作流：构建、测试与冒烟

> 状态：初始化进行中；进度、编号与发布状态的唯一真源见[路线图 §进度总账](../plans/active/2026-10-20-auto-review-panel.md#进度总账)。本文记录本仓库当前**真实存在**的命令、运行时约束与验证机制；未实现的流程不要写在这里。
> 相关：[需求](../requirements/auto-review-panel.md)、[ADR-0002 上游耦合策略](../decisions/ADR-0002-upstream-coupling-policy.md)、[ADR-0001 DSH 兼容性代码契约](../decisions/ADR-0001-dsh-compat-contract.md)

## 1. 目标运行时与版本策略

| 项 | 值 | 说明 |
| --- | --- | --- |
| 开发目标版本（基线） | `0.2.1-rc.2` | 精确 pin 在 `devDependencies`；CI 主车道对全部支持版本与启用的 OS 做笛卡尔积验证 |
| 支持矩阵 | [`SUPPORTED_DSH_RELEASES`](../../src/compat/dsh-version.ts) | **精确版本 allowlist**；`peerDependencies` 逐项或，不承诺未来版本 |
| 运行时门禁 | `auto-review-panel-compat` 行 | 版本不在 allowlist 或核心包混装时，inject 门禁的面板行根本不启动（ADR-0001） |
| cordis | 基线 `4.0.5`；候选版本按 `dsh` 声明的范围精确 pin | `upgrade-dsh.mjs` 同步重指，并从精确 release-age 条目派生 workspace-only 的 DSH probe overrides，避免预发布范围导致混装、重复副本导致 Symbol 不一致。已有自定义 overrides 时拒绝覆盖；探测后恢复 |

**必须精确 pin**：`@deepseek-ai/dsh-*` 的 `latest` dist-tag 指向陈旧版本，真正的新版发布在 `next`；范围依赖会解析到错误版本。`pnpm-workspace.yaml` 里的 `minimumReleaseAgeExclude` 对开发版本的直接与传递 DSH 包逐项列出精确版本，供 frozen install 与运行脚本前的依赖自检使用；不使用跨版本通配豁免。它是为此配套的（pnpm 的发布年龄门禁会拦下刚发布的预发布版本）。

## 2. 工具链

| 用途 | 工具 | 配置 |
| --- | --- | --- |
| 包管理 | pnpm `11.25.0` | `package.json#packageManager` |
| 类型检查与声明产出 | TypeScript `6.x` | `tsconfig.host.json`（strict、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、`verbatimModuleSyntax`、`rewriteRelativeImportExtensions`）与 `tsconfig.client.json`（同一严格集，emitDeclarationOnly 到 `lib/types/`） |
| 打包 | tsdown（rolldown） | `tsdown.config.ts`：host 逐入口 ESM 到 `lib/`，client 单独闭包工厂到 `lib/client.js`；`@deepseek-ai/*` 与 cordis 保持 external |
| Lint | oxlint | `.oxlintrc.json`（与上游仓库同一选择） |
| 测试 | vitest | `vitest.config.ts`（`tests/**/*.spec.ts`，`pool: forks`） |
| Git 钩子 | lefthook | `lefthook.yml` + `scripts/install-lefthook.mjs`（`pnpm hooks:install` 手动安装到 worktree 本地） |

源码里的相对导入写 `.ts` 后缀（`./compat.ts`）：tsc 以 `rewriteRelativeImportExtensions` 重写为 `.js`，tsdown 在打包时直接解析。

## 3. 命令

```sh
pnpm install            # 安装（首次或改依赖后）
pnpm hooks:install      # 首次 clone 后装一次 git 钩子（可选但推荐）
pnpm compat:check       # DSH 兼容性契约：allowlist / peerDependencies / 开发 pin / 已安装树四者一致
pnpm lint               # oxlint（host 与 client 半部都扫）
pnpm typecheck          # tsc -p tsconfig.host.json 与 -p tsconfig.client.json 各一次
pnpm build              # tsc 出两面 lib/types/**/*.d.ts + tsdown 出 lib/*.js（host ESM）与 lib/client.js（浏览器闭包工厂）
pnpm test               # vitest run：兼容性判定、patch 不变量、client 制品形态
pnpm smoke:compose      # 组合门禁（需要先 build）：真实 dsh plugin add + --dump-config 逐字节对照
pnpm smoke              # = smoke:compose
pnpm pack:check         # 打包产物门禁：tarball 必备成员、exports 目标、patch 引用模块与传递 chunk
pnpm smoke:packed       # tarball 经 dsh plugin add 装进隔离 $DSH_HOME，从安装副本跑组合冒烟（需要先 build）
pnpm verify:all         # lint → typecheck → build → test → smoke → pack:check → smoke:packed
pnpm docs:check         # 文档结构检查
```

两个冒烟都要求 `lib/` 已构建（冒烟脚本会检查并提示 `pnpm build`）。

`pnpm verify:all` **故意不含** `compat:check`：升级车道需要在一个还不在 allowlist 上的候选版本上跑完整矩阵，而静态门禁按设计会拒绝那棵树。CI 主车道单独跑 `compat:check`，位置在 lint 之前（见 §5）。

**`pnpm test` 必须在 `pnpm build` 之后**：`tests/client-bundle.spec.ts` 断言的是**构建产物** `lib/client.js`（浏览器闭包工厂形态、模块表依赖清单）；`lib/` 不进 Git，干净检出上没有可断言的字节。

## 4. 测试与冒烟的分工

| 层 | 覆盖 |
| --- | --- |
| `tests/*.spec.ts` | 兼容性判定（supported/unsupported/mixed/incomplete × enforce/warn）、allowlist↔peerDependencies 一致性、patch 行不变量（id、顺序、裸包名锚点、exports 可解析）、client 制品字节形态 |
| `smoke:compose` | 真实安装链：`dsh plugin add` + `--dump-config`，断言组合只多三行且其余逐字节相同 |
| `smoke:packed` | 同一组合冒烟针对 `pnpm pack` 的 tarball——证明发布产物与检出等价 |

## 5. CI 与升级车道

`ci.yml` 对 `SUPPORTED_DSH_RELEASES` × 启用 OS 做矩阵：每个版本经 `upgrade-dsh.mjs` 精确重指后再跑完整门禁。Windows 腿由仓库变量 `DSH_WINDOWS_CI` 控制，默认停放（面板当前无平台特定执行语义）。

`upgrade.yml` 是每周一次的探测：在最新候选版本上以 `DSH_AUTO_REVIEW_PANEL_COMPAT=warn` 跑完整矩阵。绿灯只证明"该候选可以被支持"，**不**自动写入 allowlist（ADR-0001）；提升是人工编辑 + 评审提交。

## 6. 常见失败与处置

| 症状 | 原因 | 处置 |
| --- | --- | --- |
| `smoke:compose` 报行差异多于预期 | 上游 base patch 行变了，或本插件 patch 行名/id 漂移 | 对照 `@deepseek-ai/dsh-base` 的 `cordis.patch.yml` 更新本仓库 `cordis.patch.yml`，并同步 `tests/patch.spec.ts` |
| `smoke:*` 提示 `lib/ is missing` | 未构建 | 先跑 `pnpm build` |
| 面板入口在 Web GUI 里看不到 | 组合里没有声明 `sidebar.footer.action` 的侧栏，或 client 锚点行缺失 | 见[故障排查：client bundle 不进启动图](../troubleshooting/client-bundle-not-in-boot-graph.md) |
| 插件装上但行为完全等同未安装，日志里有 `is not a supported release` / `mixes several DSH releases` | 宿主的 DSH 版本不在 allowlist 上，或多个 `@deepseek-ai/dsh-*` 混装 | 见[故障排查：DSH 版本不在支持矩阵上](../troubleshooting/unsupported-dsh-release.md)；`mixed` 永远按宿主问题处理，不要用 `DSH_AUTO_REVIEW_PANEL_COMPAT=warn` 绕过 |
| `pnpm compat:check` 失败 | allowlist / `peerDependencies` / 开发 pin / 已安装树四者不一致 | 按报错逐条对齐；改 allowlist 必须同时改 `peerDependencies`（ADR-0001） |
| `pnpm <script>` 报 `EPERM ... /Library/pnpm/.tools` | 仓库 pin 的 pnpm 版本需要写用户级 pnpm 目录 | 在可写该目录的终端（或提权）执行；仅跑门禁时可用 `sh node_modules/.bin/<tool>` 绕过 pnpm |
| `pnpm <script>` 报 `ERR_PNPM_UNEXPECTED_STORE` 或 `ABORTED_REMOVE_MODULES_DIR_NO_TTY` | checkout 里存在陈旧的 `.pnpm-store/`（被 gitignore），而 `node_modules` 链接自磁盘级 store | 最快解除：`CI=true pnpm <script>`。根治：删掉陈旧的仓库内 `.pnpm-store/`；或 `pnpm config set store-dir <node_modules 实际链接的 store>`；或直接 `node scripts/<smoke>.mjs`（CI 不受影响，它本来就有 `CI=true`） |
| `ERR_PNPM_IGNORED_BUILDS` | 有构建脚本的依赖未在 `pnpm-workspace.yaml` 声明 | 把该依赖加入 `allowBuilds`（需要构建）或 `allowBuilds: false`（明确不需要）；当前 `lefthook` 为 `true`、`esbuild` 为 `false` |
| lefthook 钩子没生效 | 还没跑过 `pnpm hooks:install`，或 `core.hooksPath` 被外部覆盖 | `pnpm hooks:install` 重新安装；安装器把钩子放进 worktree 本地目录并做归属标记，不会覆盖你已有的 hooks 配置 |

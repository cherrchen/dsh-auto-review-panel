# Agent Note：DSH 兼容性契约

English: [dsh-compat-contract.en.md](./dsh-compat-contract.en.md)

本仓库把"本插件支持哪些上游版本"做成了代码契约。后续 Agent 在本仓库工作时，这份笔记记下最容易踩的几个坑。

## 唯一真源

`src/compat/dsh-version.ts` 的 `SUPPORTED_DSH_RELEASES`。它、每个 `@deepseek-ai/dsh*` 的 `peerDependencies`（`a || b` 精确或）、`devDependencies` 的开发 pin、以及 `node_modules` 实际安装的树，**四处必须一致**；`pnpm compat:check`（`scripts/check-dsh-compat.mjs`）在漂移时失败，CI 把它放在 lint 之前。

## 门禁对测试的影响

`auto-review-panel-compat` 行在 `cordis.patch.yml` 中排第一；`auto-review-panel` 行 `inject: ['autoReviewPanelCompat']`。cordis 不启动 injected service 缺失的行——所以判定失败时面板行不存在，组合退化为"未安装本插件"。在测试里 mount 被门禁的行之前，必须先 `await mountCompat(ctx)`（`tests/support/compat.ts`），否则会得到 `ctx.get('…')` 为 `undefined` 的误导性报错——那是门禁在工作，不是 bug。

## 适配层规则

- 版本差异只放 `src/compat/`；业务代码不做版本判断。
- 探测**结构**不比版本字符串：哪个导出存在、返回值是否 thenable、方法名是什么。
- 可选包分两类：`RUNTIME_OPTIONAL_PACKAGES`（本插件运行时真正 `import()` 的，插件根内副本也作证）与 `HOST_SERVICE_PACKAGES`（只作宿主服务/类型消费的，只有落在插件根外的副本才作证）。把宿主服务包误判成作证源，会让 `link:` 安装把宿主版本判成 `mixed`（本仓库自己的 devDependencies 被误读成宿主的版本）。
- 可选 peer 只能动态 `import()`，不能静态值导入；"包没装"与"包装了但求值失败"是两个诊断，不可合一。

## 升级车道

`upgrade.yml` 按周在候选版本上跑完整矩阵，环境变量 `DSH_AUTO_REVIEW_PANEL_COMPAT=warn`：

- **唯一合法调用者是升级车道**。生产部署、用户文档、让红灯变绿的捷径——都不是。
- warn 只放宽 `unsupported`；`mixed` / `incomplete` 依旧 fail-closed。
- 绿灯是"该候选可以被支持"的证据，不是授权。提升 = 人工改 `SUPPORTED_DSH_RELEASES` + `peerDependencies` + 评审提交。

本地复现：`node scripts/upgrade-dsh.mjs <版本>`（改 pin）→ `pnpm install --no-frozen-lockfile --config.minimumReleaseAge=0` → `DSH_AUTO_REVIEW_PANEL_COMPAT=warn pnpm verify:all` → `git checkout -- package.json pnpm-workspace.yaml pnpm-lock.yaml` 恢复。**注意**：恢复命令把那三个文件整体回滚到 HEAD——在跑升级探测之前先 commit 或 stash 未提交的 manifest 改动。

## 容易踩的安静坑

- **`pnpm verify:all` 不含 `compat:check`**：故意的，升级车道要在未列入的版本上跑完整矩阵。CI 把它单独放在 lint 之前；本机验证契约完整性时单独跑 `pnpm compat:check`。
- **`pnpm test` 依赖 `pnpm build`**：`tests/client-bundle.spec.ts` 断言的是 `lib/client.js` 制品字节；lib/ 不进 git，干净检出必须先 build。
- **cordis 版本跟着 dsh 走**：`upgrade-dsh.mjs` 会把 cordis 开发 pin 同步重指到候选 `dsh` 声明的范围下限——树里留两份 cordis 会让模块局部 Symbol 对不上，工具调度静默失效。
- **client 锚点行必须挂裸包名**：`auto-review-panel-client` 的 `name` 是 `@dsh-electron/dsh-auto-review-panel`（不是子路径），上游 client 图只从裸包名行读 `dsh.client`。机制见[故障排查](../../docs/troubleshooting/client-bundle-not-in-boot-graph.md)。

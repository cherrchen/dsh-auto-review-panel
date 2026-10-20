# client bundle 不进 web 启动图：bundle patch 只挂子路径行

## 症状

- 侧边栏 footer 的面板入口（`sidebar.footer.action` 槽位注册）完全不显示，但宿主半部工作正常。
- 运行中的 web 服务返回的 `window.__DSH_BOOT__` 模块图里没有 `@dsh-electron/dsh-auto-review-panel` 条目；直接请求 `/plugins/??@dsh-electron/dsh-auto-review-panel/client.js` 返回 404。
- 全程无显眼报错：增量扫描失败只进 `logger.warn`，页面控制台也没有与插件相关的错误。

## 根本原因

宿主把 client bundle 收进启动图的唯一途径是扫描 loader 行（`ClientModuleRegistry`，上游 `packages/client/modules`）：它取每个 loader 行的 `name`（模块 specifier）去解析包清单，再读取 `dsh.client` 声明。解析入口对**子路径 specifier 直接短路返回 undefined**——上游源码注释原话是 "subpath entries land here — permanently not a client row"。只有挂在**裸包名**上的行才会被读取 `dsh.client`。

如果 `cordis.patch.yml` 只插入子路径行（`…/compat`、`…/panel`）而没有一行挂裸包名，`dsh.client` 声明就永远不被扫描，浏览器端 `apply` 从未执行，槽位注册自然不发生。

## 诊断方法

1. 抓启动注入：`curl 'http://127.0.0.1:<port>/?token=<token>'`（token URL 会 303 设置 cookie，需回放 cookie 再请求 `/`），在返回的 HTML 里找 `__DSH_BOOT__` 的 `entries` 列表，确认有无本插件的 id。
2. 直接探测 bundle 路由：`/plugins/??@dsh-electron/dsh-auto-review-panel/client.js`，404 即未收录。
3. 对照 loader 行：`dsh --profile <profile> --dump-config`，检查插件插入的行中是否有 `name` 恰为裸包名的行。

## 已验证的解决方案

1. 给包根 `src/index.ts` 提供最小载体插件面（`inject: []` + 空实现 `apply`，有意不提供任何服务）；
2. `cordis.patch.yml` 保留 `id: auto-review-panel-client`、`name: '@dsh-electron/dsh-auto-review-panel'`（裸包名）这一行，作为 client 扫描锚点；
3. `pnpm build` 后重启 web 运行时，确认 `__DSH_BOOT__` 出现插件条目、`/plugins/??…client.js` 返回 200、面板入口恢复显示。

回归防护：`tests/patch.spec.ts` 钉住锚点行的存在与裸包名形态；`scripts/smoke-compose.mjs` 在真实安装链上断言三行插入。

# ADR-0002: 上游耦合策略（入口导入、精确 pin、升级 smoke）

## Status

Accepted

## Date

2026-10-20

## Context

本插件通过 `cordis.patch.yml` 的 insert 行挂进上游 bundle，这使它成为上游 pre-stable 代码的直接依赖方：patch 依赖上游行语义，运行时依赖上游 service key、客户端槽位名与类型契约。上游明确不承诺 semver 兼容。

从参考仓库（`dsh-plugin-multi-root-workspace`）继承的三条实测事实直接决定设计：

1. **发布包不含源码**：`@deepseek-ai/dsh-*` 的 npm tarball 只有 `lib/`、`lib/types/`、README、LICENSE、`package.json`；`package.json.exports` 里声明的 `"./src/*"` 在安装形态下指向不存在的文件。任何 `pkg/src/*` 深导入在发布形态必然失败。
2. **dist-tag 不可信**：`@deepseek-ai/dsh-*` 的 `latest` 指向陈旧版本，真正的新版在 `next`；范围或 `latest` 会装到错误的版本。
3. **cordis 必须单例**：`Service` 身份与 service 注册依赖模块实例唯一性，双副本会导致注册行为不可预期。插件依赖宿主提供的那份 cordis 与 dsh 包。

## Decision

1. **只允许包入口导入**。禁止引用任何 `pkg/src/*` 路径（无论本机是否能解析成功）；需要上游内部实现时，按"本地实现 + 文件头注明来源 commit 与复制范围 + 差分测试钉住"的方式落地。
2. **运行时依赖声明为 peerDependencies**（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-*`），由宿主提供单一份实例；插件不打包、不自带这些包的副本。cordis 的 peer 范围按 dsh 声明的精确版本对齐，不使用宽范围。
3. **精确 pin 开发/CI 版本**：`devDependencies` 固定一个确切版本（当前 `0.2.1-rc.2`），不使用 `latest` 或宽范围。
4. **建立升级门禁**：组合 dump 差分断言（`smoke:compose`）+ 打包完整性（`pack:check` + `smoke:packed`）+ `compat:check` 静态门禁构成升级 smoke；改动 pin 后必须重跑，任一差异即报警。
5. **面板不复制上游裁决逻辑**。Auto Review 的策略、快照与生命周期语义无公开接口；面板只经支持的接缝观察（见[上游调研](../reference/upstream-auto-review.md)），读不到就不显示，绝不本地重造 reviewer。

## Alternatives Considered

| 方案 | 否决理由 |
| --- | --- |
| 深导入 `pkg/src/*` 复用上游内部实现 | 发布形态不存在该文件；本机可解析属环境偶然（符号链接），CI 与发布形态会失败 |
| 把 dsh 包作为 `dependencies` 自带副本 | 会产生第二份 cordis 与服务定义实例，破坏 service 身份；且插件会与宿主版本漂移 |
| 使用 `^0.2` 之类的范围依赖 + 自动升级 | `latest` 指向陈旧版本，范围解析会得到错误版本；上游无 semver 承诺，自动升级等于把兼容语义交给不确定性 |
| 只用单元测试，不建差分/组合套件 | 组合行语义一旦漂移，只有真实 `dsh plugin add` + `--dump-config` 对照能发现；单测只能证明"符合我们自己的预期" |
| 本地 fork 上游 Auto Review 以获得裁决数据 | 双重审查与双重费用；面板的目标是呈现既有裁决，不是重做一次（见[上游调研](../reference/upstream-auto-review.md)的接缝分析） |

## Consequences

- 正面：插件的失败模式可预期——要么在装配期 fail loud（行未生效），要么在升级 smoke 中被差分测试捕获。
- 代价：精确 pin 意味着每次上游发版都要人工决定是否升级，并跑一遍升级 smoke。
- 代价：对面板数据面的观察依赖"接缝还存在"这一事实；接缝消失时面板必须表现为空，而不是猜。

## Related Documents

- [ADR-0001：DSH 兼容性代码契约](./ADR-0001-dsh-compat-contract.md)
- [上游调研：Auto Review](../reference/upstream-auto-review.md)
- [开发工作流](../development/plugin-development-workflow.md)

# ADR-0001: DSH 兼容性代码契约（精确 allowlist、启动门禁、升级车道）

## Status

Accepted

## Date

2026-10-20

## Context

本插件的两个半部都骑在上游**没有 semver 承诺**的接缝上：宿主侧的 Connection 通道与服务注入语义、客户端侧的槽位名与启动图扫描规则、`cordis.patch.yml` 的行组合语义。上游 `@deepseek-ai/dsh-*` 处于 pre-stable，任何形状都可能在下个 tag 改变。

同时存在三个结构性问题，任何一个都会让"支持哪些版本"变成谎话：

1. **npm 元数据可以承诺代码没验证过的版本**。`peerDependencies` 写范围（如 `^0.2`）是生态惯例，但它向 npm 承诺的兼容面远大于实测面：安装器按声明放行的版本，插件从未跑过一次完整矩阵。
2. **混装在安装期是合法的**。pnpm 允许 `@deepseek-ai/dsh-a` 与 `@deepseek-ai/dsh-b` 落到不同版本（各自满足各自声明的范围），而插件一旦对着两个不同版本的上游语义工作，读到的状态面可能自相矛盾。
3. **"没装齐"与"装错版本"不可分**。可选 peer（`dsh-llm` 等）缺席是合法组合，但用"解析得到版本"来测版本会把缺席误判成"无法判断"，或者把插件自带 devDependencies 里的私有副本误判成宿主版本。

## Decision

1. **精确版本 allowlist**。`src/compat/dsh-version.ts` 的 `SUPPORTED_DSH_RELEASES` 列出本插件真正跑过完整矩阵的每一个上游版本——精确到 pre-release 尾号，不写范围、不写通配。
2. **peerDependencies 与 allowlist 逐字一致**。每个 `@deepseek-ai/dsh*` peer 声明为 `v1 || v2 || …` 形式的精确或，npm 承诺的即代码验证过的。
3. **启动门禁是一个 cordis 行**。`auto-review-panel-compat` 在 patch 中排第一；`classifyInstallation()` 把所有核心包解析到同一个版本上，产出 `supported` / `unsupported` / `mixed` / `incomplete` 四种判定，并在非 supported 时响亮抛错。所有读宿主服务的行 inject `autoReviewPanelCompat`——cordis 不启动 injected service 缺失的行，所以门禁不过时插件行**不存在**，组合退化为"未安装本插件"，绝不是死 profile。
4. **版本差异集中进 `src/compat/`**。业务代码不做版本判断；适配层探测**结构**（哪个导出存在、返回值是否 thenable），不比版本字符串。
5. **可选包按"谁加载副本"分类**。`OPTIONAL_CORE_PACKAGES` 拆为 `RUNTIME_OPTIONAL_PACKAGES`（本插件运行时真正 `import()` 的，插件根内副本也作证）与 `HOST_SERVICE_PACKAGES`（只作为宿主挂载服务/类型被消费的，只有落在插件根之外的副本才作证）——否则 `link:` 安装会把宿主服务包解析到本仓库自己的 devDependencies，把版本统一的宿主误判 `mixed`。
6. **`DSH_AUTO_REVIEW_PANEL_COMPAT=warn` 是升级车道的专用开关**。它只放宽 `unsupported`（连贯但未列入的版本），`mixed` 与 `incomplete` 依旧 fail-closed——前者意味着同一安装里两套上游语义并存，后者意味着判定本身缺证据，两者都不是"放宽一下就能跑"的情形。生产部署永不设置它。
7. **升级车道不自动扩大矩阵**。`upgrade.yml` 按周在候选版本上跑完整矩阵（warn 模式）；绿灯是"该版本可以被支持"的证据，不是授权。提升 = 人工编辑 `SUPPORTED_DSH_RELEASES` + `peerDependencies` + 评审提交。
8. **`scripts/check-dsh-compat.mjs`（`pnpm compat:check`）守住四处一致**：allowlist / `peerDependencies` / 开发 pin / 已安装树。任一漂移即失败；CI 把它放在 lint 之前，因为之后每一步的证据只对契约声称的版本有意义。

## Alternatives Considered

| 方案 | 否决理由 |
| --- | --- |
| `peerDependencies` 用 `^0.2` 范围 + 文档声明支持清单 | npm 放行的版本远多于实测版本；承诺高于验证正是本契约要消除的结构 |
| 只在文档写支持版本，不做运行门禁 | 文档与运行漂移无人发现；混装安装期合法、运行期无声 |
| 对 `unsupported` 也 fail-closed，不设 warn | 升级车道将无法在候选版本上跑完整矩阵，"候选可支持"永远拿不到证据 |
| warn 放宽全部三种非 supported 判定 | `mixed` / `incomplete` 不是版本新旧问题而是安装破损，放宽等于让面板对着自相矛盾的状态工作 |
| 升级车道通过后自动把版本加入 allowlist 并提交 | 会重新制造"承诺高于验证"的结构：绿灯是证据，不是授权 |

## Consequences

- 正面："本插件支持哪些上游版本"是可执行的事实，由四处一致性检查守住，不再是 README 里的一句话。
- 正面：混装从"npm 允许、运行时沉默"变成启动期 fail loud，错误信息列出每个被检查包的实际版本。
- 正面：未验证版本上的失败方式是"插件行不启动、组合退化为未安装"，profile 本身完好。
- 代价：上游每次发版都需要人工决定是否提升并跑升级车道——这是刻意的。
- 代价：allowlist 与 `peerDependencies` 必须同时改；`pnpm compat:check` 会在漏改时报错，但这确实是两处编辑。

## Related Documents

- [ADR-0002：上游耦合策略](./ADR-0002-upstream-coupling-policy.md)
- [Agent Note：DSH 兼容性契约](../../.agent/note/dsh-compat-contract.md)
- [故障排查：不支持的 DSH 版本](../troubleshooting/unsupported-dsh-release.md)
- [开发工作流](../development/plugin-development-workflow.md)

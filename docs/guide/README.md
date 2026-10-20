# 用户指南

English: [README.en.md](./README.en.md)

面向使用者的指南：README 只写"怎么做"，这里补上"为什么"与"具体语义"，遇到非默认情形时查阅。

## 目录

- [支持矩阵为什么是精确版本清单](#支持矩阵为什么是精确版本清单)
- [组合里实际发生了什么](#组合里实际发生了什么)
- [各安装来源的差异](#各安装来源的差异)

## 支持矩阵为什么是精确版本清单

本插件的宿主半部与浏览器半部都要在上游**没有 semver 承诺**的接缝上工作：客户端槽位名、Connection 通道、组合行的挂载语义。所以 `peerDependencies` 只列真正跑过全套验证的版本，启动时也会再查一遍：宿主的版本不在清单上，或者若干个 `@deepseek-ai/dsh-*` 混装了不同版本，那么被门禁的 `auto-review-panel` 行**不启动**，组合退化成"没装这个插件"，并打印一条说明。诊断办法见[故障排查](../troubleshooting/unsupported-dsh-release.md)，理由见 [ADR-0001](../decisions/ADR-0001-dsh-compat-contract.md)。

## 组合里实际发生了什么

`cordis.patch.yml` 只做一件事：在上游 bundle 的行列表里插入本插件的三行——兼容性门禁、面板宿主半部、以及挂在裸包名上的 client 图锚点。它**不禁用**任何上游行：面板是观察面，不替换任何现有能力。三行的职责与"为什么裸包名行不可省"见[故障排查](../troubleshooting/client-bundle-not-in-boot-graph.md)与 `tests/patch.spec.ts`。

## 各安装来源的差异

- **npm / tarball（发布后）**：预构建产物，即装即用。
- **GitHub**：装的是源码，`add` 时由包内 `prepare` 脚本自动构建（直接打包 `src/`，不做类型检查），`allowBuilds` 需含本包；不带 ref 会跟随 `main` 分支的最新提交，写 `#vX.Y.Z` 这样的版本 ref 锁住内容。
- **从源码安装**：pnpm `link:` 链接本地 checkout，依赖在本仓库已装好，无需 `allowBuilds`；需要先 `pnpm build` 生成 `lib/`（未纳入 Git）。

用源码仓库跑 DSH 时 `dsh` 不在 PATH 里，把命令里的 `dsh` 换成 `pnpm dsh`。

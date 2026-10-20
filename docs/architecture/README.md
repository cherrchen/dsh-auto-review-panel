# 架构文档（Architecture）

English: [README.en.md](./README.en.md)

## 这里存放什么

- Current Architecture（当前架构）；
- Target Architecture（目标架构）；
- 子系统设计（subsystem design）；
- 组件边界（component boundaries）；
- 数据流（data flow）；
- 接口（interfaces）。

## 不应该存放什么

- 需求（放入 `../requirements/`）；
- 决策记录（放入 `../decisions/`）；
- 实施计划（放入 `../plans/`）。

## 重要要求

不得将 Proposal 或 Target Architecture 描述成当前已经实现的系统事实。

描述未来设计的文档必须明确标注其状态。

## 当前状态

尚无架构文档。面板面（审查状态的读取通道与槽位贡献）落地前的设计决定记录将首先出现在这里；此前的取舍见 `../decisions/` 中的 ADR。

## 推荐命名

使用小写中划线命名，例如：

```text
<subsystem-or-topic>.md
```

# 图片链路调用成本定位 — B62

主 agent 重跑了固定 64 条 PasteboardPro 原始缩略图逻辑。完整查询得到 457 条 TaskRun，已能解释此前未分类的 328 条记录；本批是诊断证据，不是性能优化完成或整插件可用结论。

| 分类 | 条数 | 状态 |
| --- | ---: | --- |
| `nativeImageTransform` | 129 | 128 成功，1 次第 65 个句柄的容量拒绝 |
| `get` | 195 | 全成功 |
| `call` | 129 | 全成功 |
| `require` | 3 | 全成功 |
| 同一临时插件的非请求任务 | 1 | 终态 |
| 其他插件或发起者 | 0 | — |

456 条请求均进入固定方法桶，未知、缺失方法均为 0；分区与直方图计数闭合。诊断只输出白名单方法、固定状态与计数，不回显未知方法原文、参数、图片载荷、路径或凭证。

源码确认：生产适配器把图片转换 provider 的字节工厂接到 `window.Buffer`，而 Node 环境中的该对象是远端代理。provider 内部的 `Buffer.from()` 检查与调用会走额外的属性读取和函数调用。原始插件最后一次 `Buffer.from()` 仍属于插件自身行为。直方图证明方法分布，但没有分离每种方法的耗时；不能将所有非图片调用或耗时都归因到 provider。

下一项通用优化是让 provider 内部的字节转换使用已经存在的本地 `browserBuffer`，保留插件可见的全局 Node Buffer、图片预算、会话和授权语义。它将同时覆盖 IdeaDock、Device Link 等使用同一适配器的消费者。当前优化仍是私有候选，尚未落入工作区或验收。

## 验收范围

实现由 Luna worker 完成，另一位 Luna 静态复核。主 agent 的 5 项测试覆盖完整样本、真实三组分区、1,000 条上限、数据库查询失败和未知方法脱敏；原生 feature/example 与普通 workspace 编译均通过。查询失败或触顶时，全量终态和精确图片验收门必须失败，不能把样本当作全库。

真实原生运行继续通过 64 张 512×512 PNG 到 480×480 JPEG 的解码、缓存复用、容量拒绝、CSP、隐藏未聚焦窗口和资源清理检查。运行后 1,636 个选定源指纹零漂移；该集合不是完整编译依赖闭包。

本次 debug 加采样的首次 await 391ms，后续 63 次 P50 354ms、P95 425ms、最大 586ms。与 B60 的数值差异不代表优化收益。资源采样仍只包含原生根进程，Node sidecar、WKWebContent/XPC 未计入。发布版时延、完整内存、长期滚动、同机竞品 UI 和多数整插件可用性仍待验证。

- [主 agent 验收记录](../../../output/plugin-input-2026-10-19/batch62-root-method-acceptance-v1.json)：SHA-256 `0b83a32223fa2785d5c133eb0cb65f0ec222a201f7b332964220852904715307`。
- [证据清单](../../../output/plugin-input-2026-10-19/batch62-evidence-v1/manifest.json)：36 个 payload，1,949,491 bytes；清单 SHA-256 `0b914a17ed976182755674d65d79bbc33155940c42c0dd0da57ec933f44ea1c9`。
- [真实方法分布与清理记录](../../../output/plugin-input-2026-10-19/batch62-evidence-v1/root/native-run-v1/root-journal.json)。

本批未创建 Git 提交或推送，整体目标保持进行中。

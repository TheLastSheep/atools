# 显示器原生兼容与插件激活观察交付（Batch 42）

本批为进展交付，目标仍为 active。有限范围的 macOS display fixture 原生运行通过；plain-text 原版目录的只读 activation observation 完成，但 app 未达到原版编辑器输入前置条件，固定输入动作数仍为 0。本批没有新增 whole-original-plugin 验收，不能据此宣称大多数 ZTools 插件可直接使用，也没有证明 ATools 已达到 ZTools/uTools 的 UI、交互或性能水平。

## 实现范围与基线

B42 延续 B41 工作，新增显示器与全局光标兼容，以及受严格 opt-in 限制的窗口激活观察。root 最终执行前 freeze 选择 1,533 个源，其中 38 个本轮 owned modified，未说明漂移为 0；native display 与 activation 报告绑定该 freeze，执行前后源码与运行产物保持不变。目标状态仍为 active。

显示兼容通过独立 `DisplayRead` 权限、生产 TaskRun 路径及隔离 loopback 会话，为插件提供同步 metadata getters。TaskRun 可以持久化不透明的 intent/session/invocation 票据以关联执行；快照结果只保存操作、数量、状态与 `transportOnly` 标志，不持久化原始坐标、光标位置、显示器标签、token 或 endpoint。native activation observer 仅对本次 fixture 窗口采集有界、脱敏的状态标志；不读取编辑文本、键值、AX 内容或系统输入事件。

本批新增代码最大 453 行（`nativeflow`）；既有 display `sessions` 模块为 446 行，activation observer 和测试分别为 437 行与 143 行。继承的 `PluginPanel.svelte` 仍远超 500 行；本轮有净减少，但本文不估算其减少行数，因此不能称所有代码文件都小于 500 行。

## 按证据层级报告

| 层级 | 已验证内容 | 结论边界 |
| --- | --- | --- |
| 源码与审查 | 显示后端、同步桥接、权限、生命周期与 opt-in activation observer 已接入。独立后端审查指出 3 项 P2：endpoint 在 close/rotate 后竞态返回、successor 链遍历预算、closed-owner tombstone 数量；前端审查指出 2 项 P1 reopen 问题（无 display session 时仍 rotate、轮换后携带旧 session id）和 1 项 P2 Destroyed 清理顺序问题。范围内 source fixes 与定向测试支持这些问题已修复。 | Destroyed 先发起 display close 不证明窗口撤销具有原子性。后端纯旋转边界测试覆盖 512 条边、513 个 owner，最旧 owner 能关闭末端 successor。累计 successor/self-edge 容量为 512，closure self-edge 也占容量，因此不能保证支持 512 次用户旋转；超过容量的请求不改变有效 session，需要重启后再试。审查与源码检查不能单独证明所有运行状态。 |
| 单元、集成和编译 | Core 为 36 组、254 passed / 2 ignored / 0 failed；显示后端定向测试 15 项、backend lifecycle 测试 21 项、activation observer 测试 15 项（新增 8 项）通过，feature checks 通过。前端最终全量 v3 为 182 个文件、1,727 passed / 0 failed；TypeScript 与 Svelte 诊断为 0 error / 0 warning。最终 workspace-check-v2 exit 0，用时 5.42 秒，包含 4 项继承 warning。 | 首次 feature compile 的 2 个错误保留在历史日志，修复后定向测试与 feature checks 通过。前端历史全量 v1 为 17 failed / 1,707 passed，v2 为 2 failed / 1,725 passed；受影响 launcher 文件定向重跑 66/66 通过，之后 v3 全量通过。 |
| 真实 native display | `native-display-v1` 运行真实 NSScreen/NSEvent 的有限共享 adapter fixture：5 个同步 metadata getters 各执行 4 次，共 20/20 有效快照；生产 permission、TaskRun、拒绝、轮换、关闭与清理路径参与。未授权准备和等待授权阶段没有建立 transport。disabled 测试针对已授权 live endpoint：禁用后请求被拒绝，并清理对应 session/transport。旋转后旧 endpoint 被拒绝、旧 owner 关闭 successor、successor 可用。所有 TaskRun 终态，intent/invocation/session 均为 0，transport stopped，临时数据、环境、build 和 app scratch 已清理。47 个 native source identity 在 before/pre-spawn/after 相同并匹配 1,533-source freeze；binary、plist、bundle hash 未变化。 | 这证明固定 fixture 的有限 native 调用与生命周期路径通过，不等于 whole plugin、真实多显示器字段矩阵、编辑器交互或正式业务验收。 |
| Native 时延样本 | 这 20 次 getter 调用的 p50 为 6 ms、p95 为 9 ms、最大值为 26 ms；首调用为 26 ms。 | 这是单次有限 fixture 样本，不是启动、持续交互、内存、吞吐或跨场景性能结论，也不是竞品对照或 SLA；首调用没有低于 25 ms。 |
| Plain-text activation observation | 只读观察器完成 10 个窗口状态向量（before/after 加 8 个 scheduled samples），observer 注册/移除均为 8/8，无通知、无 overflow，清理完成。全部样本中 `applicationPolicy=regular`、finishedLaunching、canBecomeKey/Main、onActiveSpace、isVisible 及 main/runtime bundle identity 都为 true；`configBundleMatchesExpected=false`。appActive、frontmostSelf、nativeFocused、isKeyWindow、isMainWindow、windowOcclusionVisible 均为 false。first responder 精确等于主 WKWebView。 | 观察状态符合“Original plain-text requires a positively visible, foreground native window before editor commands”的前置条件失败。WKWebView 所有权不证明编辑器焦点。不能由此推断屏幕锁定或休眠，也不能把 config bundle mismatch 认定为激活失败原因。 |
| 原版插件与固定输入 | 本次 plain-text 原版目录 native run 有 23 个 TaskRuns，均终态；runtime drained；临时 DB、隔离环境、scratch、editor exchange 和 build 已清理，源与 fixture artifacts 未变。 | `originalEditorAcceptance=false`；没有 external controller、OS 固定输入动作或 TIS 输入源切换；结束时没有重新读取当前输入源，因此不宣称 ABC 仍是当前输入源。B42 新增 whole-original-plugin 验收数为 0；“大多数插件可直接安装或一键转换”仍待确认。 |
| 竞品 UX 与 bundle 预算 | 发布入口 JavaScript 为 364,451 / 573,440 bytes，相对 B41 增加 582 bytes。请求数、元数据量与主线程调度等待都有实现上限。 | 没有同机、同用例的 ZTools/uTools UX、启动、交互延迟或资源使用对照；有界预算和本次时延数据不能证明产品性能优势。 |

显示 native 主线程调度等待预算为 6 秒，普通 loopback transport 预算为 8 秒；等待不能抢占正在执行的 OS 调用。activation observation deadline 为 2 秒，也不是主线程停顿时的硬实时保证。观察器只覆盖命令窗口，不能回溯 observer 注册前的启动事件。

## 完整性与后续状态

本轮意外格式化了 5 个继承文件。每个文件的意外字节先归档，之后只有在重建候选的字节数与 SHA-256 精确匹配 B41 baseline 时才恢复；5/5 已精确恢复。另一次对 `local_plain_subnet_verification_tests.rs` 的误写经复核为 2,931 bytes，hash 与 baseline 完全相同，因此未回写。相关操作与字节证据均已记录；不能称本轮完全没有对继承文件执行写入。

B42 提供了有限显示器 API 原生证据和 activation 状态诊断；原版 plain-text 编辑器输入仍未通过前置条件，JSON 固定编辑验收没有在本批新增执行。后续先解决前台与可见性条件，再在既有两项固定输入及输入源切换/恢复的授权范围内继续验收。函数级 native fixture 不能替代 whole-original-plugin 覆盖，也不能替代同机竞品 UX 与性能测试。

原始报告、失败与通过日志、源 freeze、native summary、activation summary 及恢复审计将汇总至 `output/plugin-input-2026-10-19/batch42-evidence-manifest-v1.json`；本批交付索引为 `output/plugin-input-2026-10-19/batch42-delivery-v1.json`。私有临时目录中的原始报告路径与 SHA-256 快照列于 `/private/tmp/atools-batch42-luna-delivery-draft/manifest-of-report-paths-v1.json`。本交付未创建 Git commit 或 push。

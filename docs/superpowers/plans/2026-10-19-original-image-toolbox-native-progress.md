## 最新状态前缀（2026-10-20；B65 第 12 次固定原生场景通过）

第 12 次固定 Image-Toolbox 场景已通过 root 验收：[原生报告](../../../output/plugin-input-2026-10-19/batch65-root-native-attempt-v12.json)（SHA-256 `0b27083a99d81378c7a197c427bb68eb49e999228859edc7bb86b4f270222e77`），[证据清单](../../../output/plugin-input-2026-10-19/batch65-native-attempt-v12/manifest-v1.json)（SHA-256 `32669d0019f5ef760fba80e932505cb9ac1e32fd4828f47f70fded5e1fdca0ac`，19 payload、1,051,431 bytes）。这是一个固定、method-driven 的原插件图像载入、TextModule 编辑、ExportModule 全画布 PNG 写出与留存流程。输出 PNG 为 528×397、16,097 bytes，native 与 retained 文件一致，内容解码、原图文字可见及 200×200 输入后的编辑断言均通过。viewport/窗口装饰匹配、父子 CSP 违规各 0；任务记录 51 项且终态，窗口隐藏未聚焦、剪贴板 backend 调用 0，清理通过。该轮 1,752 个 selected source 零漂移，仍非完整编译/依赖闭包。

本轮只证明固定方法驱动路径：没有物理输入、真实焦点交互、原生对话框或系统剪贴板验收；不代表整个插件或多数插件可用，也没有整机 CPU/RSS、冷构建或发布性能结论。历史 180 秒冷构建门禁仍失败；此前 59,225 ms / 600 秒开发准备属于开发缓存中的 bounded preparation，不是冷构建通过。

B65 结果与 B76 的源码转换结果分开：B76 第 6 次 App 检查 eligible 且权限已允许，但转换 TaskRun 在 2,503 ms 后以 `SourceBuildProcessFailed` 失败，`issueDetails` 为空、产物 0；具体 runner/child 失败步骤与退出码未知，不能由 App exit 1 推断子进程 exit 1。B101 的最小 runner 诊断方案仍是未落地私有候选。

以下旧正文原字节保留。

---

## 最新状态（2026-10-20；B65 第 11 次物理 App 尝试）

第 11 次运行中，原版 Image-Toolbox 对 200×200 输入完成编辑并导出了完整 PNG；root 查看并解码确认输出为 **528×365**，与导出前测得的完整画布一致。最终仍未通过：launcher 原生窗口几何门禁报告 native 与 JavaScript viewport 相差 32 logical pixels；外层 retention verifier 仍要求不超过 200 的尺寸，拒绝保留 528×365 输出。见[第 11 次报告](../../../output/plugin-input-2026-10-19/batch65-root-native-attempt-v11.json) SHA-256 `32a95bd2aad0a09710026b0eb87d9b09002c727dfff8d8049b978cd0299e2f1c` 和[归档清单](../../../output/plugin-input-2026-10-19/batch65-native-attempt-v11/manifest-v1.json) SHA-256 `14a3175eb8b50fe116898dd841cc5ed976b6d6926a85b9fae85b192a47e9a5e0`（19 个 payload，1,034,626 字节）。B93 修复候选尚未落地，不能算通过。

报告记录窗口隐藏、未聚焦，剪贴板 0，运行清理通过，原包 59 个文件来源仍受检查。主窗口 fixture 的 `decorations=false` 配置差异正在核对；目前不能把它称作 32px 偏差的已证实原因。运行没有物理输入、对话框或剪贴板验收，也没有多数插件可用性结论。

当前对照仍基于 1,750 个 selected sources，不是完整 compiler closure。历史 180 秒冷构建门禁失败；88.09 秒、600 秒预算内的开发准备不代表冷构建通过或提速。CSP、清理和 0 剪贴板事实按本次报告范围理解，不扩大为通用 OS/网络隔离声明。

以下原有正文及第 10 次和更早历史记录保持原字节不变。

---

# 最新进度更新（2026-10-20）

**最新真实原生结果：第 10 次物理 App 尝试仍未通过严格尺寸门禁。** 原版 Image-Toolbox 加载 200×200 输入，画布对象数从 1 增至 2，并调用原导出与 `writeImageFile` 路径；导出的 PNG 完整校验通过，但尺寸为 112×72。页面 JS 在导出前读到的画布也是 112×72，Rust 对落盘 PNG 独立解码后确认与该观测一致；这不是 native 代码直接读取画布像素。原先固定的 200×200 门禁保留为失败，不能记成通过。详见[第 10 次原生报告](../../../output/plugin-input-2026-10-19/batch65-root-native-attempt-v10.json)（SHA-256 `78dcaf684f00a0a7835f89fca5dc7ee7ea06bce784e7bb921b483f5487d86904`）和[证据归档清单](../../../output/plugin-input-2026-10-19/batch65-native-attempt-v10/manifest-v1.json)（SHA-256 `ae3913a99cc10dd8719e290375c9eb728eb71be09a9e26920183a7a32153c49f`）。

该轮实测的子页面视口为 384×150、canvas 为 112×72；父原生窗口隐藏且未聚焦。窗口可见/焦点状态、剪贴板调用 0、TaskRun 终态、CSP 违规 0、根进程及已归属 Node 退出、临时目录清理和原插件 59 文件来源完整性均有报告记录。1744 个选定源码指纹无漂移，但不是完整编译闭包。当前结果没有证明原因来自生产窗口尺寸，未做物理输入、整进程树性能或多数插件验收。

下一项 B89 正在私有实现中：把预期尺寸改为运行时生产配置窗口下、导出前实际测得的 canvas 几何，并要求独立完整 PNG 解码结果与之相符；200×200 输入加载及 TextModule 编辑检查仍保留。该方案尚无冻结候选或验收，不是本轮通过。B86/B87 的构建上下文和限制见[汇总验收](../../../output/plugin-input-2026-10-19/batch86-b87-root-acceptance-v1.json)（SHA-256 `366f5fe4c7bca08dfba84aeb0a9ddb94cdd931138d3af13296ea08917042d8c6`）。

以下原有进度正文保留历史尝试记录；第 9 次及更早结果不能替代本轮第 10 次结果。

# 原版 Image-Toolbox 原生验收进度（B65）

最新第 9 次物理尝试（QA v12）完成了原包进入、200×200 图片加载、文字对象增加 1→2、原 ExportModule PNG 生成/解码和原 writeImageFile 写入；App 实例出现，父/子 CSP 精确一致且本轮违规计数 0。**最终仍未通过**：WebView 解码的导出为 112×72，Rust 完整 PNG 解码后的严格 200×200 尺寸校验拒绝。[第 9 次失败与保留材料](../../../output/plugin-input-2026-10-19/batch65-root-native-attempt-v9.json)

导出尺寸的原包规则与夹具调用正在核对，未降低期望或据此宣称生产插件缺陷。失败结构目前未保留真实落盘 PNG 的尺寸/哈希，临时数据已清理，下一项须补足固定、有界产物保留。51 个 TaskRun 全终态、激活 1 项成功；运行与 host 会话清空，实测窗口隐藏/不聚焦、剪贴板调用 0。根进程及一项确认归属的 Node、原进程组均退出，临时目录删除；1736 个选定源码前后无漂移、freeze相同、原包 59 文件的允许插入及其它文件字节验证通过。非完整编译闭包、物理输入验收或整进程树性能测量。以下保留第 8 次及更早失败。

最新第 8 次物理尝试（QA runner v11）仍未通过：子页面虽然已为三个精确本地租约源补齐 `script-src`，仍观测到租约脚本被 CSP 拦截；原 App 实例未出现，没有 PNG。该轮没有捕获违反事件的原策略，父页策略继承或多策略交集尚需核对，不能将前一项配置修正当作业务修复。[第 8 次运行与保留材料](../../../output/plugin-input-2026-10-19/batch65-root-native-attempt-v8.json)

本轮 1736 个选定源码前后无漂移，freeze SHA 相同；窗口实测隐藏、不聚焦，剪贴板调用 0。14 个 TaskRun 全部终态，激活 1 项成功；runtime/host 清空，精确根进程与一项观察到的自有 Node 及原进程组均退出，临时目录清理完成。单飞观察器实际最大并发 1，997 次采样、13 次重叠跳过，错误和溢出均为 0。它不是 CPU/RSS 结果，也不覆盖全部 WebKit/XPC。v8–v10 QA runner 未执行，物理运行次数没有按文件版本计数。

对应整合检查：CSP JavaScript 10 项、Rust 固定入口 1 项、源码转换启动诊断 8 项通过；原生 feature 编译通过，12 个警告中 2 个是新诊断夹具的未用局部变量，已由 Luna 准备私有清理候选，当前未落地。以下保留第 7 次及更早历史，不能替代当前结果。

原生第 7 次尝试已确认临时验收页面的本地租约脚本被 CSP 拦截，原始 App 实例仍未出现，编辑导出流程仍未通过。[最新失败与诊断证据](../../../output/plugin-input-2026-10-19/batch65-root-native-attempt-v7.json)保留原报告、日志和产物指纹；1728 个选定源码前后无漂移，两个 freeze SHA 相同，根进程及一项观察到的 Node 已退出，临时目录已清理。这些结果不证明 WebKit/XPC 全进程树隔离。

本次仅用作功能诊断：独立审查发现 v7 的进程观察器在慢采样时可能排队，Luna 已提供单飞、有界收尾与固定 freeze pin 的 v8 私有候选，3 项纯 mock 检查通过，尚未原生执行。正在修正临时页面 CSP 中对固定本地租约源的配置；生产安全策略和权限保持原样。

第六轮更新（child checkpoints v3）：[运行记录](../../../output/plugin-input-2026-10-19/batch65-root-native-attempt-v6.json)与[材料清单](../../../output/plugin-input-2026-10-19/batch65-failed-native-v6/manifest.json)已保存。子页面 observer、DOMContentLoaded 和进入事件均到达父页及 token 绑定的 Rust 接收器；现有等待循环观测到 app 实例缺失，未报告实例出现。没有原操作完成报告或 PNG，业务验收仍未通过。现已把等待点缩小到模块执行或 app 初始化，尚不能据此确认具体生产缺陷。

主 agent 检查为：Rust 阶段 7 项、监听与探针 14 项、原包 observer 夹具 3 项通过，定向 TypeScript 无错误，源码绑定覆盖 344 个文档输入，原生 feature 编译通过。测试模块抽离的首次编译失败及一次匹配到 0 项的筛选运行均保留；7 项是修正筛选后的实际结果。运行前后 1719 个选定源码无漂移，59 文件原包完整性、根进程与已归属 Node 身份退出和临时目录清理通过。这些源码不是完整编译闭包，也不是全 WebKit/XPC 进程清单。

源码核对发现待验证线索：默认模块资源使用 `atools-plugin` lease origin，而固定夹具 CSP 的 `script-src` 没有该 origin。尚未观测到对应的 CSP 拒绝，未据此改生产策略或扩大夹具 CSP。以下各轮失败和当时检查边界继续保留。

第五轮更新（v12）：[运行记录](../../../output/plugin-input-2026-10-19/batch65-root-native-attempt-v5.json)与[材料清单](../../../output/plugin-input-2026-10-19/batch65-failed-native-v5/manifest.json)已保存，**原插件业务验收仍未通过**。隔离数据库补齐该固定插件启动所需的五类精确授权后，已观测到数据、路径、对话框会话、资源准备、一个 Node 会话，以及入口属性赋值后的 iframe load；任务查询接收次数从上一轮的 26 次降为 0。没有原操作报告或目标 PNG，不能由 load 或 Node 会话推断子页面脚本、DOMContentLoaded、进入事件或图片流程已完成。

主 agent 独立运行的授权 helper 检查 2 项通过，原生 feature 编译及源码绑定检查通过。运行前后 1710 个选定源码无漂移；原插件 59 文件的精确入口插入规则及其它字节保持一致。根进程、已确认归属的一个 Node 身份及专属进程组均已退出，临时目录清理完成；未覆盖全部 WebKit/XPC 进程。五项授权仅用于固定夹具，未验证权限提示体验，也未扩大生产权限政策。窗口隐藏且不聚焦，无物理输入、剪贴板或原生对话框操作。

现有源码保留 module 入口，并有进入事件排队重放逻辑，尚未确认生产生命周期缺陷。下一项由 Luna 在私有夹具加入固定的子页面启动、DOMContentLoaded、进入事件和 app 实例存在性检查点，主 agent 验收；不扩大 CSP、权限或超时预算。以下为前四轮历史，保留各轮失败和当时的检查边界。

第四轮更新（v10）：[运行记录](../../../output/plugin-input-2026-10-19/batch65-root-native-attempt-v4.json)与[材料清单](../../../output/plugin-input-2026-10-19/batch65-failed-native-v4/manifest.json)已保存，仍未通过原插件业务验收。宿主应用 handler 收到两次 `prepare_plugin_data` 和 26 次 `get_task_run`，后续路径、对话框、显示、剪贴板、资源、preload、Node 准备请求均未出现。它只记录同步路由接收，不表示异步完成，也不覆盖 `plugin:*` 命令。任务全终态是在清理后统计，不能倒推等待时已经结束。下一步核对两个数据准备调用来源、任务等待与权限处理，以及固定验收授权是否完整。

v10 的完整 Tauri 定向测试 5 项、原生 feature 编译、类型检查和源码绑定通过；运行前后 1709 个选定源码无漂移。根进程退出、进程组为空、临时目录清理完成。被拒绝的 v9 私有候选及修正审查一并保留：它存在 19/20 数量断言和字段借用问题，未落地。v10 已修正并加入饱和计数检查；诊断本身不增加原包可用率或性能达标声明。

第三轮更新（v8）：仍未通过。[第三轮记录](../../../output/plugin-input-2026-10-19/batch65-root-native-attempt-v3.json)和[独立保留材料](../../../output/plugin-input-2026-10-19/batch65-failed-native-v3/manifest.json)已归档。以下两轮历史记录继续保留，不用新探针结果覆盖旧失败。

最新主 agent 检查为：探针和监听 9 项、Rust 阶段和观测 5 项通过，定向 TypeScript 语义检查、原生 feature 编译、源码绑定检查通过。1708 个选定源码在第三轮前后无漂移；它们不是完整编译依赖闭包。该轮到达 `panel-svelte-flush-checkpoint`，证明外层 Svelte 刷新检查点已经返回。当时快照中没有插件 iframe/入口，后续没有观测到入口赋值、加载或固定错误；无 Node 会话和输出 PNG，前端 45 秒报告仍未到达宿主。等待点和缺失报告的原因仍未知；超时报告中 `cspPassed:false` 也不能证明发生 CSP 拒绝。

第三轮临时窗口仍隐藏且不聚焦，未用剪贴板、物理输入或对话框。根进程退出、进程组为空、临时目录已清理；未观测到预期 Node，不能宣称完成 Node 身份覆盖。下一步由 Luna 在原生夹具记录固定启动命令的有界接收情况，区分路由接收和异步执行完成，不扩大权限、CSP 或超时预算。主 agent 独立验收。生产前端沿用 B66 检查，本轮不增加插件可用率或性能达标声明。

当前结果：**未验收通过**。已接入专用验收夹具，两个真实原生运行均未收到完成报告，也未生成目标 PNG；不计为 Image-Toolbox 可直接使用的证据。

[第二轮记录](../../../output/plugin-input-2026-10-19/batch65-root-native-attempt-v2.json) 与 [证据清单](../../../output/plugin-input-2026-10-19/batch65-failed-native-v2/manifest.json) 已保存；[首轮失败](../../../output/plugin-input-2026-10-19/batch65-root-native-attempt-v1.json) 独立保留。实现由 Luna worker 完成；独立 Luna worker 复核，主 agent 核对实际源码、执行定向检查及原生运行。

| 检查 | 结果与边界 |
| --- | --- |
| 夹具准备、CLI、构建档位脚本 | 12 项通过 |
| 独立 PNG 验证器 | 2 项通过，包含完整解码、尺寸、大小、哈希及错误输入 |
| 消息监听生命周期 | 2 项通过；忽略其它启动消息，只接收本 iframe、opaque origin 和约定类型的首个报告，完成或取消后清理 |
| 阶段诊断 | 4 项 Rust 检查通过；固定枚举、token 绑定、单调更新、超时后保留工作阶段，拒绝路径等任意诊断文字 |
| 三个原生夹具 TS 文件 | 主 agent 语义检查通过，0 错误 |
| 原生 feature 编译检查 | 通过，保留现有 9 个 Rust 警告 |
| 工作区编译检查 | v5 通过；v7 只更改受原生 smoke feature 控制的代码及测试夹具，未重复默认 feature 检查 |
| 源码绑定 | 最新检查通过，341 个文档输入及原生覆盖、变异检测、递归模块检查 |
| 第一轮原生 | 失败：Rust receiver 超时，未取得前端阶段 |
| 第二轮原生 | 失败：最后阶段为 `plugin-panel-mounted`，无 Node 会话及 PNG 被观测到 |

第二轮的阶段记录证明：文件激活调用已返回、返回动作校验已通过，`mount(PluginPanel)` 调用已经返回。**这不证明 DOM、Svelte 异步启动、预加载或插件页面已经就绪。** 同一轮没有收到前端完成或 45 秒超时报告，原生 receiver 在 100 秒截止。原因仍待确认。

两轮均保持隐藏且不聚焦的临时窗口，没有物理输入、目录/保存对话框或剪贴板操作。第二轮运行前后，1706 个选定源码指纹无漂移；完整原插件 59 个文件中，仅私有副本入口按精确规则插入 CSP 和观测脚本，其余文件逐字节一致。根进程已退出、专属进程组为空、临时目录已移除。未观测到 Node 进程，因此预期的 Node 身份观察证明没有完成；不能据此宣称所有 WebKit/XPC 辅助进程均已退出。

Rust 入口 helper 自身只校验暂存路径、文件类型和标记；主验收程序另在运行前后执行 256 KiB 上限、入口“原文加约定插入”的精确比较、其它文件字节与文件集合比较。这是受控验收输入的完整性检查，不是产品安全边界。既有 Node 工具在隔离数据库中预授权；本轮没有验证权限提示或通用 OS/网络沙箱。

下一项已派给 Luna：仅在夹具中区分挂载调用返回、Svelte flush、iframe 资源赋值/加载以及顶层固定错误类型；复用现有启动边界，不给大型 PluginPanel 文件追加日志、不扩大 CSP/权限、不增加超时预算。另一名 Luna 的只读对比未发现与已通过 PasteboardPro 夹具在隐藏窗口、主 loop、custom protocol 方面有可确定解释该超时的设置差异。

本轮没有更改生产前端，沿用 [B66 返回搜索验收](2026-10-19-launcher-return-stability-acceptance.md) 的 1873 项前端检查、零类型错误/警告及初始 JavaScript 368684/573440 字节结果。B65 未验证发布版速度、整机 CPU/RSS、完整插件业务流程、安装或“大部分插件可直接使用”。未暂存、提交或推送 Git。

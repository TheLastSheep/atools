# 原版主搜索的当前剪贴板读取契约

状态：R61 implementation in progress，Rust 运行时、权限管线与主窗来源检查已通过定向测试；正式构建、浏览器及真实 Native 验收分别记录。开发工作区 `/Users/harris/Desktop/atools`，分支 `codex/atools-ztools-parity`；固定只读 ZTools `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。

原版 Main 的自动带入与 SearchBox 的手动 paste 都调用 `getLastCopiedContent(timeLimit?)`。原先 ATools 将它标记 unavailable；手动 paste 已阻止浏览器默认行为，因此缺失宿主读取会直接损失原版输入功能。当前已接入 Rust 读取并将能力标为 limited，优先补齐此主程序能力；社区插件执行仍后置。

## 数据与时间

- 返回 `null` 或 `{type:'text'|'image'|'file', data, timestamp}`；timestamp 为安全整数毫秒 Unix 时间。上游内部还带 sequence，Main 的公开类型与消费者不依赖该字段。
- data 对应原样文本、PNG data URL，或 `{path,name,isFile,isDirectory}[]`。优先级为文件、图片、文本；无支持格式时为 null，不回退到历史行。
- 缺省、0、负数表示无限制；正数为毫秒年龄上限，包含边界。非有限数、非数值或超出安全数范围的请求拒绝。
- 复制时间表示本进程首次观察该 OS change count 的时间；同一复制事件重复读取不得刷新年龄。当前读取与后台观察共享该时间信息，不保存原始正文的全局缓存。
- 没有有效内容时以180ms作为等待新内容和获取实时快照锁的窗口；必要的本机重查在同一次宿主调用内完成，不让前端循环发 IPC。已经开始的 OS 读取、文件元数据和图片解码须等待实际工作终结，不能以超时为由提前释放工作槽；180ms不是整个 API 的端到端延迟上限。已取得的不可变快照投影不再等待实时剪贴板锁。

## 权限、隐私与生命周期

读取接入 `atools.clipboard.read_current`、ClipboardRead 及既有 TaskRun 执行/审核链。人类 Main 通过真实主 WebView 身份校验；Agent 通过同一能力注册与执行器。当前 Main 请求的原始结果仅用请求局部通道交付，任务结果只保存类型、数量与字节等摘要。拒绝、取消或终态持久化失败后不交付正文。

“暂停捕获”和“敏感内容在写入本地前排除”是历史写入策略。当前显式读取不调用历史保存来换取结果，不写正文、路径或图片到任务历史/长期记忆，仍受 ClipboardRead 的拒绝策略控制。后台复制观察只保留 change count/时间等元信息；当前剪贴板为空或改变时不返回上次正文。

共享有界媒体工作槽在底层实际工作终结前不得释放。每次 getter 一次宿主请求；不启动 Node、浏览器或额外常驻进程。Native 目前只具备 macOS snapshot backend，其它平台保持明确 unsupported，不能用空剪贴板伪装支持。

## 资源边界

当前读取复用已有媒体上限：图片输入与PNG编码各6MiB、data URL 8MiB；单边最多16384像素且总像素最多4000万，解码分配上限160MiB。文本最多10MiB；文件最多1024项、单路径16KiB，整个序列化回执最多12MiB。JSON通过有界计数writer判断，不先分配完整序列化缓冲。超限明确拒绝，不截断或降级成另一类型。不得把上游历史保存的10MiB图片限制误当作该 API 的保证。

完整内容校验集中在 Rust 的类型化 `LastCopiedContent` producer，避免在 WebView 再次扫描大段 UTF-8、base64、PNG 与文件路径。JS保留参数、精确三字段外壳、类型/粗大小、时间戳和调用前后生命周期校验。该保证依赖生产使用默认 Tauri transport、原始返回仅经 Main 请求局部通道交付，且插件桥不转发此getter；未来放开插件读取或所有frame调用凭据时必须重审。全局可注入transport仅是既有测试/宿主注入缝，不能用伪造回复测试替代Rust producer边界测试。

本批正式 Main JS 为593894B，上限593920B，余26B；Settings仍为790459B，已用满原增量预算。完整校验归Rust、前端等价分支与共享普通对象校验回收重复实现，未抬阈值。此处仅为静态产物预算，不代表延迟、RSS或CPU实测。

## 验收

先用可注入的快照/时钟与权限执行端验证优先级、完整空白、重复读取不续期、时间边界、空/过期等待、超限、并发/取消和无原文审计。再以原版 SearchBox 的 paste 事件检查文本光标插入、匹配文本、图片与文件上下文；适配器 dispose 后不发新 RPC，晚到回执不能更新界面。浏览器模拟 RPC 只证明消费者链，不证明真实 OS 读取或 Native IPC。真实 macOS/WKWebView 与跨平台继续单列。

本契约不关闭完整原版 UI、默认入口推广、Native 可见面板或 Harris 原包验收目标。

本批独验见 [R61记录](../../output/renderer-clipboard-context-2026-10-29/verification.md)：Rust运行时30、管线8、来源1及显式私有命名NSPasteboard 2项通过；前端235项、strict TS、构建辅助20项与workspace check通过。最终浏览器run `2935f74a-a6ea-45f0-91a1-f4a2e532ed71` 使用正式dist，18项检查、11张截图及清理通过，PNG由浏览器实际解码为1×1；RPC与焦点仍是合成夹具。命名NSPasteboard测试只写固定夹具、退出清空内容，不读写用户general pasteboard；真实WKWebView/Main IPC/OS剪贴板一体流程及跨平台仍待验收。

R62后续状态：上述R61“端到端待验收”现由 [真实hidden Native记录](../../output/renderer-clipboard-native-2026-10-29/verification.md) 补齐私有命名NSPasteboard切片。最终run `6a8e9e741c7b4ca1a887a2f64862b244`在同一Main/WKWebView完成正式读取、权限/TaskRun、原SearchBox合成paste及拒绝/清空/显式过期回收；不替代general剪贴板、真实Native focus自动带入、物理Cmd+V、可见/IME或跨平台验收。票40保持in-progress。

R63后续补齐autoPaste五值的Core/Child保存确认与原Main即时通知，并修复启动期间早到关闭通知丢失；正式构建、SQLite与原Vue浏览器分层通过。见 [R63记录](../../output/renderer-auto-paste-2026-10-29/verification.md)。本轮没有新Native GUI或应用收据，真实focus及general剪贴板仍不由该结果证明。

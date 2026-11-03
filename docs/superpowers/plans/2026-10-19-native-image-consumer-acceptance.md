# 原始缩略图消费者原生验收 — B60

本批由 Luna worker 实现，主 agent 独立复核、编译并运行隐藏的 Tauri/WKWebView 验收。PasteboardPro 原始 `ja.cachedThumbnail/generate` 在生产 PluginPanel、Node 图片会话和 Rust 编解码链路上通过了固定输入验收。完整原插件、大多数插件直接可用、UI 对齐和发布版性能预算仍未验收。

## 实际结果

| 项目 | 结果与边界 |
| --- | --- |
| 原始输入 | 未改动的 preload 258,790 bytes；精确提取原始 `ja` 类 2,009 bytes；原插件 PNG 241,870 bytes、512×512 |
| 缩略图 | 64 个不同记录使用同一图片，全部生成 JPEG，并由真实 WebView 解码为 480×480 |
| 缓存及容量 | 首条缓存重复调用不再次生成；第 65 个新句柄返回 null，符合当前 64 句柄预算 |
| TaskRun | 图片方法 129 条：128 成功、1 次容量拒绝；全库 457 条均终态。其余 328 条尚无方法分布证据 |
| 权限 | 只预授予该临时插件现有 legacy Node tool；它仍含 10 项宽权限。没有增加单独的 host clipboard/image_write grant，也没有 Node 网络隔离或全局网络审计 |
| 页面约束 | 隐藏且未聚焦；插件 iframe 保持 opaque origin；CSP 配置、响应头、两层 meta 及零 violation 检查通过 |
| 清理 | 图片 source/reserved bytes、handles、unique sources、reservations、sessions 全归零；Node 与 host clipboard 会话归零，transport 停止 |
| 系统影响 | PasteboardBackend 调用 0，未启动剪贴板捕获；本次进程身份和进程组退出，临时应用数据与隔离环境移除 |

原始 preload、PNG 和类片段有字节哈希绑定；不是完整 preload 初始化。实际图片通道是 `nativeImageTransform.openPath` 和 `encode`，没有运行旧 `readPngPath` 通道。图片 TaskRun 的隐私扫描只覆盖筛选后的图片记录，不等于全库隐私审计。

## 性能观测

这是一次 macOS arm64 **debug** 构建、固定 512×512 输入的观测，同时运行目标间隔 200ms 的进程采样。

- 原始 `cachedThumbnail` 的首次 await 为 296ms；随后 63 次 P50 339ms、P95 485ms、最大 798ms，总计 23,036ms。P95 使用 nearest rank；不包含启动、前置 Node bootstrap 或 WebView JPEG 解码，也不能拆分归因到编解码、传输或数据库。
- 127 次进程采样中，组内最多只观测到原生根进程 1 个，峰值 RSS 140.55MiB。Node sidecar、WKWebContent/XPC 未计入；这不是完整应用内存，也不是物理内存占用。
- 当前数值不证明发布版预算通过或失败。尚需最小方法聚合、发布版测量和同机竞品对照。

本批没有增大图片容量或放宽解码、传输预算。第 65 次拒绝暴露了长期滚动的剩余限制；不能把 64 次成功宣传为无限缓存或整插件长期可用。

## 独立检查与证据

主 agent 的图片引擎/宿主检查 39 项通过，其中 36 项为已有覆盖、3 项验证新增资源计数；前端类型检查 0 error、0 warning；原生 feature/example 与普通 workspace 编译检查通过。7 个混用验收选项被拒绝，733 个选定绑定源被纳入最终 1,636 源指纹集，原生运行前后零漂移。该集合不是完整编译依赖闭包。

最初两次原生编译发现验收夹具的模块路径、trait、字段访问及类型推断错误，已修正，失败日志保留。页面控制流的 mock 预检仅用于便宜的边界检查，原生结论来自独立的真实运行。

- [主 agent 验收记录](../../../output/plugin-input-2026-10-19/batch60-root-native-acceptance-v1.json)：SHA-256 `9204b81a4e528dfc49510bc04042cccc655abc7937918eb7fdf4917d2a4df708`。
- [证据清单](../../../output/plugin-input-2026-10-19/batch60-evidence-v1/manifest.json)：76 个 payload，3,655,039 bytes；清单 SHA-256 `5d3a523b6cc0ed10089a318f6f95795f5debd5cdadc16fb855113d31fbf5002d`。
- [原生运行与清理记录](../../../output/plugin-input-2026-10-19/batch60-evidence-v1/root/native-run-v1/root-journal.json)。IIFE、CSS、页面、类片段及图片实际字节在运行前已保留；大型 debug executable 仅保留指纹。
- [14 个归属源文件的精确改动](../../../output/plugin-input-2026-10-19/batch60-evidence-v1/review/owned-changes.diff)：8 修改、6 新增，最大 478 行。

下一批继续完善插件搜索快捷键提示，并定位图片调用的通用成本及长期句柄生命周期。本批未创建 Git 提交或推送，整体目标保持进行中。

# NativeImage 转换能力进展 — B59

本批接通生产 WebView adapter、权限检查、TaskRun、专用 Node 文件读取与 Rust 图片引擎。实现由 Luna worker 完成，主 agent 独立检查；当前是有界能力的源码、组件与宿主单元验收，真实原插件消费者的原生验收仍待完成。

## 本批行为

- `createFromPath` 使用当前文档的 Node session，读取 PNG/JPEG/WebP/TIFF；`resize` 保存最多四步不可变计划，`getSize`、`resize`、`isEmpty` 不发 IPC；编码输出 PNG/JPEG。
- 原有无需 Node 的有界 PNG Buffer/DataURL 路径保留。变换后的剪贴板输出仍须经过原 PNG 校验及独立 `image_write` 授权，文件读取授权不代替剪贴板授权。
- 图片请求走现有鉴权、执行票据和 TaskRun。通用 Node 请求不能直接调用专用文件通道；日志保留方法等摘要，不存图片、私有路径或句柄。
- session 关闭会撤销句柄。取消/超时不会提前释放仍在运行的 CPU worker 许可；取消 open 会退休旧图片 store，迟到结果不能复活关闭的文档。

## 独立检查

| 范围 | 结果及边界 |
| --- | --- |
| 引擎与宿主 | 36 个唯一案例通过（25 引擎、11 宿主），包括 CRC、预留预算、迟到结果、取消与关闭竞争 |
| 专用 transport | 5 parser + 5 真实 Node 案例；后五项在 Node 24.15.0、打包 Node 22.23.3 各执行一次，覆盖完整 4 MiB 边界；不把重复运行累加为新案例 |
| 前端 | 全量 200 文件、1,866 项通过；Svelte 检查 0 错误/0 警告。IdeaDock、Device Link 是原代码片段加 FakeXHR 的组件验收，未证明原生剪贴板业务 |
| 三个 Rust crate | Node 24、单测试线程下 425 项通过、2 项按原设置忽略。嵌套子进程重复案例已去重；不是全 workspace 测试 |
| 编译 | workspace check 与 native smoke feature/example check 通过；现有和新增编译警告保留在日志 |
| 初始 JS | 367,118 / 573,440 bytes；246,614-byte PluginPanel chunk 保持延迟加载。不是启动时延或 RSS 结果 |
| 搜索性能 | 并行检查曾有 73.337125 ms 样本超过 25 ms；原因未确认。隔离串行复测 36 样本均通过，最大 15.226917 ms；串行结果不抹去前次失败 |

三 crate 总数以每个 Cargo 顶层 suite 的最终摘要计数：58 个顶层 suite、425 项通过。较早报告的 426 包含一个嵌套子进程重复项，旧报告保留并由 v2 更正。Transport 案例已包含在相应 crate 套件中，不再与总数重复相加。

## 预算与兼容边界

- 专用 Node stdio 源输入最多 4 MiB；WebView Buffer 输入与编码输出各最多 512 KiB。通用 HTTP JSON 1 MiB、value 900 KiB 限制保持不变。
- 每 session 最多 64 个句柄、32 MiB 唯一压缩源，全局 64 MiB；每 session 两个 open reservation。相同 session 内完整内容去重；每次打开仍独占一个句柄槽，跨 session 不去重。
- 同时只有一个 CPU worker，无排队；1 秒 deadline 不能打断已经进入的同步 codec 调用，许可保留到阻塞闭包实际结束。
- 最大边 8,192、最多 16,000,000 像素。PNG 完整解码前检查 chunk framing/CRC，最多 4,096 个 chunk；这不是完整 PNG 标准符合性声明。
- 64 MiB decoder limit 是尽力约束。Resize 受控像素 buffer 最高估算 192 MiB，另有 codec 内部与分配器开销；这些值不是进程 RSS 上限。
- 默认 scale 1；单轴尺寸按已固定的 f32 数值向量推导。滤波质量映射表达意图，不证明与 Electron/Skia 像素或 DPI 行为等价。参考官方 Electron nativeImage 文档及 main 源码，未绑定具体 Electron release。
- 第 65 个新句柄被拒绝的边界不代表长时间滚动或无限缓存可用。BMP/ICO、Sharp/native addon、完整原插件初始化、保存与系统剪贴板均不能据此宣称兼容。

## 证据与后续

- [主验收记录](/Users/harris/Desktop/atools/output/plugin-input-2026-10-19/batch59-root-implementation-acceptance-v1.json)
- [归档成员与 SHA 清单](/Users/harris/Desktop/atools/output/plugin-input-2026-10-19/batch59-evidence-v1/manifest.json)

归档保存本批 32 个最终源码文件、所选检查日志、历史失败和版本清单。冻结集合为 1,627 个所选源码且零漂移；不是完整编译依赖闭包，也不包含历史每个版本的全部源码或二进制。

原 PasteboardPro class 的真实 Tauri/WKWebView 消费者、实际缩放、缓存及第 65 个容量边界正在另行准备。原生 NativeImage 时延/RSS、同机 ZTools/uTools 对照、绝大多数整插件可用性、UI 对齐与正式验收仍未完成。本批无 Git 提交或推送，整体目标保持进行中。

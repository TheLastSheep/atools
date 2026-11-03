# Electron 剪贴板图片写入进展（B55）

B55 为插件页面增加独立的 `image_write` 剪贴板能力。它使用单独的 capability/grant，仍请求 `ClipboardWrite` 权限，并显示“写入系统剪贴板图片”。请求只接受 `{image:{dataUrl,width,height}}`，限制 PNG 512 KiB、原始请求体 700 KiB、边长 8192、总像素 1600 万；PNG 在单个受控 worker 中完整解码后才调用原生剪贴板写入。只有 provider 确认写入后才返回成功。图片不进入 TaskRun 输入、历史或诊断；权限拒绝不会排队或自动重放；手动 generation rotate 不继承图片写入会话/端点，后续显式操作仍按当前授权重新建立会话。

本地回归通过：前端 194 个测试文件 1840/1840，定向 7 个文件 88 项，Svelte 检查 0 错误/0 警告；Rust 32 项 host-runtime、4 项权限上下文、16 项 loopback 回归通过（raw-body cap 用例包含在 16 项中）。工作区编译检查退出码 0，有 4 条既有警告。原始 calculation-paper 5031 字节 PNG 经真实 Rust parser/decode 后，与独立 RGBA SHA oracle 相符；fake backend 收到精确像素并被调用一次。另有两个未修改原函数的隔离 fixture 共 19 个场景，执行了生产序列化 bridge/Buffer 与 production JavaScript builders，传输使用显式 FakeXHR。

性能记录：初始 JavaScript 为 366087 字节，较 B54 增加 258 字节，低于 573440 字节预算。1200 features matcher 的 20 次样本最大值为 0.812084 ms，预算 25 ms。图片准备计时从预先构造好的 BrowserBuffer 开始，覆盖 `createFromBuffer` 和 `writeImage` 到 FakeXHR 的 null ACK；不含输入 Buffer 构造。探针在 Node v24.15.0、macOS arm64 上每个 fixture 采样 6 次：原始 PNG 首次 1.35 ms，接近 512 KiB 的 PNG 首次 46.32 ms、热样本 42.47–57.69 ms，低于 100 ms 目标。该探针没有可比基线，且不包含 Rust/native provider、整体 UI 延迟或 RSS。

这些结果只接受本地代码回归和隔离的原函数兼容场景。B55 没有运行系统剪贴板、真实 WebView/浏览器、完整原插件入口或正常插件业务流程；Node child `require('electron')` 仍不在本批支持范围。JPEG、路径、缩放及 NativeImage 的完整 Electron codec/options 也未覆盖。原生 provider 一旦开始执行不可撤销；64 MiB decoder allocation limit 是 best effort，不是进程 RSS 保证。因此本批新增真实原插件业务工作流为 0，不代表多数 ZTools 插件已可直接使用，也不代表发布或正式验收。

历史记录保留了一个无效的 68 字节正例 PNG 尝试；最终 v4 fixture 改用原始 5031 字节 PNG。sandbox 中 raw-body cap 测试以 101 退出，1 项失败于本地 TCP bind 的 EPERM，body 断言未执行；root 后续允许 loopback 的运行通过 1 项，该用例也包含在 16 项 loopback 回归中。没有独立保存 sandbox 首次运行的原始日志。

归档包含逐项 SHA/字节清单、root acceptance、before/after 源快照、历史 fixture、预算证据和独立 Rust review：[B55 evidence manifest](../../../output/plugin-input-2026-10-19/batch55-evidence-manifest-v1.json)，[evidence archive](../../../output/plugin-input-2026-10-19/batch55-evidence-v1/)。Root acceptance 原件：[root-acceptance-v1.json](../../../output/plugin-input-2026-10-19/batch55-evidence-v1/evidence/root-acceptance-v1.json)。

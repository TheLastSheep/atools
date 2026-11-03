# 06: BrowserWindow 公共导航动作归一

**What to build:** 保持原桥公共动作名称，将 BrowserWindow.loadURL / reload 接入已有 native 文档导航，将 getURL 接入当前文档状态读取。

**Blocked by:** None. 不依赖已暂缓的原生探针或 GUI 验收。

**Status:** code-contract-complete (实际 renderer 握手及桌面业务仍暂缓)

## 已确认调用链

- `pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts` 的 BrowserWindow facade 发出 `loadURL`、`reload`、`getURL`；webContents facade 使用另一路已带前缀的动作。
- native controller 接管非前缀动作，但其导航集合只识别带前缀形式，因此这三项进入 Rust action，而 native Rust parser 不支持这些动作。
- 当前集合已经包含 `webContents.goBack/goForward`，这两项不是缺陷。

## 验收边界

- 通过真实序列化公共 facade 观察动作，独立验证 controller 对应分派；不能只用手写动作覆盖生产者。
- 保留 owner/document 检查、query/hash、现有 preload 与 native 标记；getURL 读取当前有效窗口状态，不准备新的原生动作。
- 导航夹具若没有 RPC endpoint，明确断言该失败边界，不能宣称 renderer 握手通过。
- 代码每文件不超过 500 行，不改原包、不增加进程或轮询；类型、相关回归、构建预算由主 Agent 独立复核。

已交付导航动作模块、真实桥接 producer 与 controller consumer 回归。主 Agent 最终运行包含本项的 16 文件 / 129 项检查全部通过，类型检查、构建、启动 JS 预算通过；controller 499 行。见 [主验收记录](../../../output/harris-plugin-first-2026-10-23/native-window-self-provenance/verification.md)。

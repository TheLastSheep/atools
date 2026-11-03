# 02: 原版 API 创建真实独立插件窗口

**What to build:** 原版 createBrowserWindow 在 Tauri 中创建实际系统窗口，保留原同步句柄和异步 ready 语义；透明无边框窗口中的原 UI 仍运行在 opaque iframe 内。

**Blocked by:** 01: 窗口请求绑定当前插件文档。

**Status:** in-progress

- [ ] 使用既有权限和 TaskRun 审批同一任务，不另建确认流程。
- [ ] 只有已授权的单次精确目标能创建窗口；任意原始 popup 被拒绝。
- [ ] 插件 HTML、preload 和私有数据不能成为顶层页面或持久任务输入。
- [ ] ready 依赖真实子壳、实际 iframe 和当前文档的 RPC 证明，且不在父面板重复渲染。
- [ ] 不使用 Node 或修改 Harris 原包来实现窗口创建。


## 本批证据

代码与契约验证已通过；完整原版桌面业务仍待任务04验收，因此整体状态继续 in-progress。主 Agent 的81项相关Rust、187项前端、类型/构建与预算记录见 `output/harris-plugin-first-2026-10-23/native-window-production/verification.md`。

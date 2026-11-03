# 09: 原版应用真实图标

**What to build:** 原版应用列表按需显示系统图标，保留懒加载、图像分析及错误占位，生成/缓存有界。

**Blocked by:** R17来源与资源预算（已满足）；与等待解锁的08并行。

**Status:** in-progress

- [x] 共享Native协议仅允许主本地页面及当前catalog成员（实现/定向检查；实际Tauri页面另验）。
- [x] 真实OS离屏图标满足64×64/64KiB，缓存/并发/取消计费有界。
- [x] 原Vue无需改动，图像分析URL精确白名单且原防线保留。
- [ ] 定向/类型/构建/预算通过；真实Tauri图片加载和窗口回归按桌面可用状态验收。

契约：`docs/contracts/ztools-renderer-app-icons-2026-10-27.md`。

证据：`output/renderer-app-icons-2026-10-27/verification.md/json`。15图标/11catalog/107renderer Native、131前端、43Node和完整strict/formal Main build及default workspace通过。JS586470/586528，余58；来源/宿主/probe已fresh绑定。当前系统会话locked，实际Tauri图片与窗口验收仍未完成，故保持in-progress；不能把离屏测试当作原页面通过。

### R22 隐藏原页面实证补充

`output/renderer-catalog-native-2026-10-27/run-61da068fbc8e49a786d5d95da7c25dd4/catalog-native.json` 的 `initial` 和 `added` 阶段记录真实隐藏 Tauri 主页面图片 `complete=true`、64×64，并且通过原 `analyzeImage` 路径；Native report 校验通过。这里补上实际 Tauri/WebView 图片加载与分析证据，不代表图像在可见窗口中绘制成功。Issue 09 保持 `in-progress`：可见页面/焦点与窗口行为、错误占位仍待桌面可用时验收。

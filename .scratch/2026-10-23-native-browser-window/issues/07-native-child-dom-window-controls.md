# 07: Harris 原版贴图页的自身控窗入口

**What to build:** 对 native child 中原包使用的 DOM 自身控窗操作建立宿主适配，优先关闭与缩放触发的窗口尺寸变化；沿已授权的 self source、当前文档和 TaskRun 动作通路执行。

**Blocked by:** None. Task05 的 private self facade/native 来源可复用；原生桌面验收仍按用户指令暂缓。

**Status:** code-contract-complete (真实 Wry / OS 窗口交互仍待验)

## 初始源码调用与已修复的接线

- 外部 Harris Snipaste 2.0.1 `paster.html` 的 `closeSelf()` 最终直接调用 `window.close()`。
- 同页 `applyTransforms(true)` 调用原 `services.resizeCurrentWindowTo()`；`preload/services.cjs` 的该函数直接调用 `window.resizeTo()`。
- 生产插件文档放在 native shell 持有的 opaque iframe；本批前 `src/lib` 和 `public/atools-native-window.html` 没有将这两个 DOM 方法转译到 native self 窗口，现已通过 native-only factory 接到既有 `BrowserWindow.close/setSize` facade。
- 原始完整序列化桥红测确认没有发出 native 动作；修复后的原页模拟 DOM 合同已通过。尚未运行 OS 复现，不能据此宣称真实关闭/缩放效果通过。

## 实施与验收边界

- 保持 Harris 原包字节与公开调用不变，仅 native child 适配，不覆盖 hosted/main 的普通 DOM 行为。
- 不向插件暴露 Tauri API、source token 或 native label；复用 owner/document 校验和已有 native action，不另建 Node、轮询或无界事件队列。
- DOM 方法的返回值、异常观察、过期文档/销毁后行为需要明确；通过实际 compiler 注入和原版服务/页面调用验证 producer、路由与取消回收，不只断言方法存在。
- frameless 拖动依赖的 `-webkit-app-region`、BroadcastChannel 同步和真实 OS 关闭/缩放分别保持未验，不与这两项控窗接口混为通过。

## 本批结果

主 Agent 冻结后独立运行 18 文件 / 144 项前端检查、1 项 Rust self 身份矩阵、工作区编译、类型检查及构建预算均通过。关闭去重、resize 1 inflight + 1 latest、生命周期禁用、descriptor 保留与 coercion 重入已有回归；原版页面 wheel/reset/Esc/close 入口和源哈希检查通过。启动 JS 432,238/573,440 字节，8 个代码文件最多 418 行。初次类型检查 3 项错误已修并保留原日志。

详见 [主验收记录](../../../output/native-child-dom-controls/verification.md)。下一优先为 [Harris 拖动区域适配](./09-harris-native-drag-regions.md)，通用 framed 尺寸差异见 [Task08](./08-framed-window-outer-size-actions.md)。

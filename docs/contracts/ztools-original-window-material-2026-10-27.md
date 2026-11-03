# R33：原版主窗口材质和主题

目标：固定上游 `9b15fb1a2a9f3ec886016632761c7bb21e39557a` 的原版 Main 在 Tauri 中从启动、搜索、进入设置到返回搜索持续具有 macOS FullScreenUI 材质；保留原 Vue/CSS、默认 Svelte 回退和已提交的 General 偏好。

## 固定事实与边界

上游 `src/main/managers/windowManager.ts:354-358` 设置 transparent 和 `fullscreen-ui`；`src/renderer/src/style.css` 以带 alpha 的亮/暗背景叠加，不能用浏览器白底合成代替原生材质。主题原语义来自 `src/main/api/renderer/settings.ts` 的 themeSource 及原 General 页面。

当前锁定 Tauri 2.11.2；macOS `set_effects(None)` 不负责移除原生效果。复用已在锁文件中的 window-vibrancy 0.6.0，以真实 `clear_vibrancy` 清理自身创建的效果。新增直接依赖不得引入第二版本或产品进程。

1. 原版入口依据可信宿主 build config，拒绝以 renderer URL、RPC 参数或任意环境变量启用原生策略。自有 smoke 仅在 Profile 与 RendererAssets 验证后通过私有、编译特性限定的宿主调用安装。
2. 原版 Main 的持有者覆盖完整窗口生命周期；Settings 独立租约不能在关闭时清掉仍由 Main 使用的材质。默认 Svelte 无持有者时不改变呈现，临时打开原设置页后清除临时材质。
3. 所有 AppKit 操作在主线程；异步取消、迟到回调、重复关闭、清理失败及销毁不能使已清理资源复活。失败清理不得报告已成功移除。
4. 材质租约只管理自身效果，不回滚用户已经提交的主题或透明度。system/light/dark 只作用于本应用窗口，不修改系统全局主题。
5. macOS 原生读回确认实际效果数量、材质、混合模式及 active-state 策略；其他平台显式记录不支持，不泛化 macOS 结果。

## 独立验收

- Root 保留 R32 的 12 阶段原生交互与退出门禁；每阶段另读材质及持有者事实。
- 真实原 General 控件切换 light、dark、system，核对已提交偏好、实际窗口 appearance 与 Main/Child 的媒体查询，结束恢复本次全新夹具的初始设置。
- macOS Child 必须实际关闭默认白底；有 Child 的阶段直接读 WK configuration 的 drawsBackground=false，无 Child 时该事实为 null。
- 只尝试自有非持久 WKWebView 的 snapshot，禁止桌面截图、抢前台、CUA 或 AppleScript。只允许原 General 夹具图；不保存真实应用目录卡片或路径。
- PNG 受编码字节、解码像素、尺寸和非空约束；有限像素统计和 DOM 证据不能证明物理桌面合成。隐藏 snapshot 不支持时保留实际失败，视觉项仍待验。
- 截图前分别验证菜单节点消失、主题媒体状态、root/General文本色、侧栏选中主色及未选中文本色，并观察真实连续双 RAF 稳定。读不到帧或任一事实未满足即 unverified，不改原 Vue/CSS 或可见性凑通过。
- 真实清理后读回零持有者与零效果；进程正常终止，自有临时资源回收。默认入口不切换。
- 所有新增模块不超过 500 行；Root 审查关键 diff、定向测试、workspace 检查、来源稳定绑定的全新构建及实际 Native 运行。保留历史失败，不用旧二进制复验新源码。

## 结果

原生层通过，视觉仍待验。最终 run `06353d9ac8ab4353902c115d31ccdab8` 十二阶段、材质、三种主题、九阶段 WK 透明读回及实际退出/回收均通过；PID76798 exit0。严格截图条件下双 RAF、菜单和侧栏综合判据未满足，`visual.passed=false`。结果见 `output/renderer-native-material-2026-10-27/verification.md/json`；不据此宣称完整还原、物理像素、默认 Svelte 临时租约场景或跨平台已验收。

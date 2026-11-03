# 原版设置 ChildWebview 接入边界

日期：2026-10-27。ATools 开发分支 `codex/atools-ztools-parity`；固定上游 `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。本文件记录锁定 Tauri 2.11.2 的调用链调查与固定页面的实机结果；正式设置视图仍未接入。

## 保持原版同窗语义

上游 Vue `App.vue` 的 `.plugin-placeholder` 只是占位；Electron 主进程把独立 `WebContentsView` 加到同一个主窗口。Cmd+, 与设置按钮都调用无参 `openSettings(): void`，成功/失败通过后续生命周期观察，而非同步回执。退出设置回到空搜索框并聚焦，不恢复打开前的 query。

保持原版主 Vue/CSS 时，Tauri 对应承载是主 Window 内的 ChildWebview。它不是另一原生窗口，也不能把现有 Svelte PluginPanel 的 iframe 直接称作原版主页面已有的宿主。当前 `openSettings()` 仍为 unsupported；正式设置 bundle 的成功构建不改变这一事实。

## 主窗类型是必须先处理的依赖

锁定 Tauri 2.11.2 的 `Window::add_child` 需要 `unstable` feature。添加不同 label 的 child 后，`Window::is_webview_window()` 返回 false；`Manager::get_webview_window("main")` 会返回 None，`WebviewWindow` command 参数转换也会拒绝。这会影响既有主窗聚焦、尺寸、显示/隐藏与资源初始化路径。

证据：本机 Cargo registry 的 `tauri-2.11.2/src/window/mod.rs:1126-1162`、`src/lib.rs:575-584`、`src/webview/webview_window.rs:1487-1497`。调查时尚未启用；本批新增默认关闭的 `ztools-multiwebview = ["tauri/unstable"]`，隔离实机入口已创建固定页面 child，未创建正式设置 child。

因此，下一步必须区分主 Window 与主 Webview 的角色，按实际用途迁移相应 helper/command 参数；不能先创建 child 再让旧 `WebviewWindow` 调用静默失败。需要真实双视图主窗口的 show/hide/resize/focus/退出回归，不能用类型编译替代。

当前原版 renderer 的实际链为 `resizeWindow → expand_window → window::expand_main_window`、`resetWindow → reset_main_window`、`hideWindow → hide_main_window`。这三个 command 已只接受 AppHandle，主要问题是 window/resize、window/presentation、activation/state、hotkey 中的主窗查找和 `WebviewWindow` helper。原主渲染 Webview 仍可保留 label `main`；无需仅为获得父 Window 而重建整个启动入口。窗口几何/可见性作用于父 Window，DOM eval、页面探针和渲染焦点作用于实际主 Webview。现有 shared native fixture 须以这两个角色分别取证。

## 已实现的权限前置

生产 `command_registry::handler` 在原生成 dispatcher 外检查 Tauri 实际 Invoke 的 caller Webview label 与其 parent Window label，均非空、长度有界且同名时，才继续各命令原有检查；不同名 child 一律固定结构化拒绝。当前没有任何 child 命令放行项，不接受前端传入 caller label。

Tauri 的 `plugin:` 命令不经过这个 app dispatcher。默认 capability 已从 `windows: [main, settings]` 改为精确 `webviews: [main, settings]`，权限条目原样保留，避免未来 child 继承 main Window 的插件权限。项目当前无其他生产 capability；opt-in fixture 的动态 capability 需在各自将来引入 child 时另行审计。

证据：`tauri-2.11.2/src/webview/mod.rs:1811-1909` 的分派、`src/ipc/mod.rs:498-550` 的实际来源；ATools 的 `src-tauri/src/webview_command_policy.rs`、`command_registry.rs`、`capabilities/default.json`。

这只区分 Tauri 原生 Webview，不隔离同一 Webview 内的任意 iframe。四个纯策略测试后，本批又实际验证同一命令在 main 成功、child 拒绝：`get_setting`、core window visibility 和自有 bundle resource 的 fs exists。独立 fixture handler 不自动获得此生产 wrapper；其探针只接受实际 main/parent/root URL 与内部 token，child 通过固定导航拦截回报，不能据此获得通用命令。

## 固定页面双视图实机结果

主窗 helper 已按父 Window 和主 Webview 分工；历史/固定通知改为实际 main Webview 定向发送。旧 `get_webview_window("main")` 在 child 挂载后实际缺失，同时父 Window 与 main Webview 均存在，两个 native label 均从 Tauri 查询。

实机发现两项前置问题：原版主 Vue 就绪后收缩为搜索栏，须先展开再挂载；Tauri auto-resize 会按比例把 64 logical px 顶部预留缩到 45。共享布局服务现在禁用 child 比例缩放，复用生产窗口事件按实际父尺寸/scale 设置固定顶部和剩余内容区；折叠时隐藏，不伪造最小子视图。仅一个活动注册，RAII 按唯一 ID 清理，lease 不持有 App/Window/Webview；无每次挂载 listener 或常驻后台循环。

两种自动清空偏好的九阶段原生往返、主/子视图焦点、真实 WK 非持久化 store、首次与重开的权限拒绝、文档更新及最终 child/布局注册归零均通过。权限分类按锁定框架的实际诊断格式识别，未知错误不能冒充拒绝。失败报告与最终来源绑定见 `output/renderer-multiwebview-2026-10-27/verification.md`。这仍是固定页面的承载验收，不是设置 UI、物理键盘、跨显示器 DPI 或跨平台验收。

## 正式设置视图的后续验收契约

1. 仅主 renderer 的实际身份能发起打开；只从固定正式 `packages/ztools-settings/dist`/bundle resource 读取成功 provenance。拒绝 review-only 包、任意前端路径与未知 hash。
2. child 身份绑定 main Window、实际 child label、内部包 revision 和每次打开的 document/session。资源、命令、迟到回执与生命周期都使用同一身份；退出撤销，重复进入资源和视图数有界。
3. 窄命令逐项加入已注册、仍存活的 child allowlist；不得直接放开通用 General raw、任意 db key、shell、filesystem、process、clipboard、HTTP 或 Node。前置默认拒绝状态必须保持，直到每个窄接口有实际验收。
4. General 读写仍通过共享 coordinator 和打开时的 CAS；设置页只拿所需投影。原组件会打印读取对象并整对象合并，不能因此把 AI 凭据、账号 token 或未知配置传进子视图。父 Window 范围的敏感通知也必须改为精确目标或脱敏。
5. `onPluginEnter/out`、placeholder/opened/loaded/closed/back-to-search 按原序接通。General 挂载会读取平台、当前快捷键、开机启动并调用透明度设置；未支持控件必须明确禁用或拒绝，不能返回成功空操作。
6. 原版真实 General DOM、一次持久化更新、并发冲突、重开回读、退出回搜索、两种打开入口、焦点及资源回收都通过后，才宣称此纵切完成。全设置标签、其他插件及跨平台仍需完整目标后续验收。

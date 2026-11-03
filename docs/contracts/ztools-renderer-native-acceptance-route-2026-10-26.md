# ATools 原版 Vue Renderer 原生验收入口审计

日期：2026-10-26  
范围：只读核对 Tauri 主程序启动、native smoke fixture 和 renderer 浏览器 fixture。没有构建、启动应用、运行浏览器或测试。

> 以下为 2026-10-26 的历史入口审计；当时缺失的隔离主 Vue 入口已在下一批实现。当前入口及验收边界见文末更新，不能继续用本节的“没有入口”描述当前代码。

## 结论

当前没有一条入口同时满足以下条件：使用真实 ATools 主 WebView 和原版 Vue renderer；数据目录与 WebView profile 都独立；运行身份与用户应用区分；通过受控调用完成 show / hide / re-show；同一轮读取 Vue DOM/focus 与原生窗口状态。

现有 native panel harness 已提供可复用的临时数据、唯一 Tauri identity、窗口状态采样和 Vue 页面内状态采样模式；但它加载的是专为插件验收打包的 `PluginPanel` 页面，不是 ATools 主 Vue 首页，也没有生产主窗口的失焦隐藏处理。直接以主程序启动会读写真实 `~/.atools`，不能按本次隔离要求运行。

## 已存在的主程序入口

- 主窗口配置在 [`src-tauri/tauri.conf.json`](../../src-tauri/tauri.conf.json)：identifier 为 `dev.atools.desktop`；窗口 label 为 `main`、URL 为 `/`、初始 `visible: false`。
- [`src-tauri/src/app_startup.rs`](../../src-tauri/src/app_startup.rs) 的 `run()` 无条件执行 `AppConfig::new()`、`ensure_dirs()` 和 `Database::new()`，再用 `tauri::generate_context!()` 构建应用。[`crates/atools-core/src/config.rs`](../../crates/atools-core/src/config.rs) 将 `AppConfig::new()` 固定解析到 `dirs::home_dir()/.atools`；`Database::new()` 也会再次独立调用 `AppConfig::new()`。当前没有 data-dir 参数或环境变量覆盖入口。
- [`src-tauri/src/app_setup.rs`](../../src-tauri/src/app_setup.rs) 的 `visual_smoke_enabled()` 认 `--atools-visual-smoke` 或 `ATOOLS_VISUAL_SMOKE=1`，可在启动时显示真正的主窗口；它不改变数据目录或 app identity。
- [`src-tauri/src/command_registry.rs`](../../src-tauri/src/command_registry.rs) 注册 `commands::show_main_window`、`hide_main_window`、`toggle_main_window`。底层 [`src-tauri/src/window.rs`](../../src-tauri/src/window.rs) 的 `show_main_window(&AppHandle)` 和 `hide_main_window(&AppHandle)` 可复用，但当前入口是 Tauri IPC command，没有独立 CLI 控制端点。
- [`src-tauri/src/app_startup.rs`](../../src-tauri/src/app_startup.rs) 的主窗口事件处理在关闭时隐藏窗口；`Focused(false)` 时也隐藏，除非 release smoke、visual smoke 或 modal dialog 例外。普通 `--atools-visual-smoke` 会禁用这条失焦自动隐藏分支。
- [`src-tauri/src/desktop_smoke.rs`](../../src-tauri/src/desktop_smoke.rs) 的 `ATOOLS_DESKTOP_SMOKE=1` 会启动完整 desktop smoke reporter，其中包含设置、快捷键、托盘和插件运行 smoke；它不是只读 renderer 探针，且沿用上述真实数据与身份，不能作为隔离入口。

因此 `--atools-visual-smoke` 能展示真实 Vue 主窗，但不隔离 `~/.atools` 或进程身份；`ATOOLS_DESKTOP_SMOKE` 也没有主窗口 DOM/focus 生命周期采样。

## 可复用的隔离 native fixture

主要入口是 [`src-tauri/examples/legacy_node_desktop_smoke.rs`](../../src-tauri/examples/legacy_node_desktop_smoke.rs) → `atools_lib::run_legacy_node_desktop_smoke()` → [`src-tauri/src/legacy_runtime/desktop_smoke.rs`](../../src-tauri/src/legacy_runtime/desktop_smoke.rs)。Cargo 仅在 `legacy-node-smoke` feature 下暴露该 example。

`--panel-ui` 分支继续进入 [`src-tauri/src/legacy_runtime/desktop_smoke_panel.rs`](../../src-tauri/src/legacy_runtime/desktop_smoke_panel.rs)：

- 要求绝对路径参数：`--panel-ui`、`--panel-css`、`--panel-probe`、`--plugin-root`、`--output`、`--fixture-root`。
- 以 `AppConfig::with_base_dir(root/app-data)`、`root/smoke.sqlite`、`root/webview` 和唯一 `dev.atools.panel-smoke.<uuid>` identifier 建立隔离。
- 清掉默认 Tauri windows，再建 label `main`，URL 是 `atools-panel://localhost/`。页面只创建 `<div id="app">` 并加载测试脚本和 CSS；脚本由 [`scripts/probe-plugin-panel-native.mjs`](../../scripts/probe-plugin-panel-native.mjs) 用 Vite 从 `tests/components/nativePlugin*Smoke.ts` 构建。
- [`src-tauri/src/legacy_runtime/desktop_smoke_panel_foreground.rs`](../../src-tauri/src/legacy_runtime/desktop_smoke_panel_foreground.rs) 的 `native_panel_foreground(app: AppHandle, ensure: bool) -> Result<Value, String>` 默认 `ATOOLS_PANEL_FOREGROUND_MODE=observe`；只有显式 `required` 时 `ensure: true` 才可调用 `window::show_main_window()`。结果含 `nativeVisible`、`nativeFocused`、macOS `appActive`、`frontmostIsSelf`、`windowOcclusionVisible` 和键盘 responder 证据；窗口事件只记录该 fixture 的 focus/close/destroy，不安装生产失焦隐藏逻辑，也没有 hide 动作。
- `tests/components/nativePublishedForegroundPrecondition.ts` 可同轮读取 `document.visibilityState`、`document.hasFocus()` 并与 native snapshot 对齐。它只做显示/前台条件，不执行 hide / re-show，也不把原生 show 返回值单独当作窗口可见证明。

可复用的建议命令（未执行；会构建并启动一个插件面板 fixture，不验收主 Vue）：

```sh
node scripts/probe-plugin-panel-native.mjs /private/tmp/atools-plugin-panel-native-acceptance-<fresh-id>.json
```

脚本默认 scenario 为 `panel`，其 build plan 是 `cargo build -p atools --example legacy_node_desktop_smoke --features legacy-node-smoke --offline`。该流程适合复用隔离窗口、临时数据和 native window evidence 的实现模式，不能据此宣称 ATools 主 renderer 验收通过。

## 原版 Vue renderer 的现有浏览器入口

[`scripts/test-ztools-renderer-browser.mjs`](../../scripts/test-ztools-renderer-browser.mjs) 将原版 Vue renderer 放在私有 headless Chrome，通过 CDP 检查 DOM 和截图，并使用 [`tests/fixtures/ztools-renderer-host/fixture-transport.mjs`](../../tests/fixtures/ztools-renderer-host/fixture-transport.mjs) 提供受控 IPC。它可验收 renderer DOM、主题和适配层行为；focus 由 `fixture.emitFocus` 合成。脚本自身明确声明这不证明真实 Tauri/Rust 行为或原生/OS focus。因此它不能与 native panel report 拼接成“同一个主 WebView 的验收”。建议命令（未执行）：

```sh
node scripts/test-ztools-renderer-browser.mjs
```

## 最短缺失接入点

1. 在正常应用 bootstrap 提供显式 opt-in 的 isolated profile（例如绝对路径 `--data-dir`、唯一 `--app-id`、新建的 `--report`）；仅隔离 Tauri identifier 不够。让 `AppConfig` 和 SQLite `Database` 共用同一个解析出的 base dir，并为主 WebView 指向 profile 内独立目录。默认启动仍应保持现有行为。
2. 对该 profile 使用现有 `tauri.conf.json` 的真实 main-window URL `/` 和产品 Builder/命令注册，而不是 `desktop_smoke_panel.rs` 的自定义 `atools-panel://` fixture。将唯一 identifier 写入 `generate_context!()` 后再 build，确保与用户 app 分离。
3. 在 isolated-only runner 中调用已有的 `show_main_window` / `hide_main_window` API 按 `show → observe → hide → observe → show → observe` 驱动；Vue renderer 向测试专用 report command 返回 root/mount 标记、`document.visibilityState`、`document.hasFocus()`、`document.activeElement` 的稳定标识。每个阶段同时采集 `WebviewWindow::is_visible/is_focused`；macOS 可复用 `PanelForeground` 的 frontmost / occlusion 采样。
4. 本地 profile 应禁用或隔离快捷键、托盘、MCP 监听和 clipboard capture 等不属于窗口验收的启动副作用；报告保留 source/identity/profile 路径和清理结果。只有此模式完整后，才有不改 HOME、不碰 `~/.atools`、不重启用户 app 的真实主 Vue WebView 验收路径。

## 本次执行记录

- 仓库：`/Users/harris/Desktop/atools`
- 分支：`codex/atools-ztools-parity`
- 审计开始时 `git status --short` 有 1,729 项既存改动；均保留。本文是本子任务唯一新增文件。
- 未构建、启动或自动化控制应用；未运行 Cargo、浏览器、AppleScript 或 CUA。

## 2026-10-27 更新：真实主 Vue WebView 隔离入口

新增 `src-tauri/examples/ztools_renderer_desktop_smoke.rs`，只在已有 `legacy-node-smoke` feature 下构建。`renderer_desktop_smoke` 使用生产共享的 `app_builder::host_builder`、完整 command registry、main-window 创建及 `app_lifecycle`，加载固定版本原版 Vue 的真实 dist，URL 为 App `/`。普通应用的桌面服务注册和默认 Svelte 入口继续保留；fixture 省略托盘、全局热键、MCP、剪贴板采集等普通启动服务，因此这不是整个普通启动流程的验收。

数据使用全新临时目录中的 `AppConfig` 和同源 SQLite；临时 `.app` 的实际 bundle identity 与每轮 UUID 匹配。macOS **忽略 `data_directory`**，不能把目录配置视为存储隔离证据；新入口使用 incognito，并读取真实 WKWebView 的 `WKWebsiteDataStore.isPersistent() == false`。旧 panel profile 里的 `webview` 路径仅是当时配置意图，不补记为已验证隔离。

runner 为 `scripts/test-ztools-renderer-native.mjs`，使用产品 Node 启动自己的临时 `.app`，无 HTTP/CDP/AppleScript；二进制及 988 文件 native source closure 与成功 build receipt 绑定，运行前后复核。CLI 可用 `--build-receipt <绝对路径>` 指定对应构建回执。只有子进程真正结束且目录 marker/PID/identity 一致，才删除自有数据目录和应用副本；超时本身不代表进程已结束。

九阶段覆盖显示、固定文本准备、隐藏、再次显示、辅助窗口真实抢焦后隐藏/返回，以及 adapter dispose 后再次产生原生焦点事件。探针不调用输入框 focus/select，不合成焦点；每阶段同时记录 native 和 DOM，检查清空或保留全选。固定输入通过 DOM setter 和 input event 完成，不能称为物理键盘验收。辅助窗口是同一个临时应用中的空白、禁用 JS、非持久化 WebView，最多同时一个。

真实初次运行发现生产窗口顺序问题：应用激活检查先失败，导致后续 `set_focus` 根本没执行。`window/presentation.rs` 现先让已显示的自有窗口获得焦点，再验证应用激活。失败证据保留。fixture 自己的报告失败退出码也增加负向验证；事件循环改用 `run_return` 后，在真实清理完成后结合 fixture 状态决定最终退出码，不能只依赖永不返回的 `run` 后代码。

最新结论和可复现命令统一记录在 `output/renderer-native-2026-10-27/verification.md`。系统菜单实际选择、应用启动及 TaskRun、原版 setting 同窗插件、窗口材质/物理屏幕效果、跨平台和完整插件生命周期仍独立验收。

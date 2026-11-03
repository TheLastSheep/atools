# Gemini 插件方案源码评估

核对口径：ATools 当前分支源码为主；只读上游 ZTools commit `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。下列源码存在不代表运行验收。

参考来源：[用户补充附件](</Users/harris/.codex/attachments/0112ee46-e21d-48b1-ab69-9ed177bb9010/Pasted text.txt>)，SHA-256 `32ff1b62b43092b8f7e1f1129397280ac88ff3373f464a347525953363bbeb8a`。本次增量复核见 [固定上游源码核对](/Users/harris/Desktop/atools/output/gemini-plugin-reference-2026-10-27/source-review.md)；与既有评估合并使用，排期保持主程序优先、随后 Harris 原包插件。

## 决策边界

- 按 North Star 2.1/2.2、4.2、6.1/6.7 与 DESIGN 3.3、5.3：保持 Tauri + Rust 主程序、按需隔离 Node；原版 ZTools 生态按兼容客户端复用。当前原版渲染层验收优先，插件扩展不进入本轮开发范围；现有 Svelte 入口继续作为回退。
- 统一能力、权限、TaskRun、审计和结果边界继续适用。插件市场只做兼容客户端、缓存/安全校验与本地治理，不建设公开市场服务端或社区。
- 补充文本中的 100%、99%、`<0.2ms` 是未验证断言，不作为兼容率、性能目标或验收结果；North Star 2.2 已明确此类数字待验证。

## 采纳矩阵

| 主题 | 源码现状 | 评估与处理 |
|---|---|---|
| 插件市场 | 已有 Svelte 市场 UI、元数据查询、安装/更新和取消进度。官方目标端点固定；下载包校验期望 ID/版本，并支持校验和、签名公钥；官方未签名包要求用户明确确认。`src/components/PluginMarketPanel.svelte:165-172`; `src-tauri/src/plugin_market_target.rs:8-10,51-62`; `src-tauri/src/plugin_mutations/market.rs:155-184`; `src-tauri/src/commands.rs:4561-4601` | **已有，可复用。** 上游市场有本地缓存回退（`src/main/api/renderer/pluginMarket.ts:214-242`）；延后产品扩展，不采纳并发镜像竞速、默认代理回退或公开市场服务端。 |
| 协议与 CORS | ATools `atools-plugin` 按窗口租约/插件授权读取资源；`atools-page` 单文档 origin 仅原生 fixture 可用。Loopback 先验 bearer session，再按 opaque/exact origin 返回 CORS。`src-tauri/src/plugin_asset_protocol/mod.rs:103-121,169-191,195-240`; `src-tauri/src/plugin_page_runtime/mod.rs:1-7,43-65`; `src-tauri/src/plugin_loopback.rs:239-260`; `src-tauri/src/plugin_loopback_origin.rs:20-65` | **已有受控通道。** 上游 `ztools-icon://` 是应用图标协议且 `corsEnabled:false`，不能据此推出通用插件 origin（`src/main/core/iconProtocol.ts:71-87,111-124`）。Tauri 文档说明自定义协议页面的 origin 随平台而异：macOS/iOS/Linux 为 `<scheme>://localhost`，Windows/Android 默认 `http://<scheme>.localhost`；逐平台核对精确 origin 和 CORS（[Tauri Builder 文档](https://docs.rs/tauri/latest/x86_64-apple-darwin/tauri/struct.Builder.html)）。复用 ATools 协议；不加任意目标 URL 的 CORS 代理。 |
| Headless 插件 | ATools 页面 bridge 有 `mode: none/list` 和 enter/search/select，但仍由插件文档执行。`run_plugin_main_push` 需要 live Tauri window。上游 `queryMainPush` 预加载并向插件 WebContentsView 发消息，不是无 WebView 进程（`src/main/managers/pluginManager.ts:1557-1617`）。`src/lib/pluginFeatureExportsBridge.ts:161-195`; `src-tauri/src/plugin_main_push/commands.rs:59-73,100-127` | **部分已有，完整 headless runner 待做。** 复用 mode/列表契约；不把现有 main-push 当成 preload-only 无界面执行器。延后至主程序验收后。 |
| SubInput | ATools 已有 set/remove/value/focus/blur/select、epoch/generation 和回传；上游 preload/PluginManager 也维护搜索框值、placeholder 和可见性。`src/lib/pluginSubInputBridge.ts:16-35,52-109`; `src/lib/pluginSubInputState.ts:30-63`; `src/lib/pluginPanelInteractions.ts:29-54`; `src/preload/index.ts:269-284`; `src/main/managers/pluginManager.ts:1299-1328` | **已有交互底座，可采纳。** 延后真实原版插件验收：主窗焦点/IME、键盘路由和重新进入；不再造第二套 IPC。 |
| Detach | ATools 以 30 秒一次性 `FeatureAction` handoff、16 MiB 上限及 owner/revision claim 打开独立 Webview。上游则把同一 `cached.view` 传给 detached manager，再 add 到目标 `contentView`。`src-tauri/src/plugin_detach_window.rs:42-57,86-113,161-189`; `src-tauri/src/plugin_detach_runtime.rs:17,42-68`; `src-tauri/src/plugin_detach_validation.rs:10-36,61-78`; 上游 `src/main/managers/pluginManager.ts:1868-1891`; `src/main/core/detachedWindowManager.ts:224-232` | **现有 handoff 不等同原版 live-view detach。** 不把任意 JSON/WebView 状态快照称作无损；状态型插件需单独验收。保持插件延期，不在本轮扩展 reparent。 |
| Node 同步桥 | ATools `NodeModuleBridge` 通过每 session `/node/<token>` loopback 执行 sync XHR，native session/权限/TaskRun 校验；Node sidecar 请求走异步 worker。`src/lib/nodeModuleTransport.ts:10-15,38-59`; `src/lib/pluginLegacyNodeEnvironment.ts:73-76`; `src-tauri/src/legacy_runtime/commands.rs:160-179`; `src-tauri/src/legacy_runtime/mod.rs:85-128,181-238`; `crates/atools-plugin/src/sidecar/supervisor.rs:293-325` | **同步机制已有，覆盖率待测。** 上游同步 API 是 Electron `sendSync`/`ipcMain.on`（`src/main/api/plugin/pluginApiDispatcher.ts:38-59`）；复用现有 session bridge，不加 `zplugin-rpc://sync`。MDN 明确同步 XHR 会阻塞执行并可能冻结界面；测量应覆盖完整调用链和界面阻塞/恢复，不能由“本地内存协议”推出 `<0.2ms`（[MDN](https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest_API/Synchronous_and_Asynchronous_Requests)）。不接受 `<0.2ms` 或 100% Node/Electron 承诺。 |
| 插件 DB | ATools 核心为 rusqlite / SQLite WAL；插件 DB/dbStorage 已有同步受限方法与异步 API，受 session/权限/TaskRun 和 512 KiB 请求上限约束。`crates/atools-core/src/db.rs:81`; `crates/atools-core/src/db/plugin_data.rs:21-79`; `src-tauri/src/plugin_data_runtime/operations.rs:1-60`; `src/lib/pluginDataBridge.ts:98-109,149-205` | **已有，继续 SQLite。** 上游数据库桥确实用 LMDB，但这只是迁移输入，不是 ATools 引擎选择理由（上游 `src/main/api/shared/database.ts:71-88`）。不采纳 heed/LMDB 替换方案；按插件作用域补 API 验收。 |
| CLI / 开发者工具 | `atools_cli` 提供 search、harness、skills、mcp-stdio；其中 MCP 工具调用明确返回“Use ATools desktop host or plugin bridge for live tool execution”。当前未见 ZTools 插件 `init/dev/pack` 命令。`crates/atools-core/src/bin/atools_cli.rs:16-58,60-78,85-95` | **已有有限 headless CLI，不是插件 CLI。** 可作为后续共享核心入口；插件模板、watch/hot reload 与原版 `.zpx`/`.zip` 打包兼容性后置，不声称当前已具备独立插件开发工具链。 |
| 卸载与插件数据 | 固定上游源码提供 `deleteData:false` 保留插件数据库数据，默认/true 清理该数据；源码和测试已核对，未运行。`/Users/harris/Desktop/ZTools/src/main/api/renderer/plugins.ts:631-671`; `/Users/harris/Desktop/ZTools/tests/main/pluginRemovalCleanup.test.ts:228-253`。但 `removePluginUsageData` 与 provider 清理仍会执行，不能把这个选项扩大解释为保留全部关联设置。上游 `killPlugin` 异步派发 `PluginOut` 后按延时关闭，没有等待插件确认保存；未保存的内存状态不能据此视为已落盘。`/Users/harris/Desktop/ZTools/src/main/managers/pluginManager.ts:1034-1066,1151-1163`。ATools 当前 `uninstall_plugin_inner` 调用 `db.delete_plugin`，级联删除插件记录、文档、附件和 web storage；没有保留数据选项。`src-tauri/src/commands.rs:5167-5183`; `crates/atools-core/src/db/plugins.rs:216-225`; `crates/atools-core/src/db/schema.rs:20-56`; `DESIGN.md:156` | **保留为明确兼容差异。** 如需补 ATools 保留数据选项，应单独设计数据/配置范围并验证事务与附件生命周期；卸载前还需定义插件退出、异步保存及未确认时的处理，不能把强制关闭当成保存确认。 |
| 补充的全量 API 清单 | 补充文本最后另列 `window.ztools` 生命周期/窗口、输入、数据库、剪贴板/键鼠模拟、通知/对话框/截图、系统信息/外壳等方法，并推荐若干底层 crate。当前 `src/lib/pluginBridgeCapabilities.ts:10-149` 是分组能力目录，覆盖 clipboard/input/dialog/window/system/context/user 等名称，但它不是逐 API 的兼容验收结果。 | **清单不是兼容证明，逐 API 验收后置。** 对照每个方法的实际 bridge/host 实现、参数/返回与错误、权限/TaskRun、平台支持及原插件工作流；未实现或未测平台必须显式标为 unsupported/unverified。不要仅凭该目录或参考文本列出的 `arboard`/`enigo`/`xcap` 等 crate 宣称已支持。 |

## 2026-10-29 迁移入口复核

附件 SHA 与本文记录相同，沿用本表，不另建重复任务。当前原版 Vue 迁移入口与旧 Svelte 能力需分别判断：

- `packages/ztools-renderer/src/hostEventCatalog.ts` 将 `notifySubInputChange` 限定为内部 Settings；`hostAdapter.ts` 的相关生命周期与输入订阅也来自 Settings controller。上表“已有 SubInput 底座”指旧插件宿主，不能视为原版 Vue 已接通社区插件的输入、IME、焦点和键盘路由。
- 原版 Vue adapter 已接 `list_plugins` 等 inventory 读取，但尚无市场安装/更新命令接入。后续应复用 `src/lib/pluginMarketController.ts` 与 Native market mutation，不再建一套市场或镜像调度链。
- Svelte 的插件内容当前由 `PluginPanelBody.svelte` 中的 iframe 承载；已落地的原生 Settings Child WebView 与专用 `plugin_page_runtime` fixture，不能证明社区插件已在原生 Child WebView 中运行。Detach 的 handoff 重载也不等同搬运同一 live view。

本次仅复核并补清实施归属；以上插件接入仍在主程序之后，优先 Harris 原包。没有新增产品代码或运行验收结论。

## 固定上游细节补充

- pinned ZTools 的市场客户端请求 `https://z-tools.top/api/market` 下的 `/plugins`、`/plugins/recommendations` 与 `/plugins/download?name=...`，下载响应优先提供 `zpxDownloadUrl`、并可回退 `downloadUrl`。插件包读取根目录 `plugin.json`，安装入口接受 `.zpx` 和 `.zip`；本次所核路径没有静态 GitHub `plugins.json` 目录或 `.ztpx` 格式的证据。`/Users/harris/Desktop/ZTools/src/main/api/renderer/pluginMarketConfig.ts:6,34-36`; `/Users/harris/Desktop/ZTools/src/main/api/renderer/pluginMarket.ts:214-230,250-261`; `/Users/harris/Desktop/ZTools/src/main/api/renderer/pluginInstaller.ts:112-140,389-402,681-708`。
- 上游主窗初始高度是 58 px，插件视图从 y=58 开始；分离窗口标题栏是 52 px。不是固定 60 px。`/Users/harris/Desktop/ZTools/src/main/common/constants.ts:5-8`; `/Users/harris/Desktop/ZTools/src/main/managers/pluginManager.ts:628-631`; `/Users/harris/Desktop/ZTools/src/main/core/detachedWindowManager.ts:15`。
- Cmd/Ctrl+D 由 renderer 的 `App.vue` keydown handler 处理；只有当前视图为 Plugin 且存在 `currentPlugin` 才调用 detach，不是操作系统全局快捷键。处理器匹配该组合后会先 `preventDefault()`，即使当前不在插件视图也会拦截该按键；搜索框菜单显示对应平台提示。`/Users/harris/Desktop/ZTools/src/renderer/src/App.vue:384-398`; `/Users/harris/Desktop/ZTools/src/renderer/src/components/search/SearchBox.vue:973-980`。

## 未验证项

本次补充核对明确：缺少 `main` 的插件仍由隐藏文档承载，配置形态与 feature 的 `none/list` 模式分开；SubInput 的宿主输入和按键按原版 IPC/输入事件语义适配；原版 detach 移动同一 live view，任意 JSON 快照不能证明无损恢复。Tauri 提供 [Webview.reparent](https://v2.tauri.app/reference/javascript/api/namespacewebview/#reparent)，其存在也不能替代目标版本与平台的实际状态、焦点及退出回收验收。

按项目固定版本 [Tauri 2.11.2 协议文档](https://docs.rs/tauri/2.11.2/tauri/struct.Builder.html#method.register_asynchronous_uri_scheme_protocol)复核，自定义协议的平台 Origin 映射与 CORS 仍须显式处理，不能由一个 scheme 名称推出每插件隔离或任意跨域请求可用。同步 XHR 会阻塞调用方执行（[MDN](https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest_API/Synchronous_and_Asynchronous_Requests)）；补充中的 `<0.2ms` 须以本项目完整链路和界面响应实测验证，不作为当前性能结论。

本轮仅修订本评估文档，没有修改产品代码；未运行 GUI、Cargo、Node、安装、构建或市场下载。上述结论来自固定版本源码与测试代码核对，不代表运行验收；源码或测试存在不等于原版插件 UI、跨平台行为或业务流程已验收。

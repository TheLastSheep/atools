# Gemini 插件架构参考：现有源码对照分诊

日期：2026-10-26。仓库/工作区：`/Users/harris/Desktop/atools`；开发分支：`codex/atools-ztools-parity`。
审查时 HEAD：`c34789c0e3d19b3bf7c05d396540d891ff126abc`；工作区有既有未提交改动，以下结论针对所读工作树，不代表该提交或已发布版本。
参考材料：[用户附件](</Users/harris/.codex/attachments/0112ee46-e21d-48b1-ab69-9ed177bb9010/Pasted text.txt>)，SHA-256 `32ff1b62b43092b8f7e1f1129397280ac88ff3373f464a347525953363bbeb8a`。

## 范围与结论

参考可以作为能力问题清单，不能作为当前实现说明、官方规范或验收结果。
市场客户端、受控资源协议、SubInput、分离窗口、Node/CJS 同步桥和打包工具已有实现；后续应复用真实入口，避免按参考中的 `ztools-*` 伪路径另起一套运行时。
本次只读源码及既有结果文件，仅新增本文；未运行测试、构建、插件、浏览器或开发服务器，也不列举整个插件库。
继续当前选定的原 ZTools 主 Vue renderer 接入，插件行为开发不插队；当前默认入口仍是 Svelte 5 的 `src/App.svelte`，新 renderer 先作为独立入口验证。方向调整见 [ADR-0002](/Users/harris/Desktop/atools/docs/architecture/adr-0002-original-renderer-and-optional-private-sync.md)。
保持 Rust 核心 + ZTools 生态兼容 + 按需 Node，共用权限、TaskRun 与结果管线。北极星已根据本轮明确目标扩展可选私有同步服务，仍不复制公开市场服务端、不要求插件改写 Rust，见 [北极星](/Users/harris/Desktop/atools/docs/superpowers/specs/2026-07-14-atools-product-engineering-north-star.md)。

证据标记：**[S]** 本次读到的源码；**[T]** 已有测试代码，本次未执行；**[R-历史]** 已有运行产物，不能外推当前整库通过；**[U]** 尚无足够证据。

## 七项能力与真实入口

| 参考主题 | 当前状态与真实入口 | 后续复用及缺口 |
| --- | --- | --- |
| 市场分发、安装、更新、卸载 | **[S] 已有主链。** `PluginMarketController` 执行解析→确认→安装/更新；支持 ATools、legacy 与 ZTools 市场形状，官方目录经下载 resolver 获取产物。见 [pluginMarketController.ts:210](/Users/harris/Desktop/atools/src/lib/pluginMarketController.ts:210)、[commands.rs:3653](/Users/harris/Desktop/atools/src-tauri/src/commands.rs:3653)、[commands.rs:3841](/Users/harris/Desktop/atools/src-tauri/src/commands.rs:3841)。 | 复用现有 controller、`plugin_mutations::market` 和生命周期协调器。当前主链不提供参考所称的镜像并发测速、增量差分更新、后台自动升级验收；不能据一次 ZIP 下载推导这些能力。 |
| 协议、资源与 Origin 隔离 | **[S] 已有窗口所有权、可撤销资源 lease 和 `atools-plugin` 协议。** 真实注册在 [app_startup.rs:52](/Users/harris/Desktop/atools/src-tauri/src/app_startup.rs:52)、[plugin_asset_protocol/mod.rs:195](/Users/harris/Desktop/atools/src-tauri/src/plugin_asset_protocol/mod.rs:195)。 | 普通 UI 仍是 opaque 插件文档；`atools-page` 非 opaque 页面路径仅专用 macOS native fixture 启用，见 [plugin_page_runtime/mod.rs:1](/Users/harris/Desktop/atools/src-tauri/src/plugin_page_runtime/mod.rs:1)、[同文件:43](/Users/harris/Desktop/atools/src-tauri/src/plugin_page_runtime/mod.rs:43)。不能把它写成所有插件已有独立原生 Origin。 |
| UI / headless 双模式 | **[S] 已区分无 `main_url` 的空 HTML 宿主页，并复用 preload/bridge 加载；`window.exports[code]` 的 `none` / `list` 由已有运行器处理。** 见 [pluginPanelLoadController.ts:194](/Users/harris/Desktop/atools/src/lib/pluginPanelLoadController.ts:194)、[pluginFeatureExportsBridge.ts:169](/Users/harris/Desktop/atools/src/lib/pluginFeatureExportsBridge.ts:169)。 | 复用现有加载及 feature-exports 状态，不新造 `headless_runner_webview`。无 HTML 入口、`mode:none`、原生 sidecar 工具是不同维度；现有空页并不证明完全无 WebView、执行后必自动隐藏或所有后台插件可用。 |
| SubInput 双向同步 | **[S] 已有设置/移除/值/焦点/选择桥，回调按 document epoch 与 generation 排除旧消息。** 宿主变化回传 iframe；`list` 模式接入已有查询/选择状态。见 [pluginSubInputBridge.ts:16](/Users/harris/Desktop/atools/src/lib/pluginSubInputBridge.ts:16)、[同文件:72](/Users/harris/Desktop/atools/src/lib/pluginSubInputBridge.ts:72)、[pluginPanelInteractions.ts:29](/Users/harris/Desktop/atools/src/lib/pluginPanelInteractions.ts:29)。 | 复用 bridge/state/interactions。不能把宿主列表导航写成任意插件都收到原样 `KeyboardEvent`；具体按键语义、IME、焦点及清理要按入口验证。 |
| Detach / 多窗口 | **[S] 已有 Rust-owned 一次性交接、取消旧意图、版本/代码修订及窗口资源回收。** 入口 [launcherPluginDetachContract.ts:34](/Users/harris/Desktop/atools/src/lib/launcherPluginDetachContract.ts:34) → [plugin_detach_window.rs:7](/Users/harris/Desktop/atools/src-tauri/src/plugin_detach_window.rs:7)。 | 复用已有交接和生命周期，不能按示例再新建无所有权 UUID 窗口。当前 detached 槽位被占用会拒绝新开，见 [plugin_lifecycle.rs:37](/Users/harris/Desktop/atools/src-tauri/src/plugin_lifecycle.rs:37)；尚非参考所称任意多实例。交接 action/payload 也不等于保存任意 DOM、编辑器内存或未保存文件状态。 |
| Node / CJS / 同步 RPC | **[S] 已有按需 Node session、同步 loopback XHR、值/句柄编码与真实 Node CommonJS resolution。** 入口 [legacy_runtime/commands.rs:15](/Users/harris/Desktop/atools/src-tauri/src/legacy_runtime/commands.rs:15)、[nodeModuleTransport.ts:39](/Users/harris/Desktop/atools/src/lib/nodeModuleTransport.ts:39)、[bootstrap.cjs:1](/Users/harris/Desktop/atools/crates/atools-plugin/src/legacy_node/bootstrap.cjs:1)。 | 不重造浏览器版完整 Node。`Module.createRequire` 可复用本地模块/npm 解析；Node 侧直接拒绝 `electron`，相关能力走宿主 adapter，见 [bootstrap.cjs:106](/Users/harris/Desktop/atools/crates/atools-plugin/src/legacy_node/bootstrap.cjs:106)。`.node` ABI、额外依赖、Electron 未覆盖 API 仍须逐包验证。 |
| 开发 CLI / API 矩阵 | **[S] 已有本地安装预检、通用 DevTools 命令及 `package:plugin` 打包入口。** 见 [plugin_mutations.rs:17](/Users/harris/Desktop/atools/src-tauri/src/plugin_mutations.rs:17)、[commands.rs:6369](/Users/harris/Desktop/atools/src-tauri/src/commands.rs:6369)、[package.json:229](/Users/harris/Desktop/atools/package.json:229)、[plugin-package.mjs:223](/Users/harris/Desktop/atools/scripts/plugin-package.mjs:223)。 | 当前打包器要求声明 `runtime`，输出 ZIP+SHA256，并可能运行 runtime smoke / 显式 Rust 构建；不是参考中的纯 Rust `init/dev/pack`。本次未核实完整 Vue scaffold、开发链接、watch/socket 热重载或 `.ztpx` 工具链验收，不能把通用 DevTools 当完整开发者中心。 |

## 需要纠正的具体陈述

### 市场安全与清理

- **[S]** 自定义市场安装要求 Ed25519 签名与本地 pin 公钥；官方无签名例外仍要求明确确认、限定官方 HTTPS 目录/包域名，见 [commands.rs:4523](/Users/harris/Desktop/atools/src-tauri/src/commands.rs:4523)、[同文件:4561](/Users/harris/Desktop/atools/src-tauri/src/commands.rs:4561)。不能把任意镜像速度优先置于来源、版本和信任校验之前。
- **[S]** 市场包先预检/stage，再检查 package scope、plugin ID 与已确认版本，见 [plugin_mutations/market.rs:34](/Users/harris/Desktop/atools/src-tauri/src/plugin_mutations/market.rs:34)。目录元数据请求有体积/时间/同主机跳转边界，见 [plugin_market_http.rs:12](/Users/harris/Desktop/atools/src-tauri/src/plugin_market_http.rs:12)。这不是差分更新证明。
- **[S]** 市场下载路径明确要求 `.zip`；resolver 虽识别 `zpxDownloadUrl`，不意味着市场 ZIP 管线接受 ASAR。见 [commands.rs:3938](/Users/harris/Desktop/atools/src-tauri/src/commands.rs:3938)、[同文件:4680](/Users/harris/Desktop/atools/src-tauri/src/commands.rs:4680)。本地 ZPX 导入是另一入口，不能合并成参考中的 `.ztpx`。
- **[S]** 当前卸载调用 `Database::delete_plugin`，关联数据依赖 cascade 删除；不能声称已有“保留配置/彻底清除”两个用户选项。见 [commands.rs:5167](/Users/harris/Desktop/atools/src-tauri/src/commands.rs:5167)、[db/plugins.rs:149](/Users/harris/Desktop/atools/crates/atools-core/src/db/plugins.rs:149)。
- 更新/卸载要复用现有写门、reset 和资源回收，不照搬“强制 close 后删目录”的片段，见 [plugin_lifecycle.rs:217](/Users/harris/Desktop/atools/src-tauri/src/plugin_lifecycle.rs:217)。用户数据保留策略如后续需要，应单独明确，不在本轮顺手改变。

### 自定义 scheme 不会自动解决 CORS、CSP 或存储隔离

- **[S]** 协议注册、资源读取授权、Origin、CSP、iframe sandbox 与 storage bridge 是分别实现的边界；URL 换成 `zplugin://` 不能替代它们。当前 loopback Origin policy 由 session 所有者选择，缺失/撤销的 owner 不能由请求头自选授权，见 [plugin_loopback_origin.rs:25](/Users/harris/Desktop/atools/src-tauri/src/plugin_loopback_origin.rs:25)。
- Tauri 官方说明：自定义协议页面的 Origin 随平台变化，浏览器 `fetch` / XHR 请求仍要求服务端相应 CORS 响应头。参考中的 Windows URL/每插件 Origin/天然隔离存储公式不能直接当规范。见 [Tauri Builder 官方说明](https://docs.rs/tauri/latest/tauri/struct.Builder.html#method.register_uri_scheme_protocol)。
- **[U]** Worker、WASM、远程 API、CSP 注入与主题实时变化要分别给出平台/入口证据，不能由“自定义 scheme 已注册”推导全通过。

### Rust 代理与同步桥不能被绝对化

- **[S]** 已有原生 HTTP 工具入口会记录 TaskRun，并验证请求、跳转、超时和响应体上限，见 [commands.rs:238](/Users/harris/Desktop/atools/src-tauri/src/commands.rs:238)、[同文件:317](/Users/harris/Desktop/atools/src-tauri/src/commands.rs:317)。它不是可无条件向全部插件开放的透明 `fetch` 拦截器。后续若接入特定插件，应明确插件身份、权限/目标范围、敏感头与错误语义，不绕开现有能力管线。
- **[S]** 当前同步调用实际走受限 `127.0.0.1` session endpoint，而非参考的无鉴权全局 `zplugin-rpc://sync`。endpoint 形状、请求预算在 [nodeModuleTransport.ts:10](/Users/harris/Desktop/atools/src/lib/nodeModuleTransport.ts:10)；Host、token、Origin 与并发/期限在 [plugin_loopback.rs:60](/Users/harris/Desktop/atools/src-tauri/src/plugin_loopback.rs:60)、[同文件:143](/Users/harris/Desktop/atools/src-tauri/src/plugin_loopback.rs:143)。
- **[U]** “同步 XHR <0.2ms、完全无卡顿”没有本项目可复现数据支持。同步返回包含序列化、loopback、worker 调度、模块或文件操作及响应，不是纯内存常数。MDN 明确主线程同步 XHR 会阻塞，见 [MDN 同步与异步请求](https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest_API/Synchronous_and_Asynchronous_Requests)。保持现有同步 API 语义，也要按真实工作流测量阻塞与尾延迟。
- **[U]** “99% 携带 node_modules 插件直接跑通”“100% CommonJS / API / 像素兼容”都缺明确样本、分母、平台、版本及业务断言。独立进程或私有 HOME 也不等于 OS 文件/网络沙箱。实际 Node 请求会重查权限，见 [legacy_runtime/mod.rs:123](/Users/harris/Desktop/atools/src-tauri/src/legacy_runtime/mod.rs:123)，不能把这点扩大为任意第三方代码的完整隔离证明。

## API 矩阵应从现有实现收敛，而非重建接口清单

现有 UI capability 分组明确有 `ready` / `partial`，本身不是全量官方 API 或验收账本，见 [pluginBridgeCapabilities.ts:1](/Users/harris/Desktop/atools/src/lib/pluginBridgeCapabilities.ts:1)。建议后续记录“方法→真实宿主入口→权限→平台→错误/未支持语义→原包业务断言→验证产物”，沿用现有桥和测试。

| 参考分类 | 可复用入口 | 当前不能外推的部分 |
| --- | --- | --- |
| 生命周期/窗口/SubInput | [pluginSubInputBridge.ts:72](/Users/harris/Desktop/atools/src/lib/pluginSubInputBridge.ts:72)、[pluginFeatureExportsBridge.ts:169](/Users/harris/Desktop/atools/src/lib/pluginFeatureExportsBridge.ts:169)、[pluginBrowserWindowBridge.ts:61](/Users/harris/Desktop/atools/src/lib/pluginBrowserWindowBridge.ts:61) | 回调、焦点、分离、BrowserWindow 不是一项“窗口 API 通过率”；逐入口核对。 |
| DB / dbStorage / 附件 | [handler.rs:92](/Users/harris/Desktop/atools/crates/atools-api-shim/src/handler.rs:92)、[db.rs:74](/Users/harris/Desktop/atools/crates/atools-core/src/db.rs:74) | 现有存储是 SQLite WAL，参考的 heed/LMDB 重构不适用。core shim 的部分方法为委托/占位，不可只看名称或返回 null 判整个桌面实现完整/缺失。 |
| 剪贴板/输入 | [pluginClipboardCopyApi.ts:2](/Users/harris/Desktop/atools/src/lib/pluginClipboardCopyApi.ts:2)、[capability 分组:37](/Users/harris/Desktop/atools/src/lib/pluginBridgeCapabilities.ts:37) | 文本、HTML、图片、文件、模拟输入有不同权限、配额和平台限制；当前分组也明确 partial。 |
| 对话框/屏幕/上下文 | [pluginNativeDialogBridge.ts:7](/Users/harris/Desktop/atools/src/lib/pluginNativeDialogBridge.ts:7)、[capability 分组:128](/Users/harris/Desktop/atools/src/lib/pluginBridgeCapabilities.ts:128) | mock 对话框不能替代系统权限、取消/焦点或真实截图验收。 |
| 系统路径/外壳 | [capability 分组:99](/Users/harris/Desktop/atools/src/lib/pluginBridgeCapabilities.ts:99)、[handler.rs:138](/Users/harris/Desktop/atools/crates/atools-api-shim/src/handler.rs:138) | QuickJS/core shim 与桌面宿主入口支持范围不同；不得把一层的 stub 当全平台实现。 |
| ubrowser 自动化 | 当前能核实的是 BrowserWindow bridge，不是 `ubrowser.goto().run()` 全链证明。 | **[U]** 参考提出的隐藏 WebView 自动化队列，本次没有对应可验收主链证据；不由 createBrowserWindow 自动推导。 |

## 已有验证证据及可复用测试

| 证据 | 可以说明什么 | 不能说明什么 |
| --- | --- | --- |
| **[R-历史]** [published-artifact-source-audit.json](/Users/harris/Desktop/atools/output/legacy-node-2026-10-15/published-artifact-source-audit.json:1)，记录 2026-10-15 的五个候选 | 当时官方 resolver/ZIP、摘要、CRC 与有限静态检查；结果含版本不一致/待复核项。 | 没有运行插件；自算 SHA 不等于发布者签名；不能说明自动升级或全市场兼容。 |
| **[R-历史]** [published-regex-editor-native-final.json](/Users/harris/Desktop/atools/output/legacy-node-2026-10-15/published-regex-editor-native-final.json:1) | 该归档 `passed=true`，限定 regex-editor@1.0.0 的真实 App/PluginPanel、导入/搜索/激活/权限路径，以及匹配、flag、非法正则反馈；原包字节未变。 | 未测试文件读写、AI、物理键盘、其他社区插件；Node 非 OS 网络沙箱；不是当前工作树全部回归。 |
| **[T]** [plugin-subinput-bridge.test.ts:27](/Users/harris/Desktop/atools/tests/components/plugin-subinput-bridge.test.ts:27)、[plugin-feature-exports-runtime.test.ts:6](/Users/harris/Desktop/atools/tests/components/plugin-feature-exports-runtime.test.ts:6) | 已有 serialized bridge / selected-feature exports 合约用例，可在后续相关变更时复用。 | 本轮未运行，不记为当前通过；不能代替原包、native 焦点及隐藏/销毁场景。 |
| **[T]** [launcher-plugin-detach-contract.test.ts:16](/Users/harris/Desktop/atools/tests/components/launcher-plugin-detach-contract.test.ts:16)、[plugin-module-adapter.test.ts:30](/Users/harris/Desktop/atools/tests/components/plugin-module-adapter.test.ts:30) | 已覆盖交接身份/旧意图取消与 CJS adapter 的部分契约设计。 | 本轮未运行；不证明全部状态可迁移、无限多窗口或所有 npm/native addon 可用。 |

本次没有新增“已测通过”声明。主程序/设置会话的独立回归证据只覆盖各自原范围，不能借其数字给本表所有插件能力背书。

## 后续复用顺序，不改变当前排期

1. 继续当前原 Vue 主 renderer 接入和明确业务断言；上游、构建输入、宿主适配及原插件包身份保持可核验。
2. 行为缺口先沿“入口→现有桥→权限/TaskRun→宿主实现→结果/清理”追踪，尤其区分普通 opaque 页面与 native fixture、UI 与 headless、desktop 与 core shim。
3. 仅对确实缺失的方法或生命周期语义补实现；复用已有市场、SubInput、detach、Node session、资源 lease 和测试，不另建 registry/sandbox/全量 Node polyfill。
4. 镜像自动选择、保留数据卸载、任意状态分离/多实例、开发 CLI scaffold/watch、ubrowser 全链与兼容百分比仍是独立待验证需求；没有当前用户范围与证据，不插入本轮开发。

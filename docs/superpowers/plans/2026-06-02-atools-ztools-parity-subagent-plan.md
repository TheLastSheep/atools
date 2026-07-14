# ATools ZTools/uTools Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 ATools 从“已有 Tauri/Rust/Svelte 骨架”推进到 macOS 上可日常使用、体验接近 ZTools/uTools、并具备 Agent/MCP 本地工具底座能力的首版。

**Architecture:** 保持 Tauri + Rust core + Svelte/TS UI。Rust 负责本地能力、插件数据、MCP、权限审计和系统集成；Svelte 负责主搜索体验、设置页、插件 iframe 宿主、权限确认和审计可视化；插件继续运行 HTML/JS，不重写为纯 Rust UI。

**Tech Stack:** Tauri 2, Rust, Svelte 5, TypeScript, SQLite, MCP JSON-RPC over local HTTP, macOS LaunchAgent/global shortcut/tray.

---

## 1. 当前完成度总览

| 模块 | 当前完成度 | 已完成 | 主要缺口 | 首版判断 |
| --- | ---: | --- | --- | --- |
| Tauri/Rust 桌面底座 | 97% | 主窗口、全局快捷键、托盘、窗口高度、设置落库、macOS 自启命令、真实桌面 smoke、主进程运行诊断、数据/调试命令 smoke、热键/托盘/自启 plist smoke、热键唤醒黑名单、前台应用读取命令、opener 路径/URL 打开、panic crash log、crash log 查看/导出/清空命令、feature 索引幂等替换、macOS bundle identifier/entitlements 配置、Tauri shell `osascript -e` scoped command、快捷键注册失败错误透传、AI `/models` 连接测试命令、WebDAV 远端备份上传、manifest 校验、远端备份预览、恢复计划 diff、设置恢复合并命令和剪贴板历史追加导入命令 | 自动更新、签名公证 | macOS 首版可继续收口 |
| ZTools/uTools 主搜索体验 | 100% | Z 风格搜索框、三笔画圆形 Z 标识、首页图标化常用入口、结果行类型图标、最近使用类型图标磁贴、系统命令、键盘导航、结果分组、结果行来源 detail、匹配标签/tone、选中行上下文 Enter 提示、底部状态栏/按键提示、状态栏上下行分离提示、空格/Tab、网页快开、本地启动、粘贴识别、URL/文本识别、历史、别名、拼音/模糊匹配、本地应用搜索、应用图标、应用 metadata alias、搜索 benchmark | 极端结果量性能持续观察；真实大规模插件生态未回归 | 接近日用 |
| ZTools 设置页 UI | 99% | 94px 高顶部标签栏、72px 大标签、三笔画圆形 Z 标识、860px 设置窗口目标高度、宽侧栏大菜单行、左侧选中 pill、右侧内容区宽松节奏、ZTools 级大字号/大尺寸桌面控件、顶部三点更多操作菜单、设置页内嵌确认弹窗、侧栏/内容区细圆角滚动条、通用设置、快捷键三段式页面、应用快捷键自定义编辑器、所有指令来源分组/指令中心、行级别名提示/管理入口、快捷键预设、快捷键冲突/保存状态提示、应用内快捷键列表、指令别名入口、唤醒黑名单、自动粘贴、网页快开卡片列表/编辑面板/删除确认、本地启动选择/拖拽/打开定位/删除确认、AI 模型本地配置/连接测试页、WebDAV 本地配置、远端备份状态、备份预览、恢复计划、设置恢复结果、剪贴板导入结果、插件数据导入结果和覆盖冲突结果页、插件市场状态页、远程目录列表、远程详情面板、评分/下载元数据展示、远程 ZIP 安装/更新动作、下载进度显示、取消/重试控件、SHA-256 校验标记和安装确认能力、发布者/签名信任展示、已安装插件管理/详情页、插件授权启用确认、运行时权限审计行和持久授权清除、MCP 客户端模板、HTTP 服务状态页、关于页、我的数据审计概览、调试日志、脱敏诊断包、崩溃日志区块等主要页面已成型，未实现项有明确禁用态 | 插件证书链/吊销/平台级签名策略未接入；插件指令中心的禁用/固定/匹配指令需等插件接入后回归 | 可继续打磨 |
| 设置项真实功能 | 99% | 最近使用、主题/自定义主题色、透明度、托盘显示、macOS 自启、全局热键、快捷键预设/录制、快捷键常见冲突拦截、快捷键页 Space/Tab 行为设置、应用快捷键自定义新增/编辑/启停/删除/本地保存/运行时触发分发、所有指令页来源筛选/状态筛选/别名入口、指令别名新增/清空/启停/删除、唤醒黑名单、添加当前窗口、自动粘贴、自动清空、自动返回搜索、网页快开编辑/预览/URL 校验/删除确认、本地启动搜索、本地启动文件/文件夹/应用选择、打开/定位路径、删除确认、剪贴板保留、AI 模型本地配置保存和 `/models` 连接测试、网络代理 http/https URL 保存和 AI/WebDAV 请求层接入、开发者工具位置偏好保存和主窗口 DevTools 打开命令、自定义插件市场地址 http/https 保存、插件市场页外部打开入口和远程 JSON 目录读取/展示、远程 catalog rating/ratingCount/downloads/updatedAt/publisher/signature/publicKey 解析和 Settings 详情展示、远程 ZIP 下载进度事件、远程 ZIP 下载取消/自动重试/手动重试、远程 ZIP 下载/安全解包/安装/更新、远程 ZIP Ed25519 签名校验、目录 SHA-256 校验和安装/更新前确认、悬浮球独立窗口显示/隐藏和点击打开主搜索、超级面板独立窗口显示/隐藏、剪贴板文本入口和打开主搜索、WebDAV 本地配置保存、WebDAV 远端备份上传、manifest 校验、备份预览、恢复计划 diff 预览、内嵌设置恢复确认流、内嵌剪贴板历史追加导入确认流、内嵌插件数据追加导入确认流、内嵌插件数据覆盖冲突确认流、内嵌插件数据逐文档冲突选择覆盖、清空类危险操作确认流、已安装插件刷新/启停/本地目录安装、本地同 ID 更新、插件 metadata/features 原子事务更新、`plugin_data`/附件保留、市场已有插件更新前停用/导入插件卸载/插件目录定位/插件权限能力审计、远程插件安装/更新后授权启用、manifest permissions 解析、运行时 allowlist 拦截、逐 API 本会话弹窗授权、逐 API 持久授权和 Settings 集中清除、MCP 客户端配置复制、安全合并写入和安装指引、调试诊断、调试信息脱敏导出、数据页导出、审计数据概览、审计保留策略清理、审计归档到文件、崩溃日志查看/复制/清空，未实现能力不会从旧数据假启用；热键/托盘/自启 plist/悬浮球/超级面板窗口已纳入真实 smoke | 敏感凭据安全存储与迁移、插件证书链/吊销/平台级签名策略 | 剩余主要是凭据和发布项收口 |
| 插件安装/导入 | 100% | ZTools 插件扫描/导入、插件列表与市场、同父目录 staging + 原子目录替换、数据库失败字节回滚、卸载 quarantine 恢复、install/update/uninstall 全局串行化、source/destination symlink 拒绝、ZIP 加密/符号链接/路径/重复项/数量/深度/单项与总解压配额、SHA-256 与 Ed25519 校验、本地 pin 信任根且 catalog key 不可自证、信任 pin 不进入 WebDAV、metadata/features 原子事务、attachment/data 保留、远程安装后默认停用授权，以及真实 ZTools activation/render/browser/desktop smoke 全链路 | 证书链/吊销/平台级签名策略、更广样本逐插件视觉截图和 side-effecting native bridge 人工回放 | 自动化首版闭合，可扩 |
| 插件 iframe 宿主 | 99% | iframe 加载、preload 注入、subInput、outPlugin payload 归一化、宿主输出层、output 行右键 `复制结果` 菜单、iframe `contextmenu` 事件上报、manifest permissions allowlist 对 plugin data/clipboard/shell/screen/dialog/context/system/BrowserWindow bridge 拦截和 postMessage fallback 二次校验、缺失运行时权限的逐 API 本会话弹窗授权、逐 API 持久授权、主插件和 hosted BrowserWindow iframe 均使用 `allow-scripts allow-popups` 且无 `allow-same-origin`，主 invoke deny-by-default/source+generation 绑定/参数重建/强制 active pluginId，hosted child 使用独立 `MessageChannel` 七方法 RPC、BrowserWindow hosted WebContents/BrowserWindow 大部分状态与动作桥、系统 shell/screen/context/clipboard/输入/资源解析桥、Tauri-scoped `osascript` command path、Web preview PluginPanel iframe `src` fixture 加载、real-entry probe chip、real fixture error message forwarding、sandbox-safe storage fixture stubs、10-panel matrix probe forwarding、真实 Tauri indexed PluginPanel render smoke、外部 activation plan render-safe 队列 8/8 filesystem `srcdoc` 回传、40/40 smoke-injected iframe bridge probe checks、32/32 no-side-effect native/system method probe checks、large-srcdoc dynamic probe timeout 等主要宿主能力已成型 | startDrag 仍有 explicit native-only unsupported；20 个依赖 child DOM 的 inspect/capture/export/edit/selection API 明确返回 `ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED`，真实独立分离窗口、完整 WebContents API、native print UI、native 右键菜单/native menu bar/native macOS titlebar/material/document proxy、拖拽和更复杂 iframe 交互未完整；更广第三方插件视觉截图和 side-effecting native bridge replay 仍未完成 | 高风险 |
| Agent/MCP 底座 | 99% | 本地 HTTP MCP、stdio proxy、token 脱敏展示、initialize、ping、id-less notification 语义、JSON-RPC batch、tools/list、tools/call、内置 resource catalog、`resources/read`、内置 prompt catalog、`prompts/get`、权限模式、按工具授权、按 scope 阻断、审计、全局确认弹窗、dry-run/路径/风险预览、审计回放摘要、审计筛选、后端审计查询/筛选导出、审计分页加载、副作用 diff、路径副作用视图、AI 默认模型本地配置、连接测试和 `ask_ai_model` 真实调用、UI 管理页、运行诊断、客户端配置复制、Claude/Cursor/通用客户端模板、客户端安装指引、客户端配置安全合并写入、Claude/Cursor 默认配置路径建议、插件 manifest tools 白名单暴露（默认关闭）、同步/异步 handler 执行路径和 runtime context 缺失时 preload 懒加载、真实桌面权限链路和 MCP 协议 smoke | 更多客户端实测、真实第三方插件 tool 兼容回归 | 可继续 |
| 内置 Agent 工具 | 86% | ask_ai_model、search_clipboard 历史检索、find_local_files 忽略目录/深度/权限统计/通配忽略规则、rename_files、open_or_reveal_path、compress_images 质量目标和 lossless WebP 输出、ocr_image、本地上下文说明、当前浏览器 URL bridge 读取、Finder 路径 command bridge 读取 | 文件搜索索引化/性能仍可增强；OCR 依赖本地服务；浏览器兼容/权限引导和前台窗口上下文仍可增强 | 可继续 |
| 权限与审计 | 98% | DB schema、权限模式、pending request、grant/revoke、按工具授权、按 scope 阻断、audit list/export/clear/prune/archive、后端审计查询、分页 total/offset、状态/工具/客户端过滤索引、筛选导出、设置页审计概览、审计详情、回放摘要、审计筛选、保存筛选视图、审计保留策略清理、审计归档到文件、副作用 diff、路径副作用视图、数据页管理、权限确认 dry-run/本地路径/风险等级预览、真实桌面 pending/denied audit/cleanup smoke | 更多真实客户端长历史回放仍可增强 | 可继续 |
| 测试与发布 | 99% | Rust 308 测试、严格 Clippy 零告警、133 项默认快速层、8 项真实 Chrome/CDP 层、Vitest/jsdom Svelte 组件行为层、真实 Tauri desktop smoke、签名为空 8/3/0 精确发布门禁、GitHub Actions macOS quality/browser/desktop/release jobs、`pnpm check` 0/0、生产构建与 macOS `.app` bundle smoke | Developer ID 签名、公证、自动更新和 clean-machine Gatekeeper 仍依赖外部凭据/环境 | 自动化门禁闭合，正式分发待凭据 |

**Batch 386 current delta:** 发布版本从前端/package 已是 `3.0.0`、Tauri bundle 与 Rust workspace/crates 仍是 `0.1.0` 的分裂状态推进到全链路统一 `3.0.0`；新增 `test:version-consistency`，同时约束 `package.json`、`src-tauri/tauri.conf.json`、workspace version 与 `Cargo.lock` 中 4 个本地 crate。TDD 红灯先命中 Tauri `0.1.0 !== 3.0.0`，修正配置与 lock 后转绿。完整 fast tier 初次重跑又暴露 release bundle budget 读取共享 `dist` 的非确定性：`tauri build --debug` 留下 845,695-byte 未压缩首屏 JS，错误触发 573,440-byte production 预算；预算测试现改为在临时目录强制 production Vite build 并清理，不再依赖调试产物。重建 release `.app` 后 Info.plist 的 short/build version 均为 `3.0.0`；首次真实 release smoke 因固定 1500ms 后立即结束进程，截断最后一个 Agent/MCP 报告而得到 9 ok / 1 warn / 1 error，新增等待逻辑与时序单测后会轮询至 `completed:true` 再清理，复跑为 10 ok / 1 个本地 adhoc Gatekeeper warning / 0 error。最终 `cargo check --workspace` 以 `atools` / `atools-core` / `atools-plugin` / `atools-api-shim v3.0.0` 通过，`pnpm test:fast` 134/134。清单 checkbox 保持 283/290 (97.6%)；更新渠道、真实签名公证、Gatekeeper 与 6 个真实人工/side-effect 项仍是外部决策或凭据边界。

**Batch 385 current delta:** 完成 Batch 384 后剩余的本地可实现交付收口：插件安装/更新/导入改为同父目录 staging + 原子替换，数据库失败回滚旧字节，卸载先 quarantine 且失败恢复，所有插件文件变更全局串行；source/destination symlink、ZIP 加密/符号链接/unsafe/duplicate、4096 entry、32 层、32MiB 单项、64MiB 总解压配额全部 fail closed。市场安装要求 Ed25519 签名和匹配本地 settings/env pin 的公钥，catalog key 不可自证，信任 pin 不进入 WebDAV。测试入口分成 133 fast / 8 Browser / desktop / release；Vite 由测试直接拥有避免 1420 orphan；Vitest/jsdom 覆盖 Settings unmount flush 与 PluginPanel current/stale/foreign source；严格 Clippy 全 workspace 零告警；`.github/workflows/ci.yml` 以 Node 24 + pnpm 11.7.0 执行质量、浏览器/桌面和 signing-free release jobs。最终验证：Rust 308/308、Svelte 0/0、Browser 8/8、desktop smoke `2026-07-14T04:36:06Z` status ok（render 2/2、bridge 10/10、native 8/8、BrowserWindow 9/9）、release 8 ok / 3 warn / 0 error。清单仍为 283/290 (97.6%)；7 个未完成项均为真实按键/托盘/用户 LaunchAgent/side-effect replay 或正式签名 Gatekeeper，不能由安全自动化替代。

**Batch 384 current delta:** 插件 iframe 安全边界从“主 iframe 已去掉 same-origin，但 invoke 仍可能信任未知命令/插件参数，hosted BrowserWindow child 保留 same-origin 且宿主直接读取 DOM，inspect/capture/export/edit/selection 被文档当作成功”推进到“主/hosted iframe 均严格使用 `allow-scripts allow-popups`；main invoke deny-by-default，绑定 active `WindowProxy` source 与 generation，重建参数并强制 active `pluginId`；hosted child 每窗口使用独立 `MessageChannel`，仅开放 `describe` / `executeJavaScript` / `sendInputEvent` / `insertCSS` / `removeInsertedCSS` / `findInPage` / `stopFindInPage` 七个 RPC；inspect/capture/pdf/save、12 个 edit、4 个 selection/scroll 共 20 个 API 统一返回 `ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED`，`print()` callback 明确失败”。真实 `pnpm smoke:tauri-desktop` 于 `2026-07-10T13:20:34Z` 通过，BrowserWindow probe expected/reported/passed 为 1/1/1 samples、9/9 checks，九个隔离/IPC/cleanup bool 全部为 true；清单只修正既有勾选行语义，不增减 checkbox，保持 283/290 (97.6%)。历史 Batch 235/236/237/238 与相关 Web preview 描述作为实现演进记录保留，但其同源 DOM 成功语义已由本批安全边界取代。后续 P0-DB 也已完成并验证：`plugins` / `plugin_data` 不再使用 `REPLACE`，metadata/features 在同一事务内更新，attachment/data 保留，market existing plugin 更新前先停用。当前第一优先级转为固定安装目录 remove-before-copy/非事务文件系统失败恢复、source/destination symlink 与 ZIP quota、可恢复卸载和 install/update/uninstall 并发，以及插件市场 unsigned/untrusted trust-anchor fail-open；这些文件系统与信任锚风险由 Batch 385 完成。

**Batch 383 current delta:** 原生设置链路从“热键更新先注销旧注册、多个 native 写入失败后可能留下部分状态、快速连续保存可能并发、160ms debounce 尚未入队时关闭设置会丢最后快照、LaunchAgent smoke 会触碰真实用户目录、desktop parser 多组 required bool 只检查字段存在”推进到“热键先注册新值再精确注销旧值并在失败时补偿，IPC 正向/回滚都显式传递 `previousShortcut`；native 设置部分失败和 DB 持久化失败均补偿，DB-first 后才更新 local cache，串行 coordinator 只以前一次成功值为基线，flushable debouncer 在卸载时恰好入队最新快照；生产 LaunchAgent 使用 symlink 拒绝、同目录原子替换和有序 launchctl 补偿；desktop smoke 只在系统临时目录验证 plist，观测主窗口居中和新旧热键注册状态；permission/data-debug/system/plugin runtime/render 的 required bool 全部严格要求 `true`”。清单旧汇总先按实际勾选数校正为 281/290，本批只闭合有自动化证据的主窗口居中与快捷键新旧注册 2 项，推进到 283/290 (97.6%)；真实按键、托盘视觉、真实用户 LaunchAgent、第三方插件副作用回放和 Gatekeeper 仍保持未完成。

**Batch 382 current delta:** 桌面插件运行态 smoke row 从“`pnpm smoke:tauri-desktop` 已输出 `plugin_runtime_smoke` / `plugin_panel_render_smoke`，Rust `status:"ok"` 已要求 runtime/render 均 ok，但 row 279 仍是手工项”推进到“`pnpm test:desktop-plugin-runtime-smoke-binding` 约束 Web preview `initialPluginHostSmokeAction()` 只有 `pluginHostSmoke` 参数才构造预览插件、不会在 `?parity=1` 触发真实插件搜索或 `activate_feature`，并约束 Rust desktop smoke 总状态必须依赖 `plugin_runtime_smoke.ok()` 与 `plugin_panel_render_smoke.ok()`，parser 也会拒绝缺少 `feature_activated`、`plugin_path_exists`、`fs_load`、`iframe_srcdoc_loaded` 等关键字段”。红灯落在 row 279 未勾选；修复后 macOS smoke checklist closure 从 276/290 (95.2%) 提升到 277/290 (95.5%)。剩余相关区域仍是真实第三方插件逐项视觉/交互 replay、side-effecting native bridge replay、真实托盘/热键/自启人工项、签名公证、自动更新和首启发布检查。

**Batch 381 current delta:** 插件返回搜索 row 从“`PluginPanel` 返回按钮已调用 lifecycle-aware `closePluginPanel()` 并触发 `onclose`，但 App 层仍复用普通 `onEscape` 分支，未显式把 shell panel 拉回主搜索，row 333 仍是手工项”推进到“`pnpm test:plugin-back-to-search` 约束返回按钮先派发 `onPluginOut`、App 使用 `returnPluginToSearch()` 集中清理 `activePlugin`、`activePanel`、query/results、pasted intake、remote search 状态并聚焦搜索框，同时要求插件模式 `Esc` 复用同一路径，row 333 必须勾选”。红灯先落在缺少 `returnPluginToSearch()`，修复后落在 row 333 未勾选；文档闭环后 macOS smoke checklist closure 从 275/290 (94.8%) 提升到 276/290 (95.2%)。剩余相关区域仍是真实桌面点击回放、live 搜索 UI 激活、签名公证、自动更新和首启发布检查。

**Batch 380 current delta:** 内置颜色插件 row 从“`color-picker/preload.js` 已能解析 HEX/RGB/HSL 并通过 `utools.outPlugin` 返回转换结果或无法识别行，但 row 332 仍是手工项”推进到“`pnpm test:builtin-color-plugin` 通过 VM-backed `utools` stub 真实执行内置 color preload，约束 manifest 搜索触发词包含 `颜色` / `color` / `颜色转换` 和 HEX regex、plugin-enter HEX payload 输出 HEX/RGB/HSL 三行、subInput RGB 输入输出 HEX/RGB/HSL 三行、非法输入输出 `无法识别的颜色格式` 且空 subInput 清空输出，并要求 row 332 必须勾选”。红灯落在 row 332 未勾选；修复后 macOS smoke checklist closure 从 274/290 (94.5%) 提升到 275/290 (94.8%)。剩余相关区域仍是 live 搜索 UI 激活、插件返回搜索、签名公证和自动更新。

**Batch 379 current delta:** 内置 JSON 插件 row 从“`json-viewer/preload.js` 已能 `JSON.parse` payload/subInput 并通过 `utools.outPlugin` 返回格式化/压缩结果或错误行，但 row 331 仍是手工项”推进到“`pnpm test:builtin-json-plugin` 通过 VM-backed `utools` stub 真实执行内置 JSON preload，约束 manifest 搜索触发词包含 `json` / `json格式化` / `格式化json`、plugin-enter payload 输出 `格式化 JSON` 和 `压缩 JSON` 两行、subInput 输入数组同样输出格式化/压缩结果、非法 JSON 输出 `JSON 格式错误` 且空 subInput 清空输出，并要求 row 331 必须勾选”。红灯先暴露了 VM cross-realm `deepEqual` 误判，修正测试归一化后红灯落在 row 331 未勾选；修复后 macOS smoke checklist closure 从 273/290 (94.1%) 提升到 274/290 (94.5%)。剩余相关区域仍是 live 搜索 UI 激活、颜色插件输出、插件返回搜索、签名公证和自动更新。

**Batch 378 current delta:** ZTools 导入后 feature 搜索 row 从“`import_ztools_plugins()` 已调用 `db.index_features()` 且 `commands::search_features` 使用 `db.all_features()` + `matcher::search_all()`，但 row 344 仍是手工项”推进到“`cargo test -p atools --test ztools_import_tests imported_ztools_plugin_feature_can_be_searched` 同时约束导入后 `db.all_features()` 可被 `matcher::search_all("图片批处理")` 搜到，返回 `feature_code == "image-batch"`、`plugin_id == "image-batch-studio"`、`match_type == "exact"`、`score == SCORE_EXACT`，并要求 row 344 必须勾选”。红灯落在 row 344 未勾选；修复后 macOS smoke checklist closure 从 272/290 (93.8%) 提升到 273/290 (94.1%)。剩余相关区域仍是 live 搜索 UI 激活、自带 JSON/color 插件流、签名公证和自动更新。

**Batch 377 current delta:** ZTools 导入后插件管理列表 row 从“`import_ztools_plugins()` 已保存插件并索引 feature，但 Rust 测试未显式约束 `list_plugins()` 可见性，row 343 仍是手工项”推进到“`cargo test -p atools --test ztools_import_tests import_ztools_plugin_copies_directory_and_indexes_feature` 同时约束导入后 `db.list_plugins()` 返回 `image-batch-studio`，并保留插件 id/name、版本、enabled 状态和安装路径，同时要求 row 343 必须勾选”。红灯落在 row 343 未勾选；修复后 macOS smoke checklist closure 从 271/290 (93.4%) 提升到 272/290 (93.8%)。剩余相关区域仍是 live Settings panel refresh after import、插件 feature 搜索、自带 JSON/color 插件流、签名公证和自动更新。

**Batch 376 current delta:** ZTools 本机目录选择 row 从“`ZToolsImportPanel.chooseAndScan()` 已调用 Tauri dialog `open({ directory: true, multiple: false })` 并把选中路径传给 `scan_ztools_plugins`，但 row 339 仍是手工项”推进到“`pnpm test:ztools-import-view` 同时约束导入面板从 `@tauri-apps/plugin-dialog` 引入 `open`、目录 picker 参数为单选目录、取消选择时直接 return、选中目录作为 `root` 传入 `scan_ztools_plugins`、扫描后只预选无错误候选并清空旧报告，并要求 row 339 必须勾选”。红灯落在 row 339 未勾选；修复后 macOS smoke checklist closure 从 270/290 (93.1%) 提升到 271/290 (93.4%)。剩余相关区域仍是 live interactive dialog selection、导入后插件 inventory/searchability、自带 JSON/color 插件流、签名公证和自动更新。

**Batch 375 current delta:** ZTools 打开导入面板 row 从“首页快捷入口、`HomePanel`、`App.svelte` 和 `SystemPanel` 已有 `panel: "import"` 路由链，但 row 337 仍是手工项”推进到“`pnpm test:ztools-import-view` 同时约束 `home:import-ztools` 指向 `import` panel、`HomePanel.activateQuickAction()` 通过 `onpanelchange(action.panel)` 打开面板、`App.svelte` 将 home panel change 写入 active shell panel、`SystemPanel` 在 `panel === "import"` 时渲染 `ZToolsImportPanel`，并要求 row 337 必须勾选”。红灯落在 row 337 未勾选；修复后 macOS smoke checklist closure 从 269/290 (92.8%) 提升到 270/290 (93.1%)。剩余相关区域仍是真实桌面点击 smoke、真实目录选择、导入后插件 inventory/searchability、自带 JSON/color 插件流、签名公证和自动更新。

**Batch 374 current delta:** ZTools 导入报告 row 从“`ztoolsImportReportView()` 已能产出 imported/skipped/failed 三类 rows、summary 和 hasFailures，但组件层报告标题/摘要/row kind/detail/path 未显式守护，row 342 仍是手工项”推进到“`pnpm test:ztools-import-view` 同时约束 imported/skipped/failed/total 统计、三类 row 的 kind/title/detail/path、失败项 `manifest parse failed` 原因、组件 `导入报告` 标题、成功/跳过/失败摘要、`report-row ${kind}` class、row detail/path，并要求 row 342 必须勾选”。红灯落在 row 342 未勾选；修复后 macOS smoke checklist closure 从 268/290 (92.4%) 提升到 269/290 (92.8%)。剩余相关区域仍是 live shell 打开导入面板、真实目录选择、导入后插件 inventory/searchability、自带 JSON/color 插件流、签名公证和自动更新。

**Batch 373 current delta:** ZTools 导入 checkbox 选择 row 从“`ZToolsImportPanel` 已用 `disabled={!row.selectable}` 禁用不可导入项，并有 `selectAllImportable()` / `clearSelection()`，但 row 341 仍是手工项”推进到“`pnpm test:ztools-import-view` 同时约束 blocked candidate 即使在 selected set 中也保持未选中、全选可导入只选择 selectable rows、清空选择 selected count 归零、组件源码保留 disabled blocked checkbox 和 `全选可导入` / `清空选择` 控件，并要求 row 341 必须勾选”。红灯落在 row 341 未勾选；修复后 macOS smoke checklist closure 从 267/290 (92.1%) 提升到 268/290 (92.4%)。剩余相关区域仍是真实目录选择、导入报告结果、导入后插件 inventory/searchability、自带 JSON/color 插件流、签名公证和自动更新。

**Batch 372 current delta:** ZTools 导入候选统计/明细 row 从“`scripts/test-ztools-import-view.mjs` 已验证候选 summary chips、ready/warning/blocked 行和 warning/error messages，但缺失标记、状态胶囊和 selected count UI 未显式守护，row 340 仍是手工项”推进到“`pnpm test:ztools-import-view` 同时约束候选/可导入/已选/警告/错误统计、features 总数、候选标题/副标题、ready/warning/blocked 状态、warnings/errors、missingFlags、summary chip、status pill、flag/message list 和 `导入 ${selected} 个插件` selected count，并要求 row 340 必须勾选”。红灯落在 row 340 未勾选；修复后 macOS smoke checklist closure 从 266/290 (91.7%) 提升到 267/290 (92.1%)。剩余相关区域仍是真实目录选择、全选/清空 checkbox 行为、导入报告结果、导入后插件 inventory/searchability、自带 JSON/color 插件流、签名公证和自动更新。

**Batch 371 current delta:** ZTools 导入未扫描空态 row 从“`ZToolsImportPanel` 空候选时显示 `等待扫描`，且候选统计/list/action 被 `candidates.length > 0` 包裹、导入报告被 `reportView` 包裹，但 row 338 仍是手工项”推进到“`pnpm test:ztools-import-view` 同时约束空 import view 为 0 候选/0 可导入/0 已选/0 warning/0 blocked/0 features、无候选行、空态文案正确、源码只在有候选/有报告时渲染候选统计/候选行/报告，并要求 row 338 必须勾选”。红灯落在 row 338 未勾选；修复后 macOS smoke checklist closure 从 265/290 (91.4%) 提升到 266/290 (91.7%)。剩余相关区域仍是真实目录选择、候选统计和明细、导入报告结果、导入后插件 inventory/searchability、自带 JSON/color 插件流、签名公证和自动更新。

**Batch 370 current delta:** 默认设置恢复 row 从“`src/lib/settings.ts` 默认值已是 `theme: system`、`primaryColor: purple`、`showRecentInSearch: true`、`recentRows: 2`，`SettingsPanel.resetSettings()` 已调用 `applySettings(DEFAULT_ATOOLS_SETTINGS)` 并 `persistSoon()`，但 row 144 仍是手工项”推进到“`pnpm test:settings-normalization` 同时约束默认恢复值、恢复默认按钮持久化路径，以及 row 144 必须勾选”。红灯落在 row 144 未勾选；修复后 Settings shell and navigation 从 88% 提升到 89%，macOS smoke checklist closure 从 264/290 (91.0%) 提升到 265/290 (91.4%)。剩余相关区域仍是真实桌面窗口居中、全局快捷键切换、托盘显示/隐藏、LaunchAgent、自带 JSON/color 插件流、ZTools 插件导入、签名公证和自动更新。

**Batch 369 current delta:** 插件运行态布局互斥 row 从“`scripts/test-plugin-host-smoke-browser.mjs` 已覆盖 output 模式 header/runtime/SubInput/body 不重叠、output layer 在 body 内且无 iframe；`scripts/test-plugin-iframe-context-menu.mjs` 已覆盖 iframe context smoke，但 row 330 仍是手工项”推进到“`pnpm test:plugin-host-smoke-browser` 约束 output 模式必须有 1 个 output layer、0 个 iframe body、无 header/runtime/SubInput/body overlap；`pnpm test:plugin-iframe-context-menu` 约束 iframe 模式必须有 iframe、0 个 output layer、0 行 output、无 header/runtime/body overlap 且无横向溢出，并约束 row 330 必须勾选”。红灯落在 row 330 未勾选；修复后 macOS smoke checklist closure 从 263/290 (90.7%) 提升到 264/290 (91.0%)。剩余相关区域仍是 JSON/color 插件流、真实 native detached BrowserWindow、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 368 current delta:** 插件 iframe 内 `contextmenu` 上报 row 从“`scripts/test-plugin-iframe-context-menu.mjs` 已有 VM 级桥接覆盖，证明 injected bridge 捕获 `contextmenu`、不调用 `preventDefault()`、向宿主发送 `__ipc_plugin_contextmenu__`，且 `PluginPanel` / `pluginHostView` / Web preview mode 均有源码守护，但 row 329 仍是手工项”推进到“`pnpm test:plugin-iframe-context-menu` 同时启动真实 Browser smoke `?parity=1&pluginHostSmoke=iframeContext`，验证 iframe mode 无 output rows，右键 iframe 内按钮区域后 runtime strip 出现 `右键菜单 / iframe button`，并约束 row 329 必须勾选”。红灯落在 row 329 未勾选；修复后 macOS smoke checklist closure 从 262/290 (90.3%) 提升到 263/290 (90.7%)。剩余相关区域仍是 output/iframe layout、JSON/color 插件流、真实 native detached BrowserWindow、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 367 current delta:** 插件 output 行右键菜单 row 从“`scripts/test-plugin-output-context-menu.mjs` 已有源码级右键菜单、`复制结果` 和 Escape capture 守护，但 Web preview 未实际点击菜单项验证复制反馈，且 row 328 仍是手工项”推进到“`pnpm test:plugin-host-smoke-browser` 右键选中的时间戳输出行，断言 `复制结果` 菜单出现；按 Esc 后只关闭菜单且仍停留在插件态；再次右键并点击菜单项后，clipboard write path 收到 `1710000000000`，输出层切到 `已复制 / 1710000000000` 反馈行；`pnpm test:plugin-output-context-menu` 同时约束本地 `copiedItem` 反馈状态和 row 328 必须勾选”。本批红灯先落在复制反馈仍保持 2 行 output，随后落在 row 328 未勾选；修复后 macOS smoke checklist closure 从 261/290 (90.0%) 提升到 262/290 (90.3%)。剩余相关区域仍是 iframe context-menu 行为、output/iframe layout、JSON/color 插件流、真实 native detached BrowserWindow、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 366 current delta:** 输入时间戳/日期后的插件输出选择 row 从“`scripts/test-plugin-host-smoke-browser.mjs` 已通过 Web preview `pluginHostSmoke=1` 覆盖时间戳 fixture 的 2 个 output row、运行状态条 `方向键选择，Enter 复制`、选中行 `Enter 复制` hint 和无 layout overlap，但 row 327 仍是手工项”推进到“`pnpm test:plugin-host-smoke-browser` 约束 row 327 必须勾选，且继续声明 `输入时间戳/日期`、插件输出列表可选和 `Enter 复制`；该 Browser smoke 还会聚焦 SubInput、发送 ArrowDown，并确认 `Enter 复制` 从第一行移动到第二行”。红灯落在 row 327 未勾选；修复后 macOS smoke checklist closure 从 260/290 (89.7%) 提升到 261/290 (90.0%)。剩余相关区域仍是插件 output 右键菜单、iframe context-menu 行为、output/iframe layout、JSON/color 插件流、真实 native detached BrowserWindow、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 365 current delta:** 插件侧 `getCopyedFiles` / `getCopiedFiles` CopiedFile 对象形态 row 从“`scripts/test-plugin-copied-files-shape.mjs` 已覆盖 path-list native result 归一化、对象 result extra field 保留、`getCopiedFiles` 通过 typo bridge method 路由、injected bridge `_normalizeCopiedFiles`、host `normalizeCopiedFileEntries(output.split(...))` 和 shared capability inventory，但 row 326 仍是手工项”推进到“`pnpm test:plugin-copied-files-shape` 约束 row 326 必须勾选，且继续声明 `CopiedFile[]`、`path`、`name`、`isFile` 和官方 typo 字段 `isDiractory`”。红灯落在 row 326 未勾选；修复后 macOS smoke checklist closure 从 259/290 (89.3%) 提升到 260/290 (89.7%)。剩余相关区域仍是插件 output 交互、iframe context-menu 行为、真实 native detached BrowserWindow、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 364 current delta:** 插件 `onPluginOut` 宿主退出生命周期 row 从“`PluginPanel` 已通过 postMessage 生命周期事件覆盖宿主返回、iframe `__ipc_close__`、Web preview close 和 Svelte `onDestroy` fallback，`scripts/test-plugin-events-bridge.mjs` 也约束 injected bridge 接收 `atools-plugin-out` 并向 `onPluginOut(callback)` 传递官方 `isKill` boolean，但 row 325 仍是手工项”推进到“`pnpm test:plugin-events-bridge` 约束 row 325 必须勾选，且继续声明 `atools-plugin-out`、`isKill:false`、`isKill:true` 和 `onPluginOut(callback)`”。本批同时把旧源码正则从过时的 direct `detail: { isKill }` 形态调整为当前 `postPluginLifecycleEvent("plugin-out", { isKill })` 语义守护。红灯落在 row 325 未勾选；修复后 macOS smoke checklist closure 从 258/290 (89.0%) 提升到 259/290 (89.3%)。剩余相关区域仍是复制文件对象形态、插件 output 交互、真实 native detached BrowserWindow、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 363 current delta:** BrowserWindow Web preview incremental document/parent row `?parity=1&pluginHostSmoke=browserWindow` 从“hosted BrowserWindow `isNormal()` / `isModal()` / `setDocumentEdited()` / `isDocumentEdited()` / `setRepresentedFilename()` / `getRepresentedFilename()` / `setParentWindow()` / `getParentWindow()` / `getChildWindows()` 已在 row 315 分项约束 bridge、host action、void-return、sync getter、parent-child handle set/reset 和 App marker，但 aggregate row 324 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 row 324 必须勾选，且继续声明 `data-browser-window-document-parent-state="true"`、`data-browser-window-parent-child-state="true"`，并和 titlebar/material、menu-bar、background-color、waiting-response、navigationHistory、focus/owner/media、crash-reload、lifecycle、runtime 及既有 BrowserWindow smoke marker 同时存在”。红灯落在 row 324 未勾选；修复后 macOS smoke checklist closure 从 257/290 (88.6%) 提升到 258/290 (89.0%)。剩余相关区域仍是插件退出生命周期、复制文件对象形态、真实 native detached BrowserWindow、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 362 current delta:** BrowserWindow Web preview incremental titlebar/material row `?parity=1&pluginHostSmoke=browserWindow` 从“hosted BrowserWindow `setWindowButtonVisibility()` / `setWindowButtonPosition()` / `getWindowButtonPosition()` / `setVibrancy()` / `setBackgroundMaterial()` / `setSheetOffset()` 已在 row 314 分项约束 bridge、host action、void-return、sync `getWindowButtonPosition()`、null reset 和 App marker，但 aggregate row 323 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 row 323 必须勾选，且继续声明 `data-browser-window-titlebar-material-state="true"`，并和 menu-bar、background-color、waiting-response、navigationHistory、focus/owner/media、crash-reload、lifecycle、runtime 及既有 BrowserWindow smoke marker 同时存在”。红灯落在 row 323 未勾选；修复后 macOS smoke checklist closure 从 256/290 (88.3%) 提升到 257/290 (88.6%)。剩余相关区域仍是后续 BrowserWindow document aggregate row、真实 native detached BrowserWindow、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 361 current delta:** BrowserWindow Web preview incremental menu-bar row `?parity=1&pluginHostSmoke=browserWindow` 从“hosted BrowserWindow `setAutoHideMenuBar()` / `isMenuBarAutoHide()` / `setMenuBarVisibility()` / `isMenuBarVisible()` / `removeMenu()` / `setMenu()` 已在 row 313 分项约束 bridge、host action、void-return/sync getter、removed/null menu state 和 App marker，但 aggregate row 322 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 row 322 必须勾选，且继续声明 `data-browser-window-menu-bar-state="true"`，并和 background-color、waiting-response、navigationHistory、focus/owner/media、crash-reload、lifecycle、runtime 及既有 BrowserWindow smoke marker 同时存在”。红灯落在 row 322 未勾选；修复后 macOS smoke checklist closure 从 255/290 (87.9%) 提升到 256/290 (88.3%)。剩余相关区域仍是后续 BrowserWindow titlebar/document aggregate rows、真实 native detached BrowserWindow、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 360 current delta:** BrowserWindow Web preview incremental waiting/background row `?parity=1&pluginHostSmoke=browserWindow` 从“hosted `webContents.isWaitingForResponse()` 与 BrowserWindow `setBackgroundColor()` / `getBackgroundColor()` 已分别在 row 307 和 row 288 分项约束 bridge、host action、void-return/sync getter 与 App marker，但 aggregate row 321 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 row 321 必须勾选，且继续声明 `data-browser-window-webcontents-waiting-response="true"`、`data-browser-window-background-color="true"`，并和 navigationHistory、focus/owner/media、crash-reload、lifecycle、runtime 及既有 BrowserWindow smoke marker 同时存在”。红灯落在 row 321 未勾选；修复后 macOS smoke checklist closure 从 254/290 (87.6%) 提升到 255/290 (87.9%)。剩余相关区域仍是后续 BrowserWindow menu-bar/titlebar/document aggregate rows、真实 native detached BrowserWindow、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 359 current delta:** BrowserWindow Web preview incremental navigationHistory row `?parity=1&pluginHostSmoke=browserWindow` 从“hosted `webContents.navigationHistory.goToOffset(-1)` / `goForward()` / `clear()` 已在 row 306 分项约束 bridge、host action、void-return、sync can-go getter 和 App marker，但 aggregate row 320 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 row 320 必须勾选，且继续声明 `data-browser-window-navigation-history="true"`，并和 focus/owner/media、crash-reload、lifecycle、runtime 及既有 BrowserWindow smoke marker 同时存在”。红灯落在 row 320 未勾选；修复后 macOS smoke checklist closure 从 253/290 (87.2%) 提升到 254/290 (87.6%)。剩余相关区域仍是后续 WebContents waiting-response/background-color 增量 aggregate rows、真实 native detached BrowserWindow、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 358 current delta:** BrowserWindow Web preview incremental focus/owner/media row `?parity=1&pluginHostSmoke=browserWindow` 从“hosted `webContents.focus()` / `isFocused()` / `getOwnerBrowserWindow()` / `getMediaSourceId()` / `isBeingCaptured()` / `setIgnoreMenuShortcuts()` 已在 row 305 分项约束 bridge、host action、owner/media/shortcut 状态和 App marker，但 aggregate row 319 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 row 319 必须勾选，且继续声明 `data-browser-window-webcontents-focus-state="true"`、`data-browser-window-webcontents-owner-media="true"`，并和 crash-reload、lifecycle、runtime 及既有 BrowserWindow smoke marker 同时存在”。红灯落在 row 319 未勾选；修复后 macOS smoke checklist closure 从 252/290 (86.9%) 提升到 253/290 (87.2%)。剩余相关区域仍是后续 WebContents navigation-history/waiting-response/background-color 增量 aggregate rows、真实 native detached BrowserWindow、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 357 current delta:** BrowserWindow Web preview incremental crash row `?parity=1&pluginHostSmoke=browserWindow` 从“hosted `webContents.isCrashed()` / `forcefullyCrashRenderer()` / targeted `render-process-gone` 已在 row 304 分项约束 bridge、host action、crash detail 和 App marker，但 aggregate row 318 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 row 318 必须勾选，且继续声明 `data-browser-window-render-process-gone="true"`、`data-browser-window-webcontents-crash="true"`、`data-browser-window-webcontents-crash-reload="true"`，并和 lifecycle、runtime 及既有 BrowserWindow smoke marker 同时存在”。红灯落在 row 318 未勾选；修复后 macOS smoke checklist closure 从 251/290 (86.6%) 提升到 252/290 (86.9%)。剩余相关区域仍是后续 WebContents focus/navigation-history/waiting-response/background-color 增量 aggregate rows、真实 native detached BrowserWindow、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 356 current delta:** BrowserWindow Web preview incremental lifecycle row `?parity=1&pluginHostSmoke=browserWindow` 从“hosted `webContents.loadURL()` / `reload()` / `stop()` / `isDestroyed()` / `getType()` 已在 row 303 分项约束 bridge、host action 和 App marker，但 aggregate row 317 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 row 317 必须勾选，且继续声明 `data-browser-window-webcontents-load-url="true"`、`data-browser-window-webcontents-lifecycle="true"`，并和 runtime、capture/export、selection/scroll、edit、inspect、audio、zoom、DevTools、IPC、find-in-page、CSS insert/remove、always-on-top 等既有 App smoke marker 同时存在”。红灯落在 row 317 未勾选；修复后 macOS smoke checklist closure 从 250/290 (86.2%) 提升到 251/290 (86.6%)。剩余相关区域仍是后续 WebContents crash/focus/navigation-history/waiting-response/background-color 增量 aggregate rows、真实 native detached BrowserWindow、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 355 current delta:** BrowserWindow Web preview aggregate `?parity=1&pluginHostSmoke=browserWindow` 从“基础 BrowserWindow/WebContents hosted smoke 已经分项覆盖 URL navigation、visibility/event listener、content-size/min-max/aspect-ratio、fullscreen、appearance cleanup、system/focus/progress/z-order/always-on-top、IPC、executeJavaScript、sendInputEvent、CSS insert/remove、find-in-page、navigation/history、DevTools、inspect、capture/print/save、runtime state、edit/selection、audio、focus/owner/media 和 zoom，但 aggregate row 316 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 row 316 必须勾选，并继续包含关键 BrowserWindow/WebContents API token 与对应 App smoke DOM marker”。红灯落在 row 316 未勾选；修复后 macOS smoke checklist closure 从 249/290 (85.9%) 提升到 250/290 (86.2%)。剩余相关区域仍是后续 WebContents lifecycle/crash/focus/navigation-history/waiting-response 增量 aggregate rows、真实 native detached BrowserWindow、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 354 current delta:** BrowserWindow hosted `isNormal()` / `isModal()` / `setDocumentEdited()` / `isDocumentEdited()` / `setRepresentedFilename()` / `getRepresentedFilename()` / `setParentWindow()` / `getParentWindow()` / `getChildWindows()` 从“handle VM、宿主 action 和 Web preview 基础 document/parent smoke 已有 method exposure、normal/modal 初始值、document/representedFilename void-return setter 与 sync getter、parent handle set/reset、child handles 和 parent-child App smoke 标记覆盖，但 row 315 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须通过 `data-browser-window-document-parent-state` 与 `data-browser-window-parent-child-state` 验证 document state、represented filename、normal/modal、parent set/reset 和 child handle derivation”。同一测试还约束 bridge `syncBrowserWindowDocumentParentState()`、`browserWindowSetParentWindow()`、`browserWindowGetChildWindows()` 继续维护 hosted parent ids 与 handle 映射，host `isNormal` / `isModal` / `setDocumentEdited` / `setRepresentedFilename` / `setParentWindow` / `getParentWindow` / `getChildWindows` action 继续返回完整 document/parent state。红灯落在 row 315 未勾选；修复后 macOS smoke checklist closure 从 248/290 (85.5%) 提升到 249/290 (85.9%)。剩余相关区域仍是 BrowserWindow Web preview aggregate rows、native macOS document proxy icon、dirty-dot integration、sheet/modal session、NSWindow parent/child lifetime、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 353 current delta:** BrowserWindow hosted `setWindowButtonVisibility()` / `setWindowButtonPosition()` / `getWindowButtonPosition()` / `setVibrancy()` / `setBackgroundMaterial()` / `setSheetOffset()` 从“handle VM、宿主 action 和 Web preview 基础 titlebar/material smoke 已有 method exposure、setter void-return、`getWindowButtonPosition()` sync getter、`setWindowButtonPosition(null)` reset、vibrancy/background material/sheet offset 覆盖，但 row 314 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须通过 `data-browser-window-titlebar-material-state` 验证 window button visibility、position set/read/reset、vibrancy set/clear、background material 和 sheet offset 的组合路径”。同一测试还约束 bridge `syncBrowserWindowTitlebarMaterialState()`、`browserWindowSetWindowButtonPosition()` 和 sync getter 继续维护 hosted position copy/null reset，host `setWindowButtonVisibility` / `setWindowButtonPosition` / `getWindowButtonPosition` / `setVibrancy` / `setBackgroundMaterial` / `setSheetOffset` action 继续返回完整 titlebar/material state。红灯落在 row 314 未勾选；修复后 macOS smoke checklist closure 从 247/290 (85.2%) 提升到 248/290 (85.5%)。剩余相关区域仍是 BrowserWindow document/Web preview aggregate rows、native macOS traffic lights、NSVisualEffectView vibrancy、WindowServer material/compositor、real sheet attachment point、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 352 current delta:** BrowserWindow hosted `setAutoHideMenuBar()` / `isMenuBarAutoHide()` / `setMenuBarVisibility()` / `isMenuBarVisible()` / `removeMenu()` / `setMenu()` 从“handle VM、宿主 action 和 Web preview 基础 menu-bar smoke 已有 method exposure、void-return setter/remove/setMenu、sync getter、removed/visible cache、`removeMenu()` 隐藏和 `setMenu(menu)` 恢复覆盖，但 row 313 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须通过 `data-browser-window-menu-bar-state` 验证 `setAutoHideMenuBar(true)`、`setMenuBarVisibility(false)`、`removeMenu()`、`setMenu({ items: [...] })` 的 void-return 与同步 getter 组合路径”。同一测试还约束 bridge `syncBrowserWindowMenuBarState()`、`browserWindowRemoveMenu()`、`browserWindowSetMenu()` 继续维护 hosted removed/visible cache，host `setAutoHideMenuBar` / `setMenuBarVisibility` / `removeMenu` / `setMenu` action 继续返回完整 menu-bar state。红灯落在 row 313 未勾选；修复后 macOS smoke checklist closure 从 246/290 (84.8%) 提升到 247/290 (85.2%)。剩余相关区域仍是 BrowserWindow titlebar/document/Web preview aggregate rows、native app menu rendering、Electron Menu object semantics、platform menu accelerators、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 351 current delta:** BrowserWindow hosted `setBounds()` / `setSize()` / `setPosition()` / `center()` geometry events 从“handle VM、宿主 action 和 Web preview 基础 geometry smoke 已有 `resize` / one-shot `move` 监听、`setBounds()` bounds readback、hosted `dispatchPluginBrowserWindowEvent()` resize/move 派发覆盖，但 row 312 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须注册 `win.on('resize')` 和 `win.once('move')`，并通过 `setBounds({ x: 24, y: 32, width: 420, height: 260 })` 验证 resize/move payload 与 `data-browser-window-bounds` readback”。同一测试还约束 host `setBounds` 继续派发 `resize` 和 `move`，`setSize` 继续派发 `resize`，`setPosition` / `center` 继续派发 `move`。红灯落在 row 312 未勾选；修复后 macOS smoke checklist closure 从 245/290 (84.5%) 提升到 246/290 (84.8%)。剩余相关区域仍是 BrowserWindow menu/titlebar rows、Web preview aggregate rows、真实 OS window-manager geometry events、native detached BrowserWindow geometry、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 350 current delta:** BrowserWindow hosted `webContents.setAudioMuted(muted)` / `isAudioMuted()` / `isCurrentlyAudible()` 从“handle VM、宿主 action 和 Web preview 基础 audio smoke 已有 method exposure、初始 getter、targeted `audio-state-changed`、void-return mute/unmute 和 async host response 覆盖，但 row 311 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须通过 `data-browser-window-audio-initial`、`data-browser-window-audio-muted` 和 `data-browser-window-audio-unmuted` 验证 hosted audio state 的 sync getter 和 `setAudioMuted(true/false)` void-return 组合路径”。同一测试还约束 VM targeted `audio-state-changed` 事件必须同步 `event.audible` 与 boolean listener argument，bridge `emitWebContentsEvent()`、`syncWebContentsAudioState()`、`syncWebContentsAudioEvent()` 和 `webContentsSetAudioMuted()` 继续维护 muted/audible cache，host `pluginBrowserWindowAudioResult()`、`updatePluginBrowserWindowAudioMuted()` 和 `dispatchPluginBrowserWindowWebContentsEvent(..., "audio-state-changed", [currentlyAudible])` 继续派发 WebContents audio 事件。红灯落在 row 311 未勾选；修复后 macOS smoke checklist closure 从 244/290 (84.1%) 提升到 245/290 (84.5%)。剩余相关区域仍是 BrowserWindow geometry/menu rows、Web preview aggregate rows、真实 Chromium media audibility pipeline、native media session integration、actual playback detection、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 349 current delta:** BrowserWindow hosted `webContents.setZoomFactor(factor)` / `getZoomFactor()` / `setZoomLevel(level)` / `getZoomLevel()` / `setVisualZoomLevelLimits(minimumLevel, maximumLevel)` 从“handle VM、宿主 action 和 Web preview 基础 zoom smoke 已有 method exposure、初始 getter、void-return setter、factor/level 转换、visual zoom limits 和 child iframe transform 覆盖，但 row 310 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须通过 `data-browser-window-zoom-factor`、`data-browser-window-zoom-level` 和 `data-browser-window-visual-zoom-limits` 验证 `setZoomFactor(1.5)` / `setZoomLevel(-1)` / `setVisualZoomLevelLimits(0.5, 3)` 组合路径”。同一测试还约束 bridge `zoomLevelFromFactor()` / `zoomFactorFromLevel()`、正数 finite factor 校验、finite level 校验、setter 同步更新 factor/level getter cache、visual zoom limits Promise resolve `undefined`，host `pluginBrowserWindowZoomResult()`、`updatePluginBrowserWindowZoomFactor()`、`updatePluginBrowserWindowZoomLevel()`、`updatePluginBrowserWindowVisualZoomLimits()` 和 `pluginBrowserWindowFrameStyle()` 继续维护 hosted zoom state 并通过 CSS scale 呈现。红灯落在 row 310 未勾选；修复后 macOS smoke checklist closure 从 243/290 (83.8%) 提升到 244/290 (84.1%)。剩余相关区域仍是 BrowserWindow audio row、Web preview aggregate rows、真实 Chromium page zoom/pinch zoom/per-frame zoom semantics、native accessibility zoom integration、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 348 current delta:** BrowserWindow hosted `webContents.centerSelection()` / `scrollToTop()` / `scrollToBottom()` / `adjustSelection({ start, end })` 从“handle VM、宿主 action 和 Web preview 基础 selection/scroll smoke 已有 method exposure、void-return command routing、input/textarea selection range 调整、contenteditable best-effort 调整和 hosted document scroll 覆盖，但 row 309 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须通过 `data-browser-window-selection-scroll-commands`、`data-browser-window-adjust-selection` 和 `data-browser-window-scroll-top` 验证 `centerSelection()`、`adjustSelection({ start: 1, end: -1 })`、`scrollToBottom()`、`scrollToTop()` 组合路径”。同一测试还约束 bridge 暴露并归一化 selection/scroll methods，host `scrollPluginBrowserWindowDocument()`、`centerPluginBrowserWindowSelection()`、`adjustPluginBrowserWindowSelectionRange()` 和 `controlPluginBrowserWindowSelection()` 继续覆盖文档滚动、focused editable selection、input/textarea deterministic range 和 contenteditable best-effort `Selection.modify` 路径。红灯落在 row 309 未勾选；修复后 macOS smoke checklist closure 从 242/290 (83.4%) 提升到 243/290 (83.8%)。剩余相关区域仍是 BrowserWindow zoom/audio rows、Web preview aggregate rows、真实 Chromium selection pipeline、跨 frame selection routing、native scroll integration、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 347 current delta:** BrowserWindow hosted `webContents.insertText(text)` 与 `undo()` / `redo()` / `cut()` / `copy()` / `paste()` / `pasteAndMatchStyle()` / `delete()` / `selectAll()` / `unselect()` / `replace(text)` / `replaceMisspelling(text)` 从“handle VM、宿主 action 和 Web preview 基础 editing smoke 已有 method exposure、`insertText()` Promise resolve undefined、void-return command routing、focused editable target 写入和 hosted 本地 edit clipboard 覆盖，但 row 308 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须通过 `data-browser-window-insert-text`、`data-browser-window-edit-commands` 和 `data-browser-window-edit-value` 验证 `insertText('hosted edit')`、`selectAll()`、`copy()`、`cut()`、`paste()` 组合路径”。同一测试还约束 bridge 暴露全部 editing methods，host `editPluginBrowserWindowTextCommand()` 继续把 copy/cut/paste 绑定到 `pluginBrowserWindowEditClipboard`，replace/replaceMisspelling 写入 focused editable target，undo/redo 路由到 child document editing stack。红灯落在 row 308 未勾选；修复后 macOS smoke checklist closure 从 241/290 (83.1%) 提升到 242/290 (83.4%)。剩余相关区域仍是 BrowserWindow selection/scroll row、zoom/audio rows、Web preview aggregate rows、真实 Chromium editing stack、系统剪贴板、IME、spellchecker、native undo/redo history、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 346 current delta:** BrowserWindow hosted `webContents.isWaitingForResponse()` 从“handle VM、宿主 action 和 Web preview waiting-response smoke 已有默认 false、`loadURL()` pending true、host response false、`stop()` false 覆盖，但 row 307 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须通过 `data-browser-window-webcontents-waiting-response` 记录 pending 期间 `isWaitingForResponse()` 为 true，hosted response 完成后回到 false，并且 lifecycle smoke 中 `stop()` 后 `isWaitingForResponse()` 也为 false”。同一测试还约束 bridge `webContentsNavigationAction()` 在发起 hosted navigation 时同步设置 waiting/loading cache，resolve/reject 时清理，`syncWebContentsNavigationState()` 从 host result 同步 `record.loading`，`isWaitingForResponse()` 直接读取 hosted loading cache，`webContentsStop()` 和 host `stopPluginBrowserWindowLoading()` 继续清理 hosted loading/waiting state。红灯落在 row 307 未勾选；修复后 macOS smoke checklist closure 从 240/290 (82.8%) 提升到 241/290 (83.1%)。剩余相关区域仍是 BrowserWindow editing rows、Web preview waiting/background aggregate row、真实 Chromium network first-response/cross-frame wait semantics、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 345 current delta:** BrowserWindow hosted `webContents.navigationHistory.canGoBack()` / `canGoForward()` / `goBack()` / `goForward()` / `goToIndex(index)` / `canGoToOffset(offset)` / `goToOffset(offset)` / `clear()` 从“handle VM、宿主 action 和 Web preview navigationHistory smoke 已有 method exposure、void-return action、sync can-go state、index/offset routing 和 `clear()` 折叠覆盖，但 row 306 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须记录 `data-browser-window-navigation-history`，验证 `goToOffset(-1)` / `goForward()` / `clear()` 均保持 void-return shape，后退/前进后 URL 与 `canGoBack()` / `canGoForward()` 同步，`clear()` 后 hosted history 折叠为当前 entry”。同一测试还约束 bridge `navigationHistory` 暴露 `canGoBack()`、`canGoForward()`、`goBack()`、`goForward()`、`goToIndex()`、`canGoToOffset()`、`goToOffset()`、`clear()`，host 继续路由 `webContents.navigationHistory.*` action，并在 index/offset navigation 完成时同步 title/history/loading/crashed state。红灯落在 row 306 未勾选；修复后 macOS smoke checklist closure 从 239/290 (82.4%) 提升到 240/290 (82.8%)。剩余相关区域仍是 BrowserWindow waiting-response row、真实 Chromium session history/WebView cache clearing/cross-frame history semantics、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 344 current delta:** BrowserWindow hosted `webContents.focus()` / `isFocused()` / `getOwnerBrowserWindow()` / `getMediaSourceId()` / `isBeingCaptured()` / `setIgnoreMenuShortcuts()` 从“handle VM、宿主 action 和 Web preview focus/owner/media smoke 已有 void-return、同步 getter、owner handle、hosted media source id、capture false 和 shortcut state 覆盖，但 row 305 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须记录 `data-browser-window-webcontents-focus-state` 与 `data-browser-window-webcontents-owner-media`，验证 `focus()` 保持 void-return shape 并让 `isFocused()` 同步为 true，`setIgnoreMenuShortcuts(true)` 保持 void-return shape，owner 返回当前 hosted BrowserWindow handle，`getMediaSourceId()` 匹配 hosted compatibility id，`isBeingCaptured()` 为 false”。同一测试还约束 bridge 初始化 `webContentsMediaSourceId`、`webContentsFocused`、shortcut cache，`webContentsFocus()` / `webContentsSetIgnoreMenuShortcuts()` 先同步更新 cache，host `focusPluginBrowserWindowWebContents()` 设置 `visible/focused/webContentsFocused` 并派发 hosted `focus` event，`setPluginBrowserWindowIgnoreMenuShortcuts()` 归一化并记录 shortcut action。红灯落在 row 305 未勾选；修复后 macOS smoke checklist closure 从 238/290 (82.1%) 提升到 239/290 (82.4%)。剩余相关区域仍是 BrowserWindow navigationHistory rows、waiting-response row、真实 OS focus/DesktopCapturerSource/tab capture/native shortcut semantics、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 343 current delta:** BrowserWindow hosted `webContents.isCrashed()` / `forcefullyCrashRenderer()` / targeted `render-process-gone` 从“handle VM、宿主 action 和 Web preview crash smoke 已有同步 crash cache、targeted event details、reload/loadURL 清理 crash state 覆盖，但 row 304 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须记录 `data-browser-window-render-process-gone`、`data-browser-window-webcontents-crash`、`data-browser-window-webcontents-crash-reload`，验证 `forcefullyCrashRenderer()` 保持 void-return shape 并同步让 `isCrashed()` 为 true，targeted `render-process-gone` details 为 `{ reason: 'crashed', exitCode: 1 }`，随后 `reload()` 返回 `reloaded=true` 且清理 hosted crashed state”。同一测试还约束 bridge `webContentsForcefullyCrashRenderer()` 先同步标记 crash cache、targeted `render-process-gone` event 更新 cache，host `forcefullyCrashPluginBrowserWindowRenderer()` 设置 `loading=false/crashed=true`、派发 targeted WebContents event，并且 hosted `loadURL` / `reload` 会把 `crashed` 重置为 false。红灯落在 row 304 未勾选；修复后 macOS smoke checklist closure 从 237/290 (81.7%) 提升到 238/290 (82.1%)。剩余相关区域仍是 BrowserWindow focus/owner/media rows、waiting-response row、真实 Chromium renderer termination/Electron crash semantics、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 342 current delta:** BrowserWindow hosted `webContents.loadURL(url[, options])` / `reload()` / `stop()` / `isDestroyed()` / `getType()` 从“handle VM、宿主 action 和 Web preview lifecycle smoke 已有 load/reload/stop 路由、loading/waiting 清理、destroyed/type getter 覆盖，但 row 303 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须通过固定 lifecycle 替换链记录 `data-browser-window-webcontents-load-url` 与 `data-browser-window-webcontents-lifecycle`，验证 `webContents.loadURL('child-webcontents.html')` 更新返回 URL 和 sync URL cache，`webContents.reload()` 返回 `reloaded=true`，`webContents.stop()` 保持 void-return shape 并同步清理 loading/loading-main-frame/waiting-response，`webContents.isDestroyed()` 在当前 live hosted child 上为 false，`webContents.getType()` 返回 `window`”。同一测试还约束 bridge `loadURL` / `reload` / `stop` 继续走 hosted navigation action、host `webContents.loadURL` / `reload` 继续调用 `loadPluginBrowserWindowUrl()`、`stop` 继续调用 `stopPluginBrowserWindowLoading()`。红灯先落在 lifecycle replacement 计数测试过宽，修正后落在 row 303 未勾选；修复后 macOS smoke checklist closure 从 236/290 (81.4%) 提升到 237/290 (81.7%)。剩余相关区域仍是 BrowserWindow crash rows、waiting-response row、真实 Chromium network lifecycle fidelity、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 341 current delta:** BrowserWindow hosted `webContents.getUserAgent()` / `setUserAgent(userAgent)`、`getFrameRate()` / `setFrameRate(fps)`、`getBackgroundThrottling()` / `setBackgroundThrottling(allowed)`、`getProcessId()` / `getOSProcessId()` 从“handle VM、宿主 action 和基础 Web preview smoke 已有默认值、void-return setter、同步 getter 与正整数 process identity 覆盖，但 row 302 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须通过固定替换点记录 `data-browser-window-runtime-defaults`、`data-browser-window-runtime-process`、`data-browser-window-runtime-setters` 与 aggregate `data-browser-window-runtime-state`，同时验证初始 userAgent 是可读字符串、frameRate 默认 60、backgroundThrottling 默认 true、setUserAgent/setFrameRate/setBackgroundThrottling 均保持 void-return shape 且 sync getter 立即可读，hosted `processId` / `osProcessId` 均为正整数且互不相等”。同一测试还约束 bridge 初始化 hosted process identity、host 使用 `browserWindowOSProcessId()` 生成和 renderer compatibility id 区分的 OS compatibility id，并通过 `pluginBrowserWindowRuntimeResult()` 返回完整 runtime payload。红灯先落在缺少 runtime smoke 替换绑定，随后落在 row 302 未勾选；修复后 macOS smoke checklist closure 从 235/290 (81.0%) 提升到 236/290 (81.4%)。剩余相关区域仍是 BrowserWindow lifecycle rows、crash rows、真实 Electron renderer/OS process identity、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 340 current delta:** BrowserWindow hosted `webContents.capturePage([rect, opts])` / `print([options], [callback])` / `printToPDF(options)` / `savePage(fullPath, saveType)` 从“handle VM、宿主 action 和基础 Web preview smoke 已有桥接、NativeImage-compatible data URL、explicit native-only print failure、PDF bytes 和 savePage void result 覆盖，但 row 301 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须通过固定替换点记录 `data-browser-window-capture-print-save-state`，同时验证 capturePage 的 data URL、requested 120x80 size 与 non-empty 状态，print callback 返回 `success=false` 且 failureReason 明确包含 native-only，printToPDF 返回 `%PDF` 字节头，savePage 仍保持 official void result”。同一测试还约束宿主继续生成 hosted child iframe snapshot、返回 `image/svg+xml` NativeImage-compatible payload、通过 `browserWindowMinimalPdfBytes()` 序列化 PDF bytes，并在 Tauri runtime 下通过 `writeTextFile(fullPath, content)` 写入 savePage 内容。红灯先落在缺少 capture/print/save smoke 替换绑定，随后落在 row 301 未勾选；修复后 macOS smoke checklist closure 从 234/290 (80.7%) 提升到 235/290 (81.0%)。剩余相关区域仍是 BrowserWindow runtime rows、native print UI、Chromium pixel capture/PDF fidelity、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 339 current delta:** BrowserWindow hosted `webContents.inspectElement(x, y)` 从“handle VM、宿主 action 和基础 Web preview smoke 已有 void-return、同步 DevTools open/focus 与 inspected element payload 路径，但 row 300 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须通过固定替换点记录 `data-browser-window-inspect-element-state`，验证 `inspectElement(12, 8)` 保持 void-return shape 并同步打开/聚焦 hosted DevTools；同一 smoke 还通过 targeted `devtools-opened` event 记录 `data-browser-window-inspect-element-summary`，验证 inspectedElement 至少包含请求坐标、tagName/id/className/text 等 compact summary 字段”。同一测试还约束宿主继续用 `elementFromPoint(x, y)` 命中 child iframe 坐标、把文本压缩到 120 字符、记录 `webContents:inspectElement` targeted message，并在 inspect 打开 DevTools 时派发 targeted `devtools-opened`。红灯先落在缺少 inspectElement smoke 替换绑定，随后落在 row 300 未勾选；修复后 macOS smoke checklist closure 从 233/290 (80.3%) 提升到 234/290 (80.7%)。剩余相关区域仍是 BrowserWindow capture/print/save rows、runtime rows、Chromium native inspect UI/overlay/protocol attachment、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 338 current delta:** BrowserWindow hosted `webContents.openDevTools(options)` / `closeDevTools()` / `toggleDevTools()` 与 `isDevToolsOpened()` / `isDevToolsFocused()` 从“handle VM、宿主 action 和基础 Web preview smoke 已有 open/toggle/reopen/close、targeted `devtools-opened` / `devtools-closed` 事件与同步 getter 验证，但 row 299 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须通过固定替换点记录 `data-browser-window-devtools-state`，同时验证 `openDevTools({ mode:'detach', activate:false, title })` 返回 opened/focused/mode/title，`toggleDevTools()` 关闭后同步 getter 立即为 false，第二次 `openDevTools({ mode:'bottom' })` 默认聚焦，`closeDevTools()` 清理 open/focus 状态，并且 `devtools-opened` / `devtools-closed` targeted 事件 payload 与父插件监听一致”。红灯先落在缺少 DevTools smoke 替换绑定，随后落在 row 299 未勾选；修复后 macOS smoke checklist closure 从 232/290 (80.0%) 提升到 233/290 (80.3%)。剩余相关区域仍是 inspectElement row、Chromium native DevTools window/docking/protocol attachment、BrowserWindow capture/print/runtime rows、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 337 current delta:** BrowserWindow hosted `webContents.getURL()` / `getTitle()` / `isLoading()` / `isLoadingMainFrame()` / `canGoBack()` / `canGoForward()` 与 `reloadIgnoringCache()` / `goBack()` / `goForward()` 从“handle VM 和宿主 action 已有同步缓存、loading、history index、back/forward 状态实现，Web preview smoke 只分散记录 URL/title/loading/back-forward 标记且 row 298 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须通过固定替换点记录 `data-browser-window-navigation-sync-state`，同时验证 loadURL 后 getURL/getTitle/loading/canGo*、reloadIgnoringCache 后 URL/history 状态保持同步、goBack 后 URL 和 back/forward 布尔同步、goForward 后 URL 和 back/forward 布尔再次同步”。同一测试还约束 bridge `syncWebContentsNavigationState()` 继续更新 cached URL/title/loading/historyIndex，host `webContents.goBack()` / `goForward()` 继续走 hosted history。红灯先落在缺少 navigation sync smoke 替换绑定，随后落在 row 298 未勾选；修复后 macOS smoke checklist closure 从 231/290 (79.7%) 提升到 232/290 (80.0%)。剩余相关区域仍是 BrowserWindow navigationHistory row、Chromium native session history/cache semantics、DevTools rows、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 336 current delta:** BrowserWindow hosted `webContents.findInPage(text[, options])` / `stopFindInPage(action)` 从“handle 和宿主 action 已有同步 request id、匹配计数、targeted `found-in-page` 派发和 stop action 路由实现，Web preview smoke 只记录基础标记且 row 297 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须通过固定替换点记录 `found-in-page` final result、requestId 与 `window.__atoolsBrowserWindowFindRequestId` 的关联，以及 `stopFindInPage("clearSelection")` 返回 `undefined`；同一测试还约束 host 继续派发 targeted found-in-page result、计算 active match ordinal/finalUpdate、记录 stopFindInPage targeted message，并只清理对应 child iframe selection”。红灯先落在缺少 findInPage listener smoke 替换绑定，随后落在 row 297 未勾选；修复后 macOS smoke checklist closure 从 230/290 (79.3%) 提升到 231/290 (79.7%)。剩余相关区域仍是 BrowserWindow navigation rows、Chromium native find UI/selection painting、cross-frame find routing、isolated worlds、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 335 current delta:** BrowserWindow hosted `webContents.insertCSS(css[, options])` / `removeInsertedCSS(key)` 从“handle 和宿主 action 已有 keyed `<style>` 注入/移除实现，Web preview smoke 只验证 computed CSS property 插入与恢复为空，row 296 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须通过固定替换点记录 returned key shape、computed style 插入、`removeInsertedCSS` void shape、computed style cleanup，以及 child iframe 中 `style[data-atools-browser-window-css-key]` 无残留；同一测试还约束 host 继续写入 key/origin attribute、维护 inserted CSS registry，并通过 keyed selector 删除”。红灯先落在缺少 insertCSS smoke 替换绑定，随后落在 row 296 未勾选；修复后 macOS smoke checklist closure 从 229/290 (79.0%) 提升到 230/290 (79.3%)。剩余相关区域仍是 BrowserWindow find/navigation rows、Chromium native CSS cascade origin、isolated worlds/cross-frame CSS、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 334 current delta:** BrowserWindow hosted `webContents.sendInputEvent(inputEvent)` 从“handle 和宿主 action 已有 KeyboardEvent/MouseEvent/WheelEvent 分发实现，Web preview smoke 只验证 Shift+Enter 且 row 295 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须通过固定替换点记录键盘、鼠标、滚轮三类 DOM input state，并在 `webContents.loadURL()` / `webContents.reload()` 后再次派发输入，记录 `data-browser-window-send-input-event-after-webcontents-reload`，证明后续 WebContents 动作命中 loaded child document 而不是初始空文档”。红灯先落在缺少 sendInputEvent smoke 替换绑定，随后落在 row 295 未勾选；修复后 macOS smoke checklist closure 从 228/290 (78.6%) 提升到 229/290 (79.0%)。剩余相关区域仍是 BrowserWindow CSS/find/navigation rows、OS 级 native input/IME/before-input-event、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 333 current delta:** BrowserWindow hosted `webContents.executeJavaScript(code[, userGesture])` 从“handle 和宿主 action 已有成功执行路径，Web preview smoke 已记录 parent `data-browser-window-execute-js` 和 child `data-execute-js`，但 row 294 仍是手工项且没有 method-scoped error smoke”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须通过固定替换点记录成功结果、child side effect、`execute-js-smoke` thrown script，以及包含 `webContents.executeJavaScript` 方法名的错误标记 `data-browser-window-execute-js-error`”。红灯先落在缺少 executeJavaScript smoke 替换绑定，随后落在 row 294 未勾选；修复后 macOS smoke checklist closure 从 227/290 (78.3%) 提升到 228/290 (78.6%)。剩余相关区域仍是 BrowserWindow sendInputEvent/CSS/find/navigation rows、native Electron isolated worlds/frame routing、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 332 current delta:** BrowserWindow hosted `webContents.send()` IPC 从“父窗口 `win.webContents.send()`、child `ipcRenderer.on()` / `once()` 和 child `sendToParent()` 的 VM 级语义已有覆盖，Web preview smoke 也已有 on/sendToParent 基础路径，但 row 293 仍是手工项且 child Web smoke 没有 `ipcRenderer.once()` 标记”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须包含 child `ipcRenderer.once()`、`data-child-ipc-once`、`data-child-ipc-ping`、parent `data-browser-window-webcontents-send` 和 `data-parent-message-channel`”。红灯先落在缺少 child `ipcRenderer.once()` Web smoke，随后落在 row 293 未勾选；修复后 macOS smoke checklist closure 从 226/290 (77.9%) 提升到 227/290 (78.3%)。剩余相关区域仍是 BrowserWindow executeJavaScript/sendInputEvent/CSS/find/navigation rows、native Electron IPC、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 331 current delta:** BrowserWindow hosted content-size/min-max/aspect-ratio state 从“handle 和宿主 action 已有 `getContentSize()` / `setContentSize()`、`getMinimumSize()` / `setMinimumSize()`、`getMaximumSize()` / `setMaximumSize()`、`setAspectRatio()`，Web preview smoke 也已跑过 content-size/min/max 路径，但 row 292 仍是手工项且没有记录 aspect-ratio/final restore 标记”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须记录 `data-browser-window-aspect-ratio-state` 和 `data-browser-window-content-size-restored`，并约束 `setBounds()` / `setSize()` / `setContentSize()` 继续共享 hosted size constraint normalization”。红灯先落在缺少 sizing restore smoke 替换绑定，随后落在 row 292 未勾选；修复后 macOS smoke checklist closure 从 225/290 (77.6%) 提升到 226/290 (77.9%)。剩余相关区域仍是 BrowserWindow IPC rows、native OS-level content bounds/user drag constraints、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 330 current delta:** BrowserWindow hosted z-order/media-source state 从“handle 和宿主 action 已有 `getMediaSourceId()`、`moveTop()`、`moveAbove(mediaSourceId)`，Web preview smoke 也已创建临时参照窗口，但 row 291 仍是手工项且没有记录 moveTop/moveAbove 结果标记”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须记录 `data-browser-window-z-order-state`，并约束 `moveTop` / `moveAbove` 替换目标、media source id 标记和 hosted z-index 渲染”。红灯先落在缺少 moveTop smoke 替换绑定，随后落在 row 291 未勾选；修复后 macOS smoke checklist closure 从 224/290 (77.2%) 提升到 225/290 (77.6%)。剩余相关区域仍是 BrowserWindow content-size/IPC rows、native OS-level z-order/DesktopCapturerSource behavior、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 329 current delta:** BrowserWindow hosted focus/attention/progress state 从“handle 和宿主 action 已有 `setFocusable()` / `isFocusable()`、`flashFrame()`、`setProgressBar()`，但 Web preview smoke 只记录 focusable readback，没有记录 focusable 恢复或 flash/progress cleanup，row 290 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须记录 `data-browser-window-focusable-restored` 和 `data-browser-window-attention-progress-state`，并约束 hosted flashing shell class/style 和 progress strip active render 条件”。红灯先落在缺少 restored focusable marker，随后落在 row 290 未勾选；修复后 macOS smoke checklist closure 从 223/290 (76.9%) 提升到 224/290 (77.2%)。剩余相关区域仍是 BrowserWindow z-order/content-size/IPC rows、native OS-level focusability/Dock flash/taskbar progress behavior、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 328 current delta:** BrowserWindow hosted system-state 从“handle 和宿主 action 已有 `setSkipTaskbar()`、`setKiosk()` / `isKiosk()`、`setVisibleOnAllWorkspaces()` / `isVisibleOnAllWorkspaces()`、`setContentProtection()` / `isContentProtected()`，Web preview smoke 也已跑过 kiosk/workspace/content-protection readback，但 row 289 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须记录 `data-browser-window-kiosk` / `data-browser-window-kiosk-restored` / `data-browser-window-workspaces` / `data-browser-window-content-protected`，并约束 hosted `kiosk` class 使用和 maximized/fullScreen 一致的 fill-layer CSS”。红灯落在 row 289 未勾选；修复后 macOS smoke checklist closure 从 222/290 (76.6%) 提升到 223/290 (76.9%)。剩余相关区域仍是 BrowserWindow focus-attention-progress/z-order/content-size/IPC rows、native OS-level taskbar/kiosk/workspace/capture-protection behavior、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 327 current delta:** BrowserWindow hosted background-color state 从“handle 和宿主 action 已有 `setBackgroundColor(color)` / `getBackgroundColor()`，Web preview smoke 也已验证 `setBackgroundColor('rgb(16, 32, 48)')` 保持 void-return shape 且 getter 规范化为 `#102030`，但 row 288 仍是手工项”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须记录 `data-browser-window-background-color`，并约束 hosted shell style 使用 `childWindow.backgroundColor`”。红灯落在 row 288 未勾选；修复后 macOS smoke checklist closure 从 221/290 (76.2%) 提升到 222/290 (76.6%)。剩余相关区域仍是 BrowserWindow system-state/focus-attention-progress/z-order rows、native OS-level background material/color behavior、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 326 current delta:** BrowserWindow hosted appearance state 从“handle 和宿主 action 已有 `get/setOpacity`、`has/setHasShadow`、`invalidateShadow`，但 row 287 仍是手工项，Web preview smoke 只验证 opacity/shadow 写入，不证明恢复后无残留”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须记录 `data-browser-window-opacity-restored` 和 `data-browser-window-shadow-restored`，并约束 hosted shell 只在 opacity < 1 时输出 inline opacity、只在 `hasShadow:false` 时添加 `noShadow` class”。红灯先落在缺少 restored opacity marker，随后落在 row 287 未勾选；修复后 macOS smoke checklist closure 从 220/290 (75.9%) 提升到 221/290 (76.2%)。剩余相关区域仍是 BrowserWindow background-color/system-state、native OS-level appearance behavior、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 325 current delta:** BrowserWindow hosted full-screen state 从“handle 和宿主 action 已有 `is/setFullScreen` 与 `is/setFullScreenable`，但 row 286 仍是手工项，Web preview smoke 只进入/退出 full-screen 且不证明 `fullScreenable:false` 门控或 enter/leave 事件”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须监听 hosted `enter-full-screen` / `leave-full-screen`，记录事件标记，先设置 `fullScreenable:false` 并验证 `setFullScreen(true)` 不进入 full-screen，再恢复 `fullScreenable:true` 后继续原有 enter/leave 路径”。红灯先落在缺少 `enter-full-screen` 监听，随后落在 row 286 未勾选；修复后 macOS smoke checklist closure 从 219/290 (75.5%) 提升到 220/290 (75.9%)。剩余相关区域仍是 BrowserWindow appearance/system-state、native OS-level fullscreen/window behavior、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 324 current delta:** BrowserWindow hosted capability state 从“handle 已实现 `is/setResizable`、`is/setMovable`、`is/setClosable`、`is/setMinimizable`、`is/setMaximizable`，但 row 285 仍是手工项，Web preview smoke 只显式跑 `setResizable()` / `isResizable()`”推进到“`pnpm test:plugin-window-browser-bridge` 约束 App browser-window smoke 必须依次 toggle/readback 5 组 capability，并约束 `closable:false` 对应关闭按钮禁用和 disabled title”。红灯先落在 `browser-window smoke should exercise hosted movable capability updates`，随后落在 row 285 未勾选；修复后 Web preview `?parity=1&pluginHostSmoke=browserWindow` 在进入 full-screen smoke 前记录 `data-browser-window-resizable/movable/closable/minimizable/maximizable` 并恢复 capability。macOS smoke checklist closure 从 218/290 (75.2%) 提升到 219/290 (75.5%)；插件 iframe host/runtime 和测试发布粗估维持当前值。剩余相关区域仍是 BrowserWindow full-screen/full-screenable、appearance/system-state、native OS-level window behavior、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 323 current delta:** 内置插件搜索 desktop smoke 从“rows 281/282 仍是手工项，真实桌面 smoke 只验证任意 indexed plugin activation/render”推进到“`plugin_runtime_smoke.calculator_search_enter_checked`、`plugin_runtime_smoke.timestamp_search_enter_checked` 和 `plugin_panel_render_smoke.timestamp_subinput_checked` 成为必需字段”。实现接受当前/旧版内置插件共存下的 hash plugin id、`calc`/`计算器` 与 `timestamp`/`时间戳` feature code，并在搜索命中第一个候选路径不可用时继续尝试后续候选；PluginPanel smoke bridge probe 新增 iframe 可见 input 状态回传，既覆盖新版 host SubInput，也覆盖旧版自包含时间戳页面。红灯先落在缺字段断言和真实桌面 `timestamp_search_enter_checked:false` / `timestamp_subinput_checked:false`，修复后 `pnpm test:tauri-desktop-smoke-script`、`cargo test --manifest-path src-tauri/Cargo.toml desktop_smoke --lib`、`ATOOLS_DESKTOP_SMOKE_TIMEOUT_MS=180000 pnpm smoke:tauri-desktop` 均通过。macOS smoke checklist closure 从 216/290 (74.5%) 提升到 218/290 (75.2%)；插件 iframe host/runtime 和测试发布粗估维持当前值。剩余相关区域仍是更深的时间戳输出交互、JSON/颜色插件流、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 322 current delta:** 插件资源兼容 checklist 从“row 280 描述已有 `pnpm test:plugin-resource-html` / `pnpm test:plugin-resource-runtime` 覆盖面，但未绑定 checked row”推进到“两个资源测试都断言 row 280 已勾选；HTML 测试继续覆盖 `main_url` 子目录、相对 script/style、CSS `url(...)` / `@import`、`srcset`、link icon/modulepreload/媒体资源和本地 `<base href>` marker；runtime 测试继续覆盖动态 image/media/script/link/object/style、inline style、`CSSStyleSheet.insertRule()`、`appendChild` / `insertBefore` / `append` / `prepend` / `before` / `after` / `replaceWith` preflight，以及 live local base href”。红灯先落在 row 280 未勾选；更新 checklist 后转绿。macOS smoke checklist closure 从 215/290 (74.1%) 提升到 216/290 (74.5%)；插件 iframe host/runtime 和测试发布粗估维持当前值。剩余相关区域仍是真实插件搜索、真实 Tauri FS 导入、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 321 current delta:** pluginHostSmoke Web preview 从“row 279 只说明 `?parity=1&pluginHostSmoke=1` 应验证宿主 UI，但没有一个可重复 Browser 脚本绑定 runtime cards/SubInput/output/layout 证据”推进到“`scripts/test-plugin-host-smoke-browser.mjs` 通过 headless Chrome/CDP 打开 `http://localhost:1420/?parity=1&pluginHostSmoke=1`，验证标题 `插件运行态预览`、feature/source labels、运行状态/SubInput/输出结果/桥接能力 4 个 runtime chip、桥接详情 `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`、SubInput 值 `time`、2 行 output、没有真实 plugin iframe body、console 0 warn/error、无 framework overlay、无横向溢出，并检查 header/runtime/SubInput/body 兄弟区块不重叠且 output layer 保持在 body 内”。红灯先校准现有 UI 文案/默认选中态/父子布局断言，随后落在 row 279 未勾选；更新 checklist 和 `pnpm test:plugin-host-smoke-browser` 后转绿。macOS smoke checklist closure 从 214/290 (73.8%) 提升到 215/290 (74.1%)；插件 iframe host 和测试发布粗估维持当前值。剩余相关区域仍是真实 `activate_feature` 桌面插件搜索、真实 Tauri FS 导入、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 320 current delta:** UI host report scope 从“row 274 只是叙述性说明，未绑定一个可重复测试证明 report 覆盖边界”推进到“`scripts/test-ztools-ui-host-report-scope.mjs` 读取当前真实 `output/ztools-plugin-ui-host-smoke-report.json`、`output/ztools-ui-host-screenshot-captures/manifest.json` 和生成 fixture/matrix HTML，验证 10-plan summary、每个 `externalPlan` synthetic `srcdoc` probe 回传、真实入口 HTML/readiness/hash、脚本/样式依赖 readiness/hash、CSS `@import`/`url()` 字体复制、fixture bridge API probe replay marker、standalone fixture matrix、Web preview PluginPanel matrix 和 20 个截图 artifact manifest”。红灯先落在 row 274 未勾选；更新 checklist 和 `pnpm test:ztools-ui-host-report-scope` 后转绿。macOS smoke checklist closure 从 213/290 (73.4%) 提升到 214/290 (73.8%)；插件 iframe host 和测试发布粗估维持当前值。剩余 UI host 区域仍是真实 Tauri FS 导入、side-effecting native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 319 current delta:** UI host screenshot capture 从“report 只有 20 个 `screenshot_viewports` plan，且旧记录明确 `Page.captureScreenshot` 超时、不作为像素证据”推进到“`scripts/capture-ztools-ui-host-screenshots.mjs` 通过 headless Chrome/CDP 对 10 个 `web_preview` URL 逐一应用 desktop/compact viewport，等待 `ATools 3.0`、插件名、`宿主探针 5/5`、console 0 warn/error、无 framework overlay、无横向溢出后调用 `Page.captureScreenshot`，生成 20 个 PNG artifact 和 `output/ztools-ui-host-screenshot-captures/manifest.json`；`scripts/test-ztools-ui-host-screenshot-capture-browser.mjs` 校验 PNG signature、尺寸、字节数和每个 capture 的页面状态”。同时 `scripts/chrome-cdp-smoke-utils.mjs` 为 CDP command 增加可选 timeout，避免截图命令挂死。红灯先落在 capture module 缺失，随后落在 checklist 未勾选；更新 row 273 和脚本入口后转绿。macOS smoke checklist closure 从 212/290 (73.1%) 提升到 213/290 (73.4%)；插件 iframe host 和测试发布粗估维持当前值。剩余 UI host 区域仍是真实 Tauri FS 导入、native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 318 current delta:** externalPlan Browser smoke 从“`srcdoc` 已静态包含 `__atools_ui_host_probe_result__`，但 checklist row 266/267 未绑定真实 Browser 回传和 runtime strip 证据”推进到“`scripts/test-ztools-ui-host-external-plan-browser.mjs` 通过 headless Chrome/CDP 启动 Vite `127.0.0.1:1420`，打开首个 `web_preview.mode=externalPlan` URL，验证 base64url action 保留中文插件名 `计算稿纸`、synthetic `srcdoc` 包含 `__atools_ui_host_probe_result__` 和 probeResults、PluginPanel 标题 `ATools 3.0`、插件名 `计算稿纸`、iframe mode、主 iframe 使用 srcdoc 而非 src、sandbox `allow-scripts allow-popups`、bridge capability strip、`宿主探针 5/5`、console 0 warn/error、无 Vite/Svelte overlay、无横向溢出”。红灯先落在 checklist 未勾选；更新 rows 266/267 和脚本入口后转绿。macOS smoke checklist closure 从 210/290 (72.4%) 提升到 212/290 (73.1%)；插件 iframe host 和测试发布粗估维持当前值。剩余 UI host 区域仍是截图、真实 Tauri FS 导入、native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 317 current delta:** 首个 standalone real-entry fixture Browser smoke 从“matrix 已覆盖 10 个 fixture 但 checklist row 268 未绑定直接打开首个 fixture 的可重复 Browser 证据”推进到“`scripts/test-ztools-ui-host-first-fixture-browser.mjs` 通过 headless Chrome/CDP 启动 fixture server `127.0.0.1:1434`，打开 `http://127.0.0.1:1434/001-calculation-paper-calc.html`，验证真实 DOM 可见 `计算公式` 输入框、`data-atools-real-entry-fixture=true`、`data-atools-real-entry-ready=true`、`data-atools-real-entry-bridge-present=true`、`data-atools-real-entry-ztools-alias=true`、plugin id `calculation-paper`、feature code `calc`、bridge API 9/9、console 0 warn/error”。红灯先修正测试对报告/runtime 字段的假设，随后落在 checklist 未勾选；更新 row 和脚本入口后转绿。macOS smoke checklist closure 从 209/290 (72.1%) 提升到 210/290 (72.4%)；插件 iframe host 和测试发布粗估维持当前值。剩余 UI host 区域仍是 externalPlan `srcdoc` PluginPanel strip、externalPlan Browser smoke、截图、真实 Tauri FS 导入、native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 316 current delta:** PluginPanel matrix Browser smoke 从“`plugin-panel-matrix.html` 已生成并有历史基线，但当前 checklist 未绑定可重复 Browser 执行证据”推进到“`scripts/test-ztools-ui-host-plugin-panel-matrix-browser.mjs` 通过 headless Chrome/CDP 同时启动 Vite `127.0.0.1:1420` 与 fixture server `127.0.0.1:1434`，打开 `http://127.0.0.1:1434/plugin-panel-matrix.html`，验证 `data-atools-real-entry-plugin-panel-matrix=true`、expected-count 10、ready-count 10、error-count 0、all-ready true、10 个 PluginPanel iframe、10 行 `ready passed=15/15 failed=`、matrix runtime object、console 0 warn/error，并静态确认失败路径会渲染 `messages=` 透传真实 fixture error”。同时把 Vite strict-port 启停抽到 `scripts/chrome-cdp-smoke-utils.mjs` 的 `launchViteServer()`，供单个 PluginPanel smoke 和 matrix smoke 共享。红灯先落在 checklist 未勾选，更新 row 和脚本入口后转绿。macOS smoke checklist closure 从 208/290 (71.7%) 提升到 209/290 (72.1%)；插件 iframe host 和测试发布粗估维持当前值。剩余 UI host 区域仍是 externalPlan `srcdoc` PluginPanel strip、首个 standalone fixture DOM、截图、真实 Tauri FS 导入、native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 315 current delta:** 单个 PluginPanel real fixture Browser smoke 从“首个 `real_entry_plugin_panel.url` 可由历史证据打开，但当前 checklist 未绑定可重复脚本，且 row 文案仍停留在旧 `宿主探针 6/6`”推进到“`scripts/test-ztools-ui-host-plugin-panel-browser.mjs` 通过 headless Chrome/CDP 同时启动 Vite `127.0.0.1:1420` 与 fixture server `127.0.0.1:1434`，打开首个 `real_entry_plugin_panel.url`，验证标题 `ATools 3.0`、插件名 `计算稿纸`、主插件 iframe `src=http://127.0.0.1:1434/001-calculation-paper-calc.html`、空 `srcdoc`、sandbox `allow-scripts allow-popups`、runtime `iframe`、bridge capability strip、`宿主探针 15/15`、console 0 warn/error、无 Vite/Svelte overlay、无横向溢出”。红灯先暴露当前运行态已升级到 `15/15` 而非旧 `6/6`，随后只剩 checklist 未勾选；更新 row 和脚本入口后转绿。macOS smoke checklist closure 从 207/290 (71.4%) 提升到 208/290 (71.7%)；插件 iframe host 和测试发布粗估维持当前值。剩余 UI host 区域仍是 externalPlan `srcdoc` PluginPanel strip、首个 standalone fixture DOM、截图、真实 Tauri FS 导入、native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 314 current delta:** UI host fixture matrix Browser smoke 从“生成目录 matrix 已存在，但当前 checklist 未绑定真实 Browser 执行证据”推进到“`scripts/test-ztools-ui-host-fixture-matrix-browser.mjs` 通过 headless Chrome/CDP 启动本地 fixture server、打开 `http://127.0.0.1:1434/index.html`，验证 matrix marker、expected/ready/error/all-ready、10 个 fixture iframe、10 行 ready/bridge/ztools/identity、每行 `bridgeApi=9/9 bridgeApiFailed= errors=0` 和 console 0 warn/error”。红灯先暴露 `ibox-wallpaper` 的 Umami init 和 `ztools-developer-plugin` 的 `ztools.internal.getDevProjects` console error，随后通过 fixture bridge 补 `umami.init()` 与 `ztools.internal` dev-project mock，并重新生成真实 UI host report。当前真实 UI host report 基线同步为 10 planned / 10 UI host samples / 27 real entry resources / 10 fixture matrix / 10 PluginPanel matrix / 77 runtime support files。macOS smoke checklist closure 从 206/290 (71.0%) 提升到 207/290 (71.4%)；插件 iframe host 和测试发布粗估维持当前值。剩余 UI host 区域仍是 externalPlan `srcdoc` PluginPanel strip、首个 standalone fixture DOM、单个 PluginPanel real fixture、PluginPanel matrix、截图、真实 Tauri FS 导入、native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 313 current delta:** UI host fixture server 从“server 和历史 Browser matrix 已实现，但 macOS checklist 的 fixture server 行未绑定”推进到“`scripts/test-ztools-ui-host-fixture-server.mjs` 验证真实 UI host report 的 PluginPanel fixture URL 和 matrix browser URL 均使用 `127.0.0.1:1434`，同时用临时 fixture root 覆盖 root `index.html`、HTML/script/json/font MIME、CORS headers、`OPTIONS` preflight、`GET`/`HEAD`、encoded path traversal 拒绝和 malformed percent-encoding 400 兜底”：macOS smoke checklist 的 fixture server 支撑行转为已完成。macOS smoke checklist closure 从 205/290 (70.7%) 提升到 206/290 (71.0%)；插件 iframe host 和测试发布粗估维持当前值。剩余 UI host 区域仍是真实 Browser DOM/console/no-overflow/matrix rows、PluginPanel matrix、截图、真实 Tauri FS 导入、native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 312 current delta:** 真实 ZTools UI host smoke report 从“`output/ztools-plugin-ui-host-smoke-report.json` 和 generated fixture/matrix 已存在，但 macOS checklist 的 UI host report 结构项未绑定”推进到“`scripts/test-ztools-plugin-ui-host-smoke-report.mjs` 读取真实输出，验证当前 10 planned / 10 UI host samples / 10 desktop action fixtures / 10 Web preview actions / 10 iframe-ready / 20 screenshot viewport / 50 bridge probe / 10 real entry HTML ready / 30 real entry resources ready / 10 fixture / 10 fixture matrix / 10 PluginPanel fixture / 10 PluginPanel matrix / 90 bridge API probe / 85 runtime support file 基线，并逐 plan 绑定 desktop `FeatureAction`、externalPlan URL、iframe-ready、viewport、bridge probes、real entry HTML/resources、generated fixture、PluginPanel fixture URL 和 UTF-8 中文 action payload”：macOS smoke checklist 的 UI host report 前 10 行转为已完成。macOS smoke checklist closure 从 195/290 (67.2%) 提升到 205/290 (70.7%)；插件 iframe host、插件 runtime 和测试发布粗估维持当前值。剩余 UI host 区域仍是 `宿主探针 5/5` 和真实 Browser smoke/console/no-overflow/matrix rows，以及真实 Tauri FS 导入、逐插件截图、native bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 311 current delta:** 真实 ZTools 报告从“兼容性和运行态样本 JSON 已能生成，但 macOS checklist 未绑定，运行态样本基线仍停留在旧的 117/53/14/39/64/20”推进到“`scripts/test-ztools-plugin-compatibility-report.mjs` 读取 `output/ztools-plugin-compatibility-report.json`，验证真实扫描非空、`unsupported_cmd_plugins=0`、所有 error plugin 当前均来自缺少构建后的 `main`；`scripts/test-ztools-plugin-runtime-sample-report.mjs` 读取 `output/ztools-plugin-runtime-sample-report.json`，验证当前真实基线为 125 scanned、61 launchable、21 ready、40 risk、64 blocked、20 selected sample candidates，且 selected sample list 长度与 summary 一致”：macOS smoke checklist 的真实 ZTools 兼容扫描 4 行和运行态样本候选报告 5 行转为已完成。macOS smoke checklist closure 从 186/290 (64.1%) 提升到 195/290 (67.2%)；插件安装/导入、插件 runtime 和测试发布粗估维持当前值。剩余插件区缺口仍是激活计划、UI host fixture、Browser/PluginPanel matrix、逐插件导入/启用/激活/UI load/bridge replay、完整 sandbox isolation、签名公证和自动更新。

**Batch 310 current delta:** 全局快捷键冲突反馈从“`validateShortcut()` / `shortcutStatusMessage()` 已实现保留组合拦截和 native 注册失败详情，但 macOS checklist 未绑定”推进到“`scripts/test-hotkey-recorder.mjs` 验证 `Command+Space` 在 macOS 返回 `该组合通常被系统占用，请换一个快捷键`，`shortcutStatusMessage("Command+Space", "mac", "saved")` 不会显示保存成功，native error `Global shortcut already registered` 会原样进入 `保存失败：Global shortcut already registered`；同一脚本绑定 `SettingsPanel.svelte` 的 hotkey input title、error pill、`冲突/保存状态` 行和 `热键注册失败会显示为保存失败，不再静默成功` 说明”：macOS smoke checklist 的系统保留快捷键冲突风险和真实系统占用保存失败详情 2 行转为已完成。macOS smoke checklist closure 从 184/290 (63.4%) 提升到 186/290 (64.1%)；设置真实功能和测试发布粗估维持当前值。剩余同一区域仍是真实 keypress 显示/隐藏、重新注册后旧热键失效、菜单栏托盘可见性、真实 LaunchAgent 写删和发布签名链路。

**Batch 309 current delta:** Agent 权限确认弹窗从“客户端/工具/scope/执行模式/关键参数、文件路径和风险提示 UI 已存在但 checklist 未绑定”推进到“`scripts/test-permission-preview.mjs` 绑定 `PermissionConfirmDialog.svelte` 展示 `Agent 权限确认`、工具名、客户端、Scope、人类可读 scope label、执行模式、`关键参数`、`完整 JSON`、`涉及路径`、从 `preview.paths` 渲染路径、dialog `max-height` + `overflow:auto`、code `pre-wrap` + `overflow-wrap:anywhere`，以及 `risk-box` 按 `preview.riskLevel` 渲染风险列表；同一脚本验证 `permissionRequestPreview()` 对 `file_write` 产出 medium risk、路径数量提示，对 `shell` 和 `system_settings` 产出 high risk 和明确中文风险文案”：macOS smoke checklist 的权限确认弹窗摘要、文件路径展示和高/中风险提示 3 行转为已完成。macOS smoke checklist closure 从 181/290 (62.4%) 提升到 184/290 (63.4%)；Agent/MCP、权限与审计和测试发布粗估维持当前值。当前连续 Agent/MCP 权限/审计 UI checklist block 已闭合；剩余缺口回到桌面系统集成、插件 runtime/browser-window 兼容、external fixture smoke 和签名/公证/自动更新。

**Batch 308 current delta:** Agent 审计详情从“回放摘要、副作用 diff、路径副作用和压缩目标/WebP 逻辑已存在但 checklist 未绑定”推进到“`scripts/test-audit-view.mjs` 验证展开详情渲染 `回放摘要`、权限结果、执行模式、本地副作用、执行结果步骤、`副作用 diff` before/after/status、长路径换行、`路径副作用` 源/目标/状态，以及 dry-run 被标为 `dry-run 预览`；同一脚本绑定 `compress_images` 的 `original_size`、`output_size`、减少比例、`target_size`、`target_met`、`compression_ratio`、`target_unmet` 和目标未达标 diff 文案；Rust WebP 回归补充 `original_size` 断言并继续验证 `format:"webp"`、`compressed-<stem>.webp`、RIFF/WEBP 魔数和 lossless encoder”：macOS smoke checklist 的审计回放摘要、副作用 diff、图片压缩 diff、max_bytes 目标、WebP 输出、路径副作用和 dry-run 预览 7 行转为已完成。macOS smoke checklist closure 从 174/290 (60.0%) 提升到 181/290 (62.4%)；权限与审计粗估从 97% 提升到 98%，Agent/MCP 和测试发布维持当前值。剩余 Agent/MCP smoke 行集中在权限确认弹窗的客户端/工具/scope/关键参数、文件路径显示和中高风险提示；真实 macOS 热键/托盘/自启、签名公证自动更新仍未闭合。

**Batch 307 current delta:** Agent 审计列表从“UI/库已具备筛选、分页、保存视图和 filtered export，但 macOS checklist 未绑定证据”推进到“`scripts/test-audit-view.mjs` 验证关键字/status/tool/client 组合筛选、路径/错误/参数命中、无匹配空态和筛选摘要；`scripts/test-mcp-audit-settings.mjs` 验证 `已加载 {audits.length} / {auditTotal}`、`加载更多` append、不清空当前筛选、backend query 带 query/status/tool/client，以及 filtered JSONL export 走 `export_audit_entries_jsonl_filtered`、复制到剪贴板并显示 `当前筛选`；`scripts/test-audit-filter-views.mjs` 验证命名视图保存、应用、删除和 localStorage 恢复”：macOS smoke checklist 的审计筛选、分页、保存筛选视图、筛选导出和搜索命中/空态 5 行转为已完成。macOS smoke checklist closure 从 169/290 (58.3%) 提升到 174/290 (60.0%)；Agent/MCP 和测试发布粗估维持当前值。剩余审计项集中在展开详情回放摘要、副作用 diff、路径副作用、压缩目标/WebP 详情和权限弹窗渲染；真实 macOS 热键/托盘/自启、签名公证自动更新仍未闭合。

**Batch 306 current delta:** Agent 审计列表从“支持导出和清空但审计区没有独立刷新入口，checklist 未证明 JSONL copy path”推进到“审计回放区提供 `刷新` / `导出` / `清空` 三个动作；刷新调用 `reloadAuditsForFilters()` 保留当前 query/status/tool/client 筛选并重拉第一页；导出调用 `export_audit_entries_jsonl_filtered`、通过 `copyText(jsonl)` 写入剪贴板并显示已复制 JSONL 条数，存在筛选时带 `当前筛选` 提示；清空调用 `clear_audit_entries` 并重置本地 audit list/total/selected state”：扩展 `scripts/test-mcp-audit-settings.mjs` 绑定 AgentPanel、Tauri commands 和 core DB 的 clear/filtered export 路径，macOS smoke checklist 的“审计列表可刷新、清空、导出 JSONL 到剪贴板”转为已完成。macOS smoke checklist closure 从 168/290 (57.9%) 提升到 169/290 (58.3%)；Agent/MCP 和测试发布粗估维持当前值。剩余仍是保存筛选视图、筛选导出 checklist closure、搜索命中/空态、审计详情回放/副作用 diff/路径副作用，以及真实 macOS 热键/托盘/自启和签名公证自动更新。

**Batch 305 current delta:** MCP scope 策略完成度从“Settings UI 显示 scope 行和 deny 控制，但 checklist 未证明所有 scope 与 deny->confirm 恢复”推进到“前端脚本测试覆盖 10 个后端 scope 的 row model、高风险/阻断展示和 `确认`/`阻断` 选项；Rust 集成测试验证 `list_agent_scope_policies()` 返回 `clipboard_read`、`clipboard_write`、`file_read`、`file_write`、`network`、`shell`、`screenshot`、`browser_context`、`plugin_data`、`system_settings`，五个高风险 scope 标记正确，并且 `set_agent_scope_policy("system_settings", "deny")` 可再用 `"confirm"` 恢复到全 scope 确认状态”：新增 `scope_policy_lists_all_scopes_and_restores_denied_scope_to_confirm`，扩展 `scripts/test-mcp-permission-policy-settings.mjs`，macOS smoke checklist 的权限区全 scope deny/confirm 行转为已完成。macOS smoke checklist closure 从 167/290 (57.6%) 提升到 168/290 (57.9%)；Agent/MCP 和测试发布粗估维持当前值。剩余仍是审计列表刷新/清空/筛选/导出、保存筛选视图、审计详情回放/副作用 diff/路径副作用，以及真实 macOS 热键/托盘/自启和签名公证自动更新。

**Batch 304 current delta:** 系统设置 desktop smoke 从“只校验 LaunchAgent plist 字符串”推进到“真实 smoke 在系统临时目录创建隔离 LaunchAgent plist，验证 label、RunAtLoad 和当前 executable path，再删除并确认清理，同时 parser 强制 `launch_agent_write_checked` / `launch_agent_cleanup_checked` 存在”：`src-tauri/src/desktop_smoke.rs` 的 `system_settings_smoke` 新增这两个字段并纳入 `status:"ok"` 判定；`scripts/smoke-tauri-desktop.mjs` 和 fixture test 强制校验字段；macOS smoke checklist 增加已闭合自动化证据行并明确不会写真实 `~/Library/LaunchAgents`。本批真实 `ATOOLS_DESKTOP_SMOKE_TIMEOUT_MS=180000 pnpm smoke:tauri-desktop` 通过，`system_settings_smoke.hotkey_reregistered`、`tray_visibility_applied`、`launch_agent_plist_valid`、`launch_agent_write_checked`、`launch_agent_cleanup_checked`、`settings_preserved` 均为 true。macOS smoke checklist closure 从 166/289 (57.4%) 提升到 167/290 (57.6%)；Tauri/Rust 桌面底座和测试发布粗估维持当前值。剩余仍是真实菜单栏托盘可见性、真实 `~/Library/LaunchAgents` 写删、按键触发热键、签名、公证和自动更新，以及插件侧更广视觉/交互/native replay。

**Batch 303 current delta:** 真实 ZTools 外部插件 activation desktop smoke 从“plan 可生成但实际外部 render 队列会被 `ztools-developer-plugin/ui.router` 的 iframe probe 阻塞”推进到“10 个 plan 样本保留 activation 覆盖，其中 1 个 unsafe 样本显式 `render_smoke.safe:false` 跳过 render 队列，真实 Tauri smoke 对 9 个外部样本完成导入/启用/激活/FS load spec/断言/清理，并对 8 个 render-safe 外部样本完成 PluginPanel filesystem `srcdoc` 渲染、40/40 iframe bridge probe 和 32/32 no-side-effect native/system method probe”：`scripts/ztools-plugin-activation-plan.mjs` 输出 `render_smoke`；`src-tauri/src/desktop_smoke.rs` 跳过 unsafe render 样本并把外部 plan render 回传等待扩到 120s；`PluginPanel` smoke bridge probe 下限提高到 12s。macOS smoke checklist closure 从 132/288 (45.8%) 提升到 166/289 (57.4%)；插件安装/导入、插件 iframe 宿主和测试发布粗估维持 99%。剩余仍是真实逐插件视觉截图、plugin-authored interaction replay、side-effecting native bridge coverage、插件证书链/吊销/平台级签名策略、完整 iframe sandbox/cross-origin capability isolation、BrowserWindow 子 iframe same-origin 兼容债，以及签名、公证、自动更新。

**Batch 302 current delta:** `find_local_files` 从“实现和 Rust 行为测试已覆盖 ignore/depth/permission 行为但 macOS smoke checklist 仍未勾选”推进到“`ignore_dirs`、`max_depth`、权限错误跳过统计、`ignore_patterns` 通配忽略，以及 `*.tmp` 文件名和 `generated/**` 相对子树跳过均由源码、MCP schema、Rust tests 和 checklist-bound script 共同守护”：新增 `scripts/test-settings-mcp-find-local-files-ignore.mjs`，绑定 `FindLocalFilesOptions`、tool call 参数解析、`visit_files()` depth/permission/ignore traversal、`matches_ignore_patterns()` 的 `/**` 和 wildcard 语义、MCP schema 字段与现有 Rust 测试 `find_local_files_respects_ignore_dirs_and_max_depth` / `find_local_files_respects_ignore_patterns_for_files_and_paths` / `find_local_files_skips_permission_denied_directories`。macOS smoke checklist closure 从 131/288 (45.5%) 提升到 132/288 (45.8%)；Agent/MCP、内置 Agent 工具和测试发布粗估维持当前值。剩余仍是权限/审计 UI 行、插件证书链/完整 sandbox isolation，以及签名公证和自动更新。

**Batch 301 current delta:** `ask_ai_model` 成功调用审计从“工具输出不含 API key 但成功审计可读性和密钥脱敏 smoke checklist 仍未勾选”推进到“本地 OpenAI-compatible chat completion 成功后，持久化审计记录保留原始 prompt 与 assistant 输出，同时完整 audit JSON 不包含配置里的 AI API Key 或 `api_key` 字段”：新增 Rust 测试 `ask_ai_model_success_audit_keeps_prompt_and_output_without_api_key`，使用本地 TCP server 和 `sk-agent-audit-secret` sentinel 验证请求实际携带 Authorization、审计 input/output 可见且不落密钥；新增 `scripts/test-settings-mcp-ask-ai-audit-redaction.mjs` 绑定 `call_tool_with_audit()` 成功审计路径、`ask_ai_model` 输出 shape、Rust 回归和 smoke checklist。macOS smoke checklist closure 从 130/288 (45.1%) 提升到 131/288 (45.5%)；Agent/MCP、权限审计和测试发布粗估维持当前值。剩余仍是 `find_local_files` ignore 行、权限/审计 UI 行、插件证书链/完整 sandbox isolation，以及签名公证和自动更新。

**Batch 300 current delta:** `ask_ai_model` 权限确认从“工具和 Settings UI 已实现但 network scope / 保守确认 smoke checklist 仍未勾选”推进到“Settings 工具开关显示 `ask_ai_model` scope；`ask_ai_model` 明确声明 `PermissionScope::Network`；默认保守确认模式下 `permission_decision_for_tool()` 返回 `Confirm`；未确认调用在 `call_tool_with_audit()` 中先创建 pending request、emit `agent-permission-request` 并返回 `permission_required`，不会直接执行模型 prompt”：新增 Rust 测试 `ask_ai_model_requires_network_scope_confirmation_in_conservative_mode` 和脚本 `scripts/test-settings-mcp-ask-ai-permission.mjs`，绑定 Settings UI、scope、pending request controls、permission decision 与执行前确认路径。macOS smoke checklist closure 从 129/288 (44.8%) 提升到 130/288 (45.1%)；Agent/MCP、权限审计和测试发布粗估维持当前值。剩余仍是 `ask_ai_model` 成功调用审计脱敏行、`find_local_files` ignore 行、权限/审计 UI 行、插件证书链/完整 sandbox isolation，以及签名公证和自动更新。

**Batch 299 current delta:** 插件 manifest tool 白名单从“设置页/DB 同步已接近完成但用户启用后的插件 tool 仍无法进入 MCP `tools/list`”推进到“启用插件声明的 `tools` 会同步为 `plugin_<plugin>_<tool>`，默认关闭；用户打开后可被 `enabled_tool_registry()` 收录并通过 MCP `tools/list` 发现；插件禁用/不再同步后会从白名单移除”：新增 core 回归 `mcp_tools_list_includes_user_enabled_plugin_tools`，红灯证明 `ToolRegistry::list_enabled()` 旧逻辑仍用 `enabled_by_default && enabled` 导致用户启用的插件 tool 被排除；修复为以 `tool.enabled` 为准后转绿。新增 `scripts/test-settings-mcp-plugin-tool-whitelist.mjs`，同时绑定 Settings UI、plugin sync、默认关闭、用户启用后 MCP 曝露、插件禁用移除和 smoke checklist。macOS smoke checklist closure 从 128/288 (44.4%) 提升到 129/288 (44.8%)；Agent/MCP 和测试发布粗估维持当前值。剩余仍是 `ask_ai_model` 成功调用审计脱敏行、`find_local_files` ignore 行、权限/审计 UI 行、插件证书链/完整 sandbox isolation，以及签名公证和自动更新。

**Batch 298 current delta:** Settings `MCP 服务` 从“默认工具白名单 UI 已实现但 smoke checklist 仍未勾选”推进到“设置页通过 `list_agent_tools` 读取全部 Agent 工具，`工具开关` 区逐项显示工具名、描述、scope 列表、启用状态和切换动作，并由 Rust `builtin_tool_registry()` / `builtin_registry_contains_agent_whitelist` 证明默认内置工具精确为 8 个且包含 `ask_ai_model`”：新增 `scripts/test-settings-mcp-tool-whitelist.mjs`，同时读取 `SettingsPanel.svelte`、`src-tauri/src/agent_tools.rs`、`src-tauri/tests/agent_tools_tests.rs` 和 smoke checklist。红灯先通过 Settings UI 与 Rust whitelist 断言并失败在 smoke checklist 未勾选，更新 `docs/macos-smoke-checklist.md` 后目标测试转绿。macOS smoke checklist closure 从 127/288 (44.1%) 提升到 128/288 (44.4%)；Agent/MCP 和测试发布粗估维持当前值。剩余仍是 `ask_ai_model` 权限/审计行、`find_local_files` ignore 行、权限/审计 UI 行、插件证书链/完整 sandbox isolation，以及签名公证和自动更新。

**Batch 297 current delta:** Settings `MCP 服务` 从“配置合并写入行为已实现但 invalid JSON / 非对象 `mcpServers` 保护 smoke checklist 仍未勾选”推进到“设置页合并操作先弹 JSON 文件选择、取消选择不写入、确认写入只以 `serverName: "atools"` / `confirmed: true` 调用后端、后端错误会展示到 `mcpPageStatus`，且后端对无效 JSON 和非对象 `mcpServers` 均返回明确错误、保留原文件、不生成 `*.atools-backup-*` 副作用，由 Settings 源码断言和 Rust 文件写入测试共同守护”：新增 `scripts/test-settings-mcp-install-safety.mjs`，并补充 Rust 测试 `mcp_client_config_write_rejects_invalid_existing_json_without_overwrite` / `mcp_client_config_write_rejects_non_object_mcp_servers_without_overwrite`。红灯先通过 UI/backend 行为断言并失败在 smoke checklist 未勾选，更新 `docs/macos-smoke-checklist.md` 后目标测试转绿。macOS smoke checklist closure 从 126/288 (43.8%) 提升到 127/288 (44.1%)；Agent/MCP 和测试发布粗估维持当前值。剩余仍是插件 manifest tool 白名单行为、`ask_ai_model` 权限/审计行、`find_local_files` ignore 行、权限/审计 UI 行、插件证书链/完整 sandbox isolation，以及签名公证和自动更新。

**Batch 296 current delta:** Agent/MCP 独立面板从“合并到文件行为已实现但 smoke checklist 仍有 1 条未勾选”推进到“点击 `合并到文件...` 先弹 JSON 文件选择、取消选择不写入、确认写入只以 `serverName: "atools"` 调用后端，且后端强制显式确认、备份已有 JSON、保留顶层字段和其他 `mcpServers`、只替换/新增 `mcpServers.atools` 均由源码/Rust 测试断言守护”：新增 `scripts/test-agent-panel-mcp-install.mjs`，读取 `AgentPanel.svelte` 与 `src-tauri/src/commands.rs`，验证 UI 选择文件与取消短路顺序、`install_mcp_client_config` confirmed 调用参数，以及 Rust `mcp_client_config_write_requires_confirmation_and_backs_up_existing_file` / `mcp_client_config_merge_preserves_existing_servers_and_replaces_atools` 覆盖链。红灯先通过行为断言并失败在 smoke checklist 未勾选，更新 `docs/macos-smoke-checklist.md` 后目标测试转绿。macOS smoke checklist closure 从 125/288 (43.4%) 提升到 126/288 (43.8%)；Agent/MCP 和测试发布粗估维持当前值。剩余仍是工具白名单/Agent 工具行为行、插件证书链/完整 sandbox isolation，以及签名公证和自动更新。

**Batch 295 current delta:** Agent/MCP 独立面板从“客户端配置 UI 已实现但 smoke checklist 仍有 5 条未勾选”推进到“MCP bind 地址、脱敏 token、推荐连接方式、token 安全提示、HTTP/stdout 配置复制、4 类客户端模板、目标路径/合并步骤/可安全合并状态/复制/合并到文件动作和 Claude/Cursor 建议路径均由源码/共享模型断言守护”：新增 `scripts/test-agent-panel-mcp-config.mjs`，同时读取 `AgentPanel.svelte` 和 `mcpClientConfig.ts`，验证 AgentPanel 使用 `mcpConnectionView`、`mcpClientTemplates()`、`mcpClientInstallPlan()`、`saveDialog` 和 `mcpClientSuggestedTargetPath()`，并验证共享模板输出包含 `通用 HTTP MCP`、`通用 stdio proxy`、`Claude Desktop / Claude Code`、`Cursor` 以及 Claude/Cursor 默认路径。红灯先暴露了测试对组件直写模板文案的误判，修正为模型+结构断言后红灯落在 smoke checklist 未勾选，更新 `docs/macos-smoke-checklist.md` 后转绿。macOS smoke checklist closure 从 120/288 (41.7%) 提升到 125/288 (43.4%)；Agent/MCP 和测试发布粗估维持当前值。剩余仍是设置页配置合并无效 JSON/非对象保护行、工具白名单/Agent 工具行为行、插件证书链/完整 sandbox isolation，以及签名公证和自动更新。

**Batch 294 current delta:** 设置页 `MCP 服务` / `我的数据` 从“功能和页面已实现但 smoke checklist 仍有 15 条未勾选”推进到“Settings MCP 治理概览、权限策略、待确认请求、持久授权、最近调用审计、客户端模板、脱敏 token、推荐连接方式、我的数据 5 卡概览、本地隐私边界和审计数据概览均由源码/模型断言守护”：`scripts/test-mcp-governance-overview.mjs` 现在要求 SettingsPanel 渲染 `MCP 治理概览`、4 张治理卡、本地审计链路、权限模式和全部 scope 行、pending request 的 `允许一次` / `允许并记住` / `拒绝`、持久授权 `撤销`、最近审计和 `打开我的数据`、masked token、安全提示、推荐连接方式、客户端模板复制与合并到文件动作，并绑定 12 条 Settings `MCP 服务` smoke 项；`scripts/test-data-settings-overview.mjs` 现在要求 `我的数据` 5 张概览卡、本地隐私边界、审计数据概览、审计保留策略和归档动作，并绑定 3 条 smoke 项。红灯均落在 smoke checklist 未勾选，更新 `docs/macos-smoke-checklist.md` 后转绿。macOS smoke checklist closure 从 105/288 (36.5%) 提升到 120/288 (41.7%)；Agent/MCP、权限审计和测试发布粗估维持当前值。单独 Agent/MCP 面板客户端配置行已在 Batch 295 关闭；剩余仍是配置合并无效 JSON 保护行、工具白名单/Agent 工具行为行、插件证书链/完整 sandbox isolation，以及签名公证和自动更新。

**Batch 293 current delta:** 本地启动响应式行布局从“功能已实现但 1280px/窄屏 smoke checklist 仍未闭合”推进到“1280px 双列壳层、路径输入框独占一行、860px 字段堆叠、行级操作不挤压字段，并由源码断言守护”：`scripts/test-local-launch-settings.mjs` 现在要求 `.local-launch-row` 基础布局为 `48px minmax(0, 1fr)`，1280px 下切到 `42px minmax(0, 1fr)`，`.local-path-input` 保持 `grid-column: 1 / -1`，`.local-launch-actions` 始终落在内容列，且 860px 下 `.local-launch-fields` 堆叠为 `1fr`。红灯先落在缺少 1280px media rule，补齐 `src/components/SettingsPanel.svelte` 后转为 smoke checklist 未勾选，再更新 `docs/macos-smoke-checklist.md` 转绿。macOS smoke checklist closure 从 104/288 (36.1%) 提升到 105/288 (36.5%)；Settings shell/navigation、设置真实功能和 Home/search 估计维持当前值。MCP/我的数据 Settings 页面主要 smoke 已在 Batch 294 关闭；剩余仍是插件证书链/完整 sandbox isolation，以及签名公证和自动更新。

**Batch 292 current delta:** Home/search 顶部 Web preview smoke 从“行为已实现但 smoke checklist 仍有 6 条未勾选”推进到“ZTools 风格搜索框、空搜索固定/最近顺序、固定空态和管理入口、首页四入口、`set` 结果分组元信息清单闭环且由源码/模型断言守护”：`scripts/test-z-mark.mjs` 现在要求 prominent search input、右侧三笔画 Z badge 和 smoke 项保持 `[x]`；`scripts/test-home-surface.mjs` 现在要求空搜索时 `固定` 在 `最近使用` 之前、无固定项时显示紧凑 `固定` 空态、`管理固定指令` 进入 `所有指令`、首页上方四个紧凑入口可见且没有营销说明块，并绑定对应 smoke 项；`scripts/test-result-presentation.mjs` 现在要求搜索结果按来源分组、行内标题/说明/source detail/match label 渲染链路，并绑定 `set` grouped-result smoke 项。红灯均落在 smoke checklist 未勾选，更新 `docs/macos-smoke-checklist.md` 后转绿。macOS smoke checklist closure 从 98/288 (34.0%) 提升到 104/288 (36.1%)；Home/search 粗估从 88% 到 89%，其他模块估计维持当前值。Local Launch 1280px/窄屏行布局已在 Batch 293 关闭；剩余仍是 MCP/我的数据人工项、插件证书链/完整 sandbox isolation，以及签名公证和自动更新。

**Batch 291 current delta:** 首页图标和结果元信息从“行为已实现但 smoke checklist 仍有 5 条未勾选”推进到“首页常用入口图标、最近磁贴来源图标、ZTools 导入入口、搜索结果 fallback 图标和匹配标签 tone 清单闭环且由源码/模型断言守护”：`scripts/test-home-quick-action-icons.mjs` 现在要求 Home 四个常用入口使用明确 SVG 图标、避免入口文字首字 fallback、按钮具备 `打开...` aria label，并要求对应 smoke 项保持 `[x]`；`scripts/test-home-recent-type-icons.mjs` 现在要求最近/固定磁贴通过 `ResultTypeIcon` 渲染来源类型 SVG 图标、38px icon shell 和无标题首字 fallback；`scripts/test-ztools-import-view.mjs` 现在要求导入面板初始等待态、`选择目录并扫描`、不在 mount 时自动导入，并绑定导入入口 smoke 项；`scripts/test-result-type-icons.mjs` 现在要求搜索结果 fallback 图标覆盖 system/app/folder/web/link/text/paste/history/alias/plugin 且保留真实 app icon asset 转换路径；`scripts/test-match-type-meta.mjs` 现在要求 alias/fuzzy match metadata 和匹配 tone smoke 项保持 `[x]`。红灯均落在 smoke checklist 未勾选，更新 `docs/macos-smoke-checklist.md` 后转绿。macOS smoke checklist closure 从 93/288 (32.3%) 提升到 98/288 (34.0%)；Home/search 粗估从 87% 到 88%，其他模块估计维持当前值。剩余的 Home pinned-empty 管理入口、首屏四入口可见性和 `set` 结果分组已在 Batch 292 关闭；Local Launch 1280px/窄屏行布局、MCP/我的数据人工项、插件证书链/完整 sandbox isolation，以及签名公证和自动更新仍待收口。

**Batch 290 current delta:** 首页状态栏、Z badge 和通用设置从“功能已实现但 smoke checklist 仍有 11 条未勾选”推进到“首页 34px 状态栏、固定/最近使用状态文案、固定分区容量隔离、Z 图标进入设置、最近使用开关、最近/固定行数、设置持久化、暗黑主题、橙色主题色和自定义主题色清单闭环且由源码/设置规范化断言守护”：`scripts/test-search-status-bar.mjs` 现在要求 Home/search 底部状态栏、Settings 页不显示底栏、固定/最近状态文案和 smoke 项保持 `[x]`；`scripts/test-home-search-overview.mjs` 现在要求 `SearchBar` Z badge 在首页显示、携带 `打开设置` aria label，并通过 `openSettingsMenu("general")` 进入设置；`scripts/test-home-surface.mjs` 和 `scripts/test-home-pinned-sections.mjs` 现在要求最近/固定分区按 `rows * 9` 限制且固定项超出不会挤占最近使用区域；`scripts/test-general-settings-overview.mjs` 现在要求关闭 `showRecentInSearch` 后首页不展示最近使用；`scripts/test-settings-normalization.mjs` 现在通过真实 `saveAToolsSettings` / `loadAToolsSettings` / `applyAToolsAppearance` 验证设置持久化、dark/orange/custom theme 和 CSS 变量应用。红灯过程中修正了 `test-search-status-bar` 对 SettingsPanel 的过宽文本排除断言，以及 `test-settings-normalization` 对当前暗色 CSS 变量的旧值期望。macOS smoke checklist closure 从 82/288 (28.5%) 提升到 93/288 (32.3%)；Home/search 粗估从 86% 到 87%，设置页 shell/navigation 维持 88%，设置页真实功能和测试发布估计维持当前值。剩余仍是本地启动 1280px/窄屏行布局、MCP/我的数据人工项、插件证书链/完整 sandbox isolation，以及签名公证和自动更新。

**Batch 289 current delta:** 设置页 shell/layout/menu/dialog 从“样式和交互已实现但 smoke checklist 仍有 9 条未勾选”推进到“设置页外壳、顶部更多菜单、内嵌确认弹窗、860px 响应式壳层、侧栏/内容/控件/滚动条清单闭环且由源码断言守护”：`scripts/test-settings-header-style.mjs` 现在要求 94px 顶部标签、72px tab、小/大三笔画圆形 Z 标识和 smoke 项保持 `[x]`；`scripts/test-settings-header-menu.mjs` 现在要求更多菜单、复制运行信息状态、Esc 只关菜单和回到主搜索 smoke 项保持 `[x]`；`scripts/test-settings-confirm-dialog.mjs` 现在要求危险操作走 `SettingsConfirmDialog`、无浏览器原生 `confirm`、Esc/取消只关闭弹窗；`scripts/test-settings-ztools-scale.mjs`、`test-settings-sidebar-style`、`test-settings-content-style`、`test-settings-controls-style`、`test-settings-scrollbar-style` 现在要求设置页 860px shell、低视口 `min(100vh, target)`、左右区域无横向溢出、大控件和滚动条 smoke 项保持 `[x]`。红灯过程中补了 `src/components/SettingsPanel.svelte` 窄屏输入/下拉/数字控件 `max-width: 100%`，补齐无横向溢出的证据链。macOS smoke checklist closure 从 73/288 (25.3%) 提升到 82/288 (28.5%)；设置页 shell/navigation 粗估从 87% 到 88%，设置页真实功能和测试发布估计维持当前值。剩余仍是首页 Z 图标/固定项状态栏、本地启动窄屏行布局、通用设置持久化/主题项、MCP/我的数据人工项、插件证书链/完整 sandbox isolation，以及签名公证和自动更新。

**Batch 288 current delta:** 设置页 `快捷键` / `所有指令` / `唤醒黑名单` 从“页面、模型和运行时已实现但 smoke checklist 仍有 15 条未勾选”推进到“快捷键、指令中心和添加当前窗口清单闭环且由模型/UI 源码/运行时断言守护”：`scripts/test-settings-pages.mjs` 现在要求呼出快捷键齿轮预设、三 tab 快捷键页、8 个内置应用快捷键、自定义快捷键创建/编辑/冲突和指令别名入口 smoke 项保持 `[x]`；`scripts/test-app-shortcuts.mjs` 现在要求自定义应用快捷键经设置持久化/恢复、主搜索触发、普通可编辑输入框保护和对应 smoke 项保持 `[x]`；`scripts/test-command-center-settings.mjs` 现在要求所有指令统计卡、来源筛选、行级详情/别名入口、本地/网页启停、系统指令禁用、搜索/状态筛选和 smoke 项保持 `[x]`；`scripts/test-pinned-commands.mjs` 现在要求固定/取消固定经设置页持久化并同步到主搜索首页；`scripts/test-wakeup-blacklist.mjs` 现在要求桌面 `read_frontmost_app_name` 添加当前窗口和 Web 预览禁用提示。macOS smoke checklist closure 从 58/288 (20.1%) 提升到 73/288 (25.3%)；设置页真实功能、Home/search 和测试发布估计维持当前值。剩余仍是通用设置持久化/主题项、MCP/我的数据人工项、插件证书链/完整 sandbox isolation，以及签名公证和自动更新。

**Batch 287 current delta:** 设置页 `网页快开` / `本地启动` 从“页面和模型已实现但 smoke checklist 仍有 5 条未勾选”推进到“快开/本地启动清单闭环且由模型/UI 源码断言和 desktop smoke 守护”：`scripts/test-web-quick-open-overview.mjs` 现在要求默认 Google/GitHub/NPM、卡片启停、关键字 chip、URL 预览、编辑/预览/删除动作、URL wrap 和 smoke 项保持 `[x]`；`scripts/test-web-quick-open-settings.mjs` 现在要求页面内编辑器、搜索模板/固定网址切换、字段编辑、URL 预览、Esc 关闭、保存校验委托、删除确认和 smoke 项保持 `[x]`；`scripts/test-local-launch-settings.mjs` 现在要求文件/文件夹/应用选择、Web 预览禁用、拖拽、手动添加、打开/定位/删除、删除确认、添加/移除持久化和 smoke 项保持 `[x]`。本批不改生产实现，修复验证覆盖和文档完成度漂移；设置页真实功能、Home/search 和测试发布估计维持当前值。剩余仍是本地启动 1280px/窄屏布局直接验证、MCP/我的数据等未闭合 smoke 项、插件证书链/完整 sandbox isolation，以及签名公证和自动更新。

**Batch 286 current delta:** 设置页 `调试日志` 从“功能已实现但 smoke checklist 仍有 2 条未勾选”推进到“调试日志清单闭环且由 Debug 模型/UI 源码断言、Rust runtime/crash tests 和 desktop data_debug_smoke 守护”：`scripts/test-debug-settings-overview.mjs` 现在要求页面展示环境信息、桌面运行状态、本地配置状态、MCP 状态、崩溃日志、最近审计错误，并要求对应 smoke 项保持 `[x]`；`scripts/test-debug-diagnostics.mjs` 现在要求复制内容为 `atools_diagnostic_bundle`，且不包含 MCP token、AI API Key、WebDAV 密码和 proxy 凭据，并要求 smoke 项保持 `[x]`。本批不改生产实现，修复验证覆盖和文档完成度漂移；设置页真实功能和测试发布估计维持 99%。剩余仍是非 Debug 的快捷键/手工 smoke 项、插件证书链/完整 sandbox isolation，以及签名公证和自动更新。

**Batch 285 current delta:** 设置页 `WebDAV 同步` 从“实现和测试已具备但 smoke checklist 多项未勾选”推进到“WebDAV 清单闭环且由前端模型/UI 源码断言、Rust WebDAV 集成测试和 desktop smoke 共同守护”：`scripts/test-webdav-sync-view.mjs` 现在要求 Web 预览按钮禁用文案、同步/预览/恢复计划摘要、设置恢复、剪贴板导入、内嵌确认和当前能力范围 smoke 项保持 `[x]`；`scripts/test-webdav-settings-overview.mjs` 现在验证 WebDAV 字段、http/https 启用门槛、本地凭据/隐私说明、确认弹窗先于 native invoke、取消状态和追加/脱敏恢复说明；Rust WebDAV tests 覆盖上传+manifest 校验、preview read-only、恢复计划 diff、设置恢复确认+跳过 `<redacted>`、剪贴板确认+追加导入。本批不改生产实现，修复验证覆盖和文档完成度漂移；设置页真实功能和测试发布估计维持 99%。剩余仍是完整远端覆盖本机全部数据、live WebDAV provider 手工矩阵、插件证书链/完整 sandbox isolation，以及签名公证和自动更新。

**Batch 284 current delta:** 设置页 `已安装插件` 从“实现和测试已具备但 smoke checklist 未勾选”推进到“插件管理清单闭环且由模型/UI/Rust targeted tests 守护”：`scripts/test-plugin-inventory.mjs` 现在要求 6 条已安装插件 smoke 项为 `[x]`；共享模型测试覆盖总数/启停/feature 统计、来源标记、feature 预览、关键词/状态/来源筛选、选中插件详情、导入/内置插件动作可用性和 manifest 能力审计；SettingsPanel 回归覆盖本地目录安装/更新、Finder 定位、授权启用、卸载确认、持久运行时授权清除和 Web 预览保护；Rust targeted test 覆盖本地同 ID 更新保留启停状态并拒绝当前安装目录/重叠路径。本批不改生产实现，修复验证覆盖和文档完成度漂移；插件安装/导入/市场、设置页 UI/真实功能和测试发布估计维持 99%。剩余仍是完整插件权限隔离、证书链/吊销/平台级签名策略、更广第三方视觉/native replay，以及签名公证和自动更新。

**Batch 283 current delta:** 设置页 `AI 模型` 从“功能和后端已实现但 smoke checklist 仍未勾选”推进到“AI 模型清单闭环且由前端/Rust 测试共同守护”：`scripts/test-ai-settings-overview.mjs` 现在要求 6 条 AI 模型 smoke 项为 `[x]`；前端测试继续覆盖 AI 概览、Web 预览下测试连接禁用和 `/models` 结果行，Rust 测试覆盖连接测试只请求 `/v1/models`、`ask_ai_model` 使用保存的 Agent AI 设置请求 `/v1/chat/completions` 且工具输出不包含 API key。本批不改生产实现，修复验证覆盖和文档完成度漂移；设置页 UI/真实功能、Agent/MCP 底座和测试发布估计维持 99%。剩余仍是 live provider credential/manual flow、更多 MCP 客户端实测、插件证书链/完整 sandbox isolation，以及签名公证和自动更新。

**Batch 282 current delta:** 设置页 `关于` 从“功能已实现但 macOS smoke checklist 仍未勾选”推进到“清单闭环且有回归约束”：`scripts/test-about-settings.mjs` 现在要求 About 复制运行信息隐藏 MCP token、`打开 MCP 服务` 直达 `mcp` 设置页，并要求 `docs/macos-smoke-checklist.md` 中四条 About smoke 项为 `[x]`。本批不改 About 页面生产实现，修复的是验证覆盖和文档完成度漂移；`pnpm test:about-settings` 先红在未勾选清单，更新文档后转绿，`pnpm test:about-overview` 继续通过。设置页 UI/真实功能和测试发布估计维持 99%；剩余仍是快捷键/WebDAV/已安装插件等手工 smoke 未勾选项，以及插件证书链、完整 sandbox isolation、签名公证和自动更新。

**Batch 281 current delta:** 插件生态从“iframe native/system method probe queue”推进到“native context bridge 可执行且 large-srcdoc probe 不误超时”：`src-tauri/capabilities/default.json` 现在用 scoped `shell:allow-execute` 允许 `osascript -e <non-empty script>`，真实 desktop smoke 不再出现 `Scoped command osascript not found`；`PluginPanel` smoke probe wait 从固定低 timeout 改为按最终 `srcdoc` 字节数计算，12s 起步、15s 封顶，避免 5MB 级真实入口在 bridge/native probe 回传前被误判。最新 plan smoke 基线为 10 planned、9 imported、9 activated、9 ui actions checked、9 `plugin_panel_fs_load_checked`、9 assertions checked、9 cleanup verified、1 skipped，且 `plugin_panel_render_smoke` 渲染/探测 8/8 render-safe external plan samples，40/40 bridge checks 和 32/32 native method checks 通过；标准 smoke 保持 1/1 indexed PluginPanel render sample、5/5 bridge checks 和 4/4 native method checks。插件安装/导入、插件 iframe 宿主和测试发布估计维持 99%；剩余是真实逐插件视觉截图、plugin-authored interaction replay、side-effecting native bridge coverage、证书链/吊销/平台级签名策略、完整 iframe sandbox/cross-origin capability isolation、BrowserWindow 子 iframe same-origin 兼容债和 macOS 签名/公证/自动更新。

**粗略结论：** 内置程序体验已经接近 macOS 首版可日用，主搜索、设置真实功能、本地工具底座和真实桌面 smoke 是当前强项；整体替代 ZTools/uTools 前的主要缺口仍集中在更广第三方插件视觉/交互回归、完整插件隔离、证书链/吊销/平台级签名策略，以及签名、公证、自动更新。

## 2. 已经完成的可复用基础

- [x] `src/lib/settings.ts`：设置默认值、规范化、localStorage/Tauri DB 双通道保存、外观变量应用、native 设置调用。
- [x] `src/App.svelte`：设置实时加载和 `atools-settings-updated` 联动；最近使用、placeholder、默认高度已接入。
- [x] `src/components/SettingsPanel.svelte`：ZTools 风格设置页骨架；通用设置真实保存；开关控件可点击；主题色和明暗主题联动。
- [x] `src/components/HomePanel.svelte`：首页常用入口、9 列最近使用；最近行数受设置控制。
- [x] `src/components/PluginPanel.svelte`：HTML/JS 插件 iframe 宿主、preload 注入、subInput、基础 `utools/ztools` bridge。
- [x] `src/components/AgentPanel.svelte`：MCP 状态、权限模式、工具开关、授权、待确认请求、审计分页加载、保存筛选视图和导出。
- [x] `src-tauri/src/mcp_server.rs` + `crates/atools-core/src/mcp.rs`：本地 MCP HTTP server、token、initialize/ping/initialized notification/tools/list/tools/call。
- [x] `src-tauri/src/agent_tools.rs`：默认 8 个 Agent 工具和审计链路；`ask_ai_model` 已接入 AI 默认模型配置。
- [x] `src-tauri/src/hotkey.rs`：保存热键后动态注册，macOS `Option+Z` label 归一化。
- [x] `src-tauri/src/tray.rs` + `src-tauri/src/commands.rs`：托盘可见性、macOS LaunchAgent 开机自启命令。

## 3. 关键未完成清单

### P0：macOS 首版必须完成

- [x] 主搜索体验接近 uTools/ZTools：结果分组、键盘选择、首页常用入口、最近使用、空格/Tab 行为、搜索状态高度和焦点已完成基础闭环。
- [ ] 设置页真实功能补齐：快捷键、插件管理、MCP、我的数据、调试日志不能继续是占位页。
- [ ] 插件 bridge 高优 API 补齐：dialog、shell、clipboard 文件/图片、screen capture、当前浏览器 URL、Finder 路径、feature 动态注册。
- [ ] Agent 工具从 demo 变成可用：剪贴板历史搜索、文件搜索索引/通配忽略规则、图片压缩质量目标和 lossless WebP 输出、当前浏览器 URL/Finder 路径上下文、OCR macOS 原生或稳定本地服务、批量重命名 dry-run。
- [x] 权限确认 UI：工具调用需要弹出明确确认，而不是只在 Agent 页待确认列表里出现。
- [x] 审计详情/回放：已显示输入输出、路径、副作用、耗时、确认结果、回放摘要、审计筛选、副作用 diff，并支持后端分页查询、筛选导出/清空。
- [x] scope 级权限阻断：Agent scope 可在 UI 中设置为确认/阻断，阻断优先级高于 developer 模式和按工具授权。
- [ ] macOS app smoke：已覆盖 `pnpm tauri build`、启动、MCP 连接、权限确认链路、审计查看；热键、托盘、自启和插件运行仍需人工/专项 smoke。

### P1：ZTools/uTools 体验增强

- [ ] 拼音/模糊搜索、命令别名、应用搜索、本地启动项。
- [ ] 插件市场/插件详情/启停/卸载/数据清理。
- [ ] 自动粘贴搜索框、自动清空搜索框、自动返回搜索。
- [ ] 唤醒黑名单：识别当前前台 app/window，并在热键触发前判断。
- [ ] 超级面板/悬浮球：基础独立窗口已接入；后续可再补选中文本触发、拖拽/吸边等增强。
- [x] WebDAV 远端备份上传、manifest 读取校验、远端备份预览、恢复计划 diff 预览、设置恢复确认流、剪贴板历史追加导入、插件数据追加导入、插件数据冲突覆盖导入和逐文档冲突选择；AI 配置已接入 `ask_ai_model` Agent 工具调用。

### P2：Windows 和发布质量

- [ ] WebView2 差异、路径/权限/快捷键、安装包、签名。
- [ ] 自动更新、崩溃恢复、日志采集。
- [ ] 前端测试框架、插件兼容测试夹具、MCP 集成测试。

## 4. Subagent 工作包拆分

### Task A：主搜索体验对齐

**Owner:** Worker A  
**Write scope:** `src/App.svelte`, `src/components/SearchBar.svelte`, `src/components/HomePanel.svelte`, `src/components/ResultsList.svelte`, `src/lib/uiState.ts`, optional `src/styles/global.css`  
**Do not touch:** `src/components/SettingsPanel.svelte`, `src/components/PluginPanel.svelte`, Rust files.

**Goal:** 主搜索页更接近 ZTools/uTools 的命令面板行为，补齐空格/Tab、分组、焦点和结果状态。

- [ ] 梳理当前搜索状态机：home、query results、settings、plugin。
- [ ] 增加 `appSettings.spaceOpenCommand` 和 `appSettings.tabKeyFunction` 的实际行为。
- [ ] 结果列表补上分组/来源显示、选中态和空状态，不允许文字溢出。
- [ ] 最近使用点击后保持搜索框焦点；Esc 返回逻辑不抖动。
- [ ] 验证：`pnpm check`、`pnpm build`、浏览器打开 `http://127.0.0.1:1420/?parity=1`，测试输入、上下键、Enter、Esc。

**Acceptance:**
- 空搜索显示最近使用；关闭最近使用后只显示搜索框。
- 输入 `>` 能列出系统命令，键盘选择明显。
- `spaceOpenCommand=false` 时空搜索按 Space 不误触发；开启后按 Space 打开选中命令。
- Tab 行为按设置切换。

### Task B：设置页真实页面补齐

**Owner:** Worker B  
**Write scope:** `src/components/SettingsPanel.svelte`, `src/lib/settings.ts`, optional `src/components/SystemPanel.svelte`  
**Do not touch:** `src/components/PluginPanel.svelte`, `src-tauri/src/agent_tools.rs`.

**Goal:** 把设置页里最影响体验的占位菜单变成真实可用页面。

- [ ] 将 `快捷键` 页拆为独立内容：呼出快捷键、应用内快捷键说明、冲突/保存状态。
- [ ] 将 `MCP 服务` 页接入现有 `get_mcp_status`、工具开关入口、token 展示和复制配置提示。
- [ ] 将 `我的数据` 页接入审计/设置/插件数据的清空导出入口，危险操作要确认。
- [ ] 将 `调试日志` 页显示当前环境、MCP 状态、最近审计错误、构建/平台信息。
- [ ] 对未实现设置项显示“未启用”或禁用态，不再给用户假开关。
- [ ] 验证：`pnpm check`、`pnpm build`，浏览器点每个菜单不出现空白或布局错位。

**Acceptance:**
- 设置页左侧菜单至少 `通用设置`、`快捷键`、`MCP 服务`、`我的数据`、`调试日志` 是真实页面。
- 未实现的 `GPU 启动参数/证书链与吊销/完整 sandbox 隔离/运行时逐 API 授权持久化和集中管理` 明确禁用或说明状态。
- 保存状态不会卡在“保存中”。

### Task C：插件 bridge 兼容补齐

**Owner:** Worker C  
**Write scope:** `src/components/PluginPanel.svelte`, `src-tauri/src/commands.rs`, `crates/atools-api-shim/src/handler.rs`, `crates/atools-api-shim/tests/handler_tests.rs`  
**Do not touch:** settings UI or Agent tools.

**Goal:** 补齐 ZTools/uTools 高频插件 API，让导入插件有更高概率能跑。

- [ ] `showOpenDialog` / `showSaveDialog` 通过 Tauri dialog 实现。
- [ ] `copyImage` / `copyFile` / `getCopyedFiles` 做到 macOS 可用或返回明确错误，不静默假成功。
- [ ] `shellShowItemInFolder` 在 macOS 使用 `open -R`。
- [ ] `screenCapture` 先做 macOS 截图命令或明确权限错误。
- [ ] `readCurrentBrowserUrl` / `readCurrentFolderPath` 先做 macOS AppleScript/Finder 路径读取。
- [ ] `db.promises` 行为保持 promise；`postAttachment/getAttachment` 不再空实现。
- [ ] 验证：新增/更新 Rust 测试；用内置插件 timestamp/json/qr/color 手动 smoke。

**Acceptance:**
- 不允许 bridge API “返回成功但实际没做事”，除非文档明确是 unsupported。
- 插件 API 错误要能在插件面板或 console 中定位。
- `pnpm check`、`pnpm build`、`cargo test -p atools-api-shim`、`cargo test -p atools --lib` 通过。

### Task D：Agent 内置工具生产化

**Owner:** Worker D  
**Write scope:** `src-tauri/src/agent_tools.rs`, `src-tauri/tests/agent_tools_tests.rs`, `crates/atools-core/tests/agent_tests.rs`  
**Do not touch:** Svelte UI except type changes if unavoidable.

**Goal:** 把内置 Agent 工具从 demo 变成有 dry-run、错误语义和 macOS 可用性的首版。

- [ ] `rename_files` 校验目标路径冲突、父目录存在、dry-run 输出完整计划。
- [ ] `find_local_files` 增加忽略目录、最大深度、权限错误跳过统计。
- [ ] `open_or_reveal_path` 非 macOS 不误用 `xdg-open` 作为 Windows 答案；macOS `open -R` 失败要返回错误。
- [ ] `compress_images` 至少返回原始大小/输出大小；macOS `sips` 失败不能标记 compressed。
- [ ] `ocr_image` 本地服务不可用时输出 actionable error；输入 mime 不固定 png。
- [ ] `get_current_context` 增加前台 app/Finder 路径占位实现或明确空字段原因。
- [ ] 验证：为每个工具补 Rust 单测，`cargo test -p atools --test agent_tools_tests` 通过。

**Acceptance:**
- 每个工具失败时 `isError=true` 且审计记录 error。
- 文件副作用默认 dry-run；执行前能被权限确认链路拦截。
- 测试覆盖允许、失败、dry-run、路径冲突。

### Task E：权限确认弹窗和审计详情

**Owner:** Worker E  
**Write scope:** `src/components/AgentPanel.svelte`, new optional component `src/components/PermissionConfirmDialog.svelte`, `src/lib/types.ts`, optional `src/App.svelte` event wiring  
**Do not touch:** Rust Agent tool execution.

**Goal:** Agent 调工具时用户能在当前主窗口看到确认 UI，并能查看审计详情。

- [ ] 监听 `agent-permission-request`，显示非阻塞但明显的确认弹窗。
- [ ] 弹窗展示客户端、工具名、scope、关键参数、风险提示。
- [ ] 提供“允许一次”“允许并记住”“拒绝”三种动作。
- [ ] 审计列表支持点击展开完整 input/output/error/duration/status。
- [ ] 验证：`pnpm check`、`pnpm build`；浏览器模拟 pending request UI 状态。

**Acceptance:**
- 用户不进入 Agent 页也能看到确认请求。
- 审计详情不被截断；长 JSON 可滚动。
- 危险工具默认不自动执行。

### Task F：macOS 发布 smoke 和文档

**Owner:** Worker F  
**Write scope:** `docs/agent-mcp-client.md`, new `docs/macos-smoke-checklist.md`, optional `src-tauri/tauri.conf.json` only if required  
**Do not touch:** feature code unless smoke reveals minimal config fix.

**Goal:** 建立 macOS 首版交付检查清单。

- [ ] 写清 `pnpm dev`、`pnpm tauri dev`、`pnpm tauri build` 的 smoke 步骤。
- [ ] 写清热键、托盘、自启、MCP、插件导入、权限确认、审计导出的验证步骤。
- [ ] 写清 Claude/Codex/Cursor/ChatGPT 连接 MCP 的配置示例。
- [ ] 记录当前已知限制和不阻塞 macOS 首版的问题。

**Acceptance:**
- 新机器可以按文档完成 smoke。
- 文档不声称未实现功能已完成。

## 5. 第一批并行建议

建议先并行启动：

1. **Task D Agent 内置工具生产化**：主要 Rust，和 UI 冲突少。
2. **Task B 设置页真实页面补齐**：主要 SettingsPanel，不碰插件/Agent tool。
3. **Task C 插件 bridge 兼容补齐**：插件兼容主线，和 Task B/D 文件重叠少。

主线程或后续再做：

4. **Task A 主搜索体验对齐**：会动 App/Search/Results，容易和确认弹窗/App 事件冲突，适合单独做。
5. **Task E 权限确认弹窗和审计详情**：会动 App/AgentPanel，等 Task A 或当前 UI 状态稳定后做。
6. **Task F macOS 发布 smoke 和文档**：可以穿插做，但最好等功能再推进一轮。

## 6. 当前验证基线

最近一次已跑通：

```bash
pnpm check
pnpm build
cargo test -p atools --lib
pnpm smoke:tauri-desktop
```

浏览器验证过：

- 设置页打开、关闭。
- 最近使用开关关闭后主页隐藏，刷新后保持。
- 最近使用行数设为 1 后主页渲染 9 个项目。
- 主题切 dark + 橙色时 `rootTheme=dark`、`--accent=#ea580c`。
- 测试后恢复为 system + 紫色 + 最近使用 2 行。

已知验证限制：

- 当前 Codex 内置浏览器自动化无法完成输入框 `fill`，报 virtual clipboard 未安装；placeholder 输入链路只做了代码接入，未完成自动化输入验证。
- 当前 repo 没有 git 仓库元数据，无法依赖 commit/worktree 流程。

## 7. 执行规则

- 每个 subagent 必须只修改自己的 write scope。
- 不允许把未实现功能做成“看起来成功”的假实现；必须返回明确 unsupported/error。
- 涉及本地副作用的工具默认 dry-run，执行路径必须走权限/审计。
- 每个任务结束必须报告：
  - 修改文件列表
  - 通过的验证命令
  - 未完成/风险
  - 是否需要主线程集成

## 8. 2026-06-02 第一批 Subagent 执行结果

### Worker D：Agent 内置工具生产化

状态：DONE_WITH_CONCERNS，已集成。

修改文件：

- `src-tauri/src/agent_tools.rs`
- `src-tauri/tests/agent_tools_tests.rs`

完成：

- `find_local_files` 支持忽略目录、最大深度、权限错误跳过统计。
- `rename_files` dry-run 输出完整计划，并校验目标冲突、父目录缺失。
- `open_or_reveal_path` 命令失败返回 error，不再假成功。
- `compress_images` 返回原始大小/输出大小，macOS `sips` 失败不标记 compressed。
- `ocr_image` 使用输入 mime，本地服务不可用时返回 actionable error。
- `get_current_context` 增加前台 app/Finder 字段的空值原因。

保留风险：

- `compress_images` 已支持 `max_bytes` best-effort 质量目标并返回达标状态；WebP 输出仍未接入。
- 当前浏览器 URL 仍未做真实读取，只返回明确 reason。
- 前台 app/Finder 依赖 macOS Automation 权限。

### Worker B：设置页真实页面补齐

状态：DONE_WITH_CONCERNS，已集成。

修改文件：

- `src/components/SettingsPanel.svelte`
- `src/lib/settings.ts`

完成：

- `快捷键` 页改成真实页面。
- `MCP 服务` 页接入 MCP 状态、工具开关、token 和客户端配置复制。
- `我的数据` 页接入设置/审计/插件数据导出和清空，危险操作有确认。
- `调试日志` 页显示环境、MCP、最近审计错误和平台信息。
- 未实现设置改为 disabled/未启用，不再给假开关。
- native 设置失败不再被吞掉，热键冲突/注册失败会反映为保存失败。

保留风险：

- 需要在 `pnpm tauri dev` 中验证真实 Tauri IPC。
- 插件数据清空目前逐条删除，大数据量下会慢。

### Worker C：插件 bridge 兼容补齐

状态：DONE_WITH_CONCERNS，已集成；主线程补充注册了新增 Tauri commands。

修改文件：

- `src/components/PluginPanel.svelte`
- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`
- `crates/atools-api-shim/src/handler.rs`
- `crates/atools-api-shim/tests/handler_tests.rs`

完成：

- `showOpenDialog` / `showSaveDialog` 走 Tauri dialog。
- `copyImage` / `copyFile` / `getCopyedFiles` 不再静默假成功。
- `shellShowItemInFolder` macOS 使用 `open -R`。
- `screenCapture` macOS 使用 `screencapture -i`。
- `readCurrentBrowserUrl` / `readCurrentFolderPath` 使用 AppleScript 读取 Chrome/Edge/Safari/Finder。
- `db.promises` 保持 promise；attachment API 不再空实现。
- shim 对 native-only/unknown IPC 返回明确 unsupported/error。

保留风险：

- macOS `osascript`、`screencapture`、剪贴板文件操作依赖系统权限。
- 仍需要导入真实 ZTools 插件做兼容矩阵回归。

### 集成验证

已通过：

```bash
cargo fmt --check
pnpm check
pnpm build
cargo test -p atools --lib
pnpm smoke:tauri-desktop
cargo test -p atools --test agent_tools_tests
cargo test -p atools-api-shim
cargo test -p atools-core --test agent_tests
```

验证结果：

- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过。
- `cargo test -p atools --lib`：13 passed。
- `cargo test -p atools --test agent_tools_tests`：16 passed。
- `cargo test -p atools-api-shim`：17 passed。
- `cargo test -p atools-core --test agent_tests`：8 passed。

未完成验证：

- 本轮浏览器自动化 smoke 未完成。Codex in-app Browser、独立 Playwright MCP、headless Chrome MCP 均在点击/导航阶段超时；`curl` 确认 dev server 返回 200。
- 需要后续用人工或稳定 CDP 会话验证 `pnpm tauri dev` 下的设置页真实 IPC、插件 bridge 系统权限、MCP token/工具开关。

## 9. 2026-06-02 第二批 Subagent 执行结果

### Worker A：主搜索体验对齐

状态：DONE，已集成。

修改文件：

- `src/App.svelte`
- `src/components/SearchBar.svelte`
- `src/components/HomePanel.svelte`
- `src/components/ResultsList.svelte`

完成：

- 主状态机明确拆成 home search、query results、settings/plugin panel。
- 结果/最近项键盘行为只在 home search 态消费，避免影响插件/设置页。
- `spaceOpenCommand=false` 时空搜索 Space 不触发命令；开启后 Space 打开当前选中最近项。
- `tabKeyFunction=navigate` 时 Tab/Shift+Tab 在结果或最近项间循环移动。
- `tabKeyFunction=target-command` 时系统命令进入目标页，普通命令安全填入搜索框。
- 最近使用新增键盘选中态，鼠标悬停/点击和键盘共享选中索引。
- ResultsList 增加来源分组、来源/匹配标签、清晰选中态和固定空状态，长文本 ellipsis 防溢出。

保留风险：

- Web smoke 无 Tauri runtime，真实插件 `activate_feature` 路径未做端到端验证。
- 仍需要和真实 uTools/ZTools 对比微调视觉间距、焦点和输入节奏。

### Worker E：权限确认弹窗和审计详情

状态：DONE_WITH_CONCERNS，已集成。

修改文件：

- `src/App.svelte`
- `src/components/AgentPanel.svelte`
- `src/components/PermissionConfirmDialog.svelte`

完成：

- 新增全局 `PermissionConfirmDialog`。
- `App.svelte` 启动时拉取 `list_pending_agent_requests`，并监听 `agent-permission-request`。
- 非 Agent 页也能显示权限确认弹窗。
- 弹窗展示客户端、工具名、scope、关键参数、风险提示。
- 动作：
  - 允许一次：`call_agent_tool` with `confirmed: true`，然后 dismiss。
  - 允许并记住：`grant_agent_tool` + dismiss，不直接执行。
  - 拒绝：dismiss。
- AgentPanel 审计详情增强，展示完整 input/output/error/status/duration/timestamp/client_id。
- 空 output/error 显示明确占位；长 JSON 使用滚动区域。

保留风险：

- 未在 `pnpm tauri dev` 下触发真实 `agent-permission-request` 事件做端到端 smoke。
- “允许一次”会重新执行工具；这符合当前 Rust 命令能力，但用户需要理解该动作有副作用。

### 第二批集成验证

已通过：

```bash
pnpm check
pnpm build
cargo fmt --check
cargo test -p atools --lib
cargo test -p atools --test agent_tools_tests
cargo test -p atools-api-shim
curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:1420/?parity=1'
```

验证结果：

- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过。
- `cargo fmt --check`：通过。
- `cargo test -p atools --lib`：13 passed。
- `cargo test -p atools --test agent_tools_tests`：16 passed。
- `cargo test -p atools-api-shim`：17 passed。
- dev server HTTP：`200`。

当前完成度更新：

| 模块 | 第一批前 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Tauri/Rust 桌面底座 | 55% | 60% | native 设置和 bridge 命令已接入 |
| ZTools/uTools 主搜索体验 | 30% | 45% | 键盘、Tab/Space、分组、选中态已补 |
| ZTools 设置页 UI/功能 | 45% | 60% | 关键页从占位变真实页面 |
| 插件 bridge 兼容 | 30% | 45% | 高频 API 不再假成功 |
| Agent/MCP 底座 | 50% | 60% | 全局确认弹窗和审计详情已补 |
| 内置 Agent 工具 | 25% | 40% | 工具错误语义和 dry-run 提升 |
| 测试与发布 | 30% | 40% | 单测增加，仍缺 Tauri app smoke/签名公证 |

下一步建议：

1. 用 `pnpm tauri dev` 做真实 macOS app smoke。
2. 导入本机 ZTools 插件，建立兼容矩阵。
3. 继续做剪贴板历史、文件搜索索引、WebP/质量目标压缩、原生 OCR。
4. 补前端组件测试或 Playwright 稳定测试入口。

## 第三批：内置程序体验优先，不推进插件

用户最新要求：插件不着急，先继续完善内置程序体验。

状态：DONE。

修改文件：

- `src/App.svelte`
- `src/components/SettingsPanel.svelte`

完成：

- 主搜索窗口高度改为内容驱动：
  - 空搜索且不显示最近使用时只保留搜索框高度。
  - 最近使用按实际 9 列行数计算窗口高度。
  - 搜索结果按结果数量和分组数量计算窗口高度，列表高度封顶。
  - 退出插件、清空搜索、返回主页时不再调用固定 600px 的 `reset_window`。
- 最近使用键盘导航改为网格感知：
  - 左右方向键按格移动。
  - 上下方向键按 9 列跳转。
  - Tab 仍保留循环选择/目标指令两种模式。
- 设置页视觉密度继续向 ZTools 对齐：
  - 右侧设置行从松散大行压缩到 66px 基准行高。
  - 输入框、select、按钮、toggle、色块尺寸下调。
  - 窄宽度预览下侧栏和控件响应式收缩。
  - 设置项标题和说明改为单行 ellipsis，避免撑高行或文字重叠。

验证：

```bash
pnpm check
pnpm build
```

Browser smoke：

- URL：`http://127.0.0.1:1420/?parity=1`
- 页面标题：`ATools 3.0`
- DOM 非空，包含 `最近使用`、`设置`。
- Console error/warn：0。
- 最近使用键盘路径：`ArrowRight` 后 `ArrowDown`，选中项从第 1 格移动到第 11 格 `ToDo 待办`。
- 设置页路径：点击右上角 badge 打开设置，首个设置行高度为 `66px`，无标题换行。
- 设置页关闭后回到主页，最近使用可见，搜索 placeholder 正常。

Smoke 截图：

- `/tmp/atools-home-smoke.png`
- `/tmp/atools-settings-smoke.png`

当前重点剩余：

1. 真实 Tauri 窗口下复测动态高度是否和 Web preview 一致。
2. 继续做主搜索输入节奏：查询 loading、无结果反馈、粘贴文件/图片入口。
3. 设置页继续补齐“快捷键录制”“本地启动”“网页快开”这些内置功能页，不进入插件接入测试。

## 第四批：网页快开内置功能

用户要求：继续还原完成度，插件不优先；完成一大项后同步完成度。

状态：DONE。

修改文件：

- `index.html`
- `package.json`
- `scripts/test-web-quick-open.mjs`
- `src/App.svelte`
- `src/components/SettingsPanel.svelte`
- `src/lib/webQuickOpen.ts`

完成：

- 新增网页快开纯逻辑模块：
  - 默认内置 Google / GitHub / NPM。
  - 支持 `keyword + 空格 + query` 匹配，例如 `g rust`。
  - URL 模板支持 `{query}` 占位，并自动 URL encode。
  - 支持禁用项过滤、重复关键字去重、无效项过滤。
- 新增轻量逻辑测试：
  - `pnpm test:web-quick-open`
  - 使用 Vite `transformWithEsbuild` 临时转译 TS，不引入新测试框架。
- 设置页“网页快开”从占位变为真实页面：
  - 展示默认快开列表。
  - 支持启用/停用。
  - 支持编辑名称、关键字、URL 模板。
  - 支持添加、删除、恢复默认。
  - 保存到本地 `localStorage`，并通过事件实时通知主搜索。
- 主搜索接入网页快开结果：
  - 输入 `g rust` 展示 `Google 搜索 rust`。
  - 结果描述展示目标 URL。
  - 选中后在 Tauri 下通过 shell plugin 打开外部 URL；web preview 下使用 `window.open`。
- 修复 favicon 404：
  - `index.html` 增加内联 data URL favicon，避免 Playwright/浏览器 smoke 出现无关 404 error。

验证：

```bash
pnpm test:web-quick-open
pnpm check
pnpm build
curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:1420/?parity=1'
```

结果：

- `pnpm test:web-quick-open`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，144 modules transformed。
- HTTP smoke：`200`。

Browser / Playwright smoke：

- Browser plugin 路径：
  - 页面身份、DOM 非空、console health 可读。
  - Browser locator click/type/fill 被当前 runtime 的 CDP/虚拟剪贴板限制阻塞，作为 Browser-path blocker 记录。
- 独立 Playwright fallback：
  - URL：`http://127.0.0.1:1420/?parity=1`
  - 页面标题：`ATools 3.0`
  - Console error/warn：0。
  - 设置页进入“网页快开”：默认 3 条，关键字为 `g`、`gh`、`npm`。
  - 添加并编辑 `Docs/docs/https://docs.example.com/search?q={query}`：localStorage 写入成功。
  - 恢复默认：localStorage 恢复 3 条默认项。
  - 回到主搜索输入 `g rust`：结果列表出现 `Google 搜索 rust`，URL 为 `https://www.google.com/search?q=rust`。

Smoke 截图：

- `/tmp/atools-web-quick-open-smoke.png`

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 45% | 52% | 已接入网页快开本地结果，主搜索不再只有系统命令/插件结果 |
| ZTools 设置页 UI/功能 | 60% | 66% | “网页快开”从占位页变成真实可编辑功能页 |
| 内置程序功能闭环 | 40% | 48% | 第一个设置页功能和主搜索结果形成闭环 |
| 测试与发布 | 40% | 43% | 增加网页快开逻辑测试和交互 smoke 记录 |

当前重点剩余：

1. 设置页继续补齐“快捷键录制”“本地启动”真实功能页。
2. 主搜索继续补查询 loading、无结果反馈、粘贴文件/图片入口。
3. 真实 Tauri 窗口下复测外部 URL 打开、动态高度、全局快捷键。

## 第五批：本地启动内置功能

用户要求：继续还原完成度，完成一大项后同步完成度；插件不优先。

状态：DONE。

修改文件：

- `package.json`
- `scripts/test-local-launch.mjs`
- `src/App.svelte`
- `src/components/SettingsPanel.svelte`
- `src/lib/localLaunch.ts`

完成：

- 新增本地启动纯逻辑模块：
  - 默认内置 `桌面` / `下载` 两个启动项。
  - 支持文件、文件夹、应用三种类型。
  - 支持关键字精确匹配、名称/路径包含匹配。
  - 支持 `~/Desktop` 这类路径在 Tauri runtime 下展开为用户目录。
  - 支持禁用项过滤、重复关键字去重、无效项过滤。
- 新增轻量逻辑测试：
  - `pnpm test:local-launch`
  - 覆盖 normalize、路径展开、搜索结果、disabled 过滤、code 反查、create 默认值。
- 设置页“本地启动”从占位变为真实页面：
  - 展示默认启动项。
  - 支持启用/停用。
  - 支持编辑名称、关键字、类型、路径。
  - 支持添加、删除、恢复默认。
  - 保存到本地 `localStorage`，并通过事件实时通知主搜索。
- 主搜索接入本地启动结果：
  - 输入 `desktop` 展示 `打开 桌面`。
  - 结果描述展示 `文件夹 · ~/Desktop`。
  - 选中后在 Tauri 下调用 `shell_open` 打开本地路径；web preview 下只记录 preview，不产生本地副作用。

验证：

```bash
pnpm test:local-launch
pnpm test:web-quick-open
pnpm check
pnpm build
curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:1420/?parity=1'
```

结果：

- `pnpm test:local-launch`：通过。
- `pnpm test:web-quick-open`：通过，网页快开回归未破坏。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，145 modules transformed。
- HTTP smoke：`200`。

Playwright smoke：

- URL：`http://127.0.0.1:1420/?parity=1`
- 页面标题：`ATools 3.0`
- Console error/warn：0。
- 设置页进入“本地启动”：默认 2 条，关键字为 `desktop`、`downloads`。
- 添加并编辑 `Projects/proj/folder/~/Projects`：localStorage 写入成功。
- 恢复默认：localStorage 恢复 2 条默认项。
- 回到主搜索输入 `desktop`：结果列表出现 `打开 桌面`，描述为 `文件夹 · ~/Desktop`。

Smoke 截图：

- `/tmp/atools-local-launch-smoke.png`

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 52% | 58% | 已接入本地启动结果，主搜索可直接打开本地路径 |
| ZTools 设置页 UI/功能 | 66% | 72% | “本地启动”从占位页变成真实可编辑功能页 |
| 内置程序功能闭环 | 48% | 56% | 第二个设置页功能和主搜索结果形成闭环 |
| 测试与发布 | 43% | 46% | 增加本地启动逻辑测试，保留网页快开回归 |

当前重点剩余：

1. 设置页继续补齐“快捷键录制”真实交互。
2. 主搜索继续补查询 loading、无结果反馈、粘贴文件/图片入口。
3. 真实 Tauri 窗口下复测本地路径打开、动态高度、全局快捷键。

## 第六批：快捷键录制真实交互

用户要求：插件不着急，继续完善内置程序体验。

状态：DONE。

修改文件：

- `package.json`
- `scripts/test-hotkey-recorder.mjs`
- `src/components/SettingsPanel.svelte`
- `src/lib/hotkeyRecorder.ts`

完成：

- 新增快捷键录制纯逻辑模块：
  - macOS 显示 `Option` / `Command` / `Control` / `Shift`。
  - Windows/Linux 显示 `Ctrl` / `Alt` / `Shift` / `Meta`。
  - 过滤纯修饰键，避免把 `Alt`、`Shift` 这类无效输入保存成快捷键。
  - 支持 `Space`、方向键、功能键和普通字母数字主键归一化。
  - `Esc` 取消录制，不写入设置。
- 新增轻量逻辑测试：
  - `pnpm test:hotkey-recorder`
  - 覆盖 macOS `Option+Z`、`Command+Shift+P`、`Control+Space`，Windows `Ctrl+Alt+K`，纯修饰键、Esc 和提示文案。
- 设置页“呼出快捷键”从自由文本输入改为真实录制交互：
  - 通用设置页和快捷键页共用同一录制逻辑。
  - 点击输入框或齿轮按钮进入录制态。
  - 输入框录制中显示主题色边框和浅色背景。
  - 合法组合键自动写入设置并触发保存/重新注册链路。
  - 快捷键页状态 pill 显示 `已录制 xxx` 或保存状态。
- 测试后通过 UI 将 in-app Browser 预览里的快捷键恢复为默认 `Option+Z`，避免保留测试状态。

验证：

```bash
pnpm test:hotkey-recorder
pnpm test:web-quick-open
pnpm test:local-launch
pnpm check
pnpm build
```

结果：

- `pnpm test:hotkey-recorder`：通过。
- `pnpm test:web-quick-open`：通过，网页快开回归未破坏。
- `pnpm test:local-launch`：通过，本地启动回归未破坏。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，146 modules transformed。

Browser / Playwright smoke：

- in-app Browser 路径：
  - URL：`http://127.0.0.1:1420/?parity=1`
  - 页面标题：`ATools 3.0`
  - 打开设置页后，通用设置页可见 `呼出快捷键` 输入框和 `录制快捷键` 按钮。
  - 点击输入框并按 `Alt+Y` 后，DOM 显示输入框值为 `Option+Y`。
  - Console error/warn：0。
  - 第二次切换到“快捷键”页时 Browser CDP 点击链路超时，作为 Browser-path blocker 记录。
- Playwright MCP fallback：
  - 打开设置页，精确点击左侧 `快捷键` 菜单。
  - 点击 `呼出快捷键` 输入框并按 `Alt+K`。
  - 输入框值变为 `Option+K`。
  - 页面包含 `应用内快捷键` 和录制/保存状态。
  - Console error/warn：0。

Smoke 截图：

- `/tmp/atools-hotkey-recorder-smoke.png`

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI/功能 | 72% | 78% | 快捷键设置从自由文本变成真实录制交互，两个入口行为一致 |
| 设置项真实功能 | 25% | 32% | 呼出快捷键录制、保存和原生热键注册链路已闭合 |
| 内置程序功能闭环 | 56% | 60% | 关键设置项具备录制、保存、状态反馈和回归测试 |
| 测试与发布 | 46% | 48% | 增加快捷键录制逻辑测试和交互 smoke 记录 |

当前重点剩余：

1. 主搜索继续补查询 loading、无结果反馈、粘贴文件/图片入口。
2. 设置页继续补“我的数据/调试日志”的视觉细节和审计详情可读性。
3. 真实 Tauri 窗口下复测全局快捷键注册冲突、动态高度和本地路径打开。

## 第七批：粘贴文件/图片入口

用户要求：继续还原内置程序体验，插件不优先。

状态：DONE。

修改文件：

- `package.json`
- `scripts/test-paste-intake.mjs`
- `src/App.svelte`
- `src/components/SearchBar.svelte`
- `src/lib/pasteIntake.ts`
- `src/lib/types.ts`

完成：

- 新增粘贴入口纯逻辑模块：
  - 识别粘贴文件和图片。
  - 图片生成 OCR / 压缩动作；文件生成打开 / Finder 显示动作。
  - 无本地路径的浏览器粘贴图片生成明确的 `保存图片后再处理` 待处理动作，不假执行。
  - 生成主搜索结果时统一归到 `粘贴内容` 分组。
  - 新增 `pending` 匹配标签，UI 显示为 `待处理`。
- 新增轻量逻辑测试：
  - `pnpm test:paste-intake`
  - 覆盖图片、文件、无路径图片、结果 label/code、分组 plugin_id、待处理状态。
- 主搜索接入粘贴事件：
  - `SearchBar` 转发 `paste` 事件。
  - 粘贴图片/文件时阻止默认文本输入，搜索框显示 `粘贴了 x 张图片、x 个文件`。
  - 结果列表展示可处理动作。
  - 有本地路径的 OCR/压缩/打开/Finder 显示动作走现有 `call_agent_tool` 权限确认链路。
  - 无本地路径时只输出明确 preview 信息，不制造本地副作用。

验证：

```bash
pnpm test:paste-intake
pnpm test:web-quick-open
pnpm test:local-launch
pnpm check
pnpm build
curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:1420/?parity=1'
```

结果：

- `pnpm test:paste-intake`：通过。
- `pnpm test:web-quick-open`：通过，网页快开回归未破坏。
- `pnpm test:local-launch`：通过，本地启动回归未破坏。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，147 modules transformed。
- HTTP smoke：`200`。

Browser / Playwright smoke：

- in-app Browser 路径：
  - URL：`http://127.0.0.1:1420/?parity=1`
  - 页面标题：`ATools 3.0`
  - DOM 非空，包含主搜索 placeholder。
  - Console error/warn：0。
  - 粘贴交互模拟受 Browser evaluate 沙箱限制阻塞：页面上下文不可构造 `File` / `Event`。
- Playwright MCP fallback：
  - 打开主搜索页。
  - 构造 `clipboard-image.png` 图片文件并 dispatch `paste`。
  - `paste` 默认行为被阻止。
  - 输入框值变为 `粘贴了 1 张图片`。
  - 页面包含 `粘贴内容` 分组。
  - 页面包含 `保存图片后再处理 clipboard-image.png`。
  - 页面包含 `待处理` 标签。
  - Console error/warn：0。

Smoke 截图：

- `/tmp/atools-paste-intake-smoke.png`

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 58% | 64% | 主搜索开始响应文件/图片粘贴，不再只是文本查询 |
| 内置程序功能闭环 | 60% | 65% | 粘贴图片/文件能转成内置操作入口，并接权限确认链路 |
| Agent/MCP 底座 | 60% | 62% | UI 内置动作开始复用 `call_agent_tool`，但真实 Tauri 权限弹窗仍需 app smoke |
| 测试与发布 | 48% | 51% | 增加粘贴入口逻辑测试和交互 smoke 记录 |

当前重点剩余：

1. 主搜索继续补查询 loading 和更清晰的无结果反馈。
2. 真实 Tauri 窗口下验证粘贴本地文件是否能拿到路径，并触发权限确认弹窗。
3. 设置页继续补“我的数据/调试日志”的视觉细节和审计详情可读性。

## 第八批：主搜索查询状态和无结果反馈

用户要求：继续还原内置程序体验，插件不优先。

状态：DONE。

修改文件：

- `package.json`
- `scripts/test-search-feedback.mjs`
- `src/App.svelte`
- `src/components/ResultsList.svelte`
- `src/lib/searchFeedback.ts`

完成：

- 新增搜索反馈纯逻辑模块：
  - 空查询不展示反馈。
  - 无结果且正在搜索时显示 `正在搜索 “query”`。
  - 已有本地结果但插件仍在搜索时显示紧凑状态条 `正在补充插件结果`。
  - 无结果且插件搜索完成时显示更明确的空状态。
  - 浏览器预览无 Tauri runtime 时显示 `没有找到本地匹配`，并说明预览模式只搜系统命令、网页快开和本地启动。
  - 插件搜索失败时区分“无本地结果”和“已有本地结果但插件失败”。
- 新增轻量逻辑测试：
  - `pnpm test:search-feedback`
  - 覆盖 loading、strip、empty、preview unavailable、error 五类状态。
- 主搜索接入远端搜索状态：
  - `App.svelte` 增加 `remoteSearchStatus` / `searchError`。
  - Tauri runtime 下调用插件搜索前进入 `searching`，成功后进入 `ready`，失败后进入 `error`。
  - 浏览器预览进入 `unavailable`，不再给用户造成“全局搜索已完成”的错觉。
  - 增加 `searchRunId`，避免快速输入时旧异步结果覆盖新查询。
- `ResultsList` 接入反馈 UI：
  - 空结果展示 loading / error / preview 文案。
  - 有本地结果时可在顶部展示搜索中或失败状态条。
  - 状态条和空状态使用固定紧凑布局，避免文本撑高或重叠。

验证：

```bash
pnpm test:search-feedback
pnpm test:paste-intake
pnpm test:web-quick-open
pnpm test:local-launch
pnpm test:hotkey-recorder
pnpm check
pnpm build
curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:1420/?parity=1'
```

结果：

- `pnpm test:search-feedback`：通过。
- `pnpm test:paste-intake`：通过，粘贴入口回归未破坏。
- `pnpm test:web-quick-open`：通过，网页快开回归未破坏。
- `pnpm test:local-launch`：通过，本地启动回归未破坏。
- `pnpm test:hotkey-recorder`：通过，快捷键录制回归未破坏。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，148 modules transformed。
- HTTP smoke：`200`。

Browser / Playwright smoke：

- in-app Browser 路径：
  - URL：`http://127.0.0.1:1420/?parity=1`
  - 页面标题：`ATools 3.0`
  - DOM 非空，包含主搜索 placeholder。
  - Console error/warn：0。
  - 输入框点击链路受 Browser CDP 运行时限制超时，作为 Browser-path blocker 记录。
- Playwright MCP fallback：
  - 打开主搜索页。
  - 输入 `qqq-no-match-8848`。
  - 输入框值保持为该查询。
  - 页面包含 `没有找到本地匹配 “qqq-no-match-8848”`。
  - 页面包含 `浏览器预览仅搜索系统命令、网页快开和本地启动`。
  - 页面包含 `桌面应用会继续搜索插件`。
  - Console error/warn：0。

Smoke 截图：

- `/tmp/atools-search-feedback-smoke.png`

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 64% | 68% | 查询状态、预览模式和无结果反馈更接近日常命令面板体验 |
| 内置程序功能闭环 | 65% | 67% | 主搜索 now 能明确区分本地匹配、插件补充、插件失败和预览限制 |
| 测试与发布 | 51% | 54% | 增加搜索反馈逻辑测试，并保留完整前端回归和 smoke 记录 |

当前重点剩余：

1. 真实 Tauri 窗口下验证搜索 loading、插件搜索失败状态和权限确认弹窗。
2. 设置页继续补“我的数据/调试日志”的视觉细节和审计详情可读性。
3. 主搜索继续补文本粘贴识别、URL 自动快开、更多 uTools/ZTools 搜索细节。

## 第九批：URL 自动快开

用户要求：继续还原内置程序体验，插件不优先。

状态：DONE。

修改文件：

- `package.json`
- `scripts/test-url-quick-open.mjs`
- `src/App.svelte`
- `src/lib/urlQuickOpen.ts`

完成：

- 新增 URL 快开纯逻辑模块：
  - 识别 `https://example.com/a?b=c`。
  - 识别裸域名和路径，例如 `example.com/docs`，默认规范化为 `https://example.com/docs`。
  - 识别本地地址，例如 `localhost:1420/?parity=1`、`127.0.0.1:1420/test`，默认规范化为 `http://...`。
  - 含空格的普通文本不误判为 URL，例如 `g rust`、`hello world`。
  - 生成 `链接快开` 主搜索结果，选中后复用现有 `openUrl` 打开。
- 新增轻量逻辑测试：
  - `pnpm test:url-quick-open`
  - 覆盖 URL 规范化、结果生成、code 反查、非 URL 过滤。
- 主搜索接入 URL 快开：
  - 本地搜索结果优先包含 URL 快开结果。
  - 输入或粘贴裸域名时直接显示 `打开链接 xxx`。
  - `Enter` / `Tab target-command` 选中 URL 结果时打开规范化后的链接。
  - 不影响已有网页快开关键字搜索，例如 `g rust` 仍走网页快开。

验证：

```bash
pnpm test:url-quick-open
pnpm test:search-feedback
pnpm test:web-quick-open
pnpm test:paste-intake
pnpm test:local-launch
pnpm test:hotkey-recorder
pnpm check
pnpm build
curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:1420/?parity=1'
```

结果：

- `pnpm test:url-quick-open`：通过。
- `pnpm test:search-feedback`：通过，搜索反馈回归未破坏。
- `pnpm test:web-quick-open`：通过，关键字网页快开回归未破坏。
- `pnpm test:paste-intake`：通过，粘贴文件/图片入口回归未破坏。
- `pnpm test:local-launch`：通过，本地启动回归未破坏。
- `pnpm test:hotkey-recorder`：通过，快捷键录制回归未破坏。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，149 modules transformed。
- HTTP smoke：`200`。

Browser / Playwright smoke：

- in-app Browser 路径：
  - URL：`http://127.0.0.1:1420/?parity=1`
  - 页面标题：`ATools 3.0`
  - DOM 非空，包含主搜索 placeholder。
  - Console error/warn：0。
- Playwright MCP fallback：
  - 打开主搜索页。
  - 输入 `example.com/docs`。
  - 输入框值保持为 `example.com/docs`。
  - 页面包含 `链接快开` 分组。
  - 页面包含 `打开链接 example.com/docs`。
  - 页面包含规范化 URL `https://example.com/docs`。
  - 页面包含 `精确` 标签。
  - Console error/warn：0。

Smoke 截图：

- `/tmp/atools-url-quick-open-smoke.png`

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 68% | 72% | 主搜索支持输入/粘贴 URL 后直接快开，覆盖高频命令面板使用场景 |
| 内置程序功能闭环 | 67% | 70% | URL 识别、规范化、结果展示和打开动作形成闭环 |
| 测试与发布 | 54% | 56% | 增加 URL 快开逻辑测试，并保留完整前端回归和 smoke 记录 |

当前重点剩余：

1. 真实 Tauri 窗口下验证 URL 打开、搜索 loading、插件失败状态和权限确认弹窗。
2. 设置页继续补“我的数据/调试日志”的视觉细节和审计详情可读性。
3. 主搜索继续补更细的文本粘贴识别，例如 JSON/颜色/时间戳/路径自动识别。

## 第十批：文本快识别

用户要求：继续还原内置程序体验，插件不优先。

状态：DONE。

修改文件：

- `package.json`
- `scripts/test-text-quick-actions.mjs`
- `src/App.svelte`
- `src/lib/textQuickActions.ts`

完成：

- 新增文本快识别纯逻辑模块：
  - 识别 JSON 文本，生成 `复制格式化 JSON` 结果。
  - 识别 hex 颜色，例如 `#7c3aed`，规范化为 `#7C3AED`，并显示 RGB 说明。
  - 识别 10 位 / 13 位 Unix 时间戳，生成 ISO 时间复制结果。
  - 识别 macOS 路径，例如 `~/Desktop/invoice.pdf`，生成 `打开路径` 和 `在 Finder 中显示` 两个动作。
  - 普通文本和 URL 不误判，避免和 URL 快开、网页快开冲突。
- 新增轻量逻辑测试：
  - `pnpm test:text-quick-actions`
  - 覆盖 JSON、颜色、时间戳、路径、普通文本、URL 过滤、code payload 反查。
- 主搜索接入文本快识别：
  - 本地搜索结果包含文本快识别结果。
  - JSON / 颜色 / 时间戳动作选中后复制处理结果。
  - 路径动作选中后调用现有 `open_or_reveal_path` Agent 工具，走权限确认链路。
  - Web preview 下路径动作不假执行，只走已有 preview/log 路径。

验证：

```bash
pnpm test:text-quick-actions
pnpm test:url-quick-open
pnpm test:search-feedback
pnpm test:web-quick-open
pnpm test:paste-intake
pnpm test:local-launch
pnpm test:hotkey-recorder
pnpm check
pnpm build
curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:1420/?parity=1'
```

结果：

- `pnpm test:text-quick-actions`：通过。
- `pnpm test:url-quick-open`：通过，URL 快开回归未破坏。
- `pnpm test:search-feedback`：通过，搜索反馈回归未破坏。
- `pnpm test:web-quick-open`：通过，网页快开回归未破坏。
- `pnpm test:paste-intake`：通过，粘贴文件/图片入口回归未破坏。
- `pnpm test:local-launch`：通过，本地启动回归未破坏。
- `pnpm test:hotkey-recorder`：通过，快捷键录制回归未破坏。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，150 modules transformed。
- HTTP smoke：`200`。

Browser / Playwright smoke：

- in-app Browser 路径：
  - URL：`http://127.0.0.1:1420/?parity=1`
  - 页面标题：`ATools 3.0`
  - DOM 非空，包含主搜索 placeholder。
  - Console error/warn：0。
- Playwright MCP fallback：
  - 打开主搜索页。
  - 输入 `#7c3aed`。
  - 输入框值保持为 `#7c3aed`。
  - 页面包含 `文本快识别` 分组。
  - 页面包含 `复制颜色 #7C3AED`。
  - 页面包含 `RGB 124, 58, 237`。
  - 页面包含 `精确` 标签。
  - Console error/warn：0。

Smoke 截图：

- `/tmp/atools-text-quick-actions-smoke.png`

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 72% | 76% | 主搜索能识别 JSON、颜色、时间戳、路径，补齐更多命令面板高频文本场景 |
| 内置程序功能闭环 | 70% | 73% | 文本识别、结果展示、复制动作和路径权限链路已接入 |
| Agent/MCP 底座 | 62% | 63% | 路径文本动作开始复用 Agent 工具链路，但真实 Tauri 权限弹窗仍需 app smoke |
| 测试与发布 | 56% | 59% | 增加文本快识别逻辑测试，并保留完整前端回归和 smoke 记录 |

当前重点剩余：

1. 真实 Tauri 窗口下验证 URL 打开、路径动作权限确认、搜索 loading 和插件失败状态。
2. 设置页继续补“我的数据/调试日志”的视觉细节和审计详情可读性。
3. 主搜索继续细化输入体验：历史命令、别名、拼音/模糊匹配和更完整的键盘行为。

## 第十一批：真实最近使用与历史命令

用户要求：插件不着急，先继续完善内置程序体验。

状态：DONE。

修改文件：

- `package.json`
- `scripts/test-command-history.mjs`
- `scripts/test-keyboard-target.mjs`
- `src/App.svelte`
- `src/components/HomePanel.svelte`
- `src/lib/commandHistory.ts`
- `src/lib/keyboardTarget.ts`
- `src/lib/uiState.ts`

完成：

- 把首页“最近使用”从固定推荐列表升级为真实历史 + 推荐兜底：
  - 执行系统命令、本地启动、网页快开、URL 快开后写入本地历史。
  - 首页空搜索优先显示真实最近使用，再补固定推荐项。
  - 历史按使用时间倒序，重复执行会提升到第一项并累计 `useCount`。
  - 过滤一次性文本动作和粘贴动作，避免 JSON/颜色/图片临时任务污染首页历史。
  - 通过 code 和 label 双重去重，避免历史“设置”和推荐“设置”重复出现。
- 主搜索结果增加“最近使用”分组：
  - 输入历史命令的 label、explain、原始输入或来源名可召回历史项。
  - 选中历史项后按原始 code/input 重放，支持系统面板、本地启动、网页快开和 URL 快开。
- 修复键盘 target 判断：
  - `Escape` 事件 target 为 `window` 或其他非 HTMLElement 时不再抛错。
  - 设置页按 `Escape` 可回到首页，保持启动器键盘手感。
- `HomePanel` 改为接收外部命令列表，不再内部硬编码推荐项。

验证：

```bash
pnpm test:command-history
pnpm test:keyboard-target
pnpm test:text-quick-actions
pnpm test:url-quick-open
pnpm test:search-feedback
pnpm test:web-quick-open
pnpm test:paste-intake
pnpm test:local-launch
pnpm test:hotkey-recorder
pnpm check
pnpm build
curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:1420/?parity=1'
```

结果：

- `pnpm test:command-history`：通过。
- `pnpm test:keyboard-target`：通过。
- `pnpm test:text-quick-actions`：通过，文本快识别回归未破坏。
- `pnpm test:url-quick-open`：通过，URL 快开回归未破坏。
- `pnpm test:search-feedback`：通过，搜索反馈回归未破坏。
- `pnpm test:web-quick-open`：通过，网页快开回归未破坏。
- `pnpm test:paste-intake`：通过，粘贴入口回归未破坏。
- `pnpm test:local-launch`：通过，本地启动回归未破坏。
- `pnpm test:hotkey-recorder`：通过，快捷键录制回归未破坏。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，152 modules transformed。
- HTTP smoke：`200`。

Browser smoke：

- 打开 `http://127.0.0.1:1420/?parity=1`。
- 清空 `atools:command-history` 后重载。
- 输入 `设置`，结果第一项为系统命令 `设置`。
- 触发 `Enter` 后写入历史：`system:settings`。
- 触发 `Escape` 回到首页。
- 首页最近使用第一项为 `设置`。
- 首页只保留一个 `设置` 项，不再和推荐项重复。
- Console error/warn：0。

Smoke 截图：

- `/tmp/atools-command-history-smoke.png`

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 76% | 80% | 首页最近使用变成真实历史，支持执行记录、空搜索优先展示、历史召回和键盘返回 |
| 内置程序功能闭环 | 73% | 76% | 内置系统/本地/网页/URL 动作可以进入历史并重放，首页不再只是静态推荐 |
| Agent/MCP 底座 | 63% | 63% | 本批未扩展 Agent/MCP，保持不变 |
| 测试与发布 | 59% | 62% | 增加历史命令和键盘 target 测试，并完成完整回归、构建、浏览器 smoke |

当前重点剩余：

1. 真实 Tauri 窗口下验证 URL 打开、路径动作权限确认、搜索 loading 和插件失败状态。
2. 主搜索继续补别名、拼音/模糊匹配、历史项删除/清空和更完整的空格/Tab 行为。
3. 设置页继续补“我的数据/调试日志”的视觉细节、历史清理入口和审计详情可读性。

## 第十二批：我的数据页接入最近使用历史

用户要求：继续还原完成度，测试没问题后同步更新文档，完成一大项后同步完成度。

状态：DONE。

修改文件：

- `scripts/test-command-history.mjs`
- `src/App.svelte`
- `src/components/SettingsPanel.svelte`
- `src/lib/commandHistory.ts`

完成：

- `commandHistory` 模块新增数据管理能力：
  - `commandHistoryStats()`：统计历史数量、最近使用时间和最近命令。
  - `exportCommandHistoryJson()`：导出规范化最近使用历史 JSON，包含 `version`、`exportedAt`、`count`、`entries`。
  - `clearCommandHistoryStorage()`：清空本地最近使用历史并返回清空数量。
  - `COMMAND_HISTORY_UPDATED_EVENT` / `dispatchCommandHistoryUpdated()`：清空或更新历史后通知主界面刷新。
- App 主程序监听历史更新事件：
  - 设置页清空最近使用后，首页最近使用立即回退到推荐项，不需要刷新页面。
  - 主搜索执行历史写入后也会广播更新，保持设置页和首页状态一致。
- 设置页“我的数据”补齐最近使用历史：
  - 新增“最近使用历史”数据项。
  - 显示历史数量、最近命令和最近时间。
  - 支持导出最近使用历史 JSON 到剪贴板。
  - 支持确认后清空历史，清空不会影响设置、插件或审计记录。
  - 浏览器预览下也能查看/导出/清空最近使用历史；Tauri 不可用时仅审计/插件数据受限。

验证：

```bash
pnpm test:command-history
pnpm test:keyboard-target
pnpm test:text-quick-actions
pnpm test:url-quick-open
pnpm test:search-feedback
pnpm test:web-quick-open
pnpm test:paste-intake
pnpm test:local-launch
pnpm test:hotkey-recorder
pnpm check
pnpm build
curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:1420/?parity=1'
```

结果：

- `pnpm test:command-history`：通过，覆盖历史统计、导出 JSON、清空存储和更新事件。
- `pnpm test:keyboard-target`：通过。
- `pnpm test:text-quick-actions`：通过。
- `pnpm test:url-quick-open`：通过。
- `pnpm test:search-feedback`：通过。
- `pnpm test:web-quick-open`：通过。
- `pnpm test:paste-intake`：通过。
- `pnpm test:local-launch`：通过。
- `pnpm test:hotkey-recorder`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，152 modules transformed。
- HTTP smoke：`200`。

Browser smoke：

- 预置 1 条最近使用历史：`system:settings`。
- 首页最近使用第一项显示 `设置`。
- 进入设置页 `我的数据`，页面显示 `最近使用历史` 和 `1 条`。
- 确认清空最近使用历史。
- `localStorage["atools:command-history"]` 被移除。
- 页面显示 `已清空 1 条最近使用历史`。
- 按 `Escape` 回到首页，首页第一项回退为推荐项 `图片批处理`。
- Console error/warn：0。

Smoke 截图：

- `/tmp/atools-data-history-smoke.png`

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 80% | 81% | 清空历史后首页状态能即时回退，最近使用闭环更完整 |
| 内置程序功能闭环 | 76% | 78% | 最近使用历史具备查看、导出、清空和跨页面同步 |
| 设置项真实功能 | 32% | 38% | `我的数据` 页新增最近使用历史管理，和设置/审计/插件数据形成更完整的数据管理区 |
| Agent/MCP 底座 | 63% | 63% | 本批未扩展 Agent/MCP，保持不变 |
| 测试与发布 | 62% | 64% | 历史数据管理测试、完整回归、构建和浏览器 smoke 已补齐 |

当前重点剩余：

1. 真实 Tauri 窗口下验证 URL 打开、路径动作权限确认、搜索 loading 和插件失败状态。
2. 主搜索继续补别名、拼音/模糊匹配、历史项删除/清空单项和更完整的空格/Tab 行为。
3. 设置页继续补“调试日志”的视觉细节、审计详情可读性，以及数据页的插件/审计真实桌面端 smoke。

## 第十三批：主搜索拼音、别名和模糊匹配

用户要求：继续还原完成度，内置程序体验继续向 ZTools/uTools 对齐。

状态：DONE。

修改文件：

- `package.json`
- `pnpm-lock.yaml`
- `scripts/test-search-match.mjs`
- `scripts/test-local-launch.mjs`
- `scripts/test-web-quick-open.mjs`
- `scripts/test-command-history.mjs`
- `src/App.svelte`
- `src/lib/searchMatch.ts`
- `src/lib/localLaunch.ts`
- `src/lib/webQuickOpen.ts`
- `src/lib/commandHistory.ts`
- `src/lib/uiState.ts`

完成：

- 引入 `pinyin-pro@3.28.1`，用真实拼音库替代手写中文首字母表。
- 新增 `searchMatch.ts` 统一本地搜索匹配：
  - 支持 `exact`、`prefix`、`contains`、`alias`、`pinyin`、`fuzzy`。
  - 支持中文全拼和首字母，例如 `shezhi` / `sz` 匹配 `设置`。
  - 支持本地启动中文名，例如 `xz` 匹配 `下载`。
  - 支持英文别名，例如 `set` 匹配系统 `设置` 的 `settings` alias。
  - 支持英文子序列模糊，例如 `gub` 匹配 `GitHub`。
- 接入主搜索本地结果源：
  - 系统命令：`sz` / `shezhi` / `set` 可找到 `设置`。
  - 最近使用：历史项也支持拼音召回，例如 `sz` 召回历史 `设置`。
  - 本地启动：`xz` 可找到 `打开 下载`。
  - 网页快开：保留 `g rust` 关键字快开，同时支持名称 contains/fuzzy。
- 结果标签继续复用现有 `MATCH_TYPE_META`，拼音匹配显示 `拼音`。

权衡：

- `pinyin-pro` 明显增加前端产物体积：本批 `pnpm build` 里 JS gzip 从上一批约 `57.49 kB` 增至 `197.71 kB`。
- 这是为了优先还原 uTools/ZTools 的中文输入手感。后续如需瘦身，可以把拼音索引移到 Rust core 或懒加载到搜索逻辑。

验证：

```bash
pnpm test:search-match
pnpm test:local-launch
pnpm test:web-quick-open
pnpm test:command-history
pnpm test:keyboard-target
pnpm test:text-quick-actions
pnpm test:url-quick-open
pnpm test:search-feedback
pnpm test:paste-intake
pnpm test:hotkey-recorder
pnpm check
pnpm build
curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:1420/?parity=1'
```

结果：

- `pnpm test:search-match`：通过，覆盖拼音首字母、全拼、别名、contains、fuzzy 排序。
- `pnpm test:local-launch`：通过，覆盖 `xz` 匹配 `打开 下载`。
- `pnpm test:web-quick-open`：通过，覆盖 `hub` / `gub` 命中 GitHub，disabled 项不误出。
- `pnpm test:command-history`：通过，覆盖历史 `sz` 召回 `设置`。
- `pnpm test:keyboard-target`：通过。
- `pnpm test:text-quick-actions`：通过。
- `pnpm test:url-quick-open`：通过。
- `pnpm test:search-feedback`：通过。
- `pnpm test:paste-intake`：通过。
- `pnpm test:hotkey-recorder`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，154 modules transformed。
- HTTP smoke：`200`。

Browser / Playwright smoke：

- Browser 插件路径：
  - 页面身份：`http://127.0.0.1:1420/?parity=1&pinyinSmoke=1`，标题 `ATools 3.0`。
  - DOM 非空，包含主搜索 placeholder。
  - 无框架错误覆盖。
  - Console error/warn：0。
  - 交互阶段受 in-app Browser 虚拟剪贴板缺失影响，`locator.fill` 失败，因此切到 Playwright MCP fallback。
- Playwright MCP fallback：
  - 输入 `sz`，结果包含系统命令 `设置`，标签 `拼音`。
  - 输入 `xz`，结果包含 `打开 下载`，标签 `拼音`。
  - Console error/warn：0。

Smoke 截图：

- `/tmp/atools-pinyin-search-smoke.png`

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 81% | 86% | 主搜索支持拼音首字母、全拼、别名和模糊匹配，中文命令输入手感明显接近启动器 |
| 内置程序功能闭环 | 78% | 80% | 系统命令、历史、本地启动、网页快开共享搜索匹配逻辑 |
| 设置项真实功能 | 38% | 38% | 本批未扩展设置页，保持不变 |
| Agent/MCP 底座 | 63% | 63% | 本批未扩展 Agent/MCP，保持不变 |
| 测试与发布 | 64% | 67% | 增加搜索匹配测试，并扩展本地启动、网页快开、历史搜索回归 |

当前重点剩余：

1. 真实 Tauri 窗口下验证 URL 打开、路径动作权限确认、搜索 loading 和插件失败状态。
2. 主搜索继续补历史项单项删除、别名配置页、搜索索引性能优化和拼音库体积优化。
3. 设置页继续补“调试日志”的视觉细节、审计详情可读性，以及数据页的插件/审计真实桌面端 smoke。

## 第十四批：自定义别名配置页

用户要求：继续还原完成度，完成一大项后同步完成度。

状态：DONE。

修改文件：

- `package.json`
- `scripts/test-command-aliases.mjs`
- `src/App.svelte`
- `src/components/SettingsPanel.svelte`
- `src/lib/commandAliases.ts`

完成：

- 新增 `commandAliases.ts`：
  - 支持自定义别名本地存储：`atools:command-aliases`。
  - 支持别名规范化、去重、启停、创建、保存和更新事件。
  - 支持生成主搜索结果，搜索结果分组为 `别名`。
  - 支持 alias payload 解析，选中后映射到目标指令。
- 主搜索接入自定义别名：
  - alias 结果进入本地结果列表，优先使用 `alias` 匹配标签。
  - 选中 alias 后执行目标指令，并把目标指令写入最近使用。
  - 支持目标类型：系统命令、本地启动、网页快开、URL。
- 设置页 `所有指令` 从占位页变成真实配置页：
  - 支持添加别名。
  - 支持编辑别名短词。
  - 支持选择目标：系统命令、本地启动、网页快开。
  - 支持启停、删除、清空全部别名。
  - 显示可绑定指令列表和目标 code，方便用户确认映射。

验证：

```bash
pnpm test:command-aliases
pnpm test:search-match
pnpm test:local-launch
pnpm test:web-quick-open
pnpm test:command-history
pnpm test:keyboard-target
pnpm test:text-quick-actions
pnpm test:url-quick-open
pnpm test:search-feedback
pnpm test:paste-intake
pnpm test:hotkey-recorder
pnpm check
pnpm build
curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:1420/?parity=1'
```

结果：

- `pnpm test:command-aliases`：通过，覆盖别名规范化、搜索结果、payload、存储和事件。
- `pnpm test:search-match`：通过。
- `pnpm test:local-launch`：通过。
- `pnpm test:web-quick-open`：通过。
- `pnpm test:command-history`：通过。
- `pnpm test:keyboard-target`：通过。
- `pnpm test:text-quick-actions`：通过。
- `pnpm test:url-quick-open`：通过。
- `pnpm test:search-feedback`：通过。
- `pnpm test:paste-intake`：通过。
- `pnpm test:hotkey-recorder`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，155 modules transformed。
- HTTP smoke：`200`。

Browser / Playwright smoke：

- Browser 插件路径：
  - 页面身份：`http://127.0.0.1:1420/?parity=1&aliasSmoke=1`，标题 `ATools 3.0`。
  - DOM 非空，包含主搜索 placeholder。
  - Console error/warn：0。
  - 交互阶段仍受 in-app Browser 虚拟剪贴板缺失影响，`locator.fill` 失败，因此切到 Playwright MCP fallback。
- Playwright MCP fallback：
  - 清空 alias storage。
  - 打开设置页 `所有指令`。
  - 点击 `添加别名`。
  - 将默认别名改为 `cfg`，目标保持 `system:settings`。
  - 回到主搜索输入 `cfg`。
  - 结果出现 `设置`，分组/来源为 `别名`。
  - 按 `Enter` 后进入 `设置` 页，证明 alias 可执行。
  - Console error/warn：0。

Smoke 截图：

- `/tmp/atools-command-alias-smoke.png`

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 86% | 88% | 用户可自定义短词 alias，主搜索能直接召回并执行目标指令 |
| 内置程序功能闭环 | 80% | 82% | alias 配置、存储、搜索、执行、最近使用写入形成闭环 |
| 设置项真实功能 | 38% | 44% | `所有指令` 从占位页变成可用的别名映射配置页 |
| Agent/MCP 底座 | 63% | 63% | 本批未扩展 Agent/MCP，保持不变 |
| 测试与发布 | 67% | 69% | 增加别名模块测试，并完成完整回归、构建和浏览器 smoke |

当前重点剩余：

1. 真实 Tauri 窗口下验证 URL 打开、路径动作权限确认、搜索 loading 和插件失败状态。
2. 主搜索继续补历史项单项删除、搜索索引性能优化和拼音库体积优化。
3. 设置页继续补“调试日志”的视觉细节、审计详情可读性，以及数据页的插件/审计真实桌面端 smoke。

## 第十五批：调试日志诊断与搜索结果标签补全

用户要求：插件不着急，先继续完善内置程序体验；完成一大项后同步完成度。

状态：DONE。

修改文件：

- `package.json`
- `scripts/test-debug-diagnostics.mjs`
- `scripts/test-match-type-meta.mjs`
- `src/lib/debugDiagnostics.ts`
- `src/lib/types.ts`
- `src/components/SettingsPanel.svelte`

完成：

- 新增 `debugDiagnostics.ts`：
  - 统一生成调试页“本地配置状态”诊断行。
  - 覆盖自定义别名、最近使用、本地启动、网页快开、主题、呼出快捷键、搜索模式。
  - 统一生成最近审计错误摘要，显示 tool、client、status、message、duration。
- 设置页 `调试日志` 完善：
  - 浏览器预览模式下也能展示本地配置诊断，不再只是提示 Tauri 不可用。
  - 增加“本地配置状态”分组，行内显示状态值和补充说明。
  - “最近审计错误”改为可读摘要，后续真实桌面端审计回放可继续复用。
  - `复制信息` 输出环境、本地诊断、MCP 状态、审计错误和当前设置。
- 主搜索结果标签补全：
  - `MATCH_TYPE_META` 增加 `alias` -> `别名`。
  - `MATCH_TYPE_META` 增加 `fuzzy` -> `模糊`。
  - 别名和模糊匹配结果不再暴露 raw match_type。

验证：

```bash
pnpm test:debug-diagnostics
pnpm test:match-type-meta
pnpm test:command-aliases
pnpm test:search-match
pnpm test:local-launch
pnpm test:web-quick-open
pnpm test:command-history
pnpm test:keyboard-target
pnpm test:text-quick-actions
pnpm test:url-quick-open
pnpm test:search-feedback
pnpm test:paste-intake
pnpm test:hotkey-recorder
pnpm check
pnpm build
curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:1420/?parity=1'
```

结果：

- `pnpm test:debug-diagnostics`：通过，覆盖本地配置诊断行和审计错误摘要。
- `pnpm test:match-type-meta`：通过，覆盖 `alias` / `fuzzy` 中文标签。
- `pnpm test:command-aliases`：通过。
- `pnpm test:search-match`：通过。
- `pnpm test:local-launch`：通过。
- `pnpm test:web-quick-open`：通过。
- `pnpm test:command-history`：通过。
- `pnpm test:keyboard-target`：通过。
- `pnpm test:text-quick-actions`：通过。
- `pnpm test:url-quick-open`：通过。
- `pnpm test:search-feedback`：通过。
- `pnpm test:paste-intake`：通过。
- `pnpm test:hotkey-recorder`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，156 modules transformed；主 JS gzip `200.38 kB`，仍主要受拼音库影响。
- HTTP smoke：`200`。

Browser smoke：

- 使用 in-app Browser 打开 `http://127.0.0.1:1420/?parity=1&debugSmoke=3`。
- 点击 `设置` -> `调试日志` 成功。
- 页面可见：`调试日志`、`本地配置状态`、`自定义别名`、`MCP 状态`、`最近审计错误`。
- Console error/warn：0。

Smoke 截图：

- `/tmp/atools-debug-diagnostics-smoke.png`

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 88% | 89% | 搜索结果补齐别名/模糊匹配中文标签，减少 raw 状态露出 |
| 内置程序功能闭环 | 82% | 84% | 调试日志可汇总本地配置、搜索相关状态和审计错误 |
| 设置项真实功能 | 44% | 50% | `调试日志` 从占位状态页变成可用诊断页 |
| Agent/MCP 底座 | 63% | 64% | 调试页能展示 MCP 状态和审计错误摘要，后续接真实回放 |
| 测试与发布 | 69% | 72% | 增加诊断和匹配标签测试，并完成完整回归、构建和 Browser smoke |

当前重点剩余：

1. 真实 Tauri 窗口下验证 URL 打开、路径动作权限确认、搜索 loading 和插件失败状态。
2. 主搜索继续补历史项单项删除、搜索索引性能优化和拼音库体积优化。
3. 设置页继续补审计详情可读性、数据页插件/审计真实桌面端 smoke，以及调试日志真实 Tauri 主进程日志接入。

## 第十六批：最近使用单项删除与审计详情可读化

用户要求：继续还原完成度；测试没问题后同步更新文档；完成一大项后同步完成度。

状态：DONE。

修改文件：

- `package.json`
- `scripts/test-audit-view.mjs`
- `scripts/test-command-history.mjs`
- `src/lib/auditView.ts`
- `src/lib/commandHistory.ts`
- `src/components/HomePanel.svelte`
- `src/App.svelte`
- `src/components/SettingsPanel.svelte`
- `src/components/AgentPanel.svelte`

完成：

- 最近使用历史支持单项删除：
  - 新增 `removeCommandHistoryEntry`，支持从内存历史按 `code` 删除。
  - 新增 `removeCommandHistoryEntryStorage`，支持从 localStorage 删除并派发 `COMMAND_HISTORY_UPDATED_EVENT`。
  - 主搜索首页最近使用卡片增加 hover 删除按钮，仅历史项显示，不影响推荐项。
  - 设置页 `我的数据` 增加“最近使用明细”，展示最近 12 条历史，并支持逐条删除。
- Agent 审计详情可读化：
  - 新增 `auditView.ts`，统一处理审计状态、耗时、摘要行、路径提取、输入/输出/错误格式化。
  - 审计列表状态从 raw status 改为 `已完成` / `已拒绝` / `失败` 等 badge。
  - 审计详情增加摘要区：客户端、工具、状态、耗时、时间。
  - 自动提取并展示输入/输出中的本地路径。
  - 输入参数、输出结果、错误信息改为中文标题和可读 JSON。
  - 单条审计支持 `复制详情`，并补浏览器剪贴板 fallback。

验证：

```bash
pnpm test:audit-view
pnpm test:command-history
pnpm test:debug-diagnostics
pnpm test:match-type-meta
pnpm test:command-aliases
pnpm test:search-match
pnpm test:local-launch
pnpm test:web-quick-open
pnpm test:keyboard-target
pnpm test:text-quick-actions
pnpm test:url-quick-open
pnpm test:search-feedback
pnpm test:paste-intake
pnpm test:hotkey-recorder
pnpm check
pnpm build
curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:1420/?parity=1'
```

结果：

- `pnpm test:audit-view`：通过，覆盖状态映射、耗时、摘要行、路径提取、预览和详情格式化。
- `pnpm test:command-history`：通过，覆盖单项删除、存储删除和更新事件。
- `pnpm test:debug-diagnostics`：通过。
- `pnpm test:match-type-meta`：通过。
- `pnpm test:command-aliases`：通过。
- `pnpm test:search-match`：通过。
- `pnpm test:local-launch`：通过。
- `pnpm test:web-quick-open`：通过。
- `pnpm test:keyboard-target`：通过。
- `pnpm test:text-quick-actions`：通过。
- `pnpm test:url-quick-open`：通过。
- `pnpm test:search-feedback`：通过。
- `pnpm test:paste-intake`：通过。
- `pnpm test:hotkey-recorder`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，157 modules transformed；主 JS gzip `201.75 kB`，拼音库体积问题仍需单独优化。
- HTTP smoke：`200`。

Browser / Playwright smoke：

- in-app Browser 路径：
  - 已尝试加载本地页并使用页面上下文种最近使用历史。
  - 当前 in-app Browser 的 evaluate 上下文中 `window.localStorage` 不可用，无法完成这条需要注入历史数据的 smoke。
  - 因已先走 Browser 路径，切到 Playwright fallback 完成同一 URL 验证。
- Playwright fallback：
  - 注入两条最近使用历史。
  - 主搜索首页出现 `移除 设置` 和 `移除 打开链接 example.com/docs`。
  - 点击 `移除 设置` 后，localStorage 只剩 `url:https%3A%2F%2Fexample.com%2Fdocs`。
  - 使用 fake Tauri invoke 注入一条 `rename_files` 审计记录。
  - 搜索并打开 `Agent / MCP`，展开审计记录。
  - 页面可见：`涉及路径`、`输入参数`、`输出结果`、`错误信息`、`复制详情`。
  - 干净审计路径 Console error/warn：0。

Smoke 截图：

- `/tmp/atools-history-remove-smoke.png`
- `/tmp/atools-audit-detail-smoke.png`

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 89% | 91% | 最近使用卡片可单项移除，首页历史管理更接近启动器体验 |
| 内置程序功能闭环 | 84% | 86% | 历史记录从记录、展示、搜索、执行扩展到单项管理 |
| 设置项真实功能 | 50% | 54% | `我的数据` 增加最近使用明细和逐条删除 |
| Agent/MCP 底座 | 64% | 68% | 审计详情从 raw JSON 升级为状态、摘要、路径和输入输出结构化视图 |
| 测试与发布 | 72% | 75% | 增加审计视图测试，扩展历史测试，并完成完整回归、构建和浏览器 smoke |

当前重点剩余：

1. 真实 Tauri 窗口下验证 URL 打开、路径动作权限确认、搜索 loading、插件失败状态、审计详情和数据页插件/审计 smoke。
2. 主搜索继续补搜索索引性能优化和拼音库体积优化。
3. 设置页继续补调试日志真实 Tauri 主进程日志接入、插件数据真实读写视图和更多 ZTools 细节。

## 第十七批：拼音搜索懒加载与首屏 bundle 优化

用户要求：继续还原完成度；测试没问题后同步更新文档；完成一大项后同步完成度。

状态：DONE。

修改文件：

- `package.json`
- `scripts/test-pinyin-lazy-load.mjs`
- `scripts/test-search-match.mjs`
- `scripts/test-local-launch.mjs`
- `scripts/test-command-history.mjs`
- `src/lib/searchMatch.ts`
- `src/lib/pinyinSearch.ts`
- `src/App.svelte`

完成：

- 搜索匹配层去掉 `pinyin-pro` 顶层静态 import。
- 新增 `setSearchPinyinResolver` / `clearSearchPinyinResolver`，让搜索算法通过注入式 resolver 使用拼音能力。
- 新增 `pinyinSearch.ts`：
  - 使用 `import("pinyin-pro")` 动态加载真实拼音引擎。
  - 加载完成后注入 resolver。
  - 加载过程幂等，失败时保留非拼音搜索能力。
- App 启动后异步加载拼音引擎；如果用户已输入搜索词，拼音引擎就绪后自动刷新当前搜索结果。
- 测试脚本中对依赖拼音的场景注入轻量 resolver，避免单测重新把大依赖拉进同步路径。

验证：

```bash
pnpm test:pinyin-lazy-load
pnpm test:search-match
pnpm test:local-launch
pnpm test:web-quick-open
pnpm test:command-history
pnpm test:command-aliases
pnpm test:audit-view
pnpm test:debug-diagnostics
pnpm test:match-type-meta
pnpm test:keyboard-target
pnpm test:text-quick-actions
pnpm test:url-quick-open
pnpm test:search-feedback
pnpm test:paste-intake
pnpm test:hotkey-recorder
pnpm check
pnpm build
curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:1420/?parity=1'
```

结果：

- `pnpm test:pinyin-lazy-load`：通过，覆盖 `searchMatch.ts` 不静态 import `pinyin-pro`，并验证真实懒加载后 `sz` / `shezhi` 仍命中 `设置`。
- `pnpm test:search-match`：通过，覆盖注入式 resolver 下的拼音、别名、contains、fuzzy 排序。
- `pnpm test:local-launch`：通过。
- `pnpm test:web-quick-open`：通过。
- `pnpm test:command-history`：通过。
- `pnpm test:command-aliases`：通过。
- `pnpm test:audit-view`：通过。
- `pnpm test:debug-diagnostics`：通过。
- `pnpm test:match-type-meta`：通过。
- `pnpm test:keyboard-target`：通过。
- `pnpm test:text-quick-actions`：通过。
- `pnpm test:url-quick-open`：通过。
- `pnpm test:search-feedback`：通过。
- `pnpm test:paste-intake`：通过。
- `pnpm test:hotkey-recorder`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，159 modules transformed。
- HTTP smoke：`200`。

Bundle 结果：

- 上一批主 JS：`402.97 kB / gzip 201.75 kB`。
- 当前主 JS：`188.10 kB / gzip 62.92 kB`。
- 拼音异步 chunk：`216.33 kB / gzip 138.76 kB`。
- 结论：首屏主 JS gzip 降低约 `138.83 kB`，拼音能力保留为异步加载。

Browser / Playwright smoke：

- in-app Browser 路径：
  - 打开 `http://127.0.0.1:1420/?parity=1&pinyinLazySmoke=1` 成功。
  - 交互阶段仍受 Browser 虚拟剪贴板限制影响，`.fill("sz")` 失败，因此切到 Playwright fallback。
- Playwright fallback：
  - 打开 `http://127.0.0.1:1420/?parity=1&pinyinLazySmoke=playwright`。
  - 输入 `sz`，等待懒加载完成。
  - 页面可见 `设置` 和 `拼音` 标签。
  - Console error/warn：0。

Smoke 截图：

- `/tmp/atools-pinyin-lazy-smoke.png`

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 91% | 91% | 拼音召回能力保留，行为不扩展，保持不变 |
| 内置程序功能闭环 | 86% | 87% | 拼音引擎异步加载后会刷新当前搜索结果，避免首输状态长期不一致 |
| 设置项真实功能 | 54% | 54% | 本批未扩展设置页，保持不变 |
| Agent/MCP 底座 | 68% | 68% | 本批未扩展 Agent/MCP，保持不变 |
| 测试与发布 | 75% | 79% | 解决首屏 bundle 体积问题，新增懒加载测试和完整构建证据 |

当前重点剩余：

1. 真实 Tauri 窗口下验证 URL 打开、路径动作权限确认、搜索 loading、插件失败状态、审计详情和数据页插件/审计 smoke。
2. 主搜索继续补搜索索引性能优化：缓存 normalized text / alias / pinyin tokens，减少每次输入重复计算。
3. 设置页继续补调试日志真实 Tauri 主进程日志接入、插件数据真实读写视图和更多 ZTools 细节。

## 第十八批：真实 Tauri 桌面端 Smoke 入口

用户要求：继续还原完成度；测试没问题后同步更新文档；完成一大项后同步完成度。

状态：DONE。

修改文件：

- `package.json`
- `scripts/smoke-tauri-desktop.mjs`
- `scripts/test-tauri-desktop-smoke-script.mjs`
- `src-tauri/src/desktop_smoke.rs`
- `src-tauri/src/lib.rs`

完成：

- 新增真实桌面端 smoke 模式：
  - 启动环境变量：`ATOOLS_DESKTOP_SMOKE=1`。
  - Tauri setup 完成后等待 MCP 最多约 4 秒。
  - 输出单行机器可解析 JSON：`ATOOLS_DESKTOP_SMOKE {...}`。
  - 输出后自动退出进程，不需要人工关闭窗口。
- Smoke 快照覆盖：
  - `main_window`
  - `settings_window`
  - `mcp_ready`
  - `mcp_bind`
  - `agent_tools_count`
  - `enabled_agent_tools`
  - `plugin_count`
  - `audit_entries_count`
  - `permission_mode`
- 新增 `pnpm smoke:tauri-desktop`：
  - 使用 `pnpm tauri dev` 启动真实 Tauri app。
  - 注入 `ATOOLS_DESKTOP_SMOKE=1`。
  - 解析 smoke JSON，`status !== "ok"` 或进程非 0 时失败。
- 新增脚本测试：
  - 验证 smoke 输出解析。
  - 验证 env 注入。
  - 验证默认命令为 `pnpm tauri dev`。
  - 验证 `--` 后参数可透传给 Tauri CLI。

验证：

```bash
cargo test -p atools --lib
pnpm test:tauri-desktop-smoke-script
pnpm test:pinyin-lazy-load
pnpm test:audit-view
pnpm check
pnpm build
curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:1420/?parity=1'
pnpm smoke:tauri-desktop
```

结果：

- `cargo test -p atools --lib`：通过，15 tests passed。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm test:pinyin-lazy-load`：通过。
- `pnpm test:audit-view`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，159 modules transformed。
- HTTP smoke：`200`。
- `pnpm smoke:tauri-desktop`：通过。

真实 Tauri smoke 输出：

```json
{
  "status": "ok",
  "main_window": true,
  "settings_window": true,
  "mcp_ready": true,
  "mcp_bind": "127.0.0.1:55020",
  "agent_tools_count": 7,
  "enabled_agent_tools": [
    "compress_images",
    "find_local_files",
    "get_current_context",
    "ocr_image",
    "open_or_reveal_path",
    "rename_files",
    "search_clipboard"
  ],
  "plugin_count": 18,
  "audit_entries_count": 0,
  "permission_mode": "conservative"
}
```

本批发现的残留问题：

- `crates/atools-api-shim/src/handler_wrapper.rs` 有一个 `std::sync::Arc` unused import warning。
- `src-tauri/src/commands.rs` 使用 deprecated `tauri_plugin_shell::open::Program` / `Shell::open`，后续应迁移到 `tauri-plugin-opener`。
- 当前持久 DB 中已有 `json` feature code，导致内置 `json-viewer` 启动时出现 `UNIQUE constraint failed: features.code` warning；真实 smoke 不阻塞，但应作为下一批“插件 feature 冲突/失败状态”处理。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 91% | 91% | 本批未扩展主搜索行为，保持不变 |
| 内置程序功能闭环 | 87% | 88% | 桌面端 app setup、窗口、MCP、工具注册可自动验证 |
| 设置项真实功能 | 54% | 54% | 本批未扩展设置页，保持不变 |
| Agent/MCP 底座 | 68% | 72% | 真实 Tauri app 中 MCP ready 与 7 个默认 Agent 工具已可 smoke 验证 |
| 测试与发布 | 79% | 84% | 新增真实桌面端 smoke 入口，发布前可脚本化验证 macOS 首版底座 |

当前重点剩余：

1. 处理内置/已安装插件 feature code 冲突，补插件失败状态 UI 和 clean startup smoke。
2. 真实 Tauri smoke 继续扩展：URL 打开、路径权限确认、审计详情和数据页插件/审计读写。
3. 主搜索继续补搜索索引性能优化：缓存 normalized text / alias / pinyin tokens，减少每次输入重复计算。
4. 设置页继续补调试日志真实 Tauri 主进程日志接入、插件数据真实读写视图和更多 ZTools 细节。

## 第十九批：内置搜索行为设置真实化

用户最新要求：插件不着急，先继续完善内置程序体验。

状态：DONE。

修改文件：

- `package.json`
- `scripts/test-search-behavior.mjs`
- `src/lib/searchBehavior.ts`
- `src/App.svelte`
- `src/components/SettingsPanel.svelte`

完成：

- 新增 `searchBehavior.ts` 纯逻辑模块：
  - `behaviorDelayMs()` 统一解析 `immediately`、`1s`、`30s`、`1m`、`never`、`off`。
  - `autoClearDelayMs()` / `autoBackToSearchDelayMs()` 供主程序行为复用。
  - `includeLocalLaunchSearch()` 供本地启动搜索开关复用。
- 设置页行为项从“禁用假开关”改为真实可用：
  - `本地应用搜索` 改为更准确的 `本地启动搜索`，关闭后主搜索不再匹配本地启动项。
  - `自动清空搜索框` 解除禁用，执行 URL 快开、本地启动、文本复制、粘贴动作后按配置清空。
  - `自动返回到搜索` 解除禁用，进入设置、Agent 等内置面板后按配置返回主搜索。
  - `SettingsPanel` 不再把这些设置强制保存成 `false` / `never`。
- App 主程序接入：
  - 本地启动结果受 `appSettings.localAppSearch` 控制。
  - 自动清空带防误清逻辑：用户在延迟期间输入新内容、进入插件或离开主搜索时，不会清空新状态。
  - 自动返回使用面板状态计时器，面板变化后自动清理旧 timer。

验证：

```bash
pnpm test:search-behavior
pnpm test:local-launch
pnpm test:web-quick-open
pnpm test:command-history
pnpm test:search-feedback
pnpm test:url-quick-open
pnpm test:text-quick-actions
pnpm test:search-match
pnpm test:command-aliases
pnpm test:audit-view
pnpm test:debug-diagnostics
pnpm test:pinyin-lazy-load
pnpm test:hotkey-recorder
pnpm test:keyboard-target
pnpm test:paste-intake
pnpm test:match-type-meta
pnpm test:tauri-desktop-smoke-script
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:search-behavior`：通过，覆盖时长解析、自动清空、自动返回和本地启动搜索开关。
- 前端逻辑回归：全部通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，160 modules transformed；主 JS gzip `63.35 kB`，拼音异步 chunk gzip `138.76 kB`。
- Playwright smoke：
  - 关闭 `localAppSearch` 后输入 `desktop` 不出现 `打开 桌面`。
  - 开启 `localAppSearch` 后输入 `desktop` 出现 `打开 桌面`。
  - `autoClear=immediately` 时执行 `example.com/docs` URL 快开后搜索框值清空。
  - `autoBackToSearch=1s` 时打开设置页后约 1 秒回到主搜索。
  - 设置页 `本地启动搜索`、`自动清空搜索框`、`自动返回到搜索` 控件均非 disabled。
  - Console error/warn：0。
- Browser 插件路径：本轮没有暴露单独的 in-app Browser 控制工具；已记录为工具不可用，使用 Playwright fallback 完成同一 URL 验证。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见。

真实 Tauri smoke 残留：

- `crates/atools-api-shim/src/handler_wrapper.rs` unused import warning 仍存在。
- `src-tauri/src/commands.rs` deprecated `tauri_plugin_shell::open` warning 仍存在。
- `json-viewer` feature code 冲突 warning 仍存在；本批按用户要求未推进插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 91% | 92% | 本地启动搜索开关、动作后自动清空和面板自动返回已接入主搜索体验 |
| 内置程序功能闭环 | 88% | 90% | 设置项、主搜索结果和执行后状态清理形成闭环 |
| 设置项真实功能 | 54% | 60% | 3 个原禁用行为项变成真实可用设置 |
| Agent/MCP 底座 | 72% | 72% | 本批未扩展 Agent/MCP，保持不变 |
| 测试与发布 | 84% | 85% | 新增行为测试，完成前端回归、构建、Playwright smoke 和真实 Tauri smoke |

当前重点剩余：

1. 继续完善内置程序体验：搜索索引缓存、设置页真实 Tauri 主进程日志、数据页审计读写 smoke。
2. 真实 Tauri smoke 扩展 URL 打开、路径权限确认和审计详情端到端。
3. 插件 feature code 冲突和失败状态 UI 暂后，等内置体验继续收敛后再处理。

## 第二十批：剪贴板历史首版

用户要求：插件不着急，继续完善内置程序体验；测试没问题后同步更新文档和完成度。

状态：DONE。

修改文件：

- `crates/atools-core/src/models.rs`
- `crates/atools-core/src/db.rs`
- `crates/atools-core/src/utils.rs`
- `crates/atools-core/src/lib.rs`
- `src-tauri/src/agent_tools.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/tests/agent_tools_tests.rs`
- `src/lib/types.ts`
- `src/components/SettingsPanel.svelte`

完成：

- Core DB 新增本地剪贴板历史：
  - 新表 `clipboard_history`。
  - 文本内容按稳定 hash 去重，同一文本重复复制会更新 `last_copied_at` 并累加 `used_count`。
  - 支持按关键词搜索、按最近复制时间排序、limit 限制。
  - 支持按 cutoff 清理、全量清空、JSON 导出。
- Agent `search_clipboard` 升级：
  - 不再只搜索当前剪贴板。
  - 调用工具时读取当前文本剪贴板，先写入本地历史，再搜索历史。
  - 支持 `query` 和 `limit`。
  - 输出条目包含 `source=clipboard_history`、`first_copied_at`、`last_copied_at`、`used_count`。
  - 采集时读取 `settings-general.clipboardRetentionDays`，按保存天数清理旧历史。
- Tauri commands：
  - `list_clipboard_history`
  - `clear_clipboard_history`
  - `export_clipboard_history_json`
- 设置页：
  - `剪贴板历史保存天数` 从禁用态变为真实设置。
  - `我的数据` 页增加 `剪贴板历史` 数据项，支持导出和清空。
  - `我的数据` 页增加 `剪贴板历史明细`，展示最近文本、时间、次数和本地 ID。
  - 浏览器预览模式下明确提示剪贴板历史需要 Tauri 桌面运行时。

验证：

```bash
cargo fmt --check
cargo test -p atools-core --lib
cargo test -p atools --test agent_tools_tests
cargo test -p atools --lib
pnpm check
pnpm build
pnpm test:search-behavior
pnpm test:command-history
pnpm test:audit-view
pnpm test:debug-diagnostics
pnpm test:local-launch
pnpm test:web-quick-open
pnpm test:search-feedback
pnpm test:pinyin-lazy-load
pnpm smoke:tauri-desktop
```

结果：

- `cargo test -p atools-core --lib`：32 passed。
- `cargo test -p atools --test agent_tools_tests`：18 passed。
- `cargo test -p atools --lib`：15 passed。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，160 modules transformed；主 JS gzip `63.82 kB`，拼音异步 chunk gzip `138.76 kB`。
- 前端脚本回归：上述 8 个脚本全部通过。
- Playwright smoke：
  - 设置页 `剪贴板历史保存天数` 存在且非 disabled，默认值 `180`。
  - `我的数据` 页显示 `剪贴板历史` 和 `剪贴板历史明细`。
  - 浏览器预览模式显示 Tauri 运行时提示，剪贴板导出按钮禁用。
  - Console error/warn：0。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见。

真实 Tauri smoke 残留：

- `crates/atools-api-shim/src/handler_wrapper.rs` unused import warning 仍存在。
- `src-tauri/src/commands.rs` deprecated `tauri_plugin_shell::open` warning 仍存在。
- `json-viewer` feature code 冲突 warning 仍存在；本批继续按用户要求不推进插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 92% | 92% | 本批主要是后台能力和数据页，主搜索本身不扩展 |
| 内置程序功能闭环 | 90% | 93% | 剪贴板历史从 DB、Agent 工具、设置保留天数到数据页管理形成首版闭环 |
| 设置项真实功能 | 60% | 65% | `剪贴板历史保存天数` 和 `我的数据/剪贴板历史` 变成真实功能 |
| Agent/MCP 底座 | 72% | 76% | `search_clipboard` 从当前剪贴板升级为可搜索本地历史，并保留权限/审计链路 |
| 测试与发布 | 85% | 87% | 增加 DB/Agent 测试，完成前端回归、构建、Playwright smoke 和真实 Tauri smoke |

当前重点剩余：

1. 继续完善内置程序体验：搜索索引缓存、调试日志真实主进程日志、审计/剪贴板端到端桌面 smoke。
2. 扩展真实 Tauri smoke：实际调用 `search_clipboard`、验证历史写入、数据页读取和审计记录。
3. 插件 feature code 冲突和失败状态 UI 继续暂后。

## 第二十一批：本地应用搜索首版

用户要求：插件不着急，先继续完善内置程序体验。本批聚焦 uTools/ZTools 常见体验：主搜索可直接搜到并打开 macOS 本地 `.app`。

状态：DONE。

修改文件：

- `scripts/test-search-behavior.mjs`
- `src/lib/settings.ts`
- `src/lib/searchBehavior.ts`
- `src/App.svelte`
- `src/components/SettingsPanel.svelte`
- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`

完成：

- 设置边界拆清：
  - `本地应用搜索` 专门控制 macOS `.app` 搜索。
  - `本地启动搜索` 专门控制自定义本地启动项。
  - 两个设置都在通用设置的“搜索”区块中独立显示和保存。
- Rust core 新增 `search_local_apps` Tauri command：
  - 默认扫描 `/Applications` 和 `~/Applications`。
  - 递归识别 `.app` bundle。
  - 支持 exact / prefix / contains / fuzzy 匹配和 limit。
  - 结果统一为主搜索 `SearchResult`，来源为 `本地应用`。
- 主搜索接入：
  - 输入查询时并行合并系统指令和本地应用结果。
  - 本地应用结果使用 `local-app:{absolute path}` code 标记。
  - Enter/点击/历史 payload 命中本地应用时通过 Tauri `shell_open` 打开 `.app`。
  - 浏览器预览模式下不执行本地打开，只给出明确状态提示。

验证：

```bash
cargo fmt --check
cargo test -p atools --lib
cargo test -p atools --test agent_tools_tests
cargo test -p atools-core --lib
pnpm check
pnpm build
pnpm test:search-behavior
pnpm test:local-launch
pnpm test:command-history
pnpm test:search-feedback
pnpm test:command-aliases
pnpm smoke:tauri-desktop
```

结果：

- `cargo fmt --check`：通过。
- `cargo test -p atools --lib`：17 passed，新增 2 个本地 `.app` 搜索单测。
- `cargo test -p atools --test agent_tools_tests`：18 passed。
- `cargo test -p atools-core --lib`：32 passed。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，160 modules transformed。
- 前端脚本回归：`search-behavior`、`local-launch`、`command-history`、`search-feedback`、`command-aliases` 全部通过。
- Browser in-app smoke：
  - 打开 `http://127.0.0.1:1420/?parity=1&localAppSmoke=1`。
  - 点击设置入口后，设置页可见 `本地应用搜索` 和 `本地启动搜索`。
  - 两个开关均渲染在通用设置的“搜索”区块，不再混用同一设置含义。
- Playwright console fallback：
  - 同一 URL 设置页 smoke 通过。
  - Console errors：0；warnings：0。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，新 Tauri command 注册后桌面启动正常。

真实 Tauri smoke 残留：

- `crates/atools-api-shim/src/handler_wrapper.rs` unused import warning 仍存在。
- `src-tauri/src/commands.rs` deprecated `tauri_plugin_shell::open` warning 仍存在。
- `json-viewer` feature code 冲突 warning 仍存在；本批按用户要求继续不处理插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 92% | 94% | 主搜索开始具备直接发现并打开 macOS 本地应用的能力，更接近 uTools/ZTools 日常使用路径 |
| 内置程序功能闭环 | 93% | 94% | 本地应用搜索从设置、Rust 扫描、主搜索合并到执行打开形成首版闭环 |
| 设置项真实功能 | 65% | 68% | `本地应用搜索` 与 `本地启动搜索` 拆成两个真实设置项 |
| Agent/MCP 底座 | 76% | 76% | 本批未扩展 Agent/MCP，保持不变 |
| 测试与发布 | 87% | 88% | 增加 Rust `.app` 搜索测试，并完成前端回归、Browser/Playwright smoke 和真实 Tauri smoke |

当前重点剩余：

1. 继续完善内置程序体验：主搜索本地应用结果的图标展示、缓存索引、拼音/别名命中排序。
2. 补调试日志真实主进程日志和数据页审计/剪贴板端到端桌面 smoke。
3. 插件 feature code 冲突、插件市场和 bridge 兼容继续暂后。

## 第二十二批：本地应用搜索索引缓存与稳定排序

用户要求：继续还原完成度，插件不着急，优先完善内置程序体验。本批继续推进主搜索里的本地应用搜索手感。

状态：DONE。

修改文件：

- `src-tauri/src/commands.rs`

完成：

- 本地应用搜索新增进程内索引缓存：
  - `search_local_apps` 首次查询时扫描 `/Applications` 和 `~/Applications`。
  - 同一 roots 在 45 秒 TTL 内复用缓存，避免每个 keystroke 都重新递归扫描应用目录。
  - TTL 过期后自动重建索引，兼顾性能和新安装应用的可见性。
- 本地应用结果排序更稳定：
  - 仍按匹配分数优先。
  - 同分时按 label 排序。
  - 同名同分时按本地路径排序，避免列表顺序因文件系统读取顺序抖动。
- 测试辅助入口 `search_local_apps_in_roots` 限定为 `cfg(test)`，避免生产 lib 新增 dead_code warning。

TDD 记录：

- 先新增失败测试：
  - `local_app_search_cache_reuses_index_until_ttl_expires`
  - `local_app_search_sorts_same_score_and_label_by_path`
- 初次运行 `cargo test -p atools --lib local_app_search` 失败，原因是缓存类型/函数/TTL 常量不存在。
- 实现缓存和排序后，目标测试转绿。

验证：

```bash
cargo fmt --check
cargo test -p atools --lib local_app_search
cargo test -p atools --lib
cargo test -p atools --test agent_tools_tests
cargo test -p atools-core --lib
pnpm check
pnpm build
pnpm test:search-behavior
pnpm test:local-launch
pnpm test:command-history
pnpm test:search-feedback
pnpm test:command-aliases
pnpm smoke:tauri-desktop
```

结果：

- `cargo fmt --check`：通过。
- `cargo test -p atools --lib local_app_search`：4 passed。
- `cargo test -p atools --lib`：19 passed。
- `cargo test -p atools --test agent_tools_tests`：18 passed。
- `cargo test -p atools-core --lib`：32 passed。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，160 modules transformed。
- 前端脚本回归：`search-behavior`、`local-launch`、`command-history`、`search-feedback`、`command-aliases` 全部通过。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，桌面启动链路正常。

真实 Tauri smoke 残留：

- `crates/atools-api-shim/src/handler_wrapper.rs` unused import warning 仍存在。
- `src-tauri/src/commands.rs` deprecated `tauri_plugin_shell::open` warning 仍存在。
- `json-viewer` feature code 冲突 warning 仍存在；继续按用户要求不处理插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 94% | 95% | 本地应用搜索减少每次输入的目录扫描，结果排序更稳定，启动器输入手感更接近可日用 |
| 内置程序功能闭环 | 94% | 94% | 本批是性能和稳定性优化，功能闭环保持不变 |
| 设置项真实功能 | 68% | 68% | 本批未扩展设置页 |
| Agent/MCP 底座 | 76% | 76% | 本批未扩展 Agent/MCP |
| 测试与发布 | 88% | 89% | 增加缓存与排序单测，并通过真实 Tauri smoke |

当前重点剩余：

1. 继续完善内置程序体验：本地应用图标展示、应用搜索别名/拼音增强、搜索索引性能基准。
2. 补调试日志真实主进程日志和数据页审计/剪贴板端到端桌面 smoke。
3. 插件 feature code 冲突、插件市场和 bridge 兼容继续暂后。

## 第二十三批：本地应用图标首版

用户要求：继续还原完成度，优先完善内置程序体验。本批补齐主搜索里本地应用结果的视觉还原，不再只依赖字母占位。

状态：DONE。

修改文件：

- `package.json`
- `scripts/test-result-icons.mjs`
- `src/lib/resultIcons.ts`
- `src/components/ResultsList.svelte`
- `src-tauri/src/commands.rs`

完成：

- Rust 本地应用索引新增图标路径解析：
  - 读取 `.app/Contents/Info.plist`。
  - 支持 XML plist 中的 `CFBundleIconFile`。
  - 未带扩展名时自动查找 `Contents/Resources/{name}.icns`。
  - 图标资源不存在时保持 `icon=None`，前端回退到字母占位。
- 前端结果列表新增本地图标路径转换：
  - 新增 `resultIcons.ts`。
  - `data:`、`https:`、`asset:` 图标保持原样。
  - `/Applications/...` 或 Windows 本地路径只在真实 Tauri runtime 下通过 `convertFileSrc()` 转成 asset URL。
  - Web 预览模式下不直接加载本地绝对路径，避免 broken image 和 CSP 噪音。
- `ResultsList` 接入转换后的图标 URL，保留原有字母 fallback。

TDD 记录：

- 先新增失败测试：
  - Rust：`local_app_search_reads_icon_from_info_plist_without_extension`。
  - Rust：`local_app_search_leaves_icon_empty_when_declared_resource_is_missing`。
  - 前端：`pnpm test:result-icons`。
- 初次运行：
  - Rust 目标测试失败，因为结果 `icon` 没有从 Info.plist 解析。
  - 前端测试失败，因为 `src/lib/resultIcons.ts` 不存在。
- 实现 Rust 图标解析和前端 asset 转换后，目标测试转绿。

验证：

```bash
cargo fmt --check
cargo test -p atools --lib local_app_search
cargo test -p atools --lib
cargo test -p atools --test agent_tools_tests
cargo test -p atools-core --lib
pnpm check
pnpm build
pnpm test:result-icons
pnpm test:search-behavior
pnpm test:local-launch
pnpm test:command-history
pnpm test:search-feedback
pnpm test:command-aliases
pnpm smoke:tauri-desktop
```

结果：

- `cargo fmt --check`：通过。
- `cargo test -p atools --lib local_app_search`：6 passed。
- `cargo test -p atools --lib`：21 passed。
- `cargo test -p atools --test agent_tools_tests`：18 passed。
- `cargo test -p atools-core --lib`：32 passed。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，161 modules transformed。
- `pnpm test:result-icons`：通过。
- 前端脚本回归：`search-behavior`、`local-launch`、`command-history`、`search-feedback`、`command-aliases` 全部通过。
- Browser in-app smoke：
  - 成功打开 `http://127.0.0.1:1420/?parity=1&iconSmoke=1` 并读取 DOM 快照。
  - Browser 插件输入仍受 virtual clipboard 未安装限制，无法完成 locator fill。
- Playwright fallback smoke：
  - 同一 URL 输入 `>` 后渲染 4 条结果。
  - `hasResultsList=true`。
  - `brokenLocalPathImages=0`，Web 预览未把 `/Applications/...` 作为普通 img src 加载。
  - Console errors：0；warnings：0。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，桌面启动链路正常。

真实 Tauri smoke 残留：

- `crates/atools-api-shim/src/handler_wrapper.rs` unused import warning 仍存在。
- `src-tauri/src/commands.rs` deprecated `tauri_plugin_shell::open` warning 仍存在。
- `json-viewer` feature code 冲突 warning 仍存在；继续按用户要求不处理插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 95% | 96% | 本地应用结果开始具备真实 app 图标路径，视觉上更接近启动器 |
| 内置程序功能闭环 | 94% | 95% | 本地应用搜索从发现、排序、打开扩展到图标展示链路 |
| 设置项真实功能 | 68% | 68% | 本批未扩展设置页 |
| Agent/MCP 底座 | 76% | 76% | 本批未扩展 Agent/MCP |
| 测试与发布 | 89% | 90% | 增加 Rust 图标解析测试和前端图标转换测试，并通过真实 Tauri smoke |

当前重点剩余：

1. 继续完善内置程序体验：应用搜索别名/拼音增强、搜索索引性能基准、调试日志真实主进程日志。
2. 扩展真实桌面 smoke：实际搜索一个系统 app，验证 icon asset URL 可被 WebView 加载。
3. 插件 feature code 冲突、插件市场和 bridge 兼容继续暂后。

## 第二十四批：调试日志真实 Tauri 主进程诊断

用户要求：继续还原完成度，测试没问题后同步更新文档和完成度。本批把设置页 `调试日志` 从前端本地状态扩展到真实 Tauri 主进程运行状态。

状态：DONE。

修改文件：

- `scripts/test-debug-diagnostics.mjs`
- `src/lib/debugDiagnostics.ts`
- `src/lib/types.ts`
- `src/components/SettingsPanel.svelte`
- `src-tauri/src/state.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/desktop_smoke.rs`

完成：

- Rust 主进程新增运行事件缓冲：
  - `AppState.runtime_events` 保存最近 100 条主进程事件。
  - 启动、Tauri setup、Agent 工具同步、内置插件加载、MCP 启动成功/失败会写入事件。
- 新增 Tauri command：`get_runtime_diagnostics`：
  - 返回 runtime、platform、arch、debug/release。
  - 返回数据目录、数据库路径、插件目录。
  - 返回插件数、指令数、Agent 工具数、启用工具数。
  - 返回 MCP enabled/bind、当前 active plugin、最近主进程事件。
  - 不向调试页展示 MCP token。
- 设置页 `调试日志` 新增 `桌面运行状态`：
  - 浏览器预览模式显示“需要 Tauri 桌面端才能读取主进程状态”。
  - Tauri 桌面端可展示真实主进程诊断。
  - `复制信息` 增加 runtime 原始诊断和格式化行，便于用户反馈问题。
- 真实桌面 smoke 新增 `runtime_events_count` 字段：
  - 真实启动后输出本次主进程事件数量。
  - 本轮真实 smoke 输出 `runtime_events_count: 5`。

TDD 记录：

- 先新增失败测试：
  - Rust：`runtime_diagnostics_snapshot_reports_paths_counts_mcp_and_events`。
  - 前端：`runtimeDiagnosticRows()` 格式化测试。
  - Desktop smoke：`runtime_events_count` 字段测试。
- 初次运行：
  - Rust 目标测试因 `RuntimeEvent` / `runtime_diagnostics_snapshot` 不存在失败。
  - 前端测试因 `runtimeDiagnosticRows` 不存在失败。
  - Desktop smoke 测试因 `runtime_events_count` 字段不存在失败。
- 实现后全部转绿。

验证：

```bash
cargo fmt --check
cargo test -p atools --lib runtime_diagnostics_snapshot
cargo test -p atools --lib desktop_smoke
cargo test -p atools --lib
cargo test -p atools --test agent_tools_tests
cargo test -p atools-core --lib
pnpm check
pnpm build
pnpm test:debug-diagnostics
pnpm test:audit-view
pnpm test:tauri-desktop-smoke-script
pnpm smoke:tauri-desktop
```

结果：

- `cargo fmt --check`：通过。
- `cargo test -p atools --lib runtime_diagnostics_snapshot`：1 passed。
- `cargo test -p atools --lib desktop_smoke`：2 passed。
- `cargo test -p atools --lib`：22 passed。
- `cargo test -p atools --test agent_tools_tests`：18 passed。
- `cargo test -p atools-core --lib`：32 passed。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，161 modules transformed。
- `pnpm test:debug-diagnostics`：通过。
- `pnpm test:audit-view`：通过。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- Browser in-app smoke：
  - 打开 `http://127.0.0.1:1420/?parity=1&runtimeDebugSmoke=1`。
  - 点击设置入口，再进入 `调试日志`。
  - DOM 可见 `调试日志`、`桌面运行状态`、`桌面运行时`。
  - 预览模式显示 Tauri 不可用提示，且不出现 `secret-token`。
- Playwright fallback smoke：
  - 同一 URL 调试页验证通过。
  - Console errors：0；warnings：0。
  - 截图：`.playwright-mcp/page-2026-06-02T11-55-17-311Z.png`。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，`runtime_events_count=5`。

真实 Tauri smoke 残留：

- `crates/atools-api-shim/src/handler_wrapper.rs` unused import warning 仍存在。
- `src-tauri/src/commands.rs` deprecated `tauri_plugin_shell::open` warning 仍存在。
- `json-viewer` feature code 冲突 warning 仍存在；继续按用户要求不处理插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 96% | 96% | 本批未扩展主搜索 |
| 内置程序功能闭环 | 95% | 96% | 调试页可读取真实主进程状态，问题定位链路更完整 |
| 设置项真实功能 | 68% | 72% | `调试日志` 从前端诊断扩展为真实 Tauri 运行诊断 |
| Agent/MCP 底座 | 76% | 77% | 调试页可显示 MCP 运行状态并隐藏 token |
| 测试与发布 | 90% | 91% | 真实桌面 smoke 增加 runtime event 计数，覆盖主进程诊断链路 |

当前重点剩余：

1. 继续完善内置程序体验：应用搜索别名/拼音增强、搜索索引性能基准。
2. 扩展真实桌面 smoke：实际搜索一个系统 app，验证 icon asset URL 可被 WebView 加载。
3. 插件 feature code 冲突、插件市场和 bridge 兼容继续暂后。

## 第二十五批：真实桌面本地应用搜索 smoke

用户要求：插件不着急，先继续完善内置程序体验。本批把本地应用搜索从单测和前端展示推进到真实 Tauri 桌面 smoke，验证 macOS 系统目录里的 Terminal 能被发现并带出图标。

状态：DONE。

修改文件：

- `src-tauri/src/commands.rs`
- `src-tauri/src/desktop_smoke.rs`
- `scripts/test-tauri-desktop-smoke-script.mjs`

完成：

- 本地应用默认搜索目录补齐 macOS 系统应用路径：
  - `/Applications`
  - `/System/Applications`
  - `/System/Applications/Utilities`
  - `~/Applications`
- 新增 `search_local_apps_for_smoke()`，真实 smoke 使用同一套本地应用扫描和图标解析逻辑。
- 桌面 smoke 输出新增 `local_app_search`：
  - `query`
  - `result_count`
  - `icon_count`
  - `sample_label`
  - `sample_has_icon`
- 真实 Tauri smoke 的 `status=ok` 现在要求：
  - 本地应用搜索至少命中一个结果。
  - 命中结果里至少有一个真实图标路径。
- 本轮真实 smoke 输出：
  - `query: "terminal"`
  - `result_count: 1`
  - `icon_count: 1`
  - `sample_label: "打开 Terminal"`
  - `sample_has_icon: true`

TDD 记录：

- 先新增失败测试：
  - `local_app_default_roots_include_system_applications`
  - `local_app_smoke_summary_counts_results_icons_and_sample`
  - desktop smoke snapshot 的 `local_app_search` 字段断言
  - `scripts/test-tauri-desktop-smoke-script.mjs` 的 `local_app_search` 解析断言
- 初次运行 Rust 目标测试因 `LocalAppSmokeSummary` / `local_app_search` 字段尚未实现出现编译失败，形成红灯。
- 实现默认系统目录、smoke summary 和真实 reporter 接线后，目标测试转绿。

验证：

```bash
cargo fmt --check
cargo test -p atools --lib
cargo test -p atools --test agent_tools_tests
cargo test -p atools-core --lib
pnpm check
pnpm build
pnpm test:tauri-desktop-smoke-script
pnpm smoke:tauri-desktop
```

结果：

- `cargo fmt --check`：通过。
- `cargo test -p atools --lib`：24 passed。
- `cargo test -p atools --test agent_tools_tests`：18 passed。
- `cargo test -p atools-core --lib`：32 passed。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，161 modules transformed。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，`runtime_events_count=5`，`local_app_search.result_count=1`，`local_app_search.icon_count=1`。
- 本批未改前端渲染代码，因此未额外跑 Browser smoke。

真实 Tauri smoke 残留：

- `crates/atools-api-shim/src/handler_wrapper.rs` unused import warning 仍存在。
- `src-tauri/src/commands.rs` deprecated `tauri_plugin_shell::open` warning 仍存在。
- `json-viewer` feature code 冲突 warning 仍存在；继续按用户要求不处理插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 96% | 97% | 本地应用搜索覆盖 macOS 系统应用目录，并通过真实桌面 smoke 验证 Terminal 与图标命中 |
| 内置程序功能闭环 | 96% | 97% | 本地应用搜索、图标解析和桌面启动诊断形成真实运行闭环 |
| 设置项真实功能 | 72% | 72% | 本批未扩展设置页 |
| Agent/MCP 底座 | 77% | 77% | 本批未扩展 Agent/MCP |
| 测试与发布 | 91% | 92% | 真实桌面 smoke 覆盖系统应用搜索和图标摘要，发布前可更早发现 macOS 目录/资源问题 |

当前重点剩余：

1. 继续完善内置程序体验：应用搜索别名/拼音增强、搜索索引性能基准。
2. 设置页继续向 ZTools 对齐：更多开关项接真实 Tauri command，减少纯前端模拟状态。
3. 插件 feature code 冲突、插件市场和 bridge 兼容继续暂后。

## 第二十六批：本地应用 Info.plist metadata 搜索

用户要求：继续还原完成度，插件不着急，优先完善内置程序体验。本批聚焦 uTools/ZTools 常见启动器体验：应用不仅能按 `.app` 文件名召回，也能按 Info.plist 里的显示名、bundle id、可执行名召回。

状态：DONE。

修改文件：

- `src-tauri/src/commands.rs`
- `src-tauri/src/desktop_smoke.rs`
- `scripts/test-tauri-desktop-smoke-script.mjs`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 本地应用索引读取 `Contents/Info.plist`：
  - `CFBundleDisplayName` / `CFBundleName` 优先作为展示名称。
  - `CFBundleIdentifier` / `CFBundleExecutable` 作为 metadata alias 参与搜索。
- 本地应用匹配增加统一 normalize：
  - `.`、`-`、`_`、`/`、空白等分隔符统一处理。
  - `com.example.actual-tool` 可用 `com example actual` 召回。
- metadata 命中结果的 `match_type` 为 `alias`，前端已有中文标签能力可复用。
- 真实桌面 smoke 的本地应用查询从 `terminal` 改为 `com apple terminal`：
  - 不再只验证应用名搜索。
  - 真实覆盖 macOS Terminal 的 `com.apple.Terminal` bundle id 召回。
- 本轮真实 smoke 输出：
  - `query: "com apple terminal"`
  - `result_count: 1`
  - `icon_count: 1`
  - `sample_label: "打开 Terminal"`
  - `sample_has_icon: true`

TDD 记录：

- 先新增失败测试：
  - `local_app_search_uses_info_plist_display_name_and_metadata_aliases`
  - `desktop_smoke_local_app_query_exercises_bundle_identifier_alias`
- 初次运行：
  - metadata 测试失败：`actual` 无法命中 `CFBundleDisplayName=Actual Tool`。
  - smoke 查询测试失败：常量仍为 `terminal`。
- 实现 Info.plist metadata 索引、alias 匹配和 smoke 查询切换后，目标测试全部转绿。

验证：

```bash
cargo fmt --check
cargo test -p atools --lib
cargo test -p atools --test agent_tools_tests
cargo test -p atools-core --lib
pnpm check
pnpm build
pnpm test:tauri-desktop-smoke-script
pnpm test:result-icons
pnpm smoke:tauri-desktop
```

结果：

- `cargo fmt --check`：通过。
- `cargo test -p atools --lib`：26 passed。
- `cargo test -p atools --test agent_tools_tests`：18 passed。
- `cargo test -p atools-core --lib`：32 passed。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，161 modules transformed。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm test:result-icons`：通过。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，`runtime_events_count=6`，`local_app_search.query="com apple terminal"`，`result_count=1`，`icon_count=1`。
- 本批未改前端渲染代码，因此未额外跑 Browser smoke。

真实 Tauri smoke 残留：

- `crates/atools-api-shim/src/handler_wrapper.rs` unused import warning 仍存在。
- `src-tauri/src/commands.rs` deprecated `tauri_plugin_shell::open` warning 仍存在。
- `json-viewer` feature code 冲突 warning 仍存在；继续按用户要求不处理插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 97% | 98% | 本地应用搜索支持显示名、bundle id、可执行名 metadata alias，应用启动召回更接近 uTools/ZTools |
| 内置程序功能闭环 | 97% | 98% | 应用 metadata 索引、搜索匹配、图标展示和真实桌面 smoke 形成闭环 |
| 设置项真实功能 | 72% | 72% | 本批未扩展设置页 |
| Agent/MCP 底座 | 77% | 77% | 本批未扩展 Agent/MCP |
| 测试与发布 | 92% | 93% | 真实桌面 smoke 改为 bundle id 查询，覆盖更接近日常系统应用搜索的路径 |

当前重点剩余：

1. 搜索索引性能基准：本地应用、历史、别名、网页快开等多源合并在大结果量下的耗时。
2. 设置页继续向 ZTools 对齐：更多开关项接真实 Tauri command，减少纯前端模拟状态。
3. 插件 feature code 冲突、插件市场和 bridge 兼容继续暂后。

## 第二十七批：唤醒黑名单真实功能

用户要求：继续还原完成度，插件不着急，优先完善内置程序体验。本批把设置页里的 `唤醒黑名单` 从占位禁用项变成真实可编辑设置，并接入 macOS 全局快捷键唤醒前的前台应用拦截。

状态：DONE。

修改文件：

- `src-tauri/src/hotkey.rs`
- `src/components/SettingsPanel.svelte`
- `src/lib/wakeupBlacklist.ts`
- `scripts/test-wakeup-blacklist.mjs`
- `package.json`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 设置页 `唤醒黑名单`：
  - 去掉“未启用”占位。
  - 支持手动输入应用名，例如 `Terminal`。
  - 支持添加、去重、移除标签。
  - 保存时写入 `settings-general.wakeupBlacklist`，加载时真实恢复。
- Rust 全局快捷键：
  - 主窗口已显示时仍允许隐藏。
  - 主窗口未显示时，先读取当前前台应用。
  - 前台应用命中 `wakeupBlacklist` 时，不唤醒主窗口。
  - 当前前台应用读取失败、设置缺失或设置非法时，不阻塞唤醒。
- 新增前端 helper：
  - `normalizeWakeupBlacklist()`
  - `addWakeupBlacklistItem()`
  - `wakeupBlacklistMatches()`

TDD 记录：

- 先新增失败测试：
  - Rust：`suppresses_wakeup_when_foreground_app_matches_blacklist`
  - Rust：`ignores_empty_or_invalid_wakeup_blacklist_settings`
  - 前端脚本：`scripts/test-wakeup-blacklist.mjs`
- 初次运行：
  - Rust 因 `should_suppress_wakeup_for_foreground_app` 不存在失败。
  - 前端因 `src/lib/wakeupBlacklist.ts` 不存在失败。
- 实现热键规则、前端 helper 和设置页保存/恢复后，目标测试转绿。

验证：

```bash
cargo fmt --check
cargo test -p atools --lib
cargo test -p atools --test agent_tools_tests
cargo test -p atools-core --lib
pnpm check
pnpm build
pnpm test:wakeup-blacklist
pnpm test:search-behavior
pnpm smoke:tauri-desktop
```

结果：

- `cargo fmt --check`：通过。
- `cargo test -p atools --lib`：28 passed。
- `cargo test -p atools --test agent_tools_tests`：18 passed。
- `cargo test -p atools-core --lib`：32 passed。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，162 modules transformed。
- `pnpm test:wakeup-blacklist`：通过。
- `pnpm test:search-behavior`：通过。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，`local_app_search.query="com apple terminal"`，`result_count=1`，`icon_count=1`。
- Browser in-app smoke：
  - 打开 `http://127.0.0.1:1420/?parity=1&wakeupBlacklistSmoke=1`。
  - 页面身份正确，标题 `ATools 3.0`，首屏非空，控制台 0 error / 0 warning。
  - Browser 插件输入动作受 virtual clipboard 未安装限制，`fill` / `type` 无法写入输入框。
- Playwright fallback smoke：
  - 打开 `http://127.0.0.1:1420/?parity=1&wakeupBlacklistSmoke=playwright`。
  - 进入设置页，页面出现 `唤醒黑名单` 和 `应用名，例如 Terminal` 输入框。
  - 添加 `Terminal` 后出现标签，`localStorage.atools:settings-general.wakeupBlacklist` 为 `["Terminal"]`。
  - Console errors：0；warnings：0。
  - 截图：`.playwright-mcp/page-2026-06-02T12-26-12-928Z.png`。

真实 Tauri smoke 残留：

- `crates/atools-api-shim/src/handler_wrapper.rs` unused import warning 仍存在。
- `src-tauri/src/commands.rs` deprecated `tauri_plugin_shell::open` warning 仍存在。
- `json-viewer` feature code 冲突 warning 仍存在；继续按用户要求不处理插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 98% | 98% | 本批未扩展主搜索 |
| 内置程序功能闭环 | 98% | 99% | 设置页黑名单、持久化和热键唤醒拦截形成闭环 |
| 设置项真实功能 | 72% | 76% | `唤醒黑名单` 从占位变成真实可保存、可执行的主程序行为 |
| Agent/MCP 底座 | 77% | 77% | 本批未扩展 Agent/MCP |
| 测试与发布 | 93% | 94% | 新增 Rust/前端脚本测试，并完成真实 Tauri smoke 和设置页交互 smoke |

当前重点剩余：

1. 搜索索引性能基准：本地应用、历史、别名、网页快开等多源合并在大结果量下的耗时。
2. 设置页继续向 ZTools 对齐：自动粘贴需要剪贴板变更时间链路，超级面板/悬浮球/代理仍需真实实现或明确能力边界。
3. 插件 feature code 冲突、插件市场和 bridge 兼容继续暂后。

## 第二十八批：自动粘贴搜索框真实功能

用户要求：继续还原完成度，插件不着急，优先完善内置程序体验。本批把设置页里禁用的 `自动粘贴搜索框` 变成真实设置，并在桌面端主搜索接入剪贴板变更时间窗口。

状态：DONE。

修改文件：

- `src/lib/searchBehavior.ts`
- `scripts/test-search-behavior.mjs`
- `src/components/SettingsPanel.svelte`
- `src/App.svelte`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增自动粘贴纯逻辑：
  - `autoPasteDelayMs()`
  - `autoPasteQueryCandidate()`
- 自动粘贴保护条件：
  - `off` 不启用。
  - 超出设置时间窗口不粘贴。
  - 搜索框已有用户输入时不覆盖。
  - 与上次自动粘贴文本相同则不重复粘贴。
  - 空白剪贴板不粘贴。
- 设置页：
  - `自动粘贴搜索框` 下拉框解除禁用。
  - 保存真实 `autoPaste` 设置，不再强制写成 `off`。
  - 加 `aria-label="自动粘贴搜索框"`，方便键盘辅助和 Browser 验证。
- 主搜索：
  - Tauri 桌面端启动后轮询剪贴板文本。
  - 首次读取只建立 baseline，不把旧剪贴板当成刚复制内容。
  - 剪贴板文本变化后记录 `lastClipboardChangedAt`。
  - 当当前处于首页、无插件、搜索框为空、且在设置时间窗口内时自动填入搜索框并触发现有搜索流程。
  - Web 预览不读取系统剪贴板。

TDD 记录：

- 先新增失败测试：
  - `autoPasteDelayMs("3s")`
  - `autoPasteQueryCandidate()` 时间窗口命中。
  - 过期、已有输入、重复文本不粘贴。
- 初次运行 `pnpm test:search-behavior` 失败，原因是 `autoPasteDelayMs` 不存在。
- 实现 helper 后目标测试转绿，再接设置页和主搜索。

验证：

```bash
cargo fmt --check
cargo test -p atools --lib
cargo test -p atools --test agent_tools_tests
cargo test -p atools-core --lib
pnpm check
pnpm build
pnpm test:search-behavior
pnpm test:wakeup-blacklist
pnpm smoke:tauri-desktop
```

结果：

- `cargo fmt --check`：通过。
- `cargo test -p atools --lib`：28 passed。
- `cargo test -p atools --test agent_tools_tests`：18 passed。
- `cargo test -p atools-core --lib`：32 passed。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，162 modules transformed。
- `pnpm test:search-behavior`：通过。
- `pnpm test:wakeup-blacklist`：通过。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，`local_app_search.query="com apple terminal"`，`result_count=1`，`icon_count=1`。
- Browser in-app smoke：
  - 打开 `http://127.0.0.1:1420/?parity=1&autoPasteSmoke=1`。
  - 页面身份正确，标题 `ATools 3.0`，首屏非空，控制台 0 error / 0 warning。
  - 进入设置页后，`自动粘贴搜索框` 下拉框存在且可用。
  - 选择 `1秒内` 后 DOM 中 select value 为 `1s`。
  - 截图：`/tmp/atools-auto-paste-setting-behavior.png`。

真实 Tauri smoke 残留：

- `crates/atools-api-shim/src/handler_wrapper.rs` unused import warning 仍存在。
- `src-tauri/src/commands.rs` deprecated `tauri_plugin_shell::open` warning 仍存在。
- `json-viewer` feature code 冲突 warning 仍存在；继续按用户要求不处理插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 98% | 98% | 本批未扩展搜索匹配，但自动粘贴会触发现有搜索流程 |
| 内置程序功能闭环 | 99% | 99% | 剪贴板变更、设置页、主搜索查询形成闭环；整体仍保留发布级工作 |
| 设置项真实功能 | 76% | 80% | `自动粘贴搜索框` 从禁用占位变成真实可保存和可执行行为 |
| Agent/MCP 底座 | 77% | 77% | 本批未扩展 Agent/MCP |
| 测试与发布 | 94% | 95% | 增加自动粘贴逻辑测试，并完成 Browser 设置交互、构建和真实 Tauri smoke |

当前重点剩余：

1. 搜索索引性能基准：本地应用、历史、别名、网页快开等多源合并在大结果量下的耗时。
2. 设置页继续向 ZTools 对齐：超级面板/悬浮球/代理若要真正启用仍需单独实现，目前已明确能力边界。
3. 插件 feature code 冲突、插件市场和 bridge 兼容继续暂后。

## 第二十九批：发布 smoke 可修复 warning 清理

用户要求：插件不着急，先继续完善内置程序体验。本批处理真实 Tauri desktop smoke 中和内置程序/发布质量直接相关的 warning，不进入插件兼容工作。

状态：DONE。

修改文件：

- `crates/atools-api-shim/src/handler_wrapper.rs`
- `src-tauri/Cargo.toml`
- `src-tauri/src/lib.rs`
- `src-tauri/src/commands.rs`
- `Cargo.lock`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 移除 `atools-api-shim` 的 unused `Arc` import，清掉 Rust 编译 warning。
- 新增 `tauri-plugin-opener`，并在 Tauri builder 注册。
- 将 `shell_open` 从 deprecated `tauri_plugin_shell::ShellExt::open` 迁移到 opener：
  - 带 URL scheme 的目标走 `open_url`。
  - 本地 `.app`、文件、目录、相对路径走 `open_path`。
  - 保留现有前端/插件 shell 插件依赖，不破坏已有 `@tauri-apps/plugin-shell` 用法。

TDD 记录：

- 先新增失败测试：
  - `shell_open_target_detects_urls`
  - `shell_open_target_detects_local_paths`
  - `shell_open_target_trims_input`
- 初次运行 `cargo test -p atools --lib shell_open_target` 失败，原因是 `shell_open_target` / `ShellOpenTarget` 尚不存在。
- 实现目标判定和 opener 迁移后，目标测试转绿。

验证：

```bash
cargo fmt --check
cargo test -p atools --lib shell_open_target
cargo test -p atools --lib
cargo test -p atools --test agent_tools_tests
cargo test -p atools-core --lib
pnpm check
pnpm build
pnpm test:search-behavior
pnpm test:wakeup-blacklist
pnpm smoke:tauri-desktop
```

结果：

- `cargo fmt --check`：通过。
- `cargo test -p atools --lib shell_open_target`：3 passed。
- `cargo test -p atools --lib`：31 passed。
- `cargo test -p atools --test agent_tools_tests`：18 passed。
- `cargo test -p atools-core --lib`：32 passed。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，162 modules transformed。
- `pnpm test:search-behavior`：通过。
- `pnpm test:wakeup-blacklist`：通过。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，`local_app_search.query="com apple terminal"`，`result_count=1`，`icon_count=1`。

真实 Tauri smoke 残留：

- `atools-api-shim` unused import warning 已清理。
- `tauri_plugin_shell::open` deprecated warning 已清理。
- `json-viewer` feature code 冲突 warning 仍存在；这是插件内置加载/索引问题，继续按用户要求暂缓插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Tauri/Rust 桌面底座 | 87% | 88% | 内置打开能力迁移到 Tauri opener，URL/路径分流更贴近真实桌面行为 |
| ZTools/uTools 主搜索体验 | 98% | 98% | 本批未扩展搜索体验 |
| 内置程序功能闭环 | 99% | 99% | 本批是发布质量收口，内置功能闭环保持 |
| 设置项真实功能 | 80% | 80% | 本批未扩展设置页 |
| Agent/MCP 底座 | 77% | 77% | 本批未扩展 Agent/MCP |
| 测试与发布 | 95% | 96% | 可修复编译 warning 清理完成，真实 Tauri desktop smoke 只剩插件方向 warning |

当前重点剩余：

1. 搜索索引性能基准：本地应用、历史、别名、网页快开等多源合并在大结果量下的耗时。
2. 设置页继续向 ZTools 对齐：超级面板/悬浮球/代理仍需真实实现或明确能力边界。
3. 插件 feature code 冲突、插件市场和 bridge 兼容继续暂后。

## 第三十批：未实现设置能力边界归一化

用户要求：插件不着急，先继续完善内置程序体验。本批收口设置页里超级面板、悬浮球、代理、插件市场自定义、DevTools 位置、GPU 启动参数、窗口材质、固定栏行数等未实现项的能力边界，避免旧 localStorage/DB 数据把它们带入运行态造成“假启用”。

状态：DONE。

修改文件：

- `src/lib/settings.ts`
- `scripts/test-settings-normalization.mjs`
- `package.json`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `normalizeSettings()` 现在会固定归一化未实现能力：
  - `superPanelEnabled=false`
  - `floatingBallEnabled=false`
  - `proxyEnabled=false`
  - `pluginMarketCustom=false`
  - `disableGpuAcceleration=false`
  - `devToolsMode=DEFAULT_ATOOLS_SETTINGS.devToolsMode`
  - `windowMaterial=DEFAULT_ATOOLS_SETTINGS.windowMaterial`
  - `pinnedRows=DEFAULT_ATOOLS_SETTINGS.pinnedRows`
- 这样旧版本、本地调试或手动写入的设置数据不会让主程序进入未实现状态。
- 设置页 UI 保持明确禁用态和“尚未实现/暂不启用”说明，避免用户以为这些开关已经生效。

TDD 记录：

- 先新增失败测试 `scripts/test-settings-normalization.mjs`。
- 初次运行 `pnpm test:settings-normalization` 失败，原因是 `superPanelEnabled: true` 被 `normalizeSettings()` 原样保留。
- 实现归一化兜底后，目标测试转绿。

验证：

```bash
pnpm test:settings-normalization
pnpm test:search-behavior
pnpm test:wakeup-blacklist
pnpm check
pnpm build
cargo fmt --check
cargo test -p atools --lib
cargo test -p atools --test agent_tools_tests
cargo test -p atools-core --lib
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:settings-normalization`：通过。
- `pnpm test:search-behavior`：通过。
- `pnpm test:wakeup-blacklist`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，162 modules transformed。
- `cargo fmt --check`：通过。
- `cargo test -p atools --lib`：31 passed。
- `cargo test -p atools --test agent_tools_tests`：18 passed。
- `cargo test -p atools-core --lib`：32 passed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，`local_app_search.query="com apple terminal"`，`result_count=1`，`icon_count=1`。
- Browser in-app smoke：
  - 打开 `http://127.0.0.1:1420/?parity=1&unsupportedSettingsSmoke=1`。
  - 进入设置页后，`启用超级面板`、`显示悬浮球`、`网络代理`、`自定义插件市场`、`关闭 GPU 加速` 均存在、disabled、unchecked。
  - 对应文案分别显示“尚未实现/暂不启用”或“尚未接入/暂不启用”。

真实 Tauri smoke 残留：

- `json-viewer` feature code 冲突 warning 仍存在；这是插件内置加载/索引问题，继续按用户要求暂缓插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 86% | 87% | 未实现设置项继续保留 ZTools 风格展示，但明确 disabled 和暂不启用说明 |
| 设置项真实功能 | 80% | 82% | 未实现能力在数据层强制归一化为未启用，不会从旧数据假生效 |
| Tauri/Rust 桌面底座 | 88% | 88% | 本批未改 Rust 底座 |
| 测试与发布 | 96% | 96% | 新增设置归一化脚本测试，并完成 Browser、构建、Rust 和真实桌面 smoke |

当前重点剩余：

1. 若要真正启用超级面板/悬浮球/代理/DevTools 位置/GPU 参数，需要分别立项接原生窗口、网络层或启动参数；当前首版不再暴露假启用。
2. macOS 发布质量：签名、公证、自动更新仍未完成；基础 crash log 已完成，当时 UI 导出未完成，已在第三十三批补齐。
3. 插件 feature code 冲突、插件市场和 bridge 兼容继续暂后。

## 第三十一批：搜索索引性能 benchmark

用户要求：插件不着急，继续还原内置程序完成度。本批补上主搜索性能基线，覆盖前端多源搜索和 Rust feature matcher，避免搜索体验接近完成后缺少可重复的性能证据。

状态：DONE。

修改文件：

- `scripts/benchmark-search-index.mjs`
- `scripts/test-search-benchmark-script.mjs`
- `package.json`
- `crates/atools-core/tests/matcher_performance_tests.rs`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 `pnpm benchmark:search`：
  - 生成 2000 条别名、2000 条本地启动、2000 条网页快开合成数据。
  - 调用现有 `commandAliasResultsForQuery()`、`localLaunchResultsForQuery()`、`webQuickOpenResultsForQuery()` 和 `searchMatch`，不复制匹配逻辑。
  - 覆盖 `alias_exact`、`local_launch_path_contains`、`web_quick_open_prefix`、`aggregate_keyword`、`aggregate_no_match` 五类查询。
  - 输出机器可解析的 `ATOOLS_SEARCH_BENCHMARK {...}` JSON，包含 dataset 规模、case 耗时、最大耗时和阈值。
- 新增 `pnpm test:search-benchmark`：
  - 验证 benchmark 输出解析。
  - 用小规模 fixture 调用真实 benchmark，断言 datasets、cases、summary 和 duration 字段。
- 新增 Rust matcher 性能回归：
  - `search_all_large_feature_set_stays_within_interactive_budget`
  - 5000 个 feature 下查询 `cmd4999`，断言命中正确 feature 且在 500ms 宽松交互预算内。

TDD 记录：

- 先新增失败测试 `scripts/test-search-benchmark-script.mjs`。
- 初次运行 `pnpm test:search-benchmark` 失败，原因是 `scripts/benchmark-search-index.mjs` 不存在。
- 实现 benchmark 脚本后，目标测试转绿。

验证：

```bash
pnpm test:search-benchmark
pnpm benchmark:search
pnpm test:settings-normalization
pnpm test:search-behavior
pnpm test:wakeup-blacklist
pnpm check
pnpm build
cargo fmt --check
cargo test -p atools --lib
cargo test -p atools-core --lib
cargo test -p atools --test agent_tools_tests
cargo test -p atools-core --test matcher_performance_tests
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:search-benchmark`：通过。
- `pnpm benchmark:search`：通过，`status="ok"`，默认规模 `aliases=2000`、`local_launch=2000`、`web_quick_open=2000`，5 个 case，最近一次 `max_duration_ms=29.658`，低于 `threshold_ms=80`。
- `pnpm test:settings-normalization`：通过。
- `pnpm test:search-behavior`：通过。
- `pnpm test:wakeup-blacklist`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，162 modules transformed。
- `cargo fmt --check`：通过。
- `cargo test -p atools --lib`：31 passed。
- `cargo test -p atools-core --lib`：32 passed。
- `cargo test -p atools --test agent_tools_tests`：18 passed。
- `cargo test -p atools-core --test matcher_performance_tests`：1 passed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，`local_app_search.query="com apple terminal"`，`result_count=1`，`icon_count=1`。

真实 Tauri smoke 残留：

- `json-viewer` feature code 冲突 warning 仍存在；这是插件内置加载/索引问题，继续按用户要求暂缓插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 98% | 99% | 主搜索关键来源已有可重复 benchmark，默认 6000 条前端搜索源 max 约 30ms |
| 测试与发布 | 96% | 97% | 增加 benchmark 脚本、输出解析测试和 Rust matcher 性能回归测试 |
| Tauri/Rust 桌面底座 | 88% | 88% | 本批未改桌面底座 |
| 设置项真实功能 | 82% | 82% | 本批未扩展设置页 |

当前重点剩余：

1. macOS 发布质量：签名、公证、自动更新；基础 crash log 已完成，当时 UI 导出未完成，已在第三十三批补齐。
2. 若要真正启用超级面板/悬浮球/代理/DevTools 位置/GPU 参数，需要分别立项接原生窗口、网络层或启动参数；当前首版不再暴露假启用。
3. 插件 feature code 冲突、插件市场和 bridge 兼容继续暂后。

## 第三十二批：macOS release readiness 与基础 crash log

用户要求：插件不着急，继续还原内置程序完成度。本批推进 macOS 发布质量，把签名、公证、自动更新、崩溃恢复从文档缺口变成可脚本化检查项，并先完成基础 panic crash log。

状态：DONE。

修改文件：

- `scripts/check-macos-release-readiness.mjs`
- `scripts/test-macos-release-readiness.mjs`
- `package.json`
- `src-tauri/src/crash.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/tests/crash_tests.rs`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 `pnpm release:check:macos`：
  - 输出机器可解析的 `ATOOLS_MACOS_RELEASE_READINESS {...}` JSON。
  - 检查 `bundle.active`、bundle targets、`minimumSystemVersion`、签名 identity、entitlements、公证凭证、updater 配置、macOS smoke checklist、crash recovery。
  - 当前仓库输出 `status="warn"`、`ok=5`、`warn=4`、`error=0`。
  - 当前 WARN 是真实待办：`signing-identity`、`entitlements`、`notarization-credentials`、`updater-config`。
- 新增 `pnpm test:macos-release-readiness`：
  - 验证 readiness 输出解析。
  - 验证不完整配置输出 warn 而不是假通过。
  - 验证完整 fixture 输出 ok。
  - 验证当前仓库能识别 panic hook。
- 新增 Rust crash 模块：
  - `crash_log_path()` 固定写入 app base dir 下的 `crashes.log`。
  - `format_panic_log_entry()` 记录 timestamp、panic payload 和源码位置。
  - `install_panic_hook()` 在 app 启动时安装 panic hook，panic 时追加写入 `~/.atools/crashes.log`，再调用原 panic hook。
- 更新 `docs/macos-smoke-checklist.md`：
  - 增加 `pnpm release:check:macos`。
  - 更新已知 warning，不再保留已清理的 deprecated shell warning。
  - 明确 crash log 已写入本地，UI 查看和导出仍未完成。

TDD 记录：

- 先新增失败测试 `scripts/test-macos-release-readiness.mjs`。
- 初次运行 `pnpm test:macos-release-readiness` 失败，原因是 `scripts/check-macos-release-readiness.mjs` 不存在。
- 实现 readiness 脚本后目标测试转绿。
- 先新增失败测试 `src-tauri/tests/crash_tests.rs`。
- 初次运行 `cargo test -p atools --test crash_tests` 失败，原因是 `atools_lib::crash` 模块不存在。
- 实现 crash 模块和 panic hook 后目标测试转绿。
- readiness 最初只扫描 `lib.rs`，无法识别 `crash.rs` 中的 panic hook；补充当前仓库检测测试后红灯，再改为扫描 `src-tauri/src/**/*.rs` 后转绿。

验证：

```bash
cargo fmt --check
cargo test -p atools --test crash_tests
pnpm test:macos-release-readiness
pnpm release:check:macos
pnpm check
pnpm build
cargo test -p atools --lib
cargo test -p atools-core --lib
cargo test -p atools --test agent_tools_tests
cargo test -p atools-core --test matcher_performance_tests
pnpm test:search-benchmark
pnpm benchmark:search
pnpm smoke:tauri-desktop
```

结果：

- `cargo fmt --check`：通过。
- `cargo test -p atools --test crash_tests`：2 passed。
- `pnpm test:macos-release-readiness`：通过。
- `pnpm release:check:macos`：通过，`status="warn"`，`ok=5`，`warn=4`，`error=0`；`crash-recovery=ok`。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，162 modules transformed。
- `cargo test -p atools --lib`：31 passed。
- `cargo test -p atools-core --lib`：32 passed。
- `cargo test -p atools --test agent_tools_tests`：18 passed。
- `cargo test -p atools-core --test matcher_performance_tests`：1 passed。
- `pnpm test:search-benchmark`：通过。
- `pnpm benchmark:search`：通过，`status="ok"`，最近一次 `max_duration_ms=17.06`，低于 `threshold_ms=80`。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，`local_app_search.query="com apple terminal"`，`result_count=1`，`icon_count=1`。

真实 Tauri smoke 残留：

- `json-viewer` feature code 冲突 warning 仍存在；这是插件内置加载/索引问题，继续按用户要求暂缓插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Tauri/Rust 桌面底座 | 88% | 89% | 新增 panic hook 和本地 crash log，崩溃后可留痕 |
| 测试与发布 | 97% | 98% | 新增 macOS release readiness 检查和测试，签名/公证/更新缺口可脚本化暴露 |
| ZTools/uTools 主搜索体验 | 99% | 99% | 本批未扩展主搜索 |
| 设置项真实功能 | 82% | 82% | 本批未扩展设置页 |

当前重点剩余：

1. macOS 发布质量：签名、公证、自动更新仍未完成。
2. crash log UI 查看/导出当时仍未完成，已在第三十三批补齐。
3. 插件 feature code 冲突、插件市场和 bridge 兼容继续暂后。

## 第三十三批：crash log 调试页查看/导出/清空

用户要求：插件不着急，先继续完善内置程序体验。本批把上一批留下的 crash log UI 缺口补齐，让崩溃日志从“只写文件”变成设置页可查看、复制和清空的本地调试能力。

状态：DONE。

修改文件：

- `src-tauri/src/crash.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/tests/crash_tests.rs`
- `src/lib/types.ts`
- `src/lib/debugDiagnostics.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-debug-diagnostics.mjs`
- `scripts/check-macos-release-readiness.mjs`
- `scripts/test-macos-release-readiness.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- Rust crash 模块新增本地日志操作：
  - `list_crash_logs()`：读取 `crashes.log`，解析 timestamp、panic message、location 和 raw line，并按时间倒序返回。
  - `export_crash_log()`：导出完整本地崩溃日志文本。
  - `clear_crash_log()`：清空本地 `crashes.log` 并返回清理条数。
- Tauri command 接入：
  - `list_crash_logs`
  - `export_crash_log`
  - `clear_crash_log`
- 设置页“调试日志”新增“崩溃日志”区块：
  - 桌面端可查看最近 crash 条目。
  - 可复制完整日志。
  - 可确认后清空本地日志。
  - 浏览器预览模式显示空状态并禁用副作用按钮。
- `copyDebugInfo()` 导出的调试信息 now includes crash log summary，排查问题时能一次复制完整上下文。
- macOS release readiness 新增 `crash-log-ui` 检查：
  - 当前仓库 `crash-recovery=ok`。
  - 当前仓库 `crash-log-ui=ok`。
  - 当时真实剩余 warning 仍是签名、公证、entitlements、自动更新；entitlements 已在第三十五批补齐。
- 更新 macOS smoke 文档：
  - `crash-log-ui` 应为 `ok`。
  - 当前限制从“UI 查看和导出未完成”改为“已支持本地查看/复制/清空，仍未做崩溃后自动重启或远程上传”。

TDD 记录：

- 先扩展 `src-tauri/tests/crash_tests.rs`，新增 `list_export_and_clear_crash_logs_use_real_file`。
- 初次运行 `cargo test -p atools --test crash_tests` 红灯，原因是 `clear_crash_log`、`export_crash_log`、`list_crash_logs` 尚未实现。
- 实现 crash 模块 API、Tauri commands 和 invoke handler 后目标测试转绿。
- 先扩展 `scripts/test-debug-diagnostics.mjs`，要求 `crashLogSummaries()` 输出标题、详情和 raw。
- 初次运行 `pnpm test:debug-diagnostics` 红灯，原因是 `crashLogSummaries` 尚未导出。
- 实现 `CrashLogEntry` 类型和 `crashLogSummaries()` 后目标测试转绿。
- 先扩展 `scripts/test-macos-release-readiness.mjs`，要求不完整 fixture 输出 `crash-log-ui=warn`，当前项目输出 `crash-log-ui=ok`。
- 接入 release readiness 源码扫描后目标测试转绿。

验证：

```bash
pnpm test:macos-release-readiness
pnpm release:check:macos
pnpm test:debug-diagnostics
cargo fmt --check
cargo test -p atools --test crash_tests
pnpm check
pnpm build
cargo test -p atools --lib
cargo test -p atools --test agent_tools_tests
cargo test -p atools-core --lib
cargo test -p atools-core --test matcher_performance_tests
pnpm test:search-benchmark
pnpm benchmark:search
pnpm smoke:tauri-desktop
Browser: 设置页 -> 调试日志 -> 崩溃日志区块可见，空状态、复制/清空按钮状态正常
```

结果：

- `pnpm test:macos-release-readiness`：通过。
- `pnpm release:check:macos`：通过，`status="warn"`，`ok=6`，`warn=4`，`error=0`；`crash-recovery=ok`，`crash-log-ui=ok`。
- `pnpm test:debug-diagnostics`：通过。
- `cargo fmt --check`：通过。
- `cargo test -p atools --test crash_tests`：3 passed。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，162 modules transformed。
- `cargo test -p atools --lib`：31 passed。
- `cargo test -p atools --test agent_tools_tests`：18 passed。
- `cargo test -p atools-core --lib`：32 passed。
- `cargo test -p atools-core --test matcher_performance_tests`：1 passed。
- `pnpm test:search-benchmark`：通过。
- `pnpm benchmark:search`：通过，`status="ok"`，默认规模 `aliases=2000`、`local_launch=2000`、`web_quick_open=2000`，5 个 case，最近一次 `max_duration_ms=19.436`，低于 `threshold_ms=80`。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，`local_app_search.query="com apple terminal"`，`result_count=1`，`icon_count=1`。
- Browser smoke：调试日志页面可打开；崩溃日志区块在设置页中可见；浏览器预览模式下“复制日志/清空”按钮禁用，空状态文案正常。

真实 Tauri smoke 残留：

- `json-viewer` feature code 冲突 warning 仍存在；这是插件内置加载/索引问题，按用户当前要求继续暂缓插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Tauri/Rust 桌面底座 | 89% | 90% | crash log 从 panic 写入扩展到可通过 Tauri command 查看、导出、清空 |
| ZTools 设置页 UI | 87% | 88% | 调试日志页新增 ZTools 设置风格的崩溃日志区块、操作按钮和空状态 |
| 设置项真实功能 | 82% | 84% | 崩溃日志查看、复制、清空从未完成变成真实桌面功能 |
| 测试与发布 | 98% | 98% | release readiness 新增 `crash-log-ui` 检查并通过；签名、公证、自动更新仍是发布前大项 |

当前重点剩余：

1. macOS 发布质量：签名、公证、自动更新仍未完成。
2. crash log 目前是本地查看/复制/清空；未做崩溃后自动重启、远程上传或符号化。
3. 内置程序体验继续优先：下一步建议补齐设置页剩余细节、确认弹窗体验、发布文档的一键配置。
4. 插件 feature code 冲突、插件市场和 bridge 兼容继续暂后。

## 第三十四批：MCP 客户端配置复制体验

用户要求：继续还原完成度，插件不着急，优先完善内置程序体验。本批聚焦 Agent/MCP 的日用接入体验，把 HTTP MCP 和 stdio proxy 配置生成从组件内硬编码抽成可测试 helper，并在 Agent 面板补充一键复制入口。

状态：DONE。

修改文件：

- `src/lib/mcpClientConfig.ts`
- `src/components/SettingsPanel.svelte`
- `src/components/AgentPanel.svelte`
- `scripts/test-mcp-client-config.mjs`
- `package.json`
- `docs/agent-mcp-client.md`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 `mcpClientConfig` helper：
  - `mcpHttpUrl()`：从当前 MCP status 生成 `http://127.0.0.1:<port>/mcp`。
  - `mcpHttpClientConfig()`：生成带 Bearer token 的 HTTP MCP JSON。
  - `mcpStdioClientConfig()`：生成 `/Applications/ATools 3.0.app/Contents/MacOS/ATools 3.0 --mcp-stdio` proxy JSON。
  - `mcpClientConfig()`：MCP 已启动时优先 HTTP，未启动或缺 token 时回退 stdio。
  - `mcpClientConfigText()`：统一 JSON 序列化输出。
- 设置页 `MCP 服务` 从组件内硬编码改为复用 helper，继续支持复制客户端配置。
- Agent/MCP 面板新增：
  - `复制 HTTP 配置`
  - `复制 stdio 配置`
  - 复制状态提示
  - MCP 地址显示为完整 HTTP endpoint。
- 更新 MCP 客户端文档：
  - 明确 Agent 面板和设置页都可以复制配置。
  - 补充 stdio proxy JSON 示例。
  - 权限重试流程改为可通过全局确认弹窗或 Agent 面板处理。
- 更新 macOS smoke：
  - 增加 Agent/MCP 与设置页配置复制检查项。
  - 修正 `search_clipboard` 旧限制说明：当前已接入本地剪贴板历史。

TDD 记录：

- 先新增 `scripts/test-mcp-client-config.mjs` 和 `pnpm test:mcp-client-config`。
- 初次运行 `pnpm test:mcp-client-config` 红灯，原因是 `src/lib/mcpClientConfig.ts` 不存在。
- 实现 helper 后目标测试转绿。

验证：

```bash
pnpm test:mcp-client-config
pnpm test:debug-diagnostics
pnpm check
pnpm build
pnpm test:tauri-desktop-smoke-script
pnpm smoke:tauri-desktop
Browser: 设置页 -> MCP 服务 -> 复制配置入口可见
```

结果：

- `pnpm test:mcp-client-config`：通过。
- `pnpm test:debug-diagnostics`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，163 modules transformed。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，`local_app_search.query="com apple terminal"`，`result_count=1`，`icon_count=1`。
- Browser smoke：设置页 `MCP 服务` 可打开；`复制配置提示`、`复制配置` 按钮、stdio fallback 文案可见。

验证限制：

- Codex in-app Browser 当前无法用输入框 `fill` 或坐标输入搜索 `mcp`，报 virtual clipboard 缺失；独立 Playwright fallback 当前 browser backend closed。因此本批未完成 Agent/MCP 面板新增按钮的浏览器点击截图验证。该部分由 `pnpm check`、`pnpm build` 和 helper 行为测试覆盖。

真实 Tauri smoke 残留：

- `json-viewer` feature code 冲突 warning 仍存在；这是插件内置加载/索引问题，按用户当前要求继续暂缓插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP 底座 | 77% | 79% | HTTP MCP、stdio proxy 的客户端配置生成和 Agent 面板复制入口补齐 |
| 设置项真实功能 | 84% | 85% | 设置页 MCP 配置复制改为可测试共享逻辑，避免组件内硬编码 |
| ZTools 设置页 UI | 88% | 88% | 本批只保持 MCP 服务页现有入口，未扩展 ZTools 视觉细节 |
| 测试与发布 | 98% | 98% | 增加 MCP 配置 helper 测试并通过真实 Tauri smoke；签名/公证/更新仍是发布前大项 |

当前重点剩余：

1. macOS 发布质量：签名、公证、自动更新仍未完成。
2. Agent/MCP：协议完整性、更多客户端模板、一键配置导入仍可继续增强。
3. 内置程序体验继续优先：设置页剩余 ZTools 细节、权限确认端到端 smoke、数据页/调试页真实桌面验证。
4. 插件 feature code 冲突、插件市场和 bridge 兼容继续暂后。

## 第三十五批：macOS entitlements 与 bundle metadata

用户要求：继续还原完成度，插件不着急，优先完善内置程序体验。本批聚焦 macOS 发布质量：把 release readiness 中可本地修复的 `entitlements` warning 消掉，并处理 Tauri build 暴露的 bundle identifier 以 `.app` 结尾 warning。

状态：DONE。

参考：

- Tauri v2 macOS bundle 文档说明 entitlements 需要在 `src-tauri` 下创建 `Entitlements.plist`，并通过 `bundle.macOS.entitlements` 配置引用。

修改文件：

- `src-tauri/Entitlements.plist`
- `src-tauri/tauri.conf.json`
- `scripts/check-macos-release-readiness.mjs`
- `scripts/test-macos-release-readiness.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 `src-tauri/Entitlements.plist`：
  - `com.apple.security.cs.allow-jit`
  - `com.apple.security.cs.allow-unsigned-executable-memory`
  - `com.apple.security.cs.disable-library-validation`
- `tauri.conf.json` 更新：
  - `bundle.macOS.entitlements="./Entitlements.plist"`
  - `identifier="dev.atools.desktop"`，避免 `.app` 结尾与 macOS app bundle 扩展冲突。
- release readiness 增强：
  - 新增 `bundle-identifier` 检查。
  - `projectFileSet()` 支持按 `tauri.conf.json` 所在目录解析 `./Entitlements.plist`，不再要求写成仓库根相对路径。
- macOS smoke 文档更新：
  - 发布前 warning 现在只剩 `signing-identity`、`notarization-credentials`、`updater-config`。
  - `bundle-identifier` 和 `entitlements` 应为 `ok`。
  - 说明本地 build 仍是 ad-hoc 签名，entitlements 会在正式签名时应用。

TDD 记录：

- 先修改 `scripts/test-macos-release-readiness.mjs`，要求当前项目 `entitlements=ok`。
- 初次运行 `pnpm test:macos-release-readiness` 红灯，实际为 `warn`。
- 添加 entitlements 文件、配置和相对路径解析后目标测试转绿。
- 再扩展同一测试，要求 `bundle-identifier` 检查存在，且当前项目为 `ok`。
- 初次运行红灯，原因是 `bundle-identifier` 检查不存在。
- 实现 `bundleIdentifierCheck()` 并更新 Tauri identifier 后目标测试转绿。

验证：

```bash
plutil -lint src-tauri/Entitlements.plist
pnpm test:macos-release-readiness
pnpm release:check:macos
pnpm check
pnpm build
cargo fmt --check
cargo test -p atools --lib
pnpm tauri build --bundles app
plutil -p "target/release/bundle/macos/ATools 3.0.app/Contents/Info.plist" | rg "CFBundleIdentifier|LSMinimumSystemVersion"
codesign -dv --verbose=4 "target/release/bundle/macos/ATools 3.0.app"
pnpm test:tauri-desktop-smoke-script
pnpm smoke:tauri-desktop
```

结果：

- `plutil -lint src-tauri/Entitlements.plist`：OK。
- `pnpm test:macos-release-readiness`：通过。
- `pnpm release:check:macos`：通过，`status="warn"`，`ok=8`，`warn=3`，`error=0`；`bundle-identifier=ok`，`entitlements=ok`。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，163 modules transformed。
- `cargo fmt --check`：通过。
- `cargo test -p atools --lib`：31 passed。
- `pnpm tauri build --bundles app`：通过，生成 `/Users/harris/Desktop/atools/target/release/bundle/macos/ATools 3.0.app`；重新运行后不再出现 identifier 以 `.app` 结尾的 Tauri warning。
- 生成 app 的 `Info.plist`：`CFBundleIdentifier=dev.atools.desktop`，`LSMinimumSystemVersion=10.15`。
- `codesign -dv --verbose=4`：当前本地 build 为 ad-hoc 签名，`TeamIdentifier=not set`；正式签名仍需 Developer ID identity。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，`local_app_search.query="com apple terminal"`，`result_count=1`，`icon_count=1`。

真实 Tauri smoke 残留：

- `json-viewer` feature code 冲突 warning 仍存在；这是插件内置加载/索引问题，按用户当前要求继续暂缓插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Tauri/Rust 桌面底座 | 90% | 91% | macOS bundle identifier 和 entitlements 配置已纳入 Tauri bundle |
| 测试与发布 | 98% | 99% | readiness 从 `ok=6/warn=4` 推进到 `ok=8/warn=3`，并通过真实 `.app` bundle build |
| ZTools 设置页 UI | 88% | 88% | 本批未扩展设置页 |
| 设置项真实功能 | 85% | 85% | 本批未扩展设置功能 |

当前重点剩余：

1. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。
2. 本地 `.app` build 目前是 ad-hoc 签名；正式分发仍需要 Developer ID、notarytool 凭证和 updater 公钥/endpoint。
3. 内置程序体验继续优先：设置页剩余 ZTools 细节、权限确认端到端 smoke、数据页/调试页真实桌面验证。
4. 插件 feature code 冲突、插件市场和 bridge 兼容继续暂后。

## 第三十六批：真实 Tauri 权限确认链路 desktop smoke

用户要求：插件不着急，先继续完善内置程序体验。本批聚焦 Agent/MCP 权限链路的真实桌面验证，把“保守确认模式下会创建 pending request、写入 denied audit、并可清理 smoke 数据”纳入 `pnpm smoke:tauri-desktop`。

状态：DONE。

修改文件：

- `crates/atools-core/src/db.rs`
- `src-tauri/src/desktop_smoke.rs`
- `scripts/smoke-tauri-desktop.mjs`
- `scripts/test-tauri-desktop-smoke-script.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `DesktopSmokeSnapshot` 新增 `permission_smoke` 字段，桌面 smoke 的 `status="ok"` 现在要求权限链路也通过。
- `pnpm smoke:tauri-desktop` 在真实 Tauri app 启动后：
  - 临时切到 `conservative` 权限模式。
  - 使用唯一 smoke client 调用 `find_local_files` dry-run 参数。
  - 验证工具调用被权限拦截并返回 `permission_required=true`。
  - 验证 `pending_agent_requests` 中确实创建了 request。
  - 验证 dismiss 后 pending request 被移除。
  - 验证 DB 中写入 `Denied` 审计。
  - 删除该 smoke client 的审计记录，避免污染用户数据。
  - 还原原有 `agent.permission_mode` 设置。
- 新增 `Database::delete_audit_entries_for_client()`，只清理指定 client 的审计记录。
- smoke 输出解析脚本强制要求 `permission_smoke` 完整字段，避免后续回归时误判通过。
- macOS smoke 文档补充自动化权限链路检查项。

TDD 记录：

- 先扩展 `scripts/test-tauri-desktop-smoke-script.mjs`，要求 fixture 中包含 `permission_smoke`，并增加缺失该字段时必须抛错的断言。
- 初次运行 `pnpm test:tauri-desktop-smoke-script` 红灯，原因是 `parseSmokeOutput()` 尚未校验 `permission_smoke`。
- 实现 `validateSmokeSnapshot()` 的 `permission_smoke` 必填字段校验后目标测试转绿。
- 再补 `crates/atools-core/src/db.rs` 单测 `test_delete_audit_entries_for_client_only_removes_matching_client`，验证 smoke cleanup 不会误删其他 client 的审计记录。

验证：

```bash
cargo fmt --check
cargo test -p atools-core --lib
cargo test -p atools --lib desktop_smoke
cargo test -p atools --lib
pnpm test:tauri-desktop-smoke-script
pnpm check
pnpm build
pnpm smoke:tauri-desktop
pnpm release:check:macos
```

结果：

- `cargo fmt --check`：通过。
- `cargo test -p atools-core --lib`：33 passed。
- `cargo test -p atools --lib desktop_smoke`：4 passed。
- `cargo test -p atools --lib`：31 passed。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，163 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`permission_smoke.permission_required=true`、`pending_request_created=true`、`audit_denied_recorded=true`、`pending_request_dismissed=true`、`cleanup_deleted_audits=1`。
- `pnpm release:check:macos`：通过，`status="warn"`，`ok=8`，`warn=3`，`error=0`。

真实 Tauri smoke 残留：

- `json-viewer` feature code 冲突 warning 仍存在；这是插件内置加载/索引问题，按用户当前要求继续暂缓插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP 底座 | 79% | 81% | 真实 Tauri app 中已自动验证保守确认、pending request 和 denied audit 链路 |
| 权限与审计 | 78% | 80% | smoke 审计写入与按 client 清理已纳入自动化，避免污染用户本地数据 |
| 测试与发布 | 99% | 99% | desktop smoke 覆盖权限链路；剩余发布缺口仍是签名、公证、自动更新 |
| Tauri/Rust 桌面底座 | 91% | 91% | 本批增强桌面 smoke，不扩展底座功能 |

当前重点剩余：

1. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。
2. Agent/MCP：继续补 MCP 协议完整性、更多客户端配置模板、插件 tools 暴露策略；插件方向按当前要求暂缓。
3. 权限与审计：继续增强 scope 细分、dry-run 预览、审计回放/路径副作用展示。
4. 内置程序体验：继续打磨设置页 ZTools 细节、数据页/调试页真实桌面验证、热键/托盘/自启人工 smoke。

## 第三十七批：数据页与调试页真实桌面 smoke

用户要求：插件不着急，先继续完善内置程序体验。本批聚焦设置页“我的数据 / 调试日志”背后的真实桌面命令链路，把运行诊断、剪贴板历史导出、审计导出和崩溃日志读取纳入 `pnpm smoke:tauri-desktop`。

状态：DONE。

修改文件：

- `src-tauri/src/desktop_smoke.rs`
- `scripts/smoke-tauri-desktop.mjs`
- `scripts/test-tauri-desktop-smoke-script.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `DesktopSmokeSnapshot` 新增 `data_debug_smoke` 字段，桌面 smoke 的 `status="ok"` 现在要求数据/调试链路也通过。
- `pnpm smoke:tauri-desktop` 在真实 Tauri app 启动后只读验证：
  - `runtime_diagnostics_snapshot()` 可生成运行诊断，且 runtime、路径和 Agent 工具数量有效。
  - `export_clipboard_history_json()` 输出可解析 JSON，`entries` 为数组。
  - `export_audit_entries_jsonl()` 输出可逐行解析为 JSON；空审计也视为合法。
  - `list_crash_logs()` 可读取崩溃日志；日志不存在时返回空列表，不报错。
  - 运行诊断中的 MCP enabled/bind 与主进程 MCP 状态一致。
- smoke 输出解析脚本强制要求 `data_debug_smoke` 完整字段，避免后续真实桌面 smoke 漏掉数据/调试页能力。
- macOS smoke 文档补充 `data_debug_smoke` 期望输出，并明确该 smoke 不清空或改写用户真实数据。

TDD 记录：

- 先扩展 `scripts/test-tauri-desktop-smoke-script.mjs`，要求 fixture 中包含 `data_debug_smoke`，并增加缺失该字段时必须抛错的断言。
- 初次运行 `pnpm test:tauri-desktop-smoke-script` 红灯，原因是 `parseSmokeOutput()` 尚未校验 `data_debug_smoke`。
- 实现 `validateSmokeSnapshot()` 的 `data_debug_smoke` 必填字段校验后目标测试转绿。
- 再扩展 `src-tauri/src/desktop_smoke.rs` 单测，要求 `DesktopSmokeSnapshot` 暴露并校验 `data_debug_smoke`。
- 初次运行 `cargo test -p atools --lib desktop_smoke` 红灯，原因是 `DataDebugSmokeSummary` 尚未实现，snapshot 也没有该字段。
- 实现 `DataDebugSmokeSummary` 和 `run_data_debug_smoke()` 后目标测试转绿。

验证：

```bash
cargo fmt --check
cargo test -p atools --lib desktop_smoke
pnpm test:tauri-desktop-smoke-script
pnpm smoke:tauri-desktop
cargo test -p atools --lib
pnpm check
pnpm build
```

结果：

- `cargo fmt --check`：通过。
- `cargo test -p atools --lib desktop_smoke`：4 passed。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm smoke:tauri-desktop`：通过，`data_debug_smoke.runtime_diagnostics_ready=true`、`clipboard_export_json_valid=true`、`audit_export_jsonl_valid=true`、`crash_log_readable=true`、`mcp_status_consistent=true`。
- `cargo test -p atools --lib`：31 passed。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，163 modules transformed。

真实 Tauri smoke 残留：

- `json-viewer` feature code 冲突 warning 仍存在；这是插件内置加载/索引问题，按用户当前要求继续暂缓插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Tauri/Rust 桌面底座 | 91% | 92% | 真实 desktop smoke 覆盖运行诊断、数据导出和崩溃日志读取 |
| 设置项真实功能 | 85% | 86% | 我的数据/调试日志背后的只读命令链路已纳入真实桌面验证 |
| 测试与发布 | 99% | 99% | desktop smoke 覆盖更完整；剩余发布缺口仍是签名、公证、自动更新 |
| Agent/MCP 底座 | 81% | 81% | 本批只验证 MCP 状态一致性，不扩展协议 |

当前重点剩余：

1. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。
2. 内置程序体验：继续打磨设置页 ZTools 细节，重点转向热键/托盘/自启专项 smoke 和快捷键冲突提示。
3. 权限与审计：继续增强 scope 细分、dry-run 预览、审计回放/路径副作用展示。
4. Agent/MCP：继续补 MCP 协议完整性、更多客户端配置模板、插件 tools 暴露策略；插件方向按当前要求暂缓。

## 第三十八批：系统设置真实桌面 smoke

用户要求：插件不着急，先继续完善内置程序体验。本批聚焦设置页“快捷键 / 托盘 / 开机自启”的 macOS 首版验收，把系统设置链路纳入 `pnpm smoke:tauri-desktop`，并确保 smoke 不持久改写用户配置。

状态：DONE。

修改文件：

- `src-tauri/src/desktop_smoke.rs`
- `src-tauri/src/commands.rs`
- `scripts/smoke-tauri-desktop.mjs`
- `scripts/test-tauri-desktop-smoke-script.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `DesktopSmokeSnapshot` 新增 `system_settings_smoke` 字段，桌面 smoke 的 `status="ok"` 现在要求系统设置链路也通过。
- `pnpm smoke:tauri-desktop` 在真实 Tauri app 启动后验证：
  - `hotkey_reregistered`：重新注册当前已配置全局快捷键，验证热键命令链路可用。
  - `tray_visibility_applied`：按当前设置重放托盘可见性，验证托盘命令链路可用。
  - `launch_agent_plist_valid`：使用当前可执行路径 dry-run 生成 LaunchAgent plist，验证 label、RunAtLoad 和可执行路径转义。
  - `settings_preserved`：比较 `settings-general` 前后值，确保 smoke 不持久改写用户设置。
- `commands::launch_agent_plist()` 改为 `pub(crate)`，供桌面 smoke 复用真实 plist 生成逻辑。
- smoke 输出解析脚本强制要求 `system_settings_smoke` 完整字段，避免后续真实桌面 smoke 漏掉系统设置链路。
- macOS smoke 文档补充 `system_settings_smoke` 期望输出，并明确该 smoke 不写真实 LaunchAgent。

TDD 记录：

- 先扩展 `scripts/test-tauri-desktop-smoke-script.mjs`，要求 fixture 中包含 `system_settings_smoke`，并增加缺失该字段时必须抛错的断言。
- 初次运行 `pnpm test:tauri-desktop-smoke-script` 红灯，原因是 `parseSmokeOutput()` 尚未校验 `system_settings_smoke`。
- 实现 `validateSmokeSnapshot()` 的 `system_settings_smoke` 必填字段校验后目标测试转绿。
- 再扩展 `src-tauri/src/desktop_smoke.rs` 单测，要求 `DesktopSmokeSnapshot` 暴露并校验 `system_settings_smoke`。
- 初次运行 `cargo test -p atools --lib desktop_smoke` 红灯，原因是 `SystemSettingsSmokeSummary` 尚未实现，snapshot 也没有该字段。
- 实现 `SystemSettingsSmokeSummary` 和 `run_system_settings_smoke()` 后目标测试转绿。

验证：

```bash
cargo fmt --check
cargo test -p atools --lib desktop_smoke
pnpm test:tauri-desktop-smoke-script
pnpm smoke:tauri-desktop
cargo test -p atools --lib
pnpm check
pnpm build
pnpm release:check:macos
```

结果：

- `cargo fmt --check`：通过。
- `cargo test -p atools --lib desktop_smoke`：4 passed。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm smoke:tauri-desktop`：通过，`system_settings_smoke.hotkey_reregistered=true`、`tray_visibility_applied=true`、`launch_agent_plist_valid=true`、`settings_preserved=true`。
- `cargo test -p atools --lib`：31 passed。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，163 modules transformed。
- `pnpm release:check:macos`：通过，`status="warn"`，`ok=8`，`warn=3`，`error=0`。

真实 Tauri smoke 残留：

- `json-viewer` feature code 冲突 warning 仍存在；这是插件内置加载/索引问题，按用户当前要求继续暂缓插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Tauri/Rust 桌面底座 | 92% | 93% | 真实 desktop smoke 覆盖热键重新注册、托盘可见性应用和自启 plist dry-run |
| 设置项真实功能 | 86% | 87% | 快捷键、托盘、开机自启生成逻辑纳入真实桌面验证，且确认不持久改写设置 |
| 测试与发布 | 99% | 99% | desktop smoke 覆盖更完整；剩余发布缺口仍是签名、公证、自动更新 |
| Agent/MCP 底座 | 81% | 81% | 本批未扩展 Agent/MCP |

当前重点剩余：

1. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。
2. 内置程序体验：继续打磨设置页 ZTools 细节和快捷键冲突提示；真实写入 LaunchAgent 的人工 smoke 仍保留在发布清单中。
3. 权限与审计：继续增强 scope 细分、dry-run 预览、审计回放/路径副作用展示。
4. Agent/MCP：继续补 MCP 协议完整性、更多客户端配置模板、插件 tools 暴露策略；插件方向按当前要求暂缓。

## 第三十九批：快捷键冲突与保存失败提示

用户要求：插件不着急，先继续完善内置程序体验。本批聚焦 ZTools 设置页里的快捷键体验：前端先拦截明显无效或常见系统保留组合，真实系统占用继续由 Tauri 注册失败返回，并在设置页显示具体失败原因。

状态：DONE。

修改文件：

- `src/lib/hotkeyRecorder.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-hotkey-recorder.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `hotkeyRecorder` 新增：
  - `validateShortcut()`：校验空值、无修饰键、无主键，以及 macOS 常见系统保留组合。
  - `shortcutStatusMessage()`：统一生成快捷键保存/冲突/失败状态文案。
- 设置页快捷键录制接入校验：
  - `Z` 这类无修饰键组合提示“快捷键需要包含至少一个修饰键”。
  - `Option` 这类纯修饰键提示“快捷键需要包含主键”。
  - `Command+Space`、`Control+Space` 等常见 macOS 系统组合提示“该组合通常被系统占用，请换一个快捷键”。
  - 明显无效或保留组合不会进入保存队列。
- native 保存失败时保留原始错误详情，例如 `Global shortcut already registered` 会显示为 `保存失败：Global shortcut already registered`。
- 设置保存顺序调整为先执行 native 设置，再写入本地设置，降低热键注册失败后把不可用快捷键持久保存的风险。
- macOS smoke 文档更新快捷键冲突/保存状态检查项。

TDD 记录：

- 先扩展 `scripts/test-hotkey-recorder.mjs`，要求 `validateShortcut()` 和 `shortcutStatusMessage()` 存在并覆盖可用、无修饰键、无主键、系统保留组合、native 失败详情。
- 初次运行 `pnpm test:hotkey-recorder` 红灯，原因是 `validateShortcut` 尚未导出。
- 实现 helper 后目标测试转绿。

验证：

```bash
pnpm test:hotkey-recorder
pnpm check
pnpm build
cargo fmt --check
cargo test -p atools --lib hotkey
cargo test -p atools --lib
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:hotkey-recorder`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，163 modules transformed。
- `cargo fmt --check`：通过。
- `cargo test -p atools --lib hotkey`：4 passed。
- `cargo test -p atools --lib`：31 passed。
- `pnpm smoke:tauri-desktop`：通过，`system_settings_smoke`、`permission_smoke`、`data_debug_smoke` 均为 true。

验证限制：

- 当前项目未安装 `playwright`，`pnpm exec playwright --version` 失败，`node import('playwright')` 也失败；本批未做自动浏览器截图。设置页行为由 helper 测试、`pnpm check`、`pnpm build` 和真实 Tauri smoke 间接覆盖。

真实 Tauri smoke 残留：

- `json-viewer` feature code 冲突 warning 仍存在；这是插件内置加载/索引问题，按用户当前要求继续暂缓插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 88% | 89% | 快捷键页新增更明确的冲突/保存失败状态文案 |
| 设置项真实功能 | 87% | 88% | 常见无效/系统保留快捷键可前端拦截，Tauri 注册失败错误可透传 |
| Tauri/Rust 桌面底座 | 93% | 93% | 本批主要是前端校验和保存顺序优化，底座不变 |
| 测试与发布 | 99% | 99% | 增加快捷键校验测试并通过真实 desktop smoke |

当前重点剩余：

1. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。
2. 内置程序体验：继续打磨设置页 ZTools 细节和空状态；可考虑补稳定 Playwright 依赖以恢复自动浏览器截图。
3. 权限与审计：继续增强 scope 细分、dry-run 预览、审计回放/路径副作用展示。
4. Agent/MCP：继续补 MCP 协议完整性、更多客户端配置模板、插件 tools 暴露策略；插件方向按当前要求暂缓。

## 第四十批：MCP 客户端模板

用户要求：继续还原完成度，插件不着急，优先完善内置程序体验和 Agent 友好性。本批聚焦 Agent/MCP 日用接入：在 Agent 面板和设置页 MCP 服务中提供可复制的客户端模板，而不是只给一个通用配置。

状态：DONE。

修改文件：

- `src/lib/mcpClientConfig.ts`
- `src/components/AgentPanel.svelte`
- `src/components/SettingsPanel.svelte`
- `scripts/test-mcp-client-config.mjs`
- `docs/agent-mcp-client.md`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `mcpClientConfig` 新增模板 helper：
  - `mcpClientTemplates()`
  - `mcpClientTemplateText()`
- 新增四个可复制模板：
  - `通用 HTTP MCP`：MCP HTTP ready 时使用 URL + Bearer token，否则回退 stdio。
  - `通用 stdio proxy`：使用已安装 app command + `--mcp-stdio`。
  - `Claude Desktop / Claude Code`：复制 Claude 兼容的 `mcpServers` JSON，默认 stdio proxy，避免用户手动同步端口/token。
  - `Cursor`：MCP HTTP ready 时使用 HTTP 配置，否则回退 stdio。
- Agent 面板 MCP 区域新增模板列表和单独复制按钮。
- 设置页 `MCP 服务` 新增“客户端模板”区块，支持同样的模板复制。
- MCP 客户端文档补充模板说明和 Claude/Cursor 兼容 JSON 示例。
- macOS smoke 清单增加 Agent 面板和设置页模板复制检查项。

TDD 记录：

- 先扩展 `scripts/test-mcp-client-config.mjs`，要求 `mcpClientTemplates()` 输出四个模板，并覆盖 HTTP ready、stdio、Claude stdio、Cursor HTTP/fallback 行为。
- 初次运行 `pnpm test:mcp-client-config` 红灯，原因是 `mcpClientTemplates` 尚未实现。
- 实现模板 helper 后目标测试转绿。

验证：

```bash
pnpm test:mcp-client-config
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:mcp-client-config`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，163 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，权限/数据/系统设置 smoke 均为 true。

验证限制：

- 本批不做客户端配置文件自动写入。不同客户端配置文件位置和导入方式差异较大，当前只提供可复制模板，避免不确定写入。
- 当前项目未安装 Playwright，未做自动浏览器截图；UI 通过 Svelte 类型检查、构建和模板 helper 测试覆盖。

真实 Tauri smoke 残留：

- `json-viewer` feature code 冲突 warning 仍存在；这是插件内置加载/索引问题，按用户当前要求继续暂缓插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP 底座 | 81% | 83% | Agent/设置页新增 Claude/Cursor/通用 HTTP/stdio 客户端模板 |
| ZTools 设置页 UI | 89% | 90% | MCP 服务页从单按钮升级为模板列表，信息更接近可日用设置页 |
| 测试与发布 | 99% | 99% | 增加 MCP 模板 helper 测试并通过真实 desktop smoke |
| 设置项真实功能 | 88% | 88% | 本批不扩展系统设置功能 |

当前重点剩余：

1. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。
2. Agent/MCP：继续补 MCP 协议完整性、客户端一键写入配置、插件 tools 暴露策略。
3. 内置程序体验：继续打磨设置页 ZTools 细节和空状态；可考虑补稳定 Playwright 依赖以恢复自动浏览器截图。
4. 权限与审计：继续增强 scope 细分、dry-run 预览、审计回放/路径副作用展示。

## 第四十一批：权限确认 dry-run / 路径 / 风险预览

用户要求：插件不着急，先继续完善内置程序体验。本批聚焦 Agent 调用产生本地副作用前的确认体验，让用户在弹窗里直接看懂执行模式、涉及路径和风险等级。

状态：DONE。

修改文件：

- `src/lib/permissionPreview.ts`
- `src/components/PermissionConfirmDialog.svelte`
- `scripts/test-permission-preview.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 `permissionRequestPreview()` helper，统一从 pending request 中提取：
  - scope 中文标签。
  - `dry_run` / `dryRun` / `preview` 执行模式。
  - 本地路径列表，覆盖 `path`、`files`、`source`、`target`、`inputPath`、`outputPath` 等常见参数。
  - low / medium / high 风险等级。
  - dry-run、文件写入、shell、系统设置、路径副作用等风险提示。
- 权限确认弹窗新增“执行模式”行：
  - dry-run 调用显示 `dry-run 预览`。
  - 非 dry-run 调用显示 `可能执行`。
- 权限确认弹窗新增“涉及路径”区域，文件类工具会直接列出待读取/写入路径。
- 风险提示按等级区分样式，`shell`、`system_settings`、`screenshot` 为高风险，`file_write`、`clipboard_write`、`network` 为中风险。
- macOS smoke checklist 增加权限弹窗人工检查项，避免只验证 pending/audit 而漏掉确认 UI 本身。

TDD 记录：

- 先新增 `scripts/test-permission-preview.mjs`，覆盖：
  - `rename_files` dry-run 批量重命名时识别 4 个源/目标路径、`dryRun=true`、中风险和文件修改提示。
  - `open_or_reveal_path` 带 `shell` scope 时识别本地路径和高风险执行命令提示。
  - `search_clipboard` 只读剪贴板时保持低风险并提示审计记录。
- 初次运行 `node scripts/test-permission-preview.mjs` 红灯，原因是 `src/lib/permissionPreview.ts` 尚不存在。
- 实现 helper 并接入 `PermissionConfirmDialog.svelte` 后目标测试转绿。

验证：

```bash
pnpm test:permission-preview
pnpm test:audit-view
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 使用 browser automation 打开 `http://127.0.0.1:1420/?parity=1`。
- 页面标题为 `ATools 3.0`。
- console errors 为 0。

结果：

- `pnpm test:permission-preview`：通过。
- `pnpm test:audit-view`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，164 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，权限/数据/系统设置 smoke 均为 true。

真实 Tauri smoke 残留：

- `json-viewer` feature code 冲突 warning 仍存在；这是插件内置加载/索引问题，按用户当前要求继续暂缓插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP 底座 | 83% | 84% | 权限确认弹窗现在能展示 dry-run、路径和风险预览，Agent 调用前的用户确认信息更完整 |
| 权限与审计 | 80% | 82% | pending request 进入确认 UI 后可读性增强，文件副作用和高风险 scope 不再只藏在 JSON 参数里 |
| ZTools 设置页 UI | 90% | 90% | 本批不改设置页主体 |
| 测试与发布 | 99% | 99% | 新增权限预览脚本测试，并通过真实 desktop smoke |

当前重点剩余：

1. 内置程序体验：继续打磨设置页 ZTools 细节、空状态和更细的本地数据/调试视图。
2. 权限与审计：继续补审计回放视图、副作用 diff、按 scope 更细授权和更清晰的历史筛选。
3. Agent/MCP：继续补 MCP 协议完整性、客户端一键写入配置；插件 tools 暴露按当前要求暂缓。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## 第四十二批：审计回放摘要与路径副作用视图

用户要求：插件不着急，继续完善内置程序体验。本批承接权限确认链路，把 Agent 审计详情从“能看 JSON”推进到“能回放关键步骤和本地路径副作用”。

状态：DONE。

修改文件：

- `src/lib/auditView.ts`
- `src/components/AgentPanel.svelte`
- `scripts/test-audit-view.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `auditView` 新增 `auditReplaySummary()`：
  - 识别 `allowed` / `confirmed` / `denied` / `error` 的权限结果。
  - 识别 `dry_run` / `dryRun` / `preview` 执行模式。
  - 生成“客户端请求 -> 权限结果 -> 执行模式 -> 本地副作用 -> 执行结果”的回放步骤。
  - 判断 `dry-run 预览`、`已执行`、`未执行` 和“有本地副作用/未执行本地修改/无明显副作用”。
  - 为 `rename_files`、`compress_images`、`open_or_reveal_path` 生成结构化路径副作用列表。
- `auditStatusMeta()` 补齐 Rust 真实状态：
  - `confirmed` 显示 `已确认执行`。
  - `allowed` 显示 `已允许`。
- Agent 面板审计详情新增：
  - `回放摘要` 三列：权限结果、执行模式、本地副作用。
  - 回放步骤时间线。
  - `路径副作用` 表格，显示 action、source、target、status。
  - 移动端窄屏下路径副作用改为单列，避免长路径挤压。
- macOS smoke checklist 增加审计详情人工检查项。

TDD 记录：

- 先扩展 `scripts/test-audit-view.mjs`，要求：
  - `confirmed` 的 `rename_files` 记录生成 `用户确认执行`、`已执行`、`有本地副作用` 和 `重命名` 路径变更。
  - 带 `dry_run=true` 且被拒绝的记录显示 `dry-run 预览`、`未执行本地修改`，且最后一步 tone 为 `denied`。
  - `open_or_reveal_path` 记录生成 `策略允许执行` 和 `打开或显示` 路径变更。
- 初次运行 `pnpm test:audit-view` 红灯，原因是 `auditReplaySummary` 尚未实现。
- 实现 helper 后第一次目标测试暴露状态归一化问题：带 error 的 denied 被误判为执行失败。
- 修正 `normalizedStatus()` 让显式 `denied` 优先于 error 文案后，目标测试转绿。

验证：

```bash
pnpm test:audit-view
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 使用 browser automation 打开 `http://127.0.0.1:1420/?parity=1`。
- 页面标题为 `ATools 3.0`。
- console errors 为 0。

结果：

- `pnpm test:audit-view`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，164 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，权限/数据/系统设置 smoke 均为 true。

真实 Tauri smoke 残留：

- `json-viewer` feature code 冲突 warning 仍存在；这是插件内置加载/索引问题，按用户当前要求继续暂缓插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP 底座 | 84% | 85% | 审计详情新增回放摘要和路径副作用视图，Agent 调用后的可解释性更完整 |
| 权限与审计 | 82% | 84% | 审计从 raw JSON/摘要升级为可读执行链路，confirmed/allowed/denied/error 状态更贴近真实含义 |
| ZTools 设置页 UI | 90% | 90% | 本批不改设置页主体 |
| 测试与发布 | 99% | 99% | 扩展审计视图测试并通过真实 desktop smoke |

当前重点剩余：

1. 内置程序体验：继续打磨设置页 ZTools 细节、空状态、本地数据和调试视图。
2. 权限与审计：继续补历史筛选、按 scope 更细授权、副作用 diff 和更完整的审计查询。
3. Agent/MCP：继续补 MCP 协议完整性、客户端一键写入配置；插件 tools 暴露按当前要求暂缓。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## 第四十三批：审计筛选与历史查询

用户要求：插件不着急，继续完善内置程序体验。本批聚焦 Agent 审计记录增多后的日用检索问题，让审计回放可以按关键字、状态、工具和客户端快速定位。

状态：DONE。

修改文件：

- `src/lib/auditView.ts`
- `src/components/AgentPanel.svelte`
- `scripts/test-audit-view.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `auditView` 新增审计筛选 helper：
  - `auditFilterOptions()`：生成工具列表、客户端列表和 all/success/denied/error/pending/unknown 统计。
  - `filterAuditEntries()`：按关键字、状态、工具、客户端过滤审计。
  - `auditFilterSummary()`：生成 `显示 x / y 条审计 · n 个筛选条件` 摘要。
- 关键字搜索覆盖：
  - 工具名、客户端、状态标签。
  - error 文案。
  - input/output JSON。
  - 本地路径摘要。
- 状态筛选按 UI tone 归类：
  - `allowed`、`confirmed`、`success` 等归入成功。
  - `denied` 归入拒绝。
  - `error` 或带失败状态归入失败。
- Agent 面板审计区新增：
  - 搜索框。
  - 状态、工具、客户端下拉筛选。
  - 当前匹配数量摘要。
  - 空结果提示。
  - 重置按钮，重置时同步收起当前展开详情。
- macOS smoke checklist 增加审计筛选人工检查项。

TDD 记录：

- 先扩展 `scripts/test-audit-view.mjs`，要求：
  - 四条不同客户端/工具/状态的审计记录能生成工具、客户端和状态统计。
  - `query + status + toolName + clientId` 能定位 confirmed `rename_files`。
  - 搜索 error 文案 `ocr service` 能定位 `ocr_image` 失败记录。
  - 搜索 `permission` 并筛选 denied 能定位权限拒绝记录。
  - 筛选摘要显示匹配数和筛选条件数量。
- 初次运行 `pnpm test:audit-view` 红灯，原因是 `auditFilterOptions` 尚未实现。
- 实现筛选 helper 后目标测试转绿。

验证：

```bash
pnpm test:audit-view
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 使用 browser automation 打开 `http://127.0.0.1:1420/?parity=1`。
- 页面标题为 `ATools 3.0`。
- console errors 为 0。

结果：

- `pnpm test:audit-view`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，164 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，权限/数据/系统设置 smoke 均为 true。

真实 Tauri smoke 残留：

- `json-viewer` feature code 冲突 warning 仍存在；这是插件内置加载/索引问题，按用户当前要求继续暂缓插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP 底座 | 85% | 86% | Agent 审计列表新增状态/工具/客户端/关键字筛选，长历史下更可用 |
| 权限与审计 | 84% | 86% | 审计历史从只读列表升级为可查询视图，支持 error、路径和 JSON 参数检索 |
| ZTools 设置页 UI | 90% | 90% | 本批不改设置页主体 |
| 测试与发布 | 99% | 99% | 扩展审计视图筛选测试并通过真实 desktop smoke |

当前重点剩余：

1. 内置程序体验：继续打磨设置页 ZTools 细节、空状态、本地数据和调试视图。
2. 权限与审计：继续补按 scope 更细授权、副作用 diff 和更完整的审计查询后端能力。
3. Agent/MCP：继续补 MCP 协议完整性、客户端一键写入配置；插件 tools 暴露按当前要求暂缓。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## 第四十四批：scope 级权限阻断

用户要求：插件不着急，继续完善内置程序体验。本批聚焦权限链路里“按 scope 更细授权”的缺口，让用户可以在 Agent 面板里把高风险 scope 设为硬阻断，并由 Rust 执行链路强制生效。

状态：DONE。

修改文件：

- `src-tauri/src/agent_tools.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/tests/agent_tools_tests.rs`
- `src/lib/types.ts`
- `src/components/AgentPanel.svelte`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- Rust 底座新增 `AgentScopePolicy`：
  - scope id、中文标签、说明、decision、high_risk。
  - 默认所有 scope 为 `confirm`。
  - 用户显式设置为 `deny` 时存入 `agent.scope_policy`。
- Rust 权限执行链路新增 scope 硬阻断：
  - `permission_decision_for_tool()` 在 developer 模式和按工具授权前先检查 tool scopes。
  - 只要任一 scope 被设为 `deny`，工具调用直接 `Deny`。
  - 该阻断优先级高于 developer 模式和已授权工具。
- 新增 Tauri commands：
  - `list_agent_scope_policies`
  - `set_agent_scope_policy`
- Agent 面板权限区新增 scope 策略列表：
  - 展示 scope 标签、说明、scope id。
  - 高风险 scope 显示标签。
  - 每项支持 `确认` / `阻断`。
  - 阻断项用危险背景突出。
- macOS smoke checklist 增加 scope policy 检查项。

TDD 记录：

- 先新增 `permission_policy_denies_blocked_scope_even_in_developer_mode`：
  - 设置 `agent.permission_mode=developer`。
  - 设置 `agent.scope_policy={"shell":"deny"}`。
  - 调用 `permission_decision_for_tool(..., "open_or_reveal_path")`。
  - 期望返回 `PermissionDecision::Deny`。
- 初次运行目标测试红灯，实际返回 `Allow`，证明当前 developer 模式绕过了 scope policy。
- 实现 persisted scope policy 解析和执行链路硬阻断后，目标测试转绿。

验证：

```bash
cargo fmt --check
cargo test -p atools --test agent_tools_tests permission_policy
cargo test -p atools --test agent_tools_tests
cargo test -p atools --lib agent_tools
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 使用 browser automation 打开 `http://127.0.0.1:1420/?parity=1`。
- 页面标题为 `ATools 3.0`。
- console errors 为 0。

结果：

- `cargo fmt --check`：通过。
- `cargo test -p atools --test agent_tools_tests permission_policy`：2 passed。
- `cargo test -p atools --test agent_tools_tests`：19 passed。
- `cargo test -p atools --lib agent_tools`：通过，0 failures。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，164 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，权限/数据/系统设置 smoke 均为 true。

真实 Tauri smoke 残留：

- `json-viewer` feature code 冲突 warning 仍存在；这是插件内置加载/索引问题，按用户当前要求继续暂缓插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP 底座 | 86% | 87% | Agent 权限从按工具授权扩展到 scope 级阻断，且由 Rust 执行链路强制 |
| 权限与审计 | 86% | 88% | 高风险 scope 可被用户硬阻断，developer 模式也不能绕过 |
| ZTools 设置页 UI | 90% | 90% | 本批不改设置页主体 |
| 测试与发布 | 99% | 99% | 新增 scope 阻断回归测试，并通过真实 desktop smoke |

当前重点剩余：

1. 内置程序体验：继续打磨设置页 ZTools 细节、空状态、本地数据和调试视图。
2. 权限与审计：继续补副作用 diff 和更完整的审计查询后端能力。
3. Agent/MCP：继续补 MCP 协议完整性、客户端一键写入配置；插件 tools 暴露按当前要求暂缓。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## 第四十五批：审计副作用 diff

用户要求：插件不着急，继续完善内置程序体验。本批聚焦审计回放的最后一块可读性：让用户不只看到路径副作用，还能看到一次调用计划或实际改变了什么。

状态：DONE。

修改文件：

- `src/lib/auditView.ts`
- `src/components/AgentPanel.svelte`
- `scripts/test-audit-view.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `auditView` 新增 `auditSideEffectDiff()`：
  - 生成 diff summary。
  - 生成每行 action、before、after、status、tone、detail。
  - dry-run 记录显示 `计划 n 项，未执行本地修改`。
  - confirmed/allowed 记录显示 `已执行 n 项本地副作用`。
  - denied/error 记录按状态显示拒绝或失败 tone。
- `rename_files` diff：
  - 展示 source -> target。
  - confirmed 记录展示 `用户确认执行`。
  - dry-run 记录展示 `dry-run 预览`。
- `compress_images` diff：
  - 展示 input -> output。
  - 展示 `original_size -> output_size，减少 x%`。
- Agent 面板审计详情新增 `副作用 diff` 区块：
  - 展示 summary。
  - 展示 before -> after、状态和 detail。
  - 成功、待执行、拒绝/失败使用不同左边框 tone。
  - 窄屏下自动降为单列，避免长路径挤压。
- macOS smoke checklist 增加审计 diff 人工检查项。

TDD 记录：

- 先扩展 `scripts/test-audit-view.mjs`，要求：
  - confirmed `rename_files` 生成 `已执行 1 项本地副作用`，并显示 source -> target、`renamed`、`用户确认执行`。
  - dry-run + denied `rename_files` 生成 `计划 1 项，未执行本地修改`，tone 为 `pending`，detail 为 `dry-run 预览`。
  - `compress_images` 生成 input -> output，detail 为 `1000B -> 420B，减少 58%`。
- 初次运行 `pnpm test:audit-view` 红灯，原因是 `auditSideEffectDiff` 尚未实现。
- 实现 helper 并接入 Agent 面板后目标测试转绿。

验证：

```bash
pnpm test:audit-view
pnpm check
pnpm build
cargo fmt --check
pnpm smoke:tauri-desktop
```

浏览器验证：

- 使用 browser automation 打开 `http://127.0.0.1:1420/?parity=1`。
- 页面标题为 `ATools 3.0`。
- console errors 为 0。

结果：

- `pnpm test:audit-view`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，164 modules transformed。
- `cargo fmt --check`：通过。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，权限/数据/系统设置 smoke 均为 true。

真实 Tauri smoke 残留：

- `json-viewer` feature code 冲突 warning 仍存在；这是插件内置加载/索引问题，按用户当前要求继续暂缓插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP 底座 | 87% | 88% | 审计详情补副作用 diff，Agent 调用后的本地变化更可解释 |
| 权限与审计 | 88% | 90% | 审计回放从路径清单升级为 before/after diff，覆盖 dry-run、rename 和 image compression |
| ZTools 设置页 UI | 90% | 90% | 本批不改设置页主体 |
| 测试与发布 | 99% | 99% | 扩展审计视图测试并通过真实 desktop smoke |

当前重点剩余：

1. 内置程序体验：继续打磨设置页 ZTools 细节、空状态、本地数据和调试视图。
2. 权限与审计：继续补更完整的审计查询后端能力和导出筛选结果。
3. Agent/MCP：继续补 MCP 协议完整性、客户端一键写入配置；插件 tools 暴露按当前要求暂缓。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## 第四十六批：后端审计查询与筛选导出

用户要求：插件不着急，继续完善内置程序体验。本批聚焦 Agent 审计历史的真实可用性，把前端筛选逻辑补到 Rust/SQLite 侧，并让导出按钮只导出当前筛选结果。

状态：DONE。

修改文件：

- `crates/atools-core/src/agent.rs`
- `crates/atools-core/src/db.rs`
- `crates/atools-core/tests/agent_tests.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`
- `src/lib/types.ts`
- `src/components/AgentPanel.svelte`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- Rust core 新增 `AuditLogQuery`：
  - 支持 `limit`、关键字、状态、工具名、客户端过滤。
  - `limit` 限制在 1..5000，避免一次导出无限数据。
- SQLite 审计读取新增后端查询入口：
  - `query_audit_entries()` 按时间倒序读取审计并过滤。
  - 关键字搜索覆盖 id、时间、客户端、工具、状态、error、input JSON 和 output JSON。
  - `success` 状态归并 `allowed` / `confirmed`，同时支持精确 `allowed`、`confirmed`、`denied`、`error`。
- 审计导出新增后端筛选版：
  - `export_audit_entries_jsonl_filtered()` 复用同一查询条件输出 JSONL。
  - 保留旧的 `list_audit_entries()` 和 `export_audit_entries_jsonl(limit)`，避免破坏设置页和数据页已有入口。
- Tauri 新增 commands：
  - `query_audit_entries`
  - `export_audit_entries_jsonl_filtered`
- Agent 面板导出按钮改为使用当前筛选条件：
  - 有关键字/状态/工具/客户端筛选时，只导出当前匹配结果。
  - 导出成功提示显示 `当前筛选`，避免用户误以为复制了全部审计。
- macOS smoke checklist 增加筛选导出检查项。

TDD 记录：

- 先新增 `audit_entries_query_and_filtered_export_match_frontend_filters`：
  - confirmed `rename_files` + `success` + `codex` + `invoice` 能命中指定记录。
  - error `ocr_image` + `ocr service` 能命中失败记录。
  - denied + `permission` 能命中权限拒绝记录。
  - filtered JSONL export 只导出符合 `success + codex + api key` 的一条记录。
- 初次运行目标测试红灯，原因是 `AuditLogQuery`、`query_audit_entries()` 和 `export_audit_entries_jsonl_filtered()` 尚不存在。
- 实现 Rust 查询、导出和 Tauri/前端接入后目标测试转绿。

验证：

```bash
cargo fmt --check
cargo test -p atools-core --test agent_tests
cargo test -p atools --test agent_tools_tests
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 使用 browser automation 打开 `http://127.0.0.1:1420/?parity=1`。
- 页面标题为 `ATools 3.0`。
- console errors 为 0。

结果：

- `cargo fmt --check`：通过。
- `cargo test -p atools-core --test agent_tests`：通过，9 passed。
- `cargo test -p atools --test agent_tools_tests`：通过，19 passed。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，164 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，权限/数据/系统设置 smoke 均为 true。

真实 Tauri smoke 残留：

- `json-viewer` feature code 冲突 warning 仍存在；这是插件内置加载/索引问题，按用户当前要求继续暂缓插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP 底座 | 88% | 89% | 审计查询从前端当前列表扩展到 Rust 后端，并支持按当前筛选导出 |
| 权限与审计 | 90% | 92% | 审计历史支持后端查询、状态归并和筛选 JSONL 导出，日常回放/导出更接近真实使用 |
| ZTools 设置页 UI | 90% | 90% | 本批不改设置页主体 |
| 测试与发布 | 99% | 99% | 新增后端审计查询回归测试，并通过真实 desktop smoke |

当前重点剩余：

1. 内置程序体验：继续打磨设置页 ZTools 细节、空状态、本地数据和调试视图。
2. 权限与审计：审计查询分页/索引化、保存筛选视图仍可增强。
3. Agent/MCP：继续补 MCP 协议完整性、客户端一键写入配置；插件 tools 暴露按当前要求暂缓。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## 第四十七批：我的数据审计概览

用户要求：插件不着急，继续完善内置程序体验。本批聚焦设置页 `我的数据` 的审计可读性，让用户不必跳到 Agent 页就能判断本地审计数据里有什么、最近是否有失败或拒绝记录。

状态：DONE。

修改文件：

- `src/lib/auditView.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-audit-view.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `auditView` 新增 `auditDataOverview()`：
  - 返回总量文案。
  - 返回成功/拒绝/失败/待确认/未知状态统计。
  - 返回最近审计中的 Top 工具和 Top 客户端。
  - 返回最近记录摘要和异常记录摘要。
  - 空数据返回 `暂无审计记录`，供数据页空状态直接使用。
- 设置页 `我的数据` 新增 `审计数据概览`：
  - 无审计记录时显示明确空状态。
  - 有记录时显示状态分布、Top 工具、客户端、最近记录和异常记录。
  - 复用 ZTools 风格的 setting group、compact list、meta pill，不引入插件相关 UI。
- 移动端布局：
  - 三列概览在窄屏下变成单列。
  - 长 input/output/error 摘要使用等宽省略，不挤压按钮。
- macOS smoke checklist 增加 `我的数据` 审计概览检查项。

TDD 记录：

- 先扩展 `scripts/test-audit-view.mjs`，要求：
  - `auditDataOverview()` 对四条审计记录输出 `共 4 条审计记录`。
  - 状态统计为成功 2、拒绝 1、失败 1、待确认 0、未知 0。
  - Top 工具按次数和字母序输出前三项。
  - Top 客户端输出 `codex=2`、`claude=1`、`cursor=1`。
  - 最近记录按时间倒序展示。
  - 异常记录包含 denied 和 error，且拒绝记录 detail 是权限错误文案。
  - 空数组输出 `暂无审计记录`。
- 初次运行 `pnpm test:audit-view` 红灯，原因是 `auditDataOverview` 尚未导出。
- 实现 helper 后目标测试转绿。

验证：

```bash
pnpm test:audit-view
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 使用 browser automation 打开 `http://127.0.0.1:1420/?parity=1`。
- 进入 `设置` -> `我的数据`。
- DOM 可见 `审计数据概览`。
- 浏览器预览模式下可见 `暂无审计记录；Agent 或 MCP 调用工具后会在本地留下可回放记录` 和 `Tauri 运行时未连接`。
- console error/warn 为 0。

结果：

- `pnpm test:audit-view`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，164 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，权限/数据/系统设置 smoke 均为 true。

真实 Tauri smoke 残留：

- `json-viewer` feature code 冲突 warning 仍存在；这是插件内置加载/索引问题，按用户当前要求继续暂缓插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 90% | 91% | `我的数据` 页新增审计概览，空状态和统计更接近真实数据管理页 |
| 设置项真实功能 | 88% | 89% | 数据页不只导出/清空审计，也能本地查看状态、来源和异常摘要 |
| 权限与审计 | 92% | 93% | 审计数据从 Agent 页详情扩展到设置页管理视图，异常记录更容易被发现 |
| Agent/MCP 底座 | 89% | 89% | 本批不改 MCP 协议和工具调用 |
| 测试与发布 | 99% | 99% | 扩展审计视图脚本测试，并通过真实 desktop smoke |

当前重点剩余：

1. 内置程序体验：继续打磨设置页插件市场禁用态、AI 模型、WebDAV 同步等未实现页的 ZTools 风格细节。
2. 权限与审计：审计查询分页/索引化、保存筛选视图仍可增强。
3. Agent/MCP：继续补 MCP 协议完整性、客户端一键写入配置；插件 tools 暴露按当前要求暂缓。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## 第四十八批：AI 模型本地配置页

用户要求：继续还原内置程序体验，插件不着急。本批聚焦设置页 `AI 模型`，把它从占位页推进为真实可保存的本地配置页，为后续 Agent 默认模型接入做准备。

状态：DONE。

修改文件：

- `src/lib/settings.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-settings-normalization.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 设置结构新增 AI 配置字段：
  - `aiProvider`: `disabled` / `openai` / `compatible` / `local`
  - `aiBaseUrl`
  - `aiDefaultModel`
  - `aiApiKey`
  - `aiTemperature`
  - `aiUseForAgent`
- `normalizeSettings()` 新增 AI 配置规范化：
  - provider 非法值回退为 `disabled`。
  - base URL、model、api key 会 trim。
  - temperature 范围 0..2，越界回退默认 0.2。
  - provider 为 `disabled` 时强制 `aiUseForAgent=false`，避免假启用。
- 设置页 `AI 模型` 从占位页改为真实页面：
  - 模型提供商选择。
  - API Base URL。
  - 默认模型。
  - API Key 密码输入。
  - 温度滑条。
  - 用于 Agent 默认模型开关。
  - 配置预览。
- 页面明确提示：
  - 当前仅保存本地 AI 模型配置。
  - 实际 Agent/插件调用接入前不会自动发送请求。
- macOS smoke checklist 增加 AI 模型设置页和 provider 交互检查项。

TDD 记录：

- 先扩展 `scripts/test-settings-normalization.mjs`，要求：
  - `compatible` provider、base URL、model、api key 被 trim 后保留。
  - temperature 合法值 1.7 被保留。
  - `aiUseForAgent=true` 在 provider 非 disabled 时保留。
  - 非法 provider 回退 `disabled`。
  - 非字符串 base URL/model/api key 回退空字符串。
  - temperature=99 回退默认 0.2。
  - provider disabled 时强制 `aiUseForAgent=false`。
- 初次运行目标测试红灯，原因是未知 AI 字段仅被透传，没有 trim/校验。
- 初次实现后 temperature 仍被 clamp 到 2；按测试改为 AI temperature 越界回退默认值后目标测试转绿。

验证：

```bash
pnpm test:settings-normalization
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 使用 browser automation 打开 `http://127.0.0.1:1420/?parity=1`。
- 进入 `设置` -> `AI 模型`。
- DOM 可见 `模型提供商`、`API Base URL`、`默认模型`、`当前仅保存本地 AI 模型配置`、`配置预览`。
- provider 切到 `兼容 API` 后显示 `配置不完整`，Base URL 输入可编辑。
- provider 切回 `关闭` 后显示 `未启用`，Base URL 输入禁用。
- console warn/error 为 0。

结果：

- `pnpm test:settings-normalization`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，164 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，权限/数据/系统设置 smoke 均为 true。

真实 Tauri smoke 残留：

- `json-viewer` feature code 冲突 warning 仍存在；这是插件内置加载/索引问题，按用户当前要求继续暂缓插件方向。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 91% | 92% | `AI 模型` 从占位页变成真实配置页，保留 ZTools 风格设置布局 |
| 设置项真实功能 | 89% | 91% | AI provider/base URL/model/key/temperature/Agent 默认开关进入 settings 持久化链路 |
| Agent/MCP 底座 | 89% | 90% | 为 Agent 默认模型接入准备本地配置，但尚未接入真实调用 |
| 权限与审计 | 93% | 93% | 本批不改权限审计 |
| 测试与发布 | 99% | 99% | 扩展设置规范化测试，并通过真实 desktop smoke |

当前重点剩余：

1. 内置程序体验：继续打磨 WebDAV 同步、插件市场禁用态、AI 配置接入真实 Agent 调用。
2. 权限与审计：审计查询分页/索引化、保存筛选视图仍可增强。
3. Agent/MCP：继续补 MCP 协议完整性、客户端一键写入配置；插件 tools 暴露按当前要求暂缓。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 302：find_local_files 忽略规则、深度和权限统计闭环

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批聚焦 `find_local_files` 的 Agent 工具行为：支持 `ignore_dirs`、`max_depth`、权限错误跳过统计和 `ignore_patterns` 通配忽略，且 `*.tmp` 忽略文件名、`generated/**` 跳过相对路径子树。

状态：DONE。

修改文件：

- `scripts/test-settings-mcp-find-local-files-ignore.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 checklist-bound 脚本 `test-settings-mcp-find-local-files-ignore.mjs`，验证 `FindLocalFilesOptions` 包含 `limit`、`max_depth`、`ignore_dirs` 和 `ignore_patterns`。
- 脚本绑定 `find_local_files_tool_call()` 参数解析：`max_depth` clamp 到 100、`ignore_dirs` 支持显式传入并默认跳过常见目录、`ignore_patterns` 支持数组传入、输出包含 `skipped_permission_errors`。
- 脚本绑定 `visit_files()` traversal：超过 `max_depth` 停止、`PermissionDenied` 在 read_dir/entry/file_type 路径累计统计、命中 `ignore_dirs` 跳过目录、命中 `ignore_patterns` 后不匹配也不递归。
- 脚本绑定 `matches_ignore_patterns()`：`generated/**` 这类相对子树 pattern 和 `*.tmp` 这类文件名 wildcard 均有实现。
- 脚本绑定现有 Rust 行为测试：`find_local_files_respects_ignore_dirs_and_max_depth`、`find_local_files_respects_ignore_patterns_for_files_and_paths`、`find_local_files_skips_permission_denied_directories`。
- `docs/macos-smoke-checklist.md` 将 `find_local_files` ignore/depth/permission 统计项标记为完成。

TDD 记录：

- 先新增 checklist-bound 脚本；首次运行通过源码/schema/Rust 测试存在性断言，失败在 smoke checklist 未勾选。
- 更新 `docs/macos-smoke-checklist.md` 后目标脚本转绿。
- 本批未改生产 Rust；现有实现已满足该 smoke 行，新增脚本防止后续漂移。

验证：

```bash
node scripts/test-settings-mcp-find-local-files-ignore.mjs
cargo test --test agent_tools_tests find_local_files -- --nocapture
pnpm check
pnpm build
cargo test --workspace
pnpm smoke:tauri-desktop
```

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP local foundation | 99% | 99% | 本批关闭 find_local_files ignore/depth/permission smoke 漂移，不改变粗粒度能力估计 |
| 内置 Agent 工具 | 86% | 86% | find_local_files 的忽略规则与权限统计由 targeted tests 和 checklist-bound script 守护 |
| 测试与发布 | 99% | 99% | 新增 checklist-bound script 覆盖该 smoke 行 |
| macOS smoke checklist closure | 45.5% | 45.8% | 从 131/288 提升到 132/288 |

当前重点剩余：

1. 权限/审计 UI 行仍需继续用前端/Rust/desktop smoke 绑定后关闭。
2. 插件生态仍剩完整运行时权限隔离、证书链/吊销/平台级签名策略、更广第三方视觉截图和 side-effecting native bridge replay。
3. 发布侧仍剩签名、公证、自动更新配置。

## Batch 301：ask_ai_model 成功审计可读性与 API Key 脱敏闭环

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批聚焦 `ask_ai_model` 成功调用后的审计边界：审计记录需要可见 prompt 和模型输出，但不能展示 AI API Key。

状态：DONE。

修改文件：

- `src-tauri/tests/agent_tools_tests.rs`
- `scripts/test-settings-mcp-ask-ai-audit-redaction.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 Rust 测试 `ask_ai_model_success_audit_keeps_prompt_and_output_without_api_key`，通过本地 OpenAI-compatible `/chat/completions` server 验证真实请求和成功输出。
- 测试使用 `sk-agent-audit-secret` sentinel，验证请求头实际发送 Bearer token，但持久化审计 JSON 中不包含该密钥，也不包含 `api_key` 字段。
- 测试验证审计 input 保留 prompt，审计 output 保留 assistant `text` 和 model 信息，满足成功调用后的可回放/可读审计需求。
- 新增 `scripts/test-settings-mcp-ask-ai-audit-redaction.mjs`，绑定 `call_tool_with_audit()` 成功路径会保存 arguments/output、`ask_ai_model` 输出不含 key、Rust 回归测试存在，以及 macOS smoke checklist 行保持完成。
- `docs/macos-smoke-checklist.md` 将 `ask_ai_model` 成功调用审计脱敏项标记为完成。

TDD 记录：

- 先新增 Rust 行为测试；初次运行失败在测试自身对 `Authorization` header 大小写过于严格。
- 修正为大小写不敏感后 Rust 目标测试转绿，确认当前产品实现已满足审计可读性和密钥不落库要求。
- 再新增 `scripts/test-settings-mcp-ask-ai-audit-redaction.mjs`，首次运行通过 source/test 行为断言，失败在 smoke checklist 未勾选。
- 更新 `docs/macos-smoke-checklist.md` 后目标脚本转绿。

验证：

```bash
cargo test --test agent_tools_tests ask_ai_model_success_audit_keeps_prompt_and_output_without_api_key -- --nocapture
node scripts/test-settings-mcp-ask-ai-audit-redaction.mjs
pnpm check
pnpm build
cargo test --workspace
pnpm smoke:tauri-desktop
```

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP local foundation | 99% | 99% | 本批关闭 ask_ai_model successful audit redaction smoke 漂移，不改变粗粒度能力估计 |
| 权限与审计 | 97% | 97% | 成功审计现在由 targeted test 守护 prompt/output 可读和 API Key 不落审计 |
| 测试与发布 | 99% | 99% | Rust 成功调用审计测试 + checklist-bound script 已覆盖该 smoke 行 |
| macOS smoke checklist closure | 45.1% | 45.5% | 从 130/288 提升到 131/288 |

当前重点剩余：

1. `find_local_files` ignore 行和权限/审计 UI 行仍需继续用前端/Rust/desktop smoke 绑定后关闭。
2. 插件生态仍剩完整运行时权限隔离、证书链/吊销/平台级签名策略、更广第三方视觉截图和 side-effecting native bridge replay。
3. 发布侧仍剩签名、公证、自动更新配置。

## Batch 300：ask_ai_model network scope 与保守确认闭环

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批聚焦 `ask_ai_model` 的 Agent/MCP 权限边界：Settings 中显示 `network` scope；保守确认模式下调用先进入权限确认，不应静默发送 prompt。

状态：DONE。

修改文件：

- `src-tauri/tests/agent_tools_tests.rs`
- `scripts/test-settings-mcp-ask-ai-permission.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 Rust 测试 `ask_ai_model_requires_network_scope_confirmation_in_conservative_mode`，验证 `ask_ai_model` 工具声明 `PermissionScope::Network`。
- 新增测试验证默认保守确认模式下 `permission_decision_for_tool("ask_ai_model")` 返回 `Confirm`。
- 新增测试验证 `build_permission_required_payload()` 对 `ask_ai_model` 返回 `permission_required: true`，携带原始 prompt 参数和 `network` scope。
- 新增 `test-settings-mcp-ask-ai-permission.mjs`，验证 Settings `MCP 服务` 工具列表显示 tool scope、待确认请求 UI 和处理动作可见，且 `call_tool_with_audit()` 在未确认时会先创建 pending request / emit 事件 / 返回 permission_required，再进入工具执行。
- `docs/macos-smoke-checklist.md` 将 `ask_ai_model` network scope / 保守确认项标记为完成。

TDD 记录：

- 先新增 Rust 行为测试；当前实现已满足该行为测试。
- 再新增 `scripts/test-settings-mcp-ask-ai-permission.mjs`，要求 Settings UI 与后端权限链路满足 smoke 行。
- 首次运行脚本通过 UI/backend 行为断言，失败在 smoke checklist 未勾选。
- 更新 `docs/macos-smoke-checklist.md` 后目标脚本转绿。

验证：

```bash
cargo test ask_ai_model_requires_network_scope_confirmation_in_conservative_mode --workspace
node scripts/test-settings-mcp-ask-ai-permission.mjs
pnpm check
pnpm build
cargo test --workspace
pnpm smoke:tauri-desktop
```

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP local foundation | 99% | 99% | 本批关闭 ask_ai_model network scope / conservative confirmation smoke 漂移，不改变粗粒度能力估计 |
| 权限与审计 | 97% | 97% | ask_ai_model 未确认调用的 pending request 链路现在由 targeted test 守护 |
| 测试与发布 | 99% | 99% | Settings UI + Rust 权限链路现在由 targeted tests 守护 |
| macOS smoke checklist closure | 44.8% | 45.1% | 从 129/288 提升到 130/288 |

当前重点剩余：

1. `ask_ai_model` 成功调用审计脱敏行、`find_local_files` ignore 行和权限/审计 UI 行仍需继续用前端/Rust/desktop smoke 绑定后关闭。
2. 插件生态仍剩完整运行时权限隔离、证书链/吊销/平台级签名策略、更广第三方视觉截图和 side-effecting native bridge replay。
3. 发布侧仍剩签名、公证、自动更新配置。

## Batch 299：插件 manifest tool 白名单与 MCP 曝露闭环

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批聚焦插件 manifest `tools` 的 Agent/MCP 白名单行为：启用插件声明的 tool 以 `plugin_<plugin>_<tool>` 进入白名单，默认关闭；用户开启后才进入 MCP `tools/list`，插件禁用或卸载后从白名单移除。

状态：DONE。

修改文件：

- `crates/atools-core/src/agent.rs`
- `crates/atools-core/tests/agent_tests.rs`
- `scripts/test-settings-mcp-plugin-tool-whitelist.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 修复 `ToolRegistry::list_enabled()`：MCP discovery 现在以用户实际 `tool.enabled` 为准，不再用 `enabled_by_default && enabled` 排除默认关闭但已由用户开启的插件工具。
- 新增 core MCP 回归测试 `mcp_tools_list_includes_user_enabled_plugin_tools`，覆盖 `enabled_by_default: false`、`enabled: true` 的插件 tool 必须出现在 MCP `tools/list`。
- 新增 `test-settings-mcp-plugin-tool-whitelist.mjs`，验证 Settings `工具开关` 会展示 `list_agent_tools` 返回的插件工具，插件工具命名为 `plugin_<plugin>_<tool>`，默认关闭，并可由用户打开。
- 新增脚本绑定现有 Rust 测试：`plugin_manifest_tools_sync_to_agent_whitelist_disabled_by_default` 覆盖插件 tool 同步/默认关闭/metadata，`enabled_tool_registry_includes_plugin_tool_only_after_user_enables_it` 覆盖用户开启后进入 registry、插件禁用后移除。
- `docs/macos-smoke-checklist.md` 将插件 manifest tool 白名单/MCP 曝露项标记为完成。

TDD 记录：

- 先新增 core MCP 回归测试，首次运行红灯：`tools/list` 返回 0 个插件工具，证明旧 `list_enabled()` 过滤逻辑排除了用户已启用的插件 tool。
- 修改 `ToolRegistry::list_enabled()` 为只过滤 `tool.enabled` 后，回归测试转绿。
- 再新增 `scripts/test-settings-mcp-plugin-tool-whitelist.mjs`，首次运行通过 UI/backend 行为断言，失败在 smoke checklist 未勾选。
- 更新 `docs/macos-smoke-checklist.md` 后目标脚本转绿。

验证：

```bash
cargo test mcp_tools_list_includes_user_enabled_plugin_tools --workspace
cargo test plugin --test agent_tools_tests
node scripts/test-settings-mcp-plugin-tool-whitelist.mjs
pnpm check
pnpm build
cargo test --workspace
pnpm smoke:tauri-desktop
```

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP local foundation | 99% | 99% | 插件 manifest tool 用户启用后进入 MCP discovery，属于行为修复但不改变粗粒度能力估计 |
| 测试与发布 | 99% | 99% | 插件 tool DB 白名单、Settings UI 和 MCP `tools/list` 链路现在由 targeted tests 守护 |
| macOS smoke checklist closure | 44.4% | 44.8% | 从 128/288 提升到 129/288 |

当前重点剩余：

1. `ask_ai_model` 权限/审计行、`find_local_files` ignore 行和权限/审计 UI 行仍需继续用前端/Rust/desktop smoke 绑定后关闭。
2. 插件生态仍剩完整运行时权限隔离、证书链/吊销/平台级签名策略、更广第三方视觉截图和 side-effecting native bridge replay。
3. 发布侧仍剩签名、公证、自动更新配置。

## Batch 298：设置页 MCP 工具白名单 macOS smoke checklist 闭环

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批聚焦设置页 `MCP 服务` 的工具白名单：至少显示默认 8 个内置工具，并包含 `ask_ai_model`。

状态：DONE。

修改文件：

- `scripts/test-settings-mcp-tool-whitelist.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 `test-settings-mcp-tool-whitelist.mjs`，验证 `SettingsPanel.svelte` 通过 `list_agent_tools` 读取全部 Agent 工具并保存到 `agentTools`。
- 新增测试验证 Settings `MCP 服务` 渲染 `工具开关` 区，逐项显示工具名、描述、scope 列表、启用状态和开关动作。
- 新增测试绑定 Rust 侧默认 whitelist：`builtin_tool_registry()` 注册 `ask_ai_model`、`compress_images`、`find_local_files`、`get_current_context`、`ocr_image`、`open_or_reveal_path`、`rename_files`、`search_clipboard` 8 个内置工具。
- 新增测试绑定现有 Rust 单测 `builtin_registry_contains_agent_whitelist()`，要求默认工具列表为精确断言而非松散存在性检查。
- `docs/macos-smoke-checklist.md` 将 Settings MCP 默认工具白名单项标记为完成。

TDD 记录：

- 先新增 `scripts/test-settings-mcp-tool-whitelist.mjs`，要求 Settings UI 和 Rust registry/test 覆盖链满足 smoke 行。
- 首次运行红灯通过 Settings UI 与 Rust whitelist 断言，失败在 smoke checklist 未勾选。
- 更新 `docs/macos-smoke-checklist.md` 后目标测试转绿。

验证：

```bash
node scripts/test-settings-mcp-tool-whitelist.mjs
cargo test builtin_registry_contains_agent_whitelist --workspace
pnpm check
pnpm build
cargo test --workspace
pnpm smoke:tauri-desktop
```

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP local foundation | 99% | 99% | 本批关闭 Settings MCP default tool whitelist smoke 漂移，不改变粗粒度能力估计 |
| 测试与发布 | 99% | 99% | Settings 工具开关 UI + Rust 默认 whitelist 现在由 targeted test 守护 |
| macOS smoke checklist closure | 44.1% | 44.4% | 从 127/288 提升到 128/288 |

当前重点剩余：

1. 插件 manifest tool 白名单行为、`ask_ai_model` 权限/审计行、`find_local_files` ignore 行和权限/审计 UI 行仍需继续用前端/Rust/desktop smoke 绑定后关闭。
2. 插件生态仍剩完整运行时权限隔离、证书链/吊销/平台级签名策略、更广第三方视觉截图和 side-effecting native bridge replay。
3. 发布侧仍剩签名、公证、自动更新配置。

## Batch 297：设置页 MCP 配置合并安全 macOS smoke checklist 闭环

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批聚焦设置页 `MCP 服务` 的配置合并写入安全：保留其他 `mcpServers` 和顶层字段，遇到无效 JSON 或非对象 `mcpServers` 时显示错误且不覆盖原文件。

状态：DONE。

修改文件：

- `scripts/test-settings-mcp-install-safety.mjs`
- `src-tauri/src/commands.rs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 `test-settings-mcp-install-safety.mjs`，验证 `SettingsPanel.svelte` 的 `installMcpTemplate()` 先通过共享建议路径计算默认位置，再弹出 JSON `saveDialog` 选择目标文件。
- 新增测试验证取消文件选择时设置 `已取消合并` 并提前 `return`，确认选择后只以 `targetPath`、`template.config`、`serverName: "atools"`、`confirmed: true` 调用 `install_mcp_client_config`。
- 新增测试验证后端错误会通过 `catch (error)` 写入 `mcpPageStatus = String(error)`，确保无效 JSON / 非对象 `mcpServers` 等错误在设置页可见。
- `src-tauri/src/commands.rs` 新增两个 Rust 测试：无效现有 JSON 和非对象 `mcpServers` 都必须返回明确错误，保留原文件内容，并且不创建 `*.atools-backup-*`。
- `docs/macos-smoke-checklist.md` 将 Settings MCP 配置合并安全项标记为完成。

TDD 记录：

- 先补 Rust 行为测试，验证 destructive error cases；当前实现已满足这些测试。
- 再新增 `scripts/test-settings-mcp-install-safety.mjs`，要求 Settings UI 流程、错误展示和 Rust 覆盖链满足 smoke 行。
- 首次运行红灯通过 UI/backend 行为断言，失败在 smoke checklist 未勾选。
- 更新 `docs/macos-smoke-checklist.md` 后目标测试转绿。

验证：

```bash
node scripts/test-settings-mcp-install-safety.mjs
cargo test mcp_client_config --workspace
pnpm test:mcp-client-config
pnpm check
pnpm build
cargo test --workspace
pnpm smoke:tauri-desktop
```

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP local foundation | 99% | 99% | 本批关闭 Settings MCP config merge safety smoke 漂移，不改变粗粒度能力估计 |
| 测试与发布 | 99% | 99% | Settings UI 错误展示 + Rust 后端无效文件保护链路现在由 targeted test 守护 |
| macOS smoke checklist closure | 43.8% | 44.1% | 从 126/288 提升到 127/288 |

当前重点剩余：

1. 工具白名单和 Agent 工具行为行仍需继续用前端/Rust/desktop smoke 绑定后关闭。
2. 插件生态仍剩完整运行时权限隔离、证书链/吊销/平台级签名策略、更广第三方视觉截图和 side-effecting native bridge replay。
3. 发布侧仍剩签名、公证、自动更新配置。

## Batch 296：Agent/MCP 面板配置合并到文件 macOS smoke checklist 闭环

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批聚焦主 Agent/MCP 面板的 `合并到文件...` 行为：文件选择、取消不写、确认后安全合并、备份已有 JSON、只替换/新增 `mcpServers.atools` 已实现并有 Rust 覆盖，但 smoke checklist 仍未勾选。

状态：DONE。

修改文件：

- `scripts/test-agent-panel-mcp-install.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 `test-agent-panel-mcp-install.mjs`，验证 `AgentPanel.svelte` 的 `installMcpTemplate()` 先通过共享建议路径计算默认位置，再弹出 JSON `saveDialog` 选择目标文件。
- 新增测试验证取消文件选择时设置 `已取消合并` 并提前 `return`，不会继续调用 `install_mcp_client_config` 写入命令。
- 新增测试验证确认选择后只以 `targetPath`、`template.config`、`serverName: "atools"`、`confirmed: true` 调用 `install_mcp_client_config`。
- 新增测试绑定 Rust 命令层覆盖：未确认写入报错且不创建文件，已有 JSON 写入前生成真实备份文件，合并保留顶层字段和其他 `mcpServers`，并替换旧的 `mcpServers.atools`。
- `docs/macos-smoke-checklist.md` 将 Agent/MCP 面板配置合并到文件行为项标记为完成。

TDD 记录：

- 先新增 `scripts/test-agent-panel-mcp-install.mjs`，要求 AgentPanel UI 流程和 Rust 写入/合并覆盖链满足 smoke 行。
- 首次运行红灯通过源码行为断言，失败在 smoke checklist 未勾选。
- 更新 `docs/macos-smoke-checklist.md` 后目标测试转绿。

验证：

```bash
node scripts/test-agent-panel-mcp-install.mjs
cargo test mcp_client_config --workspace
pnpm test:mcp-client-config
pnpm check
pnpm build
cargo test --workspace
pnpm smoke:tauri-desktop
```

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP local foundation | 99% | 99% | 本批关闭 AgentPanel 合并到文件 smoke 漂移，不改变粗粒度能力估计 |
| 测试与发布 | 99% | 99% | AgentPanel 配置写入 UI + Rust 后端安全合并链路现在由 targeted test 守护 |
| macOS smoke checklist closure | 43.4% | 43.8% | 从 125/288 提升到 126/288 |

当前重点剩余：

1. 设置页 `MCP 服务` 的无效 JSON/非对象 `mcpServers` 保护行、工具白名单和 Agent 工具行为行仍需继续用前端/Rust/desktop smoke 绑定后关闭。
2. 插件生态仍剩完整运行时权限隔离、证书链/吊销/平台级签名策略、更广第三方视觉截图和 side-effecting native bridge replay。
3. 发布侧仍剩签名、公证、自动更新配置。

## Batch 295：Agent/MCP 面板客户端配置 macOS smoke checklist 闭环

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批聚焦主 Agent/MCP 面板的 MCP 客户端配置区域：bind 地址、脱敏 token、推荐连接方式、配置复制、客户端模板、建议路径和合并说明已经实现，但 smoke checklist 仍未勾选。

状态：DONE。

修改文件：

- `scripts/test-agent-panel-mcp-config.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 `test-agent-panel-mcp-config.mjs`，验证 `AgentPanel.svelte` 使用 `mcpConnectionView` 渲染 MCP bind/http URL、masked token、recommended transport 和 security hint。
- 新增测试验证 AgentPanel 提供 `复制 HTTP 配置`、`复制 stdio 配置`、逐模板复制、合并到文件动作、`saveDialog` 文件选择和 `mcpClientSuggestedTargetPath()` 默认路径。
- 新增测试验证共享 `mcpClientTemplates()` 输出 `通用 HTTP MCP`、`通用 stdio proxy`、`Claude Desktop / Claude Code`、`Cursor` 四类模板，并验证 Claude Desktop / Cursor 的建议路径。
- `docs/macos-smoke-checklist.md` 将 5 条 Agent/MCP 面板客户端配置展示项标记为完成。

TDD 记录：

- 先新增 `scripts/test-agent-panel-mcp-config.mjs`，要求 AgentPanel 和 shared MCP client model 满足面板配置展示 smoke 行。
- 首次运行红灯失败在测试误以为四类模板文案直接写在 AgentPanel 组件中；实际模板由 `mcpClientTemplates()` 共享模型提供。
- 调整测试为“共享模型输出 + AgentPanel 渲染结构”后，再次运行红灯失败在 smoke checklist 未勾选。
- 更新 `docs/macos-smoke-checklist.md` 后目标测试转绿。

验证：

```bash
node scripts/test-agent-panel-mcp-config.mjs
pnpm test:mcp-client-config
pnpm check
pnpm build
cargo test --workspace
pnpm smoke:tauri-desktop
```

结果：

- `node scripts/test-agent-panel-mcp-config.mjs`：通过。
- `pnpm test:mcp-client-config`：通过。
- `pnpm check`：通过。
- `pnpm build`：通过。
- `cargo test --workspace`：通过。
- `pnpm smoke:tauri-desktop`：通过。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP local foundation | 99% | 99% | 本批关闭 AgentPanel 客户端配置展示 smoke 漂移，不改变粗粒度能力估计 |
| 测试与发布 | 99% | 99% | 5 条 macOS smoke checklist 项现在由 targeted test 守护 |
| macOS smoke checklist closure | 41.7% | 43.4% | 从 120/288 提升到 125/288 |

当前重点剩余：

1. Agent/MCP 配置真实合并到文件行为、设置页无效 JSON/非对象保护行、工具白名单和 Agent 工具行为行仍需继续用前端/Rust/desktop smoke 绑定后关闭。
2. 插件生态仍剩完整运行时权限隔离、证书链/吊销/平台级签名策略、更广第三方视觉截图和 side-effecting native bridge replay。
3. 发布侧仍剩签名、公证、自动更新配置。

## Batch 294：设置页 MCP / 我的数据 macOS smoke checklist 闭环

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批聚焦设置页 `MCP 服务` 和 `我的数据` 中已经实现但 smoke checklist 仍未勾选的页面项：MCP 治理、权限策略、待确认请求、持久授权、最近审计、客户端模板和数据/审计概览。

状态：DONE。

修改文件：

- `scripts/test-mcp-governance-overview.mjs`
- `scripts/test-data-settings-overview.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `test:mcp-governance-overview` 继续覆盖 `settingsPages.mcpGovernanceOverview()` 的 4 张治理卡和审计链文案，并新增 SettingsPanel 源码断言：masked token、安全提示、推荐连接方式、客户端模板、安装计划、复制/合并到文件动作、权限策略、pending request、持久授权、最近调用审计和 `打开我的数据`。
- `test:mcp-governance-overview` 将 12 条 Settings `MCP 服务` smoke checklist 行绑定为 `[x]`。
- `test:data-settings-overview` 继续覆盖 `dataOverviewCards()` 和审计保留策略模型，并新增 `我的数据` 概览、本地隐私边界、审计数据概览、清理和归档动作的 smoke checklist 绑定。
- `docs/macos-smoke-checklist.md` 将 12 条 Settings `MCP 服务` 行和 3 条 `我的数据` 概览行标记为完成。

TDD 记录：

- 先扩展 `scripts/test-mcp-governance-overview.mjs` 和 `scripts/test-data-settings-overview.mjs`，要求已由源码/模型证明的 smoke checklist 项保持 `[x]`。
- 首次运行 `pnpm test:mcp-governance-overview` 红灯，失败在 Settings `MCP 服务` 脱敏 token / 推荐连接方式 / token 安全提示 smoke 项仍为 `[ ]`。
- 首次运行 `pnpm test:data-settings-overview` 红灯，失败在 `我的数据` 数据概览 smoke 项仍为 `[ ]`。
- 更新 `docs/macos-smoke-checklist.md` 后两个目标测试转绿。

验证：

```bash
pnpm test:mcp-governance-overview
pnpm test:data-settings-overview
pnpm test:mcp-client-config
pnpm test:mcp-permission-policy-settings
pnpm test:mcp-request-grants-settings
pnpm test:mcp-audit-settings
pnpm check
pnpm build
cargo test --workspace
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:mcp-governance-overview`：通过。
- `pnpm test:data-settings-overview`：通过。
- `pnpm test:mcp-client-config`：通过。
- `pnpm test:mcp-permission-policy-settings`：通过。
- `pnpm test:mcp-request-grants-settings`：通过。
- `pnpm test:mcp-audit-settings`：通过。
- `pnpm check`：通过。
- `pnpm build`：通过。
- `cargo test --workspace`：通过。
- `pnpm smoke:tauri-desktop`：通过。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP local foundation | 99% | 99% | 本批关闭 Settings MCP 页面展示和模板 smoke 漂移，不改变粗粒度能力估计 |
| 权限与审计 | 97% | 97% | 我的数据/审计概览 smoke 漂移已关闭，长历史回放仍可增强 |
| 测试与发布 | 99% | 99% | 15 条 macOS smoke checklist 项现在由 targeted tests 守护 |
| macOS smoke checklist closure | 36.5% | 41.7% | 从 105/288 提升到 120/288 |

当前重点剩余：

1. 单独 Agent/MCP 面板的客户端配置行、配置合并无效 JSON 保护行、工具白名单和 Agent 工具行为行仍需继续用前端/Rust/desktop smoke 绑定后关闭。
2. 插件生态仍剩完整运行时权限隔离、证书链/吊销/平台级签名策略、更广第三方视觉截图和 side-effecting native bridge replay。
3. 发布侧仍剩签名、公证、自动更新配置。

## Batch 293：本地启动响应式行布局 macOS smoke checklist 闭环

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批聚焦设置页 `本地启动` 在 1280px 和窄屏下的行级布局：路径输入框必须单独成行，行级 `打开` / `定位` / `删除` 操作不能挤压名称、关键字、类型和路径字段。

状态：DONE。

修改文件：

- `src/components/SettingsPanel.svelte`
- `scripts/test-local-launch-settings.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `SettingsPanel.svelte` 将 Local Launch 行保持为 `toggle + content` 两列壳层，基础宽度为 `48px minmax(0, 1fr)`，避免行级按钮占第三列挤压字段。
- `SettingsPanel.svelte` 增加 1280px 断点，切到 `42px minmax(0, 1fr)`，并保持操作按钮位于内容列。
- `SettingsPanel.svelte` 增加 860px 断点，让名称、关键字、类型和路径字段纵向堆叠，路径输入仍 `grid-column: 1 / -1`。
- `scripts/test-local-launch-settings.mjs` 增加响应式 CSS 和 smoke checklist 断言，防止后续回退为三列挤压布局。
- `docs/macos-smoke-checklist.md` 将本地启动 1280px/窄屏行布局项标记为完成。

TDD 记录：

- 先扩展 `scripts/test-local-launch-settings.mjs`，要求 1280px 与 860px 的 Local Launch 响应式规则和 smoke checklist 项保持 `[x]`。
- 首次运行 `pnpm test:local-launch-settings` 红灯，失败在缺少 `@media (max-width: 1280px)` 下的 `.local-launch-row` 规则。
- 补齐 `src/components/SettingsPanel.svelte` 断点后再次运行，测试越过 CSS 断言并红在 smoke checklist 未勾选。
- 更新 `docs/macos-smoke-checklist.md` 后目标测试转绿。

验证：

```bash
pnpm test:local-launch-settings
pnpm test:settings-controls-style
pnpm check
pnpm build
cargo test --workspace
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:local-launch-settings`：通过。
- `pnpm test:settings-controls-style`：通过。
- `pnpm check`：通过。
- `pnpm build`：通过。
- `cargo test --workspace`：通过。
- `pnpm smoke:tauri-desktop`：通过。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 设置页 shell/navigation | 88% | 88% | 本批关闭一条 Local Launch 响应式 smoke 漂移，不改变粗粒度模块估计 |
| 测试与发布 | 99% | 99% | 1 条 macOS smoke checklist 项现在由 targeted test 守护 |
| macOS smoke checklist closure | 36.1% | 36.5% | 从 104/288 提升到 105/288 |

当前重点剩余：

1. MCP/我的数据相关 smoke 项仍需继续用前端/Rust/desktop smoke 绑定后关闭。
2. 插件生态仍剩完整运行时权限隔离、证书链/吊销/平台级签名策略、更广第三方视觉截图和 side-effecting native bridge replay。
3. 发布侧仍剩签名、公证、自动更新配置。

## Batch 292：Home 搜索壳层 / 分组结果 macOS smoke checklist 闭环

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批聚焦 Home/search 顶部 Web preview smoke：ZTools 风格搜索框、固定/最近顺序、固定空态和管理入口、首页四个紧凑入口，以及 `set` 搜索结果分组元信息。实现此前已经具备，但 macOS smoke checklist 仍有多条未勾选；本批补上清单回归约束并同步完成度。

状态：DONE。

修改文件：

- `scripts/test-z-mark.mjs`
- `scripts/test-home-surface.mjs`
- `scripts/test-result-presentation.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `test:z-mark` 增加 Home search shell 约束，要求 prominent search input、右侧三笔画 Z badge、ZTools 风格搜索框 smoke 项保持 `[x]`。
- `test:home-surface` 增加 Home 空搜索 smoke 约束，要求有固定指令时 `固定` 分区先于 `最近使用`，无固定指令时显示紧凑 `固定` 空态和 `管理固定指令`，点击路径通过 `onsettingsmenu("commands")` 进入 `所有指令`。
- `test:home-surface` 同时要求 HomePanel 上方四个紧凑入口存在并由 `homeQuickActions()` 驱动，不回到营销说明块。
- `test:result-presentation` 增加结果分组元信息 smoke 约束，要求 `ResultsList` 使用 `groupedResultPresentation(results)`，行内显示 title、explain、source detail 和 match label。
- `docs/macos-smoke-checklist.md` 将已验证的 Home shell / pinned-empty / first-screen entries / grouped-result 6 条标记为完成；本地启动窄屏行布局、MCP/我的数据相关项仍保持未勾选。

TDD 记录：

- 先扩展 3 个 Home/search shell and grouped-result 测试脚本，要求已验证的 smoke checklist 项为 `[x]`。
- 首次运行 `pnpm test:z-mark` 红灯，失败在首页 ZTools 风格搜索框和右侧三笔画 Z 图标 smoke 项仍为 `[ ]`。
- 首次运行 `pnpm test:home-surface` 红灯，失败在空搜索固定/最近顺序 smoke 项仍为 `[ ]`；同一脚本还绑定固定空态、管理固定指令入口和首页四个紧凑入口 smoke 项。
- 首次运行 `pnpm test:result-presentation` 红灯，失败在 `set` 搜索结果分组元信息 smoke 项仍为 `[ ]`。
- 更新 `docs/macos-smoke-checklist.md` 后，3 个目标测试均转绿。

验证：

```bash
pnpm test:z-mark
pnpm test:home-surface
pnpm test:result-presentation
pnpm check
pnpm build
cargo test --workspace
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:z-mark`：通过。
- `pnpm test:home-surface`：通过。
- `pnpm test:result-presentation`：通过。
- `pnpm check`：通过。
- `pnpm build`：通过。
- `cargo test --workspace`：通过。
- `pnpm smoke:tauri-desktop`：通过。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Home/search experience | 88% | 89% | Home search shell、固定空态、首页四入口和分组结果 smoke 漂移已关闭 |
| 测试与发布 | 99% | 99% | 6 条 macOS smoke checklist 项现在由 targeted tests 守护 |
| macOS smoke checklist closure | 34.0% | 36.1% | 从 98/288 提升到 104/288 |

当前重点剩余：

1. 本地启动 1280px/窄屏行布局仍需直接布局或浏览器验证后再关闭。
2. MCP/我的数据相关 smoke 项仍需继续用前端/Rust/desktop smoke 绑定后关闭。
3. 插件生态仍剩完整运行时权限隔离、证书链/吊销/平台级签名策略、更广第三方视觉截图和 side-effecting native bridge replay。
4. 发布侧仍剩签名、公证、自动更新配置。

## Batch 291：Home 图标 / 结果元信息 macOS smoke checklist 闭环

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批聚焦首页常用入口图标、最近/固定磁贴来源图标、ZTools 导入入口、搜索结果 fallback 图标和匹配标签 tone：实现此前已经具备，但 macOS smoke checklist 仍有多条未勾选；本批补上清单回归约束并同步完成度。

状态：DONE。

修改文件：

- `scripts/test-home-quick-action-icons.mjs`
- `scripts/test-home-recent-type-icons.mjs`
- `scripts/test-ztools-import-view.mjs`
- `scripts/test-result-type-icons.mjs`
- `scripts/test-match-type-meta.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `test:home-quick-action-icons` 增加 macOS smoke checklist 约束，要求 Home 四个常用入口使用明确 SVG 图标、不显示入口文字首字 fallback、按钮具备 `打开...` aria label。
- `test:home-recent-type-icons` 增加 macOS smoke checklist 约束，要求最近/固定磁贴使用来源类型 SVG 图标、图标外层约 38px、无命令标题首字 fallback。
- `test:ztools-import-view` 增加导入入口 smoke 约束，要求导入面板显示 `等待扫描` 和 `选择目录并扫描`，且不在组件 mount 时自动执行导入。
- `test:result-type-icons` 增加搜索结果 fallback icon smoke 约束，要求无真实应用图标的内置搜索结果使用来源类型 SVG 图标，同时保留真实本地应用 icon asset 转换。
- `test:match-type-meta` 增加匹配标签 tone smoke 约束，要求 alias/fuzzy 等 metadata 和视觉 tone 保持可区分。
- `docs/macos-smoke-checklist.md` 将已验证的 Home icon / result metadata 5 条标记为完成；Home pinned-empty 管理入口、首屏四入口可见性、`set` 结果分组、本地启动窄屏行布局、MCP/我的数据相关项仍保持未勾选。

TDD 记录：

- 先扩展 5 个 Home/search icon and metadata 测试脚本，要求已验证的 smoke checklist 项为 `[x]`。
- 首次运行 `pnpm test:home-quick-action-icons` 红灯，失败在首页四个常用入口明确功能图标 smoke 项仍为 `[ ]`。
- 首次运行 `pnpm test:home-recent-type-icons` 红灯，失败在最近使用磁贴来源类型 SVG 图标 smoke 项仍为 `[ ]`。
- 首次运行 `pnpm test:ztools-import-view` 红灯，失败在导入 ZTools 插件入口只打开等待扫描面板 smoke 项仍为 `[ ]`。
- 首次运行 `pnpm test:result-type-icons` 红灯，失败在搜索结果 fallback SVG 图标 smoke 项仍为 `[ ]`。
- 首次运行 `pnpm test:match-type-meta` 红灯，失败在搜索结果匹配标签 tone smoke 项仍为 `[ ]`。
- 更新 `docs/macos-smoke-checklist.md` 后，5 个目标测试均转绿。

验证：

```bash
pnpm test:home-quick-action-icons
pnpm test:home-recent-type-icons
pnpm test:ztools-import-view
pnpm test:result-type-icons
pnpm test:match-type-meta
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:home-quick-action-icons`：通过。
- `pnpm test:home-recent-type-icons`：通过。
- `pnpm test:ztools-import-view`：通过。
- `pnpm test:result-type-icons`：通过。
- `pnpm test:match-type-meta`：通过。
- `pnpm check`：通过。
- `pnpm build`：通过。
- `pnpm smoke:tauri-desktop`：通过。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Home/search experience | 87% | 88% | 首页图标、最近磁贴、导入入口、结果 fallback 图标和匹配标签 smoke 漂移已关闭 |
| 测试与发布 | 99% | 99% | 5 条 macOS smoke checklist 项现在由 targeted tests 守护 |
| macOS smoke checklist closure | 32.3% | 34.0% | 从 93/288 提升到 98/288 |

当前重点剩余：

1. Home pinned-empty 管理入口、首屏四入口可见性和 `set` 结果分组仍需直接绑定 smoke checklist。
2. 本地启动 1280px/窄屏行布局仍需直接布局或浏览器验证后再关闭。
3. MCP/我的数据相关 smoke 项仍需继续用前端/Rust/desktop smoke 绑定后关闭。
4. 插件生态仍剩完整运行时权限隔离、证书链/吊销/平台级签名策略、更广第三方视觉截图和 side-effecting native bridge replay。
5. 发布侧仍剩签名、公证、自动更新配置。

## Batch 290：Home 状态栏 / 通用设置 macOS smoke checklist 闭环

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批聚焦首页状态栏、固定分区容量隔离、Z 图标进入设置、通用设置最近使用开关、最近/固定行数、设置持久化、暗黑主题、橙色主题色和自定义主题色：实现此前已经具备，但 macOS smoke checklist 仍有多条未勾选；本批补上清单回归约束并同步完成度。

状态：DONE。

修改文件：

- `scripts/test-search-status-bar.mjs`
- `scripts/test-home-search-overview.mjs`
- `scripts/test-home-surface.mjs`
- `scripts/test-home-pinned-sections.mjs`
- `scripts/test-general-settings-overview.mjs`
- `scripts/test-settings-normalization.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `test:search-status-bar` 增加 macOS smoke checklist 约束，要求 Home/search 底部 34px 状态栏、Settings 页不显示该底栏、固定/最近状态文案 smoke 项保持 `[x]`。
- `test:home-search-overview` 增加 Z badge 源码约束，要求 `SearchBar` 支持 `showBadge`、`app-badge`、`aria-label="打开设置"` 和 `onbadgeclick`，且 `App.svelte` 只在首页显示 badge 并通过 `openSettingsMenu("general")` 进入设置。
- `test:home-surface` 增加最近使用一行最多 9 项的 smoke 约束，继续要求 HomePanel 通过 `recentRows * 9` 限制渲染数量。
- `test:home-pinned-sections` 增加固定分区容量隔离、固定栏一行最多 9 项且刷新后保留设置的 smoke 约束，继续要求 `pinnedRows` 经 settings snapshot、App runtime、SettingsPanel 控件、`pinnedCommandCapacity` 截断和 HomePanel 限制串起来。
- `test:general-settings-overview` 增加关闭 `搜索框显示最近使用` 后首页不展示最近使用的 smoke 约束，并要求 `showHomeRecent` 只在空查询且设置开启时展开。
- `test:settings-normalization` 扩展为真实设置持久化和外观变量测试：通过 `saveAToolsSettings` / `loadAToolsSettings` / `applyAToolsAppearance` 验证 `showRecentInSearch:false`、`recentRows:1`、`pinnedRows:1`、dark theme、orange primary color、custom color、颜色选择器和相关 CSS 变量。
- `docs/macos-smoke-checklist.md` 将已验证的 Home status / General settings 11 条标记为完成；本地启动窄屏行布局、MCP/我的数据相关项仍保持未勾选。

TDD 记录：

- 先扩展 6 个 Home/status/general settings 测试脚本，要求已验证的 smoke checklist 项为 `[x]`。
- 首次运行 `pnpm test:search-status-bar` 先暴露过宽的文本排除断言会误伤 SettingsPanel；修正为结构性断言后红灯落到状态栏 smoke 项仍为 `[ ]`。
- 首次运行 `pnpm test:home-search-overview` 红灯，失败在 Z 图标进入设置 smoke 项仍为 `[ ]`。
- 首次运行 `pnpm test:home-surface` 红灯，失败在最近使用一行最多 9 项 smoke 项仍为 `[ ]`。
- 首次运行 `pnpm test:home-pinned-sections` 红灯，失败在固定栏一行最多 9 项且刷新保留 smoke 项仍为 `[ ]`；补入通用固定分区容量隔离 smoke 断言后再次红灯，失败在该通用项仍为 `[ ]`。
- 首次运行 `pnpm test:general-settings-overview` 红灯，失败在关闭最近使用后首页隐藏 recent smoke 项仍为 `[ ]`。
- 首次运行 `pnpm test:settings-normalization` 先失败在旧 dark CSS 变量期望；更新为当前实际暗色 token 后红灯落到通用设置持久化/主题 smoke 项仍为 `[ ]`。
- 更新 `docs/macos-smoke-checklist.md` 后，6 个目标测试均转绿。

验证：

```bash
pnpm test:search-status-bar
pnpm test:home-search-overview
pnpm test:home-surface
pnpm test:home-pinned-sections
pnpm test:general-settings-overview
pnpm test:settings-normalization
pnpm check
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:search-status-bar`：通过。
- `pnpm test:home-search-overview`：通过。
- `pnpm test:home-surface`：通过。
- `pnpm test:home-pinned-sections`：通过。
- `pnpm test:general-settings-overview`：通过。
- `pnpm test:settings-normalization`：通过。
- `pnpm check`：通过。
- `pnpm smoke:tauri-desktop`：通过。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Settings shell and navigation | 88% | 88% | 本批只确认 Z badge 进入设置入口，不改变设置 shell 估计 |
| ZTools 设置页 UI | 99% | 99% | 主题色、自定义颜色和 dark mode 继续由设置规范化测试守护 |
| 设置项真实功能 | 99% | 99% | 最近使用开关、recentRows、pinnedRows 和主题设置持久化已由测试绑定 |
| Home/search experience | 86% | 87% | 首页状态栏、固定/最近状态文案、固定分区容量隔离、Z badge 入口和行数限制 smoke 漂移已关闭 |
| 测试与发布 | 99% | 99% | 11 条 macOS smoke checklist 项现在由 targeted tests 守护 |
| macOS smoke checklist closure | 28.5% | 32.3% | 从 82/288 提升到 93/288 |

当前重点剩余：

1. 本地启动 1280px/窄屏行布局仍需直接布局或浏览器验证后再关闭。
2. MCP/我的数据相关 smoke 项仍需继续用前端/Rust/desktop smoke 绑定后关闭。
3. 插件生态仍剩完整运行时权限隔离、证书链/吊销/平台级签名策略、更广第三方视觉截图和 side-effecting native bridge replay。
4. 发布侧仍剩签名、公证、自动更新配置。

## Batch 289：设置页 shell/layout/dialog macOS smoke checklist 闭环

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批聚焦设置页顶部标签、更多菜单、内嵌确认弹窗、整体 shell 尺寸、侧栏、内容区、控件和滚动条：实现和样式测试此前已经具备，但 macOS smoke checklist 仍有多条未勾选；本批补上清单回归约束并同步完成度。

状态：DONE。

修改文件：

- `src/components/SettingsPanel.svelte`
- `scripts/test-settings-header-style.mjs`
- `scripts/test-settings-header-menu.mjs`
- `scripts/test-settings-confirm-dialog.mjs`
- `scripts/test-settings-ztools-scale.mjs`
- `scripts/test-settings-sidebar-style.mjs`
- `scripts/test-settings-content-style.mjs`
- `scripts/test-settings-controls-style.mjs`
- `scripts/test-settings-scrollbar-style.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `test:settings-header-style` 增加 macOS smoke checklist 约束，要求设置页顶部标签、ZTools 风格外壳、小/大三笔画圆形 Z 标识和顶部尺寸 smoke 项保持 `[x]`。
- `test:settings-header-menu` 增加 macOS smoke checklist 约束，要求顶部三点更多菜单、复制运行信息状态、Esc 只关闭菜单、回到主搜索 smoke 项保持 `[x]`。
- `test:settings-confirm-dialog` 增加 macOS smoke checklist 约束，要求恢复默认、清空历史/审计/插件数据/崩溃日志、WebDAV 恢复/导入剪贴板等危险操作走内嵌确认弹窗，且没有浏览器原生 `confirm`。
- `test:settings-ztools-scale` 补强 ShellFrame/App/SettingsPanel 断言，要求 `SETTINGS_WINDOW_HEIGHT = 860`、`targetHeight={getShellHeight()}`、`height:min(100vh,var(--shell-target-height))`、SettingsPanel `height:100%` 和 `overflow:hidden`。
- `test:settings-sidebar-style` / `test:settings-content-style` / `test:settings-controls-style` / `test:settings-scrollbar-style` 增加 macOS smoke checklist 约束，要求侧栏、内容区、桌面控件和滚动条 smoke 项保持 `[x]`。
- 红灯过程中 `test:settings-controls-style` 暴露窄屏输入/下拉控件缺少 `max-width:100%`；`src/components/SettingsPanel.svelte` 在 720px media block 内补上该约束，避免窄视口控件横向溢出。
- `docs/macos-smoke-checklist.md` 将已验证的设置页 shell/layout/menu/dialog 9 条标记为完成；首页 Z 图标、固定项状态栏、本地启动窄屏行布局、通用设置、MCP/我的数据项仍保持未勾选。

TDD 记录：

- 先扩展 8 个设置页样式/菜单/确认弹窗测试脚本，要求已验证的 Settings shell/layout/dialog smoke checklist 项为 `[x]`。
- 首次运行 `pnpm test:settings-header-style` 先暴露测试断言误写为 `middle`，当前三笔画中段真实类名为 `diagonal`；修正后红灯落到 smoke checklist 未勾选。
- 首次运行 `pnpm test:settings-header-menu` 红灯，失败在顶部三点更多菜单 smoke 项仍为 `[ ]`。
- 首次运行 `pnpm test:settings-confirm-dialog` 红灯，失败在内嵌确认弹窗 smoke 项仍为 `[ ]`。
- 首次运行 `pnpm test:settings-ztools-scale` 红灯，失败在 860px 响应式 shell smoke 项仍为 `[ ]`。
- 首次运行 `pnpm test:settings-sidebar-style`、`test:settings-content-style`、`test:settings-scrollbar-style` 红灯，失败在对应 smoke 项仍为 `[ ]`。
- 首次运行 `pnpm test:settings-controls-style` 先失败在窄屏控件缺少 `max-width:100%`；补 CSS 后红灯落到桌面控件 smoke 项仍为 `[ ]`。
- 更新 `docs/macos-smoke-checklist.md` 后，8 个目标测试均转绿。

验证：

```bash
pnpm test:settings-header-style
pnpm test:settings-header-menu
pnpm test:settings-confirm-dialog
pnpm test:settings-ztools-scale
pnpm test:settings-sidebar-style
pnpm test:settings-content-style
pnpm test:settings-controls-style
pnpm test:settings-scrollbar-style
```

结果：

- `pnpm test:settings-header-style`：通过。
- `pnpm test:settings-header-menu`：通过。
- `pnpm test:settings-confirm-dialog`：通过。
- `pnpm test:settings-ztools-scale`：通过。
- `pnpm test:settings-sidebar-style`：通过。
- `pnpm test:settings-content-style`：通过。
- `pnpm test:settings-controls-style`：通过。
- `pnpm test:settings-scrollbar-style`：通过。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Settings shell and navigation | 87% | 88% | 设置页 shell/layout/dialog smoke 漂移已关闭，并补了窄屏控件 max-width 约束 |
| ZTools 设置页 UI | 99% | 99% | 设置页顶部、左右区、控件、滚动条继续由源码测试守护 |
| 设置项真实功能 | 99% | 99% | 本批只涉及外壳/确认弹窗/布局和窄屏控件约束 |
| 测试与发布 | 99% | 99% | 9 条 macOS smoke checklist 项现在由 targeted style/menu/dialog tests 守护 |
| macOS smoke checklist closure | 25.3% | 28.5% | 从 73/288 提升到 82/288 |

当前重点剩余：

1. 首页 Z 图标进入设置和固定/最近使用状态栏 smoke 仍需 Home/Search 交互证据后再关闭。
2. 本地启动 1280px/窄屏行布局仍需直接布局或浏览器验证后再关闭。
3. 通用设置的最近使用/固定栏行数/主题/主题色/自定义色持久化 smoke 仍需逐项证明。
4. MCP/我的数据相关 smoke 项仍需继续用前端/Rust/desktop smoke 绑定后关闭。
5. 插件生态仍剩完整运行时权限隔离、证书链/吊销/平台级签名策略、更广第三方视觉截图和 side-effecting native bridge replay。
6. 发布侧仍剩签名、公证、自动更新配置。

## Batch 288：快捷键 / 所有指令 / 唤醒黑名单 macOS smoke checklist 闭环

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批聚焦设置页 `快捷键`、`所有指令` 和 `唤醒黑名单`：页面、模型和运行时路径此前已经实现，但 macOS smoke checklist 仍有多条未勾选；本批补上清单回归约束并同步完成度。

状态：DONE。

修改文件：

- `scripts/test-settings-pages.mjs`
- `scripts/test-app-shortcuts.mjs`
- `scripts/test-command-center-settings.mjs`
- `scripts/test-pinned-commands.mjs`
- `scripts/test-wakeup-blacklist.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `test:settings-pages` 增加 macOS smoke checklist 约束，要求快捷键齿轮预设、三 tab 页面、8 个内置应用快捷键、自定义快捷键创建/编辑/冲突提示、指令别名入口和空状态 smoke 项保持 `[x]`。
- `test:settings-pages` 补强模型/UI 断言，要求 hotkey presets 包含 `Option+Z`、`Command+Space`、`Control+Space`，快捷键页包含 `shortcut-tab-bar` 和 summary grid，Space/Tab 内置快捷键文案随设置变化。
- `test:app-shortcuts` 增加 macOS smoke checklist 约束，要求自定义应用快捷键持久化/刷新恢复、主搜索触发和普通可编辑控件保护 smoke 项保持 `[x]`。
- `test:app-shortcuts` 补强 SettingsPanel/App/settings 断言，要求 `appShortcuts` 经设置 snapshot、normalize settings、App runtime、`activateFeature(match.targetCode)` 和 editable target guard 串起来。
- `test:command-center-settings` 增加 macOS smoke checklist 约束，要求所有指令统计卡、来源筛选、目标行详情、启停、搜索/状态筛选 smoke 项保持 `[x]`。
- `test:command-center-settings` 补强源码断言，要求可绑定指令/指令别名/固定指令/来源分组四张统计卡、全部来源、目标行 code/alias chip/action、local/web 启停和系统指令不可停用。
- `test:pinned-commands` 增加 macOS smoke checklist 约束，要求所有指令行级固定/取消固定同步到主搜索首页 smoke 项保持 `[x]`，并覆盖 pinned store、SettingsPanel 派发、App 监听和 HomePanel 固定分区。
- `test:wakeup-blacklist` 增加 macOS smoke checklist 约束，要求 `添加当前窗口` 桌面读取前台应用和 Web 预览禁用提示 smoke 项保持 `[x]`。
- `docs/macos-smoke-checklist.md` 将已验证的快捷键 8 条、所有指令 6 条、唤醒黑名单 1 条标记为完成；未直接验证的设置页响应式布局、通用设置、MCP/我的数据项仍保持未勾选。

TDD 记录：

- 先扩展 `scripts/test-settings-pages.mjs`、`scripts/test-app-shortcuts.mjs`、`scripts/test-command-center-settings.mjs`、`scripts/test-pinned-commands.mjs` 和 `scripts/test-wakeup-blacklist.mjs`，要求已验证 Shortcut / Command Center / Wakeup Blacklist smoke checklist 项为 `[x]`。
- 首次运行 `pnpm test:settings-pages` 红灯，失败在呼出快捷键齿轮 smoke 项仍为 `[ ]`。
- 首次运行 `pnpm test:app-shortcuts` 红灯，失败在自定义应用快捷键持久化/主搜索触发 smoke 项仍为 `[ ]`。
- 首次运行 `pnpm test:command-center-settings` 红灯，失败在所有指令统计卡 smoke 项仍为 `[ ]`。
- 首次运行 `pnpm test:pinned-commands` 红灯，失败在所有指令固定/取消固定 smoke 项仍为 `[ ]`。
- 首次运行 `pnpm test:wakeup-blacklist` 红灯，失败在唤醒黑名单添加当前窗口 smoke 项仍为 `[ ]`。
- 更新 `docs/macos-smoke-checklist.md` 后，五个目标测试均转绿。

验证：

```bash
pnpm test:settings-pages
pnpm test:app-shortcuts
pnpm test:command-center-settings
pnpm test:pinned-commands
pnpm test:wakeup-blacklist
pnpm test:settings-normalization
pnpm test:hotkey-recorder
pnpm test:command-aliases
pnpm test:home-pinned-sections
pnpm check
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:settings-pages`：通过。
- `pnpm test:app-shortcuts`：通过。
- `pnpm test:command-center-settings`：通过。
- `pnpm test:pinned-commands`：通过。
- `pnpm test:wakeup-blacklist`：通过。
- `pnpm test:settings-normalization`：通过。
- `pnpm test:hotkey-recorder`：通过。
- `pnpm test:command-aliases`：通过。
- `pnpm test:home-pinned-sections`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm smoke:tauri-desktop`：通过，desktop smoke reported `status:"ok"`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 99% | 99% | 快捷键、所有指令、唤醒黑名单页面结构和入口已由模型/UI 源码测试守护 |
| 设置项真实功能 | 99% | 99% | 自定义应用快捷键持久化/触发、所有指令 pin/toggle/filter、添加当前窗口已有 targeted tests |
| Home/search experience | 86% | 86% | 自定义快捷键和固定指令继续连接主搜索/HomePanel，本批主要关闭 smoke 漂移 |
| 测试与发布 | 99% | 99% | 15 条 macOS smoke checklist 项现在由 targeted tests、`pnpm check` 和 desktop smoke 守护 |
| macOS smoke checklist closure | 20.1% | 25.3% | 从 58/288 提升到 73/288 |

当前重点剩余：

1. 设置页 860px/低视口、侧栏/内容区、控件、滚动条、本地启动 1280px/窄屏等布局项仍需直接布局或浏览器验证后再关闭。
2. 通用设置的最近使用/固定栏行数/主题/主题色/自定义色持久化 smoke 仍需逐项证明。
3. MCP/我的数据相关 smoke 项仍需继续用前端/Rust/desktop smoke 绑定后关闭。
4. 插件生态仍剩完整运行时权限隔离、证书链/吊销/平台级签名策略、更广第三方视觉截图和 side-effecting native bridge replay。
5. 发布侧仍剩签名、公证、自动更新配置。

## Batch 287：网页快开 / 本地启动 macOS smoke checklist 闭环

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批聚焦设置页 `网页快开` 和 `本地启动`：两块页面、模型和搜索入口此前已经实现，但 macOS smoke checklist 仍有多条未勾选；本批补上清单回归约束并同步完成度。

状态：DONE。

修改文件：

- `scripts/test-web-quick-open-overview.mjs`
- `scripts/test-web-quick-open-settings.mjs`
- `scripts/test-local-launch-settings.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `test:web-quick-open-overview` 增加 macOS smoke checklist 约束，要求网页快开卡片列表 smoke 项保持 `[x]`。
- `test:web-quick-open-overview` 补强默认项和布局断言，要求默认入口为 Google/GitHub/NPM，卡片包含关键字 chip、URL 预览、行级动作，并要求 URL 预览使用 `overflow-wrap:anywhere` 和 `word-break:break-word` 避免横向溢出。
- `test:web-quick-open-settings` 增加 macOS smoke checklist 约束，要求网页快开编辑器和校验/删除确认 smoke 项保持 `[x]`。
- `test:web-quick-open-settings` 补强源码断言，要求编辑器支持搜索模板/固定网址切换、字段编辑、URL 预览、保存、取消、Esc 关闭和 `validateWebQuickOpenEntry` 校验委托。
- `test:local-launch-settings` 增加 macOS smoke checklist 约束，要求本地启动选择/行级动作和删除确认 smoke 项保持 `[x]`。
- `test:local-launch-settings` 补强源码断言，要求文件/文件夹/应用选择器、Web 预览禁用状态、拖拽添加、手动添加、打开/定位/删除、删除确认、添加/删除持久化路径保持可回归；同时修正旧断言以匹配当前 `openDialog/saveDialog` 共同 import 形态。
- `docs/macos-smoke-checklist.md` 将已验证的网页快开 3 条和本地启动 2 条标记为完成；本地启动 1280px/窄屏布局项仍保持未勾选。

TDD 记录：

- 先扩展 `scripts/test-web-quick-open-overview.mjs`、`scripts/test-web-quick-open-settings.mjs` 和 `scripts/test-local-launch-settings.mjs`，要求已验证 quick-open/local-launch smoke checklist 项为 `[x]`。
- 首次运行 `pnpm test:web-quick-open-overview` 红灯，失败在网页快开卡片列表 smoke 项仍为 `[ ]`。
- 首次运行 `pnpm test:web-quick-open-settings` 红灯，失败在网页快开编辑器 smoke 项仍为 `[ ]`。
- 首次运行 `pnpm test:local-launch-settings` 先暴露旧 import 断言已不匹配当前 `openDialog/saveDialog` 形态；修正后红灯落到本地启动 smoke 项仍为 `[ ]`。
- 更新 `docs/macos-smoke-checklist.md` 后，三个测试均转绿。

验证：

```bash
pnpm test:web-quick-open-overview
pnpm test:web-quick-open-settings
pnpm test:local-launch-settings
pnpm test:web-quick-open
pnpm test:local-launch
pnpm test:local-launch-overview
pnpm check
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:web-quick-open-overview`：通过。
- `pnpm test:web-quick-open-settings`：通过。
- `pnpm test:local-launch-settings`：通过。
- `pnpm test:web-quick-open`：通过。
- `pnpm test:local-launch`：通过。
- `pnpm test:local-launch-overview`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm smoke:tauri-desktop`：通过，desktop smoke reported `status:"ok"`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 99% | 99% | 网页快开卡片/编辑器和本地启动选择/列表 UI 已由模型/源码测试守护 |
| 设置项真实功能 | 99% | 99% | 网页快开校验/搜索、本地启动搜索/路径解析/桌面入口已有 targeted tests |
| Home/search experience | 86% | 86% | 网页快开和本地启动搜索匹配已继续由模型测试覆盖，本批主要关闭设置页 smoke 漂移 |
| 测试与发布 | 99% | 99% | quick-open/local-launch smoke checklist 现在由前端模型/UI 源码断言和 desktop smoke 守护 |

当前重点剩余：

1. 本地启动 1280px/窄屏布局 smoke 仍需直接布局或浏览器验证后再关闭。
2. macOS smoke checklist 中仍有快捷键、所有指令、MCP/我的数据人工项等未勾选项，需要继续逐项证明后关闭。
3. 插件生态仍剩完整运行时权限隔离、证书链/吊销/平台级签名策略、更广第三方视觉截图和 side-effecting native bridge replay。
4. 发布侧仍剩签名、公证、自动更新配置。

## Batch 286：调试日志 macOS smoke checklist 闭环

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批聚焦设置页 `调试日志`：页面、诊断包和桌面 data/debug smoke 已经实现，但 macOS smoke checklist 仍有两条未勾选；本批补上清单回归约束并同步完成度。

状态：DONE。

修改文件：

- `scripts/test-debug-settings-overview.mjs`
- `scripts/test-debug-diagnostics.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `test:debug-settings-overview` 增加 macOS smoke checklist 约束，要求 `调试日志` 页面 smoke 项保持 `[x]`。
- `test:debug-settings-overview` 补强 SettingsPanel 源码断言，要求调试页显示环境信息、桌面运行状态、本地配置状态、MCP 状态、崩溃日志、最近审计错误，并要求 `复制信息` 绑定到 `copyDebugInfo`。
- `test:debug-diagnostics` 增加 macOS smoke checklist 约束，要求 `复制信息` 诊断包 smoke 项保持 `[x]`。
- `test:debug-diagnostics` 补强复制内容断言，要求 `diagnosticBundleText()` 输出包含 `atools_diagnostic_bundle`，且不包含 MCP token、AI API Key、WebDAV 密码和 proxy 凭据。
- 现有 Debug 模型测试继续覆盖 runtime overview、local data diagnostics、audit error summaries、crash log summaries、diagnostic warnings 和 `proxyUrl` 脱敏。
- `docs/macos-smoke-checklist.md` 将已验证的 `调试日志` 页面和 `复制信息` 脱敏诊断包项标记为完成。

TDD 记录：

- 先扩展 `scripts/test-debug-settings-overview.mjs` 和 `scripts/test-debug-diagnostics.mjs`，要求已验证 Debug Log smoke checklist 项为 `[x]`。
- 首次运行 `pnpm test:debug-settings-overview` 红灯，失败在 `调试日志` 页面 smoke 项仍为 `[ ]`。
- 首次运行 `pnpm test:debug-diagnostics` 红灯，失败在 `复制信息` 诊断包 smoke 项仍为 `[ ]`。
- 更新 `docs/macos-smoke-checklist.md` 后，两个测试均转绿。

验证：

```bash
pnpm test:debug-settings-overview
pnpm test:debug-diagnostics
cargo test -p atools commands::tests::runtime_diagnostics_snapshot_reports_paths_counts_mcp_and_events
cargo test -p atools --test crash_tests
pnpm check
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:debug-settings-overview`：通过。
- `pnpm test:debug-diagnostics`：通过。
- `cargo test -p atools commands::tests::runtime_diagnostics_snapshot_reports_paths_counts_mcp_and_events`：1 passed。
- `cargo test -p atools --test crash_tests`：3 passed。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm smoke:tauri-desktop`：通过，desktop smoke reported `status:"ok"`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 99% | 99% | 调试日志页的环境、运行时、本地配置、MCP、崩溃和审计错误信息已由源码/模型测试守护 |
| 设置项真实功能 | 99% | 99% | 诊断包复制、runtime diagnostics、crash log 读取/复制/清空已有前端/Rust/desktop smoke 覆盖 |
| 测试与发布 | 99% | 99% | Debug Log smoke checklist 现在由前端模型/UI 源码断言、Rust runtime/crash tests 和 desktop data_debug_smoke 守护 |

当前重点剩余：

1. macOS smoke checklist 中仍有快捷键、所有指令、网页快开、本地启动、MCP/我的数据人工项等未勾选项，需要继续逐项证明后关闭。
2. 插件生态仍剩完整运行时权限隔离、证书链/吊销/平台级签名策略、更广第三方视觉截图和 side-effecting native bridge replay。
3. 发布侧仍剩签名、公证、自动更新配置。

## Batch 285：WebDAV macOS smoke checklist 闭环

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批聚焦设置页 `WebDAV 同步`：远端备份上传、预览、恢复计划、设置恢复、剪贴板/插件数据导入能力此前已经实现并有测试，但 macOS smoke checklist 仍有多项未勾选；本批补上清单回归约束并同步完成度。

状态：DONE。

修改文件：

- `scripts/test-webdav-sync-view.mjs`
- `scripts/test-webdav-settings-overview.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `test:webdav-sync-view` 增加 macOS smoke checklist 约束，要求 WebDAV Web 预览按钮保护、桌面同步结果、远端预览、恢复计划、设置恢复、剪贴板导入、内嵌确认和当前能力范围项保持 `[x]`。
- `test:webdav-sync-view` 追加 `检查远端备份` 和 `生成恢复计划` Web 预览禁用文案断言，避免只覆盖桌面可用态。
- `test:webdav-settings-overview` 增加 WebDAV 页面源码断言，覆盖服务器地址、用户名、密码/Token、远端目录、同步范围、同步状态、http/https URL 启用门槛、空配置开关禁用且未选中、本地凭据说明、preview 只读说明、脱敏字段保留和剪贴板追加导入说明。
- `test:webdav-settings-overview` 增加确认弹窗顺序断言，要求恢复设置、导入剪贴板和导入插件数据都先调用 `confirmSettingsAction`，确认后才 invoke native 命令，取消时只写取消状态。
- Rust WebDAV targeted tests 覆盖上传+manifest 校验、远端预览只读、恢复计划 diff、设置恢复确认+跳过 `<redacted>`、剪贴板确认+追加导入，以及插件数据追加导入冲突跳过。
- `docs/macos-smoke-checklist.md` 将已验证的 WebDAV 设置、同步、预览、恢复计划、设置恢复、剪贴板导入、确认流和能力范围项标记为完成。

TDD 记录：

- 先扩展 `scripts/test-webdav-sync-view.mjs` 和 `scripts/test-webdav-settings-overview.mjs`，要求已验证 WebDAV smoke checklist 项为 `[x]`。
- 首次运行 `pnpm test:webdav-sync-view` 红灯，失败在 `立即同步` smoke 项仍为 `[ ]`。
- 首次运行 `pnpm test:webdav-settings-overview` 红灯，失败在 WebDAV 设置页 smoke 项仍为 `[ ]`。
- 更新 `docs/macos-smoke-checklist.md` 后，两个测试均转绿。

验证：

```bash
pnpm test:webdav-sync-view
pnpm test:webdav-settings-overview
cargo test -p atools --test webdav_tests
cargo test -p atools commands::settings_command_tests::webdav_clipboard_import_appends_missing_entries_without_touching_existing_text
cargo test -p atools commands::settings_command_tests::webdav_plugin_data_restore_imports_missing_docs_and_skips_conflicts
pnpm check
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:webdav-sync-view`：通过。
- `pnpm test:webdav-settings-overview`：通过。
- `cargo test -p atools --test webdav_tests`：9 passed。
- `cargo test -p atools commands::settings_command_tests::webdav_clipboard_import_appends_missing_entries_without_touching_existing_text`：1 passed。
- `cargo test -p atools commands::settings_command_tests::webdav_plugin_data_restore_imports_missing_docs_and_skips_conflicts`：1 passed。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm smoke:tauri-desktop`：通过，desktop smoke reported `status:"ok"`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 99% | 99% | WebDAV 页面字段、状态卡、同步范围、操作按钮和结果区已由源码/模型测试守护 |
| 设置项真实功能 | 99% | 99% | WebDAV 上传、预览、恢复计划、设置恢复、剪贴板追加导入和插件数据导入已有 Rust targeted tests |
| 测试与发布 | 99% | 99% | WebDAV smoke checklist 现在由前端模型/UI 源码断言、Rust 集成测试和 desktop smoke 守护 |

当前重点剩余：

1. WebDAV 仍不支持“远端覆盖本机全部数据”，当前能力边界保持显式记录。
2. macOS smoke checklist 中仍有快捷键、调试日志、Agent/MCP 人工项等未勾选项，需要继续逐项证明后关闭。
3. 插件生态仍剩完整运行时权限隔离、证书链/吊销/平台级签名策略、更广第三方视觉截图和 side-effecting native bridge replay。
4. 发布侧仍剩签名、公证、自动更新配置。

## Batch 284：已安装插件 macOS smoke checklist 闭环

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批聚焦设置页 `已安装插件`：本地插件管理能力此前已经实现并有模型/UI/后端测试，但 macOS smoke checklist 仍未勾选；本批补上清单回归约束并同步完成度。

状态：DONE。

修改文件：

- `scripts/test-plugin-inventory.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `test:plugin-inventory` 增加 macOS smoke checklist 约束，要求 6 条 `已安装插件` 管理项保持 `[x]`。
- 共享 inventory 模型覆盖插件总数、启用/停用数量、feature 数量、来源标记、feature 预览、关键词/状态/来源筛选、空态和选中插件 fallback。
- 插件详情模型覆盖名称、状态、版本/来源、更新时间、描述、路径、feature 明细、导入/内置插件动作差异，以及 main/preload、feature 匹配、Agent tools、manifest permissions 和本地数据边界审计。
- SettingsPanel 回归覆盖桌面端目录安装、Web 预览安装保护、Finder 定位、本地同 ID 更新、授权启用、导入插件卸载确认、插件权限/能力审计展开、持久运行时授权查看与清除。
- Rust targeted test 覆盖本地同 ID 更新会保留启停状态，并拒绝从当前安装目录或重叠目录更新。
- `docs/macos-smoke-checklist.md` 将 6 条已安装插件管理项标记为完成。

TDD 记录：

- 先扩展 `scripts/test-plugin-inventory.mjs`，要求已安装插件 smoke checklist 6 项为 `[x]`。
- 首次运行 `pnpm test:plugin-inventory` 红灯，失败在 `已安装插件` 页面仍是 `[ ]`。
- 更新 `docs/macos-smoke-checklist.md` 后，`pnpm test:plugin-inventory` 转绿。

验证：

```bash
pnpm test:plugin-inventory
pnpm test:plugin-inventory-overview
cargo test -p atools plugin_update_from_path_replaces_same_plugin_and_rejects_installed_source
pnpm check
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-inventory`：通过。
- `pnpm test:plugin-inventory-overview`：通过。
- `cargo test -p atools plugin_update_from_path_replaces_same_plugin_and_rejects_installed_source`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm smoke:tauri-desktop`：通过。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入 | 99% | 99% | 已安装插件管理 smoke checklist 从未勾选变为已验证并回归守护 |
| ZTools 设置页 UI | 99% | 99% | 插件库存概览、筛选、详情和权限审计页面保持已实现 |
| 设置项真实功能 | 99% | 99% | 本地目录安装/更新、目录定位、卸载确认和授权启用链路已有测试覆盖 |
| 测试与发布 | 99% | 99% | 已安装插件 smoke checklist 现在由前端模型/UI测试、Rust targeted test 和 desktop smoke 守护 |

当前重点剩余：

1. macOS smoke checklist 中仍有 WebDAV、快捷键、调试日志、Agent/MCP 人工项等未勾选项，需要继续逐项证明后关闭。
2. 插件生态仍剩完整运行时权限隔离、证书链/吊销/平台级签名策略、更广第三方视觉截图和 side-effecting native bridge replay。
3. 发布侧仍剩签名、公证、自动更新配置。

## Batch 283：AI 模型 macOS smoke checklist 闭环

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批聚焦设置页 `AI 模型`：实现和后端测试此前已经具备，但 macOS smoke checklist 仍停留在未勾选状态；本批补上清单回归约束并同步完成度。

状态：DONE。

修改文件：

- `scripts/test-ai-settings-overview.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `test:ai-settings-overview` 增加 macOS smoke checklist 约束，要求 6 条 AI 模型项保持 `[x]`。
- AI 页面现有回归仍覆盖 `AI 模型概览`、模型提供商、默认模型、`Agent 默认`、连接状态、连接测试隐私文案和 API Key 本地保存文案。
- `test:ai-connection-view` 覆盖 Web 预览下 `测试连接` 禁用并提示 `需在桌面应用中测试 AI 连接`，以及 `/models` 结果行展示连接、模型、模型列表和耗时。
- Rust command 测试覆盖 AI 连接测试只请求 `/v1/models`，并携带 Bearer token 到本地假服务。
- Rust Agent 工具测试覆盖 `ask_ai_model` 使用 `settings-general` 中保存的 Agent AI 配置请求 `/v1/chat/completions`，包含 system/user messages、temperature、max_tokens，并且工具输出不暴露 API key。
- `docs/macos-smoke-checklist.md` 将 AI 模型页面、provider 切换、Web 预览禁用、桌面 `/models` 连接测试、隐私边界和 `ask_ai_model` chat completions 路径标记为完成。

TDD 记录：

- 先扩展 `scripts/test-ai-settings-overview.mjs`，要求 AI 模型 smoke checklist 6 项为 `[x]`。
- 首次运行 `pnpm test:ai-settings-overview` 红灯，失败在 `AI 模型` 页面仍是 `[ ]`。
- 更新 `docs/macos-smoke-checklist.md` 后，`pnpm test:ai-settings-overview` 转绿。

验证：

```bash
pnpm test:ai-settings-overview
pnpm test:ai-connection-view
cargo test -p atools --test agent_tools_tests ask_ai_model_posts_chat_completion_using_agent_settings
cargo test -p atools commands::settings_command_tests::ai_connection_test_fetches_models_and_reports_selected_model
pnpm check
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:ai-settings-overview`：通过。
- `pnpm test:ai-connection-view`：通过。
- `cargo test -p atools --test agent_tools_tests ask_ai_model_posts_chat_completion_using_agent_settings`：通过。
- `cargo test -p atools commands::settings_command_tests::ai_connection_test_fetches_models_and_reports_selected_model`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm smoke:tauri-desktop`：通过。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 99% | 99% | AI 模型页面从 checklist 未勾选变为已验证并回归守护 |
| 设置项真实功能 | 99% | 99% | `/models` 测试和 `ask_ai_model` Agent 默认配置链路已由 Rust 测试覆盖 |
| Agent/MCP 底座 | 99% | 99% | `ask_ai_model` 使用本地设置、权限/审计链路仍按现有 MCP 工具执行 |
| 测试与发布 | 99% | 99% | AI 模型 smoke checklist 现在由前端和 Rust targeted tests 守护 |

当前重点剩余：

1. macOS smoke checklist 中仍有快捷键、WebDAV、已安装插件、调试日志等未勾选项，需要继续逐项证明后关闭。
2. AI 模型本批不验证真实第三方 provider 凭证、streaming chat completions 或更多 MCP 客户端长链路。
3. 插件生态仍剩证书链/吊销/平台级签名策略、完整 iframe sandbox/cross-origin capability isolation、更广样本视觉截图和 side-effecting native bridge replay。
4. 发布侧仍剩签名、公证、自动更新配置。

## Batch 282：关于页 macOS smoke checklist 闭环

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批不扩大插件面，先收口设置页 `关于` 已实现能力和 macOS smoke checklist 之间的漂移，让已验证的 About 页面不再停留在未勾选状态。

状态：DONE。

修改文件：

- `scripts/test-about-settings.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `test:about-settings` 从松散源码 marker 检查扩展为清单约束：macOS smoke checklist 中四条 `关于` 页面项必须为 `[x]`。
- About 运行信息复制路径增加回归约束：复制 JSON 中 MCP token 必须写成 `<hidden>`，不能包含明文 token。
- About 诊断入口增加回归约束：`打开 MCP 服务` 必须直接把 `activeMenu` 切到 `mcp` 设置页，确保左侧菜单选中 MCP 服务并显示客户端配置复制入口。
- `docs/macos-smoke-checklist.md` 将四条已由源码和测试覆盖的 About 项标记为完成：产品事实/运行信息、本地环境行、复制与排障入口、MCP 服务跳转。

TDD 记录：

- 先修改 `scripts/test-about-settings.mjs`，要求 About smoke checklist 四条为 `[x]`。
- 首次运行 `pnpm test:about-settings` 红灯，失败点为 `关于` 页非空/产品事实项仍是 `[ ]`。
- 更新 `docs/macos-smoke-checklist.md` 后，`pnpm test:about-settings` 转绿。

验证：

```bash
pnpm test:about-settings
pnpm test:about-overview
```

结果：

- `pnpm test:about-settings`：通过。
- `pnpm test:about-overview`：通过。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 99% | 99% | About 页面此前已实现，本批关闭 smoke checklist 漂移并增加回归约束 |
| 设置项真实功能 | 99% | 99% | About 复制运行信息和 MCP 服务跳转保持已实现状态 |
| 测试与发布 | 99% | 99% | About smoke checklist 现在由 `test:about-settings` 守护 |

当前重点剩余：

1. macOS smoke checklist 中仍有快捷键、WebDAV、已安装插件、AI 手工流等未勾选项，需要逐项用源码/测试/真实 smoke 证明后再关闭。
2. 插件生态仍剩证书链/吊销/平台级签名策略、完整 iframe sandbox/cross-origin capability isolation、更广样本视觉截图和 side-effecting native bridge replay。
3. 发布侧仍剩签名、公证、自动更新配置。

## Batch 281：真实 Tauri native context scope 与 large-srcdoc probe hardening

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批接上 Batch 280 的 native/system method probe，修掉真实 Tauri runtime 暴露出的两个硬化点：AppleScript bridge 在 Tauri shell capability 层没有 scoped command，以及大入口 `srcdoc` 用固定 2.5s probe timeout 容易误判。

状态：DONE。

修改文件：

- `src-tauri/capabilities/default.json`
- `src/components/PluginPanel.svelte`
- `scripts/test-tauri-desktop-smoke-script.mjs`
- `scripts/test-plugin-host-view.mjs`
- `docs/ui-ztools-restore-checklist.md`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `shell:allow-execute` 现在以 scoped permission object 形式允许一个命名 `osascript` command，实际命令为 `osascript`，参数限定为 `["-e", { "validator": "(?s).+" }]`。
- 真实 desktop smoke 不再打印 `Scoped command osascript not found`；PluginPanel 的 browser/Finder context、shell trash/beep、hide/type/paste 等现有 AppleScript 路径不再被 Tauri capability lookup 直接拒绝。
- `PluginPanel` 新增 `desktopSmokeBridgeProbeTimeoutMs(iframeSrcdocBytes)`，probe wait 预算从固定 2500ms 改为按最终 `srcdoc` 字节数计算，最小 2500ms，最大 15000ms。
- `loadPluginHtml()` 把最终 `html.length` 传入 `waitForDesktopSmokeBridgeProbe()`，大外部入口在解析、执行注入探针和等待 async native method probes 时有更合理的预算。

TDD / Debug 记录：

- 先扩展 `node scripts/test-tauri-desktop-smoke-script.mjs`，红灯失败在缺少 scoped shell execute permission。
- 初次实现为 `shell:scope` 后，真实 `pnpm smoke:tauri-desktop` 构建失败并提示 `Permission shell:scope not found`；据 Tauri 生成 schema 修正为 scoped `shell:allow-execute` permission object。
- 修正后 `node scripts/test-tauri-desktop-smoke-script.mjs` 转绿，真实 standard smoke 通过且不再出现 `Scoped command osascript not found`。
- 外部 plan smoke 曾复现 `ztools-developer-plugin` 5.2MB `srcdoc` 在固定 2.5s 下 probe timeout；先扩展 `pnpm test:plugin-host-view` 要求 dynamic timeout，再实现 size-based wait budget。

验证：

```bash
node scripts/test-tauri-desktop-smoke-script.mjs
pnpm test:plugin-host-view
pnpm check
pnpm smoke:tauri-desktop
ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop
```

结果：

- 标准 smoke：`plugin_panel_render_smoke` 1/1 rendered，5/5 bridge checks，4/4 native method checks；日志不再出现 `Scoped command osascript not found`。
- 外部 plan smoke：10 planned、8 imported、8 activated、8 ui actions checked、8 `plugin_panel_fs_load_checked`、8 assertions checked、8 cleanup verified、2 skipped；`plugin_panel_render_smoke` 6/6 rendered，30/30 bridge checks，24/24 native method checks；日志不再出现 `Scoped command osascript not found`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Tauri/Rust 桌面底座 | 97% | 97% | AppleScript bridge 命令进入 Tauri scoped shell capability，不再停在 scope lookup |
| 插件 iframe 宿主 | 99% | 99% | 大 `srcdoc` 真实入口 probe wait 更稳，减少外部样本误判 |
| 插件运行态 | 99% | 99% | context/shell AppleScript 路径更接近真实可执行状态 |
| 测试与发布 | 99% | 99% | smoke parser/capability guard、PluginPanel static guard、standard/external desktop smoke 均覆盖本批变化 |

当前重点剩余：

1. 插件生态：补逐插件视觉截图、plugin-authored interaction replay、side-effecting native bridge coverage。
2. 插件隔离：完整 iframe sandbox/cross-origin capability isolation 和 BrowserWindow 子 iframe same-origin 兼容债仍需专项收口。
3. 安装发布：证书链/吊销/平台级签名策略、macOS 签名/公证/自动更新仍未完成。

## Batch 280：真实 Tauri PluginPanel native/system method probe smoke

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批接上 Batch 279 的 iframe bridge probe queue，在真实 Tauri `PluginPanel` iframe 内增加 no-side-effect native/system method probes，并把独立 `native_method_probe_*` 聚合字段纳入 desktop smoke 成败条件。

状态：DONE。

修改文件：

- `src-tauri/src/desktop_smoke.rs`
- `src/components/PluginPanel.svelte`
- `scripts/smoke-tauri-desktop.mjs`
- `scripts/test-tauri-desktop-smoke-script.mjs`
- `scripts/test-plugin-host-view.mjs`
- `docs/ui-ztools-restore-checklist.md`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `PluginPanel` 保留已有 5 个同步 bridge probes，并新增独立 `nativeMethodProbes` 数组。
- 新探针从 sandboxed plugin iframe 内执行 `utools.getPath("home")`、`utools.desktopCaptureSources({ types:["screen"] })`、`utools.readCurrentBrowserUrl()` 和 `utools.readCurrentFolderPath()`。
- `PluginPanel` 在 smoke 模式下只对固定低风险权限 `system.path`、`screen.desktopCaptureSources`、`context.browser`、`context.finder` 做即时授权，避免自动化被运行时权限弹窗卡住；普通运行时权限行为不变。
- `plugin_panel_render_smoke` 新增并强制校验 `native_method_probe_expected_samples`、`native_method_probe_reported_samples`、`native_method_probe_passed_samples`、`native_method_probe_checks`、`native_method_probe_passed_checks`、`native_method_probe_failed_ids`。
- browser/Finder context probe 接受真实字符串、空值，或明确 method-scoped bridge/native 错误；当前 Tauri shell scope 下 `osascript` 未列入 scope 时也会以明确错误语义通过，不计作静默成功。

TDD / Debug 记录：

- 先扩展 parser fixture 和 required fields，要求 CLI smoke 输出 `native_method_probe_*` 字段。
- 先扩展 `pnpm test:plugin-host-view`，红灯失败在缺少 `nativeMethodProbes`、`nativeMethodProbePassed` 和 native probe IDs。
- 先扩展 Rust summary 测试，红灯失败在缺少 `native_method_probe_*` summary/report 字段。
- 实现后目标测试转绿，真实 standard smoke 和 external plan smoke 均通过。

验证：

```bash
node scripts/test-tauri-desktop-smoke-script.mjs
pnpm test:plugin-host-view
pnpm check
cargo fmt --check
cargo test -p atools desktop_smoke
pnpm smoke:tauri-desktop
ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop
```

结果：

- 标准 smoke：`plugin_panel_render_smoke` 1/1 rendered，5/5 bridge checks，4/4 native method checks。
- 外部 plan smoke：10 planned、8 imported、8 activated、8 ui actions checked、8 `plugin_panel_fs_load_checked`、8 assertions checked、8 cleanup verified、2 skipped；`plugin_panel_render_smoke` 6/6 rendered，30/30 bridge checks，24/24 native method checks。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入 | 99% | 99% | 外部 plan render queue 现在覆盖 no-side-effect native/system method probes |
| 插件 iframe 宿主 | 99% | 99% | 真实 Tauri iframe 内已验证 bridge basics + native method path；完整 sandbox 隔离和 side-effecting native replay 仍是后续边界 |
| 插件运行态 | 99% | 99% | 标准 indexed sample 和外部 plan samples 都纳入 native method probe 汇总 |
| 测试与发布 | 99% | 99% | desktop smoke parser、frontend static probe、Rust summary、真实 standard/external smoke 全部通过 |

当前重点剩余：

1. 插件生态：补逐插件视觉截图、plugin-authored interaction replay、side-effecting native bridge coverage。
2. 插件隔离：完整 iframe sandbox/cross-origin capability isolation 和 BrowserWindow 子 iframe same-origin 兼容债仍需专项收口。
3. 安装发布：证书链/吊销/平台级签名策略、macOS 签名/公证/自动更新仍未完成。

## Batch 279：真实 Tauri PluginPanel iframe bridge probe smoke

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批接上 Batch 278 的外部 activation plan render queue，在真实 Tauri `PluginPanel` iframe 内执行 smoke-only bridge probe，并把探针结果纳入 desktop smoke 成败条件。

状态：DONE。

修改文件：

- `src-tauri/src/desktop_smoke.rs`
- `src/components/PluginPanel.svelte`
- `scripts/smoke-tauri-desktop.mjs`
- `scripts/test-tauri-desktop-smoke-script.mjs`
- `scripts/test-plugin-host-view.mjs`
- `docs/ui-ztools-restore-checklist.md`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `PluginPanel` 在 desktop smoke 模式下向真实 filesystem `srcdoc` 注入 `__atools_desktop_smoke_bridge_probe__` 探针。
- 探针在 sandboxed plugin iframe 内检查 `window.utools` / `window.ztools` alias、`getWindowType()`、app identity、`dbStorage` roundtrip 和 platform flags。
- `PluginPanel` 等待每个样本的 bridge probe 回传后再调用 `report_plugin_panel_render_smoke`，避免 action queue 提前切换导致探针归属不明。
- `plugin_panel_render_smoke` 新增并强制校验 `bridge_probe_expected_samples`、`bridge_probe_reported_samples`、`bridge_probe_passed_samples`、`bridge_probe_checks`、`bridge_probe_passed_checks`、`bridge_probe_failed_ids`。
- 修复 summary merge 的 partial-progress 错误：队列未完成时不写入 error，只有最终 snapshot 才报告缺失 probe 样本。

TDD / Debug 记录：

- 先扩展 parser fixture 和 required fields，要求 CLI smoke 输出 `bridge_probe_*` 字段。
- 先扩展 `pnpm test:plugin-host-view`，红灯失败在缺少 `__atools_desktop_smoke_bridge_probe__`、`waitForDesktopSmokeBridgeProbe` 和 bridge report 字段。
- 先扩展 Rust summary 测试，红灯失败在缺少 `bridge_probe_*` summary/report 字段。
- 外部 plan smoke 初次运行后发现真实 bug：样本和 checks 已通过，但 summary error 保留了中间 partial progress。新增 `plugin_panel_render_smoke_summary_keeps_partial_bridge_probe_progress_error_free` 复现后修复。

验证：

```bash
node scripts/test-tauri-desktop-smoke-script.mjs
pnpm test:plugin-host-view
pnpm check
cargo fmt --check
cargo test -p atools desktop_smoke
ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop
pnpm smoke:tauri-desktop
```

结果：

- `node scripts/test-tauri-desktop-smoke-script.mjs`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `cargo fmt --check`：通过。
- `cargo test -p atools desktop_smoke`：12 passed。
- `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop`：通过，`status:"ok"`；外部 activation summary 为 10 planned、8 imported、8 activated、8 UI actions checked、8 PluginPanel FS load specs checked、8 assertions checked、8 cleanup verified、2 skipped；`plugin_panel_render_smoke` 为 `expected_samples:7`、`reported_samples:7`、`rendered_samples:7`、`external_plan_expected_samples:7`、`external_plan_rendered_samples:7`、`bridge_probe_expected_samples:7`、`bridge_probe_reported_samples:7`、`bridge_probe_passed_samples:7`、`bridge_probe_checks:35`、`bridge_probe_passed_checks:35`、`bridge_probe_failed_ids:[]`。
- `pnpm smoke:tauri-desktop`：通过，标准路径保持 `expected_samples:1`、`reported_samples:1`、`rendered_samples:1`，并验证 `bridge_probe_checks:5`、`bridge_probe_passed_checks:5`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 99% | 99% | 真实 Tauri `srcdoc` iframe 内基础 `utools/ztools` bridge probe 已纳入标准和外部 plan smoke |
| 插件安装/导入 | 99% | 99% | 外部 activation plan 覆盖从导入/激活/FS spec/render 推进到 7 个可渲染样本的 iframe bridge probe |
| 测试与发布 | 99% | 99% | desktop smoke 输出新增 bridge probe gate，Rust summary 增加 partial-progress 回归测试 |

当前重点剩余：

1. 插件兼容：补外部样本逐插件视觉截图、真实交互回放和 native/system bridge method probe 全样本执行。
2. 插件安全：证书链/吊销/平台级签名策略、完整 iframe sandbox/cross-origin capability isolation。
3. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 278：外部 activation plan PluginPanel 渲染队列 smoke

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批接上 Batch 277 的真实 Tauri 单插件 PluginPanel render smoke，把外部 activation plan 也纳入真实前端 PluginPanel 文件系统渲染回传。

状态：DONE。

修改文件：

- `src-tauri/src/desktop_smoke.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/capabilities/default.json`
- `src-tauri/gen/schemas/capabilities.json`
- `src/App.svelte`
- `src/components/PluginPanel.svelte`
- `scripts/smoke-tauri-desktop.mjs`
- `scripts/test-tauri-desktop-smoke-script.mjs`
- `scripts/test-plugin-host-view.mjs`
- `docs/ui-ztools-restore-checklist.md`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 `desktop_smoke_plugin_panel_actions`，让前端 smoke 获取 action 队列而不是单个 action。
- 当 `ATOOLS_ZTOOLS_ACTIVATION_PLAN` 存在时，后端读取 plan、导入有效样本到 `/tmp/atools-ztools-plugin-smoke`、激活对应 feature，并返回可形成真实 PluginPanel FS load spec 的外部样本 action。
- `PluginPanel` render report 新增 `expected_samples`、`sample_index`、`external_plan_sample`；Rust summary 聚合 `reported_samples`、`rendered_samples`、`external_plan_expected_samples`、`external_plan_rendered_samples` 和 `sample_plugin_ids`。
- 前端每收到一个成功 render 回传后继续打开下一个 action，直到队列完成。
- desktop smoke reporter 等待聚合 summary 完成；外部 plan render 样本未全部回传或未全部渲染时会降级。
- Tauri FS capability 精确放行 `/tmp/atools-ztools-plugin-smoke/**`，避免外部 plan 样本在真实前端读取时被 scope 拦截。

TDD 记录：

- 先扩展 parser fixture 和缺字段断言，红灯要求 `plugin_panel_render_smoke` 输出 aggregate sample fields。
- 先扩展 Rust summary 单测，红灯要求多个外部 plan render report 能合并为完整 summary。
- 先扩展前端源码契约测试，红灯要求 `desktop_smoke_plugin_panel_actions`、action queue 和 `ondesktopsmokerender` 续跑回调存在。
- 先补 capability 静态红灯：`node scripts/test-tauri-desktop-smoke-script.mjs` 在 `/tmp/atools-ztools-plugin-smoke/**` 未进入 `fs:scope` 时失败。

验证：

```bash
node scripts/test-tauri-desktop-smoke-script.mjs
pnpm test:plugin-host-view
cargo fmt --check
pnpm check
cargo test -p atools desktop_smoke
ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop
pnpm smoke:tauri-desktop
```

结果：

- `node scripts/test-tauri-desktop-smoke-script.mjs`：通过。
- `pnpm test:plugin-host-view`：通过。
- `cargo fmt --check`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `cargo test -p atools desktop_smoke`：11 passed。
- `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop`：通过，`status:"ok"`；外部 activation summary 为 10 planned、8 imported、8 activated、8 UI actions checked、8 PluginPanel FS load specs checked、8 assertions checked、8 cleanup verified、2 skipped；`plugin_panel_render_smoke` 为 `expected_samples:6`、`reported_samples:6`、`rendered_samples:6`、`external_plan_expected_samples:6`、`external_plan_rendered_samples:6`。
- `pnpm smoke:tauri-desktop`：通过，标准路径保持 `expected_samples:1`、`reported_samples:1`、`rendered_samples:1`、`external_plan_expected_samples:0`、`external_plan_rendered_samples:0`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 99% | 99% | 从单插件 Tauri render smoke 扩展到外部 plan renderable 队列 6/6 回传 |
| 插件安装/导入 | 99% | 99% | 外部 activation plan 不仅验证导入/激活/FS spec，也验证可渲染样本真实前端读文件 |
| 测试与发布 | 99% | 99% | parser、Rust summary、前端源码契约、Tauri capability 和两条 desktop smoke 路径均通过 |

当前重点剩余：

1. 插件兼容：补外部样本逐插件视觉截图、交互回放和 native bridge probe 全样本执行。
2. 插件安全：证书链/吊销/平台级签名策略、完整 iframe sandbox/cross-origin capability isolation。
3. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 277：真实 Tauri PluginPanel 渲染回传 smoke

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批接上前两批的真实入口 fixture / PluginPanel FS load spec，把 `pnpm smoke:tauri-desktop` 从“后端可形成 PluginPanel 加载规格”推进到“真实 Tauri 前端自动打开一个 indexed plugin，并由 PluginPanel 文件系统加载路径回传渲染结果”。

状态：DONE。

修改文件：

- `src-tauri/src/desktop_smoke.rs`
- `src-tauri/src/state.rs`
- `src-tauri/src/lib.rs`
- `src/App.svelte`
- `src/components/PluginPanel.svelte`
- `scripts/smoke-tauri-desktop.mjs`
- `scripts/test-tauri-desktop-smoke-script.mjs`
- `scripts/test-plugin-host-view.mjs`
- `docs/ui-ztools-restore-checklist.md`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 `plugin_panel_render_smoke` desktop smoke 汇总：
  - `reported`
  - `sample_plugin_id`
  - `sample_feature_code`
  - `main_url`
  - `plugin_path_exists`
  - `fs_load`
  - `iframe_srcdoc_loaded`
  - `iframe_src_empty`
  - `load_error_empty`
  - `iframe_srcdoc_bytes`
- 新增 Tauri desktop smoke command：
  - `desktop_smoke_plugin_panel_action`：在 smoke 环境下等待内置插件索引完成，返回一个可由 PluginPanel 文件系统加载的真实 `FeatureAction`。
  - `report_plugin_panel_render_smoke`：接收前端 PluginPanel 加载回传并写入 AppState。
- `App.svelte` 在 `VITE_ATOOLS_DESKTOP_SMOKE=1` 且真实 Tauri runtime 下自动打开上述 `FeatureAction`。
- `PluginPanel.svelte` 在真实 FS 加载分支完成 `readTextFile`、资源改写、preload 注入、bridge 注入、写入 `iframeSrcDoc` 后回传 smoke；失败时也回传错误。
- desktop smoke reporter 会等待前端回传；未回传时 `status` 降级，避免只靠后端自证。
- Node parser 开始强制校验 `plugin_panel_render_smoke`，CLI smoke 输出缺字段会直接失败。

TDD 记录：

- 先新增 parser 缺字段断言，红灯表现为缺少 `plugin_panel_render_smoke` 时没有抛错。
- 先新增 Rust 快照断言，红灯表现为 `DesktopSmokeSnapshot` 无 `plugin_panel_render_smoke` 字段。
- 先新增前端源码契约断言，红灯表现为 `PluginPanel` 没有 `report_plugin_panel_render_smoke`，`App` 没有 `desktop_smoke_plugin_panel_action` 自动激活。
- 实现后上述红灯全部转绿。

验证：

```bash
node scripts/test-tauri-desktop-smoke-script.mjs
pnpm test:plugin-host-view
pnpm test:plugin-dialog-bridge
pnpm check
cargo test -p atools desktop_smoke
pnpm smoke:tauri-desktop
```

结果：

- `node scripts/test-tauri-desktop-smoke-script.mjs`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-dialog-bridge`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `cargo test -p atools desktop_smoke`：10 passed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`plugin_panel_render_smoke.reported:true`，`fs_load:true`，`iframe_srcdoc_loaded:true`，`iframe_src_empty:true`，`load_error_empty:true`，本次真实回传 `iframe_srcdoc_bytes:146338`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 78% | 80% | desktop smoke 已覆盖真实 Tauri 前端 PluginPanel FS `srcdoc` 加载回传；逐插件视觉和全量 native bridge 回放仍未完成 |
| 插件兼容自动化 | 74% | 76% | 从 fixture/Web preview matrix 推进到真实 Tauri 抽样 render smoke |
| Tauri/Rust 桌面底座 | 96% | 96% | 新增 smoke-only command 与状态汇总，不改变普通运行时主能力 |
| 测试与发布 | 99% | 99% | 真实 desktop smoke 增加前端 render gate；签名、公证、自动更新仍是发布缺口 |

当前重点剩余：

1. 插件宿主：把真实 Tauri render smoke 从单插件抽样扩展到外部 activation plan 的逐插件回放。
2. 插件兼容：补真实 native bridge probe 回放、逐插件视觉截图和失败归因。
3. 内置程序体验：继续打磨 WebDAV 同步、插件市场禁用态、AI 配置接入真实 Agent 调用。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## 第六十五批：MCP 客户端安装指引与安全写入计划

用户要求：插件不着急，先继续完善内置程序体验。本批继续收口内置 Agent/MCP 客户端接入体验：在复制模板之外，给出目标配置位置、合并步骤和当前不自动写入的安全状态。

状态：DONE。

修改文件：

- `src/lib/mcpClientConfig.ts`
- `src/components/AgentPanel.svelte`
- `src/components/SettingsPanel.svelte`
- `scripts/test-mcp-client-config.mjs`
- `docs/agent-mcp-client.md`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 MCP 客户端安装计划模型：
  - `McpClientInstallPlan`
  - `mcpClientInstallPlan()`
  - `mcpClientInstallPlans()`
- 每个模板现在有明确落地指引：
  - 通用 HTTP MCP：客户端 MCP 设置，提示保留 `Authorization Bearer token`。
  - 通用 stdio proxy：客户端 MCP 设置，提示保留 `--mcp-stdio`。
  - Claude Desktop / Claude Code：提示 `claude_desktop_config.json`、`~/.claude.json` 或项目 `.mcp.json`。
  - Cursor：提示 Cursor 设置或项目 `.cursor/mcp.json`。
- Agent 面板 MCP 模板行展示：
  - 目标配置位置。
  - 合并步骤。
  - `暂不自动写入` 状态。
  - 不自动写入原因：避免覆盖用户已有 `mcpServers`。
- 设置页 `MCP 服务` 模板行展示同一套安装计划。
- 没有新增任何真实写入第三方客户端配置文件的能力，仍需用户复制后手动合并。

TDD 记录：

- 先扩展 `scripts/test-mcp-client-config.mjs`，要求：
  - `mcpClientInstallPlans()` 与模板 id 一一对应。
  - 所有 plan 都是 `writeAvailable=false`。
  - 所有 plan 的原因包含 `暂不自动写入`。
  - HTTP plan 包含客户端 MCP 设置和 `Authorization Bearer token` 提醒。
  - stdio plan 包含 `--mcp-stdio` 提醒。
  - Claude plan 包含 `~/.claude.json`、`.mcp.json`、合并步骤和刷新 Claude 步骤。
  - Cursor plan 包含 `.cursor/mcp.json` 和合并步骤。
- 初次运行红灯，原因是 `mcpClientInstallPlans` 尚未实现。
- 实现模型后目标测试转绿，再接入 Agent 面板和设置页。

验证：

```bash
pnpm test:mcp-client-config
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1`。
- 进入 `设置` -> `MCP 服务`：
  - 4 个 `.mcp-install-plan` 可见。
  - 4 个 `暂不自动写入` 可见。
  - `~/.claude.json`、`.cursor/mcp.json`、`--mcp-stdio`、`合并 mcpServers.atools` 均可见。
  - 安装计划区域横向溢出数量为 0。
- 回到主界面进入 `Agent / MCP`：
  - 4 个安装计划和 4 个 `暂不自动写入` 均可见。
  - Claude/Cursor 路径和合并步骤可见。
  - 安装计划区域横向溢出数量为 0。

结果：

- `pnpm test:mcp-client-config`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，171 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，权限/数据/系统设置 smoke 均为 true。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP 底座 | 91% | 92% | 客户端模板增加安装目标、合并步骤和安全写入状态，真实自动写入仍未做 |
| 设置项真实功能 | 97% | 97% | 设置页 MCP 客户端接入指引增强，但没有新增第三方配置写入命令 |
| ZTools 设置页 UI | 99% | 99% | MCP 服务页局部增强，整体设置页完成度不变 |
| 测试与发布 | 99% | 99% | 扩展 MCP 客户端配置测试，并通过 check/build/desktop smoke |

当前重点剩余：

1. Agent/MCP：继续补 MCP 协议完整性、AI 配置接入真实 Agent 调用；客户端自动写入/合并配置需要单独确认流后再做。
2. 内置程序体验：继续打磨 WebDAV 同步、插件市场禁用态。
3. 插件 tools 暴露按当前要求暂缓。
4. macOS 发布质量：签名、公证、自动更新仍未接入。

## 第六十六批：快捷键自定义编辑器本地配置闭环

用户要求：插件不着急，先继续完善内置程序体验。本批聚焦 ZTools 设置页里的快捷键体验，把 `快捷键 / 应用快捷键` 从“只展示内置快捷键、添加禁用”推进到可新增、编辑、启停、删除和本地保存的自定义应用快捷键编辑器。

状态：DONE。

修改文件：

- `src/lib/settingsPages.ts`
- `src/lib/settings.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-settings-pages.mjs`
- `scripts/test-settings-normalization.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增应用快捷键设置模型：
  - `AppShortcutEntry`
  - `createAppShortcut()`
  - `normalizeAppShortcuts()`
  - `appShortcutRows()`
- `AToolsSettings` 新增 `appShortcuts`，默认空数组，并在设置规范化时清理坏类型、空快捷键和空目标。
- 设置页 `快捷键` 顶部 `添加快捷键` 按钮可用。
- `快捷键 / 应用快捷键` tab 可新增自定义行。
- 自定义行支持启停、编辑快捷键、选择目标和删除。
- 状态 pill 显示 `已启用`、`已停用`、`无效`、`重复`、`冲突`、`目标缺失`。
- 与内置快捷键重复、自定义重复、格式无效、目标不存在均有提示。
- 本批只做编辑器和设置保存闭环，不接运行时触发分发；后续要接 `App.svelte` 的快捷键匹配和目标执行。

子 agent 审查：

- 派发只读 explorer 审查当前快捷键实现。
- 结论与本批范围一致：
  - 全局呼出快捷键已接入录制/校验/保存/Tauri 注册。
  - 应用快捷键页此前仍是占位，`添加快捷键` 禁用，`customAppCount` 硬编码 0。
  - 最小接入点为 `settingsPages.ts`、`settings.ts`、`SettingsPanel.svelte`。
  - 运行时自定义快捷键触发需另改 `App.svelte`，本批不做。

TDD 记录：

- 先扩展 `scripts/test-settings-pages.mjs`，要求：
  - `createAppShortcut()` 自动生成下一个不冲突的 `Command+数字`。
  - `normalizeAppShortcuts()` 清理坏类型/空字段并保留 `enabled=false`。
  - `appShortcutRows()` 能识别目标、重复、自定义冲突、内置冲突、无效快捷键。
  - `shortcutPageOverview()` 自定义应用快捷键数量进入概览卡。
- 先扩展 `scripts/test-settings-normalization.mjs`，要求：
  - `normalizeSettings()` 规范化 `appShortcuts`。
  - 空快捷键/空目标被过滤。
- 初次运行红灯：
  - `createAppShortcut is not a function`。
  - `appShortcuts` 未规范化，坏字段原样保留。
- 实现模型层和设置规范化后目标测试转绿，再接设置页 UI。

验证：

```bash
pnpm test:settings-pages
pnpm test:settings-normalization
pnpm test:hotkey-recorder
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1`。
- 进入 `设置` -> `快捷键`。
- DOM 可见：
  - `添加快捷键` 按钮不再禁用。
  - 自定义应用快捷键已本地保存。
  - `应用快捷键` tab。
- 切到 `应用快捷键` 后点击 `添加快捷键`：
  - `.app-shortcut-row` 数量为 1。
  - 自动生成 `Command+1`。
  - 页面显示 `1 自定义`。
  - 页面显示 `已启用` 和 `已添加应用快捷键`。
  - 自定义行横向溢出数量为 0。
- 浏览器输入层由于当前 in-app browser 虚拟剪贴板限制，未通过 UI 强行编辑成 `Command+F`；内置冲突由 `pnpm test:settings-pages` 覆盖。

结果：

- `pnpm test:settings-pages`：通过。
- `pnpm test:settings-normalization`：通过。
- `pnpm test:hotkey-recorder`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，171 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，权限/数据/系统设置 smoke 均为 true。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 设置项真实功能 | 97% | 98% | 应用快捷键自定义编辑器进入本地设置保存链路，支持新增/编辑/启停/删除和冲突状态 |
| ZTools 设置页 UI | 99% | 99% | 快捷键页移除“添加禁用”断点，但设置页仍有 WebDAV/插件市场/运行时快捷键分发等后续缺口 |
| 测试与发布 | 99% | 99% | 扩展设置页/设置规范化测试，并通过 check/build/desktop smoke |
| Agent/MCP 底座 | 92% | 92% | 本批不改 MCP/Agent |

当前重点剩余：

1. 内置程序体验：继续打磨 WebDAV 实际同步、插件市场禁用态。
2. Agent/MCP：继续补 MCP 协议完整性、AI 配置接入真实 Agent 调用；客户端自动写入/合并配置需要单独确认流后再做。
3. 插件 tools 暴露按当前要求暂缓。
4. macOS 发布质量：签名、公证、自动更新仍未接入。

## 第九十三批：网页快开卡片与编辑面板

用户要求：插件不着急，先继续完善内置程序体验。本批聚焦 `网页快开` 设置页：此前是三列内联表格编辑，和 ZTools 主程序设置体验不一致，也缺少覆盖式编辑、类型切换、URL 校验和删除确认；本批把它补成卡片列表加页面内编辑面板。

状态：DONE。

修改文件：

- `src/components/SettingsPanel.svelte`
- `src/lib/webQuickOpen.ts`
- `scripts/test-web-quick-open-settings.mjs`
- `scripts/test-web-quick-open.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `网页快开` 从表格式行编辑改成卡片列表：
  - 每张卡显示启停开关、名称、类型、关键字 chip、URL 预览。
  - 行级操作为 `编辑` / `预览` / `删除`。
- 新增页面内编辑面板：
  - 标题为 `编辑网页快开`。
  - 支持编辑名称、关键字、URL 模板。
  - 提供 `搜索模板` / `固定网址` 类型切换。
  - 展示 `URL 预览`。
  - 按 `Escape` 只关闭编辑面板，不关闭设置页。
- URL 校验：
  - 空名称、空关键字、关键字包含空格、空 URL、非法 URL、非 http/https 协议都会拦截保存。
  - 校验逻辑抽到 `src/lib/webQuickOpen.ts`，由脚本测试覆盖。
- 删除确认：
  - 删除网页快开复用设置页内嵌确认弹窗。
  - `Escape` 只关闭确认弹窗，不删除卡片、不关闭设置页。
- 布局：
  - URL 预览支持换行，卡片和编辑面板无横向溢出。

TDD 记录：

- 先新增 `scripts/test-web-quick-open-settings.mjs` 和 `pnpm test:web-quick-open-settings`：
  - 要求设置页有 `editingWebQuickOpenId`、`webQuickOpenDraft`、`webQuickOpenValidation`。
  - 要求有编辑/保存/关闭/类型切换/URL 预览/URL 校验函数。
  - 要求删除改为 `confirmSettingsAction()`，标题为 `删除网页快开`，不再直接按 id 删除。
  - 要求页面使用 `.web-quick-card-grid`、`.web-quick-card`、`.web-quick-editor-layer`、`.web-quick-editor-panel`。
  - 要求出现 `编辑网页快开`、`搜索模板`、`固定网址`、`URL 预览`。
- 初次运行红灯，原因是现有页面仍是内联表格，没有编辑面板和删除确认。
- 实现卡片/编辑面板后目标测试转绿。
- 再扩展 `scripts/test-web-quick-open.mjs`，要求 `validateWebQuickOpenEntry()` 覆盖 URL 校验；初次红灯为函数不存在。
- 将校验逻辑抽到 `src/lib/webQuickOpen.ts` 后回归转绿。

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1` 并进入设置页 `网页快开`。
- 页面可见 3 张默认卡片：`Google`、`GitHub`、`NPM`。
- 卡片可见 `编辑`、`预览`、`删除`、`搜索模板` 和关键字 chip。
- `.settings-panel`、`.content-panel`、`.web-quick-card-grid`、`.web-quick-card`、`.web-quick-preview-url`、`.web-quick-card-actions` 横向溢出数组为空。
- 点击 `编辑`：
  - 出现 `编辑网页快开` 面板。
  - 可见 `搜索模板`、`固定网址`、`URL 预览`。
  - 编辑面板相关容器横向溢出数组为空。
- 按 `Escape`：
  - 只关闭编辑面板。
  - 设置页仍可见。
  - 左侧仍停留在 `网页快开`。
- 点击第一张卡片 `删除`：
  - 出现内嵌确认弹窗，标题为 `删除网页快开`。
  - 正文显示 `确定要删除“Google”吗？删除后主搜索将不再匹配这个网页快开。`
- 再按 `Escape`：
  - 只关闭确认弹窗。
  - 卡片数量仍为 3。
  - 设置页仍停留在 `网页快开`。
- Browser console：0 errors / 0 warnings。
- 浏览器文本输入验证受当前 Browser virtual clipboard 限制，无法用自动化输入非法 URL；URL 校验由 `pnpm test:web-quick-open` 的纯函数断言覆盖。

验证：

```bash
pnpm test:web-quick-open-settings
pnpm test:web-quick-open
pnpm test:settings-confirm-dialog
pnpm test:settings-pages
pnpm test:settings-content-style
pnpm test:settings-controls-style
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:web-quick-open-settings`：通过。
- `pnpm test:web-quick-open`：通过，覆盖 URL 校验。
- `pnpm test:settings-confirm-dialog`：通过。
- `pnpm test:settings-pages`：通过。
- `pnpm test:settings-content-style`：通过。
- `pnpm test:settings-controls-style`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，186 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，8 个默认 Agent 工具可见，权限/数据/系统设置 smoke 均为 true。
- `pnpm smoke:tauri-desktop` 结束时仍出现 Vite `EPIPE` 日志噪声，但进程退出码为 0，且 smoke JSON `status` 为 `ok`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 99% | 99% | `网页快开` 从内联表格升级为卡片列表和页面内编辑面板 |
| 设置项真实功能 | 99% | 99% | 网页快开支持编辑、预览、类型切换、URL 校验和删除确认 |
| ZTools/uTools 主搜索体验 | 99% | 99% | 主搜索已有网页快开结果，本批主要补设置页管理体验 |
| 测试与发布 | 99% | 99% | 新增网页快开设置页测试，扩展 URL 校验纯函数测试，并通过 check/build/desktop smoke |

当前重点剩余：

1. 插件仍按用户要求暂缓，继续做内置程序体验。
2. 下一批建议继续做设置页剩余局部体验：例如 `所有指令` 的固定/禁用占位态、数据页审计分页，或主搜索极端结果量/空态细节。
3. macOS 发布质量仍剩签名、公证、自动更新。

## 第九十二批：本地启动设置页体验补齐

用户要求：插件不着急，先继续完善内置程序体验。本批聚焦 `本地启动` 设置页：此前只能手动编辑表格字段，缺少桌面工具应有的文件/文件夹选择、拖拽添加、打开路径、定位路径和删除确认；本批把这些补成真实内置体验。

状态：DONE。

修改文件：

- `src/components/SettingsPanel.svelte`
- `scripts/test-local-launch-settings.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `本地启动` 页顶部新增明确操作：
  - `添加文件`
  - `添加文件夹`
  - `添加应用`
  - `手动添加`
  - `恢复默认`
- 桌面端新增 Tauri dialog 选择路径：
  - 文件走文件选择。
  - 文件夹/应用走目录选择。
  - 自动推导名称、关键字和类型。
  - Web 预览下选择按钮禁用，并提示需桌面端。
- 新增拖拽添加区域：
  - 文案为 `拖拽文件或文件夹到这里添加`。
  - 仅在拿到真实本地路径时落库；Web 预览不会生成不可用路径。
- 每个本地启动项新增行级操作：
  - `打开`：调用 `shell_open`。
  - `定位`：调用 `shell_show_item_in_folder`。
  - `删除`：复用第九十一批设置页内嵌确认弹窗。
- 本地启动行布局调整：
  - 路径输入单独占一行，避免新增操作按钮后出现横向溢出。
  - 移动端下 action 区单独换行。

TDD 记录：

- 先新增 `scripts/test-local-launch-settings.mjs` 和 `pnpm test:local-launch-settings`：
  - 要求 `SettingsPanel` 导入 Tauri dialog。
  - 要求存在 `addLocalLaunchEntryFromPicker()`、`createLocalLaunchEntryFromPath()`、名称/关键字推导 helper。
  - 要求存在拖拽添加函数、dropzone 文案和 DOM 事件。
  - 要求存在 `openLocalLaunchPath()` / `revealLocalLaunchPath()`，并分别调用 `shell_open` / `shell_show_item_in_folder`。
  - 要求删除使用 `confirmSettingsAction()`，标题为 `删除本地启动项`，不再直接按 id 删除。
  - 要求页面出现 `添加文件`、`添加文件夹`、`打开`、`定位` 和 `.local-launch-actions`。
- 初次运行红灯，原因是现有页面没有 dialog 选择、拖拽添加、打开/定位，也没有删除确认。
- 实现后目标测试转绿。
- 首次 `pnpm check` 出现拖拽区域 ARIA warning，补 `role="group"` 和 `aria-label` 后清理。

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1` 并进入设置页 `本地启动`。
- 页面可见：
  - `添加文件`
  - `添加文件夹`
  - `添加应用`
  - `手动添加`
  - `拖拽文件或文件夹到这里添加`
  - 行级 `打开` / `定位` / `删除`
- Web 预览下文件/文件夹/应用选择按钮为 disabled，避免假装可选择本地路径。
- `.settings-panel`、`.content-panel`、`.local-launch-dropzone`、`.local-launch-list`、`.local-launch-row`、`.local-launch-fields`、`.local-launch-actions` 横向溢出数组为空。
- 点击第一行 `删除`：
  - 出现内嵌确认弹窗，标题为 `删除本地启动项`。
  - 正文显示 `确定要删除“桌面”吗？删除后主搜索将不再匹配这个路径。`
- 按 `Escape`：
  - 只关闭确认弹窗。
  - 设置页仍然可见。
  - 左侧仍停留在 `本地启动`。
- Browser console：0 errors / 0 warnings。

验证：

```bash
pnpm test:local-launch-settings
pnpm test:local-launch
pnpm test:settings-confirm-dialog
pnpm test:settings-pages
pnpm test:settings-content-style
pnpm test:settings-controls-style
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:local-launch-settings`：通过。
- `pnpm test:local-launch`：通过。
- `pnpm test:settings-confirm-dialog`：通过。
- `pnpm test:settings-pages`：通过。
- `pnpm test:settings-content-style`：通过。
- `pnpm test:settings-controls-style`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，186 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，8 个默认 Agent 工具可见，权限/数据/系统设置 smoke 均为 true。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 99% | 99% | `本地启动` 从表格编辑页补成带选择、拖拽、行级操作和内嵌删除确认的桌面设置页 |
| 设置项真实功能 | 99% | 99% | 本地启动支持选择文件/文件夹/应用、打开/定位路径和删除确认 |
| ZTools/uTools 主搜索体验 | 99% | 99% | 主搜索已有本地启动结果，本批主要补设置页管理体验 |
| 测试与发布 | 99% | 99% | 新增本地启动设置页测试，并通过 check/build/desktop smoke |

当前重点剩余：

1. 插件仍按用户要求暂缓，继续做内置程序体验。
2. 下一批建议做 `网页快开` 页卡片列表和覆盖式编辑器，进一步接近 ZTools 设置页的操作体感。
3. macOS 发布质量仍剩签名、公证、自动更新。

## 第九十一批：设置页统一内嵌确认弹窗

用户要求：插件不着急，先继续完善内置程序体验。本批聚焦设置页危险操作确认：此前多个设置页操作使用浏览器原生 `confirm()`，和 ZTools 桌面设置体验不一致，也会打断应用内焦点和 Escape 行为；本批统一替换为设置页内嵌确认弹窗。

状态：DONE。

修改文件：

- `src/App.svelte`
- `src/components/SettingsPanel.svelte`
- `src/components/SettingsConfirmDialog.svelte`
- `scripts/test-settings-confirm-dialog.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 `SettingsConfirmDialog`：
  - 使用 `role="dialog"` 和 `aria-modal="true"`。
  - 支持 danger/default 两种语气、标题、正文、确认按钮和取消按钮。
  - 使用设置页内覆盖层和半透明 scrim，不再弹浏览器原生确认框。
  - `Escape` 只关闭当前确认弹窗。
- `SettingsPanel` 新增统一确认请求队列：
  - `confirmSettingsAction()` 创建确认请求。
  - `resolveSettingsConfirm()` 统一回收确认结果。
- 设置页危险操作统一走内嵌弹窗：
  - 恢复 WebDAV 设置。
  - 导入剪贴板历史。
  - 清空最近使用历史。
  - 清空剪贴板历史。
  - 恢复默认设置。
  - 清空审计记录。
  - 清空插件数据。
  - 清空崩溃日志。
- `App.svelte` 增加 `settingsConfirmDialogOpen()` 保护：
  - 设置页确认弹窗打开时，App 全局 `Escape` 不关闭整个设置页。
  - 弹窗关闭后仍停留在原设置菜单。

TDD 记录：

- 先新增 `scripts/test-settings-confirm-dialog.mjs` 和 `pnpm test:settings-confirm-dialog`：
  - 要求 `SettingsPanel` 导入并渲染 `SettingsConfirmDialog`。
  - 要求危险操作文案都进入内嵌确认流。
  - 要求 `SettingsPanel` 不再出现 `confirm(` 或 `window.confirm`。
  - 要求弹窗具备 ARIA dialog、scrim、danger 样式、确认/取消按钮和 Escape 处理。
  - 要求 `App.svelte` 有 `settingsConfirmDialogOpen()`，避免 Escape 误关设置页。
- 初次运行红灯，原因是现有实现仍依赖原生 `confirm()`，且没有设置页内嵌 dialog。
- 实现 `SettingsConfirmDialog` 和设置页确认 helper 后目标测试转绿。
- 初次 `pnpm check` 出现 Svelte 可访问性 warning，原因是 `section role="dialog"`；调整为 `div role="dialog"` 后清理完成。

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1` 并进入设置页。
- 进入 `我的数据`，点击 `恢复默认`：
  - 页面出现内嵌确认弹窗，标题为 `恢复默认设置`。
  - 正文显示 `确定要恢复默认设置吗？这会覆盖当前设置。`
  - 弹窗和内容区无横向溢出。
- 按 `Escape`：
  - 只关闭确认弹窗。
  - 设置页仍然可见。
  - 左侧仍停留在 `我的数据`。
- 再次打开弹窗并点击 `取消`：
  - 只关闭确认弹窗。
  - 设置页仍然可见。
- Browser console：0 errors / 0 warnings。

验证：

```bash
pnpm test:settings-confirm-dialog
pnpm test:settings-pages
pnpm test:settings-content-style
pnpm test:settings-controls-style
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:settings-confirm-dialog`：通过。
- `pnpm test:settings-pages`：通过。
- `pnpm test:settings-content-style`：通过。
- `pnpm test:settings-controls-style`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，186 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，8 个默认 Agent 工具可见，权限/数据/系统设置 smoke 均为 true。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 99% | 99% | 原生确认框替换为设置页内嵌确认弹窗，危险操作体验更接近桌面应用 |
| 设置项真实功能 | 99% | 99% | 恢复/导入/清空类操作统一进入确认链路，避免误触 |
| ZTools/uTools 主搜索体验 | 99% | 99% | 本批不改主搜索 |
| 测试与发布 | 99% | 99% | 新增确认弹窗守护测试，并通过 check/build/desktop smoke |

当前重点剩余：

1. 插件仍按用户要求暂缓，继续做内置程序体验。
2. 下一批建议优先做 `本地启动` 页的添加文件/文件夹、拖拽添加、打开路径和删除确认；删除确认可以复用本批的内嵌确认弹窗。
3. `网页快开` 页还可继续向 ZTools 卡片列表/覆盖式编辑器靠齐。

## 第九十批：设置页顶部三点更多操作菜单

用户要求：继续还原内置程序体验，插件接入暂缓。本批聚焦设置页顶部右侧三点按钮：之前只显示视觉三点，没有任何操作，属于明显空交互；本批补成真实菜单，并修正 Escape 键只关闭菜单、不误关闭设置页。

状态：DONE。

修改文件：

- `src/App.svelte`
- `src/components/SettingsHeader.svelte`
- `scripts/test-settings-header-menu.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `SettingsHeader` 新增三点菜单状态和可访问性属性：
  - `aria-haspopup="menu"`
  - `aria-expanded={showMoreMenu}`
  - `aria-controls="settings-more-menu"`
- 点击三点按钮展开 `role="menu"` 的更多操作菜单。
- 菜单提供两个真实操作：
  - `回到主搜索`：关闭设置页并返回首页。
  - `复制运行信息`：复制 `ATools 3.0`、当前 URL、平台、User Agent 和时间，并在菜单内显示复制状态。
- 点击外部区域关闭菜单。
- 菜单打开时按 `Escape` 只关闭菜单，不再触发 App 全局 `onEscape()` 关闭整个设置页。
- 为菜单提供亮/暗主题样式，保持 header 右侧无横向溢出。

TDD 记录：

- 先新增 `scripts/test-settings-header-menu.mjs` 和 `pnpm test:settings-header-menu`：
  - 要求 `SettingsHeader` 有菜单状态、运行信息复制逻辑、ARIA menu 结构、菜单项和样式。
  - 要求 `App.svelte` 有 `settingsHeaderMenuOpen()` 保护，菜单打开时全局 Escape 不执行设置页关闭。
- 初次运行红灯，原因是三点按钮没有菜单、没有运行信息复制，也没有 App 级 Escape 保护。
- 补上 `SettingsHeader` 菜单后，浏览器验证发现 Escape 仍被 App 级监听先消费，导致设置页关闭。
- 补充测试要求 `event.stopImmediatePropagation()` 和 App 级 `settingsHeaderMenuOpen()` 后，再实现保护，目标测试转绿。

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1` 并进入设置页。
- 点击三点按钮：
  - 菜单展开，`aria-expanded` 为 `true`。
  - `复制运行信息` 后菜单仍可见，状态显示 `已复制运行信息`。
  - 页面无横向溢出。
- 菜单打开时按 `Escape`：
  - 菜单关闭。
  - 设置页仍然可见。
  - `aria-expanded` 回到 `false`。
- 再次打开菜单并点击 `回到主搜索`：
  - 设置页关闭。
  - 首页/最近使用区域可见。
- Browser console：0 errors / 0 warnings。

验证：

```bash
pnpm test:settings-header-menu
pnpm test:settings-header-style
pnpm test:z-mark
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:settings-header-menu`：通过。
- `pnpm test:settings-header-style`：通过。
- `pnpm test:z-mark`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，184 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，8 个默认 Agent 工具可见，权限/数据/系统设置 smoke 均为 true。
- `pnpm smoke:tauri-desktop` 结束时出现 Vite `EPIPE` 日志噪声，但进程退出码为 0，且 smoke JSON `status` 为 `ok`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 99% | 99% | 顶部三点按钮从空视觉变成可展开操作菜单，补齐一个明显空交互 |
| ZTools/uTools 主搜索体验 | 99% | 99% | 本批不改主搜索 |
| 设置项真实功能 | 99% | 99% | 菜单新增“回到主搜索/复制运行信息”两个真实内置操作，整体估计不调高 |
| 测试与发布 | 99% | 99% | 增加 header 菜单测试，并通过 check/build/desktop smoke |

ZTools 源码对照子任务结论：

- 本机没有 `ZToolsCenter/ZTools` 主仓库，子任务通过 GitHub 读取 ZTools 设置源码。
- 下一批更适合继续推进的内置体验项：
  1. `本地启动` 页补“添加文件/文件夹、拖拽添加、打开路径、删除确认”。
  2. `网页快开` 改成卡片列表和覆盖式编辑器，补类型切换/URL 校验。
  3. 用内嵌 `ConfirmDialog` / `DetailPanel` 替换原生 `confirm()`。
  4. `WebDAV 同步` 补测试连接和同步节奏状态。

当前重点剩余：

1. 插件仍按用户要求暂缓，先继续做内置程序体验。
2. 优先级建议：先做统一 `ConfirmDialog`，再做 `本地启动` 文件/文件夹添加和删除确认；这样后续危险操作都能复用同一个对话框。
3. macOS 发布质量仍剩签名、公证、自动更新。

## 第八十九批：设置页窗口尺度和桌面密度对齐

用户要求：插件不着急，先继续完善内置程序体验；此前指出内置 UI 尤其设置页离 ZTools 仍有差距。本批聚焦设置页默认窗口高度、侧栏宽度、菜单行高、内容区行距和桌面控件尺寸，让 1280+ 宽度下更接近 ZTools 截图里的“大设置窗口”体验。

状态：DONE。

修改文件：

- `src/App.svelte`
- `src/components/SettingsPanel.svelte`
- `scripts/test-settings-ztools-scale.mjs`
- `scripts/test-settings-sidebar-style.mjs`
- `scripts/test-settings-content-style.mjs`
- `scripts/test-settings-controls-style.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 设置页目标窗口高度从 `600px` 提升到 `860px`，避免设置页以小命令面板形态展开。
- 桌面侧栏宽度改为 `clamp(300px, 25vw, 400px)`，1600px 宽参考视口下可达到约 400px。
- 左侧菜单行调整为 80px 高、24px 字号、32px 图标，并保留 ZTools 风格选中 pill。
- 右侧内容区 padding 调整为 `60px 50px 56px 40px`，分组标题 26px，设置行最小高度 116px。
- 桌面控件调整为大尺寸：
  - 快捷键/输入/下拉控件高度 66px。
  - 快捷键输入框宽 300px。
  - 下拉控件最小宽 300px。
  - 按钮高 54px。
  - 开关为 86x48px，thumb 为 34px。
- 720px 以下保留紧凑回退：侧栏 184px、菜单 48px、设置项 76px，避免窄窗口布局被放大样式撑爆。

TDD 记录：

- 先新增 `scripts/test-settings-ztools-scale.mjs` 和 `pnpm test:settings-ztools-scale`：
  - 要求 `SETTINGS_WINDOW_HEIGHT = 860`。
  - 要求设置页侧栏、菜单、图标、内容区、行高、字号和控件尺寸匹配新目标。
- 初次运行红灯，原因是实现仍是 600px 窗口、280px 侧栏、56px 菜单、48px 控件。
- 修改实现并同步既有 sidebar/content/control 样式测试后全部转绿。

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1` 并进入设置页。
- 当前浏览器视口实测为 1280x581，设置窗口受 `min(100vh, 860px)` 限制，高度为 581px；真实更高桌面视口会按 860px 目标展开。
- 实测桌面布局：
  - `.settings-sidebar` 宽 320px，padding `46px 28px 28px 16px`。
  - 第一项菜单 80px 高、24px 字号、32px 图标。
  - `.content-panel` padding `60px 50px 56px 40px`。
  - 分组标题 26px，首个设置行约 123px。
  - 快捷键输入框 300x66px，开关 86x48px。
  - `documentElement` 横向溢出为 0。
- Browser console：0 errors / 0 warnings。

验证：

```bash
pnpm test:settings-ztools-scale
pnpm test:settings-sidebar-style
pnpm test:settings-content-style
pnpm test:settings-controls-style
pnpm test:settings-header-style
pnpm test:settings-scrollbar-style
pnpm test:settings-pages
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:settings-ztools-scale`：通过。
- `pnpm test:settings-sidebar-style`：通过。
- `pnpm test:settings-content-style`：通过。
- `pnpm test:settings-controls-style`：通过。
- `pnpm test:settings-header-style`：通过。
- `pnpm test:settings-scrollbar-style`：通过。
- `pnpm test:settings-pages`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，184 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，8 个默认 Agent 工具可见，权限/数据/系统设置 smoke 均为 true。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 99% | 99% | 设置页窗口高度、侧栏、菜单、内容行和控件尺寸更贴近 ZTools 截图；剩余主要是插件接入后的真实回归 |
| ZTools/uTools 主搜索体验 | 99% | 99% | 本批不改主搜索 |
| 设置项真实功能 | 99% | 99% | 本批不新增功能，只修正内置设置页体验 |
| 测试与发布 | 99% | 99% | 增加设置页尺度测试，并通过 check/build/desktop smoke |

当前重点剩余：

1. 内置程序继续打磨：设置页局部页面的可读性、长列表极端内容、主搜索空结果和大结果量体验。
2. 插件相关继续暂缓，不阻塞内置程序体验对齐。
3. macOS 发布质量仍剩签名、公证、自动更新。

## 第八十八批：设置页滚动条对齐

用户要求：继续还原完成度，插件不着急，先完善内置程序体验。本批聚焦设置页滚动区域：ZTools 截图里左侧菜单和右侧内容都有细窄圆角滚动条，而当前 ATools 只使用默认滚动条行为，视觉上仍偏浏览器默认控件。

状态：DONE。

修改文件：

- `src/components/SettingsPanel.svelte`
- `scripts/test-settings-scrollbar-style.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 为 `.settings-sidebar` 和 `.content-panel` 增加 `scrollbar-gutter: stable`，避免滚动条出现/隐藏造成布局抖动。
- Firefox 路径增加 `scrollbar-width: thin` 和 light/dark 两套 `scrollbar-color`。
- WebKit 路径增加 10px 宽滚动条、透明 track、3px 透明边框、999px 圆角 thumb 和 hover 色。
- 暗色主题下滚动条 thumb 改为半透明白色，并提供 hover 态。
- 720px 以下滚动条宽度回落到 8px，避免窄窗口挤占设置内容。

TDD 记录：

- 先新增 `scripts/test-settings-scrollbar-style.mjs` 和 `pnpm test:settings-scrollbar-style`：
  - 要求侧栏/内容区同时有 stable gutter、thin scrollbar 和透明 track。
  - 要求 WebKit thumb 具备透明边框、圆角、content-box 裁剪和 hover 色。
  - 要求暗色主题使用半透明白色滚动条。
  - 要求 720px 以下滚动条宽度为 8px。
- 初次运行红灯，原因是 `.settings-sidebar, .content-panel` 没有任何自定义滚动条样式。
- 增加样式后目标测试转绿。

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1` 并进入设置页。
- 亮色主题实测：
  - `.settings-sidebar` `overflowY:auto`，`scrollbarGutter: stable`，`scrollbarWidth: thin`。
  - `.settings-sidebar` clientHeight 503 / scrollHeight 949，确认为独立可滚动区域。
  - `.content-panel` `overflowY:auto`，`scrollbarGutter: stable`，`scrollbarWidth: thin`。
  - `.content-panel` clientHeight 503 / scrollHeight 3636，确认为独立可滚动区域。
  - 两者 `scrollbarColor` 均为 `rgba(0, 0, 0, 0.2) transparent`。
  - 设置页相关容器横向溢出为空数组。
- 暗色主题实测：
  - 侧栏和内容区 `scrollbarColor` 均为 `rgba(255, 255, 255, 0.24) transparent`。
  - 设置页相关容器横向溢出为空数组。
- console error/warn 为 0。

验证：

```bash
pnpm test:settings-scrollbar-style
pnpm test:settings-sidebar-style
pnpm test:settings-content-style
pnpm test:settings-controls-style
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:settings-scrollbar-style`：通过。
- `pnpm test:settings-sidebar-style`：通过。
- `pnpm test:settings-content-style`：通过。
- `pnpm test:settings-controls-style`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，184 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`agent_tools_count:8`，权限/数据/系统设置 smoke 均通过，脚本输出 `Desktop smoke passed`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 99% | 99% | 设置页侧栏和内容区补齐细窄圆角滚动条，视觉更接近 ZTools 截图 |
| 测试与发布 | 99% | 99% | 新增设置页滚动条样式守护测试，并通过浏览器 DOM/console、构建和真实 desktop smoke |
| ZTools/uTools 主搜索体验 | 99% | 99% | 本批不改主搜索 |
| Agent/MCP 底座 | 95% | 95% | 本批不改 MCP/Agent |

当前重点剩余：

1. 内置程序体验：继续打磨主搜索极端结果量信息密度、空态、最近使用和设置页局部状态。
2. 设置真实功能：WebDAV 插件数据覆盖式冲突合并和更细粒度覆盖/跳过策略仍未接入。
3. Agent/MCP：客户端自动写入/合并配置仍未做。
4. 插件 tools 暴露和插件 bridge 回归按当前要求暂缓。
5. macOS 发布质量：签名、公证、自动更新仍未接入。

## 第八十七批：最近使用磁贴类型图标化

用户要求：继续还原完成度，插件不着急，先完善内置程序体验。本批聚焦主搜索首页“最近使用”：上批结果列表已经从首字 fallback 升级为类型图标，但首页最近使用磁贴仍显示命令标题首字，和桌面启动器常见的图标网格体验不一致。

状态：DONE。

修改文件：

- `src/lib/homeSurface.ts`
- `src/lib/resultIcons.ts`
- `src/components/HomePanel.svelte`
- `scripts/test-home-recent-type-icons.mjs`
- `scripts/test-home-surface.mjs`
- `scripts/test-home-quick-action-icons.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `resultIcons.ts` 抽出 `resultFallbackIconForCode`，让首页和结果列表复用同一套 code -> icon 规则。
- `homeSurface.ts` 新增 `homeCommandFallbackIcon`：
  - `panel` / `system:*` -> `system`
  - `local:*` -> `folder`
  - `local-app:*` -> `app`
  - `web:*` -> `web`
  - `url:*` -> `link`
  - 其他推荐命令 -> `plugin`
- `HomePanel` 最近使用磁贴改为渲染 `ResultTypeIcon`，删除 `iconLabel(cmd.label)` 首字 fallback。
- 最近使用外层磁贴继续保持 38x38，内层 SVG 图标调整为 34x34 容器、20x20 SVG，并使用外层彩色底，避免双层底色。
- 更新首页测试转译夹具，补齐 `homeSurface.ts` 对 `resultIcons.ts` 的新依赖。

TDD 记录：

- 先新增 `scripts/test-home-recent-type-icons.mjs` 和 `pnpm test:home-recent-type-icons`：
  - 要求 `homeCommandFallbackIcon` 对 system/local/local-app/web/url/recommended 返回稳定 icon id。
  - 要求 `HomePanel` 导入 `ResultTypeIcon` 和 `homeCommandFallbackIcon`。
  - 要求最近使用不再包含 `{iconLabel(cmd.label)}` 和 `function iconLabel`。
  - 要求 `.recent-icon` 继续保持 38x38。
- 初次运行红灯，原因是 `homeCommandFallbackIcon` 不是函数。
- 增加映射逻辑、HomePanel 接入和测试夹具依赖后目标测试转绿。

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1`。
- 首页最近使用实测：
  - `.recent-item` 数量为 12。
  - `.recent-item .result-type-icon` 数量为 12。
  - 前 6 个最近项外层 `.recent-icon` 均为 38x38。
  - 内层 `.result-type-icon` 均为 34x34，SVG 为 20x20。
  - 内层图标 background 为 transparent，border 为 0，使用外层彩色磁贴底。
  - wrapper textContent 为空，不再显示首字 fallback。
  - `.shell-frame/.home-panel/.recent-grid/.recent-item/.recent-icon/.search-status-bar` 容器横向溢出为空数组。
- console error/warn 为 0。

验证：

```bash
pnpm test:home-recent-type-icons
pnpm test:home-surface
pnpm test:home-quick-action-icons
pnpm test:result-type-icons
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:home-recent-type-icons`：通过。
- `pnpm test:home-surface`：通过。
- `pnpm test:home-quick-action-icons`：通过。
- `pnpm test:result-type-icons`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，184 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`agent_tools_count:8`，权限/数据/系统设置 smoke 均通过。退出阶段仍有 Vite `write EPIPE` 停服日志，但命令退出码为 0，脚本输出 `Desktop smoke passed`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 99% | 99% | 首页最近使用从文字首字磁贴升级为来源类型 SVG 图标磁贴，和结果列表视觉语言保持一致 |
| 测试与发布 | 99% | 99% | 新增最近使用类型图标守护测试，并通过浏览器 DOM/console、构建和真实 desktop smoke |
| ZTools 设置页 UI | 99% | 99% | 本批不改设置页 |
| Agent/MCP 底座 | 95% | 95% | 本批不改 MCP/Agent |

当前重点剩余：

1. 内置程序体验：继续打磨主搜索极端结果量信息密度、空态、最近使用和设置页局部状态。
2. 设置真实功能：WebDAV 插件数据覆盖式冲突合并和更细粒度覆盖/跳过策略仍未接入。
3. Agent/MCP：更多 MCP 客户端实测和真实第三方插件 tool 兼容回归仍需继续。
4. 插件 tools 暴露和插件 bridge 回归按当前要求暂缓。
5. macOS 发布质量：签名、公证、自动更新仍未接入。

## 第八十六批：搜索结果类型图标化

用户要求：继续还原完成度，插件不着急，先完善内置程序体验。本批聚焦主搜索结果列表：此前没有真实图标的结果行用标题首字 fallback，系统命令、本地启动、网页快开等内置结果看起来像普通网页列表，不像桌面启动器中的功能结果。

状态：DONE。

修改文件：

- `src/lib/resultIcons.ts`
- `src/components/ResultsList.svelte`
- `src/components/ResultTypeIcon.svelte`
- `scripts/test-result-type-icons.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 `resultFallbackIcon` 纯逻辑：
  - `system:*` -> `system`
  - `local-app:*` -> `app`
  - `local:*` -> `folder`
  - `web:*` -> `web`
  - `url:*` -> `link`
  - `text:*` -> `text`
  - `paste:*` -> `paste`
  - `history:*` -> `history`
  - `alias:*` -> `alias`
  - 其他插件结果 -> `plugin`
- 新增 `ResultTypeIcon.svelte`：
  - 固定 30x30 图标容器，和现有应用图标尺寸一致。
  - 覆盖系统、应用、文件夹、网页、链接、文本、粘贴、历史、别名、插件十类 SVG。
  - 为不同来源提供轻量色彩区分，避免结果列表全是字母块。
- `ResultsList` 无真实 icon 时改为渲染 `ResultTypeIcon`，删除 `.icon-letter` 首字 fallback。
- 有真实本地应用 icon 的结果仍优先显示应用图标，不受本批影响。

TDD 记录：

- 先新增 `scripts/test-result-type-icons.mjs` 和 `pnpm test:result-type-icons`：
  - 要求 `resultFallbackIcon` 对 10 类结果返回稳定 icon id。
  - 要求 `ResultsList` 导入 `ResultTypeIcon` 和 `resultFallbackIcon`。
  - 要求 `ResultsList` 不再包含 `.icon-letter` fallback。
  - 要求 `ResultTypeIcon` 覆盖 10 类 icon，并保持 30x30。
- 初次运行红灯，原因是 `resultFallbackIcon` 不是函数。
- 增加映射逻辑、SVG 组件和 ResultsList 接入后目标测试转绿。

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1`。
- 搜索 `set` 后实测：
  - 结果行数量为 2。
  - `.result-type-icon` 数量为 2。
  - `.icon-letter` 数量为 0。
  - `设置` 行为 `tone-system`，图标 30x30，SVG parts 为 9，textContent 为空。
  - `打开 桌面` 行为 `tone-folder`，图标 30x30，SVG parts 为 2，textContent 为空。
  - 结果列表、结果行、图标容器横向溢出为空数组。
- 搜索 `g rust` 后实测：
  - 首行 `Google 搜索 rust` 使用 `tone-web`。
  - 图标为 30x30，SVG parts 为 4。
  - `.icon-letter` 数量为 0。
- console error/warn 为 0。

验证：

```bash
pnpm test:result-type-icons
pnpm test:result-icons
pnpm test:result-presentation
pnpm test:search-status-bar
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:result-type-icons`：通过。
- `pnpm test:result-icons`：通过。
- `pnpm test:result-presentation`：通过。
- `pnpm test:search-status-bar`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，184 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`agent_tools_count:8`，权限/数据/系统设置 smoke 均通过，脚本输出 `Desktop smoke passed`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 99% | 99% | 搜索结果无真实图标时从文字首字 fallback 升级为来源类型 SVG，结果列表更接近桌面启动器 |
| 测试与发布 | 99% | 99% | 新增结果类型图标守护测试，并通过浏览器 DOM/console、构建和真实 desktop smoke |
| ZTools 设置页 UI | 99% | 99% | 本批不改设置页 |
| Agent/MCP 底座 | 95% | 95% | 本批不改 MCP/Agent |

当前重点剩余：

1. 内置程序体验：继续打磨主搜索极端结果量信息密度、空态、最近使用和设置页局部状态。
2. 设置真实功能：WebDAV 插件数据恢复应用、冲突合并和更细粒度确认仍未接入。
3. Agent/MCP：客户端自动写入/合并配置仍未做。
4. 插件 tools 暴露和插件 bridge 回归按当前要求暂缓。
5. macOS 发布质量：签名、公证、自动更新仍未接入。

## 第八十五批：首页快捷入口图标化

用户要求：继续还原完成度，插件不着急，先完善内置程序体验。本批聚焦主搜索首页四个常用入口：此前入口图标只是按钮文字首字，视觉上更像网页卡片，不像 uTools/ZTools 桌面命令面板中的功能图标入口。

状态：DONE。

修改文件：

- `src/lib/homeSurface.ts`
- `src/components/HomePanel.svelte`
- `src/components/HomeQuickActionIcon.svelte`
- `scripts/test-home-quick-action-icons.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `homeQuickActions` 为四个常用入口增加稳定 icon id：
  - `导入 ZTools 插件` -> `download`
  - `插件管理` -> `plugins`
  - `Agent / MCP` -> `agent`
  - `设置` -> `settings`
- 每个快捷入口增加稳定 `ariaLabel`，例如 `打开设置`。
- 新增 `HomeQuickActionIcon.svelte`：
  - 使用 28x28 的紧凑圆角图标容器。
  - 提供导入、插件、Agent 网络节点、设置四类 SVG 图标。
  - SVG 为纯装饰图标，设置 `aria-hidden="true"`。
- `HomePanel` 的快捷入口不再用首字 fallback 当图标，改为渲染 `HomeQuickActionIcon`。
- 最近使用磁贴仍保留首字 fallback，不影响历史项和无图标命令展示。

TDD 记录：

- 先新增 `scripts/test-home-quick-action-icons.mjs` 和 `pnpm test:home-quick-action-icons`：
  - 要求 `homeQuickActions()` 返回四个稳定 icon id。
  - 要求每个 action 的 `ariaLabel` 为 `打开${label}`。
  - 要求 `HomePanel` 导入并渲染 `HomeQuickActionIcon`，不再把 `iconLabel(action.label)` 塞进快捷入口图标。
  - 要求 `HomeQuickActionIcon` 覆盖四类 icon，并保持 28x28。
- 初次运行红灯，原因是四个 action 的 icon 都是 `undefined`。
- 增加数据字段、图标组件和 HomePanel 渲染后目标测试转绿。

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1`。
- 首页实测：
  - `.quick-action` 数量为 4。
  - 四个入口的 `.home-quick-action-icon` 均为 28x28。
  - 四个入口 SVG 分别有 4/4/5/9 个 path/circle 元素。
  - 图标容器 textContent 为空，不再显示首字 fallback。
  - 快捷入口、首页面板和底部状态栏横向溢出为空数组。
- 点击 `打开设置` 快捷入口后实测：
  - `.settings-panel` 和 `.settings-header` 存在。
  - `.search-status-bar` 数量为 0。
  - 设置页相关容器横向溢出为空数组。
- console error/warn 为 0。

验证：

```bash
pnpm test:home-quick-action-icons
pnpm test:home-surface
pnpm test:search-status-bar
pnpm test:settings-header-style
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:home-quick-action-icons`：通过。
- `pnpm test:home-surface`：通过。
- `pnpm test:search-status-bar`：通过。
- `pnpm test:settings-header-style`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，182 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`agent_tools_count:8`，权限/数据/系统设置 smoke 均通过。退出阶段仍有 Vite `write EPIPE` 停服日志，但命令退出码为 0，脚本输出 `Desktop smoke passed`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 99% | 99% | 首页常用入口从首字小卡片升级为明确图标入口，体感更接近桌面命令面板 |
| 测试与发布 | 99% | 99% | 新增首页快捷入口图标化守护测试，并通过浏览器 DOM/console、构建和真实 desktop smoke |
| ZTools 设置页 UI | 99% | 99% | 本批只验证设置入口跳转和设置页无底栏残留 |
| Agent/MCP 底座 | 95% | 95% | 本批不改 MCP/Agent |

当前重点剩余：

1. 内置程序体验：继续打磨主搜索极端结果量信息密度、空态、最近使用和设置页局部状态。
2. 设置真实功能：WebDAV 插件数据恢复应用、冲突合并和更细粒度确认仍未接入。
3. Agent/MCP：客户端自动写入/合并配置仍未做。
4. 插件 tools 暴露和插件 bridge 回归按当前要求暂缓。
5. macOS 发布质量：签名、公证、自动更新仍未接入。

## 第八十四批：主搜索底部状态栏和按键提示

用户要求：继续还原完成度，插件不着急，先完善内置程序体验。本批聚焦主搜索面板：此前最近使用和搜索结果只在行内给出局部 `Enter` 提示，缺少 uTools/ZTools 常见的底部状态栏，用户无法稳定看到当前选择、结果数量和可用键盘动作。

状态：DONE。

修改文件：

- `src/App.svelte`
- `src/components/SearchStatusBar.svelte`
- `src/lib/searchStatusBar.ts`
- `scripts/test-search-status-bar.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 `searchStatusBarView` 纯逻辑：
  - 最近使用态显示 `最近使用`、当前位置/总数和选中项名称。
  - 搜索结果态显示 `搜索结果`、当前位置/总数和选中项名称。
  - 空结果态显示 `0 项匹配`。
  - 根据设置中的 Tab 行为显示 `Tab 切换` 或 `Tab 执行`。
- 新增 `SearchStatusBar.svelte`：
  - 固定 34px 高底栏。
  - 左侧展示当前列表状态，右侧展示 `↑↓/←→`、`Enter`、`Tab`、`Esc` 按键提示。
  - keycap 使用桌面工具常见的紧凑按键视觉，不占用主结果行空间。
  - 720px 以下自动隐藏后两个提示，避免窄窗口横向溢出。
- 主搜索最近使用态和搜索结果态均挂载底栏。
- 设置页、插件页、系统页不挂载底栏，避免干扰设置页 ZTools 风格布局。
- 桌面窗口高度计算为最近使用/搜索结果态增加 34px，避免 Tauri 窗口裁切底栏。

TDD 记录：

- 先新增 `scripts/test-search-status-bar.mjs` 和 `pnpm test:search-status-bar`：
  - 要求 `searchStatusBarView` 输出最近使用、结果、空结果三种状态。
  - 要求组件存在 34px 底栏、border-top、ellipsis 状态文案、flex hints 和 24px keycap。
  - 要求 `App.svelte` 挂载最近使用/搜索结果两处状态栏，并把窗口高度计算纳入 `SEARCH_STATUS_BAR_HEIGHT`。
- 初次运行红灯，原因是 `src/lib/searchStatusBar.ts` 不存在。
- 实现逻辑、组件和 App 挂载后目标测试转绿。

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1`。
- 最近使用态实测：
  - `.search-status-bar` 存在，尺寸为 1278x34。
  - 文案包含 `最近使用 1 / 12`、`Enter 打开`、`Tab 切换`、`Esc 收起`。
  - `.shell-frame/.search-surface/.home-panel/.search-status-bar/.status-copy/.status-hints` 横向溢出为空数组。
- 搜索 `set` 后实测：
  - 结果行数量为 2。
  - 状态栏文案为 `搜索结果 1 / 2 · 设置`，包含 `↑↓ 移动`、`Enter 执行`、`Tab 切换`、`Esc 清空`。
  - `.shell-frame/.search-surface/.results-list/.result-row/.search-status-bar/.status-copy/.status-hints` 横向溢出为空数组。
- 进入设置页后实测：
  - `.settings-panel` 和 `.settings-header` 存在。
  - `.search-status-bar` 数量为 0。
  - 设置页相关容器横向溢出为空数组。
- console error/warn 为 0。

验证：

```bash
pnpm test:search-status-bar
pnpm test:result-presentation
pnpm test:home-surface
pnpm test:settings-header-style
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:search-status-bar`：通过。
- `pnpm test:result-presentation`：通过。
- `pnpm test:home-surface`：通过。
- `pnpm test:settings-header-style`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，180 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`agent_tools_count:8`，权限/数据/系统设置 smoke 均通过，脚本输出 `Desktop smoke passed`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 99% | 99% | 最近使用和搜索结果新增底部状态栏，持续展示当前选择、结果数量和键盘动作，更接近 uTools/ZTools 命令面板体感 |
| 测试与发布 | 99% | 99% | 新增状态栏逻辑/结构守护测试，并通过浏览器 DOM/console、构建和真实 desktop smoke |
| ZTools 设置页 UI | 99% | 99% | 本批确认设置页不显示主搜索底栏，避免干扰设置页布局 |
| Agent/MCP 底座 | 95% | 95% | 本批不改 MCP/Agent |

当前重点剩余：

1. 内置程序体验：继续打磨主搜索极端结果量信息密度、空态、最近使用和设置页局部状态。
2. 设置真实功能：WebDAV 插件数据恢复应用、冲突合并和更细粒度确认仍未接入。
3. Agent/MCP：客户端自动写入/合并配置仍未做。
4. 插件 tools 暴露和插件 bridge 回归按当前要求暂缓。
5. macOS 发布质量：签名、公证、自动更新仍未接入。

## 第八十三批：设置页顶部标签栏尺寸对齐

用户要求：插件不着急，先继续完善内置程序体验。本批聚焦设置页最顶部：此前 header 只有 58px、tab 只有 36px，小/大 Z 标识也偏小，和 ZTools 截图中厚重的桌面标签栏差距明显。

状态：DONE。

修改文件：

- `src/components/SettingsHeader.svelte`
- `src/components/ZMark.svelte`
- `scripts/test-settings-header-style.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 设置页顶部 header 从 58px 提升到 94px，padding 调整为 `20px 22px 0`。
- 顶部 tab 从 36px 提升到 72px，字号提升到 26px，tab 间距提升到 14px。
- 激活 tab 最小宽度提升到 196px，圆角提升到 36px，并保留右侧斜切造型。
- 次级 tab 最小宽度提升到 154px，左侧负 margin/内边距同步扩大，贴近 ZTools 的双标签叠放形态。
- 关闭按钮提升到 28px，三点更多按钮提升到 32x72px，点尺寸提升到 5px。
- 三笔画圆形 Z 标识尺寸同步放大：small 为 42px，large 为 72px，设置页顶部视觉权重更接近截图。

TDD 记录：

- 先新增 `scripts/test-settings-header-style.mjs` 和 `pnpm test:settings-header-style`：
  - 要求 header、tab、激活/次级 tab、关闭按钮、更多按钮达到新的大尺寸。
  - 要求 `ZMark` small/large 分别为 42px/72px。
- 初次运行红灯，原因是当前 header 仍为 58px、tab 仍为 36px，`ZMark` small/large 仍为旧尺寸。
- 修改 `SettingsHeader.svelte` 和 `ZMark.svelte` 后目标测试转绿。

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1` 并进入设置页。
- 桌面视口实测：
  - `.settings-header` 为 94px 高，paddingTop 为 20px，paddingLeft 为 22px。
  - `.active-tab` 为 196x72，圆角为 `36px 0 0 36px`，字号为 26px。
  - `.secondary-tab` 为 160x72，圆角为 `0 36px 36px 0`，字号为 26px，paddingLeft 为 42px。
  - `.tab-close` 为 28x28，字号为 30px。
  - `.more-btn` 为 32x72。
  - `.z-mark.small` 为 42x42，`.z-mark.large` 为 72x72，均包含 3 条笔画。
  - 横向溢出为空数组。
- console error/warn 为 0。

验证：

```bash
pnpm test:settings-header-style
pnpm test:z-mark
pnpm test:settings-controls-style
pnpm test:settings-pages
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:settings-header-style`：通过。
- `pnpm test:z-mark`：通过。
- `pnpm test:settings-controls-style`：通过。
- `pnpm test:settings-pages`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，176 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`agent_tools_count:8`，权限/数据/系统设置 smoke 均通过。退出阶段仍有 Vite `write EPIPE` 停服日志，但命令退出码为 0，脚本输出 `Desktop smoke passed`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 99% | 99% | 顶部标签栏从紧凑网页标题升级为高标签栏、大 tab 和大号 Z 标识，和 ZTools 设置页截图更接近 |
| 测试与发布 | 99% | 99% | 新增顶部标签栏样式守护测试，并通过浏览器 DOM/console、构建和真实 desktop smoke |
| ZTools/uTools 主搜索体验 | 99% | 99% | 本批不改主搜索 |
| Agent/MCP 底座 | 95% | 95% | 本批不改 MCP/Agent |

当前重点剩余：

1. 内置程序体验：继续打磨设置页局部状态、主搜索极端结果量和真实桌面交互细节。
2. 设置真实功能：WebDAV 插件数据恢复应用、冲突合并和更细粒度确认仍未接入。
3. Agent/MCP：客户端自动写入/合并配置仍未做。
4. 插件 tools 暴露和插件 bridge 回归按当前要求暂缓。
5. macOS 发布质量：签名、公证、自动更新仍未接入。

## 第八十二批：设置页控件尺寸对齐

用户要求：继续还原内置程序体验。本批聚焦设置页控件体感：右侧内容区已经拉开后，输入框/下拉仍是 36px，按钮 32px，开关 48x27，和 ZTools 截图里的大号桌面控件差距明显。

状态：DONE。

修改文件：

- `src/components/SettingsPanel.svelte`
- `scripts/test-settings-controls-style.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 输入框、下拉、数字框从 36px 提升到 48px，圆角提升到 8px。
- 呼出快捷键输入框宽度从 232px 提升到 300px，字号提升到 17px。
- 下拉框最小宽度从 170px 提升到 240px，并同步调整箭头位置到 48px 控件节奏。
- 普通按钮/图标按钮从 32px 左右提升到 42px/44px，padding 增加到 18px。
- 开关从 48x27 提升到 64x36，knob 从 17px 提升到 26px，选中位移同步调整。
- 720px 以下保留控件回退：输入/下拉 40px，开关 52x30，按钮 36px，避免窄窗口被撑坏。

TDD 记录：

- 先新增 `scripts/test-settings-controls-style.mjs` 和 `pnpm test:settings-controls-style`：
  - 要求桌面输入/下拉/按钮/开关达到新的大尺寸。
  - 要求下拉箭头、开关 knob 和 checked 位移同步适配。
  - 要求 720px 以下存在小屏回退。
- 初次运行红灯，原因是文本输入仍为旧宽度、整体控件仍处于紧凑规格。
- 修改 CSS 后目标测试转绿。

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1` 并进入设置页。
- 桌面视口实测：
  - `.hotkey-input` 为 300x48，圆角 8px，字号 17px。
  - `.select-control` 为 240x48，padding 为 18/46px。
  - `.icon-button` 为 44x42，`.plain-button` 高度为 42px，左右 padding 18px。
  - `.toggle` 为 64x36，knob 为 26x26，位置为 top/left 4px。
  - 控件相关横向溢出为空数组。
- console error/warn 为 0。

验证：

```bash
pnpm test:settings-controls-style
pnpm test:settings-content-style
pnpm test:settings-sidebar-style
pnpm test:settings-pages
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:settings-controls-style`：通过。
- `pnpm test:settings-content-style`：通过。
- `pnpm test:settings-sidebar-style`：通过。
- `pnpm test:settings-pages`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，176 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`agent_tools_count:8`，权限/数据/系统设置 smoke 均通过。退出阶段仍有 Vite `write EPIPE` 停服日志，但命令退出码为 0，脚本输出 `Desktop smoke passed`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 99% | 99% | 设置控件从紧凑网页表单升级为大尺寸桌面控件，和 ZTools 设置页截图更接近 |
| 测试与发布 | 99% | 99% | 新增控件样式守护测试，并通过浏览器 DOM/console、构建和真实 desktop smoke |
| ZTools/uTools 主搜索体验 | 99% | 99% | 本批不改主搜索 |
| Agent/MCP 底座 | 95% | 95% | 本批不改 MCP/Agent |

当前重点剩余：

1. 内置程序体验：继续打磨设置页局部交互、空状态和主搜索极端结果量信息密度。
2. 设置真实功能：WebDAV 插件数据恢复应用、冲突合并和更细粒度确认仍未接入。
3. Agent/MCP：客户端自动写入/合并配置仍未做。
4. 插件 tools 暴露和插件 bridge 回归按当前要求暂缓。
5. macOS 发布质量：签名、公证、自动更新仍未接入。

## 第八十一批：设置页右侧内容区节奏对齐

用户要求：继续还原内置程序体验。本批聚焦设置页右侧内容区，左侧导航拉宽后，右侧仍保留旧的 16/20px 紧凑 padding、标题下方 3px 间距和 74px 行高，和 ZTools 截图里的桌面设置页呼吸感不一致。

状态：DONE。

修改文件：

- `src/components/SettingsPanel.svelte`
- `scripts/test-settings-content-style.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `content-panel` 桌面 padding 从 `16px 24px 22px 20px` 调整为 `34px 44px 40px 40px`，内容起点更接近 ZTools 设置页。
- `setting-group` 间距从 24px 提升到 34px。
- 分组标题从 14px 提升到 15px，标题下方间距从 3px 提升到 16px。
- 设置行最低高度从 74px 提升到 82px，垂直 padding 从 18px 提升到 20px。
- 设置项主/副文案分别提升到 15px/13px，label 间距从 4px 提升到 6px。
- 720px 以下内容区保留紧凑 padding，避免窄窗口过度挤压。

TDD 记录：

- 先新增 `scripts/test-settings-content-style.mjs` 和 `pnpm test:settings-content-style`：
  - 要求桌面内容区 padding 为 `34px 44px 40px 40px`。
  - 要求分组标题间距、字号、设置行高度和主/副文字号达到 ZTools 风格节奏。
  - 要求 720px 以下回落为 `20px 20px 24px 18px`。
- 初次运行红灯，原因是当前内容区仍是旧紧凑样式。
- 修改 CSS 后目标测试转绿。

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1` 并进入设置页。
- 桌面视口实测：
  - `.content-panel` padding 为 `34px / 44px / 40px / 40px`。
  - `setting-group` margin-bottom 为 34px。
  - `h3` margin-bottom 为 16px，font-size 为 15px。
  - 首个 `.setting-item` min-height 为 82px，实测高度约 83px。
  - setting label 主/副文案为 15px/13px。
  - 标题到内容区顶部距离为 34px，标题到首行距离为 16px。
  - `.settings-panel/.settings-sidebar/.settings-content/.content-panel/.setting-item/.setting-label` 横向溢出为空数组。
- console error/warn 为 0。

验证：

```bash
pnpm test:settings-content-style
pnpm test:settings-sidebar-style
pnpm test:settings-pages
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:settings-content-style`：通过。
- `pnpm test:settings-sidebar-style`：通过。
- `pnpm test:settings-pages`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，176 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`agent_tools_count:8`，权限/数据/系统设置 smoke 均通过。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 99% | 99% | 右侧内容区从紧凑表单节奏升级为更宽松的桌面设置页节奏，和 ZTools 截图更接近 |
| 测试与发布 | 99% | 99% | 新增内容区样式守护测试，并通过浏览器 DOM/console、构建和真实 desktop smoke |
| ZTools/uTools 主搜索体验 | 99% | 99% | 本批不改主搜索 |
| Agent/MCP 底座 | 95% | 95% | 本批不改 MCP/Agent |

当前重点剩余：

1. 内置程序体验：继续打磨设置页局部交互、空状态和主搜索极端结果量信息密度。
2. 设置真实功能：WebDAV 插件数据恢复应用、冲突合并和更细粒度确认仍未接入。
3. Agent/MCP：客户端自动写入/合并配置仍未做。
4. 插件 tools 暴露和插件 bridge 回归按当前要求暂缓。
5. macOS 发布质量：签名、公证、自动更新仍未接入。

## 第八十批：设置页左侧导航密度对齐

用户要求：继续还原内置程序体验。本批聚焦设置页左侧导航，当前 192px 侧栏和 42px 菜单行相对 ZTools 截图偏紧，视觉上更像普通后台列表，不像桌面设置页。

状态：DONE。

修改文件：

- `src/components/SettingsPanel.svelte`
- `scripts/test-settings-sidebar-style.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 设置页侧栏从固定 `192px` 调整为 `clamp(220px, 24vw, 280px)`，大窗口下更接近 ZTools 宽侧栏。
- 左侧菜单行从 `42px` 提升到 `56px`，图标从 `19px` 提升到 `24px`。
- 菜单项间距、padding 和圆角放大，选中态增加弱内描边，形成更明确的 pill。
- 720px 以下保留收窄规则：侧栏 `184px`、菜单行 `48px`，避免小窗口挤压内容区。

TDD 记录：

- 先新增 `scripts/test-settings-sidebar-style.mjs` 和 `pnpm test:settings-sidebar-style`：
  - 要求侧栏使用响应式宽度 `clamp(220px, 24vw, 280px)`。
  - 要求桌面菜单行至少 56px、图标 24px、选中态有内描边。
  - 要求 720px 以下回落到 184px/48px。
- 初次运行红灯，原因是当前样式仍为 192px 侧栏、42px 菜单行、19px 图标。
- 修改 CSS 后目标测试转绿。

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1` 并进入设置页。
- 桌面视口实测：
  - `.settings-sidebar` 宽度为 280px。
  - `.menu-item.active` 高度为 56px，宽度为 249px。
  - `.menu-icon` 为 24x24。
  - active border radius 为 12px，box-shadow 为 1px inset 弱内描边。
  - `.settings-panel/.settings-sidebar/.menu-item/.settings-content/.content-panel` 横向溢出为空数组。
- console error/warn 为 0。

验证：

```bash
pnpm test:settings-sidebar-style
pnpm test:settings-pages
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:settings-sidebar-style`：通过。
- `pnpm test:settings-pages`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，176 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`agent_tools_count:8`，权限/数据/系统设置 smoke 均通过。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 99% | 99% | 左侧导航从紧凑列表升级为宽侧栏、大菜单行和更清晰的选中 pill，更接近 ZTools 设置页 |
| 测试与发布 | 99% | 99% | 新增侧栏样式守护测试，并通过浏览器 DOM/console、构建和真实 desktop smoke |
| ZTools/uTools 主搜索体验 | 99% | 99% | 本批不改主搜索 |
| Agent/MCP 底座 | 95% | 95% | 本批不改 MCP/Agent |

当前重点剩余：

1. 内置程序体验：继续打磨设置页局部交互、空状态和主搜索极端结果量信息密度。
2. 设置真实功能：WebDAV 插件数据恢复应用、冲突合并和更细粒度确认仍未接入。
3. Agent/MCP：客户端自动写入/合并配置仍未做。
4. 插件 tools 暴露和插件 bridge 回归按当前要求暂缓。
5. macOS 发布质量：签名、公证、自动更新仍未接入。

## 第七十九批：主搜索和设置页 Z 标识还原

用户要求：插件不着急，先继续完善内置程序体验。本批聚焦一个视觉差距明显的点：此前主搜索右侧和设置页顶部圆形徽标只是文字 `Z`，不像 ZTools 截图里的斜切 Z 标识。

状态：DONE。

修改文件：

- `src/components/ZMark.svelte`
- `src/components/SearchBar.svelte`
- `src/components/SettingsHeader.svelte`
- `scripts/test-z-mark.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增可复用 `ZMark.svelte`：
  - 用 top / diagonal / bottom 三条白色笔画组成斜切 Z 标识。
  - 支持 `small` / `badge` / `large` 三种尺寸。
  - 有 label 时以 `role="img"` 和 `aria-label` 暴露语义；无 label 时 `aria-hidden=true`。
- `SearchBar` 右侧设置入口从文字 `Z` 替换为 38px 三笔画圆形 Z 标识，原点击打开设置行为保留。
- `SettingsHeader` 顶部标签内小图标和右侧大图标都替换为同一个 ZMark 组件，避免两处样式漂移。
- 删除 header 里文字 Z 徽标的重复 CSS，徽标视觉收敛到一个组件。

TDD 记录：

- 先新增 `scripts/test-z-mark.mjs` 和 `pnpm test:z-mark`：
  - 要求存在 `ZMark.svelte`。
  - 要求 ZMark 包含 `top`、`diagonal`、`bottom` 三条 stroke。
  - 要求 `SearchBar` 和 `SettingsHeader` 都导入并使用 ZMark。
  - 要求旧的 `>Z</button>`、`>Z</span>` 不再出现。
- 初次运行红灯，原因是 `src/components/ZMark.svelte` 不存在。
- 实现组件和替换后目标测试转绿。

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1`。
- 首页：
  - `.app-badge .z-mark` 存在，class 包含 `badge`。
  - `.z-stroke` 数量为 3。
  - 徽标尺寸为 38x38，文本内容为空。
  - 搜索框、徽标横向溢出为 0。
- 点击徽标进入设置页：
  - `.settings-header .z-mark` 数量为 2。
  - 小徽标尺寸为 28x28，`aria-hidden=true`。
  - 大徽标尺寸为 42x42，`aria-label="设置"`，`role="img"`。
  - header、tab、sidebar、content、ZMark 横向溢出为 0；sidebar 仅有预期纵向滚动。
  - console error/warn 为 0。

验证：

```bash
pnpm test:z-mark
pnpm test:result-presentation
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:z-mark`：通过。
- `pnpm test:result-presentation`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，176 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`agent_tools_count:8`，权限/数据/系统设置 smoke 均通过。退出阶段仍有 Vite 停服日志，但命令退出码为 0，脚本输出 `Desktop smoke passed`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 99% | 99% | 主搜索右侧徽标从文字 Z 改为三笔画圆形 Z，首屏视觉更接近 ZTools |
| ZTools 设置页 UI | 99% | 99% | 设置页顶部小/大 Z 徽标统一为三笔画组件，减少与 ZTools 截图的明显差距 |
| 测试与发布 | 99% | 99% | 新增 Z 标识使用测试，并通过浏览器 DOM/console、构建和真实 desktop smoke |
| Agent/MCP 底座 | 95% | 95% | 本批不改 MCP/Agent |

当前重点剩余：

1. 内置程序体验：继续打磨设置页空状态、局部交互和主搜索极端结果量信息密度。
2. 设置真实功能：WebDAV 插件数据恢复应用、冲突合并和更细粒度确认仍未接入。
3. Agent/MCP：客户端自动写入/合并配置仍未做。
4. 插件 tools 暴露和插件 bridge 回归按当前要求暂缓。
5. macOS 发布质量：签名、公证、自动更新仍未接入。

## Batch 276：Desktop PluginPanel FS load spec smoke

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 275 的 Web preview fixture bridge API replay，把真实 desktop activation plan smoke 从 `FeatureAction` 基础 payload 校验推进到真实 `PluginPanel` 文件系统加载规格校验。

本批实现：

- `src-tauri/src/desktop_smoke.rs`
  - `ZToolsExternalActivationSmokeSummary` 新增 `plugin_panel_fs_load_checked`。
  - `ok()` 要求导入样本数与 `plugin_panel_fs_load_checked` 一致。
  - 新增 PluginPanel FS load spec 校验：canonical `action.plugin_path` 必须等于导入插件目录；`action.main_url` 必须是相对路径，并 canonicalize 到插件目录内的真实文件；可选 `action.preload_path` 必须 canonicalize 到同一插件目录内的真实文件；payload 不允许使用 Web preview 专用 `iframeSrc` / `srcdoc`。
  - External activation plan smoke 在每个实际导入/激活样本上累加 `plugin_panel_fs_load_checked`。
- `scripts/smoke-tauri-desktop.mjs`
  - parser 现在要求 `ztools_external_activation_smoke.plugin_panel_fs_load_checked` 出现在机器输出中。
- `src-tauri/tests/webdav_tests.rs`
  - 测试 fixture 的 `WebdavSyncConfig` 补齐 `proxy_url: None`，恢复全量 Cargo 测试编译。

TDD：

- `cargo test -p atools --lib desktop_smoke::tests::ztools_external_activation_smoke_consumes_plan_imports_and_cleans_up_sample` 首次红灯：`ZToolsExternalActivationSmokeSummary` 没有 `plugin_panel_fs_load_checked` 字段。
- `pnpm test:tauri-desktop-smoke-script` 首次红灯：缺失 `plugin_panel_fs_load_checked` 的 smoke 输出没有被 parser 拦截。
- 加入 summary 字段、FS load spec 校验和 parser contract 后两个专项测试转绿。
- `cargo test -p atools` 首次运行暴露当前 WebDAV integration tests fixture 缺 `proxy_url` 字段；补齐后全量 Cargo 测试转绿。

真实 smoke 基线：

```bash
ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop
```

结果：

- `status:"ok"`。
- `planned_samples:10`。
- `imported_samples:8`。
- `activated_samples:8`。
- `ui_actions_checked:8`。
- `plugin_panel_fs_load_checked:8`。
- `assertions_checked:8`。
- `cleanup_verified:8`。
- `skipped_samples:2`。
- `sample_plugin_ids:["ztools-developer-plugin","latex-ocr","2048","cron","developer-codec-tools","ibox-wallpaper","mybatis-sql-formatter","random-data"]`。
- `error:null`。

验证：

- `pnpm test:tauri-desktop-smoke-script`：通过。
- `cargo test -p atools --lib desktop_smoke`：通过，10/10 desktop smoke 单测。
- `cargo test -p atools`：通过，75 lib tests、31 Agent tests、3 crash tests、9 WebDAV tests、3 ZTools import tests。
- `pnpm check`：通过，0 errors / 0 warnings。
- `pnpm build`：通过，仅保留既有 Vite chunk warning。
- `pnpm smoke:tauri-desktop`：通过，空 external activation summary 中 `plugin_panel_fs_load_checked:0`。
- `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop`：通过，8/8 `plugin_panel_fs_load_checked`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入 | 99% | 99% | 真实 desktop activation plan smoke 现在证明 8 个实际导入样本都能形成 PluginPanel 文件系统加载规格；仍未自动渲染逐插件 UI |
| 插件 iframe 宿主 | 99% | 99% | 与 `PluginPanel.loadPluginHtml()` 的路径读取契约对齐，但还不是 Tauri UI iframe 渲染和视觉回归 |
| 测试与发布 | 99% | 99% | full `cargo test -p atools` 重新转绿，desktop smoke 机器输出 contract 覆盖新字段 |

当前重点剩余：

1. 插件生态：仍需在真实 Tauri UI 中自动打开已导入插件的 `PluginPanel` iframe 并确认渲染结果，而不是只验证 FS load spec。
2. 插件生态：逐插件视觉截图和真实 native bridge probe 全样本执行仍未完成。
3. 插件安全：证书链/吊销/平台级签名策略仍未接入。
4. PluginPanel BrowserWindow 子 iframe same-origin 兼容债、macOS 签名/公证/自动更新仍需后续收口。

## Batch 275：Real fixture bridge API probe replay

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 274 的 resource-clean PluginPanel matrix，把 generated real-entry fixture 从基础生命周期探针推进到 in-browser bridge API 探针回放。

本批实现：

- `scripts/ztools-plugin-ui-host-smoke-report.mjs`
  - 新增 9 个 fixture bridge API probe id：`fixture-bridge-get-path`、`fixture-bridge-context`、`fixture-bridge-db-storage`、`fixture-bridge-db-all-docs`、`fixture-bridge-app-identity`、`fixture-bridge-system-flags`、`fixture-bridge-preload-ky`、`fixture-bridge-services`、`fixture-bridge-web-storage`。
  - Generated fixture 在 ready timeout 内执行 `runBridgeApiProbes()`，把结果写入 `window.__atoolsRealEntryFixture.bridgeApiProbes` 和 `data-atools-real-entry-bridge-api-*` DOM attributes。
  - `__atools_real_entry_fixture_probe__` message 现在携带 `bridgeApiProbes`，并把 9 个 bridge API probe 追加到基础 probe result list。
  - Standalone fixture matrix 聚合 `bridgeApiPassed` / `bridgeApiTotal` / `bridgeApiFailedIds`，每行渲染 `bridgeApi=X/Y bridgeApiFailed=...`，bridge API 失败会让 row status 进入 `error`。
  - Report summary 新增 `real_entry_fixture_bridge_api_probe_checks`，每个 plan 的 `real_entry_fixture` 记录 `bridge_api_probe_ids`。
- `scripts/test-ztools-plugin-ui-host-smoke-report.mjs`
  - 覆盖 summary 计数、per-plan probe id、fixture script marker、DOM attribute marker 和 matrix bridge API count rendering。

TDD：

- `pnpm test:ztools-plugin-ui-host-smoke-report` 首次红灯：`report.summary.real_entry_fixture_bridge_api_probe_checks` 缺失，断言显示 `undefined !== 18`。
- 加入 bridge API probe replay、report summary 和 matrix 聚合后专项测试转绿。

真实报告基线：

```bash
pnpm report:ztools-ui-host-smoke -- --plan output/ztools-plugin-activation-plan.json --output output/ztools-plugin-ui-host-smoke-report.json --base-url http://localhost:1420/ --fixture-output output/ztools-ui-host-real-entry-fixtures --fixture-base-url http://127.0.0.1:1434/
```

结果：

- `ui_host_samples:10/10`。
- `real_entry_html_ready:10/10`。
- `real_entry_resource_ready:30/30`。
- `real_entry_fixture_count:10`。
- `real_entry_fixture_bytes:3744497`。
- `real_entry_fixture_matrix_count:10`。
- `real_entry_fixture_matrix_bytes:12770`。
- `real_entry_plugin_panel_checks:10`。
- `real_entry_plugin_panel_ready:10`。
- `real_entry_plugin_panel_matrix_count:10`。
- `real_entry_plugin_panel_matrix_bytes:27695`。
- `real_entry_fixture_bridge_api_probe_checks:90`。
- `real_entry_fixture_runtime_support_files:85`。
- `real_entry_fixture_runtime_support_bytes:6315299`。
- Top plan: `calculation-paper -> calc`。

Browser matrix checks：

- App served at `localhost:1420`，fixture server served at `127.0.0.1:1434` via `pnpm serve:ztools-ui-host-fixtures -- --root output/ztools-ui-host-real-entry-fixtures --host 127.0.0.1 --port 1434`。
- Standalone URL: `http://127.0.0.1:1434/index.html`。
  - Matrix contained 10 fixture iframes and 10 rows.
  - Every row reported `ready ready=true bridge=true ztools=true identity=true bridgeApi=9/9 bridgeApiFailed= errors=0`.
  - Browser dev logs: `[]`。
- PluginPanel URL: `http://127.0.0.1:1434/plugin-panel-matrix.html`。
  - Matrix contained 10 panel iframes and 10 rows.
  - Every row reported `ready passed=15/15 failed=`.
  - Browser dev logs: `[]`。

验证：

- `pnpm test:ztools-plugin-ui-host-smoke-report`：通过。
- `pnpm test:ztools-ui-host-fixture-server`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm check`：通过，0 errors / 0 warnings。
- `pnpm build`：通过，仅保留既有 Vite chunk warning。
- `pnpm smoke:tauri-desktop`：通过。
- `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop`：通过，10 planned、8 imported/activated/ui actions/assertions/cleanup、2 skipped。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入 | 99% | 99% | 10 个 generated real fixture 已记录并回放 bridge API probe ids，standalone matrix 达到 `bridgeApi=9/9`；仍不是 Tauri FS 中真实导入插件 |
| 插件 iframe 宿主 | 99% | 99% | Web preview PluginPanel matrix 从 `passed=6/6` 提升到 `passed=15/15`，但主验证仍走 HTTP fixture URL |
| 插件 runtime parity | 99% | 99% | bridge API replay 覆盖常见低风险 API shape，但仍不是完整 native bridge 深回放 |
| 测试与发布 | 99% | 99% | 新增 report red/green、真实 report 基线、Browser standalone/PluginPanel matrix 行级验证和完整回归；截图像素仍未作为通过证据 |

当前重点剩余：

1. 插件生态：仍需在真实 Tauri FS `PluginPanel` iframe 中加载已导入插件路径，而不是 Web preview HTTP fixture。
2. 插件生态：逐插件视觉截图和真实 native bridge probe 全样本执行仍未完成。
3. 插件安全：证书链/吊销/平台级签名策略仍未接入。
4. PluginPanel BrowserWindow 子 iframe same-origin 兼容债、macOS 签名/公证/自动更新仍需后续收口。

## Batch 274：PluginPanel matrix resource clean pass

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 273 的 10-panel PluginPanel matrix，把剩余 Browser 资源/CORS/sandbox storage 边界收口到 console 0 warn/error。

本批实现：

- `scripts/serve-ztools-ui-host-fixtures.mjs`
  - 新增专用 fixture 静态服务。
  - 支持 CORS headers、`OPTIONS` preflight、字体/script/json MIME、`GET`/`HEAD` 和 path traversal 防护。
  - 暴露 `pnpm serve:ztools-ui-host-fixtures`。
- `scripts/ztools-plugin-ui-host-smoke-report.mjs`
  - Runtime support 扩展到 `.woff` / `.woff2` / `.ttf` / `.otf` / `.eot`。
  - 复制 CSS `@import` / `url()` 间接依赖到浏览器实际解析路径，覆盖 FontAwesome 和 ClearSans 字体资源。
  - Fixture bridge 在 sandbox 无 `allow-same-origin` 时安装 `localStorage` / `sessionStorage` stub，不放宽主插件 iframe sandbox。
  - PluginPanel matrix 保存并渲染 `errorMessages` / `messages=`，失败时可直接看到真实 fixture error。
- `src/components/PluginPanel.svelte`
  - 转发 `__atools_real_entry_fixture_probe__` 时保留 `errors: errorMessages`，供矩阵诊断。

TDD：

- `pnpm test:ztools-plugin-ui-host-smoke-report` 首次红灯：fixture 输出没有复制 CSS 字体依赖，matrix 不渲染 `messages=`，fixture bridge 没有 sandbox storage stub。
- 加入 CSS 依赖复制、matrix diagnostics 和 storage stub 后专项测试转绿。
- `pnpm test:ztools-ui-host-fixture-server` 首次红灯：缺少 CORS fixture server 和 package scripts。
- 加入 server 与 `test:ztools-ui-host-fixture-server` / `serve:ztools-ui-host-fixtures` 后专项测试转绿。
- `pnpm test:plugin-host-view` 首次红灯：`PluginPanel` 没有透传 real fixture error messages。
- 加入 `errors: errorMessages` 后专项测试转绿。

真实报告基线：

```bash
pnpm report:ztools-ui-host-smoke -- --plan output/ztools-plugin-activation-plan.json --output output/ztools-plugin-ui-host-smoke-report.json --base-url http://localhost:1420/ --fixture-output output/ztools-ui-host-real-entry-fixtures --fixture-base-url http://127.0.0.1:1434/
```

结果：

- `ui_host_samples:10/10`。
- `real_entry_html_ready:10/10`。
- `real_entry_resource_ready:30/30`。
- `real_entry_fixture_count:10`。
- `real_entry_fixture_bytes:3702617`。
- `real_entry_fixture_matrix_count:10`。
- `real_entry_fixture_matrix_bytes:11608`。
- `real_entry_plugin_panel_checks:10`。
- `real_entry_plugin_panel_ready:10`。
- `real_entry_plugin_panel_matrix_count:10`。
- `real_entry_plugin_panel_matrix_bytes:27695`。
- `real_entry_fixture_runtime_support_files:85`。
- `real_entry_fixture_runtime_support_bytes:6315299`。
- Top plan: `calculation-paper -> calc`。

Browser PluginPanel matrix check：

- App served at `localhost:1420`，fixture server served at `127.0.0.1:1434` via `pnpm serve:ztools-ui-host-fixtures -- --root output/ztools-ui-host-real-entry-fixtures --host 127.0.0.1 --port 1434`。
- URL: `http://127.0.0.1:1434/plugin-panel-matrix.html`。
- Matrix DOM markers: expected `10`、ready `10`、errors `0`、allReady `true`。
- Matrix contained 10 app PluginPanel iframes.
- Every row reported `ready passed=6/6 failed=`:
  - `calculation-paper -> calc`
  - `ztools-developer-plugin -> ui.router`
  - `latex-ocr -> latex-editor`
  - `2048 -> 2048`
  - `cron -> cron`
  - `developer-codec-tools -> codec-tools`
  - `ibox-wallpaper -> ibox`
  - `mybatis-sql-formatter -> format-sql-log`
  - `qrcode-helper -> qrcode`
  - `random-data -> randomDataSettings`
- Browser dev logs: `[]`。

验证：

- `pnpm test:ztools-ui-host-fixture-server`：通过。
- `pnpm test:ztools-plugin-ui-host-smoke-report`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm check`：通过，0 errors / 0 warnings。
- `pnpm build`：通过，仅保留既有 Vite chunk warning。
- `pnpm smoke:tauri-desktop`：通过。
- `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop`：通过，10 planned、8 imported/activated/ui actions/assertions/cleanup、2 skipped。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入 | 99% | 99% | 10 个 generated real fixture 已通过 resource-clean PluginPanel matrix，资源/CORS/storage 边界已收口到 Browser console 0；但仍不是 Tauri FS 中真实导入插件 |
| 插件 iframe 宿主 | 99% | 99% | 主插件 iframe 继续保持无 `allow-same-origin` sandbox，同时 fixture bridge 用 storage stub 兼容真实插件 storage 读取；真实 Tauri FS 加载和视觉/bridge 深回放仍未完成 |
| 测试与发布 | 99% | 99% | 新增 fixture server 测试、report/plugin host 红绿测试、真实 report matrix 基线、Browser DOM/dev-log 验证；截图像素仍未作为通过证据 |

当前重点剩余：

1. 插件生态：仍需在真实 Tauri FS `PluginPanel` iframe 中加载已导入插件路径，而不是 Web preview HTTP fixture。
2. 插件生态：逐插件视觉截图和真实 bridge probe 全样本执行仍未完成。
3. 插件安全：证书链/吊销/平台级签名策略仍未接入。
4. PluginPanel BrowserWindow 子 iframe same-origin 兼容债、macOS 签名/公证/自动更新仍需后续收口。

## Batch 273：PluginPanel real fixture matrix

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 272 的“首个 generated fixture 通过 Web preview PluginPanel shell”，把 10 个 generated fixture 全部纳入 Web preview PluginPanel matrix 回放。

本批实现：

- `scripts/ztools-plugin-ui-host-smoke-report.mjs`
  - 新增顶层 `real_entry_plugin_panel_matrix`。
  - 在 fixture 输出目录生成 `plugin-panel-matrix.html`。
  - Matrix 嵌入所有 ready `real_entry_plugin_panel.url` app preview URL。
  - Matrix 通过 `__atools_plugin_panel_real_entry_probe__` 消息汇总每个 app PluginPanel iframe 的 passed/total/failed 状态。
  - Summary 新增 `real_entry_plugin_panel_matrix_count` 和 `real_entry_plugin_panel_matrix_bytes`。
- `src/components/PluginPanel.svelte`
  - 收到 `__atools_real_entry_fixture_probe__` 后，继续更新本机 `宿主探针` chip。
  - 当 payload 标记为 real fixture preview 时，向父窗口转发 `__atools_plugin_panel_real_entry_probe__`，包含 plugin id、feature code、fixture src、probes、passed、total 和 failedIds。

TDD：

- `pnpm test:ztools-plugin-ui-host-smoke-report` 首次红灯：summary 缺少 `real_entry_plugin_panel_matrix_count`，且报告没有 `real_entry_plugin_panel_matrix`。
- 加入 matrix HTML/report 输出后专项测试转绿。
- `pnpm test:plugin-host-view` 首次红灯：`PluginPanel` 没有 `__atools_plugin_panel_real_entry_probe__` 转发路径。
- 加入父窗口 postMessage 转发后专项测试转绿。

真实报告基线：

```bash
pnpm report:ztools-ui-host-smoke -- --plan output/ztools-plugin-activation-plan.json --output output/ztools-plugin-ui-host-smoke-report.json --base-url http://localhost:1420/ --fixture-output output/ztools-ui-host-real-entry-fixtures --fixture-base-url http://127.0.0.1:1434/
```

结果：

- `ui_host_samples:10/10`。
- `real_entry_html_ready:10/10`。
- `real_entry_resource_ready:30/30`。
- `real_entry_fixture_count:10`。
- `real_entry_fixture_bytes:3691187`。
- `real_entry_fixture_matrix_count:10`。
- `real_entry_fixture_matrix_bytes:11608`。
- `real_entry_plugin_panel_checks:10`。
- `real_entry_plugin_panel_ready:10`。
- `real_entry_plugin_panel_matrix_count:10`。
- `real_entry_plugin_panel_matrix_bytes:27351`。
- `real_entry_fixture_runtime_support_files:70`。
- `real_entry_fixture_runtime_support_bytes:4949752`。
- Top plan: `calculation-paper -> calc`。

Browser PluginPanel matrix check：

- App served at `localhost:1420`，fixture directory served at `127.0.0.1:1434`。
- URL: `http://127.0.0.1:1434/plugin-panel-matrix.html`。
- Matrix DOM markers: expected `10`、ready `10`、errors `0`、allReady `true`。
- Matrix contained 10 app PluginPanel iframes.
- Every row reported `ready passed=6/6 failed=`:
  - `calculation-paper -> calc`
  - `ztools-developer-plugin -> ui.router`
  - `latex-ocr -> latex-editor`
  - `2048 -> 2048`
  - `cron -> cron`
  - `developer-codec-tools -> codec-tools`
  - `ibox-wallpaper -> ibox`
  - `mybatis-sql-formatter -> format-sql-log`
  - `qrcode-helper -> qrcode`
  - `random-data -> randomDataSettings`
- Playwright full-frame console still reported 26 errors and 12 warnings from known sandbox/null-origin asset/runtime boundaries: FontAwesome fonts, dynamic chunks, JSON preflight, codec script loading, favicon, target-densitydpi warnings, and one Umami init error.
- Batch 274 later resolved this PluginPanel matrix Browser resource/console boundary with the CORS fixture server, CSS/font support copying, and sandbox storage stubs.
- This batch proves PluginPanel shell/lifecycle/bridge/probe readiness, not visual asset completeness.

验证：

- `pnpm test:ztools-plugin-ui-host-smoke-report`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm check`：通过，0 errors / 0 warnings。
- `pnpm build`：通过，仅保留既有 Vite chunk warning。
- `pnpm smoke:tauri-desktop`：通过。
- `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop`：通过，10 planned、8 imported/activated/ui actions/assertions/cleanup、2 skipped。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入 | 99% | 99% | 10 个 generated real fixture 已经通过 Web preview PluginPanel matrix 回放并回传 `passed=6/6`；但仍不是 Tauri FS 中真实导入插件 |
| 插件 iframe 宿主 | 99% | 99% | PluginPanel 已能全样本承载 generated real fixture URL 并向矩阵转发 probe；真实 Tauri FS 加载和视觉/bridge 深回放仍未完成 |
| 测试与发布 | 99% | 99% | 新增 report/plugin host 红绿测试、真实 report matrix 基线、Browser DOM/dev-log 验证；截图像素仍未作为通过证据 |

当前重点剩余：

1. 插件生态：仍需在真实 Tauri FS `PluginPanel` iframe 中加载已导入插件路径，而不是 Web preview HTTP fixture。
2. 插件生态：逐插件视觉截图和真实 bridge probe 全样本执行仍未完成。
3. 插件生态：PluginPanel matrix 已验证脚本/lifecycle probe，但字体、图片、MathJax 等装饰资源仍需更深的视觉资源 pass。
4. 插件安全：证书链/吊销/平台级签名策略仍未接入。
5. 插件 iframe 宿主：BrowserWindow 子 iframe 仍为 hosted WebContents 兼容保留 same-origin，完整跨源化需要单独控制通道。
6. macOS 发布质量：签名、公证、自动更新仍未接入。

## Batch 272：PluginPanel real fixture URL smoke

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 271 的“10 个 standalone fixture matrix 通过”，把首个 generated real fixture 接入实际 Web preview `PluginPanel` shell，通过 iframe `src` 加载，而不是只在 standalone matrix 页面运行。

本批实现：

- `scripts/ztools-plugin-ui-host-smoke-report.mjs`
  - 新增 `--fixture-base-url` CLI 参数。
  - 每个 plan item 新增 `real_entry_plugin_panel`。
  - `real_entry_plugin_panel` 记录 status、app preview URL、fixture path、fixture URL、probe ids 和 expected DOM。
  - 生成 app preview action 时使用 `payload.iframeSrc` 指向本地 HTTP fixture URL，不把真实第三方 HTML 复制进 `srcdoc`。
  - 真实 fixture probe postMessage 增加命名 probes：ready、bridge、ztools alias、identity、script-error status。
  - Summary 新增 `real_entry_plugin_panel_checks` 和 `real_entry_plugin_panel_ready`。
- `src/components/PluginPanel.svelte`
  - Web preview payload 支持 `iframeSrc`。
  - `iframeSrc` 与 `iframeSrcDoc` 互斥，iframe 渲染时使用 `src={iframeSrc || undefined}` 和 `srcdoc={iframeSrc ? undefined : iframeSrcDoc}`。
  - 只接受本地 HTTP(S) 或 file preview iframe URL。
  - 消费 `__atools_real_entry_fixture_probe__` 并转成现有 `宿主探针` runtime chip。

TDD：

- `pnpm test:ztools-plugin-ui-host-smoke-report` 首次红灯：summary 缺少 `real_entry_plugin_panel_checks` / `real_entry_plugin_panel_ready`，且 action payload 未提供 iframe fixture URL。
- 加入 `real_entry_plugin_panel` 后专项测试转绿。
- `pnpm test:plugin-host-view` 首次红灯：`PluginPanel` 缺少 `iframeSrc` state、preview `payload.iframeSrc` 支持、iframe `src/srcdoc` 互斥和 real fixture probe handler。
- 加入 `PluginPanel` iframe URL 支持和 probe handler 后专项测试转绿。

真实报告基线：

```bash
pnpm report:ztools-ui-host-smoke -- --plan output/ztools-plugin-activation-plan.json --output output/ztools-plugin-ui-host-smoke-report.json --base-url http://localhost:1420/ --fixture-output output/ztools-ui-host-real-entry-fixtures --fixture-base-url http://127.0.0.1:1432/
```

结果：

- `ui_host_samples:10/10`。
- `real_entry_html_ready:10/10`。
- `real_entry_resource_ready:30/30`。
- `real_entry_fixture_count:10`。
- `real_entry_fixture_bytes:3691187`。
- `real_entry_fixture_matrix_count:10`。
- `real_entry_fixture_matrix_bytes:11608`。
- `real_entry_plugin_panel_checks:10`。
- `real_entry_plugin_panel_ready:10`。
- `real_entry_fixture_runtime_support_files:70`。
- `real_entry_fixture_runtime_support_bytes:4949752`。
- Top plan: `calculation-paper -> calc`。

Browser PluginPanel check：

- App served at `localhost:1420`，fixture directory served at `127.0.0.1:1432`。
- URL: first `real_entry_plugin_panel.url` from `output/ztools-plugin-ui-host-smoke-report.json`。
- Browser DOM verified title `ATools 3.0`、plugin title `计算稿纸`、one main plugin iframe、iframe `src=http://127.0.0.1:1432/001-calculation-paper-calc.html`、empty `srcdoc`、sandbox `allow-scripts allow-popups`。
- Runtime strip verified `运行状态 iframe`、bridge detail `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`、`宿主探针 6/6`。
- Browser dev logs warn/error: `[]`。
- No Vite error overlay and no horizontal overflow.
- Screenshot capture still timed out on `Page.captureScreenshot`; screenshot pixels are not pass evidence for this batch.

验证：

- `pnpm test:ztools-plugin-ui-host-smoke-report`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm check`：通过，0 errors / 0 warnings。
- `pnpm build`：通过，仅保留既有 Vite chunk warning。
- `pnpm smoke:tauri-desktop`：通过。
- `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop`：通过，10 planned、8 imported/activated/ui actions/assertions/cleanup、2 skipped。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入 | 99% | 99% | 首个 generated real fixture 已经通过 app Web preview `PluginPanel` iframe `src` 加载并回传 probe；但仍不是 Tauri FS 中真实导入插件 |
| 插件 iframe 宿主 | 99% | 99% | PluginPanel 已能承载 generated real fixture URL 并消费 real-entry probe；10 样本全量 PluginPanel 回放和真实 Tauri FS 加载仍未完成 |
| 测试与发布 | 99% | 99% | 新增 report/plugin host 红绿测试、真实 report 基线、Browser DOM/dev-log 验证；截图像素仍未作为通过证据 |

当前重点剩余：

1. 插件生态：仍需把 10 个 generated fixture 全部纳入 app `PluginPanel` 回放，而不是只验证首个样本。
2. 插件生态：仍需在真实 Tauri FS `PluginPanel` iframe 中加载已导入插件路径，而不是 Web preview HTTP fixture。
3. 插件生态：逐插件视觉截图和真实 bridge probe 全样本执行仍未完成。
4. 插件生态：首个 PluginPanel fixture 已验证脚本/lifecycle probe，但字体、图片、MathJax 等装饰资源仍需更深的视觉资源 pass。
5. 插件安全：证书链/吊销/平台级签名策略仍未接入。
6. 插件 iframe 宿主：BrowserWindow 子 iframe 仍为 hosted WebContents 兼容保留 same-origin，完整跨源化需要单独控制通道。
7. macOS 发布质量：签名、公证、自动更新仍未接入。

## Batch 271：Real entry fixture matrix verification

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 270 的“首个真实 fixture 浏览器渲染”，把 10 个生成 fixture 全部纳入本地 HTTP Browser matrix 验证。范围仍不宣称真实 app `PluginPanel` iframe 已经加载外部插件路径，也不把截图像素作为通过证据。

本批实现：

- `scripts/ztools-plugin-ui-host-smoke-report.mjs`
  - 在 `--fixture-output` 目录生成 `index.html` matrix harness。
  - Matrix 通过 same-origin iframes 加载全部生成 fixture，并暴露 DOM-readable expected/ready/error/all-ready markers。
  - `real_entry_fixture_matrix` 记录 status、path、file URL、bytes、SHA-256 和 fixture count。
  - Summary 新增 `real_entry_fixture_matrix_count`、`real_entry_fixture_matrix_bytes`、`real_entry_fixture_runtime_support_files` 和 `real_entry_fixture_runtime_support_bytes`。
  - Fixture 生成会复制 runtime support 文件，包括 sibling dynamic JS/CSS/JSON/assets 和插件根 `json/`。
  - Fixture bridge 增加 DOM-readable error messages、realistic plugin enter context、`db.promises`、sync path/context/platform helpers、`window.services`、`window.Preload.ky.create` 和 `formatMybatisLog` 等常见 preload/service stubs。

TDD：

- Matrix summary 和生成 `index.html` 断言先红灯，再加入 matrix harness 后转绿。
- Fixture error-message marker 断言先红灯，再加入 `data-atools-real-entry-error-messages` 后转绿。
- Bridge/context/service/runtime support 断言先红灯，再补齐 `getPath`、`getContext`、plugin enter context、`db.promises`、service stubs、dynamic chunks、plugin-root `json/` copy 和 runtime support summary 后转绿。

真实报告基线：

```bash
pnpm report:ztools-ui-host-smoke -- --plan output/ztools-plugin-activation-plan.json --output output/ztools-plugin-ui-host-smoke-report.json --base-url http://localhost:1420/ --fixture-output output/ztools-ui-host-real-entry-fixtures
```

结果：

- `ui_host_samples:10/10`。
- `real_entry_html_ready:10/10`。
- `real_entry_resource_ready:30/30`。
- `real_entry_fixture_count:10`。
- `real_entry_fixture_bytes:3684367`。
- `real_entry_fixture_matrix_count:10`。
- `real_entry_fixture_matrix_bytes:11608`。
- `real_entry_fixture_runtime_support_files:70`。
- `real_entry_fixture_runtime_support_bytes:4949752`。
- Fixture matrix SHA-256: `5a3c3e990bd5a42d3763c7e76c9475a81861043655c4df7bdb5005beabfb8734`。
- Top plan: `calculation-paper -> calc`。

Browser matrix check：

- Fixture directory was served through local HTTP at `127.0.0.1:1431`。
- URL: `http://127.0.0.1:1431/index.html`。
- Matrix DOM markers: expected `10`、ready `10`、errors `0`、allReady `true`。
- Every row reported ready/bridge/ztools/identity true and error count 0。
- Console warn/error: `[]`。

验证：

- `pnpm test:ztools-plugin-ui-host-smoke-report`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm check`：通过，0 errors / 0 warnings。
- `pnpm build`：通过，仅保留既有 Vite chunk warning。
- `pnpm smoke:tauri-desktop`：通过。
- `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop`：通过，10 planned、8 imported/activated/ui actions/assertions/cleanup、2 skipped。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入 | 99% | 99% | 10 个 standalone real entry fixture 已通过 Browser matrix 生命周期/bridge/identity 脚本错误检查，但尚未进入真实 app `PluginPanel` iframe |
| 测试与发布 | 99% | 99% | 新增 all-fixture matrix 红绿测试、真实报告基线和 Browser DOM/console 验证；截图像素仍未作为通过证据 |

当前重点剩余：

1. 插件生态：仍需在真实 app `PluginPanel` iframe 中加载已导入插件路径，而不是 standalone fixture。
2. 插件生态：逐插件视觉截图和真实 bridge probe 全样本执行仍未完成。
3. 插件生态：matrix 已验证脚本/lifecycle  readiness，但字体、图片、MathJax 等装饰资源仍需更深的视觉资源 pass。
4. 插件安全：证书链/吊销/平台级签名策略仍未接入。
5. 插件 iframe 宿主：BrowserWindow 子 iframe 仍为 hosted WebContents 兼容保留 same-origin，完整跨源化需要单独控制通道。
6. macOS 发布质量：签名、公证、自动更新仍未接入。

## Batch 270：Real entry browser fixture emission

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 269 的真实入口依赖 readiness，把 UI host smoke report 继续推进到“能生成浏览器可加载的真实 HTML fixture，并完成首个真实样本渲染验证”。范围仍不宣称 10 个真实第三方插件已经全部进入 app `PluginPanel` iframe 回放。

本批实现：

- `scripts/ztools-plugin-ui-host-smoke-report.mjs`
  - 新增 `--fixture-output` CLI 参数。
  - 新增 `real_entry_fixture` 输出。
  - 为每个真实入口 HTML 生成 fixture 文件。
  - fixture 会内联 local entry scripts 和 stylesheet links。
  - fixture 会在插件代码前注入最小 `utools`/`ztools` bridge。
  - fixture bridge 写入 DOM-readable markers：`data-atools-real-entry-fixture`、`data-atools-real-entry-ready`、`data-atools-real-entry-bridge-present`、`data-atools-real-entry-ztools-alias`、plugin id、feature code 和 error count。
  - `real_entry_fixture` 记录 status、path、file URL、bytes、SHA-256、inlined script/stylesheet counts 和 probe ids。

TDD：

- `pnpm test:ztools-plugin-ui-host-smoke-report` 首次红灯：summary 缺少 `real_entry_fixture_bytes`。
- 实现 fixture 生成后专项测试转绿。
- 后续补充 DOM-readable bridge marker 测试先红灯，再加入 `data-atools-real-entry-bridge-present` / `data-atools-real-entry-ztools-alias` 后转绿。

真实报告基线：

```bash
pnpm report:ztools-ui-host-smoke -- --plan output/ztools-plugin-activation-plan.json --output output/ztools-plugin-ui-host-smoke-report.json --base-url http://localhost:1420/ --fixture-output output/ztools-ui-host-real-entry-fixtures
```

结果：

- `ui_host_samples:10/10`。
- `real_entry_html_ready:10/10`。
- `real_entry_resource_ready:30/30`。
- `real_entry_resource_missing:0`。
- `real_entry_fixture_count:10`。
- `real_entry_fixture_bytes:3644645`。
- Fixture directory: `output/ztools-ui-host-real-entry-fixtures`。
- Top plan: `calculation-paper -> calc`。

首个 fixture 证据：

- path: `/Users/harris/Desktop/atools/output/ztools-ui-host-real-entry-fixtures/001-calculation-paper-calc.html`。
- bytes: `1028777`。
- SHA-256: `c33636bebe9e3a57e1c80fa97c34d61b8dddbb8f7c90df1dde0957b01450f31a`。
- inlined scripts: `1`。
- inlined stylesheets: `0`。

Browser rendered check：

- Direct `file://` navigation was blocked by Browser URL policy; the same fixture directory was served through local HTTP at `127.0.0.1:1430`.
- URL: `http://127.0.0.1:1430/001-calculation-paper-calc.html`。
- DOM snapshot rendered real sample UI: `计算公式` textbox, `清空`, `备注`, `保存稿纸`, `我的稿纸` controls.
- DOM markers: `data-atools-real-entry-fixture=true`, `data-atools-real-entry-ready=true`, `data-atools-real-entry-bridge-present=true`, `data-atools-real-entry-ztools-alias=true`。
- Plugin identity markers: `calculation-paper`, feature code `calc`。
- Console warn/error: `[]`。

验证：

- `pnpm test:ztools-plugin-ui-host-smoke-report`：通过。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入 | 98% | 99% | 真实外部样本已能生成浏览器可加载 fixture，首个真实插件 HTML 已渲染到 DOM 并通过 bridge/lifecycle marker 验证 |
| 测试与发布 | 99% | 99% | 新增真实 HTML fixture 生成红绿测试和首样本 Browser DOM 验证；截图仍未作为通过证据 |

当前重点剩余：

1. 插件生态：仍需把 10 个真实 fixture 全部纳入自动 Browser loop，而不是只验证首个样本。
2. 插件生态：仍需在 app `PluginPanel` iframe 中加载真实插件路径，而不是 standalone fixture。
3. 插件生态：逐插件视觉截图和真实 bridge probe 全样本执行仍未完成。
4. 插件安全：证书链/吊销/平台级签名策略仍未接入。
5. 插件 iframe 宿主：BrowserWindow 子 iframe 仍为 hosted WebContents 兼容保留 same-origin，完整跨源化需要单独控制通道。
6. macOS 发布质量：签名、公证、自动更新仍未接入。

## Batch 269：Real entry resource dependency baseline

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 268 的真实入口 HTML readiness，把 UI host smoke report 继续推进到“真实入口 HTML 依赖的本地脚本/样式资源也可读、可定位、可校验”。范围仍不包含在 app iframe 中实际执行第三方 HTML。

本批实现：

- `scripts/ztools-plugin-ui-host-smoke-report.mjs`
  - 解析每个真实入口 HTML 的 local `<script src>`。
  - 解析每个真实入口 HTML 的 stylesheet `<link rel="stylesheet">`。
  - 新增 `real_entry_resources` 字段。
  - `real_entry_resources` 记录 expected/status、total/ready/missing counts、总 bytes、scripts、stylesheets 和 missing。
  - script 记录 `kind`、原始 URL、absolute path、`module` 标记、byte size 和 SHA-256。
  - stylesheet 记录 `kind`、原始 URL、absolute path、byte size 和 SHA-256。
  - HTTP(S)、protocol-relative、data URL、hash-only URL 不作为本地资源缺失计入。

TDD：

- `pnpm test:ztools-plugin-ui-host-smoke-report` 首次红灯：summary 缺少 `real_entry_resource_checks`、`real_entry_resource_ready`、`real_entry_resource_missing` 和 `real_entry_resource_bytes`。
- 实现本地脚本/样式依赖解析和读取后，专项测试转绿。
- 测试 fixture 覆盖普通 script、module script 和 stylesheet，并验证 path、bytes、SHA-256、module 标记和 missing 为空。

真实报告基线：

```bash
pnpm report:ztools-ui-host-smoke -- --plan output/ztools-plugin-activation-plan.json --output output/ztools-plugin-ui-host-smoke-report.json --base-url http://localhost:1420/
```

结果：

- `ui_host_samples:10/10`。
- `real_entry_html_ready:10/10`。
- `real_entry_html_missing:0`。
- `real_entry_html_bytes:80631`。
- `real_entry_resource_checks:30`。
- `real_entry_resource_ready:30`。
- `real_entry_resource_missing:0`。
- `real_entry_resource_bytes:3530202`。
- Top plan: `calculation-paper -> calc`。

首个样本证据：

- `plugin_id: calculation-paper`。
- `real_entry_resources.total_resources: 1`。
- `real_entry_resources.ready_resources: 1`。
- `real_entry_resources.missing_resources: 0`。
- `index.js` path: `/Users/harris/Desktop/ZTools-plugins/plugins/calculation-paper/index.js`。
- `index.js` bytes: `1025290`。
- `index.js` SHA-256: `f501c6389c211754cf459253c9e6f9d204b44d59cc65b08b29e30665a535a54a`。

验证：

- `pnpm test:ztools-plugin-ui-host-smoke-report`：通过。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入 | 97% | 98% | UI host smoke report 已确认每个真实样本入口依赖的本地脚本/样式资源可读、可定位并带 hash，真实渲染前置文件门禁更完整 |
| 测试与发布 | 99% | 99% | 新增真实 entry dependency readiness 红绿测试和 report JSON 基线；仍未把 Browser screenshot timeout 纳入通过证据 |

当前重点剩余：

1. 插件生态：仍需让 10 个真实第三方插件 HTML 在 app iframe 中逐个实际执行，而不是只验证入口和依赖文件。
2. 插件生态：逐插件真实 HTML iframe ready、视觉截图和真实 bridge probe 全样本执行仍未完成。
3. 插件安全：证书链/吊销/平台级签名策略仍未接入。
4. 插件 iframe 宿主：BrowserWindow 子 iframe 仍为 hosted WebContents 兼容保留 same-origin，完整跨源化需要单独控制通道。
5. macOS 发布质量：签名、公证、自动更新仍未接入。

## Batch 268：Real entry HTML readiness baseline

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 267 的 externalPlan 探针回收，把 UI host smoke report 从“最小 srcdoc 可回传宿主探针”继续推进到“逐样本真实入口 HTML 文件可读、可定位、可校验、可作为后续真实渲染输入”。范围仍不包含把第三方 HTML 复制进 Web preview URL，也不声明真实 HTML 已逐个 iframe 渲染执行。

本批实现：

- `scripts/ztools-plugin-ui-host-smoke-report.mjs`
  - 读取每个样本真实插件目录下的 `manifest.main`。
  - 新增 `real_entry_html` 字段。
  - `real_entry_html` 记录 `expected`、`status`、`main_url`、absolute `html_path`、entry directory、relative entry directory、byte size、SHA-256 和 `resource_signals`。
  - `resource_signals` 统计入口 HTML 内的 external script、module script、inline script、stylesheet link、image/media `src` 和直接 `utools`/`ztools` bridge reference。
  - 对 missing source path、outside-source main URL、missing main file 使用状态字段表达，不把样本直接伪装成 ready。
  - Web preview 仍使用 minimal probe `srcdoc`，不复制第三方 HTML 内容。

TDD：

- `pnpm test:ztools-plugin-ui-host-smoke-report` 首次红灯：summary 缺少 `real_entry_html_checks`、`real_entry_html_ready`、`real_entry_html_missing` 和 `real_entry_html_bytes`。
- 实现真实入口 HTML readiness 采集后，专项测试转绿。
- 测试 fixture 覆盖根目录 `index.html` 和子目录 `ui/main.html`，并验证 entry directory、SHA-256、脚本/样式资源信号以及 preview 不复制第三方 HTML。

真实报告基线：

```bash
pnpm report:ztools-ui-host-smoke -- --plan output/ztools-plugin-activation-plan.json --output output/ztools-plugin-ui-host-smoke-report.json --base-url http://localhost:1420/
```

结果：

- `ui_host_samples:10/10`。
- `iframe_ready_checks:10`。
- `screenshot_viewport_checks:20`。
- `bridge_probe_checks:50`。
- `real_entry_html_checks:10`。
- `real_entry_html_ready:10`。
- `real_entry_html_missing:0`。
- `real_entry_html_bytes:80631`。
- Top plan: `calculation-paper -> calc`。

首个样本证据：

- `plugin_id: calculation-paper`。
- `main_url: index.html`。
- `html_path: /Users/harris/Desktop/ZTools-plugins/plugins/calculation-paper/index.html`。
- `bytes: 163`。
- `sha256: d776b6d7eb19b9cecf2319ce529a2d17dbf8c0a03de954bb1f18b6197ef7add0`。
- `resource_signals.script_src_count: 1`。
- `resource_signals.stylesheet_link_count: 0`。
- `resource_signals.image_reference_count: 0`。

验证：

- `pnpm test:ztools-plugin-ui-host-smoke-report`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，仍只有既有 Vite chunk-size warning。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入 | 96% | 97% | UI host smoke report 已对每个真实样本记录入口 HTML readiness、hash、路径和资源信号，后续真实渲染自动化可直接消费 |
| 测试与发布 | 99% | 99% | 新增真实入口 HTML readiness 红绿测试和 report JSON 基线；仍未把 Browser screenshot timeout 纳入通过证据 |

当前重点剩余：

1. 插件生态：仍需让 10 个真实第三方插件 HTML 在 iframe 中逐个实际渲染，而不是只读取入口文件。
2. 插件生态：逐插件真实 HTML iframe ready、视觉截图和真实 bridge probe 全样本执行仍未完成。
3. 插件安全：证书链/吊销/平台级签名策略仍未接入。
4. 插件 iframe 宿主：BrowserWindow 子 iframe 仍为 hosted WebContents 兼容保留 same-origin，完整跨源化需要单独控制通道。
5. macOS 发布质量：签名、公证、自动更新仍未接入。

## Batch 267：ExternalPlan probe result recovery

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 266 的 UI host fixture/report，把 externalPlan iframe 内部探针从“报告里的预期项”推进到“运行时实际回传并在 PluginPanel 宿主运行条展示”。范围仍不包含逐个执行真实第三方插件 HTML 页面。

本批实现：

- `src/lib/pluginHostView.ts`
  - `pluginHostView` 状态新增 `uiHostProbePassed`、`uiHostProbeTotal` 和 `uiHostProbeFailedIds`。
  - runtime strip 在收到探针汇总后新增 `宿主探针` chip。
  - 全部通过时显示 `5/5` 和 `iframe 已回传 bridge/lifecycle 探针`，失败时显示失败数量和失败 id。
- `src/components/PluginPanel.svelte`
  - 新增 `UiHostProbeResult` 状态。
  - `handleMessage` 消费 iframe postMessage 中的 `__atools_ui_host_probe_result__`。
  - 按当前 `pluginId` 和 `featureCode` 过滤过期或不匹配报告。
  - 归一化 `data.probes[]`，计算 passed/total/failedIds，并传给 `pluginHostView`。
  - active plugin owner 变化时清空旧探针状态。
- `scripts/ztools-plugin-ui-host-smoke-report.mjs`
  - externalPlan `srcdoc` 监听 `atools-plugin-enter` 和 `atools-plugin-ready`。
  - 收集 5 项探针：`plugin-enter-event`、`plugin-ready-event`、`utools-bridge-present`、`ztools-alias-present`、`iframe-dom-identity`。
  - 将探针写入 `window.__atoolsExternalUiHostSmoke.probeResults`。
  - 向父窗口 postMessage `__atools_ui_host_probe_result__`，并保留 fallback timeout，避免宿主 lifecycle 消息缺失时永远没有结果。

TDD / Debugging：

- `pnpm test:plugin-host-view` 首次红灯：runtime strip 最后一项仍为 `桥接能力`，没有 `宿主探针`。
- `pnpm test:ztools-plugin-ui-host-smoke-report` 首次红灯：生成的 externalPlan HTML 不包含 `__atools_ui_host_probe_result__` 和 probe result collection。
- 实现 PluginHostView/PluginPanel/srcdoc 回传路径后，上述两个专项测试转绿。
- desktop smoke 曾被并行执行触发一次 `Port 1420 is already in use`，定位为两个 Vite dev server 同时启动的端口竞争；改为串行运行后标准 smoke 通过。

真实报告基线：

```bash
pnpm report:ztools-ui-host-smoke -- --plan output/ztools-plugin-activation-plan.json --output output/ztools-plugin-ui-host-smoke-report.json --base-url http://localhost:1420/
```

结果：

- `ui_host_samples:10/10`。
- `iframe_ready_checks:10`。
- `screenshot_viewport_checks:20`。
- `bridge_probe_checks:50`。
- Top plan: `calculation-paper -> calc`。

Browser rendered check：

- 第一个 externalPlan URL 加载页面标题 `ATools 3.0`。
- 页面显示 `计算稿纸`、`calc`、`calculation-paper`。
- 运行状态为 iframe，bridge capability strip 显示 `utools/ztools`。
- PluginPanel runtime strip 显示 `宿主探针 5/5`。
- 主插件 iframe sandbox 为 `allow-scripts allow-popups`。
- console warn/error 为空。
- 无 framework overlay，无横向溢出。
- Browser screenshot capture 仍在 `Page.captureScreenshot` 超时，未作为通过证据。

验证：

- `pnpm test:plugin-host-view`：通过。
- `pnpm test:ztools-plugin-ui-host-smoke-report`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，仍只有既有 Vite chunk-size warning。
- `pnpm smoke:tauri-desktop`：串行重跑通过，标准 no-plan `ztools_external_activation_smoke` 为空 counts，`ui_actions_checked:0`。
- `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop`：通过，10 planned、8 imported、8 activated、8 UI actions checked、8 assertions checked、8 cleanup verified、2 skipped、`error:null`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入 | 95% | 96% | externalPlan iframe 探针结果可回收到 PluginPanel，并在宿主 runtime strip 显示 `宿主探针 5/5` |
| 测试与发布 | 99% | 99% | 新增 UI host probe result recovery 专项和 Browser rendered check；截图仍受 Browser CDP timeout 限制 |

当前重点剩余：

1. 插件生态：externalPlan 仍使用最小 `srcdoc`，尚未执行 10 个真实第三方插件 HTML。
2. 插件生态：逐插件真实 HTML iframe ready、视觉截图和真实 bridge probe 全样本执行仍未完成。
3. 插件安全：证书链/吊销/平台级签名策略仍未接入。
4. 插件 iframe 宿主：BrowserWindow 子 iframe 仍为 hosted WebContents 兼容保留 same-origin，完整跨源化需要单独控制通道。
5. macOS 发布质量：签名、公证、自动更新仍未接入。

## Batch 266：External ZTools UI host smoke report

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 265 的 `FeatureAction` payload 验证，把真实外部 activation plan 继续推进为 UI host 自动化可消费的 fixture/report。范围仍不包含把每个真实第三方插件 HTML 都实际跑完 iframe-ready、截图和 bridge probe。

本批实现：

- `scripts/ztools-plugin-ui-host-smoke-report.mjs`
  - 读取 `output/ztools-plugin-activation-plan.json`。
  - 对每个 activation plan 读取真实 `plugin.json`，生成 desktop `FeatureAction` fixture。
  - fixture 覆盖 plugin id/name、feature code、main URL、安装后 plugin path、可选 preload path、受限 expand height、manifest permissions 和 trigger payload。
  - 为每个样本生成 Web preview `pluginHostSmoke=externalPlan` URL。
  - 每个样本输出 iframe-ready expectation、2 个截图视口和 5 个 bridge probes。
  - Web preview srcdoc 使用最小探针，不复制第三方插件 HTML。
- `src/App.svelte`
  - 新增 `pluginHostSmoke=externalPlan` 模式。
  - 从 `pluginHostSmokeAction` base64url 参数恢复 `FeatureAction`。
  - 使用 `TextDecoder` 解码 UTF-8，避免中文插件名/触发词 mojibake。
- `package.json`
  - 新增 `test:ztools-plugin-ui-host-smoke-report`。
  - 新增 `report:ztools-ui-host-smoke`。

TDD / Debugging：

- `pnpm test:ztools-plugin-ui-host-smoke-report` 首次失败：缺少 `ztools-plugin-ui-host-smoke-report.mjs`。
- 增加报告脚本、package 入口和 App externalPlan mode 后目标测试转绿。
- Browser 验证发现 `计算稿纸` 在 App 中显示为 mojibake；定位到 App 用 raw `atob()` 解析 UTF-8 JSON。
- 扩展测试要求 `TextDecoder` UTF-8 解码后红灯，再改成 base64url bytes -> `TextDecoder` 后转绿。

真实报告基线：

```bash
pnpm report:ztools-ui-host-smoke -- --plan output/ztools-plugin-activation-plan.json --output output/ztools-plugin-ui-host-smoke-report.json --base-url http://localhost:1420/
```

结果：

- `planned_samples:10`。
- `ui_host_samples:10`。
- `desktop_action_fixtures:10`。
- `web_preview_actions:10`。
- `iframe_ready_checks:10`。
- `screenshot_viewport_checks:20`。
- `bridge_probe_checks:50`。
- `preload_expected_samples:6`。
- `permission_scoped_samples:0`。
- `skipped_samples:0`。
- Top plan: `calculation-paper -> calc`。

Browser rendered check：

- URL：`http://localhost:1420/?parity=1&pluginHostSmoke=externalPlan&pluginHostSmokeAction=...`。
- 页面标题为 `ATools 3.0`。
- 页面显示 `计算稿纸`、`calc`、`calculation-paper`。
- 运行状态为 iframe，bridge capability strip 显示 `utools/ztools`。
- 主插件 iframe sandbox 为 `allow-scripts allow-popups`。
- console warn/error 为空。
- 无 framework overlay，无横向溢出。
- Browser screenshot capture 仍在 `Page.captureScreenshot` 超时，未作为通过证据。

验证：

- `pnpm test:ztools-plugin-ui-host-smoke-report`：通过。
- `pnpm test:ztools-plugin-activation-plan`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，仍只有既有 Vite chunk-size warning。
- `pnpm smoke:tauri-desktop`：通过，标准 no-plan `ztools_external_activation_smoke` 为空 counts，`ui_actions_checked:0`。
- `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop`：通过，10 planned、8 imported、8 activated、8 UI actions checked、8 assertions checked、8 cleanup verified、2 skipped、`error:null`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入 | 94% | 95% | 真实 ZTools activation plan 可生成 UI host fixture/report，后续自动化可逐样本消费 iframe-ready、bridge probe 和截图视口期望 |
| 测试与发布 | 99% | 99% | 新增 UI host smoke report 专项和 Web preview rendered check；截图仍受 Browser CDP timeout 限制 |

当前重点剩余：

1. 插件生态：仍需逐插件真实 HTML iframe ready、视觉截图、bridge probe 自动执行和结果回收。
2. 插件安装：源码型插件缺少已构建 main 文件，需要 build/install 策略或市场包策略。
3. 插件安全：证书链/吊销/平台级签名策略仍未接入。
4. 插件 iframe 宿主：BrowserWindow 子 iframe 仍为 hosted WebContents 兼容保留 same-origin，完整跨源化需要单独控制通道。
5. macOS 发布质量：签名、公证、自动更新仍未接入。

## Batch 265：External ZTools activation smoke validates PluginPanel payload

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 264 的外部插件 activation desktop smoke，把“导入/feature 激活查找/断言/清理”推进到验证 `activate_feature_inner` 返回的 `FeatureAction` 是否满足 `PluginPanel` 打开插件 UI 的宿主前置条件。范围仍不包含逐插件视觉打开、iframe-ready 截图或 bridge 调用回放。

本批实现：

- `src-tauri/src/desktop_smoke.rs`
  - `ZToolsExternalActivationSmokeSummary` 新增 `ui_actions_checked`。
  - 外部 activation smoke 导入样本后调用真实 `activate_feature_inner`。
  - 使用 plan 中的 `activation.trigger_type` 和 `activation.query` 构造 activation payload。
  - 验证返回 `FeatureAction` 的 `plugin_id`、`feature_code`、`plugin_path`、`main_url`、可选 `preload_path` 和 `expand_height`。
  - `ok()` 条件新增 `imported_samples == ui_actions_checked`，避免只查到 feature 但没有宿主可用 payload。

TDD：

- `cargo test -p atools --lib ztools_external_activation_smoke_consumes_plan_imports_and_cleans_up_sample` 首次失败：`ZToolsExternalActivationSmokeSummary` 缺少 `ui_actions_checked` 字段。
- 增加 summary 字段、plan activation payload 读取、`activate_feature_inner` 调用和 `FeatureAction` 校验后目标测试转绿。

真实 smoke 基线：

```bash
ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop
```

结果：

- `status:"ok"`。
- `mcp_bind:"127.0.0.1:65409"`。
- `ztools_external_activation_smoke.plan_path` 解析到 `/Users/harris/Desktop/atools/output/ztools-plugin-activation-plan.json`。
- `planned_samples:10`。
- `imported_samples:8`。
- `activated_samples:8`。
- `ui_actions_checked:8`。
- `assertions_checked:8`。
- `cleanup_verified:8`。
- `skipped_samples:2`，原因是 feature code 已归属现有插件，smoke 为避免污染内置索引而跳过。
- `sample_plugin_ids`: `ztools-developer-plugin`、`latex-ocr`、`2048`、`cron`、`developer-codec-tools`、`ibox-wallpaper`、`mybatis-sql-formatter`、`random-data`。

验证：

- `cargo test -p atools --lib desktop_smoke`：10 passed。
- `cargo test -p atools --test ztools_import_tests`：3 passed。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm test:ztools-plugin-activation-plan`：通过。
- `pnpm test:ztools-plugin-runtime-sample-report`：通过。
- `pnpm test:ztools-plugin-compatibility-report`：通过。
- `pnpm test:ztools-import-view`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，仍只有既有 Vite chunk-size warning。
- `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop`：通过。
- `pnpm smoke:tauri-desktop`：标准 smoke 仍通过，外部 activation summary 为空 no-plan counts，`ui_actions_checked:0`，不影响 status。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入 | 93% | 94% | 外部 ZTools 样本进入真实 activation path 后，已验证 PluginPanel 宿主所需的 FeatureAction payload |
| 测试与发布 | 99% | 99% | Desktop smoke 外部插件 activation plan 新增 UI action payload 计数，并通过标准/带 plan 双路径 |

当前重点剩余：

1. 插件生态：仍需逐插件 iframe ready、视觉截图、title/runtime strip、bridge call evidence 和日志回收。
2. 插件安装：源码型插件缺少已构建 main 文件，需要 build/install 策略或市场包策略。
3. 插件安全：证书链/吊销/平台级签名策略仍未接入。
4. 插件 iframe 宿主：BrowserWindow 子 iframe 仍为 hosted WebContents 兼容保留 same-origin，完整跨源化需要单独控制通道。
5. macOS 发布质量：签名、公证、自动更新仍未接入。

## Batch 264：Desktop smoke consumes external ZTools activation plan

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 263 的外部插件 activation smoke plan，把“真实第三方插件运行时兼容回归”推进到真实 Tauri desktop smoke 可消费 plan 并执行导入、feature 激活查找、路径/main/preload 断言和清理。范围仍不包含逐插件 UI 视觉打开、截图或 bridge 调用回放。

本批实现：

- `src-tauri/src/desktop_smoke.rs`
  - `DesktopSmokeSnapshot` 新增 `ztools_external_activation_smoke`。
  - 新增 `ATOOLS_ZTOOLS_ACTIVATION_PLAN` env 入口；不设置时保持 skipped 空 summary，不影响标准 desktop smoke。
  - 读取 `output/ztools-plugin-activation-plan.json` 这类 plan JSON，并逐个消费 `activation_plans`。
  - 复用现有 `ztools_import::import_ztools_plugins()`，导入计划样本到 smoke install root。
  - 对导入样本验证 feature code 反查到 expected plugin id、plugin path 存在、main 存在、preload 存在或未声明。
  - 每个导入样本结束后调用 `db.delete_plugin()` 并删除安装目录，验证 DB/plugin files cleanup。
  - 若计划样本 feature code 已归属其他已安装插件，则安全跳过该样本，避免覆盖内置 feature ownership。
  - 新增 repo-root fallback 路径解析，修复 Tauri 进程 cwd 在 `src-tauri` 时相对 plan path 读不到的问题。

TDD / Debugging：

- `cargo test -p atools --lib ztools_external_activation_smoke_consumes_plan_imports_and_cleans_up_sample` 首次失败：缺少 `build_ztools_external_activation_smoke_summary`。
- 实现 plan 解析、导入、activation lookup、assertion 和 cleanup 后目标测试转绿。
- 真实 `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop` 首次失败：Tauri 进程按错误 cwd 解析相对路径，`ztools_external_activation_smoke.error` 为 `failed to read activation plan: No such file or directory`。
- `cargo test -p atools --lib ztools_activation_plan_path_resolves_repo_relative_output_from_tauri_cwd` 首次失败：缺少 repo-relative resolver。
- 增加 cwd + repo root 双路径解析后，该测试转绿，真实 desktop smoke 也转绿。

真实 smoke 基线：

```bash
ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop
```

结果：

- `status:"ok"`。
- `mcp_bind:"127.0.0.1:63786"`。
- `ztools_external_activation_smoke.plan_path` 解析到 `/Users/harris/Desktop/atools/output/ztools-plugin-activation-plan.json`。
- `planned_samples:10`。
- `imported_samples:8`。
- `activated_samples:8`。
- `assertions_checked:8`。
- `cleanup_verified:8`。
- `skipped_samples:2`，原因是 feature code 已归属现有插件，smoke 为避免污染内置索引而跳过。
- `sample_plugin_ids`: `ztools-developer-plugin`、`latex-ocr`、`2048`、`cron`、`developer-codec-tools`、`ibox-wallpaper`、`mybatis-sql-formatter`、`random-data`。

验证：

- `cargo test -p atools --lib desktop_smoke`：10 passed。
- `cargo test -p atools --test ztools_import_tests`：3 passed。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm test:ztools-plugin-activation-plan`：通过。
- `pnpm test:ztools-plugin-runtime-sample-report`：通过。
- `pnpm test:ztools-plugin-compatibility-report`：通过。
- `pnpm test:ztools-import-view`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，仍只有既有 Vite chunk-size warning。
- `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop`：通过。
- `pnpm smoke:tauri-desktop`：标准 smoke 仍通过，外部 activation summary 为空 skipped 且不影响 status。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入 | 92% | 93% | 外部 ZTools 样本 plan 已进入真实 desktop smoke，可导入、激活查找、断言并清理 |
| 测试与发布 | 99% | 99% | Desktop smoke 新增可选外部插件 activation plan summary，并通过标准/带 plan 双路径 |

当前重点剩余：

1. 插件生态：仍需逐插件 UI load、iframe ready、title/runtime strip、bridge call evidence 和截图/日志回收。
2. 插件安装：源码型插件缺少已构建 main 文件，需要 build/install 策略或市场包策略。
3. 插件安全：证书链/吊销/平台级签名策略仍未接入。
4. 插件 iframe 宿主：BrowserWindow 子 iframe 仍为 hosted WebContents 兼容保留 same-origin，完整跨源化需要单独控制通道。
5. macOS 发布质量：签名、公证、自动更新仍未接入。

## Batch 263：Real ZTools activation smoke plan

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 262 的运行态样本候选报告，把“真实第三方插件运行时兼容回归”继续推进为可执行的外部样本激活 smoke plan。范围覆盖只读 plan generator、fixture 测试、真实 `ZTools-plugins` 激活计划 JSON 和 smoke 文档；不实际导入、启用、打开、截图或清理第三方插件，也不把计划等同于已执行的逐插件回归。

本批实现：

- `scripts/ztools-plugin-activation-plan.mjs`
  - 复用 `buildZToolsPluginRuntimeSampleReport()` 的候选样本排序。
  - 读取每个候选插件的 `plugin.json`，解析 feature 和 cmds。
  - 生成 expected install id，规则与 Rust `sanitize_id` 对齐：非字母数字折叠为 `-` 并裁剪首尾 hyphen。
  - 优先选择 text trigger；无 text 时选择可简化的 regex 或 over trigger；files/img/window 等生成 typed payload 和 manual reason。
  - 为每个样本输出 install、enable、activation、assertions、risks 和 cleanup 结构，供后续桌面 smoke harness 消费。
  - 支持 `--source`、`--output`、`--limit` / `--max-samples`、`--install-root`、`--json`。
- `scripts/test-ztools-plugin-activation-plan.mjs`
  - 使用临时 fixture 覆盖 text trigger、regex trigger、typed payload trigger、缺 main blocked 跳过、expected install id、assertions 和 cleanup 输出。
- `package.json`
  - 新增 `test:ztools-plugin-activation-plan`。
  - 新增 `report:ztools-activation-plan`。
- `output/ztools-plugin-activation-plan.json`
  - 记录当前真实 `/Users/harris/Desktop/ZTools-plugins/plugins` 的前 10 个外部插件激活 smoke plan。

TDD 红灯：

- `pnpm test:ztools-plugin-activation-plan` 首次失败：缺少 `ztools-plugin-activation-plan.mjs` 导出。
- 实现 plan generator、manifest feature/cmd 解析、trigger selection、install id normalization、assertions 和 cleanup 输出后目标测试转绿。

真实样本基线：

```bash
pnpm report:ztools-activation-plan -- --source /Users/harris/Desktop/ZTools-plugins/plugins --output output/ztools-plugin-activation-plan.json --limit 10 --install-root /tmp/atools-ztools-plugin-smoke
```

结果：

- 10 个计划样本。
- 来自 53 个 launchable 插件。
- 64 个 blocked 插件被跳过。
- 10 个 ready plan。
- 0 个 risk plan。
- 10 个 text trigger。
- 0 个 regex trigger。
- 0 个 typed payload trigger。
- 0 个 manual trigger。
- Top plan：`calculation-paper -> calc`。

验证：

- `pnpm test:ztools-plugin-activation-plan`：通过。
- `pnpm test:ztools-plugin-runtime-sample-report`：通过。
- `pnpm test:ztools-plugin-compatibility-report`：通过。
- `pnpm test:ztools-import-view`：通过。
- `cargo test -p atools --test ztools_import_tests`：3 passed。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，仍只有既有 Vite chunk-size warning。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:61353"`，`agent_tools_count:8`，权限/数据/系统设置/插件 runtime smoke 均通过，示例插件 `calculator` / `calc`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入 | 91% | 92% | 真实 ZTools 插件外部样本已有可执行 activation smoke plan 和 JSON 基线 |
| 测试与发布 | 99% | 99% | 新增第三方 activation plan 测试，并通过 check/build/真实 desktop smoke |

当前重点剩余：

1. 插件生态：下一步需要让桌面 smoke harness 消费 `output/ztools-plugin-activation-plan.json`，实际逐个导入、启用、激活、确认 UI load / bridge evidence，并清理安装目录和插件数据。
2. 插件安装：源码型插件缺少已构建 main 文件，需要 build/install 策略或市场包策略。
3. 插件安全：证书链/吊销/平台级签名策略仍未接入。
4. 插件 iframe 宿主：BrowserWindow 子 iframe 仍为 hosted WebContents 兼容保留 same-origin，完整跨源化需要单独控制通道。
5. macOS 发布质量：签名、公证、自动更新仍未接入。

## Batch 262：Real ZTools runtime sample candidate report

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 261 的真实 manifest 兼容基线，把“真实第三方插件运行时兼容回归”继续推进为可重复的外部运行态样本候选报告。范围覆盖只读扫描器、fixture 测试、真实 `ZTools-plugins` 样本候选 JSON 和 smoke 文档；不自动安装、启用、打开或清理第三方插件，也不把候选报告等同于完整运行时 UI/bridge 回归。

本批实现：

- `scripts/ztools-plugin-runtime-sample-report.mjs`
  - 复用 `buildZToolsPluginCompatibilityReport()` 的真实 manifest 扫描结果。
  - 对每个插件分析 main HTML 是否存在且可作为入口、入口 HTML 中的本地资源是否存在、是否引用 http/https 外部资源。
  - 对 preload 分析缺失文件、Electron require、Node require 模块、`fs` / `child_process` 等高风险信号。
  - 输出每个插件的 `ready` / `risk` / `blocked` 运行态候选状态、score、warnings、blockers、entry/preload 明细。
  - 按状态、score、feature 数和名称选出前 N 个 `sample_candidates`，用于后续桌面激活 smoke 的样本池。
  - 支持 `--source`、`--output`、`--limit` / `--max-candidates`、`--json`，默认 source 为相邻 `../ZTools-plugins/plugins`。
- `scripts/test-ztools-plugin-runtime-sample-report.mjs`
  - 使用临时 fixture 覆盖 ready 插件、缺本地入口资源 risk、外部资源 + Electron/Node preload risk、缺 main blocked、JSON 写出和候选排序。
- `package.json`
  - 新增 `test:ztools-plugin-runtime-sample-report`。
  - 新增 `report:ztools-runtime-samples`。
- `output/ztools-plugin-runtime-sample-report.json`
  - 记录当前真实 `/Users/harris/Desktop/ZTools-plugins/plugins` 运行态候选基线。

TDD 红灯：

- `pnpm test:ztools-plugin-runtime-sample-report` 首次失败：缺少 `ztools-plugin-runtime-sample-report.mjs` 导出。
- 实现运行态候选扫描器、CLI writer、entry resource 分析、preload risk 分析、score 和 sample selection 后目标测试转绿。

真实样本基线：

```bash
pnpm report:ztools-runtime-samples -- --source /Users/harris/Desktop/ZTools-plugins/plugins --output output/ztools-plugin-runtime-sample-report.json --limit 20
```

结果：

- 117 个 manifest。
- 53 个 launchable。
- 14 个 ready candidates。
- 39 个 risk candidates。
- 64 个 blocked plugins。
- 10 个插件存在缺失本地入口资源，共 17 个缺失资源引用。
- 5 个插件使用外部入口资源。
- 4 个插件缺 preload。
- 26 个插件存在 Electron require preload 信号。
- 69 个插件存在 Node require preload 信号。
- 已选出 20 个排序后的运行态样本候选，前排 ready 样本包括 `calculation-paper`、`ztools-developer-plugin`、`latex-ocr`、`2048`、`cron`、`developer-codec-tools`、`ibox-wallpaper`、`mybatis-sql-formatter`、`qrcode-helper`、`random-data`。

验证：

- `pnpm test:ztools-plugin-runtime-sample-report`：通过。
- `pnpm test:ztools-plugin-compatibility-report`：通过。
- `pnpm test:ztools-import-view`：通过。
- `cargo test -p atools --test ztools_import_tests`：3 passed。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，仍只有既有 Vite chunk-size warning。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:59508"`，`agent_tools_count:8`，权限/数据/系统设置/插件 runtime smoke 均通过，示例插件 `calculator` / `calc`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入 | 90% | 91% | 真实 ZTools 插件运行态样本候选有了可重复报告和 JSON 基线 |
| 测试与发布 | 99% | 99% | 新增第三方运行态候选报告测试，并通过 check/build/真实 desktop smoke |

当前重点剩余：

1. 插件生态：报告只选出候选样本，不覆盖逐插件导入、启用、激活、UI load、bridge 调用和清理。
2. 插件安装：源码型插件缺少已构建 main 文件，需要 build/install 策略或市场包策略。
3. 插件安全：证书链/吊销/平台级签名策略仍未接入。
4. 插件 iframe 宿主：BrowserWindow 子 iframe 仍为 hosted WebContents 兼容保留 same-origin，完整跨源化需要单独控制通道。
5. macOS 发布质量：签名、公证、自动更新仍未接入。

## Batch 261：Real ZTools plugin compatibility report

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 260 的插件权限收口，把剩余的“真实第三方插件兼容回归”先推进为可重复的 manifest/import 兼容扫描入口。范围覆盖只读扫描器、fixture 测试、真实 `ZTools-plugins` 样本报告和 smoke 文档；不改变运行时，不安装/卸载外部插件，不包含完整第三方插件运行时回归。

本批实现：

- `scripts/ztools-plugin-compatibility-report.mjs`
  - 递归扫描指定目录下的 `plugin.json`，跳过 `node_modules` 和隐藏目录。
  - 输出每个插件的 `main` / `preload` / `logo` 文件存在性、macOS platform 支持、feature/command 数量、unsupported typed cmd types、warnings/errors 和兼容状态。
  - 聚合 summary：扫描插件数、compatible/warning/error 数、feature/command 总数、missing main/preload/logo、unsupported cmd plugin 数、重复 feature code 组数。
  - 输出 `unsupported_cmd_types` 计数和 `duplicate_feature_codes` 明细。
  - 支持 `--source`、`--output`、`--json`，默认 source 为相邻 `../ZTools-plugins/plugins`。
- `scripts/test-ztools-plugin-compatibility-report.mjs`
  - 使用临时 fixture 覆盖 compatible 插件、缺 main error、缺 preload/logo/platform warning、unknown cmd type、重复 feature code、`node_modules` 忽略和 JSON 写出。
- `package.json`
  - 新增 `test:ztools-plugin-compatibility-report`。
  - 新增 `report:ztools-compat`。
- `output/ztools-plugin-compatibility-report.json`
  - 记录当前真实 `/Users/harris/Desktop/ZTools-plugins/plugins` 扫描基线。

TDD 红灯：

- `pnpm test:ztools-plugin-compatibility-report` 首次失败：缺少 `ztools-plugin-compatibility-report.mjs` 导出。
- 实现扫描器、CLI writer 和 summary 后目标测试转绿。

真实样本基线：

```bash
pnpm report:ztools-compat -- --source /Users/harris/Desktop/ZTools-plugins/plugins --output output/ztools-plugin-compatibility-report.json
```

结果：

- 117 个 manifest。
- 51 个 compatible。
- 6 个 warning。
- 60 个 error。
- 246 个 features。
- 690 条 commands。
- 0 个 unsupported cmd-type plugin。
- 11 组重复 feature code。
- 主要 error 是源码型插件缺少已构建 `main` 文件，下一步需要决定源码型插件 build/install 策略。

验证：

- `pnpm test:ztools-plugin-compatibility-report`：通过。
- `pnpm test:ztools-import-view`：通过。
- `cargo test -p atools --test ztools_import_tests`：3 passed。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，仍只有既有 Vite chunk-size warning。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:56588"`，`agent_tools_count:8`，权限/数据/系统设置/插件 runtime smoke 均通过，示例插件 `calculator` / `calc`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入 | 89% | 90% | 真实 ZTools 插件 manifest 兼容回归有了可重复报告和 JSON 基线 |
| 测试与发布 | 99% | 99% | 新增第三方插件兼容报告测试，并通过 check/build/真实 desktop smoke |

当前重点剩余：

1. 插件生态：报告只覆盖 manifest/import 兼容，不覆盖逐插件运行时激活、UI 和 bridge 调用行为。
2. 插件安装：源码型插件缺少已构建 main 文件，需要 build/install 策略或市场包策略。
3. 插件安全：证书链/吊销/平台级签名策略仍未接入。
4. 插件 iframe 宿主：BrowserWindow 子 iframe 仍为 hosted WebContents 兼容保留 same-origin，完整跨源化需要单独控制通道。
5. macOS 发布质量：签名、公证、自动更新仍未接入。

## Batch 260：Persistent runtime permission grants

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 259 的逐 API 本会话授权弹窗，把“本次会话允许”补成“本次会话允许 / 始终允许”双路径，并把已持久授权集中展示到 Settings 的已安装插件权限审计里。范围覆盖共享持久授权 helper、PluginPanel 持久授权加载/保存/监听、Settings 持久授权展示和清除；不包含证书链/吊销/平台级签名策略、完整 iframe sandbox/cross-origin capability isolation、BrowserWindow 子 iframe 跨源化或第三方插件兼容回归。

本批实现：

- `src/lib/pluginRuntimePermissions.ts`
  - 新增 `atools.pluginRuntimePermissionGrants.v1` 版本化本地存储 key。
  - 提供 plugin ID / permission 规范化、按插件读取 grant list、精确 grant 保存、重复去重、清除单插件授权和共享 update event。
  - `isPluginRuntimePermissionPersistentlyGranted()` 复用 exact / group / wildcard allow 语义，保持和 manifest allowlist 判断一致。
- `src/components/PluginPanel.svelte`
  - 运行时权限状态拆为 session approval 和 persistent approval 两层。
  - active plugin owner 切换时按 `action.plugin_id` 读取持久授权。
  - 缺失权限弹窗新增 `始终允许`，会保存当前插件的精确 permission，同时仍保留 `本次会话允许`。
  - 监听 `PLUGIN_RUNTIME_PERMISSION_GRANTS_UPDATED_EVENT`，Settings 清除持久授权后当前宿主能刷新持久层。
- `src/components/SettingsPanel.svelte`
  - `已安装插件` -> `插件权限/能力审计` 新增 `持久运行时授权` 行。
  - 有持久授权时展示 grant list；无授权时说明需要在运行时弹窗选择 `始终允许`。
  - `清除授权` 调用共享 helper 清除当前插件持久授权，并通过状态文案反馈 `已清除插件运行时授权`。
- `scripts/test-plugin-runtime-permission-grants.mjs`
  - 新增纯 helper 测试，覆盖缺省读取、保存、trim、去重、追加、空值忽略和清除。
- `scripts/test-plugin-runtime-permissions.mjs`
  - 增加 PluginPanel 静态断言：`始终允许`、`grantPluginRuntimePermission`、active-plugin grant loading 和 update event。
- `scripts/test-plugin-inventory.mjs`
  - 增加 Settings 静态断言：持久授权读取、清除 helper、`持久运行时授权`、`清除授权` 和清除状态反馈。

TDD 红灯：

- `pnpm test:plugin-runtime-permission-grants` 首次失败：缺少 `pluginRuntimePermissions.ts` 持久授权 helper。
- `pnpm test:plugin-runtime-permissions` 首次失败：PluginPanel 缺少 `始终允许`、持久保存、active-plugin 持久授权读取和 update event。
- `pnpm test:plugin-inventory` 首次失败：Settings 插件权限审计缺少持久授权展示和清除动作。
- `pnpm check` / `pnpm build` 首次失败：`{@const}` 放在普通 `<div>` 里违反 Svelte 5 规则；移动到 `{#if}` 的直接子节点后通过。

验证：

- `pnpm test:plugin-runtime-permission-grants`：通过。
- `pnpm test:plugin-runtime-permissions`：通过。
- `pnpm test:plugin-inventory`：通过。
- `pnpm test:settings-pages`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，仍只有既有 Vite chunk-size warning。
- In-app Browser：`http://localhost:1420/?pluginHostSmoke=permissionPrompt` 显示 `拒绝` / `本次会话允许` / `始终允许`；点击 `始终允许` 后弹窗关闭，刷新同一 smoke 页面不再弹出 `clipboard.write` 权限提示。Settings -> `已安装插件` Web preview 可进入，console warning/error 为 0；浏览器预览没有桌面插件清单，插件详情持久授权行由专项测试覆盖。当前自动化后端截图接口超时，未把 screenshot 作为通过条件。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:53794"`，`agent_tools_count:8`，权限/数据/系统设置/插件 runtime smoke 均通过，示例插件 `calculator` / `calc`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 98% | 99% | 逐 API runtime permission 从 session-only 补到 per-plugin persistent grants，宿主启动时可直接复用 |
| 插件安装/导入 | 88% | 89% | Settings 已安装插件权限审计可以集中查看和清除持久运行时授权 |
| 设置项真实功能 | 99% | 99% | 设置页新增真实清除持久授权动作，但整体已接近 99%，不再上调 |
| 测试与发布 | 99% | 99% | 新增 helper/PluginPanel/Settings 专项测试，并通过 check/build/Browser smoke/真实 desktop smoke |

当前重点剩余：

1. 插件安全：证书链/吊销/平台级签名策略仍未接入。
2. 插件 iframe 宿主：BrowserWindow 子 iframe 仍为 hosted WebContents 兼容保留 same-origin，完整跨源化需要单独控制通道。
3. 插件生态：真实第三方插件兼容回归仍需按插件样本继续补。
4. macOS 发布质量：签名、公证、自动更新仍未接入。

## Batch 259：Runtime per-API permission prompt

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 258 的主插件 iframe sandbox 隔离和 Batch 257 的 manifest allowlist，把“缺失敏感权限立即拒绝”推进为“逐 API 本会话授权弹窗”：缺失权限时 bridge 会向 host 请求授权，host 展示权限弹窗；用户批准后仅本会话授予该精确 permission，拒绝则 reject 原始调用且不触达 native/Tauri 命令。范围覆盖注入 bridge、host fallback/direct postMessage、PluginPanel 权限队列/UI、Web preview permission prompt smoke；不包含权限持久化、Settings 集中管理、证书链/吊销/平台级信任策略、完整 sandbox/cross-origin capability isolation 或真实第三方插件兼容回归。

本批实现：

- `src/components/PluginPanel.svelte`
  - 注入 bridge 新增 `_requestPluginPermission()`、`__atools_permission_request__` / `__atools_permission_response__` 流程和本会话已批准权限缓存。
  - 原先缺失权限的 `_permissionPromise()` 不再立即 reject，而是等待 host 决策后继续执行或拒绝原始 API 调用。
  - host 新增 runtime permission request 队列、`plugin-permission-dialog`、`本次会话允许` / `拒绝` 两个动作。
  - 批准时只加入当前 session 的精确 permission；拒绝时原始 bridge promise 以 `Plugin permission denied: <permission>` 拒绝。
  - `__ipc_call__` 和 `__atools_native_call__` fallback/direct 路径也改为先 `ensureHostPluginPermission()` 再触发 native/Tauri 命令。
  - 权限响应发送增加 `postMessage` 容错，并先从队列移除再响应 bridge，避免跨 frame 响应异常阻塞 UI 关闭。
- `src/App.svelte`
  - 新增 `pluginHostSmoke=permissionPrompt` Web preview smoke mode，使用空 manifest permissions 和 iframe `copyText('permission prompt smoke')` 触发 `clipboard.write` 运行时权限请求。
- `scripts/test-plugin-runtime-permissions.mjs`
  - 覆盖 bridge 权限请求/响应、批准后继续调用、拒绝后不触达 host 命令、同一 session 不重复提示、host UI 文案和 Web smoke mode。
- `scripts/test-plugin-window-browser-bridge.mjs` / `scripts/test-plugin-iframe-context-menu.mjs`
  - 同步 `pluginHostSmoke` 静态断言，适配 App 里先读取参数再比较的写法。

TDD 红灯：

- `pnpm test:plugin-runtime-permissions` 首次失败：bridge 中没有 `_requestPluginPermission`，缺失权限仍直接拒绝。
- 扩展 Web smoke 断言后再次失败：`App.svelte` 没有 `pluginHostSmoke=permissionPrompt` 模式，且权限 smoke 会进入 output rows 而不是 iframe runtime。
- 扩展响应容错断言后再次失败：host 响应 `postMessage` 没有 try/catch，跨 frame 响应异常可能阻断 UI 队列移除。
- `pnpm test:plugin-window-browser-bridge` 首次回归失败：旧静态断言仍要求 `params.get("pluginHostSmoke") === "browserWindow"` 内联比较；同步为 `pluginHostSmoke === "browserWindow"` 后通过。

验证：

- `pnpm test:plugin-runtime-permissions`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-resource-runtime`：通过。
- `pnpm test:plugin-iframe-sandbox`：通过。
- `pnpm test:plugin-window-browser-bridge`：通过。
- `pnpm test:plugin-window-lifecycle`：通过。
- `pnpm test:plugin-iframe-context-menu`：通过。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，仍只有既有 Vite chunk-size warning。
- In-app Browser：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=permissionPrompt&batch=259-runtime-permission-prompt` 进入 iframe runtime，显示唯一 `clipboard.write` 运行时权限弹窗；`本次会话允许` 和 `拒绝` 均会关闭弹窗，console 0 errors / 0 warnings。Browser screenshot capture 本批曾超时，未作为通过条件。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:50584"`，`agent_tools_count:8`，权限/数据/系统设置/插件 runtime smoke 均通过，示例插件 `calculator` / `calc`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 97% | 98% | 缺失敏感 runtime API permission 会进入 host 弹窗，批准/拒绝都在触达 native 命令前闭环 |
| 设置项真实功能 | 99% | 99% | 运行时授权仅本会话，尚未进入 Settings 持久化/集中管理 |

当前重点剩余：

1. 插件安全：运行时逐 API 授权已具备本会话弹窗，但还没有持久化策略、Settings 集中管理、证书链/吊销/平台级签名策略。
2. 插件 iframe 宿主：BrowserWindow 子 iframe 仍为 hosted WebContents 兼容保留 same-origin，完整跨源化需要重做子窗口 DOM 控制通道。
3. 插件生态：真实第三方插件兼容回归仍需按插件样本继续补。
4. macOS 发布质量：签名、公证、自动更新仍未接入。

## Batch 258：Main plugin iframe sandbox isolation

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 257 的运行时权限 allowlist，把主插件 iframe 的浏览器级 sandbox 继续收紧：主插件 iframe 不再使用 `allow-same-origin`，生命周期事件不再依赖父页面直接读取 iframe window，而是走 postMessage 注入桥。范围覆盖主插件 iframe sandbox 常量、BrowserWindow 子 iframe 兼容策略显式分离、`onPluginOut` / `onPluginDetach` postMessage 生命周期、sandbox 下 find/selection best-effort 降级，以及 Browser preview 中插件管理入口的 Tauri runtime guard；不包含 BrowserWindow 子 iframe 的完整跨源化、完整 iframe sandbox/cross-origin capability isolation、运行时逐 API 用户弹窗授权、证书链/吊销/平台级签名策略或第三方插件兼容回归。

本批实现：

- `src/components/PluginPanel.svelte`
  - 新增 `PLUGIN_IFRAME_SANDBOX = "allow-scripts allow-popups"`，主插件 iframe 移除 `allow-same-origin`。
  - 新增 `PLUGIN_BROWSER_WINDOW_IFRAME_SANDBOX = "allow-scripts allow-same-origin allow-popups"`，明确 BrowserWindow 子 iframe 暂时保留同源兼容边界。
  - `dispatchPluginOutEvent` / `dispatchPluginDetachEvent` 改为 `postPluginLifecycleEvent`，由注入 bridge 监听 `__atools_lifecycle__` 后在插件内部派发 `atools-plugin-out` / `atools-plugin-detach`。
  - 主 iframe `findInPage` 和 selection clear 改成 sandbox-safe best-effort，不再让跨源访问异常影响宿主主流程。
- `src/components/SettingsPanel.svelte`
  - `hasTauriRuntime()` 从 key-exists-only 改为检查 `__TAURI_INTERNALS__.invoke` 是否为函数。
  - 已安装插件刷新 catch 在浏览器预览下回落到“运行时未连接”文案，不再显示 raw Tauri invoke TypeError。
- `src/components/SystemPanel.svelte`
  - 首页 `插件管理` 快捷入口新增相同的 invoke-based Tauri runtime guard。
  - 浏览器预览下刷新/启停插件会显示明确不可用文案，不再直接调用 `list_plugins` / `toggle_plugin`。
- `scripts/test-plugin-iframe-sandbox.mjs`
  - 覆盖主插件 iframe sandbox 移除 same-origin、BrowserWindow 子 iframe 显式兼容策略、postMessage 生命周期和 sandbox-safe find/selection 降级。
- `scripts/test-settings-tauri-runtime-guard.mjs`
  - 覆盖 SettingsPanel/SystemPanel 的 invoke-based runtime guard，以及浏览器预览下不暴露 raw invoke TypeError。

TDD 红灯：

- `pnpm test:plugin-iframe-sandbox` 首次失败：主插件和子窗口 iframe 都是 inline `allow-scripts allow-same-origin allow-popups`，且生命周期仍通过父页面直接构造 iframe `CustomEvent`。
- `pnpm test:plugin-iframe-sandbox` 扩展保护后再次失败：主 iframe selection clear 仍有未隔离的直接访问路径。
- `pnpm test:settings-tauri-runtime-guard` 首次失败：SettingsPanel 只检查 `"__TAURI_INTERNALS__" in window`，SystemPanel 没有 runtime guard，浏览器预览会显示 raw `Cannot read properties of undefined (reading 'invoke')`。

验证：

- `pnpm test:settings-tauri-runtime-guard`：通过。
- `pnpm test:plugin-iframe-sandbox`：通过。
- `pnpm test:plugin-runtime-permissions`：通过。
- `pnpm test:plugin-resource-runtime`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-window-browser-bridge`：通过。
- `pnpm test:plugin-window-lifecycle`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，仍只有既有 Vite chunk-size warning。
- In-app Browser：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=iframeContext&batch=258-iframe-sandbox&v=7` 主插件 iframe 实际渲染为 `sandbox="allow-scripts allow-popups"`，console 0 errors / 0 warnings。
- In-app Browser：`http://127.0.0.1:1420/?batch=258-iframe-sandbox&v=5` 首页 `插件管理` 入口显示 `Tauri 运行时未连接，已安装插件需在桌面应用中查看`，console 0 errors / 0 warnings。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，插件 runtime、MCP、权限审计和桌面窗口 smoke 均通过。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Settings shell/navigation | 86% | 87% | 首页插件管理快捷入口在浏览器预览下不会再暴露 raw Tauri invoke TypeError |
| 插件 iframe 宿主 | 96% | 97% | 主插件 iframe 移除 `allow-same-origin`，生命周期改为 postMessage，减少主插件同源逃逸面 |
| 设置项真实功能 | 99% | 99% | runtime guard 更稳，但完整 sandbox/cross-origin isolation 和运行时逐 API 用户弹窗授权仍未完成 |

当前重点剩余：

1. 插件 iframe 宿主：BrowserWindow 子 iframe 仍为 hosted WebContents 兼容保留 same-origin，完整跨源化需要重做子窗口 DOM 控制通道。
2. 插件安全：还没有完整 iframe sandbox/cross-origin capability isolation，也没有运行时逐 API 用户弹窗授权。
3. 插件市场：证书链/吊销/平台级签名策略仍未实现。
4. 插件生态：真实第三方插件兼容回归仍需按插件样本继续补。

## Batch 257：Plugin runtime permission allowlist

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 256 的授权启用门禁，把授权摘要里的 manifest 权限推进到运行时执行面：插件 manifest 可声明 `permissions`，激活插件时传给 PluginPanel，注入 bridge 和 host fallback 都会在调用敏感 API 前按 allowlist 拦截。范围覆盖 manifest 解析、FeatureAction 传递、Settings 权限审计行、bridge `_invokeFn`/`_nativeCall` 拦截和 PluginPanel postMessage fallback 二次校验；不包含完整 iframe sandbox/cross-origin capability isolation、运行时逐 API 用户弹窗授权、证书链/吊销/平台级签名策略或第三方插件兼容回归。

本批实现：

- `crates/atools-core/src/models.rs`
  - `PluginManifest` 新增 `permissions: Vec<String>`，serde default 兼容旧 manifest。
- `src-tauri/src/commands.rs`
  - 新增 `activate_feature_inner`，`FeatureAction` 带出 `plugin_permissions`。
  - 权限数组会 trim/sort/dedup 后传给前端 runtime host。
- `src/components/PluginPanel.svelte`
  - 注入 bridge 新增 `_atoolsPluginPermissions`、`_requirePluginPermission`、`_invokePermissionForCommand`、`_nativePermissionForMethod`。
  - `_invokeFn` / `_nativeCall` 在调用前按 manifest allowlist 拦截 plugin data、clipboard、shell、screen、dialog、context、system、BrowserWindow 等敏感能力。
  - PluginPanel host 对 `__ipc_call__` / `__atools_native_call__` fallback 再做一次同样的权限校验，拒绝后不会触达 Tauri command/native bridge。
- `src/lib/pluginInventory.ts`
  - 权限审计新增 `运行时权限` 行，授权确认摘要会包含 manifest permissions。
- `scripts/test-plugin-runtime-permissions.mjs`
  - 直接执行注入 bridge，覆盖显式空权限拒绝、具体权限放行和 group 权限放行。

TDD 红灯：

- `cargo test -p atools-core --test models_tests test_plugin_manifest_roundtrip` 首次失败：`PluginManifest` 没有 `permissions` 字段。
- `cargo test -p atools --lib activate_feature_includes_manifest_permissions_for_runtime_allowlist` 首次失败：缺 `activate_feature_inner` / `plugin_permissions`。
- `pnpm test:plugin-runtime-permissions` 首次失败：`FeatureAction` 和 injected bridge 没有权限槽和拦截逻辑。

验证：

- `cargo fmt`：通过。
- `cargo test -p atools-core --test models_tests`：8 passed。
- `cargo test -p atools --lib activate_feature`：1 passed。
- `cargo test -p atools --lib`：73 passed。
- `cargo test -p atools-api-shim`：19 passed。
- `pnpm test:plugin-runtime-permissions`：通过。
- `pnpm test:plugin-system-shell-bridge`：通过。
- `pnpm test:plugin-screen-interactive`：通过。
- `pnpm test:plugin-context-bridge`：通过。
- `pnpm test:plugin-db-attachment-metadata`：通过。
- `pnpm test:plugin-inventory`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，仍只有既有 Vite chunk-size warning。
- Browser smoke：打开 `http://127.0.0.1:1420/?batch=257-runtime-permissions`，进入 Settings -> 已安装插件，页面无 console error/warn。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，插件 runtime smoke `feature_activated:true`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入/市场 | 86% | 88% | manifest permissions 解析/传递，Settings 权限审计和 runtime allowlist 拦截 |
| 插件 iframe 宿主 | 95% | 96% | 注入 bridge 与 host postMessage fallback 会按 manifest allowlist 拦截敏感 API |
| 设置项真实功能 | 99% | 99% | 新增真实运行时 allowlist，但完整 sandbox/cross-origin isolation 和运行时逐 API 用户弹窗授权仍未完成 |

当前重点剩余：

1. 插件安全：还没有完整 iframe sandbox/cross-origin capability isolation，也没有运行时逐 API 用户弹窗授权。
2. 插件市场：证书链/吊销/平台级签名策略仍未实现。
3. 插件生态：真实第三方插件兼容回归仍需按插件样本继续补。

## Batch 256：Plugin permission authorization gate

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 255 的远程安装/更新链路，把“远程 ZIP 校验通过后立即可用”的行为收紧为“安装/更新后默认停用，用户在已安装插件页确认 manifest 权限摘要后授权启用”。范围覆盖远程安装/更新落库状态、授权命令、feature 重建、Agent tools 同步和 Settings 授权确认；不包含证书链/吊销/平台级签名策略、完整 sandbox 隔离、运行时逐 API 授权/拦截或第三方插件兼容回归。

本批实现：

- `src-tauri/src/commands.rs`
  - 新增 `authorize_plugin_permissions` Tauri command 和 `authorize_plugin_permissions_inner`。
  - 授权启用会加载插件、设置 `enabled = true`、保存插件、重建 feature 行，并同步插件 Agent tools 白名单。
  - 远程市场安装和更新成功后会把插件保存为 `enabled = false`，并重建 feature 行，使远程插件在授权前不会进入 `all_features()` / 主搜索。
  - `toggle_plugin` 在启停保存后也会重建 feature 行，避免启停操作后 feature 索引被保存流程清掉。
- `src-tauri/src/lib.rs`
  - 注册 `authorize_plugin_permissions` 到 Tauri invoke handler。
- `src/lib/pluginInventory.ts`
  - disabled imported plugin 详情动作新增 `授权启用`，并说明会确认 manifest 权限后同步 Agent tools 白名单。
- `src/components/SettingsPanel.svelte`
  - 已安装插件停用按钮从直接启用改为 `authorizeInstalledPlugin`。
  - 授权前用内嵌确认弹窗展示 `确认 manifest 权限` 摘要，覆盖运行入口、preload、Feature 指令、Agent tools 和插件数据边界。
  - 库存详情中的 `授权启用` 动作复用同一确认和 invoke 流程。
- `scripts/test-plugin-inventory.mjs`
  - 覆盖 disabled imported plugin 出现 `授权启用`，内置插件不出现该动作，并静态确认 Settings 使用 `authorize_plugin_permissions` 和 `确认 manifest 权限` 文案。

TDD 红灯：

- `cargo test -p atools --lib plugin_market_zip_download_installs_plugin_and_rejects_zip_slip` 首次失败：缺 `authorize_plugin_permissions_inner`，远程安装仍会直接启用并进入 feature 搜索。
- `cargo test -p atools --lib plugin_market_zip_update_requires_reauthorization_before_searchable` 首次失败：缺更新后重新授权门禁。
- 上述 Rust 测试在初版实现后又暴露出 `save_plugin` 会清理旧 feature 行的问题，因此授权/启停/远程安装更新都补了 feature 重建。
- `pnpm test:plugin-inventory` 首次失败：disabled imported plugin 的 Settings actions 中没有 `授权启用`。

验证：

- `cargo test -p atools --lib plugin_market_zip_download_installs_plugin_and_rejects_zip_slip`
- `cargo test -p atools --lib plugin_market_zip_update_requires_reauthorization_before_searchable`
- `pnpm test:plugin-inventory`
- `cargo fmt`
- `cargo test -p atools --lib plugin_market` 通过 9 tests。
- `pnpm test:plugin-inventory`
- `pnpm test:plugin-market-catalog`
- `pnpm test:plugin-market-status`
- `pnpm test:plugin-market-overview`
- `pnpm check` 通过 0 errors / 0 warnings。
- `pnpm build` 通过，保留既有 Vite chunk-size warning。
- In-app Browser 打开 `http://127.0.0.1:1420/`，Settings -> `已安装插件` DOM 可见 `插件库存概览` 和桌面 runtime 边界说明，console 0 errors / 0 warnings；浏览器预览无 Tauri runtime，真实授权动作由静态脚本和 Rust 单测覆盖。
- `cargo test -p atools --lib` 通过 72 tests。
- `pnpm smoke:tauri-desktop` 通过，输出 `ATOOLS_DESKTOP_SMOKE {"status":"ok", ... "plugin_runtime_smoke":{"feature_activated":true, ...}}`，同时覆盖 MCP、权限审计、系统设置和插件 runtime smoke。

完成度变化：

| 模块 | 之前 | 现在 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入/市场 | 83% | 86% | 远程安装/更新后默认停用，必须授权启用后才进入 feature 搜索和 Agent tools 同步；授权/启停会重建 feature 索引 |
| 设置项真实功能 | 99% | 99% | 新增真实授权启用命令，但完整 sandbox 隔离、运行时逐 API 授权/拦截、证书链/吊销/平台级签名策略仍使总项保持 99% |
| ZTools 设置页 UI | 99% | 99% | 已安装插件页新增授权确认入口，UI 总完成度不单独上调 |

当前重点剩余：

1. 插件市场：只支持 http/https `.zip`；catalog-provided Ed25519 签名已接入，但证书链/吊销/平台级签名策略仍未实现。
2. 插件安全：授权门禁已接入，但完整 sandbox 隔离、运行时逐 API 授权/拦截还未完成。
3. 插件生态：真实第三方插件兼容回归仍需按插件样本继续补。

## Batch 255：Plugin market cancel and retry

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批在 Batch 254 签名信任基础上，把插件市场远程安装/更新任务体验从“只能等待命令返回”推进到可取消、可自动重试、失败后可手动重试。范围覆盖 operation id、Tauri 取消命令、下载 retry loop、attempt 进度事件、Settings 取消/重试控件和状态模型；不包含证书链/吊销/平台级签名策略、完整插件权限授权/隔离模型或第三方插件兼容回归。

本批实现：

- `src-tauri/src/commands.rs`
  - 新增 `cancel_plugin_market_operation` Tauri command 和内部取消登记表。
  - `install_plugin_from_market` / `update_plugin_from_market` 接收可选 `operationId`，并把 `operation_id` 写入进度事件。
  - `PluginMarketProgressEvent` 新增 `operation_id`、`attempt`、`max_attempts`。
  - 远程 ZIP 下载遇到 transient 请求失败或 5xx/429 时最多自动重试 3 次，并在重试前发出 `retrying` 阶段。
  - 下载循环在 chunk 后检查取消标记，取消时发出 `cancelled` 阶段并在 SHA-256/Ed25519 校验和本地写入前返回错误。
- `src/lib/pluginMarketStatus.ts`
  - 远程能力新增 `取消/重试`。
  - 未加载目录时远程能力变为 `0/10 可用`；已加载且具备评分/签名条目时达到 `10/10 可用`。
- `src/components/SettingsPanel.svelte`
  - 远程安装/更新生成 operation id 并传给 Tauri。
  - 进度展示包含 attempt/max attempts。
  - 下载中显示 `取消下载`；失败或取消后保留最近操作并显示 `重试`。
  - `plugin-market-progress` handler 按 operation id 过滤当前任务事件，并显示 retry/cancel 状态。
- `scripts/test-plugin-market-catalog.mjs`、`scripts/test-plugin-market-status.mjs`、`scripts/test-plugin-market-overview.mjs`
  - 覆盖 operation id、attempt 字段、取消命令、重试函数、`取消/重试` 能力和 `10/10`/`0/10` 远程能力计数。

TDD 红灯：

- `cargo test -p atools --lib plugin_market_zip_download_retries_transient_request_failure_and_reports_attempts` 首次失败：缺 `operation_id`、`attempt`、`max_attempts` 和 retrying 阶段。
- `cargo test -p atools --lib plugin_market_zip_download_can_be_cancelled_before_local_write` 首次失败：缺取消 helper/取消命令和 `cancelled` 终态事件。
- `pnpm test:plugin-market-catalog` 首次失败：远程能力仍没有 `取消/重试`，Settings 也没有 operation id、取消和重试 UI。

验证：

- `cargo test -p atools --lib plugin_market_zip_download_retries_transient_request_failure_and_reports_attempts`
- `cargo test -p atools --lib plugin_market_zip_download_can_be_cancelled_before_local_write`
- `pnpm test:plugin-market-catalog`
- `cargo fmt`
- `cargo test -p atools --lib plugin_market` 通过 8 tests。
- `pnpm test:plugin-market-catalog`
- `pnpm test:plugin-market-status`
- `pnpm test:plugin-market-overview`
- `pnpm check` 通过 0 errors / 0 warnings。
- `pnpm build` 通过，保留既有 Vite chunk-size warning。
- In-app Browser 打开 `http://127.0.0.1:1420/`，Settings -> `插件市场` DOM 可见 `0/10 可用`、`取消/重试`、`下载进度`、`签名信任`，且旧 `签名信任暂缓接入` 文案已消失。
- `cargo test -p atools --lib` 通过 71 tests。
- `pnpm smoke:tauri-desktop` 通过，输出 `ATOOLS_DESKTOP_SMOKE {"status":"ok", ... "mcp_bind":"127.0.0.1:53785", ...}`，且本批无新增 Rust dead-code warning。

完成度变化：

| 模块 | 之前 | 现在 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入/市场 | 80% | 83% | 远程 ZIP 安装/更新新增 operation id、下载取消、transient 自动重试和失败/取消后的 Settings 手动重试，远程能力从 `9/9` 扩到 `10/10` |
| 设置项真实功能 | 99% | 99% | 新增真实取消/重试副作用，但证书链/吊销/平台级签名策略和权限隔离仍使总项保持 99% |
| ZTools 设置页 UI | 99% | 99% | 市场页新增取消/重试控制，UI 总完成度不单独上调 |

当前重点剩余：

1. 插件市场：只支持 http/https `.zip`；catalog-provided Ed25519 签名已接入，但证书链/吊销/平台级签名策略仍未实现。
2. 插件安全：完整插件权限授权/隔离模型仍未接入，目前只有只读能力审计、安装确认、签名/哈希校验、取消/重试和 Agent tool 白名单。
3. 插件生态：真实第三方插件兼容回归仍需按插件样本继续补。

## Batch 254：Plugin market Ed25519 signature trust

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批在 Batch 253 远程下载进度基础上，把插件市场的“签名信任”从状态占位推进到 catalog 字段解析、安装/更新校验和 Settings 展示。范围覆盖 catalog 发布者/签名字段、Ed25519 ZIP 签名校验、签名失败拒绝更新、Settings 传参与信任标记；不包含证书链/吊销/平台级签名策略、后台取消/重试、完整插件权限授权/隔离模型或第三方插件兼容回归。

本批实现：

- `src-tauri/src/commands.rs`
  - `PluginMarketCatalogPlugin` 新增 `publisher`、`publisher_url`、`signature`、`public_key`。
  - Raw catalog 支持 `publisher`、`publisherUrl`/`publisher_url`、`signature`、`publicKey`/`public_key`，并校验发布者主页必须是 http/https。
  - `install_plugin_from_market` / `update_plugin_from_market` 接收可选 `signature` 和 `publicKey`。
  - 远程 ZIP 下载保留 SHA-256 校验，并在解包和安装/更新前验证 Ed25519 签名。
  - 未签名 legacy ZIP 仍可安装；只提供签名或只提供公钥会明确拒绝；坏签名拒绝更新并保留旧版本。
- `src/lib/types.ts`
  - `PluginMarketCatalogPlugin` 同步新增发布者和签名字段。
- `src/lib/pluginMarketStatus.ts`
  - 状态输入新增 `remoteSignedPluginCount`。
  - `签名信任` 能力在远程目录已读取且存在签名条目时变为可用。
  - 已读取且同时具备评分/签名字段的目录从 `8/9 可用` 达到 `9/9 可用`。
- `src/components/SettingsPanel.svelte`
  - 远程安装/更新 invoke 传递 `signature` 和 `publicKey`。
  - 安装确认文案区分“将验证 Ed25519 签名”和“未提供完整签名/公钥”。
  - 远程目录列表和详情面板展示发布者、签名状态、Ed25519 签名和发布者主页。
- `scripts/test-plugin-market-catalog.mjs`
  - 覆盖签名/公钥字段、发布者字段、install/update 传参和 `签名信任` UI。

TDD 红灯：

- `cargo test -p atools --lib plugin_market_zip_download_verifies_ed25519_signature_before_install_or_update` 首次失败：缺 trusted install/update test helper、缺 `ed25519_dalek` 依赖和签名字段。
- `cargo test -p atools --lib plugin_market_catalog_fetches_and_normalizes_remote_json` 首次失败：catalog 还未暴露发布者和签名字段。
- `pnpm test:plugin-market-catalog` 首次失败：`签名信任` 仍为不可用，Settings 也没有传递签名材料。

验证：

- `cargo test -p atools --lib plugin_market_zip_download_verifies_ed25519_signature_before_install_or_update`
- `cargo test -p atools --lib plugin_market_catalog_fetches_and_normalizes_remote_json`
- `pnpm test:plugin-market-catalog`
- `cargo fmt`
- `cargo test -p atools --lib plugin_market` 通过 6 tests。
- `pnpm test:plugin-market-catalog`
- `pnpm test:plugin-market-status`
- `pnpm test:plugin-market-overview`
- `pnpm check` 通过 0 errors / 0 warnings。
- `pnpm build` 通过，保留既有 Vite chunk-size warning。
- In-app Browser 打开 `http://127.0.0.1:1420/`，Settings -> `插件市场` DOM 可见 `0/9 可用`、`签名信任` 和未加载目录时的签名信任说明。
- `cargo test -p atools --lib` 通过 69 tests。
- `pnpm smoke:tauri-desktop` 通过，输出 `ATOOLS_DESKTOP_SMOKE {"status":"ok", ... "mcp_bind":"127.0.0.1:50698", ...}`，且本批无新增 Rust dead-code warning。

完成度变化：

| 模块 | 之前 | 现在 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入/市场 | 77% | 80% | 远程 ZIP 安装/更新新增 catalog-provided Ed25519 签名校验，Settings 展示发布者/签名信任，远程能力在签名+评分目录下达到 `9/9` |
| 设置项真实功能 | 99% | 99% | 新增真实签名校验副作用，但证书链/吊销/平台级签名策略、后台任务和权限隔离仍使总项保持 99% |
| ZTools 设置页 UI | 99% | 99% | 市场页新增发布者和签名信任展示，UI 总完成度不单独上调 |

当前重点剩余：

1. 插件市场：只支持 http/https `.zip`；catalog-provided Ed25519 签名已接入，但证书链/吊销/平台级签名策略仍未实现。
2. 插件安全：完整插件权限授权/隔离模型仍未接入，目前只有只读能力审计、安装确认、签名/哈希校验和 Agent tool 白名单。
3. 插件任务体验：后台取消/重试仍未接入。
4. 插件生态：真实第三方插件兼容回归仍需按插件样本继续补。

## Batch 253：Plugin market download progress

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批在 Batch 252 远程详情/评分基础上，把插件市场远程 ZIP 安装/更新的“下载进度”从剩余边界推进为真实可观测能力。范围覆盖下载流式读取、Tauri 进度事件、Settings 订阅和状态模型；不包含后台取消/重试、签名/发布者信任、完整插件权限授权/隔离模型或第三方插件兼容回归。

本批实现：

- `src-tauri/src/commands.rs`
  - 新增 `PluginMarketProgressContext` 和 `PluginMarketProgressEvent`。
  - `install_plugin_from_market` / `update_plugin_from_market` 注入 `AppHandle`，通过 `plugin-market-progress` 事件发出阶段进度。
  - 远程 ZIP 下载从 `response.bytes()` 改为 `response.chunk()` 流式读取，保留 50 MB 上限并在每个 chunk 后报告 `downloaded_bytes`、`total_bytes` 和 `percent`。
  - 进度阶段覆盖 `requesting`、`downloading`、`verifying`、`verified`、`installing`、`finished`。
  - 测试专用 wrapper 使用 `#[cfg(test)]` 限定，避免 dev build dead-code warning。
- `src/lib/pluginMarketStatus.ts`
  - 远程能力新增 `下载进度`。
  - 已读取 catalog 且有评分时远程能力从 `7/8 可用` 调整为 `8/9 可用`。
  - summary/overview 文案明确远程安装/更新会显示进度。
- `src/components/SettingsPanel.svelte`
  - 引入 Tauri `listen`，在 Settings 生命周期内订阅并清理 `plugin-market-progress`。
  - 新增 `PluginMarketProgressEvent` 类型、`pluginMarketProgress` 状态、`handlePluginMarketProgress()`、`marketProgressLabel()` 和字节格式化。
  - 远程安装/更新触发后先显示“正在连接插件市场”，收到事件后显示 `下载进度：...`，catalog 行内也显示当前插件的进度 pill。
- `scripts/test-plugin-market-catalog.mjs`
  - 覆盖 `listen`、`PluginMarketProgressEvent`、`pluginMarketProgress`、`handlePluginMarketProgress`、`marketProgressLabel`、`plugin-market-progress` 和 `下载进度` UI。
- `scripts/test-plugin-market-status.mjs`
  - 覆盖未加载目录时 `下载进度` 不可用。
- `scripts/test-plugin-market-overview.mjs`
  - 覆盖未加载目录时远程能力从 `0/8` 调整为 `0/9`。

TDD 红灯：

- `cargo test -p atools --lib plugin_market_zip_download_reports_progress_events` 首次失败：缺 `PluginMarketProgressContext` 和 `download_plugin_market_archive_with_progress`。
- `pnpm test:plugin-market-catalog` 首次失败：remote capabilities 缺 `下载进度`，Settings 缺进度事件/UI。
- `pnpm test:plugin-market-status` 首次失败：未加载态 remote capabilities 缺 `下载进度`。
- `pnpm test:plugin-market-overview` 首次失败：远程能力仍为 `0/8 可用`，expected 为 `0/9 可用`。

验证：

- `cargo test -p atools --lib plugin_market_zip_download_reports_progress_events`
- `cargo fmt`
- `cargo test -p atools --lib plugin_market` 通过 5 tests。
- `pnpm test:plugin-market-catalog`
- `pnpm test:plugin-market-status`
- `pnpm test:plugin-market-overview`
- `pnpm check` 通过 0 errors / 0 warnings。
- `pnpm build` 通过，保留既有 Vite chunk-size warning。
- In-app Browser 打开 `http://127.0.0.1:1420/`，Settings -> `插件市场` DOM 可见 `0/9 可用` 和 `下载进度` 远程能力行。
- `cargo test -p atools --lib` 通过 68 tests。
- `pnpm smoke:tauri-desktop` 通过，输出 `ATOOLS_DESKTOP_SMOKE {"status":"ok", ... "mcp_bind":"127.0.0.1:64339", ...}`，且本批新增 dead-code warning 已清理。

完成度变化：

| 模块 | 之前 | 现在 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入/市场 | 75% | 77% | 远程 ZIP 安装/更新新增流式下载进度事件和 Settings 进度展示，远程能力从 `7/8` 扩到 `8/9` |
| 设置项真实功能 | 99% | 99% | 新增真实进度事件，但签名信任、后台任务和权限隔离仍使总项保持 99% |
| ZTools 设置页 UI | 99% | 99% | 市场页新增进度展示，UI 总完成度不单独上调 |

当前重点剩余：

1. 插件市场：只支持 http/https `.zip`；没有签名/发布者信任、后台取消/重试。
2. 插件安全：完整插件权限授权/隔离模型仍未接入，目前只有只读能力审计、安装确认和 Agent tool 白名单。
3. 插件生态：真实第三方插件兼容回归仍需按插件样本继续补。

## Batch 252：Plugin market remote details/rating

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批在 Batch 251 安全远程 ZIP 安装/更新、SHA-256 校验和安装确认基础上，把插件市场 catalog 的远程详情与评分元数据从“暂缓”推进到可展示状态。范围只覆盖 catalog 字段解析、Settings 市场页详情面板和能力状态；不包含签名/发布者信任、后台进度/取消/重试、完整插件权限授权/隔离模型或第三方插件兼容回归。

本批实现：

- `src-tauri/src/commands.rs`
  - `PluginMarketCatalogPlugin` 新增 `rating`, `rating_count`, `downloads`, `updated_at`。
  - `RawPluginMarketCatalogPlugin` 支持 `rating`、`ratingCount`/`rating_count`、`downloads`、`updatedAt`/`updated_at`。
  - rating 支持 JSON number/string 归一化为字符串；rating count/downloads 支持 number/string 归一化为 `u64`。
- `src/lib/types.ts`
  - 前端 `PluginMarketCatalogPlugin` 类型补齐 `rating`, `rating_count`, `downloads`, `updated_at`。
- `src/lib/pluginMarketStatus.ts`
  - `PluginMarketStatusInput` 增加 `remoteRatedPluginCount`。
  - 远程能力增加 `远程详情`、`远程评分`、`签名信任`，已读取且有评分字段时远程能力为 `7/8 可用`。
  - summary/overview 文案从“评分详情暂缓”改为“远程详情/评分可展示，签名信任仍暂缓”。
- `src/components/SettingsPanel.svelte`
  - 新增 `selectedMarketPluginId`、`selectedMarketCatalogPlugin()`、`openMarketCatalogDetails(plugin)`。
  - 远程 catalog 行增加 `详情` 按钮、评分 pill、评分数和下载数 pill。
  - 远程 catalog 下方增加 `远程详情` 面板，展示 id、版本、作者、更新时间、市场评分、评分数、下载次数、下载 URL、checksum 和 homepage。
  - 远程能力区改为按实际能力显示 `可用` / `未接入`，`签名信任` 保持未接入。
- `scripts/test-plugin-market-catalog.mjs`
  - 覆盖 `remoteRatedPluginCount`、`7/8 可用`、新字段类型、详情 helper、详情按钮、评分 pill 和详情面板文案。
- `scripts/test-plugin-market-status.mjs`
  - 覆盖未加载目录时 `远程详情`、`远程评分`、`签名信任` 都不可用。
- `scripts/test-plugin-market-overview.mjs`
  - 覆盖未加载目录时远程能力从 `0/6` 调整为 `0/8`，并保留“详情”提示。

TDD 红灯：

- `cargo test -p atools --lib plugin_market_catalog_fetches_and_normalizes_remote_json` 首次失败：`PluginMarketCatalogPlugin` 缺 `rating`、`rating_count`、`downloads`、`updated_at` 字段。
- `pnpm test:plugin-market-catalog` 首次失败：remote capabilities 仍只有旧 6 项，缺 `远程详情`、可用 `远程评分` 和 `签名信任`，Settings 缺详情 UI。
- `pnpm test:plugin-market-status` 首次失败：未加载态 remote capabilities 缺 `远程详情` 和 `签名信任`。
- `pnpm test:plugin-market-overview` 首次失败：远程能力仍为 `0/6 可用`，expected 为 `0/8 可用`。

验证：

- `cargo test -p atools --lib plugin_market_catalog_fetches_and_normalizes_remote_json`
- `pnpm test:plugin-market-catalog`
- `pnpm test:plugin-market-status`
- `pnpm test:plugin-market-overview`
- `cargo fmt`
- `cargo test -p atools --lib plugin_market`
- `pnpm check` 通过 0 errors / 0 warnings。
- `pnpm build` 通过，保留既有 Vite chunk-size warning。
- `cargo test -p atools --lib` 通过 67 tests。
- In-app Browser 打开 `http://127.0.0.1:1420/`，Settings -> `插件市场` DOM 可见 `0/8 可用`、`远程详情`、`远程评分`、`签名信任`；Browser screenshot capture 在 CDP `Page.captureScreenshot` 超时，本批不产出截图 artifact。
- `pnpm smoke:tauri-desktop` 通过，输出 `ATOOLS_DESKTOP_SMOKE {"status":"ok", ... "mcp_bind":"127.0.0.1:61141", ...}`。
- `lsof -nP -iTCP:1420 -sTCP:LISTEN` 无输出，确认 dev server 未遗留。

完成度变化：

| 模块 | 之前 | 现在 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入/市场 | 72% | 75% | 远程 catalog 详情与评分/下载元数据展示完成，远程能力从 `5/6` 扩到 `7/8` |
| 设置项真实功能 | 99% | 99% | 新增详情/评分显示，但签名信任、后台任务和权限隔离仍使总项保持 99% |
| ZTools 设置页 UI | 99% | 99% | 市场页新增详情面板，UI 总完成度不单独上调 |

当前重点剩余：

1. 插件市场：只支持 http/https `.zip`；没有签名/发布者信任、后台取消/重试和下载进度。
2. 插件安全：完整插件权限授权/隔离模型仍未接入，目前只有只读能力审计、安装确认和 Agent tool 白名单。
3. 插件生态：真实第三方插件兼容回归仍需按插件样本继续补。

## Batch 251：Plugin market install/update confirmation

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批在 Batch 250 远程 ZIP 安装/更新与 SHA-256 校验基础上，补上插件市场安装/更新前的应用内确认，避免用户点击 catalog 行后直接触发远程下载和本地插件目录写入。范围只覆盖 Settings 插件市场的远程 ZIP `安装` / `重装` / `更新` 操作确认；不包含签名/发布者信任、后台进度/取消/重试、完整插件权限授权/隔离模型或第三方插件兼容回归。

本批实现：

- `src/components/SettingsPanel.svelte`
  - `installPluginFromMarketCatalog(plugin)` 在设置 `installingMarketPluginId` 和调用 Tauri invoke 之前先调用 `confirmSettingsAction(...)`。
  - 确认标题按动作显示 `${安装|重装|更新}插件`，确认按钮沿用 action label。
  - 确认文案包含插件名、版本、远程 ZIP URL、本地插件目录写入副作用，以及 catalog 是否提供 SHA-256 校验。
  - 取消确认时设置 `pluginMarketStatusText = 已取消...` 并 return，不进入下载/安装/更新路径。
- `src/lib/pluginMarketStatus.ts`
  - 远程能力新增 `安装确认`。
  - 已读取 catalog 后远程能力从 `4/5 可用` 调整为 `5/6 可用`；未读取目录时为 `0/6 可用`。
  - overview 和 summary 文案明确安装/更新前需要确认。
- `scripts/test-plugin-market-catalog.mjs`
  - 覆盖 `安装确认` 能力、`confirmSettingsAction` 调用、确认标题/按钮、取消状态，以及安装/更新 invoke 仍带 plugin id、download URL、checksum。
- `scripts/test-plugin-market-status.mjs`
  - 覆盖未读取目录时 `安装确认` 不可用，以及 summary 变为“读取后可确认安装或更新远程 ZIP”。
- `scripts/test-plugin-market-overview.mjs`
  - 覆盖远程能力未加载态从 `0/5` 调整为 `0/6`，并包含确认说明。

TDD 红灯：

- `pnpm test:plugin-market-catalog` 首次失败：actual remote capabilities 缺 `安装确认`，Settings 也没有确认弹窗调用。
- `pnpm test:plugin-market-status` 首次失败：actual remote capabilities 缺 `安装确认`。
- `pnpm test:plugin-market-overview` 首次失败：actual 仍为 `0/5 可用`，expected 为 `0/6 可用`。

验证：

- `pnpm test:plugin-market-catalog`
- `pnpm test:plugin-market-status`
- `pnpm test:plugin-market-overview`
- `pnpm test:settings-confirm-dialog`
- `pnpm check`
- `pnpm build` 通过，保留既有 Vite chunk-size warning。
- `cargo test -p atools --lib plugin_market`
- In-app Browser 打开 `http://localhost:1420/?bust=251-market-confirm`，Settings -> `插件市场` 可见 `插件市场概览`、`下载/安装/更新`、`SHA-256 校验`、`安装确认`、`刷新插件`，无横向溢出，无 Vite/Svelte error overlay，console 0 warnings/errors。
- Playwright fallback 打开 `http://localhost:1420/?bust=251-market-confirm-pw`，1280px 下验证同样市场状态并保存 `/Users/harris/Desktop/atools-b251-market-confirm.png`。
- `pnpm smoke:tauri-desktop` 通过，输出 `ATOOLS_DESKTOP_SMOKE {"status":"ok", ... "mcp_bind":"127.0.0.1:58670", ...}`。
- `cargo test -p atools --lib` 通过 67 tests。

完成度变化：

| 模块 | 之前 | 现在 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入/市场 | 70% | 72% | 远程安装/重装/更新前加入设置页确认，取消不会启动下载或本地写入 |
| 设置项真实功能 | 99% | 99% | 新增安装确认流，但签名信任、后台任务和权限隔离仍使总项保持 99% |
| ZTools 设置页 UI | 99% | 99% | 市场能力新增确认项，UI 总完成度不单独上调 |

当前重点剩余：

1. 插件市场：只支持 http/https `.zip`；没有签名/发布者信任、评分详情、远程详情页、后台取消/重试和下载进度。
2. 插件安全：完整插件权限授权/隔离模型仍未接入，目前只有只读能力审计、安装确认和 Agent tool 白名单。
3. 插件生态：真实第三方插件兼容回归仍需按插件样本继续补。

## Batch 250：Plugin market SHA-256 checksum verification

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批在 Batch 249 远程 ZIP 安装/更新基础上接入目录 SHA-256 校验：自定义市场 catalog 条目可声明 `checksum` 或 `sha256`，安装/更新远程 ZIP 前必须先验证下载字节摘要。范围仍限定为 http/https `.zip` catalog 条目；不包含签名/发布者信任、评分详情、后台取消/重试、安装进度、完整权限授权/隔离模型或真实第三方插件兼容回归。

本批实现：

- `src-tauri/src/commands.rs`
  - `PluginMarketCatalogPlugin` 新增 `checksum: Option<String>`，远程 JSON 同时接受 `checksum`、`sha256`、`sha256Checksum`、`sha256_checksum`。
  - catalog normalization 将合法 SHA-256 digest 统一为 `sha256:<64 lowercase hex>`。
  - `install_plugin_from_market` / `update_plugin_from_market` 新增可选 `checksum` 参数，并传入 checksum-aware 内部 helper。
  - 下载 ZIP 后、staging 解包前计算 SHA-256；digest mismatch 返回明确 `checksum mismatch` 错误，不触碰安装目录、不改写现有插件版本。
  - 旧无 checksum helper 仅保留给 `cfg(test)` 兼容已有无 checksum 回归。
- `src/components/SettingsPanel.svelte`
  - catalog 行安装/更新 invoke 传 `checksum: plugin.checksum ?? null`。
  - 带 checksum 的远程条目显示 `SHA-256 已校验`。
  - 插件市场和已安装插件边界文案改为“目录 SHA-256 会校验，签名信任仍未接入”。
- `src/lib/pluginMarketStatus.ts` / `src/lib/types.ts`
  - 前端 catalog 类型新增 `checksum`。
  - 远程能力增加 `SHA-256 校验`；已读取远程目录后远程能力从 `3/4` 变为 `4/5`。
- `src-tauri/Cargo.toml` / `Cargo.lock`
  - 新增 `sha2` 依赖用于 ZIP 摘要计算。
- `scripts/test-plugin-market-catalog.mjs`
  - 覆盖 Settings checksum 类型、invoke 参数、`SHA-256 已校验` 标记和 `4/5` 能力数。
- `scripts/test-plugin-market-status.mjs`
  - 覆盖未读取目录时 `SHA-256 校验` 为不可用。
- `scripts/test-plugin-market-overview.mjs`
  - 覆盖远程能力未接入态从 `0/4` 调整为 `0/5`，并显示校验相关说明。

TDD 红灯：

- `cargo test -p atools --lib plugin_market_zip_download_verifies_sha256_checksum_before_install` 首次失败：`install_plugin_from_market_checked_url_inner` / `update_plugin_from_market_checked_url_inner` 不存在，`PluginMarketCatalogPlugin` 没有 `checksum` 字段。
- `pnpm test:plugin-market-catalog` 首次失败：实际远程能力仍只有 `目录读取/市场搜索/下载/安装/更新/远程评分`，缺 `SHA-256 校验`。
- `pnpm test:plugin-market-status` 首次失败：未读取目录态缺 `SHA-256 校验` 行。
- `pnpm test:plugin-market-overview` 首次失败：远程能力仍为 `0/4 可用`，不是 `0/5 可用`。

验证：

- `cargo test -p atools --lib plugin_market_zip_download_verifies_sha256_checksum_before_install`
- `pnpm test:plugin-market-catalog`
- `pnpm test:plugin-market-status`
- `pnpm test:plugin-market-overview`
- `cargo fmt`
- `cargo test -p atools --lib plugin_market`
- `cargo test -p atools --lib`
- `pnpm check`
- `pnpm build` 通过，保留既有 Vite chunk-size warning。
- In-app Browser 打开 `http://localhost:1420/?bust=250-market-sha256`，Settings -> `插件市场` 可见 `插件市场概览`、`下载/安装/更新`、`SHA-256 校验`、`刷新插件`，无横向溢出，console 0 errors/0 warnings。Browser 截图接口仍在 `Page.captureScreenshot` 超时。
- Playwright fallback 打开 `http://localhost:1420/?bust=250-market-sha256-pw`，1280px 下验证同样市场状态、无 Vite/Svelte error overlay、console 0 warnings/errors，并保存 `/Users/harris/Desktop/atools-b250-market-sha256.png`。
- `pnpm smoke:tauri-desktop` 首次因手动 dev server 占用 1420 失败；停止该 dev server 后重跑通过，最终输出 `ATOOLS_DESKTOP_SMOKE {"status":"ok", ... "mcp_bind":"127.0.0.1:57203", ...}` 且无 Rust warning。

完成度变化：

| 模块 | 之前 | 现在 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入/市场 | 67% | 70% | 远程 ZIP 安装/更新新增目录 SHA-256 校验，能拒绝下载篡改或 catalog digest mismatch |
| 设置项真实功能 | 99% | 99% | 新增真实安全校验副作用，但签名信任和权限隔离仍使总项保持 99% |
| ZTools 设置页 UI | 99% | 99% | 市场能力和 catalog 行校验状态已显示，整体 UI 完成度不单独上调 |

当前重点剩余：

1. 插件市场：只支持 http/https `.zip`；没有签名/发布者信任、评分详情、远程详情页、后台取消/重试和下载进度。
2. 插件安全：完整插件权限授权/隔离模型仍未接入，目前只有只读能力审计和 Agent tool 白名单。
3. 插件生态：真实第三方插件兼容回归仍需按插件样本继续补。

## Batch 249：Plugin market remote ZIP update

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批在 Batch 248 远程 ZIP 安装基础上补齐同 ID 远程更新：自定义市场目录中的已安装插件不再只能重新“安装”，而是按状态显示 `更新` 或 `重装`，并走保留启停状态的更新路径。范围仍限定为 http/https `.zip` catalog 条目，不包含签名/校验和、评分详情、后台任务取消/重试、完整权限授权/隔离模型或第三方插件生态兼容回归。

本批实现：

- `src-tauri/src/commands.rs`
  - 新增 Tauri command `update_plugin_from_market(plugin_id, download_url)`。
  - 新增内部 `update_plugin_from_market_url_inner(...)`，复用远程 ZIP 下载、50 MiB 限制、临时 staging、安全解包、zip-slip/symlink/multiple manifest 防护。
  - 更新路径复用 `plugin_update_from_path_inner(...)`，所以会校验 ZIP 内 manifest id 与目标插件 id 一致，保留已有插件 `enabled` 状态和 `created_at`，替换旧文件，刷新 DB 插件记录和 feature 索引。
  - `install_plugin_from_market` 新增 catalog `plugin_id` 参数，并在复制前校验 ZIP 内 manifest id 与 catalog id 一致，避免 catalog 条目静默安装另一个插件。
  - 抽出 `download_plugin_market_archive(...)`、`install_plugin_from_directory_checked_inner(...)` 和 staging cleanup helper，减少安装/更新路径分叉。
- `src-tauri/src/lib.rs`
  - 注册 `commands::update_plugin_from_market` 到 Tauri handler。
- `src/components/SettingsPanel.svelte`
  - 新增 `marketCatalogInstalledPlugin(...)`、`marketCatalogActionLabel(...)`、`marketCatalogBusyLabel(...)`。
  - catalog 行未安装显示 `安装`，同版本已安装显示 `重装`，不同版本已安装显示 `更新`；busy 态对应 `安装中` / `重装中` / `更新中`。
  - 已安装同 ID catalog 条目调用 `update_plugin_from_market`，新条目调用 `install_plugin_from_market`，成功后刷新已安装插件清单。
- `src/lib/pluginMarketStatus.ts`
  - 远程能力从 `下载/安装` 升级为 `下载/安装/更新`。
  - 自定义目录已读取时文案明确 ZIP 安装/更新可用，评分和详情仍暂缓。
- `scripts/test-plugin-market-catalog.mjs`、`scripts/test-plugin-market-status.mjs`、`scripts/test-plugin-market-overview.mjs`
  - 更新状态模型、SettingsPanel 源码和概览文案断言，覆盖 install/update 分流、busy label 和 `下载/安装/更新` 能力。

验证：

- 红灯确认：
  - `cargo test -p atools --lib plugin_market_zip_update_preserves_enabled_state_and_rejects_id_mismatch` 首次失败在 `no update_plugin_from_market_url_inner in commands`。
  - `pnpm test:plugin-market-catalog` 首次失败在 expected `下载/安装/更新`，actual 仍为 `下载/安装`。
  - `pnpm test:plugin-market-status` 首次失败在 expected `下载/安装/更新`，actual 仍为 `下载/安装`。
- 绿灯：
  - `cargo test -p atools --lib plugin_market_zip_update_preserves_enabled_state_and_rejects_id_mismatch`
  - `pnpm test:plugin-market-catalog`
  - `pnpm test:plugin-market-status`
  - `pnpm test:plugin-market-overview`
  - `pnpm test:plugin-inventory`
  - `cargo test -p atools --lib plugin_market`
  - `cargo test -p atools --lib`
  - `cargo fmt`
  - `pnpm check`
  - `pnpm build`
- Browser/Playwright smoke：
  - In-app Browser 打开 `http://localhost:1420/?bust=249-market-update`，Settings -> `插件市场` 可见 `插件市场概览`、`网络插件市场下载安装更新需先配置并读取自定义目录`、`下载/安装/更新`、`刷新插件`，console 0 errors/0 warnings。Browser `Page.captureScreenshot` 本次仍超时，改用 Playwright fallback 留图。
  - Playwright fallback URL：`http://localhost:1420/?bust=249-market-update-pw`。
  - Playwright 检查 `hasMarketOverview=true`、`hasInstallUpdateBoundary=true`、`hasDownloadInstallUpdate=true`、`hasRefresh=true`、`frameworkOverlay=false`，console 0 errors/0 warnings。
  - screenshot：`/Users/harris/Desktop/atools-b249-market-update.png`。
- Desktop smoke：
  - `pnpm smoke:tauri-desktop`
  - `ATOOLS_DESKTOP_SMOKE {"status":"ok", ...}`
  - `Desktop smoke passed: 127.0.0.1:56116`

完成度调整：

| 模块 | 之前 | 现在 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入/市场 | 64% | 67% | 自定义远程目录条目可安全更新同 ID ZIP 插件，保留启停状态并拒绝 manifest ID 不匹配 |
| ZTools 设置页 UI | 99% | 99% | 插件市场页新增安装/重装/更新动作分流，但整体设置页仍受签名、权限隔离和真实回归约束 |
| 设置项真实功能 | 99% | 99% | 新增远程 ZIP 更新真实副作用命令，但签名校验、权限授权和插件生态回归仍使总项保持 99% |

剩余风险：

1. 插件市场：只支持 http/https `.zip`，没有签名、checksum、publisher trust、评分详情、远程详情页、后台取消/重试和下载进度。
2. 安装/更新安全：已做 zip-slip、symlink、多 manifest、空 archive、大小限制和 manifest ID 校验，但尚未做完整权限授权、沙箱隔离或恶意插件静态审计。
3. 兼容回归：复用本地安装/更新流程可保证 manifest/feature/Agent tools 进入现有索引，但真实第三方插件 UI/runtime 兼容仍需后续专项。
4. 产品体验：catalog 安装/更新仍是单按钮同步状态，没有版本比较细节、失败重试、更新说明或安装前权限确认弹窗。

## Batch 248：Plugin market remote ZIP install

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批聚焦自定义插件市场：在已经能读取远程 JSON catalog 的基础上，允许 catalog 条目安装 http/https `.zip` 插件包。范围只覆盖“远程目录中的 ZIP 包下载安装到本地插件目录”，不包含远程更新、签名/校验和、评分详情、后台任务取消/重试、完整权限授权/隔离模型或第三方插件生态兼容回归。

实现依据：

- `zip` crate `ZipArchive::new()` 可从字节流读取 ZIP archive。
- `ZipFile::enclosed_name()` 提供 enclosed path 校验，返回值可用于拒绝 zip-slip 路径。
- 本批在 archive 层继续额外拒绝 symlink entry，并要求 staging 目录里只有一个 `plugin.json`，避免一个 ZIP 同时注入多个插件根。
- Source: Context7 `/zip-rs/zip2`

本批实现：

- `src-tauri/Cargo.toml`
  - 新增 `zip = { version = "2.4", default-features = false, features = ["deflate"] }`。
- `src-tauri/src/commands.rs`
  - 新增 Tauri command `install_plugin_from_market(download_url)`。
  - 新增 market install 内部流程：校验 http/https `.zip` URL，使用 `reqwest` 下载，限制 50 MiB，写入 `plugin-market-staging/download-<pid>-<nanos>` 临时目录，解包后定位唯一 `plugin.json`。
  - 解包阶段使用 `entry.enclosed_name()` 拒绝 unsafe path，拒绝 symlink entry，拒绝空 archive 和多 manifest archive。
  - 抽出 `install_plugin_from_directory_inner(...)`，让本地目录安装和远程 market 安装复用同一套 manifest 校验、插件目录复制、DB 保存、feature 索引和 Agent plugin tools 同步路径。
  - 成功安装后清理 staging 目录；清理失败只记录 warning，不把已完成安装回滚成失败。
- `src-tauri/src/lib.rs`
  - 注册 `commands::install_plugin_from_market` 到 Tauri handler。
- `src/components/SettingsPanel.svelte`
  - 自定义远程 catalog row 新增 `安装` 按钮和单行 `安装中` busy 状态。
  - 安装成功后刷新 `list_plugins`，选中新安装插件并折叠权限审计面板。
  - Web preview 保持无副作用提示，不尝试安装。
- `src/lib/pluginMarketStatus.ts`
  - 远程能力从旧 `下载/更新` 改为 `下载/安装`。
  - 仅在 `remoteCatalogLoaded` 时把 `下载/安装` 标记为可用。
  - 保持 `远程评分`、详情和更新能力不可用。
- `scripts/test-plugin-market-catalog.mjs`、`scripts/test-plugin-market-status.mjs`、`scripts/test-plugin-market-overview.mjs`
  - 更新市场能力断言和 SettingsPanel 源码断言，覆盖 `install_plugin_from_market` 调用、busy state 和新的 `下载/安装` 文案。

验证：

- 红灯确认：
  - `cargo test -p atools --lib plugin_market_zip_download_installs_plugin_and_rejects_zip_slip` 首次失败在 `no install_plugin_from_market_url_inner in commands`。
  - `pnpm test:plugin-market-catalog` 首次失败在 expected `下载/安装=true`，actual 仍为 `下载/更新=false`。
- 绿灯：
  - `cargo test -p atools --lib plugin_market_zip_download_installs_plugin_and_rejects_zip_slip`
  - `pnpm test:plugin-market-catalog`
  - `pnpm test:plugin-market-status`
  - `pnpm test:plugin-market-overview`
  - `pnpm test:plugin-inventory`
  - `cargo test -p atools --lib plugin_market`
  - `cargo test -p atools --lib`
  - `cargo fmt`
  - `pnpm check`
  - `pnpm build`
- Browser/Playwright smoke：
  - In-app Browser 打开 `http://localhost:1420/?bust=248-market-install`，Settings -> `插件市场` 可见 `插件市场概览`、`网络插件市场下载安装需先配置并读取自定义目录`、`下载/安装`、`刷新插件`，console 0 errors/0 warnings。Browser `Page.captureScreenshot` 本次超时，改用 Playwright fallback 留图。
  - Playwright fallback URL：`http://localhost:1420/?bust=248-market-install-pw`。
  - Playwright 检查 `hasMarketOverview=true`、`hasDownloadInstallBoundary=true`、`hasDownloadInstallCapability=true`、`hasRefresh=true`、`frameworkOverlay=false`、`consoleEntries=[]`。
  - screenshot：`/Users/harris/Desktop/atools-b248-market-install.png`。
- Desktop smoke：
  - `pnpm smoke:tauri-desktop`
  - `ATOOLS_DESKTOP_SMOKE {"status":"ok", ...}`
  - `Desktop smoke passed: 127.0.0.1:52791`

完成度调整：

| 模块 | 之前 | 现在 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入/市场 | 61% | 64% | 自定义远程目录条目可下载 http/https ZIP，安全解包后复用本地插件安装流程 |
| ZTools 设置页 UI | 99% | 99% | 插件市场页新增行级安装动作，但整体设置页仍受插件接入后真实回归和发布项约束 |
| 设置项真实功能 | 99% | 99% | 新增一个真实插件市场副作用命令，但远程更新、签名校验和权限隔离仍使总项保持 99% |

剩余风险：

1. 插件市场：只支持 http/https `.zip`，没有签名、checksum、publisher trust、评分详情、远程详情页、后台取消/重试和 remote update。
2. 安装安全：已做 zip-slip、symlink、多 manifest、空 archive 和大小限制，但尚未做完整权限授权、沙箱隔离或恶意插件静态审计。
3. 兼容回归：复用本地安装流程可保证 manifest/feature/Agent tools 进入现有索引，但真实第三方插件 UI/runtime 兼容仍需后续专项。
4. 产品体验：catalog 安装仍是单按钮同步状态，没有下载进度、失败重试、版本比较、更新提示或安装前权限确认弹窗。

## Batch 247：BrowserWindow hosted document and parent state bridge

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批继续收口宿主内 browser-window BrowserWindow 兼容，补齐 current Electron/BaseWindow document/parent state surface：`isNormal()`、`isModal()`、`setDocumentEdited(edited)`、`isDocumentEdited()`、`setRepresentedFilename(filename)`、`getRepresentedFilename()`、`setParentWindow(parent | null)`、`getParentWindow()`、`getChildWindows()`。范围仍限定为当前 PluginPanel hosted child iframe；这里维护的是 hosted document/parent state compatibility，不等同 native macOS document proxy icon、dirty-dot integration、sheet/modal session、NSWindow parent/child lifetime 或系统级窗口层级销毁语义。

官方语义依据：

- Electron latest BaseWindow / BrowserWindow 方法列表包含 `isNormal()`、`isModal()`、`setRepresentedFilename()`、`getRepresentedFilename()`、`setDocumentEdited()`、`isDocumentEdited()`、`setParentWindow()`、`getParentWindow()`、`getChildWindows()`。
- `setDocumentEdited(edited)`、`setRepresentedFilename(filename)`、`setParentWindow(parent | null)` 是 setter-style void-return API；对应 getter 同步返回当前 document state 或 window relationship。
- `setParentWindow(null)` 表示清理 parent window。
- Source: Context7 `/websites/electronjs`, `https://www.electronjs.org/docs/latest/api/base-window`, `https://www.electronjs.org/docs/latest/api/browser-window`

本批实现：

- `src/components/PluginPanel.svelte`
  - hosted BrowserWindow state 新增 `documentEdited`、`representedFilename`、`modal`、`parentWindowId`。
  - 注入端 handle registry 新增 hosted BrowserWindow handle 查找，用于 `getParentWindow()` 和 `getChildWindows()` 返回同一宿主内的 handle 引用。
  - 注入端 handle 新增 `isNormal()`、`isModal()`、`setDocumentEdited()`、`isDocumentEdited()`、`setRepresentedFilename()`、`getRepresentedFilename()`、`setParentWindow()`、`getParentWindow()`、`getChildWindows()`。
  - `minimize()`、`restore()`、`maximize()`、`unmaximize()`、`setFullScreen()`、`setKiosk()` 的回包会同步 hosted shape cache，支撑 `isNormal()` 读取。
  - host action 新增 document/parent route；关闭窗口时会清理已销毁 parent id 的 child cache。
- `src/App.svelte`
  - BrowserWindow Web preview 在临时 source window 上验证 `setParentWindow(sourceWin)` / `getParentWindow()` / `getChildWindows()`，再执行 `setParentWindow(null)` 清理。
  - BrowserWindow Web preview 在 titlebar/material smoke 后验证 document edited、represented filename、normal/modal 和 parent/child 空状态，并记录 `data-browser-window-document-parent-state`。
- `scripts/test-plugin-window-browser-bridge.mjs`
  - 增加 BrowserWindow handle document/parent API 方法暴露断言。
  - 增加 `setDocumentEdited(true)`、`setRepresentedFilename(...)`、`setParentWindow(parent)`、`setParentWindow(null)` 的 void-return、sync getter 和 native bridge route/args 断言。
  - 增加 `PluginBrowserWindowState` 字段和 App Web preview 静态覆盖断言。

验证：

- 红灯确认：
  - `pnpm test:plugin-window-browser-bridge` 首次失败在 `browser-window handle should expose isNormal()`。
- 绿灯：
  - `pnpm test:plugin-window-browser-bridge`
  - `pnpm test:plugin-host-view`
  - `pnpm test:plugin-window-page-search`
  - `pnpm test:plugin-window-lifecycle`
  - `pnpm check`
- Browser/Playwright smoke：
  - In-app Browser 打开 `http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=247-document-parent-browser`，页面 identity 和 non-blank DOM 通过；Browser 的 sandboxed iframe attribute 读取和 screenshot capture 仍受已知限制，因此最终属性断言使用 Playwright MCP fallback。
  - Playwright MCP URL：`http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=247-document-parent-mcp`
  - recorded `data-browser-window-document-parent-state="true"`、`data-browser-window-parent-child-state="true"`、`data-browser-window-titlebar-material-state="true"`、`data-browser-window-menu-bar-state="true"`、`data-browser-window-background-color="true"`、`data-browser-window-webcontents-waiting-response="true"`、`data-browser-window-navigation-history="true"`、`data-browser-window-webcontents-focus-state="true"`、`data-browser-window-webcontents-owner-media="true"`、`data-browser-window-webcontents-crash-reload="true"`、`data-browser-window-webcontents-lifecycle="true"`、`data-browser-window-runtime-state="true"`、`data-browser-window-always-on-top="true"`。
  - host shell class 包含 `windowButtonsHidden` 和 `alwaysOnTop`，close button computed `visibility` 为 `hidden`。
  - screenshot：`/Users/harris/Desktop/atools-b247-document-parent-smoke.png`。
  - console：0 errors，2 existing iframe sandbox warnings。
- Final verification also includes:
  - `pnpm build`
  - `pnpm smoke:tauri-desktop`
  - 1420 port clear before desktop smoke.

完成度调整：

| 模块 | 之前 | 现在 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 94% | 95% | BrowserWindow hosted document/parent state APIs 可在指定 child iframe handle 上跑通，并纳入 Web preview smoke |
| 插件 runtime parity | 99% | 99% | 顶层 uTools/ZTools runtime 主体未新增一类能力；本批属于 hosted BrowserWindow 子集扩面 |

剩余风险：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. BrowserWindow：当前仍是 hosted child iframe，不是系统级独立 native BrowserWindow。
3. Document/parent：当前只维护 hosted document dirty、represented filename、modal 和 parent/child handle cache，不等同 native macOS document proxy、dirty-dot、modal session、NSWindow parent/child lifetime 或系统级销毁语义。
4. WebContents：完整 Chromium WebContents API、跨进程 frame routing、真实 network/cache/session history、native DevTools/print/PDF/capture pipeline 仍未完全还原。

## Batch 246：BrowserWindow hosted titlebar and material state bridge

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批继续收口宿主内 browser-window BrowserWindow 兼容，补齐 current Electron/macOS titlebar/material surface：`setWindowButtonVisibility(visible)`、`setWindowButtonPosition(position | null)`、`getWindowButtonPosition()`、`setVibrancy(type[, options])`、`setBackgroundMaterial(material)`、`setSheetOffset(offsetY[, offsetX])`。范围仍限定为当前 PluginPanel hosted child iframe；这里维护的是 hosted titlebar/material state compatibility，不等同 native macOS traffic lights、NSVisualEffectView vibrancy、background material compositor 或 sheet attachment point。

官方语义依据：

- Electron latest `BrowserWindow.setWindowButtonVisibility(visible)` 控制 macOS traffic light/window buttons 可见性。
- Electron latest `BrowserWindow.setWindowButtonPosition(position)` 设置 frameless window traffic light/window buttons 自定义位置，`null` 重置为系统默认。
- Electron latest `BrowserWindow.getWindowButtonPosition()` 返回 custom position 或 `null`。
- Electron breaking changes 标记 `setTrafficLightPosition()` / `getTrafficLightPosition()` 已被 current `setWindowButtonPosition()` / `getWindowButtonPosition()` 替代。
- Electron latest `BrowserWindow.setVibrancy(type[, options])` 添加或移除 macOS vibrancy，传 `null` 或空字符串移除。
- Electron latest `BrowserWindow.setBackgroundMaterial(material)` 设置 macOS background material。
- Electron latest BaseWindow `setSheetOffset(offsetY[, offsetX])` 修改 macOS sheet attachment point。
- Source: Context7 `/websites/electronjs`, `https://www.electronjs.org/docs/latest/api/browser-window`, `https://www.electronjs.org/docs/latest/api/base-window`, `https://www.electronjs.org/docs/latest/breaking-changes`

本批实现：

- `src/components/PluginPanel.svelte`
  - hosted BrowserWindow state 新增 `windowButtonVisible`、`windowButtonPosition`、`vibrancy`、`vibrancyOptions`、`backgroundMaterial`、`sheetOffsetY`、`sheetOffsetX`。
  - 注入端 handle 新增 `setWindowButtonVisibility()`、`setWindowButtonPosition()`、`getWindowButtonPosition()`、`setVibrancy()`、`setBackgroundMaterial()`、`setSheetOffset()`。
  - `setWindowButtonPosition(null)` 会把 hosted position cache 重置为 `null`；`getWindowButtonPosition()` 返回拷贝或 `null`。
  - host action 新增对应路由并更新 runtime strip 最近消息；`windowButtonsHidden` class 会让 hosted child-window header close button 进入 hidden 状态，表达当前 hosted traffic-light visibility。
- `src/App.svelte`
  - BrowserWindow Web preview 在 menu-bar smoke 后调用 titlebar/material API，验证 setter void-return、button position 同步 getter、`null` reset、vibrancy clear、background material 和 sheet offset，并记录 `data-browser-window-titlebar-material-state`。
- `scripts/test-plugin-window-browser-bridge.mjs`
  - 增加 BrowserWindow handle titlebar/material API 方法暴露断言。
  - 增加 `setWindowButtonVisibility(false)`、`setWindowButtonPosition({ x: 18, y: 9 })`、`setWindowButtonPosition(null)`、`setVibrancy("sidebar", { animationDuration: 120 })`、`setVibrancy(null)`、`setBackgroundMaterial("under-window")`、`setSheetOffset(44, 12)` 的 void-return、sync getter 和 native bridge route/args 断言。
  - 增加 `PluginBrowserWindowState` 字段、`windowButtonsHidden` class 和 App Web preview 静态覆盖断言。

验证：

- 红灯确认：
  - `pnpm test:plugin-window-browser-bridge` 首次失败在 `browser-window handle should expose setWindowButtonVisibility()`。
- 绿灯：
  - `pnpm test:plugin-window-browser-bridge`
  - `pnpm test:plugin-host-view`
  - `pnpm test:plugin-window-page-search`
  - `pnpm test:plugin-window-lifecycle`
  - `pnpm check`
- Browser/Playwright smoke：
  - In-app Browser 打开 `http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=246-titlebar-material-iab`，页面 identity 和 non-blank DOM 通过；Browser 的 sandboxed/transformed iframe attribute 读取和截图仍受已知限制，因此最终属性断言使用 Playwright MCP fallback。
  - Playwright MCP URL：`http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=246-titlebar-material-mcp`
  - recorded `data-browser-window-titlebar-material-state="true"`、`data-browser-window-menu-bar-state="true"`、`data-browser-window-background-color="true"`、`data-browser-window-webcontents-waiting-response="true"`、`data-browser-window-navigation-history="true"`、`data-browser-window-webcontents-focus-state="true"`、`data-browser-window-webcontents-owner-media="true"`、`data-browser-window-webcontents-crash-reload="true"`、`data-browser-window-webcontents-lifecycle="true"`、`data-browser-window-runtime-state="true"`、`data-browser-window-always-on-top="true"`。
  - host shell class 包含 `windowButtonsHidden`，close button computed `visibility` 为 `hidden`；child iframe title 为 `子窗口已更新`，并保持 `data-child-ipc-ping="true"`、`data-execute-js="42"`、`data-send-input-event="Enter:shift"`。
  - screenshot：`/Users/harris/Desktop/atools-b246-titlebar-material-smoke.png`。
  - console：0 errors，2 existing iframe sandbox warnings。
- Final verification also includes:
  - `pnpm build`
  - `pnpm smoke:tauri-desktop`
  - 1420 port clear before desktop smoke.

完成度调整：

| 模块 | 之前 | 现在 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 93% | 94% | BrowserWindow hosted titlebar/material state APIs 可在指定 child iframe handle 上跑通，并纳入 Web preview smoke |
| 插件 runtime parity | 99% | 99% | 顶层 uTools/ZTools runtime 主体未新增一类能力；本批属于 hosted BrowserWindow 子集扩面 |

剩余风险：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. BrowserWindow：当前仍是 hosted child iframe，不是系统级独立 native BrowserWindow。
3. Titlebar/material：当前只维护 hosted window-button visibility/position、vibrancy/background material/sheet offset state，不等同 native macOS traffic lights、NSVisualEffectView vibrancy、WindowServer material/compositor 或真实 sheet attachment point。
4. WebContents：完整 Chromium WebContents API、跨进程 frame routing、真实 network/cache/session history、native DevTools/print/PDF/capture pipeline 仍未完全还原。

## Batch 245：BrowserWindow hosted menu-bar state bridge

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批继续收口宿主内 browser-window BrowserWindow 兼容，补齐 Windows/Linux 侧常见的菜单栏状态 API：`setAutoHideMenuBar(hide)`、`isMenuBarAutoHide()`、`setMenuBarVisibility(visible)`、`isMenuBarVisible()`、`removeMenu()`、`setMenu(menu)`。范围仍限定为当前 PluginPanel hosted child iframe；这里维护的是 hosted menu-bar state compatibility，不等同 native app menu、Alt 键唤起、Menu 对象渲染或平台菜单行为。

官方语义依据：

- Electron latest `BrowserWindow.setAutoHideMenuBar(hide)` 设置菜单栏是否自动隐藏，菜单栏可通过单按 Alt 键显示；主要适用于 Windows/Linux。
- Electron latest `BrowserWindow.isMenuBarAutoHide()` 返回菜单栏 auto-hide 状态 boolean。
- Electron latest `BrowserWindow.setMenuBarVisibility(visible)` 设置菜单栏可见性；如果 auto-hide 启用，Alt 仍可显示菜单栏；主要适用于 Windows/Linux。
- Electron latest `BrowserWindow.isMenuBarVisible()` 返回菜单栏可见性 boolean。
- Electron latest `BrowserWindow.setMenu(menu)` 设置窗口菜单栏；`null` 可移除菜单栏。
- Electron latest `BrowserWindow.removeMenu()` 移除窗口菜单栏。
- Source: Context7 `/websites/electronjs`, `https://www.electronjs.org/docs/latest/api/browser-window`

本批实现：

- `src/components/PluginPanel.svelte`
  - hosted BrowserWindow state 新增 `menuBarAutoHide`、`menuBarVisible`、`menuRemoved`。
  - `createPluginBrowserWindow()` 从 options 初始化 auto-hide、visible 和 removed 状态，并把它们返回给注入端 handle cache。
  - hosted BrowserWindow handle 新增 `setAutoHideMenuBar()` / `isMenuBarAutoHide()` / `setMenuBarVisibility()` / `isMenuBarVisible()` / `removeMenu()` / `setMenu()`。
  - `setAutoHideMenuBar()` / `setMenuBarVisibility()` / `removeMenu()` / `setMenu()` 保持 `undefined` 返回值，同时立即同步注入端 cache，并异步路由到 host action。
  - host action 新增 `setAutoHideMenuBar`、`isMenuBarAutoHide`、`setMenuBarVisibility`、`isMenuBarVisible`、`removeMenu`、`setMenu`，用于更新 BrowserWindow runtime strip 最近消息和 hosted state。
- `src/App.svelte`
  - BrowserWindow Web preview 在 background-color smoke 后调用 `setAutoHideMenuBar(true)`、`setMenuBarVisibility(false)`、`removeMenu()`、`setMenu({ items: [...] })`。
  - smoke 确认 setter/remove/setMenu 均保持 void-return shape，`isMenuBarAutoHide()` 回读 true，`setMenu()` 后 `isMenuBarVisible()` 回读 true，并记录 `data-browser-window-menu-bar-state`。
- `scripts/test-plugin-window-browser-bridge.mjs`
  - 增加 BrowserWindow handle 菜单栏 API 方法暴露断言。
  - 增加默认 auto-hide/visible 状态、setter void-return shape、同步 getter 回读、native bridge route/args、`removeMenu()` 隐藏、`setMenu(menu)` 恢复 visible 的行为断言。
  - 增加 `PluginBrowserWindowState` 字段和 App Web preview 静态覆盖断言，确保 menu-bar state smoke 不会被实现后移除。

验证：

- 红灯确认：
  - `pnpm test:plugin-window-browser-bridge` 首次失败在 `browser-window handle should expose setAutoHideMenuBar()`。
- 绿灯：
  - `pnpm test:plugin-window-browser-bridge`
  - `pnpm test:plugin-host-view`
  - `pnpm test:plugin-window-page-search`
  - `pnpm test:plugin-window-lifecycle`
- Browser/Playwright smoke：
  - In-app Browser 打开 `http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=245-menu-bar-iab4`，页面加载到 hosted BrowserWindow UI；Browser 自动化读取 sandboxed/transformed iframe 属性和截图仍受已知限制，因此最终属性断言使用 Playwright MCP fallback。
  - Playwright MCP URL：`http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=245-menu-bar-mcp`
  - recorded `data-browser-window-menu-bar-state="true"`、`data-browser-window-background-color="true"`、`data-browser-window-webcontents-waiting-response="true"`、`data-browser-window-navigation-history="true"`、`data-browser-window-webcontents-focus-state="true"`、`data-browser-window-webcontents-owner-media="true"`、`data-browser-window-webcontents-crash-reload="true"`、`data-browser-window-webcontents-lifecycle="true"`、`data-browser-window-runtime-state="true"`、`data-browser-window-always-on-top="true"`。
  - child iframe title 为 `子窗口已更新`，并保持 `data-child-ipc-ping="true"`、`data-execute-js="42"`、`data-send-input-event="Enter:shift"`。
  - screenshot：`/Users/harris/Desktop/atools-b245-menu-bar-smoke.png`。
  - console：0 errors，2 existing iframe sandbox warnings。
- Final verification also includes:
  - `pnpm check`
  - `pnpm build`
  - `pnpm smoke:tauri-desktop`
  - 1420 port clear after Web and desktop smoke.

完成度调整：

| 模块 | 之前 | 现在 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 92% | 93% | BrowserWindow hosted menu-bar state APIs 可在指定 child iframe handle 上跑通，并纳入 Web preview smoke |
| 插件 runtime parity | 99% | 99% | 顶层 uTools/ZTools runtime 主体未新增一类能力；本批属于 hosted BrowserWindow 子集扩面 |

剩余风险：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. BrowserWindow：当前仍是 hosted child iframe，不是系统级独立 native BrowserWindow。
3. BrowserWindow menu bar：当前只维护 hosted auto-hide/visible/removed state cache，不等同 Windows/Linux native menu bar、Alt 键唤起、Electron `Menu` object 渲染、accelerator、role item、application menu 或 OS 级菜单事件。
4. WebContents：完整 Chromium WebContents API、跨进程 frame routing、真实 network/cache/session history、native DevTools/print/PDF/capture pipeline 仍未完全还原。

## Batch 244：BrowserWindow hosted background color and WebContents waiting-response bridge

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批继续收口宿主内 browser-window WebContents/BrowserWindow 兼容，补齐 `webContents.isWaitingForResponse()` 和 BrowserWindow `setBackgroundColor(color)` / `getBackgroundColor()`。范围仍限定为当前 PluginPanel hosted child iframe；这里维护的是 hosted loading/background compatibility，不等同完整 Chromium network wait state 或 native window compositor/background behavior。

官方语义依据：

- Electron latest `webContents.isWaitingForResponse()` 用于检查页面是否正在等待主资源的 first response，并返回 boolean。
- Electron latest `BrowserWindow.setBackgroundColor(backgroundColor)` 接受 CSS color 字符串并保持无返回值语义。
- Electron latest `BrowserWindow.getBackgroundColor()` 返回窗口 background color 的 `#RRGGBB` 字符串，alpha 不会随 getter 返回。
- Source: Context7 `/websites/electronjs`, `https://www.electronjs.org/docs/latest/api/web-contents`, `https://www.electronjs.org/docs/latest/api/browser-window`

本批实现：

- `src/components/PluginPanel.svelte`
  - hosted BrowserWindow handle 的 `webContents` 新增 `isWaitingForResponse()`，同步读取当前 hosted child iframe loading cache。
  - hosted BrowserWindow handle 新增 `setBackgroundColor(backgroundColor)` / `getBackgroundColor()`。
  - 注入端新增背景色规范化 helper，覆盖 `#RGB`、`#ARGB`、`#RRGGBB`、`#AARRGGBB`、`rgb()` / `rgba()` 和少量常见命名色，getter 统一返回 `#RRGGBB`。
  - host state 新增 `backgroundColor`，`createPluginBrowserWindow()` 读取 `options.backgroundColor` / `backgroundcolor` 并规范化，`handlePluginBrowserWindowAction()` 支持 `getBackgroundColor` / `setBackgroundColor`。
  - `pluginBrowserWindowStyle()` 把 hosted background color 应用到普通、显式定位、最小化、全屏、最大化和 kiosk 子窗口 shell。
- `src/App.svelte`
  - BrowserWindow Web preview 在 `webContents.loadURL()` promise pending 期间读取 `isWaitingForResponse()`，加载完成后确认回落为 false，并记录 `data-browser-window-webcontents-waiting-response`。
  - BrowserWindow final state smoke 调用 `setBackgroundColor("rgb(16, 32, 48)")` 并确认 `getBackgroundColor() === "#102030"`，记录 `data-browser-window-background-color`。
- `scripts/test-plugin-window-browser-bridge.mjs`
  - 增加 `webContents.isWaitingForResponse`、`getBackgroundColor`、`setBackgroundColor` 方法暴露断言。
  - 增加 `loadURL()` pending/resolved/stop 后 waiting-response 状态断言。
  - 增加默认 `#ffffff`、`rgb(16, 32, 48)` -> `#102030`、setter void-return shape、native bridge route/args 断言。
  - 增加 App smoke 静态覆盖断言，确保 Web preview 实际调用并记录两个新 data attribute。

验证：

- 红灯确认：
  - `pnpm test:plugin-window-browser-bridge` 首次失败在 `browser-window webContents should expose isWaitingForResponse()`。
- 绿灯：
  - `pnpm test:plugin-window-browser-bridge`
  - `pnpm test:plugin-host-view`
  - `pnpm test:plugin-window-page-search`
  - `pnpm test:plugin-window-lifecycle`
- Browser smoke：
  - In-app Browser 打开 `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=244-waiting-background-iab`，页面加载到 hosted BrowserWindow UI；sandboxed iframe content 读取仍受已知限制，因此最终属性断言使用 headless browser automation。
  - 初次 Browser smoke 捕获注入脚本正则转义错误，控制台报 `Invalid regular expression`；随后移除注入端 RGB 正则，改为 split parser。
  - Headless URL：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=244-waiting-background-pw3`
  - recorded `data-browser-window-webcontents-waiting-response="true"`、`data-browser-window-background-color="true"`、`data-browser-window-navigation-history="true"`、`data-browser-window-webcontents-focus-state="true"`、`data-browser-window-webcontents-owner-media="true"`、`data-browser-window-webcontents-crash-reload="true"`、`data-browser-window-webcontents-lifecycle="true"`、`data-browser-window-runtime-state="true"`。
  - console：0 errors，2 existing iframe sandbox warnings。
- Final verification also includes:
  - `pnpm check`
  - `pnpm build`
  - `pnpm smoke:tauri-desktop`
  - 1420 port clear after Web and desktop smoke.

完成度调整：

| 模块 | 之前 | 现在 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 91% | 92% | BrowserWindow hosted `webContents.isWaitingForResponse()` 和 BrowserWindow background color state 可在指定 child iframe handle 上跑通，并纳入 Web preview smoke |
| 插件 runtime parity | 99% | 99% | 顶层 uTools/ZTools runtime 主体未新增一类能力；本批属于 hosted BrowserWindow/WebContents 子集扩面 |

剩余风险：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. BrowserWindow：当前仍是 hosted child iframe，不是系统级独立 native BrowserWindow。
3. WebContents：`isWaitingForResponse()` 只读取 hosted loading/waiting cache，不等同真实 Chromium network first-response tracking 或跨 frame navigation 状态。
4. BrowserWindow background color：当前只维护 hosted shell CSS background 和 `#RRGGBB` getter cache，不等同 native transparent window、alpha compositor、vibrancy 或 OS 级窗口背景合成。

## Batch 243：BrowserWindow hosted WebContents navigationHistory bridge

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批继续收口宿主内 browser-window WebContents 兼容，补齐当前 Electron 推荐替代旧导航 API 的 `webContents.navigationHistory` surface：`canGoBack()`、`canGoForward()`、`goBack()`、`goForward()`、`goToIndex(index)`、`canGoToOffset(offset)`、`goToOffset(offset)`、`clear()`。范围仍限定为当前 PluginPanel hosted child iframe；这里维护的是 hosted history compatibility，不等同完整 Chromium session history。

官方语义依据：

- Electron latest 已把 WebContents 上的 `clearHistory()`、`canGoBack()`、`goBack()`、`canGoForward()`、`goForward()`、`goToIndex()`、`canGoToOffset()`、`goToOffset()` 等旧导航方法标记为 deprecated，并要求使用 `webContents.navigationHistory`。
- `webContents.navigationHistory` 当前包含 `clear()`、`canGoBack()`、`goBack()`、`canGoForward()`、`goForward()`、`canGoToOffset(offset)`、`goToOffset(offset)` 等 navigation history 方法；Electron 教程仍展示 `goToIndex(index)` 路径。
- Source: Context7 `/websites/electronjs`, `https://www.electronjs.org/docs/latest/api/web-contents`

本批实现：

- `src/components/PluginPanel.svelte`
  - hosted BrowserWindow handle 的 `webContents` 新增 `navigationHistory` 对象。
  - `navigationHistory.canGoBack()` / `canGoForward()` 同步读取当前 hosted child iframe history index。
  - `navigationHistory.canGoToOffset(offset)` 同步判断 offset 是否落在当前 hosted history stack 内。
  - `navigationHistory.goBack()` / `goForward()` / `goToIndex(index)` / `goToOffset(offset)` 保持 void-return shape，并路由到 `webContents.navigationHistory.*` host action。
  - `navigationHistory.clear()` 保持 void-return shape，同步折叠 hosted history 到当前 entry，再路由 `webContents.navigationHistory.clear` host action。
  - host helper 新增 `pluginBrowserWindowHistoryIndex()`、`pluginBrowserWindowHistoryOffset()`、`clearPluginBrowserWindowNavigationHistory()`，并把既有 `goBack()` / `goForward()` history helper 收敛到 index-based 路径。
- `src/App.svelte`
  - Web preview `?pluginHostSmoke=browserWindow` 在 focus/owner/media smoke 后调用 `win.webContents.navigationHistory.goToOffset(-1)`、`goForward()`、`clear()`。
  - parent smoke 新增 `data-browser-window-navigation-history`，验证 backward/forward 后 URL 与 can-go 状态同步，并确认 `clear()` 后 back/forward 均不可用。
- `scripts/test-plugin-window-browser-bridge.mjs`
  - 增加 `webContents.navigationHistory` 方法暴露断言。
  - 增加初始 can-go 状态、`loadURL()` 后 history growth、`goToOffset(-1)` / `goForward()` / `goToIndex(0)` / `clear()` void-return shape、同步 can-go cache 和 native bridge route/args 断言。
  - 增加 App smoke 静态覆盖断言，确保 Web preview 会实际调用 navigationHistory 并记录 `data-browser-window-navigation-history`。

验证：

- 红灯确认：
  - `pnpm test:plugin-window-browser-bridge` 首次失败在 `browser-window webContents should expose navigationHistory`。
  - 增加 App smoke 静态断言后再次红灯，失败在 `browser-window smoke should exercise hosted webContents.navigationHistory.goToOffset`。
- 绿灯：
  - `pnpm test:plugin-window-browser-bridge`
  - `pnpm test:plugin-host-view`
  - `pnpm test:plugin-window-page-search`
  - `pnpm test:plugin-window-lifecycle`
  - `pnpm check`
- Browser smoke：
  - In-app Browser 打开 `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=243-navigation-history-iab`，页面加载并显示 hosted BrowserWindow UI；sandboxed iframe attribute 读取受限，且 in-app Browser 自动化命中已知 sandbox iframe `MutationObserver` 限制，因此最终属性断言使用 headless browser automation。
  - Headless URL：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=243-navigation-history-pw`
  - checked 68 BrowserWindow/WebContents attributes with no mismatches。
  - recorded `data-browser-window-navigation-history="true"`，同时 `data-browser-window-webcontents-focus-state="true"`、`data-browser-window-webcontents-owner-media="true"`、`data-browser-window-webcontents-crash-reload="true"`、`data-browser-window-webcontents-lifecycle="true"`、`data-browser-window-runtime-state="true"` 等既有标记保持通过。
  - console：0 errors，2 existing iframe sandbox warnings。
- Final verification also includes:
  - `pnpm build`
  - `pnpm smoke:tauri-desktop`
  - 1420 port clear after Web and desktop smoke.

完成度调整：

| 模块 | 之前 | 现在 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 90% | 91% | BrowserWindow hosted WebContents navigationHistory surface 可在指定 child iframe handle 上跑通，并纳入 Web preview smoke |
| 插件 runtime parity | 99% | 99% | 顶层 uTools/ZTools runtime 主体未新增一类能力；本批属于 hosted BrowserWindow WebContents 子集扩面 |

剩余风险：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. BrowserWindow：当前仍是 hosted child iframe，不是系统级独立 native BrowserWindow。
3. WebContents：`navigationHistory` 只维护当前 hosted child iframe 的本地 history array，不等同完整 Chromium session history；`clear()` 只折叠当前 hosted history，不清理真实 WebView/Chromium 的底层历史或 cache；动作方法通过 async host action 同步到 child iframe，插件侧立即可读的是 hosted cache。

## Batch 242：BrowserWindow hosted WebContents focus/owner/media/shortcut state bridge

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批继续收口宿主内 browser-window WebContents 兼容，补齐 Electron WebContents focus、owner、media source 和 menu shortcut 相关 API：`focus()`、`isFocused()`、`getOwnerBrowserWindow()`、`getMediaSourceId()`、`isBeingCaptured()`、`setIgnoreMenuShortcuts(ignore)`。范围仍限定为当前 PluginPanel hosted child iframe；这里维护的是 hosted state compatibility，不等同真实 native BrowserWindow、Chromium tab capture 或系统级菜单快捷键拦截。

官方语义依据：

- Electron latest `webContents.focus()` focuses the page.
- Electron latest `webContents.isFocused()` returns whether the web page is focused.
- Electron latest `BrowserWindow.fromWebContents(webContents)` returns the owning BrowserWindow or null; hosted bridge uses this owner relationship for `getOwnerBrowserWindow()`.
- Electron latest `webContents.getMediaSourceId()` returns a WebContents capture source id that can be used for tab capture.
- Electron latest `webContents.setIgnoreMenuShortcuts(ignore)` controls whether app menu shortcuts are ignored while this WebContents is focused, and has void-return shape.
- Source: Context7 `/websites/electronjs`, `https://www.electronjs.org/docs/latest/api/web-contents`

本批实现：

- `src/components/PluginPanel.svelte`
  - hosted BrowserWindow handle 的 `webContents` 新增：
    - `focus()`
    - `isFocused()`
    - `getOwnerBrowserWindow()`
    - `getMediaSourceId()`
    - `isBeingCaptured()`
    - `setIgnoreMenuShortcuts(ignore)`
  - bridge 新增 hosted WebContents focus、media source、capture 和 ignore-menu-shortcuts cache。
  - BrowserWindow handle 的 `focus()` / `blur()` / `showInactive()` 通过 shared focus helper 同步 BrowserWindow 与 WebContents focus cache。
  - host action router 新增 `webContents.focus` 和 `webContents.setIgnoreMenuShortcuts`，并记录最后一次 BrowserWindow 消息用于 runtime strip/smoke。
  - hosted child window 创建时生成稳定 `web-contents:<windowSeq>:0` media source id，`isBeingCaptured()` 默认返回 false。
- `src/App.svelte`
  - Web preview `?pluginHostSmoke=browserWindow` 在 crash lifecycle smoke 后调用 `win.webContents.focus()`、`setIgnoreMenuShortcuts(true)`、`isFocused()`、`getOwnerBrowserWindow()`、`getMediaSourceId()`、`isBeingCaptured()`。
  - parent smoke 新增 `data-browser-window-webcontents-focus-state` 和 `data-browser-window-webcontents-owner-media`。
- `scripts/test-plugin-window-browser-bridge.mjs`
  - 增加 WebContents focus/owner/media/shortcut API 方法暴露断言。
  - 增加 `blur()` 后 `isFocused() === false`、`focus()` void-return、sync focus cache、`setIgnoreMenuShortcuts()` void-return、native bridge route/args、owner handle identity、stable media source id、default `isBeingCaptured() === false` 和 App smoke 静态覆盖。

验证：

- 红灯确认：
  - `pnpm test:plugin-window-browser-bridge` 首次失败在 `browser-window webContents should expose focus()`。
  - 增加 App smoke 静态断言后再次红灯，失败在 `browser-window smoke should exercise hosted webContents.focus`。
- 绿灯：
  - `pnpm test:plugin-window-browser-bridge`
  - `pnpm test:plugin-host-view`
  - `pnpm test:plugin-window-page-search`
  - `pnpm test:plugin-window-lifecycle`
  - `pnpm check`
- Browser smoke：
  - In-app Browser 打开 `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=242-webcontents-focus-owner`，页面加载并显示 hosted BrowserWindow UI；sandboxed iframe attribute 读取受限，因此用 headless browser automation 做属性断言。
  - Headless URL：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=242-webcontents-focus-owner-pw`
  - checked 60 BrowserWindow/WebContents attributes with no mismatches。
  - recorded `data-browser-window-webcontents-focus-state="true"`、`data-browser-window-webcontents-owner-media="true"`。
  - prior checks stayed true: render-process-gone、crash/reload recovery、runtime state、navigation/lifecycle、capture/export、selection/scroll、edit、inspect、audio、zoom、DevTools、IPC、find-in-page、CSS injection/removal、always-on-top。
  - console：0 errors，2 existing iframe sandbox warnings。
- Final verification also includes:
  - `pnpm build`
  - `pnpm smoke:tauri-desktop`
  - 1420 port clear after Web and desktop smoke.

完成度调整：

| 模块 | 之前 | 现在 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 89% | 90% | BrowserWindow hosted WebContents focus/owner/media/shortcut state surface 可在指定 child iframe handle 上跑通，并纳入 Web preview smoke |
| 插件 runtime parity | 99% | 99% | 顶层 uTools/ZTools runtime 主体未新增一类能力；本批属于 hosted BrowserWindow WebContents 子集扩面 |

剩余风险：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. BrowserWindow：当前仍是 hosted child iframe，不是系统级独立 native BrowserWindow。
3. WebContents：`focus()` / `isFocused()` 维护 hosted focus cache，不等同 OS 级 native focus；`getMediaSourceId()` 返回 hosted compatibility id，不等同真实 DesktopCapturerSource；`isBeingCaptured()` 不跟踪真实 tab capture；`setIgnoreMenuShortcuts()` 只维护 hosted shortcut state，不接入 native app menu shortcut pipeline。

## Batch 241：BrowserWindow hosted WebContents crash lifecycle bridge

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批继续收口宿主内 browser-window WebContents 兼容，补齐 Electron WebContents crash lifecycle API：`isCrashed()`、`forcefullyCrashRenderer()`，并派发 targeted `render-process-gone` 事件。范围仍限定为当前 PluginPanel hosted child iframe；这里维护的是 hosted crash state compatibility，不会真的崩掉当前 WebView renderer。

官方语义依据：

- Electron latest `webContents.isCrashed()` returns whether the renderer process has crashed.
- Electron latest `webContents.forcefullyCrashRenderer()` forcefully terminates the renderer process and returns void.
- Electron latest `forcefullyCrashRenderer()` emits `render-process-gone` with `reason=killed || reason=crashed`, and calling `reload()` after it recovers in a new process.
- Electron latest `render-process-gone` replaces older crashed renderer events and carries render-process gone details.
- Source: Context7 `/websites/electronjs`, `https://www.electronjs.org/docs/latest/api/web-contents`

本批实现：

- `src/components/PluginPanel.svelte`
  - hosted BrowserWindow handle 的 `webContents` 新增：
    - `isCrashed()`
    - `forcefullyCrashRenderer()`
  - bridge 新增 hosted crash cache；`forcefullyCrashRenderer()` 保持 void-return shape，同步设置 crash cache，并异步路由 `webContents.forcefullyCrashRenderer` 到宿主。
  - host 新增 `crashed` state，创建窗口时默认为 false。
  - host 新增 `forcefullyCrashPluginBrowserWindowRenderer()`，把 hosted child window 标记为 crashed/loading=false，并通过 existing WebContents event helper 派发 targeted `render-process-gone` 事件。
  - `loadURL()` / `reload()` / history navigation 会把 hosted crashed state 恢复为 false。
- `src/App.svelte`
  - Web preview `?pluginHostSmoke=browserWindow` 在 WebContents navigation/lifecycle smoke 后注册 `render-process-gone` listener，调用 `forcefullyCrashRenderer()`，验证 `isCrashed()`，随后 `reload()` 验证 crash state 清理。
  - parent smoke 新增 `data-browser-window-render-process-gone`、`data-browser-window-webcontents-crash`、`data-browser-window-webcontents-crash-reload`。
- `scripts/test-plugin-window-browser-bridge.mjs`
  - 增加 WebContents crash lifecycle API 方法暴露断言。
  - 增加 default `isCrashed() === false`、`forcefullyCrashRenderer()` void-return、sync crash cache、native bridge route/args、targeted `render-process-gone` details 和 App smoke 静态覆盖。

验证：

- 红灯确认：`pnpm test:plugin-window-browser-bridge` 首次失败在 `browser-window webContents should expose isCrashed()`。
- 绿灯：
  - `pnpm test:plugin-window-browser-bridge`
  - `pnpm test:plugin-host-view`
  - `pnpm test:plugin-window-page-search`
  - `pnpm test:plugin-window-lifecycle`
  - `pnpm check`
- Browser smoke：
  - 当前可调用工具未暴露 in-app Browser 控制能力；本批使用 Playwright 类浏览器自动化验证本地页面。
  - URL：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=241-webcontents-crash`
  - checked 58 BrowserWindow/WebContents attributes with no mismatches。
  - recorded `data-browser-window-render-process-gone="true"`、`data-browser-window-webcontents-crash="true"`、`data-browser-window-webcontents-crash-reload="true"`。
  - prior checks stayed true: runtime state、navigation/lifecycle、capture/export、selection/scroll、edit、inspect、audio、zoom、DevTools、navigation、IPC、find-in-page、CSS injection/removal、always-on-top。
  - console：0 errors，2 existing iframe sandbox warnings。
- Final verification also includes:
  - `pnpm build`
  - `pnpm smoke:tauri-desktop`
  - 1420 port clear after Web and desktop smoke.

完成度调整：

| 模块 | 之前 | 现在 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 88% | 89% | BrowserWindow hosted WebContents crash lifecycle surface 可在指定 child iframe handle 上跑通，并纳入 Web preview smoke |
| 插件 runtime parity | 99% | 99% | 顶层 uTools/ZTools runtime 主体未新增一类能力；本批属于 hosted BrowserWindow WebContents 子集扩面 |

剩余风险：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. BrowserWindow：当前仍是 hosted child iframe，不是系统级独立 native BrowserWindow。
3. WebContents：`forcefullyCrashRenderer()` 只维护 hosted crash state 并派发 compatibility event，不会终止真实 Chromium renderer；`render-process-gone` details 固定为 hosted `{ reason: "crashed", exitCode: 1 }`，不等同完整 Electron/Chromium renderer crash semantics。

## Batch 240：BrowserWindow hosted WebContents navigation/lifecycle bridge

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批继续收口宿主内 browser-window WebContents 兼容，补齐 Electron WebContents navigation/lifecycle API：`loadURL(url[, options])`、`reload()`、`stop()`、`isDestroyed()`、`getType()`。范围仍限定为当前 PluginPanel hosted child iframe；`loadURL()` / `reload()` 会更新 hosted iframe 内容、URL/title/history/loading state，`stop()` 只清理 hosted loading state，不伪装真实 Chromium network cancellation 或完整 session history。

官方语义依据：

- Electron latest `webContents.loadURL(url[, options])` loads a URL in the WebContents and returns a Promise after loading completes.
- Electron latest WebContents instance methods include `loadURL`, `stop`, `reload`, `isDestroyed`, and `getType`.
- Electron latest `webContents.stop()` stops current navigation.
- Electron latest `webContents.reload()` reloads current page.
- Electron latest `webContents.isDestroyed()` reports whether the WebContents is destroyed.
- Electron latest `webContents.getType()` reports the WebContents type.
- Source: Context7 `/websites/electronjs`, `https://www.electronjs.org/docs/latest/api/web-contents`

本批实现：

- `src/components/PluginPanel.svelte`
  - hosted BrowserWindow handle 的 `webContents` 新增：
    - `loadURL(url[, options])`
    - `reload()`
    - `stop()`
    - `isDestroyed()`
    - `getType()`
  - `webContents.loadURL()` / `reload()` 复用现有 hosted BrowserWindow URL loading helper，并把 `webContents.loadURL` 纳入 history push 状态同步。
  - `webContents.stop()` 保持 Electron void-return shape，先同步清理 bridge loading cache，再向 host 发出 `webContents.stop` action。
  - host 新增 `stopPluginBrowserWindowLoading()`，把 child window loading state 置为 false，并返回 hosted navigation result。
  - `isDestroyed()` 复用 BrowserWindow handle 的 destroyed state；host closed event 和 `close()` 后都会让 `webContents.isDestroyed()` 返回 true。
  - `getType()` 在当前 hosted child iframe 表面返回 `"window"`。
- `src/App.svelte`
  - Web preview `?pluginHostSmoke=browserWindow` 在 runtime-state smoke 后调用 `win.webContents.loadURL('child-webcontents.html', { userAgent: ... })`、`win.webContents.reload()`、`win.webContents.stop()`。
  - parent smoke 新增 `data-browser-window-webcontents-load-url` 和 `data-browser-window-webcontents-lifecycle`，覆盖 URL sync、reload result、stop void shape、loading clear、`isDestroyed()` 和 `getType()`。
- `scripts/test-plugin-window-browser-bridge.mjs`
  - 增加 WebContents navigation/lifecycle API 方法暴露断言。
  - 增加 `isDestroyed()` 初始 false、closed 后 true、`getType() === "window"` 覆盖。
  - 增加 `webContents.loadURL()` route/args、loading state、history state、URL/title sync 覆盖。
  - 增加 `webContents.reload()` route/result 覆盖。
  - 增加 `webContents.stop()` void-return、sync loading clear 和 host route 覆盖。
  - 增加 App smoke 静态断言，确保 Web preview 真调用这批方法。

验证：

- 红灯确认：`pnpm test:plugin-window-browser-bridge` 首次失败在 `browser-window webContents should expose loadURL()`。
- 绿灯：
  - `pnpm test:plugin-window-browser-bridge`
  - `pnpm test:plugin-host-view`
  - `pnpm test:plugin-window-page-search`
  - `pnpm test:plugin-window-lifecycle`
  - `pnpm check`
- Browser smoke：
  - 当前可调用工具未暴露 in-app Browser 控制能力；本批使用 Playwright 类浏览器自动化验证本地页面。
  - URL：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=240-webcontents-nav-life`
  - checked 44 key attributes with no mismatches。
  - recorded `data-browser-window-webcontents-load-url="true"`、`data-browser-window-webcontents-lifecycle="true"`、`data-browser-window-runtime-state="true"`。
  - prior checks stayed true: capture/export、selection/scroll、edit、inspect、audio、zoom、DevTools、navigation、IPC、find-in-page、CSS injection/removal、always-on-top。
  - console：0 errors，2 existing iframe sandbox warnings。
- Final verification also includes:
  - `pnpm build`
  - `pnpm smoke:tauri-desktop`
  - 1420 port clear after Web and desktop smoke.

完成度调整：

| 模块 | 之前 | 现在 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 87% | 88% | BrowserWindow hosted WebContents navigation/lifecycle surface 可在指定 child iframe handle 上跑通，并纳入 Web preview smoke |
| 插件 runtime parity | 99% | 99% | 顶层 uTools/ZTools runtime 主体未新增一类能力；本批属于 hosted BrowserWindow WebContents 子集扩面 |

剩余风险：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. BrowserWindow：当前仍是 hosted child iframe，不是系统级独立 native BrowserWindow。
3. WebContents：`loadURL()` / `reload()` 更新 hosted iframe 和 hosted history，不等同 Chromium session history；`stop()` 只清理 hosted loading state，不等同真实 Chromium network cancellation；`getType()` 固定为当前 hosted `"window"` 类型，不代表完整 Electron WebContents 类型矩阵。

## Batch 239：BrowserWindow hosted WebContents identity/runtime state bridge

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批继续收口宿主内 browser-window WebContents 兼容，补齐 Electron WebContents identity/runtime state API：`getUserAgent()`、`setUserAgent(userAgent)`、`getFrameRate()`、`setFrameRate(fps)`、`getBackgroundThrottling()`、`setBackgroundThrottling(allowed)`、`getProcessId()`、`getOSProcessId()`。范围仍限定为当前 PluginPanel hosted child iframe；这里的 process id 是 hosted compatibility id，不伪装真实 Electron renderer 或 OS process。

官方语义依据：

- Electron latest `webContents.getUserAgent()` returns the user agent for this web page。
- Electron latest `webContents.setUserAgent(userAgent)` overrides the user agent for this web page。
- Electron latest `webContents.getFrameRate()` / `setFrameRate(rate)` 读写 WebContents frame rate。
- Electron latest `webContents.getBackgroundThrottling()` / `setBackgroundThrottling(allowed)` 读写 background throttling 状态。
- Electron latest `webContents.getProcessId()` / `getOSProcessId()` 返回 WebContents process identity。
- Source: Context7 `/websites/electronjs`, `https://www.electronjs.org/docs/latest/api/web-contents`

本批实现：

- `src/components/PluginPanel.svelte`
  - hosted BrowserWindow handle 的 `webContents` 新增：
    - `getUserAgent()` / `setUserAgent(userAgent)`
    - `getFrameRate()` / `setFrameRate(fps)`
    - `getBackgroundThrottling()` / `setBackgroundThrottling(allowed)`
    - `getProcessId()` / `getOSProcessId()`
  - bridge 新增 runtime state cache：user agent、frame rate、background throttling、hosted process id、hosted OS process id。
  - setter 保持 Electron void-return shape，先同步更新 getter cache，再异步路由 `webContents.setUserAgent` / `webContents.setFrameRate` / `webContents.setBackgroundThrottling` 到宿主。
  - host 新增 runtime state helper 和 action route：`updatePluginBrowserWindowUserAgent()`、`updatePluginBrowserWindowFrameRate()`、`updatePluginBrowserWindowBackgroundThrottling()`。
- `src/App.svelte`
  - Web preview `?pluginHostSmoke=browserWindow` 在 page export smoke 后调用 runtime state API。
  - parent smoke 记录 `data-browser-window-runtime-state`，覆盖 setter void shape、sync getter 更新、positive hosted process IDs。
- `scripts/test-plugin-window-browser-bridge.mjs`
  - 增加 WebContents identity/runtime API 方法暴露断言。
  - 增加 default value、positive process id、setter route/args、void-return shape 和 sync getter 更新覆盖。
  - 增加宿主静态断言：三个 host update helper、三条 action route 和 App smoke 调用。

验证：

- 红灯确认：`pnpm test:plugin-window-browser-bridge` 首次失败在 `browser-window webContents should expose getUserAgent()`。
- 绿灯：
  - `pnpm test:plugin-window-browser-bridge`
  - `pnpm test:plugin-host-view`
  - `pnpm test:plugin-window-page-search`
  - `pnpm test:plugin-window-lifecycle`
  - `pnpm check`
- Browser smoke：
  - 当前可调用工具未暴露 in-app Browser 控制能力；本批使用 Playwright 类浏览器自动化验证本地页面。
  - URL：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=239-runtime-state`
  - recorded `data-browser-window-runtime-state="true"`。
  - prior checks stayed true: capture/export、selection/scroll、edit、inspect、audio、zoom、DevTools、navigation、IPC、find-in-page、CSS injection/removal、always-on-top。
  - console：0 errors，2 existing iframe sandbox warnings。
- Final verification also includes:
  - `pnpm build`
  - `pnpm smoke:tauri-desktop`

完成度调整：

| 模块 | 之前 | 现在 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 86% | 87% | BrowserWindow hosted WebContents identity/runtime state bridge 可在指定 child iframe handle 上跑通 |
| 插件 runtime parity | 99% | 99% | 顶层 uTools/ZTools runtime 主体未新增一类能力；本批属于 hosted BrowserWindow WebContents 子集扩面 |

剩余风险：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. BrowserWindow：当前仍是 hosted child iframe，不是系统级独立 native BrowserWindow。
3. WebContents：process ids 是 hosted compatibility ids；不等同真实 Electron renderer process id、OS process id、Chromium frame routing 或完整 WebContents API。

## Batch 238：BrowserWindow hosted WebContents page capture/export bridge

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批继续收口宿主内 browser-window WebContents 兼容，补齐 Electron WebContents page capture/export API：`capturePage([rect, opts])`、`print([options], [callback])`、`printToPDF(options)`、`savePage(fullPath, saveType)`。范围仍限定为当前 PluginPanel hosted child iframe；这里维护的是 hosted snapshot/PDF/save serialization compatibility，不伪装 Chromium raster capture、系统打印或完整 PDF pipeline。

官方语义依据：

- Electron latest `webContents.capturePage([rect, opts])` captures a snapshot of the page or rect and resolves `Promise<NativeImage>`。
- Electron latest `webContents.print([options], [callback])` returns void and invokes callback with `(success, failureReason)`。
- Electron latest `webContents.printToPDF(options)` prints the page as PDF and resolves `Promise<Buffer>`。
- Electron latest `webContents.savePage(fullPath, saveType)` accepts `HTMLOnly` / `HTMLComplete` / `MHTML` and resolves `Promise<void>` on success。
- Source: Context7 `/websites/electronjs`, `https://www.electronjs.org/docs/latest/api/web-contents`

本批实现：

- `src/components/PluginPanel.svelte`
  - hosted BrowserWindow handle 的 `webContents` 新增：
    - `capturePage(rect?, opts?)`
    - `print(options?, callback?)`
    - `printToPDF(options?)`
    - `savePage(fullPath, saveType)`
  - bridge 新增 NativeImage-compatible capture result wrapper：`toDataURL()`、`toPNG()`、`getSize()`、`getAspectRatio()`、`isEmpty()`。
  - bridge 新增 Buffer-compatible byte normalization，`printToPDF()` 在无 Node Buffer 的 iframe 环境下返回 `Uint8Array`。
  - host 新增 `capturePluginBrowserWindowPage()`、`printPluginBrowserWindowPage()`、`printPluginBrowserWindowToPdf()`、`savePluginBrowserWindowPage()`：
    - `capturePage()` 等待 child iframe ready 后根据 rect 生成 deterministic SVG snapshot data URL。
    - `print()` 保持 Electron void-return shape，并通过 callback 返回 `success:false` + 明确 hosted native-only failure reason。
    - `printToPDF()` 从 child iframe title/text 生成 minimal PDF byte stream。
    - `savePage()` 校验 `HTMLOnly` / `HTMLComplete` / `MHTML`，序列化当前 child iframe document；Tauri runtime 下用 `writeTextFile()` 写入允许 scope，Web preview 下只验证序列化路径和 Promise shape。
- `src/App.svelte`
  - Web preview `?pluginHostSmoke=browserWindow` 在 DevTools/inspect smoke 后调用 `capturePage()`、`print()`、`printToPDF()`、`savePage()`。
  - parent smoke 记录 `data-browser-window-capture-page`、`data-browser-window-print`、`data-browser-window-print-to-pdf`、`data-browser-window-save-page`。
- `scripts/test-plugin-window-browser-bridge.mjs`
  - 增加 WebContents capture/export API 方法暴露断言。
  - 增加 route/args、NativeImage-compatible object、print callback failure shape、PDF byte data 和 savePage Promise void 覆盖。
  - 增加宿主静态断言：capture/print/save helper、四个 action route 和 App smoke 调用。

验证：

- 红灯确认：`pnpm test:plugin-window-browser-bridge` 首次失败在 `browser-window webContents should expose capturePage()`。
- 绿灯：
  - `pnpm test:plugin-window-browser-bridge`
  - `pnpm test:plugin-host-view`
  - `pnpm test:plugin-window-page-search`
  - `pnpm test:plugin-window-lifecycle`
  - `pnpm check`
- Browser smoke：
  - 当前可调用工具未暴露 in-app Browser 控制能力；本批使用 Playwright CLI 验证本地页面。
  - URL：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=238-capture-export`
  - recorded `data-browser-window-capture-page="true"`、`data-browser-window-print="true"`、`data-browser-window-print-to-pdf="true"`、`data-browser-window-save-page="true"`。
  - prior checks stayed true: selection/scroll、edit、inspect、audio、zoom、DevTools、navigation、IPC、find-in-page、CSS injection/removal、always-on-top。
  - console：0 errors，2 existing iframe sandbox warnings。
- Final verification also includes:
  - `pnpm build`
  - `pnpm smoke:tauri-desktop`

完成度调整：

| 模块 | 之前 | 现在 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 85% | 86% | BrowserWindow hosted WebContents page capture/export bridge 可在指定 child iframe 上跑通 |
| 插件 runtime parity | 99% | 99% | 顶层 uTools/ZTools runtime 主体未新增一类能力；本批属于 hosted BrowserWindow WebContents 子集扩面 |

剩余风险：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. BrowserWindow：当前仍是 hosted child iframe，不是系统级独立 native BrowserWindow。
3. WebContents：capture 是 hosted SVG snapshot，`printToPDF()` 是 minimal PDF compatibility output，`print()` 无 native printer，只返回明确 failure；不等同 Chromium raster capture、系统打印或完整 Chromium PDF pipeline。

## Batch 237：BrowserWindow hosted WebContents selection and scroll bridge

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批继续收口宿主内 browser-window WebContents 兼容，补齐 Electron WebContents selection/scroll API：`centerSelection()`、`scrollToTop()`、`scrollToBottom()`、`adjustSelection(options)`。范围仍限定为当前 PluginPanel hosted child iframe；这里维护的是 child iframe DOM scroll 和 focused editable selection 的兼容路径，不伪装 Chromium 完整 selection pipeline、native scroll integration 或跨进程 frame routing。

官方语义依据：

- Electron latest `webContents.centerSelection()` centers the current text selection in the web page。
- Electron latest `webContents.scrollToTop()` / `scrollToBottom()` scroll current `webContents` to top/bottom。
- Electron latest `webContents.adjustSelection(options)` 使用 `start` / `end` 数值调整 focused frame 当前文本选区起止点；文档未声明返回值，当前 bridge 按 void-return shape 处理。
- Source: Context7 `/websites/electronjs`, `https://www.electronjs.org/docs/latest/api/web-contents`

本批实现：

- `src/components/PluginPanel.svelte`
  - hosted BrowserWindow handle 的 `webContents` 新增：
    - `centerSelection()`
    - `scrollToTop()`
    - `scrollToBottom()`
    - `adjustSelection(options)`
  - bridge 复用 void-return action 路由；`adjustSelection()` 规范化 `{ start, end }` 为数值后传给 `browserWindowAction: webContents.adjustSelection`。
  - host 新增 `controlPluginBrowserWindowSelection()`，等待目标 child iframe ready 后执行具体控制：
    - `scrollToTop()` / `scrollToBottom()` 更新 child iframe document scrolling element。
    - `centerSelection()` 对当前 editable target 调用 `scrollIntoView({ block: "center" })`，否则按 DOM selection range 计算居中滚动。
    - `adjustSelection()` 对 input/textarea selection range 做 delta 调整；contenteditable 通过浏览器 `Selection.modify` best-effort。
- `src/App.svelte`
  - Web preview `?pluginHostSmoke=browserWindow` 在编辑命令 smoke 后，设置 child iframe 可滚动内容、选中 input 文本，依次调用 `centerSelection()`、`adjustSelection({ start: 1, end: -1 })`、`scrollToBottom()`、`scrollToTop()`。
  - parent smoke 读取 child iframe selection range 和 scrollTop，记录 `data-browser-window-selection-scroll-commands`、`data-browser-window-adjust-selection`、`data-browser-window-scroll-top`。
- `scripts/test-plugin-window-browser-bridge.mjs`
  - 增加 WebContents selection/scroll API 方法暴露断言。
  - 增加 void-return、native bridge route/args、`adjustSelection({ start, end })` payload shape 覆盖。
  - 增加宿主静态断言：`controlPluginBrowserWindowSelection()` helper、四个 action route 和 App smoke 调用。

验证：

- 红灯确认：`pnpm test:plugin-window-browser-bridge` 首次失败在 `browser-window webContents should expose centerSelection()`。
- 绿灯：
  - `pnpm test:plugin-window-browser-bridge`
  - `pnpm test:plugin-host-view`
  - `pnpm test:plugin-window-page-search`
  - `pnpm test:plugin-window-lifecycle`
  - `pnpm check`
- Browser smoke：
  - 当前可调用工具未暴露 in-app Browser 控制能力；本批使用 Playwright CLI 验证本地页面。
  - URL：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=237-selection-scroll`
  - recorded `data-browser-window-selection-scroll-commands="true"`、`data-browser-window-adjust-selection="true"`、`data-browser-window-scroll-top="true"`。
  - prior checks stayed true: `data-browser-window-insert-text="true"`、`data-browser-window-edit-commands="true"`、`data-browser-window-edit-value="true"`、`data-browser-window-inspect-element="true"`、`data-browser-window-audio-initial="true"`、`data-browser-window-audio-muted="true"`、`data-browser-window-audio-unmuted="true"`、`data-browser-window-zoom-factor="true"`、`data-browser-window-zoom-level="true"`、`data-browser-window-visual-zoom-limits="true"`、`data-browser-window-devtools-close="true"`、`data-browser-window-always-on-top="true"`。
  - child frame style retained hosted zoom transform: computed transform `matrix(0.833333, 0, 0, 0.833333, 0, 0)`。
  - console：0 errors，2 existing iframe sandbox warnings。
- Final verification also includes:
  - `pnpm build`
  - `pnpm smoke:tauri-desktop`

完成度调整：

| 模块 | 之前 | 现在 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 84% | 85% | BrowserWindow hosted WebContents selection/scroll bridge 可在指定 child iframe 上跑通 |
| 插件 runtime parity | 99% | 99% | 顶层 uTools/ZTools runtime 主体未新增一类能力；本批属于 hosted BrowserWindow WebContents 子集扩面 |

剩余风险：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. BrowserWindow：当前仍是 hosted child iframe，不是系统级独立 native BrowserWindow。
3. WebContents：selection/scroll commands 只覆盖 child iframe DOM scroll 和 focused editable selection，不等同 Chromium 完整 selection pipeline、native scroll integration 或跨进程 frame routing。

## Batch 236：BrowserWindow hosted WebContents edit command bridge

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批继续收口宿主内 browser-window WebContents 兼容，补齐 Electron WebContents editing API：`insertText(text)` 以及 `undo()` / `redo()` / `cut()` / `copy()` / `paste()` / `pasteAndMatchStyle()` / `delete()` / `selectAll()` / `unselect()` / `replace(text)` / `replaceMisspelling(text)`。范围仍限定为当前 PluginPanel hosted child iframe；这里维护的是 focused editable target 的兼容编辑路径，不伪装 Chromium 完整编辑栈、系统剪贴板、IME、spellchecker 或真实 undo history。

官方语义依据：

- Electron latest `webContents` 文档列出这些 editing command 方法；`insertText(text)` 返回 `Promise<void>` 并向 focused element 插入文本。
- `undo` / `redo` / `cut` / `copy` / `paste` / `pasteAndMatchStyle` / `delete` / `selectAll` / `unselect` / `replace` / `replaceMisspelling` 为页面 editing command；文档未声明返回值，当前 bridge 按 Electron void-return shape 处理。
- Source: https://www.electronjs.org/docs/latest/api/web-contents

本批实现：

- `src/components/PluginPanel.svelte`
  - hosted BrowserWindow handle 的 `webContents` 新增：
    - `insertText(text)`
    - `undo()` / `redo()` / `cut()` / `copy()` / `paste()` / `pasteAndMatchStyle()` / `delete()` / `selectAll()` / `unselect()`
    - `replace(text)` / `replaceMisspelling(text)`
  - bridge 新增 `webContentsInsertText()` 和 `webContentsEditAction()`；`insertText()` 通过 `browserWindowAction: webContents.insertText` 返回 Promise 并 resolve `undefined`，其余编辑命令同步返回 `undefined` 并异步路由到 host action。
  - host action 新增 focused editable target 解析，支持 `input` / `textarea` / `contenteditable` 的插入、选择、删除和替换；`copy` / `cut` / `paste` 使用 `pluginBrowserWindowEditClipboard` hosted 本地 edit clipboard。
  - `undo` / `redo` 仅在当前 child iframe 文档上走 best-effort `document.execCommand("undo" | "redo")`，不承诺 Chromium 原生 undo stack。
- `src/App.svelte`
  - Web preview `?pluginHostSmoke=browserWindow` 的 child srcdoc 增加 `browser-window-edit-target` input。
  - parent smoke 在 `executeJavaScript()` 后聚焦 child input，调用 `insertText("hosted edit")`，再验证 `selectAll()` / `copy()` / `cut()` / `paste()` void-return shape 和最终 child input value。
- `scripts/test-plugin-window-browser-bridge.mjs`
  - 增加 WebContents editing API 方法暴露断言。
  - 增加 `insertText("typed text")` Promise void result、native bridge route/args 覆盖。
  - 增加 `undo` / `redo` / `cut` / `copy` / `paste` / `pasteAndMatchStyle` / `delete` / `selectAll` / `unselect` / `replace` / `replaceMisspelling` void-return 和 route/args 覆盖。
  - 增加宿主静态断言：`editPluginBrowserWindowText()` helper、`webContents.insertText` / `selectAll` / `replaceMisspelling` route、App smoke 调用和 editable target fixture。

验证：

- 红灯确认：`pnpm test:plugin-window-browser-bridge` 首次失败在 `browser-window webContents should expose insertText()`。
- 绿灯：
  - `pnpm test:plugin-window-browser-bridge`
  - `pnpm test:plugin-host-view`
  - `pnpm test:plugin-window-page-search`
  - `pnpm test:plugin-window-lifecycle`
  - `pnpm check`
- Browser smoke：
  - in-app Browser 在本地 URL 上仍返回 crash/policy 页面后，改用独立 Playwright 验证同一 URL。
  - URL：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=236-edit2`
  - recorded `data-browser-window-insert-text="true"`、`data-browser-window-edit-commands="true"`、`data-browser-window-edit-value="true"`。
  - prior checks stayed true: `data-browser-window-inspect-element="true"`、`data-browser-window-audio-initial="true"`、`data-browser-window-audio-muted="true"`、`data-browser-window-audio-unmuted="true"`、`data-browser-window-zoom-factor="true"`、`data-browser-window-zoom-level="true"`、`data-browser-window-visual-zoom-limits="true"`、`data-browser-window-devtools-close="true"`、`data-browser-window-always-on-top="true"`。
  - child frame style retained hosted zoom transform: computed transform `matrix(0.833333, 0, 0, 0.833333, 0, 0)`。
  - console：0 errors，2 existing iframe sandbox warnings。
- Final verification also includes:
  - `pnpm build`
  - `pnpm smoke:tauri-desktop`

完成度调整：

| 模块 | 之前 | 现在 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 83% | 84% | BrowserWindow hosted WebContents editing command bridge 可在指定 child iframe focused editable target 上跑通 |
| 插件 runtime parity | 99% | 99% | 顶层 uTools/ZTools runtime 主体未新增一类能力；本批属于 hosted BrowserWindow WebContents 子集扩面 |

剩余风险：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. BrowserWindow：当前仍是 hosted child iframe，不是系统级独立 native BrowserWindow。
3. WebContents：editing commands 只覆盖 focused hosted editable target，不等同 Chromium 完整 editing stack、系统剪贴板、IME、spellchecker 或真实 undo/redo history。

## Batch 235：BrowserWindow hosted WebContents inspectElement bridge

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批继续收口宿主内 browser-window WebContents 兼容，补齐 Electron WebContents DevTools-adjacent API：`inspectElement(x, y)`。范围仍限定为当前 PluginPanel hosted child iframe；这里维护的是宿主内 DevTools open/focus 兼容状态和目标元素摘要，不伪装真实 Chromium DevTools inspect UI、dock window、protocol attachment 或 native independent BrowserWindow。

官方语义依据：

- Electron `webContents.inspectElement(x, y)` 在指定屏幕坐标开始检查元素。
- Electron 文档未声明返回值；当前 bridge 按 void-return shape 处理，和 `setZoomFactor()` / `setAudioMuted()` 这类同步 setter 保持一致。

本批实现：

- `src/components/PluginPanel.svelte`
  - hosted BrowserWindow handle 的 `webContents` 新增 `inspectElement(x, y)`。
  - bridge 新增 coordinate normalization 和 `webContentsInspectElement()`；调用时同步设置 `webContentsDevToolsOpened=true`、`webContentsDevToolsFocused=true`，异步发送 `browserWindowAction: webContents.inspectElement`，返回值保持 `undefined`。
  - `PluginBrowserWindowState` 新增 `inspectedElement`；host action 会等待目标 child iframe ready，调用 `elementFromPoint(x, y)` 获取目标 DOM 元素，并记录 `{ x, y, tagName, id, className, text }` 摘要。
  - host 返回包含 `devToolsOpened` / `devToolsFocused` / `devToolsMode` / `devToolsTitle` / `inspectedElement` 的结果，并在原本未打开 DevTools 时派发 targeted `devtools-opened` 事件。
- `src/App.svelte`
  - Web preview `?pluginHostSmoke=browserWindow` 在 DevTools close 后增加 `inspectElement(12, 8)` smoke：验证 void-return shape，并验证 `isDevToolsOpened()` / `isDevToolsFocused()` 同步读取 true。
- `scripts/test-plugin-window-browser-bridge.mjs`
  - 增加 WebContents `inspectElement()` 方法暴露断言。
  - 增加 `inspectElement(12, 8)` void-return、native bridge action args、DevTools open/focus sync cache 和 host response cache 更新覆盖。
  - 增加宿主静态断言：`inspectedElement` state、`inspectPluginBrowserWindowElement()` helper、`webContents.inspectElement` route 和 App smoke 调用。

验证：

- 红灯确认：`pnpm test:plugin-window-browser-bridge` 首次失败在 `browser-window webContents should expose inspectElement()`。
- 绿灯：
  - `pnpm test:plugin-window-browser-bridge`
  - `pnpm test:plugin-host-view`
  - `pnpm test:plugin-window-page-search`
  - `pnpm test:plugin-window-lifecycle`
  - `pnpm check`
- Browser smoke：
  - in-app Browser 在本地 URL 上仍返回 crash/policy 页面后，改用独立 Playwright 验证同一 URL。
  - URL：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=235-inspect`
  - recorded `data-browser-window-inspect-element="true"`。
  - prior checks stayed true: `data-browser-window-audio-initial="true"`、`data-browser-window-audio-muted="true"`、`data-browser-window-audio-unmuted="true"`、`data-browser-window-zoom-factor="true"`、`data-browser-window-zoom-level="true"`、`data-browser-window-visual-zoom-limits="true"`、`data-browser-window-devtools-close="true"`、`data-browser-window-always-on-top="true"`。
  - child frame style retained hosted zoom transform: computed transform `matrix(0.833333, 0, 0, 0.833333, 0, 0)`。
  - console：0 errors，2 existing iframe sandbox warnings。
- Port hygiene：最终 `lsof -nP -iTCP:1420 -sTCP:LISTEN` 无监听。

完成度调整：

| 模块 | 之前 | 现在 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 82% | 83% | BrowserWindow hosted WebContents inspectElement bridge 可在指定 child iframe handle 上跑通 |
| 插件 runtime parity | 99% | 99% | 顶层 uTools/ZTools runtime 主体未新增一类能力；本批属于 hosted BrowserWindow WebContents 子集扩面 |

剩余风险：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. BrowserWindow：当前仍是 hosted child iframe，不是系统级独立 native BrowserWindow。
3. WebContents：`inspectElement()` 只维护 hosted DevTools state 和 DOM element summary，不等同真实 Chromium DevTools inspect UI、protocol attachment、元素高亮 overlay 或 native independent window。

## Batch 234：BrowserWindow hosted WebContents audio state bridge

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批继续收口宿主内 browser-window WebContents 兼容，补齐 Electron WebContents 常用 audio state API：`setAudioMuted(muted)`、`isAudioMuted()`、`isCurrentlyAudible()`，并支持 targeted `audio-state-changed` 事件。范围仍限定为当前 PluginPanel hosted child iframe；这里维护的是宿主内 muted/audible 兼容状态，不伪装 Chromium 完整媒体播放、音频输出、tab audio indicator 或跨 frame/native media audibility pipeline。

官方语义依据：

- Electron `webContents.setAudioMuted(muted)` muted 参数为 boolean，返回 void。
- Electron `webContents.isAudioMuted()` 同步返回当前页面是否 muted。
- Electron `webContents.isCurrentlyAudible()` 同步返回当前页面是否正在 audible。
- Electron `audio-state-changed` 在媒体变为 audible/inaudible 时触发；当前 hosted bridge 同步提供 `event.audible` 和 boolean listener argument。

本批实现：

- `src/components/PluginPanel.svelte`
  - hosted BrowserWindow handle 的 `webContents` 新增：
    - `setAudioMuted(muted)`
    - `isAudioMuted()`
    - `isCurrentlyAudible()`
  - bridge cache 新增 `webContentsAudioMuted` / `webContentsCurrentlyAudible`；`setAudioMuted()` 保持 Electron void-return shape，调用时同步更新 muted getter，muted 后立即清空 audible cache，并异步路由 host action。
  - targeted `audio-state-changed` 事件进入父插件 iframe 时同步 audible cache，listener event 带 `event.audible`。
  - hosted child-window state 新增 `audioMuted` / `currentlyAudible`；host action `webContents.setAudioMuted` 更新状态并在 audible 变化时派发 targeted `audio-state-changed`。
- `src/App.svelte`
  - Web preview `?pluginHostSmoke=browserWindow` 在 DevTools/zoom path 之间增加 audio smoke：验证初始 muted/audible false、`setAudioMuted(true)` void shape 与 sync getter、`setAudioMuted(false)` void shape 与 sync getter。
- `scripts/test-plugin-window-browser-bridge.mjs`
  - 增加 WebContents audio 方法暴露断言。
  - 增加 `audio-state-changed` targeted event VM 覆盖，验证 `event.sender`、`event.audible`、boolean argument 和 `isCurrentlyAudible()` cache。
  - 增加 `setAudioMuted(true/false)` void-return、native bridge action、host response cache 更新和 App smoke 静态覆盖断言。

验证：

- 红灯确认：`pnpm test:plugin-window-browser-bridge` 首次失败在 `browser-window webContents should expose setAudioMuted()`。
- 绿灯：
  - `pnpm test:plugin-window-browser-bridge`
  - `pnpm test:plugin-host-view`
  - `pnpm test:plugin-window-page-search`
  - `pnpm test:plugin-window-lifecycle`
  - `pnpm check`
  - `pnpm build`
  - `pnpm smoke:tauri-desktop`
- Browser smoke：
  - in-app Browser 在本地 URL 上返回 crash/policy 页面后，改用独立 Playwright 验证同一 URL。
  - URL：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=234-audio`
  - recorded `data-browser-window-audio-initial="true"`、`data-browser-window-audio-muted="true"`、`data-browser-window-audio-unmuted="true"`。
  - prior checks stayed true: `data-browser-window-zoom-factor="true"`、`data-browser-window-zoom-level="true"`、`data-browser-window-visual-zoom-limits="true"`、`data-browser-window-devtools-close="true"`、`data-browser-window-always-on-top="true"`。
  - child frame style retained hosted zoom transform: `transform: scale(0.833333); transform-origin: 0px 0px; width: 120%; height: 120%;` and computed transform `matrix(0.833333, 0, 0, 0.833333, 0, 0)`。
  - console：0 errors，2 existing iframe sandbox warnings。
- Desktop smoke：
  - `Desktop smoke passed: 127.0.0.1:53854`
  - smoke JSON `status:"ok"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`agent_tools_count:8`，plugin runtime/system/data/permission smoke `error:null`。
  - 退出阶段仍有既有 Vite EPIPE / closed-server 日志，命令退出码 0。
- Port hygiene：最终 `lsof -nP -iTCP:1420 -sTCP:LISTEN` 无监听。

完成度调整：

| 模块 | 之前 | 现在 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 81% | 82% | BrowserWindow hosted WebContents audio muted/audible state bridge 可在指定 child iframe handle 上跑通 |
| 插件 runtime parity | 99% | 99% | 顶层 uTools/ZTools runtime 主体未新增一类能力；本批属于 hosted BrowserWindow WebContents 子集扩面 |

剩余风险：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. BrowserWindow：当前仍是 hosted child iframe，不是系统级独立 native BrowserWindow。
3. WebContents：audio state 只维护 hosted muted/audible cache 和事件兼容，不等同 Chromium 完整媒体播放/audibility 检测、tab audio indicator 或跨 frame/native media pipeline。
4. Browser 验证：in-app Browser 本批在本地 URL 上返回 crash/policy 页面；已用独立 Playwright 完成同等本地 smoke。
5. 真实第三方插件、SPA/router 运行态、native 右键菜单、拖拽和更复杂 iframe 交互仍需专项回归。

## Batch 233：BrowserWindow hosted WebContents zoom state bridge

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批继续收口宿主内 browser-window WebContents 兼容，补齐 Electron WebContents 常用 zoom 状态 API：`setZoomFactor(factor)`、`getZoomFactor()`、`setZoomLevel(level)`、`getZoomLevel()`、`setVisualZoomLevelLimits(minimumLevel, maximumLevel)`。范围仍限定为当前 PluginPanel hosted child iframe；这里维护的是宿主内 zoom 兼容状态和 CSS scale 呈现，不伪装 Chromium 的完整 page zoom、pinch zoom、跨 frame zoom propagation 或 native independent BrowserWindow。

### 背景和依据

- Electron `webContents.setZoomFactor(factor)` 要求 factor 大于 0，返回 void；`getZoomFactor()` 同步返回当前 factor。
- Electron `webContents.setZoomLevel(level)` 返回 void，level 到 factor 的关系是 `scale := 1.2 ^ level`；`getZoomLevel()` 同步返回当前 level。
- Electron `webContents.setVisualZoomLevelLimits(minimumLevel, maximumLevel)` 返回 `Promise<void>`，用于设置 pinch visual zoom limits。
- 当前 hosted BrowserWindow 已覆盖父子 IPC、脚本执行、输入事件、CSS、page search、hosted history 和 DevTools state，但 zoom 仍在剩余 WebContents 缺口内。

### 实现

- `PluginBrowserWindowState` 新增 `zoomFactor`、`zoomLevel`、`visualZoomMinimumLevel`、`visualZoomMaximumLevel`。
- 注入桥在 `_createBrowserWindowHandle()` 中维护 WebContents zoom cache，新增：
  - `setZoomFactor(factor)`
  - `getZoomFactor()`
  - `setZoomLevel(level)`
  - `getZoomLevel()`
  - `setVisualZoomLevelLimits(minimumLevel, maximumLevel)`
- `setZoomFactor()` / `setZoomLevel()` 保持 Electron void-return shape：调用时同步更新插件侧 getter cache，同时异步路由到 host；host response 到达后再对齐 cache。
- PluginPanel host 增加 `updatePluginBrowserWindowZoomFactor()`、`updatePluginBrowserWindowZoomLevel()` 和 `updatePluginBrowserWindowVisualZoomLimits()`，并按 Electron `1.2 ^ level` 关系维护 factor/level。
- `pluginBrowserWindowFrameStyle()` 将当前 hosted zoom factor 渲染为 child iframe `transform: scale(...)`、反向宽高百分比和 `transform-origin: 0 0`。
- Web preview 的 `?pluginHostSmoke=browserWindow` 增加 zoom 状态路径：`setZoomFactor(1.5)` -> sync getter check -> `setZoomLevel(-1)` -> sync getter check -> `setVisualZoomLevelLimits(0.5, 3)`，并验证最终 child iframe transform。

### TDD 和测试

- 扩展 `scripts/test-plugin-window-browser-bridge.mjs`：
  - 要求 BrowserWindow `webContents` 暴露 zoom 五个方法。
  - 验证初始 `getZoomFactor() === 1`、`getZoomLevel() === 0`。
  - 验证 `setZoomFactor()` / `setZoomLevel()` 保持 void-return shape，并分别经 native bridge 发送 action `webContents.setZoomFactor` / `webContents.setZoomLevel`。
  - 验证 async host response 后 sync getter cache 更新。
  - 验证 `setVisualZoomLevelLimits()` 经 native bridge 发送 action，并按 Electron 语义 resolve `undefined`。
  - 增加静态断言，要求 Web preview smoke 调用新增 zoom 方法并读取 sync state。
- 初次红灯：`pnpm test:plugin-window-browser-bridge` 失败在 `browser-window webContents should expose setZoomFactor()`。
- 实现后目标测试转绿。
- 最终脚本验证：
  - `pnpm test:plugin-window-browser-bridge`
  - `pnpm test:plugin-host-view`
  - `pnpm test:plugin-window-page-search`
  - `pnpm test:plugin-window-lifecycle`
  - `pnpm check`
  - `pnpm build` 通过，仅保留既有 Vite chunk size warning。
  - `pnpm smoke:tauri-desktop` 通过，输出 `Desktop smoke passed: 127.0.0.1:51647`，权限、数据调试、系统设置、插件 runtime、本地应用搜索均为 `error:null`；退出阶段仍有既有 Vite dev server `EPIPE` 停服日志但命令退出码为 0。
- Browser 检查：in-app Browser 打开 `http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=233-zoom-iab`，宿主 DOM 中 child iframe 最终 style 为 `transform: scale(0.833333); transform-origin: 0px 0px; width: 120%; height: 120%;`。
- 独立 Playwright 检查：`http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=233-zoom-void` 中父 iframe body 包含 `data-browser-window-zoom-factor="true"`、`data-browser-window-zoom-level="true"`、`data-browser-window-visual-zoom-limits="true"`；child iframe transform 为 `matrix(0.833333, 0, 0, 0.833333, 0, 0)`。console 为 0 errors，仅有既有 iframe sandbox warnings。

### 完成度调整

| 模块 | Before | After | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 80% | 81% | BrowserWindow hosted WebContents zoom state bridge 可在指定 child iframe handle 上跑通 |
| 插件 runtime parity | 99% | 99% | 本批增强宿主 WebContents 兼容面，但不新增 native runtime 能力总类 |
| 测试与发布 | 99% | 99% | 覆盖继续加深，但签名、公证、自动更新仍未完成 |

### 剩余风险

1. Zoom：当前是 hosted iframe zoom factor state 和 CSS scale，不等同 Chromium 的完整 page zoom、pinch zoom、跨 frame zoom propagation、DPI-aware layout 或 native WebContents zoom pipeline。
2. WebContents 覆盖：仍不是完整 Electron WebContents；isolated world、页面 capture、打印、跨进程 frame routing、before-input-event、真实 cache 策略等仍未接入。
3. 插件生态：仍未跑真实第三方 ZTools/uTools 插件矩阵；SPA/router 插件、复杂 preload、native 菜单和独立窗口生命周期仍是高风险。

## Batch 232：BrowserWindow hosted WebContents DevTools state bridge

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批继续收口宿主内 browser-window WebContents 兼容，补齐 Electron WebContents 常用 DevTools 状态 API：`openDevTools(options)`、`closeDevTools()`、`toggleDevTools()`、`isDevToolsOpened()`、`isDevToolsFocused()`，以及 `devtools-opened` / `devtools-closed` targeted events。范围仍限定为当前 PluginPanel hosted child iframe；这里维护的是宿主内 DevTools 兼容状态和事件，不伪装真实 Chromium DevTools window、dock UI、inspect protocol 或 native independent BrowserWindow。

### 背景和依据

- [Electron webContents 文档](https://www.electronjs.org/docs/latest/api/web-contents)说明 `contents.openDevTools([options])` 支持 `mode` / `activate` / `title` 选项，`closeDevTools()` 关闭 DevTools，`toggleDevTools()` 切换状态，`isDevToolsOpened()` 返回打开状态；同页文档还描述了 `devtools-opened` / `devtools-closed` 事件。
- Electron `isDevToolsFocused()` 返回 DevTools 是否 focused，是插件调试/自检代码中常见的同步状态探针。
- 当前 hosted BrowserWindow 已覆盖父子 IPC、脚本执行、输入事件、CSS、page search 和 hosted history，但 DevTools 仍在剩余 WebContents 缺口内。

### 实现

- `PluginBrowserWindowState` 新增 `devToolsOpened`、`devToolsFocused`、`devToolsMode`、`devToolsTitle`。
- 注入桥在 `_createBrowserWindowHandle()` 中维护 WebContents DevTools cache，新增：
  - `openDevTools(options)`
  - `closeDevTools()`
  - `toggleDevTools()`
  - `isDevToolsOpened()`
  - `isDevToolsFocused()`
- `syncWebContentsDevToolsState()` 会在 host action resolve 或 host targeted event 到达时更新本地 sync cache。
- `updatePluginBrowserWindowDevTools()` 维护 hosted 状态，规范化 `mode`，按 `activate:false` 保留 unfocused 语义，并派发 targeted `devtools-opened` / `devtools-closed` WebContents events。
- Web preview 的 `?pluginHostSmoke=browserWindow` 增加 DevTools 状态路径：`openDevTools({ mode:"detach", activate:false, title:"Hosted DevTools" })` -> `toggleDevTools()` -> `openDevTools({ mode:"bottom" })` -> `closeDevTools()`，并验证 `isDevToolsOpened()` / `isDevToolsFocused()` 和 opened/closed 事件标记。

### TDD 和测试

- 扩展 `scripts/test-plugin-window-browser-bridge.mjs`：
  - 要求 BrowserWindow `webContents` 暴露 DevTools 五个方法。
  - 验证初始 `isDevToolsOpened()` / `isDevToolsFocused()` 为 `false`。
  - 验证 `openDevTools(options)`、`toggleDevTools()`、`closeDevTools()` 分别经 native bridge 发送 action `webContents.openDevTools`、`webContents.toggleDevTools`、`webContents.closeDevTools`。
  - 验证 action resolve 后同步 cache 更新，`activate:false` 下 focused 为 false，默认 open 下 focused 为 true。
  - 验证 targeted `devtools-opened` / `devtools-closed` 事件只由 `webContents.on()` / `once()` 监听，且 one-shot close listener 只触发一次。
  - 增加静态断言，要求 host 存在 `pluginBrowserWindowDevToolsResult()` / `updatePluginBrowserWindowDevTools()`，桥接代码包含三个新增 action，Web preview smoke 调用新增方法并读取 sync state。
- 初次红灯：`pnpm test:plugin-window-browser-bridge` 失败在 `browser-window webContents should expose openDevTools()`。
- 实现后目标测试转绿。
- 最终脚本验证：
  - `pnpm test:plugin-window-browser-bridge`
  - `pnpm test:plugin-host-view`
  - `pnpm test:plugin-window-page-search`
  - `pnpm test:plugin-window-lifecycle`
  - `pnpm check`
  - `pnpm build` 通过，仅保留既有 Vite chunk size warning。
  - `pnpm smoke:tauri-desktop` 通过，输出 `Desktop smoke passed: 127.0.0.1:58975`，权限、数据调试、系统设置、插件 runtime、本地应用搜索均为 `error:null`。
- Browser 检查：in-app Browser 打开 `http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=232-devtools-iab`，标题为 `ATools 3.0`，Browser 窗口 chip 显示 1 个子窗口，最近消息完成到 `window:setAlwaysOnTop +1`，子窗口标题为 `子窗口已更新`。
- Playwright frame 检查：`http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=232-devtools-detail` 中父 iframe body 包含 `data-browser-window-devtools-event-opened="true"`、`data-browser-window-devtools-open="true"`、`data-browser-window-devtools-event-closed="true"`、`data-browser-window-devtools-toggle="true"`、`data-browser-window-devtools-reopen="true"`、`data-browser-window-devtools-close="true"`；此前 navigation、CSS insert/remove、findInPage、IPC、executeJavaScript 和 sendInputEvent 标记保持通过。console 为 0 errors，仅有既有 iframe sandbox warnings。

### 完成度调整

| 模块 | Before | After | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 79% | 80% | BrowserWindow hosted WebContents DevTools state bridge 可在指定 child iframe handle 上跑通 |
| 插件 runtime parity | 99% | 99% | 本批增强宿主 WebContents 兼容面，但不新增 native runtime 能力总类 |
| 测试与发布 | 99% | 99% | 覆盖继续加深，但签名、公证、自动更新仍未完成 |

### 剩余风险

1. DevTools：当前只维护 hosted DevTools open/focus/mode/title 状态并派发事件；`inspectElement` 已在后续批次补为 hosted state/元素摘要，不打开真实 Chromium DevTools window，不实现 dock UI、protocol attachment 或 native DevTools lifecycle。
2. WebContents 覆盖：仍不是完整 Electron WebContents；isolated world、页面 capture、打印、跨进程 frame routing、before-input-event、真实 cache 策略等仍未接入。
3. 插件生态：仍未跑真实第三方 ZTools/uTools 插件矩阵；SPA/router 插件、复杂 preload、native 菜单和独立窗口生命周期仍是高风险。

## Batch 231：BrowserWindow hosted WebContents navigation state bridge

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批继续收口宿主内 browser-window WebContents 兼容，补齐 Electron/WebContents 常用的同步导航状态读取和 history 操作：`getURL()`、`getTitle()`、`isLoading()`、`isLoadingMainFrame()`、`canGoBack()`、`canGoForward()`、`reloadIgnoringCache()`、`goBack()`、`goForward()`。范围仍限定为当前 PluginPanel hosted child iframe；这里维护的是宿主内 URL/title/srcdoc history，不伪装完整 Chromium NavigationHistory、session history、跨进程 frame routing 或 native independent BrowserWindow。

### 背景和依据

- Electron `webContents.getURL()` / `getTitle()` / `isLoading()` / `isLoadingMainFrame()` 是常见同步状态读取；`goBack()` / `goForward()` / reload 类动作是 BrowserWindow 插件中常见的 WebContents 导航入口。
- 当前 hosted BrowserWindow 已覆盖 URL/load/reload handle 方法、父子 IPC、脚本执行、输入事件、CSS 注入和 page search，但 WebContents 自身还没有同步导航状态和 history action 表面。
- current host 使用 child iframe `srcdoc`，所以本批采用 hosted 兼容语义：由 PluginPanel 记录每个 hosted BrowserWindow 的 URL/title/srcdoc history，并在 iframe ready 后同步标题和 loading 状态。

### 实现

- `PluginBrowserWindowState` 新增 `history`、`historyIndex` 和 `loading`，history entry 记录 `{ url, title, srcdoc }`。
- 注入桥在 `_createBrowserWindowHandle()` 中维护 WebContents 本地导航 cache，新增：
  - `getURL()` / `getTitle()` / `isLoading()` / `isLoadingMainFrame()`
  - `canGoBack()` / `canGoForward()`
  - `reloadIgnoringCache()` / `goBack()` / `goForward()`
- `loadURL()` / `reload()` 复用 WebContents navigation action，host 返回结果后同步本地 cache；`loadURL()` 会截断 forward history，`reload()` / `reloadIgnoringCache()` 保留当前 history entry。
- `loadPluginBrowserWindowUrl()` 返回 `{ url, title, historyIndex, historyLength, loading:false, reloaded, ignoreCache }`，并在 load/reload 时清理旧 inserted CSS key。
- `navigatePluginBrowserWindowHistory()` 支持 hosted back/forward，恢复目标 entry 的 URL/title/srcdoc，等待 iframe ready 后再返回 navigation result。
- Web preview 的 `?pluginHostSmoke=browserWindow` 增加导航状态路径：父 iframe 在 `loadURL("child-reloaded.html")` 后读取 WebContents sync 状态，再执行 `reloadIgnoringCache()`、`goBack()`、`goForward()` 并记录对应 `data-browser-window-*` 标记。

### TDD 和测试

- 扩展 `scripts/test-plugin-window-browser-bridge.mjs`：
  - 要求 BrowserWindow `webContents` 暴露 `getURL()` / `getTitle()` / `isLoading()` / `isLoadingMainFrame()` / `canGoBack()` / `canGoForward()` / `reloadIgnoringCache()` / `goBack()` / `goForward()`。
  - 验证初始 sync 状态来自 create result，`loadURL()` resolve 后 `getURL()` / `getTitle()` / history booleans 同步更新。
  - 验证 `reloadIgnoringCache()`、`goBack()`、`goForward()` 分别经 native bridge 发送 action `webContents.reloadIgnoringCache`、`webContents.goBack`、`webContents.goForward`。
  - 增加静态断言，要求 host 存在 `pluginBrowserWindowNavigationResult()` / `navigatePluginBrowserWindowHistory()`，桥接代码包含三个新增 WebContents action，Web preview smoke 调用三个新增方法。
- 初次红灯：`pnpm test:plugin-window-browser-bridge` 失败在 `browser-window webContents should expose getURL()`。
- 实现后目标测试转绿。
- 最终脚本验证：
  - `pnpm test:plugin-window-browser-bridge`
  - `pnpm test:plugin-host-view`
  - `pnpm test:plugin-window-page-search`
  - `pnpm test:plugin-window-lifecycle`
  - `pnpm check`
  - `pnpm build` 通过，仅保留既有 Vite chunk size warning。
  - `pnpm smoke:tauri-desktop` 通过，输出 `Desktop smoke passed: 127.0.0.1:53257`，权限、数据调试、系统设置、插件 runtime、本地应用搜索均为 `error:null`。
- Browser 检查：in-app Browser 打开 `http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=231-nav-iab-clean`，标题为 `ATools 3.0`，Browser 窗口 chip 显示 1 个子窗口，最近消息完成到 `window:setAlwaysOnTop +1`，子窗口 URL 为 `child-reloaded.html`，无 Vite/Svelte framework error overlay。
- Playwright frame 检查：`http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=231-nav-debug` 中父 iframe body 包含 `data-browser-window-webcontents-url="child-reloaded.html"`、`data-browser-window-webcontents-title="child-reloaded.html"`、`data-browser-window-webcontents-loading="true"`、`data-browser-window-can-go-back="true"`、`data-browser-window-reload-ignoring-cache="true"`、`data-browser-window-go-back="true"`、`data-browser-window-go-forward="true"`；此前 CSS insert/remove、findInPage、IPC、executeJavaScript 和 sendInputEvent 标记保持通过。console 为 0 errors，仅有既有 iframe sandbox warnings。

### 完成度调整

| 模块 | Before | After | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 78% | 79% | BrowserWindow hosted WebContents navigation/status/history bridge 可在指定 child iframe 上跑通 |
| 插件 runtime parity | 99% | 99% | 本批增强宿主 WebContents 兼容面，但不新增 native runtime 能力总类 |
| 测试与发布 | 99% | 99% | 覆盖继续加深，但签名、公证、自动更新仍未完成 |

### 剩余风险

1. 导航栈：Batch 231 当时的 history 是 hosted URL/title/srcdoc 兼容栈，尚未覆盖 `navigationHistory` 对象；Batch 243 已补 hosted navigationHistory，但仍不等同 Chromium session history、跨 frame history 或浏览器进程级导航。
2. WebContents 覆盖：仍不是完整 Electron WebContents；isolated world、页面 capture、DevTools、打印、跨进程 frame routing、before-input-event、真实 cache 策略等仍未接入。
3. 插件生态：仍未跑真实第三方 ZTools/uTools 插件矩阵；SPA/router 插件、复杂 preload、native 菜单和独立窗口生命周期仍是高风险。

## Batch 230：BrowserWindow hosted `findInPage()` / `stopFindInPage()` bridge

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批延续宿主内 browser-window WebContents 兼容，补齐 Electron WebContents 常用的 `win.webContents.findInPage(text[, options])`、`win.webContents.stopFindInPage(action)` 和 `found-in-page` 事件路径。范围仍限定为当前 PluginPanel hosted child iframe；这里的查找只基于对应子 iframe 文档文本计算 match count 和 final event，不伪装完整 Chromium 查找 UI、高亮绘制、跨 frame 搜索或 native independent BrowserWindow。

### 背景和依据

- [Electron webContents 文档](https://www.electronjs.org/docs/latest/api/web-contents)说明 `contents.findInPage(text[, options])` 会发起页面查找并同步返回 request id，结果通过 `found-in-page` 事件获得；`contents.stopFindInPage(action)` 支持 `clearSelection` / `keepSelection` / `activateSelection`。
- 当前 hosted BrowserWindow 已覆盖父子 IPC、脚本执行、输入事件和 CSS 注入移除，但还没有 WebContents 自身 EventEmitter 表面，插件无法监听子窗口查找结果。
- current host 使用 child iframe `srcdoc`，所以本批采用 hosted 兼容语义：对目标子 iframe 文本做非破坏性匹配统计，并通过 targeted `found-in-page` 事件回传 request id 和 final result。

### 实现

- 注入桥把 hosted BrowserWindow handle 的非枚举 `webContents` 对象扩展为：
  - `findInPage(text, options)` -> 同步生成 request id，异步 action `webContents.findInPage`
  - `stopFindInPage(action)` -> 异步 action `webContents.stopFindInPage`，保持 void-return shape
  - `on` / `addListener` / `once` / `off` / `removeListener` / `removeAllListeners`
- BrowserWindow 事件分发增加 `target:"webContents"` 分支；普通 window 事件仍走 handle EventEmitter，WebContents targeted events 只投递到 `handle.webContents` 的监听器。
- `PluginPanel.svelte` 新增 `findPluginBrowserWindowInPage()`：等待对应 child iframe ready，读取子文档 body/documentElement 文本，按 `matchCase` 计算非重叠 match count，生成 `{ requestId, activeMatchOrdinal, matches, selectionArea, finalUpdate:true }`，并派发 targeted `found-in-page`。
- `stopPluginBrowserWindowFindInPage()` 规范化 action；`clearSelection` 会 best-effort 清理子 iframe selection。
- Web preview 的 `?pluginHostSmoke=browserWindow` 增加 page-search 路径：父 iframe 注册 `win.webContents.on("found-in-page", ...)`，调用 `findInPage("发送", { matchCase:false })`，验证同步 request id、final found event 和 `stopFindInPage("clearSelection")`。

### TDD 和测试

- 扩展 `scripts/test-plugin-window-browser-bridge.mjs`：
  - 要求 BrowserWindow `webContents` 暴露 `findInPage()` / `stopFindInPage()` 和 EventEmitter 方法。
  - 验证 `findInPage("needle", { forward:false, matchCase:true })` 同步返回 request id `1`，并经 native bridge 发送 action `webContents.findInPage` 和参数 `[text, options, requestId]`。
  - 验证 `stopFindInPage("clearSelection")` 保持官方 void-return shape，并经 native bridge 发送 action `webContents.stopFindInPage`。
  - 验证 targeted `found-in-page` 事件只由 `webContents.on()` / `once()` 监听，且 one-shot listener 在首次事件后移除。
  - 增加静态断言，要求 host 存在 `findPluginBrowserWindowInPage()` / `stopPluginBrowserWindowFindInPage()`，桥接代码包含两个 WebContents 方法，Web preview smoke 调用两个方法并监听 `found-in-page`。
- 初次红灯：`pnpm test:plugin-window-browser-bridge` 失败在 `browser-window webContents should expose findInPage()`。
- 实现后目标测试转绿。
- 最终脚本验证：
  - `pnpm test:plugin-window-browser-bridge`
  - `pnpm test:plugin-host-view`
  - `pnpm test:plugin-window-page-search`
  - `pnpm test:plugin-window-lifecycle`
  - `pnpm check`
  - `pnpm build` 通过，仅保留既有 Vite chunk size warning。
  - `pnpm smoke:tauri-desktop` 通过，输出 `Desktop smoke passed: 127.0.0.1:63515`，权限、数据调试、系统设置、插件 runtime、本地应用搜索均为 `error:null`。
- Browser 检查：in-app Browser 打开 `http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=230-find`，标题为 `ATools 3.0`，Browser 窗口 chip 显示 1 个子窗口，最近消息继续更新，无 Vite/Svelte framework error overlay。
- Playwright frame 检查：`http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=230-find-fixed` 中父 iframe body 包含 `data-browser-window-find-in-page="true"`、`data-browser-window-found-in-page="true"`、`data-browser-window-found-request="true"`、`data-browser-window-stop-find-in-page="true"`；CSS insert/remove 仍保持 `data-browser-window-insert-css="true"`、`data-browser-window-remove-inserted-css="true"`、`data-browser-window-insert-css-removed="true"` 且无 `style[data-atools-browser-window-css-key]` 残留；child iframe 保持 `data-child-ipc-ping="true"`、`data-execute-js="42"`、`data-send-input-event="Enter:shift"`。

### 完成度调整

| 模块 | Before | After | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 77% | 78% | BrowserWindow hosted `webContents.findInPage()` / `stopFindInPage()` 和 targeted `found-in-page` 事件可在指定 child iframe 上跑通 |
| 插件 runtime parity | 99% | 99% | 本批增强宿主 WebContents 兼容面，但不新增 native runtime 能力总类 |
| 测试与发布 | 99% | 99% | 覆盖继续加深，但签名、公证、自动更新仍未完成 |

### 剩余风险

1. 查找呈现：当前只返回 match count / active ordinal / final event，不绘制 Chromium 原生查找高亮或滚动到匹配位置。
2. WebContents 覆盖：仍不是完整 Electron WebContents；isolated world、页面 capture、navigation history、DevTools、打印、跨 frame routing、before-input-event 等仍未接入。
3. 插件生态：仍未跑真实第三方 ZTools/uTools 插件矩阵；SPA/router 插件、复杂 preload、native 菜单和独立窗口生命周期仍是高风险。

## Batch 229：BrowserWindow hosted `insertCSS()` / `removeInsertedCSS()` bridge

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批延续宿主内 browser-window WebContents 兼容，补齐 Electron WebContents 常用的 `win.webContents.insertCSS(css[, options])` 和 `win.webContents.removeInsertedCSS(key)` 路径。范围仍限定为当前 PluginPanel hosted child iframe；这里的 CSS 注入只在对应子 iframe DOM 中插入/移除 keyed `<style>`，不伪装完整 Electron WebContents、isolated world、user/author 原生 cascade origin 或跨进程 frame routing。

### 背景和依据

- [Electron webContents 文档](https://www.electronjs.org/docs/latest/api/web-contents)说明 `contents.insertCSS(css[, options])` 会向当前页面注入 CSS，并返回一个可传给 `contents.removeInsertedCSS(key)` 的唯一 key；`removeInsertedCSS(key)` 返回 `Promise<void>`。
- 当前 hosted BrowserWindow 已覆盖父子 IPC、脚本执行和输入事件，但还不能按 WebContents 方式临时注入样式；真实插件里这类方法常用于 overlay、高亮、主题或调试样式。
- 由于 current host 使用 child iframe `srcdoc`，CSS key 必须按 hosted window id 作用域隔离，并在 close/load/reload 时清理，避免旧 key 误操作新页面。

### 实现

- 注入桥把 hosted BrowserWindow handle 的非枚举 `webContents` 对象扩展为：
  - `insertCSS(css, options)` -> action `webContents.insertCSS`
  - `removeInsertedCSS(key)` -> action `webContents.removeInsertedCSS`
- `PluginPanel.svelte` 新增 `PluginBrowserWindowInsertedCss` 记录和 `pluginBrowserWindowInsertedCss` map，以 returned key 记录 owning window、CSS 文本和 `cssOrigin`。
- `insertPluginBrowserWindowCss()` 等待对应 hosted child iframe ready，在子文档 head/documentElement 中插入 `<style data-atools-browser-window-css-key="...">`，返回 key。
- `removePluginBrowserWindowCss()` 校验 key 属于当前 hosted window，等待 child iframe ready 后查找并移除对应 `<style>`，删除 key 记录并返回 `undefined`。
- `loadPluginBrowserWindowUrl()` / `reload()` 和 `close()` 会清理对应 window 的 inserted CSS key，避免导航后旧 key 残留。
- Web preview 的 `?pluginHostSmoke=browserWindow` 增加 CSS 注入路径：父 iframe 调用 `insertCSS('body { --atools-insert-css: inserted; }', { cssOrigin: 'user' })`，通过 `executeJavaScript('getComputedStyle(...).getPropertyValue(...)')` 验证值为 `inserted`，再调用 `removeInsertedCSS(key)` 并验证值清空。

### TDD 和测试

- 扩展 `scripts/test-plugin-window-browser-bridge.mjs`：
  - 要求 BrowserWindow handle 暴露 `webContents.insertCSS()` 和 `webContents.removeInsertedCSS()`。
  - 验证 `insertCSS("body { --atools-insert-css: inserted; }", { cssOrigin: "user" })` 经 native bridge 发送 action `webContents.insertCSS` 和参数 `[css, { cssOrigin: "user" }]`，并解析返回 key。
  - 验证 `removeInsertedCSS(key)` 经 native bridge 发送 action `webContents.removeInsertedCSS` 和 key 参数，并解析为 `undefined`。
  - 增加静态断言，要求 host 存在 `insertPluginBrowserWindowCss()` / `removePluginBrowserWindowCss()`，桥接代码包含两个 WebContents 方法，Web preview smoke 调用两个方法。
- 初次红灯：`pnpm test:plugin-window-browser-bridge` 失败在 `browser-window webContents should expose insertCSS()`。
- 实现后目标测试转绿。
- 最终脚本验证：
  - `pnpm test:plugin-window-browser-bridge`
  - `pnpm test:plugin-host-view`
  - `pnpm test:plugin-window-page-search`
  - `pnpm test:plugin-window-lifecycle`
  - `pnpm check`
  - `pnpm build` 通过，仅保留既有 Vite chunk size warning。
  - `pnpm smoke:tauri-desktop` 通过，输出 `Desktop smoke passed: 127.0.0.1:54745`，权限、数据调试、系统设置、插件 runtime、本地应用搜索均为 `error:null`。
- Browser 检查：`http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=229-css` 标题为 `ATools 3.0`，最终子窗口数量为 1、标题为 `子窗口已更新`、class 包含 `positioned focused alwaysOnTop`，inline style 为 `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3003;`，最近消息为 `window:setAlwaysOnTop +1`，无 Vite/Svelte framework error overlay。
- Playwright frame 检查：`http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=229-css-nd` 中父 iframe body 包含 `data-browser-window-insert-css="true"`、`data-browser-window-remove-inserted-css="true"`、`data-browser-window-insert-css-removed="true"`；child iframe body 保持 `data-child-ipc-ping="true"`、`data-execute-js="42"`、`data-send-input-event="Enter:shift"`；所有 iframe 内 `style[data-atools-browser-window-css-key]` 均为空，说明 remove path 没有留下 injected style。

### 完成度调整

| 模块 | Before | After | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 76% | 77% | BrowserWindow hosted `webContents.insertCSS()` / `removeInsertedCSS()` 可对指定 child iframe 做 keyed stylesheet 注入和移除 |
| 插件 runtime parity | 99% | 99% | 本批增强宿主 WebContents 兼容面，但不新增 native runtime 能力总类 |
| 测试与发布 | 99% | 99% | 覆盖继续加深，但签名、公证、自动更新仍未完成 |

### 剩余风险

1. CSS origin：当前记录并标记 `cssOrigin`，但 WebView DOM `<style>` 注入无法等同 Chromium 原生 user/author cascade origin。
2. 插件 BrowserWindow：本批只补 hosted CSS injection/removal，仍不是完整 Electron WebContents；isolated world、页面 capture、navigation history、DevTools、打印、跨 frame routing、before-input-event 等仍未接入。
3. 插件生态：仍未跑真实第三方 ZTools/uTools 插件矩阵；SPA/router 插件、复杂 preload、native 菜单和独立窗口生命周期仍是高风险。

## Batch 228：BrowserWindow hosted `sendInputEvent()` bridge

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批延续宿主内 browser-window WebContents 兼容，补齐 Electron/uTools 生态常见的 `win.webContents.sendInputEvent(inputEvent)` 路径。范围仍限定为当前 PluginPanel hosted child iframe；这里的 `sendInputEvent` 会把键盘、鼠标和滚轮输入转换成对应 DOM 事件派发到子 iframe 文档，不伪装完整 Electron WebContents、native 独立窗口、跨进程 frame routing 或 OS 级输入注入。

### 背景和依据

- [uTools 窗口 API 文档](https://www.u-tools.cn/docs/developer/api-reference/utools/window.html)说明 `createBrowserWindow()` 返回定制 BrowserWindow，插件代码会继续按 Electron BrowserWindow/WebContents 习惯调用返回 handle。
- [Electron webContents 文档](https://www.electronjs.org/docs/latest/api/web-contents)说明 `contents.sendInputEvent(inputEvent)` 会向页面发送输入事件，BrowserWindow 通常需要处于 focus 状态，输入类型覆盖 keyboard/mouse/wheel 等事件形态。
- 当前 hosted BrowserWindow 已覆盖 `webContents.send()` 和 `webContents.executeJavaScript()`；剩余缺口是父插件无法用 WebContents 输入事件驱动 child iframe 内部交互，且上一批 smoke 暴露出 `loadURL()` / `reload()` 后续 WebContents 动作存在打到初始空文档的竞态风险。

### 实现

- 注入桥把 hosted BrowserWindow handle 的非枚举 `webContents` 对象扩展为 `sendInputEvent(inputEvent)`，action 统一路由为 `browserWindowAction` 的 `webContents.sendInputEvent`。
- `PluginPanel.svelte` 新增 `dispatchPluginBrowserWindowInputEvent()`：校验 window id、frame ready 和 input event type，然后按事件类型构造并派发 `KeyboardEvent`、`MouseEvent` 或 `WheelEvent`。
- 键盘事件支持 `rawKeyDown` / `keyDown` / `keyUp` / `char` 到 DOM `keydown` / `keyup` / `keypress`；鼠标事件支持 `mouseDown` / `mouseUp` / `mouseMove` / `mouseEnter` / `mouseLeave` / `contextMenu`；滚轮事件支持 `mouseWheel` 到 DOM `wheel`。
- modifiers 兼容 `["shift", "control", "ctrl", "alt", "meta", "command", "cmd"]` 以及显式 `shiftKey` / `ctrlKey` / `altKey` / `metaKey` 布尔字段；鼠标坐标使用 child iframe viewport 坐标。
- hosted browser-window frame refs 增加 ready map：iframe action 监听 `load`，`loadURL()` / `reload()` 在更新 `srcdoc` 后等待 child frame 可用再 resolve，避免后续 `executeJavaScript()` / `sendInputEvent()` 命中旧的初始空文档。
- `webContents.send()` 保持 Electron fire-and-forget 语义，立即向父插件 resolve `true`，但 host 会在后台等待 child frame ready 后投递，并在短窗口内重试，避免阻塞父插件 Promise 链。
- Web preview 的 `?pluginHostSmoke=browserWindow` 增加父到子输入事件路径：父 iframe 调用 `win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter", modifiers: ["shift"] })`，父 iframe 记录 `data-browser-window-send-input-event="true"`，子 iframe通过 `keydown` listener 记录 `data-send-input-event="Enter:shift"`。

### TDD 和测试

- 扩展 `scripts/test-plugin-window-browser-bridge.mjs`：
  - 要求 BrowserWindow handle 暴露 `webContents.sendInputEvent()`。
  - 验证 `webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter", modifiers: ["shift"] })` 经 native bridge 发送 action `webContents.sendInputEvent` 和正确 input event 参数，并按 Electron-compatible void 语义解析为 `undefined`。
  - 增加静态断言，要求 host 存在 `dispatchPluginBrowserWindowInputEvent()`，桥接代码包含 `webContents.sendInputEvent`，Web preview smoke 调用 `win.webContents.sendInputEvent()`，child smoke 包含 `data-send-input-event` 标记。
- 初次红灯：`pnpm test:plugin-window-browser-bridge` 失败在 `browser-window webContents should expose sendInputEvent()`。
- 中间验证暴露 readiness 竞态：Browser/Playwright smoke 显示父链路可能停在 `loadURL` 或 `webContents:ping`，以及 child body 未记录 `data-child-ipc-ping` / `data-execute-js` / `data-send-input-event`。随后补 iframe ready guard，并把 `webContents.send()` 改回非阻塞后台投递，避免破坏 Electron fire-and-forget 语义。
- 最终脚本验证：
  - `pnpm test:plugin-window-browser-bridge`
  - `pnpm test:plugin-host-view`
  - `pnpm test:plugin-window-page-search`
  - `pnpm test:plugin-window-lifecycle`
  - `pnpm check`
  - `pnpm build` 通过，仅保留既有 Vite chunk size warning。
  - `pnpm smoke:tauri-desktop` 通过，输出 `Desktop smoke passed: 127.0.0.1:64476`，权限、数据调试、系统设置、插件 runtime、本地应用搜索均为 `error:null`。
- Browser 检查：`http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=228-send-nonblocking` 标题为 `ATools 3.0`，最终子窗口数量为 1、标题为 `子窗口已更新`、header URL 为 `child-reloaded.html`、class 包含 `positioned focused alwaysOnTop`，inline style 为 `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3003;`，最近消息为 `window:setAlwaysOnTop +1`，无 Vite/Svelte framework error overlay。
- Playwright frame 检查：`http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=228-final-nd` 中父 iframe body 包含 `data-browser-window-webcontents-send="true"`、`data-browser-window-execute-js="true"`、`data-browser-window-send-input-event="true"`、`data-parent-message-channel="browser-window-ipc"`，父状态文本为 `browser-window-ipc:browserWindow`；child iframe body 包含 `data-child-ipc-ping="true"`、`data-execute-js="42"`、`data-send-input-event="Enter:shift"`。

### 完成度调整

| 模块 | Before | After | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 75% | 76% | BrowserWindow hosted `webContents.sendInputEvent()` 可向指定 child iframe 派发键盘/鼠标/滚轮 DOM 事件，并补齐 iframe ready guard |
| 插件 runtime parity | 99% | 99% | 本批增强宿主兼容面，但不新增插件 runtime/native 能力总类 |
| 测试与发布 | 99% | 99% | 覆盖继续加深，但签名、公证、自动更新仍未完成 |

### 剩余风险

1. 插件 BrowserWindow：本批只补 hosted `webContents.sendInputEvent`，仍不是完整 Electron WebContents；`executeJavaScriptInIsolatedWorld()`、capture、navigation history、DevTools、打印、跨 frame routing、native before-input-event 等仍未接入。
2. 输入事件语义：当前是 DOM 事件兼容派发，不等同 OS 级真实键鼠输入；复杂 IME、文本编辑默认行为、拖拽、选择、pointer capture、跨 iframe 坐标换算仍需真实插件回归。
3. 插件生态：仍未跑真实第三方 ZTools/uTools 插件矩阵；SPA/router 插件、复杂 preload、native 菜单和独立窗口生命周期仍是高风险。

## Batch 227：BrowserWindow hosted `executeJavaScript()` bridge

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批延续宿主内 browser-window WebContents 兼容，补齐 uTools 文档示例里的 `win.webContents.executeJavaScript(code[, userGesture])` 路径。范围仍限定为当前 PluginPanel hosted child iframe；这里的 `executeJavaScript` 只在对应子 iframe `contentWindow` 中执行脚本并回传结果，不伪装完整 Electron WebContents、native 独立窗口或跨进程 frame routing。

状态：DONE。

参考：

- [uTools 窗口 API 文档](https://www.u-tools.cn/docs/developer/api-reference/utools/window.html)的 `createBrowserWindow()` 示例在父窗口里同时使用 `win.webContents.send()` 和 `win.webContents.executeJavaScript()`。
- [Electron webContents 文档](https://www.electronjs.org/docs/latest/api/web-contents)说明 `executeJavaScript(code[, userGesture])` 会在页面中执行代码，并返回解析为脚本结果的 `Promise<any>`；脚本抛错或返回 rejected promise 时 promise 会 reject。

修改文件：

- `src/components/PluginPanel.svelte`
- `src/App.svelte`
- `scripts/test-plugin-window-browser-bridge.mjs`
- `docs/ui-ztools-restore-checklist.md`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 注入桥把 hosted BrowserWindow handle 的非枚举 `webContents` 对象扩展为 `executeJavaScript(code, userGesture)`，action 统一路由为 `browserWindowAction` 的 `webContents.executeJavaScript`。
- PluginPanel 新增 `executePluginBrowserWindowJavaScript()`，按 window id 定位 hosted child iframe，调用子窗口 `contentWindow.eval(code)`，并通过既有 native bridge Promise 返回同步值或 Promise 结果。
- 执行失败时返回 method-scoped 错误：窗口不存在、iframe 未 ready、脚本抛错或 promise rejected 不会被吞掉，也不会伪造成功。
- Web preview 的 `?pluginHostSmoke=browserWindow` 增加父到子脚本执行路径：父 iframe 调用 `win.webContents.executeJavaScript('document.body.setAttribute("data-execute-js", String(21 * 2)); 21 * 2', true)`，父 iframe 记录 `data-browser-window-execute-js="true"`，子 iframe body 记录 `data-execute-js="42"`。

TDD 记录：

- 扩展 `scripts/test-plugin-window-browser-bridge.mjs`：
  - 要求 BrowserWindow handle 暴露 `webContents.executeJavaScript()`。
  - 验证 `webContents.executeJavaScript("window.__answer = 40 + 2; window.__answer", true)` 经 native bridge 发送 action `webContents.executeJavaScript` 和参数 `["window.__answer = 40 + 2; window.__answer", true]`，并能解析返回值 `42`。
  - 验证 `webContents.executeJavaScript(0)` 会按 Electron 兼容语义经 `String(code)` 转成脚本 `"0"`，不因 falsy 值被误转成空字符串。
  - 增加静态断言，要求 host 存在 `executePluginBrowserWindowJavaScript()`，桥接代码包含 `webContents.executeJavaScript`，Web preview smoke 调用 `win.webContents.executeJavaScript()`。
- 首次运行目标测试红灯：
  - `AssertionError [ERR_ASSERTION]: browser-window webContents should expose executeJavaScript()`
- 边界测试红灯：
  - 旧实现用 `String(code || "")`，`executeJavaScript(0)` 发送参数 `["", false]`，期望为 `["0", false]`。
- 实现后目标测试转绿。
- `pnpm check` 首次暴露 TS 错误：当前 DOM 类型里 `Window` 未声明 `eval`；补充局部类型窄化后 `pnpm check` 转绿。

验证：

```bash
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-host-view
pnpm test:plugin-window-page-search
pnpm test:plugin-window-lifecycle
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-window-browser-bridge`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-window-page-search`：通过。
- `pnpm test:plugin-window-lifecycle`：通过。
- `pnpm check`：通过，`svelte-check found 0 errors and 0 warnings`。
- `pnpm build`：通过，195 modules transformed；仍有既有 Vite chunk size warning（`index-BazISr19.js` 超 500 kB），不属于本批回归。
- `pnpm smoke:tauri-desktop`：通过，最终输出 `Desktop smoke passed: 127.0.0.1:57667`。

Browser smoke：

- URL：`http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=227`
- 页面身份：标题 `ATools 3.0`，URL 正确。
- 非空：页面显示 `插件运行态预览`、runtime chips、SubInput 和 hosted Browser window shell。
- Framework overlay：`vite-error-overlay` / `.vite-error-overlay` / `.svelte-error-overlay` / `[data-sveltekit-error]` 计数均为 0。
- 目标状态：
  - 最终子窗口数量：`1`
  - 标题：`子窗口已更新`
  - header URL：`child-reloaded.html`
  - class：`positioned focused alwaysOnTop`
  - inline style：`width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3003;`
  - parent iframe `data-browser-window-webcontents-send`：`true`
  - parent iframe `data-browser-window-execute-js`：`true`
  - child iframe `data-child-ipc-ping`：`true`
  - child iframe `data-execute-js`：`42`
  - parent iframe callback channel：`browser-window-ipc`
  - parent iframe 状态文本：`browser-window-ipc:browserWindow`
- 控制台：仍有已知 `MutationObserver` TypeError 噪声；无 Vite/Svelte framework error overlay，目标执行状态为 true。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 74% | 75% | BrowserWindow hosted `webContents.executeJavaScript()` 可在指定子 iframe 执行脚本并通过 Promise 回传结果 |
| 插件 runtime parity | 99% | 99% | 本批只补当前 PluginPanel hosted WebContents 兼容层，不改变 API shim/runtime 总量 |

当前重点剩余：

1. 插件 BrowserWindow：本批只补 hosted `webContents.executeJavaScript`，仍不是完整 Electron WebContents；`executeJavaScriptInIsolatedWorld()`、`sendInputEvent()`、capture、navigation history、DevTools、打印、跨 frame routing 等未接入。
2. 插件窗口：真实独立 native BrowserWindow、更多 OS 级事件/生命周期、分离窗口、真实右键菜单和拖拽仍未完成。
3. 插件生态：真实第三方插件包、SPA/router 运行态和复杂跨 iframe 交互仍需专项回归。

## Batch 226：BrowserWindow hosted WebContents IPC bridge

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批延续宿主内 browser-window handle，补齐 uTools 文档示例里的主窗口到独立窗口通信路径：父插件通过 `win.webContents.send(channel, ...args)` 向子窗口发送消息，子窗口 preload 通过 `ipcRenderer.on(channel, listener)` 接收。范围仍限定为当前 PluginPanel hosted child iframe；这里的 `webContents` 只覆盖 `send()` 子窗口 IPC，不伪装完整 Electron WebContents、native 独立窗口或跨进程 IPC。

状态：DONE。

参考依据：

- [uTools 窗口 API 文档](https://www.u-tools.cn/docs/developer/api-reference/utools/window.html)说明 `createBrowserWindow()` 返回定制 BrowserWindow，父窗口到独立窗口只能用 `win.webContents.send`，子窗口接收统一使用 `ipcRenderer.on`。
- [Electron webContents 文档](https://www.electronjs.org/docs/latest/api/web-contents)说明 `contents.send(channel, ...args)` 会向 renderer 发送异步消息。
- [Electron ipcRenderer 文档](https://www.electronjs.org/docs/latest/api/ipc-renderer)说明 renderer 侧可通过 `ipcRenderer.on(channel, listener)` 接收消息。

修改文件：

- `src/components/PluginPanel.svelte`
- `src/App.svelte`
- `scripts/test-plugin-window-browser-bridge.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 注入桥把 `createBrowserWindow()` 返回对象扩展为非枚举 `webContents` 属性，当前支持 `webContents.send(channel, ...args)`；非枚举设计保持既有 handle JSON 形态不变。
- 子窗口注入层新增最小 Electron 兼容 `require("electron").ipcRenderer`，支持 `on()` / `addListener()` / `once()` / `off()` / `removeListener()` / `removeAllListeners()`。
- PluginPanel 新增 hosted child iframe ref map，`browserWindowAction` 的 `webContents.send` action 会按 window id 投递到匹配的子 iframe，并用 `__atools_browser_window_ipc__` 与生命周期事件、`sendToParent` 消息隔离。
- Web preview 的 `?pluginHostSmoke=browserWindow` 增加父到子 IPC 路径：父 iframe 调用 `win.webContents.send("ping", { value: 42 }, "payload")`，子 iframe 通过 `ipcRenderer.on("ping")` 校验 payload，并自动 `sendToParent("browser-window-ipc", ...)` 回传父 iframe。

TDD 记录：

- 扩展 `scripts/test-plugin-window-browser-bridge.mjs`：要求 BrowserWindow handle 暴露 `webContents.send()`，并验证其经 `browserWindowAction` 发送 action `webContents.send` 和正确参数。
- 增加子窗口 VM 回归：要求 hosted child bridge 暴露 `require("electron").ipcRenderer`，验证 `on()` / `once()` / `off()` 监听语义，父侧 `__atools_browser_window_ipc__` 消息只触发有效 listener。
- 增加宿主静态断言：要求存在 `dispatchPluginBrowserWindowIpcMessage()` 和 `__atools_browser_window_ipc__` 分发标记。
- 增加 Web preview 静态断言：要求 smoke 包含 `win.webContents.send()` 和 child `ipcRenderer.on()`。
- 初次红灯：`pnpm test:plugin-window-browser-bridge` 失败在 `browser-window handle should expose webContents`。
- 中间红灯：加入 `webContents` 后因属性可枚举导致既有 plain handle 断言失败；改为非枚举属性后回归转绿。

验证：

```bash
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-host-view
pnpm test:plugin-window-page-search
pnpm test:plugin-window-lifecycle
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-window-browser-bridge`：红/绿通过，最终回归通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-window-page-search`：通过。
- `pnpm test:plugin-window-lifecycle`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed；Vite 仍提示部分 chunk 超过 500 kB，命令退出码为 0。
- Browser 检查：`http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=226` 标题为 `ATools 3.0`，最终子窗口数量为 1、标题为 `子窗口已更新`、header URL 为 `child-reloaded.html`、class 包含 `positioned focused alwaysOnTop`，inline style 为 `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3003;`，`webContents.send` accepted 为 `true`，子 iframe `data-child-ipc-ping` 为 `true`，父 iframe callback channel 为 `browser-window-ipc`，父 iframe 状态文本为 `browser-window-ipc:browserWindow`，`plugin-browser-window-progress` 已清除，无 Vite/framework error overlay。
- Browser dev logs 仍出现既有 `MutationObserver` TypeError 噪声；本轮 DOM、frameLocator 和截图均未出现 framework error overlay，且目标 iframe IPC state 已明确为 true。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:64512"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`agent_tools_count:8`，插件 runtime `context_bridge_checked:true`，`browser_context_checked:true`，`finder_context_checked:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:64512`。
- 端口清理确认：`1420` 和 `64512` 均无残留监听。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 73% | 74% | BrowserWindow hosted `webContents.send()` 可投递到指定子 iframe，子窗口可通过最小 `ipcRenderer.on()` 兼容层接收，并能继续通过 `sendToParent()` 回调父插件 iframe |
| 插件 runtime parity | 99% | 99% | BrowserWindow handle 表面继续扩展，但真实 native BrowserWindow、完整 WebContents API、更多 OS 级事件/生命周期、startDrag、native 右键菜单和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展 browser-window IPC 专项回归、Browser frameLocator smoke，并回归真实桌面 smoke |

当前重点剩余：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. 插件窗口：本批只补 hosted `webContents.send` / child `ipcRenderer.on`，不是完整 Electron WebContents，也不包含 `executeJavaScript()`、`sendInputEvent()`、capture、navigation history 等 native WebContents 表面。
3. 插件交互：native 右键菜单、拖拽、更复杂 iframe 交互和真实第三方插件兼容仍需专项回归。

## Batch 225：BrowserWindow hosted sizing constraints handle

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批延续宿主内 browser-window handle，补齐 Electron BrowserWindow 继承表面里的 content size、minimum/maximum size 和 aspect-ratio sizing 方法：`getContentSize()` / `setContentSize()`、`getMinimumSize()` / `setMinimumSize()`、`getMaximumSize()` / `setMaximumSize()`、`setAspectRatio()`。范围仍限定为当前 PluginPanel 宿主内子 iframe；这里的 content size、min/max constraint 和 aspect ratio 是 hosted shell 兼容状态，不伪装 OS 级 native content bounds、用户拖拽约束或原生窗口 chrome。

状态：DONE。

参考依据：

- [uTools 窗口 API 文档](https://www.u-tools.cn/docs/developer/api-reference/utools/window.html)说明 `createBrowserWindow()` 返回的 BrowserWindow 由 uTools 定制，大部分函数和属性继承 Electron BrowserWindow。
- [Electron BrowserWindow 文档](https://www.electronjs.org/docs/latest/api/browser-window)包含 `setContentSize()` / `getContentSize()`、`setMinimumSize()` / `getMinimumSize()`、`setMaximumSize()` / `getMaximumSize()` 和 `setAspectRatio()`。

修改文件：

- `src/components/PluginPanel.svelte`
- `src/App.svelte`
- `scripts/test-plugin-window-browser-bridge.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 注入桥新增 BrowserWindow handle 方法：`getContentSize()`、`setContentSize(width, height, animate)`、`getMinimumSize()`、`setMinimumSize(width, height)`、`getMaximumSize()`、`setMaximumSize(width, height)`、`setAspectRatio(aspectRatio, extraSize)`。
- PluginPanel 新增 hosted child window `minimumWidth` / `minimumHeight` / `maximumWidth` / `maximumHeight` / `aspectRatio` / `aspectRatioExtraSize` state。
- 新增 `normalizePluginBrowserWindowSize()` 和 `constrainPluginBrowserWindowSize()`；`setBounds()`、`setSize()`、`setContentSize()` 共用 hosted size constraint 路径。
- `setMinimumSize()` / `setMaximumSize()` 会更新约束并把当前 hosted child window 尺寸钳制到有效范围；`getMinimumSize()` / `getMaximumSize()` 返回当前约束数组。
- `setAspectRatio()` 记录 hosted aspect-ratio 兼容状态；按照 Electron 文档，程序化 `setSize()` / `setContentSize()` 不强制套用 aspect ratio。
- Web preview 的 `?pluginHostSmoke=browserWindow` 增加 content-size、min/max-size 和 aspect-ratio 路径：先改到 `390x240` 并读回，再设置 `360x220` min 和 `900x640` max，记录 `16/9` aspect ratio，最后恢复最终 `420x260` 子窗口。

TDD 记录：

- 扩展 `scripts/test-plugin-window-browser-bridge.mjs`：要求 BrowserWindow handle 暴露 sizing constraint 方法，并验证这些方法都经 `browserWindowAction` 发送正确 action 和参数。
- 增加宿主静态断言：要求 `PluginBrowserWindowState` 记录 minimum/maximum/aspect-ratio state，并存在 `normalizePluginBrowserWindowSize()` / `constrainPluginBrowserWindowSize()`。
- 增加 Web preview 静态断言：要求 smoke 包含 `win.setContentSize()` / `win.getContentSize()`、`win.setMinimumSize()` / `win.getMinimumSize()`、`win.setMaximumSize()` / `win.getMaximumSize()` 和 `win.setAspectRatio()`。
- 初次红灯：`pnpm test:plugin-window-browser-bridge` 失败在 `browser-window handle should expose getContentSize()`。
- 实现后回归转绿。

验证：

```bash
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-host-view
pnpm test:plugin-window-page-search
pnpm test:plugin-window-lifecycle
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-window-browser-bridge`：红/绿通过，最终回归通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-window-page-search`：通过。
- `pnpm test:plugin-window-lifecycle`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed；Vite 仍提示部分 chunk 超过 500 kB，命令退出码为 0。
- Browser 检查：`http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=225` 标题为 `ATools 3.0`，最终子窗口数量为 1、标题为 `子窗口已更新`、header URL 为 `child-reloaded.html`、class 包含 `positioned focused alwaysOnTop`，inline style 为 `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3003;`，computed size 为 `420px x 260px`，computed z-index 为 `3003`，`plugin-browser-window-progress` 已清除，无 Vite/framework error overlay。
- `pnpm smoke:tauri-desktop`：第一次因手动 Web preview 占用 `1420` 失败；停止预览服务后重跑通过，`status:"ok"`，`mcp_bind:"127.0.0.1:56973"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`agent_tools_count:8`，插件 runtime `context_bridge_checked:true`，`browser_context_checked:true`，`finder_context_checked:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:56973`。
- 端口清理确认：`1420` 和 `56973` 均无残留监听。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 72% | 73% | BrowserWindow hosted content size、minimum/maximum size 和 aspect-ratio 方法可查询、更新和渲染约束，最终 smoke 仍恢复主子窗口到 `420x260` |
| 插件 runtime parity | 99% | 99% | BrowserWindow handle 表面继续扩展，但真实 native BrowserWindow、OS 级 content bounds/window chrome、用户拖拽 aspect-ratio 约束、更多 OS 级事件/生命周期、startDrag、native 右键菜单和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展 browser-window sizing constraints 专项回归、Browser DOM smoke，并回归真实桌面 smoke |

当前重点剩余：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. 插件窗口：本批是宿主内 sizing constraints state，不是系统级独立 native BrowserWindow content bounds、window chrome 或用户拖拽 aspect-ratio 约束；真实独立窗口仍需后续 native window host。
3. 插件交互：output 层右键复制、iframe contextmenu 上报、browser-window parent message 和常用 handle 方法已覆盖；native 右键菜单、拖拽和更复杂复制/菜单路径仍需真实插件专项回归。
4. 插件资源兼容：完整 SPA/router 运行态、history API 行为和真实第三方插件包仍需专项回归。
5. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 224：BrowserWindow hosted z-order/media-source handle

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批延续宿主内 browser-window handle，补齐 Electron BrowserWindow 继承表面里的窗口层级和媒体源标识方法：`getMediaSourceId()`、`moveTop()` 和 `moveAbove(mediaSourceId)`。范围仍限定为当前 PluginPanel 宿主内子 iframe；这里的 media source id 和 z-order 是 hosted shell 兼容状态，不伪装 OS 级 DesktopCapturerSource 或 native window stacking。

状态：DONE。

参考依据：

- [uTools 窗口 API 文档](https://www.u-tools.cn/docs/developer/api-reference/utools/window.html)说明 `createBrowserWindow()` 返回的 BrowserWindow 由 uTools 定制，大部分函数和属性继承 Electron BrowserWindow。
- [Electron BrowserWindow 文档](https://www.electronjs.org/docs/latest/api/browser-window)包含 `getMediaSourceId()`、`moveTop()` 和 `moveAbove(mediaSourceId)`。

修改文件：

- `src/components/PluginPanel.svelte`
- `src/App.svelte`
- `scripts/test-plugin-window-browser-bridge.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 注入桥新增 BrowserWindow handle 方法：`getMediaSourceId()`、`moveTop()`、`moveAbove(mediaSourceId)`。
- PluginPanel 新增 hosted child window `mediaSourceId` / `zOrder` state；每个 hosted child window 创建时获得稳定 `window:<seq>:0` 兼容 source id。
- `pluginBrowserWindowLayer()` 现在将 hosted `zOrder` 写入子窗口 z-index；`alwaysOnTop` / `focused` 仍保留基础层级语义。
- `moveTop()` 会把目标 hosted child window 移到当前宿主 z-order 顶层。
- `moveAbove(mediaSourceId)` 会验证参照 source id 存在，再把目标 hosted child window 移到参照窗口之上；参照不存在时返回明确错误，不假成功。
- Web preview 的 `?pluginHostSmoke=browserWindow` 增加 `getMediaSourceId()`、`moveTop()`、临时参照子窗口、`moveAbove(sourceId)`、关闭参照子窗口代表路径，并继续跑现有 URL、窗口状态、events、bounds、capability flags、full-screen、appearance、system-state、focus/attention/progress、title 和 always-on-top smoke。

TDD 记录：

- 扩展 `scripts/test-plugin-window-browser-bridge.mjs`：要求 BrowserWindow handle 暴露 `getMediaSourceId()`、`moveTop()`、`moveAbove()`，并验证这些方法都经 `browserWindowAction` 发送正确 action 和参数。
- 增加宿主静态断言：要求 `PluginBrowserWindowState` 记录 `mediaSourceId` / `zOrder`，并存在 `pluginBrowserWindowLayer()`。
- 增加 Web preview 静态断言：要求 smoke 包含 `win.getMediaSourceId()`、`win.moveTop()`、`win.moveAbove()`。
- 初次红灯：`pnpm test:plugin-window-browser-bridge` 失败在 `browser-window handle should expose getMediaSourceId()`。
- 实现后回归转绿。

验证：

```bash
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-host-view
pnpm test:plugin-window-page-search
pnpm test:plugin-window-lifecycle
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-window-browser-bridge`：红/绿通过，最终回归通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-window-page-search`：通过。
- `pnpm test:plugin-window-lifecycle`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed；Vite 仍提示部分 chunk 超过 500 kB，命令退出码为 0。
- Browser 交互检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=224` 标题为 `ATools 3.0`，最终子窗口数量为 1、标题为 `子窗口已更新`、header URL 为 `child-reloaded.html`、class 包含 `positioned focused alwaysOnTop` 且不残留 `flashing/kiosk/fullScreen/minimized/maximized/noShadow`，inline style 为 `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3003;`，computed z-index 为 `3003`，`plugin-browser-window-progress` 已清除，无 framework overlay。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:52378"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`agent_tools_count:8`，插件 runtime `context_bridge_checked:true`，`browser_context_checked:true`，`finder_context_checked:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:52378`。退出阶段仍有 Vite EPIPE / server closing 停服日志，但命令退出码为 0。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 71% | 72% | BrowserWindow hosted media source id 和 z-order 方法可查询、更新和渲染，最终 smoke 会验证临时参照窗口关闭后只保留主子窗口 |
| 插件 runtime parity | 99% | 99% | BrowserWindow handle 表面继续扩展，但真实 native BrowserWindow、OS 级 DesktopCapturerSource/native z-order、更多 OS 级事件/生命周期、startDrag、native 右键菜单和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展 browser-window z-order/media-source 专项回归、Browser 交互 smoke，并回归真实桌面 smoke |

当前重点剩余：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. 插件窗口：本批是宿主内 media-source/z-order state，不是系统级独立 native BrowserWindow DesktopCapturerSource 或 native z-order；真实独立窗口仍需后续 native window host。
3. 插件交互：output 层右键复制、iframe contextmenu 上报、browser-window parent message 和常用 handle 方法已覆盖；native 右键菜单、拖拽和更复杂复制/菜单路径仍需真实插件专项回归。
4. 插件资源兼容：完整 SPA/router 运行态、history API 行为和真实第三方插件包仍需专项回归。
5. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 223：BrowserWindow hosted focus/attention/progress handle

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批延续宿主内 browser-window handle，补齐 Electron BrowserWindow 继承表面里一组低副作用状态方法：`focusable`、`flashFrame` 和 `setProgressBar`。范围仍限定为当前 PluginPanel 宿主内子 iframe；这里的 flashing/progress 表示 hosted shell 的注意力和进度状态，不伪装 OS 级 Dock/taskbar 原生闪烁或进度条。

状态：DONE。

参考依据：

- [uTools 窗口 API 文档](https://www.u-tools.cn/docs/developer/api-reference/utools/window.html)说明 `createBrowserWindow()` 返回的 BrowserWindow 由 uTools 定制，大部分函数和属性继承 Electron BrowserWindow。
- [Electron BrowserWindow 文档](https://www.electronjs.org/docs/latest/api/browser-window)包含 `setFocusable()` / `isFocusable()`、`flashFrame()` 和 `setProgressBar()`。

修改文件：

- `src/components/PluginPanel.svelte`
- `src/App.svelte`
- `scripts/test-plugin-window-browser-bridge.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 注入桥新增 BrowserWindow handle 方法：`setFocusable()` / `isFocusable()`、`flashFrame()`、`setProgressBar()`。
- PluginPanel 新增 hosted child window `focusable` / `flashing` / `progressBar` / `progressBarMode` state，并从 `createBrowserWindow()` options 初始化 `focusable`。
- `setFocusable(false)` 会影响后续 hosted `show()` / `focus()` 的聚焦结果；当前不会伪造 OS 级窗口 focusability。
- `flashFrame(true)` 通过 hosted `flashing` class 高亮子窗口壳层；`flashFrame(false)` 清除该 class。
- `setProgressBar(progress, options)` 会按 Electron 进度语义记录 hosted progress：`progress < 0` 清除，`progress > 1` 进入 indeterminate，`0..1` 显示标题栏下方细进度条，并支持 `normal/error/paused/indeterminate/none` mode。
- Web preview 的 `?pluginHostSmoke=browserWindow` 增加 focusable、flashFrame 和 progressBar 代表路径，并继续跑现有 URL、窗口状态、events、bounds、capability flags、full-screen、appearance、system-state、title 和 always-on-top smoke。

TDD 记录：

- 扩展 `scripts/test-plugin-window-browser-bridge.mjs`：要求 BrowserWindow handle 暴露 `setFocusable()` / `isFocusable()`、`flashFrame()`、`setProgressBar()`，并验证这些方法都经 `browserWindowAction` 发送正确 action 和参数。
- 增加宿主静态断言：要求 `PluginBrowserWindowState` 记录 `focusable` / `flashing` / `progressBar` / `progressBarMode`。
- 增加渲染静态断言：要求 hosted child window 存在 `class:flashing={childWindow.flashing}` 和 `plugin-browser-window-progress`。
- 增加 Web preview 静态断言：要求 smoke 包含 `win.setFocusable(...)`、`win.isFocusable(...)`、`win.flashFrame(...)`、`win.setProgressBar(...)`。
- 初次红灯：`pnpm test:plugin-window-browser-bridge` 失败在 `browser-window handle should expose setFocusable()`。
- 实现后回归转绿。

验证：

```bash
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-host-view
pnpm test:plugin-window-page-search
pnpm test:plugin-window-lifecycle
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-window-browser-bridge`：红/绿通过，最终回归通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-window-page-search`：通过。
- `pnpm test:plugin-window-lifecycle`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed；Vite 仍提示部分 chunk 超过 500 kB，命令退出码为 0。
- Browser 交互检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=223` 标题为 `ATools 3.0`，最终子窗口数量为 1、标题为 `子窗口已更新`、header URL 为 `child-reloaded.html`、class 包含 `focused positioned alwaysOnTop` 且不残留 `flashing/kiosk/fullScreen/minimized/maximized/noShadow`，inline style 为 `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3;`，computed opacity 为 `1`，`plugin-browser-window-progress` 已清除。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:65136"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`agent_tools_count:8`，插件 runtime `context_bridge_checked:true`，`browser_context_checked:true`，`finder_context_checked:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:65136`。退出阶段仍有 Vite EPIPE 停服日志，但命令退出码为 0。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 70% | 71% | BrowserWindow hosted focusable、flashFrame 和 progressBar 状态可设置、查询或渲染，最终 smoke 会验证恢复后无 flashing/progress 残留 |
| 插件 runtime parity | 99% | 99% | BrowserWindow handle 表面继续扩展，但真实 native BrowserWindow、OS 级 Dock/taskbar flashing/progress、更多 OS 级事件/生命周期、startDrag、native 右键菜单和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展 browser-window focus/attention/progress 专项回归、Browser 交互 smoke，并回归真实桌面 smoke |

当前重点剩余：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. 插件窗口：本批是宿主内 focus/attention/progress state，不是系统级独立 native BrowserWindow focusability、Dock/taskbar flash 或 Dock/taskbar progress；真实独立窗口仍需后续 native window host。
3. 插件交互：output 层右键复制、iframe contextmenu 上报、browser-window parent message 和常用 handle 方法已覆盖；native 右键菜单、拖拽和更复杂复制/菜单路径仍需真实插件专项回归。
4. 插件资源兼容：完整 SPA/router 运行态、history API 行为和真实第三方插件包仍需专项回归。
5. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 222：BrowserWindow hosted system-state handle

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批延续宿主内 browser-window handle，补齐 Electron BrowserWindow 继承表面里一组系统状态方法：skip-taskbar、kiosk、visible-on-all-workspaces 和 content-protection 的设置/查询。范围仍限定为当前 PluginPanel 宿主内子 iframe；这里的 taskbar/kiosk/workspace/content-protection 是 hosted shell state，不伪装 OS 级独立 native BrowserWindow 能力。

状态：DONE。

参考依据：

- [uTools 窗口 API 文档](https://www.u-tools.cn/docs/developer/api-reference/utools/window.html)说明 `createBrowserWindow()` 返回的 BrowserWindow 由 uTools 定制，大部分函数和属性继承 Electron BrowserWindow。
- [Electron BrowserWindow 文档](https://www.electronjs.org/docs/latest/api/browser-window)包含 `setSkipTaskbar()`、`setKiosk()` / `isKiosk()`、`setVisibleOnAllWorkspaces()` / `isVisibleOnAllWorkspaces()`、`setContentProtection()` / `isContentProtected()`。

修改文件：

- `src/components/PluginPanel.svelte`
- `src/App.svelte`
- `scripts/test-plugin-window-browser-bridge.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 注入桥新增 BrowserWindow handle 方法：`setSkipTaskbar()`、`setKiosk()` / `isKiosk()`、`setVisibleOnAllWorkspaces()` / `isVisibleOnAllWorkspaces()`、`setContentProtection()` / `isContentProtected()`。
- PluginPanel 新增 hosted child window `skipTaskbar` / `kiosk` / `visibleOnAllWorkspaces` / `contentProtected` state，并从 `createBrowserWindow()` options 初始化。
- `browserWindowAction` 新增系统状态查询和更新路由，所有新增 handle 方法都经宿主 bridge，不只改本地 JS handle。
- `setKiosk(true)` 会让 hosted child window 填满当前 browser-window layer、聚焦窗口并清理 minimized/maximized state；`setKiosk(false)` 后 Web preview 会恢复到正常 bounds。
- Web preview 的 `?pluginHostSmoke=browserWindow` 增加 skip-taskbar、kiosk、visible-on-all-workspaces、content-protection 代表路径，并继续跑现有 URL、窗口状态、events、bounds、capability flags、full-screen、appearance、title、always-on-top 和 parent message smoke。

TDD 记录：

- 扩展 `scripts/test-plugin-window-browser-bridge.mjs`：要求 BrowserWindow handle 暴露 system-state 方法，并验证 `setSkipTaskbar`、`setKiosk` / `isKiosk`、`setVisibleOnAllWorkspaces` / `isVisibleOnAllWorkspaces`、`setContentProtection` / `isContentProtected` 都经 `browserWindowAction` 发送正确 action 和参数。
- 增加宿主静态断言：要求 `PluginBrowserWindowState` 记录 `skipTaskbar` / `kiosk` / `visibleOnAllWorkspaces` / `contentProtected`。
- 增加渲染静态断言：要求 hosted child window 存在 `class:kiosk={childWindow.kiosk}`。
- 增加 Web preview 静态断言：要求 smoke 包含 `win.setSkipTaskbar(...)`、`win.setKiosk(...)`、`win.isKiosk(...)`、`win.setVisibleOnAllWorkspaces(...)`、`win.isVisibleOnAllWorkspaces(...)`、`win.setContentProtection(...)`、`win.isContentProtected(...)`。
- 初次红灯：`pnpm test:plugin-window-browser-bridge` 失败在 `browser-window handle should expose setSkipTaskbar()`。
- 实现后回归转绿。

验证：

```bash
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-host-view
pnpm test:plugin-window-page-search
pnpm test:plugin-window-lifecycle
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-window-browser-bridge`：红/绿通过，最终回归通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-window-page-search`：通过。
- `pnpm test:plugin-window-lifecycle`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 交互检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=222` 标题为 `ATools 3.0`，最终子窗口数量为 1、标题为 `子窗口已更新`、header URL 为 `child-reloaded.html`、class 包含 `focused positioned alwaysOnTop` 且不残留 `kiosk/fullScreen/minimized/maximized/noShadow`，inline style 为 `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3;`，computed opacity 为 `1`；真实坐标点击子窗口按钮后状态条变为 `Browser 窗口 1 个 最近消息 browser-window-message +1`，无 framework overlay。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:61892"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`agent_tools_count:8`，插件 runtime `context_bridge_checked:true`，`browser_context_checked:true`，`finder_context_checked:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:61892`。退出阶段仍有 Vite EPIPE 停服日志，但命令退出码为 0。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 69% | 70% | BrowserWindow hosted system-state 方法可设置、查询和渲染，最终 smoke 会验证 kiosk 恢复后无 class/style 残留 |
| 插件 runtime parity | 99% | 99% | BrowserWindow handle 表面继续扩展，但真实 native BrowserWindow、OS 级 taskbar/kiosk/workspace/screen-capture protection、更多 OS 级事件/生命周期、startDrag、native 右键菜单和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展 browser-window system-state 专项回归、Browser 交互 smoke，并回归真实桌面 smoke |

当前重点剩余：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. 插件窗口：本批是宿主内 system-state，不是系统级独立 native BrowserWindow taskbar/kiosk/workspace/screen-capture protection；外部窗口、OS 级 kiosk/workspace 行为和真实独立窗口仍需后续 native window host。
3. 插件交互：output 层右键复制、iframe contextmenu 上报、browser-window parent message 和常用 handle 方法已覆盖；native 右键菜单、拖拽和更复杂复制/菜单路径仍需真实插件专项回归。
4. 插件资源兼容：完整 SPA/router 运行态、history API 行为和真实第三方插件包仍需专项回归。
5. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 221：BrowserWindow hosted appearance handle

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批延续宿主内 browser-window handle，补齐 Electron BrowserWindow 继承表面里的外观状态方法：`opacity` 和 `hasShadow` 的查询、设置与宿主渲染。范围仍限定为当前 PluginPanel 宿主内子 iframe；这里的 opacity/shadow 表示宿主内窗口壳层 CSS 状态，不伪装系统级独立 native BrowserWindow 外观能力。

状态：DONE。

参考依据：

- [uTools 窗口 API 文档](https://www.u-tools.cn/docs/developer/api-reference/utools/window.html)说明 `createBrowserWindow()` 返回的 BrowserWindow 由 uTools 定制，大部分函数和属性继承 Electron BrowserWindow。
- [Electron BrowserWindow 文档](https://www.electronjs.org/docs/latest/api/browser-window)包含 `setOpacity()` / `getOpacity()`、`setHasShadow()` / `hasShadow()` / `invalidateShadow()`。

修改文件：

- `src/components/PluginPanel.svelte`
- `src/App.svelte`
- `scripts/test-plugin-window-browser-bridge.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 注入桥新增 BrowserWindow handle 方法：`getOpacity()` / `setOpacity()`、`hasShadow()` / `setHasShadow()` / `invalidateShadow()`。
- PluginPanel 新增 hosted child window `opacity` / `hasShadow` state，并从 `createBrowserWindow()` options 初始化；opacity 会按 Electron 语义约束到 `[0, 1]`。
- `browserWindowAction` 新增外观状态查询和更新路由，所有新增 handle 方法都经宿主 native bridge。
- 非 1 opacity 会写入宿主子窗口 inline style；恢复 `setOpacity(1)` 后最终 style 不残留 opacity。
- `hasShadow:false` 会通过 `noShadow` class 关闭宿主子窗口阴影；恢复 `setHasShadow(true)` 后最终 class 不残留。
- Web preview 的 `?pluginHostSmoke=browserWindow` 增加 `setOpacity(0.72)` / `getOpacity()` / `setOpacity(1)`、`setHasShadow(false)` / `hasShadow()` / `setHasShadow(true)` / `invalidateShadow()` 代表路径，并继续跑现有 URL、窗口状态、events、bounds、capability flags、full-screen、title、always-on-top 和 parent message smoke。

TDD 记录：

- 扩展 `scripts/test-plugin-window-browser-bridge.mjs`：要求 BrowserWindow handle 暴露 appearance 方法，并验证 `setOpacity` / `getOpacity` / `setHasShadow` / `hasShadow` / `invalidateShadow` 都经 `browserWindowAction` 发送正确 action 和参数。
- 增加宿主静态断言：要求 `PluginBrowserWindowState` 记录 `opacity` / `hasShadow`，并存在 `class:noShadow={!childWindow.hasShadow}`。
- 增加 Web preview 静态断言：要求 smoke 包含 `win.setOpacity(...)` / `win.getOpacity(...)` / `win.setHasShadow(...)` / `win.hasShadow(...)`。
- 初次红灯：`pnpm test:plugin-window-browser-bridge` 失败在 `browser-window handle should expose getOpacity()`。
- 实现后回归转绿。

验证：

```bash
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-host-view
pnpm test:plugin-window-page-search
pnpm test:plugin-window-lifecycle
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-window-browser-bridge`：红/绿通过，最终回归通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-window-page-search`：通过。
- `pnpm test:plugin-window-lifecycle`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 交互检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=221` 标题为 `ATools 3.0`，最终子窗口数量为 1、标题为 `子窗口已更新`、header URL 为 `child-reloaded.html`、class 包含 `focused positioned alwaysOnTop` 且不残留 `fullScreen/minimized/maximized/noShadow`，inline style 为 `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3;`，computed opacity 为 `1`；真实坐标点击子窗口按钮后状态条变为 `Browser 窗口 1 个 最近消息 browser-window-message +1`，无 framework overlay。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:55729"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，插件 runtime `context_bridge_checked:true`，`browser_context_checked:true`，`finder_context_checked:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:55729`。退出阶段仍有 Vite/esbuild 停服日志，但命令退出码为 0。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 68% | 69% | BrowserWindow hosted opacity/shadow 外观状态可查询、更新和渲染，最终 smoke 会验证恢复后无样式残留 |
| 插件 runtime parity | 99% | 99% | BrowserWindow handle 表面继续扩展，但真实 native BrowserWindow、OS 级外观能力、更多 OS 级事件/生命周期、startDrag、native 右键菜单和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展 browser-window appearance 专项回归、Browser 交互 smoke，并回归真实桌面 smoke |

当前重点剩余：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. 插件窗口：本批是宿主内 CSS appearance state，不是系统级独立 native BrowserWindow opacity/shadow；外部窗口、OS 级阴影重算和真实独立窗口仍需后续 native window host。
3. 插件交互：output 层右键复制、iframe contextmenu 上报、browser-window parent message 和常用 handle 方法已覆盖；native 右键菜单、拖拽和更复杂复制/菜单路径仍需真实插件专项回归。
4. 插件资源兼容：完整 SPA/router 运行态、history API 行为和真实第三方插件包仍需专项回归。
5. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 220：BrowserWindow hosted full-screen handle

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批延续宿主内 browser-window handle，补齐 hosted full-screen 表面：`fullScreen` / `fullScreenable` 的查询与设置，以及对应的宿主内 full-screen class 和事件派发。范围仍限定为当前 PluginPanel 宿主内子 iframe；这里的 full-screen 表示填满当前插件宿主层，不伪装系统级独立 native BrowserWindow 全屏。

状态：DONE。

修改文件：

- `src/components/PluginPanel.svelte`
- `src/App.svelte`
- `scripts/test-plugin-window-browser-bridge.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 注入桥新增 BrowserWindow handle 方法：`isFullScreen()` / `setFullScreen()`、`isFullScreenable()` / `setFullScreenable()`。
- PluginPanel 新增 hosted child window `fullScreen` / `fullScreenable` state，并从 `createBrowserWindow()` options 初始化；`fullScreenable:false` 会阻止进入 hosted full-screen。
- `browserWindowAction` 新增 full-screen 查询和更新路由，进入 full-screen 会清理 minimized/maximized、显示并聚焦子窗口，退出 full-screen 会恢复宿主内普通 bounds 渲染。
- 宿主内子窗口 full-screen 复用 fill-layer 样式，并通过 `class:fullScreen={childWindow.fullScreen}` 反映渲染状态。
- hosted full-screen 状态切换会派发 `enter-full-screen` / `leave-full-screen` 事件。
- Web preview 的 `?pluginHostSmoke=browserWindow` 增加 `setFullScreen(true)` / `isFullScreen()` / `setFullScreen(false)` / `isFullScreen()` 代表路径，并继续跑现有 URL、窗口状态、events、bounds、capability flags、title、always-on-top 和 parent message smoke。

TDD 记录：

- 扩展 `scripts/test-plugin-window-browser-bridge.mjs`：要求 BrowserWindow handle 暴露 full-screen 方法，并验证 `setFullScreen` / `isFullScreen` / `setFullScreenable` / `isFullScreenable` 都经 `browserWindowAction` 发送正确 action 和参数。
- 增加宿主静态断言：要求 `PluginBrowserWindowState` 记录 `fullScreen` / `fullScreenable`，并存在 `class:fullScreen={childWindow.fullScreen}`。
- 增加 Web preview 静态断言：要求 smoke 包含 `win.setFullScreen(...)` 和 `win.isFullScreen(...)`。
- 初次红灯：`pnpm test:plugin-window-browser-bridge` 失败在 `browser-window handle should expose isFullScreen()`。
- 实现后回归转绿。

验证：

```bash
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-host-view
pnpm test:plugin-window-page-search
pnpm test:plugin-window-lifecycle
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-window-browser-bridge`：红/绿通过，最终回归通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-window-page-search`：通过。
- `pnpm test:plugin-window-lifecycle`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 交互检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=220` 标题为 `ATools 3.0`，最终子窗口数量为 1、标题为 `子窗口已更新`、header URL 为 `child-reloaded.html`、class 包含 `focused positioned alwaysOnTop` 且不残留 `fullScreen/minimized/maximized`，inline style 为 `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3;`；真实坐标点击子窗口按钮后状态条变为 `Browser 窗口 1 个 最近消息 browser-window-message +1`，无 framework overlay。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:50701"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，插件 runtime `context_bridge_checked:true`，`browser_context_checked:true`，`finder_context_checked:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:50701`。退出阶段仍有 Vite/esbuild 停服日志，但命令退出码为 0。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 67% | 68% | BrowserWindow hosted full-screen state 可查询、更新和渲染，并派发 `enter-full-screen` / `leave-full-screen` 事件 |
| 插件 runtime parity | 99% | 99% | BrowserWindow handle 表面继续扩展，但真实 native BrowserWindow、OS 级 fullscreen、更多 OS 级事件/生命周期、startDrag、native 右键菜单和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展 browser-window full-screen 专项回归、Browser 交互 smoke，并回归真实桌面 smoke |

当前重点剩余：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. 插件窗口：本批是宿主内 full-screen shell state，不是系统级独立 native BrowserWindow fullscreen；外部焦点、OS 级窗口约束和真实独立窗口仍需后续 native window host。
3. 插件交互：output 层右键复制、iframe contextmenu 上报、browser-window parent message 和常用 handle 方法已覆盖；native 右键菜单、拖拽和更复杂复制/菜单路径仍需真实插件专项回归。
4. 插件资源兼容：完整 SPA/router 运行态、history API 行为和真实第三方插件包仍需专项回归。
5. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 219：BrowserWindow capability flag handle

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批延续宿主内 browser-window handle，补齐窗口 capability flag 表面：`resizable`、`movable`、`closable`、`minimizable`、`maximizable` 的查询与设置。范围仍限定为当前 PluginPanel 宿主内子 iframe；这些 flag 表示宿主内窗口壳层状态，不伪装系统级独立 native BrowserWindow 行为。

状态：DONE。

修改文件：

- `src/components/PluginPanel.svelte`
- `src/App.svelte`
- `scripts/test-plugin-window-browser-bridge.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 注入桥新增 BrowserWindow handle 方法：`isResizable()` / `setResizable()`、`isMovable()` / `setMovable()`、`isClosable()` / `setClosable()`、`isMinimizable()` / `setMinimizable()`、`isMaximizable()` / `setMaximizable()`。
- PluginPanel 新增 hosted child window capability state，并从 `createBrowserWindow()` options 初始化，默认均为 `true`，显式 `false` 时关闭对应能力。
- `browserWindowAction` 新增 capability 查询和更新路由，所有新增 handle 方法都经宿主 native bridge。
- 宿主内子窗口关闭按钮会根据 `closable` 禁用，并保留程序化 `close()` handle 行为。
- Web preview 的 `?pluginHostSmoke=browserWindow` 增加 `setResizable(false)` / `isResizable()` / `setResizable(true)` 代表路径，并继续跑现有 URL、窗口状态、events、bounds、title、always-on-top 和 parent message smoke。

TDD 记录：

- 扩展 `scripts/test-plugin-window-browser-bridge.mjs`：要求 BrowserWindow handle 暴露 capability flag 方法，并验证每个 `set*` / `is*` 都经 `browserWindowAction` 发送正确 action 和参数。
- 增加宿主静态断言：要求 `PluginBrowserWindowState` 记录 `resizable` / `movable` / `closable` / `minimizable` / `maximizable`。
- 增加 Web preview 静态断言：要求 smoke 包含 `win.setResizable(...)` 和 `win.isResizable(...)`。
- 初次红灯：`pnpm test:plugin-window-browser-bridge` 失败在 `browser-window handle should expose isResizable()`。
- 实现后回归转绿。

验证：

```bash
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-host-view
pnpm test:plugin-window-page-search
pnpm test:plugin-window-lifecycle
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-window-browser-bridge`：红/绿通过，最终回归通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-window-page-search`：通过。
- `pnpm test:plugin-window-lifecycle`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 交互检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=219` 标题为 `ATools 3.0`，最终子窗口数量为 1、标题为 `子窗口已更新`、header URL 为 `child-reloaded.html`、class 包含 `focused positioned alwaysOnTop`，inline style 为 `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3;`，实际 rect 为 `420x260`，关闭按钮恢复可用；真实坐标点击子窗口按钮后状态条变为 `Browser 窗口 1 个 最近消息 browser-window-message +1`，无 framework overlay。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:64930"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，插件 runtime `context_bridge_checked:true`，`browser_context_checked:true`，`finder_context_checked:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:64930`。退出阶段仍有 Vite `EPIPE` 停服日志，但命令退出码为 0。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 66% | 67% | BrowserWindow hosted capability flags 可查询和更新，`closable` 已影响宿主内子窗口关闭按钮禁用态 |
| 插件 runtime parity | 99% | 99% | BrowserWindow handle 表面继续扩展，但真实 native BrowserWindow、更多 OS 级事件/生命周期、startDrag、native 右键菜单和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展 browser-window capability 专项回归、Browser 交互 smoke，并回归真实桌面 smoke |

当前重点剩余：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. 插件窗口：本批是宿主内 capability flag state，不是系统级独立 native BrowserWindow；外部焦点、OS 级窗口约束和真实独立窗口仍需后续 native window host。
3. 插件交互：output 层右键复制、iframe contextmenu 上报、browser-window parent message 和常用 handle 方法已覆盖；native 右键菜单、拖拽和更复杂复制/菜单路径仍需真实插件专项回归。
4. 插件资源兼容：完整 SPA/router 运行态、history API 行为和真实第三方插件包仍需专项回归。
5. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 218：BrowserWindow geometry event routing

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批延续宿主内 browser-window EventEmitter 路径，把几何变化 action 纳入事件派发：`setBounds()` / `setSize()` / `setPosition()` / `center()` 不再只更新宿主 shell 状态，也会把 hosted `resize` / `move` 事件派发给父插件 iframe 内对应 handle。范围仍限定为当前 PluginPanel 宿主内子 iframe；事件来自宿主内几何 action 状态，不伪装系统级独立 native BrowserWindow 事件流。

状态：DONE。

修改文件：

- `src/components/PluginPanel.svelte`
- `src/App.svelte`
- `scripts/test-plugin-window-browser-bridge.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `setBounds()` 更新 hosted child bounds 后派发 `resize` 和 `move` 事件，事件 payload 带上尺寸、位置和规范化后的 bounds。
- `setSize()` 更新 hosted child size 后派发 `resize` 事件。
- `setPosition()` 更新 hosted child position 后派发 `move` 事件。
- `center()` 清除显式定位后派发 one-shot 可消费的 `move` 事件。
- Web preview 的 `?pluginHostSmoke=browserWindow` 注册 `resize` 和 one-shot `move` 事件监听，并继续跑现有 URL、窗口状态、bounds、title、always-on-top 和 parent message smoke。

TDD 记录：

- 扩展 `scripts/test-plugin-window-browser-bridge.mjs`：要求宿主存在 `dispatchPluginBrowserWindowEvent(id, "resize", ...)` 和 `dispatchPluginBrowserWindowEvent(id, "move", ...)`。
- 增加 Web preview 静态断言：要求 smoke 包含 `win.on('resize', ...)` 和 `win.once('move', ...)`。
- 初次红灯：`pnpm test:plugin-window-browser-bridge` 失败在 `setBounds/setSize should dispatch hosted browser-window resize events`。
- 实现后回归转绿。

验证：

```bash
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-host-view
pnpm test:plugin-window-page-search
pnpm test:plugin-window-lifecycle
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-window-browser-bridge`：红/绿通过，最终回归通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-window-page-search`：通过。
- `pnpm test:plugin-window-lifecycle`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 交互检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=218` 标题为 `ATools 3.0`，最终子窗口数量为 1、标题为 `子窗口已更新`、header URL 为 `child-reloaded.html`、class 包含 `focused positioned alwaysOnTop`，inline style 为 `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3;`，实际 rect 为 `420x260`；真实坐标点击子窗口按钮后状态条变为 `Browser 窗口 1 个 最近消息 browser-window-message +1`，无 framework overlay。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:62006"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，插件 runtime `context_bridge_checked:true`，`browser_context_checked:true`，`finder_context_checked:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:62006`。退出阶段仍有 Vite `EPIPE` 停服日志，但命令退出码为 0。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 65% | 66% | BrowserWindow hosted geometry action 已能派发 `resize` / `move` 事件，父插件 iframe handle 可监听几何变化 |
| 插件 runtime parity | 99% | 99% | BrowserWindow hosted event 覆盖继续扩展，但真实 native BrowserWindow、更多 OS 级事件/生命周期、startDrag、native 右键菜单和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展 browser-window 几何事件专项回归、Browser 交互 smoke，并回归真实桌面 smoke |

当前重点剩余：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. 插件窗口：本批是宿主内 geometry action event，不是系统级独立 native BrowserWindow；外部焦点、OS 级窗口事件和真实独立窗口仍需后续 native window host。
3. 插件交互：output 层右键复制、iframe contextmenu 上报、browser-window parent message 和常用 handle 方法已覆盖；native 右键菜单、拖拽和更复杂复制/菜单路径仍需真实插件专项回归。
4. 插件资源兼容：完整 SPA/router 运行态、history API 行为和真实第三方插件包仍需专项回归。
5. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 217：BrowserWindow event listener handle

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批延续宿主内 browser-window handle，补齐常用 EventEmitter 表面：`on()`、`addListener()`、`once()`、`off()`、`removeListener()` 和 `removeAllListeners()`。范围仍限定为当前 PluginPanel 宿主内子 iframe；事件来自宿主内 shell/action 状态，不伪装系统级独立 native BrowserWindow 事件流。

状态：DONE。

修改文件：

- `src/components/PluginPanel.svelte`
- `src/App.svelte`
- `scripts/test-plugin-window-browser-bridge.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 注入桥新增每个 BrowserWindow handle 独立的 listener 表，支持 `on` / `addListener` / `once` / `off` / `removeListener` / `removeAllListeners`。
- 新增 `__atools_browser_window_event__` 消息通道，父插件 iframe 可按 window id 把宿主事件派发给对应 handle。
- `closed` 事件会把 handle 标记为 destroyed，并清理 create callback 与事件 dispatcher。
- PluginPanel 新增 `dispatchPluginBrowserWindowEvent()`；`close` / `hide` / `show` / `focus` / `showInactive` / `blur` / `minimize` / `restore` / `maximize` / `unmaximize` 等 action 会同步派发对应宿主内事件。
- Web preview 的 `?pluginHostSmoke=browserWindow` 注册 `focus` / `maximize` / `restore` 事件监听，并继续跑现有 URL、窗口状态、bounds、title、always-on-top 和 parent message smoke。

TDD 记录：

- 扩展 `scripts/test-plugin-window-browser-bridge.mjs`：要求 BrowserWindow handle 暴露 EventEmitter 方法，并验证 host event message 能触发 `focus` listener。
- 验证 `off()` 能移除监听、`removeAllListeners(event)` 能清空指定事件、`once()` 只触发一次。
- 验证 host `closed` event 会让 `isDestroyed()` 返回 `true`。
- 增加宿主静态断言：要求存在 `dispatchPluginBrowserWindowEvent()` 和 `__atools_browser_window_event__` 通道。
- 增加 Web preview 静态断言：要求 smoke 包含 `win.on('focus', ...)` 和 `win.once('restore', ...)`。
- 初次红灯：`pnpm test:plugin-window-browser-bridge` 失败在 `browser-window handle should expose on()`。
- 实现后回归转绿。

验证：

```bash
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-host-view
pnpm test:plugin-window-page-search
pnpm test:plugin-window-lifecycle
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-window-browser-bridge`：红/绿通过，最终回归通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-window-page-search`：通过。
- `pnpm test:plugin-window-lifecycle`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 交互检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=217` 标题为 `ATools 3.0`，最终子窗口数量为 1、可见数量为 1、标题为 `子窗口已更新`、header URL 为 `child-reloaded.html`、class 包含 `focused positioned alwaysOnTop`，inline style 为 `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3;`，实际 rect 为 `420x260`；真实坐标点击子窗口按钮后状态条变为 `Browser 窗口 1 个 最近消息 browser-window-message +1`，无 framework overlay。Browser runtime 当前无法可靠读取 nested sandbox iframe 属性，事件属性由 VM 红/绿测试覆盖。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:58543"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，插件 runtime `context_bridge_checked:true`，`browser_context_checked:true`，`finder_context_checked:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:58543`。退出阶段仍有 Vite `EPIPE` 停服日志，但命令退出码为 0。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 64% | 65% | BrowserWindow handle 的基础 EventEmitter 表面和宿主内 lifecycle/action event 派发可用，`closed` event 会同步 destroyed 状态 |
| 插件 runtime parity | 99% | 99% | BrowserWindow handle 表面更完整，但真实 native BrowserWindow、更多 OS 级事件/生命周期、startDrag、native 右键菜单和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展 browser-window 事件专项回归、Browser 交互 smoke，并回归真实桌面 smoke |

当前重点剩余：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. 插件窗口：本批是宿主内 action/lifecycle event，不是系统级独立 native BrowserWindow；外部焦点、OS 级窗口事件和真实独立窗口仍需后续 native window host。
3. 插件交互：output 层右键复制、iframe contextmenu 上报、browser-window parent message 和常用 handle 方法已覆盖；native 右键菜单、拖拽和更复杂复制/菜单路径仍需真实插件专项回归。
4. 插件资源兼容：完整 SPA/router 运行态、history API 行为和真实第三方插件包仍需专项回归。
5. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 216：BrowserWindow minimize/maximize/restore handle

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批延续宿主内 browser-window handle，补齐常用窗口状态方法：`minimize()`、`isMinimized()`、`restore()`、`maximize()`、`unmaximize()` 和 `isMaximized()`。范围仍限定为当前 PluginPanel 宿主内子 iframe；最小化/最大化表示宿主内 shell 折叠和填满当前插件面板层，不伪装系统级独立 native BrowserWindow。

状态：DONE。

修改文件：

- `src/components/PluginPanel.svelte`
- `src/App.svelte`
- `scripts/test-plugin-window-browser-bridge.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 注入桥把 `minimize()`、`isMinimized()`、`restore()`、`maximize()`、`unmaximize()` 和 `isMaximized()` 统一接到 `browserWindowAction`。
- PluginPanel 的子窗口状态新增 `minimized` / `maximized`，创建时默认关闭。
- `minimize()` 折叠宿主内子 iframe 并释放焦点；`restore()` 清除 minimized/maximized 状态并保留原 bounds；`maximize()` 让当前子窗口填满 PluginPanel 子窗口层并聚焦；`unmaximize()` 回到原尺寸/位置。
- 子窗口 shell 新增 `minimized` / `maximized` class，CSS 隐藏最小化 iframe 内容、最大化时使用宿主层内 `inset:0`。
- Web preview 的 `?pluginHostSmoke=browserWindow` 自动执行 `minimize -> isMinimized -> restore -> maximize -> isMaximized -> unmaximize -> restore`，并把 `data-browser-window-minimized` / `data-browser-window-maximized` 写回父 iframe，后续仍继续验证 focus、bounds、title、always-on-top 和 parent message。

TDD 记录：

- 扩展 `scripts/test-plugin-window-browser-bridge.mjs`：要求 BrowserWindow handle 暴露 minimize/maximize/restore 状态方法，并验证每个方法都经 `browserWindowAction` 发送正确 action 和参数。
- 增加宿主静态断言：要求 `PluginBrowserWindowState` 保存 `minimized` / `maximized`，并存在 `class:minimized={childWindow.minimized}` / `class:maximized={childWindow.maximized}`。
- 增加 Web preview 静态断言：要求 smoke 包含 `win.minimize()`、`win.isMinimized()`、`win.restore()`、`win.maximize()`、`win.isMaximized()` 和 `win.unmaximize()`。
- 初次红灯：`pnpm test:plugin-window-browser-bridge` 失败在 `browser-window handle should expose minimize()`。
- 实现后回归转绿。

验证：

```bash
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-host-view
pnpm test:plugin-window-page-search
pnpm test:plugin-window-lifecycle
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-window-browser-bridge`：红/绿通过，最终回归通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-window-page-search`：通过。
- `pnpm test:plugin-window-lifecycle`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 交互检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=216` 标题为 `ATools 3.0`，父 iframe 记录 `data-browser-window-minimized="true"` 和 `data-browser-window-maximized="true"`；最终子窗口数量为 1、可见数量为 1、标题为 `子窗口已更新`、header URL 为 `child-reloaded.html`、class 包含 `focused positioned alwaysOnTop` 且不含 `minimized/maximized`，inline style 为 `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3;`，实际 rect 为 `420x260`；真实坐标点击子窗口按钮后状态条变为 `Browser 窗口 1 个 最近消息 browser-window-message +1`，无 framework overlay。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:56063"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，插件 runtime `context_bridge_checked:true`，`browser_context_checked:true`，`finder_context_checked:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:56063`。退出阶段仍有 Vite `EPIPE` 停服日志，但命令退出码为 0。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 63% | 64% | BrowserWindow handle 的最小化、最大化、恢复和状态查询在宿主内子 iframe shell 上可用，并可通过 Browser smoke 验证状态查询、最终 restore、bounds/always-on-top 保留和父子消息回调 |
| 插件 runtime parity | 99% | 99% | BrowserWindow handle 表面更完整，但真实 native BrowserWindow、窗口事件/生命周期、startDrag、native 右键菜单和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展 browser-window 窗口状态专项回归、Browser 交互 smoke，并回归真实桌面 smoke |

当前重点剩余：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. 插件窗口：本批是宿主内子 iframe shell 最小化/最大化/恢复状态，不是系统级独立 native BrowserWindow；外部焦点、跨窗口生命周期、OS 级窗口事件和真实独立窗口仍需后续 native window host。
3. 插件交互：output 层右键复制、iframe contextmenu 上报、browser-window parent message 和常用 handle 方法已覆盖；native 右键菜单、拖拽和更复杂复制/菜单路径仍需真实插件专项回归。
4. 插件资源兼容：完整 SPA/router 运行态、history API 行为和真实第三方插件包仍需专项回归。
5. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 215：BrowserWindow URL/load/reload handle

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批延续宿主内 browser-window handle，补齐常用导航方法：`getURL()`、`loadURL(url)` 和 `reload()`。范围仍限定为当前 PluginPanel 宿主内子 iframe；`loadURL()` / `reload()` 会更新宿主内 iframe srcdoc 和 URL 状态，不伪装系统级独立 native BrowserWindow 导航栈。

状态：DONE。

修改文件：

- `src/components/PluginPanel.svelte`
- `src/App.svelte`
- `scripts/test-plugin-window-browser-bridge.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 注入桥把 `getURL()`、`loadURL(url)` 和 `reload()` 统一接到 `browserWindowAction`。
- PluginPanel 新增 `loadPluginBrowserWindowUrl()`，复用 `pluginBrowserWindowHtml()` 和 `injectPluginBridge()` 重新生成子窗口 iframe 内容，保留现有窗口 id 和桥接上下文。
- `getURL()` 返回宿主内当前子窗口 URL；`loadURL(url)` 更新 URL、标题和 srcdoc；`reload()` 用当前 URL 重新注入 srcdoc，并保留当前标题。
- Web preview 的 `?pluginHostSmoke=browserWindow` 自动执行 `loadURL('child-reloaded.html') -> getURL() -> reload()`，并把 `data-browser-window-url` 写回父 iframe，后续仍继续验证 focus、bounds、title 和 always-on-top。

TDD 记录：

- 扩展 `scripts/test-plugin-window-browser-bridge.mjs`：要求 BrowserWindow handle 暴露 `getURL()` / `loadURL()` / `reload()`，并验证每个方法都经 `browserWindowAction` 发送正确 action 和参数。
- 增加宿主静态断言：要求存在 `loadPluginBrowserWindowUrl()`；Web preview smoke 必须包含 `win.loadURL()`、`win.getURL()` 和 `win.reload()`。
- 初次红灯：`pnpm test:plugin-window-browser-bridge` 失败在 `browser-window handle should expose getURL()`。
- 实现后回归转绿。

验证：

```bash
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-host-view
pnpm test:plugin-window-page-search
pnpm test:plugin-window-lifecycle
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-window-browser-bridge`：红/绿通过，最终回归通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-window-page-search`：通过。
- `pnpm test:plugin-window-lifecycle`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 交互检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=215` 标题为 `ATools 3.0`，子窗口数量为 1，最终可见数量为 1，子窗口标题为 `子窗口已更新`，header URL 为 `child-reloaded.html`，class 包含 `focused positioned alwaysOnTop`，inline style 为 `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3;`，父 iframe 记录 `data-browser-window-url="child-reloaded.html"`、bounds 为 `{"x":24,"y":32,"width":420,"height":260}`、always-on-top 为 `true`；真实坐标点击子窗口按钮后状态条变为 `Browser 窗口 1 个 最近消息 browser-window-message +1`，无 framework overlay。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:52753"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，插件 runtime `context_bridge_checked:true`，`browser_context_checked:true`，`finder_context_checked:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:52753`。退出阶段仍有 Vite `EPIPE` 停服日志，但命令退出码为 0。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 62% | 63% | BrowserWindow handle 的 URL 读取、loadURL 和 reload 在宿主内子 iframe 上可用，并可通过 Browser smoke 验证 URL 状态、bounds/always-on-top 保留和父子消息回调 |
| 插件 runtime parity | 99% | 99% | BrowserWindow handle 表面更完整，但真实 native BrowserWindow、最小化/最大化/生命周期事件、startDrag、native 右键菜单和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展 browser-window 导航专项回归、Browser 交互 smoke，并回归真实桌面 smoke |

当前重点剩余：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. 插件窗口：本批是宿主内子 iframe URL/reload 方法，不是系统级独立 native BrowserWindow；最小化、最大化、外部焦点、跨窗口生命周期和 OS 级窗口事件仍需后续 native window host。
3. 插件交互：output 层右键复制、iframe contextmenu 上报、browser-window parent message 和常用 handle 方法已覆盖；native 右键菜单、拖拽和更复杂复制/菜单路径仍需真实插件专项回归。
4. 插件资源兼容：完整 SPA/router 运行态、history API 行为和真实第三方插件包仍需专项回归。
5. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 214：BrowserWindow title/visibility/always-on-top state handle

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批延续 Batch 213 的宿主内 browser-window handle，补齐常用状态和标题方法：`isVisible()`、`isFocused()`、`showInactive()`、`blur()`、`getTitle()`、`setTitle(title)`、`isAlwaysOnTop()` 和 `setAlwaysOnTop(flag)`。范围仍限定为当前 PluginPanel 宿主内子 iframe；`setAlwaysOnTop()` 表示宿主内层级和状态，不伪装系统级 always-on-top 独立窗口。

状态：DONE。

修改文件：

- `src/components/PluginPanel.svelte`
- `src/App.svelte`
- `scripts/test-plugin-window-browser-bridge.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 注入桥把新增 BrowserWindow handle 方法统一接到 `browserWindowAction`：`isVisible` / `isFocused` / `showInactive` / `blur` / `getTitle` / `setTitle` / `isAlwaysOnTop` / `setAlwaysOnTop`。
- PluginPanel 的子窗口状态新增 `alwaysOnTop`，创建时读取 `options.alwaysOnTop === true`，并继续复用现有 `visible` / `focused` / `title` 状态。
- `handlePluginBrowserWindowAction()` 支持状态查询、`showInactive()` 不抢焦点显示、`blur()` 释放当前子窗口焦点、`setTitle()` 更新宿主标题栏、`setAlwaysOnTop()` 更新宿主内置顶状态。
- 子窗口渲染层新增 `alwaysOnTop` class，并在 inline style 中为宿主内置顶窗口写入更高 `z-index`。
- Web preview 的 `?pluginHostSmoke=browserWindow` 会自动执行 `hide -> show -> showInactive -> isVisible -> focus -> setBounds -> getBounds -> setTitle -> setAlwaysOnTop -> isAlwaysOnTop`，Browser smoke 可直接验证标题、class、z-index 和后续 `sendToParent` 回调。

TDD 记录：

- 扩展 `scripts/test-plugin-window-browser-bridge.mjs`：要求 BrowserWindow handle 暴露 title/visibility/focus/always-on-top 状态方法，并验证每个方法都经 `browserWindowAction` 发送正确 action 和参数。
- 增加宿主静态断言：要求 `PluginBrowserWindowState` 保存 `alwaysOnTop`，并存在 `class:alwaysOnTop={childWindow.alwaysOnTop}`。
- 初次红灯：`pnpm test:plugin-window-browser-bridge` 失败在 `browser-window handle should expose isVisible()`。
- 实现后回归转绿。

验证：

```bash
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-host-view
pnpm test:plugin-window-page-search
pnpm test:plugin-window-lifecycle
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-window-browser-bridge`：红/绿通过，最终回归通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-window-page-search`：通过。
- `pnpm test:plugin-window-lifecycle`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 交互检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=214` 标题为 `ATools 3.0`，子窗口数量为 1，最终可见数量为 1，子窗口标题为 `子窗口已更新`，class 包含 `focused positioned alwaysOnTop`，inline style 为 `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3;`，实际 rect 为 `420x260`，runtime strip 显示 `Browser 窗口 1 个 最近消息 window:setAlwaysOnTop +1`；点击子窗口按钮后状态条变为 `Browser 窗口 1 个 最近消息 browser-window-message +1`，无 framework overlay。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:64999"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，插件 runtime `context_bridge_checked:true`，`browser_context_checked:true`，`finder_context_checked:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:64999`。退出阶段仍有 Vite `EPIPE` 停服日志，但命令退出码为 0。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 61% | 62% | BrowserWindow handle 的 title/visibility/focus/always-on-top 状态方法在宿主内子 iframe 上可用，并可通过 Browser smoke 验证标题、class、z-index 和父子消息回调 |
| 插件 runtime parity | 99% | 99% | BrowserWindow handle 表面更完整，但真实 native BrowserWindow、最小化/最大化/生命周期事件、startDrag、native 右键菜单和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展 browser-window 专项回归、Browser 交互 smoke，并回归真实桌面 smoke |

当前重点剩余：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. 插件窗口：本批是宿主内子 iframe 状态/标题/层级方法，不是系统级独立 native BrowserWindow；最小化、最大化、外部焦点、跨窗口生命周期和 OS 级窗口事件仍需后续 native window host。
3. 插件交互：output 层右键复制、iframe contextmenu 上报、browser-window parent message 和常用 handle 方法已覆盖；native 右键菜单、拖拽和更复杂复制/菜单路径仍需真实插件专项回归。
4. 插件资源兼容：完整 SPA/router 运行态、history API 行为和真实第三方插件包仍需专项回归。
5. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 213：BrowserWindow bounds/size/position handle

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批延续 Batch 212 的宿主内 browser-window handle，补齐常用尺寸和位置方法：`getBounds()`、`setBounds(bounds)`、`getSize()`、`setSize(width, height)`、`getPosition()`、`setPosition(x, y)` 和 `center()`。范围仍限定为当前 PluginPanel 宿主内子 iframe，不伪装系统级独立 native BrowserWindow、置顶、最小化、OS 事件或外部焦点语义。

状态：DONE。

修改文件：

- `src/components/PluginPanel.svelte`
- `src/App.svelte`
- `scripts/test-plugin-window-browser-bridge.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 注入桥把新增 BrowserWindow handle 方法统一接到 `browserWindowAction`：`getBounds` / `setBounds` / `getSize` / `setSize` / `getPosition` / `setPosition` / `center`。
- PluginPanel 的子窗口状态新增 `x` / `y` / `width` / `height` / `positioned`，创建时读取 `options.width` / `options.height` / `options.x` / `options.y`，并对尺寸和位置做保守归一化。
- `handlePluginBrowserWindowAction()` 支持读取和更新 bounds、size、position；`setBounds()` / `setPosition()` 会进入显式定位，`center()` 会回到宿主内居中布局。
- 子窗口渲染层把受控尺寸和位置写入 inline style，并用 `positioned` class 区分显式定位；修正 CSS 高度约束，避免 `setBounds({ height: 260 })` 被 `max-height:100%` 压缩。
- Web preview 的 `?pluginHostSmoke=browserWindow` 会在创建子窗口后自动执行 `hide -> show -> focus -> setBounds -> getBounds`，Browser smoke 可直接验证实际 DOM rect、style/class 和后续 `sendToParent` 回调。

TDD 记录：

- 扩展 `scripts/test-plugin-window-browser-bridge.mjs`：要求 BrowserWindow handle 暴露 bounds/size/position/center 方法，并验证每个方法都经 `browserWindowAction` 发送正确 action 和参数。
- 增加宿主静态断言：要求 `PluginBrowserWindowState` 保存 `x/y/width/height/positioned`，存在 `normalizePluginBrowserWindowBounds()`、`pluginBrowserWindowStyle()` 和 `class:positioned={childWindow.positioned}`。
- 初次红灯：`pnpm test:plugin-window-browser-bridge` 失败在 `browser-window handle should expose getBounds()`。
- 实现后回归转绿，并在 Browser smoke 中发现 `max-height:100%` 会把 260px 高度压到 160px；修正 CSS 后重新验证实际 rect 为 `420x260`。

验证：

```bash
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-host-view
pnpm test:plugin-window-page-search
pnpm test:plugin-window-lifecycle
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-window-browser-bridge`：红/绿通过，最终回归通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-window-page-search`：通过。
- `pnpm test:plugin-window-lifecycle`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 交互检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=213` 标题为 `ATools 3.0`，子窗口数量为 1，最终可见数量为 1，子窗口 class 包含 `focused positioned`，inline style 为 `width: 420px; height: 260px; left: 24px; top: 32px;`，实际 rect 为 `420x260`，runtime strip 显示 `Browser 窗口 1 个 最近消息 window:setBounds +1`；点击子窗口按钮后状态条变为 `Browser 窗口 1 个 最近消息 browser-window-message +1`，无 framework overlay。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:61052"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，插件 runtime `context_bridge_checked:true`，`browser_context_checked:true`，`finder_context_checked:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:61052`。退出阶段仍有 Vite `EPIPE` 停服日志，但命令退出码为 0。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 60% | 61% | BrowserWindow handle 的 bounds/size/position/center 在宿主内子 iframe 上可用，并可通过 Browser smoke 验证实际尺寸、显式位置和父子消息回调 |
| 插件 runtime parity | 99% | 99% | BrowserWindow handle 表面更完整，但真实 native BrowserWindow、置顶/最小化/生命周期事件、startDrag、native 右键菜单和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展 browser-window 专项回归、Browser 交互 smoke，并回归真实桌面 smoke |

当前重点剩余：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. 插件窗口：本批是宿主内子 iframe 尺寸/位置方法，不是系统级独立 native BrowserWindow；置顶、最小化、外部焦点、跨窗口生命周期和 OS 级窗口事件仍需后续 native window host。
3. 插件交互：output 层右键复制、iframe contextmenu 上报、browser-window parent message 和常用 handle 方法已覆盖；native 右键菜单、拖拽和更复杂复制/菜单路径仍需真实插件专项回归。
4. 插件资源兼容：完整 SPA/router 运行态、history API 行为和真实第三方插件包仍需专项回归。
5. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 212：BrowserWindow handle show/hide/focus/close

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批延续 Batch 211 的宿主内 browser-window 子 iframe，补齐 `createBrowserWindow()` 返回对象的可验证 handle 方法：`show()`、`hide()`、`focus()`、`close()`、`isDestroyed()`。范围仍限定为当前 PluginPanel 宿主内子 iframe，不伪装系统级独立 native BrowserWindow、窗口尺寸管理或外部焦点语义。

状态：DONE。

修改文件：

- `src/components/PluginPanel.svelte`
- `src/App.svelte`
- `scripts/test-plugin-window-browser-bridge.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 注入桥把 `createBrowserWindow()` 的 native result 包装成宿主内 BrowserWindow handle，保留 id/type/windowType/url/title，并新增 `show()`、`hide()`、`focus()`、`close()`、`isDestroyed()`。
- `show()` / `hide()` / `focus()` / `close()` 通过 `browserWindowAction` native bridge 进入宿主，不再是空方法或纯前端假状态。
- 宿主 `handlePluginBrowserWindowAction()` 会校验 window id，更新子 iframe 可见状态、focused 状态或关闭子窗口，并返回 `{ visible, focused, closed }`。
- 子窗口渲染层新增 `hidden` / `focused` 状态类；`hide()` 隐藏但不销毁 iframe，`focus()` / `show()` 让目标子窗口可见且聚焦，`close()` 移除子窗口并让 handle 的 `isDestroyed()` 返回 `true`。
- Web preview 的 `?pluginHostSmoke=browserWindow` 会在创建子窗口后自动执行 `hide -> show -> focus`，Browser smoke 可直接验证 focused 子窗口和 `window:focus` 状态条，再点击子窗口按钮验证 `sendToParent` 仍能回调父插件。

TDD 记录：

- 扩展 `scripts/test-plugin-window-browser-bridge.mjs`：要求 create 返回 handle 方法、`hide/show/focus/close` 都经 `browserWindowAction` 发往宿主，`close()` 后 `isDestroyed()` 返回 true，并要求宿主存在 `handlePluginBrowserWindowAction()`、`class:hidden={!childWindow.visible}`、`class:focused={childWindow.focused}`。
- 初次红灯：`pnpm test:plugin-window-browser-bridge` 失败在 create 返回对象缺少 `show()`。
- 实现后修正测试顺序：先验证 create callback 的 parent message，再调用 close；关闭后清理 callback 属于预期行为。

验证：

```bash
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-host-view
pnpm test:plugin-window-page-search
pnpm test:plugin-window-lifecycle
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-window-browser-bridge`：红/绿通过，最终回归通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-window-page-search`：通过。
- `pnpm test:plugin-window-lifecycle`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 交互检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=212` 标题为 `ATools 3.0`，插件宿主预览非空，子窗口数量为 1，最终可见数量为 1，子窗口带 `focused` class，runtime strip 先显示 `Browser 窗口 1 个 最近消息 window:focus`；按当前子 iframe 坐标点击 `发送给父窗口` 后状态条变为 `Browser 窗口 1 个 最近消息 browser-window-message +1`，无 framework overlay。当前主/子 srcdoc 均不含 `observer.observe(document)`，仍使用 `observerRoot` fallback；Browser dev logs 保留的 MutationObserver 错误来自 Browser/Playwright 注入路径，不作为应用错误判定。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:55476"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，插件 runtime `context_bridge_checked:true`，`browser_context_checked:true`，`finder_context_checked:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:55476`。退出阶段仍有 Vite `EPIPE` 停服日志，但命令退出码为 0。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 59% | 60% | BrowserWindow handle 的 show/hide/focus/close/isDestroyed 在宿主内子 iframe 上可用，并可通过 Browser smoke 验证可见/聚焦/关闭状态 |
| 插件 runtime parity | 99% | 99% | BrowserWindow handle 表面更完整，但真实 native BrowserWindow、完整系统窗口方法、startDrag、native 右键菜单和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展 browser-window 专项回归、Browser 交互 smoke，并回归真实桌面 smoke |

当前重点剩余：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. 插件窗口：本批是宿主内子 iframe handle 方法，不是系统级独立 native BrowserWindow；窗口尺寸、置顶、最小化、外部焦点、跨窗口生命周期和 OS 级窗口事件仍需后续 native window host。
3. 插件交互：output 层右键复制、iframe contextmenu 上报、browser-window parent message 和基础 handle 方法已覆盖；native 右键菜单、拖拽和更复杂复制/菜单路径仍需真实插件专项回归。
4. 插件资源兼容：完整 SPA/router 运行态、history API 行为和真实第三方插件包仍需专项回归。
5. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 211：插件 browser-window 子 iframe 与 sendToParent 回调

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批聚焦此前仍为 fixed unsupported 的 `createBrowserWindow(url, options, callback)` / `sendToParent(channel, ...args)`：先实现当前 PluginPanel 宿主内的受控 browser-window 子 iframe 和父子消息回调，不伪装完整 native 独立窗口、BrowserWindow 对象方法或跨窗口生命周期。

状态：DONE。

修改文件：

- `src/components/PluginPanel.svelte`
- `src/lib/pluginHostView.ts`
- `src/App.svelte`
- `scripts/test-plugin-window-browser-bridge.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `createBrowserWindow(url, options, callback)` 在宿主内创建受控子 iframe，返回 `{ id, type: "browserWindow", windowType: "browserWindow", url, title }`，并按插件资源路径或 Web preview payload 准备子窗口 HTML。
- 子 iframe 注入桥时带入窗口类型和 window id；子 iframe 中 `utools.getWindowType()` 返回 `browserWindow`。
- 子 iframe 调用 `sendToParent(channel, ...args)` 时，宿主校验来源 window id，记录最近父子消息，并通过 `__atools_browser_window_parent_message__` 转发给主插件 iframe 的 `createBrowserWindow` callback。
- `pluginHostView` 新增 `Browser 窗口` runtime chip，显示子窗口数量和最近消息，例如 `Browser 窗口 / 1 个 / 最近消息 browser-window-message +1`。
- Web preview 新增 `?pluginHostSmoke=browserWindow`，主 iframe 会创建子窗口，子窗口按钮会调用 `sendToParent`，Browser 可直接验证渲染和回调。
- 修复桥注入 JSON payload 中原始 `</script>` 截断内联桥脚本的问题：所有桥 JSON 替换都走 `pluginBridgeJson()`，把 script close 序列转为安全的 `<\/script>`。

TDD 记录：

- 重写 `scripts/test-plugin-window-browser-bridge.mjs`：旧测试要求 browser-window API 返回 unsupported；新红灯要求 create callback 接收子窗口 `sendToParent` 消息、子 iframe `getWindowType()` 返回 `browserWindow`、宿主存在 browser-window 状态/渲染/消息转发路径，且 component 中不再有 fixed `createBrowserWindow unsupported` / `sendToParent unsupported`。
- 初次红灯：`pnpm test:plugin-window-browser-bridge` 失败在 create callback 没有收到 `sendToParent` 消息。
- Browser smoke 暴露 preview payload 中 `</script>` 截断桥脚本，导致主 iframe 没有 `window.utools`，随后补 `pluginBridgeJson()` 静态断言并修复桥 JSON 注入。

验证：

```bash
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-host-view
pnpm test:plugin-window-page-search
pnpm test:plugin-window-lifecycle
pnpm test:plugin-bridge-capabilities
pnpm test:plugin-events-bridge
pnpm test:plugin-resource-runtime
pnpm test:plugin-iframe-context-menu
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-window-browser-bridge`：红/绿通过，最终回归通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-window-page-search`：通过。
- `pnpm test:plugin-window-lifecycle`：通过。
- `pnpm test:plugin-bridge-capabilities`：通过。
- `pnpm test:plugin-events-bridge`：通过。
- `pnpm test:plugin-resource-runtime`：通过。
- `pnpm test:plugin-iframe-context-menu`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 交互检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=214` 标题为 `ATools 3.0`，插件宿主预览非空，子窗口数量为 1，子 iframe srcdoc 含 `sendToParent` 且注入 `var _atoolsWindowType = "browserWindow"`；点击子窗口按钮后 runtime strip 显示 `Browser 窗口 1 个 最近消息 browser-window-message +1`，无 framework overlay。当前主/子 srcdoc 均不含 `observer.observe(document)`，仍使用 `observerRoot` fallback；Browser dev logs 保留的 MutationObserver 错误来自 Browser/Playwright 注入路径，不作为应用错误判定。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:51885"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，插件 runtime `context_bridge_checked:true`，`browser_context_checked:true`，`finder_context_checked:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:51885`。退出阶段仍有 Vite/esbuild `EPIPE` 停服日志，但命令退出码为 0。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 57% | 59% | createBrowserWindow 不再固定 unsupported，当前宿主可创建受控 browser-window 子 iframe，并支持 sendToParent 回调主插件 iframe |
| 插件 runtime parity | 99% | 99% | browser-window 表面更接近可用，但真实 native BrowserWindow、完整对象方法、独立窗口生命周期、startDrag、native 右键菜单和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 新增 browser-window 专项回归、Browser 交互 smoke，并回归真实桌面 smoke |

当前重点剩余：

1. 插件 iframe 宿主：`startDrag` 仍为 explicit native-only unsupported。
2. 插件窗口：本批是宿主内受控子 iframe，不是系统级独立 native BrowserWindow；BrowserWindow 对象方法、窗口生命周期、外部 focus/size/close 语义仍需后续 native window host。
3. 插件交互：output 层右键复制、iframe contextmenu 上报和 browser-window parent message 已覆盖；native 右键菜单、拖拽和更复杂复制/菜单路径仍需真实插件专项回归。
4. 插件资源兼容：完整 SPA/router 运行态、history API 行为和真实第三方插件包仍需专项回归。
5. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 210：插件 iframe contextmenu 事件上报

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批延续 Batch 209 的右键交互收口，但范围限定为 iframe 内 `contextmenu` 事件不丢失、宿主可见和 Web preview 可验证；不伪装完整 native 右键菜单、插件自绘菜单系统或文件拖拽。

状态：DONE。

修改文件：

- `src/components/PluginPanel.svelte`
- `src/lib/pluginHostView.ts`
- `src/App.svelte`
- `scripts/test-plugin-iframe-context-menu.mjs`
- `scripts/test-plugin-resource-runtime.mjs`
- `scripts/test-plugin-host-view.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 注入桥在插件 iframe 内以 capture phase 观察 `contextmenu`，上报坐标、目标 tag、是否可编辑、选中文本和 `defaultPrevented`，但不调用 `preventDefault()`，保留插件自定义右键事件路径。
- `PluginPanel.svelte` 处理 `__ipc_plugin_contextmenu__`，记录最近 iframe 右键事件，并关闭 output 右键菜单，避免两层菜单状态互相残留。
- `pluginHostView` 在收到 iframe 右键事件后追加 `右键菜单 / iframe button` runtime chip，让宿主能看到 iframe 右键路径确实到达。
- Web preview 新增 `?pluginHostSmoke=iframeContext`，渲染 iframe 按钮并复用真实 `UTOOLS_BRIDGE` 注入，Browser 可以直接验证 iframe 右键交互。
- 修复 preview HTML 无 `<head>` 时桥脚本过早插入的问题：无 head 时插到 `<body>` 开始标签后。
- 修复运行时资源 observer 在 iframe realm 下可能对 `documentElement` 抛 `MutationObserver.observe` 类型错误的问题：先尝试 `documentElement`，失败后静默降级到 `body`，避免插件 iframe 产生未捕获错误。

TDD 记录：

- 新增 `scripts/test-plugin-iframe-context-menu.mjs`，并接入 `pnpm test:plugin-iframe-context-menu`。
- 初次红灯：新测试失败在注入桥没有监听 `contextmenu`。
- 首轮实现后 Browser 暴露 preview srcdoc 没有注入真实桥；补测试要求 `loadPreviewPluginHtml` 走 `injectPluginBridge` 后红灯，再抽共享桥注入函数。
- Browser 继续暴露无 `<head>` preview HTML 中桥脚本插入太早；补测试要求 `bodyOpenMatch` 后红灯，再把无 head 注入点改到 `<body>` 后。
- Browser 还暴露 runtime resource observer 的 MutationObserver 兼容问题；补 `scripts/test-plugin-resource-runtime.mjs` 红灯，模拟 `observe(documentElement)` 抛错，随后实现 body fallback。

验证：

```bash
pnpm test:plugin-iframe-context-menu
pnpm test:plugin-resource-runtime
pnpm test:plugin-host-view
pnpm test:plugin-output-context-menu
pnpm test:plugin-window-page-search
pnpm test:plugin-events-bridge
pnpm test:plugin-bridge-capabilities
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-iframe-context-menu`：红/绿通过，最终回归通过。
- `pnpm test:plugin-resource-runtime`：红/绿通过，最终回归通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-output-context-menu`：通过。
- `pnpm test:plugin-window-page-search`：通过。
- `pnpm test:plugin-events-bridge`：通过。
- `pnpm test:plugin-bridge-capabilities`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 交互检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=iframeContext&bust=213` 标题为 `ATools 3.0`，插件宿主预览非空，body mode 为 iframe，srcdoc 包含桥和 `右键测试按钮`，桥脚本位于 `<body>` 后，srcdoc 不再包含 `observer.observe(document)`；对 iframe 左上按钮区域右键后 runtime strip 出现 `右键菜单 / iframe button`，无 framework overlay。Browser dev logs 仍捕获一条 `MutationObserver.observe(document)` 错误，但当前 srcdoc 已证明不含该调用；该日志来自 Browser/Playwright 注入脚本，不作为应用错误判定。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:61889"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，`plugin_runtime_smoke.context_bridge_checked:true`，`plugin_runtime_smoke.browser_context_checked:true`，`plugin_runtime_smoke.finder_context_checked:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:61889`。退出阶段仍有 Vite/esbuild `EPIPE` 停服日志，但命令退出码为 0。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 56% | 57% | iframe 内 contextmenu 事件可到达宿主并在运行状态条可见，Web preview 也复用真实桥注入 |
| 插件 runtime parity | 99% | 99% | 右键事件路径更完整，但 native 右键菜单、真实独立分离窗口、browser-window、startDrag、拖拽和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 新增 iframe contextmenu 专项测试，并回归资源运行时、宿主视图、Browser 交互和真实桌面 smoke |

当前重点剩余：

1. 插件 iframe 宿主：startDrag、createBrowserWindow/sendToParent 等仍是 explicit native-only unsupported 或 native-only 行为。
2. 插件窗口：`onPluginDetach` 已能由宿主按钮触发，但真实独立分离窗口和 `getWindowType() === "detach"` 仍未实现。
3. 插件交互：output 层右键复制和 iframe contextmenu 上报已覆盖；native 右键菜单、拖拽和更复杂复制/菜单路径仍需按真实插件行为专项回归。
4. 插件资源兼容：完整 SPA/router 运行态、history API 行为和真实第三方插件包仍需专项回归。
5. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 209：插件 output 右键复制菜单

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批聚焦插件 output layer 的高频交互：此前输出行只能点击或按 Enter 复制，右键没有 ZTools/uTools 式局部复制菜单，且全局 Escape 处理容易和插件态退出冲突。本批先补 output 行右键复制，不伪装完整 iframe 原生右键菜单或文件拖拽能力。

状态：DONE。

修改文件：

- `src/components/PluginPanel.svelte`
- `scripts/test-plugin-output-context-menu.mjs`
- `scripts/test-plugin-events-bridge.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `PluginPanel.svelte` 新增 output 右键菜单状态、打开/关闭逻辑和 `复制结果` 菜单项。
- 输出行点击、Enter 和右键菜单复制复用 `copyPluginOutputItem(idx)`，复制后继续走既有 `onoutput` 反馈 `已复制`。
- 右键打开菜单时同步选中目标输出行，点击页面或切换 SubInput 选择会关闭菜单。
- `Esc` 在右键菜单打开时通过 capture-phase keydown 拦截并关闭菜单，调用 `stopImmediatePropagation()`，避免冒泡到 App 全局 Escape 后直接退出插件态。

TDD 记录：

- 新增 `scripts/test-plugin-output-context-menu.mjs`，并接入 `pnpm test:plugin-output-context-menu`。
- 初次运行红灯：`pnpm test:plugin-output-context-menu` 失败在缺少 `OutputContextMenuState`、右键 handler、菜单 DOM 和 Escape 拦截。
- 实现最小 output 菜单后目标测试转绿。
- Browser 验证时发现 Escape 会关闭菜单后继续退出插件态；按 systematic debugging 追到 `PluginPanel` 与 `App` 都有 window-level keydown，改为 capture-phase 拦截并补测试断言后转绿。

验证：

```bash
pnpm test:plugin-output-context-menu
pnpm test:plugin-host-view
pnpm test:plugin-events-bridge
pnpm test:plugin-window-lifecycle
pnpm test:plugin-input-bridge
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-output-context-menu`：红/绿通过，最终回归通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-events-bridge`：通过；同步放宽 onDestroy/onMount import 静态断言以适配 Svelte import 合并。
- `pnpm test:plugin-window-lifecycle`：通过。
- `pnpm test:plugin-input-bridge`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 交互检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1` 标题为 `ATools 3.0`，插件宿主预览非空，output layer 有 2 行，无 framework overlay，无横向溢出，控制台 0 errors / 0 warnings；对第一行右键后出现 `复制结果` 菜单，选中行为 `当前时间戳`；按 `Esc` 后菜单关闭且仍停留在插件宿主 output layer。Browser screenshot 通道本批仍超时，未作为通过条件。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:55361"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，`plugin_runtime_smoke.context_bridge_checked:true`，`plugin_runtime_smoke.browser_context_checked:true`，`plugin_runtime_smoke.finder_context_checked:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:55361`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 55% | 56% | output 行右键菜单补齐最常见的复制结果路径，并修复菜单 Esc 与宿主退出的冲突 |
| 插件 runtime parity | 99% | 99% | output 层交互更完整，但 iframe 原生右键菜单、真实独立分离窗口、browser-window、startDrag、拖拽和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 新增 output 右键菜单专项测试，并回归插件宿主、事件桥、输入桥、Browser 交互和真实桌面 smoke |

当前重点剩余：

1. 插件 iframe 宿主：startDrag、createBrowserWindow/sendToParent 等仍是 explicit native-only unsupported 或 native-only 行为。
2. 插件窗口：`onPluginDetach` 已能由宿主按钮触发，但真实独立分离窗口和 `getWindowType() === "detach"` 仍未实现。
3. 插件交互：output 层右键复制已覆盖；iframe 原生右键菜单、拖拽和更复杂复制路径仍需按真实插件行为专项回归。
4. 插件资源兼容：完整 SPA/router 运行态、history API 行为和真实第三方插件包仍需专项回归。
5. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 208：插件分离按钮 onPluginDetach 生命周期桥

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批收口插件宿主分离生命周期：此前注入桥已暴露 `utools.onPluginDetach(callback)`，但标题栏 `分离` 仍是禁用按钮，用户无法从宿主 UI 触发官方分离事件。本批先推进真实生命周期通知，不伪装完整独立窗口。

状态：DONE。

修改文件：

- `src/lib/pluginHostView.ts`
- `src/components/PluginPanel.svelte`
- `scripts/test-plugin-host-view.mjs`
- `scripts/test-plugin-events-bridge.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `pluginHostView` 将标题栏 `分离` 操作从禁用态推进为可用动作，`设置` 仍保持禁用态。
- `PluginPanel.svelte` 新增 `dispatchPluginDetachEvent()`，向插件 iframe 派发 `atools-plugin-detach`。
- 标题栏动作统一进入 `handlePluginChromeAction()`；`detach` 点击触发 `dispatchPluginDetachEvent()`，同一插件 owner 内防重复派发，切换插件 owner 时重置。
- 未实现独立窗口创建，也不把 `getWindowType()` 改成 `detach`；当前只补官方生命周期回调，避免假装完成完整分离窗口。

TDD 记录：

- 先扩展 `scripts/test-plugin-host-view.mjs`：期望 `分离` action 可用，并要求按钮点击走宿主 action handler。
- 先扩展 `scripts/test-plugin-events-bridge.mjs`：期望组件存在 `dispatchPluginDetachEvent()`、派发 `atools-plugin-detach`，且 `detach` action 调用派发函数。
- 初次运行红灯：
  - `pnpm test:plugin-host-view` 失败在 `detach` 仍为 `available:false`。
  - `pnpm test:plugin-events-bridge` 失败在缺少 `dispatchPluginDetachEvent()`。
- 实现最小宿主派发后两个目标测试转绿。

验证：

```bash
pnpm test:plugin-host-view
pnpm test:plugin-events-bridge
pnpm test:plugin-window-lifecycle
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-window-drag-bridge
pnpm test:plugin-window-page-search
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-host-view`：红/绿通过，最终回归通过。
- `pnpm test:plugin-events-bridge`：红/绿通过，最终回归通过。
- `pnpm test:plugin-window-lifecycle`：通过。
- `pnpm test:plugin-window-browser-bridge`：通过。
- `pnpm test:plugin-window-drag-bridge`：通过。
- `pnpm test:plugin-window-page-search`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 渲染检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1` 标题为 `ATools 3.0`，插件宿主预览非空，`分离` 按钮启用且唯一，`设置` 仍禁用，运行状态显示 `桥接能力 utools/ztools DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`，无 framework overlay，无横向溢出，控制台 0 errors / 0 warnings。该 Web 预览处于 output layer，不渲染 iframe；detach 生命周期派发由 VM/静态专项测试覆盖。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:51618"`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，`plugin_runtime_smoke.context_bridge_checked:true`，`plugin_runtime_smoke.browser_context_checked:true`，`plugin_runtime_smoke.finder_context_checked:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:51618`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 54% | 55% | 标题栏 `分离` 从禁用态推进为可触发 `onPluginDetach` 生命周期事件的宿主动作 |
| 插件 runtime parity | 99% | 99% | detach 生命周期通知更完整，但真实独立分离窗口、browser-window、startDrag、右键/复制/拖拽和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展插件宿主视图和事件桥测试，并回归窗口桥、构建、Browser 和真实桌面 smoke |

当前重点剩余：

1. 插件 iframe 宿主：startDrag、createBrowserWindow/sendToParent 等仍是 explicit native-only unsupported 或 native-only 行为。
2. 插件窗口：`onPluginDetach` 已能由宿主按钮触发，但真实独立分离窗口和 `getWindowType() === "detach"` 仍未实现。
3. 插件交互：右键菜单、复制和拖拽还需按真实插件行为专项回归。
4. 插件资源兼容：完整 SPA/router 运行态、history API 行为和真实第三方插件包仍需专项回归。
5. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 207：插件 onPluginOut 宿主退出生命周期桥

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批收口插件宿主退出生命周期：此前注入桥已经暴露 `utools.onPluginOut(callback)` 并能响应测试注入事件，但宿主返回/iframe close/Web preview close/Svelte 销毁路径没有统一主动派发退出事件，真实插件无法可靠收到官方退出回调。

状态：DONE。

修改文件：

- `src/components/PluginPanel.svelte`
- `scripts/test-plugin-events-bridge.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `PluginPanel.svelte` 新增 `dispatchPluginOutEvent(isKill)`，向插件 iframe `contentWindow` 派发 `atools-plugin-out`，事件 detail 保留 `{ isKill }`。
- 返回按钮、插件 iframe `__ipc_close__`、Web preview hide 路径统一走 `closePluginPanel()`，正常退出时派发 `isKill:false` 后再离开插件态。
- Svelte `onDestroy` 作为销毁 fallback 派发 `isKill:true`，覆盖宿主被动卸载时插件侧清理回调。
- 每次切换 `dynamicFeatureOwner` 时重置派发 guard，避免同一插件退出重复派发，同时不影响下一次插件进入。
- 扩展 `scripts/test-plugin-events-bridge.mjs`，静态守护 `onDestroy` 注册、`dispatchPluginOutEvent`、`atools-plugin-out`、`detail:{ isKill }`、返回按钮/iframe close/Web preview close 路径。

TDD 记录：

- 先扩展 `scripts/test-plugin-events-bridge.mjs`。
- 初次运行红灯：`PluginPanel should register a destroy-time plugin lifecycle hook`。
- 实现宿主退出派发后目标测试转绿。
- `pnpm check` 首次暴露类型错误：`Property 'CustomEvent' does not exist on type 'Window'`。按根因补 `PluginLifecycleWindow` 类型后 `svelte-check` 转绿。

验证：

```bash
pnpm test:plugin-events-bridge
pnpm test:plugin-window-lifecycle
pnpm test:plugin-host-view
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-context-bridge
pnpm test:plugin-input-bridge
pnpm test:plugin-bridge-capabilities
pnpm test:plugin-screen-interactive
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-events-bridge`：红/绿通过，最终回归通过。
- `pnpm test:plugin-window-lifecycle`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-window-browser-bridge`：通过。
- `pnpm test:plugin-context-bridge`：通过。
- `pnpm test:plugin-input-bridge`：通过。
- `pnpm test:plugin-bridge-capabilities`：通过。
- `pnpm test:plugin-screen-interactive`：通过。
- `pnpm check`：修正 `Window.CustomEvent` 类型后 0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 渲染检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1` 标题为 `ATools 3.0`，插件宿主预览非空，运行状态显示 `桥接能力 utools/ztools DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`，无横向溢出，控制台 0 errors / 0 warnings。Browser 截图捕获接口本轮超时并重置 REPL，未作为通过条件。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:65113"`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，`plugin_runtime_smoke.context_bridge_checked:true`，`plugin_runtime_smoke.browser_context_checked:true`，`plugin_runtime_smoke.finder_context_checked:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:65113`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 53% | 54% | 宿主返回、iframe close、Web preview close 和销毁 fallback 已派发 `onPluginOut` 退出生命周期 |
| 插件 runtime parity | 99% | 99% | 生命周期派发更完整，但 startDrag、browser-window、真实 `onPluginDetach`、右键/复制/拖拽和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展插件事件桥测试并回归插件宿主、构建、Browser 和真实桌面 smoke |

当前重点剩余：

1. 插件 iframe 宿主：startDrag、createBrowserWindow/sendToParent 等仍是 explicit native-only unsupported 或 native-only 行为。
2. 插件生命周期：`onPluginDetach` 还缺真实分离窗口触发；`onPluginOut` 已覆盖当前宿主退出路径。
3. 插件交互：右键菜单、复制和拖拽还需按真实插件行为专项回归。
4. 插件资源兼容：完整 SPA/router 运行态、history API 行为和真实第三方插件包仍需专项回归。
5. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 206：插件当前上下文 Browser/Finder 桥回归

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批收口插件当前上下文桥的能力清单和插件侧回归：`readCurrentBrowserUrl()`、官方别名 `getCurrentBrowserUrl()`、`readCurrentFolderPath()` 不应只由命令层 desktop smoke 间接覆盖，也应在插件 iframe 注入桥中有明确 native call 测试和运行状态能力清单展示。

状态：DONE。

修改文件：

- `src/lib/pluginBridgeCapabilities.ts`
- `scripts/test-plugin-context-bridge.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 `scripts/test-plugin-context-bridge.mjs`，直接执行 `UTOOLS_BRIDGE` 注入脚本并模拟 iframe native response：
  - 验证 `utools.readCurrentBrowserUrl()` 通过 native bridge 发送 `readCurrentBrowserUrl` 并返回浏览器 URL 或 `null`。
  - 验证 `utools.getCurrentBrowserUrl()` 作为官方兼容别名复用同一 native bridge 方法。
  - 验证 `utools.readCurrentFolderPath()` 通过 native bridge 返回 Finder 当前目录或 Desktop fallback 路径。
  - 静态验证 host 侧仍包含 Chrome/Edge/Safari URL 读取和 Finder 无窗口 Desktop fallback。
- 将 `getCurrentBrowserUrl` 加入共享 `上下文` 能力清单，使插件运行状态详情和实际注入 API surface 对齐。
- 新增 `pnpm test:plugin-context-bridge` package script，便于后续上下文桥专项回归。

TDD 记录：

- 先新增 `scripts/test-plugin-context-bridge.mjs` 和 package script。
- 初次运行红灯：`shared capability inventory should include getCurrentBrowserUrl alias`。
- 在 `src/lib/pluginBridgeCapabilities.ts` 的 `context` 方法列表加入 `getCurrentBrowserUrl` 后，目标测试转绿。

验证：

```bash
pnpm test:plugin-context-bridge
pnpm test:plugin-bridge-capabilities
pnpm test:plugin-host-view
pnpm test:plugin-screen-display
pnpm test:plugin-screen-interactive
pnpm test:plugin-system-identity
pnpm test:plugin-window-lifecycle
pnpm test:plugin-events-bridge
pnpm test:plugin-input-bridge
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-context-bridge`：通过。
- `pnpm test:plugin-bridge-capabilities`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-screen-display`：通过。
- `pnpm test:plugin-screen-interactive`：通过。
- `pnpm test:plugin-system-identity`：通过。
- `pnpm test:plugin-window-lifecycle`：通过。
- `pnpm test:plugin-events-bridge`：通过。
- `pnpm test:plugin-input-bridge`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 渲染检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1` 标题为 `ATools 3.0`，插件宿主预览非空，运行状态显示 `桥接能力 utools/ztools DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`，无横向溢出，控制台 0 errors / 0 warnings。Browser 截图捕获接口本轮超时，未作为通过条件。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:61734"`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，`plugin_runtime_smoke.context_bridge_checked:true`，`plugin_runtime_smoke.browser_context_checked:true`，`plugin_runtime_smoke.finder_context_checked:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:61734`。
- 结束后检查 `lsof -nP -iTCP:1420 -sTCP:LISTEN`、`lsof -nP -iTCP:61734 -sTCP:LISTEN` 和 `pgrep -fl "(target/debug/atools|cargo  run|pnpm dev|vite --host 127.0.0.1|vite$|smoke-tauri-desktop)"`：均无残留。
- `git status --short`：退出码 128，当前目录不是 git repository。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 52% | 53% | 当前上下文桥新增插件侧专项回归，并把 `getCurrentBrowserUrl` 官方别名纳入运行状态能力清单 |
| 插件 runtime parity | 99% | 99% | browser/Finder context 能力清单和插件侧回归提升，但 startDrag、browser-window、完整生命周期/拖拽和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 新增插件上下文桥测试并回归插件宿主、构建、Browser 和真实桌面 smoke |

当前重点剩余：

1. 插件 iframe 宿主：startDrag、createBrowserWindow/sendToParent 等仍是 explicit native-only unsupported 或 native-only 行为。
2. 插件资源兼容：完整 SPA/router 运行态、history API 行为和真实第三方插件包仍需专项回归。
3. 插件安全：完整插件权限授权/隔离模型仍未完成。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 205：插件 screenColorPick WebView 取色桥

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批收口插件 screen bridge 的固定 unsupported：`screenColorPick(callback)` 不应继续无条件返回 explicit unsupported，而应在当前 WebView host 支持时调用 web-native EyeDropper，并在不支持时返回明确 unavailable。

状态：DONE。

修改文件：

- `src/components/PluginPanel.svelte`
- `scripts/test-plugin-screen-interactive.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `screenColorPick(callback)` host 分支改为真实兼容路径：
  - 新增 `pickScreenColorWithEyeDropper()`，在 WebView 支持 `window.EyeDropper` 时调用 `open()`。
  - 新增 `normalizeEyeDropperHex()` 和 `rgbStringFromHex()`，把 EyeDropper 的 `sRGBHex` 归一为 `{ hex, rgb }`。
  - 缺少 EyeDropper 或返回非法颜色时返回 `screenColorPick unavailable: ...`，不再伪造成功。
- `screenCapture(callback)` 和 `desktopCaptureSources(options)` 保持既有行为：截图走 Tauri 命令，desktop sources 返回 primary screen 兼容列表。

TDD 记录：

- 先扩展 `scripts/test-plugin-screen-interactive.mjs`：
  - 要求 `PluginPanel.svelte` 不再包含 `screenColorPick unsupported`。
  - 要求 `case "screenColorPick"` 调用 `pickScreenColorWithEyeDropper()`。
  - 要求缺少能力时存在明确 `screenColorPick unavailable` 错误。
- 初次运行红灯：`screenColorPick should use a WebView host color picker path instead of unconditional unsupported`。
- 实现 EyeDropper 取色路径后，目标测试转绿。

验证：

```bash
pnpm test:plugin-screen-interactive
pnpm test:plugin-bridge-capabilities
pnpm test:plugin-host-view
pnpm test:plugin-input-bridge
pnpm test:plugin-window-lifecycle
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-window-drag-bridge
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-screen-interactive`：通过。
- `pnpm test:plugin-bridge-capabilities`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-input-bridge`：通过。
- `pnpm test:plugin-window-lifecycle`：通过。
- `pnpm test:plugin-window-browser-bridge`：通过。
- `pnpm test:plugin-window-drag-bridge`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 渲染检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1` 显示插件宿主预览，output layer 有 2 行，SubInput 可见且值为 `time`，桥接能力详情为 `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`，无横向溢出，控制台 0 errors / 0 warnings。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:57656"`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，`plugin_runtime_smoke.context_bridge_checked:true`，`plugin_runtime_smoke.dialog_guard_checked:true`，`plugin_runtime_smoke.data_roundtrip_checked:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:57656`。
- 结束后检查 `lsof -nP -iTCP:1420 -sTCP:LISTEN`、`lsof -nP -iTCP:57656 -sTCP:LISTEN` 和 `pgrep -fl "(target/debug/atools|cargo  run|pnpm dev|vite --host 127.0.0.1|vite$|smoke-tauri-desktop)"`：均无残留。
- `git status --short`：退出码 128，当前目录不是 git repository。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 51% | 52% | `screenColorPick(callback)` 从 fixed unsupported 推进为 WebView EyeDropper 兼容取色路径，缺少能力时明确 unavailable |
| 插件 runtime parity | 99% | 99% | screenColorPick 兼容提升，但 startDrag、browser-window、完整生命周期/拖拽和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展 screen bridge 测试并回归插件宿主、构建、Browser 和真实桌面 smoke |

当前重点剩余：

1. 插件 iframe 宿主：startDrag、createBrowserWindow/sendToParent 等仍是 explicit native-only unsupported 或 native-only 行为。
2. 插件资源兼容：完整 SPA/router 运行态、history API 行为和真实第三方插件包仍需专项回归。
3. 插件安全：完整插件权限授权/隔离模型仍未完成。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 204：插件 hideMainWindowPasteImage/File 图片与文件粘贴桥

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批完成插件外部输入桥剩余的图片与文件粘贴路径：`hideMainWindowPasteImage(image)` 和 `hideMainWindowPasteFile(file)` 不应继续只返回 explicit unsupported，而应在当前 macOS WebView host 中写入剪贴板、隐藏主窗口并触发前台应用标准粘贴。

状态：DONE。

修改文件：

- `src/components/PluginPanel.svelte`
- `scripts/test-plugin-input-bridge.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `hideMainWindowPasteImage(image)` host 分支改为真实执行：
  - 复用 `writePluginImageToClipboard()`，支持图片路径和 `data:image/...;base64,...`。
  - 调用 `hideMainWindowForPluginPaste()` 隐藏主窗口。
  - 通过 AppleScript 触发 macOS `Command+V`。
- `hideMainWindowPasteFile(file)` host 分支改为真实执行：
  - 新增 `pathsFromBridgeValue()`，兼容单个路径、`{ path }` 对象和路径数组。
  - 新增 `pluginFileClipboardAppleScript()`，把一个或多个路径写入 macOS 文件剪贴板。
  - 隐藏主窗口后通过 AppleScript 触发 macOS `Command+V`。
- `hideMainWindowPasteText(text)` 和 `hideMainWindowTypeString(text)` 保持 Batch 202/203 的真实 host 行为。

TDD 记录：

- 先扩展 `scripts/test-plugin-input-bridge.mjs`：
  - 要求 `PluginPanel.svelte` 不再包含 `hideMainWindowPasteImage unsupported` 和 `hideMainWindowPasteFile unsupported`。
  - 要求 image 分支调用 `writePluginImageToClipboard(args.image)`、隐藏主窗口后粘贴。
  - 要求 file 分支调用 `pluginFileClipboardAppleScript(pathsFromBridgeValue(args.file))`、隐藏主窗口后粘贴。
- 初次运行红灯：`paste-image should be implemented by the WebView host instead of returning unsupported`。
- 实现图片/文件剪贴板+隐藏+粘贴路径后，目标测试转绿。

验证：

```bash
pnpm test:plugin-input-bridge
pnpm test:plugin-bridge-capabilities
pnpm test:plugin-host-view
pnpm test:plugin-screen-interactive
pnpm test:plugin-window-lifecycle
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-window-drag-bridge
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-input-bridge`：通过。
- `pnpm test:plugin-bridge-capabilities`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-screen-interactive`：通过。
- `pnpm test:plugin-window-lifecycle`：通过。
- `pnpm test:plugin-window-browser-bridge`：通过。
- `pnpm test:plugin-window-drag-bridge`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 渲染检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1` 显示插件宿主预览，output layer 有 2 行，SubInput 可见且值为 `time`，桥接能力详情为 `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`，无横向溢出，控制台 0 errors / 0 warnings。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:55442"`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，`plugin_runtime_smoke.context_bridge_checked:true`，`plugin_runtime_smoke.dialog_guard_checked:true`，`plugin_runtime_smoke.data_roundtrip_checked:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:55442`。
- 结束后检查 `lsof -nP -iTCP:1420 -sTCP:LISTEN`、`lsof -nP -iTCP:55442 -sTCP:LISTEN` 和 `pgrep -fl "(target/debug/atools|cargo  run|pnpm dev|vite --host 127.0.0.1|vite$|smoke-tauri-desktop)"`：均无残留。
- `git status --short`：退出码 128，当前目录不是 git repository。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 50% | 51% | `hideMainWindowPasteImage(image)` / `hideMainWindowPasteFile(file)` 从 explicit unsupported 推进为图片/文件剪贴板+隐藏+粘贴真实 host 行为 |
| 插件 runtime parity | 99% | 99% | 外部输入桥四类文本/图片/文件/直接输入路径已接入当前 WebView host，但 screenColorPick、startDrag、browser-window 和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展 input bridge 测试并回归插件宿主、构建、Browser 和真实桌面 smoke |

当前重点剩余：

1. 插件 iframe 宿主：screenColorPick、startDrag、createBrowserWindow/sendToParent 等仍是 explicit native-only unsupported 或 native-only 行为。
2. 插件资源兼容：完整 SPA/router 运行态、history API 行为和真实第三方插件包仍需专项回归。
3. 插件安全：完整插件权限授权/隔离模型仍未完成。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 203：插件 hideMainWindowTypeString 直接输入桥

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批继续收口插件外部输入桥：`hideMainWindowTypeString(text)` 不应继续只返回 explicit unsupported，而应在 macOS WebView host 中隐藏主窗口并通过 System Events 直接输入文本。

状态：DONE。

修改文件：

- `src/components/PluginPanel.svelte`
- `scripts/test-plugin-input-bridge.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `hideMainWindowTypeString(text)` host 分支改为真实执行：
  - 复用 `hideMainWindowForPluginPaste()` 隐藏主窗口；Web 预览 fallback 走 `onclose()`。
  - 通过 `appleScriptString(String(args.text ?? ""))` 转义插件文本。
  - 通过 AppleScript `tell application "System Events" to keystroke ...` 向前台应用直接输入文本。
- `hideMainWindowPasteImage`、`hideMainWindowPasteFile` 仍保持明确 method-scoped unsupported，避免在没有完整权限/焦点/剪贴板编排时制造假成功。

TDD 记录：

- 先扩展 `scripts/test-plugin-input-bridge.mjs`：
  - 要求 `PluginPanel.svelte` 不再包含 `hideMainWindowTypeString unsupported`。
  - 要求 host 源码包含 `hideMainWindowForPluginPaste()` 和 `appleScriptString(String(args.text ?? ""))`。
- 初次运行红灯：`type-string should be implemented by the WebView host instead of returning unsupported`。
- 实现主窗口隐藏+System Events 直接输入路径后，目标测试转绿。

验证：

```bash
pnpm test:plugin-input-bridge
pnpm test:plugin-bridge-capabilities
pnpm test:plugin-host-view
pnpm test:plugin-screen-interactive
pnpm test:plugin-window-lifecycle
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-window-drag-bridge
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-input-bridge`：通过。
- `pnpm test:plugin-bridge-capabilities`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-screen-interactive`：通过。
- `pnpm test:plugin-window-lifecycle`：通过。
- `pnpm test:plugin-window-browser-bridge`：通过。
- `pnpm test:plugin-window-drag-bridge`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 渲染检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1` 显示插件宿主预览，output layer 有 2 行，SubInput 可见且值为 `time`，桥接能力详情为 `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`，无横向溢出，控制台 0 errors / 0 warnings。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:53032"`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，`plugin_runtime_smoke.context_bridge_checked:true`，`plugin_runtime_smoke.dialog_guard_checked:true`，`plugin_runtime_smoke.data_roundtrip_checked:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:53032`。
- 结束后检查 `lsof -nP -iTCP:1420 -sTCP:LISTEN`、`lsof -nP -iTCP:53032 -sTCP:LISTEN` 和 `pgrep -fl "(target/debug/atools|cargo  run|pnpm dev|vite --host 127.0.0.1|vite$|smoke-tauri-desktop)"`：均无残留。
- `git status --short`：退出码 128，当前目录不是 git repository。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 49% | 50% | `hideMainWindowTypeString(text)` 从 explicit unsupported 推进为主窗口隐藏+System Events 直接输入真实 host 行为 |
| 插件 runtime parity | 99% | 99% | 文本直接输入兼容提升，但 image/file、screenColorPick、startDrag、browser-window 和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展 input bridge 测试并回归插件宿主、构建、Browser 和真实桌面 smoke |

当前重点剩余：

1. 插件 iframe 宿主：hideMainWindowPasteImage/File、screenColorPick、startDrag、createBrowserWindow/sendToParent 等仍是 explicit native-only unsupported 或 native-only 行为。
2. 插件资源兼容：完整 SPA/router 运行态、history API 行为和真实第三方插件包仍需专项回归。
3. 插件安全：完整插件权限授权/隔离模型仍未完成。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 202：插件 hideMainWindowPasteText 文本粘贴桥

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批从剩余 `input/native-only` 缺口里选取可安全自动化覆盖的文本粘贴桥：`hideMainWindowPasteText(text)` 不应继续只返回 explicit unsupported，而应在 macOS WebView host 中执行剪贴板写入、隐藏主窗口和前台应用标准粘贴。

状态：DONE。

修改文件：

- `src/components/PluginPanel.svelte`
- `scripts/test-plugin-input-bridge.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `hideMainWindowPasteText(text)` host 分支改为真实执行：
  - 使用 Tauri clipboard manager `writeText()` 写入文本。
  - 调用 `hide_main_window` 隐藏主窗口；Web 预览 fallback 走 `onclose()`。
  - 短延迟后通过 AppleScript 触发 `Command+V`。
- `hideMainWindowPasteImage`、`hideMainWindowPasteFile`、`hideMainWindowTypeString` 仍保持明确 method-scoped unsupported，避免在没有完整权限/焦点/剪贴板编排时制造假成功。

TDD 记录：

- 先扩展 `scripts/test-plugin-input-bridge.mjs`：
  - 要求 `PluginPanel.svelte` 不再包含 `hideMainWindowPasteText unsupported`。
  - 要求 host 源码包含 `writeText()`、`hideMainWindowForPluginPaste()` 和 macOS `keystroke "v" using command down`。
- 初次运行红灯：`paste-text should be implemented by the WebView host instead of returning unsupported`。
- 实现文本剪贴板+隐藏+粘贴路径后，目标测试转绿。

验证：

```bash
pnpm test:plugin-input-bridge
pnpm test:plugin-bridge-capabilities
pnpm test:plugin-host-view
pnpm test:plugin-screen-interactive
pnpm test:plugin-window-lifecycle
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-window-drag-bridge
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-input-bridge`：通过。
- `pnpm test:plugin-bridge-capabilities`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-screen-interactive`：通过。
- `pnpm test:plugin-window-lifecycle`：通过。
- `pnpm test:plugin-window-browser-bridge`：通过。
- `pnpm test:plugin-window-drag-bridge`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 渲染检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1` 显示插件宿主预览，output layer 有 2 行，SubInput 可见且值为 `time`，桥接能力详情为 `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`，无横向溢出，控制台 0 errors / 0 warnings。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:50359"`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，`plugin_runtime_smoke.context_bridge_checked:true`，`plugin_runtime_smoke.dialog_guard_checked:true`，`plugin_runtime_smoke.data_roundtrip_checked:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:50359`。
- 结束后检查 `lsof -nP -iTCP:1420 -sTCP:LISTEN`、`lsof -nP -iTCP:50359 -sTCP:LISTEN` 和 `pgrep -fl "(target/debug/atools|cargo  run|pnpm dev|vite --host 127.0.0.1|vite$|smoke-tauri-desktop)"`：均无残留。
- `git status --short`：退出码 128，当前目录不是 git repository。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 48% | 49% | `hideMainWindowPasteText(text)` 从 explicit unsupported 推进为文本剪贴板+隐藏+粘贴真实 host 行为 |
| 插件 runtime parity | 99% | 99% | 文本外部输入兼容提升，但 image/file/typeString、screenColorPick、startDrag、browser-window 和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展 input bridge 测试并回归插件宿主、构建、Browser 和真实桌面 smoke |

当前重点剩余：

1. 插件 iframe 宿主：hideMainWindowPasteImage/File/TypeString、screenColorPick、startDrag、createBrowserWindow/sendToParent 等仍是 explicit native-only unsupported 或 native-only 行为。
2. 插件资源兼容：完整 SPA/router 运行态、history API 行为和真实第三方插件包仍需专项回归。
3. 插件安全：完整插件权限授权/隔离模型仍未完成。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 201：插件运行时动态 base href 资源解析

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 200 的运行时 base marker 资源解析，继续收口 `history/base 动态变更` 缺口：当插件运行中把 `<base href>` 改成新的本地目录时，后续动态资源请求应按 live href 解析，不能继续使用入口 HTML 静态改写留下的旧 marker。

状态：DONE。

修改文件：

- `src/components/PluginPanel.svelte`
- `scripts/test-plugin-resource-runtime.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- iframe 注入 bridge 的 `_runtimeResourceBaseDir()` 现在优先读取当前 `<base href>`。
- 如果当前 href 是新的本地路径，例如 `./live/`，后续动态资源解析会用 live href 作为 baseDir。
- 如果当前 href 已经是静态改写后的 `asset(...)`，bridge 会继续回退到 `data-atools-plugin-base-href` marker，保持 Batch 200 的静态 base 行为。
- remote/data/protocol/hash-only/已转换 `asset(...)` 资源 URL 仍保持跳过行为。

TDD 记录：

- 先扩展 `scripts/test-plugin-resource-runtime.mjs`：
  - 将 `<base>` stub 固定为可变对象，初始状态为 `href="asset(/plugins/sample/pages/runtime/)" data-atools-plugin-base-href="./runtime/"`。
  - 在初始 image/srcset 已按 `./runtime/` 解析后，模拟插件运行时执行 `base.href = "./live/"`。
  - 要求下一次 `window.__atools_resolve_plugin_resource__("./dynamic/live-logo.png")` 发出的资源请求带 `baseDir: "./live/"`。
- 初次运行红灯：实际 `baseDir` 仍是 `./runtime/`，失败信息为 `runtime resolver should prefer a live local base href over the stale static base marker`。
- 实现优先 live local href、再 fallback marker 后，目标测试转绿。

验证：

```bash
pnpm test:plugin-resource-html
pnpm test:plugin-resource-runtime
pnpm test:plugin-host-view
pnpm test:plugin-bridge-capabilities
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-window-drag-bridge
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-resource-html`：通过。
- `pnpm test:plugin-resource-runtime`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-bridge-capabilities`：通过。
- `pnpm test:plugin-window-browser-bridge`：通过。
- `pnpm test:plugin-window-drag-bridge`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 渲染检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1` 显示插件宿主预览，output layer 有 2 行，SubInput 可见且值为 `time`，桥接能力详情为 `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`，无横向溢出，控制台 0 errors / 0 warnings。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:64085"`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，`plugin_runtime_smoke.context_bridge_checked:true`，`plugin_runtime_smoke.dialog_guard_checked:true`，`plugin_runtime_smoke.data_roundtrip_checked:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:64085`。
- 结束后检查 `lsof -nP -iTCP:1420 -sTCP:LISTEN`、`lsof -nP -iTCP:64085 -sTCP:LISTEN` 和 `pgrep -fl "(target/debug/atools|cargo  run|pnpm dev|vite --host 127.0.0.1|vite$|smoke-tauri-desktop)"`：均无残留。
- `git status --short`：退出码 128，当前目录不是 git repository。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 47% | 48% | 运行时动态资源解析开始遵守插件运行中更新后的本地 `<base href>` |
| 插件 runtime parity | 99% | 99% | history/base 动态变更的资源加载继续收口，但完整 SPA/router 行为和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展 runtime 资源转换测试并回归插件宿主、构建、Browser 和真实桌面 smoke |

当前重点剩余：

1. 插件 iframe 宿主：screenColorPick、hideMainWindowPaste*、startDrag、createBrowserWindow/sendToParent 等仍是 explicit native-only unsupported 或 native-only 行为。
2. 插件资源兼容：完整 SPA/router 运行态、history API 行为和真实第三方插件包仍需专项回归。
3. 插件安全：完整插件权限授权/隔离模型仍未完成。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 200：插件运行时 base href 资源解析

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 199 的静态 `<base href>` 资源解析，补齐运行时动态资源部分：插件入口 HTML 改写 `<base>` 后，后续动态插入的本地资源也应按当前 base 目录解析，而不是退回 `main_url` 所在目录。

状态：DONE。

修改文件：

- `src/lib/pluginResourceHtml.ts`
- `src/components/PluginPanel.svelte`
- `scripts/test-plugin-resource-html.mjs`
- `scripts/test-plugin-resource-runtime.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `<base href="./app/">` 改写为 WebView asset URL 时，会同步写入 `data-atools-plugin-base-href="./app/"`，保留运行时可读的原始本地 base。
- iframe 注入 bridge 的运行时资源 resolver 会优先读取 `data-atools-plugin-base-href`，并忽略已经转换后的 `asset(...)` href。
- 动态 `img/source/video/audio/track/iframe/embed/object/script/link` 属性、`srcset`、`<style>` 文本、inline `style` 和 CSSOM `insertRule()` 发起资源转换时会携带当前本地 base href。
- 父窗口收到运行时资源转换请求后，会把 base href 按 `plugin_path + main_url` 换算为真实插件资源目录，再调用 `convertPluginResourceUrl()`。
- 对 remote/data/protocol/hash-only/已转换 `asset(...)` URL 仍保持原有跳过行为。

TDD 记录：

- 先扩展 `scripts/test-plugin-resource-runtime.mjs`：
  - stub 当前文档 `<base href="asset(/plugins/sample/pages/runtime/)" data-atools-plugin-base-href="./runtime/">`。
  - 要求初始 image/srcset、CSS `@import` / `url(...)`、inline style、动态 media/style/script/link 和 CSSOM `insertRule()` 请求都带 `baseDir: "./runtime/"`。
  - 要求父窗口响应后资源落到 `/plugins/sample/pages/runtime/...`。
- 初次运行红灯：`runtime image resources should include the current local base href`，实际 `baseDir` 为空。
- 同步扩展 `scripts/test-plugin-resource-html.mjs`：
  - 要求静态 `<base>` 改写后保留 `data-atools-plugin-base-href="./app/"`。
  - 初次运行红灯：输出只有 `<base href="asset(/plugins/sample/pages/app/)">`，缺少 marker。
- 实现 base marker、运行时读取和父窗口 baseDir 换算后，两个目标测试转绿。

验证：

```bash
pnpm test:plugin-resource-html
pnpm test:plugin-resource-runtime
pnpm test:plugin-host-view
pnpm test:plugin-bridge-capabilities
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-window-drag-bridge
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-resource-html`：通过。
- `pnpm test:plugin-resource-runtime`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-bridge-capabilities`：通过。
- `pnpm test:plugin-window-browser-bridge`：通过。
- `pnpm test:plugin-window-drag-bridge`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 渲染检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1` 显示插件宿主预览，output layer 有 2 行，SubInput 可见且值为 `time`，桥接能力详情为 `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`，无横向溢出，控制台 0 errors / 0 warnings。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:61828"`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，`plugin_runtime_smoke.context_bridge_checked:true`，`plugin_runtime_smoke.dialog_guard_checked:true`，`plugin_runtime_smoke.data_roundtrip_checked:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:61828`。
- 结束后检查 `lsof -nP -iTCP:1420 -sTCP:LISTEN`、`lsof -nP -iTCP:61828 -sTCP:LISTEN` 和 `pgrep -fl "(target/debug/atools|cargo  run|pnpm dev|vite --host 127.0.0.1|vite$|smoke-tauri-desktop)"`：均无残留。
- `git status --short`：退出码 128，当前目录不是 git repository。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 46% | 47% | 运行时动态资源解析开始遵守当前本地 `<base href>` |
| 插件 runtime parity | 99% | 99% | 资源兼容继续提升，但 SPA/router 运行态和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展 HTML/runtime 资源转换测试并回归插件宿主、构建、Browser 和真实桌面 smoke |

当前重点剩余：

1. 插件 iframe 宿主：screenColorPick、hideMainWindowPaste*、startDrag、createBrowserWindow/sendToParent 等仍是 explicit native-only unsupported 或 native-only 行为。
2. 插件资源兼容：SPA/router 运行态、history/base 动态变更和真实第三方插件包仍需专项回归。
3. 插件安全：完整插件权限授权/隔离模型仍未完成。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 199：插件入口 HTML base href 静态资源解析

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 198 的资源兼容收口，处理计划中 `router/base` 缺口的静态资源部分：插件入口 HTML 中声明本地 `<base href>` 后，静态资源应按 base 目录解析，而不是继续按 `main_url` 所在目录解析。

状态：DONE。

修改文件：

- `src/lib/pluginResourceHtml.ts`
- `scripts/test-plugin-resource-html.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `preparePluginHtmlResources()` 会先解析原始 HTML 的首个本地 `<base href>`。
- 本地 base 会影响静态资源准备：
  - `<script src>`
  - stylesheet `<link rel="stylesheet" href>`
  - link icon/modulepreload 等 `<link href>`
  - `img/source/video` 等 `src` / `poster` / `srcset`
  - inline 后 stylesheet 内的 CSS `url(...)` / `@import`
- `<base href="./app/">` 自身会改写为 WebView 可加载 asset URL，例如 `asset(/plugins/sample/pages/app/)`。
- remote/data/protocol/hash-only base 不改变本地资源解析，避免扩大到外部路由语义。

TDD 记录：

- 先扩展 `scripts/test-plugin-resource-html.mjs`：
  - 构造 `mainFile: "pages/index.html"` 且 HTML 含 `<base href="./app/">`。
  - 要求 `scripts/base.js` 读取 `/plugins/sample/pages/app/scripts/base.js`。
  - 要求 `styles/base.css` 读取 `/plugins/sample/pages/app/styles/base.css`。
  - 要求 base 自身、icon、img 和 stylesheet 内 `url("../shared/bg.png")` 都按 `pages/app` 解析。
- 初次运行红灯：实际读取路径仍是 `/plugins/sample/pages/scripts/base.js` / `/plugins/sample/pages/styles/base.css`，说明当前实现没有遵守 `<base href>`。
- 实现 baseDir 解析和传递后，目标测试转绿。

验证：

```bash
pnpm test:plugin-resource-html
pnpm test:plugin-resource-runtime
pnpm test:plugin-host-view
pnpm test:plugin-bridge-capabilities
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-window-drag-bridge
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-resource-html`：通过。
- `pnpm test:plugin-resource-runtime`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-bridge-capabilities`：通过。
- `pnpm test:plugin-window-browser-bridge`：通过。
- `pnpm test:plugin-window-drag-bridge`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 渲染检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1` 显示插件宿主预览，output layer 有 2 行，SubInput 可见且值为 `time`，桥接能力详情为 `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`，无横向溢出，控制台 0 errors / 0 warnings。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:60295"`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，`data_debug_smoke.audit_filtered_export_checked:true`，`data_debug_smoke.audit_filtered_export_count_checked:true`，`permission_smoke.scope_deny_audit_recorded:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:60295`。
- 结束后检查 `lsof -nP -iTCP:1420 -sTCP:LISTEN`、`lsof -nP -iTCP:60295 -sTCP:LISTEN` 和 `pgrep -fl "(target/debug/atools|cargo  run|pnpm dev|vite --host 127.0.0.1|vite$|smoke-tauri-desktop)"`：均无残留。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 45% | 46% | 入口 HTML 静态资源准备开始遵守本地 `<base href>` |
| 插件 runtime parity | 99% | 99% | 静态资源兼容继续提升，但 SPA/router 运行态和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展 HTML 资源转换测试并回归插件宿主相关脚本测试 |

当前重点剩余：

1. 插件 iframe 宿主：screenColorPick、hideMainWindowPaste*、startDrag、createBrowserWindow/sendToParent 等仍是 explicit native-only unsupported 或 native-only 行为。
2. 插件资源兼容：SPA/router 运行态、history/base 动态行为和真实第三方插件包仍需专项回归。
3. 插件安全：完整插件权限授权/隔离模型仍未完成。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 198：插件宿主现代 DOM 插入资源 preflight

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 197 的动态 script/link 插入前资源解析，补齐第三方插件常用的现代 DOM variadic 插入 API，避免插件使用 `append()` / `prepend()` / `before()` / `after()` / `replaceWith()` 时本地脚本或 stylesheet 在 URL 改写前抢跑加载。

状态：DONE。

修改文件：

- `src/components/PluginPanel.svelte`
- `scripts/test-plugin-resource-runtime.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 注入桥继续保留 Batch 197 的 `appendChild()` / `insertBefore()` preflight。
- 新增对 variadic DOM 插入方法的 preflight：
  - `append()`
  - `prepend()`
  - `before()`
  - `after()`
  - `replaceWith()`
- 仅当参数中存在本地资源 `<script src="./...">` 或 `<link href="./...">` 时延迟原始插入调用。
- 非本地、已转换或无资源参数仍走原始同步插入路径。
- variadic 方法保持原 DOM 返回语义：返回 `undefined`，真实插入在资源转换后完成。

TDD 记录：

- 先扩展 `scripts/test-plugin-resource-runtime.mjs`：
  - 给 `ElementStub` 增加 `append()`、`prepend()`、`before()`、`after()`、`replaceWith()` 行为。
  - 要求本地动态 script/link 通过这些方法插入时，在父窗口资源响应前不进入 parent children。
  - 要求父窗口响应后资源属性被转换为 asset URL，并按原 DOM 方法语义完成 append/prepend/sibling/replace 插入。
- 初次运行红灯：`local append script should not be inserted before resource resolution`，说明当前实现只覆盖 `appendChild()` / `insertBefore()`，`append()` 仍会提前插入。
- 实现 variadic preflight patch 后，目标测试转绿。

验证：

```bash
pnpm test:plugin-resource-runtime
pnpm test:plugin-resource-html
pnpm test:plugin-host-view
pnpm test:plugin-bridge-capabilities
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-window-drag-bridge
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-resource-runtime`：通过。
- `pnpm test:plugin-resource-html`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-bridge-capabilities`：通过。
- `pnpm test:plugin-window-browser-bridge`：通过。
- `pnpm test:plugin-window-drag-bridge`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 渲染检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1` 显示插件宿主预览，output layer 有 2 行，SubInput 可见且值为 `time`，桥接能力详情为 `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`，无横向溢出，控制台 0 errors / 0 warnings。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:59460"`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，`data_debug_smoke.audit_filtered_export_checked:true`，`data_debug_smoke.audit_filtered_export_count_checked:true`，`permission_smoke.scope_deny_audit_recorded:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:59460`。
- 结束后检查 `lsof -nP -iTCP:1420 -sTCP:LISTEN`、`lsof -nP -iTCP:59460 -sTCP:LISTEN` 和 `pgrep -fl "(target/debug/atools|cargo  run|pnpm dev|vite --host 127.0.0.1|vite$|smoke-tauri-desktop)"`：均无残留。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 44% | 45% | 本地动态 script/link 资源 preflight 从 `appendChild` / `insertBefore` 扩展到现代 DOM variadic 插入 API |
| 插件 runtime parity | 99% | 99% | 资源兼容继续提升，但 native-only screen/input/drag/browser-window 和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展运行时资源 VM 测试并回归插件宿主相关脚本测试 |

当前重点剩余：

1. 插件 iframe 宿主：screenColorPick、hideMainWindowPaste*、startDrag、createBrowserWindow/sendToParent 等仍是 explicit native-only unsupported 或 native-only 行为。
2. 插件资源兼容：router/base 标签行为和真实第三方插件包仍需专项回归。
3. 插件安全：完整插件权限授权/隔离模型仍未完成。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 197：插件宿主动态 script/link 插入前资源解析

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批继续处理插件运行时资源兼容：Batch 194 的 MutationObserver 能在节点插入后改写 `script/link` 资源属性，但浏览器可能已经用错误的 `srcdoc` 相对 URL 开始加载脚本或 stylesheet。本批对 fetch-sensitive 的动态 `script/link` 插入做 preflight。

状态：DONE。

修改文件：

- `src/components/PluginPanel.svelte`
- `scripts/test-plugin-resource-runtime.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 注入桥在 DOM `Node` 可用时 patch：
  - `Node.prototype.appendChild`
  - `Node.prototype.insertBefore`
- 仅对本地资源节点走 preflight：
  - `<script src="./...">`
  - `<link href="./...">`
- preflight 行为：
  - `appendChild()` / `insertBefore()` 保持同步返回 child。
  - 先通过现有 `__atools_resource_resolve__` 父窗口桥转换本地 URL。
  - 转换完成后调用原始 DOM 插入方法。
  - external/data/protocol/hash-only 和已转换 asset URL 保持原即时插入路径。

TDD 记录：

- 先扩展 `scripts/test-plugin-resource-runtime.mjs`：
  - 给 `ElementStub` 增加真实 `appendChild()` / `insertBefore()` 行为。
  - 要求本地动态 script `appendChild()` 在 URL 转换前不进入 parent children。
  - 要求父窗口响应后 script `src` 被改为 asset URL，并真正 append 到 parent。
  - 要求本地动态 link `insertBefore()` 同样先 resolve，再按 reference node 插入。
- 初次运行红灯：`local dynamic script should not be appended before resource resolution`，说明当前实现仍会让 script 先插入再改写。
- 实现 pre-insertion patch 后，目标测试转绿。

验证：

```bash
pnpm test:plugin-resource-runtime
pnpm test:plugin-resource-html
pnpm test:plugin-host-view
pnpm test:plugin-bridge-capabilities
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-window-drag-bridge
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-resource-runtime`：通过。
- `pnpm test:plugin-resource-html`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-bridge-capabilities`：通过。
- `pnpm test:plugin-window-browser-bridge`：通过。
- `pnpm test:plugin-window-drag-bridge`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 渲染检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1` 显示插件宿主预览，output layer 有 2 行，SubInput 可见且值为 `time`，桥接能力详情为 `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`，无横向溢出，控制台 0 errors / 0 warnings。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:58562"`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，`data_debug_smoke.audit_filtered_export_checked:true`，`data_debug_smoke.audit_filtered_export_count_checked:true`，`permission_smoke.scope_deny_audit_recorded:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:58562`。
- 结束后检查 `lsof -nP -iTCP:1420 -sTCP:LISTEN`、`lsof -nP -iTCP:58562 -sTCP:LISTEN` 和 `pgrep -fl "(target/debug/atools|cargo  run|pnpm dev|vite --host 127.0.0.1|vite$|smoke-tauri-desktop)"`：均无残留。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 43% | 44% | 动态 script/link 本地资源从插入后观察改写推进到插入前 preflight 转换 |
| 插件 runtime parity | 99% | 99% | 资源兼容继续提升，但 native screen/input/browser-window stub 和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展运行时资源 VM 测试并回归静态资源和窗口 bridge 测试 |

当前重点剩余：

1. 插件 iframe 宿主：screenColorPick、hideMainWindowPaste*、startDrag、createBrowserWindow/sendToParent 等仍是 stub 或 native-only unsupported。
2. 插件资源兼容：router/base 标签行为、append/prepend/replaceWith 等更多 DOM 插入 API 和真实第三方插件包仍需专项回归。
3. 插件安全：完整插件权限授权/隔离模型仍未完成。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 196：插件宿主 CSSStyleSheet insertRule 资源解析

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 195 的 runtime CSS 资源桥，处理插件通过 CSSOM `CSSStyleSheet.insertRule()` 动态插入规则时仍保留相对资源 URL 的缺口。

状态：DONE。

修改文件：

- `src/components/PluginPanel.svelte`
- `scripts/test-plugin-resource-runtime.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 注入桥在 CSSOM 可用时 patch `CSSStyleSheet.prototype.insertRule`：
  - 保留原始同步 `insertRule()` 调用和返回 index 行为。
  - 异步复用 runtime CSS token scanner 解析规则中的本地 `url(...)` / 字符串 `@import`。
  - 通过父窗口 `__atools_resource_resolve__` 转换本地资源。
  - 转换完成后用原始 `deleteRule` / `insertRule` 替换对应规则，避免走 patched insertRule 造成递归。
- 保留 external/data/protocol/hash-only 和已转换 asset URL 行为，不扩大到不确定的动态脚本执行时序。

TDD 记录：

- 先扩展 `scripts/test-plugin-resource-runtime.mjs`：
  - 增加 `CSSStyleSheetStub`。
  - 要求 `insertRule(".sheet-icon { background: url('./sheet/icon.svg'); }", 0)` 保持返回 index `0`。
  - 要求该调用产生 `__atools_resource_resolve__` 请求。
  - 父窗口响应后，要求 sheet rule 被替换为 asset URL 版本。
- 初次运行红灯：`CSSStyleSheet.insertRule should resolve local CSS url(...) values`，说明测试覆盖到未实现行为。
- 实现 `insertRule` patch 和规则替换后，目标测试转绿。

验证：

```bash
pnpm test:plugin-resource-runtime
pnpm test:plugin-resource-html
pnpm test:plugin-host-view
pnpm test:plugin-bridge-capabilities
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-window-drag-bridge
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-resource-runtime`：通过。
- `pnpm test:plugin-resource-html`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-bridge-capabilities`：通过。
- `pnpm test:plugin-window-browser-bridge`：通过。
- `pnpm test:plugin-window-drag-bridge`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 渲染检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1` 显示插件宿主预览，output layer 有 2 行，SubInput 可见且值为 `time`，桥接能力详情为 `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`，无横向溢出，控制台 0 errors / 0 warnings。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:57531"`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:57531`。
- 结束后检查 `lsof -iTCP:1420 -sTCP:LISTEN` 和 `pgrep -fl "(target/debug/atools|cargo  run|pnpm dev|vite --host 127.0.0.1|vite$|smoke-tauri-desktop)"`：均无残留。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 42% | 43% | 运行时 CSS 资源桥从 `<style>` / inline style 扩展到 CSSStyleSheet insertRule |
| 插件 runtime parity | 99% | 99% | 资源兼容继续提升，但 native screen/input/browser-window stub 和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展运行时资源 VM 测试并回归静态资源和窗口 bridge 测试 |

当前重点剩余：

1. 插件 iframe 宿主：screenColorPick、hideMainWindowPaste*、startDrag、createBrowserWindow/sendToParent 等仍是 stub 或 native-only unsupported。
2. 插件资源兼容：动态脚本执行抢跑、router/base 标签行为和真实第三方插件包仍需专项回归。
3. 插件安全：完整插件权限授权/隔离模型仍未完成。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 195：插件宿主运行时 CSS 资源解析桥

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 194 的运行时资源解析桥，继续处理插件运行后通过 JS 动态插入的 `<style>` 文本和 inline `style` 属性。此前这些 CSS 内的相对 `url(...)` / `@import` 仍不会经过父窗口资源转换。

状态：DONE。

修改文件：

- `src/components/PluginPanel.svelte`
- `scripts/test-plugin-resource-runtime.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 运行时资源扫描 selector 新增 `<style>` 和 `[style]`。
- `MutationObserver` 新增：
  - `style` attributeFilter。
  - `characterData: true`，用于捕捉 style 文本节点变化。
- 注入桥新增 CSS token 扫描：
  - 支持 runtime CSS `url(...)`。
  - 支持字符串形式 `@import "./theme/base.css"`。
  - 避免使用在 Svelte template string 与 VM 抽取测试之间容易失真的正则转义，改用显式字符扫描。
- `<style>` 文本和 inline `style` 属性改写：
  - 本地相对 CSS 资源通过 `__atools_resource_resolve__` 交给父窗口转换。
  - remote/data/protocol/hash-only 和已转换 asset URL 保持原样。
  - 使用 marker 避免重复转换循环。

TDD 记录：

- 先扩展 `scripts/test-plugin-resource-runtime.mjs`：
  - 要求 runtime scanner selector 包含 style elements 和 style attributes。
  - 要求 observer 监听 `style` 属性和 `characterData`。
  - 要求初始 `<style>` 中的 `@import "./theme/base.css"` 和 `url("../assets/bg image.png?size=2")` 通过父窗口资源解析。
  - 要求 inline `style="background-image: url('../inline/bg.png')"` 被改写，同时保留 data URL。
  - 要求后续插入的 `<style>` 和 style 属性 mutation 也被改写。
- 初次运行红灯：`runtime resource scanner should include style elements and style attributes`，说明测试覆盖到未实现行为。
- 实现 CSS token scanning、style attr/text 处理和 observer 扩展后，目标测试转绿。

验证：

```bash
pnpm test:plugin-resource-runtime
pnpm test:plugin-resource-html
pnpm test:plugin-host-view
pnpm test:plugin-bridge-capabilities
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-window-drag-bridge
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-resource-runtime`：通过。
- `pnpm test:plugin-resource-html`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-bridge-capabilities`：通过。
- `pnpm test:plugin-window-browser-bridge`：通过。
- `pnpm test:plugin-window-drag-bridge`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 渲染检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1` 显示插件宿主预览，output layer 有 2 行，SubInput 可见且值为 `time`，桥接能力详情为 `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`，无横向溢出，控制台 0 errors / 0 warnings。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:56742"`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:56742`。
- 结束后检查 `lsof -iTCP:1420 -sTCP:LISTEN` 和 `pgrep -fl "(target/debug/atools|cargo  run|pnpm dev|vite --host 127.0.0.1|vite$|smoke-tauri-desktop)"`：均无残留。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 41% | 42% | 运行时资源桥从动态节点属性扩展到动态 `<style>` 文本和 inline style CSS 资源 |
| 插件 runtime parity | 99% | 99% | 资源兼容继续提升，但 native screen/input/browser-window stub 和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展运行时资源 VM 测试并回归静态资源和窗口 bridge 测试 |

当前重点剩余：

1. 插件 iframe 宿主：screenColorPick、hideMainWindowPaste*、startDrag、createBrowserWindow/sendToParent 等仍是 stub 或 native-only unsupported。
2. 插件资源兼容：CSSStyleSheet `insertRule`、动态脚本执行抢跑、router/base 标签行为和真实第三方插件包仍需专项回归。
3. 插件安全：完整插件权限授权/隔离模型仍未完成。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 194：插件宿主运行时资源解析桥

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批继续收口插件 iframe 宿主资源兼容：Batch 192/193 已覆盖入口 HTML 静态资源，但插件运行后通过 JS 动态插入的图片、媒体、link、script 等节点仍会落回 `srcdoc` 的无效相对路径。本批先做无 native 副作用的运行时资源属性解析桥。

状态：DONE。

修改文件：

- `src/components/PluginPanel.svelte`
- `scripts/test-plugin-resource-runtime.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 注入桥新增 `window.__atools_resolve_plugin_resource__(url, baseDir?)`：
  - 本地相对 URL 通过 `postMessage` 交给父窗口转换。
  - external/data/protocol/hash-only 和已转换 asset URL 保持原样。
  - 父窗口返回 `__atools_resource_response__`，iframe 内 pending promise resolve/reject。
- `PluginPanel` 父窗口消息处理新增 `__atools_resource_resolve__`：
  - 使用 `convertPluginResourceUrl()`。
  - 使用当前 `action.plugin_path`。
  - 使用 `action.main_url || "index.html"`，保持和入口 HTML 静态资源一致的 `main_url` 相对路径语义。
- 注入桥新增运行时扫描和 `MutationObserver`：
  - 页面 ready 后扫描 `img/source/video/audio/track/iframe/embed/object/script/link` 常见资源节点。
  - 监听新增节点和 `src`、`poster`、`srcset`、`href`、`data` 属性变化。
  - `srcset` 逐个 candidate 转换本地 URL，保留 data/external candidate。
  - 写入 `data-atools-resource-resolved-*` marker，避免重复转换循环。

TDD 记录：

- 先新增 `scripts/test-plugin-resource-runtime.mjs`：
  - 要求 bridge 暴露 `__atools_resolve_plugin_resource__`。
  - 要求 bridge 安装 `MutationObserver` 并监听 `srcset` 等资源属性。
  - 要求初始 `img src`、`source srcset` 通过父窗口资源解析消息转换。
  - 要求后续插入的 `video poster` 也通过 observer 转换。
  - 要求 `PluginPanel` 具有 `__atools_resource_resolve__` / `__atools_resource_response__` 父窗口消息路径。
- 初次运行红灯：`bridge should expose an async runtime resource resolver`，说明测试覆盖到未实现行为。
- 实现 bridge 和父窗口处理后，测试继续暴露 `srcset` 候选解析问题；将桥内 `srcset` 解析从模板字符串中容易混淆的正则改为显式字符扫描后转绿。

验证：

```bash
pnpm test:plugin-resource-runtime
pnpm test:plugin-resource-html
pnpm test:plugin-host-view
pnpm test:plugin-bridge-capabilities
pnpm test:plugin-window-browser-bridge
pnpm test:plugin-window-drag-bridge
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-resource-runtime`：通过。
- `pnpm test:plugin-resource-html`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-bridge-capabilities`：通过。
- `pnpm test:plugin-window-browser-bridge`：通过。
- `pnpm test:plugin-window-drag-bridge`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 渲染检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1` 显示插件宿主预览，output layer 有 2 行，SubInput 可见且值为 `time`，桥接能力详情为 `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`，无横向溢出，控制台 0 errors / 0 warnings。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:56147"`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:56147`。
- 结束后检查 `lsof -iTCP:1420 -sTCP:LISTEN` 和 `pgrep -fl "(target/debug/atools|cargo  run|pnpm dev|vite --host 127.0.0.1|vite$|smoke-tauri-desktop)"`：均无残留。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 40% | 41% | 入口静态资源之外，运行时动态插入的常见资源属性可通过父窗口解析为 WebView asset URL |
| 插件 runtime parity | 99% | 99% | 资源兼容继续提升，但 native screen/input/browser-window stub 和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 新增运行时资源 bridge VM 测试，并回归静态资源和窗口 bridge 测试 |

当前重点剩余：

1. 插件 iframe 宿主：screenColorPick、hideMainWindowPaste*、startDrag、createBrowserWindow/sendToParent 等仍是 stub 或 native-only unsupported。
2. 插件资源兼容：动态脚本执行抢跑、复杂 CSSOM 插入、router/base 标签行为和真实第三方插件包仍需专项回归。
3. 插件安全：完整插件权限授权/隔离模型仍未完成。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 193：插件宿主 srcset 与 CSS import 资源兼容

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 192 的入口 HTML 资源准备，继续补静态资源中更常见但此前未覆盖的形态：响应式图片/媒体 `srcset`、CSS 字符串 `@import`，以及真实 ZTools/Vite 插件中出现的 link icon/modulepreload 资源。

状态：DONE。

修改文件：

- `src/lib/pluginResourceHtml.ts`
- `scripts/test-plugin-resource-html.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `pluginResourceHtml`：
  - HTML 属性改写新增 `srcset`。
  - 新增 `rewriteSrcsetResourceUrls()`，逐个 candidate 转换本地资源路径。
  - data/external candidate 保持原样，避免把 `data:...base64,...` 的逗号误判为 srcset 分隔符。
  - CSS 资源改写新增字符串形式 `@import "./theme/base.css"`。
  - 既有 `@import url(...)` 继续由 CSS `url(...)` pass 覆盖。
- 测试覆盖：
  - `img srcset="./small.png 1x, ../assets/logo@2x.png 2x, https://example.com/remote.png 3x"`。
  - `source srcset="./media/clip-small.mp4 480w, data:video/mp4;base64,abc 720w"`。
  - CSS `@import './theme/base.css'` 和 `@import url('../fonts/font.css') screen`。
  - link icon / modulepreload 本地 href 转换。

TDD 记录：

- 先扩展 `scripts/test-plugin-resource-html.mjs`：
  - 要求 `srcset` 中本地 candidate 转为 asset URL。
  - 要求 external/data candidate 保持原样。
  - 要求 CSS 字符串 `@import` 转为 asset URL。
  - 要求 icon/modulepreload link href 转为 asset URL。
- 初次运行红灯：`srcset` 仍保留 `./small.png` / `../assets/logo@2x.png`，说明测试覆盖到未实现行为。
- 实现 `srcset` candidate 解析和 CSS 字符串 `@import` 改写后，`pnpm test:plugin-resource-html` 转绿。

验证：

```bash
pnpm test:plugin-resource-html
pnpm test:plugin-host-view
pnpm test:plugin-bridge-capabilities
pnpm test:plugin-screen-interactive
pnpm test:tauri-desktop-smoke-script
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-resource-html`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-bridge-capabilities`：通过。
- `pnpm test:plugin-screen-interactive`：通过。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 渲染检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1` 显示插件宿主 output layer，桥接能力详情为 `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`，SubInput 可见且值为 `time`，无横向溢出，控制台 0 errors / 0 warnings。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:55175"`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:55175`。Vite 在退出阶段打印 `The service was stopped` 噪声；历史 smoke 记录中已有相同 shutdown-time 噪声，且本次 smoke JSON 为 `status:"ok"`、命令退出码为 0。
- 结束后检查 `lsof -iTCP:1420 -sTCP:LISTEN` 和 `pgrep -fl "(target/debug/atools|cargo  run|pnpm dev|vite --host 127.0.0.1|vite$|smoke-tauri-desktop)"`：均无残留。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 39% | 40% | 入口 HTML 静态资源从 script/style/image 基础覆盖扩展到 srcset、CSS @import、icon/modulepreload |
| 插件 runtime parity | 99% | 99% | 静态入口资源兼容继续提升，但 native screen/input/browser-window stub 和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 扩展插件资源 helper 测试，并继续通过 Browser、build 和真实 desktop smoke |

当前重点剩余：

1. 插件 iframe 宿主：screenColorPick、hideMainWindowPaste*、startDrag、createBrowserWindow/sendToParent 等仍是 stub 或 native-only unsupported。
2. 插件资源兼容：运行时动态插入的 script/link/img/media 节点、复杂 router/base 标签行为和真实第三方插件包仍需专项回归。
3. 插件安全：完整插件权限授权/隔离模型仍未完成。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 192：插件宿主 HTML 资源路径兼容

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批聚焦插件 iframe 宿主的入口 HTML 资源加载：此前 `srcdoc` 宿主只内联 `<script src>`，且相对路径按插件根目录拼接，导致 `main_url` 位于子目录时脚本路径错误，同时 CSS/图片等相对资源仍依赖 `srcdoc` 的无效相对 URL 解析。本批把入口 HTML 资源准备抽成独立 helper，先覆盖无交互、无副作用的静态入口资源。

状态：DONE。

修改文件：

- `src/lib/pluginResourceHtml.ts`
- `src/components/PluginPanel.svelte`
- `scripts/test-plugin-resource-html.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 `pluginResourceHtml`：
  - `pluginMainResourceDir()` 按 `main_url` 所在目录计算资源基准目录。
  - `pluginResourceFilePath()` 支持相对路径、绝对路径、`.` / `..` 归一化，并跳过 external/data/protocol/hash-only URL。
  - `convertPluginResourceUrl()` 对本地资源调用 `convertFileSrc()`，保留 query/hash suffix。
  - `preparePluginHtmlResources()` 统一准备入口 HTML。
- `PluginPanel`：
  - 从组件内移除 ad-hoc `scriptSrcRegex` 逻辑。
  - 在读取入口 HTML 后调用 `preparePluginHtmlResources()`。
  - 保留后续 preload 注入和 uTools/ZTools bridge 注入顺序。
- 静态入口资源兼容：
  - 本地 `<script src>` 按 `main_url` 目录解析并内联。
  - stylesheet link 按 `main_url` 目录解析并内联为 `<style>`。
  - CSS `url(...)` 按 stylesheet 所在目录解析并转为 asset URL。
  - 常见 HTML 图片/媒体 `src` / `poster` 资源按入口 HTML 目录解析并转为 asset URL。
  - external/data/protocol/hash-only URL 不改写，避免误处理远端或锚点资源。

TDD 记录：

- 新增 `scripts/test-plugin-resource-html.mjs` 并注册 `pnpm test:plugin-resource-html`：
  - 要求 `pluginResourceHtml` helper 存在并导出核心函数。
  - 要求 `main_url="pages/index.html"` 时相对 script/style/image 从 `pages/` 目录解析。
  - 要求 CSS `url("../assets/bg image.png?size=2")` 从 stylesheet 目录解析，并保留 query。
  - 要求 data URL 保持原样。
  - 要求 `PluginPanel` 使用 `preparePluginHtmlResources()` 和 `convertFileSrc()`，且不再包含 `scriptSrcRegex`。
  - 初次运行红灯：`AssertionError: pluginResourceHtml helper should exist`。
- 实现 helper 和组件接入后，`pnpm test:plugin-resource-html` 转绿。
- `pnpm check` 首次发现 stylesheet inliner 的未使用参数；根因是正则参数保留但 `<style>` 输出不需要这些片段，改为显式忽略参数后 `pnpm check` 转绿。

验证：

```bash
pnpm test:plugin-resource-html
pnpm test:plugin-host-view
pnpm test:plugin-bridge-capabilities
pnpm test:plugin-screen-interactive
pnpm test:tauri-desktop-smoke-script
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-resource-html`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-bridge-capabilities`：通过。
- `pnpm test:plugin-screen-interactive`：通过。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，195 modules transformed。
- Browser 渲染检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1` 显示插件宿主 output layer，桥接能力详情为 `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`，SubInput DOM 可见且 smoke value 为 `time`，无横向溢出，控制台 0 errors / 0 warnings。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:54808"`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:54808`。
- 结束后检查 `lsof -iTCP:1420 -sTCP:LISTEN` 和 `pgrep -fl "(target/debug/atools|cargo  run|pnpm dev|vite --host 127.0.0.1|vite$)"`：均无残留。
- `git status --short`：当前目录不是 git 仓库，返回 `fatal: not a git repository`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 38% | 39% | 入口 HTML 资源从 root-only script inlining 推进到 `main_url` 目录相对的 script/style/CSS url/image 资源准备 |
| 插件 runtime parity | 99% | 99% | 静态入口资源兼容提升，但 native screen/input/browser-window stub 和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 新增插件 HTML 资源 helper/host 脚本覆盖，继续通过 Browser 和真实 desktop smoke |

当前重点剩余：

1. 插件 iframe 宿主：screenColorPick、hideMainWindowPaste*、startDrag、createBrowserWindow/sendToParent 等仍是 stub 或 native-only unsupported。
2. 插件资源兼容：运行时动态插入的 script/link/img/media 节点、复杂 router/base 标签行为和真实第三方插件包仍需专项回归。
3. 插件安全：完整插件权限授权/隔离模型仍未完成。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 191：插件宿主 desktopCaptureSources 主屏源兼容列表

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批聚焦插件 iframe 宿主的 screen bridge：此前 `utools.desktopCaptureSources(options)` 已暴露给插件，但宿主直接返回 `desktopCaptureSources unsupported`。本批先接入无交互、无文件副作用的 primary screen source metadata，减少一个 screen bridge stub，同时明确不伪造 native window source 枚举。

状态：DONE。

修改文件：

- `src/lib/pluginScreenBridge.ts`
- `src/components/PluginPanel.svelte`
- `scripts/test-plugin-screen-interactive.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 `desktopCaptureSourcesForDisplay(options, screenInfo, devicePixelRatio)`：
  - 默认或 `types:["screen"]` 返回一个 primary screen source。
  - `types:["window"]` 返回空列表，避免假装支持 Electron/native 窗口源枚举。
  - source 包含 `id`、`name`、`type`、`display_id`、`bounds`、`workArea`、`scaleFactor`、`thumbnail:null` 和 `appIcon:null`。
- `PluginPanel` native bridge：
  - `desktopCaptureSources` 不再直接返回 unsupported。
  - 基于当前 `window.screen` 和 `window.devicePixelRatio` 返回 primary display metadata。
- 能力边界：
  - `screenColorPick(callback)` 仍保持 explicit native-only unsupported。
  - 本批不接入真实 Electron desktopCapturer 窗口枚举、不生成缩略图、不做截图授权流。

TDD 记录：

- 扩展 `scripts/test-plugin-screen-interactive.mjs`：
  - 要求新增 `pluginScreenBridge.ts`。
  - 要求导出 `desktopCaptureSourcesForDisplay`。
  - 要求 `types:["screen"]` 返回 primary screen source，包含 bounds/workArea/scaleFactor。
  - 要求 `types:["window"]` 返回空列表。
  - 要求 `PluginPanel` 使用 `desktopCaptureSourcesForDisplay`，且不再包含 `desktopCaptureSources unsupported`。
  - 初次运行红灯：缺少 `pluginScreenBridge` helper。
- 实现后重新运行 `pnpm test:plugin-screen-interactive` 转绿。

验证：

```bash
pnpm test:plugin-screen-interactive
pnpm test:plugin-screen-display
pnpm test:plugin-bridge-capabilities
pnpm test:plugin-host-view
pnpm test:plugin-system-shell-bridge
pnpm test:tauri-desktop-smoke-script
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-screen-interactive`：通过。
- `pnpm test:plugin-screen-display`：通过。
- `pnpm test:plugin-bridge-capabilities`：通过。
- `pnpm test:plugin-host-view`：通过。
- `pnpm test:plugin-system-shell-bridge`：通过。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，194 modules transformed。
- Browser 渲染检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1` 显示插件宿主预览，桥接能力详情为 `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`，SubInput/output 可见，无横向溢出，控制台 0 errors / 0 warnings。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:53851"`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:53851`。
- 结束后检查 `lsof -iTCP:1420 -sTCP:LISTEN` 和 `pgrep -fl "target/debug/atools|pnpm dev|vite --host 127.0.0.1|smoke-tauri-desktop"`：均无残留。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 37% | 38% | `desktopCaptureSources` 从 host unsupported 推进到 primary screen 兼容源列表 |
| 插件 runtime parity | 99% | 99% | 减少一个 screen bridge stub，但 native window source、缩略图、screenColorPick 和真实第三方插件兼容仍未完成 |
| 测试与发布 | 99% | 99% | 新增前端 screen bridge helper/host 脚本覆盖；发布侧签名、公证、自动更新仍未完成 |

当前重点剩余：

1. 插件 iframe 宿主：screenColorPick、hideMainWindowPaste*、startDrag、createBrowserWindow/sendToParent 等仍是 stub 或 native-only unsupported。
2. 插件 screen bridge：Electron/native desktopCapturer 窗口源枚举、缩略图和授权流仍未接入。
3. 插件安全：完整插件权限授权/隔离模型仍未完成。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 190：插件宿主 shellTrashItem 移到废纸篓桥接

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批聚焦插件 iframe 宿主的系统 shell bridge：此前 `utools.shellTrashItem(path)` 已暴露给插件，但宿主直接返回 `shellTrashItem unsupported`，插件无法执行官方语义的“移到废纸篓”。本批把该 API 在 macOS 下接到 Finder move-to-Trash AppleScript。

状态：DONE。

修改文件：

- `src/lib/pluginSystemShellBridge.ts`
- `src/components/PluginPanel.svelte`
- `scripts/test-plugin-system-shell-bridge.mjs`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 `pluginSystemShellBridge` helper：
  - `normalizeShellTrashPath(value)`：拒绝空路径，避免空参数被当成成功。
  - `shellTrashAppleScript(path)`：生成 Finder `delete POSIX file ...` 脚本，并转义引号和反斜杠。
- `PluginPanel` native bridge：
  - `shellTrashItem` 不再直接返回 unsupported。
  - 从插件参数读取并校验路径。
  - 通过现有 `runAppleScript(..., "shellTrashItem")` 执行 Finder move-to-Trash。
  - 成功后返回 `null`，保持 uTools 风格的副作用 API 形态。
- 能力边界：
  - 本批没有实现外部粘贴、屏幕取色、桌面捕获、detached browser window 或 native drag。
  - 没有引入新的权限授权/隔离模型；该部分仍是后续插件安全收口。

TDD 记录：

- 扩展 `scripts/test-plugin-system-shell-bridge.mjs`：
  - 要求新增 `pluginSystemShellBridge.ts`。
  - 要求导出 `normalizeShellTrashPath` 和 `shellTrashAppleScript`。
  - 要求空路径抛出 `shellTrashItem requires a file path`。
  - 要求包含引号和反斜杠的路径被正确转义。
  - 要求 `PluginPanel` 使用 `shellTrashAppleScript` / `normalizeShellTrashPath`，且不再包含 `shellTrashItem unsupported`。
  - 初次运行红灯：缺少 `pluginSystemShellBridge` helper。
- 实现后重新运行 `pnpm test:plugin-system-shell-bridge` 转绿。

验证：

```bash
pnpm test:plugin-system-shell-bridge
pnpm test:plugin-bridge-capabilities
pnpm test:plugin-dialog-bridge
pnpm test:plugin-input-bridge
pnpm test:plugin-window-drag-bridge
pnpm test:plugin-screen-interactive
pnpm test:tauri-desktop-smoke-script
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-system-shell-bridge`：通过。
- `pnpm test:plugin-bridge-capabilities`：通过。
- `pnpm test:plugin-dialog-bridge`：通过。
- `pnpm test:plugin-input-bridge`：通过。
- `pnpm test:plugin-window-drag-bridge`：通过。
- `pnpm test:plugin-screen-interactive`：通过。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，193 modules transformed。
- Browser 渲染检查：`http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1` 显示插件宿主预览，桥接能力详情为 `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`，SubInput/output 可见，无横向溢出，控制台 0 errors / 0 warnings。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:53438"`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:53438`。
- 结束后检查 `lsof -iTCP:1420 -sTCP:LISTEN` 和 `pgrep -fl "target/debug/atools|pnpm dev|vite --host 127.0.0.1|smoke-tauri-desktop"`：均无残留。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 36% | 37% | `shellTrashItem` 从 host unsupported 推进到 macOS Finder move-to-Trash bridge |
| 插件 runtime parity | 99% | 99% | 桥接面增加一个真实系统副作用 API，但真实第三方插件兼容回归和权限隔离仍未完成 |
| 测试与发布 | 99% | 99% | 新增前端 bridge helper/host 脚本覆盖；发布侧签名、公证、自动更新仍未完成 |

当前重点剩余：

1. 插件 iframe 宿主：hideMainWindowPaste*、screenColorPick、startDrag、createBrowserWindow/sendToParent 等仍是 stub 或 native-only unsupported；desktopCaptureSources 已在 Batch 191 推进到 primary screen 兼容源列表。
2. 插件安全：完整插件权限授权/隔离模型仍未完成。
3. 插件生态：导入后真实第三方插件兼容回归仍未完成。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 189：主搜索结果键盘提示精细化

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批聚焦主搜索结果的键盘可见反馈：此前结果状态栏把上下方向合并为 `↑↓ 移动`，不够贴合 smoke 清单里对 `ArrowDown` 移动到下一行的要求；同时把已由脚本覆盖但 checklist 未同步的 `HTTP 服务` 和 `快捷键 / 全局快捷键` 项一并校正。

状态：DONE。

修改文件：

- `src/lib/searchStatusBar.ts`
- `src/components/SearchStatusBar.svelte`
- `scripts/test-search-status-bar.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 主搜索结果模式下，底部状态栏按键提示从 `↑↓ 移动` 拆分为：
  - `↑ 上一行`
  - `↓ 下一行`
- 保持上下文 Enter 行为：
  - 系统/插件结果：`Enter 执行`
  - 网页快开、链接快开、本地启动、本地应用：`Enter 打开`
  - 文本转换：`Enter 复制`
- 移动端状态栏隐藏规则从第 3 项后隐藏改为第 4 项后隐藏，确保拆分方向键后仍能保留 `Enter` 动作提示。
- 重新核对并同步 macOS smoke checklist：
  - 搜索结果当前选中行上下文 Enter 提示。
  - Settings 左侧 `HTTP 服务` / `关于` 菜单。
  - `HTTP 服务` 非空页、MCP 替代入口、token/security 提示和复制配置 fallback。
  - `快捷键 / 全局快捷键` 的当前呼出快捷键、录制/保存状态和自定义全局快捷键空态。

TDD 记录：

- 扩展 `scripts/test-search-status-bar.mjs`：
  - 要求结果状态栏显示 `↑:上一行` 和 `↓:下一行`。
  - 要求 `Enter` 可分别显示 `执行`、`打开` 和 `复制`。
  - 要求移动端 CSS 从 `.hint:nth-child(n + 4)` 开始隐藏，避免窄屏丢掉 `Enter`。
  - 初次运行红灯：实际仍是 `↑↓:移动`，且移动端从第 3 项开始隐藏。
- 实现后重新运行 `pnpm test:search-status-bar` 转绿。

验证：

```bash
pnpm test:search-status-bar
pnpm test:result-presentation
pnpm test:http-service-settings
pnpm test:http-service-overview
pnpm test:hotkey-recorder
pnpm test:settings-pages
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:search-status-bar`：通过。
- `pnpm test:result-presentation`：通过。
- `pnpm test:http-service-settings`：通过。
- `pnpm test:http-service-overview`：通过。
- `pnpm test:hotkey-recorder`：通过。
- `pnpm test:settings-pages`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，192 modules transformed。
- Browser 渲染检查：`http://127.0.0.1:1420/` 输入 `set` 后显示 `Enter 执行`、`↑ 上一行`、`↓ 下一行`；触发 `ArrowDown` 后选中 `打开 桌面`，状态栏显示 `2 / 2 · 打开 桌面` 和 `Enter 打开`；控制台 0 errors / 0 warnings。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:52877"`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:52877`。
- 结束后检查 `lsof -iTCP:1420 -sTCP:LISTEN` 和 `pgrep -fl "target/debug/atools|pnpm dev|vite --host 127.0.0.1|smoke-tauri-desktop"`：均无残留。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 99% | 100% | 结果行上下文 Enter 提示和状态栏上下行提示都已由脚本覆盖 |
| Home/search experience | 85% | 86% | `ui-ztools` 粗口径中继续推进主搜索状态栏 smoke 细节 |
| 设置页 UI / smoke 覆盖 | 99% | 99% | HTTP 服务和全局快捷键 smoke checklist 与已有脚本证据对齐，功能百分比不再上调 |

当前重点剩余：

1. 插件生态：远程插件下载/更新、完整插件权限授权/隔离模型、导入后真实兼容回归仍未完成。
2. 插件 iframe 宿主：dialog/shell/screen/clipboard/file/browser context 高优 API 和资源路径兼容仍是高风险缺口。
3. 内置 Agent 工具：文件搜索索引化、OCR 本地服务依赖、浏览器兼容/权限引导仍可增强。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 188：自定义插件市场远程目录读取

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批聚焦设置页 `插件市场`：此前自定义市场地址只能作为外部 URL 打开，插件市场仍显示“网络下载未接入”。本批把它推进到真实远程 JSON 目录读取和展示，但继续明确不做远程下载、安装、更新或评分详情。

状态：DONE。

修改文件：

- `src/lib/types.ts`
- `src/lib/pluginMarketStatus.ts`
- `src/components/SettingsPanel.svelte`
- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`
- `scripts/test-plugin-market-status.mjs`
- `scripts/test-plugin-market-overview.mjs`
- `scripts/test-plugin-market-catalog.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增前端共享类型 `PluginMarketCatalog` / `PluginMarketCatalogPlugin`，匹配 Tauri command 返回结构。
- `pluginMarketStatus()` 支持远程目录读取态：
  - 未读取时保持 `未接入`，但提示自定义地址已保存且可刷新读取目录。
  - 读取成功后显示 `目录可用`。
  - `目录读取` 和 `市场搜索` 标记可用。
  - `下载/更新` 和 `远程评分` 继续标记未接入。
- Settings -> `插件市场`：
  - `刷新插件` 在桌面端先读取已安装插件数量。
  - 若 `pluginMarketCustom` 和 `pluginMarketUrl` 有效，则调用 `fetch_plugin_market_catalog`。
  - 读取成功后展示 `远程目录` 列表，包含插件名、描述、版本、作者和来源更新时间。
  - Web 预览仍明确提示需在桌面应用中查看。
- Tauri command：
  - 新增 `fetch_plugin_market_catalog(url)`。
  - 仅接受 http/https catalog URL。
  - 使用 15 秒超时的 reqwest client。
  - 支持 JSON 字段 `updatedAt` / `updated_at`、`downloadUrl` / `download_url`。
  - 过滤无名称或无合法 http/https `downloadUrl` 的条目。
  - 缺失 ID 时从插件名生成安全 ID。
- 保持能力边界：本批只读取和展示远程目录 metadata，不下载 zip、不安装、不更新、不执行远程插件。

TDD 记录：

- 扩展 `scripts/test-plugin-market-status.mjs`：
  - 要求状态包含 `remoteCatalogLoaded` 和 `remotePluginCount`。
  - 要求远程能力从旧 `分类浏览` 改为 `目录读取`。
  - 初次运行红灯：`remoteCatalogLoaded` 为 undefined。
- 扩展 `scripts/test-plugin-market-overview.mjs`：
  - 修正当前已有 `市场地址` 卡片的期望。
  - 要求远程能力显示 `0/4 可用`，目录读取成功时可显示可用数量。
  - 初次运行红灯：旧测试和当前卡片结构不一致，且本地入口 tone 仍按缺失自定义地址误判为 desktop。
- 新增 `scripts/test-plugin-market-catalog.mjs`：
  - 要求 catalog loaded 状态为 `目录可用`。
  - 要求 SettingsPanel 包含 `PluginMarketCatalog`、`fetch_plugin_market_catalog`、`remoteCatalogLoaded` 和 `远程目录` 列表。
  - 初次运行红灯：市场状态仍是 `disabled`，SettingsPanel 没有远程目录读取路径。
- 扩展 Rust 单测：
  - 本地 HTTP server 返回 catalog JSON。
  - 要求 `fetch_plugin_market_catalog_from_url()` 读取并规范化插件条目，过滤无下载 URL 的条目。
  - 初次运行红灯：helper/command 不存在。

验证：

```bash
pnpm test:plugin-market-status
pnpm test:plugin-market-overview
pnpm test:plugin-market-catalog
pnpm test:tauri-desktop-smoke-script
cargo fmt --check
cargo test -p atools --lib
cargo test -p atools-core --lib
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-market-status`：通过。
- `pnpm test:plugin-market-overview`：通过。
- `pnpm test:plugin-market-catalog`：通过。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `cargo fmt --check`：通过。
- `cargo test -p atools --lib`：通过，64 tests。
- `cargo test -p atools-core --lib`：通过，36 tests。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，192 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:52087"`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:52087`。
- 结束后检查 `lsof -iTCP:1420 -sTCP:LISTEN` 和 `pgrep -fl "target/debug/atools|pnpm dev|vite --host 127.0.0.1|smoke-tauri-desktop"`：均无残留。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 设置页功能完成度 | 99% | 99% | 插件市场从纯未接入状态页推进到可展示自定义远程目录；整体仍受远程下载/更新、权限授权和发布项约束 |
| 设置项真实功能 | 99% | 99% | 自定义插件市场地址已接入保存、外部打开和远程 JSON 目录读取/展示；远程下载/更新仍未完成 |
| 插件安装/导入 | 59% | 61% | 自定义插件市场不再只是外部 URL，已能读取和展示远程 catalog metadata；远程安装/更新仍未接入 |
| Tauri/Rust 桌面底座 | 97% | 97% | 新增远程目录读取命令和单测，但签名、公证、自动更新仍未完成 |
| 测试与发布 | 99% | 99% | 新增前端、Rust 和真实 desktop smoke 覆盖 |

当前重点剩余：

1. 插件市场：远程插件 zip 下载、安装、更新、取消/重试任务、签名/校验和评分详情仍未接入。
2. 插件管理：完整插件权限授权/隔离模型和导入后真实兼容回归仍需继续。
3. 设置真实功能：GPU 启动参数仍不在 macOS 上伪造设置；超级面板/悬浮球的拖拽、吸边和选区触发属于后续增强。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 187：超级面板独立桌面窗口

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批聚焦设置页 `通用设置` 里此前被禁用的 `启用超级面板`：把它从“窗口尚未实现”的假开关推进为真实 Tauri 独立窗口。当前先补基础桌面窗口、剪贴板文本入口和打开主搜索，选中文本自动触发、拖拽/吸边后续再做。

状态：DONE。

修改文件：

- `src/lib/settings.ts`
- `src/lib/settingsPages.ts`
- `src/components/SettingsPanel.svelte`
- `src/App.svelte`
- `src-tauri/src/window.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/desktop_smoke.rs`
- `scripts/test-settings-normalization.mjs`
- `scripts/test-settings-pages.mjs`
- `scripts/test-general-settings-overview.mjs`
- `scripts/test-super-panel-ui.mjs`
- `scripts/test-tauri-desktop-smoke-script.mjs`
- `scripts/smoke-tauri-desktop.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `normalizeSettings()` 不再强制 `superPanelEnabled=false`，只保留真实 boolean；旧字符串等非法值不会被当成启用。
- `applyNativeSettings()` 增加 `set_super_panel_visible` 调用，设置保存后会同步桌面窗口显示状态。
- `generalUnsupportedCapabilities()` 移除 `superPanel`，通用概览的暂缓能力文案同步收窄为 GPU 启动参数。
- 设置页 `通用设置`：
  - `启用超级面板` 从 disabled 占位改为可用开关。
  - 切换时调用 `set_super_panel_visible`，并继续走 settings 保存。
  - Web 预览下明确提示不会创建桌面窗口。
- Tauri 窗口层：
  - 新增 `SUPER_PANEL_LABEL = "super-panel"` 等尺寸和顶部偏移常量。
  - 新增设置解析和主屏顶部居中定位 helper。
  - 新增 `ensure_super_panel_window()` 和 `set_super_panel_visible()`。
  - 显示时创建透明、无边框、不可缩放、always-on-top、skip-taskbar 的独立 Webview；关闭时隐藏已有窗口，不在禁用状态下预创建。
- Tauri setup 启动时读取 `settings-general` 并应用超级面板开关。
- 前端 `App.svelte` 新增 `/#/super-panel` 路由：读取剪贴板文本，提供刷新、复制和 `打开主搜索` 动作。
- 桌面 smoke 新增 `system_settings_smoke.super_panel_window`，验证窗口可创建、可隐藏，且 smoke 不改写 `settings-general`。

TDD 记录：

- 扩展 `scripts/test-settings-normalization.mjs`：
  - 要求 `superPanelEnabled:true` 归一化后保留为 true。
  - 初次运行红灯：生产代码仍强制 false。
- 扩展 `scripts/test-settings-pages.mjs`：
  - 要求暂缓能力数量从 2 降为 1。
  - 要求暂缓能力不再包含 `superPanel`，但仍包含 `disableGpuAcceleration`。
  - 初次运行红灯：`superPanel` 仍在 `generalUnsupportedCapabilities()` 中。
- 扩展 `scripts/test-general-settings-overview.mjs`：
  - 要求 SettingsPanel 包含 `setSuperPanelVisible`、`set_super_panel_visible` 调用、启用态文案和 `persistSuperPanelChange`。
  - 要求不再出现 `超级面板尚未实现，暂不启用`。
  - 初次运行红灯：设置页仍是禁用占位开关。
- 新增 `scripts/test-super-panel-ui.mjs`：
  - 要求 `App.svelte` 包含 `isSuperPanelWindow`、`/#/super-panel`、`openMainFromSuperPanel`、`show_main_window`、`superPanelClipboardText`、`readText()`、`copySuperPanelText`、`super-panel-shell` 和 `super-panel-surface`。
  - 初次运行红灯：App 没有超级面板窗口路由。
- 扩展 Rust 单测：
  - 要求超级面板 label、初始 URL、settings JSON bool 解析和主屏顶部居中几何计算正确。
  - 初次运行红灯：`crate::window` 尚无超级面板 helper/常量。
- 扩展桌面 smoke 脚本校验：
  - 要求 `system_settings_smoke.super_panel_window` 必须存在并为 true。

验证：

```bash
pnpm test:settings-normalization
pnpm test:settings-pages
pnpm test:general-settings-overview
pnpm test:super-panel-ui
pnpm test:tauri-desktop-smoke-script
cargo fmt --check
cargo test -p atools --lib
cargo test -p atools-core --lib
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:settings-normalization`：通过。
- `pnpm test:settings-pages`：通过。
- `pnpm test:general-settings-overview`：通过。
- `pnpm test:super-panel-ui`：通过。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `cargo fmt --check`：通过。
- `cargo test -p atools --lib`：通过，63 tests。
- `cargo test -p atools-core --lib`：通过，36 tests。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，192 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:51238"`，`system_settings_smoke.floating_ball_window:true`，`system_settings_smoke.super_panel_window:true`，`agent_tools_count:8`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:51238`。
- 结束后检查 `lsof -iTCP:1420 -sTCP:LISTEN` 和 `pgrep -fl "target/debug/atools|pnpm dev|vite --host 127.0.0.1|smoke-tauri-desktop"`：均无残留。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 设置页功能完成度 | 99% | 99% | 超级面板从禁用占位变成真实桌面窗口设置；设置页整体仍受远程插件更新、权限授权和发布项约束 |
| 设置项真实功能 | 99% | 99% | 超级面板已接入设置保存、启动应用、独立窗口显示/隐藏、剪贴板文本入口和点击打开主搜索；远程插件更新和完整权限模型仍未完成 |
| 超级面板设置/窗口 | 0% | 100% | 已支持保存、启动应用、透明置顶窗口、主屏顶部定位、隐藏、剪贴板文本读取/复制和唤起主搜索；选中文本触发、拖拽/吸边可作为后续增强 |
| Tauri/Rust 桌面底座 | 97% | 97% | 新增独立窗口命令和真实 smoke 覆盖，但签名、公证、自动更新仍未完成 |
| 测试与发布 | 99% | 99% | 新增前端、脚本、Rust 和真实 desktop smoke 覆盖 |

当前重点剩余：

1. 设置真实功能：GPU 启动参数仍不在 macOS 上伪造设置；超级面板/悬浮球的拖拽、吸边和选区触发属于后续增强。
2. 插件管理：远程插件市场下载/更新、完整插件权限授权/隔离模型和导入后真实兼容回归仍需继续。
3. Agent/MCP：更多 MCP 客户端实测和真实第三方插件 tool 兼容回归仍需继续。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 186：悬浮球独立桌面窗口

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批聚焦设置页 `通用设置` 里此前被禁用的 `显示悬浮球`：把它从“窗口尚未实现”的假开关推进为真实 Tauri 独立窗口，并保持超级面板和 GPU 启动参数的未实现边界。

状态：DONE。

修改文件：

- `src/lib/settings.ts`
- `src/lib/settingsPages.ts`
- `src/components/SettingsPanel.svelte`
- `src/App.svelte`
- `src-tauri/src/window.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/desktop_smoke.rs`
- `scripts/test-settings-normalization.mjs`
- `scripts/test-settings-pages.mjs`
- `scripts/test-general-settings-overview.mjs`
- `scripts/test-floating-ball-ui.mjs`
- `scripts/test-tauri-desktop-smoke-script.mjs`
- `scripts/smoke-tauri-desktop.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `normalizeSettings()` 不再强制 `floatingBallEnabled=false`，只保留真实 boolean；旧字符串等非法值不会被当成启用。
- `generalUnsupportedCapabilities()` 移除 `floatingBall`，通用概览的暂缓能力文案同步收窄为超级面板和 GPU 启动参数。
- 设置页 `通用设置`：
  - `显示悬浮球` 从 disabled 占位改为可用开关。
  - 切换时调用 `set_floating_ball_visible`，并继续走 settings 保存和 `applyNativeSettings()`。
  - Web 预览下明确提示不会创建桌面窗口。
- Tauri 窗口层：
  - 新增 `FLOATING_BALL_LABEL = "floating-ball"` 等尺寸/边距常量。
  - 新增设置解析和主屏右下角定位 helper。
  - 新增 `ensure_floating_ball_window()` 和 `set_floating_ball_visible()`。
  - 显示时创建透明、无边框、不可缩放、always-on-top、skip-taskbar 的独立 Webview；关闭时隐藏已有窗口，不在禁用状态下预创建。
- Tauri setup 启动时读取 `settings-general` 并应用悬浮球开关。
- 前端 `App.svelte` 新增 `/#/floating-ball` 路由：只渲染紧凑 Z 按钮，点击调用 `show_main_window` 打开主搜索。
- 桌面 smoke 新增 `system_settings_smoke.floating_ball_window`，验证窗口可创建、可隐藏，且 smoke 不改写 `settings-general`。

TDD 记录：

- 扩展 `scripts/test-settings-normalization.mjs`：
  - 要求 `floatingBallEnabled:true` 归一化后保留为 true。
  - 初次运行红灯：生产代码仍强制 false。
- 扩展 `scripts/test-settings-pages.mjs`：
  - 要求暂缓能力数量从 3 降为 2。
  - 要求暂缓能力不再包含 `floatingBall`，但仍包含 `disableGpuAcceleration`。
  - 初次运行红灯：`floatingBall` 仍在 `generalUnsupportedCapabilities()` 中。
- 扩展 `scripts/test-general-settings-overview.mjs`：
  - 要求 SettingsPanel 包含 `setFloatingBallVisible`、`set_floating_ball_visible` 调用、启用态文案和 `persistFloatingBallChange`。
  - 要求不再出现 `悬浮球窗口尚未实现，暂不启用`。
  - 初次运行红灯：设置页仍是禁用占位开关。
- 新增 `scripts/test-floating-ball-ui.mjs`：
  - 要求 `App.svelte` 包含 `isFloatingBallWindow`、`/#/floating-ball`、`openMainFromFloatingBall`、`show_main_window`、`floating-ball-shell` 和 `floating-ball-button`。
  - 初次运行红灯：App 没有悬浮球窗口路由。
- 扩展 Rust 单测：
  - 要求悬浮球 label、初始 URL、settings JSON bool 解析和主屏右下角几何计算正确。
  - 初次运行红灯：`crate::window` 尚无悬浮球 helper/常量。
- 扩展桌面 smoke 脚本校验：
  - 要求 `system_settings_smoke.floating_ball_window` 必须存在并为 true。

验证：

```bash
pnpm test:settings-normalization
pnpm test:settings-pages
pnpm test:general-settings-overview
pnpm test:floating-ball-ui
pnpm test:tauri-desktop-smoke-script
cargo fmt --check
cargo test -p atools --lib
cargo test -p atools-core --lib
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:settings-normalization`：通过。
- `pnpm test:settings-pages`：通过。
- `pnpm test:general-settings-overview`：通过。
- `pnpm test:floating-ball-ui`：通过。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `cargo fmt --check`：通过。
- `cargo test -p atools --lib`：通过，62 tests。
- `cargo test -p atools-core --lib`：通过，36 tests。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，192 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:50223"`，`system_settings_smoke.floating_ball_window:true`，`agent_tools_count:8`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:50223`。
- 结束后检查 `lsof -iTCP:1420 -sTCP:LISTEN` 和 `pgrep -fl "target/debug/atools|pnpm dev|vite --host 127.0.0.1|smoke-tauri-desktop"`：均无残留。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 设置页功能完成度 | 99% | 99% | 悬浮球从禁用占位变成真实桌面窗口设置；设置页整体仍受超级面板、远程插件更新、权限授权和发布项约束 |
| 设置项真实功能 | 99% | 99% | 悬浮球已接入设置保存、启动应用、独立窗口显示/隐藏和点击打开主搜索；超级面板、远程插件更新和完整权限模型仍未完成 |
| 悬浮球设置/窗口 | 0% | 100% | 已支持保存、启动应用、透明置顶窗口、主屏定位、隐藏和点击唤起主搜索；拖拽/吸边可作为后续增强 |
| Tauri/Rust 桌面底座 | 97% | 97% | 新增独立窗口命令和真实 smoke 覆盖，但签名、公证、自动更新仍未完成 |
| 测试与发布 | 99% | 99% | 新增前端、脚本、Rust 和真实 desktop smoke 覆盖 |

当前重点剩余：

1. 设置真实功能：超级面板仍是未启用边界；GPU 启动参数仍不在 macOS 上伪造设置。
2. 插件管理：远程插件市场下载/更新、完整插件权限授权/隔离模型和导入后真实兼容回归仍需继续。
3. Agent/MCP：更多 MCP 客户端实测和真实第三方插件 tool 兼容回归仍需继续。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 185：自定义插件市场地址外部入口

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批聚焦设置页 `通用设置` 里此前被禁用的 `自定义插件市场`：把它从“网络市场暂缓”的假开关推进为可保存、可展示、可打开的外部市场地址入口，同时不宣称远程下载/更新已经完成。

状态：DONE。

修改文件：

- `src/lib/settings.ts`
- `src/lib/settingsPages.ts`
- `src/lib/pluginMarketStatus.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-settings-normalization.mjs`
- `scripts/test-settings-pages.mjs`
- `scripts/test-general-settings-overview.mjs`
- `scripts/test-plugin-market-status.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `AToolsSettings` 新增 `pluginMarketUrl`，默认空字符串。
- `normalizeSettings()` 新增插件市场 URL 规范化：
  - 只接受 `http` / `https` URL。
  - 保存前 trim 空白。
  - 只有 `pluginMarketCustom === true` 且 URL 合法时才保持启用。
  - 非法协议或空 URL 会清空并关闭自定义市场，避免旧数据假启用。
- `generalUnsupportedCapabilities()` 移除 `pluginMarketCustom`，当前通用页暂缓能力收窄到超级面板、悬浮球和 GPU 启动参数。
- 设置页 `通用设置`：
  - `自定义插件市场` 从禁用占位项变为可启用开关。
  - 新增 `插件市场地址` 输入，支持 http/https 地址。
  - 未填写地址时开关不可启用。
  - 文案明确该地址会作为插件市场页外部入口，网络下载和远程更新仍未接入。
- 设置页 `插件市场`：
  - 状态模型新增 `customMarketConfigured` 和 `customMarketUrl`。
  - 概览新增 `市场地址` 卡片。
  - 本地替代入口新增 `自定义地址` 能力行。
  - 启用地址后页面展示已保存 URL。
  - 桌面端 `打开市场地址` 调用现有 `shell_open` Tauri 命令打开该 URL。
- 远程能力边界保持不变：分类浏览、市场搜索、下载/更新、远程评分和详情仍全部暂缓。

TDD 记录：

- 扩展 `scripts/test-settings-normalization.mjs`：
  - 要求无 URL 时 `pluginMarketUrl` 归一化为空且 `pluginMarketCustom=false`。
  - 要求合法 URL trim 后保留，并允许 `pluginMarketCustom=true`。
  - 要求关闭开关时合法 URL 仍可保存但不启用。
  - 要求 `ftp://...` 这类非法协议被清空且关闭。
  - 初次运行红灯：`pluginMarketUrl` 字段尚不存在。
- 扩展 `scripts/test-settings-pages.mjs`：
  - 要求暂缓能力数量从 4 降为 3。
  - 要求暂缓能力不再包含 `pluginMarketCustom`。
  - 初次运行红灯：自定义插件市场仍在 `generalUnsupportedCapabilities()` 中。
- 扩展 `scripts/test-general-settings-overview.mjs`：
  - 要求 SettingsPanel 包含 `插件市场地址`、`bind:value={pluginMarketUrl}`、启用态文案、`openPluginMarketUrl`、`shell_open` 调用和 `打开市场地址`。
  - 要求不再出现 `插件市场尚未实现，暂不启用`。
  - 初次运行红灯：设置页仍是禁用占位开关。
- 扩展 `scripts/test-plugin-market-status.mjs`：
  - 要求市场状态输出 `customMarketConfigured=true` 和已保存 URL。
  - 要求 summary 同时说明 `插件市场网络下载尚未接入` 与 `自定义市场地址已保存`。
  - 要求本地能力新增 `自定义地址`，桌面端配置后可用，Web 预览下不可用。
  - 要求概览卡新增 `市场地址`。
  - 初次运行红灯：市场状态模型尚无自定义市场字段。
- 实现后，上述四条目标测试转绿。

验证：

```bash
pnpm test:settings-normalization
pnpm test:settings-pages
pnpm test:general-settings-overview
pnpm test:plugin-market-status
cargo fmt --check
cargo test -p atools --lib
cargo test -p atools-core --lib
pnpm test:tauri-desktop-smoke-script
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:settings-normalization`：通过。
- `pnpm test:settings-pages`：通过。
- `pnpm test:general-settings-overview`：通过。
- `pnpm test:plugin-market-status`：通过。
- `cargo fmt --check`：通过。
- `cargo test -p atools --lib`：通过，61 tests。
- `cargo test -p atools-core --lib`：通过，36 tests。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，192 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:64612"`，`agent_tools_count:8`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:64612`。Vite/esbuild 在退出阶段打印 service-stop / `write EPIPE` 噪声和一次 esbuild callback 噪声，但命令退出码为 0。
- 结束后检查 `lsof -nP -iTCP:1420 -sTCP:LISTEN` 和 `pgrep -fl "target/debug/atools|vite.*1420|pnpm dev|smoke-tauri-desktop"`：均无残留。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 设置页功能完成度 | 99% | 99% | 自定义插件市场地址从禁用占位变成可保存、可展示、可打开的外部入口；设置页整体仍受远程插件更新/权限授权/发布项约束 |
| 设置项真实功能 | 99% | 99% | 插件市场地址已接入设置保存和 `shell_open` 外部打开链路；超级面板、悬浮球、远程插件更新和完整权限模型仍未完成 |
| 自定义插件市场地址 | 0% | 100% | 已支持 http/https URL 保存、非法协议拒绝、市场页状态展示和桌面端外部打开；不包含远程下载/更新 |
| 测试与发布 | 99% | 99% | 新增 4 条前端脚本断言，并通过真实 desktop smoke |

当前重点剩余：

1. 设置真实功能：超级面板、悬浮球仍是未启用边界。
2. 插件管理：远程插件市场下载/更新、完整插件权限授权/隔离模型和导入后真实兼容回归仍需继续。
3. Agent/MCP：更多 MCP 客户端实测和真实第三方插件 tool 兼容回归仍需继续。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 184：开发者工具位置偏好与打开命令

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批聚焦设置页 `通用设置` 里此前被禁用的 `开发者工具位置`：把它从强制回默认的占位项变成真实可保存偏好，并新增桌面端命令按当前偏好打开指定窗口 DevTools。

状态：DONE。

修改文件：

- `src/lib/settings.ts`
- `src/lib/settingsPages.ts`
- `src/components/SettingsPanel.svelte`
- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`
- `scripts/test-settings-normalization.mjs`
- `scripts/test-settings-pages.mjs`
- `scripts/test-general-settings-overview.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `AToolsSettings.devToolsMode` 收窄为 `detach` / `right` / `bottom` / `undocked`。
- `normalizeSettings()` 新增 DevTools mode 规范化：
  - 合法值会保留。
  - 非法旧值会回退到默认 `detach`。
- 设置页不再在保存时强制把 `devToolsMode` 写回默认值。
- 设置页加载 native/local settings 后会保留已保存的 DevTools 偏好。
- `generalUnsupportedCapabilities()` 移除 `devToolsMode`。
- 设置页 `通用设置`：
  - `开发者工具位置` 下拉从禁用变为可编辑。
  - 文案说明 DevTools 会按偏好打开，但原生停靠能力取决于当前 WebView。
  - 新增 `打开主窗口 DevTools` 桌面端动作。
- Rust 新增 `open_devtools_for_window` Tauri command：
  - 读取并校验 settings 中的 `devToolsMode`。
  - 支持 `main` / `settings` 窗口 label。
  - 调用 Tauri `open_devtools()` 打开目标窗口 DevTools。
  - 对非法 mode 或未知窗口返回明确错误。

TDD 记录：

- 扩展 `scripts/test-settings-normalization.mjs`：
  - 要求 `devToolsMode: "bottom"` 被保留。
  - 要求非法旧值 `attach` 回退默认值。
  - 初次运行红灯：`normalizeSettings()` 仍强制回 `detach`。
- 扩展 `scripts/test-settings-pages.mjs`：
  - 要求暂缓能力数量从 5 降为 4。
  - 要求暂缓能力不再包含 `devToolsMode`。
  - 初次运行红灯：`devToolsMode` 仍在 `generalUnsupportedCapabilities()` 中。
- 扩展 `scripts/test-general-settings-overview.mjs`：
  - 要求 SettingsPanel 包含 DevTools 偏好文案、`bind:value={devToolsMode}`、`onchange={persistSoon}`、`openDevtoolsForWindow` 和 `open_devtools_for_window` 调用。
  - 要求不再出现 `插件 DevTools 位置控制尚未接入`。
  - 初次运行红灯：设置页仍是禁用下拉和未接入文案。
- 新增 Rust 红灯测试 `devtools_mode_settings_are_parsed_for_window_opening`：
  - 要求 helper 接受 `right` / `bottom` / `undocked`，缺省回 `detach`。
  - 要求非法 `attach` 返回包含 `DevTools` 的错误。
  - 要求默认窗口 label 为 `main`。
  - 初次运行红灯：`devtools_mode_from_settings` / `devtools_target_label` 不存在。
- 实现后，上述四条目标测试转绿。

验证：

```bash
pnpm test:settings-normalization
pnpm test:settings-pages
pnpm test:general-settings-overview
cargo test -p atools --lib devtools_mode_settings_are_parsed_for_window_opening
cargo fmt --check
cargo test -p atools --lib
cargo test -p atools-core --lib
pnpm test:tauri-desktop-smoke-script
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:settings-normalization`：通过。
- `pnpm test:settings-pages`：通过。
- `pnpm test:general-settings-overview`：通过。
- `cargo test -p atools --lib devtools_mode_settings_are_parsed_for_window_opening`：通过。
- `cargo fmt --check`：通过；首次检查发现 `commands.rs` 格式差异，运行 `cargo fmt` 后重新验证通过。
- `cargo test -p atools --lib`：通过，61 tests。
- `cargo test -p atools-core --lib`：通过，36 tests。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，192 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:63289"`，`agent_tools_count:8`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:63289`。Vite/esbuild 在退出阶段打印 `write EPIPE` / service-stop 噪声和一次 esbuild callback 噪声，但命令退出码为 0。
- 结束后检查 `lsof -nP -iTCP:1420 -sTCP:LISTEN` 和 `pgrep -fl "target/debug/atools|vite.*1420|pnpm dev|smoke-tauri-desktop"`：均无残留。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 设置页功能完成度 | 99% | 99% | DevTools 位置从禁用占位变成可保存偏好，并有桌面端打开命令；设置页整体仍受插件市场/权限授权/发布项约束 |
| 设置项真实功能 | 99% | 99% | 开发者工具位置已接入设置保存和 Tauri DevTools 打开链路；超级面板、悬浮球、插件市场地址、远程插件更新和完整权限模型仍未完成 |
| DevTools 位置设置 | 0% | 100% | 已支持偏好保存、非法旧值回退、主/设置窗口 DevTools 打开命令；原生 dock 细节由 WebView 决定 |
| 测试与发布 | 99% | 99% | 新增 1 条 Rust 单测、3 条前端脚本断言，并通过真实 desktop smoke |

当前重点剩余：

1. 设置真实功能：超级面板、悬浮球、插件市场地址仍是未启用边界。
2. 插件管理：远程插件更新、完整插件权限授权/隔离模型和导入后真实兼容回归仍需继续。
3. Agent/MCP：更多 MCP 客户端实测和真实第三方插件 tool 兼容回归仍需继续。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 183：网络代理设置接入请求层

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批聚焦设置页 `通用设置` 里此前被禁用的 `网络代理`：把它从“尚未接入请求层”的占位开关推进为真实设置，并接到 AI `/models` 连接测试和 WebDAV 请求客户端。

状态：DONE。

修改文件：

- `src/lib/settings.ts`
- `src/lib/settingsPages.ts`
- `src/lib/debugDiagnostics.ts`
- `src/components/SettingsPanel.svelte`
- `src-tauri/src/commands.rs`
- `src-tauri/src/webdav.rs`
- `scripts/test-settings-normalization.mjs`
- `scripts/test-settings-pages.mjs`
- `scripts/test-general-settings-overview.mjs`
- `scripts/test-debug-diagnostics.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `AToolsSettings` 新增 `proxyUrl`，默认空字符串。
- `normalizeSettings()` 新增代理 URL 规范化：
  - 只接受 `http` / `https` URL。
  - 保存前 trim 空白。
  - 只有 `proxyEnabled === true` 且 URL 合法时才保持启用。
  - 非法协议或空 URL 会清空并关闭代理，避免旧数据假启用。
- 设置页 `通用设置`：
  - `网络代理` 不再是禁用占位项。
  - 新增 `代理地址` 输入，支持 `http://127.0.0.1:7890` 这类 http/https 代理。
  - 文案明确代理会用于 WebDAV 同步和 AI 模型连接测试。
  - 未填写地址时开关不可启用。
- `generalUnsupportedCapabilities` 移除 proxy 项。
- AI `/models` 连接测试：
  - `AiConnectionConfig` 新增 `proxy_url`。
  - 构造 `reqwest::Client` 时应用 `reqwest::Proxy::all(proxy_url)`。
  - 非法代理 URL 返回明确 proxy 错误。
- WebDAV 请求层：
  - `WebdavSyncConfig` 新增 `proxy_url`。
  - sync、远端备份下载、设置恢复下载、剪贴板导入下载、插件数据导入下载和 manifest 校验统一走带代理配置的 client。
  - 启用代理但 URL 为空或协议非法时返回明确错误。
- 调试诊断包：
  - 增加 `proxyEnabled`。
  - `proxyUrl` 始终输出 `<redacted>`。

TDD 记录：

- 扩展 `scripts/test-settings-normalization.mjs`：
  - 要求合法代理 URL trim 后保留，并保持 `proxyEnabled=true`。
  - 要求 `ftp://...` 这类非法协议被清空且关闭代理。
  - 初次运行红灯：`normalizeSettings()` 仍强制 `proxyEnabled=false`。
- 扩展 `scripts/test-settings-pages.mjs`：
  - 要求 `generalUnsupportedCapabilities` 不再包含 proxy。
  - 初次运行红灯：暂缓项数量仍是 6。
- 扩展 `scripts/test-general-settings-overview.mjs`：
  - 要求 SettingsPanel 包含 `代理地址`、`bind:value={proxyUrl}` 和请求层接入文案。
  - 要求不再出现 `代理设置尚未接入请求层`。
  - 初次运行红灯：设置页仍没有代理地址输入。
- 新增 Rust 红灯测试 `network_proxy_settings_are_parsed_for_ai_and_webdav_requests`：
  - 要求 AI 配置和 WebDAV 配置都能从 settings 解析出合法 `proxy_url`。
  - 要求关闭代理时为 `None`。
  - 要求非法协议返回包含 proxy 的错误。
  - 初次运行红灯：`AiConnectionConfig` / `WebdavSyncConfig` 还没有 `proxy_url`。
- 扩展 `scripts/test-debug-diagnostics.mjs`：
  - 要求诊断包输出 `proxyEnabled=true`。
  - 要求带账号密码的 `proxyUrl` 被脱敏。
  - 初次运行红灯：诊断包没有代理字段。
- 实现后，上述五条目标测试转绿。

验证：

```bash
pnpm test:settings-normalization
pnpm test:settings-pages
pnpm test:general-settings-overview
pnpm test:debug-diagnostics
cargo test -p atools --lib network_proxy_settings_are_parsed_for_ai_and_webdav_requests
cargo fmt --check
cargo test -p atools --lib
cargo test -p atools-core --lib
pnpm test:tauri-desktop-smoke-script
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:settings-normalization`：通过。
- `pnpm test:settings-pages`：通过。
- `pnpm test:general-settings-overview`：通过。
- `pnpm test:debug-diagnostics`：通过。
- `cargo test -p atools --lib network_proxy_settings_are_parsed_for_ai_and_webdav_requests`：通过。
- `cargo fmt --check`：通过。
- `cargo test -p atools --lib`：通过，60 tests。
- `cargo test -p atools-core --lib`：通过，36 tests。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，192 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:62052"`，`agent_tools_count:8`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:62052`。Vite 在退出阶段打印 `write EPIPE` 噪声，但命令退出码为 0。
- 结束后检查 `lsof -nP -iTCP:1420 -sTCP:LISTEN` 和 `pgrep -fl "target/debug/atools|vite.*1420|pnpm dev|smoke-tauri-desktop"`：均无残留。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 设置页功能完成度 | 99% | 99% | 代理设置已从禁用占位变成真实控制，但设置页整体仍受插件市场/权限授权/发布项约束 |
| 设置项真实功能 | 99% | 99% | 网络代理已接入 AI 连接测试和 WebDAV 请求层；超级面板、悬浮球、插件市场地址、开发者工具位置、远程插件更新和完整权限模型仍未完成 |
| 网络代理设置 | 0% | 100% | 已支持 http/https 代理 URL 保存、非法协议拒绝、请求层应用和诊断脱敏 |
| 测试与发布 | 99% | 99% | 新增 1 条 Rust 单测、4 条前端脚本断言，并通过真实 desktop smoke |

当前重点剩余：

1. 设置真实功能：超级面板、悬浮球、插件市场地址、开发者工具位置仍是未启用边界。
2. 插件管理：远程插件更新、完整插件权限授权/隔离模型和导入后真实兼容回归仍需继续。
3. Agent/MCP：更多 MCP 客户端实测和真实第三方插件 tool 兼容回归仍需继续。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 182：WebDAV 插件数据逐文档冲突选择

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 181 的全量冲突覆盖能力，把 WebDAV 插件数据恢复补到逐文档选择：恢复计划列出同插件同文档 ID 的冲突，用户可以勾选冲突文档，只覆盖选中的远端版本。

状态：DONE。

修改文件：

- `src-tauri/src/webdav.rs`
- `src-tauri/src/commands.rs`
- `src/lib/types.ts`
- `src/lib/webdavSyncView.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-webdav-sync-view.mjs`
- `scripts/test-webdav-settings-overview.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `WebdavRestorePlanItem` 新增 `plugin_conflicts`，恢复计划会列出插件 ID、插件名、文档 ID、本机摘要和远端摘要。
- 新增 `overwrite_selected_conflicts` 恢复模式。
- `restore_webdav_plugin_data` 新增 `selected_conflict_documents` 参数。
- 默认 `append_missing` 行为保持不变：只导入缺失文档并跳过冲突。
- `overwrite_conflicts` 行为保持不变：确认后覆盖全部冲突。
- `overwrite_selected_conflicts` 会导入缺失文档，只覆盖已选择的冲突文档；未选择冲突继续跳过。
- 设置页 `WebDAV 同步`：
  - 恢复计划预览显示 `冲突 n 条`。
  - 新增 `插件数据冲突选择` 区块。
  - 支持 `全选冲突`、`清空选择`。
  - 新增单独危险动作 `覆盖选中冲突`，调用时传入 `mode: "overwrite_selected_conflicts"` 和 `selectedConflictDocuments`。

TDD 记录：

- 先新增 Rust 红灯测试 `webdav_plugin_data_restore_selected_conflicts_only_replaces_chosen_docs`：
  - 构造两个冲突文档和一个缺失文档。
  - 要求选择模式只覆盖被选中的冲突文档，未选冲突保留本机版本。
  - 初次运行红灯：`WebdavPluginDataConflictSelection`、`OverwriteSelectedConflicts` 和函数第 5 个选择参数均不存在。
- 新增 Rust 红灯测试 `plugin_data_restore_plan_lists_same_id_conflict_documents`：
  - 构造本机/远端插件数据 payload。
  - 要求恢复计划只列出同插件同文档 ID 且内容不同的冲突文档，忽略相同文档、缺失文档和本机不存在插件。
  - 初次运行红灯：`WebdavRestorePlanItem.plugin_conflicts` 不存在。
- 扩展 `scripts/test-webdav-sync-view.mjs`：
  - 要求 `webdavPluginDataSelectedOverwriteButtonState()` 覆盖未选择和已选择状态。
  - 要求 `webdavRestorePlanRows()` 对插件数据计划显示 `冲突 2 条`。
  - 初次运行红灯：`webdavPluginDataSelectedOverwriteButtonState is not a function`。
- 扩展 `scripts/test-webdav-settings-overview.mjs`：
  - 要求 SettingsPanel 包含 `覆盖选中冲突`、`插件数据冲突选择`、`selectedConflictDocuments` 和 `mode: "overwrite_selected_conflicts"`。
  - 初次运行红灯：SettingsPanel 没有选择性覆盖入口。
- 实现后，上述四条目标测试转绿。

验证：

```bash
cargo test -p atools --lib webdav_plugin_data_restore_selected_conflicts_only_replaces_chosen_docs
cargo test -p atools --lib plugin_data_restore_plan_lists_same_id_conflict_documents
pnpm test:webdav-sync-view
pnpm test:webdav-settings-overview
cargo fmt --check
cargo test -p atools --lib
cargo test -p atools-core --lib
pnpm test:settings-pages
pnpm check
pnpm test:tauri-desktop-smoke-script
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `cargo test -p atools --lib webdav_plugin_data_restore_selected_conflicts_only_replaces_chosen_docs`：通过。
- `cargo test -p atools --lib plugin_data_restore_plan_lists_same_id_conflict_documents`：通过。
- `pnpm test:webdav-sync-view`：通过。
- `pnpm test:webdav-settings-overview`：通过。
- `cargo fmt --check`：通过；首次检查发现格式差异，运行 `cargo fmt` 后重新验证通过。
- `cargo test -p atools --lib`：通过，59 tests。
- `cargo test -p atools-core --lib`：通过，36 tests。
- `pnpm test:settings-pages`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm build`：通过，192 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:60478"`，`agent_tools_count:8`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:60478`。Vite 在退出阶段打印 `The service was stopped` 噪声，但命令退出码为 0。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 设置页功能完成度 | 99% | 99% | 设置页整体仍受插件市场/权限授权/发布项约束，但 WebDAV 插件数据恢复 UI 已补齐逐文档选择 |
| 设置项真实功能 | 99% | 99% | WebDAV 插件数据恢复从全量覆盖冲突推进到选中文档覆盖；超级面板、悬浮球、代理、远程插件更新和完整权限模型仍未完成 |
| WebDAV 插件数据恢复 | 99% | 100% | 已支持追加缺失、跳过冲突、覆盖全部冲突、逐文档选择冲突覆盖、结果计数和恢复计划冲突预览 |
| 测试与发布 | 99% | 99% | 新增 2 条 Rust 单测、2 条前端脚本断言，并通过真实 desktop smoke |

当前重点剩余：

1. 设置真实功能：超级面板、悬浮球、代理、插件市场地址、开发者工具位置仍是未启用边界。
2. 插件管理：远程插件更新、完整插件权限授权/隔离模型和导入后真实兼容回归仍需继续。
3. Agent/MCP：更多 MCP 客户端实测和真实第三方插件 tool 兼容回归仍需继续。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 181：WebDAV 插件数据覆盖冲突导入

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 180 的插件数据追加导入，补齐覆盖式冲突合并：默认导入仍安全跳过冲突，另提供单独高风险“覆盖冲突数据”动作，确认后才用远端同 ID 文档覆盖本机冲突文档。

状态：DONE。

修改文件：

- `src-tauri/src/commands.rs`
- `src/lib/types.ts`
- `src/lib/webdavSyncView.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-webdav-sync-view.mjs`
- `scripts/test-webdav-settings-overview.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 WebDAV 插件数据恢复模式：
  - `append_missing` 仍是默认安全模式。
  - `overwrite_conflicts` 为显式覆盖冲突模式。
- `restore_webdav_plugin_data` 新增可选 `mode` 参数。
- 插件数据恢复结果新增 `overwritten_documents`。
- `append_missing` 继续只导入缺失文档，同 ID 冲突跳过，本机不存在插件跳过。
- `overwrite_conflicts` 会导入缺失文档，并覆盖本机已安装插件中同 ID 且内容不同的文档；内容相同仍计为 unchanged，缺失插件仍跳过。
- 设置页 `WebDAV 同步` 新增单独危险动作 `覆盖冲突数据`：
  - 使用独立确认标题和确认按钮。
  - 确认文案明确“远端同 ID 文档会替换本机冲突文档”。
  - 调用 Tauri 命令时传入 `mode: "overwrite_conflicts"`。
- 插件数据恢复结果行新增 `已覆盖`，与 `已导入`、`冲突文档` 分开展示。

TDD 记录：

- 先新增 Rust 红灯测试 `webdav_plugin_data_restore_overwrite_mode_replaces_conflicts`：
  - 构造本机已安装插件、缺失文档、冲突文档、相同文档和本机不存在插件。
  - 要求覆盖模式导入缺失文档、覆盖冲突文档、保留相同文档 unchanged，并正确统计 skipped/missing plugin。
  - 初次运行红灯：`apply_webdav_plugin_data_payload_with_mode` 和 `WebdavPluginDataRestoreMode` 不存在。
- 扩展 `scripts/test-webdav-sync-view.mjs`：
  - 要求 `webdavPluginDataOverwriteButtonState()` 覆盖可覆盖和覆盖中状态。
  - 要求插件数据恢复结果行显示 `已覆盖`。
  - 初次运行红灯：`webdavPluginDataOverwriteButtonState is not a function`。
- 扩展 `scripts/test-webdav-settings-overview.mjs`：
  - 要求 SettingsPanel 包含 `覆盖冲突数据`、`mode: "overwrite_conflicts"` 和冲突覆盖提示文案。
  - 初次运行红灯：SettingsPanel 没有覆盖冲突动作和显式 mode 参数。
- 实现后，上述三条目标测试转绿。

验证：

```bash
cargo test -p atools --lib webdav_plugin_data_restore_overwrite_mode_replaces_conflicts
pnpm test:webdav-sync-view
pnpm test:webdav-settings-overview
cargo fmt --check
cargo test -p atools --lib
cargo test -p atools-core --lib
pnpm test:settings-pages
pnpm check
pnpm test:tauri-desktop-smoke-script
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `cargo test -p atools --lib webdav_plugin_data_restore_overwrite_mode_replaces_conflicts`：通过。
- `pnpm test:webdav-sync-view`：通过。
- `pnpm test:webdav-settings-overview`：通过；一次中间失败暴露 SettingsPanel 未传入精确 `mode: "overwrite_conflicts"` 字面量，修正请求对象后通过。
- `cargo fmt --check`：通过。
- `cargo test -p atools --lib`：通过，57 tests。
- `cargo test -p atools-core --lib`：通过，36 tests。
- `pnpm test:settings-pages`：通过。
- `pnpm check`：0 errors / 0 warnings；一次中间失败暴露普通导入按钮把 `MouseEvent` 误传给 `mode`，改为 `onclick={() => restoreWebdavPluginData()}` 后通过。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm build`：通过，192 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:59235"`，`agent_tools_count:8`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:59235`。Vite 在退出阶段打印 `write EPIPE` 噪声，但命令退出码为 0。
- 一次 desktop smoke 暴露旧的兼容 wrapper 已无调用并产生 `dead_code` warning；删除 wrapper 后重新 smoke 通过且无该 warning。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 设置页功能完成度 | 98% | 99% | WebDAV 插件数据从安全追加恢复升级为显式覆盖冲突恢复，设置页 WebDAV 恢复链路更完整 |
| 设置项真实功能 | 99% | 99% | 插件数据覆盖冲突确认流已接入，但逐文档冲突选择、完整插件权限授权、远程插件更新等仍使整体保持 99% |
| 测试与发布 | 99% | 99% | 新增覆盖冲突 Rust 单测、视图脚本测试、SettingsPanel 字面量检查，并通过真实 desktop smoke |

当前重点剩余：

1. 设置真实功能：WebDAV 插件数据逐文档冲突选择和整库覆盖策略仍可增强。
2. Agent/MCP：更多 MCP 客户端实测和真实第三方插件 tool 兼容回归仍需继续。
3. 插件管理：插件市场、远程更新、完整插件权限授权/隔离模型和导入后真实兼容回归仍需继续。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 180：WebDAV 插件数据追加导入

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批聚焦 WebDAV 真实功能里长期保留的“插件数据恢复应用”缺口：在已有 WebDAV 备份上传、远端预览、恢复计划、设置恢复和剪贴板追加导入基础上，新增插件数据的安全追加导入。

状态：DONE。

修改文件：

- `src-tauri/src/webdav.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`
- `src/lib/types.ts`
- `src/lib/webdavSyncView.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-webdav-sync-view.mjs`
- `scripts/test-webdav-settings-overview.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 WebDAV 插件数据下载计划：
  - `restore_webdav_plugin_data(config, confirmed)` 需要显式确认。
  - 从远端 manifest 定位并读取 `plugin-data.json`。
  - 返回远端目录、manifest 类型、导出时间和插件数据 payload。
- 新增 Tauri 命令 `restore_webdav_plugin_data`：
  - 复用当前 WebDAV 设置构造配置。
  - 应用远端插件数据后记录 runtime event。
- 新增本地插件数据安全应用策略：
  - 只处理本机已安装插件。
  - 只导入本机缺失的文档。
  - 同 ID 文档内容相同计为 unchanged 并跳过。
  - 同 ID 文档内容不同计为 conflict 并跳过，不覆盖本机插件数据。
  - 远端插件本机不存在时计入 missing plugins，并跳过该插件文档。
- 设置页 `WebDAV 同步`：
  - 新增 `导入插件数据` 按钮。
  - 确认文案明确“只追加缺失文档，冲突文档会跳过”。
  - 恢复计划说明从“插件数据仍只预览”更新为“插件数据可追加导入”。
  - 新增插件数据导入结果区，展示远端插件/文档、已导入、已跳过、冲突、缺失插件和耗时。
- 共享 WebDAV 视图模型新增插件数据导入按钮状态和结果行模型。

TDD 记录：

- 先新增 Rust 红灯测试 `webdav_plugin_data_restore_imports_missing_docs_and_skips_conflicts`：
  - 构造本机已安装插件和一个本地已有文档。
  - 远端 payload 同时包含缺失文档、冲突文档和本机不存在插件。
  - 未确认时要求返回 `explicit confirmation` 且不写入。
  - 确认后要求只导入缺失文档，冲突文档保留本机内容，missing plugin 计数正确。
  - 初次运行红灯：`no apply_webdav_plugin_data_payload in commands`。
- 扩展 `scripts/test-webdav-sync-view.mjs`：
  - 要求 `webdavPluginDataRestoreButtonState()` 覆盖桌面端、未生成计划、无变化、可导入和导入中状态。
  - 要求 `webdavPluginDataRestoreRows()` 展示远端插件、远端文档、已导入、已跳过、冲突文档、缺失插件和耗时。
  - 初次运行红灯：`webdavPluginDataRestoreButtonState is not a function`。
- 扩展 `scripts/test-webdav-settings-overview.mjs`：
  - 要求 SettingsPanel 包含 `restoreWebdavPluginData`、`导入插件数据`、原生 `restore_webdav_plugin_data` 调用和 `冲突文档会跳过` 文案。
  - 初次运行红灯：SettingsPanel 没有插件数据恢复动作。
- 实现后，上述三条目标测试转绿。

验证：

```bash
cargo test -p atools --lib webdav_plugin_data_restore_imports_missing_docs_and_skips_conflicts
pnpm test:webdav-sync-view
pnpm test:webdav-settings-overview
cargo fmt --check
cargo test -p atools --lib
cargo test -p atools-core --lib
pnpm test:settings-pages
pnpm check
pnpm test:tauri-desktop-smoke-script
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `cargo test -p atools --lib webdav_plugin_data_restore_imports_missing_docs_and_skips_conflicts`：通过。
- `pnpm test:webdav-sync-view`：通过。
- `pnpm test:webdav-settings-overview`：通过。
- `cargo fmt --check`：通过。首次检查发现格式差异，运行 `cargo fmt` 后重新验证通过。
- `cargo test -p atools --lib`：通过，56 tests。
- `cargo test -p atools-core --lib`：通过，36 tests。
- `pnpm test:settings-pages`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm build`：通过，192 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:58329"`，`agent_tools_count:8`，权限/数据/系统设置/插件 runtime smoke 均通过，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:58329`。
- 注意：一次 `cargo test -p atools --lib` 与 `pnpm build` 并行运行时，Tauri embed assets 读取到正在被 Vite 重写的 dist hash 文件，导致旧资产文件缺失错误；串行重跑 `cargo test -p atools --lib` 后 56 tests 通过。
- 收尾检查：`lsof -nP -iTCP:1420 -sTCP:LISTEN` 和相关 `pgrep` 均无残留进程。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 设置页功能完成度 | 97% | 98% | WebDAV 从设置恢复/剪贴板追加导入推进到插件数据追加导入，设置页少一个“只预览不写入”的真实功能缺口 |
| 设置项真实功能 | 99% | 99% | 插件数据恢复应用已接入，但覆盖式冲突合并、完整插件权限授权、远程插件更新等仍使整体保持 99% |
| 测试与发布 | 99% | 99% | 新增 WebDAV 插件数据恢复单测和视图脚本测试，并通过真实 desktop smoke |

当前重点剩余：

1. 设置真实功能：WebDAV 插件数据覆盖式冲突合并和更细粒度覆盖/跳过策略仍可增强。
2. Agent/MCP：更多 MCP 客户端实测和真实第三方插件 tool 兼容回归仍需继续。
3. 插件管理：插件市场、远程更新、完整插件权限授权/隔离模型和导入后真实兼容回归仍需继续。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 179：审计 JSONL 文件归档

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 178 的审计保留清理，把剩余的审计归档策略落到真实功能：用户可以在设置页选择文件位置，把最近审计记录写成 JSONL 文件，作为清理旧记录前的本地归档。

状态：DONE。

修改文件：

- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`
- `src/lib/types.ts`
- `src/lib/settingsPages.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-data-settings-overview.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 Tauri 命令 `archive_audit_entries_jsonl`：
  - 写入目标路径由用户文件选择器提供。
  - 需要 `confirmed=true`，未确认时不会创建文件。
  - 自动创建父目录，写入最近最多 1000 条审计 JSONL。
  - 返回 `AuditArchiveResult { path, count }`，供前端显示归档位置和数量。
- 设置页 `我的数据`：
  - 审计数据行新增 `归档到文件` 按钮。
  - 默认文件名为 `atools-audit-archive-YYYY-MM-DD.jsonl`。
  - 归档动作独立于剪贴板导出和按策略清理，不会删除审计记录。
- 数据概览模型补充“保留策略清理和文件归档”文案，避免只呈现导出/清空能力。

TDD 记录：

- 先新增 Rust 红灯测试 `audit_archive_file_requires_confirmation_and_writes_jsonl`：
  - 构造一条固定审计记录。
  - 未确认写入时要求返回 `explicit confirmation`，并且目标文件不存在。
  - 确认写入后要求返回 `count=1`、路径正确、文件为换行结尾的 JSONL，并能解析出 `id/client_id/tool_name`。
  - 初次运行红灯：`no write_audit_archive_file in commands`。
- 再扩展 `scripts/test-data-settings-overview.mjs`：
  - 要求审计概览卡包含 `归档`。
  - 要求 SettingsPanel 包含 `archiveAudits`、`归档到文件`、`atools-audit-archive`。
  - 要求调用 `invoke<AuditArchiveResult>("archive_audit_entries_jsonl", ...)`。
  - 初次运行红灯：审计卡片仍只描述保留策略清理，设置页没有归档入口。
- 实现原生命令、前端类型、设置页入口和共享文案后，两条目标测试转绿。

验证：

```bash
cargo test -p atools --lib audit_archive_file_requires_confirmation_and_writes_jsonl
pnpm test:data-settings-overview
cargo fmt --check
cargo test -p atools --lib
cargo test -p atools-core --lib
pnpm test:settings-pages
pnpm check
pnpm test:tauri-desktop-smoke-script
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `cargo test -p atools --lib audit_archive_file_requires_confirmation_and_writes_jsonl`：通过。
- `pnpm test:data-settings-overview`：通过。
- `cargo fmt --check`：通过。
- `cargo test -p atools --lib`：通过，55 tests。
- `cargo test -p atools-core --lib`：通过，36 tests。
- `pnpm test:settings-pages`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm build`：通过，192 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:57168"`，`agent_tools_count:8`，权限/数据/系统设置/插件 runtime smoke 均通过，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:57168`。Vite/esbuild 在退出阶段打印 `write EPIPE` 噪声，但命令退出码为 0。
- 收尾检查：`lsof -nP -iTCP:1420 -sTCP:LISTEN` 和相关 `pgrep` 均无残留进程。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 权限与审计 | 96% | 97% | 审计历史从复制导出/筛选/保留清理扩展为可写入用户选择的 JSONL 归档文件，清理前的数据保全路径更完整 |
| 设置项真实功能 | 99% | 99% | `我的数据` 新增真实原生归档动作，但整体仍因超级面板、远程插件更新、完整插件权限授权等保留 99% |
| 测试与发布 | 99% | 99% | 新增归档写文件单测和数据页模型测试，并通过真实 desktop smoke |

当前重点剩余：

1. 权限与审计：更多真实客户端长历史回放和归档后批量检索体验仍可增强。
2. Agent/MCP：更多 MCP 客户端实测和真实第三方插件 tool 兼容回归仍需继续。
3. 插件管理：插件市场、远程更新、完整插件权限授权/隔离模型和导入后真实兼容回归仍需继续。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 178：审计保留策略清理

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批聚焦权限与审计剩余缺口里的审计保留策略：在已有审计查询、筛选、导出和清空基础上，增加可按规则清理旧审计记录的本地 SQLite 命令和设置页入口，避免长历史无限增长只能全量清空。

状态：DONE。

修改文件：

- `crates/atools-core/src/db.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`
- `src/lib/settingsPages.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-data-settings-overview.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 `Database::prune_audit_entries(older_than, keep_latest)`：
  - 先删除早于 cutoff 的审计记录。
  - 再按 `timestamp DESC, id DESC` 只保留最新 N 条。
  - 返回实际删除数量，重复执行同一策略时不会继续删除。
- 新增 Tauri 命令 `prune_audit_entries`：
  - 参数 `retentionDays` 会转换为 UTC ISO cutoff。
  - 参数 `keepLatest` 控制最多保留的最新审计条数。
  - `retentionDays=0` 返回明确错误，避免误把 0 天当作“删除几乎全部历史”。
- 设置页 `我的数据`：
  - 审计数据行增加 `清理旧记录`。
  - 新增 `审计保留策略` 区块，展示 `90 天`、`1000 条` 和当前审计状态。
  - 清理前使用已有页内确认弹窗，不使用浏览器原生 `confirm`。
- 数据概览模型补充审计保留策略文案，Web 预览仍明确桌面端读取真实审计数据库。

TDD 记录：

- 先新增 Rust 红灯测试 `test_prune_audit_entries_applies_age_and_count_retention`：
  - 构造 4 条固定 timestamp 审计。
  - 按 `older_than=2026-06-01T00:00:00Z` 和 `keep_latest=2` 清理。
  - 期望删除旧记录和超出数量的中间记录，只保留最新两条。
  - 初次运行红灯：`no method named prune_audit_entries found for struct Database`。
- 再扩展 `scripts/test-data-settings-overview.mjs`：
  - 要求审计概览卡包含 `保留策略`。
  - 要求 `auditRetentionPolicyRows()` 输出保留时间、数量上限和当前状态。
  - 要求 SettingsPanel 渲染 `审计保留策略` 并调用 `invoke<number>("prune_audit_entries", ...)`。
  - 初次运行红灯：审计卡片仍只描述输入/输出/权限/副作用，没有保留策略。
- 实现 DB、Tauri command、共享前端模型和设置页入口后，两条目标测试转绿。
- `cargo fmt --check` 首次发现 `db.rs` 格式差异，运行 `cargo fmt` 后重新验证通过。

验证：

```bash
cargo test -p atools-core --lib test_prune_audit_entries_applies_age_and_count_retention
pnpm test:data-settings-overview
cargo test -p atools-core --lib
cargo test -p atools --lib
pnpm test:settings-pages
pnpm check
cargo fmt --check
pnpm test:tauri-desktop-smoke-script
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `cargo test -p atools-core --lib test_prune_audit_entries_applies_age_and_count_retention`：通过。
- `pnpm test:data-settings-overview`：通过。
- `cargo test -p atools-core --lib`：通过，36 tests。
- `cargo test -p atools --lib`：通过，54 tests。
- `pnpm test:settings-pages`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `cargo fmt --check`：通过。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm build`：通过，192 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:56250"`，`agent_tools_count:8`，权限/数据/系统设置/插件 runtime smoke 均通过，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:56250`。Vite/esbuild 在退出阶段打印 `write EPIPE` / callback 噪声，但命令退出码为 0。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 权限与审计 | 95% | 96% | 审计历史从导出/筛选/全量清空扩展为可按 90 天 / 最新 1000 条策略清理，长历史维护能力更完整 |
| 设置项真实功能 | 99% | 99% | `我的数据` 新增真实原生清理动作，但整体仍因超级面板、远程插件更新、完整插件权限授权等保留 99% |
| 测试与发布 | 99% | 99% | 新增 DB 保留策略和数据页模型测试，并通过真实 desktop smoke |

当前重点剩余：

1. 权限与审计：审计归档策略和更多真实客户端长历史回放仍可增强。
2. Agent/MCP：更多 MCP 客户端实测和真实第三方插件 tool 兼容回归仍需继续。
3. 插件管理：插件市场、远程更新、完整插件权限授权/隔离模型和导入后真实兼容回归仍需继续。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 177：插件 Agent Tool Preload 懒加载

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步给出完成度。本批接上 Batch 176 的同步/异步插件 Agent tool 执行路径，补齐插件 UI 尚未打开时的运行时上下文缺口：MCP/Agent 调用插件 manifest tool 时，如果 runtime context 缺失，会按 manifest `preload` 从插件目录懒加载后重试 handler。

状态：DONE。

修改文件：

- `src-tauri/src/agent_tools.rs`
- `src-tauri/tests/agent_tools_tests.rs`
- `scripts/test-tauri-desktop-smoke-script.mjs`
- `src-tauri/tauri.conf.json`
- `docs/agent-mcp-client.md`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `execute_plugin_tool` 在插件 runtime 返回 `Context not found` 时，会读取插件 manifest `preload`，执行 `runtime.execute_preload(plugin.id, preload_code)`，然后重试 `____callAgentTool____`。
- 懒加载只允许插件目录内的相对 preload 路径；绝对路径和包含 `..` 的路径会在读取前拒绝。
- 没有 preload 的插件会返回明确错误，不假装执行成功。
- 修复真实 desktop smoke 卡在 macOS WindowServer / Tauri hidden main window 创建阶段的问题：
  - 先加脚本测试约束隐藏启动窗口不能 `focus:true`。
  - 再把隐藏 main window 的 `focus` 从 `true` 改为 `false`。
  - 真实 smoke 随后稳定输出 `ATOOLS_DESKTOP_SMOKE status:"ok"`。

TDD / 调试记录：

- 先新增 `plugin_manifest_tool_lazy_loads_preload_when_context_is_missing`：
  - 测试不预先调用 `execute_preload`。
  - 调用已启用的插件 manifest tool。
  - 初次红灯为 `Plugin Agent tool plugin_clipboard_plus_search_history failed: Context not found`。
- 实现 lazy-load 后目标测试转绿。
- 再新增 `plugin_manifest_tool_lazy_load_rejects_preload_outside_plugin_directory`，覆盖 `../preload.js` 越界路径拒绝。
- 真实 `pnpm smoke:tauri-desktop` 一度卡住且没有输出 smoke JSON；进程采样显示主线程停在 Tauri/tao/AppKit 创建 hidden main window 的 WindowServer 调用中，而不是 MCP 或插件代码。
- 先在 `scripts/test-tauri-desktop-smoke-script.mjs` 增加 hidden startup window focus guard，初次红灯为 `hidden startup window main must not request focus`。
- 将 `src-tauri/tauri.conf.json` 中 hidden main window 的 `focus` 改为 `false` 后，脚本测试和真实 desktop smoke 转绿。

验证：

```bash
cargo fmt --check
cargo test -p atools --test agent_tools_tests plugin_manifest_tool_lazy_loads_preload_when_context_is_missing
cargo test -p atools --test agent_tools_tests
cargo test -p atools --lib
pnpm test:plugin-inventory
pnpm test:plugin-registered-tools
pnpm test:plugin-db-storage
pnpm check
pnpm test:settings-pages
pnpm test:tauri-desktop-smoke-script
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `cargo fmt --check`：通过。
- `cargo test -p atools --test agent_tools_tests plugin_manifest_tool_lazy_loads_preload_when_context_is_missing`：通过。
- `cargo test -p atools --test agent_tools_tests`：通过，31 tests。
- `cargo test -p atools --lib`：通过，54 tests。
- `pnpm test:plugin-inventory`：通过。
- `pnpm test:plugin-registered-tools`：通过。
- `pnpm test:plugin-db-storage`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm test:settings-pages`：通过。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm build`：通过，192 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:55238"`，`agent_tools_count:8`，权限/数据/系统设置/插件 runtime smoke 均通过，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:55238`。Vite 在退出阶段打印 `write EPIPE` 噪声，但命令退出码为 0。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP 底座 | 99% | 99% | 插件 manifest tool 不再要求用户先打开插件 UI；runtime context 缺失时可安全懒加载 preload 后执行 handler。仍保留更多客户端实测和真实第三方插件 tool 兼容回归缺口 |
| 测试与发布 | 99% | 99% | 新增插件 Agent lazy-load 回归和 hidden window focus smoke guard，并通过真实 desktop smoke |

当前重点剩余：

1. Agent/MCP：更多 MCP 客户端实测和真实第三方插件 tool 兼容回归仍需继续。
2. 插件管理：插件市场、远程更新、完整插件权限授权/隔离模型和导入后真实兼容回归仍需继续。
3. 权限与审计：审计保留/归档策略和更多真实客户端长历史回放仍可增强。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 176：插件 Agent Tool 异步执行桥

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批接上 Batch 175 的同步 handler 执行路径，把插件 manifest tool 的 Promise/async handler 纳入 Agent/MCP 执行链路，尤其覆盖 handler 内部继续 await `utools.dbStorage` 等插件 IPC API 的情况；真实第三方插件 tool 兼容和更多 MCP 客户端实测仍保留为后续缺口。

状态：DONE。

修改文件：

- `crates/atools-plugin/src/bridge.rs`
- `crates/atools-plugin/src/runtime.rs`
- `src-tauri/tests/agent_tools_tests.rs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `____callAgentTool____` 不再把 thenable/Promise handler 作为不支持错误抛出，而是登记为 async result 并返回内部 result id。
- 新增 `____takeAsyncAgentToolResult____`，由 Rust worker 轮询 async tool 状态，resolved 后返回 JSON value，rejected 后返回明确错误。
- `call_function_impl` 检测 `__atoolsAsyncAgentToolResultId` 后进入等待循环，持续执行 QuickJS pending jobs，并在等待期间处理 IPC callback。
- 修复 IPC dispatcher 根因：原先在 current-thread Tokio runtime 中 `tokio::spawn` 后立即回到阻塞的 crossbeam `iter()`，单个 IPC 调用没有后续事件时 spawned task 不会被 poll，导致 async tool 内的 `await utools.*` 永久 pending。本批改为在独立 dispatcher 线程中直接 `block_on(handler.handle(...))` 并发送 callback，QuickJS worker 仍不阻塞在 native handler 上。
- Promise rejection、missing result 和超时都会通过插件 Agent tool 错误返回，不静默成功。

TDD / 调试记录：

- 先在 `crates/atools-plugin/src/runtime.rs` 增加红灯测试 `call_agent_tool_awaits_async_handler_promise`：
  - handler 是 `async function`，内部 `await Promise.resolve(...)`。
  - 初次运行失败：`Failed to call function: Exception`，对应 Batch 175 的 async unsupported 路径。
- 再在 `src-tauri/tests/agent_tools_tests.rs` 增加红灯测试 `plugin_manifest_tool_executes_async_handler_that_uses_ipc_bridge`：
  - 插件 manifest tool handler 内部 `await utools.dbStorage.setItem(...)` 再 `await utools.dbStorage.getItem(...)`。
  - 初次运行失败：`Timed out waiting for async plugin Agent tool result`。
- 系统化调试时补了更小的 runtime 级 IPC 用例 `call_agent_tool_awaits_async_handler_ipc_promise`，确认 timeout 不是 Tauri DB fixture 问题，而是 dispatcher spawned task 没有被 current-thread runtime 持续 poll。
- 修复 dispatcher 后，普通 Promise、runtime IPC Promise 和 Tauri Agent IPC handler 三条目标测试均转绿。

验证：

```bash
cargo fmt --check
cargo test -p atools-plugin --lib
cargo test -p atools --test agent_tools_tests
cargo test -p atools --lib
cargo test -p atools-api-shim
pnpm test:plugin-registered-tools
pnpm test:plugin-db-storage
pnpm test:plugin-bridge-capabilities
pnpm check
pnpm test:settings-pages
pnpm test:tauri-desktop-smoke-script
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `cargo fmt --check`：通过。
- `cargo test -p atools-plugin --lib`：通过，16 tests。
- `cargo test -p atools --test agent_tools_tests`：通过，29 tests。
- `cargo test -p atools --lib`：通过，54 tests。
- `cargo test -p atools-api-shim`：通过，19 tests。
- `pnpm test:plugin-registered-tools`：通过。
- `pnpm test:plugin-db-storage`：通过。
- `pnpm test:plugin-bridge-capabilities`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm test:settings-pages`：通过。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm build`：通过，192 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:50957"`，`agent_tools_count:8`，权限/数据/系统设置/插件 runtime smoke 均通过，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:50957`。Vite 在退出阶段打印 `write EPIPE` 噪声，但命令退出码为 0。
- smoke 后确认 `1420` 和 `50957` 均无残留监听，未留下临时 stop 脚本。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP 底座 | 99% | 99% | 插件 manifest tools 支持同步和异步 handler 执行，且 async handler 可 await 插件 IPC；仍保留更多客户端实测和真实第三方插件 tool 兼容回归缺口 |
| 测试与发布 | 99% | 99% | 新增 Promise、IPC Promise 和 Tauri Agent async plugin tool 测试，并通过构建和真实 desktop smoke |

当前重点剩余：

1. Agent/MCP：更多 MCP 客户端实测和真实第三方插件 tool 兼容回归仍需继续。
2. 插件管理：插件市场、远程更新、完整插件权限授权/隔离模型和导入后真实兼容回归仍需继续。
3. 权限与审计：审计保留/归档策略和更多真实客户端长历史回放仍可增强。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## Batch 175：插件 Agent Tool 同步执行桥

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批接上此前插件 manifest tools 只进入 Agent 白名单、但执行时仍停在 builtin-only executor 的缺口，把已启用且授权后的插件 tool 路由到插件 runtime 中注册的同步 handler；异步 handler 和真实第三方插件兼容回归仍保留为后续缺口。

状态：DONE。

修改文件：

- `crates/atools-plugin/src/bridge.rs`
- `crates/atools-plugin/src/runtime.rs`
- `src-tauri/src/agent_tools.rs`
- `src-tauri/tests/agent_tools_tests.rs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 在插件 runtime shim 中新增 `____callAgentTool____`，用于从 Agent/MCP 调用插件 tool handler。
- 支持 `utools.registerTool(name, definition, handler)` 注册的同步 handler，按原始 manifest tool 名、规范化 tool 名和对象 key 归一化匹配。
- 当 handler 返回 `undefined` 时归一为 `null`，其余 JSON 结果直接返回给 Agent tool caller。
- 对未注册 handler 返回明确错误，避免工具启用后静默成功或误走内置工具路径。
- 对 Promise/async handler 返回明确不支持错误：当前 QuickJS `call_function` 只序列化同步返回值，暂不假装 await。
- `call_tool_with_audit` 改为先按工具来源分流；`source == "plugin"` 时要求插件 runtime 可用并调用 `execute_plugin_tool`，否则仍走内置 executor。
- `execute_plugin_tool` 会校验插件 ID、插件仍存在且启用，并把规范化工具名映射回 manifest 原始 tool key 后再调用 runtime。

TDD / 调试记录：

- 先在 `crates/atools-plugin/src/runtime.rs` 增加红灯测试 `call_agent_tool_invokes_registered_sync_handler`：
  - preload 中注册 `utools.registerTool('echo', ..., handler)`。
  - 调用 `____callAgentTool____` 并期望返回 `{ echoed: "hello", count: 3 }`。
  - 初次运行失败：`Function ____callAgentTool____ not found`。
- 再在 `src-tauri/tests/agent_tools_tests.rs` 增加红灯测试 `plugin_manifest_tool_executes_registered_plugin_handler`：
  - 创建带 manifest `tools.search_history` 的插件 fixture。
  - 同步进 Agent 白名单并启用 `plugin_clipboard_plus_search_history`。
  - 在插件 runtime 中注册 `search_history` 同步 handler。
  - 调用 `execute_plugin_tool` 并期望透传 `query` 和 `limit`。
  - 初次运行失败：`execute_plugin_tool` 尚不存在。
- 实现 runtime bridge、Agent 工具来源分流和插件 tool 执行 helper 后，两条目标测试转绿。
- `cargo fmt --check` 首次提示 rustfmt 换行和 import 排序，运行 `cargo fmt` 后重新验证通过。

验证：

```bash
cargo fmt --check
cargo test -p atools-plugin --lib
cargo test -p atools --test agent_tools_tests
cargo test -p atools --lib
pnpm test:plugin-inventory
pnpm test:plugin-inventory-overview
pnpm check
pnpm test:settings-pages
pnpm test:tauri-desktop-smoke-script
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `cargo fmt --check`：通过。
- `cargo test -p atools-plugin --lib`：通过，14 tests。
- `cargo test -p atools --test agent_tools_tests`：通过，28 tests。
- `cargo test -p atools --lib`：通过，54 tests。
- `pnpm test:plugin-inventory`：通过。
- `pnpm test:plugin-inventory-overview`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm test:settings-pages`：通过。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm build`：通过，192 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:63773"`，`agent_tools_count:8`，权限/数据/系统设置/插件 runtime smoke 均通过，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:63773`。Vite/esbuild 在退出阶段打印 `write EPIPE` / callback 噪声，但命令退出码为 0。
- smoke 后确认 `1420` 和 `63773` 均无残留监听，未留下临时 stop 脚本。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP 底座 | 99% | 99% | 插件 manifest tools 从白名单暴露推进到同步 handler 执行；仍保留异步 handler、更多客户端实测和真实第三方兼容回归缺口 |
| 测试与发布 | 99% | 99% | 新增插件 runtime 和 Agent tool 执行测试，并通过构建和真实 desktop smoke |

当前重点剩余：

1. Agent/MCP：插件 tool 异步 handler 支持、更多 MCP 客户端实测和真实第三方插件 tool 兼容回归仍需继续。
2. 插件管理：插件市场、远程更新、完整插件权限授权/隔离模型和导入后真实兼容回归仍需继续。
3. 权限与审计：审计保留/归档策略和更多真实客户端长历史回放仍可增强。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## 第九十批：导入插件本地同 ID 更新（Batch 174）

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批继续收口设置页 `已安装插件` 的详情动作，把 `更新插件` 从远程更新占位推进为导入插件可用的本地同 ID 更新：用户选择一个包含 `plugin.json` 的目录，后端校验 manifest name 对应的插件 ID 与当前插件一致，再替换安装目录并刷新索引；远程市场更新仍不宣称完成。

状态：DONE。

修改文件：

- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`
- `src/lib/pluginInventory.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-plugin-inventory.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增原生命令 `update_plugin_from_path`，用于从本地目录更新已安装导入插件。
- 后端更新逻辑：
  - 只允许更新 ATools 用户插件目录下的导入插件，内置插件不可替换。
  - 读取所选目录 `plugin.json`，将 manifest `name` sanitize 后与当前 plugin id 比对，不一致则拒绝。
  - 拒绝源目录与当前安装目录重叠，避免选择已安装目录时先删源再复制。
  - 替换插件文件、保存新 manifest/version/path、重建 feature 索引、同步 plugin Agent tools。
  - 保留原插件 `enabled` 状态和 `created_at`。
- 设置页 `已安装插件`：
  - 导入插件的 `更新插件` 变为可用，原因文案为 `选择本地目录更新同一插件`。
  - 内置插件的 `更新插件` 仍不可用，原因文案为 `内置插件随应用更新，不能从设置页替换`。
  - 新增 `updateInstalledPluginFromDirectory`，桌面端打开目录选择器，调用 `update_plugin_from_path`，更新后刷新插件清单。
  - Web 预览下显示 `浏览器预览模式无法更新插件`，不触发原生 dialog。

TDD / 调试记录：

- 先新增 Rust 红灯测试 `plugin_update_from_path_replaces_same_plugin_and_rejects_installed_source`：
  - 要求更新后版本变为 2.0.0。
  - 要求保留原插件启停状态。
  - 要求不删除所选源目录。
  - 要求旧安装目录 stale 文件被清理，新文件进入安装目录。
  - 要求拒绝当前安装目录作为更新源。
  - 要求拒绝 manifest name 对应 ID 与当前 plugin id 不一致的目录。
- 初次运行红灯，原因是 `plugin_update_from_path_inner` 不存在。
- 再更新 `scripts/test-plugin-inventory.mjs`：
  - 要求导入插件 `更新插件` 可用。
  - 要求内置插件 `更新插件` 不可用且说明随应用更新。
  - 要求 SettingsPanel 包含 `updateInstalledPluginFromDirectory`、`invoke("update_plugin_from_path", { pluginId: plugin.id, path: selectedPath })`、Web 预览不可更新文案、取消更新文案和 `更新` 按钮文案。
- 初次运行红灯，原因是 `更新插件` 仍为 `available:false` / `远程更新未接入`。
- 实现后端命令、命令注册、库存模型和 SettingsPanel 更新动作后，目标测试转绿。
- `cargo fmt --check` 首次要求格式化 `commands.rs`，运行 `cargo fmt` 后重新验证通过。

验证：

```bash
cargo test -p atools --lib plugin_update_from_path_replaces_same_plugin_and_rejects_installed_source
pnpm test:plugin-inventory
pnpm test:plugin-inventory-overview
pnpm check
cargo fmt --check
cargo test -p atools --lib
pnpm test:settings-pages
pnpm test:tauri-desktop-smoke-script
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `cargo test -p atools --lib plugin_update_from_path_replaces_same_plugin_and_rejects_installed_source`：通过。
- `pnpm test:plugin-inventory`：通过。
- `pnpm test:plugin-inventory-overview`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `cargo fmt --check`：通过。
- `cargo test -p atools --lib`：通过，54 tests。
- `pnpm test:settings-pages`：通过。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm build`：通过，192 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:60226"`，`agent_tools_count:8`，权限/数据/系统设置/插件 runtime smoke 均通过，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:60226`。Vite/esbuild 在退出阶段打印 `write EPIPE` / callback 噪声，但命令退出码为 0。
- smoke 后确认 `1420` 和 `60226` 均无残留监听，未留下临时 stop 脚本。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入 | 56% | 59% | 导入插件现在可从本地同 ID 目录更新，后端校验 ID、保留启停状态、刷新文件/manifest/feature/Agent tools |
| 设置项真实功能 | 99% | 99% | 已安装插件管理新增本地更新命令，但远程插件更新、插件市场和完整权限授权模型仍未做 |
| ZTools 设置页 UI | 99% | 99% | 插件详情动作区又减少一个纯占位，整体仍保持 99% |
| 测试与发布 | 99% | 99% | 新增后端同 ID 更新保护测试，并通过构建和真实 desktop smoke |

当前重点剩余：

1. 插件管理：插件市场、远程更新、完整插件权限授权/隔离模型和导入后真实兼容回归仍需继续。
2. Agent/MCP：插件 tools 真实执行 bridge 仍未做；更多客户端实测可继续增强。
3. 权限与审计：审计保留/归档策略和更多真实客户端长历史回放仍可增强。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## 第八十九批：插件权限能力审计（Batch 173）

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批继续收口设置页 `已安装插件` 的详情动作，把此前未接入的 `插件权限` 升级为只读 manifest 能力审计：展示插件实际声明的运行入口、feature 匹配、Agent tools 和本地数据边界，同时不虚构完整权限授权/隔离模型。

状态：DONE。

修改文件：

- `src/lib/pluginInventory.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-plugin-inventory.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `插件详情` 中 `插件权限` 从不可用占位改为可用动作。
- 插件库存模型新增 `permissionRows`，按插件 manifest 生成只读审计信息：
  - 运行入口：`main`、`preload`、窗口高度、单例运行。
  - Feature 指令：feature 数量和 cmds 匹配数量。
  - Agent Tools：manifest `tools` 名称，并明确默认关闭、需在 Agent/MCP 白名单启用。
  - 本地数据边界：插件文件路径、插件数据、启停状态和工具白名单均只保存在本机。
- SettingsPanel 新增 `pluginPermissionPanelOpen`，点击 `插件权限` 后展开 `插件权限/能力审计` 区块并显示状态反馈。
- 选择其他插件、安装插件或卸载插件时会收起权限审计区，避免跨插件显示旧信息。
- 范围保持真实：本批只提供 manifest 能力审计，不声称已经实现完整插件权限授权/隔离模型。

TDD / 调试记录：

- 先更新 `scripts/test-plugin-inventory.mjs`：
  - 构造带 `main`、`preload`、`pluginSetting`、feature cmds 和 manifest `tools` 的导入插件样例。
  - 要求 `插件权限` action 为 `available:true`，reason 为 `查看 manifest 声明的本地能力和 Agent tools`。
  - 要求 `selectedPlugin.permissionRows` 返回运行入口、Feature 指令、Agent Tools 和本地数据边界 4 行。
  - 要求 SettingsPanel 包含 `pluginPermissionPanelOpen`、`插件权限/能力审计`、`inventory.selectedPlugin.permissionRows`、`已展开插件权限/能力审计` 和 `查看` 按钮文案。
- 初次运行红灯，原因是库存模型仍返回 `插件权限` 不可用和 `插件权限模型未接入`。
- 实现共享模型与 SettingsPanel 展开区后，目标测试转绿。

验证：

```bash
pnpm test:plugin-inventory
pnpm test:plugin-inventory-overview
pnpm check
cargo fmt --check
cargo test -p atools --lib
pnpm test:settings-pages
pnpm test:tauri-desktop-smoke-script
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-inventory`：通过。
- `pnpm test:plugin-inventory-overview`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `cargo fmt --check`：通过。
- `cargo test -p atools --lib`：通过，53 tests。
- `pnpm test:settings-pages`：通过。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm build`：通过，192 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:57531"`，`agent_tools_count:8`，权限/数据/系统设置/插件 runtime smoke 均通过，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:57531`。Vite/esbuild 在退出阶段打印 `write EPIPE` / callback 噪声，但命令退出码为 0。
- smoke 后确认 `1420` 和 `57531` 均无残留监听，未留下临时 stop 脚本。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入 | 54% | 56% | `插件权限` 不再是空占位，设置页可查看 manifest 声明的运行入口、feature 匹配、Agent tools 和本地数据边界 |
| 设置项真实功能 | 99% | 99% | 已安装插件管理新增只读权限/能力审计，但完整插件权限授权/隔离模型仍未做 |
| ZTools 设置页 UI | 99% | 99% | 插件详情动作区补齐一个可展开审计面板，整体仍保持 99% |
| 测试与发布 | 99% | 99% | 复用插件库存脚本、Svelte check、Rust 单测、构建和真实 desktop smoke 覆盖 |

当前重点剩余：

1. 插件管理：插件市场、远程更新、完整插件权限授权/隔离模型和导入后真实兼容回归仍需继续。
2. Agent/MCP：插件 tools 真实执行 bridge 仍未做；更多客户端实测可继续增强。
3. 权限与审计：审计保留/归档策略和更多真实客户端长历史回放仍可增强。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## 第八十八批：本地插件目录安装入口（Batch 172）

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批继续收口设置页 `已安装插件` 的顶层入口，把此前硬禁用的 `安装插件` 接到已有原生 `install_plugin` 命令，只支持选择本地包含 `plugin.json` 的目录，不宣称网络插件市场或远程更新已完成。

状态：DONE。

修改文件：

- `src/lib/pluginInventory.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-plugin-inventory.mjs`
- `scripts/test-plugin-inventory-overview.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `已安装插件` 顶部 `安装插件` 从硬禁用按钮改为可点击的桌面本地安装入口。
- SettingsPanel 新增 `installPluginFromDirectory`，桌面端调用 Tauri dialog 目录选择器，要求用户选择包含 `plugin.json` 的插件目录。
- 选择目录后调用原生 `install_plugin`，安装成功后选中新插件并刷新已安装插件清单。
- Web 预览下不打开原生目录选择器，直接显示 `浏览器预览模式无法安装插件`。
- 插件库存概览从 `本地导入` 更新为 `本地安装`，明确本地 `plugin.json` 目录安装可用，同时网络安装和远程更新仍未接入。

TDD / 调试记录：

- 先更新 `scripts/test-plugin-inventory.mjs`：
  - 要求 SettingsPanel 包含 `installPluginFromDirectory`。
  - 要求安装入口使用 `directory: true` 的目录选择器。
  - 要求 SettingsPanel 通过 `invoke("install_plugin", { path: selectedPath })` 调用原生命令。
  - 要求 Web 预览文案为 `浏览器预览模式无法安装插件`。
  - 要求旧的 `<button class="plain-button" disabled>安装插件</button>` 不再存在。
- 初次运行红灯，原因是 SettingsPanel 仍没有本地安装 handler。
- 再更新 `scripts/test-plugin-inventory-overview.mjs`：
  - 要求 `安装入口` 卡片值为 `本地安装`。
  - 要求 detail 包含 `plugin.json`、`网络安装` 和 `导入插件可卸载`。
  - 要求 Web 预览下安装入口值为 `桌面端安装`，tone 为 `desktop`。
- 初次运行红灯，原因是概览仍返回 `本地导入`。
- 实现库存模型与 SettingsPanel handler 后，目标测试转绿。

验证：

```bash
pnpm test:plugin-inventory
pnpm test:plugin-inventory-overview
pnpm check
cargo fmt --check
cargo test -p atools --lib
pnpm test:settings-pages
pnpm test:tauri-desktop-smoke-script
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-inventory`：通过。
- `pnpm test:plugin-inventory-overview`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `cargo fmt --check`：通过。
- `cargo test -p atools --lib`：通过，53 tests。
- `pnpm test:settings-pages`：通过。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm build`：通过，192 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:54990"`，`agent_tools_count:8`，权限/数据/系统设置/插件 runtime smoke 均通过，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:54990`。Vite/esbuild 在退出阶段打印 `write EPIPE` / callback 噪声，但命令退出码为 0。
- smoke 后确认 `1420` 和 `54990` 均无残留监听，未留下临时 stop 脚本。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入 | 51% | 54% | 设置页现在能从本地包含 `plugin.json` 的目录安装插件，并刷新已安装清单 |
| 设置项真实功能 | 99% | 99% | 已安装插件管理从刷新/启停/卸载/定位推进到本地安装；整体仍因插件更新、WebDAV 插件数据恢复等保持 99% |
| ZTools 设置页 UI | 99% | 99% | 顶部安装入口从硬禁用占位变成桌面可执行、本地边界明确的真实动作 |
| 测试与发布 | 99% | 99% | 复用插件库存脚本、Svelte check、Rust 单测、构建和真实 desktop smoke 覆盖 |

当前重点剩余：

1. 插件管理：插件市场、远程更新、插件权限和导入后真实兼容回归仍需继续。
2. Agent/MCP：插件 tools 真实执行 bridge 仍未做；更多客户端实测可继续增强。
3. 权限与审计：审计保留/归档策略和更多真实客户端长历史回放仍可增强。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## 第八十七批：插件目录 Finder 定位（Batch 171）

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批继续收口设置页 `已安装插件` 的详情动作，把此前 `打开目录` 的禁用占位接到已有原生定位命令，方便在 Finder 中定位插件目录。

状态：DONE。

修改文件：

- `src/lib/pluginInventory.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-plugin-inventory.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `插件详情` 中 `打开目录` 从不可用占位改为可用动作。
- 插件库存模型把 `打开目录` 标记为 `available:true`，原因文案为 `在 Finder 中定位插件目录`。
- SettingsPanel 新增 `openInstalledPluginDirectory`，桌面端调用 `shell_show_item_in_folder` 定位选中插件路径。
- Web 预览下不触发原生副作用，返回 `浏览器预览模式无法定位：<path>` 状态。
- 动作按钮根据 action label 显示 `定位` / `卸载` / `执行`，继续保持 `更新插件` 和 `插件权限` 未接入。

TDD / 调试记录：

- 先更新 `scripts/test-plugin-inventory.mjs`：
  - 要求 `打开目录` 为 `available:true`。
  - 要求 reason 为 `在 Finder 中定位插件目录`。
  - 要求 SettingsPanel 包含 `openInstalledPluginDirectory`。
  - 要求 SettingsPanel 通过 `invoke("shell_show_item_in_folder", { path: plugin.path })` 调用原生定位命令。
- 初次运行红灯，原因是库存模型仍返回 `available:false` 和 `暂不从设置页触发本地副作用`。
- 实现库存模型与 SettingsPanel handler 后，目标测试转绿。

验证：

```bash
pnpm test:plugin-inventory
pnpm check
cargo fmt --check
cargo test -p atools --lib
pnpm test:plugin-inventory-overview
pnpm test:settings-pages
pnpm test:tauri-desktop-smoke-script
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-inventory`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `cargo fmt --check`：通过。
- `cargo test -p atools --lib`：通过，53 tests。
- `pnpm test:plugin-inventory-overview`：通过。
- `pnpm test:settings-pages`：通过。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm build`：通过，192 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:52951"`，`agent_tools_count:8`，权限/数据/系统设置/插件 runtime smoke 均通过，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:52951`。Vite 在退出阶段打印 `write EPIPE` 噪声，但命令退出码为 0。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入 | 50% | 51% | 插件详情本地管理从卸载扩展到 Finder 定位插件目录 |
| 设置项真实功能 | 99% | 99% | 已安装插件管理新增一个真实本地副作用入口，但整体仍因插件更新、WebDAV 插件数据恢复等保持 99% |
| ZTools 设置页 UI | 99% | 99% | 动作按钮状态更贴近日用管理页，整体不调高 |
| 测试与发布 | 99% | 99% | 复用插件库存脚本、Svelte check、构建和真实 desktop smoke 覆盖 |

当前重点剩余：

1. 插件管理：远程更新、插件权限和插件市场仍未接入；导入后真实兼容回归仍需继续。
2. Agent/MCP：插件 tools 真实执行 bridge 仍未做；更多客户端实测可继续增强。
3. 权限与审计：审计保留/归档策略和更多真实客户端长历史回放仍可增强。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## 第八十六批：导入插件卸载确认流（Batch 170）

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批聚焦设置页 `已安装插件` 的真实管理闭环，把此前一直标记未接入的“卸载插件”推进为只对导入插件开放的确认式真实命令，同时保护内置资源插件不被误删。

状态：DONE。

修改文件：

- `src/lib/pluginInventory.ts`
- `src/components/SettingsPanel.svelte`
- `src-tauri/src/commands.rs`
- `scripts/test-plugin-inventory.mjs`
- `scripts/test-plugin-inventory-overview.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `已安装插件` 详情中的 `卸载插件` 对导入插件变为可执行动作。
- 内置插件仍不可卸载，原因明确为 `内置插件不可卸载，可停用以隐藏指令`。
- 卸载动作进入设置页内嵌危险确认弹窗，确认文案说明会移除插件本体、指令索引和插件数据。
- 确认后调用原生 `uninstall_plugin`，成功后清空选中插件并刷新已安装插件列表。
- 原生卸载命令新增路径保护：只允许删除 ATools 用户插件目录下的插件目录，防止误删 `.app/Contents/Resources/plugins` 等内置资源路径。
- 插件库存概览文案更新为“网络安装和远程更新仍未接入；导入插件可卸载，内置插件可停用”。

TDD / 调试记录：

- 先更新 `scripts/test-plugin-inventory.mjs`，要求导入插件的 `卸载插件` action 可用，内置插件不可用，并要求 SettingsPanel 包含 `uninstallInstalledPlugin`、`invoke("uninstall_plugin")` 和确认文案。
- 初次运行红灯，原因是库存模型仍返回 `卸载流程和数据确认未接入` 且 action 不可用。
- 先更新 `scripts/test-plugin-inventory-overview.mjs`，要求概览文案包含 `导入插件可卸载`。
- 初次运行红灯，原因是概览仍写 `网络安装、远程更新和卸载仍未接入`。
- 再新增 Rust 单测 `plugin_uninstall_path_allows_only_user_plugin_directories`。
- 初次运行红灯，原因是 `plugin_uninstall_path_allowed` 不存在。
- 实现库存模型、设置页动作和 Rust 路径 guard 后，目标测试转绿。
- `pnpm check` 首次发现 Svelte 模板回调里 `inventory.selectedPlugin` 仍可能为 null；根因是模板分支窄化没有进入事件回调，修复为在回调内部重新做 null guard。

验证：

```bash
pnpm test:plugin-inventory
pnpm test:plugin-inventory-overview
cargo test -p atools --lib plugin_uninstall_path_allows_only_user_plugin_directories
cargo fmt --check
cargo test -p atools --lib
pnpm check
pnpm test:settings-pages
pnpm test:tauri-desktop-smoke-script
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:plugin-inventory`：通过。
- `pnpm test:plugin-inventory-overview`：通过。
- `cargo test -p atools --lib plugin_uninstall_path_allows_only_user_plugin_directories`：通过。
- `cargo fmt --check`：通过。
- `cargo test -p atools --lib`：通过，53 tests。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm test:settings-pages`：通过。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm build`：通过，192 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:49273"`，`agent_tools_count:8`，权限/数据/系统设置/插件 runtime smoke 均通过，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:49273`。Vite 在退出阶段打印 `write EPIPE` 噪声，但命令退出码为 0。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入 | 47% | 50% | 导入插件现在可从设置页确认卸载，并清理本体、插件记录、feature 索引、插件数据和 Agent 插件工具白名单 |
| 设置项真实功能 | 99% | 99% | 已安装插件管理从刷新/启停推进到导入插件卸载；整体仍因超级面板、插件更新、WebDAV 插件数据恢复等保持 99% |
| ZTools 设置页 UI | 99% | 99% | 插件详情动作从未接入按钮变成可执行/不可执行的分层状态，但设置页整体仍保留 99% |
| 测试与发布 | 99% | 99% | 新增插件库存脚本测试、Rust 路径 guard 单测，并通过构建和真实 desktop smoke |

当前重点剩余：

1. 插件管理：远程更新、插件权限和插件市场仍未接入；导入后真实兼容回归仍需继续。
2. Agent/MCP：插件 tools 真实执行 bridge 仍未做；更多客户端实测可继续增强。
3. 权限与审计：审计保留/归档策略和更多真实客户端长历史回放仍可增强。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## 第八十五批：插件 manifest tools 白名单暴露（Batch 169）

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批接上 Agent/MCP 底座最后几个缺口之一，把已启用插件 manifest 中声明的 `tools` 同步进 Agent 工具白名单，但保持默认关闭，避免在插件执行 bridge 尚未完成前静默扩大可调用面。

状态：DONE。

修改文件：

- `crates/atools-core/src/db.rs`
- `src-tauri/src/agent_tools.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/tests/agent_tools_tests.rs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增插件 manifest tool 同步入口：
  - 只读取已启用插件。
  - 将 manifest `tools` 规范化为 `plugin_<plugin_id>_<tool_name>`。
  - 写入 `agent_tools`，标记 `source:"plugin"` 和 `plugin_id`。
  - 保留 manifest input/output schema。
  - 赋予 `PluginData` scope。
- 插件工具默认关闭：
  - `enabled_by_default=false`。
  - `enabled=false`。
  - 不会因为插件启用就直接出现在 MCP `tools/list`。
- 用户显式打开插件工具后，enabled registry / MCP 工具列表会包含该工具。
- 插件禁用、卸载或 manifest 不再声明对应工具后，会清理 stale plugin-sourced Agent 工具。
- Agent/MCP 工具管理命令改为返回完整白名单，使默认关闭的插件工具可以被看到和切换。
- 插件 install/import、启停、卸载和内置插件加载完成后都会同步插件 Agent 工具。

边界：

- 本批只完成 Agent/MCP 白名单暴露与启用态治理。
- 插件 tool 的真实执行 bridge 仍未实现；即使用户启用插件工具，当前调用也会走现有 executor 的受控错误路径，不会假装执行成功。

TDD / 调试记录：

- 先在 `src-tauri/tests/agent_tools_tests.rs` 增加 enabled plugin manifest tool fixture。
- 新增 `plugin_manifest_tools_sync_to_agent_whitelist_disabled_by_default`，覆盖名称、source、plugin_id、description、schema、scope、默认关闭。
- 新增 `enabled_tool_registry_includes_plugin_tool_only_after_user_enables_it`，覆盖默认不进入 enabled registry、用户启用后进入权限/registry、插件禁用后清理。
- 初次运行红灯，原因是 `atools_lib::agent_tools::sync_plugin_tools` 不存在。
- 实现同步入口、DB stale 清理和权限判断后，目标测试转绿。

验证：

```bash
cargo test -p atools --test agent_tools_tests plugin_tool
cargo test -p atools --test agent_tools_tests
cargo test -p atools --lib
cargo fmt --check
pnpm test:mcp-audit-settings
pnpm check
pnpm test:tauri-desktop-smoke-script
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `cargo test -p atools --test agent_tools_tests plugin_tool`：通过。
- `cargo test -p atools --test agent_tools_tests`：通过，27 tests。
- `cargo test -p atools --lib`：通过，52 tests。
- `cargo fmt --check`：通过。
- `pnpm test:mcp-audit-settings`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm build`：通过，192 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:62485"`，`agent_tools_count:8`，enabled agent tools 仍为 8 个内置工具，权限/数据/系统设置/插件 runtime smoke 均通过，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:62485`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP 底座 | 99% | 99% | 插件 manifest tools 已进入白名单治理，但真实执行 bridge 仍未完成，所以底座仍保留 99% |
| 插件安装/导入 | 46% | 47% | 插件安装/导入后的 manifest tools 会同步进 Agent 白名单；插件市场、更新、权限和真实兼容回归仍未做 |
| 测试与发布 | 99% | 99% | 新增插件 tool 白名单 Rust 回归测试，并通过 Tauri lib、前端、构建和真实 desktop smoke |

当前重点剩余：

1. Agent/MCP：插件 tools 真实执行 bridge 仍未做；更多客户端实测可继续增强。
2. 插件管理：卸载、更新、插件权限仍未接入。
3. 权限与审计：审计保留/归档策略和更多真实客户端长历史回放仍可增强。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## 第八十四批：审计筛选视图持久化（Batch 168）

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批接上第八十三批分页/索引，把权限与审计剩余缺口中的“保存筛选视图”补上，让常用审计查询可以本地命名保存、应用和删除。

状态：DONE。

修改文件：

- `src/lib/auditFilterViews.ts`
- `src/components/AgentPanel.svelte`
- `scripts/test-audit-filter-views.mjs`
- `scripts/test-mcp-audit-settings.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 localStorage-backed 审计筛选视图模型：
  - storage key：`atools:audit-filter-views`。
  - 支持 query/status/tool/client 四类筛选。
  - 支持自动生成视图标签，例如 `搜索: permission denied · 状态: denied`。
  - 同名视图 upsert，避免重复堆积。
  - 最多保留 12 个视图。
- Agent/MCP 审计回放新增保存视图控件：
  - `已保存视图` 下拉。
  - `名称` 输入框。
  - `保存视图`、`应用`、`删除`。
- 筛选视图控件在空审计列表时仍可见；用户可以先保存/套用查询，再等待后续审计记录进入。
- 应用已保存视图时会恢复 query/status/tool/client，并触发现有分页查询重拉第一页。
- 已保存视图里的工具/客户端值会进入下拉选项，即使当前加载页没有该工具/客户端。

TDD / 调试记录：

- 先新增 `scripts/test-audit-filter-views.mjs` 和 `test:audit-filter-views`，覆盖：
  - storage key。
  - 筛选归一化。
  - 自动标签。
  - upsert 同名替换。
  - 删除。
  - localStorage round-trip。
  - AgentPanel 必须加载、保存、应用、删除筛选视图。
- 初次运行红灯，原因是 `src/lib/auditFilterViews.ts` 不存在。
- 实现 helper 和 AgentPanel 控件后，目标测试转绿。
- 渲染验证发现 Web 预览无审计记录时，保存视图控件仍被 `audits.length > 0` 分支隐藏；先补源码回归断言，初次红灯后将空状态与筛选控件解耦，复测转绿。

验证：

```bash
pnpm test:audit-filter-views
pnpm test:mcp-audit-settings
pnpm check
pnpm build
pnpm test:tauri-desktop-smoke-script
cargo fmt --check
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:audit-filter-views`：通过。
- `pnpm test:mcp-audit-settings`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，192 modules transformed。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `cargo fmt --check`：通过。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:57668"`，`agent_tools_count:8`，`data_debug_smoke.audit_filtered_export_checked:true`，`data_debug_smoke.audit_filtered_export_count_checked:true`，权限/数据/系统设置/插件 runtime smoke 均通过，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:57668`。
- Rendered validation：Browser 插件返回 `No Codex browser route is available`，因此使用 Playwright fallback 打开 `http://localhost:1420/`；页面标题 `ATools 3.0`，首页非空，控制台 0 errors / 0 warnings；进入 `Agent / MCP` 后确认 `审计回放`、`已保存视图`、`保存视图` 可见；填写 `permission denied` + `Denied opens` 后点击 `保存视图`，页面显示 `已保存 Denied opens`，下拉选项数为 2，`localStorage["atools:audit-filter-views"]` 写入包含 `Denied opens` 的 JSON。
- Screenshot evidence：`/tmp/atools-audit-filter-views.png`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP 底座 | 99% | 99% | Agent 审计查询体验补保存视图，但底座仍因插件 tools 暴露和更多客户端实测保留 99% |
| 权限与审计 | 94% | 95% | 审计查询从一次性筛选升级为可保存/复用的本地视图 |
| 测试与发布 | 99% | 99% | 新增筛选视图脚本测试、Svelte 检查、构建和渲染 fallback 验证 |

当前重点剩余：

1. 权限与审计：审计保留/归档策略和更多真实客户端长历史回放仍可增强。
2. Agent/MCP：插件 tools 暴露仍未做；更多客户端实测可继续增强。
3. 插件管理：卸载、更新、插件权限仍未接入。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## 第八十三批：审计查询分页与索引（Batch 167）

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批聚焦权限与审计剩余缺口中的审计分页/索引化，让审计历史在记录量增加后仍能按页加载并返回真实总数。

状态：DONE。

修改文件：

- `crates/atools-core/src/agent.rs`
- `crates/atools-core/src/db.rs`
- `crates/atools-core/tests/agent_tests.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/desktop_smoke.rs`
- `src/lib/types.ts`
- `src/components/AgentPanel.svelte`
- `scripts/test-mcp-audit-settings.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `AuditLogQuery` 新增 `offset`，并通过 serde default 保持旧调用兼容。
- 新增 `AuditLogPage`，后端审计分页返回 `entries`、`total`、`limit`、`offset`。
- `Database::query_audit_entries_page()` 复用现有审计筛选语义，先计算过滤后的总数，再按 offset/limit 返回当前页；旧 `query_audit_entries()` 继续返回列表。
- SQLite schema 新增审计过滤索引：
  - `idx_audit_log_status_timestamp`
  - `idx_audit_log_tool_timestamp`
  - `idx_audit_log_client_timestamp`
- Tauri 新增 `query_audit_entries_page` 命令，前端类型新增 `AuditLogPage`。
- Agent/MCP 面板审计区改用分页查询：
  - 初次刷新加载 50 条。
  - 摘要显示 `已加载 x / y 条`。
  - 筛选条件变化时重新加载第一页，避免后续分页 offset 沿用旧列表长度。
  - 当还有更多记录时显示 `加载更多`，并追加下一页。
- 保留现有筛选导出、清空和审计详情行为。

TDD / 调试记录：

- 先新增 `audit_entries_query_page_returns_total_and_offset_window`，要求成功审计按过滤条件返回 total 和 offset 页窗口；初次红灯为 `AuditLogPage`、`AuditLogQuery.offset`、`query_audit_entries_page` 不存在。
- 先新增 `test_audit_log_filter_indexes_exist`，要求 SQLite schema 存在状态/工具/客户端时间索引；初次红灯为索引缺失。
- 先扩展 `scripts/test-mcp-audit-settings.mjs`，要求 AgentPanel 使用 `query_audit_entries_page`、维护 `auditTotal`、提供 `loadMoreAudits` 并渲染 `加载更多`；初次红灯为仍使用旧列表查询。
- 后续补充筛选分页一致性检查，要求 AgentPanel 维护 `auditFilterKey` 并通过 `reloadAuditsForFilters` 在筛选变化时重拉第一页；初次红灯为缺少筛选变更重载。
- 扩大验证时 `cargo test -p atools --lib` 暴露 `desktop_smoke.rs` 里一个手写 `AuditLogQuery` 缺少 `offset`；定位为新增非可选 Rust 字段后的结构体字面量遗漏，补 `offset: 0` 后通过。

验证：

```bash
pnpm test:mcp-audit-settings
cargo test -p atools-core --test agent_tests audit_entries_query_page_returns_total_and_offset_window
cargo test -p atools-core --lib audit_log_filter_indexes_exist
cargo test -p atools-core --test agent_tests
cargo test -p atools-core --lib
cargo test -p atools --lib
cargo fmt --check
pnpm check
pnpm build
pnpm test:tauri-desktop-smoke-script
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:mcp-audit-settings`：通过。
- `cargo test -p atools-core --test agent_tests audit_entries_query_page_returns_total_and_offset_window`：1 passed。
- `cargo test -p atools-core --lib audit_log_filter_indexes_exist`：1 passed。
- `cargo test -p atools-core --test agent_tests`：17 passed。
- `cargo test -p atools-core --lib`：35 passed。
- `cargo test -p atools --lib`：52 passed。
- `cargo fmt --check`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，191 modules transformed。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_bind:"127.0.0.1:52280"`，`agent_tools_count:8`，`data_debug_smoke.audit_filtered_export_checked:true`，`data_debug_smoke.audit_filtered_export_count_checked:true`，权限/数据/系统设置/插件 runtime smoke 均通过，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:52280`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP 底座 | 99% | 99% | 审计历史支持分页加载和总数展示；底座仍保留 99%，因为插件 tools 暴露和更多客户端实测未完成 |
| 权限与审计 | 93% | 94% | 审计查询补齐分页 total/offset 和过滤索引，长历史可用性更完整 |
| 测试与发布 | 99% | 99% | 新增分页/索引回归测试，并通过真实 desktop smoke |

当前重点剩余：

1. 权限与审计：保存筛选视图仍可增强。
2. Agent/MCP：插件 tools 暴露仍未做；更多客户端实测可继续增强。
3. 插件管理：卸载、更新、插件权限仍未接入。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## 第八十二批：MCP 客户端默认配置路径建议（Batch 166）

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批接上第八十一批安全合并写入，把已知 MCP 客户端的默认目标配置路径接入安装计划和文件选择器。

状态：DONE。

资料来源：

- MCP 官方文档：Claude Desktop macOS 配置路径为 `~/Library/Application Support/Claude/claude_desktop_config.json`。
- Cursor 官方 MCP 文档：全局配置为 `~/.cursor/mcp.json`，项目配置为 `.cursor/mcp.json`。

修改文件：

- `src/lib/mcpClientConfig.ts`
- `src/components/AgentPanel.svelte`
- `src/components/SettingsPanel.svelte`
- `src-tauri/src/desktop_smoke.rs`
- `scripts/test-mcp-client-config.mjs`
- `docs/agent-mcp-client.md`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 `mcpClientSuggestedTargetPath()`：
  - 通用 HTTP / stdio：默认 `mcp.json`。
  - Claude Desktop：有 home path 时建议 `~/Library/Application Support/Claude/claude_desktop_config.json` 的展开路径，无 home path 时回退 `claude_desktop_config.json`。
  - Cursor：有 home path 时建议 `~/.cursor/mcp.json` 的展开路径，无 home path 时回退 `mcp.json`。
- `McpClientInstallPlan` 新增 `suggestedTargetPath`，并在 Agent/MCP 面板和设置页 `MCP 服务` 模板行显示。
- `合并到文件...` 的 save dialog 默认路径改为上述建议路径；桌面端会先读取 home 目录，失败时保留安全 fallback。
- Cursor 目标说明从单一项目路径补为 `Cursor 全局 ~/.cursor/mcp.json / 项目 .cursor/mcp.json`。
- 修复真实 desktop smoke 中重复出现的 MCP 冷启动 flaky：
  - 原始 TCP HTTP reader 遇到未完成响应前的一次 `WouldBlock` 会立即失败。
  - 现在对未完成响应做有限短重试；响应完整后仍立即返回，持续不完整仍报错。

TDD / 调试记录：

- 先扩展 `scripts/test-mcp-client-config.mjs`，要求：
  - `mcpClientSuggestedTargetPath()` 返回 Claude Desktop 和 Cursor 的 home 展开路径。
  - `mcpClientInstallPlans({ homePath })` 带 `suggestedTargetPath`。
  - Cursor 安装计划包含 `~/.cursor/mcp.json` 和 `.cursor/mcp.json`。
- 初次运行红灯，原因是 `mcpClientSuggestedTargetPath` 尚不存在。
- 真实 desktop smoke 两次降级均为第一笔 MCP `ping` 的 `Resource temporarily unavailable (os error 35)`；同轮后续 discovery/resources/prompts/batch 均成功，定位为 smoke 原始 HTTP reader 的冷启动读超时处理过窄。
- 先新增 `mcp_http_smoke_reader_tolerates_transient_would_block_before_payload`，初次红灯为缺少 `read_mcp_http_response_with_would_block_retries`。
- 实现有限 `WouldBlock` 重试后目标测试转绿，真实 desktop smoke 转绿。

验证：

```bash
pnpm test:mcp-client-config
pnpm check
pnpm build
pnpm test:tauri-desktop-smoke-script
cargo test -p atools --lib mcp_http_smoke_reader
cargo test -p atools --lib
cargo fmt --check
pnpm smoke:tauri-desktop
```

结果：

- `pnpm test:mcp-client-config`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，191 modules transformed。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `cargo test -p atools --lib mcp_http_smoke_reader`：3 passed。
- `cargo test -p atools --lib`：52 passed。
- `cargo fmt --check`：通过。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`agent_tools_count:8`，`data_debug_smoke.mcp_ping_ok:true`，`data_debug_smoke.mcp_resources_ok:true`，`data_debug_smoke.mcp_prompts_ok:true`，`data_debug_smoke.mcp_batch_ok:true`，`data_debug_smoke.mcp_notification_ok:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:61984`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP 底座 | 99% | 99% | 已知客户端默认路径建议和安全合并写入闭环完成；仍保留 99%，因为插件 tools 暴露和更多客户端实测未完成 |
| 测试与发布 | 99% | 99% | 修复真实 desktop smoke 首个 MCP ping 冷启动 flaky，降低回归噪音 |

当前重点剩余：

1. Agent/MCP：插件 tools 暴露仍未做；更多客户端实测可继续增强。
2. 插件管理：卸载、更新、插件权限仍未接入。
3. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## 第八十一批：MCP 客户端配置安全合并写入（Batch 165）

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批把 MCP 客户端模板从“复制和手动合并”推进到用户选择目标 JSON 后的安全自动合并。

状态：DONE。

修改文件：

- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`
- `src/lib/mcpClientConfig.ts`
- `src/components/AgentPanel.svelte`
- `src/components/SettingsPanel.svelte`
- `scripts/test-mcp-client-config.mjs`
- `docs/agent-mcp-client.md`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 Tauri 命令 `install_mcp_client_config`，参数包含目标路径、模板 config、server name 和显式确认标记。
- 新增 Rust 合并/写入核心：
  - 只替换或新增 `mcpServers.atools`。
  - 保留其他 `mcpServers` 和顶层字段。
  - 已存在文件且内容会变化时，先创建同目录 `*.atools-backup-*` 备份。
  - 目标不存在时创建父目录。
  - 无效 JSON、非对象 config、非对象 `mcpServers` 和未确认写入都会返回明确错误。
- 前端 `mcpClientConfig.ts` 新增同语义的纯合并 helper 和安装结果文案 helper。
- MCP install plan 从 `暂不自动写入` 更新为 `可安全合并`，并明确“选择目标配置 JSON、写入前备份、只合并 `mcpServers.atools`”。
- Agent/MCP 面板和设置页 `MCP 服务` 保留 `复制`，新增 `合并到文件...`，通过 Tauri save dialog 让用户选择或新建目标 JSON。
- 文档同步更新 MCP 客户端安装说明、macOS smoke 手工检查项和还原完成度。

TDD 记录：

- 先扩展 `scripts/test-mcp-client-config.mjs`，要求：
  - `mcpClientInstallPlans()` 全部 `writeAvailable=true`。
  - 原因包含写入前备份。
  - 步骤包含选择目标配置 JSON、合并 `mcpServers.atools`、保留 HTTP token / stdio 参数等客户端差异。
  - `mergeMcpClientConfig()` 保留顶层字段和其他 server，只替换 `mcpServers.atools`。
- 初次运行红灯，原因是 `mergeMcpClientConfig` 尚未实现且旧计划仍返回 `writeAvailable=false`。
- 先新增 Rust 测试，要求合并保留其他 server、写入需要显式确认、已有文件写入前备份；初次红灯为缺少 `merge_mcp_client_config` / `write_mcp_client_config_file`。
- 实现 Rust 和 TS 合并/写入模型后目标测试转绿，再接入两个 UI 面。

验证：

```bash
cargo test -p atools-core --test agent_tests
cargo test -p atools --lib
cargo test -p atools --test agent_tools_tests
cargo test -p atools-api-shim --test handler_tests
cargo test -p atools-plugin --lib
cargo fmt --check
pnpm test:mcp-client-config
pnpm check
pnpm build
pnpm test:tauri-desktop-smoke-script
pnpm smoke:tauri-desktop
```

结果：

- `cargo test -p atools-core --test agent_tests`：16 passed。
- `cargo test -p atools --lib`：51 passed。
- `cargo test -p atools --test agent_tools_tests`：25 passed。
- `cargo test -p atools-api-shim --test handler_tests`：19 passed。
- `cargo test -p atools-plugin --lib`：13 passed。
- `cargo fmt --check`：通过。
- `pnpm test:mcp-client-config`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，191 modules transformed。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`agent_tools_count:8`，`data_debug_smoke.mcp_ping_ok:true`，`data_debug_smoke.mcp_resources_ok:true`，`data_debug_smoke.mcp_prompts_ok:true`，`data_debug_smoke.mcp_batch_ok:true`，`data_debug_smoke.mcp_notification_ok:true`，示例插件 `calculator` / `calc`，`Desktop smoke passed: 127.0.0.1:58582`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP 底座 | 99% | 99% | 客户端自动合并写入缺口已收口；仍保留 99%，因为插件 tools 暴露和更多客户端实测未完成 |
| 设置项真实功能 | 99% | 99% | 设置页 MCP 客户端配置从复制/指引推进到选择文件后的真实安全写入 |
| 测试与发布 | 99% | 99% | 增加前端/Rust 合并写入测试，并通过完整回归和真实 desktop smoke |

当前重点剩余：

1. Agent/MCP：插件 tools 暴露仍未做；客户端默认配置路径自动发现和更多客户端实测可继续增强。
2. 插件管理：卸载、更新、插件详情、插件权限仍未接入。
3. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## 第八十批：MCP 内置 Resource Catalog（Batch 164）

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批接上第七十九批 prompt catalog，把 Agent/MCP 底座剩余的 resources 内容目录补齐到可 list/read 的内置资源。

状态：DONE。

修改文件：

- `crates/atools-core/src/mcp.rs`
- `crates/atools-core/tests/agent_tests.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/desktop_smoke.rs`
- `scripts/smoke-tauri-desktop.mjs`
- `scripts/test-tauri-desktop-smoke-script.mjs`
- `docs/agent-mcp-client.md`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- MCP static handler：
  - `resources/list` 返回内置 `atools://agent/tools` resource。
  - `resources/read` 返回当前启用 Agent 工具目录 JSON，包含工具名、描述、输入 schema 和输出 schema。
  - 未知 resource URI 返回 JSON-RPC `-32002 Resource not found`，并在 error data 中带回 URI。
- stdio fallback：
  - 桌面 app 未运行时仍可本地响应 `resources/list` 和 `resources/read`。
- desktop smoke：
  - `data_debug_smoke` 新增 `mcp_resources_ok`。
  - 真实 HTTP `/mcp` 覆盖 `resources/list` 目录内容和 `resources/read` 返回文本。

TDD 记录：

- 先新增 `mcp_static_handler_exposes_builtin_agent_tools_resource_and_read`，初次运行红灯，因为 `resources/list` 仍返回空数组。
- 再新增 `local_stdio_fallback_handles_builtin_resource_read`，初次运行红灯，因为 fallback 尚未把 `resources/read` 交给 static handler。
- 扩展 desktop smoke 脚本要求 `mcp_resources_ok`，并在 Rust smoke 中补真实 HTTP list/read 检查。

验证：

```bash
cargo test -p atools-core --test agent_tests
cargo test -p atools --lib
cargo test -p atools --test agent_tools_tests
cargo test -p atools-api-shim --test handler_tests
cargo test -p atools-plugin --lib
cargo fmt --check
pnpm check
pnpm build
pnpm test:tauri-desktop-smoke-script
pnpm smoke:tauri-desktop
```

结果：

- `cargo test -p atools-core --test agent_tests`：通过，16 passed。
- `cargo test -p atools --lib`：通过，49 passed。
- `cargo test -p atools --test agent_tools_tests`：通过，25 passed。
- `cargo test -p atools-api-shim --test handler_tests`：通过，19 passed。
- `cargo test -p atools-plugin --lib`：通过，13 passed。
- `cargo fmt --check`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，191 modules transformed。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_ready:true`，`agent_tools_count:8`，`data_debug_smoke.mcp_resources_ok:true`，端口 `127.0.0.1:52584`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP 底座 | 98% | 99% | resources 从空 discovery 升级为内置工具目录 resource 和 `resources/read`，HTTP 与 stdio fallback 均覆盖 |
| 测试与发布 | 99% | 99% | real desktop smoke 新增 resource 协议探测，并通过运行态验证 |
| 内置 Agent 工具 | 86% | 86% | 本批不扩展工具执行能力，只把工具目录作为 MCP resource 暴露 |
| 设置项真实功能 | 99% | 99% | 本批不改设置页功能 |

当前重点剩余：

1. 内置程序体验：继续打磨设置页空状态、局部交互和主搜索极端结果量信息密度。
2. 设置真实功能：WebDAV 插件数据恢复应用、冲突合并和更细粒度确认仍未接入。
3. Agent/MCP：客户端自动写入/合并配置仍未做。
4. 插件 tools 暴露和插件 bridge 回归按当前要求暂缓。
5. macOS 发布质量：签名、公证、自动更新仍未接入。

## 第七十九批：MCP 内置 Prompt Catalog（Batch 163）

用户要求：继续还原完成度，同时测试没问题后同步更新文档，完成一大项后同步完成度。本批聚焦 Agent/MCP 底座，把 prompts 从空 discovery 推进到有内置目录和 `prompts/get` 的可用协议面。

状态：DONE。

修改文件：

- `crates/atools-core/src/mcp.rs`
- `crates/atools-core/tests/agent_tests.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/desktop_smoke.rs`
- `scripts/smoke-tauri-desktop.mjs`
- `scripts/test-tauri-desktop-smoke-script.mjs`
- `docs/agent-mcp-client.md`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- MCP static handler：
  - `prompts/list` 返回内置 `atools_agent_tool_guide`。
  - `prompts/get` 支持按 `arguments.task` 返回任务定制的本地 Agent 工具选择提示。
  - 未知 prompt 返回 `-32602`，不伪造空成功。
- stdio fallback：
  - 桌面 app 未运行时仍可本地响应 `prompts/list` 和 `prompts/get`。
  - batch 中的 `prompts/list` 继续遵守 request/notification 响应过滤。
- desktop smoke：
  - `data_debug_smoke` 新增 `mcp_prompts_ok`。
  - 真实 HTTP `/mcp` 覆盖 `prompts/list` 目录内容和 `prompts/get` 返回文本。
  - raw HTTP 读取改为按 `Content-Length` 判断响应完整，避免等待 socket EOF 造成偶发 `os error 35`。

TDD 记录：

- 先新增 `mcp_static_handler_exposes_builtin_prompt_catalog_and_get`，初次运行红灯，因为 `prompts/list` 仍为空。
- 再新增 `local_stdio_fallback_handles_builtin_prompt_get`，初次运行红灯，因为 fallback 把 `prompts/get` 当成需要桌面端的请求。
- 扩展 desktop smoke 脚本要求 `mcp_prompts_ok`，初次运行红灯，因为 smoke 输出还没有该字段。
- 真实 smoke 首次冷启动时暴露 MCP ping 读取 socket EOF 的偶发问题；补 `mcp_http_smoke_reader_*` 回归后按 `Content-Length` 停止读取。

验证：

```bash
cargo test -p atools-core --test agent_tests
cargo test -p atools --lib
cargo test -p atools --test agent_tools_tests
cargo test -p atools-api-shim --test handler_tests
cargo test -p atools-plugin --lib
cargo fmt --check
pnpm check
pnpm build
pnpm test:tauri-desktop-smoke-script
pnpm smoke:tauri-desktop
```

结果：

- `cargo test -p atools-core --test agent_tests`：通过，15 passed。
- `cargo test -p atools --lib`：通过，48 passed。
- `cargo test -p atools --test agent_tools_tests`：通过，25 passed。
- `cargo test -p atools-api-shim --test handler_tests`：通过，19 passed。
- `cargo test -p atools-plugin --lib`：通过，13 passed。
- `cargo fmt --check`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，191 modules transformed。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_ready:true`，`agent_tools_count:8`，`data_debug_smoke.mcp_prompts_ok:true`，端口 `127.0.0.1:64617`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP 底座 | 97% | 98% | prompts 从空 discovery 升级为内置目录和 `prompts/get`，HTTP 与 stdio fallback 均覆盖 |
| 测试与发布 | 99% | 99% | real desktop smoke 新增 prompt 协议探测，并补强 smoke HTTP 读取稳定性 |
| 内置 Agent 工具 | 86% | 86% | 本批不扩展工具执行能力，只补工具选择 prompt |
| 设置项真实功能 | 99% | 99% | 本批不改设置页功能 |

当前重点剩余：

1. 内置程序体验：继续打磨设置页空状态、局部交互和主搜索极端结果量信息密度。
2. 设置真实功能：WebDAV 插件数据恢复应用、冲突合并和更细粒度确认仍未接入。
3. Agent/MCP：客户端自动写入/合并配置仍未做。
4. 插件 tools 暴露和插件 bridge 回归按当前要求暂缓。
5. macOS 发布质量：签名、公证、自动更新仍未接入。

## 第七十八批：主搜索匹配标签 tone 区分

用户要求：插件不着急，先继续完善内置程序体验。本批聚焦主搜索结果列表的视觉扫读，让 `精确`、`别名`、`拼音`、`模糊`、`待处理` 等匹配标签不再全部使用同一种弱灰样式。

状态：DONE。

修改文件：

- `src/lib/resultPresentation.ts`
- `src/components/ResultsList.svelte`
- `scripts/test-result-presentation.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `ResultRowPresentation` 增加 `matchTone`，由 `MATCH_TYPE_META` 统一映射，未知类型回落为 `unknown`。
- 结果行 UI 使用 `tone-${rowMeta.matchTone}` class，不在 Svelte 模板里硬编码匹配类型分支。
- 匹配标签 tone 分组：
  - `exact` / `prefix` / `contains` / `regex`：使用主题 accent 弱强调。
  - `alias`：使用紫色弱强调，突出用户自定义短词。
  - `pinyin`：使用绿色弱强调，突出中文输入召回。
  - `fuzzy`：使用橙色弱强调，提示低精度召回。
  - `pending` / `over` / `unknown`：使用中性灰，避免抢占主结果。
- 保持 chip 固定高度、ellipsis 和结果行三列布局，避免匹配标签变化造成结果行抖动。

TDD 记录：

- 先扩展 `scripts/test-result-presentation.mjs`：
  - 前缀匹配期望 `matchTone === "prefix"`。
  - 别名结果期望 `matchLabel === "别名"` 且 `matchTone === "alias"`。
  - 未知匹配类型期望 label 保留原始值，tone 回落 `unknown`。
- 初次运行红灯，原因是 `ResultRowPresentation` 尚未导出 `matchTone`。
- 实现 `resultMatchTone()` 并接入 UI 后目标测试转绿。

验证：

```bash
pnpm test:result-presentation
pnpm test:match-type-meta
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1`。
- 输入 `github`：
  - 结果 `GitHub` 的匹配标签为 `精确`，class 包含 `tone-exact`。
- 输入 `sz`：
  - 结果 `设置` 的匹配标签为 `拼音`，class 包含 `tone-pinyin`。
- 输入 `gub`：
  - 结果 `GitHub` 的匹配标签为 `模糊`，class 包含 `tone-fuzzy`。
- 注入本地别名 `cfg -> system:settings` 后输入 `cfg`：
  - 结果 `设置` 的匹配标签为 `别名`，class 包含 `tone-alias`。
- 四类查询 `.result-row/.result-title/.result-desc/.result-meta/.match-chip/.source-chip` 溢出计数均为 0。
- console error/warn 为 0。

结果：

- `pnpm test:result-presentation`：通过。
- `pnpm test:match-type-meta`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，174 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`main_window:true`，`settings_window:true`，`mcp_ready:true`，`agent_tools_count:8`，权限/数据/系统设置 smoke 均通过。退出阶段仍有 Vite `write EPIPE` 停服日志，但命令退出码为 0，脚本输出 `Desktop smoke passed`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 99% | 99% | 匹配标签从统一灰色升级为按精确/别名/拼音/模糊等 tone 区分，结果列表更容易扫读 |
| 测试与发布 | 99% | 99% | 扩展 presentation 测试，并通过浏览器 DOM/console、构建和真实 desktop smoke |
| ZTools 设置页 UI | 99% | 99% | 本批不改设置页 |
| Agent/MCP 底座 | 95% | 95% | 本批不改 MCP/Agent |

当前重点剩余：

1. 内置程序体验：继续打磨设置页空状态、局部交互和主搜索极端结果量信息密度。
2. 设置真实功能：WebDAV 插件数据恢复应用、冲突合并和更细粒度确认仍未接入。
3. Agent/MCP：客户端自动写入/合并配置仍未做。
4. 插件 tools 暴露和插件 bridge 回归按当前要求暂缓。
5. macOS 发布质量：签名、公证、自动更新仍未接入。

## 第七十七批：主搜索结果行上下文 Enter 提示

用户要求：继续还原完成度，测试没问题后同步更新文档。本批聚焦主搜索结果列表的日常体感，让选中行的 Enter 提示从统一 `执行` 变成按结果类型区分的动作提示。

状态：DONE。

修改文件：

- `src/lib/resultPresentation.ts`
- `scripts/test-result-presentation.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `resultShortcutHint()` 按结果类型输出更准确的动作：
  - `web:` / `url:` / `local:` / `local-app:`：`Enter 打开`
  - `text:` 普通文本转换：`Enter 复制`
  - `text:` path-open：`Enter 打开`
  - `text:` path-reveal：`Enter 定位`
  - `paste:open:`：`Enter 打开`
  - `paste:reveal:`：`Enter 定位`
  - 其他 `paste:` 处理类工具：`Enter 处理`
  - 系统、别名、历史、插件等默认：`Enter 执行`
- `ariaLabel` 自动包含新的上下文提示，读屏和 DOM 验证能看到真实动作。
- UI 层无需额外分支，继续读取 `resultRowPresentation()`。

TDD 记录：

- 先扩展 `scripts/test-result-presentation.mjs`：
  - 网页快开选中行期望 `Enter 打开`。
  - JSON 文本识别期望 `Enter 复制`。
  - Finder 定位期望 `Enter 定位`。
  - 粘贴图片 OCR/压缩这类处理动作期望 `Enter 处理`。
  - 未选中行仍不显示提示。
- 初次运行红灯，原因是所有选中结果仍统一返回 `Enter 执行`。
- 实现结果类型判断后目标测试转绿。

验证：

```bash
pnpm test:result-presentation
pnpm test:search-feedback
pnpm test:tauri-desktop-smoke-script
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1`。
- 输入 `github`：
  - 选中行文本包含 `Enter 打开`。
- 输入 `{"ok":true}`：
  - 选中行文本包含 `Enter 复制`。
- `.result-row` 横向溢出数量为 0。
- console error/warn 为 0。

结果：

- `pnpm test:result-presentation`：通过。
- `pnpm test:search-feedback`：通过。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，174 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_ready:true`，`agent_tools_count:8`，权限/数据/系统设置 smoke 均通过。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 99% | 99% | 结果行 Enter 提示从统一执行升级为打开/复制/定位/处理等上下文动作，更接近日常命令面板体感 |
| 测试与发布 | 99% | 99% | 扩展结果展示模型测试，并通过浏览器 DOM/console、构建和真实 desktop smoke |
| ZTools 设置页 UI | 99% | 99% | 本批不改设置页 |
| Agent/MCP 底座 | 95% | 95% | 本批不改 MCP/Agent |

当前重点剩余：

1. 内置程序体验：继续打磨主搜索极端结果量信息密度、设置页空状态和局部交互。
2. 设置真实功能：WebDAV 插件数据恢复应用、冲突合并和更细粒度确认仍未接入。
3. Agent/MCP：客户端自动写入/合并配置仍未做。
4. 插件 tools 暴露和插件 bridge 回归按当前要求暂缓。
5. macOS 发布质量：签名、公证、自动更新仍未接入。

## 第七十六批：所有指令页别名管理体感增强

用户要求：继续还原完成度，插件不着急，先完善内置程序体验。本批聚焦设置页 `所有指令`，把指令列表里的别名状态从单一统计文案升级为可扫读、可操作的行级管理体验。

状态：DONE。

修改文件：

- `src/lib/settingsPages.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-settings-pages.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `commandCenterRows()` 新增行级别名展示字段：
  - `aliasActionLabel`：无别名时显示 `添加别名`，已有别名时显示 `管理别名`。
  - `aliasPreview`：优先展示启用别名，若没有启用别名则展示已有停用别名，最多 3 个。
  - `aliasHint`：展示 `未设置短词`、`别名均已停用`、`N 个别名可用` 或 `N/M 个别名可用`。
- 设置页 `所有指令`：
  - 列表行新增别名提示和别名 chip。
  - 行级按钮从统一 `别名` 改为更明确的 `添加别名` / `管理别名`。
  - 保持原有来源筛选、状态筛选、搜索和别名新增逻辑。
- 样式：
  - 别名 chip 使用紧凑行内样式，不增加卡片嵌套。
  - 浏览器验证中 `.command-target-row` 横向溢出数为 0。

TDD 记录：

- 先扩展 `scripts/test-settings-pages.mjs`：
  - 对已有停用别名的本地启动行，期望 `aliasActionLabel=管理别名`、`aliasPreview=["desk"]`、`aliasHint=别名均已停用`。
  - 对无别名的网页快开行，期望 `aliasActionLabel=添加别名`、`aliasPreview=[]`、`aliasHint=未设置短词`。
- 初次运行红灯，原因是 `CommandCenterRow` 尚无这些字段。
- 实现模型字段和 UI 渲染后目标测试转绿。

验证：

```bash
pnpm test:command-aliases
pnpm test:settings-pages
pnpm check
pnpm test:tauri-desktop-smoke-script
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1`。
- 进入 `设置` -> `所有指令`。
- DOM 可见：
  - `所有指令`
  - `添加别名`
  - `管理别名`
  - `未设置短词` 或 `N 个别名可用`
  - 已配置别名 chip，例如 `cfg`
- `.command-target-row` 横向溢出数量为 0。
- console error/warn 为 0。

结果：

- `pnpm test:command-aliases`：通过。
- `pnpm test:settings-pages`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm build`：通过，174 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_ready:true`，`agent_tools_count:8`，权限/数据/系统设置 smoke 均通过。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 99% | 99% | `所有指令` 列表新增行级别名提示、chip 和明确的添加/管理入口，体感更接近指令中心 |
| 设置项真实功能 | 99% | 99% | 复用已有别名新增/保存链路，本批不引入新的本地副作用 |
| 测试与发布 | 99% | 99% | 扩展设置页模型测试，并通过浏览器 DOM/console、构建和真实 desktop smoke |
| Agent/MCP 底座 | 95% | 95% | 本批不改 MCP/Agent |

当前重点剩余：

1. 内置程序体验：继续打磨主搜索微交互、极端结果量信息密度、设置页空状态。
2. 设置真实功能：WebDAV 插件数据恢复应用、冲突合并和更细粒度确认仍未接入。
3. Agent/MCP：客户端自动写入/合并配置仍未做。
4. 插件 tools 暴露和插件 bridge 回归按当前要求暂缓。
5. macOS 发布质量：签名、公证、自动更新仍未接入。

## 第七十五批：MCP initialized notification / ping 协议补齐

用户要求：插件不着急，先继续完善内置程序体验。本批聚焦内置 Agent/MCP 底座的客户端连接体感，补齐严格 MCP 客户端初始化流程中会遇到的 `notifications/initialized` 和 `ping` 行为。

状态：DONE。

修改文件：

- `crates/atools-core/src/mcp.rs`
- `crates/atools-core/tests/agent_tests.rs`
- `src-tauri/src/mcp_server.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/desktop_smoke.rs`
- `scripts/smoke-tauri-desktop.mjs`
- `scripts/test-tauri-desktop-smoke-script.mjs`
- `docs/agent-mcp-client.md`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- core MCP static handler：
  - 新增 `handle_static_mcp_message()`，支持 JSON-RPC notification 返回 `None`。
  - `notifications/initialized` 不再返回 `Method not found`。
  - `ping` 返回标准 JSON-RPC `{ "result": {} }`。
  - 旧 `handle_static_mcp_request()` 保留，兼容已有调用方。
- HTTP MCP server：
  - `/mcp` 对 `notifications/initialized` 返回 `204 No Content`，不再发送 JSON 错误体。
  - `ping` 走统一 static handler。
  - `tools/call` 仍由桌面端权限、审计和工具执行链路处理。
- stdio proxy：
  - fallback 状态下 `initialize`、`tools/list`、`ping` 可本地响应。
  - `notifications/initialized` 不向 stdout 写任何 JSON 行。
  - 转发桌面 HTTP server 时识别 `204 No Content` 并跳过 stdout 输出。
- desktop smoke：
  - `data_debug_smoke` 新增 `mcp_ping_ok`。
  - `data_debug_smoke` 新增 `mcp_initialized_notification_ok`。
  - smoke 运行时通过本地 TCP 真实请求 HTTP MCP，不只验证内存 handler。

TDD 记录：

- 先扩展 `crates/atools-core/tests/agent_tests.rs`：
  - `mcp_static_handler_accepts_initialized_notification_without_response`
  - `mcp_static_handler_responds_to_ping`
- 初次运行红灯，原因是 `handle_static_mcp_message` 尚不存在。
- 再扩展 `src-tauri/src/lib.rs` 的 stdio fallback 单测：
  - `local_stdio_fallback_skips_initialized_notification`
  - `local_stdio_fallback_responds_to_ping`
- 初次运行红灯，原因是 fallback 固定返回 `serde_json::Value`。
- 扩展桌面 smoke 解析脚本和 Rust snapshot，要求输出两个 MCP 协议 smoke 字段；初次运行红灯，原因是字段尚不存在。
- 实现 core/HTTP/stdio/smoke 后目标测试转绿。

验证：

```bash
cargo test -p atools-core mcp_static_handler -- --nocapture
cargo test -p atools --lib
cargo test -p atools --test agent_tools_tests
cargo fmt --all --check
pnpm test:mcp-client-config
pnpm test:tauri-desktop-smoke-script
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `cargo test -p atools-core mcp_static_handler -- --nocapture`：通过，3 个 MCP static handler 用例通过。
- `cargo test -p atools --lib`：通过，37 passed。
- `cargo test -p atools --test agent_tools_tests`：通过，23 passed。
- `cargo fmt --all --check`：通过。
- `pnpm test:mcp-client-config`：通过。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，174 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，`mcp_ready:true`，`agent_tools_count:8`，`data_debug_smoke.mcp_ping_ok:true`，`data_debug_smoke.mcp_initialized_notification_ok:true`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP 底座 | 94% | 95% | MCP lifecycle 关键请求/通知补齐，HTTP 和 stdio 都不会误把 `initialized` notification 当错误 |
| 测试与发布 | 99% | 99% | 真实 desktop smoke 新增 MCP 协议探测字段，并通过运行态验证 |
| 内置 Agent 工具 | 80% | 80% | 本批不扩展工具能力 |
| 设置项真实功能 | 99% | 99% | 本批不改设置页功能 |

当前重点剩余：

1. 内置程序体验：继续打磨 ZTools 风格设置页细节、主搜索微交互、空状态和禁用态。
2. Agent/MCP：客户端自动写入/合并配置需要确认流后再做。
3. 内置 Agent 工具：WebP 输出、文件搜索性能/忽略规则、OCR 本地服务稳定性、浏览器/Finder 上下文真实读取仍可增强。
4. 插件 tools 暴露按当前要求暂缓。
5. macOS 发布质量：签名、公证、自动更新仍未接入。

## 第七十四批：AI 默认模型接入 Agent 工具调用

用户要求：继续还原完成度，测试没问题后同步文档。本批接上第七十三批的 AI `/models` 连接测试，把 AI 配置真正接入 Agent 工具链路；新增 `ask_ai_model` 作为受权限、审计和 MCP 工具开关管理的内置 Agent 工具。

状态：DONE。

修改文件：

- `src-tauri/src/agent_tools.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/tests/agent_tools_tests.rs`
- `src/components/SettingsPanel.svelte`
- `scripts/test-tauri-desktop-smoke-script.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增内置 Agent 工具 `ask_ai_model`：
  - 进入默认工具 registry，真实桌面 smoke 中工具数从 7 增加到 8。
  - scope 为 `network`，仍走现有保守确认、按工具授权、scope 阻断和审计链路。
  - 输入支持 `prompt`、`system`、`max_tokens`。
  - 读取 `settings-general` 中的 `aiProvider`、`aiBaseUrl`、`aiDefaultModel`、`aiApiKey`、`aiTemperature`、`aiUseForAgent`。
  - 只有 `aiUseForAgent=true` 时才允许调用。
  - `openai` / `compatible` 要求 API Key；`local` 允许空 Key。
  - 调用 OpenAI-compatible `POST /chat/completions`，不支持 stream。
  - 输出 `status`、`provider`、`model`、`text`、`finish_reason`、`usage`、`duration_ms`，不返回 API Key。
- 设置页 `AI 模型`：
  - `用于 Agent 默认模型` 说明从“后续会读取”改为 `开启后 ask_ai_model 工具会读取这组本地配置`。
- 运行诊断和 smoke 脚本：
  - `agent_tool_count` 精确更新为 8。
  - 真实 desktop smoke 输出 `enabled_agent_tools` 包含 `ask_ai_model`。

TDD 记录：

- 先扩展 `src-tauri/tests/agent_tools_tests.rs`：
  - registry 期望新增 `ask_ai_model`。
  - `agent_ai_config_from_settings` 要求 Agent 默认开关开启，且远端 provider 必须有 API Key。
  - `ask_ai_model` 使用本地 TCP HTTP 服务器，验证请求路径、Bearer token、model、temperature、max_tokens、system/user messages，并解析返回文本。
- 初次运行红灯，原因为 `agent_ai_config_from_settings` / `ask_ai_model` 不存在。
- 实现后目标测试转绿。
- 扩大验证时发现 `runtime_diagnostics_snapshot_reports_paths_counts_mcp_and_events` 仍硬编码 7 个工具；根因为新增默认工具后旧精确断言过期。修正为 8，并增加 `ask_ai_model` 存在性断言后转绿。

验证：

```bash
cargo test -p atools --test agent_tools_tests
cargo fmt --all --check
pnpm test:tauri-desktop-smoke-script
cargo test -p atools --lib
pnpm test:settings-pages
pnpm test:ai-connection-view
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1`。
- Web 预览下 Agent 面板无 Tauri runtime，工具白名单不读取桌面工具；真实工具列表由 desktop smoke 验证。
- 进入 `设置` -> `AI 模型`。
- DOM 可见 `ask_ai_model 工具会读取这组本地配置`。
- 旧文案 `后续内置 Agent 工作流会优先读取这组本地配置` 不再出现。
- Web 预览下 `测试连接` 仍禁用，title 为 `需在桌面应用中测试 AI 连接`。
- 控制台 error / warn 为空。

结果：

- `cargo test -p atools --test agent_tools_tests`：通过，23 passed。
- `cargo fmt --all --check`：通过。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `cargo test -p atools --lib`：通过，35 passed。
- `pnpm test:settings-pages`：通过。
- `pnpm test:ai-connection-view`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，174 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，MCP ready，`agent_tools_count:8`，`enabled_agent_tools` 包含 `ask_ai_model`，权限/数据/系统设置 smoke 均通过。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP 底座 | 93% | 94% | AI 默认模型配置从连接测试推进到真实 Agent 工具调用 |
| 内置 Agent 工具 | 73% | 80% | 新增 `ask_ai_model`，由权限和审计链路管理，可通过 MCP 暴露 |
| 设置项真实功能 | 99% | 99% | AI 配置已被 Agent 工具读取；超级面板/悬浮球/插件市场等仍未完成，暂不升 100% |
| Tauri/Rust 桌面底座 | 97% | 97% | 本批新增工具调用能力，不改变发布侧缺口 |
| 测试与发布 | 99% | 99% | Agent 工具测试、运行诊断测试、构建和真实 desktop smoke 已回归 |

当前重点剩余：

1. Agent/MCP：继续补 MCP 协议完整性、客户端自动写入/合并配置；`ask_ai_model` 的真实远端调用已经接入，但客户端配置仍需手动复制。
2. 内置 Agent 工具：WebP 输出、文件搜索性能/忽略规则、OCR 本地服务稳定性、浏览器/Finder 上下文真实读取仍可增强。
3. WebDAV：插件数据恢复应用、冲突合并和更细粒度确认仍未接入。
4. macOS 发布质量：签名、公证、自动更新仍未接入。

## 第七十三批：AI 模型连接测试闭环

用户要求：插件不着急，先继续完善内置程序体验。本批聚焦设置页 `AI 模型`，把“只保存本地配置”推进为桌面端可验证的 OpenAI-compatible `/models` 连接测试；仍不发送聊天请求，也不把 API Key 写入日志、审计或 MCP 客户端配置。

状态：DONE。

修改文件：

- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`
- `src/lib/aiConnectionView.ts`
- `src/lib/types.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-ai-connection-view.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 Tauri command `test_ai_connection`：
  - 从当前设置读取 `aiProvider`、`aiBaseUrl`、`aiDefaultModel`、`aiApiKey`。
  - `disabled` 或配置不完整时返回明确错误。
  - `openai` / `compatible` 要求 API Key，`local` 允许空 Key。
  - 将 Base URL 规范到 `/models`，只允许 `http` / `https`。
  - 使用 `GET /models` 读取模型列表，并检查默认模型是否存在。
  - 返回 provider、base_url、model、models_count、model_found、duration_ms，不返回 API Key。
- 设置页 `AI 模型`：
  - 标题区新增 `测试连接` 按钮。
  - Web 预览下按钮禁用，title 为 `需在桌面应用中测试 AI 连接`。
  - 桌面端点击前先保存当前配置，再调用 `test_ai_connection`。
  - 配置字段变更时清空旧测试结果，避免显示过期状态。
  - 成功后显示 `连接测试` 结果区，包含连接状态、提供商、Base URL、模型是否找到、模型数量和耗时。
  - 页面文案改为 `桌面端会读取 /models 验证配置和默认模型；不会发送聊天内容，也不会把 API Key 写入审计或 MCP 配置。`

TDD 记录：

- 先扩展 `src-tauri/src/commands.rs` 单测，红灯为 `ai_connection_config_from_settings`、`ai_models_url`、`test_ai_connection_config` 不存在或未导出。
- Rust 测试覆盖：
  - OpenAI-compatible Base URL 会追加 `/models`。
  - `disabled` 或远端 provider 缺 API Key 会拒绝。
  - 本地测试服务器收到 `GET /v1/models` 和 `Authorization: Bearer sk-local`。
  - 返回模型列表后，结果包含 `models_count=2`、`model_found=true` 和耗时。
- 先新增 `scripts/test-ai-connection-view.mjs`，红灯为 `src/lib/aiConnectionView.ts` 不存在。
- 前端视图测试覆盖：
  - Web 预览、未启用、配置不完整、测试中、可测试等按钮状态和原因。
  - 连接结果行显示 `已连接`、`模型 / 已找到`、模型数量、耗时。
  - 默认模型不在列表时显示 `未出现在列表`。

验证：

```bash
cargo test -p atools --lib settings_command_tests::ai_connection
pnpm test:ai-connection-view
cargo fmt --all --check
cargo test -p atools --lib
pnpm test:settings-pages
pnpm test:settings-normalization
pnpm test:webdav-sync-view
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1`。
- 进入 `设置` -> `AI 模型`。
- DOM 可见 `AI 模型`、`测试连接`、新的 `/models` 说明文案和配置预览。
- Web 预览下 `测试连接` 禁用，title 为 `需在桌面应用中测试 AI 连接`。
- 旧文案 `实际 Agent/插件调用接入前不会自动发送请求` 不再出现。
- 控制台 error / warn 为空。

结果：

- `cargo test -p atools --lib settings_command_tests::ai_connection`：通过，2 passed。
- `pnpm test:ai-connection-view`：通过。
- `cargo fmt --all --check`：通过。
- `cargo test -p atools --lib`：通过，35 passed。
- `pnpm test:settings-pages`：通过。
- `pnpm test:settings-normalization`：通过。
- `pnpm test:webdav-sync-view`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，174 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，MCP ready，7 个默认 Agent 工具可见，`settings_preserved:true`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Tauri/Rust 桌面底座 | 96% | 97% | 增加 AI `/models` 连接测试命令，覆盖 URL 规范化、HTTP 请求和运行时事件记录 |
| 设置项真实功能 | 99% | 99% | AI 模型页从本地保存推进到连接测试；真实 Agent 调用仍未接入，暂不升 100% |
| ZTools 设置页 UI | 99% | 99% | AI 模型页新增连接按钮、测试状态和结果区 |
| Agent/MCP 底座 | 92% | 93% | AI 默认模型配置可先验证模型列表，降低后续 Agent 调用接入风险 |
| 测试与发布 | 99% | 99% | 增加 Rust/前端 AI 连接测试，并通过构建和真实 desktop smoke |

当前重点剩余：

1. 内置程序体验：继续补 AI 配置接入真实 Agent 工作流调用，或者打磨插件市场禁用态/本地市场体验。
2. Agent/MCP：继续补 MCP 协议完整性、客户端自动写入/合并配置；插件 tools 暴露按当前要求暂缓。
3. WebDAV：插件数据恢复应用、冲突合并和更细粒度确认仍未接入。
4. macOS 发布质量：签名、公证、自动更新仍未接入。

## 第七十二批：WebDAV 剪贴板历史追加导入确认流

用户要求：继续还原完成度，测试没问题后同步文档。本批继续内置程序体验，不推进插件兼容；把 WebDAV 恢复链路从设置恢复扩展到剪贴板历史追加导入。策略是追加本机缺失文本，不清空、不覆盖现有剪贴板历史。

状态：DONE。

修改文件：

- `src-tauri/src/webdav.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/tests/webdav_tests.rs`
- `src/lib/webdavSyncView.ts`
- `src/lib/types.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-webdav-sync-view.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 Rust `restore_webdav_clipboard_history()`：
  - 未传入 `confirmed=true` 时直接拒绝。
  - 只读取远端 `manifest.json` 和 `clipboard-history.json`，不会下载 `settings.json` / `plugin-data.json`。
  - 从远端 `entries` 中抽取非空文本，优先使用 `last_copied_at`，其次 `first_copied_at`。
  - 统计远端条目数、跳过的无效条目数和可导入条目。
- 新增 Tauri command `restore_webdav_clipboard_history`：
  - 只追加导入本机缺失的文本历史。
  - 已存在的同文本历史保持原 `used_count` 和 `last_copied_at`，不被远端覆盖。
  - UI 返回摘要，不把完整剪贴板文本回传到设置页展示。
- 设置页 `WebDAV 同步`：
  - `同步状态` 区新增 `导入剪贴板` 按钮。
  - Web 预览下保持禁用，提示 `需在桌面应用中导入剪贴板历史`。
  - 生成恢复计划后，只有远端剪贴板历史有差异时才允许导入。
  - 点击导入会弹出确认，文案强调追加导入、不清空、不覆盖。
  - 导入完成后显示 `剪贴板导入结果`，包含远端条目、已导入、已跳过和耗时。

TDD 记录：

- 先扩展 `src-tauri/tests/webdav_tests.rs`，红灯为 `restore_webdav_clipboard_history` 不存在。
- Rust WebDAV 测试覆盖：
  - 未确认导入返回包含 `confirmation` 的错误。
  - 本地 HTTP 服务器返回 manifest、settings、plugin-data、clipboard-history。
  - 剪贴板恢复只发 `GET` 请求，并且只请求 `manifest.json` / `clipboard-history.json`。
  - 空文本条目会被跳过，非空文本会提取 `copied_at`。
- 先扩展 `src-tauri/src/commands.rs` 单测，红灯为 `record_webdav_clipboard_entries` / `WebdavClipboardRestoreEntry` 不存在。
- Commands 测试覆盖：
  - 已有本机剪贴板文本不重复写入。
  - 远端缺失文本追加导入。
  - 已有文本的 `used_count` 和 `last_copied_at` 不被远端覆盖。
- 先扩展 `scripts/test-webdav-sync-view.mjs`，红灯为 `webdavClipboardRestoreButtonState is not a function`。
- 前端视图测试覆盖：
  - `导入剪贴板` 在 Web 预览、无计划、无差异、导入中等状态下的禁用原因。
  - 剪贴板有差异时按钮可用，原因说明追加导入且不清空本机历史。
  - 导入结果行展示 manifest、远端条目、已导入、已跳过和耗时。

验证：

```bash
cargo test -p atools --test webdav_tests
cargo test -p atools --lib
cargo fmt --all --check
pnpm test:webdav-sync-view
pnpm test:settings-pages
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1`。
- 进入 `设置` -> `WebDAV 同步`。
- 页面显示 `检查远端备份`、`生成恢复计划`、`恢复设置`、`导入剪贴板`、`立即同步`。
- Web 预览下 `导入剪贴板` 禁用，title 为 `需在桌面应用中导入剪贴板历史`。
- 控制台 error / warn 为空。

结果：

- `cargo test -p atools --test webdav_tests`：通过，9 passed。
- `cargo test -p atools --lib`：通过，32 passed。
- `cargo fmt --all --check`：通过。
- `pnpm test:webdav-sync-view`：通过。
- `pnpm test:settings-pages`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，173 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，MCP ready，7 个默认 Agent 工具可见，`settings_preserved:true`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Tauri/Rust 桌面底座 | 96% | 96% | WebDAV 增加剪贴板历史追加导入命令；签名/公证/自动更新仍是发布缺口 |
| 设置项真实功能 | 99% | 99% | WebDAV 从设置恢复推进到剪贴板历史追加导入；插件数据恢复和冲突合并仍不做，暂不升 100% |
| ZTools 设置页 UI | 99% | 99% | WebDAV 状态页增加导入剪贴板按钮和剪贴板导入结果区 |
| 测试与发布 | 99% | 99% | WebDAV Rust 集成测试扩展到 clipboard restore，前端状态模型、构建和桌面 smoke 已回归 |

当前重点剩余：

1. 内置程序体验：继续打磨 WebDAV 插件数据恢复前的更细确认/冲突合并，或转向插件市场禁用态/本地市场体验。
2. Agent/MCP：继续补 MCP 协议完整性、AI 配置接入真实 Agent 调用；客户端自动写入/合并配置需要单独确认流后再做。
3. 插件 tools 暴露和真实插件兼容按当前要求暂缓。
4. macOS 发布质量：签名、公证、自动更新仍未接入。

## 第七十一批：WebDAV 设置恢复应用确认流

用户要求：插件不着急，先继续完善内置程序体验。本批继续收口 `WebDAV 同步` 页面，把第七十批的恢复计划推进到可用的设置恢复确认流；只允许恢复 `settings.json`，插件数据和剪贴板历史仍保持高风险预览，不直接写入。

状态：DONE。

修改文件：

- `src-tauri/src/webdav.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/tests/webdav_tests.rs`
- `src/lib/webdavSyncView.ts`
- `src/lib/types.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-webdav-sync-view.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 Rust `restore_webdav_settings()`：
  - 未传入 `confirmed=true` 时直接拒绝，且不会发起网络请求。
  - 只读取远端 `manifest.json` 和 `settings.json`，不下载 `plugin-data.json` / `clipboard-history.json`。
  - 合并设置时跳过远端 `<redacted>` 字段，保留本机 AI Key、WebDAV 密码等敏感配置。
  - 返回 `applied_keys`、`skipped_keys`、远端 manifest 类型/导出时间、合并后的 `merged_settings` 和耗时。
- 新增 Tauri command `restore_webdav_settings`，由桌面端负责下载并合并远端设置；最终写入仍走设置页现有 `applyNativeSettings` + `saveAToolsSettings` 链路。
- 设置页 `WebDAV 同步`：
  - `同步状态` 区新增 `恢复设置` 按钮。
  - Web 预览下保持禁用，提示 `需在桌面应用中恢复`。
  - 生成恢复计划后，只有远端设置有变化时才允许恢复设置。
  - 点击恢复设置会弹出确认，确认文案列出将恢复的 key 和跳过的脱敏字段。
  - 恢复后显示 `设置恢复结果`，包含已恢复 key、已跳过 key 和耗时。
  - 明确提示插件数据和剪贴板历史仍只预览，不会写入本机。

TDD 记录：

- 先扩展 `src-tauri/tests/webdav_tests.rs`，红灯为 `restore_webdav_settings` 不存在。
- Rust 测试覆盖：
  - 未确认恢复返回包含 `confirmation` 的错误。
  - 本地 HTTP 服务器返回 manifest、settings、plugin-data、clipboard-history。
  - 设置恢复只发 `GET` 请求，并且只请求 `manifest.json` / `settings.json`。
  - 远端 `hotkey`、`theme`、`webdavSyncClipboard` 写入合并结果。
  - 远端 `aiApiKey`、`webdavPassword` 为 `<redacted>` 时跳过，并保留本机原值。
- 先扩展 `scripts/test-webdav-sync-view.mjs`，红灯为 `webdavSettingsRestoreButtonState is not a function`。
- 前端视图测试覆盖：
  - `恢复设置` 在 Web 预览、无计划、设置无变化、恢复中等状态下的禁用原因。
  - 设置有变化时按钮可用，原因说明只恢复设置，插件数据和剪贴板不会写入。
  - 恢复结果行展示 manifest、已恢复 key、已跳过 key 和耗时。

验证：

```bash
cargo test -p atools --test webdav_tests
cargo test -p atools --lib
cargo fmt --all --check
pnpm test:webdav-sync-view
pnpm test:settings-pages
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1`。
- 进入 `设置` -> `WebDAV 同步`。
- 页面显示 `检查远端备份`、`生成恢复计划`、`恢复设置`、`立即同步`。
- Web 预览下 `恢复设置` 禁用，title 为 `需在桌面应用中恢复`。
- 页面不再显示 `真正恢复需要后续确认流`、`未接入网络同步命令` 或 `真实上传/下载同步尚未接入`。
- 控制台 error / warn 为空。

结果：

- `cargo test -p atools --test webdav_tests`：通过，7 passed。
- `cargo test -p atools --lib`：通过，31 passed。
- `cargo fmt --all --check`：通过。
- `pnpm test:webdav-sync-view`：通过。
- `pnpm test:settings-pages`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，173 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`status:"ok"`，MCP ready，7 个默认 Agent 工具可见，`settings_preserved:true`。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Tauri/Rust 桌面底座 | 96% | 96% | WebDAV 增加设置恢复合并命令，仍有签名/公证/自动更新缺口 |
| 设置项真实功能 | 99% | 99% | WebDAV 设置恢复确认流已接入；插件数据/剪贴板恢复应用和冲突合并仍不做，暂不升 100% |
| ZTools 设置页 UI | 99% | 99% | WebDAV 状态页增加恢复设置按钮和设置恢复结果区 |
| 测试与发布 | 99% | 99% | WebDAV Rust 集成测试扩展到 settings restore，前端状态模型和桌面 smoke 已回归 |

当前重点剩余：

1. 内置程序体验：继续打磨插件市场禁用态/本地市场体验，或继续做 WebDAV 插件数据/剪贴板恢复应用前的更细确认/冲突合并。
2. Agent/MCP：继续补 MCP 协议完整性、AI 配置接入真实 Agent 调用；客户端自动写入/合并配置需要单独确认流后再做。
3. 插件 tools 暴露和真实插件兼容按当前要求暂缓。
4. macOS 发布质量：签名、公证、自动更新仍未接入。

## 第七十批：WebDAV 恢复计划 diff 预览

用户要求：继续还原完成度，测试没问题后同步文档。本批继续 WebDAV 恢复链路，但仍不直接执行远端覆盖；先生成本机与远端备份的恢复计划，给后续确认流提供明确 diff。

状态：DONE。

修改文件：

- `src-tauri/src/webdav.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/tests/webdav_tests.rs`
- `src/lib/webdavSyncView.ts`
- `src/lib/types.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-webdav-sync-view.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 Rust `plan_webdav_restore()`：
  - 只发送 `GET` 请求读取远端备份。
  - 不写入本机数据库。
  - 对 `settings.json` 逐 key 比较本机与远端值。
  - 对远端 `<redacted>` 的敏感配置标记为跳过，避免把脱敏占位值作为恢复值。
  - 对 `plugin-data.json` / `clipboard-history.json` 返回替换摘要并标记高风险。
- 新增 Tauri command `plan_webdav_restore`，桌面端基于当前本机设置、插件数据和剪贴板历史生成恢复计划。
- 设置页 `WebDAV 同步`：
  - `同步状态` 区新增 `生成恢复计划` 按钮。
  - Web 预览下保持禁用并提示 `需在桌面应用中生成`。
  - 计划成功后展示 `恢复计划预览`。
  - diff 行展示设置变更 key、跳过的脱敏 key、插件/剪贴板替换摘要和高风险标记。
  - 明确提示：当前只生成恢复计划，不会写入本机数据；真正恢复需要后续确认流。

TDD 记录：

- 先扩展 `src-tauri/tests/webdav_tests.rs`，红灯为 `plan_webdav_restore` / `WebdavRestoreLocalSnapshot` 不存在。
- Rust 测试覆盖：
  - 本地 HTTP 服务器返回 manifest、settings、plugin-data、clipboard-history。
  - restore plan 只发 `GET` 请求。
  - `settings` 识别 `hotkey` 会更新，并跳过 `webdavPassword` 的 `<redacted>`。
  - `plugin-data` / `clipboard-history` 标记为 `would_replace` 且高风险。
  - 计划返回 manifest 类型、导出时间和 3 个范围。
- 先扩展 `scripts/test-webdav-sync-view.mjs`，红灯为 `webdavRestorePlanButtonState is not a function`。
- 前端视图测试覆盖：
  - `生成恢复计划` 可用、生成中、禁用原因。
  - 恢复计划行展示 `将更新`、`将替换`、跳过 key 和高风险标记。

验证：

```bash
cargo test -p atools --test webdav_tests
cargo test -p atools --lib
cargo fmt --all --check
pnpm test:webdav-sync-view
pnpm test:settings-pages
pnpm check
pnpm build
```

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1`。
- 进入 `设置` -> `WebDAV 同步`。
- 页面显示 `检查远端备份`、`生成恢复计划`、`立即同步`。
- Web 预览下 `生成恢复计划` 禁用，title 为 `需在桌面应用中生成`。
- 页面显示只读保护文案。
- 页面不再显示 `未接入网络同步命令` 或 `真实上传/下载同步尚未接入`。
- 控制台无 error / warning；仅有浏览器对 password input 不在 form 内的 verbose 提示。

结果：

- `cargo test -p atools --test webdav_tests`：通过，5 passed。
- `cargo test -p atools --lib`：通过，31 passed。
- `cargo fmt --all --check`：通过。
- `pnpm test:webdav-sync-view`：通过。
- `pnpm test:settings-pages`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，173 modules transformed。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Tauri/Rust 桌面底座 | 96% | 96% | WebDAV 增加恢复计划 diff 命令，底座完成度维持不变 |
| 设置项真实功能 | 99% | 99% | WebDAV 从远端备份预览推进到恢复计划 diff；恢复应用/冲突合并仍未做，暂不升 100% |
| ZTools 设置页 UI | 99% | 99% | WebDAV 状态页增加生成恢复计划按钮和 diff 预览区 |
| 测试与发布 | 99% | 99% | WebDAV Rust 集成测试扩展到 restore plan，前端状态模型测试同步扩展 |

当前重点剩余：

1. 内置程序体验：继续做 WebDAV 恢复应用前的确认流，或转向插件市场禁用态/本地市场体验。
2. Agent/MCP：继续补 MCP 协议完整性、AI 配置接入真实 Agent 调用；客户端自动写入/合并配置需要单独确认流后再做。
3. 插件 tools 暴露和真实插件兼容按当前要求暂缓。
4. macOS 发布质量：签名、公证、自动更新仍未接入。

## 第六十九批：WebDAV 远端备份检查与恢复预览

用户要求：继续还原完成度，测试没问题后同步文档。本批继续 WebDAV 内置体验，但不直接做危险的远端覆盖本机数据；先补“检查远端备份”只读预览，作为后续恢复确认流的前置闭环。

状态：DONE。

修改文件：

- `src-tauri/src/webdav.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/tests/webdav_tests.rs`
- `src/lib/webdavSyncView.ts`
- `src/lib/types.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-webdav-sync-view.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 Rust `preview_webdav_backup()`：
  - 只发送 `GET` 请求，不发送 `MKCOL` / `PUT`，不写入本地数据库。
  - 读取远端 `manifest.json`。
  - 根据 manifest 文件列表读取远端 `settings.json`、`plugin-data.json`、`clipboard-history.json` 等备份文件。
  - 返回备份类型、导出时间、远端目录、文件数、声明字节数、下载字节数和摘要。
- 新增 Tauri command `preview_webdav_backup`，桌面端读取成功后写 runtime event。
- 设置页 `WebDAV 同步`：
  - `同步状态` 区新增 `检查远端备份` 按钮。
  - Web 预览下保持禁用并提示 `需在桌面应用中检查`。
  - 检查成功后展示 `远端备份预览`，包含备份类型、导出时间、文件数量和每个文件摘要。
  - 常驻提示：检查远端备份只读取 manifest 和文件摘要，不会覆盖本机设置、插件数据或剪贴板历史。

TDD 记录：

- 先扩展 `src-tauri/tests/webdav_tests.rs`，红灯为 `preview_webdav_backup` 不存在。
- Rust 测试覆盖：
  - 本地 HTTP 服务器返回 manifest、settings、plugin-data。
  - preview 只发 `GET` 请求。
  - preview 会读取 manifest 和 manifest 声明的文件。
  - 返回 `manifest_kind`、`exported_at`、`remote_path`、文件摘要和字节数。
- 先扩展 `scripts/test-webdav-sync-view.mjs`，红灯为 `webdavPreviewButtonState is not a function`。
- 前端视图测试覆盖：
  - `检查远端备份` 可用、检查中、禁用原因。
  - 远端预览行展示备份类型、导出时间、文件数量和文件摘要。

验证：

```bash
cargo test -p atools --test webdav_tests
cargo test -p atools --lib
cargo fmt --all --check
pnpm test:webdav-sync-view
pnpm test:settings-pages
pnpm check
pnpm build
```

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1`。
- 进入 `设置` -> `WebDAV 同步`。
- 页面显示 `检查远端备份` 和 `立即同步`。
- Web 预览下 `检查远端备份` 禁用，title 为 `需在桌面应用中检查`。
- 页面显示 `检查远端备份只读取 manifest 和文件摘要，不会覆盖本机设置、插件数据或剪贴板历史。`
- 页面不再显示 `未接入网络同步命令` 或 `真实上传/下载同步尚未接入`。
- 控制台无 error / warning；仅有浏览器对 password input 不在 form 内的 verbose 提示。

结果：

- `cargo test -p atools --test webdav_tests`：通过，4 passed。
- `cargo test -p atools --lib`：通过，31 passed。
- `cargo fmt --all --check`：通过。
- `pnpm test:webdav-sync-view`：通过。
- `pnpm test:settings-pages`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，173 modules transformed。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Tauri/Rust 桌面底座 | 96% | 96% | WebDAV 增加只读远端预览命令，底座完成度维持不变 |
| 设置项真实功能 | 99% | 99% | WebDAV 从上传校验推进到远端备份预览；恢复应用/冲突合并仍未做，暂不升 100% |
| ZTools 设置页 UI | 99% | 99% | WebDAV 状态页增加检查远端备份按钮和只读保护提示 |
| 测试与发布 | 99% | 99% | WebDAV Rust 集成测试扩展到 preview，前端状态模型测试同步扩展 |

当前重点剩余：

1. 内置程序体验：继续打磨插件市场禁用态/本地市场体验，或做 WebDAV 恢复应用前的确认和 diff 预览。
2. Agent/MCP：继续补 MCP 协议完整性、AI 配置接入真实 Agent 调用；客户端自动写入/合并配置需要单独确认流后再做。
3. 插件 tools 暴露和真实插件兼容按当前要求暂缓。
4. macOS 发布质量：签名、公证、自动更新仍未接入。

## 第六十八批：WebDAV 远端备份同步最小闭环

用户要求：插件不着急，先继续完善内置程序体验。本批聚焦设置页 `WebDAV 同步` 的真实能力，把“只保存配置、网络同步未接入”推进为桌面端可执行的远端备份上传和 manifest 读取校验。

状态：DONE。

修改文件：

- `src-tauri/src/webdav.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/tests/webdav_tests.rs`
- `src/lib/webdavSyncView.ts`
- `src/lib/types.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-webdav-sync-view.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 Rust WebDAV 同步模块：
  - 校验 http/https WebDAV URL、用户名和远端目录。
  - 按远端目录逐级发送 `MKCOL`。
  - 上传 `manifest.json`、`settings.json`、`plugin-data.json`、`clipboard-history.json` 中被勾选范围的文件。
  - 上传后读取远端 `manifest.json`，验证远端可读。
  - `MKCOL 405` 视作目录已存在，不误报失败。
- 设置同步 payload 会脱敏 `password`、`apiKey`、`token`、`secret` 等字段，避免把 AI Key / WebDAV 密码明文写入远端备份。
- 新增 Tauri command `sync_webdav_now`，由桌面端负责读取插件数据和剪贴板历史，并记录运行时事件。
- 设置页 `WebDAV 同步`：
  - 顶部说明改为真实上传和 manifest 校验。
  - Web 预览下 `立即同步` 保持禁用，并提示需在桌面应用中同步。
  - 桌面端配置完整且启用后可点击 `立即同步`。
  - 同步状态显示执行能力、上传文件数、远端 manifest 校验和耗时。
  - 配置或同步范围变更后清空上次同步摘要，避免展示旧结果。

TDD 记录：

- 先新增 `src-tauri/tests/webdav_tests.rs`，红灯为 `atools_lib::webdav` 模块不存在。
- 实现 Rust 模块后覆盖：
  - base URL + 远端目录拼接和路径 segment 编码。
  - 设置备份脱敏 AI Key / WebDAV 密码，并按同步范围生成文件。
  - 本地 HTTP 服务器捕获真实 `MKCOL`、`PUT`、`GET` 请求序列。
  - 上传请求带 Basic Auth。
  - 上传后远端 manifest 读取校验成功。
- 初次绿灯前修复两个根因：
  - base URL 末尾空 path segment 导致双斜杠，改为 `pop_if_empty()` 后再追加远端目录。
  - 测试按大小写精确匹配 `Authorization` 不符合 HTTP header 规则，改为大小写不敏感读取。
- 先新增 `scripts/test-webdav-sync-view.mjs`，红灯为 `src/lib/webdavSyncView.ts` 缺失。
- 实现前端视图模型后覆盖：
  - 浏览器预览、未启用、同步中、可同步四种按钮状态。
  - 同步状态行显示 `已接入 WebDAV 上传校验`、上传文件数、远端 manifest 和耗时。

验证：

```bash
cargo test -p atools --test webdav_tests
cargo test -p atools --lib
cargo fmt --all --check
pnpm test:webdav-sync-view
pnpm test:settings-pages
pnpm check
```

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1`。
- 进入 `设置` -> `WebDAV 同步`。
- 页面显示 `桌面端会将设置、插件数据和剪贴板历史按所选范围上传到 WebDAV，并读取远端 manifest 校验`。
- 页面显示 `执行能力 / 已接入 WebDAV 上传校验`。
- 页面不再显示 `未接入网络同步命令` 或 `真实上传/下载同步尚未接入`。
- Web 预览下 `立即同步` 按钮禁用，title 为 `需在桌面应用中同步`。
- 控制台无 error / warning；仅有浏览器对 password input 不在 form 内的 verbose 提示。

结果：

- `cargo test -p atools --test webdav_tests`：通过，3 passed。
- `cargo test -p atools --lib`：通过，31 passed。
- `cargo fmt --all --check`：通过。
- `pnpm test:webdav-sync-view`：通过。
- `pnpm test:settings-pages`：通过。
- `pnpm check`：0 errors / 0 warnings。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Tauri/Rust 桌面底座 | 95% | 96% | 新增真实 WebDAV 网络命令，覆盖 MKCOL/PUT/GET 和远端 manifest 校验 |
| 设置项真实功能 | 99% | 99% | WebDAV 从本地配置保存推进到远端备份上传；双向恢复/冲突合并仍未做，暂不升 100% |
| ZTools 设置页 UI | 99% | 99% | WebDAV 状态页不再展示未接入断点，增加上传/校验状态 |
| 测试与发布 | 99% | 99% | 新增 Rust WebDAV 集成测试和前端状态模型测试 |

当前重点剩余：

1. 内置程序体验：继续打磨插件市场禁用态/本地市场体验，或补 WebDAV 双向恢复/冲突合并前的确认流。
2. Agent/MCP：继续补 MCP 协议完整性、AI 配置接入真实 Agent 调用；客户端自动写入/合并配置需要单独确认流后再做。
3. 插件 tools 暴露和真实插件兼容按当前要求暂缓。
4. macOS 发布质量：签名、公证、自动更新仍未接入。

## 第六十七批：自定义应用快捷键运行时触发分发

用户要求：插件不着急，先继续完善内置程序体验。本批接上第六十六批的自定义应用快捷键编辑器，把已保存的应用快捷键接入主程序运行时触发分发，补齐“设置可配但不能执行”的断点。

状态：DONE。

修改文件：

- `src/lib/appShortcutRuntime.ts`
- `src/App.svelte`
- `src/lib/keyboardTarget.ts`
- `src/components/SearchBar.svelte`
- `src/lib/settingsPages.ts`
- `scripts/test-app-shortcuts.mjs`
- `scripts/test-keyboard-target.mjs`
- `scripts/test-settings-pages.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 `appShortcutTargetFromKeyboardEvent()` 运行时匹配模块。
- 自定义应用快捷键按启用状态、快捷键合法性、目标可用性和平台修饰键匹配。
- 重复快捷键不触发，避免多个目标同时命中。
- 设置页输入框、快捷键录制框等普通可编辑控件不会误触发应用快捷键。
- 主搜索框作为 uTools/ZTools 风格命令入口保留快捷键触发能力。
- `App.svelte` 在主搜索键盘处理里先分发自定义应用快捷键，再进入普通搜索导航逻辑。
- 触发后写入最近使用历史，并执行对应系统/本地/网页快开目标。
- 新增应用快捷键默认优先生成 `Command+Option+数字`，避开浏览器/系统常见 `Command+数字` 标签页冲突；Windows/Linux 对应 `Ctrl+Alt+数字`。

TDD 记录：

- 先新增 `scripts/test-app-shortcuts.mjs`，红灯为 `src/lib/appShortcutRuntime.ts` 缺失。
- 实现运行时匹配后覆盖：
  - 启用的 `Command+1` 可命中目标。
  - 不可用目标返回 `null`。
  - 停用快捷键返回 `null`。
  - 无修饰键/非法快捷键返回 `null`。
  - 普通可编辑控件内返回 `null`。
  - 重复启用快捷键返回 `null`。
  - Windows `Ctrl+Alt+K` 可命中。
- 先扩展 `scripts/test-keyboard-target.mjs`，红灯为 `isMainSearchKeyboardTarget is not a function`。
- 标记主搜索输入框后，主搜索框可触发自定义应用快捷键，普通输入框继续被保护。
- 先调整 `scripts/test-settings-pages.mjs` 期望默认生成 `Command+Option+2`，红灯为仍生成 `Command+1`；更新生成策略后转绿。

验证：

```bash
pnpm test:app-shortcuts
pnpm test:settings-pages
pnpm test:keyboard-target
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1`。
- 进入 `设置` -> `快捷键` -> `应用快捷键`。
- 删除旧自定义快捷键后点击 `添加快捷键`，默认生成 `Command+Option+1`。
- 关闭设置回到主搜索框。
- 按 `Meta+Alt+1` 后自动打开 `设置` 页面。
- DOM 可见 `通用设置`、`快捷键`、`呼出快捷键 Option+Z` 等设置页内容，说明运行时分发已触发目标。

结果：

- `pnpm test:app-shortcuts`：通过。
- `pnpm test:settings-pages`：通过。
- `pnpm test:keyboard-target`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，172 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，权限/数据/系统设置 smoke 均为 true。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 设置项真实功能 | 98% | 99% | 自定义应用快捷键从本地保存推进到运行时触发分发，主搜索框聚焦也可触发 |
| ZTools 设置页 UI | 99% | 99% | 设置页 UI 不变，但快捷键配置对应的真实行为闭环补齐 |
| ZTools/uTools 主搜索体验 | 99% | 99% | 主搜索框保留应用快捷键入口行为，更接近命令面板使用体验 |
| 测试与发布 | 99% | 99% | 新增运行时快捷键测试，并通过 check/build/desktop smoke |

当前重点剩余：

1. 内置程序体验：继续打磨 WebDAV 实际同步、插件市场禁用态。
2. Agent/MCP：继续补 MCP 协议完整性、AI 配置接入真实 Agent 调用；客户端自动写入/合并配置需要单独确认流后再做。
3. 插件 tools 暴露和真实插件兼容按当前要求暂缓。
4. macOS 发布质量：签名、公证、自动更新仍未接入。

## 第六十四批：MCP 客户端连接状态与 token 脱敏展示

用户要求：继续还原完成度，测试没问题后同步文档。本批继续完善内置 Agent/MCP 客户端配置体验，不做插件兼容。

状态：DONE。

修改文件：

- `src/lib/mcpClientConfig.ts`
- `src/components/AgentPanel.svelte`
- `src/components/SettingsPanel.svelte`
- `scripts/test-mcp-client-config.mjs`
- `docs/agent-mcp-client.md`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 MCP 连接视图模型：
  - `maskMcpToken()`：完整 token 不再直接显示在 UI。
  - `mcpConnectionView()`：统一输出服务状态、HTTP URL、脱敏 token、推荐连接方式和安全提示。
- Agent 面板 MCP 区域：
  - 增加状态行。
  - Token 改为脱敏展示。
  - 增加推荐连接方式和 token 安全提示。
  - 复制 HTTP/stdio/模板配置行为保持不变，复制的 HTTP 配置仍包含 Bearer token。
- 设置页 `MCP 服务`：
  - 使用同一连接视图模型。
  - Token 改为脱敏展示。
  - 增加推荐连接方式和 token 安全提示。
- 文档更新：
  - `docs/agent-mcp-client.md` 改为说明 UI 显示 masked token，复制配置仍带 Bearer token。
  - `macos-smoke-checklist` 增加脱敏 token 和推荐连接方式检查。

TDD 记录：

- 先扩展 `scripts/test-mcp-client-config.mjs`，要求：
  - `maskMcpToken("local-token")` 输出 `local-…oken`。
  - 短 token 输出 `••••`，空 token 输出 `未启动`。
  - `mcpConnectionView(status)` 在 HTTP ready 时输出 `运行中`、HTTP URL、脱敏 token、`http` 推荐传输和安全提示。
  - token 缺失时输出 `等待 token`、stdio 推荐传输和 fallback 安全提示。
  - status 为 null 时输出 `未启动` 和 stdio fallback。
- 初次运行红灯，原因是 `maskMcpToken` 不存在。
- 实现连接视图模型后目标测试转绿，再改 Agent 面板和设置页。

验证：

```bash
pnpm test:mcp-client-config
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1`。
- 进入 `设置` -> `MCP 服务`。
- DOM 可见：
  - `MCP 服务`
  - `Token`
  - token 安全提示：`HTTP MCP 未就绪；可复制 stdio proxy 配置。` 或 `Token 已隐藏；复制 HTTP 配置会包含 Bearer token。`
  - `推荐连接`
  - `stdio proxy` 或 `HTTP MCP`
- 预览态未出现 `local-token` 或 `Bearer local-token`。

结果：

- `pnpm test:mcp-client-config`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，171 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，权限/数据/系统设置 smoke 均为 true。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Agent/MCP 底座 | 90% | 91% | Agent 和设置页统一 MCP 连接状态，token 默认脱敏展示，复制配置仍可用 |
| 设置项真实功能 | 97% | 97% | 本批不新增设置命令，只改善 MCP 配置展示 |
| ZTools 设置页 UI | 99% | 99% | 本批只改 MCP 服务局部展示 |
| 测试与发布 | 99% | 99% | 扩展 MCP 客户端配置测试，并通过真实 desktop smoke |

当前重点剩余：

1. Agent/MCP：继续补 MCP 协议完整性、客户端配置一键写入、AI 配置接入真实 Agent 调用。
2. 插件 tools 暴露按当前要求暂缓。
3. macOS 发布质量：签名、公证、自动更新仍未接入。
4. 插件宿主/插件生态：bridge 高优 API 和真实兼容回归仍是后续缺口。

## 第六十三批：插件宿主壳层与 outPlugin 输出层收口

用户最新要求：继续还原完成度，插件不着急。本批不做真实第三方插件兼容回归，只处理内置插件运行壳层的标题栏、subInput、iframe/output 层级和 outPlugin payload 稳定性。

状态：DONE。

修改文件：

- `src/lib/pluginHostView.ts`
- `src/components/PluginPanel.svelte`
- `scripts/test-plugin-host-view.mjs`
- `package.json`
- `docs/ui-ztools-restore-checklist.md`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增插件宿主视图模型：
  - 标题栏 chrome：插件名、feature code、plugin id。
  - 宿主动作：`返回` 可用，`设置`/`分离` 明确禁用。
  - 布局槽：titlebar、subinput、body，subInput 显示时位置稳定。
  - body mode：loading/error/iframe/output。
  - 输出行：选中态和 `Enter 复制` 提示。
- 修复 outPlugin payload 归一化：
  - 支持 `outPlugin([{ title }])`。
  - 支持 uTools/ZTools 常见 `outPlugin({ items: [...] })`。
  - 兼容当前桥接可能传入的 `[{ items: [...] }]` 包裹形态。
  - 过滤无 title 的无效行，并把 data/description/icon 规范化成字符串。
- `PluginPanel` UI 接入视图模型：
  - 标题栏显示插件名、feature code、来源 plugin id。
  - `设置`/`分离` 按钮显示禁用态，不触发假功能。
  - output layer 使用独立 `.plugin-output-layer`，密集列表显示 `Enter 复制`。
  - iframe 使用 `plugin-iframe full-bleed`，body 区域 `min-height: 0`，避免和 subInput/output 挤压。
- `ui-ztools-restore-checklist` 中 `Plugin host` 已完成。
- `macos-smoke-checklist` 增加桌面端插件运行态回归项，并明确 Web 预览不搜索插件。

TDD 记录：

- 先新增 `scripts/test-plugin-host-view.mjs`，要求：
  - `normalizePluginOutputItems()` 能处理数组、`{ items: [...] }`、`[{ items: [...] }]`、空值和无效项。
  - `pluginHostView()` 输出标题栏、禁用动作、布局槽、output body mode、iframe/output class、选中行 `Enter 复制`。
  - iframe-only 和 error 状态分别返回正确 body mode。
- 初次运行红灯，原因是 `src/lib/pluginHostView.ts` 不存在。
- 实现视图模型后目标测试转绿；随后改造 `PluginPanel` 使用模型。

验证：

```bash
pnpm test:plugin-host-view
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1`。
- 尝试搜索 `timestamp`，Web 预览返回：
  - `没有找到本地匹配 “timestamp”`
  - `浏览器预览仅搜索系统命令、网页快开和本地启动；桌面应用会继续搜索插件`
- 因此 Browser 不能作为插件运行态证据；本批插件宿主行为由 `pnpm test:plugin-host-view`、`pnpm check`、`pnpm build` 和真实 `pnpm smoke:tauri-desktop` 覆盖，桌面端人工插件运行态 smoke 已写入 `macos-smoke-checklist`。

结果：

- `pnpm test:plugin-host-view`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，171 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，权限/数据/系统设置 smoke 均为 true。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件 iframe 宿主 | 30% | 36% | 宿主壳层、subInput/body 层级、outPlugin payload 归一化和输出层 UI 已收口；高优 bridge API 和真实兼容回归仍暂缓 |
| 插件安装/导入 | 46% | 46% | 本批不改导入 |
| ZTools/uTools 主搜索体验 | 99% | 99% | 本批不改主搜索 |
| ZTools 设置页 UI | 99% | 99% | 本批不改设置页 |
| 测试与发布 | 99% | 99% | 新增插件宿主视图模型测试，并通过真实 desktop smoke |

当前重点剩余：

1. 内置程序体验：继续收口设置页剩余真实功能或 Agent/MCP 客户端配置体验。
2. 插件宿主：dialog/shell/screen/clipboard/file/browser context、资源路径、生命周期、右键/复制/拖拽仍需专项实现。
3. macOS 发布质量：签名、公证、自动更新仍未接入。
4. 插件生态：真实 ZTools 插件目录扫描/导入后的兼容回归按用户当前要求暂缓。

## 第六十二批：导入面板预检统计与报告视图

用户最新要求：插件不着急，先继续完善内置程序体验。本批只完善内置导入面板的候选、预检、选择和报告 UI，不做真实 ZTools 插件兼容回归。

状态：DONE。

修改文件：

- `src/lib/ztoolsImportView.ts`
- `src/components/ZToolsImportPanel.svelte`
- `scripts/test-ztools-import-view.mjs`
- `package.json`
- `docs/ui-ztools-restore-checklist.md`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增导入面板视图模型：
  - 候选统计：候选、可导入、已选、警告、错误、feature 总数。
  - 候选行状态：`可导入`、`需注意`、`不可导入`。
  - 自动过滤不可导入项的 selected count，避免错误候选被误计入导入数量。
  - 报告行拆分：已导入、已跳过、导入失败。
- `ZToolsImportPanel` UI 改为消费视图模型：
  - 顶部按钮改为 `选择目录并扫描`。
  - 未扫描时显示 `等待扫描` 空态。
  - 扫描后显示统计 chip、状态胶囊、缺失标记、warnings/errors 和路径。
  - 增加 `全选可导入`、`清空选择`。
  - 导入报告显示成功/跳过/失败三类明细，失败项显示错误原因。
- `ui-ztools-restore-checklist` 中 `Import panel` 已完成。
- `macos-smoke-checklist` 补充导入面板空态、候选统计、不可导入禁用、报告明细回归项。

TDD 记录：

- 先新增 `scripts/test-ztools-import-view.mjs`，要求：
  - 3 个候选项分别覆盖 ready/warning/blocked。
  - summary 输出 total/selectable/selected/warning/blocked/features。
  - summary chips 顺序为候选、可导入、已选、警告、错误。
  - blocked 候选不可选，且不计入 selected。
  - report view 输出 imported/skipped/failed 三类明细。
- 初次运行红灯，原因是 `src/lib/ztoolsImportView.ts` 不存在。
- 实现视图模型后目标测试转绿；随后改造 Svelte UI。

验证：

```bash
pnpm test:ztools-import-view
pnpm check
pnpm build
cargo test -p atools --test ztools_import_tests
pnpm smoke:tauri-desktop
```

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1`。
- 空搜索首页点击 `导入 ZTools 插件` 进入导入面板。
- DOM 可见：
  - `导入 ZTools 插件`
  - `选择目录并扫描`
  - `等待扫描`
  - `选择 ZTools 插件目录后，这里会显示可导入插件和预检结果。`
- 未扫描时 DOM 中候选统计、候选行、报告行数量均为 0，未触发目录选择或真实导入副作用。
- 候选/报告复杂状态由 `pnpm test:ztools-import-view` 覆盖；本批按用户要求不做真实插件目录兼容回归。

结果：

- `pnpm test:ztools-import-view`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，170 modules transformed。
- `cargo test -p atools --test ztools_import_tests`：3 passed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，权限/数据/系统设置 smoke 均为 true。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 插件安装/导入 | 43% | 46% | 导入面板预检统计、候选状态、选择数量和报告明细已成型；真实插件兼容回归仍暂缓 |
| ZTools/uTools 主搜索体验 | 99% | 99% | 本批不改主搜索 |
| ZTools 设置页 UI | 99% | 99% | 本批不改设置页 |
| 设置项真实功能 | 97% | 97% | 本批不新增设置命令 |
| 测试与发布 | 99% | 99% | 新增导入视图模型测试，并通过真实 desktop smoke |

当前重点剩余：

1. 内置程序体验：继续处理插件宿主容器的标题栏/subInput/iframe/output 层级，或继续收口设置页细节。
2. Agent/MCP：继续补 MCP 协议完整性和客户端配置体验；插件 tools 暴露按当前要求暂缓。
3. macOS 发布质量：签名、公证、自动更新仍未接入。
4. 插件生态：真实 ZTools 插件目录扫描/导入后的兼容回归按用户当前要求暂缓。

## 第六十一批：首页常用入口与空状态收口

用户最新要求：插件不着急，先继续完善内置程序体验。本批不推进插件兼容测试，只收口首页/空状态体验。

状态：DONE。

修改文件：

- `src/lib/homeSurface.ts`
- `src/components/HomePanel.svelte`
- `src/App.svelte`
- `scripts/test-home-surface.mjs`
- `package.json`
- `docs/ui-ztools-restore-checklist.md`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增首页固定入口模型：
  - `导入 ZTools 插件` -> `import`
  - `插件管理` -> `plugins`
  - `Agent / MCP` -> `agent`
  - `设置` -> `settings`
- `HomePanel` 在最近使用上方渲染一行紧凑入口：
  - 保持启动器/命令中心密度。
  - 不做营销 hero 或说明卡。
  - 点击只切换内置面板，不自动执行导入副作用。
- 增加首页窗口高度常量，避免常用入口加入后裁切最近使用。
- `ui-ztools-restore-checklist` 中 `Empty/home state` 已完成。
- `macos-smoke-checklist` 增加首页入口和导入面板切换回归项。

TDD 记录：

- 先新增 `scripts/test-home-surface.mjs`，要求：
  - `homeQuickActions()` 返回 4 个固定入口，顺序为导入、插件管理、Agent/MCP、设置。
  - 每个入口都有唯一 `home:` code、面板目标、推荐来源和非空 explain。
  - `homeSurfaceSections()` 在开启固定入口时先返回 `quick-actions`，再返回 `recent`。
- 初次运行红灯，原因是 `src/lib/homeSurface.ts` 不存在。
- 实现 `homeSurface.ts`、首页入口渲染和窗口高度调整后目标测试转绿。

验证：

```bash
pnpm test:home-surface
pnpm test:command-history
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 打开 `http://127.0.0.1:1420/?parity=1`。
- 空搜索首页 DOM 可见 4 个固定入口：
  - `导入 ZTools 插件`
  - `插件管理`
  - `Agent / MCP`
  - `设置`
- 首页仍显示 `最近使用`，且未出现 `AI-native`、`开源`、`轻量`、`产品定位`、`本地优先` 等营销说明文案。
- 点击 `导入 ZTools 插件` 后进入导入面板，DOM 可见 `选择目录` 和 `扫描`，未自动执行导入。
- 浏览器 Playwright locator 点击在本地 Browser runtime 中出现交互等待超时；诊断确认按钮存在、未禁用、无遮挡，改用坐标点击验证实际 UI 行为通过，判断为自动化点击等待限制，不是应用 UI 阻塞。

结果：

- `pnpm test:home-surface`：通过。
- `pnpm test:command-history`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，169 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，权限/数据/系统设置 smoke 均为 true。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 99% | 99% | 首页空状态固定入口完成，导入入口可见且可切到导入面板 |
| ZTools 设置页 UI | 99% | 99% | 本批不改设置页 |
| 设置项真实功能 | 97% | 97% | 本批只接内置面板入口，不新增设置命令 |
| 插件安装/导入 | 43% | 43% | 仅补入口和面板跳转，不推进导入兼容测试 |
| 测试与发布 | 99% | 99% | 增加首页模型测试，并通过真实 desktop smoke |

当前重点剩余：

1. 内置程序体验：继续收口设置页细节、命令面板焦点/尺寸边界、导入面板的非插件兼容 UI 状态。
2. Agent/MCP：继续补 MCP 协议完整性和客户端配置体验；插件 tools 暴露按当前要求暂缓。
3. macOS 发布质量：签名、公证、自动更新仍未接入。
4. 插件生态：用户当前要求暂缓，后续再测 ZTools 插件实际兼容。

## 第六十批：主搜索结果行展示与键盘提示

用户要求：继续还原完成度，插件不着急，先完善内置程序体验。本批聚焦 UI 还原清单中的 `Search results: dense rows, keyboard selection visible, source metadata readable`，把结果行展示从“标题/说明 + 简单 chip”推进为更接近 ZTools/uTools 的可读来源元信息和选中行键盘提示。

状态：DONE。

修改文件：

- `src/lib/resultPresentation.ts`
- `src/components/ResultsList.svelte`
- `src/App.svelte`
- `scripts/test-result-presentation.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增结果展示纯模型：
  - `groupedResultPresentation()`：按 `system:`、`local-app:`、`web:`、`history:`、`alias:` 等来源生成稳定分组。
  - `resultSourceLabel()` / `resultSourceDetail()`：让来源不只显示插件名，也显示 `system · ATools`、`local · 本地启动`、`local-app · 本地应用` 这类可读 detail。
  - `resultRowPresentation()`：统一生成来源标签、匹配标签、选中行键盘提示和 aria label。
- 结果列表 UI 对齐：
  - 结果行右侧改为来源 chip + 来源 detail + 匹配 chip。
  - 当前选中行显示真实可用的 `Enter 执行` 提示。
  - ArrowDown 移动选中项后，`Enter 执行` 提示跟随移动。
  - 行高从 50 调整到 54，并同步窗口高度计算，保持密集但不挤压文本。

TDD 红灯：

- `node scripts/test-result-presentation.mjs` 初次失败：`src/lib/resultPresentation.ts` 不存在。

验证：

```bash
pnpm test:result-presentation
pnpm test:result-icons
pnpm test:match-type-meta
pnpm test:search-behavior
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 使用内置浏览器打开 `http://127.0.0.1:1420/?parity=1`。
- 在搜索框输入 `set` 后，页面显示 `系统命令` 和 `本地启动` 分组。
- 结果行可见标题、说明、来源 detail 和匹配标签，例如 `system · ATools`、`local · 本地启动`、`别名`、`模糊`。
- 当前选中行可见 `Enter 执行`；按 `ArrowDown` 后，提示从 `设置` 移动到 `打开 桌面`。

结果：

- `pnpm test:result-presentation`：通过。
- `pnpm test:result-icons`：通过。
- `pnpm test:match-type-meta`：通过。
- `pnpm test:search-behavior`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，168 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`permission_smoke`、`data_debug_smoke`、`system_settings_smoke` 均为 true。
- 浏览器 DOM 验证通过。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools/uTools 主搜索体验 | 99% | 99% | 搜索结果行补齐来源 detail、匹配标签和选中行 Enter 提示，UI 还原清单该项已关闭 |
| ZTools 设置页 UI | 99% | 99% | 本批不改设置页 |
| 测试与发布 | 99% | 99% | 新增 result-presentation 测试并通过构建 |
| 插件相关 | 不变 | 不变 | 按用户要求，本批不进入插件兼容测试 |

当前重点剩余：

1. 内置程序体验：继续处理空首页/import 入口是否保留的问题，或转向 WebDAV/AI 配置真实能力。
2. 设置真实功能：自定义全局/应用快捷键编辑器、WebDAV 实际同步、AI 配置接入真实 Agent 调用仍未完成。
3. macOS 发布质量：签名、公证、自动更新仍未完成。
4. 插件生态：按当前优先级暂缓，后续再做插件指令禁用/固定/匹配指令与 bridge/API 兼容回归。

## 第五十九批：所有指令页来源分组与指令中心

用户要求：继续还原完成度，插件不着急，先完善内置程序体验。本批参考 ZTools `AllCommandsSetting` 的信息架构，把 ATools 的 `所有指令` 从“别名配置页”推进为内置来源的指令中心：先覆盖系统指令、本地启动、网页快开，插件指令禁用/固定/匹配指令留到插件接入后回归。

状态：DONE。

修改文件：

- `src/lib/settingsPages.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-settings-pages.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增所有指令页共享模型：
  - `commandCenterOverview()`：统计可绑定目标、启用目标、别名数、启用别名数和来源分组。
  - `commandCenterRows()`：按来源、启用状态、搜索关键字过滤系统/本地/网页目标。
  - `commandCenterSourceForCode()`：按 `system:`、`local:`、`web:` 等 code 前缀归类来源。
- `所有指令` UI 重构：
  - 顶部新增统计卡：可绑定指令、指令别名、来源分组。
  - 左侧新增来源列表：全部来源、系统指令、本地启动、网页快开。
  - 右侧新增搜索框、状态筛选和密集目标列表，展示名称、说明、code、启用状态、别名数量和 `别名` 操作入口。
  - 下方保留真实别名管理：添加、清空、启停、删除和目标选择。
- 边界处理：
  - 仍不伪造插件指令的禁用/固定/匹配指令管理。
  - 本地启动/网页快开的启用状态会进入所有指令页状态筛选。

TDD 红灯：

- `pnpm test:settings-pages` 初次失败：`commandCenterOverview is not a function`。

验证：

```bash
pnpm test:settings-pages
pnpm test:command-aliases
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 使用内置浏览器打开 `http://127.0.0.1:1420/?parity=1` 并进入设置页 `所有指令`。
- 页面可见三个统计卡：`可绑定指令`、`指令别名`、`来源分组`。
- 来源列表可见 `全部来源`、`系统指令`、`本地启动`、`网页快开`。
- 默认列表可见系统、本地、网页三类目标行，每行包含启用状态、说明、code、别名数量和 `别名` 按钮。
- 点击 `网页快开` 来源后，右侧只显示 `GitHub`、`Google`、`NPM` 三个网页快开目标。
- 搜索框输入自动化仍受当前内置浏览器 virtual clipboard 限制；搜索/别名命中行为由 `commandCenterRows()` 纯模型测试覆盖。

结果：

- `pnpm test:settings-pages`：通过。
- `pnpm test:command-aliases`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，167 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`permission_smoke`、`data_debug_smoke`、`system_settings_smoke` 均为 true。
- 浏览器 DOM 验证通过。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 99% | 99% | `所有指令` 页从别名配置页升级为内置来源指令中心，信息层级更接近 ZTools |
| 设置项真实功能 | 96% | 97% | 所有指令页新增来源筛选、状态筛选、目标搜索和按目标添加别名入口 |
| 测试与发布 | 99% | 99% | 扩展 settings-pages 测试并通过构建 |
| 插件相关 | 不变 | 不变 | 按用户要求，本批不进入插件指令接入测试 |

当前重点剩余：

1. 内置程序体验：继续打磨主搜索极端结果量下的视觉/滚动细节，或进一步补 `我的数据` / `WebDAV 同步` 的真实操作状态。
2. 设置真实功能：自定义全局/应用快捷键编辑器、WebDAV 实际同步、AI 配置接入真实 Agent 调用仍未完成。
3. macOS 发布质量：签名、公证、自动更新仍未完成。
4. 插件生态：按当前优先级暂缓，后续再做插件指令禁用/固定/匹配指令与 bridge/API 兼容回归。

## 第五十八批：快捷键页三段式体验对齐

用户要求：继续还原完成度，插件不着急，先完善内置程序体验。本批聚焦 ZTools 设置源码里的 `ShortcutsSetting`，把 ATools 的 `快捷键` 独立页从简短说明页推进到接近 ZTools 的三段式信息结构。

状态：DONE。

修改文件：

- `src/lib/settingsPages.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-settings-pages.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 快捷键页共享模型增强：
  - 新增 `shortcutTabs()`：`全局快捷键`、`应用快捷键`、`指令别名`。
  - 新增 `builtInAppShortcutsForPlatform()`：按 macOS/Windows 生成内置应用快捷键列表。
  - 新增 `shortcutPageOverview()`：统一生成呼出快捷键、应用快捷键、指令别名概览和空状态文案。
- 快捷键页 UI 对齐：
  - 顶部新增 ZTools 风格三段 tab。
  - 新增概览卡：呼出快捷键、应用快捷键、指令别名。
  - `全局快捷键` tab 保留真实可用的呼出快捷键录制和保存状态，明确自定义全局快捷键首版未接入。
  - `应用快捷键` tab 展示 8 个内置快捷键：`Command+D`、`Command+F`、`Tab`、`Command+,`、`Command+Q`、`Command+W`、`Option+Command+I`、`Space`。
  - `Space` 和 `Tab` 继续接入真实设置项，列表文案随设置变化。
  - `指令别名` tab 复用现有本地别名存储，支持添加映射、清空、启停和删除。
  - `添加快捷键` 保持禁用，不做假自定义快捷键编辑器。

TDD 红灯：

- `pnpm test:settings-pages` 初次失败：`shortcutTabs is not a function`。

验证：

```bash
pnpm test:settings-pages
pnpm test:command-aliases
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 使用内置浏览器打开 `http://127.0.0.1:1420/?parity=1` 并进入设置页。
- `快捷键` 页可见三段 tab：`全局快捷键`、`应用快捷键`、`指令别名`。
- `全局快捷键` tab 可见呼出快捷键和“暂无自定义全局快捷键”空状态。
- `应用快捷键` tab 可见 `8 个内置`、Space/Tab 设置，以及 8 个内置快捷键行。
- `指令别名` tab 可见 `添加映射`、`清空别名` 和空状态，未伪造插件快捷键功能。

结果：

- `pnpm test:settings-pages`：通过。
- `pnpm test:command-aliases`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，167 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，`permission_smoke`、`data_debug_smoke`、`system_settings_smoke` 均为 true。
- 浏览器 DOM 验证通过。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 98% | 99% | `快捷键` 页从简短说明升级为全局/应用/别名三段式结构，信息层级更接近 ZTools |
| 设置项真实功能 | 95% | 96% | `快捷键` 页直接承载 Space/Tab 行为设置和真实指令别名管理 |
| 测试与发布 | 99% | 99% | 扩展 settings-pages 测试并通过构建 |
| 插件相关 | 不变 | 不变 | 按用户要求，本批不进入插件接入测试 |

当前重点剩余：

1. 内置程序体验：继续细化 `所有指令` 页的信息密度和系统命令/本地启动/网页快开的来源分组。
2. 设置真实功能：自定义全局/应用快捷键编辑器如果要接入，需要独立后端注册/冲突/审计策略。
3. macOS 发布质量：签名、公证、自动更新仍未完成。
4. 插件生态：按当前优先级暂缓，后续再做 bridge/API 兼容回归。

## 第五十七批：设置页导航与内置体验补齐

用户要求：插件不着急，先继续完善内置程序体验。本批参考 ZTools 设置源码的路由和通用设置交互，把 ATools 设置页继续向 ZTools 主程序体验靠齐，不进入插件接入测试。

状态：DONE。

修改文件：

- `src/lib/settingsPages.ts`
- `src/components/SettingsPanel.svelte`
- `src-tauri/src/commands.rs`
- `src-tauri/src/lib.rs`
- `scripts/test-settings-pages.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/ui-ztools-restore-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增设置页共享模型 `settingsPages.ts`：
  - 菜单顺序对齐 ZTools 源码，补上 `HTTP 服务` 和 `关于`。
  - 抽出 macOS/Windows 默认快捷键和快捷键预设。
  - 抽出首版暂缓能力状态，避免 UI 继续散落硬编码。
  - 抽出 HTTP 服务状态和关于页产品事实，明确传统 HTTP API 未接入、推荐走 MCP。
- 设置页 UI 对齐：
  - 左侧菜单新增 `HTTP 服务`、`关于`。
  - 设置项行距从偏紧的表格感调整为更接近 ZTools 的宽松桌面设置页。
  - 通用页新增 `首版暂缓能力` 汇总，集中展示超级面板、悬浮球、代理、自定义市场、DevTools 位置、GPU 启动参数的未接入状态。
  - `HTTP 服务` 页不做假开关，说明 ATools 首版以 MCP 作为本地自动化入口。
  - `关于` 页展示 ATools 3.0、Tauri + Rust、本地 MCP、HTML/JS 插件 UI 和运行信息。
- 快捷键体验：
  - 呼出快捷键输入框继续负责录制。
  - 齿轮按钮改为 ZTools 风格快捷设置，下拉显示默认、`Command+Space`、`Control+Space` 和重置。
  - 预设仍走原有 `validateShortcut` 和保存链路；冲突组合不会静默保存。
- 外观体验：
  - `customColor` 从设置数据接入 UI。
  - 选择 `自定义` 主题色后显示真实颜色选择器，颜色跟随 settings 持久化，不再固定使用默认桃粉。
- 唤醒黑名单：
  - 通用页新增 `添加当前窗口` 按钮。
  - Rust 新增只读命令 `read_frontmost_app_name`，macOS 通过 `System Events` 读取当前前台应用名。
  - Web 预览模式按钮禁用并给出“需在桌面应用中使用”的提示。

TDD 红灯：

- `pnpm test:settings-pages` 初次失败：`src/lib/settingsPages.ts` 不存在。
- `cargo test -p atools settings_command_tests::apple_scripts_cover_browser_and_finder_context` 初次失败：缺少 `macos_frontmost_app_name_script`。

验证：

```bash
pnpm test:settings-pages
pnpm test:settings-normalization
cargo test -p atools settings_command_tests
cargo fmt --check
pnpm check
pnpm build
cargo test -p atools --lib
pnpm smoke:tauri-desktop
```

浏览器验证：

- 使用独立 Playwright 打开 `http://127.0.0.1:1420/?parity=1`。
- 设置页左侧菜单可见 `HTTP 服务` 和 `关于`。
- `HTTP 服务` 页可切换，显示 `传统 HTTP API` 未接入，并推荐 `MCP 服务`。
- `关于` 页可切换，显示 `ATools 3.0`、`Tauri + Rust`、本地 MCP、HTML/JS 插件 UI 和运行信息。
- 通用页快捷键齿轮下拉可见默认、`Command+Space`、`Control+Space` 和重置项。

结果：

- `pnpm test:settings-pages`：通过。
- `pnpm test:settings-normalization`：通过。
- `cargo test -p atools settings_command_tests`：6 passed。
- `cargo fmt --check`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，167 modules transformed。
- `cargo test -p atools --lib`：31 passed。
- `pnpm smoke:tauri-desktop`：通过，`settings_window=true`，`mcp_ready=true`，权限/数据/系统设置 smoke 均为 true。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 97% | 98% | 菜单补齐 `HTTP 服务` / `关于`，快捷键预设、自定义色和暂缓能力状态更接近 ZTools 设置体验 |
| 设置项真实功能 | 94% | 95% | 自定义主题色进入 UI 持久化；唤醒黑名单新增“添加当前窗口”只读命令 |
| Tauri/Rust 桌面底座 | 94% | 95% | 新增 macOS 前台应用读取 command，支撑设置页真实交互 |
| 测试与发布 | 99% | 99% | 增加 settings-pages 测试和 Rust 命令测试 |
| 插件相关 | 43% / 30% | 不变 | 按用户要求，本批不进入插件接入测试 |

当前重点剩余：

1. 内置程序体验：继续按 ZTools 细化 `快捷键` 独立页的全局/应用快捷键管理、所有指令页的信息密度和主搜索极端结果量性能。
2. 设置真实功能：WebDAV 真实同步、传统 HTTP API 是否保留、超级面板/悬浮球/代理/DevTools 位置仍需单独决策。
3. macOS 发布质量：签名、公证、自动更新仍未完成。
4. 插件生态：按当前优先级暂缓，后续再做 bridge/API 兼容回归。

## 第五十六批：compress_images 质量目标压缩

用户要求：继续还原完成度，插件不着急，优先完善内置程序体验。本批聚焦内置 Agent 工具 `compress_images`，把“每张小于 500KB”这类本地图片压缩场景从只 resize 推进到支持 `max_bytes` best-effort 质量目标。

状态：DONE。

修改文件：

- `src-tauri/src/agent_tools.rs`
- `src-tauri/tests/agent_tools_tests.rs`
- `src/lib/auditView.ts`
- `scripts/test-audit-view.mjs`
- `resources/skills/image-batch-compress/SKILL.md`
- `docs/agent-mcp-client.md`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `compress_images` 新增输入参数 `max_bytes`：
  - 未传时保持原有行为。
  - 传入后返回 `target_size`、`target_met`、`target_reason`、`compression_ratio`。
  - 输出已在目标内时 `target_met=true`。
  - 目标无法达成时不假装成功，单项 `status=target_unmet`，并给出未达标原因。
- macOS 下新增 best-effort 质量迭代：
  - 在原有 `sips --resampleWidth` 后，如果仍超过 `max_bytes`，尝试用 `sips -s format jpeg -s formatOptions` 降低质量。
  - 只保留最小有效候选；未达标时保留最小输出并明确 `target_reason`。
- MCP tool schema 更新：
  - input schema 增加 `max_bytes`。
  - output schema 增加目标尺寸和压缩比字段。
- 审计视图增强：
  - `target_unmet` 在 `副作用 diff` 中显示为 error tone。
  - 摘要显示 `未达标 n 项本地副作用`。
  - 图片大小详情追加 `目标 xxx 未达标`。
- `image-batch-compress` skill 更新：
  - 指导 Agent 在用户要求体积上限时传 `max_bytes`。
  - 明确 WebP 输出仍未接入。

TDD 记录：

- 先扩展 `src-tauri/tests/agent_tools_tests.rs`：
  - `compress_images_reports_met_size_target` 要求达标输出包含目标字段和压缩比。
  - `compress_images_reports_unmet_size_target_without_claiming_success` 要求极小目标返回 `target_unmet`，且不假装成功。
- 初次运行 `cargo test -p atools --test agent_tools_tests compress_images` 红灯：
  - `target_size` 为 `Null`。
  - 未达标时 `status` 仍为 `compressed`。
- 实现质量目标逻辑后压缩测试转绿。
- 再扩展 `scripts/test-audit-view.mjs`：
  - 要求 `target_unmet` 审计 diff 显示 `未达标` 摘要、error tone 和目标未达标详情。
- 初次运行 `pnpm test:audit-view` 红灯：
  - 审计仍显示 `已执行 1 项本地副作用`。
- 更新 `auditView.ts` 后目标测试转绿。

验证：

```bash
cargo fmt --check
cargo test -p atools --test agent_tools_tests compress_images
cargo test -p atools --test agent_tools_tests
cargo test -p atools --lib agent_tools
pnpm test:audit-view
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

结果：

- `cargo fmt --check`：通过。
- `cargo test -p atools --test agent_tools_tests compress_images`：4 passed。
- `cargo test -p atools --test agent_tools_tests`：21 passed。
- `cargo test -p atools --lib agent_tools`：通过，0 个匹配测试但 crate 编译通过。
- `pnpm test:audit-view`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，166 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，`permission_smoke`、`data_debug_smoke`、`system_settings_smoke` 均为 true。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| 内置 Agent 工具 | 70% | 73% | `compress_images` 支持 `max_bytes` 质量目标、达标状态和未达标原因 |
| 权限与审计 | 93% | 93% | 审计 diff 能识别压缩未达标，但权限链路不变 |
| Agent/MCP 底座 | 90% | 90% | tool schema 更新，MCP 协议本身不变 |
| 测试与发布 | 99% | 99% | 新增压缩目标和审计 diff 测试，并通过真实 desktop smoke |

当前重点剩余：

1. 内置 Agent 工具：WebP 输出仍未接入；OCR 仍依赖本地服务；文件搜索索引化/忽略规则仍可增强。
2. Agent/MCP：继续补 MCP 协议完整性、客户端一键写入配置；插件 tools 暴露按当前要求暂缓。
3. 内置程序体验：继续打磨设置页 ZTools 细节、数据页筛选/空状态和调试视图可读性。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## 第五十五批：调试日志脱敏诊断包

用户要求：插件不着急，先继续完善内置程序体验。本批聚焦设置页 `调试日志` 的复制体验，把原先直接复制完整 `settings` 的调试信息改成可对外发送的脱敏诊断包。

状态：DONE。

修改文件：

- `src/lib/debugDiagnostics.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-debug-diagnostics.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 `buildDiagnosticBundle()` / `diagnosticBundleText()`：
  - 汇总运行时、MCP bind、主进程事件计数、本地配置计数、审计状态计数、剪贴板历史数量、插件数据摘要和崩溃日志摘要。
  - 诊断包固定 `kind=atools_diagnostic_bundle`，便于后续用户反馈或 issue 模板识别。
  - 输出 `warnings`，覆盖 Tauri 未连接、MCP 未启动、主进程错误事件、审计拒绝/失败、崩溃日志等高价值排查信号。
- 敏感信息脱敏：
  - MCP token 不进入诊断包。
  - `aiApiKey` 输出为 `<redacted>`。
  - `webdavPassword` 输出为 `<redacted>`。
- 设置页 `调试日志`：
  - `复制信息` 改为复制脱敏诊断包。
  - 状态提示改为 `已复制脱敏诊断包`。
  - 调试页保存完整拉取的最近审计记录，用于诊断包统计；页面仍只展示最近错误摘要。

TDD 记录：

- 先扩展 `scripts/test-debug-diagnostics.mjs`，要求：
  - 诊断包包含 runtime/MCP、本地数据、审计、崩溃日志和 warnings。
  - 诊断包统计 aliases、clipboard history、plugin data、audit denied/error、crash log。
  - 诊断包文本不包含 `secret-token`、`sk-secret-key`、`dav-secret`。
- 初次运行 `pnpm test:debug-diagnostics` 红灯，原因是 `buildDiagnosticBundle()` 尚未实现。
- 实现诊断包模型和脱敏逻辑后目标测试转绿。

验证：

```bash
pnpm test:debug-diagnostics
pnpm test:audit-view
pnpm test:settings-normalization
pnpm test:tauri-desktop-smoke-script
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 使用 browser automation 打开 `http://127.0.0.1:1420/?parity=1`。
- 通过 DOM CUA 点击 `设置` -> `调试日志`。
- 页面可见 `调试日志`、`复制信息`、`桌面运行状态`、`本地配置状态`、`MCP 状态`、`崩溃日志`、`最近审计错误`。
- Web 预览下显示 `浏览器预览模式，无法读取 Tauri MCP 状态和审计记录`。
- 控制台 warn/error 为 0。
- 为避免覆盖用户系统剪贴板，浏览器 smoke 未实际点击 `复制信息`；脱敏内容由 `pnpm test:debug-diagnostics` 覆盖。

结果：

- `pnpm test:debug-diagnostics`：通过。
- `pnpm test:audit-view`：通过。
- `pnpm test:settings-normalization`：通过。
- `pnpm test:tauri-desktop-smoke-script`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，166 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，插件数 18，`permission_smoke`、`data_debug_smoke`、`system_settings_smoke` 均为 true。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 96% | 97% | 调试日志复制体验从原始信息升级为 ZTools 风格可反馈诊断包 |
| 设置项真实功能 | 93% | 94% | 调试信息导出进入脱敏、可审计的本地诊断链路 |
| Tauri/Rust 桌面底座 | 94% | 94% | 本批不改 Rust 主进程 |
| Agent/MCP 底座 | 90% | 90% | 诊断包展示 MCP 状态但不改 MCP 协议 |
| 权限与审计 | 93% | 93% | 诊断包统计审计状态，权限执行链路不变 |
| 测试与发布 | 99% | 99% | 新增诊断包模型测试，并通过真实 desktop smoke |

当前重点剩余：

1. 内置程序体验：继续打磨设置页 ZTools 细节、数据页筛选/空状态和调试视图可读性。
2. WebDAV：真实上传/下载、冲突处理、敏感字段更安全的存储策略仍未接入。
3. Agent/MCP：继续补 MCP 协议完整性、客户端一键写入配置；插件 tools 暴露按当前要求暂缓。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## 第五十一批：插件市场状态页

用户要求：插件不着急，先继续完善内置程序体验。本批聚焦设置页 `插件市场`，把旧 placeholder 改成明确的状态页：网络市场未接入，本地已有能力可用，远程搜索/下载/更新暂缓。

状态：DONE。

修改文件：

- `src/lib/pluginMarketStatus.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-plugin-market-status.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 `pluginMarketStatus()` 状态模型：
  - `state=disabled`
  - `label=未接入`
  - `networkMarketAvailable=false`
  - 本地可用能力：内置插件、本地导入、启停管理、插件数据导出。
  - 暂缓远程能力：分类浏览、市场搜索、下载/更新、远程评分。
- 设置页 `插件市场` 从通用 placeholder 拆为专门页面：
  - 顶部显示 `未接入` 状态。
  - 明确提示 `插件市场网络下载尚未接入`。
  - 显示网络市场状态、已安装插件数量和推荐入口。
  - `打开市场` 按钮禁用，避免假入口。
  - `刷新插件` 按钮可读取桌面端 `list_plugins`，用于显示已安装插件数量。
- Web 预览模式下明确提示插件数量需在桌面应用中查看。

TDD 记录：

- 先新增 `scripts/test-plugin-market-status.mjs`：
  - 要求桌面端状态为 `disabled / 未接入`。
  - 要求远程市场能力全部 `available=false`。
  - 要求本地能力按可用状态返回。
  - 要求 Web 预览模式下插件数据导出不可用，并提示需在桌面应用中查看。
- 初次运行红灯，原因是 `src/lib/pluginMarketStatus.ts` 不存在。
- 实现状态模型后目标测试转绿。

验证：

```bash
pnpm test:plugin-market-status
pnpm test:settings-normalization
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 使用 browser automation 打开 `http://127.0.0.1:1420/?parity=1`。
- 进入 `设置` -> `插件市场`。
- DOM 可见 `插件市场`、`未接入`、`插件市场网络下载尚未接入`、`网络市场`、`本地可用能力`、`内置插件`、`本地导入`、`启停管理`、`插件数据导出`、`暂缓接入`、`分类浏览`、`市场搜索`、`下载/更新`、`远程评分`、`打开市场`。
- `打开市场` 为 disabled，`刷新插件` 非 disabled。
- 旧 placeholder 文案 `显示下载进度，支持取消和重试` 不再出现在页面中。
- console warn/error 为 0。

结果：

- `pnpm test:plugin-market-status`：通过。
- `pnpm test:settings-normalization`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，165 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，插件数 18，权限/数据/系统设置 smoke 均为 true。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 93% | 94% | `插件市场` 从旧 placeholder 变成明确状态页，避免网络市场假入口 |
| 设置项真实功能 | 92% | 92% | 本批只读取已安装插件数量，不接入市场下载/更新 |
| 插件安装/导入 | 38% | 38% | 本地导入能力不在本批扩展，插件市场网络能力仍暂缓 |
| Agent/MCP 底座 | 90% | 90% | 本批不改 MCP/Agent |
| 权限与审计 | 93% | 93% | 本批不改权限审计 |
| 测试与发布 | 99% | 99% | 新增插件市场状态模型测试，并通过真实 desktop smoke |

当前重点剩余：

1. 内置程序体验：继续打磨设置页细节空状态和主程序微交互。
2. 插件市场：真实网络市场、下载/更新、评分/详情、签名校验仍未接入。
3. Agent/MCP：继续补 MCP 协议完整性、客户端一键写入配置；插件 tools 暴露按当前要求暂缓。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## 第五十四批：已安装插件筛选

用户要求：继续还原完成度，完成一大项后同步文档和完成度。本批继续打磨 `已安装插件` 管理体验，增加关键词、启用状态和来源筛选，解决插件数量增长后无法快速定位的问题。

状态：DONE。

修改文件：

- `src/lib/pluginInventory.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-plugin-inventory.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `pluginInventory()` 新增筛选参数：
  - `query`：按插件 id、名称、版本、描述、路径、来源、feature 预览和全部 feature 明细搜索。
  - `status`：`all` / `enabled` / `disabled`。
  - `source`：`all` / `builtin` / `imported`。
- 新增 `filteredSummary`：
  - 显示筛选后的总数、启用/停用数量和 feature 数。
  - 原 `summary` 保留为全量统计。
- 筛选无结果时显示专门空态：
  - `没有匹配的插件，调整筛选条件后重试。`
- 设置页 `已安装插件` 新增控件：
  - `筛选已安装插件` 输入框。
  - `插件启用状态筛选` 下拉。
  - `插件来源筛选` 下拉。
  - 列表标题显示 `n 个匹配`。
  - 顶部统计显示筛选数 / 总数。

TDD 记录：

- 先扩展 `scripts/test-plugin-inventory.mjs`：
  - `query=schema` 应命中 JSON 插件，即使 `schema` 不在前三个 feature 预览中。
  - `status=disabled` 只返回停用插件。
  - `source=imported` 只返回导入插件。
  - 无匹配时 rows 为空、`selectedPlugin=null`，且空态为筛选专用文案。
- 初次运行红灯，原因是 `filteredSummary` 和筛选逻辑未实现。
- 首次实现后 `query=schema` 仍失败，暴露只搜索前三个 feature 预览的问题。
- 补全 row 的 `searchText`，覆盖全部 feature code/label/explain 后目标测试转绿。

验证：

```bash
pnpm test:plugin-inventory
pnpm test:plugin-market-status
pnpm test:settings-normalization
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 使用 browser automation 打开 `http://127.0.0.1:1420/?parity=1`。
- 进入 `设置` -> `已安装插件`。
- DOM 可见 `筛选插件`、`按名称、feature、描述、路径或来源快速定位`、`搜索插件、feature、路径`、`显示范围`、`全部状态`、`只看启用`、`只看停用`、`全部来源`、`内置`、`导入`、`个匹配`。
- `筛选已安装插件` 输入框存在。
- `插件启用状态筛选` 和 `插件来源筛选` 存在，默认值均为 `all`。
- 旧 placeholder 文案 `通过插件包安装第三方插件` 不再出现。
- console warn/error 为 0。

结果：

- `pnpm test:plugin-inventory`：通过。
- `pnpm test:plugin-market-status`：通过。
- `pnpm test:settings-normalization`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，166 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，插件数 18，权限/数据/系统设置 smoke 均为 true。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 96% | 96% | 本批属于已安装插件页体验细化，不单独推高整体设置页完成度 |
| 设置项真实功能 | 93% | 93% | 本批不新增副作用功能 |
| 插件安装/导入 | 42% | 43% | 插件管理页支持关键词、状态和来源筛选，管理体验更接近日用 |
| Agent/MCP 底座 | 90% | 90% | 本批不改 MCP/Agent |
| 权限与审计 | 93% | 93% | 本批不改权限审计 |
| 测试与发布 | 99% | 99% | 扩展插件清单模型测试，并通过真实 desktop smoke |

当前重点剩余：

1. 内置程序体验：继续打磨主搜索和设置页微交互，避免布局和文案上的 ZTools 差距。
2. 插件管理：卸载、更新、插件权限仍未接入；本地副作用入口需要权限/确认设计。
3. Agent/MCP：继续补 MCP 协议完整性、客户端一键写入配置；插件 tools 暴露按当前要求暂缓。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## 第五十三批：已安装插件详情区

用户要求：继续还原完成度，插件不着急但内置程序体验要继续完善。本批在 `已安装插件` 页上补选中插件后的详情区，使设置页更接近 ZTools/uTools 的管理体验；仍不触发卸载、更新、权限等高风险/未完成操作。

状态：DONE。

修改文件：

- `src/lib/pluginInventory.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-plugin-inventory.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `pluginInventory()` 支持 `selectedPluginId`：
  - 命中时返回对应 `selectedPlugin`。
  - 未命中时回退到排序后的第一个插件。
  - 空列表时 `selectedPlugin=null`。
- 新增插件详情模型：
  - 名称、状态、版本、来源、描述、路径、更新时间。
  - feature 明细：code、label、explain。
  - 操作边界：打开目录、更新插件、卸载插件、插件权限均标记未接入。
- 设置页 `已安装插件` 新增详情区：
  - 插件行有 `详情` 按钮用于切换选中插件。
  - `插件详情` 展示基础字段和 feature 明细。
  - 未接入操作显示为禁用按钮，不触发本地副作用。
  - Web 预览空列表显示 `选择一个插件查看详情`。

TDD 记录：

- 先扩展 `scripts/test-plugin-inventory.mjs`：
  - 要求 `selectedPluginId=z-user` 返回用户导入插件详情。
  - 要求 feature 明细结构完整。
  - 要求操作列表明确返回 `打开目录/更新插件/卸载插件/插件权限` 且全部 `available=false`。
  - 要求缺失 selection 回退到第一个启用插件。
  - 要求空列表 `selectedPlugin=null`。
- 初次运行红灯，原因是 `selectedPlugin` 未实现。
- 实现详情模型后目标测试转绿。

验证：

```bash
pnpm test:plugin-inventory
pnpm test:plugin-market-status
pnpm test:settings-normalization
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 使用 browser automation 打开 `http://127.0.0.1:1420/?parity=1`。
- 进入 `设置` -> `已安装插件`。
- Web 预览无 Tauri runtime，验证空态：
  - DOM 可见 `已安装插件`、`插件详情`、`选择一个插件查看详情`、`Tauri 运行时未连接`、`安装插件`。
  - `安装插件` disabled，`刷新` 非 disabled。
  - 旧 placeholder 文案 `通过插件包安装第三方插件` 不再出现。
  - console warn/error 为 0。
- 详情内容由 `pnpm test:plugin-inventory` 覆盖；桌面端插件存在性由 `pnpm smoke:tauri-desktop` 覆盖，当前插件数为 18。

结果：

- `pnpm test:plugin-inventory`：通过。
- `pnpm test:plugin-market-status`：通过。
- `pnpm test:settings-normalization`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，166 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，插件数 18，权限/数据/系统设置 smoke 均为 true。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 95% | 96% | `已安装插件` 补充详情区和 feature 明细，管理页完整度更接近 ZTools |
| 设置项真实功能 | 93% | 93% | 本批不新增副作用功能，继续只保留刷新/启停 |
| 插件安装/导入 | 40% | 42% | 插件详情查看进入设置页；更新/卸载/权限仍明确未接入 |
| Agent/MCP 底座 | 90% | 90% | 本批不改 MCP/Agent |
| 权限与审计 | 93% | 93% | 本批不改权限审计 |
| 测试与发布 | 99% | 99% | 扩展插件清单模型测试，并通过真实 desktop smoke |

当前重点剩余：

1. 内置程序体验：继续打磨主搜索和设置页微交互，避免布局和文案上的 ZTools 差距。
2. 插件管理：卸载、更新、插件权限仍未接入；本地副作用入口需要权限/确认设计。
3. Agent/MCP：继续补 MCP 协议完整性、客户端一键写入配置；插件 tools 暴露按当前要求暂缓。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## 第五十二批：已安装插件设置页

用户要求：插件不着急，先继续完善内置程序体验。本批聚焦设置页 `已安装插件`，把旧 placeholder 改为真实插件管理页：读取已安装插件、展示统计和 feature 摘要，并接入已有启停命令；安装、卸载、更新仍明确暂缓。

状态：DONE。

修改文件：

- `src/lib/pluginInventory.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-plugin-inventory.mjs`
- `package.json`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 新增 `pluginInventory()` 前端状态模型：
  - 统计插件总数、启用数、停用数、feature 总数。
  - 启用插件排序靠前。
  - 识别内置/导入来源。
  - 生成版本、描述、feature 预览、路径和更新时间展示字段。
- 设置页 `已安装插件` 从 placeholder 拆为真实页面：
  - 顶部显示刷新按钮和禁用的 `安装插件` 按钮。
  - 明确提示只管理已安装插件，网络安装、远程更新和卸载未接入。
  - 桌面端调用 `list_plugins` 读取插件列表。
  - 插件行显示版本、来源、feature 数量、描述、feature 预览和本地路径。
  - 启停按钮接入已有 `toggle_plugin` Tauri command。
  - Web 预览模式下显示 `Tauri 运行时未连接`，不假装能管理桌面插件。

TDD 记录：

- 先新增 `scripts/test-plugin-inventory.mjs`：
  - 要求统计总数/启用/停用/feature 数。
  - 要求启用插件排在停用插件前。
  - 要求空版本显示 `0.0.0`。
  - 要求内置资源路径识别为 `内置`，用户路径识别为 `导入`。
  - 要求 feature 预览最多显示 3 项，并标记更多 feature。
  - 要求空列表提示 `暂无已安装插件，可以先使用本地导入。`
- 初次运行红灯，原因是 `src/lib/pluginInventory.ts` 不存在。
- 实现状态模型后目标测试转绿。

验证：

```bash
pnpm test:plugin-inventory
pnpm test:plugin-market-status
pnpm test:settings-normalization
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 使用 browser automation 打开 `http://127.0.0.1:1420/?parity=1`。
- 进入 `设置` -> `已安装插件`。
- DOM 可见 `已安装插件`、`本页只管理已安装插件的启用状态和本地信息`、`插件总数`、`启用/停用`、`指令 feature`、`安装入口`、`本地导入可用；网络安装暂缓`、`插件列表`、`安装插件`。
- `安装插件` 为 disabled，`刷新` 非 disabled。
- Web 预览下显示 `Tauri 运行时未连接`。
- 旧 placeholder 文案 `通过插件包安装第三方插件` 不再出现在页面中。
- console warn/error 为 0。

结果：

- `pnpm test:plugin-inventory`：通过。
- `pnpm test:plugin-market-status`：通过。
- `pnpm test:settings-normalization`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，166 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，插件数 18，权限/数据/系统设置 smoke 均为 true。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 94% | 95% | `已安装插件` 从旧 placeholder 变成真实管理页 |
| 设置项真实功能 | 92% | 93% | 设置页接入插件刷新和启停管理 |
| 插件安装/导入 | 38% | 40% | 插件列表和启停管理进入 ZTools 风格设置页；安装/卸载/更新仍暂缓 |
| Agent/MCP 底座 | 90% | 90% | 本批不改 MCP/Agent |
| 权限与审计 | 93% | 93% | 本批不改权限审计 |
| 测试与发布 | 99% | 99% | 新增插件清单模型测试，并通过真实 desktop smoke |

当前重点剩余：

1. 内置程序体验：继续打磨插件详情禁用态、设置页细节空状态和主程序微交互。
2. 插件管理：卸载、更新、插件详情、插件权限仍未接入。
3. Agent/MCP：继续补 MCP 协议完整性、客户端一键写入配置；插件 tools 暴露按当前要求暂缓。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## 第五十批：WebDAV 本地配置页

用户要求：插件不着急，继续完善内置程序体验。本批聚焦设置页 `WebDAV 同步`，把占位页推进为真实可保存的本地配置页，同时明确首版不假装已经具备网络同步能力。

状态：DONE。

修改文件：

- `src/lib/settings.ts`
- `src/components/SettingsPanel.svelte`
- `scripts/test-settings-normalization.mjs`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- 设置结构新增 WebDAV 配置字段：
  - `webdavEnabled`
  - `webdavUrl`
  - `webdavUsername`
  - `webdavPassword`
  - `webdavRemotePath`
  - `webdavSyncSettings`
  - `webdavSyncPlugins`
  - `webdavSyncClipboard`
- `normalizeSettings()` 新增 WebDAV 规范化：
  - URL trim 后只接受 `http` / `https`。
  - 用户名、密码 trim 后保存。
  - 远端目录自动补 `/` 前缀。
  - URL 或用户名不完整时强制 `webdavEnabled=false`，并恢复默认同步范围，避免旧数据假启用。
- 设置页 `WebDAV 同步` 从占位页改为真实页面：
  - 服务器地址、用户名、密码/Token、远端目录。
  - 启用开关。
  - 同步设置、插件数据、剪贴板历史范围开关。
  - 同步状态区显示连接状态、远端目录、同步范围、执行能力。
- 页面明确提示：
  - 当前仅保存 WebDAV 连接配置和同步范围。
  - `立即同步` 禁用。
  - 执行能力显示 `未接入网络同步命令`。
- 浏览器验证时发现并修复一个体验问题：
  - 空配置下点击启用开关时，状态文案是 `未启用`，但 checkbox DOM 会误保持选中。
  - 修复后配置不完整时启用开关禁用且未选中；清空 URL 或用户名会自动关闭 WebDAV。

TDD 记录：

- 先扩展 `scripts/test-settings-normalization.mjs`，要求：
  - 合法 WebDAV 配置被 trim 后保留。
  - 远端目录 `atools/sync` 规范化为 `/atools/sync`。
  - 合法配置下启用状态和同步范围被保存。
  - 非 http/https URL、空用户名、空密码、空远端目录组合会强制关闭 WebDAV，并恢复默认同步范围。
- 初次运行目标测试红灯，原因是 WebDAV 字段只被透传，URL 没有 trim/协议校验。
- 实现 WebDAV 设置规范化后目标测试转绿。
- 浏览器交互作为第二个红灯来源，发现空配置开关视觉状态不一致；修复受控开关和配置变更联动后转绿。

验证：

```bash
pnpm test:settings-normalization
pnpm check
pnpm build
pnpm smoke:tauri-desktop
```

浏览器验证：

- 使用 browser automation 打开 `http://127.0.0.1:1420/?parity=1`。
- 进入 `设置` -> `WebDAV 同步`。
- DOM 可见 `WebDAV 同步`、`WebDAV 服务器地址`、`WebDAV 用户名`、`WebDAV 密码或 Token`、`WebDAV 远端目录`、`同步设置`、`同步插件数据`、`同步剪贴板历史`、`未接入网络同步命令`。
- 空配置时启用开关为 disabled + unchecked，状态为 `未启用`。
- console warn/error 为 0。
- 当前 Codex 内置浏览器后端缺少 virtual clipboard，无法自动输入 URL/用户名；合法配置后的持久化和规范化由 `pnpm test:settings-normalization` 覆盖。

结果：

- `pnpm test:settings-normalization`：通过。
- `pnpm check`：0 errors / 0 warnings。
- `pnpm build`：通过，164 modules transformed。
- `pnpm smoke:tauri-desktop`：通过，MCP ready，7 个默认 Agent 工具可见，权限/数据/系统设置 smoke 均为 true。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| ZTools 设置页 UI | 92% | 93% | `WebDAV 同步` 从占位页变成 ZTools 风格本地配置页 |
| 设置项真实功能 | 91% | 92% | WebDAV 连接信息和同步范围进入 settings 持久化链路，且不完整配置不会假启用 |
| Agent/MCP 底座 | 90% | 90% | 本批不改 MCP 协议和 Agent 工具调用 |
| 权限与审计 | 93% | 93% | 本批不改权限审计 |
| 测试与发布 | 99% | 99% | 扩展设置规范化测试，并通过真实 desktop smoke |

当前重点剩余：

1. 内置程序体验：继续打磨插件市场禁用态、设置页空状态、AI 配置接入真实 Agent 调用。
2. WebDAV：真实上传/下载、冲突处理、加密/敏感字段保存策略仍未接入。
3. Agent/MCP：继续补 MCP 协议完整性、客户端一键写入配置；插件 tools 暴露按当前要求暂缓。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

## 第四十九批：feature 索引冲突幂等修复

用户要求：继续还原完成度，测试没问题后同步文档和完成度。本批处理真实桌面 smoke 每次出现的 `json-viewer` feature code 冲突 warning，避免内置资源里同一个 feature code 在旧/新插件间迁移时污染启动日志。

状态：DONE。

修改文件：

- `crates/atools-core/src/db.rs`
- `docs/macos-smoke-checklist.md`
- `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

完成：

- `Database::index_features()` 从普通 `INSERT` 改为 `INSERT OR REPLACE`：
  - 仍先删除当前 plugin_id 的旧 feature。
  - 如果同一个 `features.code` 已属于另一个插件，则替换为当前插件归属。
  - 修复内置资源历史迁移时 `json` code 已存在导致 `json-viewer` 加载失败的问题。
- 保持 `features.code` 全局唯一语义：
  - 搜索和 `get_feature()` 仍只返回一个 owner。
  - 最新索引的插件成为该 code 的 owner。
- macOS smoke checklist 更新：
  - `json-viewer` feature code 冲突不再是预期 warning。
  - 如果复现，视为 feature 索引或内置资源路径回归。

TDD 记录：

- 先新增 `test_feature_indexing_reassigns_duplicate_code_to_latest_plugin`：
  - 保存旧插件 `json` 和新插件 `json-viewer`。
  - 旧插件先索引 `json` feature。
  - 新插件再索引同 code `json` feature。
  - 期望不报错，且 `get_feature("json")` 指向 `json-viewer`。
- 初次运行目标测试红灯，复现：
  - `UNIQUE constraint failed: features.code`
- 改为 `INSERT OR REPLACE` 后目标测试转绿。

验证：

```bash
cargo fmt --check
cargo test -p atools-core test_feature_indexing_reassigns_duplicate_code_to_latest_plugin
cargo test -p atools-core --lib
cargo test -p atools-api-shim
cargo test -p atools --test ztools_import_tests
cargo test -p atools --test agent_tools_tests
pnpm smoke:tauri-desktop
```

结果：

- `cargo fmt --check`：通过。
- `cargo test -p atools-core test_feature_indexing_reassigns_duplicate_code_to_latest_plugin`：通过。
- `cargo test -p atools-core --lib`：34 passed。
- `cargo test -p atools-api-shim`：17 passed。
- `cargo test -p atools --test ztools_import_tests`：3 passed。
- `cargo test -p atools --test agent_tools_tests`：19 passed。
- `pnpm smoke:tauri-desktop`：通过，输出中不再出现 `json-viewer` feature code 冲突 warning。

真实 Tauri smoke 残留：

- 本批后 `json-viewer` feature code 冲突 warning 已消除。
- 当前发布侧剩余 warning 仍是签名、公证、自动更新配置未接入。

完成度更新：

| 模块 | 上次估计 | 当前估计 | 说明 |
| --- | ---: | ---: | --- |
| Tauri/Rust 桌面底座 | 93% | 94% | feature 索引支持重复 code 幂等替换，真实启动日志更干净 |
| 插件安装/导入 | 35% | 38% | feature 索引不再因历史 code 归属冲突失败，导入/内置资源迁移更稳 |
| 测试与发布 | 99% | 99% | 真实 desktop smoke 已去掉 json-viewer 冲突 warning，但签名/公证/自动更新仍未完成 |
| ZTools 设置页 UI | 92% | 92% | 本批不改设置页 |
| Agent/MCP 底座 | 90% | 90% | 本批不改 MCP/Agent |

当前重点剩余：

1. 内置程序体验：继续打磨 WebDAV 同步、插件市场禁用态、AI 配置接入真实 Agent 调用。
2. 权限与审计：审计查询分页/索引化、保存筛选视图仍可增强。
3. Agent/MCP：继续补 MCP 协议完整性、客户端一键写入配置；插件 tools 暴露按当前要求暂缓。
4. macOS 发布质量：签名 identity、公证凭证、自动更新配置仍未完成。

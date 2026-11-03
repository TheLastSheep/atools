# ZTools 原版设置入口契约

日期：2026-10-26  
上游：/Users/harris/Desktop/ZTools，锁定 commit 9b15fb1a2a9f3ec886016632761c7bb21e39557a，工作区干净。

## 结论

原版 openSettings() 打开的是**主窗口内的 setting 插件视图**。设置 Vue 工程虽然是独立包，但运行时通过 ZTools 插件宿主嵌入主窗口。新建或显示 Tauri settings WebviewWindow 不等于还原此行为。

## 原版入口、路由与宿主事件

- 主 UI 的 Cmd+, 调用 window.ztools.openSettings()；设置按钮在非插件模式下也调用同一 API。两处都不传参数。见 ZTools/src/renderer/src/components/search/SearchBox.vue:435-442,942-951,1007-1012，类型声明 ZTools/src/renderer/src/env.d.ts:236。
- openSettings 经 ZTools/src/preload/index.ts:63 的 open-settings IPC 到 ZTools/src/main/api/renderer/window.ts:67,158-160，再到 WindowManager.showSettings()。没有路由参数或完成回调。
- showSettings() 先隐藏当前插件，查 DB 中 name === 'setting' 的插件，然后 api.launchPlugin({type:'plugin', featureCode:'main', name:'设置'})，最后移动并激活主窗口；找不到插件或启动失败则返回。查找与启动见 ZTools/src/main/managers/windowManager.ts:1369-1433，api.launchPlugin 转发见 ZTools/src/main/api/index.ts:287-295。
- type:'plugin' 会走 preparePluginLaunch，主窗模式先通知 show-plugin-placeholder，再 createPluginView。见 ZTools/src/main/api/renderer/commands.ts:478-506,345-390。PluginManager 在主窗口的 contentView 添加 WebContentsView，以插件 main URL 加载并缓存/复用；见 ZTools/src/main/managers/pluginManager.ts:183-205,415-499,603-660。
- 主渲染层收到 onShowPluginPlaceholder 后切换到 Plugin 视图、清空 query 和粘贴状态；另监听 loaded/closed、全局 placeholder、sub-input placeholder/visible。见 ZTools/src/preload/index.ts:110-113,146-168,284-290、ZTools/src/renderer/src/App.vue:620-649,681-696。
- 嵌入插件通过 onPluginEnter 收到启动 payload，onPluginOut 退出并回到搜索视图。见 ZTools/src/main/api/plugin/lifecycle.ts:23-50。设置工程的入口注册这两个事件；根 hash 路由 / 重定向至 /generalSetting，没有 /#/settings 路由。见 ZTools/internal-plugins/setting/src/main.ts:9-47、ZTools/internal-plugins/setting/src/router/router.ts:22-36,182-185。

## 设置 Vue 包与 API 依赖

- 独立 HTML 入口是 ZTools/internal-plugins/setting/index.html:7-9，挂载 #app 并加载 ZTools/internal-plugins/setting/src/main.ts。该入口注册事件、检测系统平台、挂载 Vue App/Router。ZTools/internal-plugins/setting/src/App.vue 挂载 SettingHone，它再挂载菜单和路由页：ZTools/internal-plugins/setting/src/main.ts:9-47、ZTools/internal-plugins/setting/src/App.vue:1-30、ZTools/internal-plugins/setting/src/components/SettingHone/SettingHone.vue:1-27。
- 打开默认 General 页至少需要 ztools.onPluginEnter/onPluginOut、window.ztools.isWindows/isMacOS、window.ztools.internal.getPlatform/dbGet/dbPut/setTheme/setWindowMaterial；GeneralSetting.vue 还直接读写 settings-general，查询/设置快捷键、窗口透明度、开机启动等。引用：ZTools/internal-plugins/setting/src/main.ts:9-38、ZTools/internal-plugins/setting/src/components/SettingHone/SettingHone.vue:6-15、ZTools/internal-plugins/setting/src/views/GeneralSetting/GeneralSetting.vue:314-406,1170-1195,1258-1289。
- 完整 General 页不是单纯 DB 读写：还调用头像选择、剪贴板配置、窗口位置、super panel、代理、tray、floating ball 等 window.ztools.internal.* setter。完整设置包的 LeftMenu 也会读同步账号配置/资料。见 ZTools/internal-plugins/setting/src/views/GeneralSetting/GeneralSetting.vue:433-1105、ZTools/internal-plugins/setting/src/components/LeftMenu/LeftMenu.vue:57-78,100-120,154-160,220-234。未实现的 API 必须显式拒绝或禁用对应操作，不能伪报成功。

## ATools 可复用处与缺口

- 原版主 renderer adapter 的 openSettings() 当前是 unsupportedSync，能力状态也是 unsupported。见 packages/ztools-renderer/src/types.ts:101-106、packages/ztools-renderer/src/hostAdapter.ts:297-305,346-362。
- ATools 的同窗承载面是 LauncherPrimarySurface → PluginPanelMount；activePlugin 时它扩展主窗并隐藏主搜索框，挂载 PluginPanel。见 src/App.svelte:420-449、src/components/LauncherPrimarySurface.svelte:115-128、src/components/PluginPanelMount.svelte:24-49。
- PluginPanel 已有 iframe 生命周期、资源解析、页面身份/权限、加载完成与 sub-input 状态；它按 FeatureAction.plugin_path 加载页面。可复用该主窗承载和生命周期外壳，但须为原版设置包提供一个受控内部设置 action 与 settings 专用桥接。见 src/lib/pluginPanelLoadController.ts:108-166,240-286、src/components/PluginPanelBody.svelte:91-99、src/lib/pluginSubInputState.ts:1-16。
- 现有 ZTools 兼容 iframe bridge 提供通用 onPluginEnter/onPluginOut 和 setSubInput 能力；它没有原版设置工程所需的 window.ztools.internal.* 配置 API。见 src/lib/pluginBridgeCapabilities.ts:31-36,72-95、src/lib/pluginUtoolsBridgeSource/providers-and-entry-lifecycle.ts:213-226,372-390。这不等于设置页已接通。
- plugin_browser_window_runtime 是活动插件按权限请求创建的子窗口能力；它不能代替原版同窗 pluginView。见 src/lib/pluginPanelBrowserWindowRuntime.ts:81-101、src-tauri/src/plugin_browser_window_runtime/commands.rs:9-43。
- 另有隐藏的 Tauri settings label，URL 固定为 /#/settings；tray handler 只复用该窗口并 show/center/focus。它是当前 Svelte 配置下的独立设置入口，不是原版 openSettings() 语义，也不应成为这条接线的目标。见 src-tauri/tauri.conf.json:15-44、src-tauri/src/tray.rs:64-70、src-tauri/capabilities/default.json:5-26。当前 Svelte openSettingsMenu() 也只是切换主窗内 Svelte settings panel：src/lib/launcherNavigationController.ts:105-109。

## 最小实际接线边界

1. 从锁定上游另行构建 internal-plugins/setting，由 ATools 构建目标把产物写入 ATools 管理的 bundle/resource 目录；不修改上游，也不把设置 app 塞进 packages/ztools-renderer/dist。现有 packages/ztools-renderer/build.mjs 只构建主 renderer 的 src/renderer，README 明确设置 app 尚未接通：packages/ztools-renderer/README.md:1-25,60-64,98-107。
2. 提供单一内部设置 action，让无参 openSettings() 激活 main-window PluginPanel 中该设置页；Cmd+, 与头像设置按钮继续复用同一入口。先进入 Plugin 视图状态再加载 Vue 页面；退出按 PluginOut 回到搜索页，重开可复用该内嵌实例。不要创建一个新 settings 原生窗口来替代。
3. 在设置页 iframe 上提供原版 bootstrap 需要的事件和真实 settings API。首个可验收纵切至少到 GeneralSetting 实际挂载、读取持久化 settings-general、一次真实设置写入后再次读取一致，并能退出回主搜索。还需确认主 Vue WebView 收到两种入口，真实页面 DOM 已 ready；显示 loading/placeholder、空白 frame 或只改变 activePlugin 都不算完成。
4. 上游设置包有独立 build 命令 vue-tsc && vite build 与 base:'./'，但当前无 internal-plugins/setting/node_modules 或 setting/dist；上游顶层也没有 vue-router、@vueuse/core、unocss 链接。主 renderer 所需的 Vite/Vue 依赖已在上游安装，现有 dist 存在。未运行安装或构建；不能据此宣称 setting bundle 可构建。见 ZTools/internal-plugins/setting/package.json:6-26、ZTools/internal-plugins/setting/vite.config.ts:7-35、packages/ztools-renderer/source-manifest.json:14-34。

完整设置页的所有标签和保存按钮还需要逐项映射其 native API；上面的最小纵切仅覆盖原版设置入口与 General 页真实读写，不代表全设置功能兼容。Svelte 入口继续作为迁移回退，验收不足时不切换默认入口：docs/superpowers/specs/2026-07-14-atools-product-engineering-north-star.md:47-56、DESIGN.md:10-18。

## 本次读取边界

- ATools：/Users/harris/Desktop/atools，分支 codex/atools-ztools-parity；工作区已有其他改动，全部保留。本文件是本子任务唯一写入。
- ZTools：/Users/harris/Desktop/ZTools，HEAD 为锁定 commit 且工作区干净；仅只读。
- 未运行 Cargo、测试、浏览器、应用启动、安装依赖或构建；因此没有运行时/视觉/真实窗口验收结论。

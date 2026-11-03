# 23：ZTools 首页分区展开与搜索文本编辑

状态：本票首页／搜索浏览器切片通过；不代表完整 ZTools UI／原生还原。

## 当前目标

用户更新整体目标为“参考 ztools 源码和 ui，使用 rust 和 tauri2 还原到 atools 中”。继续采用系统 WebView + Rust 核心 + 按需 Node，Harris 原包优先。保留此前原生 App、系统剪贴板和 AppleScript 暂缓决定。当前切片属于 Tauri 应用的实际 Svelte 宿主界面，不替换前端技术栈，不把纯前端 UI 状态迁到 Rust。

## 固定来源与调用链

本地 ZTools HEAD：`9b15fb1a2a9f3ec886016632761c7bb21e39557a`，renderer 44 个源文件已冻结；对照本地源码，无远端最新版结论。

- ZTools `components/common/CollapsibleList.vue`：默认行数只折叠，超出可展开完整分区；两个分区独立。
- ATools `launcherSurfacePresentation.svelte.ts` → `homeCommandsFor` → `HomePanel` / `homeSurface` / `launcherKeyboardHost`：多次截断，超出行数的项没有展开入口。
- ZTools `components/search/SearchBox.vue:129`、`:504`：输入框有文本选区时，方向和 Enter 键不传给列表导航；Tab 保持另一路径。
- ATools `launcherKeyboardController.ts`：主搜索框被认作导航目标，但缺少非空选区保护。

## 实现与验收合同

1. 首页保留完整、已验证的候选，固定与最近使用分别展开/收起；默认行数、主题色与磁贴标题本轮不改。
2. 展开状态仅属于当前窗口，不持久化、不增加后台进程、轮询或特权接口。渲染、键盘和状态栏共用精确可见顺序。
3. 分区切换改变索引时保持已选命令身份；收起隐藏项回退到同分区最后可见项。切换不执行命令、不丢失按钮焦点。
4. 可访问原生按钮具有展开状态、分区名称与控制目标；窄窗无横向溢出，滚动只发生在命令区域。
5. 主搜索框非空选区的常规方向键与 Enter 保留编辑，不切换或启动结果；用户显式配置的应用快捷键仍优先。折叠光标、Tab、Escape、IME 与插件子输入语义保持。
6. 主 Agent 独立运行相关回归、应用类型、生产构建和初始 JS 预算；实际 Chrome 用真实生产 App、受控目录/IPC 和真实 CDP 输入，明确不替代原生 Tauri/WebKit/OS 业务验收。
7. 所有归属代码文件不超过 500 行；原包、无关脏文件和已经冻结的运行时不改。保存修改前红测与最终结果，严格核对临时资源收尾。

## 分工

- Luna A：主搜索选区保护及其集成测试，独占 keyboard controller。
- Luna B：首页完整候选、可见分区、展开状态、UI 与键盘/状态接线及相关测试。
- Luna C：隔离浏览器 fixture 和 runner，不能启动浏览器或代替主验收。
- 主 Agent：接口、调用链、关键 diff、实际运行、截图和性能/资源核对。实现后另请 Luna 只读检查。

## 修改前基线

7 个 launcher/home 文件共 46 项：45 通过，1 失败。失败位于 `launcher-empty-search-tab.test.ts`，为空 catalog/history 设置期待非空卡片；保留完整原日志并核对原因，不能改生产空首页策略来使夹具通过。

证据目录：`output/ztools-launcher-parity-2026-10-25/`。修改前指纹覆盖 944 个本地前端/测试文件，以及 44 个 ZTools renderer 文件。

## 总目标仍需覆盖

| 领域 | 当前证据与后续要求 |
| --- | --- |
| 首页、搜索、键盘与主题 | 本票补两个确认差距；分区拖拽、默认视觉密度及完整竞品截图对照仍需核验 |
| 设置与系统集成 | 已有页面不等于完整对齐；子页重开位置、终端偏好及窗口材质存在源码差异，需按平台与原生能力另验 |
| 插件管理与市场 | 保留现有事务、安全、缓存等边界；实际安装/更新/卸载/恢复仍按原票证据分别确认 |
| Harris 原版插件 | Task21/22 浏览器切片可复用；LM files 循环、Office 正文标记、其它原包完整业务继续开放 |
| Tauri/Rust 原生行为 | 热键、窗口、系统剪贴板、选择器与 TaskRun/权限端到端未由浏览器替身证明；此前暂缓保持 |
| 体积与性能 | 初始 JS 预算与无新增进程属于窄范围门槛；整 App 启动、RSS/CPU、激活与同机竞品测量未完成 |

这些要求不因本票通过而缩小，不使用历史 checklist 勾选或百分比声明整体完成。

## 最终结果

主 Agent 独立 19 文件180项回归、应用与本票测试严格类型0错0警告、默认生产构建及453127/573440字节预算通过（首屏增加4009字节）。四组真实Chrome布局/主题和搜索9项检查通过，展开首行完整可见、收起点击、身份/焦点/滚动与选区路径均实测。17代码文件最多500行、944基线内无越界源码改动、880 native/runtime及44上游renderer源未改。六轮测试进程/profile/端口已收尾；先前失败原样保留。

独立Luna只读复核与主目视分别执行；原生Tauri/WKWebView、Harris完整业务、系统输入、跨平台与整App性能未由本票证明。源、原报、截图、失败归因和资源证据见 `output/ztools-launcher-parity-2026-10-25/verification.md`。整体目标继续开放。

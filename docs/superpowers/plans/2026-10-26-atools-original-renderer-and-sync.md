# 原版 renderer 接入与私有同步执行计划

日期：2026-10-26。工作区：`/Users/harris/Desktop/atools`；开发分支：`codex/atools-ztools-parity`。

用户已明确取消 Claim，本计划直接跟踪本地交付。主 Agent 负责接口、派单与最终验收；常规执行交Sol/Terra，简单明确任务可交Luna，普通改动由非实施Sol/Terra独立复核，Worker不再派生。已有未提交工作全部保留，不在本计划中提交或推送。

## 当前前沿（R80，原版普通应用全局快捷键）

沿[ticket52](../../../.scratch/original-main-native/issues/52-original-app-global-shortcuts.md)、[实施合同](../../contracts/ztools-app-global-shortcuts-2026-11-02.md)及[Native wire](../../contracts/ztools-app-global-shortcuts-2026-11-02-native-wire.md)推进原 Main→Shortcuts 预填、稳定 App 选择、CAS/owned OS 注册、权限/TaskRun/审计启动、修改删除、恢复和退出 drain。R80 与整目标继续开放：录制、Feature dispatch、owner hooks 和保存顺序已实现并获对应来源复核；录制上限为 65 capture/132 suppression，复用一个 App worker，无逐键 RPC，held tombstone 保留至真实释放或确认撤销，保存等待 drained；Feature 128 项 Offered/Claimed 复用 activate_feature RPC 携带 dispatch ID，真实 Promise terminal 后单次 completion，shutdown 失败保留 owner 并由显式 retry 恢复。以上容量是设计/测试边界，不是性能实测。Native core revision4、Feature/fixbatch、default-build、routing 的增量来源批准见[分层进度](../../../output/renderer-main-frontier-r80-2026-11-02/verification.md)；原 Native 与 owner-hooks 的 REQUEST_CHANGES 历史保留，后续批准只关闭对应源 scope。Settings FE revision 7 files/53 tests、strict TS 与来源复核通过；Main Feature TS 13/13、Svelte-check 0/0 分别留档。attempt-1 编译 RED，attempt-2 四个过滤器分别通过但 default workspace RED，attempt-3 app_global_shortcuts 33/33 与默认 workspace check 通过，计数不合并：[attempt-1](../../../output/renderer-main-frontier-r80-2026-11-02/recording-verification/attempt-1/summary.md) · [attempt-2](../../../output/renderer-main-frontier-r80-2026-11-02/recording-verification/attempt-2/summary.md) · [attempt-3](../../../output/renderer-main-frontier-r80-2026-11-02/recording-verification/attempt-3/summary.md)。新增相关模块不超过500行；旧 commands.rs 仍11989行，仅提取 activate_feature wrapper 并 re-export，不把所有 scope 文件说成小于500行。R80 正式四树构建与资源预算已完成（Settings emitted 817,194 B ≤ cap 822,755 B，Main 保持 614,004 B，Updater 正式产物验证）；Rust 侧 app_global_shortcuts 33/33、hotkey 101/101、general_settings_runtime 11/11、renderer_settings_view 226/226 及完整 src-tauri 1,920 项测试全部通过；前端 7 文件 53 项 Vitest 与 16 项 Controller 测试全部通过；修复 macOS Hardened Runtime 进程组退出观测与两处 commands 测试断言；工作区 cargo check 0 错误。Harris 插件后置、Node on-demand、默认 Svelte fallback 不变。

## 上一前沿（R72，隔离原生录制入口补齐，GUI 验收仍待补）

沿ticket44补manual-only热键plugin、严格start/stop与hotkey patch、有界Native观测及退出结果区分；7源冻结/最大324行，manual9/startup1/runner5及fresh feature build通过，Terra无P1/P2。唯一fresh run `ca4de0fed1f94e92bc51567819f90773` 在600361ms自身期限退出、Native/runner exit0、来源稳定/SQLite完整/自有root和bundle回收。CUA listApps正常但getApp请求15秒实际阻塞2942.5365秒；无AX/截图/按键、witness为空，故真实录制/取消/主键恢复/活跃键释放仍未验，不把empty owned release当功能通过。见[R72结果](../../../output/renderer-hotkey-native-r72-2026-11-02/verification.md)。Main604426/Settings801929B保持，无预算调整；停止重复同一GUI控制链，保留缺口并继续其它主程序任务。默认Svelte、主程序优先及goal active不变，无提交推送。

## 上一前沿（R71，原设置快捷键临时录制实现与自动化通过）

沿[ticket44](../../../.scratch/original-main-native/issues/44-original-hotkey-recording.md)及[录制合同](../../contracts/ztools-hotkey-recording-2026-11-02.md)接通原HotkeyInput的Option/Alt+Space录制、单组件所有权与回收。两mode均Released后清理/drop gate再交付；held取消保留唯一drain，主键变更busy安全拒绝；普通DOM先确认stop再保存。修复间接锁重入、丢Released、跨代/隐藏/取消仲裁及busy错误分类，未改原模板/CSS。最新前端23、Native94、正式reader19、strict/build和默认/feature workspace通过，Terra及Astra独立范围无剩余发现；Root36源hash匹配/max495。Main604426B保持，Settings801929B（+3037≤事前3072），显式R71上限801964，旧预算失败保留。见[R71验收](../../../output/renderer-hotkey-recording-r71-2026-11-02/verification.md)。无本批新Native app/GUI，系统实际按键、连续录制/恢复、双击全局执行、跨平台/发行性能及完整UI仍开放；默认Svelte不切换，goal active，无提交推送。

## 上一前沿（R70，真实双页两开关/主题观察与期限退出报告）

独立owned manual-ui以正式R69 UI接入真实Native，Root CUA确认原Settings两开关1→0→新会话保持→1、Main固定文字/禁用行为、ESC候选→query→固定文字，以及暗→明→暗可读；SQLite独立只读确认false/false及终态true/true/dark。最初AX setValue未产chip，Raise/坐标聚焦+typeText后成功，不称自动初始焦点、物理键盘/中文IME或完整像素验收；截图仅在本对话，无本地PNG。

第二run实际GUI流程绑定旧报告代码，Native CmdQ后exit0但缺native report，runnerexit1并保留root/DB。仅三Rust源修复Exit阶段写回，第三fresh run由CUA getApp请求timeout15秒但实际阻塞683.204秒，未发送CmdQ；原生600秒期限退出、真实report/外部exit0/DB integrity/source稳定/owned回收通过，标准CmdQ新报告路径仍未验，不能当旧GUI重跑。

首run在AppKit注册阶段SIGABRT，根因未确诊；前两异常run/root保留。同源码/正式UI的运行环境对照同时有重编binary SHA变化，不称严格单变量或已证明sandbox原因。脚本25项、初始Native定向与修后manual8/feature workspace已通过；Terra最终复核为功能/期限退出报告部分验收，见[回执](../../../output/renderer-main-frontier-r70-2026-11-01/reviewer-r70.md)。Main604426/606381 B、Settings资源798892/800742 B保持，未重建UI。见[R70验收](../../../output/renderer-main-frontier-r70-2026-11-01/verification.md)。本轮不再运行，完整goal继续active、默认Svelte不切换、主程序优先/插件后置，无Git写操作。

## 上一前沿（R69，原版内置 search/esc 两开关浏览器闭环通过）

仅开放 `builtinAppShortcutsEnabled.search/esc` 布尔单键patch；Core嵌套CAS保留旧close/kill/未知键，原ShortcutsSetting脚本补丁保存失败恢复，不支持的close/kill不写入。Main复用既有General事件，缺失整条设置保持默认true，新事件胜过迟到启动读，原Pinia generation防异步回写。Cmd/Ctrl+F固定非空trim文本并清输入，ESC按query→pastedText→hide处理；无新运行Node/轮询/监听源。

已冻结Rust32/13/22/26、bundle16/1ignored、reader1及默认/feature workspace通过；前端strict与54suite424项通过。正式Main重建604426/606381 B、Settings798892/800742 B，事前冻结各3KiB增量预算，未删原Vue/CSS/字典。根compatibility helper及src .ts/.mjs均绑定正式provenance；Node21及两helper篡改拒绝反例通过。

双页原DOM run `8d1679c0-61fa-4f65-baad-c1834795ea0c` 自然exit0、5检查/4截图：三次独立Child会话、单键保存/未知键保留、关闭重开、写失败/CAS冲突恢复、Main CDP 合成按键和composition生命周期、最终监听/请求/资源归零。此为synthetic transport/合成浏览器输入，不是Native GUI、物理键盘或真实SQLite运行闭环；原失败run保留。证据见[R69验收](../../../output/renderer-main-frontier-r69-2026-10-29/verification.md)。独立Terra增量复核功能范围APPROVE、无P1/P2，见[复核回执](../../../output/renderer-main-frontier-r69-2026-10-29/reviewer-resume.md)，完整UI/goal仍开放，默认Svelte不切换，无Git写操作。

## 上一前沿（R68，真实Settings Child注册到Main启动与退出通过）

票43实际原Main→Wry Child→原LocalLaunchSetting→同一binding受控Rust四路径登记→别名/关闭/Main搜索/新文档重开→清除别名并删非app登记→原七阶段权限启动/审计/历史/退出已通过。新来源初始Core空/rev0，精确4/5/8及Main事件累计保持；inputSource为rust-injected-drag-event、physicalOsDrop=false。Settings-child新schema3外部source/bundle/SQLite强绑定，省略source旧CoreSeed实际schema2回归也通过。profile误写root前缀的P1已修且正反例保留。

两个Host PID31802/34298自然exit0，两个run各两个owned probe的Native/Node PID终态一致；TaskRun3/取消1/成功2、audit拒绝1/确认2、local history2/各1次，owner/root/bundle清理通过。新模式两session/document/nonce不同，双关闭session/Child/layout/pending call/write=0、实际4项框架ACL拒绝；九个前置+七个启动阶段共16个Native/AppKit离散样本均hidden/unfocused/appActive=false/mainKey=false、focus-event0，不称全时段桌面前台观测。Node副本SQLite integrity/rev8/app2及整行独立对照通过，DB/WAL匹配；SHM仅为共享索引旁文件，字节差异不当业务污染。

Native profile24/launch15/drop19/presentation4，Settings169和smoke249（各1ignored，组有重叠不累加），正式loader另选1项通过；Node28/VM、workspace默认/实际feature通过（atools256/258 warnings）。Fresh closure1470份SHA`1ad1a8c1be64a09aa2ec6adfb711241d075367afde1ed87e09f85747715de220`，较R67变36/增14/删0；50审查文件当前hash匹配且≤496行。binary`66c46ced47c322ae907d7889ec15c6894acbc9c5c12db77a2a0ac0ae14a43bc8`/双exe/新receipt/两run/current来源绑定，Main603309/604116B、Settings797670/798151B保持，未重建正式UI或新增预算。

Sol/Terra执行与独立Sol源/实际产物复核均通过，范围内APPROVE、无剩余P1/P2，两validator/11反例、Settings-child SQLite逐audit_id和六PID ESRCH补查已绑定（原document UUID与旧CoreSeed独立SQLite未保留）；见[R68验收](../../../output/renderer-main-frontier-r68-2026-10-29/verification.md)。票43物理OS拖放/真实选择器、普通file/folder打开与Finder、visible/physical/IME/跨平台、默认Vue、完整UI和发行性能继续开放；主程序继续、Harris随后，默认Svelte/SQLite/按需Node不变，goal active，无Git写操作。当前已有桌面前检screenLocked=null未知，不用旧locked=true描述现在。

## 上一前沿（R67，原版本地页原生拖放接线与通知交错修复）

票43补具体Settings Child原生Drop→有界Rust登记→原SFC列表/反馈，保持目标模板/CSS。补精确localLaunch路由和R65资源milestone Native loader遗漏；不从JS File.path取来源。每Child单批64路径、16KiB单条/64KiB总，无新生产进程/轮询。Astra独立复核发现两项P2并关闭：Sol将最终目标/编号/eval串到同一主线程任务；Luna移除旧Result清新hover，Enter/Leave控制高亮。

基础回归前端52文件414、NativeSettings159（1ignored）；修后Astra独验NativeDrop/交付14、policy5、当前正式dist loader1、Node25、bridge/原SFC5及独立hover反例2通过，计数有重叠不累加。Child显式strict、正式Settings两项类型检查/构建通过；默认workspace256warnings，修后prototype262warnings。Settings797670B（+3615），正式冻结4KiB/798151B余481，Main603309B及604116B上限保持。1456份Native SHA`0712ec77f3f15b10a048c6dfc01434589d1af82f518913b0768fd1ee5d6ae950`，11份变化均≤500行，无删除；26审查源/20host源/构建输入及dist绑定收尾一致。

见[R67验收](../../../output/renderer-main-frontier-r67-2026-10-29/verification.md)和[Astra独立回执](../../../output/renderer-main-frontier-r67-2026-10-29/astra-review-final.json)。0tests、编译失败与两项RED保留。没有本轮新桌面构建/运行receipt，R66运行不绑定新源码；实际OS拖放/Wry Child接线/框架事件ACL、选择器、可见/物理/跨平台仍开放。下一步继续票43真实Settings添加到Main使用闭环，主程序优先，随后Harris原包；默认Svelte/SQLite/按需Node不变，goal active，无Git提交推送。

## 上一前沿（R66，本地应用真实Native启动与普通app回归通过）

票43补齐原Main/WKWebView→实际Tauri→权限/TaskRun→macOS打开自有`.app`→真实SQLite历史→退出回收。local-shortcut与app两种模式均7阶段通过：TaskRun取消1/成功2，审计拒绝1/确认2，历史分别local2/app0与app2/local0，pending/live归零、自有root和bundle回收。记录经Core预置、输入为DOM合成；不是系统选择器添加或物理输入验收。

真实运行发现R65合成transport漏验的生产事件白名单缺口，现将`atools://renderer-local-shortcuts`限定Main WebView放行；同步更新Native/Node settingsView.input严格契约和只读失败诊断。旧失败不改判。Root独验前端50文件409、Native263（1 ignored）、Node17、Main strict及正式构建通过，workspace默认256/prototype262 warnings。Main603309B（较R65+36B），604116B上限不变；Settings794055B不变。1452份Native SHA`99ec9f8b5a637ab4b7c2fa4943c59d7e3ea5155c18b08e7140917a8afbfb0362`，24份变化均≤500行，无删除，收尾来源及二进制保持一致。

两份新Native receipt及独立review见[R66验收](../../../output/renderer-main-frontier-r66-2026-10-29/verification.md)。五个失败夹具经独立owner/SQLite/进程审计已清理，历史失败与后续清理分别留证。桌面三次只读快照均locked=true，不推导全程状态，无本轮可见GUI/AppleScript/物理输入。票43选择器/原生拖放、普通文件/文件夹/揭示、可见流程及跨平台仍开放。

用户再次提供的Gemini附件与既有SHA相同，沿[采纳矩阵](../../contracts/ztools-gemini-plugin-reference-assessment-2026-10-27.md)复核，不新增重复任务，也不提升插件兼容验收状态。默认Svelte、SQLite、按需Node、主程序优先及随后Harris原包不变；发行性能与完整UI仍未完成，goal active，无Git提交推送。

## 上一前沿（R65，本地启动管理接入原Main，重名路径与启动变更竞态修正）

票43实现原LocalLaunchSetting七操作→有界Child session→Native元数据/面板→真实SQLite及Main启动/历史/固定身份；保留未知metadata数字token，changed才发revision，不新增生产Node或轮询。已知App仍先走目录，不等待本地设置；原App白名单和Native当前注册表检查保留，本地目标新增当前平台绝对路径约束。原模板/CSS不动，但原Store重名路径匹配和SearchResults持久化名字有两处构建期SHA锁定逻辑修正，明确记录而非宣称整份逻辑不改。

Root独验Core本地8/direct17/预算1，Native local15/Main17/pin7/picker3/buffer9（有重叠不累加），前端50文件408及Main strict、基础设施26、两份正式构建通过。默认workspace256 warnings，面板prototype262 warnings。Main603273B（+4277），4KiB失败181B保留，新里程碑明确修订5KiB/604116B；Settings794055B（+3598），4KiB/794553B，不采用初提6KiB。源/产物38份Main、19份Settings桥hash匹配；1447份Native输入SHA `e0e0dac2eacb2c0499a7ac69d8d55ecec3603de79c52ac248ecccff35748d13d`收尾不变，27份变化输入均≤500行。

最终原Vue两页面浏览器run `df58f552-d3a1-4c5a-958f-06b20161521e`，14检查/10PNG：取消、添加、别名、清理、搜索/启动/固定/重开/删除；同名不同路径保持B、改名后按persistedName取消固定。合成transport/in-memory，Rust/SQLite另验，不等价真实Native。1预期alias冲突，意外错误/网络0，自有清理通过。初次bootstrap及两次partial夹具失败保留；最终修复严格字段锁与旧document销毁后通过。见[R65验收](../../../output/renderer-main-frontier-r65-2026-10-29/verification.md)。

票43真实系统面板/拖放/OS打开/可见流程开放；桌面本批只读前检locked=true，无新Native app receipt。默认Svelte、Harris原插件后置、整体UI/物理/IME/Windows/Linux及发行性能未完成。Gemini附件沿既有采纳矩阵，SQLite+按需Node和主程序优先不变，整体goal active，无Git提交推送。

## 上一前沿（R64，推荐置顶/前移/取消写通，存量metadata原文保留）

票42补齐原Main推荐菜单→adapter→Main专用命令→独立SQLite域；一次保存一次IPC，回执后更新缓存，失败保持原Store回滚，其他app-state与插件执行未触碰。独立审查发现长扩展键误拒和JS大整数舍入导致CAS冲突，现用启动raw基线、严格append/remove/moveToFront/noop及Core RawValue保留存量行token；重复身份按原版首次操作，不静默去重。Root另修逐候选数组复制为线性比对，保留输入/回执/复杂度预算。

Root验收Core9、Native命令helper6、菜单11、PluginData10、前端47文件392项、Main全源strict与正式构建、预算来源验证15项通过。默认workspace check通过（250 warnings），面板prototype含legacy-node/multiwebview通过（262 warnings）；all-features因额外压缩Node发行模式缺APPLE_TEAM_ID失败，未配签名。Main598996B，较593911B增加5085B；4KiB失败保留，公开修订到5KiB上限599031B，余35B。Settings18源及全部资源hash匹配，仍790457B。

最终原Vue浏览器run`adfad873-03d2-405d-9cd2-f11a7b524749`，23检查/16PNG，置顶/前移/重开换目录/一次失败回滚重试/取消；5成功1预期失败、插件0执行，来源与资源清理通过。它使用合成Native transport/private localStorage，Rust/SQLite另验，不扩大为真实系统菜单或可见Native。1436 Native输入SHA`68c3edb566c0b963f63b34e8575a0ab2a584d9c5829c63c7ad4eb3723f062ede`；Worker误将rustfmt配置写入lib.rs，Root以已接受完整SHA精确恢复419行并重新验证，失败和恢复回执保留；另3处递归formatter疑似触及文件缺前像，不称纯格式化。

见[R64验收](../../../output/renderer-recommendation-pins-2026-10-29/verification.md)。桌面本批前检18:13:54Z报告锁定，未新跑Native可见/系统菜单或产生应用receipt。票42、默认Vue推广、完整UI/物理/IME、Windows/Linux、Harris原包及发行性能继续开放。Gemini附件与已核对SHA相同，沿原采纳矩阵使用；SQLite、按需Node与主程序优先排期保持，整体goal active，无Git提交推送。

## 上一前沿（R63，自动带入设置写通，启动期间早到通知不再丢失）

票41新增autoPaste五值的共享Core/SQLite CAS写入、Child一次patch后的确认与原Main即时通知；原20字段末尾追加，Main原五字段写权限不放开。独立审查发现原App等待目录时丢早到通知；Root在来源一致的真实原Vue复现off后仍读取1次的RED，再以有界primitive缓存/仅新订阅者回放修复，非法事件不污染、dispose清理、两组64cap保留。

最终Core28、Native Child21/Main权限2、前端45文件379项、Main严格类型与Settings严格tsc/vue-tsc、两份正式构建及workspace通过（262 warnings）。Main593911/593920B余9B；Settings790457B，增量6142/6144B余2B，未抬预算。1431份Native输入SHA `1c3e2297fedaf3057340133a01b725a3f6b2b85954a4f1500e938ea8e60b04ad`前后稳定，新增/变化代码≤500行；同职责去重保留校验/错误/回调语义，见[R63验收](../../../output/renderer-auto-paste-2026-10-29/verification.md)。

最终browser `0d0f9046-1123-450c-9248-53bee14ebd92` 正式dist原App/windowStore/SearchBox通过20检查/13PNG；off→3s→off、四种毫秒时限、过期/手动paste及启动早到off均有事实，来源稳定/自有回收通过。另一Luna源码与RED/GREEN独验无P1/P2。通知/RPC为合成，不是Native focus或真实剪贴板。桌面前检locked，本轮无新Native GUI/应用receipt；完整可见/物理/跨平台、默认Vue及Harris后置范围继续开放。下一候选为原推荐固定域精确持久化，不开放任意dbPut。主程序优先、SQLite/按需Node不变，未add/commit/push，整体goal active。

## 上一前沿（R62，真实WKWebView剪贴板链路通过，完整可见验收保持开放）

票40已补齐同一隐藏Tauri进程中的原Vue Main→正式命令/身份→ClipboardRead/TaskRun→Rust→私有命名NSPasteboard→原SearchBox链路。最终run `6a8e9e741c7b4ca1a887a2f64862b244`、PID60291自然exit0：文本、选中替换、实际解码1×1图片、文件、同changeCount过期、清空及保存Deny均通过。7次调用/6次snapshot，实际任务6成功+1取消、审计6确认+1拒绝，正文不进入任务/审计、legacy/native history不增长；工作槽2→2、pending/outstanding归零、私有板clear读回及owner回收通过。另一Luna独立重算与负例变异通过；Main句柄仅在报告前记录存在，不称观察到destroy。

Root审查并修复隔离DB漏正式工具注册、probe延迟ready、Node ChildProcess包装及JSON转义绕过隐私校验；旧逻辑回放真实RED保留，没有放宽权限。最终定向Rust19、Profile全feature18、路径1和Node16/延迟ready检查通过（套件重叠不累加），workspace全feature通过、262 warnings。1430份Native输入SHA `552932c70ce126941540675fb166a0926ae79b8c3574f4b110789a19e3c4bafc`、binary `7ea3f5b4300fcaedf574e6e6bb06bf047efcd2e203c15a45cc8c850ef43ea912`与fresh receipt前后稳定，变更代码≤500行，见[R62验收](../../../output/renderer-clipboard-native-2026-10-29/verification.md)。

全程不读写用户general剪贴板，不请求前台/系统按键/输入源；829ms仅为journey耗时，非性能基准。Main593894B/593920B与既有Settings预算不抬，产品前端未改。票40保持in-progress：真实focus自动带入、general板/物理Cmd+V、可见/IME及Windows/Linux仍开放。Gemini相同附件窄复核无新增矛盾，沿用既有取舍表；SQLite、按需Node、主程序优先/Harris后置不变。默认Svelte未切，完整UI/发行性能与整体goal继续active，未add/commit/push。

## 上一前沿（R61，原版Main粘贴读取接入与分层验证通过）

票40补齐原版SearchBox已preventDefault但宿主getter unavailable导致的粘贴缺口，能力现为limited。一次Main调用进入共享ClipboardRead/TaskRun；Rust从当前快照按文件/图片/文本优先投影，时间戳随changeCount首次观察固定。原文仅走请求局部通道，审计只存摘要；暂停/过滤仍是历史写入策略。配对快照时间、实际阻塞工作持锁/工作槽至终结、有界JSON计数writer及不可变投影不等待实时锁均有回归；完整内容校验归Rust，JS保留外壳与生命周期，不启动Node。

Root独验Rust运行时30、权限管线8、来源1和隔离命名NSPasteboard 2项通过；后者在默认受限环境因系统返回NULL失败，放行登录会话服务后通过，原始失败和系统warning保留，全程不读写用户general pasteboard。前端32文件235项、strict TS、构建辅助20项、workspace check通过（262 warnings）。正式Main593894B≤593920B，余26B；Settings790459B及其0增量余量不变，预算未抬。见[R61记录](../../../output/renderer-clipboard-context-2026-10-29/verification.md)。

最终浏览器run `2935f74a-a6ea-45f0-91a1-f4a2e532ed71` 从正式dist加载原Vue，18项检查、11张截图、源码/产物稳定和全部自有资源回收通过；Root查看文本/选中替换/图片/文件画面。覆盖手动文本、图片（实际解码1×1）、文件及1秒过期自动带入不覆盖上下文。最初两次失败来自测试对dispatchEvent取消返回值及31字原版缩略标签的错误预期，已修，未改上游或降低通过条件。

票40继续in-progress：上述分层结果不能替代真实WKWebView/Main IPC/OS读取端到端；跨平台当前unsupported。默认Svelte未切换，完整UI、可见/物理输入、Harris原包及整应用性能保持开放。Gemini参考沿既有取舍表，不改SQLite/按需Node；未add/commit/push，整体goal active。

## 上一前沿（R60，启动项生产接线、原版设置页恢复交互与资源预算通过）

票38已接通生产startup恢复、固定路径与bundle身份校验、共享OS操作锁，以及Main/Child的严格read/inspect/resolve入口。原Vue通过唯一General启动项模板例外接入共享controller，Svelte复用同一状态机。明确提供关闭、迁移、暂不处理；未知状态在原Vue显示可见文字并隐藏会看似关闭的slider。CAS、系统批准及旧项拒绝均清除缓存，重试真实fresh read；不写General旧bool，不改默认入口或只读上游。

Root独验Rust General154、Child131项通过（1既有ignore），accepted资源下workspace check通过、保留262 warnings。最终定向前端41/41，之前广域Settings154/154（重叠不相加），strict TS/Vue、Svelte 0/0及模板边界检查通过。Vite emission职责已拆分，纯诊断调用删除保留参数副作用与warn/error；DTO、错误说明与状态事务去重。资源从首次796413B减至790459B，比784315B基线恰好增加6144B，未抬预算，增量余量为0。Main JS保持593564B。见[R60验收记录](../../../output/renderer-legacy-login-integration-2026-10-29/verification.md)。

真实无界面Chrome载入正式dist的原Vue页面，最终run `8f87c7b8e0d241bab707f153d046172b` 五页14/14检查通过；覆盖三种明确选择、现代/旧项共存、CAS与revision拒绝及fresh重读、可见未知提示。Root查看未知与恢复后PNG，源码/产物hash稳定，0外网尝试，自有服务已关闭。Native输入1409份SHA `26d8140f821d88b197aae1e64675052a0e09b783903e17ff85c4bacc03cb1657`稳定；原始失败日志保留。浏览器RPC为合成，不能替代Rust IPC、WKWebView、真实LaunchAgent或下次登录验收。

北京时间2026-10-29 21:13:52只读会话查询明确locked，本批无Native GUI运行/新应用receipt，未把用户真实LaunchAgent作为迁移夹具。票38继续in-progress；等待桌面前提满足再做来源一致的可见面板/输入验收，真实迁移需要隔离登录环境。完整UI对齐、默认入口推广、Harris原包、跨平台和整应用性能继续开放；主程序优先、按需Node、SQLite不变，未add/commit/push，整体goal active。

## 上一前沿（R59，旧登录项真实文件事务与中断恢复已验证）

桌面前提在北京时间2026-10-29 19:13:11复查仍明确锁定；本批没有新原生GUI运行。继续推进票38的必要底层缺口：Luna实现严格journal、真实文件LegacyPort和只读现代状态的重开恢复，Root负责接口、接线、关键审查和实际验收。固定路径、同卷NO_REPLACE、文件/目录sync、命名目录与锁的fd身份、ForwardCommitted不可回滚、pending调和及未知证据保留均已进入私有真实文件测试。

Root独验General137项通过（legacy60项为其子集），workspace check通过（345 warnings包含新增未接线模块dead-code）、格式和文件规模检查通过。恢复原文件后仍残留pending的新用例先真实RED再GREEN；受控回放旧目录guard时4项port测试有2项失败，正确源码逐字节恢复后进入最终GREEN。独立复审无剩余P1/P2；1401份Native输入SHA `141dddc22775e57cf0aa022c83a22aff522a61b0cc47a726f59e4be785a984e4`前后稳定，Main JS仍593564B，无新增Cargo依赖。见[R59验收](../../../output/renderer-legacy-login-durable-2026-10-29/verification.md)。

这不是旧启动项的完整用户交付：生产启动恢复钩子、共享设置授权命令和明确关闭/迁移UI仍未接通，真实OS/下次登录、可见交互与发行性能未验。未操作用户真实启动项；票38继续in-progress。下一步接入以上生产调用链，再做隔离OS验收；主面板等桌面前提满足后恢复来源一致的可见验收。完整原版UI、默认入口推广、Harris原包及跨平台范围继续保留，不因文件测试通过收窄整体目标。

## 上一前沿（R58，桌面前置检查与构造对照；可见验收等待解锁）

只读桌面查询在北京时间2026-10-29 18:16:56明确报告锁定。原生runner已接入启动前/结束后会话检查，只有会话存在、已登录、位于控制台且明确未锁定才能通过；不再在锁定或未知状态下尝试显示/焦点。Root独立运行Node 36项通过，真实查询按预期返回`desktop-session-locked`且未启动应用。旧运行没有同刻锁屏读数，不追溯重分类；R57四份报告独立复算仍全部失败，源码绑定及专属路径回收记录通过。

Luna补齐默认关闭的真正NSPanel构造对照，Root审查和编译发现的模块/初始化接缝已修；独立review发现迟到操作可能逃过清理，已补上有界排空和同run清理重试，并保留最初错误。构造对照只承载空白NSView、独立输出诊断，不冒充Main或完整UI验收；尚未运行。Root最终验收Rust renderer238项通过/1忽略、带隔离feature的workspace check通过（277 warnings）、格式与脚本语法检查通过；1387份Native输入SHA `fd3d8eca5bae7a9dc9f22f63734864604bff5b6125763cd9a059f6deabbb6981`前后稳定。独立复审已确认清理竞态修复，无剩余阻断项；首次6个编译错误日志保留。本批没有新Native应用运行或build receipt，见[R58验收记录](../../../output/renderer-main-panel-native-2026-10-29/r58-verification.md)。等待可交互桌面再进行来源一致的Main验收，避免继续无效GUI实验。默认入口、依赖方案及主程序优先/Harris后置不变。

## 上一前沿（R57，真实面板与恢复已有记录，非激活交互仍未通过）

R56建立真实原版Main的单独面板runner、严格报告重算、源码/二进制/receipt前后绑定与业务失败后的owner清理。第一次受限执行在NSApplication初始化阶段SIGABRT，正常桌面环境同一binary可到达安装预检；精确diagnostic定位系统KVO包装。四次R56进程均已ESRCH、专属root/app均不存在，见`output/renderer-main-panel-native-2026-10-29/r56-observed-verification.json`。没有把执行环境崩溃归因为面板实现。

R57仅支持实测的精确Foundation KVO包装，记录actual/reported类、原始布局与完整方法事实，每阶段原content view稳定性必须已知true，关闭/退出先经过恢复屏障。Root已验窗口84项、renderer235项/1忽略、Node15项；实际记录中原版Main能显示、key/focus/occlusion及DOM焦点均true、content稳定，原KVO/delegate/样式恢复全true，资源回收通过。然而`run-258e58d6952144869849b6a41ee24a8f`激活应用一次，仍正式失败。随后分离order/key、库完整show-and-make-key及实际Main WK作为first responder均得到激活0/前台保持，却没有真实key/occlusion/DOM可见，也保持失败。所有原始报告和fresh receipt保留，完整UI、默认入口、Harris原包、跨平台及发行性能继续开放。

## 上一前沿（R55，隔离Mac面板原型静态与单元验证）

固定`tauri-nspanel`提交仅由非默认`macos-main-panel-prototype`启用，默认入口保持；精确临时bundle作用域转换同一main对象，原delegate/样式/视图状态保留供恢复。普通显示、切换及嵌入设置父窗聚焦已接入面板分支，原版Vue/CSS与独立设置窗保持现状。只读AppKit与DOM观测链首先检验隐藏基线、显示、隐藏、重显与恢复，不把`passed`扩为整产品或画面验收。独立审查发现的runtime类名错误已修正；布局、真实实例与恢复仍需逐项原生验收，进程期文本输入方法不可撤销和部分失败不可重试已显式记录。

Root已验非默认feature编译、窗口74项、renderer验收相关232项/1忽略及默认workspace check；默认265 warnings包含R52未接入legacy模块，不能称全部为历史warning。1381份来源SHA `cd5bdd945d21840697973c536766b7d69bf07fcde92fb955fda7fdfb9579f786`前后稳定；本批未启动原型应用，没有NSPanel对象转换、可见画面、物理输入或新Native build receipt。初始编译失败和一次旧错误提示断言失败保留，见[静态验证记录](../../../output/renderer-main-panel-2026-10-29/verification.md)。ticket39保持in-progress，旧R53失败和ticket26/36/38继续保留。

用户再次提供的Gemini插件补充与10-27核对表记录的附件SHA完全相同，无新增范围或重复任务；仍按既有插件参考矩阵使用，主程序优先、随后Harris原包插件。

## 上一前沿（R54，真实应用ID修复；普通Mac面板语义纠偏）

R54修复真实配置与登录项授权不一致：base与HEAD的bundle ID是dev.atools.desktop，原守卫只认com.atools.desktop。现在只接受当前/历史两项精确ID，app-aware仍要求实际NSBundle与配置完全一致，stateless也只认实际已知bundle；隔离前缀不进production路径，旧LaunchAgent路径/Label不变。Main feature General回归101项与workspace check通过，独立只读审查无新P1/P2。2个Native变更文件218/453行，1363来源SHA `af01f159940e045aeb64c0fa1bd680a8ae2fb2681d34694a6cd9f6951fee2491`，无依赖/前端变化；未操作真实production启动项，见[配置授权验收](../../../output/renderer-production-login-scope-2026-10-29/verification.md)。R51临时bundle的通过未覆盖此真实配置分支，已增加读取真实配置的回归。

固定上游再次核对发现普通macOS唤起是panel+modal-panel相对层级1+show，搜索WebContents恢复输入焦点，同时保留原应用前台状态；app.focus(steal)只在特殊流程。当前ATools show/set_focus/显式app activation比普通目标更强，旧foreground失败不能直接当作普通面板还原的合格验收目标。不能只删app-active门槛；下一票[39](../../../.scratch/original-main-native/issues/39-macos-main-panel.md)必须证明真实非激活面板、输入焦点、前台保持、画面和生命周期。主窗目前未panel化，依赖也未引入；候选插件已冻结调研commit，Tao ivar/事件/恢复与私有selector等风险先在隔离原型验证，见[面板契约](../../contracts/ztools-macos-main-panel-parity-2026-10-29.md)。ticket26/36/38及完整UI/启动/迁移/跨平台/性能继续开放，默认入口保持，未stage/commit/push，整体goal active。

## 上一前沿（R53，可见激活失败事实；原因未确认）

R53为实际失败请求补固定schema观测，仅legacy-node-smoke下输出自身的eligibility及9项nullable窗口/app事实；默认feature不新增日志，生产激活判据不改。新run `4fc00589-d72f-4657-be6f-48291c4453ec` 两实例均finishedLaunching/regular/未终止，但requestSent=false，窗口flag visible=true、Space=true、appHidden=false，appActive/frontmost/key/focused/occlusionVisible均false。即时快照不能排除主循环延后生效，故又在QA失败分支被动等待既有2秒预算，不重发show/activate/focus，正式结论仍失败。最终run `5322217f-b0fd-44a8-a056-2903b396f616` 两实例实际2027/2030ms后仍focused=false、focus-gained计数0，stage0；均自然exit1、无timeout/signal，所有自有资源清理。未取得合格可见PNG，不能归因锁屏或宣称可见UI恢复。

最终1363 Native输入SHA `7bf172d83454de4006144a320f4fee3b782cb8ade13c972ae434f71093f68526`、binary `4ad56b324cc8689f83bf6879e336b49f94fcc1650ef548ff09d03418cae723ee`、收据1793253820613稳定。activation定向16项在前一观测冻结点通过，随后只改QA controller被动观察；最新workspace与fresh feature example通过，265/269警告含R52的22条尚未接线dead-code。源文件453/293/398行，无前端/依赖变更或预算抬升。见[R53记录](../../../output/renderer-visible-recheck-2026-10-29/verification.md)。正在对照固定上游及缓存Tauri/Tao的实际调用链，不凭deprecated名称猜原因；没有新条件或源码依据不重复相同流程。ticket26/36的可见/物理/IME仍开放，默认入口不切，整体goal active。

## 上一前沿（R52，迁移前置实现）

R52新增严格旧plist检查器和纯端口迁移策略：有界no-follow读取、身份/权限与plist字段校验、两种明确选择、现代CAS/实际读回、分阶段补偿、commit失败保留前向恢复证据。FileIdentity读取期间保留ctime检查，跨rename用专门保留metadata比较；复用同一现代状态分类。Main最终General回归98项通过，其中24项属于本批；workspace check通过，265警告较R51增加22条未接线legacy模块dead-code，未把它们称作历史警告。7个Native新增/变更文件无删除，均≤500行，无Cargo依赖/锁变化；冻结点1363输入SHA `9d9cf5575d78468bbdc0947af1015f1808ad6ecef1f19c0bf8d4e80af6db65cf`。独立审查发现的提交前状态漂移与commit fake证据缺失已修；见[R52前置验收](../../../output/renderer-legacy-login-2026-10-29/verification.md)。

尚无真实durable文件/journal adapter、重启恢复、显式UI/窄命令或真实旧项迁移，普通toggle保护不变；ticket38仍in-progress，不能因单元/临时文件通过宣称迁移已可用。当前只读会话给出loginDone/onConsole=true、screenLocked=null；缺少锁标记不是解锁证明。新可见正式run `fa6c432a-6e9b-4a7d-bece-61d31ed4384a` 的两个实例仍在首次显示失败，stage0、自然exit1、自有root/app均清理；不归因锁屏，也不回推旧run。已开始仅QA feature下的结构化激活失败观测，未改变生产激活判据；其结果须另行记录，不覆盖[R51隐藏验收](../../../output/renderer-login-cross-entry-2026-10-29/verification.md)或冒充可见通过。默认Svelte、SQLite、按需Node、主程序优先/Harris后置保持，未stage/commit/push，整体goal active。

## 上一前沿（R51，历史验收）

R51完成10阶段隐藏 Native 跨入口设置切片。真实 run `689bdffde00d4dcd8ed3559de680511c`、PID33249自然exit0；原12阶段及七项必需侧报通过。专用测试入口挂载生产 `SystemPanel(panel=settings, settingsMenu=general)`，不启动完整 `App`，也不进入默认产品入口。测试刻意让数据库对外布尔值为false而OS实际状态为true，确认原Vue与Svelte均读回OS真值；开关false/true在两侧和fresh重开后保持一致。Svelte普通placeholder保存不覆盖启动状态字段，未知marker保留；陈旧CAS产生真实冲突，显式重读后显示OS当前值。`read/change/save=3/2/1`，原始数据库SHA前后均为`9e64883075932153ee83ba7ead3ba5853dfd9b618a6c74953713e4969f931cfb`，raw `launchAtLogin`仍缺省。

进程自然终结；窗口、Child、session、layout、pending均归零，observer为2/2移除，activation/focus/key计数为0；现代OS启动项已注销，临时root及app bundle均删除。1358份Native输入SHA `7d3e0dd5dd16474bd707e298853e4d8d2911d92b19b6b05abdb6f22333cb362d`、binary SHA `a075263603c3a9cfa613d170c219c9fc7eeab059ef916af9151b4bbd77f8501f`与receipt `1793250784539`稳定。Main 593564B、Settings 788644B，原预算保持；QA fallback资源716654B，仅由专用测试入口加载，不进入默认产品入口。Root已复验定向Rust 11项、最终Node gate 20/20、workspace check及当前Native example build通过；20项是最终gate套件，不是跨批累计。严格validator对同一原始Native产物复算通过，没有重跑Native GUI。原始证据：[Native报告](../../../output/renderer-settings-input-native-2026-10-27/run-689bdffde00d4dcd8ed3559de680511c/native-report.json)、[跨入口报告](../../../output/renderer-settings-input-native-2026-10-27/run-689bdffde00d4dcd8ed3559de680511c/native-login-cross-entry-report.json)、[独立复算记录](../../../output/renderer-login-cross-entry-2026-10-29/verification.json)、[R51验证摘要](../../../output/renderer-login-cross-entry-2026-10-29/verification.md)。

Ticket38仍in-progress：这证明隐藏测试入口中的生产SettingsPanel跨入口状态读写，不证明完整App启动。旧启动项关闭/迁移仍未实现；6707和77444两次旧失败保留，修复后使用新run验收，不修改旧报告或放宽门禁。可见像素、材质、IME、物理键、完整普通启动、重新登录、旧macOS/其他平台、发行及整应用性能仍开放。默认Svelte、SQLite、按需Node及主程序优先/Harris后置不变；未stage/commit/push。

## 上一前沿（R50，历史验收）

R50补齐Svelte回退设置页的OS状态来源与保存隔离：专用开关挂载读一次、点击单次CAS，复用原Vue的login_items backend和General串行门；普通Native表单无条件省略launchAtLogin，服务端拒绝混入该字段的Native补丁。未知状态明确禁用/重读，独立概览不再以旧DB bool显示手动启动。整页mock IPC证明DB=true/OS=false、专用变更不触发普通保存/DB改写/广播、重挂载读回true。保留预览持久化与原UI样式，未切默认入口。

Main独验Rust General74、前端6文件59、check0/0、workspace和默认Svelte build通过；独立审查P2原型键错误映射已修复。真实事件传播RED、首次宏注册编译失败、旧mock协议/完整快照断言失败均保留并修正。Native1343输入SHA f7d26013a0a1f7dd726d641837888e78f905578536a8e382b87246f311f751c8前后稳定，新增/变更Native5文件全部≤500行，无删除/依赖变化。证据 [R50 verification](../../../output/renderer-login-state-source-2026-10-29/verification.md)。

R50当时没有新命令的Native GUI/真实IPC验收，不借R49二进制背书；来源一致的跨入口运行由上方R51补齐。ticket38旧启动项关闭/迁移仍未实现，候选[迁移合约](../../contracts/ztools-legacy-login-item-migration-2026-10-29.md)明确不bootout当前app、持久恢复和可丢弃登录环境的验收要求。可见/物理/IME、其它平台/发行和整应用性能仍开放，原版主程序优先、Harris后置，目标active，未stage/commit/push。

## 上一前沿（R49，历史验收）

R49原General开机启动完成本机macOS27.0 hidden现代系统切片。原checkbox false→true与实际SMAppService读回true、fresh Child true、可信Rust入口外部关闭、原checkbox CAS冲突回滚true/getter拒绝、fresh Child false、注销精确NotRegistered与owned全回收通过。最终run `1fa005452b70485c9916c412e20974b6`、PID1507自然exit0；原12阶段与六必需侧报同轮通过，新侧报已接正式Node必需门禁。child/session/layout/pending为0，观察者2/2，焦点/激活/系统key事件0。没有把47.496秒整段验收当启动或API基准，完整证据 `output/renderer-launch-at-login-2026-10-29/verification.md/json`。

共享Rust backend采用公开SMAppService（API下限13），去掉launchctl文本判断与子进程查询；app-aware scope、原始OS状态、CAS/回读/补偿、同一operation锁和proof撤销阻止迟到注册。Child共用General有界队列，仅一次设置IPC，原Vue/CSS未改。冷启动实际NotFound→Enabled→NotRegistered被旧模型误拒，先RED后修正；Unknown/接口错误仍不可用，批准/旧配置错误保留。首轮df7…失败资源经独立API确认注销后另行回收，旧报告保持失败；第二轮82c…实际业务成功但末次控件未mount，修复有界真实DOM等待后最终通过，无放宽门禁。

最终1342 Native输入SHA `9c6ea71c649f67ed40ce2e17790b952434eb17b1aa24c974005fccd99c71cdf7`、binary `c289c96824a51114eedc53a883fee4e8eb1cd4b537b4243b0a3673843802dce3`、收据1793243208303前后稳定。新增/扩展模块≤500行；原巨大commands提取减少17060B仍11999行，历史大文件治理未完成；根Cargo/锁/lib不改。早期General68、renderer411/1ignored，后续模型14、当前正式bundle读取1、前端12文件130、最终Node27模块173、正式strict资源构建/审计、final workspace及fresh example/真实运行通过；各批检查时点与源码差异明确记录，不累加套件或为仅QA等待修复重跑无关全库。

Main JS593564B/593920保持；Settings788644B，相对R47+2462B，有限去重回收296B后明确增加Settings预算4096B：有效790459/绝对790528。历史政策与失败保留，见 [预算决定](../../contracts/ztools-launch-at-login-budget-2026-10-29.md)，不声称整应用性能达标。ticket37仅verified-scoped；[ticket38](../../../.scratch/original-main-native/issues/38-legacy-login-item-migration.md)旧启动项关闭/迁移及跨Svelte入口状态为默认推广前必要工作。可见/物理/IME、show取消、重新登录启动、其它平台/旧mac及发行性能仍开放。原Svelte回退、SQLite、按需Node和主程序优先保持，Harris插件后置，整体goal active。

### R48 历史验收（保留原批次来源与数值）

R48 正常foreground/settings路径也复现初次show失败，当前会话只读返回screenLocked=true/loginDone=true、onConsole未知；没有核实物理屏幕，也不能回推R36会话。已请求解锁，保持可见UI、材质/IME及show取消未验收。唯一Native改动是QA controller在初次show失败时输出固定分类并立即经既有finalizer退出；不改生产show或放宽门禁。最终父run `4c8c2604-9f53-4cd7-8978-9467299149d0`，PID54109/54123均macos-activation-unconfirmed、自然exit1、后续stage0、settings未初始化、自有资源清理完成。正式runner保持失败；两case失败反馈由93223ms缩为4382ms，仅为测试流程时长。Main后处理修正not-run占位的错误null断言后对同一原始产物复算通过，未重跑Native。

相关Native fixture191项、workspace与fresh example通过；相对R47仅controller1文件变化，无删除或超500行模块。1331输入SHA `e222071f938bf28740d7719a292be229ee3c0096073d3af08c5aa792a3e0d369`、binary `b000d6f04a3b4ae02c08fb86c8ee579816d0ee61c34e72bf335901ab856853c8`、收据1793235495182稳定；Main593564B/Settings786182B与固定预算不变。证据 `output/renderer-visible-main-2026-10-29/verification.md/json`。ticket26/36保持开放；会话前置条件未满足时不反复盲跑，下一独立功能按[ticket37](../../../.scratch/original-main-native/issues/37-general-launch-at-login.md)交付原General开机启动：共享OS注册backend、真实状态/补偿、unsupported及Child窄setter。当前仅完成原版/现有调用链核对和派单准备，不宣称实现；默认Svelte、按需Node、SQLite和主程序优先保持，整体goal active。

### R47 历史验收（保留原批次来源与数值）

R47 原General“自动返回到搜索”完成指定macOS hidden原页面→生产一次性调度→原搜索回调切片。真实原控件校验七项并保存30s；同一个Settings Child切“所有指令”以启用原SubInput后输入，隐藏后150ms仍保留、30038ms实际返回并清空。fresh Child读回30s，原控件改immediately后同路径57ms返回；已在搜索页时非空查询隐藏后57ms清空。恢复effective baseline never且未知字段保持。run `be7a7b4acefa4b75a4c5d72a68c72128`，PID90850自然exit0，自有资源清理，child/session/layout/pending均0，观察者2/2、焦点/激活0。单次隐藏夹具观察不当成整应用延迟基准。证据 `output/renderer-auto-back-search-2026-10-29/verification.md/json`。

Core原19字段后追加autoBack为20；Child保存/确认不加第二次IPC。Native只在hide后采样期限，show取消Waiting，Returning合并重复hide，Exit/Destroyed取消并回收两类句柄；共享Window角色、generation和主线程claim/oneshot防迟到，真实runtime Drop见证通过。Main复用原通道，无新增listener/入站命令，closed旧fence不再误挡全局返回。Main593564/593920B余356（较R46少327），Settings786182B/有效786363余181、绝对786432余250（较R46少154）；共享UTF-8计量、去冗余状态/校验，未抬预算或改原Vue/CSS/词典。

Core相关25、前端21文件207、Native renderer相关401/1ignored、timer11、Node25模块159、严格产品/选定测试TS、workspace与两份正式资源构建通过。后续变化仅QA就绪/页面路径，生产代码哈希保持，最终fresh build和实际Native覆盖修正。1331份Native输入SHA `657aba02f960f3c37ef225074e79f49bac56211cb7e30616bc33b0c02827c7aa`、二进制 `744b326a8b83d75b0e244364666ff2331eee066a1679a7322f2b0dd715f6dcd0`、receipt1793233747770前后稳定；相对R46变27份，无删除或超过500行的变化代码，commands/lib/根Cargo清单与锁保持。保留两次预算失败、Root漏传源码路径预检失败、原控件就绪及General本无主输入框的两次QA失败，均按具体事实修正。未反复重跑未变的冷启动场景。

新auto sidecar由Main对原始UI/DB/DOM/计时/清理事实独立复算并由另一Luna只读核对；旧五门禁和12阶段保持，未声称新sidecar已进入旧五门禁。下一批沿ticket26推进可见主程序及真实show取消验收；可见像素/材质/IME、其它期限长时等待、Windows/Linux、完整普通启动/默认入口、剩余General/Shortcuts及整应用性能仍开放。Harris原包插件与可选同步保持各自后置范围；默认Svelte、SQLite和按需Node路线不变，整体goal active。Gemini参考继续按既有源码取舍表使用。

### R46 历史验收（保留原批次来源与数值）

R46 原General窗口位置与剪贴板保留/重置完成指定macOS hidden切片。原四策略及30→1→180均经原控件、独立SQLite和fresh Child读回；生产隐藏主窗cursor/primary/缺外部上下文fallback实际(712,414)，remember保存非居中(776,478)→移开→恢复。修复2倍屏逻辑坐标先floor的生产偏差与fresh同值保存误报；未确认收据仍拒绝，不增加重复配置IPC。私有DB与模拟PasteboardBackend通过生产capture证明过期未固定条目清理、pin保留及重置不删历史，默认统一180且明确90保留，零系统剪贴板访问。证据 `output/renderer-general-policies-2026-10-29/verification.md/json`。

最终同一来源/二进制的settings run `5aba4b72983f47a6aed455fdfc9e95c5`（PID15765）、R45回归 `9594607b7c574d1e8ec95bfa8addd029`（17098→17118）、R39回归 `db1fcfb80e144f0b8537305674a3cc3c`（17252→17454）均通过，五进程自然exit0并回收自有资源。1322份Native输入SHA `909c6d14c2835e107ab6adf56d360f06bf0fabf7dc9d91ef4cfee3b8b10d5fb4`、二进制 `d19c2d2adffb6fe09ad6167d9d60fd3ea22354dd4672748392c1e49e3ac6fdbe`、实际构建收据1793229436216与正式资源前后稳定。相对R45变化34份Native输入，无删除/超过500行的变化模块，commands/lib及根Cargo清单与锁未变。来源/QA编译、投影与重置断言、收据路径、真实取整和同值保存的失败与修复证据保留。

Core串行356/3ignored、最终Native相关517/1ignored、前端14文件152、Node25模块159及启动13、Pasteboard集成9、严格TS、Svelte0错误/警告、正式Settings strict构建和workspace通过；套件不累加。首次Core媒体wall-time失败后独立串行通过，未改性能阈值或matcher。Main JS593891/593920B（余29）；Settings786336B较R45增231，有效786363B（余27）、绝对786432B（余96），未抬预算或改原Vue/CSS。

下一批先收敛资源余量，再接General自动返回搜索，剩余范围见 [General剩余控件](../../contracts/ztools-general-remaining-controls-2026-10-29.md)。可见像素/材质/IME、物理唤起/双击修饰键/全局录制、外部活动窗口实际跨屏和混合DPI、Windows/Linux、完整普通启动/默认入口、其它设置和整应用性能仍开放。当前lastActive hidden仅验缺上下文fallback，material仍visual unverified，不能当成完整原版对齐。默认Svelte回退、SQLite与按需Node保持，整体goal active、主程序优先，Harris原包和可选同步随后按各自范围推进。Gemini补充附件与既有源码采纳表一致，参考使用，不改变架构或优先级。

### R45 历史验收（保留原批次来源与数值）

R45 macOS主快捷键启动恢复完成hidden Native切片：生产共享初始化函数安全拒绝无效键→原General显示空注册态→原控件保存其它设置仍保留无效原值→原HotkeyInput修复B，DB/owned/Tauri manager一致→首进程保持B至自然退出→同DB第二进程由生产共享函数注册B并原General读回→释放确认。run `d1e1cb1858a345a0afdd06818cecda59`，PID38116→38147，同DB device/inode一致，18/13项事实及归属校验通过。最终同一二进制还通过旧R44设置输入回归 `21a7d4ecfeb943288926455f41995d40` 和R39持久状态回归 `2478b94ba9c74a9a9e2f357f8097b0dd`；五个进程均自然exit0并回收自有资源。证据 `output/renderer-hotkey-startup-recovery-2026-10-29/verification.md/json`。R44普通组合键冲突与精确Toast历史验收保持；下方旧数值仍是各批历史证据。

R45时Main JS593891B/上限593920B保持；Settings全部资源786105B，较R44减少22B。R44有效预算baseline784315+2048保持786363B余258B，绝对786432B余327B，R45不提高上限。Child与旧Svelte writer/session共132通过，Native相关459/1ignored、不带legacy smoke的生产路径274/1ignored、旧Node144及R45 runner/report/probe13通过，Svelte0错误/警告，strict构建与workspace通过。所有crates与R44字节一致，Core353/3ignored沿用旧基线、R45未重跑。46个Native输入变化无删除，commands/lib保持且变化模块<=500行；1304输入与fresh二进制/receipt在三条实际运行前后稳定。已保留known候选补偿、QA编译/报告路径/导出名/隐藏blur的失败与修复证据。原Vue/CSS、默认Svelte回退、SQLite与按需Node路线保持。

R45共享函数同DB冷启动不替代完整普通启动、可见恢复入口及物理系统键。R45计划后续的位置/保留期限切片现已由R46交付，其余缺口仍以上方当前前沿和剩余控件表为准。

## 固定输入与范围

- 产品方向：[ADR-0002](../../architecture/adr-0002-original-renderer-and-optional-private-sync.md)。默认离线核心、SQLite 数据、权限和 TaskRun 管线继续保留。
- 原版 UI：外部只读 ZTools commit `9b15fb1a2a9f3ec886016632761c7bb21e39557a`，Vue/CSS 不改，保留 MIT 版权和构建来源证据。
- 私有同步协议：Go 上游 commit `8ae1e14fd1071b6762fdb59f05162bc0779a5564`；真实接口见 [协议契约](../../contracts/ztools-sync-protocol-2026-10-26.json)。不把完整协议支持作为首个子集已经完成的事实。
- 第二份 Gemini 材料按 [源码对照表](../../architecture/2026-10-26-gemini-reference-triage.md) 使用，不直接照搬伪路径、性能数字或兼容百分比。
- 新增插件补充按 [插件参考核对表](../../contracts/ztools-gemini-plugin-reference-assessment-2026-10-27.md) 使用：沿用现有模块、SQLite 和按需 Node，不直接采纳同步 XHR 延迟、无损状态快照或完整兼容断言；不改变当前主程序优先级。

## 当前可独立验收的批次

| 批次 | 实施归属 | 交付与验收边界 | 状态 |
| --- | --- | --- | --- |
| R1 固定原版 UI 构建 | `packages/ztools-renderer/build.mjs` 与 manifest | 固定 commit、干净上游、源文件/依赖/适配器摘要；编译原版 Vue/CSS；全部JS≤589,824字节，较前批570,144增量≤16,384；默认Svelte预算独立 | 当前578,997字节，增量8,853；旧门槛失败及预算调整保留 |
| R2 类型化宿主适配 | `packages/ztools-renderer/src/` | 应用/插件只读目录、设置读取、受限搜索偏好写入、统一 TaskRun 管线应用启动意图；不支持项显式报告；本地图标分析和销毁 | 最新85项renderer测试及严格类型通过；真实原生执行尚待验 |
| R3 原生应用目录 | `src-tauri/src/launcher_app_catalog*` 与注册 | 仅主 WebView，固定根目录/深度/数量/缓存预算；测试只扫临时目录 | 主 Agent 5 项测试通过 |
| R4 原版页面浏览器验收 | browser runner 与专用 fixture | 真实原版 DOM 搜索、键盘选择、启动意图、搜索偏好、Esc 和四种主题；仅临时 transport，不启动用户应用 | 最新15项检查、6张截图；真实CDP拖拽排序通过，来源稳定、资源全回收；非原生系统启动证明 |
| R5 可选 Tauri 入口 | 独立配置与 renderer README | 显式选择新 dist；不改默认 Svelte；不混入旧 devUrl/构建命令 | 配置及4项静态检查完成；隔离真实主WebView见R10，普通完整启动和setting窗口仍未验 |
| R6 启动设置批读 | core settings、renderer_settings、settingsSnapshot | 固定14键、main-only、有界SQL读事务、general字段投影；并发共享1次IPC；真实临时SQLite重开读取 | 本批完成；设置读取11→1；原版页面重启排序仍待验 |
| R7 焦点和退出生命周期 | focusEvents、Tauri transport、windowNotifications | Window/main focus；原版清空/保留全选；void单向布局；pagehide/迟到注册/退出后迟到layout | 浏览器接线及R10真实macOS窗口往返通过；外部应用上下文和自动粘贴未验 |
| R8 应用历史与固定 | Core事务、appState、startupReadModel、native coordinator | namespaced写入与revision原子化、别名身份、跨域乱序通知、先启动后记录、同序排序ack、旧读竞态 | Core11项最终定向、native应用10项、前端集成通过；混合插件排序和原生端到端待验 |
| R9 原生右键菜单接线 | renderer_context_menu、contextMenu、Window/main事件 | 有界会话/nonce/单次消费；RPC返回前选择；未知动作禁用；popup blur guard | native菜单9项及原版Vue四次菜单选择通过；真实OS弹出/焦点未验 |
| R10 隔离真实主窗验收 | app_builder、app_lifecycle、renderer_desktop_smoke、native runner | 生产共享宿主与真实原版Vue；临时SQLite/独立bundle identity/非持久化WK；真实show/hide/blur/return及dispose；构建来源绑定与归属清理 | 两种偏好各9阶段通过；33项fixture、26项窗口回归、15项Node与workspace check通过；预期失败用例实际exit1，资源回收通过 |
| R11 原版设置构建与偏好存储 | packages/ztools-settings、core General CAS、native命令、generalSettingsClient | 全设置app独立构建；上游只读、模板/style块不改，可追溯stage类型/竞态修复；真实有界SQLite写入/CAS/持久化、main-only命令、串行客户端 | 正式完整设置strict已通过，12项错误清零；51资源749,163字节，原失败候选保留；Core/client证据见前批、写协调见R12；openSettings/同窗frame尚待接线 |
| R12 General 写入口与系统设置协调 | core General write plan、general_settings_runtime、旧设置与剪贴板调用方 | 统一 CAS/最新字段patch、Native效果/补偿、AI失效、32准入、关闭后owned事务和会话快照归属 | 本地代码与隔离回归完成：Core310通过3忽略、Native23、前端194；源/必要调用方TS与Svelte、workspace、fixture feature编译及浏览器回收通过；真实OS副作用仍未验 |
| R13 设置正式构建与子视图隔离前置 | stage compatibility、resource budget、webview command policy | 原严格项目全量检查；类型擦除等价与captcha迟到回调；全资源双预算及拒绝替换；app dispatcher拒绝child、插件权限精确匹配Webview | 补丁与预算脚本、负向预算构建、4项纯policy及workspace通过；正式dist55文件780,478字节；真实Child IPC与主Window角色迁移尚待验 |
| R14 主窗角色与真实多视图承载 | window main roles、固定顶部布局、app-state通知、native双模式夹具 | 同窗父/子真实身份；main成功而child app/core/fs拒绝；固定header、实际缩放与焦点；单slot RAII、重开新身份与归零 | 本批单/双模式各两种偏好九阶段通过；Rust窗口30、renderer64、Node26、workspace通过；正式设置包/窄API/General DOM尚未接入，默认入口不切换 |
| R15 原版同窗设置接入 | settings child session、窄API、General DOM、shared lifecycle | 原头像/Cmd+, 同窗正式设置、五字段CAS、主窗通知/返回、权限与退出回收 | 已完成指定切片；设置与generic多视图两种偏好共36阶段通过，完整设置未验 |
| R16 搜索与键盘General偏好 | 13字段Core/schema、单事件通知、原控件与Native探针 | 新增八项DOM编辑→SQLite→main接收→重开读回；13项cold seed、实际搜索结构、只读/错类型拒绝 | 本地验收通过；Core312/3ignored、Native103、Main127+strict、VM、正式构建和workspace通过；实际指令执行、OS/物理输入/像素和完整产品继续开放 |
| R17 原renderer资源余量 | callbackRegistry四处复用、child双Proxy共用handler | 不改原UI/依赖/预算，保持派发时序/异常/receiver和13字段行为，以新dist回归 | Main130+strict、child16及API、Node26、正式构建及新dist Native36阶段通过；JS减少214至586,299、setting资源减少130至765,325，余量229/165；完整目标继续 |
| R18 原Vue键盘与自有应用启动 | catalog source、真实Mach-O探针、Native/Node独立证据 | 原DOM搜索/选择/Enter或Space→持久权限→TaskRun/关联审计→实际应用→历史与退出回收 | 1067输入构建launcher/settings两偏好各18阶段通过；generic焦点回归失败，1069输入诊断仍失败并全部回收；107 Native/43 Node通过；整批继续in-progress |
| R19 原Vue系统应用图标 | 受限资源协议、AppKit离屏PNG、原图像分析 | 原懒加载→当前catalog成员→64×64真实图标，2worker/128在途、256项/8MiB缓存及取消计费 | 15图标/11catalog/107renderer Native、131前端、43Node、strict/正式构建/default workspace通过；JS586470余58；已fresh绑定，console locked，实际Tauri图片/窗口仍待验，整批in-progress |
| R20 原版应用目录实时刷新 | Native FSEvents、catalog失效、appCatalog及onAppsChanged | 固定根/有界事件、先失效再main-only通知、单flight与过期/退出拒绝、实际私有根变化及回收 | watcher8/renderer108/catalog5/source8/icons15通过；原JS587111预算拒绝已由R21正式586524与fresh绑定收敛；完整Tauri事件→Vue/可见页面仍待验，整批in-progress |
| R21 兼容目录与受控构建发布 | host method/event目录、stage/锁/回滚、原版浏览器夹具 | 保留真实Interface、收敛R20预算；失败候选不覆盖已接受dist；六类通知的原页面/退出验证 | 指定资源切片完成：Main142/strict、Node45、正负CLI/workspace通过；JS586524余4；1080 Native输入fresh绑定；headless原Vue14检查/6截图通过并回收。真实Native事件→Vue与可见UI继续待验 |
| R22 隐藏原版应用目录页 | fixture owner/profile、真实FSEvents、main事件、原Vue列表、真实PNG/CORS | 自有hidden Tauri完成新增/删除/退出后事件链、图标解码、旧路径拒绝和资源回收；不请求前台 | 五阶段实际运行和独立审查通过；ticket12本地hidden slice完成，ticket09/10可见UI/焦点/错误占位仍开放；完整目标保持进行 |
| R23 主搜索框拖窗 | 同版Fuse basic、前端有界队列、main-only Rust几何与尺寸锁 | 原Vue鼠标事件→实际隐藏窗口移动、锁内改高、释放及恢复；旧catalog链与回收同时回归 | R23 五阶段 hidden 拖动切片保留；R24 真实十阶段 Native 补验活动锁 hide/navigation，ticket13/14 的隐藏生命周期项完成。可见/物理/多屏及完整目标继续开放 |
| R24 拖窗生命周期与启动回搜索 | Native 尺寸锁 hide/navigation 清理、原版 `onAppLaunched`、pasted 与 typed-query 清空 | 隐藏 Native 实测旧/新文档生命周期；原 DOM 分别验证失败保留和成功清空；严格分开 fixture 与真实 OS 启动证据 | Native schema2十阶段 run `066cc4fd` 通过，window ticket 13/14 完成；browser `66d74695` 14项/6截图通过。真实 Native 应用启动通知/隐藏链未运行，ticket15 in-progress；Main JS586447/586528余81 |
| R25 隐藏 Native 启动回搜索 | 独立 `launch_return_journey` 与 Node verifier | 原版 Vue + 真实生产 launch/permission/TaskRun/history/hide 链；仅自有 `LSBackgroundOnly` fixture apps | macOS hidden profile Native 七阶段与 Node 独立校验通过，双探针 terminal、source/binary稳定且 owned cleanup 完成；ticket15仅此隐藏切片 DONE，可见UI/默认入口仍待验 |
| R30 隐藏原生设置输入 | 私有呈现policy、AppKit观察、独立settings-input journey与严格runner | 原Main→Rust→原Setting真实目录筛选、反向值、owner切换、退出/重开、来源和owned回收 | 十阶段/独立校验/真实exit0通过；227回归、Node23、default workspace与legacy-only编译通过；可见UI和重开后旧session显式重放仍开放 |
| R44 原版主快捷键普通组合键 | Core17字段、owned registry、General事务与intent fencing、原HotkeyInput | 修改/重开、真实占用拒绝提示与状态保持、权限边界、恢复及退出回收；固定低碰撞QA键，无OS按键输入 | macOS hidden28事实/旧12阶段通过；两进程持久状态回归保持；物理唤起、双击修饰键、全局录制与主键冷启动未验，完整目标active |
| R45 主快捷键启动恢复 | 无注册态owned checkpoint、共享startup函数、原General空展示与显式修复、旧Svelte writer保留 | 无效原值保留、同DB两进程修复/退出/重注册/读回、未知状态封锁、旧回归与回收 | 指定macOS hidden切片通过；全普通启动/可见恢复窗口/物理键未验；Main/Settings预算不提高，完整目标active |
| R46 窗口位置与剪贴板保留 | Core19字段、原General控件、Child同值确认、生产position/capture | 四策略保存/重开、逻辑先floor与remember恢复、30→1→180清理/pin保留/重置不删、来源/退出回归 | 指定macOS hidden实际切片通过；外部活动窗口跨屏/可见/非mac及整应用性能未验，资源余量27B，完整目标active |
| R47 隐藏后自动返回搜索 | Core20字段、原General/同session所有指令、单次Waiting/Returning与原回调 | 真30s/立即/搜索态query清空、fresh读回、原始资源计数与真实future回收、固定预算 | 指定hidden实际通过：30038ms/57ms/57ms；可见show取消/IME/其它平台未验，Main与Settings资源净减少，完整目标active |
| S1 独立私有同步服务 | `crates/atools-sync-server/` | 认证/刷新、WebSocket 线性文档同步、tombstone、snapshot 和 checkpoint；独立临时 DB 测试 | 本批18项单测、3项回环集成通过；完整Go协议待补 |
| S2 服务资源与数据边界 | 同步服务预算、路径守卫、事务测试 | 连接/认证/push/pull 准入；阻塞工作取消后仍计费；完整消息预算；拒绝桌面数据目录；不支持的冲突分支不写入 | 本批静态复审、预算/路径/回滚测试及连接回收集成通过 |
| V 当前批次收敛 | 主 Agent | 定向测试、相关集成、workspace check、来源/文件规模/锁文件与资源回收审计 | 已验当前批次，完整目标保持进行；证据见下 |

## 后续迁移门槛

原版页面的浏览器成功不能替代 Tauri WebKit/WebView2、系统应用启动、窗口材质或完整插件生命周期验收。R1–R5 通过后，仍需补齐原版设置入口、真实事件推送和插件启动/关闭，再考虑默认入口切换。不得通过隐藏错误或伪造返回值满足旧页面。

同步服务首批主动限定线性 revision；完整 revision tree/冲突合并、附件、实时广播和自动快照阈值仍需后续纵向交付。未实现项在能力协商和 README 中明确声明；不把 source contract 与 Rust 子集等同。

Harris 原包兼容保持后续优先级；当前先交付主程序入口和共用基础。插件商店、SubInput、detach、Node/CJS 优先复用已有模块。没有实测瓶颈时不替换 Node、不迁移 SQLite，也不新增并行运行时。

## 验证与证据

初批证据集中在 `output/atools-replication-2026-10-26/verification.md`。前一阶段R6/R7证据在 `output/renderer-activation-batch-2026-10-26/verification.md`，最终browser report为 `output/playwright/ztools-renderer-browser/browser-1db19779-c108-4627-8dce-3b47d9372841/report.json`。该阶段前端56项、native设置7项、Core串行288项通过（3忽略），workspace check通过；全部JS570,144/573,440字节。失败结果保留，未提交/推送。该阶段后续工作包含真实原生唤起/焦点、原版设置入口、历史与固定、自动粘贴权限和插件生命周期；本批历史/固定进度见下一节。

## 应用状态批次收敛

最新证据：`output/renderer-app-state-2026-10-26/verification.md`。原版Vue与CSS未改，使用单canonical应用和真实command-aliases配置，实际页面验证分名历史/固定、pin/unpin/remove与鼠标拖拽；回执事件revision 1–7，四次菜单选择先于模拟popup回复。应用状态有界拒绝，不截断插件或未知记录；混合插件完整排序仍limited。

全前端85项、严格TS通过；native renderer筛选30项通过（其中应用10、菜单9、设置7及已有窗口4）；Core全回归299项/3忽略后，最终同序排序ack改动另以11项定向复验；workspace check通过，保留197条既有警告与nom提示。旧budget失败日志及本阶段576KiB总量/16KiB增量双约束可复现。未新增包依赖或常驻Node，未提交、未推送；真实Tauri/OS菜单与启动、设置入口和自动粘贴继续开放。

## 真实主窗口批次收敛

最新证据：`output/renderer-native-2026-10-27/verification.md`。生产宿主构建、命令注册和窗口事件抽为共享模块，普通启动仍注册原12个桌面插件。隔离入口省略普通桌面启动服务，原版Vue在真正Tauri主WebView运行。真实首轮暴露“先激活应用失败、后续焦点请求未执行”的生产顺序问题，现先聚焦已显示的自有窗口，再保留原激活验证。

最终正向报告 `run-473f399b-e0f4-464b-88b8-55186ae17642/report.json`：立即清空和保留全选分别九阶段；Native/DOM/自身前台身份同轮成立，实际WK store为非持久化，剪贴板尝试为0，dispose后真实焦点往返没有新增回调/调用。固定文本由DOM setter输入，不能称为物理键盘验收。退出改用fixture专用`run_return`后，实际负向身份错误报告仍失败且进程exit1；正常/负向均确认进程结束后才回收自有目录。初轮真实失败和旧退出码错误的证据保留。

最终fixture33项通过，窗口回归26项、runner15项通过；workspace check通过并保留197条警告/nom提示。988文件native源码与当前构建二进制绑定，Vue/CSS及15个适配TS来源未变，全部JS仍578,997字节。真实系统菜单、应用启动/TaskRun、窗口材质/物理屏幕效果和跨平台仍待验。

设置的源码核对已纠正为**主窗口内的原版setting插件视图**，不另建设置窗口代替。入口契约和离线依赖缺口见 `docs/contracts/ztools-renderer-settings-entry-2026-10-27.md` 与 `docs/contracts/ztools-settings-build-dependencies-2026-10-27.md`；后续先交付General页真实读取/保存/重开/退出。当前不切换默认入口，完整目标继续进行。

## 设置接入准备批次

最新证据：`output/renderer-settings-2026-10-27/verification.md`。隔离设置包使用其自身上游lock的确切版本及显式补齐依赖，安装不执行脚本；没有改主程序manifest/lock或上游。完整setting/shared原样暂存，两个原TS项目均执行。Node config通过，web源码12项类型错误使正式构建拒绝。仅显式review模式生成独立候选，provenance保留失败、诊断与hash，进程仍exit1；不得把候选、编译或源文件存在算成设置UI验收。

General存储用Immediate事务CAS，严格限制五类偏好/字节预算，保留unknown字段，旧快照冲突拒绝。Native命令只向main WebView/Window开放，commit后通知失败不冒充回滚；client合并读取、串行写入并限制32个pending，迟到读取/退出均有检查。Core完整306通过（3忽略），native上下文1、客户端19、严格TS和workspace check通过（197条既有警告）。本批没有运行GUI，完整同窗General读取/保存/重开/退出仍未验；默认Svelte和按需Node不变。主renderer重新构建，16个适配TS来源纳入provenance，JS仍578,997字节。

独立复核发现旧 `set_setting`/剪贴板窗口的整对象写回仍可覆盖新值，故上述CAS保证只适用于专用调用之间；ticket04必须先统一生产写入口，再接通ticket03的新可写UI。已派发写入遇dispose的P2已改为结果未知/requiresReload，并用先提交再迟到回执的fake持久层验证。未把本地取消等同数据库回滚。正式设置包的12处上游类型错误、frame身份/资源与生命周期接线仍开放。

## General 写协调批次

最新证据：`output/renderer-settings-coordination-2026-10-27/verification.md/json`，ticket04 已完成指定入口的本地代码与隔离验收。旧整键 General setter 拒绝写入，六个旧系统设置 setter IPC 撤下；旧设置面板、剪贴板 dialog、capture pause 与 renderer mutation 使用同一 Rust coordinator。系统效果仅执行变更字段，失败补偿、CAS 提交、AI 失效和通知在同一已接收事务生命周期内完成。正常已建立编辑租约的保存由七次前端 IPC 收敛为一次；此为调用链结论，不是时延或 RSS 测量。

主 Agent 独立审查又发现了“销毁 flush 丢失 lease 后用最新 raw 保存旧整对象”的旁路。编辑器现绑定 opening raw 并在有效回执后推进私有快照；Native 和 preview 的卸载并发回归均通过，迟到回执不能更新新 lease。浏览器 quota 失败会显示保存失败并恢复旧值；前端及 Rust 准入都限制 32 项。Core 全回归310通过（3忽略），Native23、24个前端文件194项、严格TS/Svelte、Node协调脚本、预算/构建、workspace与Native fixture feature编译通过。最终自有浏览器运行 `2c8c34a0-ae2d-40ca-9592-e1ae7496b030` 来源稳定且回收完成；仅用strict mock IPC，不作为Tauri或OS验收。

首屏静态JS图475,092/573,440字节；新增模块最大473行，五个根manifest/lock未变。默认Svelte入口继续保留，原版setting同窗frame/openSettings与12项已知strict错误仍开放，下一批回到ticket03；真实OS系统设置效果、菜单、应用启动和插件生命周期保持未验收。完整目标继续进行，未提交或推送。

## 原版设置正式构建与子视图前置批次

最新证据：`output/renderer-settings-view-2026-10-27/verification.md/json`。上段12项strict错误现已清零：完整原setting/shared以固定版本暂存，只在自有stage应用5文件可追溯补丁，保留上游干净及原模板/style完整块。四项类型文件的固定scope编译擦除输出一致，验证码修复以真实组件的迟到A/B与重试验证。完整原tsc、vue-tsc和Vite正式构建通过，正式dist为51运行资源749,163字节（含元数据55文件780,478字节）；旧失败review候选保留。

预算固定基线749,106字节、增长≤16KiB且总运行资源≤768KiB，涵盖CSS/图片；真实负向构建因预算超限exit1、原dist摘要不变且临时策略恢复。最终预算脚本还核对完整目录集合、每项hash及symlink拒绝。16个编译CSS仅有三个已知SFC scope ID变化，其他样式内容及静态资源一致；这不是渲染视觉验收。构建保留两条原版跨chunk循环引用警告，尚须真实页面验证。

主窗ChildWebview的前置现在明确：Tauri 2.11.2加child后旧get_webview_window/main包装类型失效，需先迁父Window几何/可见性与主Webview页面/焦点角色。生产app dispatcher已默认拒绝不同名child，默认plugin capability改为精确webview匹配，原权限条目不变。4个纯策略、15个native runner helper与workspace检查通过；没有启用unstable、创建child或做实际IPC验收。ticket05继续实现真实双视图主窗，再接ticket03的设置资源/窄API/General DOM保存与返回搜索；默认入口未切换，完整目标保持进行。

## 主窗多视图承载批次

最新证据：`output/renderer-multiwebview-2026-10-27/verification.md/json`。R13之后现已增加默认关闭的multiwebview feature；父Window负责几何/显示，实际main Webview负责DOM/焦点，历史/固定通知精确发给main。真实同窗固定页面首轮暴露原版空搜索栏收缩前置，次轮暴露比例缩放把64logical顶部变45；失败报告保留，两轮均exit1且自有资源回收。共享固定顶部布局复用既有窗口事件，单slot RAII按ID清理，不加每次挂载listener或常驻布局循环。

最终1,019文件native来源与单/双模式二进制分别绑定，两种模式各两种偏好九阶段，合计36阶段通过。main三类调用成功，child首次/重开app/core/fs均拒绝，实际WK非持久化、main/child焦点、缩放几何、新文档身份及最终child/布局注册零均通过；临时进程、目录、bundle回收。主Agent运行窗口30、renderer64、Node26项与默认workspace检查通过。上游/原Vue/CSS/16个adapter及主JS578,997字节保持；源码/预算证据不替代RSS/时延基准或物理输入/跨DPI验收。

ticket05仍in-progress：固定页承载已验，正式设置资源绑定、窄接口/通知投影和General真实DOM保存/重开/退出回搜索尚未接入；openSettings仍unsupported，默认Svelte未切换。完整目标继续进行，插件仍后置并优先Harris；Gemini补充仅作已记录的参考评估。本批未staging/commit/push。

## 原版同窗设置接入批次 R15

最新证据：`output/renderer-settings-entry-2026-10-27/verification.md/json`。ticket03 的 General 纵向切片和 ticket05 的承载范围已完成本地验收。原版头像按钮和 Cmd+, 进入同一主窗的正式 setting 子 Webview；初开/重开实测顶部58 logical px、内容填满父窗。五字段安全投影写入绑定 opening revision，General DOM 提示文字实际保存到临时 SQLite，主搜索提示收到通知，重开新文档读回；原始未知字段与秘密留在库中。

最终 Native 设置报告 `178ddde8-3ca2-44df-afc3-6edf24b4608a` 与通用双视图回归 `3fdd84e6-edc2-4d05-9a3b-08ce0ac95bfc` 两种偏好均通过，共36个主窗阶段。普通 app/Core 调用、旧 session、未列资源实际拒绝；两种退出恢复 Native/DOM 焦点，session/child/layout/pending calls/writes均零，临时进程、目录、bundle回收。固定版本 Tauri 的拒绝引用是leaf permission，保留实际有界诊断并精确识别，没有增加权限。

主Agent回归：前端13文件117项、最终文案相关4文件55项、严格TS、Native renderer97项、后续probe两项、Node34项及bridge14行为场景和独立VM通过，完整设置原tsc/vue-tsc/Vite、主renderer构建及默认workspace检查通过。1,051个Native输入与二进制绑定，运行前后来源稳定；源码/VM不代替真实App验收。构建预算保持，主JS586,521字节/有效586,528，设置资源765,442/有效765,490；余量分别7和48字节，后续扩展前必须重审资源分配。

默认Svelte未切换，设置当前只开放placeholder/theme/primaryColor/customColor/autoClear；其他动作明确unsupported。完整设置标签、系统动作、菜单/应用启动、物理输入/IME、视觉像素/材质和跨平台保持未完成。未测RSS/CPU/时延或release包体积；没有改Node/SQLite路线，插件继续后置且优先Harris。Gemini补充保留为源码核验过的参考，本地拆单继续；没有staging/commit/push，整体目标保持active。

## 搜索与键盘偏好批次 R16

最新证据：`output/renderer-general-parity-2026-10-27/verification.md/json`。General现开放13项，新增搜索模式、最近/推荐显示、最近/固定行数、Tab模式/目标和Space指令偏好。Core纯校验、Native child及通知schema对齐，Main直接写仍限原五项；保留一次保存/一次通知和32准入。Native/TS两层启动白名单漏字段已修复，行数2.0/-0.0统一规范存储。

真实设置运行 `afd63309-2995-4a10-9c36-f91dd6d66c3a` 两种偏好均验证八项DOM编辑、数据库提交、main接收及新文档重开读回。进入设置前实际main Pinia读到临时seed全部13项；这不是保存新值后的进程重启验收。实际临时搜索产生aggregate结果并清空/恢复焦点，没有启动应用或保存应用名/路径/query；行数视觉上限和实际快捷键执行不在本轮范围。只读与错误类型写入实际拒绝，原保存/通知/权限/往返/退出检查保留。

共用双视图回归 `08a3f793-c321-4f3c-b73c-9d9641f07e3d` 通过，共36主窗阶段，session/child/layout/pending及临时进程/目录/bundle归零。最终Native1055输入与二进制绑定，所有来源稳定；Core312通过3忽略、Native103、Main127+strict、Node校验/VM、完整原设置strict/Vite、main构建及默认workspace check通过。失败日志保留。主JS586,513/586,528、设置资源765,455/765,490 bytes，余量15/35，未重设预算；后续先重审资源分配。

默认入口和插件优先级保持；完整设置、系统动作、应用启动、物理输入/IME、逐像素/材质、跨平台、性能实测及同步完整协议仍开放。Gemini插件补充继续按源码评估复用，不引入LMDB/另一个运行时或未测兼容承诺。未staging/commit/push，整体目标保持active。

## 原renderer资源回收批次 R17

证据：`output/renderer-resource-headroom-2026-10-27/verification.md/json`。既有四处callback快照/调用/错误隔离集中到callbackRegistry；保留各模块门控、逐recipient disposal与错误计数。setting两层Proxy共用get handler，then/symbol/Reflect receiver/own/unsupported语义不变。未采用会增加耦合的微小JSON helper或删掉错误normalize，没有改原UI、依赖、压缩策略或固定预算。

Main全17文件130项+strict、child16及focused API、Node26、Main正式构建和完整原setting两个strict/Vite通过。JS586,299（减少214）、setting全运行资源765,325（减少130），余量229/165 bytes。Native1055输入及二进制摘要未变，验证匹配R16receipt后复用二进制加载新dist。真实设置293880dc及双视图421a15e5，两偏好共36阶段通过；来源稳定，临时进程、目录、bundle与会话回收。没有把资源字节下降称为RSS/CPU或延迟改善。

后续优先真实原Vue搜索/键盘启动链，使用自有临时应用验证生产catalog、权限、TaskRun、历史记录及完整进程回收。当前不以只扩可写字段替代主程序可用性验收；默认入口、系统行为、物理输入/视觉、跨平台、完整同步及Harris原包插件阶段继续开放。未staging/commit/push，整体目标保持active。

## 原版搜索启动与回归批次 R18

证据：`output/renderer-launcher-2026-10-27/verification.md/json`。原Vue真实DOM input/ArrowDown/Enter及Space已启动自有临时Mach-O应用，同一second目标先被持久Deny拒绝，再允许成功；TaskRun.audit_id关联审计、实际marker/nonce/PID退出、数据库history与main实际Pinia一致。未列路径和禁用Space无启动/历史。生产catalog固定来源与预算保留，fixture-only owned source没有向前端开放任意扫描根。

1067输入构建的launcher `60cbe9c4`、setting `39bf7ff0`两偏好共36窗口阶段通过；随后generic `ac4e1348`两例在DOM焦点交接失败，不能合并为54阶段通过。补充独立API/Native/DOM观测、保持80ms及原门槛后，1069输入诊断 `12d0a61f` 两例仍失败：API返回成功、文档hidden/未聚焦，Native前台校验也失败。根因未定，本轮停止没有新观测的重复运行；全部宿主、profile及bundle回收。旧positive保留其原来源绑定，不代表最新诊断构建通过；ticket08继续in-progress。

Root最新107项Native、43项Node定向及语法检查通过；catalog11和生产seam后的默认workspace检查通过。前端dist来源未变，继续R17预算与类型/正式构建证据，不声称重复执行；余量229/165 bytes，未测RSS/时延。失败编译/断言/Native记录及单独的归属清理证明全部保留。Gemini参考另补卸载数据语义和全API验收差异；不改SQLite/按需Node、不进入插件扩展或默认入口切换。未staging/commit/push，整体目标保持active。

## 原版系统图标批次 R19

证据：`output/renderer-app-icons-2026-10-27/verification.md/json`。Root只读系统会话确认locked/on-console，已告知用户解锁条件；未在锁屏环境反复运行foreground，也未改生产激活逻辑。继续补齐实际主程序缺口：catalog从icon恒空改为不含路径的每进程opaque资源URL，原Vue/CSS、懒加载与占位保持。共享Native协议只读当前catalog成员，AppKit在固定清零位图离屏生成64×64 PNG，2实际worker/128在途，256项/8MiB/5分钟缓存；取消后仍计费至实际工作结束，正常计费至响应提交。CORS变体始终Vary Origin/Referer，前端仅精确格式使用cors，不开放任意URL代理。

Root实际15图标（含OS PNG decode）、11catalog、107renderer Native、131前端、43Node、完整strict/正式Main构建及default workspace通过，失败日志保留。Main JS增加171至586470，有效预算586528、余58；setting来源未变。1075 Native输入及宿主/真实probe新二进制fresh绑定；自建icon fixture目录残留0。没有新增依赖包/版本、Node进程或轮询，仅补既有AppKit graphics-context feature。真实Tauri img decode/CORS/错误占位和窗口回归仍未验，ticket09保持in-progress，不把离屏/编译成功当作可见页面证据；默认入口和完整目标均未完成。

下一主程序缺口已只读确认：renderer永久memoize应用列表，onAppsChanged未接入，Native30秒TTL无法单独修复新安装/删除应用的搜索刷新。后续冻结事件驱动失效与回收边界，仍不引入常驻轮询或扩预算。插件保持后置并优先Harris，原有Rust/WebView/按需Node/SQLite路线不变；未staging/commit/push，整体goal active。

## 应用目录变更刷新批次 R20

证据：`output/renderer-app-refresh-2026-10-27/verification.md/json`。原Vue通过既有onAppsChanged重新读应用目录；Native CoreServices事件先使同一source失效，再精确投递main Webview。固定系统根及可选用户Applications根、扫描/缓存预算保持；Ready启动一次、Exit停止并排空，不增Node、轮询或依赖包。私有真实FSEvents已串起新增/删除→失效→同source快照，前端单flight、旧响应/监听失败恢复与warm-cache dispose竞态通过；独立审查指出的readiness未要求实际app-list调用已修复，调用计数不代表成功绘制。

Root实际watcher8、renderer Native108、catalog5/source8/icons15、Main139+完整strict、Node30及default workspace通过（201条既有警告/nom提示）。首次restricted Start失败与第二轮路径别名/回收失败保留；修复后真实私有目录检查通过，系统CF context仍可能延迟release，立即回收证据限callback捕获。

三次正式Main构建587168/587640/587111均被旧16KiB增量门槛拒绝，最后超583字节；通用缓存/事件常量抽取反增472，已撤回，预算未提高。最后候选独立保留，dist逐文件恢复R19的586470字节；新source与旧dist不匹配，不能作为本轮验收。Native1080输入已记录，新的Native二进制绑定仍待完成。本批没有GUI运行，完整Tauri事件→JS→Vue、图标/CORS/占位和焦点回归仍开放；最后会话观测locked、原解锁询问待答，ticket10与整个目标保持进行。

Gemini附件已用摘要关联既有参考评估并追加固定上游核对：缺main仍有隐藏视图、feature none/list另行分流、SubInput按原版输入路由、detach移动同一live view，百分比/同步延迟不作事实。继续主程序优先与后续Harris原包插件，未staging/commit/push。

## 兼容目录与构建发布批次 R21

证据：`output/renderer-resource-catalog-2026-10-27/verification.md/json`。方法实现与availability合为一个catalog，settings五个callback名称和宿主wrapper共用；Root用改前真实81自有属性/30方法/53事件逐项对比，键/状态/descriptor与fresh副本相等，API及method键序也相同，event metadata键序按合同不保证。没有泛化错误/缓存，也未删诊断或改原Vue/CSS。正式JS从R20候选587111降至586524，省587、余4；旧预算和manifest字节保持，当前24份adapter源码与dist一致。

构建在私有stage完成全部检查才发布；旧直接rm(dist)方式已移除。新增协作式锁/备份/回滚与归属检查，独立review发现并修复backup身份、release lock替换的两个竞态；发布后释放错误明确标记已发布，并保留外来内容/恢复路径。Root实际Node45（事务15）、Main142/完整strict、两次真实负向预算CLI和最终正向CLI、workspace通过，201条既有警告/nom提示保留。负向exit1且旧dist逐文件不变、manifest原字节恢复、临时项清空；1080 Native输入与两个fresh示例完整身份绑定，Rust来源与R20相同，本轮没有原生窗口运行。

旧浏览器夹具只接受3类通知已同步到原页面实际6类，并按每key=1/listenerState及dispose归零验收；导航/mount/主题检查完整提到page模块，全部作者文件≤500。实际headless运行75ff3b4e通过14检查/6截图：四组主题计算样式、原搜索/Enter、别名历史/固定/菜单回执、CDP拖拽、两种焦点返回和退出清理；source/package/dist稳定，进程78686不存在、profile已删除。保留5个逐文档已知updater unavailable日志，意外errors/warnings/exception为0；合成回执不是Rust TaskRun或OS动作证据。

ticket11完成本地资源/发布切片；ticket10仍待真实FSEvents→Tauri→Vue刷新及实际图标/窗口验收，整个目标保持active。当前会话仍locked，原生foreground不重复；下一独立动作按已核对background-journey-design实现隐藏catalog验证，须跳过startup/controller显示、child/layout为0、零前台请求，意外focus不能重试前台。隐藏DOM与可见材质/物理输入证据保持区分。默认Svelte未切换，完整设置/系统动作、跨平台、同步完整协议及Harris原包插件继续开放；未staging/commit/push。

## 隐藏原版应用目录页批次 R22

实际五阶段报告：`output/renderer-catalog-native-2026-10-27/run-61da068fbc8e49a786d5d95da7c25dd4/report.json` 与 `catalog-native.json`；独立审查：`output/renderer-catalog-2026-10-27/independent-review.md`。运行 ID `61da068fbc8e49a786d5d95da7c25dd4`，子进程 PID 36872 exit 0，source/dist/native source/binary/build receipt绑定稳定，终止后 owned fixture root 与 app bundle 均移除。Rust renderer 125 项、Node 28 项、legacy-only/default workspace check 与 fresh both-example build 通过；旧失败日志保留。Main JS 586524 bytes、有效预算 586528，未改变来源或预算。

真实隐藏 Tauri 主页面记录 `appListCalls` 1→2→3→3→3，adapter catalog events 0→1→2→2→2，独立 main-target event witness 0→1→2→2→3，Native catalog 数量 1/2/1/1/2；原Vue标题按初始1项→新增2项→删除后1项变化。初始与新增图标均实际解码为64×64，原 `analyzeImage` 成功。五阶段均记录 hidden/unfocused、focus-gained=0、child/layout=0、WK store非持久；clipboard为0，stale launch被拒绝且TaskRun/history前后为0。dispose后第三个Native witness未带来新的adapter回调或app-list调用。

ticket12定义的本地hidden catalog slice完成。ticket09/10保持in-progress：该运行不证明可见窗口绘制、前台/焦点交互、错误占位或完整窗口行为。R20预算拒绝和恢复记录、R18焦点失败记录均保留；本次没有 foreground retry，也不把完整原版产品目标标为完成。

## 原版主窗口拖动批次 R23

实际证据：`output/renderer-catalog-native-2026-10-27/run-54aaf1a83f3642219e6d9f5d668fc624/report.json`、`window-drag-native.json`、`catalog-native.json`。五阶段 hidden Native 几何为 `(356,608) 800×61 unlocked` → `(376,623) 800×61 locked` → `(376,599) 800×85 locked` → 同几何 released/unlocked → 恢复 `(356,608) 800×61`；scale factor 2。全程 hidden/unfocused、DOM focus=false、focus-gained/child/layout=0、WK store非持久，clipboard/TaskRun/history=0。3次move调用 coalesce为2次Native dispatch；pending/errors=0，catalog通过。PID93513 exit0，owned root/bundle清理，source/native/binary/receipt稳定。

Root验收汇总：Native1100-input与fresh双example绑定、Main154+strict和最终focused33、Fuse4、Node最终34、workspace/legacy-only/fresh-build检查通过；headless browser run `326253c7` 通过14项、6张截图并清理。Main JS 585828 / effective cap 586528 bytes，余量700；较R21的586524减少696 bytes。没有改变manifest预算或压缩策略。

ticket13的本地hidden拖动切片完成。真实Native run没有触发锁定期间hide/navigation中途动作；相关清理路径有源码/状态测试与独立审查证据，不能记为本轮真实Native生命周期演练。可见窗口绘制、物理输入/多屏、跨平台及重启位置保持仍未验证。旧3轮编译/serde断言失败和preflight run `75562...` 记录保留（该次没有启动App进程）；preflight不计为应用journey失败。整体目标仍active，默认Svelte未切换，主程序优先、Harris原包插件后置。

## 拖窗生命周期与启动回搜索批次 R24

Native window-drag run `066cc4fd348641688c2865b3e757910f` 的 schemaVersion 2 十阶段全部通过，报告位于 `output/renderer-catalog-native-2026-10-27/run-066cc4fd348641688c2865b3e757910f/`。在 hidden/unfocused 原页面里，R23 五阶段保持通过；新增阶段实测锁中生产 hide 后解锁、同文档重拖成功、锁中真实 navigation 后新文档解锁并重新拖动。前8阶段文档 ID 为 `a0f7908d53da470d82c200e35c852160` 且 page-load 计数0/0/0，最后两阶段切到 `2b3b98bb83d841ccb141ad321c4e04c0` 且 generation/start/finish为1/1/1。全部阶段 focus-gained/child/layout、clipboard、TaskRun、history为0；catalog通过，PID46832 exit0且自有资源清理，source/native/binary/receipt稳定。R23 ticket13的生命周期 pending由此收敛；ticket14标记hidden Native生命周期完成。

原版主 renderer 的成功返回搜索 browser run `66d74695-897d-48e4-92cf-b18c86b78885` 通过14项/6截图并清理。autoClear=never下的失败受控请求保留 pasted search state，直接 synthetic成功回执清空 pasted/query，再从空白DOM重输 query 通过原版 ArrowDown/Enter成功并清空；两步 Escape、alias history/pins/context menu及七类事件/dispose持续通过。此前 `53a7dfdd-a86f-40cf-a545-ac714ee7d311` 的夹具错误是错误地在内容匹配pastedText模式等待 app row，报告保留且没有修改原 Vue行为。

R24 Native unit12、renderer143、Main21 files/162与strict TypeScript、Node37通过；default/legacy-only/workspace及fresh1103-input builds通过。Main JS 586447 / 586528 bytes，余量81，预算未改。真实自有 OS app启动→Native通知→原DOM清空/隐藏→history与进程回收链本轮没有执行；browser receipts仅是fixture事实，ticket15保持in-progress且真实Native启动项未完成。可见/物理/多屏、跨平台、重启位置及插件/Harris后续范围仍开放；默认 Svelte 未切换，完整目标保持 active，不给总体完成百分比。

## 隐藏 Native 启动回搜索批次 R25

实际证据：`output/renderer-launch-return-native-2026-10-27/run-0410b9f349ba4a5aaa0358dbb17516a0/native-report.json` 与同目录 `report.json`。Native 七阶段全部 `observed`、`passed:true`、`errors:[]`；独立 Node 校验通过。真实 deny 得到 Cancelled TaskRun/Denied audit 且无启动通知；First 与 Second 分别经原版 DOM/API 和生产 launch 路径成功，main Webview 收到两次原始 null payload，query/paste 经真实 Vue 返回清空并由生产 hide 解锁。最终3条 TaskRun（1 Cancelled、2 Succeeded）、1 Denied/2 Confirmed audit、两条 history 各 use_count=1；两个自有 probe 都有匹配 marker 并确认 PID terminal，host exit0、source/binary/build receipt 稳定，owned root/bundle 已清理。

该实测限定为 macOS hidden profile：Native `window.visible/focused=false`、`focusGainedEvents=0`、WK store 非持久；DOM `inputFocused=true` 只代表搜索框保留为 activeElement，`documentHasFocus=false` 与 Native unfocused 另行验证。DOM KeyboardEvent 不是物理键盘。`LSBackgroundOnly=true` 只用于自有临时 probe apps，宿主未设该属性；不得据此推断任意用户应用经生产 `open` 都不会进入前台。完整可见 UI、默认入口仍待验；本批保持主程序优先，Harris 原包插件后置。


## 原版命令别名与目录批次 R26

证据：`output/renderer-aliases-2026-10-27/verification.md/json`。Core 精确 raw CAS 与 guarded 事务、Native 有界目录/分页/单写入、关闭清理、Main eager alias 通知与两层缓存失效、当前 Setting child 图标身份均已接入。实际原菜单带 `#/shortcuts?_t=<Date.now()>`，按源码限定接纳此内部参数，外层 query/错误来源仍拒。存储错误保守按结果未知清基线重读；child 已消失但 close 报错的资源遗留路径已修。没有启动插件或新增常驻 Node。

Root 独验：Core full 324 passed/3 ignored 为 guard 加入前结果，最终 alias/guard 定向 10 passed；Main169与strict、Child16、旧Child Node16、Native renderer170、icons15、正式两份构建、default workspace及legacy-only编译通过。Main JS587945（增1498）、Setting emitted771693（增6368），明确更换里程碑基线与增量分配，绝对上限保持；26份Main源码和9份Setting源码与dist绑定一致。

原Main browser `4315c8f6` 15检查/6截图通过，synthetic alias更新只增加一次设置批读、getApps仍一次。原Setting browser `1a4b316a` 的新增/编辑/确认删除/重载fixture map/合成CAS保留输入切片通过、4截图，overall仍partial：14条真实HostUnsupported涉及SubInput及禁用/固定/快捷键读取，其它console blocker为0。Source身份稳定并全部清理；原始失败夹具记录保留。浏览器内存重注入不是SQLite，Native unit不是Tauri GUI运行，R25旧桌面二进制不得冒充本轮来源。

Ticket16及整体目标继续in-progress/active；下一票17先修主程序SubInput与只读状态，真实Tauri别名全链路和完整可见UI仍待验。默认Svelte入口未切换，Harris原包插件、跨平台、整体性能及完整同步协议后置；未staging/commit/push。Gemini补充仍按已有源码评估作为参考，不采信100%兼容或同步延迟数字。

## 原设置页输入与只读状态批次 R27

证据：`output/renderer-settings-input-2026-10-27/verification.md/json`。SubInput session generation/revision/valueVersion、单在途和 latest 用户输入、有界 Child 控制队列、单一既有 listener、五键一次 Core 快照及分页已接入。Native 关闭清除其输入原文，未知读取不伪造空列表，不新增 Node 进程。Root 及两位非实现者审查发现的身份、跳号、queued close、JSON 转义上限和文件夹 truthiness 问题已修复；错误夹具造成的 Native 初次失败仍保留。

Root 独验：Native renderer203、前端27files207、旧Child Node16、Main strict、Setting原tsc/vue-tsc、workspace和legacy-only编译通过。Setting最终emitted777963 B，增6270，符合本里程碑8192 B增量及786432 B绝对门槛。**Main构建失败：594310 >589824 B，超4486 B；R26正式dist未被替换。** 未抬高绝对预算，未删原UI/字典/诊断，未添加旁路review构建流程。

R27和ticket17保持partial/in-progress；当前版本原Main→Setting的浏览器双向链与Tauri GUI未验，不能复用旧dist或R25桌面二进制称通过。先处理Main预算再做来源一致的原DOM验收，默认Svelte仍不切换。整体目标active，插件继续后置且Harris原包优先；Gemini补充作为源码核对参考，不改变按需Node与SQLite决策。

## 构建预算恢复与原双页面输入批次 R28

证据：`output/renderer-budget-recovery-2026-10-27/verification.md/json`。固定 Terser5.51.2 仅构建期 post-minify，完整lock/实际传递依赖/helper身份和语义安全检查后，Main正式JS587776 B，原589824上限与1879增量不变，比R27失败候选少6534 B、比587945基线少169 B。字典/原Vue保留，28份Main来源绑定；未增加应用运行时或常驻Node。Setting加入退出终止准入后778122 B，增6429≤8192，总量≤786432，12份来源一致。

Luna实现，Root和非实现者独审并修复Escape漏接；stop先于out callback/Native close，立即拒绝后续输入并本地settle，失败不复活旧owner但可重试close。旧Cmd+F流程捕获trusted pagehide pending1的失败保留。最终原双页面10检查/6截图：Main筛选/清空、Child反向设值、alias/路由owner、迟到代次、IME最终值、真实CDP Cmd+F、CAS保留草稿、关闭/重开通过；退出输入RPC17→17、pending0、真实导航pagehide恢复hook、新session独立。Chrome/profile/CDP/server全清理，来源稳定。独立review修正先取旧快照再等待的夹具时序后，最终run为 `096654c3-7e76-4ff0-b33f-3d339d21d3e7`。

Root独验minifier5、原子发布15、Child相关33/4files、旧Node16、Native renderer203、Setting严格tsc/vue-tsc与正式build、workspace check通过；原Main browser15/6保持。双页面inputSlicePassed=true但overall仍partial/exit1，唯一updater.getDownloadStatus unavailable原错误保留。截图的透明底色/真实窗口合成、OS焦点/物理输入和SQLite不由合成transport证明，19原生验收需fresh二进制/receipt并不抢前台；20 getter锁/状态语义已只读排查。

18本地budget/browser切片完成，21实现与浏览器通过，17/19及整体目标仍active。默认Svelte、完整设置写入/迁移、可见UI、跨平台、整应用性能、同步完整协议与Harris原包插件仍开放。Gemini参考继续按固定上游源码评估；未staging/commit/push。

## 原主界面更新状态批次 R29

证据：`output/renderer-updater-status-2026-10-27/verification.md/json`。Native update operation gate与snapshot短锁分离，共享metadata/error指针、锁外深复制/释放和serde JSON上限，check/install/restart/cancel/错误缓存语义由22项独验覆盖；getter只读内存不联网/安装/重启。Main新typed reader校验exact DTO/descriptor/symbol/UTF8/64KiB、同在途共享与disposal，limited且省略无事实的hasDownloaded，完整更新窗口仍不支持。

Root Main27/strict、runner26和含legacy+multiwebview workspace通过。首Main构建590284超460保留，等价去掉内部重复错误与冗余复制后589758，原589824总量/1879增量不变，余66；29份adapter与dist绑定，Setting仍778122且provenance字节不变。初次Tauri宏搬迁编译失败已修，旧log保留；两位非实现者独审与Root关键diff检查完成。

原Main browser16/6（`browser-85853c40`）、双页面10/6（`eda338e1`）均整体passed，旧updater错误0、每Main document getter1次，输入/退出RPC17→17/pending0保持，源稳定且owned资源全回收。浏览器仍为合成transport，不是Tauri handler运行；Native未真实检查/下载/安装/restart，默认入口不切换。

三个Native runner现在共享固定commit/clean/实际source count+hash/真实chunk字节及原预算校验，移除旧产物literal；当前来源pure preflight通过，不冒充fresh二进制/receipt。19调查确认Child打开和反向value会请求Native焦点，R30 hidden contract已冻结私有policy/独立profile/activation观察和真实Rust双向输入。下一票按此实施，不能直接运行旧foreground journey。20实现/单元/浏览器已验而Native运行接19；整体目标保持active，完整可见UI、设置/迁移、Harris原包、跨平台、整应用性能与可选同步仍开放，未staging/commit/push。

## 隐藏原生设置输入批次 R30

证据：`output/renderer-native-input-2026-10-27/verification.md/json`。独立隐藏profile、私有focus抑制policy、实际AppKit激活观察、nonce/caller/session/probeId关联和单在途探针已接入；没有前台回退、系统输入源或用户应用操作。两份原dist保持不变，Main589758/589824 B、Setting778122/有效779885 B，未抬manifest预算。

最终fresh run `7d5822132e554e2dad673ae208eb4ea4` 十阶段、独立报告及真实进程exit0通过。真实系统目录131→1→0→131，Child反向设值增加valueVersion且不增加用户输入序列；原侧栏切换generation2→5并拒绝同session旧owner。公有outPlugin关闭后session/child/layout/pending归零，新session输入为空；观察期app/window均未激活/聚焦，两观察器已移除，自有root/bundle及进程回收。真实updater getter启动1次、显式复核后2次，ticket20只读状态切片补齐Native证据。

Root独验227项renderer相关回归、Node23、实际当前dist的Rust reader、fresh example build、默认workspace和legacy-only编译通过。残留旧资源预算、非法autoPaste=never夹具、延时注册前过早取样及managed Arc退出状态类型错误均已修正；五个失败Native run和seed红测记录保留，不以报告passed替代exit0。新增完整seed投影前置校验、真实输入就绪门槛和manifest预算交叉检查，减少后续无效完整运行。

19仍为partial：本轮没有重开后显式旧session重放、retained Arc擦除witness或全部关闭后入站RPC计数。可见样式/材质、物理输入/IME、多屏、完整设置/迁移与更新窗口、跨平台/发行、整应用性能、完整同步协议和Harris原包仍开放。默认Svelte不切换，整体目标active，主程序优先。用户Gemini补充继续按既有源码矩阵参考；本轮复核市场真实安装链和生产SubInput分支，没有因局部元数据探针或null shim误判全局缺失。

## 重开后的旧会话请求批次 R31

证据：`output/renderer-session-replay-2026-10-27/verification.md/json`。报告schema2增加freshReopen实际旧session参数拒绝门禁；fresh Child经真实call_renderer_settings得到SETTINGS_CALLER_REJECTED，当前会话前后完整Native快照相同。原ownerRotation仍证明旧generation，两个范围分别记录，旧schema1不能冒充本轮通过。

fresh run `f205595cc3ab43489815ed6bb00f5d8e` 十阶段、Node独立校验、实际PID5737 exit0和owned cleanup通过；Native相关232/1ignored、Node25、workspace通过。两份原renderer/dist及预算不变，所有观察期内激活/焦点计数0。19的旧session参数缺口已补；retained Arc擦除、已销毁WebView继续执行及关闭后全部入站计数不据此宣称通过。

下一功能R32由22及 `docs/contracts/ztools-settings-search-pins-2026-10-27.md` 跟踪，复用Core app-state和Main通知，接通原所有指令页应用固定/取消固定；不另造存储、不改原Vue。禁用命令的全量写入/失效/过滤链另续。隐藏WK像素捕获已做只读API调查，实际是否非空尚未验证，不以API存在宣布可见UI还原。整体目标继续active，默认入口及插件优先级保持，未提交推送。

## 原设置页应用搜索固定批次 R32

证据：`output/renderer-settings-search-pins-2026-10-27/verification.md/json`。原Child仅增加固定mutateSearchPin桥，复用Core app-state即时事务/revision及Main既有通知。Immediate guard、write/read gates、会计和read epoch防关闭排队写入及迟到旧缓存；未知存储结果保守重读、不自动重试，确认的幂等结果也发布真实快照。独立审查和Root修正了未知提交被当失败、Child丢code、no-op确认未通知以及Main DOM观察误通过风险；原Vue/CSS未改。

最终schema3 run `2c6bdacf02d3404aba17b2207f6b1185` 十二阶段/独立校验/实际PID86642 exit0通过：原菜单固定→SQLite0→1、Child读回、out后原Main固定组含目标；fresh重开原菜单取消→1→2、Child空值、out后Main移除，history原值不变。保留R31旧session拒绝及所有旧输入门禁，观察期无激活，owned资源回收。

Root独验Core329/3ignored、Native相关245/1ignored、current-dist reader1、Child37、旧Child16、Node27、default workspace/legacy-only通过；最终browser10检查/6截图通过并回收。Main保持589758/589824 B；Setting779464/779885 B，余421，未改预算/依赖或新增产品运行进程。首次Native菜单probe-timeout失败留存，按原owner开闭和8秒总期限修正夹具后fresh重建通过，不改产品动画或绕过菜单。未做磁盘提交故障运行注入、可见像素/物理输入、完整插件固定或完整主程序验收。

22指定direct/app切片完成。下一视觉前沿23：固定上游macOS Main有FullScreenUI vibrancy，ATools尚未接入；必须覆盖原版Main启动至退出生命周期并保护Svelte回退，不能只在Settings期间生效。浏览器白底截图不等于Native颜色事实。完整设置/禁用链、材质像素/IME、跨平台/发行、同步完整协议及Harris原包继续开放，默认入口未切换，整体目标active，未stage/commit/push。

## 原版主窗口材质与主题批次 R33

证据：`output/renderer-native-material-2026-10-27/verification.md/json`。可信原版config的Main lifetime owner与临时Settings lease分开；原生FullScreenUI/BehindWindow/FollowsWindowActiveState持续存在，最后owner释放后真实clear并读回。默认dist不被当成原版，stop/destroy拒晚到acquire；释放错误/取消用同一精确lease token恢复，不永久卡Closing。原Vue/CSS和已提交General偏好保持。

Root在首run `85a503ae089744909bcd13d802130d40` 实际检查PNG发现旧菜单和白底；未接受旧visual=captured为完整UI证明。修复mac Child transparent，并新增实际WK配置读回及严格菜单/颜色/双RAF门禁。最终fresh run `06353d9ac8ab4353902c115d31ccdab8` 十二阶段和独立材质校验通过，九个Child阶段drawsBackground=false；三种主题与SQLite/Child/Main媒体及NSWindow appearance一致并恢复dark；PID76798 exit0，effects/owners归0，自有资源回收，激活/焦点事件0。

最终视觉明确unverified：菜单、侧栏综合判据和双RAF未满足；route/media/root与General标签颜色满足。原因尚未拆清，不能只归因hidden或宣称产品CSS错误。23保持partial，24承接只读诊断与必要修复；default Svelte临时场景、真实清理故障注入及物理合成仍待验。

Root相关Native274/1ignored、current-dist reader1、Node30、default workspace通过；1188 Native输入构建/运行来源稳定绑定。Main589758/589824 B、Setting779464/779885 B均未变，没有新增产品进程/常驻轮询；完整CPU/RSS/GPU/冷启动/包体不据此宣布通过。主程序优先，插件/同步后续，整体目标active，默认入口未切换，未stage/commit/push。

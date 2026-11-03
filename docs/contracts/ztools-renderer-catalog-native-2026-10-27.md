# R22 真实目录事件与原版页面刷新

仓库/工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`，HEAD `c34789c0e3d19b3bf7c05d396540d891ff126abc`。上一目标轮为progress：R21资源/发布及浏览器回归已通过。完整还原目标保持active，当前不是完整产品验收。

## 路径与边界

增加专用 `--journey catalog`，在现有真实smoke executable中走独立分支。保留hidden/focus=false和非持久WK store；跳过startup show、foreground controller及设置/launcher journey，不创建child、不请求show/focus/activate，也不使用AppleScript/CUA/剪贴板/外部用户应用。原Vue mount几何调整允许，但layout count必须0；意外Native focus-gained为失败，不做foreground重试。

同一AppState source服务生产watcher、getApps、图标和launch成员检查。只在已核对owner marker的私有 `<profile.root>/launcher-apps` 创建空app目录；不复制或执行任何程序。初始 `ATools Catalog Initial.app`，新增再删除 `ATools Catalog Added.app`，dispose后增加 `ATools Catalog AfterDispose.app`。固定搜索文本 `ATools Catalog`，seed searchMode=list、autoClear=never、autoPaste=never、showMatchRecommendation=false；查询用原DOM value setter/input事件，不调用focus。

必须通过真实生产FSEvents→同source失效→main-only Tauri事件→原Vue onAppsChanged/getApps→原DOM列表变化。禁止手工invalidate、伪造事件、替换getApps或强制Vue reload来满足变更阶段。初始读取/listener稳定并等待有界settle后记录基线，后续要求事件数和app-list调用数递增，DOM精确从1→2→1。已删除固定路径通过原生产IPC `launch_renderer_app` 拒绝，错误精确为 `Application is not in the native launcher catalog`；TaskRun/history前后为0。

真实行img须为当前opaque系统icon URL，decode后64×64；同URL通过现有analyzeImage执行cors读取，记录成功而不保存图片数据。隐藏lazy画像无法完成时保留失败/限制，不伪称可见绘制或改变生产组件。dispose后四类公开eventSource及settingsView均disposed、app缓存/调用清理；另一次真实目录变化后，无新增adapter调用或回调。General listener没有公开state，本轮不能声称已完整证明它的Native回收。

## Rust接口归属

`catalog_journey`导出 `Prepared { source, harness }`、`prepare(Arc<Profile>, Arc<Database>)->Result<Prepared,String>`、`Harness: Clone`、`handles/handler`、`on_page_load`、`record_window_event`、`start(AppHandle)`。Root负责mod.rs接线和common incognito getter可见性；Profile/owner worker负责新增catalog_journey bool及owner共用验证；新journey worker只写catalog_journey目录。保留controller Harness用于原有WK store实测记录，但catalog不注入或启动通用focus probe/controller。

独立 `catalog_probe_ready` / `catalog_probe_observe` 只允许main/main/local根页、32字符token、单次ready及严格阶段顺序/单pending。DOM观察≤16KiB，报告≤1MiB，watchdog≤120秒；每个阶段等待有界。Native hidden/focus、child/layout、真实dataStore检查在Rust采集，不能信任DOM自述。

## 报告与runner契约

顶层schemaVersion=1、journey=`catalog`、scope=`hidden-original-vue-real-catalog-events`、identifier/root/pid/autoClear=`never`、passed、metadata、clipboard、staleLaunch、errors及stages。metadata含ownedFixture=true/rootCount=1/windowPolicy=`hidden-no-foreground`/dataStorePersistent=false。clipboard三计数均0；staleLaunch含rejected=true/taskRunsBefore=0/taskRunsAfter=0/historyBefore=0/historyAfter=0。

stages严格为 `initial, added, removed, disposed, post-dispose`，各含stage/elapsedMs/dom/native/errors。dom包含inputFound/inputValue/titles、documentVisibility/documentHasFocus、appListCalls/catalogDeliveredEvents/catalogSubscriberCount/pendingNativeCalls/appReadPending/disposed、icon（complete/width/height/analysisSucceeded或null）及四类eventSources与settingsView。native包含visible/focused/focusGainedEvents/activeChildLayouts/childWebviews/dataStorePersistent/catalogItems。Native可见/聚焦均false、gained/layout/child均0；catalogItems按1/2/1/1/2记录。initial/added icon成功；disposed/post缓存及调用清理，无迟到增加。字段如需调整由Root协调后同步validator，不能各自猜schema。

精确嵌套：`dom.eventSources`仅含 `focusEvents/appState/contextMenu/appCatalog`，各仅含 `subscribers/listenerState/deliveredEvents/registrationErrors/callbackErrors/registrationsPending/cleanupPending/cleanupErrors`；`dom.settingsView`为单独对象，仅 `listenerState/registrationErrors/cleanupErrors`。顶层及以上字段均按本节封闭集合输出，不附带完整adapter或路径/图片数据。pendingNativeCalls=0/appReadPending=false；前3阶段disposed=false、catalogSubscriberCount≥2，后2阶段disposed=true、catalogSubscriberCount=0，四类source均disposed/subscribers=0且pending/errors=0，settingsView.disposed。初始/added图标成功，disposed/post icon=null。DOM titles排序为initial `[ATools Catalog Initial]`、added `[ATools Catalog Added,ATools Catalog Initial]`，其余仍initial一项（dispose后不更新UI）；Native post catalogItems=2作为单独观察。disposed的calls/events可≥removed（允许此前已排队的额外FSEvent），post必须严格等于disposed；不能假设removed到dispose间完全无事件。native fields按实际Option值记录，未知null不能算false。

为证明dispose后的真实事件确已到达，probe单独注册一个精确main-target的只读Tauri `atools://renderer-apps-changed` witness，计数放 `dom.nativeCatalogEvents`（追加第15字段）。它不经adapter四类eventSource，不能代替原Vue callback；added/removed相对前阶段需递增，post相对disposed需递增，而adapter自身calls/events保持不变。完成post计数观察后调用自己unlisten并置 `dom.witnessStopped=true`（第16字段），前4阶段为false；该标记表示已执行自己的unlisten，不宣称跨进程立即回收，最终进程退出/fixture清理另行证明。禁止全局broadcast或人工emit来驱动witness。

独立复核后的确定flow：所有阶段DOM visibility须为hidden，与Rust gate一致；图标只在initial/added测量，removed/disposed/post-dispose的icon固定null。Node verifier同步此状态合同，不以producer当前不会生成某值为理由放宽独立报告验证。

Node独立入口 `scripts/test-ztools-catalog-native.mjs`，只接受absolute `--binary/--build-receipt`；复用既有spawn/有界输出/owner清理/Native来源绑定，直接执行本次临时bundle。可用既有`mode=multiwebview`资源暂存以匹配当前feature构建，但实际journey为catalog且无child；不要修改498行common runtime或影响原runner。必须终止/close确认后才回收root/bundle，记录来源和产物前后稳定。当前JS586524/586528预算与原Vue/CSS不变。

## 验收

Root唯一执行Cargo/build/实际Native runner；Luna只做分属实现和允许的Node自测，不派生。所有作者文件≤500行；新增factory/protocol/report须有职责边界。Root先审关键diff、相关Rust/Node负向用例、workspace，再fresh构建绑定和一次真实catalog运行。后台DOM/图片解码证据与可见窗口、材质、物理输入和跨平台验收分开；失败不改原门槛。

# R20 原版应用目录变更刷新

工作区`/Users/harris/Desktop/atools`，开发分支`codex/atools-ztools-parity`。固定上游`9b15fb1a2a9f3ec886016632761c7bb21e39557a`的Vue/CSS不改。当前桌面仍锁定，不重复foreground验收；此切片可在私有目录验证。

## 行为与顺序

macOS应用目录新增、删除、改名后，原Vue通过既有`onAppsChanged → loadCommands → getApps`刷新。Native先使同一catalog source的快照失效，再只向main Webview发`atools://renderer-apps-changed`（unit/null payload，无应用名/路径）。启动、固定及图标成员校验继续使用该source，删除后的旧路径不能由前端旧缓存继续认可。

Native不从前端接收监视根；System为两个固定系统根及可获得时的用户Applications根（共2–3个），owned fixture仅监视已验临时根。扫描深度4/4096项/1024应用与30秒TTL不变；TTL不替代事件失效。源增加`invalidate()->Result<(),String>`和`watch_roots()->Result<Vec<PathBuf>,String>`内部Rust接口；不增加任意路径IPC。

## 原生监视

- 复用现有core-foundation/libc，经macOS CoreServices FSEvents及serial dispatch queue；不添加依赖包、Node、独立进程或定时扫描。
- 使用SinceNow、FileEvents/WatchRoot、约1秒latency合并；一次batch最多一次通知。只处理扫描范围内目录结构变化，忽略.app内部文件写入及范围外/超深路径；drop、MustScanSubDirs、RootChanged需失效以恢复。
- 每批最多处理4096项，路径转换有界；overflow保守失效一次。C callback不得unwind，CFArray/CFString借用不可逃逸。
- callback info用可核对的retain/release或等价Arc所有权。停止时关闭active gate→Stop→保持queue绑定的Invalidate→从queue外drain→摘除用户callback→Release stream/queue；idempotent stop与Drop，不能从自身callback queue同步drain。实际回收断言验证callback捕获被释放；系统持有的CF context可能延后release，不将前者称为整个CF context立即析构。
- 不存在的根、根删除后重建需真实owned测试；文档未保证时不能宣称已支持，不改为监视整个Home。
- 共享host安装内部Tauri plugin：setup只安装空runtime；Ready开始监视并invalidate/通知一次，弥补build期间首次读取的启动窗口；Exit显式停止并排空。失败记录固定诊断，离线基础读取仍可用，不能伪造watcher成功。

Backend冻结接口：`NativeWatcher::start(roots:&[PathBuf], on_change:Arc<dyn Fn()+Send+Sync>)->Result<Self,&'static str>`，`stop(&mut self)`且Drop幂等。此interface的stop调用者必须在callback queue外，固定生产callback不得调用stop。非macOS明确unsupported。

## 前端缓存

独立appCatalog module拥有列表缓存/路径解析/变更监听。订阅内部失效callback并等native listener ready后才首次读取；同一时刻最多一个list RPC。事件到达时作废缓存，读取期间变更的旧结果不得回填；旧请求完成后再合并读取最新快照，不能并行发出重复扫描。对外返回副本，launch/reveal以同一新快照检查成员。listener失败不永久缓存该次快照；dispose后不发布迟到值并清理owned listener。

复用现有eventSubscriptions生命周期与错误计数。`onAppsChanged`升级limited，其他inactive事件仍由原目录统一生成。允许删除重复的五个inactive包装：必须保留键集合、可枚举自有属性、get/has、callback校验/无参调用及诊断；未文档化的键枚举顺序不作为兼容保证，不能宣称此顺序未变化。

Main JS有效预算仍586,528，R19为586,470，只有58字节余量。先通过有语义的重复消除容纳新行为，不砍防线、诊断或扩大预算。setting来源保持。

## 归属与验收

- Backend worker：watch/backend.rs、ffi.rs、backend_tests.rs；不修改source、插件协调器或前端。
- Native协调worker：catalog/source失效和roots接口、watch/mod.rs的plugin/Runtime；必要测试；不改backend或Root接线。
- Frontend worker：appCatalog module、hostAdapter/hostEventCatalog及相关测试；Root负责transport/types、Native probe/readiness对应接线、build pin及完整验证。
- Root审查所有关键diff，唯一执行Cargo、正式build与Native验收；单队列locked/offline -j2。每个作者文件≤500行，已有dirty工作全部保留。
- 真实私有目录add/remove/rename、nested folder、缺失根创建与根重建、停止后context释放；callback→invalidate→新snapshot的实际链路；前端单flight、订阅/读取竞态、旧值拒绝、失败恢复和dispose；类型/构建/固定资源预算。页面与完整窗口验收继续等待桌面可用，不把source test称作GUI通过。

## R20 当前验收状态

Root私有目录真实watcher8项（包含FSEvents→invalidate→同source快照）、Native renderer108、catalog5/source8、图标15、Main139及完整strict、Node30和default workspace均通过。readiness新增实际app-list调用计数，拒绝只完成设置读取的假ready；计数只证明调用发生，不证明请求成功或Vue绘制。

正式Main第三次构建为587111字节，超过有效预算583字节（旧16KiB增量门槛失败），不接受该候选。第二次共享缓存抽取反增472字节，已撤回；不扩预算。候选保存在R20 output，dist已逐文件恢复R19通过预算的586470字节版本；因此当前新source与已接受旧dist不匹配，不可将旧dist或旧Native二进制用于本轮验收。完整Tauri事件→JS→Vue刷新、图标和焦点回归仍待验，ticket10保持in-progress。

R21后续更新：通过单一兼容目录消除实际重复，正式JS降至586524字节、余4，未改预算。当前24个adapter来源与正式dist匹配，Native1080输入及两个fresh二进制已绑定；Main142、Node45/strict、正负向CLI与headless原Vue14检查/6截图通过。R20拒绝记录保留为历史，source/dist不匹配已修复；真实Native事件→原Vue刷新仍未验。证据 `output/renderer-resource-catalog-2026-10-27/verification.md/json`。

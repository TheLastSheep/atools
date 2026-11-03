# R18 自有应用启动与原版键盘链

工作区 `/Users/harris/Desktop/atools`；开发分支 `codex/atools-ztools-parity`；HEAD `c34789c0e3d19b3bf7c05d396540d891ff126abc`。R17资源回收已验，整体目标保持active。本批回到主程序可用性：原Vue搜索和按键进入生产Native目录校验、权限、TaskRun、OS启动与历史记录。只使用自有临时测试应用，不启动用户应用。保留默认Svelte及插件后置/Harris优先。

## 目录来源接口

`LauncherAppCatalogSource::default()` 保持原固定系统roots/缓存。`snapshot()` 返回原LauncherApp列表；`AppState.launcher_app_catalog: Arc<LauncherAppCatalogSource>` 为列表与既有launch/Pin membership共享来源。现有reorder/orphan语义不变。fixture构造器仅legacy-node-smoke feature可用，限absolute/real-nonsymlink，canonical路径位于现有Profile允许的temp_dir或macOS `/private/tmp`之内、末级为`launcher-apps`，独立cache和原TTL/扫描预算；它不是授权边界，profile owner由调用工厂验证。没有新增caller roots入参，不绕过main/path/权限/TaskRun。允许范围需与既有Node固定`/private/tmp/atools-renderer-native-*`一致，不能只验证环境TMPDIR。

## Mode、工厂与探针

- Native沿用现有`--journey`参数，新增值`launcher`，与settings journey互斥；Node mode为`launcher`。仅此mode在已验owned profile root内使用固定`launcher-apps`子目录并注册正常启动使用的builtin tool definitions。
- 两个自有bundle为`AToolsOwnedProbeFirst.app`、`AToolsOwnedProbeSecond.app`。每次bundle ID绑定runId和first/second；真实Mach-O来自Cargo example `atools_owned_launch_probe`（源文件`src-tauri/examples/atools_owned_launch_probe.rs`），和desktop smoke在同一次锁定离线构建中生成，receipt绑定两二进制与Native源码。不得以脚本/Node/mock或`open`返回值代替目标进程证据。
- 两bundle固定可执行文件`Contents/MacOS/AToolsOwnedLaunchProbe`。Resources含私有`probe-config.txt`，精确两行`<32hex runId>\n<first|second>\n`，≤128bytes。目标进程只读此配置，校验自有temp confinement/文件形状，在Resources中create_new写`probe-started.json`与`probe-exiting.json`，字段精确`schemaVersion:1,runId,probeId,pid`；随后短时有界退出。probe可复用现有libc的nofollow标志，不新增依赖；不得写其他位置、联网或访问剪贴板。
- Native factory必须在主Vue初始化前绑定fixture source，seed searchMode=list、tabKeyFunction=navigate、autoPaste=off、showRecentInSearch=true。immediately case使用spaceOpenCommand=false并以Enter启动；never case使用true并以Space启动。该映射仅fixture策略，不改变产品语义。
- 使用真实input setter+InputEvent与原有全局KeyboardEvent监听，不直接改Pinia、调用handleSelectApp或mock launch。结果应为固定两项，观察ArrowDown前后selection变化并匹配first/second。键盘为DOM事件，不称物理键盘验收。

## 每case顺序与真实存储证据

1. 初始TaskRun/history/marker均零；用main invoke尝试未列出的自有temp路径，必须在catalog拒绝且不产生TaskRun/history/marker。
2. Enter case先在space关闭时发送Space，仍保持零TaskRun/history/marker。
3. 临时DB写`agent.scope_policy={"shell":"deny"}`并读回；原Vue真实按键产生Cancelled TaskRun及Denied audit，marker/history仍零，即使confirmed=true也不得绕过Deny。
4. 仅清除临时scope deny策略并读回；恢复/聚焦自有主窗，以相同生产Vue按键重试。观察Succeeded TaskRun、成功audit、marker nonce/id、目标PID终止、history恰一项/useCount1与main事件应用。`mainHistoryApplied`允许只读真实原Vue Pinia commandData的history，并结合生产adapter accepted event/reply计数；必须匹配选中的自有identity/useCount，不直接改store，也不只用adapter计数代替Vue消费。list空query不展示history，不宣称可见历史卡。报告不包含应用名/路径/查询/完整marker或TaskRun输入，仅固定probeId枚举、布尔、状态和计数。
5. 两个TaskRun中恰一Cancelled、一Succeeded；不得直接写TaskRun/audit/history来制造证据。原9阶段focus/dispose往返保留，launcher journey应放在BlurReturn后、Disposed之前；跳过generic child准备，settingsView/multiwebview报告为null。

## 固定launcher报告（case顶层`launcher`）

schemaVersion=1、enabled=true、passed=true、errors=[]，下列字段全部必填：

- catalog：fixtureOnly=true、itemCount=2、confined=true。
- input：key为Enter/Space且匹配case；spaceEnabled对应false/true；domInput=true、resultCount=2、selectionChanged=true、selectedIdentityMatched=true、selectedProbe为first/second。
- spaceDisabled：applicable/checked仅Enter case为true；noTaskRun/noMarker/noHistory均true。
- unlisted：rejected/noTaskRun/noMarker/noHistory均true。
- denied：policyReadback/taskRunCancelled/auditDenied/noMarker/noHistory均true。
- launched：policyCleared/taskRunSucceeded/auditSucceeded/markerStarted/markerNonceMatched/exitMarker/processTerminal/historyRecordedOnce/mainHistoryApplied均true；useCount=1。
- counts：taskRuns=2、denied=1、succeeded=1、historyItems=1、processStarts=1、processExits=1。
- cleanup：probesTerminal=true、pendingLaunches=0、liveProbeProcesses=0。

Native值来自独立DB/marker/PID和真实DOM/只读生产store观察，JS回报应nonce/operation/caller绑定并严格限制字段与字节；JS不得写store或宣称DB/TaskRun/PID成功。缺证据/异常/超时保持false与固定错误码，不删门禁。Root维护独立Node report validator，实施者不修改通过条件。

原9stage内部仍用原始input进行autoClear/focus验证；launcher模式最终输出clone必须将`stage.dom.inputValue`置null，disposeError不输出原异常。Node独立检查stage/dom已知精确字段集合和两个null；不能让泛用stage旁路launcher区的query禁出约束。其它settings/multi报告格式不变，不移除原窗口验证或errors。

## Node staging与清理接口

Node新增`--launcher-probe-binary <absolute>`，launcher mode强制与build receipt的`launcherProbe`指纹匹配；其他mode拒绝该参数。保留现有Native `Profile::prepare`创建新root和owner的时序，不采用启动后Node写入race/hook。

Node在已有受控host.app的`Contents/Resources/launcher-apps`预置上述两bundle（hash/私有权限/nonce绑定并拒绝symlink）。Native `Profile::prepare`成功并验证owner后、主Vue初始化前，从自身可执行文件定位该固定Resources目录，按精确文件集合有界复制到新profile root的`launcher-apps`，再注入catalog。只接受两个固定bundle，每个仅Info.plist、Contents/MacOS可执行文件、Resources/probe-config.txt；可执行文件≤32MiB、plist≤4KiB、config≤128B，无symlink/额外文件/旧marker，目录私有。验证CFBundleExecutable、runId/probeId绑定的CFBundleIdentifier（`dev.atools.launch-probe.<runId>.<probeId>`），并保持配置/内容与staged字节相同。Native只读取自身固定资源和已验profile，不接收新路径参数。Node事后从实际被执行的profile root读取marker并核对复制后的可执行文件hash。

Root receipt中`launcherProbe`使用与`binary`相同的fingerprint结构。其Cargo命令同时包含`--example ztools_renderer_desktop_smoke --example atools_owned_launch_probe --features legacy-node-smoke,ztools-multiwebview --locked --offline -j 2`，构建前后Native输入一致。

目标marker必须被Node从已验证owned root独立有界读取，核对probeId/runId/PID及exit marker，并确认PID不存在。只有host已终止、完整launcher成功/无pending且目标进程独立终止证据成立，才回收该fixture root。失败/未知不能证明无活跃目标时保留root并停止下一case；主临时.app在host结束后仍可独立回收。不得按猜测PID强杀或删可能仍执行的bundle。报告准确区分host与probe的清理。

## 分工与验收

Luna 1负责catalog source/state/既有命令接线及临时目录单测；Luna 2负责Rust probe、Native launcher module、profile/factory/controller/report接线和有界观察；Luna 3负责Node mode参数/staging/receipt/独立marker清理与测试。Root负责接口、独立report validator、关键diff、串行Cargo与build、正式新来源绑定和真实Native验收。所有源文件≤500行，独立职责分模块，不继续派生。

Main/setting固定产物与预算保持R17：586299/765325 bytes，禁止为fixture加入生产JS或改Vue/CSS。Root按变更运行catalog、renderer native、Node回归与workspace，继而fresh receipt真实launcher两case及settings/multi回归。完成只指本纵切片；物理输入/IME、像素/材质、跨平台、其他系统设置、完整同步和插件仍开放。

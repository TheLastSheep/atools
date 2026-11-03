# R25 原版搜索成功启动后的真实回退

上一轮 R24 为 progress；全目标 active。仓库/工作区 `/Users/harris/Desktop/atools`，目标开发分支 `codex/atools-ztools-parity`，HEAD `c34789c0e3d19b3bf7c05d396540d891ff126abc`。主程序优先，社区/Harris 插件后置。Root 负责接口、审查及独立验收，Luna 实施；不 staging/commit/push。

## 目标与限制

沿用生产 `launch_renderer_app`、权限、TaskRun/audit、history、main-only null 载荷 app-launched 通知及 hide_main_window。增加独立的 `--journey launch-return` 私有 Native 验收：强制 autoClear=never，要求 legacy-node-smoke，使用原版 Vue、隐藏/不聚焦/非持久主 Webview，不运行旧 foreground controller，不创建辅助窗。不能修改 catalog journey 的零 TaskRun/history 合同。

只启动当前 run 的自有 `AToolsOwnedProbeFirst.app` 和 `AToolsOwnedProbeSecond.app`，真实 Mach-O 与私有 marker。仅目标探针 Info.plist 强制 `LSBackgroundOnly=true`，Node stage/inspect 与 Rust stage 同时校验；默认旧 launcher fixture 不变。主 Tauri host 不设 background-only。生产 `open <path>` 保持不变，不以直接 exec 或改 open 参数绕过真实管线。

Apple 将 LSBackgroundOnly 定义为 Mach-O app 的后台运行配置，参考 https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/LaunchServicesKeys.html 。是否满足当前环境仍依赖实际进程 marker、主窗事件和退出观察；不得从声明推导全平台无焦点或性能结论。禁止 show/focus/activate、CUA/AppleScript、用户应用/剪贴板/输入源操作。仅终止已验证本次 owner 的进程，终止确认后才清理自有资源。

## 场景与证据

按序七个阶段：`baseline, pasted, denied, direct-return, typed, keyboard-return, disposed`。

`RunEvent::Ready` 不表示 main document 已完成探针注入。Native 在 stage 0 前有界等待一次性的 `renderer_launch_return_probe_ready` 主 Webview 握手；JS 仅在 adapter 初始化且 app-launched listener 确认 listening 后发送。缺少握手立即写失败报告并退出，不把 optional-chained no-op 当成功，也不运行 18 秒 receipt timeout 来探测加载竞态。每个 stage 仍有独立 nonce 与有界 receipt。

1. baseline：原 Vue 与现有可观察 listener 已就绪，查询/粘贴为空，TaskRun/history/启动计数为 0。完整七类注册/退出的传输计数已有 R24 浏览器证据；本轮不为不可见诊断编造 Native 数值。
2. pasted：通过真实 input + 原 Meta+F 处理器生成 `AToolsOwnedProbeFirst` 粘贴文本。使用生产拖窗 API 设置 size lock，让隐藏的效果可以被实际观察；此时 Native locked=true。
3. denied：临时 DB 内通过生产 `set_agent_scope_policy(db, "shell", "deny")` 拒绝 open_or_reveal_path 所需的实际 Shell scope，再通过真实 adapter API 请求 First。此工具的 scope 不是其方法名；不得制造一个生产门禁不识别的 scope 字符串。必须 reject，粘贴内容和锁保持，启动事件 0、marker absent、history 0，恰有一个 Cancelled TaskRun 与 Denied audit。
4. direct-return：清该私有 deny 后，同一 API 成功打开 First。真实 event 到达 1，原 Vue 查询及粘贴均空，Native lock=false/hidden/unfocused；恰有一个 Succeeded TaskRun/Confirmed audit、First history 一次/use_count=1。通知或隐藏不可由夹具伪造。
5. typed：重新输入 `AToolsOwnedProbe`，在原结果列表用 ArrowDown 选中 Second；观察非空 query、精确 selected title 与 Native lock=true，不能直接调用原 Vue 内部函数。
6. keyboard-return：原 DOM Enter 真实打开 Second；event 到达 2，query/粘贴均空、Native lock=false/hidden/unfocused；总 TaskRun=3（1 deny+2 success）、history=2，两条各一次/use_count=1，不额外刷新/重复启动。
7. disposed：释放 adapter 与独立前端 witness，所有可观察 listener/队列归零，没有新事件或调用。Native 驱动核对两个自有 probe 的 started/exiting marker、run/probe/PID 身份与实际 ESRCH；不把 open 退出成功当进程已运行。未通过 terminal 证据则不清 root。

TaskRun/audit 阶段门禁还要求 TaskRun 的 `audit_id` 关联同路径、同 client/tool/input 与预期状态的 audit：denied 阶段 First Denied；direct-return 与 typed 阶段继续要求 First Confirmed；keyboard-return 与 disposed 阶段再要求 Second Confirmed。聚合报告保留计数 schema，不输出内部关联 ID；缺链或数据库观测未知均失败。

每阶段原始 DOM 及 Native 证据分开：DOM input/pasted/selected/visibility/document focus/input active-element、adapter launch 调用数及原始 adapter snapshots；Native 实际 window visible/focused/sizeLock、focus-gained、childWebviews、activeChildLayouts、WK store、DB TaskRun/audit/history、原生 app-launched 独立 witness。`inputFocused` 只记录 DOM active element 是否为搜索框，必须有实测布尔值，但不作为 OS 窗口焦点判断；隐藏且失焦的 WebView 仍可能让原 Vue 搜索框保持 active。OS 未聚焦仍由 `documentHasFocus=false`、Native `window.focused=false` 和 `focusGainedEvents=0` 独立验证。Native witness 必须绑定 `main` Webview，并逐个检查原始事件 payload 为 JSON null。不得缺字段时默认为 0/false。只校验实际 adapter snapshot 暴露的计数和错误字段；`settingsView.snapshot()` 不含 subscriber/callback/delivery 计数，`generalPreferenceEvents.snapshot()` 不含 listener/subscriber/cleanup 计数，`windowDrag.snapshot()` 不含真实 lock 状态。R24 browser evidence 负责这些 adapter group 的完整 registration/disposal 证据；R25 不增改 production adapter。native size lock 仅从宿主 window-drag 状态观察，且必须在 adapter 调用 settle 后采集。clipboard 三计数 0。真实 Native witness 只观察，不发送成功事件或代替业务路径。保持生产 adapter、Main 产物与资源预算不变。

## 协议与职责

计数来源的特殊语义：实际取得完整、有效的 `nativeCalls` 稀疏映射后，未出现某方法 key 按现有 `Partial<Record>` 定义表示从未调用，可记为0；映射本身缺失/无效时仍为未知。不能将此规则推广到其他缺失 snapshot 字段。

顶层报告固定 `schemaVersion:1, journey:'launch-return', scope:'hidden-original-vue-real-launch-return', runId, identifier, root, pid, passed, errors, metadata, clipboard, stages, probes`。metadata 至少明确 ownedFixture、catalogItems=2、windowPolicy=hidden-no-foreground、dataStorePersistent=false、backgroundOnly=true、autoClear=never。Native/DOM schema 由 Native Worker 先写清单交 Node Worker；Node 独立校验关闭字段、顺序、完整性及上述增量，畸形输入 fail closed、不 throw。

Native Worker 负责独立 launch_return_journey 模块及 JS、profile/mod 接线、复用 owned factory/process/DB evidence 的合理可见性，必要纯协议/安全门禁测试；不运行 Cargo/build/GUI，不改 Node 文件及生产业务语义。Node Worker 负责可选 background-only probe factory/测试、新 report helper/测试与独立 runner，复用现有 source/binary/receipt/owner/cleanup 约束；不改 Rust/Vue/预算。所有 authored 文件≤500行，不往已有近500行模块追加独立职责，不拷贝已有完整基础设施。

Root 串行执行最小相关检查后 workspace/legacy checks 和 fresh source-bound example build。Main adapter 无改动时复用 R24 已通过的 162/strict/browser，不重复无关测试或重新压包；需核对当前 dist/source/hash 与双预算。记录失败、退出、清理和未验边界。隐藏 DOM KeyboardEvent 不等于物理键盘；hidden Native 不证明可见 UI/材质/多屏/跨平台。完成本切片不代表整个还原目标完成。

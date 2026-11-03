# R29：原 Main 更新状态的真实只读接线

工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`，HEAD `c34789c0e3d19b3bf7c05d396540d891ff126abc`。上游 ZTools 固定 `9b15fb1a2a9f3ec886016632761c7bb21e39557a`，只读。Root 定接口、审查、独立测试和实际构建/运行；Luna 实施，不派生。保留已有工作区改动，不 staging/commit/push。

## 要解决的问题与范围

原 Main `windowStore.checkUpdateStatus` 在自动检查启用时调用 getter，仅消费已观察到的 hasUpdate/version/changelog。ATools 现有 getter 显式未支持；Native `get_app_update_status` 不联网，但与 check/install 共用跨网络 await 的 mutex，无法及时读进行中状态。先修真实 snapshot，再接 Main。此票只读，不进行真实检查、下载、安装或重启；完整更新窗口/独立 downloaded 状态仍需后续真实实现，不以本票宣称全量兼容。

## Native 接口与职责

继续复用 `get_app_update_status`，窗口授权仍仅 main/settings；不新增通用命令、事件订阅或运行时。`UpdateStatus` wire exact keys：`operation: idle|checking|installing|restarting`、`update: UpdateMetadata|null`、`checked: boolean`、`lastError: {code:string,message:string}|null`。UpdateMetadata 保持 exact `currentVersion,version,date,body`，后两项 string|null。checked 表示存在上次成功检查观察，不代表实时最新；update=null且checked=false不是“已是最新”。

把 operation 串行化 async gate 与短锁 snapshot 分离；没有 snapshot guard 跨 backend await、progress callback 或 restart。status 只复制内存，不进入 operation gate、不调用 backend，保持 async 调用点但返回 `Result<UpdateStatus,UpdateCommandError>`，锁错误保守拒绝。初始 idle/unchecked/null/null；check 开始 checking，成功写缓存/checked，失败清检查缓存并记录原错误；install 开始 installing，失败保留可重试观察并记录错误，成功在 restart 前先写 restarting 并清缓存，重启失败记录原错误且不假装完成。

保留并发 check 合并缓存 TTL、版本验证、单安装及原 progress/restart 行为。Future 取消不能永远停留 checking/installing；以有清晰责任的 guard 释放本地 operation 状态并记录结果未知/中断，不声称回滚安装。状态/串行职责独立可测。现有 updater.rs 超500行，按 models/coordinator/backend/commands/package-smoke/tests 的实际职责拆分，保留所有原测试和 smoke 支持，所有文件≤500；不递归 rustfmt。

Root 首轮审查增量：成功的 cache-hit check 也清除先前失败的 lastError，不能出现新 check 成功而 getter 永久报旧 install 失败。Native status 必须在克隆前检查下述同一字段 byte 限额，再按 serde JSON 实际总量≤64KiB返回；超限以短结构化 `state_response_too_large` 拒绝，不等到 JS 收到超大 IPC 后再处理，不截断，也不改变旧 check/install 对 metadata 的接收行为。Tauri command 薄入口留在注册期望的 updater module 路径，不能只重导出函数而漏宏生成的命令标识。

## Main adapter

独立 `updaterStatus.ts` 隐藏严格 DTO/UTF-8 预算校验、映射和并发只读合并；hostAdapter 只接线，当前486行不得堆职责。增加唯一 `get_app_update_status` 到 typed command union。getter 无参数，以 undefined args 调现有 invoke，复用 disposal gate；同一在途读取共享、结束后下一次可读取新观察，失败不永久缓存，不新增 listener。

兼容返回 `hasUpdate: Boolean(update)`，可用时带 version/changelog，另带 `checked` 和 `status`。idle+unchecked 映射 idle（尚未观察），idle+checked+null 映射 not-available（上次检查无更新），idle+update 映射 available；进行中 operation 映射原名。hasUpdate=false表示无已观察到的可用版本，不能解释成确定无更新。**不输出 `hasDownloaded:false`；Native没有独立下载完成观察，省略字段并以 limited capability 表明限制。** LastError 非空保留错误 code/message 并拒绝 getter，不能变成空状态或无更新。真实 invoke 失败原样拒绝；结构/预算错误用既有 invalid-response。

Wire总量≤64KiB；metadata currentVersion/version ≤128 UTF-8 bytes，date ≤128，body≤48KiB；error code≤128/message≤8KiB。严格 exact keys、原始类型、有限枚举和 checked/update 一致性（unchecked不能带update）。不静默截断。方法能力遵循现有仅叶函数的 catalog 约定：`updater.getDownloadStatus=limited`、`updater.showUpdateWindow=unavailable`。updater 是部分可用的 namespace 对象，不在 methods 增加非 callable 根键；原API键、descriptor和未支持方法行为保持。Root独审明确了初稿含糊的“object=limited”表述并同步测试，未改变真实getter功能。主程序 JS 原589824总量与相对587945最大1879增量不变。

## 验收与取证

Root 独立跑 Native updater 单元/并发取消/状态延迟测试与相关 Main 回归、严格检查、workspace编译；实际 updater backend 全用 mock，status 在被阻塞的 check/install/restart 期间以独立 timeout 读到进行中且没有额外 backend 调用。保留已有检查缓存/单安装/progress/授权/smoke 测试。

Main 新模块覆盖初始/无更新/可用/进行中、Native错误/非法DTO/UTF-8边界、并发1次与后续新读、拒绝/重试、dispose迟到回执；catalog与旧 unavailable 测试按真实状态更正，不放宽未知命令。Root正式构建通过当前预算和来源绑定后才运行原Main与双页面。

浏览器 transport 只增加严格无参数 getter 的明确 snapshot fixture，记录读次数；它不是Native事实。当前已接通getter后不应再有原 unavailable 日志，最终 Main/双页面必须无该错误、无意外console/network问题。旧R28原始partial报告和限定分类保留，不允许通过泛化错误白名单或仅改分类变绿。原生双视图后续须 fresh binary/receipt 和独立 no-activation 路径；本票不操作用户浏览器、输入源或前台应用。

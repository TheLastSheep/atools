# R42：原版 General 透明度滑块的提交与原生应用

工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`；原版只读 ZTools commit `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。主程序优先，插件延期；不修改原 Vue/CSS、默认入口、依赖或资源门槛。

## 已确认的产品缺口

原 General 的 `handleOpacityChange` 先调用 `setWindowOpacity`，成功后才 `saveSettings`。当前 Native 只允许应用已提交值，新值先被拒绝；Child/Core 的14字段 allowlist又不允许保存 opacity。已有 macOS AppKit alpha设置/读回不是滑块可用的证明。

## 单一写入路径

- `opacity` 加入既有 General 精确可写字段，范围为有限 JSON number `0.3..=1.0`。旧14字段、未知字段保留、64KiB/CAS与会话保护继续适用。
- Child `setWindowOpacity` 使用既有 General 串行写队列发送一次 `patchGeneral`，而不是先发一次应用RPC再发一次保存RPC。成功后更新已提交 projection/runtime缓存；原页面随后的同值dbPut是no-op。异常拒绝，无确认的值不得当成已应用；非macOS在写入前明确拒绝。
- Native `patchGeneral` 保持现有准入、session write gate、pending write和取消安全任务。Core新增 `prepare_renderer_general_settings_write(expected, changes)`，完成与旧mutate相同的归一化/白名单验证并返回既有GeneralSettingsWritePlan；原mutate委托它再commit，不另造存储或revision。
- General runtime协调器内：prepare CAS计划→读取真实窗口旧alpha→应用候选并读回→提交计划→通知main。原生应用失败或commit失败均尝试恢复真实旧alpha；恢复失败明确报错。无提交则不发成功通知，通知失败则维持`notificationDelivered:false`，不假装未提交或自动重试写入。
- 不含opacity的既有写入保留原行为。新事务不得顺手注册快捷键/托盘或验证和修改无关native字段。
- 既有AppKit IO抽取为共享`native_window_opacity`，提供crate-private `read_apply(window, Option<f64>) -> Result<f64, String>` async接口；None只读，Some在主线程设置并读回。低层允许恢复真实旧`0..=1`，用户写入仍由Core限制到`0.3..=1`。非macOS明确unsupported。旧appearance bootstrap/已提交值应用与新事务复用同一IO，不复制unsafe代码。

## 验收

先Core真实临时SQLite验证15字段、范围/类型/CAS/未知保留；Native事务使用真实SQLite与可失败的原生IO adapter验证apply/commit失败恢复、无副作用纯写路径；Child验证同一队列、同值no-op、失败/冲突/通知未送达和不可用平台不假成功。独立Root再构建原设置包，核对原Vue/CSS身份、strict与资源预算。

真实hidden Tauri：初始私有General明确opacity=1；原range控件改为65%→独立DB读回0.65及真实NSWindow alpha读回→关闭/新Child重开UI/DB/alpha保持→原控件恢复100%→DB与alpha一致→关闭/回收。不改原控件实现、不用直接mutation替代DOM动作、不启用插件或Node。复用settings-input journey/owner/source binding/cleanup，旧12阶段、应用设置/禁用/inventory/alias门禁保留。Native只读alpha不等于物理合成/可见画面证明。

若追加独立sidecar，使用`native-window-opacity-report.json`，顶层为schemaVersion1、journey=settings-window-opacity、scope=hidden-original-vue-window-opacity、identifier/root/pid/runId/observations/errors；无Native passed位。观察包含14项nullable成功bool（initialStateValid、changeDispatched、changedUiMatches、changedStored、changedNativeMatches、freshChildOnReopen、reopenUiMatches、reopenStored、reopenNativeMatches、restoreDispatched、restoredStored、restoredNativeMatches、unrelatedPreserved、closed），pluginUiOpened/preloadStarted两项nullable bool要求false；changedNativeOpacity/reopenedNativeOpacity/restoredNativeOpacity为nullable有限0..1数字，分别与0.65/0.65/1相差不超过0.005。全部已知且errors为空、同owner原生终态/清理通过才成功。固定error前缀settings-window-opacity-，后缀baseline-invalid/open-failed/change-failed/reopen-failed/restore-failed/readback-invalid/unrelated-changed/close-failed/report-write-failed。

Main593891B，固定上限593920B，仍不增加Main资源。Settings782503B，既有有效门槛783560B，余1057B；新桥代码必须实测，不默认提高门槛。新增/修改作者文件<=500行。Root独占Cargo、正式构建与Native；Worker不得开子代理，原有dirty工作全部保留。

## 结果

实际run `a653503a9ded4284953ef861b91e8618`通过：原滑块65%→独立SQLite0.65与NSWindow alpha0.65→fresh Child重开保持→原滑块100%→DB/alpha1→exit0及owned cleanup。旧12阶段及其它门禁全部通过，同一构建R39两进程持久化回归亦通过。Settings783356B（+853B，原有效门槛余204B），Main及原模板/样式保持。

首次实际run因Core/Child capability顺序错位而在旧主题/本地应用阶段失败，未执行opacity；已以实际Rust字段表复现并修正序列，保留严格ready校验和跨语言回归。Core349/3ignored、Child79+脚本16、Node110、Native358/1ignored及工作区/严格构建通过。详见[验收记录](/Users/harris/Desktop/atools/output/renderer-window-opacity-2026-10-29/verification.md)。本结果仍非可见合成或完整主程序验收。

# R44：原版 General 主唤起组合键

工作区/仓库 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`，HEAD c34789c0；上游只读9b15fb1a2a9f3ec886016632761c7bb21e39557a。Luna实施，Main派单/审查/独立验收。保留全部已有dirty，不提交推送，不切默认Svelte入口。

## 用户路径与范围

原 General HotkeyInput 在确认时先更新v-model再emit change，调用updateShortcut成功后saveSettings。预设和重置也先updateShortcut再save。当前三者均未接入；仅开放字段不执行Native效果会假成功。

本票接通原控件的普通修饰键组合与F1–F12注册、保存、重开、冲突回退；不代替原版的双击修饰键运行时或临时全局录制。DOM录制是原组件已有回退，startHotkeyRecording必须明确返回success:false及固定不可用说明，不能谎报已开全局监听。双击modifier在Native解析时明确拒绝，保留配置/注册/UI并记录后续完整实现要求；整体唤起键和产品目标不因此算全量完成。Shortcuts页指令绑定另行处理。

## 冻结接口与写入不变量

1. Core17字段：保持R43前16项顺序，末尾追加hotkey，非空string、无控制字符、无首尾空白且UTF-8<=256B；Core不依赖Tauri。Native用锁定Tauri Shortcut解析器严格验证实际可注册格式，未知/双modifier等不改变DB/OS。
2. Native普通主唤起键持有唯一owned ledger。DB配置、调用方previous字符串或is_registered任意字符串均不是所有权证明。注册新键成功前不撤旧键，不触碰其它用途的注册，不调用unregister_all。相同canonical id只更新label且不重复注册。失败自身回收已经成功取得的候选；恢复失败精确SETTINGS_NATIVE_RECOVERY_FAILED，禁止把不确定状态当成功。
3. `hotkey`模块导出私有Rust接口（不新增通用frontend IPC）：
   - `OwnedMainHotkeySnapshot: Clone + Send`，`label(&self)->&str`；非Serialize/Deserialize；可提供cfg(test) `for_test(label:&str)->Self`用于失败IO单测。
   - `setup_owned_main_hotkey(app:&AppHandle, label:&str)->Result<(),String>`，首次获取owned注册，已有不同owned键时拒绝。
   - `read_owned_main_hotkey(app:&AppHandle)->Result<OwnedMainHotkeySnapshot,String>`，核对ledger及Tauri manager实际注册集合，未初始化/丢失/不一致拒绝。
   - `set_owned_main_hotkey(app:&AppHandle,label:&str)->Result<(),String>`，更换并核对，失败自行补偿本次部分效果。
   - `restore_owned_main_hotkey(app:&AppHandle,snapshot:&OwnedMainHotkeySnapshot)->Result<(),String>`，在失败状态也能尽量清理本次owned候选并恢复snapshot，不能凭label注销foreign。
   - `release_owned_main_hotkey(app:&AppHandle)->Result<(),String>`，仅清理本模块自己的键并验证。
4. 生产setup_hotkey的main注册、旧update_hotkey/update_hotkey_from/commands wrapper以及旧General system_effects都复用该ledger；旧caller previous只可作一致性检查。保留pasteboard/paste stack/其它用途能力，避免把它们计为primary owned。hotkey.rs现504行，按primary注册/相关测试等真实职责拆分，禁止继续堆积或全文件格式化commands/lib。
5. renderer native事务复用同一General coordinator、会话锁和取消安全任务，不另开写通道。hotkey-only及opacity/tray/hotkey mixed均先prepareCAS、预读所有会被影响的真实原生快照，再应用/核对→commit→一次main通知；失败按逆序恢复所有started效果（包括部分失败）。含hotkey的恢复失败用SETTINGS_NATIVE_RECOVERY_FAILED；opacity-only保留旧码。纯配置不访问Native；notification false不回滚/不重试。
6. renderer effect IO可将hotkey read/apply/restore封成一个明确port，使用上述Snapshot，不将已超过少量职责的transaction文件扩到500行以上。假IO/真实SQLite覆盖注册失败、注销失败、提交CAS失败、mixed补偿和恢复失败。
7. General projection必须从已验证raw hotkey投影新值（缺失才使用提供的fallback），修复现patch后仍使用旧opening.value.hotkey导致新值丢失的问题。ready的currentShortcut有owned状态时用owned readback；没有初始化的旧smoke可保留configured标签作为读取显示，不能据此确认注册，任何热键写入仍需真正owned注册。
8. Child `updateShortcut(string)`进入既有General串行写队列，以一次patchGeneral hotkey写入取得实际提交回执，推进general.hotkey与runtime.currentShortcut，再返回{success:true}。原Vue随后dbPut相同值不再Native RPC。普通失败返回固定安全{success:false,error}，CAS/结果未知/恢复失败保留sticky与关闭/迟到保护。不得自动生成updateHotkey或重复setter。
9. HotkeyInput原先v-model先emit使handleHotkeyChange捕获新值冒充previous。仅在已有stage可靠性补丁机制内，用getCurrentShortcut取得旧已提交值供失败回退；上游只读、原template/style块完整不变。预设/重置保存同样依赖已提交host回执，不能注册成功却存储失败。

## Native验收与预算

复用settings-input既有profile/runner，托盘之后增加hotkey段。仅本临时应用注册固定低碰撞QA组合 `Command+Ctrl+Option+Shift+F10`(A)、F11(B)、F12(C)。不注册用户常用键、不产生系统按键、不操作用户应用；若实际OS拒绝注册，保留失败，不抢占。

共享setup_owned注册A→原HotkeyInput DOM click/键事件录制B→独立SQLite B、owned+Tauri注册B而A未注册→fresh Child UI/currentShortcut B→用其它用途owned AppShortcut注册C→原控件尝试C被拒且UI/DB/primary仍B、foreign C保持→原控件恢复A→释放自己的primary和AppShortcut并验证无残留。原12阶段/各sidecar/退出门禁保留；Node以17项之外的新精确观察合同独立按事实重算，不信Native passed位。写入器必须真实roundtrip新报告，probe BOOL/string调用合同先Node VM验证，回收在正确线程。

R39两个进程可以后续接入同一低碰撞键的冷启动读回；本票若尚未获得该证据，必须保持“热键跨应用冷启动”未验，不用原R43 tray冷启动假装证明hotkey。OS注册成功/manager成员不等于物理按键能唤起，物理输入另验。

Main JS593891B/上限593920B保持。Settings当前784315B/有效上限784380B仅余65B，绝对786432B不提高。先复用队列/协议/错误保护并实测，必要时语义等价压缩/结构优化释放空间，不删保护或改原UI；不得先改budget。所有新/改作者模块<=500行，现有巨型commands仅必要窄接线。

## QA报告冻结

`native-main-hotkey-report.json` 顶层恰为schemaVersion1、journey=settings-main-hotkey、scope=hidden-original-vue-main-hotkey、identifier/root/pid/runId、observations/errors（9项），无Native passed。28项nullable bool，以下26项须true：initialOwnedRegistered、initialUiMatches、recordDispatched、changedStored、changedOwnedRegistered、previousUnregistered、changedUiMatches、freshChildOnReopen、reopenUiMatches、reopenStored、reopenOwnedRegistered、conflictDispatched、conflictUiRestored、conflictStoredUnchanged、conflictPrimaryPreserved、conflictOtherPreserved、restoreDispatched、restoredStored、restoredOwnedRegistered、alternateUnregistered、unrelatedPreserved、childClosed、ownedPrimaryReleased、otherShortcutReleased、mainRawHotkeyMutationDenied、childRawHotkeyMutationDenied；pluginUiOpened/preloadStarted须false。errors仅settings-main-hotkey-前缀加baseline-invalid/open-failed/record-failed/change-failed/reopen-failed/conflict-failed/restore-failed/readback-invalid/unrelated-changed/close-failed/cleanup-failed/report-write-failed。

探针方法只处理F10/F11/F12字符串代码，Rust以`js_string`生成带引号的JS字面量，JS拒绝其它类型/键码。以NodeVM薄DOM测试真实探针字符串参数与拒绝值，不能称真实Vue/OS验证；Native实际原HotkeyInput click和document keydown/up另验。新报告用真实私有writer roundtrip做准入测试后加入唯一精确allowlist名；当前writer246行可复用，不另建任意路径写接口。Node端对28事实、严格owner、无错误、完整Native终态和清理事实重算pass。

## 首次构建后的 Main 预算决定

正式strict构建首次测得785690B，较R43增1375B，超旧阶段门槛1310B，仍低绝对上限742B。日志`output/renderer-main-hotkey-2026-10-29/settings-build-first.log`保留，构建器已自动清理临时输出且旧dist未promote；不声称保存了失败候选完整文件。

独立只读复核未找到可低风险回收1310B的重复逻辑；新热键已复用General队列、回执与错误保护。Main批准精确新milestone `original-vue-main-hotkey-2026-10-29`：baseline784315B/maxIncrease1536B/absolute786432B，有效785851B。旧三种政策继续按各自原值识别，新旧混用、未知或抬absolute仍拒绝，Main JS政策不变。首次测量在新门槛内余161B，最终以重建和Native来源绑定为准；不是整应用性能或完整包体积测量。

## 独立审查补充不变量

- 仅精确SETTINGS_HOTKEY_REJECTED表示primary未变或已完整自补偿。外层可跳过对本次hotkey重复恢复，但必须补偿此前opacity/tray；post-success读回失败不得错误归为安全拒绝。
- 完整General projection不得在显式快捷键失败后重放旧/新值；显式hotkey intent结果优先，排队全对象保存必须有fence，并保留其它真实General字段。覆盖B成功、C被拒、B的旧save携带C而排后，以及C成功后旧B快照不倒退。
- Main和旧settings不再获得raw GlobalShortcut注册/注销权限，所有生产变更收敛到owned路径。Native安装真实插件且A先注册成功，再从Main/Child各试raw unregister_all，只有确切ACL拒绝且A仍在才算对应两事实true；unknown plugin或任意throw不算拒绝。
- F12冲突的UI/DB原本同为B，不能在dispatch后首次读到B就宣称请求完成。probe须先确认没有旧的精确拒绝Toast，再等待本次原Vue的固定error Toast；`rejectionObserved=true`作为Native冲突事实的必要前提，Node仍保留28项事实合同。未出现提示或旧提示不得通过，VM保留延迟/缺失/陈旧信号的RED/GREEN。
- 锁定GlobalShortcut插件的GlobalHotkey注册错误可以归为安全拒绝；Tauri派发、RecvError或未来错误分支只能归为固定未知结果，manager缺失同样不能返回安全拒绝。未知路径不凭候选label注销可能属于其它功能的键；Child按原unknown保护停止后续写入。

## 并发修复后的最终预算分配

补齐两项有实际RED证据的热键intent fencing后，第二次strict构建测得786127B，比R43增1812B，超1536B阶段额度276B；日志`output/renderer-main-hotkey-2026-10-29/settings-build-fenced.log`保留，旧dist未promote。新增保护不能因资源门禁删除。

Main据实将本票唯一milestone的maxIncrease改为2048B，baseline784315B及absolute786432B保持，有效门槛786363B。按该次实测余236B，距绝对上限305B；最终须重新strict构建并来源绑定。旧milestone及Main JS政策完全不变。此预算只衡量未压缩设置运行资源，不能代表整应用性能。后续扩展必须先处理所剩空间，不能继续无测量抬阶段门槛。

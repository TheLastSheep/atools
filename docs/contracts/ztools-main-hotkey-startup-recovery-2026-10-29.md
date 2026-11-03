# R45 主快捷键启动恢复与冷启动

仓库/工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`，HEAD c34789c0；上游只读9b15fb1a2a9f3ec886016632761c7bb21e39557a。Luna实施，Main定接口/审查/独验。原dirty、默认入口、Node/SQLite、固定资源上限保持，不提交推送。

## 产品行为

已存快捷键格式不支持或注册明确被拒时，普通应用继续启动，保留原DB，不偷偷注册另一个默认键；有恢复入口可进入设置。原General明确显示没有已注册快捷键，用户录制有效键后实际注册/保存；其它设置的保存不能顺带覆盖未修复的原值。下次进程从同一DB启动时由生产共用函数注册新键，原General读回新键。

只将精确SETTINGS_HOTKEY_REJECTED视为安全启动拒绝；未知结果不归为安全/注册成功。损坏的整个JSON、磁盘故障等不借此伪装修复。窗口在生产安全拒绝时显示以提供恢复入口（即使托盘关闭）；fixture仍遵守其已冻结的隐藏策略。物理唤起、双击修饰键及完整普通桌面启动服务仍单列验收，不能由checkpoint或manager成员代替。

## Native接口（crate内部，不新增通用IPC）

- 保持R44 `OwnedMainHotkeySnapshot` 及read/set/restore接口的“必须已注册”语义。
- 新 `OwnedMainHotkeyStateSnapshot: Clone+Send`，不Serialize/Deserialize，封装registry identity/generation与可选已注册snapshot；`label()->Option<&str>`、`startup_attempted()->bool`。cfg(test)提供 `for_test_registered(&str)`、`for_test_unregistered()`。
- `read_owned_main_hotkey_state(app)->Result<StateSnapshot,String>`：None只证明本模块当前没有已注册主键且无未清理owned残留，不用任意is_registered推导ownership；未知/恢复失败拒绝。
- `apply_owned_main_hotkey(app,label)->Result<(),String>`：同一lease内已有owner走set，确认无owner走setup，仍注册新键后才撤旧键；该路径用于显式用户修复，不自动选择fallback。
- `restore_owned_main_hotkey_state(app,&checkpoint)->Result<(),String>`：registered复用旧restore；unregistered检查相同registry及同代/恰一次变更，仅清本次确实拥有的主键/候选，恢复无主键。过期/跨registry/未知失败，不清foreign。
- `MainHotkeyStartup` 提供registered与needs_recovery两个明确状态；`initialize_main_hotkey_from_settings(app)->Result<MainHotkeyStartup,String>`读取现有DB并调用owned setup。明确拒绝返回needs_recovery并记录startup_attempted；其它错误保留。`setup_hotkey`生产入口复用此函数并保留其它用途快捷键；app_setup在needs_recovery时提供显示入口且记录固定warning。
- configured_hotkey仅在缺失字段时使用产品默认值；存在但非string返回不可注册的空标记，不能静默替换配置。保留未修改的原JSON。

## General与旧设置

renderer native effect port使用新state checkpoint/apply/restore，支持从确认无owner的状态修复；CAS、mixed补偿、safe-rejected去重恢复和unknown sticky全部保持。旧Svelte的原生设置效果复用同一state接口，不让默认回退入口成为恢复死路。

SettingsPreferences加载/写后投影以实际owned状态决定展示键：registered展示实际label；确认startup_attempted且无owner展示空串，原raw仅保存在私有opening snapshot供CAS。其它字段仍按原投影校验。不要把原无效字段自动写回默认值。未执行startup的旧legacy smoke可继续显式configured展示回退，不作为注册证明；生产不以此回退冒充已注册。

旧Svelte native writer也必须对比该编辑会话的previous normalized值，仅显式改变的hotkey进入changes；不能把normalize产生的Option+Z随其它设置保存覆盖原false/空值。先执行既有own-data/访问器校验，保持opening CAS、lease归属及preview行为。Native effect diff先比较before/after原JSON热键值（缺失沿用原默认语义），只有真正变更才校验requested string；不因未变化的损坏原类型阻止其它设置保存。回滚依实际state checkpoint。

bootstrap的runtime.currentShortcut允许空串表示无注册（原wire已允许），未知仍报错。Child General读取投影可接受空hotkey，但updateShortcut和Core17字段写入仍严格拒绝空值；direct dbPut不得绕过。原上游loadSettings的`currentShortcut || defaultHotkey`在自有stage可靠性补丁中改为保留实际空串，原template/style不变。保留R44 intent fence/初始baseline与其它字段保存保护。

UNKNOWN registry一旦发生即停止后续读写/恢复，不把重新打开Child当成清除；未知及原生恢复失败的固定提示要求重启应用后确认。已知owned候选的部分失败不等于UNKNOWN：restore_state应在identity/generation检查后重试清理本模块的known uncertain候选，并恢复registered或无owner checkpoint；不能在ensure_usable处提前拒绝所有补偿，也不能删掉检查后假报无残留。

## 验收与预算

单位回归覆盖无owner快照、初始化、同值注册、candidate失败、跨registry/过期快照、从有主键回滚到无主键、foreign保留、safe启动拒绝与unknown区分。真实SQLite覆盖空展示不改raw、修复成功提交与提交失败回滚无主键、mixed恢复及旧Svelte路径。

真实Native使用私有App/DB及四修饰键加F10/F11/F12，零系统键入。优先同一DB两个顺序Tauri进程：第一进程通过生产共用startup函数处理无效/明确占用配置，原General修复为B并保存；退出后第二进程通过同一函数注册DB中的B，General重开B；旧门禁、归属、终态与回收保持。第一进程不以journey手动setup固定B冒充startup，也不以头部seed JSON证明UI修复。

Main JS593891/593920B保持；Settings当前786127B，有效上限786363B、绝对786432B不提高。先实测原控件修复/只读空值校验的增量，不删保护或增加运行时。所有新/改作者模块<=500行，共享commands/lib不整文件格式化。

# R43：原版托盘开关、缺省值与冷启动保持

仓库/工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`，只读上游 `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。Luna实施，Main派单/审查/独立验收；不提交推送、不换默认入口或原Vue/CSS、不扩插件。适用真实Native验收平台为当前macOS，其他平台不由此宣称完成。

## 完整用户路径与合同

原General checkbox先saveSettings，再setTrayIconVisible；原save会吞掉异常，故后一个setter不得无条件执行OS副作用。showTrayIcon作为第16个editable字段追加在原15项末尾，bool only；Native ready、Child和跨语言fixture严格同序。

1. 单次General patch在原协调器/会话/取消安全写保护内CAS prepare→读取真正旧原生状态→应用并读回→commit→单次main通知。纯配置、opacity-only、tray-only及mixed patch均正确；不应用无关hotkey/launchAtLogin等效果。
2. 复用R42事务并按实际职责改名为renderer native effect transaction，不另造写通道。mixed预读两个旧值后才应用；失败补偿逆序覆盖已开始的效果（包括部分失败的效果）。恢复成功的CAS冲突保留原冲突码；opacity-only恢复失败保留原码，含tray的恢复失败用精确`SETTINGS_NATIVE_RECOVERY_FAILED`，两种情况均要求Child重开并停止后续写入。通知未送达仍为已提交false，不回滚或重试。
3. Child `setTrayIconVisible`只确认已成功提交且确实包含tray效果的receipt/value，通知false也可确认；无对应提交、失败或结果未知均拒绝且不触碰OS。需要在新的tray写入尝试时作废旧确认，防止原页面吞错后错误确认。排除自动生成的updateShowTrayIcon；不增加另一个Native setter或额外RPC。保留opacity队列和全部旧General行为。
4. 缺失showTrayIcon的默认值统一为true，显式false保留。Core提供`DEFAULT_SHOW_TRAY_ICON`，Native启动、原General投影/Native effects及旧Svelte默认一致；既有无关开关默认不改变。无效记录/读取失败不能静默当false。原ZTools的true默认已有固定源码证据。
5. 当前锁定Tauri2.11.2、tray-icon0.23.1。真实读回仅查本进程`atools-tray`，用`with_inner_tray_icon`进入主线程读`ns_status_item().isVisible()`；句柄/NSStatusItem缺失为不可见，不能以影子bool或setter成功代替。共享接口为`native_tray_visibility::read_apply(app:&tauri::AppHandle,target:Option<bool>)->Result<bool,String>`同步；None只读，Some应用后读回，非mac明确不支持读回，renderer tray patch须在提交/副作用前拒绝。旧平台setter能力保持，不据此冒充已测。
6. `tray::setup_tray`读取配置，false启动不新建可见status item；首次true再ensure一个有界托盘，后续hide/show复用同一Tauri托盘/菜单监听，避免每次toggle创建新callback。显式false启动不得短暂先show再hide。legacy setter复用同一factory；缺icon/配置错误明确返回错误。默认Svelte入口仍保留，仅修复其默认值false→true。

## 验收与归属清理

复用既有settings-input隐藏journey，在R42 opacity之后增加独立tray段。启动私有General不含showTrayIcon但实际托盘true；原checkbox关闭→独立SQLite false与实际tray false→关闭/fresh Child读回false→原控件开启→DB/实际tray true；最后释放本测试托盘并确认不可见。旧12阶段、材质/主题、本地应用/禁用/inventory/alias/opacity及owned cleanup保持，不用直接mutation替代UI动作。

`native-tray-visibility-report.json`固定顶层schemaVersion1/journey=settings-tray-visibility/scope=hidden-original-vue-tray-visibility/identifier/root/pid/runId/observations/errors，无Native passed。observations为nullable bool：startupDefaultVisible、initialUiEnabled、disableDispatched、disabledStored、disabledNative、freshChildOnReopen、reopenUiDisabled、reopenStoredDisabled、reopenNativeDisabled、enableDispatched、enabledStored、enabledNative、unrelatedPreserved、childClosed、trayReleased（均须true），pluginUiOpened/preloadStarted（须false）。errors固定settings-tray-visibility-前缀+baseline-invalid/open-failed/disable-failed/reopen-failed/enable-failed/readback-invalid/unrelated-changed/close-failed/cleanup-failed/report-write-failed。Node独立按事实、owner、terminal/clean重算通过。

冷启动复用现有R39两进程协议：seed本来是headless元数据/DB进程，不是Tauri UI。它用真实Core把本次私有General显式设false并记录true的traySettingStored与false的trayConfiguredVisible；cold main通过生产setup读取同一DB并记录false的trayConfiguredVisible和真实trayNativeVisible。该seeding不代替上面的原控件验收。将这四项加入既有严格seed/main报告和Node gate，报告schema升级2并同步profile/handoff验证及测试；保持现有disabled/document/attachment/DB identity证据与清理，不造新CLI/profile/controller。

Core/Native以真实临时SQLite、可失败的原生IO adapter验证类型/范围、CAS、部分应用与补偿、mixed回滚、通知失败、平台不可用和旧路径回归。前端使用实际Core字段表验证16项能力握手；对直接/保存失败后的setter确认和通知false、迟到/关闭/队列均有证据。只能声称AppKit属性/本进程原生对象事实，菜单栏物理像素另验。

Main JS593891B/593920B保持。Settings783356B，当前有效门槛783560B，先保持门槛实测；若新增必要逻辑越限，保留失败候选并由Main明确记录预算决定，绝对上限786432B不提高，不通过删除保护/改原版UI过关。新增/修改作者文件<=500行。

## Main 预算决定（首次构建后）

首次严格构建测得784315B，较R42增加959B，超过旧有效门槛755B；失败日志保留在`output/renderer-tray-visibility-2026-10-29/settings-build-first.log`。构建器按既有事务自动清理临时输出并保留旧dist，因此只保留失败测量日志，不能声称保存了失败候选的完整文件。

Main批准新的Settings-only milestone `original-vue-tray-visibility-2026-10-29`：baseline783356B、maxIncrease1024B、absolute786432B，有效门槛784380B。该决定覆盖本票必要的保存/恢复/确认保护；旧legacy及disabled政策继续按各自精确值识别，未知milestone、旧ID套新值和抬高上限仍拒绝。Main JS政策不变。首次测量在新门槛内剩65B，仍须以最终严格构建及来源绑定实跑为准，不等于完整应用体积、RSS或时延预算通过。

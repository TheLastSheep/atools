# 原版 ZTools 主界面交互接入合同（2026-10-26阶段快照）

工作区 `/Users/harris/Desktop/atools`；开发分支 `codex/atools-ztools-parity`。固定上游为干净的 `/Users/harris/Desktop/ZTools`，commit `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。原版 Vue/CSS 只读，默认入口未切换。本文件保留2026-10-26阶段的实现与证据边界，不代表后续R系列完成后的当前状态；源码、浏览器模拟、真实SQLite与原生桌面验收分别记录。

2026-11-02复核：下文将设置入口、自动粘贴、别名/主题事件等列为unsupported的内容已被后续交付取代，不得据此重复派单。当前前沿见[执行计划](../superpowers/plans/2026-10-26-atools-original-renderer-and-sync.md)、[General剩余接线](ztools-general-remaining-controls-2026-10-29.md)及各自验收记录；新任务仍须核对当前源码。插件生命周期与完整可见/物理交互并未由这些后续实现自动获得验收。

## 已接通的调用链

| 用户动作 | 固定上游契约 | 当前 ATools 接入与证据边界 |
| --- | --- | --- |
| 主窗重新聚焦 | `App.vue:529` 的 `onFocusSearch(windowInfo?)` 按偏好清空或保留 query，重置列表，聚焦并全选保留文本。 | `focusEvents.ts` 复用一个 `tauri://focus` 订阅，`tauriTransport.ts` 定向 `Window/main`。Tauri 2.11.2 native focus payload 是 `()`，不伪造前台窗口信息，capability为limited。fixture已验证两种真实原Vue DOM分支；真实OS唤起/显示链仍待验。 |
| 启动读取设置 | `windowStore.ts:546` 和 `commandDataStore.ts` 读取general及13个原版domain keys。 | `settingsSnapshot.ts` → `get_ztools_renderer_settings` → `renderer_settings.rs` → `Database::read_settings_bounded`，一次固定14键快照。main-only，读事务/参数化SQL/prepare_cached，缺失保留null，general64KiB、其余128KiB、总键和值1MiB；general仅31字段投影。浏览器观察设置读取11→1，全部启动invoke14→4，另1次listen注册。 |
| 搜索并选择系统应用 | `SearchResults.vue:659` 调用 `launch({path,type,featureCode,name,cmdType,confirmDialog,param})`。 | 单次`launch_renderer_app`在Rust重新检查原生目录路径，沿`call_tool_with_audit/open_or_reveal_path`及权限/TaskRun启动，成功才原子记录历史；权限拒绝不记历史、不重试。已启动但写历史失败返回明确部分成功错误。浏览器仅模拟回执，真实系统启动与TaskRun往返未验。 |
| 保存搜索偏好 | `commandDataStore.ts:723` 把小写trimmed query映射到`{path,featureCode?,name}`，写search-preference并影响后续排序。 | 仅允许有界JSON写`ztools-renderer:search-preference`；set_setting成功才更新readModel，晚到失败旧读不删除新缓存。临时SQLite已验证写→重开→快照读取；原版页面重启排序仍待端到端验证。 |
| 动态尺寸和隐藏 | `src/preload/index.ts:29-30` 是ipcRenderer.send，resizeWindow/hideWindow返回void。 | `windowNotifications.ts` 保留单向通知，检查有界高度，固定诊断记录失败/取消；dispose后丢弃迟到布局通知，不产生未处理Promise。浏览器明确排队迟到resize后，native计数未增加，dropped=1。 |
| 应用历史、固定与排序 | 原版以path+name区分别名，固定优先persistedName；排序需通知以释放乐观更新标记。 | 有界Rust事务保存namespaced历史/固定及revision；全量快照一次回执，事件与回执去重，乱序按值补跨域通知。相同顺序仍确认排序。两个domain先一起解析再替换缓存，旧读不覆盖新缓存；迟到读失败保留原错误。应用域支持，插件/未知记录保留，混合插件列表排序仍拒绝。 |
| 原生右键菜单 | 原Vue生成菜单，onContextMenuCommand消费原action ID。 | Rust只创建一个有界菜单会话；Window/main选中事件回原Vue处理。支持应用pin/unpin/remove/reveal；未知项与submenu保留标签并禁用。前端白名单在popup前生效、只消费一次；native popup期间抑制main失焦隐藏。真实系统菜单和焦点时序待原生隔离验收。 |

核心状态模块：`packages/ztools-renderer/src/hostAdapter.ts`、`focusEvents.ts`、`settingsSnapshot.ts`、`startupReadModel.ts`、`windowNotifications.ts`。页面退出经pagehide释放监听；异步注册迟到后解除，pending注册和pending清理分别计数，清理错误不藏进零成功状态。

## 当时缺口（2026-10-26）

1. **真实桌面焦点与窗口上下文。** 已订阅Tauri原生focus，不等于验证完整show/toggle→可见/聚焦→失焦隐藏→再次唤起。连续显式show是否产生预期通知、WebKit/WebView2焦点、跨显示器和关闭竞态仍需原生隔离验收。现有Rust `window.rs`、`window/activation.rs` 负责显示和前台请求；不得仅凭成功返回声称物理窗口已恢复。
2. **自动粘贴。** 原版默认可能启用autoPaste，focus回调会调用`getLastCopiedContent(timeLimit)`。当前该API明确unavailable，不能返回null伪装已读取。本批fixture显式autoPaste=never，不读真实剪贴板。后续接入需复用权限与TaskRun管线，区分显式粘贴和自动聚焦；不得以一次focus自授读取权限。
3. **插件身份、混合排序与推荐固定。** 应用域历史/固定写入和事件已接通；插件项增删、混合插件完整排序及recommendation-pinned仍待后续。不会把插件快照当应用处理，也未开放任意dbPut。当前单域4096项/128KiB、修改队列16项，超限整次拒绝，不截断旧记录；原版无此持久化上限，不能声称无界数据兼容。
4. **设置、别名、禁用与主题更新。** `openSettings()`由Cmd/Ctrl+,和头像菜单触发（SearchBox.vue:435、1009），仍unsupported。原版设置app在`internal-plugins/setting`；独立Tauri配置的base settings窗口仍指向`/#/settings`，尚未接入。别名、禁用、主题等变更事件仍inactive；批读cache需要在真实写入事件到达时按domain失效。
5. **插件生命周期。** 当前新renderer仅提供真实已装目录读取；插件启动、面板、SubInput、detach、后台/Node等需沿已有plugin lifecycle/permission/TaskRun模块接入。Harris原包仍优先，不能用应用启动白名单替代插件权限。

## 当时的下一批实施顺序

先完成隔离原生主窗显示/焦点与菜单验收及设置入口，再补自动粘贴权限、原版偏好重启排序和插件身份。startup batch已完成，不再另建LMDB/LevelDB或任意key查询；后续如优化重复布局通知，应测通信与实际尺寸语义，不能删除合法resize来凑零调用。现观察立即清空分支3次61px布局、保留分支1次，均记录在report。

本批应用状态证据：`output/renderer-app-state-2026-10-26/verification.md`；前批聚焦与启动证据：`output/renderer-activation-batch-2026-10-26/verification.md`；上一批原版构建/同步子集证据保留在`output/atools-replication-2026-10-26/verification.md`。这些是阶段结果，不能据此宣布完整UI、全插件生态或完整同步协议已还原。

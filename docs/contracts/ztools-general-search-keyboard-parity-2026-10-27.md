# R16 General 搜索与键盘偏好契约

目标：保留原版 Vue 模板/style、同窗身份/资源/CAS/退出边界，接通八项本地偏好，形成实际控件编辑、SQLite 保存、主界面实时更新与重开读回；完整主程序目标继续进行。

固定工作区 `/Users/harris/Desktop/atools`、开发分支 `codex/atools-ztools-parity`；只读上游 `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。默认 Svelte 不切换；插件后置，Harris 优先。Cargo/build/GUI 由主 Agent 串行或按已知独立边界执行，实施由 Luna worker 完成，不派生。

## 13 项 writable 字段顺序

保留已有五项：`placeholder, theme, primaryColor, customColor, autoClear`。

按以下顺序追加八项：

| 字段 | 合法写入值 | 原版主界面 callback | 设置页 commit 后 internal 通知 |
|---|---|---|---|
| showRecentInSearch | boolean | onUpdateShowRecentInSearch | updateShowRecentInSearch |
| recentRows | integer 0..20 | onUpdateRecentRows | updateRecentRows |
| pinnedRows | integer 0..20 | onUpdatePinnedRows | updatePinnedRows |
| searchMode | aggregate / list | onUpdateSearchMode | updateSearchMode |
| showMatchRecommendation | boolean | onUpdateMatchRecommendation | updateMatchRecommendation |
| tabKeyFunction | navigate / target-command | onUpdateTabKeyFunction | updateTabKeyFunction |
| tabTargetCommand | string，无控制字符，受已有原始记录/请求字节限制 | onUpdateTabTarget | updateTabTarget |
| spaceOpenCommand | boolean | onUpdateSpaceOpenCommand | updateSpaceOpenCommand |

JSON 不做布尔/数值/字符串隐式转换。行数按数值的整数语义处理：`2.0` 与 `2` 同值，接受后按整数写入；非有限值、小数、越界值、布尔和字符串拒绝。最大 patch 字段数为 13；未知字段和其他 readonly 字段拒绝，现有 raw/请求/投影预算保持。已存长 placeholder 可读，改变 placeholder 的写入仍 ≤512 bytes。Core 提供纯校验和字段常量，Native child gate 与偏好存储复用该校验，避免三套不同允许范围。

主 renderer 原有直接 General mutation 客户端仍只允许原五项，除非另有已确认调用需求；本轮扩展从原版 setting child 的窄接口进入。Core 数据层的同一 CAS seam 与共享 coordinator 继续使用，不给 child 开放通用 save/set 命令。新八项不触发 OS 系统副作用。

## 通知与生命周期

仍使用一个精确投递给 main Webview 的 General raw event。main 只挑选、验证已支持字段并转发原版回调，不向回调输出 raw/未知字段/秘密。八项在启动时的 existing General read 与保存后的通知都必须有效。

child 的通知方法只确认匹配当前已提交值且 notificationDelivered=true 的回执；不得用空 Promise 伪报成功，也不得重复发送第二次保存请求。pending≤32、opening revision、迟到回执/Closing 检查保持。其他系统设置/autoPaste/账号/插件动作仍明确 unsupported。

## 固定性能边界

- main 全 JS ≤min(589824, 570144+16384)=586528 bytes，R15 实测586521。
- settings 全运行资源 ≤min(786432, 749106+16384)=765490 bytes，R15 实测765442。
- 不抬上限或重设基线绕过增长限制；不新增运行时、依赖、常驻进程、每字段 Native listener 或轮询。
- 优先复用已有 schema/回调注册和数据驱动通知；任何压缩必须保留严格类型、字段边界和错误语义，不用删验收信息冒充性能优化。

## 验收范围

真实 Tauri General 控件依次修改八项（先将 searchMode 从 list 改为 aggregate，并开启最近使用，以显示行数控件）；独立 Native 数据库读取、main 原版 store/可见结构、重开后的控件与已提交值交叉验证。主界面 store 仅作为 observer，不直接改值；没有数据的列表不得据此宣称行数视觉效果已验。

搜索布局通过只读 `getApps()` 获取临时查询候选，在自有临时主窗口实际输入并观察 `.aggregate-view .search-results .app-item`，随后清空并恢复焦点；不得启动、打开或固定系统应用。报告仅保留 mode、selector、visible、queryInjected/queryRestored、结果数量与固定失败原因，不保存查询、应用名或路径。成功必须有至少一个可见结果且输入已恢复；目录为空或 API 不可用均保持失败。此项不验证行数视觉上限。

`settingsView` 报告升级 schemaVersion=2，增加 `preferences`，包含固定八字段的独立 edited/committed/mainApplied/reopened 证据和 readonly/invalid patch 拒绝。额外 `coldStartup:{passed,fieldCount:13,tabTargetCommandBytes:2049}` 在任何插件模式或写入之前，将实际主 Vue/Pinia 初始化值与 Native 固定 seed 的 13 项逐项核对；不把 seed 读取称为保存新值后的进程重启测试。保留所有 R15 必填成功条件、完整来源/二进制绑定和零残留检查。主 Agent 维护 Node verifier，实施者不得放宽通过条件。VM/纯函数不算 GUI。

完整设置标签、OS 效果、自动粘贴、实际目标指令/插件执行、物理输入/IME、像素/材质、跨平台、RSS/CPU/延迟等仍按总目标继续验收；本切片不代替这些要求。

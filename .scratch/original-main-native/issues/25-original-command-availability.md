# 25: 原版设置禁用与启用指令

**What to build:** 用户在原版全部指令菜单禁用指令后，保存实际禁用列表并立即刷新原主搜索过滤；重新启用后恢复搜索。保持原 Vue/CSS，保留其它类型与未知 ID，旧快照不得覆盖较新修改。

**Blocked by:** 17/19 的真实设置输入与会话边界、22 的实际菜单与命令设置快照已具备；24 的可见性验收独立保留，不阻止本功能。

**Status:** verified-hidden-native-slice — Luna 分工实施，Root 审查并独立验收。原版 direct/app 指令流程通过；可见UI与插件启停兼容不在本票通过范围。

- [x] 原版 `dbPut('disable-commands', string[])` 与随后通知不改接口；仅开放该固定命名空间写入。
- [x] 完整已读 commandSettings token 绑定当前 session/bundle，SQLite Immediate 锁后 guard 与语义 CAS；冲突、关闭、格式错误、存储错误不覆盖数据。
- [x] 数组最多4096项、每项UTF8最多16448字节、编码最多128KiB；新写操作有单独明确的 envelope 上限，其它操作既有上限不变。
- [x] 提交后只通知 Main，一次批量写/一次通知；两层缓存先失效再回调，旧在途读取不能回填旧状态，不重扫系统应用。
- [x] 原菜单禁用/启用→真实SQLite→原Main store排除/恢复，在同一 fresh Child 的隐藏原生流程验证；不据此宣称物理输入或像素验收。
- [x] 保持原12阶段、材质/主题Native状态及回收门禁；按R34实测基线冻结R35 Main 1KiB与Settings 4KiB增量双预算，完整记录调整与实际成本；不新增常驻Node、Child或observer，不切默认入口、不提交推送。材质可见快照仍未验收。

Core、Native、Child、Main分别实施；Core与Native定向检查、两端类型/行为检查、正式资源构建及真实原生流程由Root统一验收。最终运行 `00ad4fd41e6d4d90859d67ab76f91a23`：禁用/启用10项、原12阶段全部通过，exit 0，资源全部回收。Core9、Native314（另1忽略）、严格dist reader单独1、前端249、Node68通过，workspace编译通过。完整证据见 [R35验收记录](/Users/harris/Desktop/atools/output/renderer-disabled-commands-2026-10-28/verification.md)。主程序优先，插件运行兼容仍后置。

旧累计资源门禁拒绝的候选与本期基线调整分别保留，见 `output/renderer-disabled-commands-2026-10-28/budget-decision.md`；不能把新预算记录为优化或运行性能通过。

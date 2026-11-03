# 17: 原设置页的子输入框与只读状态

**What to build:** 用户进入所有指令或快捷键页后，父窗口显示原版子输入框，输入实时筛选真实目录；读取实际禁用/固定/快捷键状态，返回搜索时正确恢复，消除当前 HostUnsupported 生命周期和列表读取错误。

**Blocked by:** 03/05 原版设置承载已具备；16 的有界传输及真实路由接口已落定。不是要求 16 的完整 UI 验收先通过；该票正是收敛其已发现的 UI 依赖缺口。

**Status:** in-progress / partial — R28浏览器输入链与R30真实隐藏Tauri Main↔Rust↔Setting输入/目录筛选、route owner、关闭重开已验证。当前Main589758 B、Setting778122 B，原预算保持；19仍保留重开后旧session重放等明确缺口，完整可见UI及非空禁用/固定/快捷键状态业务验收仍开放。证据：`output/renderer-native-input-2026-10-27/verification.md/json`，保留R27/R28历史记录。

- [x] 先冻结 pinned SubInput 调用、参数/回调、父输入回传与退出语义，复用已有机制；不伪造成功或另建无归属的桥接。
- [x] 新增只读能力仅访问确定 namespace，从真实数据库区分缺失与错误，不返回虚构空列表；禁止顺便开放任意写入。
- [ ] 会话、路由、子视图身份与迟到回调隔离；切页、关闭、重开后监听和缓冲归零。
- [ ] 原 DOM 输入→实际目录筛选、正确状态显示→返回恢复；失败/不支持项仍明确记录。
- [x] 先检查余量和共用职责，保留现有性能约束；不通过删原 Vue/CSS/字典或静默抬预算过门禁。
- [x] Root 派单和独立测试，Luna 实施；浏览器模型、SQLite/Native 事实、可见 UI 分开记录。R30新增227项相关回归和隐藏Native十阶段/实际exit0通过；旧预算、seed和夹具错误保留，未切换默认入口。

事实源：R26 `1a4b316a` 原设置 DOM run，alias slice 通过而整体 partial；14 条真实未支持诊断涉及 SubInput、禁用指令、搜索/超级面板固定、全局/应用快捷键读取。插件仍后置，先修主程序。

R69仅补原版内置 `search/esc` 开关切片：Core单键CAS、Main既有General事件和原Shortcuts控件保存/失败恢复，浏览器三会话原DOM闭环通过，5检查/4截图、exit0且监听/请求/资源归零。来源、预算、strict/回归见 `output/renderer-main-frontier-r69-2026-10-29/verification.md`。浏览器为synthetic transport；不支持的close/kill保持拒绝，Native GUI/物理输入/完整快捷键与完整UI仍开放，不关闭整票。

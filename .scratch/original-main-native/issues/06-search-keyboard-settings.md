# 06: 搜索与键盘通用设置实时生效

**What to build:** 原版 General 页可修改搜索模式、最近使用/推荐显示、最近/固定显示行数、Tab 模式与目标、空格打开指令；保存后主界面实时更新，重开保持。

**Blocked by:** 03 同窗 General 与 05 子视图承载（已满足）。

**Status:** complete — 本地 R16 切片已验；完整产品目标继续进行

- [x] 原版八个控件走真实存储、实时通知与重开读回；不只扩数据库白名单。
- [x] Core、Native、child 明确共用/对齐 13 项字段范围；类型严格、旧快照冲突拒绝、未知/敏感字段保留且不外泄。
- [x] 每字段只复用一次已确认的保存通知；没有新增每字段监听、轮询、进程或依赖。
- [x] 固定资源预算保持，schema/通知去重复后实际构建达标。
- [x] 真实 Tauri 证据与独立校验通过，原五字段、权限拒绝、主窗往返、退出零残留保持。
- [x] 其他系统设置、自动粘贴、指令/插件执行和完整目标保持开放，不用部分成功代替整体还原。

证据：`output/renderer-general-parity-2026-10-27/verification.md/json`。设置运行 `afd63309-2995-4a10-9c36-f91dd6d66c3a`、共用双视图回归 `08a3f793-c321-4f3c-b73c-9d9641f07e3d`：两种偏好共36主窗阶段通过，新增八项四阶段证据、13项冷启动seed读取、实际aggregate结果与恢复输入、只读/错误类型拒绝及零残留均通过。Core312/3ignored、Native103、Main127+strict、VM、正式构建及workspace check通过。JS586,513、设置资源765,455 bytes，固定预算余量15/35 bytes。默认Svelte未切换，行数视觉上限、实际指令执行、OS/物理输入/视觉及跨平台仍不在本切片验收范围。

R69仅补原版内置 `search/esc` 开关切片：Core单键CAS、Main既有General事件和原Shortcuts控件保存/失败恢复，浏览器三会话原DOM闭环通过，5检查/4截图、exit0且监听/请求/资源归零。来源、预算、strict/回归见 `output/renderer-main-frontier-r69-2026-10-29/verification.md`。浏览器为synthetic transport；不支持的close/kill保持拒绝，Native GUI/物理输入/完整快捷键与完整UI仍开放，不关闭整票。

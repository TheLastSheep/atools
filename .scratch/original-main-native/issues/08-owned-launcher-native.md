# 08: 原版键盘与自有应用真实启动

**What to build:** 原Vue搜索/ArrowDown/Enter或Space→生产catalog与权限→TaskRun→自有临时Mach-O应用→历史记录和完整回收。

**Blocked by:** R17固定资源与来源（已满足）。

**Status:** verified-scoped

- [x] 共享catalog source保持生产限制，fixture只注入已验owned目录。
- [x] 未列路径与持久Deny真实拒绝，不启动或记history。
- [x] 两case从真实DOM按键启动自有Mach-O，TaskRun/audit/marker/PID/history独立证据全部成立。
- [x] Node独立校验报告与marker，未知进程不删root；来源与零残留回收成立。
- [x] 相关回归、fresh构建绑定、实际Native与原settings/multi回归通过，整体目标继续。

契约：`docs/contracts/ztools-renderer-owned-launcher-2026-10-27.md`。

当前证据见 `output/renderer-launcher-2026-10-27/verification.md/json`：1067输入构建的launcher/settings各两case通过；通用双视图两case焦点失败。1069输入诊断构建两case仍失败，API请求成功而DOM hidden/未聚焦，全部自有资源回收。未将旧positive视作最新构建通过，最后一项与整批继续in-progress。

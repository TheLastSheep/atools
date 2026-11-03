# 33：原版 General 主唤起组合键

**What to build:** 原“呼出快捷键”控件能更换并持久保存普通组合键，冲突时保持旧键与界面，关闭重开能正确读取；注册与数据库失败可恢复。

**Blocked by:** 04/05、31/32已有共享写协调与可恢复原生事务。

**Status:** verified — R44普通组合键macOS hidden切片；合同 docs/contracts/ztools-original-main-hotkey-2026-10-29.md，证据 output/renderer-main-hotkey-2026-10-29/verification.md/json。

- [x] 唯一owned主键注册，生产启动/旧设置/原版Child代码共用，不误注销其它用途键；不等同完整普通启动或物理输入验收。
- [x] 原控件→一次CAS/Native提交→fresh Child保持→本次拒绝提示确认冲突回退→恢复与退出回收。
- [x] 部分失败/CAS/mixed/恢复失败/通知/迟到与取消有回归，未知线程结果与未初始化/不支持格式不假成功。
- [x] 原Vue/CSS、固定绝对资源上限、来源绑定、旧门禁和私有资源清理保持。

真实run `11592c7cf3c64a99a0a7e51071687706`，PID54927 exit0；28项事实、旧12阶段与sidecars通过。R39两进程回归run `b9f15a2a92094f15b5f44bc6f54d95da`通过，但不含主热键冷启动。

双击修饰键、全局临时录制、物理按键唤起、跨进程热键冷启动和其它Shortcuts页绑定仍需完整实现/验收；不得将此普通组合键切片称为全部快捷键完成。

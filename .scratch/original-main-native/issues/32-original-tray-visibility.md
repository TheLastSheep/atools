# 32：原版托盘开关即时生效和冷启动保持

**What to build:** 原通用设置可显示/隐藏ATools托盘；关闭重开与应用冷启动保持用户选择，新用户默认显示，保存失败不误改系统状态。

**Blocked by:** 03/04/05及31已提供原设置、共享CAS/取消安全写入与可补偿原生事务；可见像素另验。

**Status:** verified-hidden-native-macos-slice — R43，Main 独立实跑 `0ff30d6270774ac8ab886b071be154a1` 与两进程冷启动 `b9428f88fd1d489a9364dde5049378ed` 通过，全部归属资源清理。证据 `output/renderer-tray-visibility-2026-10-29/verification.md/json`；合同见 `docs/contracts/ztools-original-tray-visibility-2026-10-29.md`。

- [x] 原checkbox→单次提交与实际原生读回→fresh Child保持→恢复；后续setter仅确认，不重复产生OS副作用。
- [x] 默认true与显式false在Core/Native/两种前端一致，冷启动false不先创建可见图标。
- [x] 同一私有SQLite的headless seed与独立Tauri cold main证明false保持，原R39证据全部保留。
- [x] 类型/CAS/应用与提交失败/混合效果补偿/通知未送达/关闭均受保护，不假成功。
- [x] 不新增Node、产品轮询或每次toggle菜单监听；预算、来源、旧Native门禁及归属清理通过。

本票不等于菜单栏物理像素、完整系统设置、跨平台或整体UI已验收。

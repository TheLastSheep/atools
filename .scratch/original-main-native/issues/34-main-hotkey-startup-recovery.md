# 34：主快捷键启动恢复与冷启动

**What to build:** 快捷键无效或明确被占用时仍能进入应用和设置，原控件修复后下一进程从原数据库注册新键。

**Blocked by:** 33普通组合键编辑与owned注册。

**Status:** verified-scoped — R45 macOS hidden original-General slice；完整普通启动与物理/可见验收保持开放。

- [x] 安全拒绝由生产共享初始化函数返回恢复状态，不覆盖原配置或偷偷选默认键；未知结果不冒充可用。普通 app_setup 恢复入口代码已审查，完整启动/窗口显示未实跑。
- [x] 原General显示无注册态，可修复为新键；无关保存保留未修复原值。真实SQLite、原DOM与owned/Tauri manager读回通过。
- [x] 取消/CAS/mixed失败恢复到真实无主键状态由Native回归覆盖；默认Svelte writer修复/保留由单元及类型检查覆盖，未作真实Svelte UI验收。
- [x] 同一私有DB两个顺序进程证明修复、退出释放、实际生产共享startup函数注册与原General读回。首进程B保持注册直到自然退出，第二进程重新注册。
- [x] 原Vue/CSS、固定资源上限、来源绑定、R44/R39旧回归及私有资源回收保持。

独立验收：[verification.md](/Users/harris/Desktop/atools/output/renderer-hotkey-startup-recovery-2026-10-29/verification.md)。R45 run `d1e1cb1858a345a0afdd06818cecda59`，PID38116→38147；旧设置run `21a7d4ecfeb943288926455f41995d40`，旧持久状态run `2478b94ba9c74a9a9e2f357f8097b0dd`。五进程自然exit0且自有资源回收。原生启动夹具用无效键；外部应用占键启动、物理唤起、双击修饰键、全局录制与可见像素另验。整体goal active，默认入口不切换。

# 23: 原版主窗口的原生材质与主题

**What to build:** 原版Main入口从启动、搜索、进入设置到返回搜索，持续具有固定上游macOS FullScreenUI材质，主题跟随system/light/dark；默认Svelte回退及其他窗口不被误改。

**Blocked by:** 原版宿主/设置十二阶段已具备。原生层已接通；剩余视觉诊断可继续，不以未知的物理合成结果伪填通过。

**Status:** partial — R33 原生层已验证，完整视觉及回退场景仍开放。证据：`output/renderer-native-material-2026-10-27/verification.md/json`；最终run `06353d9ac8ab4353902c115d31ccdab8`，十二阶段/三种主题/WK透明读回/退出回收通过，严格视觉检查未通过。

- [x] 从可信host config/原版入口与已验证的自有smoke入口创建呈现租约；原版Main完整生命周期持有，不能只在Settings打开期间生效便宣称Main对齐。
- [ ] 默认Svelte打开原设置页的场景有单独临时租约，关闭/失败恢复原状态；多个持有者及窗口销毁不误清仍在使用的材质。
- [x] 保留原Vue/CSS及既有General偏好，Native材质使用固定上游同名FullScreenUI；system/light/dark的effective appearance有真实事实，不改系统全局主题。
- [x] 锁定Tauri2.11.2在macOS set_effects(None)不清理，使用经验证的clear/自有AppKit机制回收；不得用no-op伪清理。
- [ ] 先单元验证所有权/启用/关闭失败，再Root独立Native观察材质、主题和退出回收；隐藏属性观察、WebView快照与可见合成像素分别记录。
- [x] 没有抢前台、CUA/AppleScript或用户桌面截图；若隐藏快照不支持，保留失败及未验边界，不改前台策略凑通过。
- [x] 原预算/来源绑定保持，不增加Node或其他进程；Root审diff、正式构建及验收，Luna实施，不提交推送。

已修 Child 默认白底，九个有 Child 的阶段均实际读取 drawsBackground=false。首次原始 PNG 曾见旧菜单残影；新增只读门禁后，最终两主题的route/media/root与General标签颜色通过，但菜单未消失、侧栏综合颜色未满足、1秒内未观察到双RAF，故不落合格截图。原因未定，不能只归因于hidden或认定产品CSS缺陷。

独立审查修复了精确原版入口选择、stop后的迟到acquire、释放失败/取消后永久Closing问题；重复关闭使用同一opaque lease token恢复，实际原生故障注入仍未做。default Svelte临时租约已有接线/纯策略覆盖，但没有独立真实Native场景，保留未勾选。

只读依据来自固定上游9b15及本地锁定Tauri/window-vibrancy源；不使用已安装ZTools3.2替代pinned3.0.1基线。禁用命令写入、完整设置/迁移和Harris插件继续独立跟踪。

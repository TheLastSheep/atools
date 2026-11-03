# 46：原版关闭插件快捷键与原生窗口关闭

**What to build:** 接通原 ShortcutsSetting 的 closePlugin 开关，macOS CmdW 根据 Main/Settings 当前状态返回搜索或隐藏；开关关闭后按键交页面。窗口关闭与真正退出保持各自语义，复用现有会话和 General 事务。

**Blocked by:** R69 内置 search/esc 开关及 R71/R73 已有所有权/录制清理；真实 GUI 缺口单独保留，不重复等待失效桌面控制链。

**Status:** in-progress — R74 实现、自动检查与独立复核通过；真实 macOS 交互和 Windows/Linux 后端仍开放，不据模型检查关闭本票。

- [x] 三布尔 DTO、Child 单键/Core 合法集合 CAS、默认 true、未知字段保留，kill 不扩展。
- [x] 原 ShortcutsSetting 保存/重开/失败恢复及 HotkeyInput CmdW 合成 DOM 录制，不改模板/CSS。
- [x] macOS 两处自有 Close 菜单投影、原生读回与实例归属代码、焦点和设置事务；模型/源码检查通过，实际系统菜单仍待最后一项。
- [x] Settings 正常 outAck/清理返回、搜索隐藏、统一完成点 100ms 保护及旧代隔离已实现和自动检查；CmdQ 角色保留，真实系统行为待最后一项。
- [x] 定向测试、正式资源、默认/双 feature 工作区检查和冻结差异独立复核。
- [ ] 真实 macOS 菜单/按键/窗口行为及 Windows/Linux 后端分别完成；不得据模型/DOM 检查关闭本票。

合同：`docs/contracts/ztools-close-shortcut-2026-11-02.md`。

本批证据目录：`output/renderer-close-shortcut-r74-2026-11-02/`。Main 上限保持 606381 B；Settings 先守 802953 B，必要时按事前最多 1024 B 增量登记 803354 B milestone。无新进程、轮询或每键 IPC；默认 Svelte、主程序优先、完整目标继续。

最终见 `output/renderer-close-shortcut-r74-2026-11-02/verification.md`。Main604522 B（+96）、Settings802653 B（+323），未提高预算。Terra 普通复核通过；Astra 三项发现修复后 NO FINDINGS，绑定 Native32源414cc7ca；Root50源哈希匹配、最大500行。无 App/GUI/OS 输入，保留全部失败及未验边界。

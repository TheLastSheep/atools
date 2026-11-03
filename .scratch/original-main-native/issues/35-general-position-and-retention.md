# 35：原设置的窗口呼出位置与剪贴板保留

**What to build:** 原 General 中可修改窗口呼出位置、剪贴板保留天数并重置到180；后续窗口定位与历史清理使用已提交配置，不抢前台或清空历史。

**Blocked by:** 34 主快捷键启动恢复与冷启动（指定 hidden 切片已验）。

**Status:** verified-scoped — R46，macOS hidden 原 General 与生产消费者切片。

- [x] 原控件保存/重开读回，保留坏旧主键与其它配置，通知不重复IPC；修复fresh同值保存误报，未确认收据仍拒绝。
- [x] 四项可写；hidden实际cursor/primary/lastActive缺上下文fallback为(712,414)，remember非居中位置恢复；外部活动窗口跨屏/物理和非mac仍列开放。
- [x] 30→1→180通过生产capture清理私有夹具数据、pin保留；零系统剪贴板访问，重置前后历史快照相同。
- [x] 边界/CAS/退出/权限、strict原版构建、固定预算、旧回归和自有资源回收通过。

具体契约见 `docs/contracts/ztools-general-policies-2026-10-29.md`。

证据 `output/renderer-general-policies-2026-10-29/verification.md/json`。实际settings run `5aba4b72983f47a6aed455fdfc9e95c5`（PID15765），R45回归 `9594607b7c574d1e8ec95bfa8addd029`（17098→17118），R39回归 `db1fcfb80e144f0b8537305674a3cc3c`（17252→17454）；同一最终二进制，五进程自然exit0且自有资源清理。Core356/3ignored、Native相关517/1ignored、前端152、Node159及启动13、Pasteboard集成9、Svelte/strict/workspace通过；套件不累加。Settings786336B，有效余27B、绝对余96B，Main593891B余29B，未提高上限。

完整可见UI、物理键/IME、外部活动窗口实际选择与混合DPI多屏、Windows/Linux、全普通启动/默认入口和整应用性能未验。整体goal仍active，主程序优先、Harris原包后置，无commit/push。

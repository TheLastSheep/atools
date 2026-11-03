# 31：原版通用设置透明度即时生效与重开保持

**What to build:** 在原版通用设置拖动窗口透明度滑块后，主窗口真实透明度与保存值一致；关闭设置并重开保持。失败时恢复原透明度并明确报错。

**Blocked by:** 03/04/05 的原版设置、共享CAS与会话写入已具备；23 的原生属性读取底座已具备。可见合成画面另验，不阻断本次功能实现。

**Status:** verified-hidden-native-macos-slice — R42，Luna 实施、Main 独立验收；run `a653503a9ded4284953ef861b91e8618` 原控件65%→独立SQLite/真实NSWindow alpha→fresh Child保持→原控件恢复100%→退出清理通过。证据 `output/renderer-window-opacity-2026-10-29/verification.md/json`；可见合成及完整目标另验。

- [x] 原range控件进入已有General串行写入，单次请求完成应用与提交，后续同值保存不重复通信。
- [x] 原生窗口alpha、独立SQLite读回及fresh Child读回一致，恢复初始值并正常退出清理。
- [x] 类型/范围、CAS冲突、应用或提交失败恢复、补偿失败、通知未送达与平台不可用均有对应检查，不假成功；失败路径以真实SQLite及可失败IO adapter验证，非跨平台实机证明。
- [x] 保持其它General字段和未知数据，纯设置写入不新增原生副作用；并发排队不覆盖别的已提交字段。
- [x] 原Vue/CSS与Main资源保持；Settings783356B在783560B门槛内，旧Native门禁及R39两进程持久化回归通过。

本票不替代可见画面、物理输入、跨平台或整个目标验收，不扩大插件或默认入口范围。

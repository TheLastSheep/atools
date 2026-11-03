# 36：隐藏后自动返回原搜索页

**What to build:** 在原General选择自动返回期限，主窗隐藏后按该期限返回搜索；重新显示取消旧计时，修改设置仅影响下次隐藏，退出不留任务。

**Blocked by:** 35，窗口位置与剪贴板保留；固定资源预算内的必要收敛。

**Status:** verified-scoped — R47，macOS hidden 原General/所有指令/搜索和生产调度。

- [x] 原控件保存30s/immediately、fresh重开读回与baseline恢复；七项枚举经Core/Child和模型校验，七个原选项实际校验，无额外变更IPC。
- [x] 真实隐藏/到期/关闭/退出，以及等待/返回任务有界合并、取消与回收；显示入口及迟到竞态有接线、状态单测和真实runtime Drop证明。
- [x] 原Main已在搜索时也清空查询，原Settings完整退出后返回，旧session fence保持；General保存后同session转“所有指令”才输入，遵循原SubInput可见语义。
- [x] 原固定Main/Settings预算、strict类型、相关回归和Main独立原始事实复算通过。
- [ ] 真实可见窗口的show取消、物理输入/IME、其它延迟实际长时等待、跨平台、第三方插件及整应用性能。

契约 `docs/contracts/ztools-auto-back-search-2026-10-29.md`；资源与源代码基线 `output/renderer-auto-back-search-2026-10-29/`。

实际run `be7a7b4acefa4b75a4c5d72a68c72128`，PID90850自然exit0并清理；30s实际30038ms，立即与全局搜索各57ms（单次夹具观察）。最终清理child/session/layout/pending均0、观察者2/2、焦点/激活0。Main593564B余356，Settings786182B有效余181，未抬上限。详细来源、红测/失败历史、独立检查与未验项见 `output/renderer-auto-back-search-2026-10-29/verification.md/json`。

R53当前正常前台复验仍在首次show失败，未进入本票的可见show取消阶段。固定即时及2秒预算被动观测均未取得焦点，正式失败及owned清理记录见[R53证据](../../../output/renderer-visible-recheck-2026-10-29/verification.md)。本票的可见取消/物理输入/IME项继续开放，不用R47隐藏成功或R53诊断完整性替代。

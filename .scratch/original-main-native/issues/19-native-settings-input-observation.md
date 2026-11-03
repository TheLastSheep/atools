# 19: 原生同窗设置的输入与退出观察

**What to build:** 在自有临时 Tauri 配置中运行原 Main/Setting，通过真实 Rust 输入链观察双向筛选、切页、关闭和重开，保持隐藏与不激活用户窗口的验收约束。

**Blocked by:** 18及R29当前产物来源、资源与浏览器门禁已通过。依新hidden contract实现私有呈现policy与独立journey后才可运行，不能直接运行旧foreground settings journey。

**Status:** partial / hidden-native-input-and-session-replay-verified — R30真实输入十阶段后，R31 schema2 `run-f205595cc3ab43489815ed6bb00f5d8e` 又完成fresh Child携旧session参数的实际请求拒绝、前后完整Native状态不变，十阶段/独立校验/真实exit0/owned cleanup通过。观察期未激活；232相关回归、Node25及workspace通过。证据：`output/renderer-session-replay-2026-10-27/verification.md/json`。完整可见UI、retained Arc擦除witness及关闭后全部入站RPC计数仍未验；不把本轮称为已销毁WebView继续执行JS的证明。

- [x] 固定当前产物、真实命令目录夹具与临时SQLite；不用旧桌面二进制或用户数据。
- [x] 替换旧固定尺寸/源码数断言为冻结来源、实际字段及原预算检查；不能只删门禁。
- [x] 独立隐藏、不激活的固定probe路径，不继续旧generic焦点流程或操作用户应用。
- [x] 原Main DOM输入→Rust→原Child筛选及Child程序设值→Main实际观察；DOM事件与物理输入分开。
- [ ] 关闭/重开身份、旧代次拒绝、真实缓冲与owned资源回收有证据；可见UI/OS焦点仍独立验收。

源码调查：`output/renderer-budget-recovery-2026-10-27/native-next-seam.md`。Root定义接口和最终运行，Luna实施，不派生。

旧session参数重放已补，其他明确缺口继续保留；不要把新会话空值代替旧retained缓冲擦除。各次Native失败、错误seed红测与exit类型错误均保留；默认入口仍不切换。下一主程序功能按22接通原设置页的应用搜索固定，独立于这些未验边界。

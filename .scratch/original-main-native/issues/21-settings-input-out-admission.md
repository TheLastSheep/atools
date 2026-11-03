# 21: 设置退出后的输入准入与无效通信

**What to build:** 设置会话退出后立即停止本地输入控制准入，使原页面退出回调造成的卸载操作不再向已关闭会话发送无效请求。

**Blocked by:** None。需先冻结 stop 与 dispose 的职责，保持 close/outAcknowledged 生命周期通信可用。

**Status:** implemented and browser-verified; native lifecycle slice verified — R28记录退出输入RPC17→17/pending0。R30实际公有outPlugin关闭及新session空值重开通过，session/child/layout/pending归零；本轮没有独立统计关闭后的全部Native入站/被拒RPC，因此不把浏览器计数转称Native计数。证据：`output/renderer-budget-recovery-2026-10-27/verification.md/json` 与 `output/renderer-native-input-2026-10-27/verification.md/json`。

- [x] Source与固定输入夹具复现退出回调中新的set/remove/focus请求，区分正常owner切换和终止会话。
- [x] stop立即清本地callback/可见态和队列，阻止后续输入准入；不得阻断Native close/out acknowledgement或伪造OS焦点成功。
- [x] 已派发回执与迟到回声仍安全处理；dispose恢复全局hook且不重复settle。
- [x] 退出过程不产生新的无效输入RPC；以真实调用次数证明减少，单元和原DOM退出/重开验证。
- [x] 独立检查Setting体积和来源绑定，不改变原Vue或借错误豁免通过。

初始观察：`output/playwright/ztools-settings-input-browser/848d89ce-d55a-418c-b23b-8c175153b446/report.json` 的关闭后控制请求。该观察是synthetic transport，不等于Native已发生故障；Native19仍要独立验证。

# R34：原设置页画面收敛诊断

承接24，保持完整原版界面还原目标，不用非空快照、媒体查询或状态布尔替代真实画面验收。

## 既有失败与事实

R33 最终真实原生 run `06353d9ac8ab4353902c115d31ccdab8` 在当前二进制/源码来源重新核对后仍有效：十二阶段、材质、三主题及透明读回通过；两主题的菜单、侧栏综合检查和双RAF失败。`output/renderer-paint-readiness-2026-10-28/baseline-red.json` 是这份实际观测的来源绑定重放，不是本轮新进程。

固定上游 `9b15fb1a2a9f3ec886016632761c7bb21e39557a` 中：

- LeftMenu 根据 route.name 标记active；active使用主色，普通项使用文本色。当前聚合判据静态上与该语义相符，但缺少失败子条件。
- Dropdown 和 TagDropdown 都有100ms离场过渡；Tag菜单 Teleport 到body。初始采样撞到正常过渡、未完成的leave及旧合成帧不能仅靠总计数区分。
- 插件视图创建和前台运行时 `backgroundThrottling=false`；退出到后台时按声明恢复节流。ATools设置Child未指定对应策略，运行时默认值须直接观察。

## 可证伪假设

1. 侧栏失败来自路由active、颜色解析或实际颜色的某个子条件：分别观察唯一性、active、可解析性和颜色比较；不直接改颜色。
2. 菜单留在离场过程：观察等待前后的body/theme菜单数、enter/leave class及owner是否仍open；只有数据支持后才改生命周期。
3. WK隐藏调度阻止帧推进：先读取实际inactiveSchedulingPolicy并统计真实RAF回调，再决定是否有必要补宿主策略；不伪造RAF、改DOM、显示窗口或抢前台。

## 阶段A：只读观测

保持产品代码不变。原General流程额外采样一次每主题的before/after sidebar与菜单固定布尔/计数、实际RAF回调数、真实耗时及超时；最多1秒、计数≤64、总探针沿用16KiB/single-pending/nonce/caller/generation边界。零回调不改写成成功。

macOS14+读取WK configuration/preferences的固定inactiveSchedulingPolicy键，按锁定objc2-web-kit0.3.2枚举映射 suspend=0、throttle=1、none=2；旧macOS及其它平台明确unsupported。调用在主线程，期限2秒，关闭的receiver不触发迟到读操作，不提供任意KVC入口。

每份原生材质报告新增 `paintDiagnostics.light/dark`；null表示观测未取得，结构错误拒绝，observed不等于视觉通过。原十二阶段、八项readiness、主题/材质/透明/清理门禁均保留。

锁定Wry是0.55.1，不以本机另一个0.57.0源码替代。实际0.55.1的473–494行与 [Tauri 2.11.2接口](https://docs.rs/tauri/2.11.2/tauri/webview/struct.WebviewBuilder.html#method.background_throttling) 作为宿主策略依据；API存在不证明此处就是根因。

## 后续动作与交付边界

只有阶段A的真实观测支持缺口时，才单变量修改宿主；若与隐藏绘制无关，不为凑绿改变策略。需保留前后来源稳定的构建、实际进程终止和退出回收，复核所有旧门禁与前端预算。不改变默认入口、原Vue/CSS、系统主题或用户桌面，不提交推送。

如仍无双RAF或物理合成证据，视觉继续unverified；不让已确认的隐藏验收局限阻止其余已授权主程序功能推进，也不把局限当成完整还原。

## A/B 结果与独立可见阶段

阶段 A 实跑策略为 suspend，阶段 B 单独给设置 Child 禁用 background throttling 后实际策略变为 none；两主题仍 RAF=0、菜单保持。此结果否定“只禁用节流即可修复隐藏绘制”，不据策略读回宣称视觉通过。

在保留原隐藏门禁的基础上增加单独的 opt-in `visible-unfocused` 阶段：同一 fresh Child，最长 12 秒，不增加 Child/observer，不激活或抢焦点。仅短时将验证后的自有窗口以 normal level 排前，要求 isVisible、occlusion Visible、当前 Space 和无焦点同时满足；隐藏后恢复旧层级。原 12 阶段及 material.visual 口径不变，另存 presented-paint 报告。

首次可见尝试暴露了 fixture 取消链缺陷：外层 timeout 丢弃 await 后 pending 未释放。现已加入同步构造的 RAII guard、最多32条完整身份取消记录和单次迟到回执丢弃；未知/错身份/普通重复仍拒绝。回归覆盖未 poll drop、outer timeout、abort、旧 guard 对新 slot 的保护。没有改变生产业务 RPC 权限。

最终 `7315ceb1c96542cd8c751eed552637b2` 的原12阶段、材质和退出回收通过；可见组合前置条件未通过，尚未取得主题画面。各 occlusion/Space 读数未持久化，不能断言具体失败项；null及未执行步骤的全 false 不作为真实画面观测。默认隐藏流程 `3ae9f50846a64f409235114e833cba6b` 单独通过，视觉仍 unverified。

本轮独立验收为 Native 290 passed/1 ignored、Node47/47、workspace check通过。来源、失败保留、构建收据与限制见 [R34验收记录](/Users/harris/Desktop/atools/output/renderer-paint-readiness-2026-10-28/verification.md)。不切换默认入口，不以此阻止其它已授权主程序功能推进。

## R36补充：窗口事实与配置层级

R36在show失败时仍保留逐项未知/已知的窗口事实。真实A运行 `58b8864709c94285a143a6db8dcf3c33` 显示窗口可见且位于当前Space，应用未隐藏/激活，窗口无焦点；10次采样均未取得occlusion Visible，故未进入画面步骤。旧报告的null和占位false继续不作为实际观测。

ATools `tauri.conf.json` 的主窗 `alwaysOnTop=true`，固定上游 `windowManager.ts` 也配置置顶；此前QA主动设为Normal level。[Apple窗口分层文档](https://developer.apple.com/documentation/appkit/nswindow/level-swift.struct)说明层级排序优先于同层窗口排序；[orderFrontRegardless](https://developer.apple.com/documentation/appkit/nswindow/orderfrontregardless%28%29)只排到当前level前面，不激活或变为key。这提供了可证伪线索，尚不能证明本次遮挡的唯一原因。

R36B明确将可选QA的显示策略改为保留该自有主窗原配置level，不主动降低或升到更高level；其它身份、12秒时限、未遮挡/当前Space/无焦点/无激活、隐藏与清理要求保持。仅此一个Native文件改变后fresh build并复测；A及R34历史结果保留。完整画面与物理材质的验收标准不变，默认入口不切换。

实际B运行 `f9e84491c97c44d5ac89f14e5c78499a` 仍为visible/当前Space/无焦点/未隐藏且occlusionVisible=false（10次），所以保留原层级不是充分修复，也未定位遮挡根因。两次可见诊断有效但gate未通过；Native进程exit0与Node runner exit1分别记录。最终B的默认隐藏运行 `0330111b80494739993c35695794eb96` 通过，原12阶段、禁用启用、材质和回收均保持；新PNG与物理画面仍未验收。

Native72、Node78、workspace检查通过；前端字节和预算与R35相同。详见 [R36记录](/Users/harris/Desktop/atools/output/renderer-visible-window-facts-2026-10-28/verification.md)。不再无新证据重复显示试验，后续推进原版通用设置的本地应用搜索完整消费链。

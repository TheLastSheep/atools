# R47 原 General 自动返回搜索

工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`；保留现有dirty，不提交推送。固定只读ZTools `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。沿用to-tickets拆解、Luna实施与Main独立验收。

## 固定行为

上游 `windowManager.ts:937-955,974-986,1037-1118`：hide后启动一次性timer；show入口先取消；重复hide替换；设置更新不重排已启动的timer，下一次hide读取新值。枚举immediately/30s/1m/3m/5m/10m/never，延迟分别0/30000/60000/180000/300000/600000/不启动。不是可见面板停留计时，也不是自动隐藏。

到期即使已在搜索也走返回通知，原Vue `App.vue:594-607`清空搜索、当前插件及loading，并按既有nextTick更新布局/DOM焦点。当前主程序迁移范围先处理原Settings与搜索；插件UI仍按原计划后置，不能声称本批覆盖全部第三方插件生命周期。

## 模块与接口

- Core原19字段顺序保持，追加autoBackToSearch为20；七项严格枚举不混用autoClear（autoClear含2m但不含30s）。复用CAS、预算、未知字段和坏旧hotkey保留。
- Child原投影已有autoBack字段，增加writable与internal.updateAutoBackToSearch，复用同值确认和既有变更IPC，无第二次配置通知或轮询。
- window auto_back仅在ztools-multiwebview启用。真实hide成功后读取已提交DB一次并固定当前delay；show入口取消，Destroyed/Exit永久stop。Waiting与Returning分别持有句柄，最多一个等待或已开始的返回任务；Returning期间重复hide合并，show不撤回已开始的关闭，stop取消并回收两类任务。generation fencing防止取消后排队回调触发，主线程claim前再用共享Window角色复查仍隐藏；不持锁调用Tauri或返回逻辑，不新增Node/进程/系统输入。
- cfg(ztools-multiwebview) `renderer_settings_view::return_to_search_after_hide(&AppHandle).await` 由timer在主线程claim后调用。已claim代表原版timeout已实际触发；后来的show不能撤回已开始的关闭。当前Settings复用既有out ack/写入结算/资源释放与session-scoped closed/back；搜索态在同一既有事件通道发exact `{version:1,phase:"auto-back-to-search"}`，不伪造session。
- Main原Settings事件客户端严格区分该新窄信号与原五种session事件。无active/openPromise/queuedClose时才调用原onBackToSearch，迟到全局信号不能关闭新设置。旧closing集合含已终态session的scoped fence，不能以整个集合非空拒绝搜索态返回；确认closed后的旧scoped back仍拒绝。无新listener或入站命令。
- 默认Svelte保留现状；它的旧面板计时与原版语义差异单列，不冒充本批已对齐或完整默认入口交付。

## 必要资源收敛

R46 Main593891/593920B余29；Settings786336/有效786363B余27，绝对786432B余96。上限保持。Main去可派生pending/cache布尔状态；Child去完整验证前重复undefined扫描、一次安全提取Native错误码，保留全部shape/权限/CAS/错误及通知确认。最终以正式构建实测接线后的总量，不以源码缩短或估算代替产物预算。

正式产物已测：Main593564B（余356，较R46少327），Settings786182B（有效余181，绝对余250，较R46少154）。Main重复命名回调工厂候选反增33B已撤销；后改为中性UTF-8字节计量单例供八个消费者复用，原上限、错误route与UTF-16计量保持。两次超限594096/594129候选日志保留，未发布失败stage或提高预算；本批上游Vue/CSS保持。

## 验收

Core真实SQLite边界/CAS；Child原dbPut+通知及同值/失败；Main单通道signal、严格shape、迟到会话/退出；Native纯调度与真实hide/show/stop挂接检查、related cargo和workspace；正式Main与Settings构建绑定上游/资源身份并满足原预算。实际原生旅程需另记录原控件保存、真实到期/取消/退出与原Vue状态，不以纯调度或合成transport宣称端到端通过。物理输入/可见像素/跨平台/整应用性能及默认入口继续开放。

已完成指定hidden实际验收：run `be7a7b4acefa4b75a4c5d72a68c72128`，PID90850自然exit0并清理；原General配置后在同session转“所有指令”启用真实SubInput再输入，30s实际30038ms，立即/全局搜索各57ms观察到完整返回，最终资源计数0、观察者2/2，焦点/激活0。新侧报由Main独立复算并另行只读复核，未宣称纳入旧runner五门禁；可见show取消、IME/像素和其他平台仍开放。完整证据和失败历史见 `output/renderer-auto-back-search-2026-10-29/verification.md/json`。

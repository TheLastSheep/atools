# 26：插件运行状态与会话停止恢复

**What to build:** 用户能在插件管理中确认哪些已安装插件仍在运行，并对Harris实际会话发起明确停止；只有完整退出确认后才显示停止，失败可见并可恢复，旧动作不得误停同插件的新会话。

**Blocked by:** 25的当前共享界面切片已完成；实施前还需确认前台、后台、主推送、独立窗口和Node owner的统一可查询边界。

**Status:** runtime-observation-and-background-stop-verified；其它形态停止、跨窗口管理及原版真实验收仍开放。

- [ ] 对照ZTools的运行中筛选、运行标记和终止操作，覆盖ATools实际拥有的运行形态，明确尚未覆盖的形态。
- [ ] 复用现有权限、TaskRun和owner/session生命周期，不把UI状态当作OS进程已退出。
- [ ] 运行列表有界、无需后台轮询，不启动额外Node；动作绑定session及revision而非仅pluginId。
- [ ] 停止后确认文档/资源/Node helper回收，失败保留诊断与恢复入口；不吞错误或假成功。
- [ ] 真实Harris原版路径、失败与旧回执、资源预算均有独立验收。

只读来源：固定ZTools HEAD9b15fb1的插件管理提供all/running筛选、runningPlugins标记及killPlugin；ATools现安装清单只有enabled/source/feature信息，已有后台session pool stop但尚未呈现到库存。不能把该差距表述成ATools完全没有stop能力，也不能用仅后台会话UI代替整套运行管理完成标准。

## 2026-10-25实施前调用链审计与顺序

ZTools running是pluginViews与detached表的路径去重并集，包括隐藏缓存和main-push预加载；不是OS进程存活证明。kill成功只是已受理，实际销毁延迟200ms。ATools需区分view、admission、数据桥、Node、通用sidecar和QuickJS context，不能把全部资源记录统一标为运行进程。

实施前ATools不存在生产统一枚举：native各manager只提供已知owner/ID的访问或测试计数。Legacy Node和通用sidecar未绑定可靠的启动code revision，不能拿当前插件revision冒充加载版本。普通前台已有Panel strict-close export，但正常关闭路径未等待它；后台/MainPush另有自己的owner和TaskRun回执。2026-10-26新增的四类只读汇总见后文，未记录载入revision的来源仍返回null。

实施前发现并正在修复三类真实状态丢失：后台pool清理失败仍删除session；MainPush清理失败仍删除runner且一项失败跳过native收尾；通用SidecarSupervisor先删除再shutdown，并发start还可生成两个owner。这些是可信运行列表的必要前提，本阶段不把它们代替整票完成。

新增的Panel维护重试必须穿过真实CloseTracker/Lifecycle链；仅fake adapter一次拒绝再成功不足以证明生产可恢复。显式retry只重放失败的原close命令和不可变原owner参数，不自动重放业务；worker未确认、不可快照、预算溢出和底层sticky Node错误继续保持失败。生命周期Out/revoke/generation不重复，失败占用容量且不允许新启动覆盖。

所有接口完成后，仍需实现各运行形态的统一安全快照、跨窗口管理归属、经既有TaskRun/权限入口的明确停止、库存运行筛选/标记/错误恢复及Harris原版闭环。当前没有声明已存在这些功能。

## 开发工作区

用户新增开发分支规范后，所有Worker已暂停写入并分别核验。主在相同HEAD创建专用开发分支`codex/atools-ztools-parity`，工作区`/Users/harris/Desktop/atools`；24,835非忽略路径内容与工作区status摘要切换前后完全一致，master ref未动。各Worker重新确认branch/path后才恢复，均不得stage/commit/push。证据：`output/ztools-running-plugins-2026-10-25/development-workspace.json`。

证据目录：`output/ztools-running-plugins-2026-10-25/`。先冻结1563前端/测试/脚本文件和881 native/runtime文件；原始四个关键文件另存基线副本。主统一Cargo通道、2 jobs、locked/offline；前端产品Node22.23.3、单worker。原生App/GUI/AppleScript/系统输入继续暂缓，不安装依赖或改原包。

## 退出回收前置修复的独立验收

后台/MainPush保留关闭失败实例和容量；Panel从首次关闭调用捕获失败，精确重试冻结的原owner参数，独立错误包装避免错误归属碰撞。所有组件卸载入口消费销毁拒绝，strict接口仍拒绝未确认退出。Rust同插件并发启动共享owner，关闭成功后才移除，stop-all尝试所有owner并返回失败。

主验收：17文件182项前端回归通过；最终测试类型修正后复验同一12项通过；严格检查0/0；Rust运行库234及sidecar集成4项通过；workspace check通过（197既有宿主警告）；24个代码文件均≤500行。首屏JS460,993/573,440 bytes，比Task25增加4,546 bytes；20个日志记录测试PID均已退出。

参见 `output/ztools-running-plugins-2026-10-25/verification.md` 与 `summary-main.json`。以上只完成前置修复，不勾选本票完整产品验收项；统一运行快照、TaskRun停止、运行中列表和Harris原版/实际WebView仍待完成。

## 2026-10-26：运行视图与本窗口后台停止

已接入“设置→插件→运行会话”。主窗口只读命令一次汇集后台admission、MainPush admission、Legacy Node owner及原生BrowserWindow记录；Native最多128行，前端合并快照最多160行。其它观察来源以coverage不可用显式标明，不把空列表当作全部退出。Node/窗口未知载入revision保留null，agent Node不编造窗口label。

本窗口后台会话由owning Host提供完整身份及stop回调，沿既有TaskRun停止；旧实例、revision或source换代不会误停新实例，未确认退出保留反馈。其余形态只读，无跨窗口停止或新通用管理TaskRun。本轮没有新增轮询或生产Node启动。

主验收：20文件197项前端回归，最终受影响5文件24项复验（含新增1项UUID不可用挂载回归，不重复累计）；严格0/0；Native投影14及聚合1项通过；workspace check通过（197既有宿主警告）。浏览器8组检查、4图均通过并逐图查看；12个提示文字对比度样本最低约5.04:1，显式主题反向系统组合不漂移。首屏JS466,190/573,440 bytes。31代码文件均≤500行，6个已记录浏览器/runner PID已退出。

证据：`output/ztools-running-inventory-2026-10-26/verification.md`、`summary-main.json`。浏览器Native IPC和插件名称为模拟夹具，不等于Harris原版或真实Tauri/WebView验收。本票完整验收项仍不勾选；下一步仍需其它形态的归属停止、失败恢复入口，以及已暂缓的原生/原版闭环。

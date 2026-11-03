# R40：原版 Main 插件变化刷新串行与合并

仓库/开发工作区 `/Users/harris/Desktop/atools`，分支 `codex/atools-ztools-parity`；只读上游固定 `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。沿用Tauri系统WebView、Rust核心、按需Node及SQLite，不修改原Vue/CSS。

## 调用边界

原App的 `onPluginsChanged` 回调是async并await `commandDataStore.reloadPluginAvailabilityData()`；内部并行读取插件目录、禁用状态与其它设置后更新原store。当前公共callback registry不等待回调完成，多个事件会并发执行完整刷新；pluginCatalog只保护自己的目录读代次，不能保护已经返回给consumer的旧值。

先以明确门控的异步依赖建立RED，分别核对adapter级顺序和固定原版consumer；不能将一个手写的简化consumer称为原版Main实证。未复现的风险仍保持待确认。

## 目标语义

- 一个异步刷新回调尚未settle时，不向同一插件变化订阅并行派发第二次；有效事件立即使目录缓存失效，并记下需要尾随刷新。
- 同一批事件只保留“尚有新变化”事实，不排队保存每个null事件；当前刷新结束后至多派发一次尾随轮次，后续新事件按同样规则处理。
- 兼容原同步回调、多个订阅者、回调拒绝和同步抛错；按现有callback身份核对订阅，撤销或dispose后不交付排队回调。不得将异常转为伪成功或泄漏未处理拒绝。
- 首次读取前监听、启动期迟订阅补发、目录数据克隆、旧代读取拒绝/追新及现有诊断继续保留。未知payload不触发刷新。
- 不改变原生插件变更事实或安装/启停事务，不增加生产命令。若考虑自动重试，须先明确可观察错误与次数边界，不因原回调内部catch而声称已识别所有失败。

本调度用于固定原版Main的已知async consumer，不承诺任意第三方回调的活性。活跃期等待该consumer及其host操作settle；不能以超时后并行新批次假装取消旧store写入。Host dispose须使本批等待退出并清除后续派发，正常关闭的取消不归为回调异常。原store内部catch的读取失败仍不代表成功，自动重试不在本轮通过范围。

## 已执行的RED

Main独立运行adapter用例得到4 failed / 2 passed：旧实现回调并发、20次事件并发派发及取消前已派发第二轮；见 `output/renderer-plugin-refresh-2026-10-28/adapter-business-red.log`。初版测试自身的环状gate等待已修正，初次日志单独保留，不以该超时代替业务RED。

独立Luna构建的实际消费者测试，直接加载固定上游Pinia store，并从App.vue AST提取原async回调。受控API延迟下，新指令先出现，释放旧回调后新指令最终消失；Main运行得到1 failed、无skip，见 `output/renderer-plugin-refresh-2026-10-28/original-consumer-red.log`。它证明实际原函数经当前adapter的竞态，不是Rust或物理UI证据。

## 验证与预算

Main当前593860B；绝对上限593920B、现有增量门槛保持，不降低原界面、字典或功能换取空间。必要时在同一职责内整理重复逻辑，不新增依赖或轮询。Settings资源782503B保持。

原版浏览器fixture只同步现有真实事件目录和诊断，不放宽旧业务断言。Main独立执行RED/GREEN、类型检查、正式Main构建与来源绑定；Rust源码不变时复用仍与当前Native输入完全匹配的实际构建receipt，随后运行原R38及R39隐藏Native回归。浏览器合成transport、真实Rust和可见画面分别记账，不能相互替代。

## 本轮结果

已完成本契约切片。实际原App回调/store回滚用例转绿；受控20事件为首+尾2次回调、2次list读取，最大并发1。同批subscriber仍同步收到通知，dispose解除批次等待且不记伪错误。Main独立28文件221用例、strict、正式构建、原版页面16项检查及实际R38/R39 Native回归通过。

Main最终593891B（+31B，既有593920B绝对上限保持、余29B），Settings782503B保持。四次过预算构建失败及旧RED保留，没有提高门槛、修改minifier或上游源码。Native1250个源输入与R39实际构建完全相同，复用有真实exit0记录的receipt；两次新Native运行均加载本轮正式Main资源，进程正常退出、owned资源回收。详见[验收记录](/Users/harris/Desktop/atools/output/renderer-plugin-refresh-2026-10-28/verification.md)和[原始事实索引](/Users/harris/Desktop/atools/output/renderer-plugin-refresh-2026-10-28/verification.json)。

本轮不外推为全量失败恢复、20事件Native压力测试、可见Tauri UI、完整主程序或Harris原包兼容完成。应用别名Native纵向验收继续按16推进。

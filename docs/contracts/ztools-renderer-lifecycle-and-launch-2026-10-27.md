# R24 活动拖动清理与启动后回到搜索

工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`，HEAD `c34789c0e3d19b3bf7c05d396540d891ff126abc`。上一轮R23是progress；全目标保持active。主程序优先，社区/Harris插件后置；原版internal setting属于主程序，不用Svelte替代其目标界面。

## A. 补齐实际生命周期证据

R23只有正常拖动/改高/释放/恢复。沿用显式 `--window-drag true` 的私有catalog journey，升级独立 `window-drag-native.json` 为schemaVersion=2：

`baseline, dragged, resized, released, restored, hide-locked, hidden-cleared, redragged, navigated, recovered`。

前五阶段保持旧门槛。hide-locked由原SearchBox再次mousedown确认实际Native locked=true；随后只调用生产api.hideWindow，不手工clear、不先mouseup，hidden-cleared必须实际locked=false、hidden/unfocused。之后mouseup清原DOM手势，再同一文档重新拖动并移动8×6，redragged实际locked=true证明可恢复。然后在仍locked时触发真实同源完整reload/navigation。

导航只能由本次fixture的main/main/local/token保护命令触发。Native Harness记录实际PageLoad Started/Finished，并为新文档生成独立documentId；不从DOM自述推断重载。主界面原pagehide/dispose和生产Started清理自然执行，fixture不得调用生产clear。新文档Finished后注入独立resume脚本：navigated实际锁为false、原Vue与新adapter已就绪，文档ID改变、adapter计数重新开始；再次用原DOM拖动/释放，再经原API恢复基线位置/尺寸，recovered无锁/pending/错误。

旧文档导航成功后保持异步前缀未完成，不能在旧文档启动catalog probe；新文档resume完成写入v2报告后才启动原catalog probe。旧R23 v1产物保留原身份与结论，不重新解释为v2通过。

v2 DOM追加 `documentId/hideWindowCalls`；Native追加 `documentId/documentGeneration/pageLoadStarts/pageLoadFinishes`，三个计数前8阶段为0/0/0，后2阶段为1/1/1。Native与DOM的documentId相等，前8阶段相同，后两阶段另一相同32hex值；未知状态必须失败。新文档初次观察只允许drag的position read=1、moves/locks/hide=0，但原Vue挂载可以有自己的非负expand调用，不能把合法布局排除。所有阶段Native hidden/unfocused、focus-gained/child/layout=0、WK store非持久。首次与新文档中的getWindowPosition返回值均需与实际位置一致。可见/物理/多屏/跨平台及重启位置依旧待验。

复用现有Harness/报告和队列，按实际职责拆schema/生命周期与common/initial/resume脚本，各文件≤500；不新增运行时框架。Node独立validator同步v2、封闭字段与阶段、畸形输入不throw，旧catalog协议保持不变。只接受当前带来源绑定的fresh Native二进制；终止确认后才清理owned资源。

## B. 原版启动成功通知

固定上游App.vue:803的onAppLaunched在成功启动后清空query和pasted内容、回到Search；当前inactive导致autoClear=never时残留旧查询。接入独立零数据Native事实 `atools://renderer-app-launched`，payload严格null，精确投递main Webview。

只在生产launch_renderer_app的同一协调流程完成实际open/权限以及history提交之后发出：先既有app-state，再app-launched，然后生产hide_main_window（记位置/清拖动锁）。拒绝、open失败、记录失败和普通pin/history修改均不发送成功通知。通知/隐藏在已启动并提交后失败仅记录诊断，不把结果伪装成未启动而诱导重试。流程继续复用统一权限/TaskRun，不改变Node策略。

前端复用既有createRendererEventSubscriptions，零新增请求/轮询；onAppLaunched从inactive转为limited，严格null校验、订阅共享、错误隔离/迟到注册/dispose由现有深模块承担。API总数与事件名字保持，能力状态更新。说明此批只覆盖原renderer的Native应用协调器，其他未接入系统动作不宣称覆盖。

原Vue/CSS不改。浏览器夹具成功启动回执后发送同一事实，原DOM必须清空（包括autoClear=never）；失败回执不能清空，随后明确重新输入文本验证原两步Esc，不降低旧断言。精确验证七类Native listeners及dispose清理，不用合成回执证明真实OS启动。

Main当前585828/586528余700，settings包不改，预算/压缩/依赖不变。Root执行全部相关检查、正式构建与真实Native；原生成功启动后的通知业务流程尚需独立实机证据，不把浏览器回执或纯协调器测试称作真实启动验收。

## 归属

Root负责接口、关键diff和验收。Luna分别负责A Native/JS Harness、A Node validator、B frontend/browser、B Native producer/协调测试，不派生子代理；互不覆盖文件。禁止staging/commit/push或操作外部用户应用；只用本次自有临时隐藏ATools，不show/focus/activate，不用CUA/AppleScript/剪贴板。

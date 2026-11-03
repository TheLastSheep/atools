# 26：原版设置可见窗口状态与画面恢复

**Status:** partial — R36诊断及R53固定激活观测完成；可见运行仍未通过，完整UI继续待验收。Luna实施，Root独立验收，未切默认入口。

**Depends on:** 24的严格可见门禁及R35已经验收的原版命令流程。R34实际可见运行因前置条件失败，没有合格PNG；默认隐藏模式的成功不代表画面通过。

## 第一阶段：保留失败时的原始状态

原版Vue/CSS、显示方式、12秒可见租约、无焦点/无激活限制保持。当前show失败只返回错误，报告的presentation/cleanup为未观测占位值，无法区分遮挡、Space、应用隐藏或焦点变化。

新增有界windowTrace到presented report schemaVersion 2：自身schemaVersion 1；baseline、afterOrderFront、lastVisibility、afterHide四个固定阶段；未执行该阶段用null。每个事实仅含visible、occlusionVisible、onActiveSpace、windowFocused、windowKey、appActive、appHidden、frontmostIsSelf，均为布尔或null；字段null表示该项未知，以保留getter失败前已读取的其它项。visibilitySamples为0..256的安全整数，0当且仅当lastVisibility为null。只记录自有窗口/应用的状态，不采集其它应用标识或画面。

调用者持有trace，即使show返回Err也保存实际baseline/最后采样/清理事实。采样发生在现有主线程读取处，不增加observer或进程；数据记录不得修改状态，不调用activate、unhide、切换Space或提升窗口层级。新增事实不会放宽原有门禁。成功还需有完整事实证明隐藏基线、实际显示、未遮挡当前Space、应用未隐藏且无焦点/激活、最终隐藏；afterOrderFront必须明确visible=true且focused/key/active/hidden/frontmost=false，仅occlusion/Space不要求窗口服务器立即公布。任何安全事实未知不能支持成功。

## 验收

- [x] Native严格边界和Node精确schema各自覆盖未采样、真实false、错误类型/多余字段、计数范围、cleanup一致性与伪造passed。
- [x] Root统一定向Rust/Node检查、fresh build和source receipt；前端和预算未改时不重复构建。
- [x] 真实visible-unfocused运行明确失败谓词；保留原12阶段、禁用启用、材质/主题和回收结果。不得把诊断成功称为画面恢复。
- [ ] 若证据确认产品缺陷，再冻结明确修复与独立验收；若为环境前置条件，保留缺口并推进其它主程序任务，不反复盲跑。
- [ ] 取得合格内容PNG后独立查看；物理材质、跨平台与发行性能仍单列。

只读源码已排除：runner通过open/LaunchServices隐藏app的假设；项目主动设置Prohibited activation policy的假设。R36A/B已补齐动态appHidden及具体occlusion/Space事实，见下。

## R36A观测与R36B单变量验证

真实A运行 `58b8864709c94285a143a6db8dcf3c33` 已取得完整事实：窗口visible=true、onActiveSpace=true、appHidden=false；焦点/key/appActive/frontmost均false；10次采样的occlusionVisible始终false。因此具体失败项为未遮挡判据，应用隐藏与非当前Space不是本次失败项。原12阶段、禁用启用、材质与回收通过，未取得合格PNG。

测试程序主动将原已配置置顶的主窗口降到Normal level；ATools配置与固定上游主窗均置顶。R36B单变量验证只去掉此降级，使用原有level并在隐藏后仍按原路径恢复；不提升到高于原配置，不激活/抢焦点，不改Space/occlusion门禁或时限。此项明确扩展R34的Normal-only QA显示策略；R34及本次A的失败记录保留，不改写。若仍未通过，不反复盲跑，继续其它主程序功能并保持视觉未验收。

R36B实际运行 `f9e84491c97c44d5ac89f14e5c78499a` 仍是相同事实，10次occlusionVisible=false；保留原层级不是充分修复，未证明遮挡根因。最终同一B二进制的默认隐藏回归 `0330111b80494739993c35695794eb96` 通过，原12阶段、禁用启用10项、材质及回收保持；两次可见Node runner因视觉失败exit1，Native进程均exit0，不能混为全通过。

最终Native72、Node78、workspace检查通过。Main590200/Settings782341字节与R35相同，预算未调整。完整事实、来源、失败与限制见 [R36验收记录](/Users/harris/Desktop/atools/output/renderer-visible-window-facts-2026-10-28/verification.md)。后续主程序功能候选见27；未取得新合格PNG。

工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`。保留既有dirty工作，不切默认入口，不暂存/提交/推送。主程序优先，插件保持后置。

## R48 正常前台路径与当前会话

当前R47二进制的正常foreground/settings路径也在初次show失败（父run `eb403d77-9646-4c64-a254-018da32e6960`），因此旧无焦点QA与产品show差异不能作为修复结论。当前会话只读查询返回loginDone=true、screenLocked=true、onConsole未知；该锁屏标记不等于物理屏幕核实，也不能回推R36旧运行。已请求解锁，尚未获得本轮确认。

仅QA controller增加初次show失败即返回的固定诊断。最终父run `4c8c2604-9f53-4cd7-8978-9467299149d0`两case均分类macos-activation-unconfirmed、自然exit1且owned资源清理，后续stage0，失败流程从93223ms缩为4382ms；正式门禁仍失败，没有新合格PNG或画面恢复声明。191项相关测试、workspace及fresh example通过；Main/Settings正式资源不变。完整证据见 `output/renderer-visible-main-2026-10-29/verification.md/json`。

## R53 当前前台失败观测

新会话只读结果为sessionAvailable/loginDone/onConsole=true、screenLocked=null，不表示锁屏已确认解除，也不能回推R48。新正式run `fa6c432a…`仍首次show失败；随后仅QA feature增加固定JSON。`4fc00589…`实际两个实例均完成启动、regular policy、未终止，但激活请求返回false；窗口flag visible与当前Space为true、appHidden=false，appActive/frontmost/key/focused/occlusionVisible均false。不是只有进程或visible标志就算可见恢复。

在不重发show/activate/focus的前提下，`5322217f…`追加原2秒预算的被动观察：实际2027/2030ms后focused仍false、焦点取得事件0，正式passed=false、stage0，进程自然exit1并完成自有资源清理。三批原报告保持失败，无新合格PNG。当前1363 Native源SHA `7bf172d8…`/binary `4ad56b32…`/收据1793253820613稳定；activation16项及最新workspace/example检查范围见[R53证据](../../../output/renderer-visible-recheck-2026-10-29/verification.md)。生产激活逻辑及默认入口不变，拒绝原因、可见/物理/IME仍未确认；后续先核对上游与Tauri/Tao实际调用链，不重复无新条件的运行。

## 普通面板目标纠偏

固定上游普通Mac路径明确使用非激活panel、modal-panel相对层级1与show，输入聚焦到搜索WebContents；特殊安装流程才激活整个app。当前普通ATools路径显式激活app，语义不同。R53失败事实保留，但该强foreground路径不能直接替代普通面板目标；R34/R36无焦点画面诊断也不是完整交互合同。后续[39](39-macos-main-panel.md)需同时证明真实面板类型、键盘/搜索焦点、前台状态保持、合格内容PNG和回收，不能只删断言判通过，见[面板契约](../../../docs/contracts/ztools-macos-main-panel-parity-2026-10-29.md)。

本项继续partial。会话可交互后按既有视觉门禁补验；等待期间推进独立主程序ticket37，不反复盲跑，不用隐藏成功替代可见验收。

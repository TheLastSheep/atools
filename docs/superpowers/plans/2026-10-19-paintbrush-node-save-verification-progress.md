# B49 Paintbrush Node 保存链路验证进展

B49 交付的是诊断流程和可复查证据，真实原插件的图片保存仍待完成。最终 v6 浏览器探针在插件 iframe 挂载之前超时；四个保存用例均未开始，不能据此判断保存链路通过或断言根因。独立代码审查接受本批诊断生命周期和证据边界，原生业务验收仍为 pending。

## 本批范围

探针用隔离的离线 Node 子进程和 Chromium fixture 检查原始 Paintbrush 插件加载与保存前置链路。探针绑定了 28 个实际运行输入，原插件 `plugin.json` 和 `preload.js` 未改。5 个新增验证源均少于 500 行，最长 448 行。最终 source freeze 包含 1,582 个选定源，其中既有基线 1,577 个、新验证源 5 个；这些是明确选择的源输入，不是完整编译器或依赖闭包。

预期的业务验收是四类完整 PNG：常规有效图、接近上限的有效图、超上限图，以及用户取消保存。要观察真实 `save-clipboard` handler、Node RPC、`fs.writeFileSync` 和目标文件读回；探针不得把这些操作替换成假调用。本批尚未进入上述用例。

## 最终 v6 观测

Node fixture 已初始化，直接访问相同 loopback parent health 路由得到 HTTP 200 和完整 114,642 字节响应。服务端记录 3 个无法归属到单一客户端的聚合 TCP 连接、1 个 HTTP 请求（health 请求）、0 个浏览器 parent GET。CDP 观察到 1 个 parent GET 的 `requestWillBeSent`，没有 `responseReceived` 或 `loadingFailed`；导航命令和 load event 均超时。由于 TCP 计数是聚合值，不能据此声称 Chrome 的 TCP 连接数为零，也没有足够证据判定代理、策略或其他根因。

没有挂载插件 iframe，没有原始 preload ready，没有 Node module RPC 或图片端点请求。四个保存用例定义数为 4、完成数为 0，实际保存图片数为 0。最终探针退出码为 1，表示这次前置链路未通过。

最终普通清理证据覆盖本次实际观测并归属的 Node/Chromium 进程组、监听器、隔离环境和临时目录；不证明任意脱离或被重新托管的进程都已清理。历史 v3 的原 Node/Chrome 环境根未被绑定，相关清理仍属未知，不能由 v6 的清理结果追认。

## 过程记录

- v1 发现原 handler 未安装，存在 exports selector 缺口；只观测到普通已归属资源清理。
- v2 修复 selector 后 handler 仍未安装，且只得到通用 Window 错误；没有 Node RPC。
- v3 的 load-event rejection 绕过报告和 finally。之后 root 按进程身份重验并清理了当时可确认的 Chrome group 和 scratch；原 Node/Chrome 环境根仍未绑定，清理结论未知。
- v4 加入及时 rejection 处理、有限诊断和资源日志，但导航仍未到 readiness。
- v5 的 root CLI digest 输入错误，在启动任何资源前被拒绝，属于 not-started，不是清理失败。
- v5b 使用正确 digest，但只发生 parent navigation；浏览器请求事件为 1，服务端接受的 parent GET 为 0。该轮 TCP 未观察。
- v6 保持相同 Chromium flags 和 deadlines，额外证实 Node health 路由可达；浏览器仍未进入 iframe，根因未确认。

## 验证与来源

Root 对五个最终验证脚本执行了 `node --check`，全部 5/5 通过；selected-source post-probe scan 为 1,582 项零漂移，既有 1,577 项基线零漂移，28 个实际探针输入均绑定 final freeze。B50 启动前 root handoff checkpoint 再核对 1,582 个选定源为零漂移；B50 后续源码不计入 B49。HEAD 未变，未执行 Git mutation。独立 reviewer 只读核对源哈希、报告和清理声明，没有运行 child、browser、build 或 tests；review 结论接受诊断实现，保存业务和正式验收仍 pending。

- [Root 最终验证汇总](../../../output/plugin-input-2026-10-19/batch49-evidence-v1/records/verification-summary-v2.json)
- [独立审查 v2](../../../output/plugin-input-2026-10-19/batch49-evidence-v1/reviews/review-v2.md)
- [最终 v6 探针报告](../../../output/plugin-input-2026-10-19/batch49-evidence-v1/probes/probe-v6.json)
- [B50 前 source handoff checkpoint](../../../output/plugin-input-2026-10-19/batch49-evidence-v1/records/pre-b50-source-handoff-v1.json)
- [最终 source freeze](../../../output/plugin-input-2026-10-19/batch49-evidence-v1/records/source-freeze-v6.json)
- [证据清单](../../../output/plugin-input-2026-10-19/batch49-evidence-manifest-v1.json)

更早版本的红报告与 root 修复观察已保存在证据包中；v1–v5 的 freeze 与各阶段精确 owned 源快照也一并归档，便于把失败报告和当时实现对应起来，不包含全量源树。B48 的前端/Rust/build/performance 检查只由未变产品源承接，不作为 B49 新运行的验证；B49 没有新测 initial bundle。

## 验收边界和后续

本批没有证明原生剪贴板读取、原生保存对话框、原生 UI、Rust 权限/TaskRun 链路、完整真实文件写入与读回，也没有证明多数插件可直接使用、发布或正式验收。不能从 fixture 诊断推导竞品体验或通用插件成功率。

下一项独立产品工作建议为已安装列表跨 30 条分页的连续 ArrowUp/ArrowDown 导航，验收需覆盖可见 31/61 项、单次 state update、真实组件焦点、过滤/刷新后目标失效和插件详情返回焦点，并保持 Home/End 现页语义。此建议不改变 B49 的 pending 状态。

# 搜索返回与原生激活验收记录（B43）

## 交付行为

从普通搜索结果打开插件后，返回会重新执行原查询，并按插件与功能身份恢复选中项；若结果消失，则选择当前结果列表的首项。搜索框在远程结果完成前立即聚焦，用户可以继续键入或用方向键切换。

返回上下文仅保存在当前应用内存中。direct-launch 成功打开新的顶层插件会清除旧上下文，返回到空搜索；插件内部 redirect 延续原插件链，返回仍恢复起始查询和选择。插件被停用或代码失效时会清除旧上下文并显示生命周期提示，不自动重跑旧查询覆盖提示。激活失败、owner 校验失败和过期请求不会覆盖当前有效上下文。

## 源码范围与一致性

最终 source freeze v3：1539 个选定源码，24 个归属文件（18 个修改、6 个新增），最大新增文件 362 行。所有选定源码均与 freeze-v3 指纹匹配，未发现未归属漂移；18 个 before 快照逐一匹配 B42 delivery 的 selectedSources 及 freeze-v3 before 指纹。4 个历史超长源码文件已在 root 范围记录中明确跟踪。

保留 freeze v1、v2 的拒收候选及对应 after 快照，以区分迭代边界；after-v3 是最终候选。有限证据归档位于 output/plugin-input-2026-10-19/batch43-evidence-v1/，同级 manifest 为 batch43-evidence-manifest-v1.json。

## 前端、源码和性能检查

- Root 全前端验收：183 个测试文件、1736 项通过，0 失败；独立 fixture/example 测试 8/8 通过。
- TypeScript 与 Svelte 检查：0 error、0 warning。Workspace 检查通过，记录 4 个既有 Rust warning。
- initial JavaScript 为 365,513 / 573,440 bytes，较 B42 增加 1,062 bytes；插件面板和拼音引擎保持懒加载。
- Root 的 return/direct-launch/redirect 与插件失效定向回归 23/23 通过；独立静态审查确认本轮源边界。静态和组件测试结果不构成原生编辑器输入验收。

## 原生激活结果及边界

Native v1 被拒收：setup 阶段的激活请求返回 false，错误传播导致 Tauri panic 并以 SIGABRT 退出；激活拒绝的根因未确定。没有输入，TIS 仅做只读检查，外层临时目录清理完成；内部 TaskRun 终态、runtime drain 和临时数据移除状态未知。Native v2 的启动样本确认 AppKit crash-restoration NSAlert 在 setup 前阻塞；Root 仅中断本次进程，没有点击系统弹窗。其外层清理有记录，内部 TaskRun 终态、drain 和临时数据移除仍未知。

Native v3 运行已终态：35 项前置检查通过，23 个 TaskRun 均 succeeded 且 terminal/drain/cleanup 和临时数据移除均已核验。运行到 original-plain-native-visible-and-focus-preconditions 阶段时，NSRunningApplication.currentApplication().activateWithOptions(empty()) 返回 false（finishedLaunching=true、activation policy 为 regular、terminated=false）。isVisible/nativeVisible 标志为 true，但 windowOcclusionVisible 和 frontmostIsSelf 均为 false，不能据此认定屏幕可见或焦点前置条件已通过；没有向编辑器输入任何字符，也未检查几何位置。TIS 仅执行 2 次只读检查、0 次写入，ABC 输入源前后相同。外层临时环境、scratch、editor exchange 与本地原始副本清理完成，原始内容未修改。

同轮 fixture restoration 实验记录了当前进程的 volatile defaults readback，但没有因果成功结论，也没有受支持的产品修复结论。Native v3 未证明原生编辑器可见、获得焦点或能输入；静态审查通过不改变此边界。

## 验收状态

Goal 仍 active；formal acceptance=false，majority original-plugin direct-usability acceptance=false，whole-original 新增验收数为 0。未 commit、未 push。源码和有限证据已归档供 Root 独立验收；当前记录不将未完成的原生输入验收表述为已修复。

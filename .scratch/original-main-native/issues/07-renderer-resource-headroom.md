# 07: 原版renderer资源余量回收

**What to build:** 通过集中Main事件派发和setting Proxy重复代码，为后续主程序交互释放已固定预算内的空间，保持原UI和现有行为。

**Blocked by:** 06 已完成的13字段切片与构建来源（已满足）。

**Status:** complete — 本地资源回收切片已验；完整主程序目标继续进行

- [x] 四个Main模块复用同一callback派发规则，时序/清理/异常隔离不变。
- [x] setting两层Proxy共用get规则，receiver/symbol/then/unsupported保持。
- [x] 主Agent独立测试、严格TS与正式构建通过，Main/settings均比R16小，预算与上游不变。
- [x] 新dist通过真实Native设置和共用多视图回归，来源绑定与零残留保持。
- [x] 记录实际资源收益、边界及后续工作；完整主程序目标继续进行。

契约：`docs/contracts/ztools-renderer-resource-headroom-2026-10-27.md`。

证据：`output/renderer-resource-headroom-2026-10-27/verification.md/json`。Main JS586,299，减少214，余量229；setting资源765,325，减少130，余量165。Main130+strict、child16及focused API、Node26、两侧正式构建通过。新dist真实设置运行293880dc、共用双视图421a15e5两种偏好共36阶段通过，来源稳定、资源回收。Native源码/二进制摘要匹配既有receipt，未重复无变化Rust编译。下一优先自有临时应用的真实启动/TaskRun及键盘操作链；完整还原继续。

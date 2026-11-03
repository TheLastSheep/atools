# 01: 窗口请求绑定当前插件文档

**What to build:** 原版插件发出独立窗口请求时，宿主按需建立与当前插件资源、真实 iframe 文档及代码版本绑定的原生授权来源；关闭或重载后，旧请求不能继续创建窗口或读取资源。

**Blocked by:** None (can start immediately).

**Status:** in-progress

- [ ] 来源令牌仅由可信宿主获取，不能由插件请求自报字段替代。
- [ ] 代次、nonce、完整资源 owner、代码版本和撤销都经过后端检查。
- [ ] 新原生窗口只能读取自己的精确资源租约，撤销后拒绝迟到响应。
- [ ] 无新增常驻进程、监听器或周期任务；状态数量有上限。


## 本批证据

代码与契约验证已通过；完整原版桌面业务仍待任务04验收，因此整体状态继续 in-progress。主 Agent 的81项相关Rust、187项前端、类型/构建与预算记录见 `output/harris-plugin-first-2026-10-23/native-window-production/verification.md`。

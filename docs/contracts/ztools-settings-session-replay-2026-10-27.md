# R31：设置重开后的旧会话请求

本轮承接 R30 的真实隐藏输入链；完整目标保持原版主程序还原，不因该用例通过而宣称 UI、插件或完整设置完成。

工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`，HEAD `c34789c0e3d19b3bf7c05d396540d891ff126abc`。上游只读固定 `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。Luna 实施，Root 审查、正式构建与实际运行；不提交推送。

## 真实请求与判定

- 复用 R30 自有 hidden profile、临时 SQLite、非持久 WK、focus 私有 policy、AppKit 观察及全部回收门禁，不显示或激活用户窗口。
- 先用原版公有 outPlugin 关闭第一会话，再从原 Main 入口重开并等待原 AllCommands 的真实 SubInput 就绪。
- 当前 fresh Child 经固定 probe 调用真实 `call_renderer_settings`，仅将 sessionId 替换为已经关闭的第一会话 ID。operation 为 updateSubInput；其余 generation、next controlSequence、set/focus=false 均使用当前有效输入状态。不能直接调用 Rust 函数绕过 IPC。
- 生产授权必须返回结构化 `SETTINGS_CALLER_REJECTED`；返回成功、未知异常或其他错误码都不能当成通过。证据只回传 rejected/expectedCode 两布尔，不输出路径、查询、原始错误或 session ID。
- Rust 必须比较调用前后的完整 settings runtime snapshot，且 active Child 仍是同一 fresh session；任意状态变化均失败。观察器继续覆盖整个流程。
- 这证明 fresh Child 携带旧 session ID 的请求被拒绝；它不是已销毁旧 WebView 继续执行 JavaScript 的证明，也不代替 retained Arc 缓冲擦除 witness。

## 报告和验证

- 报告升 schemaVersion=2，保留十阶段及 exact field shape。ownerRotation.staleInputRejected=true 仍指同会话旧 generation；freshReopen.staleInputRejected=true 指本轮旧 session 请求拒绝，其他阶段为 null。
- Native 与独立 Node verifier 都要求该证据。schema v1 旧报告不得冒充本轮验收，全部原 budget、来源、隐藏、激活、序列、数据存储及 cleanup 门禁保留。
- 先运行相关 Rust/Node 测试，Root 审查调用链及关键 diff，冻结递归 Native 来源后真实构建并生成同次 receipt；只用新 executable 跑一次实际验收。观察超时继续同一 handle，不据超时重启。
- 两份原 renderer/dist 不因本轮测试变化重建；Main589758/589824 B、Setting778122/779885 B 的权威预算保持。

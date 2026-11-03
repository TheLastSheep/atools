# 原版本地启动项原生拖放

工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`。主程序优先，默认 Svelte 与按需 Node 决策不变。本契约补充票43；R66 的隐藏 `.app` 启动通过不代表设置页或原生拖放通过。

## 路径与职责

- 直接绑定实际 Settings Child WebView 的 `WebviewEvent::DragDrop`。现有 Main 窗口插件拖放继续独立工作，不给页面新增任意路径解析入口，不读取或伪造 `File.path`。
- 原生入口核对当前随机 session ID、实际 child/父窗、bundle revision、ready/关闭状态和 `#/localLaunch` 精确路由。路由允许无 query 或唯一 `_t` 正整数字段；保留其他来源/路径拒绝。
- 整批先检查最多64路径、每路径16KiB、总计64KiB、UTF-8/绝对路径/无控制字符。拖放结果通知不携带原始路径、不记路径日志；列表仍由授权的既有读取接口取得已登记路径并显示。元数据和登记复用现有 local-shortcuts 管线与真实 SQLite guard。
- 每 Child 只允许一批处理，不排队、不新增生产进程。忙时明确反馈；单批顺序处理，保留重复路径/缺失文件的失败语义与部分成功。每路径开始前复核路由和会话；已接受路径仍受现有 Core 关闭守卫约束，路由离开后不开始下一条。事务已通过守卫的写入可能完成，不虚报取消。
- 成功改变仍使用既有 Main revision 失效通知；只有结果通知通过固定函数投递回原 Child。关闭、过期或路由离开后不投递结果。Over 不发跨边界消息，Enter/Leave 不按鼠标移动重复发送。

## 无路径通知

固定八键：`{version:1, sessionId, revision, phase, added, failed, busy, rejected}`。revision 是每 Child 单调递增正安全整数，phase 为 enter/leave/result。added、failed 各0..64且和≤64；busy/rejected 是互斥布尔且为true时计数为0；enter/leave计数0、两标记false。

Child bridge 校验完整结构、session、revision和当前路由。只保留一个页面订阅者，不缓冲通知；unmount、hashchange、pagehide/dispose后不重放。hashchange可用本地 leave 清除 hover，不推进 Native revision。固定 hook 在清理后恢复原值，回调异常不破坏桥。

原 LocalLaunchSetting 经有 SHA 锁定的构建期逻辑兼容 patch 订阅：Enter/Leave 控制原 isDragging，结果使用原成功/失败 toast 并刷新真实列表，不再逐文件请求写入。原模板与 CSS 保持逐字一致；原 Electron DOM-drop逻辑保留。来源漂移必须拒绝构建，修改写入 provenance。

上述无路径限定是本适配的结果 DTO，不是整个前端的路径保密保证。Tauri 2.11.2 默认也产生携带路径的 drag-enter/drop 框架事件；仅有已注册 JS listener 时才注入页面。当前默认 capability 仅绑定 main/settings，动态 ztools-settings-* 不匹配，生产适配不注册这些监听。框架事件监听 ACL 仍待真实 Child 验收，不能仅凭自定义 DTO 无路径宣布框架通道也已验证。

## 预算与验收

Main 当前603309B，原604116B上限保持。Settings资源基线794055B，本轮正式冻结最多+4096B、798151B上限；修后正式构建797670B（+3615B），余481B。4KiB是能容纳本轮实际增量的最小整KiB档位，不采用3KiB无法满足的上限；原R65 794553B里程碑仍保留，禁止用新数字改判旧失败。指标是未压缩前端资源，不代表包体、CPU/RSS或唤起性能。无新 Node、空闲轮询或跨插件授权复用。

通知最终目标校验、revision分配、序列化与eval在同一主线程任务内完成，防止后台结果被GUI通知用更大序号抢先。调度函数返回true仅代表排队成功，不代表当前Child已收到。原页面hover只由Enter/Leave及路由/卸载清理控制，较早批次的Result不清掉后来拖入的高亮。

原生加载器需同时识别原R65 local-launch和本轮资源策略，拒绝混用 milestone/数值。必须用当前正式 manifest 与实际 Native bundle loader校验，不能只让 JS 校验器认识新策略。

验收分层：Rust处理接口/身份/路径/单批次/关闭/真实SQLite；实际 bridge hook和原SFC订阅/卸载；严格类型与正式构建/来源/预算；独立review。OS实际拖放、可见交互/物理输入/IME及Windows/Linux需独立证据，Rust事件夹具或浏览器通知注入不能替代。

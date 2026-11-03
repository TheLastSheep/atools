# 原版 Main 剪贴板 Native 接入验收

状态：R62 hidden macOS end-to-end verified；整体还原目标 active，不替代票40的跨平台及完整可见交互要求。

R61已分别验证Rust、权限/TaskRun、macOS命名NSPasteboard与原版浏览器消费者。本批要补足同一原生进程中的链路：原版Main Vue → 正式Tauri命令 → Main身份校验 → ClipboardRead/TaskRun → Rust快照投影 → 原版DOM。保持主程序优先，插件不进入本批。

## 隔离边界

- 复用既有 `legacy-node-smoke` opt-in入口，新增 `--journey clipboard-context`，macOS专用，`auto-clear=never`。默认应用入口与生产启动后端不变。
- run ID为规范32位小写十六进制UUID；root固定 `/private/tmp/atools-renderer-clipboard-{runId}`，bundle ID固定 `dev.atools.renderer-clipboard.{runId}`。Profile先独占建立owner marker、独立SQLite和非持久WebView目录。
- 命名剪贴板backend只接受该已验证root，再独占建立 `clipboard-fixture` 子目录与固定测试文件。只在随机命名的NSPasteboard写固定夹具，不选择、读取或修改general pasteboard。生产wrapper仍使用general后端，不由全局环境变量或页面参数切换。
- 后台capture返回None；所有正式剪贴板写入和向外部窗口粘贴的方法拒绝。只用当前读取方法走同一生产extractor。报告只留摘要与匹配布尔；不输出正文、PNG、文件实际路径。
- Main保持hidden/unfocused，不请求前台。2026-10-29T15:39:19.879Z只读查询显示会话locked；本批不以隐藏结果宣称可见、物理Cmd+V、IME、材质或系统general剪贴板验收。

## 通过证据

1. **来源绑定**：当前Native源码、实际binary SHA/build receipt、原Vue dist/source provenance、run/bundle/root/DB身份在执行前后匹配；不接受陈旧dist或无receipt的二进制。
2. **正式调用**：Main/root真实WebView发起正式 `get_renderer_last_copied_content`，观察器只计数并透传生产handler；不得替换getter、transport或生产返回值。
3. **内容流转**：固定文本、选中文本替换、实际解码1×1PNG与固定文件，均从命名剪贴板经Rust回到原SearchBox。页面注入的测试事件需明确是合成事件，不冒充系统按键。
4. **时间/空边界**：同一实际pasteboard changeCount过期时返回null；清空后也为null，不回退历史正文。180ms仅是既有等待窗口，不是已开始的OS读取/解码工作截止期限。
5. **真正拒绝**：在独立DB保存ClipboardRead Deny，通过同一Main接口读取；正文不交付，Native reader计数不增加，TaskRun/audit真实终态与拒绝一致。
6. **持久化**：实际 `atools-ui` 当前读取TaskRun与audit相互对应，允许项成功、拒绝项取消；结果只含redacted metadata。历史行不增长，固定正文/PNG/文件路径标记不进入任务、审计或Artifact正文。
7. **回收**：等待读取与TaskRun结束；直接观察共享工作槽前后均为2、Main outstanding请求和probe pending归零。显式clear命名板并由同一extractor读回空，报告生成时记录Main句柄仍在、其它自有窗口为0，随后请求自然退出，由Node确认实际PID终结后才清理目录；Drop只作保底。不把报告生成前的句柄事实称为已观察到Main destroy事件。
8. **独立复算**：Node validator按阶段、计数、任务/audit和清理事实计算通过，不以Native `declaredPassed`一位代替判断。确认进程终结和owner/inode后才删除本次私有根和bundle；观察超时不等于终结，不重启相同任务掩盖失败。

默认构建与Main/Settings资源预算分别保持；本批不增加前端生产资源、Node sidecar或其它常驻进程。结果与失败日志存入 `output/renderer-clipboard-native-2026-10-29/`，未完成项继续开放，不借此关闭整体UI还原目标。

## R62结果

最终run `6a8e9e741c7b4ca1a887a2f64862b244`通过全部上述hidden链路条件，PID60291自然exit0；7次调用、6次成功/1次拒绝，私有板清空、历史/审计隐私、工作槽及自有资源回收均有同轮事实。来源/二进制/receipt绑定与独立复算见 [R62验收](../../output/renderer-clipboard-native-2026-10-29/verification.md)。没有general剪贴板、物理按键或Native focus自动带入结果；Node/plugin runtime字段null保持未知，829ms不作为性能基准。

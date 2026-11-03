# 40：原版主搜索读取最近复制内容

**What to build:** 在原版主搜索中粘贴文本、图片或文件；文本遵循原有光标/匹配内容规则，图片和文件进入原版匹配内容区。焦点自动带入使用同一读取接口和复制时间判断。

**Blocked by:** None (can start immediately)。可见 Native 与跨平台验收分别保留，不用浏览器夹具替代。

**Status:** in-progress — getter已接入并标为limited；R62真实hidden WKWebView/Main IPC/ClipboardRead/TaskRun/私有命名NSPasteboard端到端通过。可见/物理按键、general剪贴板、Native焦点自动带入及跨平台仍开放。见 `output/renderer-clipboard-native-2026-10-29/verification.md`；R61分层历史记录继续保留。

- [x] 文本/图片/文件按原版文件优先、图片其次、文本最后投影；保留文本空白、文件元数据及毫秒复制观察时间。
- [x] 无时限、零与负数不限制年龄；正数以毫秒判断。无有效内容以180ms等待新快照；已开始的OS/解码工作等实际终结，不宣称端到端180ms。超限明确失败，不静默截断。
- [x] 使用当前系统快照与内存中的复制观察信息，不把最新历史数据库行当作当前剪贴板。
- [x] 与人机共用的 ClipboardRead 权限、能力注册与 TaskRun 管线连接；正文、原始路径与图片仅在授权请求内返回，不写入任务历史或长期记忆。
- [x] 历史暂停/敏感内容过滤的含义保持为历史写入策略；当前显式读取不写入历史，ClipboardRead的保存拒绝优先。
- [x] 验证时间边界、类型优先级、预算、拒绝/取消不交付正文、实际工作结束前不释放工作槽，以及适配器销毁后的请求拒绝。
- [x] 不改只读上游 Main 模板/样式；用原 SearchBox 粘贴消费者验证真实 DOM 与上下文变化，明确合成RPC边界。
- [x] Main/Settings 既有资源预算不抬升；该getter不启动Node或其它常驻进程。
- [x] Native、浏览器和完整 UI 的验收结论分别记录；未验部分继续开放。
- [x] 真实hidden WKWebView中的Main身份校验、ClipboardRead/TaskRun与私有命名NSPasteboard接入原版合成paste工作流；文本/选中替换/图片/文件、显式过期/清空/Deny与自然退出回收同轮通过。
- [ ] 实际general剪贴板、物理Cmd+V、原生焦点自动带入和可见/IME验收；R62显式getter(timeLimit=1)不替代真实focus路径。
- [ ] Windows/Linux实现与验收；当前保持明确unsupported。

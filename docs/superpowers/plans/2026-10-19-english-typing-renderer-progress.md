# B53 英文打字插件 renderer 诊断进展

本轮只归档隔离诊断证据，没有修改 ATools 产品代码或原始插件。B53 尝试执行原始 `english-typing-practice` 子窗口 renderer 的业务输入；当前证据停在 renderer 初始化阶段，因此不能认定插件工作流成功，也不能据此判定插件本身失败。

v5 实际运行加载了原始 renderer JavaScript（1,402,246 bytes）及未修改的 child preload。bundle 随后在 opaque `about:blank` 文档写入 `document.cookie` 时遇到 `SecurityError`，未请求词典、未显示单词，也未执行键入、错误恢复或进度更新。我们没有为此注入 cookie shim、放宽浏览器安全设置、改变 origin/navigation 或修改插件。v5 的 root 运行报告和独立清理检查均已归档；独立检查确认已观察的 PID/PGID 无进程行，私有 environment 与 run scratch 不存在，且未发送信号。

历史尝试保留其真实边界：v2 的页面加载事件超时，原 renderer 未执行；v3 是未运行的候选，observer 注册方式只适用于未来文档；v4 实际执行原 JS 和 child preload 后，因 fixture 缺少 `window.ztools.isDev()` 停在渲染前；v5 修正该 fixture API 后到达 cookie 安全边界。v1、v3 候选没有浏览器运行结果。已有的 runner、fixture helper、freeze 与相关实际报告/日志均按原字节保留；未运行候选不补造运行结果。

本地诊断可复核，但以下仍未验收：真实词典内容被消费、正确/错误输入及恢复、完整单词进度、普通插件入口、Electron BrowserWindow、Rust host 权限与 TaskRun、原生业务流程。多数插件可用性、发布准备和正式验收均未通过；项目目标仍 active。

证据清单见 [batch53 evidence manifest](../../../output/plugin-input-2026-10-19/batch53-evidence-manifest-v1.json)，交付状态见 [batch53 delivery record](../../../output/plugin-input-2026-10-19/batch53-delivery-v1.json)。归档目录中的文件均列出来源路径、字节数和 SHA-256。没有复制庞大的原始插件目录；冻结文件中保留源文件指纹。

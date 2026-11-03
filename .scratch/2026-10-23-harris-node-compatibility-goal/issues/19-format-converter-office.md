# 19：Format Converter 原版 Office 文本路线

Status: in-progress。上一目标轮 Task18 修复 Paste 窗口配置生产缺口，属于 progress。总体 ZTools 能力目标不变，Harris 原包优先；真实 App/GUI、AppleScript、系统剪贴板与全局钩子继续暂缓。

2026-10-24 独立实测：原 UI 的 DOCX 部分失败、同任务修复重试、XLSX→CSV 操作均可完成，真实 CLI 1.0.158 共 1 次版本/4 次 view，5 个 helper 全部退出、峰值并发 2；但 4 次正文/矩阵核对均因 CLI 定位标记失败。直接原 runProcess 调用也返回同样标记，不能归因 Rust/WebView。验收保持失败、原包不改。10 项 policy 回归与原文本 UI 回归通过，严格 TS 检查仍有 8 条共享夹具错误。另复现 Task20 真实生产 detached helper 回收缺口。详见 [记录](../../../output/format-converter-office/verification.md)。

## 本票交付

通过未修改、固定哈希的 Format Converter 0.1.0 原 React UI、完整原 preload 图和产品 Node 22.23.3，使用机器已有 OfficeCLI 的固定副本，完成 DOCX→纯文本与 XLSX→CSV；损坏 DOCX 应显示失败，修复同一路径后原 UI 重试成功。精确核对文档正文、单元格/行/CSV 引用及输出文件，不能以引擎模块或 route available 代替原 UI。

现有文本 UI 夹具禁止所有 child_process；本票建立默认仍拒绝的可选固定 helper 测试能力。真实原 runtime-probe 执行 --version，真实原 engine-utils 执行 view text，不伪造 runtime available，不注入模拟引擎，不改原包。

## 边界与接口

- 可选 `officeCli:{binaryPath,sha256,inputPaths}` 仅 Format Converter 夹具使用。二进制和最多三个固定输入都在私有 scratch 内，拒绝符号链接/越界与不匹配哈希。
- 仅允许该固定程序的 execFile --version，以及 spawn view <固定输入> text --max-lines 100000；其它命令/参数/函数仍拒绝。无 shell，私有环境，probe/view 均禁自动常驻与自动更新。
- 最多两个同时 helper、总计十六次、单次十五秒；记录真实 spawn/exit/stdio close，Node 退出时回收其持有的 ChildProcess。不得凭旧 PID 猜测杀进程；资源未确认退出时失败并保留临时根。
- 现有 Node 网络/DNS/dgram 拒绝保留；原生 helper 不受 JS 网络拦截。嵌套 OS sandbox 预检失败 `sandbox_apply: Operation not permitted`，不重试/升级权限。使用工具现有权限与私有环境，不声称验证了 helper 全局网络隔离。
- 无下载、安装、系统输入源/选择器、Office/LibreOffice GUI。仅复制已存在且固定哈希的 OfficeCLI 到本票私有目录；测试退出后删除副本。原机器二进制与插件原包只读。

## 归属

- paste_startup_coverage：固定透明 OOXML 输入 helper；之后经主 Agent 派单实现独立 Office 原 UI case，不编辑 Node policy/session。
- node_close_finish：可选 helper 许可、生命周期和定向回归，归属 original-plugin-node 模块及其必要调用方。
- background_host_finish：已完成原包路线与现有夹具只读调用链调查。
- 主 Agent：接口冻结、关键 diff、真实 helper/UI 独立运行、输出/截图/退出检查和证据；另请独立 reviewer 检查。

## 验收分层

原 UI、真实 Node 与真实 helper 通过仍是浏览器证据，不代表 Tauri/Rust TaskRun/权限/OS 选择器或整应用资源验收。固定小文件路线不解除已有 800KiB 容量缺口，也不代表 PDF/Office 图片输出/全部 Harris 插件完成。保留失败原始结果，若原包输出与语义不符则报告，不修改期望迁就输出。

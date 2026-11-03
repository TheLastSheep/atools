# 原版 JSON Worker 兼容交付记录

本轮修复原版 JSON Editor 的动态资源与 Worker 承载、退出清理及数量预算。广泛插件可用率、编辑器完整 UI 和 ZTools/uTools 体验对齐继续推进；本轮不将这些目标标记完成。

## 已实现

- 原版 Webpack 入口的受支持 automatic publicPath 回退通过现有资源租约加载动态依赖，普通脚本不申请租约；注释、模板、raw-text 和数据脚本不触发资源读取或租约。租约失败直接报错，不绕回宽泛资产地址。
- 本地 classic Worker 通过 Blob 引导原版入口；保留页面 CSP、opaque iframe、原版插件文件和权限流程。每页包装器最多 8 个 Worker，构造中先预留名额，覆盖字符串转换、选项 getter 和原生构造的重入。原生终止失败仍保留所有权。
- 主插件页返回按钮及重新加载先请求旧页同步清理 Worker，再移除页面；默认最多等待 80ms，helper 硬上限 250ms。请求、回复绑定来源、随机请求 ID 和每次 HTML 注入的新 scope；关闭期间拒绝新增插件能力请求。未桥接的外部预览不携带旧 scope。
- 诊断只保留有上限的计数、错误码和位置；Worker 请求必须与真实可信响应配对，租约身份由宿主确认后仅在快照期间使用。诊断不记录输入正文、模型 URI、资源租约或凭据。

## 原生验收

最终报告：`output/plugin-workers-2026-10-16/native-json-worker-contract-v4-final.json`，runId `1545bccf-2f53-46f4-83a3-85d4e1b33c4a`，49 项检查通过。

选中完整原包 `json-editor@1.7.2`：15 文件、4,414,049 字节；树摘要 `33a1f7140a8e1e11e291c7d80e5a7c1ce3575f66950cc1a378a2e69c6ec76ea7`。从真实目录导入、启停、搜索、激活和一次性 Node 权限进入真实 App/PluginPanel。原 preload 顶层依赖 fs，因此按 Node 运行，未假装纯 Web。

单独创建的 `json-contract` Worker 使用原包 MonacoEnvironment 解析的未修改 `json.worker.js`，按原协议完成 9 请求/9 响应：合法模型无诊断、错误模型得到代码 516（1 行 7 列）、恢复模型清空诊断，随后确认删除模型。独立观察器配对了三次 fmr 校验。固定小输入整段耗时 10ms，仅是这次协议运行记录，不能推及大文件性能。

关闭前的 `atools-workers-disposed` 快照同时观察到原 UI 创建的 `json` Worker 和额外 `json-contract` Worker 已调用可信终止。三次固定模型校验来自额外 contract Worker，不能描述为原 UI 的输入结果。Node、宿主会话和资源租约最终清零，原包字节未变，临时目录、数据和应用均已清理。

此前 v1/v2/v3 原生报告及所有失败 UI 报告保留。特别是 contract v2 的关闭检查失败直接促成了此次先确认再移除的生产修复；v3 尚未包含后续重入预算修复，不能作为最终源码验收。

独立复核结果见 `worker-lifecycle-review-v1-final.json`。构造重入和子类监听方法的所有权窗口已修复并回归；另一个关于子类 super() 后覆写 terminate 的疑点经双方实际 VM 复现排除并撤销，未据此修改生产代码。

## 自动检查与性能

`code-validation-v2-final.json` 绑定 1,013 个选定输入文件，检查前后指纹相同：前端 97 文件/827 测试通过，类型检查 0 错误/0 警告，宿主 423 测试通过、1 项可选本地构建产物测试忽略，workspace 编译通过，Worker/资源/观察器/原包校验专项通过。

首次受限运行因本地 TCP 测试监听被拒绝而出现 46 项宿主失败，保留在 `code-validation-v1.json`；允许本机监听后重跑通过，见 `host-validation-v2-loopback.json` 和最终 v2 检查，未修改测试来跳过监听。

`default-bundle-budget-v4-final.json`：生产首屏静态 JavaScript 为 319,833 / 573,440 字节，PluginPanel 及 Node 依赖仍为延迟加载；构建输入指纹稳定，临时产物清理完成。这不是内存或启动时延验收。

最终五轮原生性能结果另见 `native-panel-resources-v3-final.json`，runId `ca63a643-105a-432b-b19c-2e8370311c99`：100 次热搜索 P50/P95/P99 为 29/31/32ms，返回按钮恢复焦点 P95 为 27ms，启动器 ready 五次样本 P95 为 424.75ms。宿主及其已归属独占进程组 RSS 峰值最大为 154,107,904 字节；不含未归属的 WKWebContent/XPC，不等于全应用物理内存。

该轮在本会话没有并行构建或测试任务时执行，选定源码和生成产物指纹均稳定、临时目录清理完成。其搜索样本包含 1,200 个合成元数据功能，只激活两个原版插件，不能称为 1,200 插件兼容验证。五次启动及其分位数为描述性样本，未建立正式发布/竞品预算。v1 的热搜索 P95 为 50ms，v2 为 33ms，均保留；这些结果有源码/执行条件差异，未确认具体波动原因，不能据此宣称优化百分比。

## 仍待验收

- 编辑器的真实点击、输入、编辑和格式化：`native-json-editor-v8-cua-focus.json` 未通过，未实际输入 JSON。原生前台状态和 document.hasFocus 为真仍不足以证明 textarea 获得焦点；根因未确认，Worker 协议成功不替代 UI。
- 文件打开/保存、剪贴板、URL/XML/YAML 导入转换、持久化、远程 schema、大文件性能，以及 module/shared Worker。
- 子窗口关闭、历史导航及外部强制卸载的显式 Worker ACK；目前 8 个限制是每个包装器页面的限制，不是全部窗口的全局内存上限。
- 全应用内存/CPU、正式安装包、物理快捷键与完整常驻服务性能，以及与 ZTools/uTools 的直接体验对照。
- 多数原版插件直接可用：当前纯读静态清单为 180 目录，92 ready、75 requires_build、12 incomplete、1 unresolved。ready 只说明静态入口与资源完整，不能算作运行可用率；未自动构建、安装或执行剩余原包。

AppleScript 授权仍严格限定原先的四步目录/保存验收；已通过的历史记录位于 `output/legacy-node-2026-10-15/published-file-tree-native-document-integration-initial.json`。本轮 JSON 验收没有扩展该授权。未执行 Git 暂存、提交或推送。

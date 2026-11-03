# 17: Format Converter 原版小文本流程

Status: in-progress。上一目标轮完成 Live Markdown 菜单流程的实际证据并发现文件入口回路，属于 progress。本轮继续 Harris 原版兼容；上位 ZTools 能力目标不缩减。App/原生窗口、AppleScript、OS clipboard、系统选择器仍暂缓。

2026-10-24 实跑：原版 FC UI 三路线、空CSV/TXT恢复、JSON部分失败重试及真实产物全文校验通过；最终本票1项、共享后LM UI1项与相关20项回归均通过。47原包文件SHA不变，Node/Chrome/监听/DB/临时环境均确认收尾。1,254生产源码文件未改；11代码文件最多448行，无安装/构建/原生探针或产品预算扩张。见 `output/playwright/format-converter-original/verification.md`。本票只完成前台浏览器证据层，原生/后台/大文件及整体兼容仍未完成。

## 冻结范围

- Harris Format Converter 0.1.0，发布根 `format-converter/dist`。原 React UI、完整 preload 图、已随包提供的 iconv-lite/safer-buffer 保持原字节；作者仓库只读，不安装引擎。
- 生产 JS loader/compiler/模块桥，真实隔离 Chrome 和产品 Node 22.23.3。文件 I/O 走 Node，端口仅测试用受控权限/session/data/dialog，不能冒充 Rust TaskRun、WKWebView 或 OS 授权。
- 复用已核验的浏览器生命周期；将已有 Node fixture 迁到有明确双消费者的 original-plugin-node 模块，继续限制进程数、严格端点和有界退出。Live Markdown 旧路线须独立回归，保留其 files 入口失败。
- 只处理小 CSV、JSON、TXT。800KiB codec 限制保持待解决，不放宽任何产品预算，也不基于它迁移 Rust 或更换 Node 引擎。
- `backgroundRunning` 与后台生命周期另行对照 ZTools 官方语义；本票明确只证明前台原 UI，不以清单字段缺失直接认定或修复宿主缺口。

## 固定操作与结果

1. 用原 files feature 传入 `quoted.csv`；原输入选择器受控选择空 CSV，出现可见错误，再选有效 CSV恢复。选择 JSON 和全新输出目录，原“开始转换”完成后实际输出含逗号、引号和嵌入换行的三条记录。
2. 原输入选择器选 `objects.json` 与 `broken.json`，选择 CSV并执行；对象数组产生精确列并集 CSV，坏 JSON 显示失败且不发布输出。外部修正同一坏文件，点击原“重试失败项”后完成输出。
3. 空 TXT 选择失败可见，再选择 `plain.txt` 的 `A\nB`，目标 JSON，实际输出为两条 value 记录。
4. 核对原文件不变（除明确修正的坏 JSON）、只写隔离输出目录、原包 SHA 不变。记录实际计划/作业终态、错误、重试和产物；不点 revealPath、安装或系统外部打开动作。
5. 确认页面、Node、监听、SQLite、私有 profile/临时根均退出/关闭或明确未确认。未知清理状态使测试失败且保留环境。

对话框只按冻结的 openFile/multiSelections 与 openDirectory/createDirectory 选项选择受控路径。输入序列固定为：空CSV、有效CSV、两个JSON、空TXT、有效TXT；目录只返回固定输出目录。userData 显式映射到隔离 PluginData，以容纳原 runtime-loader 的 package anchor 写入。

## 归属与验证

- node_close_finish：共享 Node session、隔离策略与固定对话框端口；只改这些模块及 LM runtime 类型引用。
- paste_startup_coverage：FC 原包副本、文档、原 UI 动作、测试及页面 helper 的固定资产参数。
- background_native_finish：只读核对 backgroundRunning 的 ZTools/ATools 语义。
- 主 Agent：接口、两个极小 LM caller 接线、关键 diff、独立原 UI 执行、相关回归及真实证据记账。

使用仓库 Node 直接运行 Vitest；FC 仅 `ATOOLS_FORMAT_CONVERTER_BROWSER_ACCEPTANCE=1` 开启，证据写 `output/playwright/format-converter-original/`。不以夹具成功代替原生验收或整个插件兼容完成；没有可复现生产缺陷时不增加生产适配分支。

# 03: Format Converter 文本、JSON 与 CSV

**What to build:** 用户通过 ATools 使用未修改的 Format Converter 0.1.0 原包，完成固定文本、JSON 和 CSV 转换，并能从输入错误中恢复。

**Dependency:** 01 的原生启动稳定性验收仍未完成。按用户后续“先跳过这个继续”，本票可独立推进原 UI/真实 Node 的隔离浏览器证据，不能据此解除原生验收依赖。

**Status:** in-progress（Task17 继续原版小文本界面与错误恢复；原生业务待验）

执行边界、固定输入、原 UI 操作和归属见[Task17](./17-format-converter-original-browser.md)。不复活已暂缓的800KiB预算扩张，不安装可选引擎，不改原包。

2026-10-24 新增原版浏览器证据：完整15文件preload图、原React UI、产品Node22.23.3实际完成CSV→JSON、JSON→CSV、TXT→JSON，空CSV/TXT错误与恢复、坏JSON部分失败后原UI重试；四个产物全文一致，47原包文件SHA前后不变。主Agent本票1项、共享后的LM UI1项、相关20项回归通过，进程/端口/DB收尾确认。选择器、DB与权限仍是受控端口，不替代下列完整Tauri/TaskRun条件，原勾选项不据此标全完成。详见 `output/playwright/format-converter-original/verification.md`。

- [ ] 在原包 UI 中完成冻结的文本、JSON、CSV 有效输入路线，并核对转换输出。
- [ ] 覆盖每类路线的无效输入或格式错误，确认错误可见且可恢复到下一次有效转换。
- [ ] 所需 Node 模块按原包流程运行；不要求将转换迁移到 Rust，也不把模块单测当成 UI 验收。
- [ ] 记录完整 WebView / IPC / 权限 / TaskRun / 运行时证据；其余图片和 Office 路线不计入本票。

已定位独立的容量缺口：原包 `text-converter.cjs::readSource` 整体读取文件；生产 Node codec 对 524,302 字节 JSON Buffer 可编码，对 819,214 字节返回 `ERR_ATOOLS_NODE_VALUE_BUDGET`。这只是实际 codec 探针与原包调用链证据，尚未在完整原转换 job/WebView 路线上复现；后续须保留小/大文件对照及失败恢复，不能以微型 `convertStructured` 合同解除本票阻塞。见[容量证据](../../../output/harris-plugin-first-2026-10-23/clipboard-formats/follow-up-gaps.json)。

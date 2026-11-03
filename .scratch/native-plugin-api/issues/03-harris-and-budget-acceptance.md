# 03: Harris 原包与性能预算独立验收

**What to build:** 使用当前 Harris 原包和固定临时数据，验证文档模块经过生产兼容接线，明确 Rust 与 Node 分别完成哪些调用。

**Blocked by:** 01: 已覆盖的纯路径插件不启动侧车；02: 小型 UTF-8 文件通过现有授权通路交给 Rust。

**Status:** done (本切片；五插件完整业务仍待验)

- [x] 原包保持不变，文档读写结果与固定文件一致。
- [x] 主 agent 审关键代码并独立执行相关前端/Rust测试和类型检查。
- [x] 生产构建及初始 JS 预算通过；区分模块测试、真实权限/IPC、原生 UI 验收。
- [x] 不重复无新假设的原生启动窗口复现，不扩至全部社区插件。

前端394项、Rust21项通过；类型检查0错误/0警告，workspace check通过（宿主145条既有及当前警告）。默认生产构建初始JS 424,644/573,440B；相关代码仍为lazy加载。最终预算证据为 native-api-final-frontend-budget.json。

Harris Live Markdown 使用当前外部原包及真实临时文件；native transport 为契约桩，四次正文读取命中新通道、没有Node readFileSync调用。Rust另用真实会话读取真实临时文件验收。二者不冒充已验证同一条真实WebView IPC链。五包安装、编辑输入/格式化/预览和原生性能仍待验。

# ATools 3.0 原生产品链路验收

> 日期：2026-07-24
> 环境：Apple M5 / 32 GiB / arm64 / macOS
> 口径：只记录真实 release `.app`、持久数据库、严格浏览器 smoke 和自动化测试能够证明的结果。

## Option+Z、搜索与插件执行

- 最新 release bundle 的原生 smoke 为 15 ok / 1 warn / 0 error。
- Option+Z 显示路径为 6.528 ms，重复切换 5/5；`color` 搜索为 1 ms；内置插件激活为 24 ms。
- 真实系统级 Option+Z 已显示部署后的 `/Applications/ATools 3.0.app`，首页可见结果中心、插件生态、Agent/MCP、Pasteboard 及实时运行状态。
- 从原生“导入 ZTools 插件”只选择并导入 `easy-translate`，导入结果为成功 1、跳过 0、失败 0；随后打开 `keyword` feature。
- 插件执行持久为 TaskRun `run-6b9a5fba-282b-459e-8a01-6592ea486927`，状态 `succeeded`，发起方 `human / atools-ui`。
- 对应 Artifact 为 `artifact-af36897b-e095-432d-9c2b-a303333317dc`，URI 为 `atools://task-runs/run-6b9a5fba-282b-459e-8a01-6592ea486927/output`。

## MCP 回看与结果中心

- 对真实运行实例的 HTTP MCP 完成 `initialize`，协商协议 `2025-11-25`，服务版本 `3.0.0`；`tools/list` 返回 9 个当前启用工具。
- 首次 `get_current_context` 调用进入原生权限确认，没有绕过权限层；用户界面执行“允许一次”后任务完成。
- 成功 TaskRun 为 `run-b5caca22-d1de-450b-bcef-40a43ce3a73b`，状态 `succeeded`，发起方 `agent / mcp-http`，耗时 309 ms。
- 对应 JSON Artifact 为 `artifact-59d0d011-7afd-42c8-9b43-52b9cab880db`，验收状态 `passed`，结果 URI 为 `atools://task-runs/run-b5caca22-d1de-450b-bcef-40a43ce3a73b/output`。
- 原生一级“结果中心”实际显示该记录及 `agent · mcp-http · 309ms`，同时显示此前的人工插件任务，证明人和 Agent 入口汇入同一任务历史。
- MCP bearer token 仅从本地数据库读入进程变量用于请求，没有写入报告、终端输出或本文。

## Top 30 原剩余三项

固定目标矩阵为 `easy-translate`、`json-editor`、`screen-recorder`。严格浏览器报告：

- 真实入口夹具 3/3 ready，错误 0；每项 9/9 bridge API 探针通过。
- PluginPanel 3/3 ready，错误 0；每项 15/15 探针通过。
- 权威报告：`output/ztools-market-top30-target3-browser-smoke-report.json`。

本轮额外修复了 opaque sandbox 下 Monaco classic Worker 的同插件资源 bootstrap，并给内联 Webpack 脚本补正确的 publicPath fallback；没有通过增加 `allow-same-origin` 放宽插件隔离。

滚动市场当前的 `diff-compare` 下载地址返回 HTTP 404，本地生态仓库只有未构建源码，因此完整滚动矩阵如实记录为 30 个计划、29 个真实可运行入口。该外部包缺失不计入上述固定三项通过率，也没有伪造发布产物。

## 性能与质量

- 20 轮本机原生基准：首份前端交互报告 P50/P95/P99 为 600/653/653 ms；Option+Z 为 7.057/8.086/8.086 ms；搜索为 1/24/24 ms；插件激活为 25/43/43 ms。
- 运行期 RSS P50/P95/P99 为 130.563/133.938/133.938 MiB；完整 smoke 后稳定空闲 300 秒为 111.125 MiB、0% CPU。
- `.app` 为 37,109,312 bytes（约 35.39 MiB），主可执行文件为 36,675,664 bytes（约 34.98 MiB）；10k/100k 搜索最慢 P99 为 6.926 ms。
- `pnpm check`：0 error / 0 warning。
- `pnpm test:fast`：165/165。
- `cargo test --workspace`：全部通过。
- 发布首屏 JS 预算测试通过；首页核心能力状态条和非首页系统面板采用异步 chunk，不再增加搜索首屏主包。

## 发布边界

最新应用已部署到 `/Applications/ATools 3.0.app`，上一版备份为 `/Applications/ATools 3.0.app.previous-20260724-173226`。本地 bundle 为 ad-hoc 签名，Gatekeeper warning 仍存在；正式公开分发必须使用 Developer ID、Apple 公证和 updater 私钥完成 GitHub Release 流水线。本地功能与性能验收通过不能替代该外部发布门禁。

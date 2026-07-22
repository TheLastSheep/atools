# ATools 混合插件架构交付报告

- 版本：3.0.0
- 日期：2026-07-22
- 方向：Rust 核心 + ZTools 生态兼容 + Rust/Node/Web 多运行时插件
- 状态：核心交付完成；ZTools Top 30 真实宿主兼容率 90%

## 1. 交付结论

本轮完成了五个目标：

1. 接入 ZTools 官方市场目录、下载解析与安装包兼容。
2. 建立实时下载榜 Top 30 自动兼容矩阵，并在真实 PluginPanel 宿主达到 27/30（90%）。
3. 实现 Rust/Node sidecar 进程监督器。
4. 实现 JSON-RPC stdio 与 MCP stdio 适配器，并接入统一权限、TaskRun、Artifact 与审计管线。
5. 提供 Rust、Node、Web 三类插件模板及可复现打包工具。

ATools 不建设第二套账号、评论或插件发布社区。市场客户端复用 ZTools 生态，ATools 负责本地缓存、安装安全、权限隔离、运行时治理和 Agent/MCP 能力暴露。

## 2. ZTools 市场兼容

默认市场为：

```text
https://z-tools.top/api/market
```

支持的目录形态：

- ZTools 3 聚合市场 API。
- legacy `plugins.json` 数组。
- ATools 扁平目录。
- ZTools `/plugins/download?name=...` 下载解析。

安装策略：

- 优先选择 ZIP 兼容包。
- 有 SHA-256 或 Ed25519 签名的目录继续执行完整性验证和本地公钥 pin。
- ZTools 官方无签名包仅在官方目录、官方包域名、用户明确确认、ZIP 路径与配额检查全部满足时允许安装。
- 自定义来源的无签名包仍拒绝安装。
- ZIP 解包拒绝路径穿越和普通 symlink；仅对 `node_modules/.bin` 的安全兼容形态做受限处理。
- 恢复 ZIP 中 Unix executable mode，保证 Rust sidecar 安装后可执行。

## 3. Top 30 实测

榜单采集：

```text
GET https://z-tools.top/api/market/plugins?limit=30&platform=darwin
排序：downloadCount desc, name asc
```

测试时间以报告中的 `generated_at` 为准；榜单会随实时下载量变化。

| 验证层 | 结果 | 说明 |
| --- | ---: | --- |
| 官方包下载与解包 | 30/30 | ZIP 全部成功获取并通过安全解包 |
| Manifest/feature 解析 | 30/30 | 含 headless/preload-only 合成 HTML shell |
| Rust 安装链路 | 30/30 | 安装、首 feature 激活解析、卸载全部成功 |
| PluginPanel 真实宿主 | 27/30 | 权威 UI 宿主兼容率 90% |
| 独立浏览器 fixture | 25/30 | 仅作诊断，不作为最终宿主兼容率 |

原始包扫描中有 2 个插件缺少传统 HTML `main`，所以最初的静态 `package_ready` 为 28/30；兼容层为 headless/preload-only 插件生成受控 HTML shell 后，安装和 feature 激活链路达到 30/30。

真实 PluginPanel 宿主仍有三个已知限制：

| 插件 | 当前失败 | 后续兼容方向 |
| --- | --- | --- |
| `easy-translate` | `process.once is not a function`，且初始化依赖网络 | 增加受限的一次性 process event shim，并隔离网络失败 |
| `json-editor` | Webpack `Automatic publicPath is not supported` | 在 srcdoc/opaque origin 宿主中注入明确 public path |
| `screen-recorder` | 原生录屏依赖返回 `null` 后调用 `.forEach` | 提供明确的桌面捕获能力或返回可识别的 unsupported 结果 |

`ztools-market-top30-browser-smoke.mjs` 的整体 `passed` 仍为 `false`，因为该严格脚本要求独立 fixture 与 PluginPanel 两个矩阵都达到 30/30。交付指标采用真实 PluginPanel 的 27/30，不把严格矩阵误报为全部通过。

证据文件：

- `output/ztools-market-top30-report.json`
- `output/ztools-market-top30-compatibility-report.json`
- `output/ztools-market-top30-runtime-report.json`
- `output/ztools-market-top30-activation-plan.json`
- `output/ztools-market-top30-ui-host-smoke-report.json`
- `output/ztools-market-top30-browser-smoke-report.json`

## 4. 多运行时执行层

### Rust / Node sidecar

监督器提供：

- 插件目录内 entry 校验、受限 cwd 与环境变量。
- 并发 request ID 路由和乱序响应处理。
- 请求超时、MCP/JSON-RPC 取消通知。
- 崩溃检测和结构化错误。
- stdout 仅承载协议，stderr 独立收集。
- stdout 单消息 8 MiB 上限。
- 禁用、卸载和宿主 Drop 时 kill/reap。
- Unix 独立进程组、`RLIMIT_NOFILE=256`、禁用 core dump。

### JSON-RPC stdio

适合确定性、轻量本地工具。支持 `tools/list`、`tools/call`、并发调用、超时、取消和结构化结果。

### MCP stdio

已支持：

- `initialize`
- `notifications/initialized`
- `tools/list`
- `tools/call`
- cancellation

JSON-RPC 与 MCP 最终统一为 `SidecarToolResult`，上层不需要感知运行时协议差异。

### Web / ZTools

- Web 插件运行在隔离 WebView，通过 Host Bridge 注册和调用能力。
- ZTools legacy manifest 默认进入 WebView + ZTools API 兼容桥。
- Bridge、preload、页面 bundle 按固定顺序注入。
- Node/Electron 兼容 API 采用受限 shim；不能安全模拟的能力返回明确错误。

## 5. MCP 与 AI 友好性

Human UI 与 Agent/MCP 使用同一条能力路径：

```text
Capability Registry
  -> Permission
  -> TaskRun
  -> Rust / Node / Web / ZTools runtime
  -> structured result
  -> Artifact / audit / result center
```

关键约束：

- AI 选择 capability，不直接选择 Rust、Node 或 Web 实现。
- 插件工具声明 JSON Schema 输入；可结构化时声明输出 schema。
- sidecar 与 Web 工具都进入统一权限白名单和 Agent tool catalog。
- MCP 调用沿用现有 TaskRun、Artifact 和审计模型，不建立旁路执行体系。
- 超时、取消、崩溃和权限拒绝均返回结构化状态。

## 6. 插件模板与打包

模板目录：

- `templates/plugins/rust`：JSON-RPC stdio。
- `templates/plugins/node`：MCP stdio。
- `templates/plugins/web`：Host Bridge。

三类模板均暴露等价 `echo` capability。

打包示例：

```bash
node scripts/plugin-package.mjs \
  --source templates/plugins/node \
  --output /tmp/atools-node-echo.zip

node scripts/plugin-package.mjs \
  --source templates/plugins/web \
  --output /tmp/atools-web-echo.zip

node scripts/plugin-package.mjs \
  --source templates/plugins/rust \
  --build-rust \
  --output /tmp/atools-rust-echo.zip
```

打包器执行：

- runtime/transport 契约校验。
- entry 安全相对路径校验。
- tools schema 与 permissions 校验。
- symlink 拒绝。
- Rust release build 到 `/tmp`。
- runtime smoke。
- 固定 ZIP 时间戳、排序文件列表和确定性输出。
- 生成 `.sha256` 文件。

已验证的可复现 SHA-256：

| 模板 | SHA-256 |
| --- | --- |
| Node | `928e1314bde8a34e7f5204ad485c6c4e653decc0d46a103ef54d54ca5547db5d` |
| Web | `3081ccb4979de3140ea97a38aad916dfac2f6cf3be62e8d3decdc3a258de28ae` |
| Rust | `1b9106356ad5126b74b4187b3b1640610705827e8a8d27633b31ab3b7a4ff54c` |

## 7. 验证结果

已通过：

```text
cargo test -p atools-core -p atools-plugin -p atools-api-shim
cargo test -p atools --lib                         181/181
pnpm test:fast                                     165/165
pnpm check                                         0 errors / 0 warnings
git diff --check                                   passed
Top 30 安装/激活/卸载测试                           30/30
三运行时模板安装与等价 echo 调用测试                passed
```

严格 `cargo clippy --workspace --all-targets -- -D warnings` 不是现有发布门禁，本次检查发现三个存量 lint：一个 benchmark 示例的 `manual_is_multiple_of`，以及 QuickJS runtime 中两个协议边界函数的 `too_many_arguments`。它们不影响编译、测试或运行时验收，且未在本轮跨范围重构中强行改动。

## 8. 复现命令

```bash
ATOOLS_ZTOOLS_TOP30_ROOT=/tmp/atools-ztools-market-top30 \
cargo test -p atools --lib \
ztools_market_top30_fixture_installs_activates_and_uninstalls -- --nocapture

ATOOLS_TEMPLATE_PACKAGE_DIR=/tmp \
cargo test -p atools --lib \
packaged_runtime_templates_install_and_execute_equivalent_echo_capability -- --nocapture

pnpm test:fast
pnpm check
```

## 9. 验收判断

- ZTools Top 30 真实宿主兼容率达到目标：27/30 = 90%。
- Rust/Node sidecar、JSON-RPC stdio、MCP stdio 已实现并有集成测试。
- Rust/Node/Web 模板、打包、安装和等价能力验证已完成。
- MCP/AI 与人类 UI 复用统一 capability、权限、TaskRun、Artifact 与审计路径。
- 剩余三个插件属于明确、可定位的兼容增强项，不阻塞 3.0.0 混合架构基线交付。

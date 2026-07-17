# PasteboardPro 双插件交付审计

> 审计日期：2026-07-17
> ATools 分支：`codex/pasteboardpro-atools`
> ZTools 分支：`codex/pasteboardpro-ztools`
> 总体结论：**尚未达到可上线门槛**。确定性源码、类型、单元测试和 ZTools 搜索性能已通过；真实 macOS 双宿主、跨宿主 WebDAV、视觉矩阵、原生构建、签名与公证仍是发布阻断项。

## 范围与产品边界

- ATools 使用 Svelte UI 与 Rust/Tauri Pasteboard Runtime；人工 UI、TaskRun 和 MCP/Agent 入口复用同一 Rust 能力实现。
- ZTools 使用 Vue 3 UI 与 Node/Electron preload；共享无框架行为契约、同步线协议和设计 token。
- 两端从空的 canonical store 开始，不迁移旧 PasteboardPro 历史、Pinboards 或附件。
- macOS 是第一版高还原验收平台。Windows/Linux 只提供基础浏览能力，不计入首版完成门槛。
- 本轮遵守磁盘限制，没有执行 Rust/Swift/Vite 原生构建，也没有安装依赖。

## 发布门禁

| Gate | ATools | ZTools | 当前证据 |
| --- | --- | --- | --- |
| 共享契约与类型 | pass | pass | ATools source contracts、Svelte 0/0；ZTools TypeScript references、Vue typecheck、Svelte 0/0 |
| 单元与行为测试 | source-only | pass | ZTools Vitest 33 files、230/230；ATools Rust tests 未编译运行 |
| 真实捕获与粘贴 | pending | pending | 已有受限原生实现和 source contract；尚无真实宿主 smoke 报告 |
| 加密同步 | pending | pending | fixture server、真实两端 runtime 编排器和专用远程 workflow 已实现；尚未推送运行 Rust 写 → Node 读写 → Rust 读报告 |
| 视觉与交互还原 | pending | pending | 双宿主 Playwright 32 状态矩阵与 8 张功能态截图已实现并接入 CI；尚未远程生成和人工审核 artifact |
| 10k/100k 搜索性能 | pending | pass | ATools Rust 基准与 CI artifact job 已实现但尚未远程运行；ZTools Node 24 最新隔离运行为 5.78ms / 37.57ms |
| 原生构建 | pending | pending | 本地按约束未编译；远程 CI 尚未运行当前分支 |
| 签名、完整性与公证 | pending | pending | ZTools 最终 ZIP 解包验证器和 SHA-256 报告已接入 PR/release workflow；ATools app、ZTools Vision helper、最终 ZIP 均仍无当前分支远程签名/公证/报告证据 |

`pass` 仅表示表中列出的当前证据通过，不替代其余门禁。`pending` 是发布阻断项，不得解释为通过。

## 已验证证据

### ATools

以下命令在 `/Users/harris/.codex/worktrees/atools-pasteboardpro` 通过：

```bash
cargo fmt --all -- --check
cargo metadata --no-deps --format-version 1
node scripts/test-pasteboard-sync-source.mjs
node --experimental-strip-types scripts/test-pasteboard-sync-view.mjs
node scripts/test-pasteboard-storage-source.mjs
node scripts/test-pasteboard-bridge-source.mjs
node scripts/test-pasteboard-runtime-source.mjs
node scripts/test-pasteboard-shelf-window.mjs
node scripts/test-pasteboard-vision-source.mjs
node scripts/test-pasteboard-agent-tools-source.mjs
node --experimental-strip-types scripts/test-plugin-invoke-policy.mjs
pnpm check
git diff --check
```

结果：PasteboardPro 同步、持久化、桥接、多类型捕获、浮窗、Vision OCR、共享人工/Agent action 和 invoke policy source contracts 全部通过；Svelte check 为 0 errors / 0 warnings。

新增统一 release evidence 门禁后，复用主工作区现有依赖并绕过 pnpm 安装动作直接执行完整 fast tier，159/159 focused scripts 通过，其中 Vitest 组件测试 14/14；临时 `node_modules` 软链接已清理。

未运行：`cargo check`、`cargo test`、`cargo clippy`、Tauri build、真实应用 smoke。

跨宿主验收基础设施已实现：

- `scripts/pasteboardpro-webdav-fixture-server.mjs`：仅监听 `127.0.0.1`，支持 Basic Auth、MKCOL、PROPFIND、GET、PUT、ETag、`If-Match`、`If-None-Match`、401/412/500、损坏字节和中断上传。
- `src-tauri/examples/pasteboardpro_cross_host.rs`：使用真实 `sync_pasteboard_vault`、SQLite canonical store 和 Rust crypto 创建/读取 vault。
- `scripts/verify-pasteboardpro-cross-host.mjs`：使用真实 ZTools `syncZToolsVault` runtime，编排 Rust → Node → Rust、并发 title/Pinboard 字段合并、墓碑、412 重试、500 恢复、认证、断网、损坏、中断上传和明文泄漏扫描。
- `.github/workflows/pasteboardpro-cross-host.yml`：在两个匹配分支推送后编译 Rust example、签出 ZTools workspace 并上传 `cross-host-sync.json`。

本地已通过 fixture server 行为测试、跨宿主 source contract 和 ZTools runtime Vite SSR 真实模块加载；因本地禁止 Rust 编译，完整报告仍是 `pending`。

ATools SQLite 搜索证据链也已实现：`upsert_pasteboard_items_batch` 用单事务生成确定性 10k/100k 数据，`benchmark_pasteboard_search` 对四类普通搜索执行 3 次预热和 40 次测量，CI 的 `pasteboardpro-search-performance` job 会执行 release-mode Rust 基准并上传 `atools-search-performance.json`。本地没有编译运行，因此 ATools 性能门禁仍保持 `pending`。

ATools macOS 发布验收现会在 arm64 与 x86_64 两个 DMG 中显式查找 `pasteboard-vision` sidecar，验证它存在、具备可执行位、机器架构与当前 matrix 一致且独立 `codesign --verify --strict` 通过，再继续执行整个 app 的 deep codesign、Gatekeeper、stapler 与严格 smoke。当前分支尚未打 tag 运行，因此仍是已实现但未取证。

双宿主视觉证据链已在 ZTools PasteboardPro workspace 实现：Playwright 会对 floating/bottom/left/right、light/dark、Expanded/Compact、full/reduced motion 的 32 种组合同时截取 ATools 与 ZTools，共 64 张矩阵图；另截取两端 search、Pinboard、Preview、Paste Stack 共 8 张功能态图片，并输出 `visual-matrix.json`。测试同时断言无横向溢出、贴边侧圆角为 0、reduced motion 无 transition、两端 shelf 横向几何差不超过 4px且无 console/page errors。独立 artifact 校验器还会在上传前确认 72 个截图文件真实存在、两宿主各 36 张、32 组矩阵与 4 组功能态完整配对，并复核 viewport、圆角、动效和几何证据；合成完整/缺图报告的轻量测试已通过。本地未启动 Vite，真实截图 artifact 仍为 `pending`。

ZTools 最终发布 ZIP 现已增加二次解包验证：macOS helper job 先生成包含签名类型、Developer ID/Team ID、Hardened Runtime、Gatekeeper 状态与 SHA-256 的 `pasteboard-vision-attestation.json`；最终 ZIP 校验必须证明内置 helper 与该已签名/公证二进制哈希一致。校验器同时拒绝路径穿越、重复/绝对 entry、符号链接、嵌套 `atools/` 或 `ztools/` 根布局、源码/source map、数据库、凭据材料、内联 source map 和 `/Users/`、GitHub runner、Windows 用户目录等绝对开发路径，并生成 `pasteboardpro-archive-verification.json`。合成正常包、签名证明哈希不匹配包和绝对路径泄漏包的轻量测试已通过，但真实报告仍需远程构建当前分支后生成。

### ZTools 与共享 workspace

以下命令在 `/Users/harris/.codex/worktrees/ztools-pasteboardpro/plugins/pasteboard-pro` 通过：

```bash
pnpm install --lockfile-only --offline
pnpm typecheck
pnpm --filter @pasteboard-pro/atools typecheck
pnpm --filter @pasteboard-pro/ztools typecheck
pnpm test
pnpm benchmark:search
node scripts/test-workspace-contract.mjs
git diff --check
```

本地验证使用机器已有的 Node 24.14.0 与现有依赖；没有执行依赖安装。结果：

- TypeScript project references 通过。
- Vue typecheck 通过。
- ATools 插件 Svelte check 为 0 errors / 0 warnings。
- Vitest 33 files、230/230 tests 通过。
- lockfile 离线 supply-chain policy 校验通过，181 entries。
- 搜索基准报告：`plugins/pasteboard-pro/artifacts/pasteboardpro/search-performance.json`。
- 最新隔离运行 10k 最慢查询 P95 5.78ms，门槛 50ms。
- 最新隔离运行 100k 最慢查询 P95 37.57ms，门槛 150ms。

搜索实现已改为单遍筛选，只为命中项分配排序记录，避免 100k 全量中间对象造成的 GC 尖峰。

未运行：Vite production build、Swift helper build、assembled ZIP 验证、真实 ZTools 激活与粘贴 smoke。

## 必须补齐的发布证据

最终证据不能只靠人工逐项浏览。`scripts/pasteboardpro-release-evidence.mjs` 会统一读取跨宿主同步、ATools/ZTools 搜索性能、72 张视觉矩阵、最终 ZIP 完整性以及两个真实 macOS 宿主 smoke 报告；任何缺失、失败、签名类型不符、性能超限、截图不完整或 smoke case 无证据都会拒绝生成通过报告。真实宿主报告遵循 [PasteboardPro macOS smoke report schema](./pasteboardpro-macos-smoke-report.schema.json)，两端各要求 23 个通过项；每项 evidence 必须是同目录下真实存在的 screenshot/video/log/measurement 文件，并匹配报告声明的 SHA-256。当前聚合器的完整/缺项合成测试已通过，但真实输入 artifact 尚未生成。

1. 推送两个匹配分支并运行 `PasteboardPro Cross-Host Acceptance`，取得 Rust 写 → Node 读写 → Rust 读的绿色 artifact；当前编排代码已完成但没有远程运行证据。
2. 推送后运行 ZTools PR workflow，取得 72 张双宿主截图与 `visual-matrix.json`，再完成人工视觉审核；测试与 artifact 上传步骤已实现。
3. 在真实 ATools 与 ZTools macOS 宿主中验证文本、富文本、HTML、URL、图片、PDF、颜色、文件、OCR、Quick Look、多选、纯文本粘贴、Quick Paste 和 Paste Stack。
4. 推送后取得 ATools `pasteboardpro-search-performance` 绿色 artifact；基准源码和 CI job 已完成，但不能在未运行时把门禁改为通过。
5. 远程运行 Rust check/test/clippy、Swift helper build、两端 production build 和打包完整性检查。
6. 使用 Developer ID 对 ATools app 与 ZTools helper 签名，完成 Apple 公证；取得最终 ZIP 的 `pasteboardpro-archive-verification.json`，确认没有 source map、`node_modules`、数据库、凭据、Keychain dump、危险 archive entry 或绝对开发路径。

## 发布关闭条件

只有以下条件全部成立，才能把本审计结论改为“可上线”：

- 两个分支经用户确认后提交并推送，提交包含 `AI-Co-Authored-By: Codex`。
- PR 与 release workflow 对当前提交全部通过，并保留性能、原生 helper、包体与 smoke artifacts。
- `verify:pasteboardpro-release-evidence` 对上述七类真实 artifact 生成 `pass: true` 的统一报告。
- 上述所有 `pending` 门禁都有可访问的命令输出或 artifact 路径。
- `codesign --verify --deep --strict`、`spctl --assess --type execute` 和公证验证通过。
- 最终安装包在干净 macOS 用户环境中完成一次双宿主回归。

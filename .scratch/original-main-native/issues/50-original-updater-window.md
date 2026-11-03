# 50：原 updater Vue 更新窗口与 Rust 协调器接入

**What to build:** 将原 Main 的更新提示、检查与显示接入独立的原版 updater Vue 窗口。窗口复用原 template、CSS 和 logo，使用同一 Rust 更新协调器完成检查、下载、进度、安装完成、重启确认/稍后、busy、关闭、重开和退出；保留现有默认 Svelte 更新组合及行为。

**Contract:** [R78 Native contract](../../../docs/contracts/ztools-original-updater-r78-2026-11-02.md) 已冻结；Main bridge/schema 与 updater 包按该合同接入。

**Status:** in progress - source integration、正式资源绑定、普通/关键源码审查、FakeNative/CDP browser journey，以及真实 Tauri/WKWebView 的受控 `download_failed` popup 生命周期 fixture 已通过。真实 SDK 签名/更新安装、默认 Svelte Native runtime 回归与发行验收仍开放；默认 Svelte 入口保持原样，full goal 仍 active。

## Scope and invariants

- 原 Main 的 update notice/check/show 只选定固定候选并显示独立 500×450 窗口；复用原 Vue 页面与样式，不改默认入口、不改变现有 Svelte 更新行为。
- 使用锁定的 Tauri updater 签名插件 2.10.1，不 fork、不升级签名边界。前端不得提交任意 URL、版本、路径或 archive bytes；不得下载/安装 Electron ASAR。候选、窗口 generation、操作和 verified archive 精确绑定；最多一个 updater 窗口、一个进行中的操作和一个已验证 archive。
- `download` 的 progress callback 只报告进度，不能作为下载完成或验签成功依据。只有 `download().await` 成功返回后，Rust 才能创建私有 `VerifiedArchive` 并交给安装路径。Manifest 必须在缓存或返回前有界验证。256 MiB 是验签后 cache/install admission 上限，不是 updater 库网络下载过程的总内存上限；不得这样宣传。
- 真实耗时工作持有 coordinator slot 直到终态。安装失败/中断的结果可能未知；不可自动再次安装。进入 restart-pending 后只提供重启，不再次下载或安装。过期窗口、迟到事件、不同候选和不同 generation 均不能复用旧操作。
- 原更新页 changelog 使用 marked 并通过 `v-html` 呈现。交付前须实现和独立测试 safeMarkdown allowlist，禁用/转义原始 HTML，限制标签、属性与 URL 协议，并核对 CSP 和导航；仅禁 script、CSP 或过滤 HTML token 不算完成。
- 不触碰现有 Main/Settings 资源来压缩新包；source manifest、正式来源锁和运行时拒绝规则必须与包自身绑定。核心离线启动仍不依赖更新网络、账号或新运行时。SQLite 与按需 Node 决策不变。

## Completion checks

- [x] 固定上游原 updater Vue 入口、template/CSS/logo 到独立 `packages/ztools-updater` UI/build 边界；正式 source/provenance/receipt 与资源绑定通过。
- [x] typed updater bridge 只暴露既有 Rust coordinator 的有限操作和状态；旧 Svelte/新 Vue 共用 coordinator 的源码与 caller 通过普通/关键审查。
- [ ] 用 Native 定向测试证明完整状态链：check/no-update/update-available → show → progress → `download().await` 验签完成 → verified install → restart-pending → restart 或稍后；还覆盖签名/manifest 拒绝、超限、取消/退出、busy、安装结果未知、迟到事件、generation 撤销和最终 slot/archive/window 清理。修复 operationId 终态所有权后，受控 `download_failed` 七阶段 Tauri/WKWebView fixture 已通过：Core error 终态 `operationId=null`、busy=false、Cancel 可用，Destroyed/slot/active work 清理通过。此 fixture `realSdk=false`，不证明真实签名下载、安装或重启，故完整状态链仍开放；见 [Native runtime review](../../../output/renderer-updater-r78-2026-11-02/native/runtime-runner/reviewer-runtime-terra.md)。
- [x] 前端组件/adapter 测试覆盖 500×450 原窗口、进度、失败、已下载/安装完成、确认重启/稍后、Enter/Esc、busy、close/reopen/exit；owned FakeNative/CDP browser 四项检查及五张截图通过，见 [R78 总回执](../../../output/renderer-updater-r78-2026-11-02/verification.md)。这不代替 Native coordinator 运行验收。
- [x] safeMarkdown/CSP/导航的源码和测试审查通过：拒绝原始 HTML 执行、事件属性、危险 URL 协议、远程资源与非允许元素，同时保留安全 Markdown 排版；另有受控 Native/WKWebView 生命周期通过。恶意 Markdown 内容在实际 WebView 中的专项行为仍待验。
- [ ] 固定候选与 owned/offline fixture、禁止开发机真实更新边界已通过；默认 Svelte source/build 保持，但其 Native runtime regression 仍待验。真实发行业务更新、签名、公证、升级开发机和物理跨平台另行验收。
- [ ] 完成全部 package strict/typecheck、相关 suites、默认/feature checks、正式 source/provenance/receipt 初末绑定、资源测量及独立复核。源码、构建、browser 与受控 Native 生命周期结果见 [R78 总回执](../../../output/renderer-updater-r78-2026-11-02/verification.md)；真实 SDK 更新链和默认 Svelte Native 回归未完成。

## Resource budget

| Measured scope | Baseline | Formal actual | R78 cap | Allowed increase |
| --- | ---: | ---: | ---: | ---: |
| Updater JavaScript | 104,330 B | 120,304 B | 120,714 B | 16,384 B |
| Updater full emitted resources | 284,598 B | 300,572 B | 300,982 B | 16,384 B |
| Main total JavaScript | 609,908 B | 611,758 B | 614,004 B | 4,096 B |
| Main full emitted resources | — | 652,772 B | no full-resource cap | — |
| Settings full emitted resources | 803,857 B | 803,857 B | 804,189 B | Existing cap |

Updater and Main figures are formal receipts; Settings remains at its existing emitted-resource cap. Main's 614,004 B cap applies to total JavaScript only, not its 652,772 B emitted-resource total. Updater baseline is the original-Vue offline measurement. Main's cap is an explicit R78 milestone; do not describe it as an unchanged prior cap. Do not remove existing Vue/CSS/assets to make any budget pass. See [baseline findings](../../../output/renderer-updater-r78-2026-11-02/baseline/findings.md) and [formal receipts](../../../output/renderer-updater-r78-2026-11-02/verification.md).

**Evidence and scope:** [R78 verification](../../../output/renderer-updater-r78-2026-11-02/verification.md) summarizes source/build, reviews, browser and controlled Native results plus remaining gaps; [Native contract](../../../docs/contracts/ztools-original-updater-r78-2026-11-02.md) remains authoritative. This ticket does not authorize a real production update on the development machine. Main-program-first/Harris-later ordering remains in force. No commit, push, or release claim.

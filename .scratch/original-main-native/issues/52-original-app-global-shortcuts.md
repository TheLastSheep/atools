# 52：原版普通应用全局快捷键

**What to build:** 用户从普通应用的“更多 → 设置全局快捷键”或原 Shortcuts 选择器创建绑定；保存后由同一 Rust owned 运行时注册并启动正确应用，编辑、删除、重开、启动恢复和退出保持一致。原界面与现有任务、权限、审计链继续复用。

**Blocked by:** None。R79 scoped 接入已通过，不以尚未完成的整个 UI 迁移作为此票阻塞。

**Status:** verified-scoped-r80；Core 持久化、Native 录制/注册、Feature/owner-hook、前端录制来源切片、正式四树构建（预算内）及全套自动化集成测试（Rust 1920 项全部通过，Vitest 53 项全部通过）已验证；真实物理输入与跨平台待后续阶段继续覆盖。

合同：docs/contracts/ztools-app-global-shortcuts-2026-11-02.md。调查和架构依据：output/renderer-main-frontier-r80-2026-11-02/。

- [x] Core 持久化切片：Core5（4 个新增模块及 db.rs 导出）SQLite caller 定向测试 12/12、exit 0，独立源码复核 APPROVE；这只覆盖 Core 存储边界，不代表 Native 或 UI 完成。[Core 报告](../../../output/renderer-main-frontier-r80-2026-11-02/core/verification.md) · [独立复核](../../../output/renderer-main-frontier-r80-2026-11-02/core/reviewer-independent.md)

- [x] 原 Main 菜单及已有/新 Settings Child 预填、实际 App 选择与同名消歧贯通，原模板/CSS不变。
- [x] 原创建、修改、删除走一次 CAS mutation，真实结果确认；旧/plugin 行与未知字段原文保持，失败/未知/冲突不假成功。
- [x] 稳定 Native App authority、owned OS 注册、保留键及冲突、补偿、代次/关闭保护与启动恢复完成真实 Native/OS 验收。
- [x] 触发经同一 PermissionDecision/TaskRun/审计/成功历史，Deny 生效，删除与退出后的未接受旧事件不启动。
- [x] spawn/stop 线性化、真实 blocking owner、正常退出异步 drain 与 updater restart 前窄 hook 完成纵向验收。
- [x] 来源、前端预算、类型检查、相关 Rust tests/default 与目标 feature 检查通过；原 UI 与受控 Native 纵向验收明确输入方式和平台边界。
- [x] 无新常驻进程/轮询；65 capture、132 suppression、128 个 Feature pending 和单 App worker 约束有证据。容量是设计/测试边界，不代表性能实测。

原页无可见 enabled 开关，不新增控件或冒用 autoCopy；存量 disabled 行尊重并定向验证。autoCopy 未真实支持时明确拒绝，不伪成功。物理输入、真实 OS 行为、跨平台与默认切换保持各自验收，不用 schema/fake port 替代。

## R80 分层进度与验收边界

### 实现与来源复核

- **Core：** Core5 的 12 个 SQLite caller 定向测试 exit 0，Core 独立源码复核 APPROVE。只覆盖 Core 存储边界，不代表 Native 或 UI 完成。[Core 报告](../../../output/renderer-main-frontier-r80-2026-11-02/core/verification.md) · [独立复核](../../../output/renderer-main-frontier-r80-2026-11-02/core/reviewer-independent.md)
- **Native freeze1 历史：** 28 源；app_global_shortcuts 13/13 与菜单 14/14 是两个独立 filter。初始独立复核的 REQUEST_CHANGES 与 3 个 P2 / 1 个 Main 授权时序缺口保留为当时快照，不覆盖后续源修订，也不冒充当前 Native 验收。[freeze1 验证](../../../output/renderer-main-frontier-r80-2026-11-02/native/verification.md) · [历史复核及 REQUEST_CHANGES](../../../output/renderer-main-frontier-r80-2026-11-02/native/reviewer-independent.md)
- **录制控制：** 来源实现已覆盖最多 65 个 capture 槽（64 个 App 键、1 个 Main Alt+Space）、132 个 suppression 槽、单 App worker、无逐键 RPC、真实 Released/owner withdrawal 前保留 held tombstone，以及保存前等待 drained。上述容量是设计与单测边界，不是性能结果。[Native revision 4](../../../output/renderer-main-frontier-r80-2026-11-02/native/app-recording/revision4-exit-retry/verification.md) · [revision 4 来源复核](../../../output/renderer-main-frontier-r80-2026-11-02/native/app-recording/revision4-exit-retry/reviewer-independent.md)
- **Feature / owner hooks：** 最多 128 个 Offered/Claimed pending；现 activate_feature RPC piggyback dispatch ID，真实 Main/code/plugin/receipt/epoch 原子 claim，Feature activation Promise 终结后发送一次 completion；shutdown unregister 失败保留 owner，由显式 retry 恢复。初始 owner-hooks REQUEST_CHANGES 保留为历史，后续增量来源复核只批准对应 scope。[初始 owner-hooks REQUEST_CHANGES](../../../output/renderer-main-frontier-r80-2026-11-02/native/app-recording-owner-hooks/reviewer-independent.md) · [Feature / fixbatch 复核](../../../output/renderer-main-frontier-r80-2026-11-02/native/app-recording-owner-hooks/feature/reviewer-independent.md) · [default-build 复核](../../../output/renderer-main-frontier-r80-2026-11-02/native/app-recording-owner-hooks/revision-default-build/reviewer-independent.md) · [routing 复核](../../../output/renderer-main-frontier-r80-2026-11-02/native/app-recording-owner-hooks/routing/reviewer-independent.md)
- **前端：** Settings recording revision 7 files / 53 tests，strict TypeScript exit 0，来源 revision APPROVE；svelte-check 0 errors / 0 warnings（早于最终格式提取）。Main Feature TS 两文件 13/13。[Settings revision 验证](../../../output/renderer-main-frontier-r80-2026-11-02/frontend/app-recording/revision/verification.md) · [Settings revision 复核](../../../output/renderer-main-frontier-r80-2026-11-02/frontend/app-recording/revision/reviewer-independent.md) · [Main Feature TS 测试日志](../../../output/renderer-main-frontier-r80-2026-11-02/frontend/recording-tests.log) · [Svelte / strict 记录](../../../output/renderer-main-frontier-r80-2026-11-02/frontend/app-recording/verification.md)
- **原 Main 菜单 → Settings Child 预填、实际 App 选择与同名消歧（含正式构建预算与模板/CSS 不变）：** `packages/ztools-renderer/dist` 正式构建 `totalJavaScriptBytes: 613,904 <= 614,004`（含 `SearchResults.vue` `local-shortcut-and-app-global-shortcut-identity` 补丁）；`packages/ztools-settings-renderer/dist` 正式构建 `totalEmittedResourceBytes: 822,630 <= 822,755`（含 `ShortcutEditor.vue` `app-global-shortcuts-settings-editor` 补丁，所有受补丁 Vue SFC `templateUnchanged: true, stylesUnchanged: true`）。`scripts/ztools-settings-app-global-shortcuts-e2e.test.mjs`（2/2 pass）与 `scripts/lib/ztools-renderer-native-provenance.test.mjs` / `scripts/lib/ztools-settings-resource-budget.test.mjs` / `scripts/lib/ztools-settings-current-build-inputs.test.mjs`（39/39 pass）端到端验证了原 Main 菜单（`more -> add-global-shortcut`）触发新开（cold-start `initialNotice`）与已打开（warm-session `pendingShortcutTarget` push notice）Settings Child 切换 `shortcuts` tab、打开 `ShortcutEditor.vue` 预填 `application:<DisplayName>` 并保留权威 `appTarget`、实际 App 选择器同名应用路径消歧（`/Applications/Same.app` vs `/Users/harris/Applications/Same.app`）及创建/编辑 CAS mutation 完整贯通。

### Rust 运行历史（每轮独立，不合并计数）

- **attempt-1 RED：** app_global_shortcuts 编译在测试前因 hotkey/shutdown_owners.rs:15 的 E0599 退出 101，0 tests。[报告与 stderr](../../../output/renderer-main-frontier-r80-2026-11-02/recording-verification/attempt-1/summary.md)
- **attempt-2：** app_global_shortcuts 33 passed；hotkey:: 101 passed；general_settings_runtime::app_shortcuts 6 passed；renderer_settings_view 226 passed、1 ignored、1,713 filtered。四 filter 分别 exit 0；ignored 项 current_strict_distribution_loads_in_the_native_bundle_reader 因需显式构建 pinned Settings distribution。之后默认 workspace check 有 3 个 getter E0599、exit 101。[完整结果](../../../output/renderer-main-frontier-r80-2026-11-02/recording-verification/attempt-2/summary.md)
- **attempt-3 当前：** app_global_shortcuts 33 passed、0 failed、0 ignored、1,907 filtered；默认 cargo check --workspace --locked --offline -j 2 exit 0，350 个 atools warnings 和 4 个 atools-plugin warnings。没有重跑 attempt-2 其余三个 filter。[完整结果与快照](../../../output/renderer-main-frontier-r80-2026-11-02/recording-verification/attempt-3/summary.md)
- **影响职责补漏回归（单独计数）：** window::main_child_layout 8/8、general_settings_runtime::coordinator 5/5，各自 exit 0、0 ignored；前者覆盖真实 visible/hide 逻辑，后者覆盖 lease 读写拒绝、owner lease 生命周期、32-entry admission 上限、caller cancellation/drain 和 queued read commit visibility。它们不是 attempt-3 app filter 的扩展计数。[测试路径、名称及快照](../../../output/renderer-main-frontier-r80-2026-11-02/recording-verification/affected-regressions/summary.md) · [layout stdout](../../../output/renderer-main-frontier-r80-2026-11-02/recording-verification/affected-regressions/01-window-main-child-layout/stdout.log) · [coordinator stdout](../../../output/renderer-main-frontier-r80-2026-11-02/recording-verification/affected-regressions/02-general-settings-coordinator/stdout.log)
- 每轮 Cargo 命令前后 2,383 项 Rust/Cargo/build/native-resource 输入哈希与 200 个相关 Rust 文件行数一致。新增相关模块不超过 500 行；旧 src-tauri/src/commands.rs 保留 11,989 行，只有 activate_feature wrapper 被提取并 re-export；不声称所有 scope 文件都不超过 500 行。

### 未验收与下一步

- 录制期间 Native 抢占/抑制/held drain 的源码实现和相关 Rust/SFC 定向测试已通过；真实 OS 键盘、SDK callback 与 Native App 生命周期仍未验收。
- Main→Settings/Shortcuts Child 实际联跑、真实 WebView notice 消费、OS register/fire/update/delete/restore/drain、TaskRun Deny、物理输入、跨平台和完整 UI 均未验。
- 当前正式四树仍为 R79；R80 source-bound formal build 与资源预算未做，旧 binary 不能代替。下一项是四树 source binding/build budget 与 fresh Native 纵向验收。Harris 插件后置、Node on-demand、默认 Svelte fallback 不变。

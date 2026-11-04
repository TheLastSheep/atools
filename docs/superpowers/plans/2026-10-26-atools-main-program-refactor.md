# ATools 主程序重构阶段计划

本阶段按用户最新指示优先推进主程序，插件接入、原版插件验收和兼容层扩展暂缓。继续保留 Tauri WebView、Rust 核心及按需 Node 架构；不据此启动运行时替换。

工作区：`/Users/harris/Desktop/atools`。开发分支：`codex/atools-ztools-parity`。保留已有未提交改动；本阶段没有提交或推送授权。

## 已完成批次：普通搜索生命周期

状态：实现完成，主 Agent 独立完成相关回归及浏览器验收；证据以当前 [验收记录](../../../output/main-shell-refactor-2026-10-26/verification.md) 为准。此状态不代表整个主程序重构或 ZTools UI 对齐完成。

问题：普通搜索缺少统一的隐藏、恢复和销毁边界。隐藏前的 debounce 或迟到来源、图标回复可能继续改界面、触发窗口尺寸调整；恢复查询与重试结果保留也存在交叉影响。

职责边界：

- `launcherSearchController` 负责普通搜索的请求代次、debounce、可见性、恢复及销毁。以 `state.query` 为唯一当前查询来源。
- Content Intake 只转发文档可见性，保留已有媒体清理行为。
- Controller Host 负责装配；Window Runtime Host 与 Runtime Lifecycle 负责所有退出路径释放搜索会话。
- 插件运行时、MainPush 候选检索、Rust 搜索实现和系统剪贴板均不在本批改动范围。

验收行为：

1. 隐藏时取消尚未派发的普通搜索，结清等待 debounce 的调用者；迟到来源和图标回复不能写回界面。
2. 恢复普通首页非空查询时仅刷新一次；同查询保留用户选中项，查询变化时立即投影新本地结果。
3. 清空查询、设置页、插件页、固定文本和媒体上下文不恢复普通搜索。
4. `partial`/`error` 后隐藏换查询再离线恢复，不能保留旧查询的结果；显式同查询重试仍保留旧结果直到回复。
5. 销毁幂等，旧实例的回复不能影响重新挂载后的窗口。

实施由 Luna Worker 承担，主 Agent 负责接口、关键 diff 审查、缺陷复核及独立验收。定向用例、真实 App 集成、私有 Chromium 标签可见性及首屏预算各自记录证据。

## 已完成批次：设置读取生命周期与保存事务

状态：基础职责迁出并完成主 Agent 独立验收。证据见 [设置会话验收](../../../output/settings-session-refactor-2026-10-26/verification.md)。本批没有修改 8,622 行的 `SettingsPanel.svelte`。

- `SettingsEditingGate` 从 159 行减为 95 行，只处理显示与挂载；读取代次、超时、取消、重试及租约释放由纯 TypeScript 生命周期模块拥有。
- 原生保存事务从 `settings.ts` 迁出，前向与补偿共用同一份六项命令定义；修复部分保存失败漏回滚应用快捷键的问题。原有对外入口保持兼容。
- 真实设置表单回归覆盖快捷键和主题合并编辑、失败恢复、后续保存及卸载不重复写入。
- 主 Agent 独立验收为 11 个测试文件、76 项通过，三份设置脚本通过，类型检查 0/0，私有浏览器 14 项通过。首屏脚本为 467,480 / 573,440 字节。

## 已完成批次：设置页面与编辑状态迁移（含 AgentPanel / PasteboardShelf 拆解收敛）

状态：实施完成。现有读取门禁与原生事务已独立；页面共享的草稿、revision、debounce、失败恢复及卸载 flush 已收口至 `settingsPanelState.svelte.ts` 及各领域控制器（`settingsPanelEntriesController.ts`、`settingsPanelLocalLaunchController.ts`、`settingsPanelAiController.ts`、`settingsPanelDataDebugController.ts`、`settingsPanelMcpAboutController.ts`、`settingsPanelWebdavController.ts`、`settingsPanelWebdavViewController.ts`、`settingsPanelViewModels.ts`），原 `SettingsSaveCoordinator` 和 `SettingsSaveDebouncer` 继续复用，不另造一条保存通道。

页面迁移完整保留了当前跨路由草稿和状态语义、插件市场首次访问后的保活、快捷键与所有指令共享的别名，以及 MCP/HTTP/调试/关于共享状态：
- `src/components/SettingsPanel.svelte` 已从 8,639 行收敛为 **417 行**的路由与协调壳，子页面拆分为 10 个 ≤ 500 行的独立组件（`SettingsGeneralAppearanceSection.svelte`、`SettingsGeneralBehaviorSection.svelte`、`SettingsShortcutsSection.svelte`、`SettingsProvidersAiSection.svelte`、`SettingsMcpSection.svelte`、`SettingsWebLocalSection.svelte`、`SettingsCommandsSection.svelte`、`SettingsDataSection.svelte`、`SettingsSyncSection.svelte`、`SettingsDebugHttpAboutSection.svelte`）及 6 个 ≤ 500 行的配套样式文件（`SettingsPanelBase.css`、`SettingsPanelControls.css`、`SettingsPanelOverview.css`、`SettingsPanelDomainCards.css`、`SettingsPanelCommandCenter.css`、`SettingsPanelResponsive.css`）。
- `src/components/AgentPanel.svelte` 已从 3,099 行收敛为 **398 行**，拆分为 `AgentMcpPermissionSection.svelte`、`AgentCapabilitySkillMemorySection.svelte`、`AgentResultCenterSection.svelte`、`AgentAuditReplaySection.svelte`、`src/lib/agentPanelHelpers.ts` 及 `AgentPanel.css` / `AgentPanelTaskRun.css` / `AgentPanelAudit.css`（全部 ≤ 500 行）。
- `src/components/PasteboardShelf.svelte` 已从 607 行收敛为 **471 行**，拆分为 `PasteboardPinboardNav.svelte` 与 `PasteboardShelf.css`（全部 ≤ 500 行）。
- 所有新增与变更代码文件均不超过 500 行，通过 `npm run check`（0 errors, 0 warnings）及设置/插件市场组件回归测试（22 个测试文件、194 项全部通过）。

## 持续验收边界

- 私有浏览器使用真实主 App 与受控 IPC，不能替代 Tauri WebView、Rust 后端或操作系统能力验收。
- 原生窗口是否稳定发送可见性事件仍待验证；此前暂缓的原生 GUI 验收不在本批恢复。
- 已发送的 Tauri 搜索没有在本批增加后端取消协议；本批阻止继续派发与接纳过期结果。
- 普通搜索可见性不等于所有插件或后台通信暂停。
- 首屏脚本预算继续为 573,440 字节；CPU、内存、真实唤醒延迟须另以实测认定。
- 插件恢复推进之前，由当前用户方向决定优先级；不在主程序重构过程中顺带扩展插件范围。

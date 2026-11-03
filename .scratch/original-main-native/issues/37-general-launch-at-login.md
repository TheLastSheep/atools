# 37：原版 General 开机启动与 OS 状态

**Status:** verified-scoped — 本机macOS27.0的hidden原General/现代登录项完整切片通过；其它平台/旧配置、可见与重新登录启动仍开放。主程序优先，不扩大插件范围。

仓库/工作区 `/Users/harris/Desktop/atools`；开发分支 `codex/atools-ztools-parity`。上游固定 `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。主 Agent 定义接口、复核与验收，Luna 分模块实施；不提交或推送。

## 原版行为与当前差异

- 原 General `handleLaunchAtLoginChange` 调 `internal.setLaunchAtLogin(bool)`；失败反转复选框。初始化以 `getLaunchAtLogin()` 读 OS 状态，并非仅读 General 数据库布尔值。源码为上游 `internal-plugins/setting/src/views/GeneralSetting/GeneralSetting.vue:1043,1265`；底层 `src/main/api/renderer/settings.ts:348`。
- ATools 原 Child facade 只有 getter，尚无 setter。既有 General coordinator 已有 LaunchAtLogin 系统效果及失败补偿，不能另建并行写入通路。
- 旧 macOS setter 在 `commands.rs` 内写固定 LaunchAgent，getter只校验文件与exe。R49已提取为共享模块；旧无AppHandle setter保留薄包装，持有AppHandle的实际设置入口使用同一个app-aware backend。
- 非 macOS setter的无操作成功已改为明确unsupported；当前真实验证目标为macOS13+公开SMAppService。其它平台与旧macOS继续保持未完成，不能据此关闭完整目标。

## 实施边界

1. 使用 `general_settings_runtime/login_items` 管理状态、事务、归属和平台adapter；新模块不超过500行，原超大commands只作提取/薄包装。Child不得传任意label、路径或命令。系统`launchctl print`手册说明其输出不是API，旧SMJob字典也已弃用且不稳定，因此不以文本解析实现真值查询。
2. macOS13+使用公开 `SMAppService.mainAppService`：真实Enabled才确认on，NotRegistered与NotFound表示当前未启用；未识别enum/接口错误仍不可用，RequiresApproval保留明确错误。新应用真实观测到NotFound→register成功/Enabled→unregister成功/NotRegistered，见本批独立只含固定状态的诊断。所有读写/补偿及隔离proof清理共用同一operation锁；cleanup只接受实际注销后原始NotRegistered，不能以Boolean缓存代替。
3. 原 Child 增加窄 setter，保留原 Vue/CSS 与原有失败回滚语义。遵守当前 session/权限和串行设置写入边界；现有 Svelte 与 General coordinator 调用方一并收敛。
4. 保持普通登录启动的隐藏行为，不增加常驻进程、命令行查询或轮询。设置包经正式测量/有限去重后明确追加4KiB资源预算，Main预算不变，详情见 `docs/contracts/ztools-launch-at-login-budget-2026-10-29.md`；不静默关闭门禁。
5. 现有产品LaunchAgent存在时保护原文件并明确拒绝自动重复注册；旧配置迁移/关闭另按ticket38完成，作为默认入口切换前的必要工作，不能把未迁移状态算作完整兼容。

## 独立验收

- Rust：真实文件边界、符号链接/超限/未知状态拒绝、注册失败及补偿失败、非支持平台的失败语义，现有协调器回归。
- macOS：只对当前临时独立bundle/runId的mainAppService做真实注册/状态读回/注销；不写临时假plist、不解析launchctl输出、不读写产品现有启动项。已启动阻塞调用须实际结束，注销后独立读回关闭，未确认则保留自有root与bundle。错误流程与安全回收分别判定。
- 原页面：实际复选框保存、OS 查询读回、重开、失败回滚；同值、迟到 session 与退出资源回收。程序化 DOM 输入与可见/物理交互分别记录。
- Main 负责类型/相关集成、workspace、来源绑定和实际原生验收；自测或模块存在不等于通过。跨平台未实现保持显式 unsupported，整体目标继续开放。

首轮run `df7ae721b5174226b53edef9431da3b4`的原12阶段通过，新增系统状态未确认，Node整体保持失败并保留资源。独立公开API诊断完成注册/注销并确认NotRegistered后，已另外记录owned回收；原失败报告不改写。证据目录 `output/renderer-launch-at-login-2026-10-29/`。

最终run `1fa005452b70485c9916c412e20974b6`（PID1507）自然exit0，原12阶段及六必需侧报全通过：原checkbox启用/OStrue、fresh Child true、真实外部关闭、原checkbox冲突回滚/getter拒绝、fresh Child false、精确注销与全部owned回收。Main独立复算、另一Luna只读复核通过。最终1342输入/二进制/收据1793243208303稳定；完整证据见 `output/renderer-launch-at-login-2026-10-29/verification.md/json`。第二次控件mount竞态失败仍保留，没有当成成功。

# 18: Paste 原生子窗口创建偏好

Status: in-progress。上一目标轮完成 Format Converter 原版小文本 UI 与失败恢复的真实 Node 证据，属于 progress。本轮修复已复现的生产选项缺口；原生 App/GUI、AppleScript、OS clipboard 和全局钩子继续暂缓，不缩减上位 ZTools 能力目标。

2026-10-24：本票生产修复及独立源码/编译验收完成。14 文件 83 项前端与 21 项相关 Rust 通过，类型/生产构建/启动体积预算/离线工作区检查通过；独立 reviewer 未发现范围内具体缺陷。3 个原包证据 SHA 未变，21 本票代码文件最大 500 行。真实窗口后台计时和完整 Paste 业务仍待验，因此本票保持 in-progress。详见 [验收记录](../../../output/native-window-preferences/verification.md)。

## 已复现的问题

Harris Paste 1.3.1 的 shelf/panel 原 builder 同时传入 `webPreferences.preload`、`nodeIntegration:false`、`contextIsolation:false`、`backgroundThrottling:false`。当前 native mapper 只允许 preload，因此会在 Rust 创建之前拒绝整项请求。主 Agent 直接运行生产 mapper 复现，保存 `output/native-window-preferences/before-options-main.json`；错误为 `only webPreferences.preload is supported`。

此外，native 的运行时 setBackgroundThrottling 当前仅更新 JS metadata，Wry 没有对应动态 setter；不能把 getter 值变化当作底层策略已生效。

## 接口与行为

- 只新增识别原包实际需要的上述 WebPreferences。两个隔离相关字段只接受 false，作为兼容提示消费，不改变 opaque iframe、CSP、Tauri 暴露或 Node 权限。true、非布尔、未知字段仍拒绝。
- 仅 backgroundThrottling 布尔值正规化为顶层 Rust 字段；raw WebPreferences 不进入 WindowSpec，preload 仍走现有路径。
- 默认/true 保持默认策略；显式 false 仅在受支持的 macOS 14+ 插件子窗口 builder 上配置 Disabled。主窗口、其它窗口及全局设置不改；不支持平台、版本未知时明确 unsupported。
- 版本探测使用有界、缓存的系统只读信息，不启动 OS 子进程。平台拒绝发生在 manager reservation 前，保持原权限/TaskRun/owner 生命周期和窗口额度。
- 原生父 handle 与子页面 self getter 均读回已接受的构造值（构造配置，不是 OS 观测快照）；导航/重载保持一致。该字段不得塞入 geometry 快照。
- native runtime setter 在序列化桥和 host state 双层明确不支持，不能乐观更新状态、发送多余 IPC 或假报成功。legacy/hosted 行为不在本票改。

本票不映射主窗口多个 iframe 的逐插件 backgroundRunning，不能靠全局关节流模拟它；不重建窗口实现 setter，不新增 Node 进程/轮询/依赖，不改原包。

## 归属与验证

- node_close_finish：Rust WindowSpec、平台策略、子窗口 builder 与相关定向测试。
- paste_startup_coverage：TS mapper、构造 state、native setter 边界、子页面配置透传与相关合同回归。
- 主 Agent：接口边界、关键 diff、独立定向测试、类型/构建/工作区检查及证据；独立 reviewer 复核来源与资源边界。

先通过实际原 Paste builder 验证 mapper，再检查 controller 发出的 Rust 参数和生产 compiler/self getter。Rust 覆盖默认值、类型、平台版本与 reservation 前拒绝；检查现有 Snipaste 窗口、权限、文档和生命周期回归。使用产品 Node 22.23.3；Cargo 使用 locked/offline、jobs=2/incremental=0，不跑包含 Finder AppleScript 的完整 hostlib。

真实 WebView 的隐藏计时、窗口打开/关闭和整应用资源仍需后续原生验收。本票合同/编译通过不表示 Paste 原生窗口业务已完成。

# TypeScript 插件构建与生产包进展（2026-10-20）

## 本轮结果

生产 Node-bearing unsigned arm64 `.app` 在 source freeze v27 上实测为 **193,562,413 bytes（184.5955 MiB）**，超过 100 MiB 原始包体预算 88,704,813 bytes。构成包括 Node 112,925,600 bytes、ATools 原生可执行文件 25,026,160 bytes，以及除 `Info.plist` 外的资源 55,609,439 bytes。Node 单体已超过 100 MiB；本轮没有交付资源裁剪或压缩后的 Node，包体预算仍失败。此测量不包含应用启动、签名、公证或 DMG 验收。

本轮软件检查通过：UI 定向交互 118 项、10 个文件；Svelte 检查 0 错误/0 警告；初始 JS 371,292/573,440 bytes（相较前次增加 162 bytes）。插件回归为 215 项通过；该套件源冻结为 v26，之后相关变更仅为 `cfg(test)` adapter，当前 source-build 单元 71 项及 pipeline contract 5 项也通过。

新增的真实本地 TypeScript 5.9.3 + Vite 5.4.21 合成项目流程通过 native 验收 24 项：成功转换生成 4 个输出条目、共 1,157 bytes；类型错误负例以 runner exit 2 失败且没有构建输出，旧安装保留。另覆盖拒绝、取消、TaskRun 终态及清理。4 次转换运行中成功 1 次、失败 1 次、取消 2 次，另有 1 次基线导入成功；合计 5 条 TaskRun 均终态。该结果验证生产构建管线对一个合成项目执行本地工具，不证明任何原始社区插件的业务可用性。

另外，本轮 UI 行为调整让空搜索/空 Home 结果时 Tab 与 Shift+Tab 不再被拦截，并移除了无效的切换提示；118 项 UI 检查覆盖程序化事件与组件归属，默认物理焦点顺序仍未测量。构建入口现在对受支持配置使用锁定的本地 TypeScript/Vue 工具链做 Vite 前类型检查；不支持的配置会给出中文恢复指引，要求先在插件侧构建再导入，不跳过类型检查。

## 已知边界

固定 Git HEAD 的兼容性检查含 153 个顶层插件目录；静态分类与资源就绪度不能替代插件实际运行。30 个 TypeScript/Vite 候选中，静态锁元数据匹配，但检查时 30 个都没有插件本地 `node_modules`，所以不能将它们计为已构建或可导入。代表性真实插件的原始业务行为、物理键盘与焦点体验、整应用 CPU/RSS、发布签名/公证及 DMG 尚未由上述 TypeScript 合成验收证明。

历史负例继续保留，不作为当前状态：较早 UI 检查为 115 通过/3 失败，后续受控检查为 118 通过；早期 native TypeScript 协议版本失败；某次 pipeline 测试编译失败。当前检查不能追认这些旧记录为通过，也不能将旧失败误记为当前失败。

## 证据

- [本轮证据索引](../../../output/plugin-input-2026-10-20/batch230-root-evidence-v1/manifest-v1.json)（34 个归档载荷，1,940,496 bytes；非源码闭包）
- [Root v31 验收检查点](../../../output/plugin-input-2026-10-20/batch230-root-evidence-v1/reports/root-checkpoint-v31.json)
- [生产 app v27 尺寸报告](../../../output/plugin-input-2026-10-20/batch230-root-evidence-v1/reports/production-app-v27.json)
- [Native TypeScript v2 报告](../../../output/plugin-input-2026-10-20/batch230-root-evidence-v1/reports/typescript-native-v2.json)
- [固定 HEAD TypeScript 候选依赖审计](../../../output/plugin-input-2026-10-20/batch230-root-evidence-v1/audits/dependency-gap.json)
- [资源体积审计](../../../output/plugin-input-2026-10-20/batch230-root-evidence-v1/audits/resource-size.json)

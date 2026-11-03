# B45 Node 启动诊断与原生编辑器 activation 进展

状态：本文件记录 B45 实施与验证范围，最终 root 验收状态以交付清单为准；真实原生工作流仍未通过。B45 目标仍 active；本批没有增加一个通过固定原生编辑器输入验收的工作流。

## 本批交付内容

B45 为原有 Node sidecar 启动阶段增加了有界、默认关闭的诊断：复用生产 Node resolver 和同一个 sidecar child，记录 resolve、spawn/running、initialize 写入、首个 stdout 与匹配 response 等阶段；诊断限事件数/总字节，stderr 仅保留有界计数和摘要，不记录 raw stderr、环境值、路径、argv 或协议内容。仅 native fixture 的显式授权分支开启诊断；现有 1500 ms deadline 保持原值，permission 与严格输入门禁未放宽。

诊断校验现识别 Core 既有的 `run-<uuid>` ID 格式。fixture success/failure snapshots 必须与相同数据库 TaskRun、owner、plugin 及 `errorObservation` 关联；原始 appRunId 仍为裸 UUID。主 agent 记录的失败/成功例均以数据库 ID 验证关联。activation helper 在唯一请求前后采固定状态，并把 `activateWithOptions(empty())` BOOL 视为 requestSent；false 仅在 post-state 每个前台条件都真实满足时通过。`show → activate → set_focus` 调用顺序未变。该修改不证明编辑器可输入。

归档源以 root freeze-v2 为准：相对 B44 的 1552 个 selected sources 增至 1561 个（新增 9 个显式输入），本批 29 个 owned files 为 20 个修改、9 个新增，post-run source drift 0。selected sources 是显式证据输入清单，不是完整 compiler/dependency closure；归档只复制 29 个 owned 当前源及明确列出的证据。B44 baseline HEAD 为 `c34789c0e3d19b3bf7c05d396540d891ff126abc`；当前 HEAD 仍为该值。B44 fidelity 仍有一处已知偏差：`src-tauri/src/legacy_runtime/local_package_verification.rs` 是未计划的 formatter 字节变化，未恢复；当前字节已纳入 freeze，不宣称 B44 fidelity 全部恢复。`src-tauri/src/agent_tools.rs` 从 2996 行降到 2910 行，仍超过 500 行；不可宣称所有 owned 文件或整个仓库均低于 500 行。其它 owned Rust 文件最高 493 行。

## 验证与实际观察

- Root targeted frozen tests：activation 15/15；host startup typed 2/2；TaskRun fixture 4/4；TaskRun observation 3/3。workspace check exit 0，source-binding 2/2。
- Plugin 默认全套为 138 passed / 0 failed。
- 原始 native-smoke 全套重复两次，均 147 passed / 1 failed，且各自在最后两个测试前停止；不可用私有副本的绿灯替代原 suite 结果。
- Controlled fake-Node driver 为 10/10，但仅证明私有启动阶段负/正用例，不等同真实插件业务验收。性能 matcher 1200 features 观测最高 0.890625 ms，预算 25 ms。前端没有新 build，复用了 B44 的生产 initial JS 365,513 bytes 结果，未把它作为 B45 新构建结果。原生测试面板 JS 为 1,889,780 bytes，是测试夹具 bundle；与生产 initial JS 字节预算分开。

同 source、同 native executable、同 panel JS、同 package digest、同 pinned Node runtime 的 direct/LaunchServices 原生对照均失败，均未发送固定输入（actions=0、TIS writes=0）：

| 模式 / app runId | 原生检查 | 观察到的结果 | TaskRun / cleanup |
| --- | ---: | --- | --- |
| direct / `c7cffd5e-3403-4e75-a634-cbb3ee50267e` | 35 | Node 初始化成功，诊断耗时 69 ms；但 activation 返回 false，前台 app/frontmost/mainKey/occlusion 均 false。 | 23 条 TaskRun 全成功；有界 ID snapshot 21 条。Node success 与 `run-7864c317-1d9c-4ba9-a088-976e9ac68060` 关联已验证。owned PID 均通过 ESRCH 确认不存在，未发送信号。 |
| LaunchServices / `e19aca97-ab49-4b21-b781-19b445f12073` | 23 | Node 在 3 ms spawn、3 ms 写入 59 bytes initialize 请求；1506 ms 后没有匹配 initialize response，stderr 0，`node_version=null`。记录了 typed failure 与 `errorObservation`，真实 TaskRun `run-d22edad2-9b27-4037-9d3f-94b83ec07e1b` 关联已验证。对照使用同一已校验的 pinned Node binary/runtime 描述 22.23.3；这不证明 LaunchServices target 实际回报该版本。 | 7 条 TaskRun：6 成功、1 失败。inner cleanup、TaskRun terminal 与 runtime drain 通过；outer `cleanupScope` aggregate 的 `passed` 仍为 false，因为 native run 未通过。已知 wrapper/observer/target/Node PID 由 `kill(pid, 0)` ESRCH 确认不存在，未发信号；目标 OS exit code 未知，不能填成 0。 |

两次 app 的 TaskRuns 均 terminal、inner cleanup/drain 完成，输入源前后记录相同；LaunchServices outer cleanupScope aggregate 仍未通过。无固定输入，也没有 JSON editor run。LaunchServices 延迟尚无因果结论：缺少 first stdout/response 不能证明 target 未执行；目标 OS exit code unknown。任意未观测 detached descendants 的覆盖仍为 unknown，不能宣称通用全子进程证明。LaunchServices wrapper 收尾中的 `Node.js 24.15.0` 是控制脚本 host，不是 sidecar pinned Node runtime。B45 原生新增 workflow acceptance 为 0，majority direct-plugin acceptance=false，formal acceptance=false。B45 中直接跑的失败事实不得以 v1 旧 run、私有 helper exit 0 或 root source-only 检查改写。

## 未完成与 B46 候选

activation 独立源审查没有 P1/P2，但真实激活/编辑器输入焦点仍需 root 原生复验；每次 foreground 调用增加两次固定同步快照，其真实延迟没有测量。Node 的 LaunchServices initialize timeout 未解释，1500 ms deadline 未放宽。原始 native-smoke suite 的 1 个失败与末尾 2 个未执行测试仍未解决。

B46 只读审计候选：

1. 插件 HTML/preload/panel resource load 失败后，面板只有 alert，没有原位“重试加载”；建议用户显式点击时重试一次，先关闭旧 session，并以 generation 防止晚到结果覆盖。应由独立的 load controller 承担生命周期，不继续堆进 8k 行 `PluginPanel.svelte`；无自动重试/轮询/搜索开销。
2. 多功能插件列表“打开”默认进入 manifest 首个 feature。已有测试保留该兼容行为，不可直接移除；产品可考虑增加“选择功能”入口复用详情页的精确 feature-code 按钮。

两项均为候选，不属于 B45 已实施范围；完整只读依据随归档的 `b46/findings.md` 保存。

## 归档与交付状态

`output/plugin-input-2026-10-19/batch45-evidence-v1/` 收纳 owned frozen source、可用 before snapshots、root proofs/logs、direct/LaunchServices v1/v2 的结果/输入源/编排/日志、controlled fake-Node driver 与有界 sidecar observer 代码及报告。不会复制 Node/app binaries、编译 target 或大型 session logs。归档逐文件含相对路径、字节数、完整 SHA-256 和聚合大小；封顶 15 MB / 350 files。`before/` 按 B44 已验证基线与 B45 不同阶段的中间快照分别标注，不能把后者当作统一 B44 基线。具体 provenance note、manifest 与 delivery candidate 由 `batch45-delivery-v1.json` 引用。

本文件绑定 source freeze、测试报告及失败的原生观察；最终验收状态以交付清单为准。未进行 Git add/commit/push。`gitMutationsPerformed=false`。

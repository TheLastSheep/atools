# ATools 北极星交付审计

> 基线：`docs/superpowers/specs/2026-07-14-atools-product-engineering-north-star.md`  
> 审计日期：2026-07-14  
> 口径：只有源码、自动化测试、真实桌面 smoke、发布产物或受控实测能够证明的项目才记为完成。

## 状态定义

- **已证明**：实现存在，且有与要求范围匹配的自动化或真实运行证据。
- **验证中**：实现已提交，完整远程 CI 尚未结束。
- **部分完成**：存在可用实现，但没有覆盖北极星要求的完整入口、生命周期或证据范围。
- **外部阻塞**：代码已准备，仍依赖仓库所有者或外部账户材料。
- **未完成**：当前没有足够实现或证据。

## 当前发布硬门槛

| 要求 | 状态 | 权威证据 | 剩余工作 |
| --- | --- | --- | --- |
| 正式签名、公证与 Gatekeeper | 外部阻塞 | `.github/workflows/publish-macos.yml` 包含双架构签名、公证、stapling、Gatekeeper 和发布前验证；2026-07-14 只读检查确认仓库和 Environment 当前均没有 Actions Secrets | 配置 Tauri 更新私钥及 Apple Developer 证书/公证 9 项 Secrets；成功跑完 `v3.0.0` 发布流水线 |
| 自动更新 | 部分完成 | `src-tauri/src/updater.rs`、`src/lib/appUpdater.ts`、`scripts/verify-github-release-updater.mjs` 和发布工作流 | 必须由首个正式 Release 的 `latest.json`、签名和双架构资产完成端到端证明 |
| 插件安装/更新/卸载事务与恢复 | 已证明 | `replace_plugin_directory_transactionally`、`uninstall_plugin_files_transactionally`；Rust 回归覆盖失败恢复 | 保持发布回归 |
| symlink、ZIP 配额、并发、可信市场 | 已证明 | `src-tauri/src/commands.rs` 中 symlink 拒绝、ZIP entry/size/depth 配额、mutation lock、SHA-256、Ed25519 与本地 pinned key；对应 Rust tests | 保持发布回归 |
| 快捷键、托盘、开机启动 | 已证明 | `src-tauri/src/desktop_smoke.rs` 的真实 macOS `system_settings_smoke`；CI `pnpm test:desktop` | 正式签名包仍需在发布流水线再次 smoke |
| 前端/Tauri/Cargo 版本统一 | 已证明 | `package.json`、`src-tauri/tauri.conf.json`、workspace `Cargo.toml` 均为 `3.0.0`；`validate-release-tag.mjs` | 发布 tag 必须为 `v3.0.0` |

## 产品边界与双入口

| 要求 | 状态 | 权威证据 | 缺口 |
| --- | --- | --- | --- |
| 本地优先、无模型可用 | 已证明 | 搜索、插件、剪贴板、文件、设置与 MCP 核心均不要求模型；`ask_ai_model` 是独立可选工具 | 后续功能继续禁止引入强制远程依赖 |
| MCP HTTP/stdio、模型无关 | 已证明 | `src-tauri/src/mcp_server.rs`、`crates/atools-core/src/mcp.rs`、`docs/agent-mcp-client.md`；桌面 MCP smoke | 保持协议兼容 |
| 人与 Agent 共用 TaskRun | 部分完成 | MCP/Agent 工具由 `call_tool_with_task_run` 统一；插件激活、网页快开、URL 快开、本地启动/应用、粘贴工具和路径文本操作均创建 human TaskRun；CI run `29338826896` 完整通过 | 纯文本复制仍是直接剪贴板动作；若持久化必须先设计正文脱敏，不能把潜在敏感文本直接写进任务历史。仅切换面板属于 UI 导航，不记作任务 |
| 统一 Capability 目录 | 部分完成 | `ToolRegistry` 已统一内置 Agent 工具和用户启用的插件 tools | 搜索 Feature、本地启动项、Skills 与 MCP Tool 仍是多个目录模型，需要稳定 `Capability` 领域契约 |
| 结构化执行优先 | 已证明 | 原生、插件、CLI/系统桥接优先；项目未内建通用 Computer Use/Browser Use 执行器 | 低优先级兜底一旦新增必须记录选择原因 |

## Phase 1：TaskRun、Artifact 与结果中心

| 要求 | 状态 | 权威证据 | 缺口 |
| --- | --- | --- | --- |
| TaskRun 模型与状态机 | 已证明 | `TaskRunStatus::can_transition_to` 与 `InvalidTaskRunTransition` 在核心层拒绝非法跳转；回归覆盖成功终态不可重开及 partial/failed 重试；CI run `29338826896` | 无 |
| MCP 结构化摘要、runId、指标和 Artifact | 已证明 | `task_run_envelope` 与 `scripts/test-task-run-contract.mjs` | 无 |
| 持久结果中心 | 已证明 | `src/components/AgentPanel.svelte` 支持历史、详情、验收、错误、指标、复制和来源 | 无 |
| 通用 Artifact 协议 | 已证明 | `ArtifactKind` 覆盖文件、目录、图片、截图、Markdown、富文本、表格、CSV、JSON、Diff、URL、报告和日志 | 大文件继续只保存受控引用 |
| 专业 Artifact 渲染器 | 已证明 | `src/lib/artifactView.ts` 与结果中心实现图片、表格/CSV、Markdown、JSON、Diff、文件/目录、URL 和安全降级；`test-artifact-view.mjs`；CI run `29336438932` 完整通过 | 无 |
| 打开、定位、复制产物 | 已证明 | 结果中心通过 `shell_open`、`shell_show_item_in_folder` 和剪贴板桥接执行；CI run `29336438932` 桌面 smoke 通过 | 无 |
| 失败重试与取消 | 部分完成 | 终态失败/部分/取消可重试；created/awaiting permission 可取消 | 同步执行中的工具无法中断；长任务异步状态查询、运行中取消和失败项粒度重试尚未完成 |
| 独立验收状态 | 已证明 | `TaskValidation` 与结果中心独立展示，不把调用成功等同目标验收 | 当前多数内置工具只有执行器级验收，仍需按 Skill/任务定义业务验收 |

## Phase 2：Skills 与执行记忆

| 要求 | 状态 | 权威证据 | 缺口 |
| --- | --- | --- | --- |
| MemoryItem 模型、作用域与持久化 | 已证明 | `crates/atools-core/src/memory.rs`、SQLite `memory_items`、`memory_tests.rs` | 无 |
| 显式/确认/临时写入，不自动永久推断 | 已证明 | `MemoryApproval`、临时过期校验及 UI 文案/写入路径 | 暂不生成自动候选，符合“从显式偏好和修正开始” |
| 敏感数据边界 | 已证明 | 核心层拒绝密码、Token、API Key、Cookie、私钥和常见凭据格式 | 独立 Secret Vault 尚未实现；当前策略是拒绝而非保存凭据引用 |
| 结构化作用域检索 | 已证明 | workspace/skill/tool/application/domain 已下推 SQLite 精确匹配，增加作用域索引与旧库回填；回归覆盖目标记忆位于 1000 条近期无关记录之后；CI run `29338826896` | 无 embedding 依赖 |
| 查看、编辑、停用、删除、导出、清空 | 已证明 | Agent 面板与 Tauri commands 完整覆盖 | 危险清空操作后续宜加入二次确认 |
| 结果页显示来源与影响 | 已证明 | TaskRun `memoryIds`、内容展示与“显式输入优先”说明 | 无 |
| 成功任务保存为配方 | 已证明 | 结果中心显式“保存为配方”，保存 `sourceRunId` 并复用敏感内容检查 | 无 |
| Skill 声明契约 | 已证明 | `SkillDefinition` 声明触发、能力依赖、步骤、权限、失败恢复、验收和结果建议；SQLite、管理 UI、`atools://skills` resource/template 与 `atools_skill_<id>` prompt；CI run `29338826896` 完整通过 | 无 |

## 性能与质量证据

| 必测项 | 状态 | 当前证据/缺口 |
| --- | --- | --- |
| 10k/100k 搜索 P50/P95/P99 | 已证明 | `benchmark-search-index.mjs`、JSON artifact、80ms 100k P99 CI 硬门槛 |
| 安装包体积 | 未完成 | 发布工作流会生成 app/dmg，但尚无可比较的结构化基准和回退门槛 |
| 冷启动到可交互 | 未完成 | desktop smoke 证明能启动，但没有首帧时间采样 |
| 热键到首帧 | 未完成 | smoke 证明热键注册/替换，未测按键到 UI 首帧 |
| 空闲 RSS/CPU | 未完成 | 无稳定采样报告 |
| 轻/重插件内存增量 | 未完成 | 无稳定采样报告 |
| 插件冷启动 | 未完成 | smoke 证明激活与渲染，未记录分位数 |
| 多次唤起与长时间稳定性 | 未完成 | 无持续时间、RSS/CPU 漂移报告 |
| TaskRun/Memory 数据库增长 | 已证明 | CI run `29338826896`：100k 下 TaskRun 列表 P99 2.476ms、单条读取 0.013ms、Memory 列表 1.563ms、作用域检索 31.459ms，均低于 80ms 门槛；JSON artifact 保留 30 天 | 共享 runner 只证明项目回退上限，不替代同机竞品对比 |
| 与 uTools/ZTools 同机对比 | 未完成 | `docs/performance-benchmark.md` 已定义方法，但尚无同机受控数据；不得宣传竞品优势 |

## Phase 3 与长期路线

Phase 3 是北极星中的后续能力生态，不应冒充 3.0.0 已交付项：

- 插件开发 CLI、模板和类型定义仍需统一收口。
- 插件、无界面 Tool、Skill 与结果渲染器尚无统一分发包格式。
- 市场已有签名与权限基础，但平台级发布者身份、撤销和自动兼容矩阵仍不完整。
- Windows 扩展应由真实需求驱动，不得削弱当前 macOS 发布安全。

## 下一步顺序

1. 在远程 macOS runner 建立安装包、冷启动、插件激活和 RSS/CPU 证据；热键首帧需要真实 UI 探针。
2. 建立稳定 `Capability` 领域契约，收敛搜索 Feature、本地启动项、Skills 与 MCP Tool 的目录分裂。
3. 为纯文本复制设计不落敏感正文的 TaskRun/审计合同。
4. 配置签名/公证 Secrets，创建 `v3.0.0`，让发布工作流完成双架构、Gatekeeper、stapling、更新清单和正式 Release 提升。

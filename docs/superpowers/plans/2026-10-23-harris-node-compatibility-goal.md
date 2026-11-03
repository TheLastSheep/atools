# Harris 原版插件兼容目标：按需 Node 与单切片验收

当前上位目标仍是对照 ZTools 补齐 ATools 的产品能力。本文件只约束 Harris 插件优先交付阶段，不把整体目标缩减为五个插件；其它插件与 UI 能力差距继续保留。

最近交付切片：[Paste 原始格式二进制读取与 FileHandle 收尾](../../../output/harris-plugin-first-2026-10-23/clipboard-buffer/README.md)、[Paste 原生格式检测与读取](../../../output/harris-plugin-first-2026-10-23/clipboard-formats/README.md)、[插件自动分离设置与窗口交接](../../../output/harris-plugin-first-2026-10-23/plugin-window-preferences/README.md)、[Paste 富文本写入兼容](../../../output/harris-plugin-first-2026-10-23/clipboard-html/README.md)、[图片与文件历史兼容](../../../output/harris-plugin-first-2026-10-23/clipboard-media-history/README.md)。原格式读取完成宿主/原函数合同及临时命名剪贴板检查；窗口设置完成生产组件浏览器检查。真实桌面窗口、退出与完整原包业务仍待验收，限定原生证据不替代完整业务。

**最新执行调整（2026-10-23）**：用户再次要求“先跳过这个继续”。停止[关联原生子窗口探针](../../../output/harris-plugin-first-2026-10-23/native-related-window/README.md)最终版本的原生运行与 GUI 验收，保留待确认，继续兼容层实现。此前[文件拖出切片](../../../output/harris-plugin-first-2026-10-23/file-drag/README.md)也仍暂缓、默认构建禁用，保留原生未验及启动/取消竞态。跳过不代表通过，也不暂停整个开发目标。

最近新增[子窗口回信通道分离](../../../output/harris-plugin-first-2026-10-23/frame-reply-transport/README.md)：真实 iframe WindowProxy 保持身份来源，可信壳 sender 单独承担回信与 MessagePort 发送；挂载、load、open 及 nonce 轮换显式透传，旧文档、替换和清理边界拒绝旧身份。主 Agent 独立验收13文件117项、类型检查和默认构建通过，初始静态JS430,921字节，低于573,440字节预算。原生窗口管理器和现有 Svelte 窗口层尚未使用该可选 sender，不能据此声明 Snipaste 原生窗口支持。旧隔离脚本的过期组件结构断言仍失败，日志保留，未将所有检查记为通过。

最近新增交付为 [Node 根退出后的辅助进程回收](../../../output/harris-plugin-first-2026-10-23/node-descendant-cleanup/README.md)：真实 Node 自然退出/崩溃残留辅助 PID 及并发关闭返回 `NotRunning` 均先独立复现再修复。根回收前清理已验证进程组、保留清理错误、终止等待有界、未确认 wait 不归还名额；主 Agent 独立运行 50 项不同定向测试和默认工作区编译通过。现有四槽、初始化和 payload 预算不变，无新增常驻进程。仅在当前 macOS 验证，整应用资源和五包原生 UI 仍待验。[Snipaste 独立透明置顶窗口](../../../output/harris-plugin-first-2026-10-23/native-browser-window-gap.md)已确认是后续共用宿主缺口，未将面板内 iframe 记作原生窗口支持。

前一独立切片为[小文档保存的 Promise 批量状态查询](../../../output/harris-plugin-first-2026-10-23/node-promise-polling/scope.md)：主 Agent 在未修改的 Live Markdown 0.1.0 原异步保存模块上独立测得4个不同小文档并发保存145次请求，其中36次状态查询（9轮、每轮4次）。只优化这一实测通信次数；不迁移 Rust API，不扩大任何预算，不据此声明界面或真实 IPC 变快。该合同测量可独立于已暂缓的原生 UI 推进，原生业务未验状态不变。

本切片现已完成[模块与协议交付](../../../output/harris-plugin-first-2026-10-23/node-promise-polling/README.md)：同一固定路线总请求145→118，状态查询36→9；保存字节、冲突恢复和关闭检查通过，预算与进程分派不变。主 Agent 独立验收155项前端、13项真实Node协议、105项宿主用例及类型/编译/默认构建预算；另有1项本地计算稿纸原包快照不匹配，保留失败，不记宿主整组全绿。初始JS430,921字节，完整原包UI及真实IPC延迟仍待验。

此前暂缓 Format Converter 大文件转换及 Buffer snapshot 方案，保留 512 KiB 成功、800 KiB 原 job 触发 `ERR_ATOOLS_NODE_VALUE_BUDGET` 的失败证据，不放宽预算、不记为通过。Paste 的 `clipboard.readBuffer(format)` 和 FileHandle.read 收尾已完成下述宿主及模块合同；原生 UI/完整插件验收继续单列。

该切片的宿主与原模块合同现已通过：主 Agent 独立验收204项不同前端用例、89项不同Rust用例（含1项临时命名剪贴板原生往返）；类型检查、工作区编译和默认生产构建通过。初始JS430,921字节，插件面板独占延迟加载JS682,055字节。FileHandle补齐三种读取、原view写回及方法包装缓存，避免canonical decode后无界套层。未启动App、安装引擎或替换原包；整体业务仍未完成。Image Batch结果拖拽的“暴露方法但路由固定拒绝”仅登记为后续静态缺口。

本计划根据 2026-10-23 用户确认的新阶段目标，细化并接替 [Harris 首批插件交付计划](./2026-10-22-harris-plugin-first-delivery.md) 的后续执行顺序。旧计划中的包清单和已发生证据继续有效，不为替换目标而假报旧全生态目标已完成。后续工程以本文件和有限切片为准，不依赖应用内旧目标登记状态。

## Accepted 目标

- 保留 Tauri WebView、Rust 核心和按需启动的 Node。以作者 `harris` 的五个原版发布包稳定可用为目标，Node 使用本身不算失败。
- 原包保持不变；不以下载量剔除 Harris 插件。共用宿主适配只在可复现的原包行为缺口上改进。
- 继续使用当前 Web/Rust/Node 分派：Rust 处理已有本地能力，WebView 承载原 UI，Node 运行仍需要的 CJS、npm、Node API 和原生扩展；Electron API 继续由宿主兼容桥适配，Node 本身不提供 Electron 环境。进一步迁移 Node API 前，先取得同一路线的行为基线，再用测量结果确认具体瓶颈。
- 所有需要权限的能力继续通过现有 permission gate、TaskRun 和生命周期管理；文档读写继续遵循既有文档 API / generation 边界。不得以兼容为由绕开权限、TaskRun、取消或文档绑定。
- 一次只推进一个可验收切片。冻结该切片的原包版本、固定输入、操作、运行环境和通过条件；主 agent 审关键 diff 并独立验收后，再开始下一切片。

## 固定包范围

以下五包沿用现有计划中的版本、发布入口和来源；实际运行前仍核对所选目录及其内容。外部作者仓库只读。

| 插件 | 版本 / 发布入口 | 核心验收操作 |
|---|---|---|
| Live Markdown | 0.1.0 · `live-markdown/plugin.json` → `dist/index.html` | 打开固定 Markdown、编辑、预览/源码切换、保存后关闭并重开 |
| Paste 剪切板 | 1.3.1 · `pasteboard-pro/dist/ztools/plugin.json` | 安装正确发布目录，查询固定文本/图片历史、预览、单条复制/粘贴 |
| Snipaste Pro | 2.0.1 · `snipaste/plugin.json` → `dist/index.html` | 打开工作台、标注并保存固定图片、验证贴图入口 |
| 图片批处理 | 0.1.3 · `image-batch-studio/dist/plugin.json` | 导入固定图片，完成一条缩放/转换路线并验证导出 |
| 格式转换 | 0.1.0 · `format-converter/dist/plugin.json` | 完成文本、JSON、CSV 核心转换 |

原版 UI / 操作的结果才可记为插件业务通过。静态扫描、契约桩、模块加载、Node 初始化、单项 Rust API 测试分别记录为对应层级，不能替代原包业务结果。可选 AI、Office 或图像引擎不作为所有插件的安装前提；冻结的核心路线确需引擎时，复用原包按需流程，在隔离验收环境只安装该路线的必要依赖，并单独记录安装、转换和失败恢复结果。本次目标调整不执行安装。

## 优先级与切片顺序

已拆为 [7项本地任务](../../../.scratch/2026-10-23-harris-node-compatibility-goal/issues/)。编号表示推荐执行顺序；原生业务验收依赖运行时稳定性，通信优化只需先取得一条核心路线的完整基线。未通过的依赖不会阻止只读调查或独立模块证据推进。

**本轮用户追加指令：先跳过原生 initialize 超时，继续 Harris 插件。** 暂缓该超时与外部 sampler 的进一步排查，保留已知失败及默认1500ms预算；不将它们标为通过，也不再要求先解决它们才能开发下一条 Harris 业务入口。当前切片接通 Live Markdown 固定文件到既有文件激活 gate，原包 UI 业务仍按实际证据单列。

### P0：Node 启动、取消和退出回收

先从已有 Node 启动不稳定和取消断言失败中定位一个可复现的具体生命周期故障；确认真实失效边界后再修复。现有取消测试的早期断言本身不证明产品回收失败。前序两次原生复现额度已用完；再复现前必须有新的区分性假设或候选修复，不能无条件重跑。P0 可与不依赖 GUI 的模块证据并行，独立证据不代替原生验收。覆盖成功启动、启动失败/超时、已启动进程上的用户取消或宿主关闭，以及连续打开/关闭后的进程和会话回收；记录真实子进程生命周期和对应 TaskRun 结果。不得靠重试隐藏失败。

通过条件：先前失败的具体步骤在约定环境下稳定通过；取消或关闭能结束其拥有的子进程与请求，释放占用并保留正确失败/取消结果；重复生命周期后没有本阶段创建的 Node 子进程或会话残留。只测单独 Node bootstrap 不满足此条件。

**目标调整时的源码基线与阶段预算**：当时 `Sessions::open` 由转移锁串行启动，最多登记4个会话；同一 owner、plugin、document、version、path 的运行中会话复用，不跨身份共享。该会话限制不等于 OS 进程峰值≤4，取消后异步回收尚待验证。阶段目标为 Legacy Node 兼容宿主管理的侧车根进程在 starting / running / stopping 各状态合计≤4，正常并行启动≤1；未使用 Node 的路线不启动侧车，所有本次插件关闭后所拥有的侧车归零。本轮已实现许可直到 child 回收才释放，验证结果见下方 P0 进展。引擎等辅助子进程另列数量、归属和回收结果。

**首个切片（已交付运行时部分）**：核实 UI 的 `take_intent` 会克隆并保留 map 登记，窗口关闭不会因这一步丢失 intent；真正复现并修复的是无 UI intent 的 Agent 路径在入口检查等待后漏验取消/停止。旧 abort 测试已改为真实子进程出现且 open 仍 Pending 后再取消，进程未启动的取消单独验证。现有 initialize 单阶段预算1500ms不等于整个 open 的总耗时；原生 App 的旧超时仍待定位，不能靠放宽默认预算或自动重试掩盖。

### P1：原包核心编辑和文本路线

顺序拆成两个独立切片，每个完成并审查后再开始下一个：

1. **Live Markdown**：通过完整原生宿主打开固定文件，真实编辑并切换预览/源码，保存后关闭并重开，核对字节内容和 UI 状态。现有 path/UTF-8 Rust 能力保留；不顺次迁移 metadata/exists 来追求“零 Node”。
2. **Format Converter**：在原插件 UI 完成固定文本、JSON 和 CSV 的有效输入与错误输入路线，核对输出及可恢复状态。所需 Node 模块可按需运行；不能把此前单独模块的 Markdown→HTML 结果当作其完整核心验收。

通过条件：原包不变、从 ATools 安装 / 打开，用户可完成列明操作；数据持久化和错误恢复符合预期；真实权限、IPC、WebView 与 Node/Rust 分派均来自本次验收路径。单元测试、API 契约桩、固定模块测试只能作为辅助证据。

### P2：减少 RPC 往返与阻塞

P1 路线通过后，用同一插件、同一操作和同一操作次数建立前后对照，分别记录 `get` / `call` 往返次数、请求与响应字节、同步等待/阻塞时间。只针对量测到的重复往返或大 payload 改进。

当前源码确认 Node 方法读取和调用分成 `get`、`call` 两次通信；UTF-8原生读取回退还可能增加一次尝试和首次 `require`。这是结构上的往返，不是已测出的延迟瓶颈。常规 TaskRun 可辅助按方法计数和查看耗时，但不覆盖 `poll` / `pollPromise` / `release`，也没有传输字节和 XHR 等待测量；临时计数须覆盖这些控制请求，不能以 TaskRun 数量冒充总通信次数。沿用现有测试和诊断入口，不新建观测平台。

通过条件：原包 UI、调用顺序和同步 API 可见语义保持兼容；同一操作下至少一个预先指定的往返、payload 或同步等待指标下降，且错误、权限、取消、TaskRun 与持久化行为不退化。不得随意把同步 API 改为 Promise；不得缓存有副作用或读时变化的 `get`。没有清楚的可复现改善时保留现状并记录结果，不为追求 Rust 覆盖率迁移能力。

### P3：其余 Harris 插件核心路线与失败恢复

按包逐个切片：Paste 的固定历史检索/预览/单条复制，Snipaste 的固定图片标注/保存/贴图入口，图片批处理的一条导入—转换—导出路线。每个切片还要覆盖一次可恢复失败（如无效输入、取消或缺失可选能力）并验证用户能继续或明确退出。系统截屏、独立原生窗口等边界单列验收，不由工作台可见或 API 桩代替。图像引擎按上述最小必要依赖原则准备；下载、安装或平台支持仍受阻时保留具体失败，不能把路线从完成标准中静默删除。

## 性能与资源验收

- 沿用现有门槛：初始静态 JS ≤573,440 字节、1,200 功能 matcher ≤25ms、合成本地搜索 P99 ≤80ms；这些是不同检查，不能互相代替。
- 候选版本复用现有 macOS runtime benchmark，分开记录首报告、热键、桌面搜索、插件激活和宿主 RSS。当前脚本门槛分别为5秒、500ms、150ms、1500ms、300MiB；这些是门槛，不是当前实测结果。
- 同时记录本次应用的 WebView/Node 进程树、峰值子进程数及关闭后残留。宿主 RSS 不能冒充整棵进程树内存；完整进程树 RSS、空闲 CPU、安装包及竞品同机数据缺失时保持待测，不新增未经测量的宣传数字。
- 核心包100MiB门槛与包含 Node、路线必要引擎的完整配置分开报告；固定版本、构建配置、包来源和操作后才进行前后比较。

## 不在本阶段

- 不改写五个 Harris 原包，不按下载量删减范围，也不扩展到全体 ZTools 插件。
- 不以零 Node 为目标；不因 Rust 可实现而自动替换仍稳定工作的 Node 路线。
- 不顺次迁移 metadata/exists，不将单独 Node 初始化约 30ms 解释为原生插件可用，也不将模块/契约桩通过解释为完整兼容。
- 不预先全量安装 Sharp、Office、AI 模型等可选引擎；核心路线需要的最小依赖按原包流程单独验证。不改用 Bun、不更换 TypeScript/Vite 工具链、不引入新运行时。
- 不重构 TaskRun、权限模型、文档 generation 协议或创建新的监控 / benchmark 平台。复用已有测试、原生验收入口和诊断；如需临时记录，只保存本切片必要证据。
- 不以本轮目标授权创建提交、推送、替换已安装应用或写外部仓库。

## 执行与停止条件

- Luna worker 负责独立实现且不派生子代理；主 agent 负责调用链、接口与职责划分、关键 diff 审查和最终独立验收。并行工作不得写同一文件或覆盖既有工作。
- 每个切片开工前写明一个可复现失败 / 行为、固定包和环境、拟改模块、成功与失败恢复步骤、证据位置；主 agent 再确认该切片可以验收。
- 每个切片只在其职责内修改代码。测试先跑最小相关项，再进行对应的生产构建或原生手工验收；记录未运行和失败的检查，不扩大为全仓平台任务。
- 本轮不追加无新假设的 Node 生命周期复现；若明确假设 / 修复后仍无新证据，保存失败边界，继续不依赖该阻塞的切片。模块证据可独立推进，不能冒充原生结果。
- 切片只有在原版业务路径、失败恢复、资源回收及适用的权限 / TaskRun 边界都由实际运行证据通过时才标记完成。静态检查和局部 API 证据不得升级为产品验收。
- 五包任何核心路线未验、环境缺少可选能力或退出资源状态不明时，整体目标保持未完成，并给出具体阻塞；不因单个切片完成自动宣称五包兼容。

## 现有证据边界

- 已交付的 path 与 UTF-8 Rust 基础能力继续保留；当前授权 / TaskRun 通路及同步调用契约继续作为后续集成边界。
- 原版 Live Markdown 局部文档模块与 Node 回退、Rust 文件能力和 transport 契约已有各自测试记录，但尚无本计划要求的完整原生 UI 编辑—保存—重开验收。
- 产品 Node 的独立 bootstrap 初始化测量中位数约30ms，只描述孤立 CLI 阶段；不覆盖 Tauri WebView、权限、preload、完整 RPC、插件 UI 或业务工作流。
- 前序原生 App 的 Node 初始化不稳定仍待定位；旧取消测试的采样问题与本轮运行时取消缺口已分别处理，见下方记录。文档/metadata/exists 的 Rust 单测通过仍不能代替真实 API 分派验收。

## 2026-10-23：P0 运行时切片已验收，整项仍未完成

- **已修复**：Agent 在入口检查等待期间被关闭/全局停止后仍进入 Node 准备；Node 命令队列满时 Drop 的关闭请求丢失；最后一个 opening 取消遇到 server 锁竞争时 idle listener 未关闭。UI named intent 仍被登记并可取消的对照通过，没有按此前错误的“take_intent 已移出 map”假设改动 UI 授权逻辑。
- **四槽预算**：许可从新启动前持有，移入实际 child 的 process loop，确认 wait/try_wait 退出后才归还。真实测试证明第三个已运行、第四个已创建但启动未完成时，取消第四个不会提前释放其名额；第五个被拒绝，旧 child 退出后可启动替代会话。该预算限定 Legacy Node 兼容根进程，不冒充所有工具或引擎辅助进程的总数。
- **回收与隔离**：复用身份、旧实例关闭、文档绑定、私有入口、pending run、真实 PID 消失和 listener 释放的相关用例通过。清理只在锁竞争时按需调度，无新增周期轮询；等待清理时出现的新 opening 保留其 transport。未确认 child 退出的异常路径保留已占用名额，不假报可复用；process-loop 强制 abort/panic 的异常策略未单独注入验收。
- **独立验收**：Luna worker 分别实现、交叉审查；主 agent 审关键 diff 并执行47项不同的定向测试，全部通过（50次通过执行含3项组间重复）。`cargo check --workspace --features atools/legacy-node-smoke --locked --offline` 通过，宿主库仍有107条编译警告。本切片16个代码文件均≤447行，生产 Node bootstrap 的29,000字节及 SHA256 未变；没有新增依赖、Rust 系统 API 或原包改写。
- **保留未完成项**：原生 App initialize 1500ms不稳定的旧证据未由本次运行时测试解决；Harris 完整 WebView 业务、整应用 RSS、辅助进程树和连续 UI 生命周期仍待验。没有重跑 GUI/AppleScript、安装引擎、提交/推送或替换已安装应用；任务01保持 in-progress，未解除后续原生业务验收依赖。

完整结果与原始失败日志见 [本轮 P0 记录](../../../output/harris-plugin-first-2026-10-23/p0-node-lifecycle/README.md)，固定源码与测试列表见同目录 `verification.json`。

## 2026-10-23：完整 preload 合同与一次原生失败回收

- Harris Live Markdown 原包完整 `preload/services.cjs` 已经生产 CJS 预加载器执行，真实临时文件的异步原子保存、冲突保护、恢复重开及文件入口订阅通过；固定 Node 22.23.3 独立复验新旧 7 项测试，前端检查通过。此为借用 host 的模块合同，尚非真实 transport / WebView 编辑验收。任务02改为模块工作 in-progress，完整原生业务仍依赖01。
- 一次新原生尝试在5ms写完59B请求、1507ms initialize_response 超时。对应失败 TaskRun 已终态、诊断关联验证通过，最终会话、请求、资源租约和临时 transport 归零；App/Node 两个精确 PID 均独立复核已退出。此只补足本次失败回收证据，任务01仍 in-progress。
- 外部 sampler 未发现本次 App，没有有效栈。实际 executable 路径经报告确认正确；进程名候选已补 bundle display name，但缺少本次实际 comm 记录，漏检根因仍未确认。只修诊断识别，不继续本切片的 App 重跑，不据此归因或放宽1500ms默认预算。下一项业务入口仍优先 Harris 固定 Markdown 文件路线。

见 [本切片证据](../../../output/harris-plugin-first-2026-10-23/p0-node-startup/README.md)；原生启动根因、完整成功/取消 UI 生命周期和五包业务保持待验。

## 2026-10-23：按用户指令跳过超时，接通 Harris 文件入口

原有桌面计划只能文字激活；现已支持显式固定文件，按原 manifest 选择 files feature，由前端进入既有文件激活和 owner/media gate/TaskRun 管线。原生文件数组不写入验收标记，外部样本按当前队列稳定身份分类，并用真实 Svelte `$state` 代理回归防止0/0假绿。

主 Agent 已生成 Live Markdown `typora-workbench` 单包固定文件计划，独立运行63项前端、39项Rust用例及新旧JS脚本；前端检查、工作区编译和初始JS预算通过。旧队列脚本因已拆出的App内联结构断言仍失败，日志保留。本切片不启动App、不重跑初始化故障；完整编辑保存业务、进程树和运行中性能仍待验，任务02保持in-progress。见 [文件入口证据](../../../output/harris-plugin-first-2026-10-23/live-markdown-file-entry/README.md)。


## 2026-10-23：跳过原生探针，推进原版 Snipaste 窗口接线

Harris Snipaste 2.0.1 的 createBrowserWindow 已接入生产 native 路径；保持 opaque iframe、原 query/hash、既有preload和同一权限/TaskRun管线。补齐原包窗口参数、精确来源与真实原生标签、导航/就绪/关闭/退出回收；没有另建窗口专用Node启动通道或改写原包；preload仍可使用既有按需Node，实际进程数待验。

主 Agent 独立运行81项相关Rust检查、187项前端回归，类型检查、生产构建与工作区编译通过。窗口4/Owner与16/global、32pending intent、有界事件队列经过相关测试；启动JS432,238/573,440字节。TaskRun编号已按真实Rust模型run-UUIDv4纠正，测试不再用裸UUID替代。

原生探针最终版与GUI继续按用户要求跳过，不能据此宣称原版桌面可用。完整业务、整应用RSS/CPU、跨平台及child self facade来源标记仍待后续；本阶段与整项目标保持未完成。详见 [窗口接线验收记录](../../../output/harris-plugin-first-2026-10-23/native-window-production/verification.md)。

## 2026-10-23：子窗口来源、公共导航与原包贴图载荷合同

child self 的 native 来源现已显式注入，补齐真实编译桥回归；这是内部来源边界修复，未新增公开当前窗口 API。另将原 BrowserWindow.loadURL/reload 接入已有 native 文档导航，getURL 在来源与 owner 校验后读取当前 URL；保留 query/hash，不再错误分派到不支持它们的 Rust action。

原版 Snipaste 2.0.1 的完整三模块 preload 图在原字节临时副本上执行，真实文件队列完成两个不同 ID 的交错读取、latest 和预加载重建回读，原文件哈希前后不变。此合同借用 Node 文件系统，不证明实际 sidecar 共享或 OS 窗口关闭。主 Agent 使用产品 Node 22.23.3 独立通过 16 文件 / 129 项回归，类型 0 错误/警告、构建通过，启动 JS 432,238/573,440 字节；11 个代码文件最大 499 行。详见 [本批验收记录](../../../output/harris-plugin-first-2026-10-23/native-window-self-provenance/verification.md)。

下一项为 [Harris 贴图页自身控窗转译](../../../.scratch/2026-10-23-native-browser-window/issues/07-native-child-dom-window-controls.md)：原页直接调用 window.close 和 window.resizeTo，尚未接入 native self 动作。原生探针、GUI、真实 renderer 握手、完整业务和整应用资源仍待验；总体目标保持未完成。

## 2026-10-23：原版贴图页关闭与缩放控窗接线

已为 native self 文档注入 window.close / resizeTo 适配，复用既有权限、来源与 TaskRun 动作通路；普通 main/hosted 文档不序列化该工厂。连续尺寸更新最多一个处理中和一个最新待发值，关闭去重并丢弃待发尺寸，文档退出/销毁后禁用捕获的方法并保留插件后来替换的属性。

主 Agent 独立通过 18 文件 / 144 项前端检查、1 项 Rust self 身份矩阵、类型检查、生产构建和工作区编译；Rust 库仍有 197 条编译警告。启动 JS 432,238/573,440 字节，8 代码文件最多 418 行。原版 Snipaste 2.0.1 页面与三模块 preload 图在 scratch 副本上执行 wheel/reset/Esc/close 合同，并检查源文件哈希不变；不以模拟页面取代真实 OS 验收。首次 3 项类型错误修正后已复验，日志保留于 [本批记录](../../../output/native-child-dom-controls/verification.md)。

下一优先为 [Harris drag/no-drag 区域](../../../.scratch/2026-10-23-native-browser-window/issues/09-harris-native-drag-regions.md)，[framed 外框尺寸差异](../../../.scratch/2026-10-23-native-browser-window/issues/08-framed-window-outer-size-actions.md)排后。原生探针、GUI、BroadcastChannel 同步、真实 sidecar 共享、完整业务与整应用 RSS/CPU 仍未完成；总体目标继续推进。

## 2026-10-23：原版贴图拖动区域与macOS原生启动合同

已把原版Snipaste 2.0.1的区域CSS接到native-only样式转换与私有拖动入口，覆盖初始HTML、已内联样式及现有动态资源/CSSOM入口；原包保持固定字节。macOS使用同一窗口真实LeftMouseDown、短时限与一次消费，UI启动前重验exact child source、当前TaskRun和权限，启动ACK不等待鼠标释放。没有新增Node调用、逐pointermove通信、observer或周期轮询。

主Agent独立通过24文件/185项前端、42个不同相关Rust用例的分段回归、类型与构建、工作区编译；两个旧JS脚本修正测试依赖和职责迁移后的结构断言后通过，原行为检查保留。启动JS保持432,238/573,440字节；当前插件按需文件728,558字节，大chunk警告仍在。29代码文件均≤500行；原包哈希与冻结源码已复核。详见[本批验收记录](../../../output/native-drag-regions/verification.md)，其中保留首次失败和测试夹具修正的证据层级。

这只是macOS接线与页面合同，未运行GUI/App/AppleScript/原生探针；兼容shim下的preload导出不能当作Node/FS业务通过。外链CSS正文、部分CSSOM反射、其他平台、真实连续拖动、完整Harris五包和整应用RSS/CPU仍待验。总体目标保持未完成，下一独立切片为Task08运行时framed尺寸。

## 2026-10-23：原生窗口外框、内容区与约束基准

Task08已完成源码合同：创建及运行时setSize/setBounds使用实测frame/DPI转换为Tauri内容尺寸，setContentSize保持内容基准；构造min/max保留useContentSize原始基准，公开getter与runtime更新使用outer基准。不可行约束、物理像素边界及setBounds部分提交明确处理，返回值来自当前观测快照；macOS异步尺寸请求不冒充最终布局完成。

另修复compact几何快照丢失contentBounds的问题，使原生getContentSize读取真实内容区；原生当前尺寸可在系统裁剪或待处理时越过adapter约束，来源和revision仍受校验。同步getter零新增通信，没有新增Node调用、进程或轮询，原包未改写。

主Agent独立通过54项相关Rust、25文件/192项前端、类型、生产构建、原同步句柄脚本与离线工作区编译。首次5项前端失败确认为旧ready夹具缺少nativeSnapshot，改为生产StateFactory/reader/applySnapshot后全部复验，保留原业务断言。15代码文件最大458行，指纹冻结复核一致。启动JS保持432,238/573,440字节，插件按需文件729,661字节，增加1,103字节，大chunk警告保留。

详见[本批验收记录](../../../output/native-frame-size/verification.md)。Task08的OS几何继续待验；GUI/App/AppleScript/原生探针仍按用户指令暂缓，实际sidecar共享、完整Harris业务与整应用资源仍未完成。总体目标保持进行中。

## 2026-10-23：插件主文档与贴图子窗口广播合同

补齐同一PluginPanel实例内的BroadcastChannel适配，复用现有认证frame/document、私有hosted nonce与Window.postMessage，保持structured clone、同文档多实例独立拷贝、顺序和精确发送者排除。旧文档/来源不能加入继任文档，ACK及失效释放有界fanout预算；无新增Node/Rust特权调用、进程、全局总线或周期轮询。

原版Harris Snipaste 2.0.1贴图页经真实native文档准备、生产编译桥和认证路由，验证变换、原样双Solo及关闭消息抵达受控main接收文档。原包9个固定文件SHA未变；受控services载荷和main接收夹具不能替代真实Node/FS bootstrap或原React UI。

主Agent独立通过34套/261项相关前端、类型0错0警告、生产构建、原同步脚本和离线workspace check（宿主库197条既有警告）。15代码文件最大500行且验证前后指纹一致；Task08的15个几何文件未变。启动JS432,238/573,440字节保持不变；插件按需JS748,433字节，增加18,772字节，大chunk警告保留。首次类型、旧VM factory及同步脚本断言失败均记录修正和最终复验，见[本批验收记录](../../../output/plugin-broadcast-channel/verification.md)。

Task10源码与受控集成合同通过，原生WebKit跨窗口、完整Harris业务、实际sidecar共享、整应用RSS/CPU和旧initialize超时仍未验/未解决；GUI/App/AppleScript/原生探针继续暂缓，总目标保持进行。下一步在恢复原生验收前继续优先梳理Harris原包尚缺的共享能力，避免同一原生阻塞反复重跑。

## 2026-10-23：公开复制API同步结果与权限重试

原版Snipaste2.0.1的writeDualModeClipboard会Boolean(copyImage/copyText(...))。主Agent独立复现宿主拒绝/写入失败仍报成功，现补齐copyText/copyImage/copyFile同步boolean：只有真实同步宿主完成才true，拒绝/失效返回false；manifest/runtime gate与HostClipboard TaskRun/session两层保留，需要授权时不缓存、不重放，显式重试才写入。图片复用现有NativeImage和FileRead路径，不新增Rust API、Node进程或轮询，不改写原包。

主Agent独立通过46套/364项前端、19项相关Rust、6项JS检查、类型0错0警告、生产构建及离线workspace check。四个旧脚本已迁到真实生产模块并保留动态边界检查，旧document transport不再假设copyFile是异步。15代码文件最大493行、指纹冻结；原包6个固定文件未变。启动JS432,238/573,440字节不变，按需插件JS754,121字节（+5,688），大chunk警告保留。详见[本批记录](../../../output/plugin-clipboard-copy-result/verification.md)，其中区分原始红测、首轮坏CRC夹具、修正有效PNG及最终回归。

Harris原service经生产preload/编译桥运行并在临时副本真实写文件，但宿主XHR/图片转换答复受控；不是实际sidecar、系统剪贴板或原React/paster UI验收。原paster无条件“已复制”及plainText/text差异保留为原包限制。auto-start-plugin登记/执行仍是独立静态缺口，旧initialize超时、完整Harris业务、实机资源继续待验；GUI/App/AppleScript/探针仍暂缓，总目标保持进行。

### Task12：ZTools旧进入回调与预加载入口（source-contract verified）

按固定官方源码确认：ZTools旧onPluginReady是Enter别名；启动preload加载完整页面但不合成Enter。现将ZTools与uTools的ready语义区分，并在实际生成CJS preload后保留；其他公开成员转发当前uTools能力，晚装剪贴板及可枚举Symbol扩展不丢失。新增可信编译参数preload入口，关闭Feature/MainPush/promote等激活路径；它尚无生产后台调度调用。

主Agent独立通过68套/620项前端（0跳过）、6项桥接脚本、类型/默认生产构建/locked offline workspace编译。启动JS432,238/573,440字节不变；插件独占按需静态JS775,659字节，相比前轮制品增加1,660。9代码文件最大463行，验收源码指纹冻结，原包及上游关键文件不变。报告：`output/plugin-entry-lifecycle/verification.md`。

完整Harris后台登记、权限/TaskRun、常驻预算、同文档前台复用与退出回收由Task13继续；不开放任意host-global数据库或返回假登记成功。完整UI、系统业务和实际RSS/CPU仍未验收；GUI/App/AppleScript/探针保持暂缓，整体目标保持进行。

### Task13/14：后台生命周期与Paste原构建队列（source and isolated runtime verified）

Task13后台登记、持续文档复用与严格Node退出收尾的来源、实现和上一批验收见[后台启动记录](../../../output/plugin-background-startup/verification.md)。Task14进一步以Harris Paste 1.3.1未改写的完整built preload，经生产编译桥和真实产品Node，在隔离环境完成文字/文件持久队列初始化、失效ID修剪、关闭重开及成功消费。文件`writeBuffer`缺失已复现并补通用文件列表适配，只调用一次现有typed write通道；权限等待和宿主失败保持队列，不自动重放操作。

主Agent本批独立通过42文件/351次用例执行（0失败/跳过）、应用类型与默认生产构建。启动静态JS449,118/573,440字节不变；插件独占按需静态JS791,421字节，增加6,889字节。11个归属代码文件≤500行且验收前后指纹稳定，原包未改。完整记录见[Paste原构建启动验收](../../../output/paste-original-startup/verification.md)。

JSDOM、临时Node SQLite、权限/OS输入/clipboard受控端口不等于Tauri/Rust真实业务验收；Windows/Linux文件写provider、任意raw buffer、完整原UI、整应用RSS/CPU仍未验。GUI/App/AppleScript/全局输入钩子继续按用户指示跳过，Task13及总目标保持进行中。

### Task15：原版Paste独立编辑页（partial original UI evidence）

在保持原编译Vue页面与preload不变的情况下，主Agent通过私有Chrome真实DOM输入确认：空值禁存、一次`db.put`拒绝不落库、输入保留与按钮恢复、显式重试持久化、原doc关闭，以及旧Node先退出后的新owner/session/端点读回。同一临时SQLite记录经原`getHistoryItem`回读的标题与正文一致。

完整验收仍未通过：原包`App.vue`只在Shelf渲染status，独立编辑页保存失败没有可见提示；该条件的失败断言保留。最终2个文件4次用例为3通过/1失败/0跳过，三项旧队列回归通过。9个测试/夹具文件最多455行，生产Vite输入416文件与已冻结Rust/宿主40文件未变，本轮未重复应用构建/类型/Cargo检查。见[原编辑页验收与截图](../../../output/playwright/paste-original-editor/verification.md)。

浏览器OS HOME字段修正与仅fixture来源的loopback权限是测试环境适配，不是产品兼容层改动或真实TaskRun证据。真实父子窗口通知、WKWebView/Rust生产DB/权限、系统剪贴板与完整检索/预览继续待验；Task13/15及总目标保持进行中。

### Task16：Live Markdown 原版菜单文件流程（partial original UI evidence）

主 Agent 在原 React/CodeMirror 页面和完整35文件 preload 图上独立完成：原菜单打开固定 Markdown、真实DOM输入与实时/源码切换、保存、可见冲突保护、另存后继续编辑、旧 Node 退出后新 owner/session/端点/Node 读回正文与偏好。最终菜单路线1项通过，3文件27项相关回归通过、无跳过；两次 Node、Chrome、监听和SQLite均确认退出/关闭，临时根删除，40原包文件SHA前后不变。

原 `files` 路线仍失败：两次首次源码切换卡住，后一次3,125次native-text读取均指向同一input.md。原源码和发布JS中的render回调变化、effect重新订阅、preload立即重放文件入口、readDocument/setDoc形成回路，与实际重复读取吻合。保留原包和失败入口，不在宿主层造订阅抑制；没有ZTools同版本实跑对照，不归因为Node引擎或Tauri本身。菜单路线单独记通过，不能完成本票或Harris整体兼容。重开后切视图/查看设置出现“未保存”标记也保留待确认。

本轮只更改10个测试/夹具文件（最大407行），给既有Chrome helper增加可选origin并纠正类型；1,254个冻结生产源码文件全部未变，没有新增常驻进程或扩大产品预算，未重复应用构建/类型/Cargo检查。浏览器是WKWebView替身，native-text明确走真实Node fallback，DB/权限/选择器为受控端口；真实App/OS/TaskRun/整应用资源仍暂缓。Chrome内部帮助页与扩展活动单列未验，不宣称浏览器全局网络隔离。

见[本票独立核验、截图与失败记录](../../../output/playwright/live-markdown-original/verification.md)。保留两个原包自身交互问题，后续继续Harris小文件核心路线；不因本票菜单路线通过恢复已暂缓的桌面探针。

### Task17：Format Converter 原版小文本与失败重试（foreground browser evidence）

主Agent使用原React界面、15文件完整preload图及真实产品Node22.23.3，独立完成复杂CSV→JSON、对象数组JSON→CSV、TXT→JSON。空CSV/TXT错误可见并能恢复；坏JSON导致部分完成且不发布失败输出，修正同一临时文件后点击原重试按钮完成，UI显示编号前8位保持一致。四个实际产物全文比对通过，47原包文件SHA不变，Node/Chrome/监听/SQLite/临时目录均确认收尾；主Agent目视失败条目与完成截图。

最终本票UI1项、共享后LM菜单UI1项及2文件20项回归通过、0跳过。将已有Node fixture按双消费者职责迁到original-plugin-node，增加严格固定文件/目录选择；本票11代码文件最大448行，1,254冻结生产源码文件未变，没有新增依赖、生产适配分支、常驻进程或产品预算扩张。首次修复夹具的单对象/对象数组语义错误后保留原输出断言重跑，旧失败未改写。

原生Tauri/Rust TaskRun/权限/系统选择器、后台计时、800KiB限制及Office/图片引擎仍未验/未解决。独立核对ZTools HEAD9b15fb1确认backgroundRunning指隐藏WebContents不节流，auto-start-plugin才是自启预加载；ATools已有后台会话保留，但逐插件隐藏节流映射缺失，业务影响未测，不能将其误当自启或直接认定插件整体不兼容。见[本票证据与边界](../../../output/playwright/format-converter-original/verification.md)。任务03与总目标保持进行中。

### Task18：Paste 原版窗口创建偏好（production contract evidence）

修复 Harris Paste 1.3.1 原 shelf/panel 配置在 native mapper 提前被拒绝的缺口。只接纳原包实际需要的 WebPreferences，将后台节流布尔值正规化到 Rust；隔离提示只接受 false，不扩展 renderer 权限。显式 false 经当前平台门禁接到独立子窗口真实 Tauri builder；版本探测有界缓存、不启动子进程。默认策略、主窗口和全局配置保持原有语义。

父 handle 与 child self 使用已接受的构造值，导航/重载文档再次注入同一值；native 动态 setter 明确 unsupported，桥接与 host state 均不乐观修改。无新增 Node 进程、依赖、轮询或特权 IPC。主 Agent 独立通过14文件83项前端、21项Rust、类型0错0警告、生产构建与启动预算449,118/573,440字节、离线workspace check；宿主197条警告保留。3个原包证据文件SHA未变，21本票代码文件最大500行、冻结指纹一致。另一Luna只读审查未发现范围内具体缺陷。

这些是生产接线与文档合同证据；controller 导航测试仅证明注入参数，不能当作真实Wry导航或隐藏计时通过。原生App/GUI/AppleScript/系统剪贴板按用户指令继续暂缓，逐插件主文档backgroundRunning、完整Paste业务及整应用资源仍待验。见[本票记录](../../../output/native-window-preferences/verification.md)，Task18与总体目标保持进行中。

### Task19/20：Office 原版输出失败与生产 detached 回收缺口

主 Agent 在未改原包的 Format Converter 0.1.0 React UI、完整15文件preload、产品Node22.23.3及固定已装OfficeCLI1.0.158上完成操作链：原界面部分失败可见，同一路径修复后同任务重试，随后Excel→CSV。最终受限fixture实际记录1版本/4view，5个helper退出及stdio close确认，峰值2；Node/Chrome/五个helper均ESRCH，临时根已清理，47原包文件及已装CLI SHA不变。

本票验收仍失败：4次严格输出核对均含CLI定位标记，CSV还含sheet与cell地址。直接原runProcess调用得到同样内容，问题收敛到原插件/CLI输出约定，不以宿主改写stdout或修改期望来算兼容。另修复验收夹具的descriptor取值绕过与telemetry字段缺口，前两次实际UI没有正确受限进程记录，不计作该保护通过。最终10项policy回归、既有文本UI1项通过；严格TS仍受8条共享夹具错误影响。1,255冻结基线源码未变，新增fixture及ignored Rust探针共11代码文件最大451行；未安装依赖、未扩大生产预算。

Task20此前通过真实LegacyNodeSession独立红测：sidecar stop后root已Stopped/ESRCH，detached helper在独立PGID继续存活，直到自己的2.5秒计时器退出；没有手工发信号。当时生产回收修复尚未实现，后续进展见下一节。EventEmitter回调保留、其它快速事件和大输出仍待独立复现。GUI/App/AppleScript/系统剪贴板继续暂缓，整体目标未完成。见[Office票完整证据与边界](../../../output/format-converter-office/verification.md)。

### Task20：受管 detached helper（macOS 生产会话切片通过）

保留 WebView + Rust 核心 + 按需 Node 和原包 detached:true。Rust 创建并持有 helper，私有双 Unix socket 传递同步控制与有界异步流；Node 保持 ChildProcess 接口及同步 PID。只读确认 root reap 后的进程组消失，未确认清理严格失败且保留配额。每 owner 4 / 全局 8 的 helper 配额在 IO/actor 收尾后释放；PID 历史和传输队列有界，无新常驻 Node 或转换引擎迁移。

主 Agent 对最终代码独立通过231项Rust库、27项JS合约/policy、7项真实LegacyNodeSession场景及离线workspace check。保留原泄漏红测并跑绿，Harris字节不变的runProcess用PPID证明helper由Rust创建；stdout/stderr、退出码7与超时kill通过。新增exit后读输出用例实际抓出晚到credit竞态后修复；root crash/drop、标准stdio/stdin、ENOENT/单child kill与socket/env不继承均通过。最终root77612/helper77613在stop即ESRCH，产品Node进程与私有socket目录无残留，47原包文件SHA不变，35相关代码文件最多491行。

定向空闲样本250.32ms墙钟/0.48ms CPU只证明该Rust actor未忙循环，不是整App性能结果；197条既有宿主警告、其它平台/Node版本、多owner配额压力、原生UI/TaskRun、Office正文标记、LM files入口与容量缺口继续保留。未提交/推送、未安装依赖或替换已装App。完整命令、红绿记录、指纹与边界见[主验收记录](../../../output/managed-node-children/verification.md)。总体目标保持进行中。

### Task21：Harris UI 与宿主导航（浏览器切片通过）

主线回到可见UI、键盘和失败恢复。插件设置/分离收入可访问菜单，窄窗导航320/480从93px降到56px；保留子输入/清空、返回、运行警告。真实Chrome发现并修复portal菜单Tab离开页面的问题，最终Tab/ShiftTab按逻辑次序留在页面，外部/iframe点击、禁用项和模拟IME均通过。新增独立菜单模块、存活与身份保护，没有新增轮询或原生能力。

原版Paste独立编辑页写入失败仍由原catch处理，ATools桥额外显示自己的固定可访问提示；错误保留、不自动重试。主实际原UI证明首次无提交且输入保留，随后显式重试、原window.close和新Node/SQLite重开读回。活页同目标新写入解除提示由序列化bridge单测验证；普通读、其它目标、旧回执不误清。原包10个加载文件指纹不变。

主独立114项相关回归、两个最终浏览器流程、0错0警告前端检查及生产构建/449118字节初始JS预算通过。20个本票代码文件最大499行；上一票35文件指纹未改；进程、端口和临时环境收尾确认。原生UI/WKWebView/TaskRun、完整uTools对照、LM files循环、Office正文、所有Harris插件完整业务仍未完成。旧计划99%/100%改标历史估算，禁止当作当前UI还原率。详见[主验收记录](../../../output/harris-ui-interactions-2026-10-25/verification.md)。

### Task22：共用消息发送修复与 Paste 历史面板（浏览器切片通过）

原版Paste Shelf空态的实际回放最终抓到生产binder参数错误：原postMessage的第二参数目标origin被当成结构化transport的transfer列表，浏览器发送失败被折为false，原Promise一直pending。新增显式postLegacy适配，仅第一方bridge改用；宿主配置origin/文档身份和第三参数transfer保留，legacy失败拒绝Promise，结构化post的false语义保持。只有两个生产transport文件变化，没有按插件修原包。

主Agent在独立的primary/Shelf Node会话、共享临时SQLite和原版UI上完成两卡载入、正文检索、ArrowDown焦点及完整卡片摘要、空态与清空恢复，四次真实原查询2/1/0/2。JSON relay按原ShelfWindowManager的stringify语义跨CDP取回，不捏造结果；它仍是受控hostIPC替身。旧编辑器失败/重试/新Node持久化回归通过，同文档通知实测1次，不冒称跨窗口投递。

主独立26文件214项定向回归、两条原版页面路线、应用类型0错0警告、生产构建与首屏JS449118/573440字节预算通过。新fixture strict整体仍有17条共享旧helper错误，与仅编译旧helper完全一致，未报全绿。10个归属代码文件最多495行、原包10文件未改、Node/Chrome/profile/临时根收尾确认。没有新增依赖/常驻生产进程或Rust编译；整应用性能与原生/系统剪贴板/TaskRun、完整视觉对照及此前原包问题继续待验。失败原报及夹具纠正一并保留，见[主验收记录与截图](../../../output/harris-paste-history-2026-10-25/verification.md)。

### Task23：按更新目标推进 ZTools 宿主 UI（实施中）

用户将整体目标更新为“参考 ztools 源码和 UI，使用 Rust 和 Tauri 2 还原到 ATools”。沿用系统 WebView + Rust + 按需 Node、Harris 原包优先和原生验收暂缓决定。当前按本地 ZTools HEAD9b15fb1 确认两个宿主交互差距：首页分区只有截断而没有展开；搜索输入有选区时方向/Enter仍交给结果。完整要求、实现边界和派单见 `.scratch/2026-10-23-harris-node-compatibility-goal/issues/23-ztools-home-expansion.md`。修复前 7 文件46项为45通过/1旧夹具失败，原报保留在 `output/ztools-launcher-parity-2026-10-25/baseline.log`。总目标没有缩小为本票，完整 UI、原生/系统业务与同机性能仍待独立证明。

### Task23 完成切片：分区展开与文字选区交互

参考固定 ZTools HEAD9b15fb1，首页 fixed/recent 独立展开、完整候选、显示/键盘/状态共用sections、候选更新时选中身份保持、收起同区回退及文本选区编辑保护已实现。主目视在绿色报告后继续抓出窄窗首行被裁切，补齐实际展开后Header+首行同时可见；随后真实复验抓出focus提前滚动影响收起点击，限制首行对齐为展开动作后发生并保留红绿证据。

主独立19文件180项、严格应用/本票测试类型0/0、默认构建和453127/573440首屏预算通过（增加4009字节）；800/420×浅/深及搜索9项浏览器检查通过。17代码最多500行，880 native/runtime与44上游renderer未改，六轮测试资源确认退出。未重复Cargo、未新增常驻Node、未安装/改原包/提交/推送。完整源、截图与失败历史见 [Task23记录](../../../output/ztools-launcher-parity-2026-10-25/verification.md)。这是受控catalog/IPC的生产前端浏览器结果，不是原生Tauri/Rust/TaskRun、原版插件启动或整应用资源验收；整体Rust+Tauri2还原目标继续开放。

### Task24：双行指令卡片与 Rust 工作区高度约束（浏览器切片通过）

按固定 ZTools CommandList/App resize 链推进86px双行卡片和内容高度；旧340首页cap不足，移除后由Rust按当前显示器工作区限制窗口，ShellFrame沿用viewport约束与内滚。真实Harris地址解析8字标签旧UI截断已采集；先处理caller静默吞resize错误，保留原包、按需Node和原生GUI暂缓边界。票据 `.scratch/2026-10-23-harris-node-compatibility-goal/issues/24-home-command-cards.md`，证据 `output/ztools-home-cards-2026-10-25/`。当前native几何与crate7项同组用例、离线workspace check已通过，不当作真实monitor/窗口验收；整体目标继续。

主浏览器实际发现展开仅改CSS目标高度、未向宿主resize，现已补齐共享高度同步，并覆盖设置/历史/固定项变化与选中项不重复请求。主独立23文件200项、严格类型0/0、默认构建与455448/573440首屏静态JS预算通过（比Task23增加2321字节）。真实卡片浏览器800/420×浅/深及800×300内滚、键盘/提示/菜单/单次删除、受控resize失败可见恢复通过；旧展开/搜索四矩阵回归也通过。主目视绿色报告仍发现截图处于remount入场动画，最终仅调整夹具等待真实有限动画结束，5张图稳定性字段和目视均确认。

22归属代码文件最大500行，1497基线无超范围变化，879非本票native/runtime、44上游renderer及Harris3原证据文件未改；5份有效报告的10PID/10端口/profile/build独立确认退出，首轮缺失report的原ACK不补造。197条宿主警告和4个旧源码正则门禁失败分别保留，不报全项目全绿。无新增产品依赖/常驻Node/轮询；初始JS不等于整App资源验收。原生Tauri/WKWebView/显示器、系统业务、设置/插件管理完整UI、全部Harris业务仍开放，见 [Task24验收记录](../../../output/ztools-home-cards-2026-10-25/verification.md)。整体目标保持进行。

### Task25：设置加载保护与偏好保留（组件浏览器切片通过）

继续对照ZTools内部设置源码（固定HEAD9b15fb1）发现实质交互缺口：其GeneralSetting读取完成前不渲染控件，ATools却在native读取前以旧本地值开放编辑，early dirty跳过迟到hydrate并可能写回旧整快照。本轮优先以真实设置入口门控及同窗口读取快照修复此风险，失败/超时可重试，避免重复native读取，不在8622行单体追加职责。服务、UI和浏览器由独立Luna分工，主负责接口、关键差异和独立验收。票据25、证据 `output/ztools-settings-inventory-2026-10-25/`。

插件运行态/停止入口差距已另记票据26；必须先审查所有owner/session形态，不能把仅后台stop或UI列表当作任意插件进程退出。完整UI、原版插件业务、原生验收和同机资源目标保持开放。

主独立159项/15文件、严格应用/选定测试类型0/0、fixture严格TS、既有正规化/原生保存合同脚本及默认构建预算通过。首屏456447/573440字节，比Task24增加999。按相同固定IPC实际复现旧覆盖：只点击托盘，theme/两项行数随整快照写回旧light/1/1；修复版保持其余权威字段，失败可显式重试。审查又抓出取消后短暂发布快照的竞态，补AbortSignal后先红后绿；不声称物理取消Tauri调用。

最终current 4b293153浏览器14项/6图通过，主目视loading/error及800/420×600浅深截图。旧a9520c0d只标风险复现，不能算产品验收；两份select按键/可点击失败原报保留，改用真实普通开关验证同一保存链路，select按键仍待确认。15代码最多482行，881 native/runtime、123上游设置源及8622行旧SettingsPanel未改；旧单体结构债务未解决。5轮浏览器和早期Worker测试资源均核对退出；早期Worker定向TERM、不完整红测及pnpm锁拒绝记录保留，后续直接使用产品Node且单worker。未重复Cargo、安装依赖、改原包或提交/推送。

详见 [Task25验收与截图](../../../output/ztools-settings-inventory-2026-10-25/verification.md)。真实WKWebView/DB/系统能力、完整UI/所有Harris业务、跨窗口写事务与整App性能仍未由本票证明，整体目标保持进行。

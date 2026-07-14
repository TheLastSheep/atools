# ATools 性能基准与证据规则

本文定义 ATools 3.0 的可复现性能证据合同。它落实产品工程北极星中的性能边界，但不把一次 CI 结果包装成竞品优势结论。

## 自动化搜索基准

GitHub Actions 的 `performance-evidence` job 在每次 push 和 pull request 上运行：

```bash
pnpm benchmark:search:ci
```

基准分别构造 10,000 和 100,000 条指令别名、本地启动项与网页快开项，覆盖精确别名、路径包含、网页前缀、聚合关键词和无结果查询。每个用例先预热 3 次，再采样 20 次，报告 P50、P95、P99、均值、最小值和最大值。

机器、Node 版本、提交 SHA、运行 ID、数据规模与采样配置随 JSON 一起记录。报告以 `search-performance-<commit>` artifact 保存 30 天，文件路径为 `artifacts/performance/search-index.json`。

默认 80 ms 阈值是热搜索的交互延迟发布上限。`benchmark:search:ci` 超出时会报告 `warn` 并以非零状态阻断合并；任何对外性能宣传仍必须引用同机重复测试，不能只引用共享 CI runner 的数据。

## TaskRun 与 Memory 数据库增长基准

`database-performance-evidence` job 在远程 macOS runner 执行：

```bash
pnpm benchmark:database:ci
```

基准分别向独立 SQLite 数据库写入 10,000/100,000 条 `TaskRun` 和同量 `MemoryItem`，记录写入耗时和数据库逻辑分配字节数，再对最近 100 条任务、单条任务、最近 100 条记忆和精确作用域记忆检索分别预热并采样 30 次，输出 P50/P95/P99 与最大值。报告以 `database-performance-<commit>` artifact 保存 30 天，路径为 `artifacts/performance/database-growth.json`。

数据库查询暂用 80 ms P99 回退上限。它用于发现规模增长后的明显退化，不代表持久化写入吞吐承诺；共享 runner 的数据库文件大小和延迟也不能替代同机竞品对比。

## 远程 macOS 运行时基准

`runtime-performance-evidence` job 只在 GitHub 托管的 macOS runner 构建 unsigned release `.app`，不会要求开发机生成本地构建产物：

```bash
pnpm benchmark:runtime:ci
```

基准记录 `.app` 目录与主可执行文件的原始字节数，并连续启动 20 个全新应用进程。每轮采集 LaunchServices 调用到进程出现、首份前端 release-smoke 报告、完整 smoke 的耗时，以及完成 smoke 时的 RSS/CPU 点样本；结果包含首轮明细和全部样本的 P50/P95/P99，保存为 `macos-runtime-performance-<commit>` artifact 30 天，文件路径为 `artifacts/performance/macos-runtime.json`。

首份 release-smoke 报告证明 Tauri bridge、前端入口和原生 command 已经可以交互，因此是可自动复现的“启动到首个前端交互报告”代理指标，不等同于重启机器后的冷启动首帧。RSS/CPU 也是 smoke 完成时的点样本，不等同于稳定空闲 5 分钟。当前 5 秒首报告、300 MiB RSS、100 MiB `.app` 仅作为共享 runner 的软告警线；先积累真实数据，形成稳定基线后才能升级为阻断门槛。

## 同机竞品对比

ATools、uTools 与 ZTools 的比较必须在同一台机器、相同电源模式、相同数据集规模和相同采样轮次下完成。至少记录：

| 指标 | ATools | uTools | ZTools | 采集方法 |
| --- | ---: | ---: | ---: | --- |
| 安装包大小 | 待测 | 待测 | 待测 | 发布产物原始字节数 |
| 冷启动到可交互 | 待测 | 待测 | 待测 | 重启应用后计时，至少 20 次 |
| 热键到首帧 P50/P95/P99 | 待测 | 待测 | 待测 | 屏幕/事件时间戳，至少 50 次 |
| 10k 搜索 P50/P95/P99 | CI 可追溯，待同机 | 待测 | 待测 | 相同语料与查询集合 |
| 100k 搜索 P50/P95/P99 | CI 可追溯，待同机 | 待测 | 待测 | 相同语料与查询集合 |
| 空闲 RSS/CPU | 待测 | 待测 | 待测 | 启动稳定 5 分钟后采样 |
| 单插件内存增量/冷启动 | 待测 | 待测 | 待测 | 同一插件夹具、同一启动路径 |
| 连续唤醒与长稳 | 待测 | 待测 | 待测 | 固定轮次和持续时长 |
| 本地数据库增长 | CI 基准验证中 | 待测 | 待测 | 固定任务与历史写入负载 |

在表格仍含“待测”时，项目只能表述为“已建立可复现基准”，不能表述为“已证明比 uTools/ZTools 更快、更轻”。

## 当前共享 Runner 参考结果

2026-07-14 的优化验证把 100k 搜索从初始 P99 1374.503 ms 最终降到 15.341 ms。中间方案在相邻共享 runner 上出现过 68.149 ms 与 89.776 ms 的波动，因此继续优化并保留 80 ms 发布上限；最终分用例最慢项为聚合关键词 15.341 ms，路径包含 0.093 ms，无结果 0.003 ms。所有运行均保留机器元数据与完整 JSON artifact。当前结论是“共享 runner 上满足项目热搜索上限”，不是“已证明竞品优势”。

- 初始证据：[CI run 29332182277](https://github.com/TheLastSheep/atools/actions/runs/29332182277)
- 68.149 ms 证据：[CI run 29333449969](https://github.com/TheLastSheep/atools/actions/runs/29333449969)
- 89.776 ms 复测：[CI run 29333768686](https://github.com/TheLastSheep/atools/actions/runs/29333768686)
- 15.341 ms 最终证据：[CI run 29334020853](https://github.com/TheLastSheep/atools/actions/runs/29334020853)

2026-07-14 的综合交付验证 [CI run 29338826896](https://github.com/TheLastSheep/atools/actions/runs/29338826896) 中，100k 搜索 P50/P95/P99 为 12.403/19.647/22.801 ms。相同运行的 100k 数据库 P99 为：最近 100 条 TaskRun 2.476 ms、单条 TaskRun 0.013 ms、最近 100 条 Memory 1.563 ms、作用域 Memory 检索 31.459 ms；两类硬门槛均通过，完整 JSON 分别作为 `search-performance-<commit>` 与 `database-performance-<commit>` artifact 保存 30 天。

2026-07-14 的首次远程运行时证据 [CI run 29339874992](https://github.com/TheLastSheep/atools/actions/runs/29339874992) 成功构建并启动 unsigned release `.app` 20 次，上传 `macos-runtime-performance-3916450...` JSON artifact。作业注解记录 `.app` 目录 32.63 MiB、RSS P99 112.453 MiB、首个前端交互报告 P99 6278 ms。包体和 RSS 低于软告警线；首报告高于初始 5 秒软线，因此保留 `warn`，在获得更多共享 runner 样本或定位首轮异常前不升级为硬门槛，也不把该代理值表述为冷启动首帧。

## 结果判定与变更规则

- JSON `schema_version` 改变时，必须同步测试和本文。
- 优化前后必须比较相同机器、规模、预热与采样配置；共享 runner 只能用于发现明显回退。
- 对外性能基线至少需要 5 次同类 CI 运行或一次受控同机对比；内部产品延迟上限可以在有充分安全余量时先作为回退硬门槛。
- 安装包、真实冷启动首帧、热键首帧、稳定空闲资源和插件启动仍需分别闭环，不得由搜索、数据库或 runtime 代理基准相互替代。
- 发布签名、公证、Gatekeeper 和更新器验证属于独立硬门槛，性能报告通过不能替代发布验收。

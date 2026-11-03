# ATools 已安装插件功能检索与精确打开进展（B47）

本批修正已安装插件列表在功能搜索命中后的打开入口：用户输入唯一功能代码、名称或说明时，可打开对应的精确 feature；多义或仅插件元数据匹配时保留原有首功能默认行为。产品实现继续使用现有 App/native 路径，并绑定准确的插件 owner 与 feature code。浏览器验收使用隔离 mock bridge；这不等于真实原插件业务流程成功。

## 交付与验证

Root 冻结绑定 1,571 个显式选定源码，其中 11 个本批自有文件（7 修改、4 新增），`PluginInventoryPanel.svelte` 为 460 行，低于 500 行；7 个既有文件的 before 快照逐项与 B47 baseline 相符。显式选择列表不构成完整编译依赖闭包。源码后检选定集无漂移。

- 定向测试：6 个文件，83/83 通过。
- 完整前端套件：187 个文件，1,788/1,788 通过；Svelte 检查 0 error / 0 warning。
- Cargo workspace check：退出码 0，包含 4 个既有 warning。两项 Node inventory harness 退出码 0；source binding 676 个选定输入、11/11 owned 文件匹配。
- 按 HTML 入口及静态依赖图实测，生产首屏 JS 为 365,513 / 573,440 bytes，较基线增加 0 bytes；插件面板保持动态懒加载。
- 浏览器最终 run `7621470e-1351-4363-a8d0-44c337328a75`：7 个阶段、11 个布局状态、7 次 exact owner/code `activate_feature` 调用、5 项清理通过。10 张截图均核验 SHA、字节数和尺寸；root 目视检查其中 4 张（长标签 800/420、列表 420、暗色打开失败 800）。夹具会有意拒绝 activation，因此验证的是检索、路由请求和焦点/布局合同，不是插件业务执行。

性能比较使用同一 runner/runtime，分别绑定 before 与 candidate 的 source SHA，覆盖 1,200 个 feature、12 个 plugin、6 个 query，每组每来源 5 次预热及 60 次交错样本。纯派生最坏 p95 从 0.222334 ms 到 0.358875 ms，增加 0.136541 ms；候选耗时为基线约 1.61 倍（约增加 61%），仍低于 25 ms 预算。候选更慢，不能描述成无性能回归；该数值也不是完整 UI、主 matcher、OS 输入或原生插件延迟。早期 unbound baseline 只作为历史记录，最终比较以 root 的受控报告为准。

浏览器 v1/v2 的失败报告和日志均保留。v1 的通用 JSON 标签命中 1,200 个合成插件，测试错误地期待一行；v2 新增的 6 次检索调用使旧详情阶段的全局调用总数从预期 1 变为实际 7，旧断言未按阶段增量计算。最终 runner/fixture 修正后 v3 通过。变化仅限两个浏览器验收文件；最终 root 核对产品、测试、benchmark、构建及 Rust 输入未变，因此复用之前通过的检查。红报告仍是实际失败历史，不升级为绿。

## 限制与未完成

本批新接受的真实原插件业务工作流为 0；未执行真实 macOS 输入，未证明多数 ZTools 插件可直接使用；release validation=false、formal acceptance=false、majority acceptance=false，goal 仍 active。没有竞品 parity、端到端 latency、闲置资源或完整依赖闭包结论。B45/B46 已发布的原生启动/前台验收缺口以及 1 项已知 formatter fidelity gap 仅沿用为既有未决项，没有在本批重试或恢复。

本批 `PluginInventoryPanel.svelte` 为 460 行，低于 500 行。B46 交付中另一个 `PluginPanel.svelte` 仍有 8,373 行，是既有拆分债务；二者不是同一个文件。无 idle 轮询、自动重试、新依赖或新的 feature activation API。

本文件记录 B47 实施与验证范围；本批根验收状态以 `batch47-delivery-v1.json` 及后续 root 发布清单为准。

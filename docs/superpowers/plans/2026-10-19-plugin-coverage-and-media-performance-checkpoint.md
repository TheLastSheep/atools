# 插件覆盖与文件匹配性能核对（B68/B69）

当前仍不能给出“大部分原插件可直接使用”的比例。[证据索引](../../../output/plugin-input-2026-10-19/batch69-goal-evidence-map-v1.json)区分本地目录、静态资源、安装事务、代表性 API、指定原包业务动作和物理 UI。历史基数为 180 个本地目录；92 项 ready 仅表示静态入口/资源条件。历史 inventory 没有完整上游 revision pin，不能用当前 dirty checkout 回填。已选的业务样例互有重叠，不能相加当作可用插件数。

原包一键转换仍缺真实 source-only 包的执行验收。B38 的生产构建/权限/TaskRun/安装链已用合成 Vite 项目验证，不能替代原包构建。当前由 Luna 继续检查现有本地依赖与真实生产构建合同，主 agent 负责验收。

性能记录纠正：[历史 73.337125ms 样本](../../../output/plugin-input-2026-10-19/batch59-evidence-v1/root/core-plugin-shim-tests-v1.log)来自 `media_content_performance_tests` 的文件名匹配边界，并非普通 `FeatureSearchIndex.search`。该输入为 1200 条规则、32 个 8192 字节文件名、2 个唯一正则；原始文件名共 256 KiB，按正则数量加权后为 512 KiB。25ms 预算保持不变。

[调查记录](../../../output/plugin-input-2026-10-19/batch68-root-media-matcher-investigation-v1.json)及[保留材料](../../../output/plugin-input-2026-10-19/batch68-evidence-v1/manifest.json)包含 Luna 和主 agent 各一次有界对照：用 barrier 启动边界组及另一个文件匹配测试组，记录全部 12 个边界查询，未重现尖峰。主 agent 的 4 个 512 KiB 加权边界样本为 8.132、7.686、8.851、8.068ms；线程 CPU 为 7.990、7.652、8.593、7.958ms。对照代码复用实际 core 路径依赖，断言结果数量或完整配额拒绝；它省略原测试部分 match_type 断言，不替代原测试套件。barrier 只保证两个工作负载同时开始，未测量每条查询是否重叠。

历史执行的外层命令、线程数和同期系统负载没有留存，原因保持未知。串行及两次对照通过均不抹去原红项，也不证明并发性能全部达标。本项没有足够证据支持生产算法修改，因此未改算法、未放宽预算。B66 初始 JavaScript 368684/573440 字节仍只代表静态入口图；整应用启动、RSS/CPU、稳定 P99 和竞品同机体验仍待验收。

实现子任务继续使用 Luna worker，主 agent 做独立核对与运行验收。没有暂存、提交或推送 Git。

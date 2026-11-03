# ATools 原插件兼容进展（2026-10-20）

## 分母与静态分类

固定本地 ZTools-plugins HEAD `2d47bd91011b6be872eef1d7c56b4c6b57a93b3d` 的静态 inventory 分开记录 153 个上游目录与 27 个本地目录；嵌套 manifest 不单列。上游分类按 HEAD 内容，不以脏工作树替代：当前 tracked plugin subtree 有 72 项修改、532 项删除，另有 27 个本地未追踪 direct-manifest 目录。上游目录中 144 个完成分类、分类错误为 0：Tier 1/2/3 为 4/56/84；状态为 ready 60、requires-build 11、incomplete 73。报告另列 3 个不兼容快照条目和 6 个缺少直接 manifest 的目录。这些分类描述静态形态，不代表安装成功、原插件业务可用率或多数覆盖。

当前冻结为 source-freeze-v22：1798 个 selected source pins，明确不是 compiler/dependency closure。前一阶段公共 B165 archive 有 65 个 payload、2,935,499 字节；本阶段只引用其 manifest，不复制旧归档 payload。

## 原插件与转换执行

`application-uninstaller` 的原始本地包通过生产转换与导入路径：13 项检查、2 个 TaskRun 均终态。该证据证明所选包的转换/导入，不证明其卸载业务操作；该包也不属于 153 个上游分母。

`FileTree` v1–v6 失败报告与 root review 均保留。v7 对固定 HEAD 包和 fixture 目录运行通过 21 项具名检查：原始扫描、忽略规则刷新、隐藏文件开关，以及一次成功的 `files` feature 激活；418 个 TaskRun 均终态，返回搜索焦点、runtime drain、临时数据清理和原包未变化均由 root receipt 记录。虽然报告的合成搜索数据含有两个 metadata 插件组，本次业务验收只激活一个原始 FileTree 插件。它不覆盖物理键鼠、任意用户目录或整个插件体验。

`calculation-paper` v3 有 36 项检查和 5 个终态 TaskRun，验证原输入/结果处理 `6*7=42`、清空及 `8*9=72`；root receipt 绑定 source-freeze-v21 与同一 9629… debug binary。FileTree v7 则绑定 v22。它是程序化原插件流程，不是物理窗口或竞品 UI 验收。合成 public-parent Vite 报告是合成转换证据，不计为原插件业务验收。

## 测试、构建与性能

v22 定向生命周期回归为 55 项通过，native smoke TypeScript 检查退出码为 0；v21 Svelte 检查为 0 errors/0 warnings。当前初始 JavaScript 为 371,088 / 573,440 字节，lazy plugin-panel 与拼音资源不计入该首屏预算。

core 查询结果的源码连续性也已核对：formal review 绑定 source-freeze-v13；v13 与当前 v22 冻结共有的 88 个 `crates/atools-core/` selected pins 全部相同。v12 root review 独立记录了这 88 个 core pins 与 v13 一致。该 selected 子集核对不代表完整编译闭包。

性能证据按时间和范围区分。较早的 default `core-full-v2` 在 12:47–12:50 UTC 退出 101；两个首次 media 样本超过 25 ms：`maximum1000` 为 271.602 ms，`ruleBoundary8192` 为 26.958 ms。失败原因未确认，原报告与日志保留。之后的 `core-full-paired-cpu-v2` 于 14:15:55 UTC 完成，root 于 14:17:16 UTC 复核：263 passed、0 failed、3 ignored；该轮报告的全部正式 25 ms 查询样本均通过，包含 media 最大 12.433 ms、matcher 最大 18.821 ms、typed-text 最大 7.030 ms。它更新了当前这组完整 core 门禁结果，但不抹去较早的失败观察。更早 paired-cpu-v1 中 feature-catalog 首次样本 41.255 ms 超过 25 ms，原因同样未确认。当前结果不证明全进程/系统树 CPU 或内存上限，也不是全局性能接受；3 个 ignored 测试未运行，2,000 ms ceiling 的 32.941 ms cold snapshot 不是 25 ms warm-query 样本。较早的 `plugin-full-v2.log` 记录 203 passed、0 failed、0 ignored；当前 v18 的 `v18-plugin-full-v1.log` 记录 210 passed、0 failed、0 ignored（19 个结果块）。两份日志分别保留，不能把旧结果写成当前结果。

## 验收边界

本阶段证据覆盖静态分类、有限的原插件具体流程、程序化前端检查和一组完整 core 查询门禁。selected source snapshots 不是完整编译闭包。静态 ready、合成转换、原插件具体业务流程、物理 UI 与全生态比例是不同证据层级；当前结果不能证明“多数插件可用”、全插件业务成功、竞品 UI parity 或发布完成。B188 Developer Codec Tools 与 Home 相关候选没有在本阶段通过验收，不列为已接受结果。

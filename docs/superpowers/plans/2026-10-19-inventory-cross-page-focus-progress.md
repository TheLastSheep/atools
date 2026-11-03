# 已安装插件列表跨页键盘焦点进展（B50）

插件列表现在支持从当前页末项按 ↓ 跳到下一页首项，以及从首项按 ↑ 返回上一页末项。翻页后焦点按插件身份恢复；Home/End 在本页定位且边界不循环。Enter 沿用详情按钮的原生动作，Escape 从详情返回同一插件和页。筛选、查询、手动翻页、刷新、显式重试或用户把焦点移到别处时，旧的跨页焦点请求会失效。

本次改动把跨页焦点交接放进独立分页焦点控制器，Panel 只接线。列表仍最多渲染 30 行；跨页只写一次本地页状态，不增加列表/目录/写操作 IPC，不加轮询、全局按键监听、预取或缓存。正常边界导航用真实 Chromium CDP 按键；等待 Svelte tick 的竞态用同一 JavaScript task 内的受控 DOM 序列复现，确认搜索/刷新/筛选/重试取消旧交接。详情往返也在跨页后验证相同身份和页码。

## 验收范围

- 最终 Chromium 运行的 6 项检查通过，覆盖 31/61 项目录的双向翻页、末页边界、Home/End、非详情控件、跨页后详情 Enter/Escape、待处理焦点取消、显式刷新/重试与过滤刷新不产生陈旧焦点。最多 30 行 DOM；一次挂载只读取一次 `list_plugins`，其余 IPC 只对应明确触发的刷新或失败重试。
- 浏览器运行绑定冻结源，使用实际 `PluginInventoryPanel` 和固定 IPC fixture，页面为 `about:blank`，无 fixture HTTP。它验证组件集成，不代表 macOS 原生键盘输入、已安装插件业务流程或与竞品的 parity。
- 浏览器 v1 曾因测试序列错误而红：脚本回到第 1 页后错误地期待 End 跳至第 2 页。产品未因该结果修改。v2 通过；v3 补强跨页详情往返、同 task pending focus 序列并通过。三次报告及测试构建的早期失败/通过证据均归档。
- 最终前端全量：190 个文件、1819 项通过；定向 16 项通过；Svelte 检查 0 错误/0 告警；Cargo workspace check exit 0（4 条既有 warning）。
- 生产首屏静态 JS 为 365,829 B，预算 573,440 B；相对前一验收基线增量 0。该数字是初始静态图预算，不代表整个安装包没有变化。Rust matcher 1,200 features、20 次样本最大 762,667 ns（预算 25 ms），仅代表 matcher，不代表 UI 按键或原生启动延迟。

独立只读源码审查未发现 P1/P2；审查指出 `defaultPrevented` 的提前返回目前没有专门的预取消键盘事件回归断言，这是非阻断覆盖建议。

## 交付边界

本批增加的已验收原插件/原生业务工作流为 0；多数插件直接可用、发布与正式验收均未通过。本批没有 Git add/commit/push。B49 原 paintbrush PNG 保存仍是 4 个场景定义、0 个完成，浏览器父页未能到达插件挂载，根因待查；B45 原生编辑器与 LaunchServices 验收缺口继续保留。本批只改善设置页插件目录的键盘分页，不把它们表述成已解决。

最终交付索引与核验材料：

- [根验收摘要 v2](../../../output/plugin-input-2026-10-19/batch50-evidence-v1/metadata/verification-summary-v2.json)
- [独立源码审查](../../../output/plugin-input-2026-10-19/batch50-evidence-v1/review/review-v1.md)
- [最终 Chromium 报告](../../../output/plugin-input-2026-10-19/batch50-evidence-v1/browser/v3-final/report.json)
- [最终源冻结 v3](../../../output/plugin-input-2026-10-19/batch50-evidence-v1/metadata/source-freeze-v3.json)
- [证据 Manifest](../../../output/plugin-input-2026-10-19/batch50-evidence-manifest-v1.json)
- [交付摘要](../../../output/plugin-input-2026-10-19/batch50-delivery-v1.json)

复制核对清单位于同级 `output/plugin-input-2026-10-19/batch50-copy-list-v1.json`；它记录复制来源与目标，不是验收结论。

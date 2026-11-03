# 已安装插件筛选结果反馈

已安装插件列表的筛选计数现在有稳定的无障碍播报节点。用户键入筛选词或切换状态、来源后，只有目录读取完成且没有恢复错误时，节点才播报当前匹配数；初次读取和刷新期间保持空白。可见计数在结果未就绪时显示“筛选结果待更新”，不显示暂时的零或旧数字。无匹配时输入框保留焦点，清除筛选后列表恢复并把焦点放回输入框。

计数播报节点始终挂载，带有明确名称、`polite` 和 `atomic` 语义。可见计数与播报节点分开，市场按钮在 live 区域外。原有反馈区域继续报告目录总量和错误；筛选计数与目录总量代表不同层级。

本批涉及 [工具栏](../../../src/components/PluginInventoryToolbar.svelte)、[面板接线](../../../src/components/PluginInventoryPanel.svelte) 和 [组件回归测试](../../../tests/components/plugin-inventory-filter-accessibility.test.ts)。实现没有增加请求、定时器、全局监听或新的筛选扫描。

## 验证

- 定向测试：2 个文件、23 项通过；包含零结果、清除筛选和焦点恢复、非零计数，以及同一播报节点贯穿初始加载、筛选、刷新等待和刷新完成。
- 更宽的定向测试：4 个文件、39 项通过。该证据来自 v2，v3 只调整未就绪时的可见计数文案及相应测试。
- Svelte 检查：0 个错误、0 个警告。
- 离线锁定 workspace 检查：退出码 0，保留 4 条既有警告。
- 发布构建静态初始 JavaScript：365,829 字节，预算 573,440 字节，与本批 baseline 相同。懒加载的插件面板不在初始静态图内；这不代表整个应用包、内存占用或输入延迟没有变化。

完整的来源、哈希和 root 验收结果见[证据索引](../../../output/plugin-input-2026-10-19/batch52-evidence-manifest-v1.json)、[交付记录](../../../output/plugin-input-2026-10-19/batch52-delivery-v1.json)、[最终验收](../../../output/plugin-input-2026-10-19/batch52-evidence-v1/metadata/root-acceptance-v1.json)、[源码冻结清单](../../../output/plugin-input-2026-10-19/batch52-evidence-v1/metadata/source-freeze-v3.json) 和[独立审查](../../../output/plugin-input-2026-10-19/batch52-evidence-v1/review/independent-review-v3.md)。

## 验收边界

测试覆盖组件 DOM 与状态变化，不代表真实屏幕阅读器、VoiceOver 的播报顺序或队列行为；本批没有浏览器或原生界面输入验收，也没有验证插件业务流程。1,587 项 source freeze 是本次检查选择的来源清单，不是编译闭包。正式验收、发布验收和多数插件直接可用均未通过；goal 仍处于 active 状态，本批未执行 Git 修改。

历史红测和测试假设修正记录一并保存在归档中，便于区分基线缺口、早期测试模拟问题与最终 root 验收。

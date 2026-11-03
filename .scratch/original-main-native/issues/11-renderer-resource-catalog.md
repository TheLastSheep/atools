# 11: 兼容目录与构建产物预算收敛

**What to build:** 统一适配器重复兼容目录，容纳R20目录刷新；完整验证后发布构建产物，失败保留已接受dist。

**Blocked by:** R20已实现但超预算583字节；与等待解锁的08/09页面验收可并行。

**Status:** complete（本地资源与构建发布切片；整体UI目标未完成）

- [x] 真实Interface基线对比、能力副本/订阅/unsupported语义保持。
- [x] 临时stage全检查后发布，失败/并发/回滚与清理的定向检查通过。
- [x] 正负向真实CLI构建验证预算、退出码、旧dist及来源闭包。
- [x] 完整相关测试、strict与必要Native构建绑定；真实浏览器回归完成，原生页面边界保留。

契约：`docs/contracts/ztools-renderer-resource-catalog-2026-10-27.md`。

证据：`output/renderer-resource-catalog-2026-10-27/verification.md/json`。Root Main142/strict、Node45（输出事务15项）、正/负向CLI、workspace通过；JS586524/586528，省587字节且余4。Native1080输入与两个fresh示例绑定；headless原Vue14检查/6截图、六事件逐项回收、来源稳定和自有进程/profile回收通过。默认入口未切换，真实Tauri事件→Vue、系统图标和窗口/材质/物理输入仍待后续；不将浏览器fixture回执称为真实TaskRun或OS动作。

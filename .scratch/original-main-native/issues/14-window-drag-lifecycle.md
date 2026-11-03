# 14: 拖动中隐藏和重新加载

**What to build:** 拖动中隐藏或主页面重载后清理旧尺寸锁，新手势可继续使用；用实际隐藏Native完成验证。

**Blocked by:** 13 本地拖动切片完成。

**Status:** DONE — hidden Native lifecycle slice; visible and broader platform behavior remains unverified.

- [x] 实际锁中hide后Native解锁，同文档重新拖动。
- [x] 实际锁中完整重载后Native解锁，新文档和新adapter重新拖动。
- [x] v2阶段与文档身份、无前台/副作用、原catalog回归及资源回收通过。

契约：`docs/contracts/ztools-renderer-lifecycle-and-launch-2026-10-27.md`。

## R24 实际验收

Native run `066cc4fd348641688c2865b3e757910f`：`output/renderer-catalog-native-2026-10-27/run-066cc4fd348641688c2865b3e757910f/report.json`、`window-drag-native.json` 与 `catalog-native.json`。schemaVersion 2 的十阶段全部通过：`baseline, dragged, resized, released, restored, hide-locked, hidden-cleared, redragged, navigated, recovered`。R23 的前五阶段原样保留。

同文档阶段位置从 `(356,608)` 拖至 `(376,623)`，并在锁内改为 `(376,599), 800×85`；释放后解锁，恢复到 `(356,608), 800×61`。随后真实 SearchBox 手势使窗口再次锁定，生产 `hideWindow` 调用计数从 0 增至 1，隐藏后 Native 尺寸锁变为 false；同一文档再次拖动到 `(364,614)` 并锁定。保持锁定触发真实同源完整导航，新的文档/adaptor 观察到相同位置且 Native 已解锁；初次位置读取为 1，move/lock 为 0，原 Vue 挂载发出一次 `expandWindow`。随后拖动恢复到 `(356,608), 800×61` 且保持解锁。

前八阶段 DOM/Native 使用文档 ID `a0f7908d53da470d82c200e35c852160`，`documentGeneration/pageLoadStarts/pageLoadFinishes` 为 `0/0/0`；导航和恢复两阶段使用新文档 ID `2b3b98bb83d841ccb141ad321c4e04c0`，计数为 `1/1/1`。十阶段均 hidden/unfocused，focus-gained、child、layout、clipboard、TaskRun、history 均为 0；catalog 五阶段通过。Native PID 46832 exit 0，私有 root 与 bundle 清理完成，source/native/binary/receipt 保持稳定。

实现门禁来源变更后，Native window-drag 状态测试5项通过；renderer 143项、默认配置相关启动12项、Main 21 files/162项及 strict TypeScript、Node 37项均通过。前述12项包含在renderer 143项内，不相加，也不代表完整Native测试。首次 Native 编译暴露3处类型/借用错误，修复后的上面运行通过；失败记录保留。浏览器首轮 `53a7dfdd-a86f-40cf-a545-ac714ee7d311` 暴露夹具错误地在 pastedText 模式等待 app row，原 Vue 的内容匹配行为未改。R24 后续 browser run 与启动回搜索证据记录在 ticket 15。

本票只完成隐藏窗口 Native 生命周期切片。可见窗口、物理/多屏输入、跨平台及重启位置保持仍未验证。

# 12: 真实应用目录事件刷新原版页面

**What to build:** 本次自有隐藏Tauri中，真实FSEvents驱动原Vue getApps/列表更新、系统icon解码和移除路径拒绝，完成退出回收。

**Blocked by:** R21预算与current source/dist已收敛。可见窗口验收仍等桌面可用，本票隐藏链路单独验证。

**Status:** completed（本地 hidden catalog slice；不代表 visible UI 验收）

- [x] 独立catalog profile/owner/source和无foreground接线。
- [x] Native观察协议/阶段、真实增删→原DOM及icon/CORS、旧路径拒绝。
- [x] Node来源绑定、报告校验、终止后自有目录/bundle回收。
- [x] Root相关检查、fresh构建及实际Native证据；可见UI待验范围单独保留。

契约：`docs/contracts/ztools-renderer-catalog-native-2026-10-27.md`。

## R22 本地隐藏切片结果

实际五阶段报告：`output/renderer-catalog-native-2026-10-27/run-61da068fbc8e49a786d5d95da7c25dd4/report.json` 与 `catalog-native.json`；独立审查：`output/renderer-catalog-2026-10-27/independent-review.md`。Native run PID 36872 exit 0，终止后自有 fixture root 与 app bundle 均回收。Rust renderer 125 项、Node 28 项、legacy-only/default workspace check 和 fresh both-example build 通过；旧失败日志继续保留。当前 Main JS 为 586524 bytes / 有效预算 586528，source 未变。

DOM/native 记录五阶段：`appListCalls` 1→2→3→3→3，adapter events 0→1→2→2→2，main-target witness 0→1→2→2→3，catalog 数量 1/2/1/1/2。窗口始终 hidden/unfocused、focus-gained 0、child/layout 0，WK store 非持久；clipboard 全0，stale launch rejected，TaskRun/history 前后全0。initial/added 原页面图像解码64×64且 `analyzeImage` 成功。该结果只完成 ticket 12 定义的本地 hidden catalog slice；可见UI、真实前台焦点/窗口行为、错误占位、物理输入及完整产品验收仍开放。

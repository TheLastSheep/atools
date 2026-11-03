# 15: 启动成功后回到原版搜索

**What to build:** 应用成功启动并记入历史后，原版界面清空本次查询和匹配内容、隐藏主窗；失败保持查询。

**Blocked by:** 08 现有应用协调管线；14与本票职责独立。

**Status:** DONE — R25 macOS hidden Native launch-to-search slice passed. This status is limited to the isolated hidden profile and its owned app fixtures; visible UI and the default launcher entry remain open.

- [x] Native成功顺序与main-only空载荷通知，失败不通知，不诱导重复启动。
- [x] 原版onAppLaunched/七类事件与退出，预算不变。
- [x] 原DOM成功/失败与autoClear=never浏览器行为验证；合成回执与真实Native证据分别记录。
- [x] 真实自有应用启动→通知→清空/隐藏→历史与进程回收验收（限R25 macOS hidden profile）。

契约：`docs/contracts/ztools-renderer-lifecycle-and-launch-2026-10-27.md`。

## R24 浏览器与 Native 证据边界

Headless browser run `66d74695-897d-48e4-92cf-b18c86b78885`：`output/playwright/ztools-renderer-browser/browser-66d74695-897d-48e4-92cf-b18c86b78885/report.json`，14项检查、6张截图通过并完成资源清理。autoClear=never 下，失败的受控 API 请求保留原查询状态；成功 synthetic receipt 经 `app-launched` 清空 pastedText/query；重新输入 app query 后再由原版 ArrowDown/Enter 成功路径清空。两步 Escape、同路径 alias 的历史/固定/菜单流、七个事件通道及 dispose 仍通过。该 fixture 不打开 OS 进程，也不代表 Native 启动成功。

首轮 browser run `53a7dfdd-a86f-40cf-a545-ac714ee7d311` 因夹具在 Meta+F 产生 pastedText 后仍等待 app row 而失败；上游此模式进入内容匹配，原 Vue 行为正确，未为测试改动原 Vue。后续夹具在 pastedText 存在时通过绑定的 `window.ztools.launch` 先验证失败保留、再验证成功回执清空，随后另测普通 query 键盘路径。

在 R24 证据截点，真实自有应用成功启动→空载荷通知→清空/隐藏→历史/进程回收尚未执行，因此当时第一项和最后一项保持未完成，本票标记 in-progress。不能将 browser synthetic receipt 当作 OS 启动证据。R24 正式 Main JS 为 586447 / 586528 bytes，余量81；未调高预算。

## R25 macOS hidden Native 验收

最终 Native/Node run：`output/renderer-launch-return-native-2026-10-27/run-0410b9f349ba4a5aaa0358dbb17516a0/native-report.json` 与同目录 `report.json`。Native `passed:true`、`errors:[]`，七个阶段均为 `observed`；Node 独立验证通过。宿主进程 exit 0 且终止已观察，source/binary/build receipt 稳定；两个 owned app probe 均有 started/exiting marker，PID terminal，live probes 为0，owned root 和 bundle 清理完成。

真实隐藏原版 Vue 链通过生产 `launch_renderer_app` 管线：首次 deny 保留 pasted 内容，形成一条 Cancelled TaskRun/Denied audit 且没有 app-launched 事件；First 的真实启动成功通知 main Webview，原 Vue 清空 query/pasted 并由生产 hide 解锁；随后 DOM query 选择 Second 并通过原 Enter 启动，第二次 main-only null-payload 通知后再次清空/隐藏。最终共3条 TaskRun（1 Cancelled、2 Succeeded）、1条 Denied/2条 Confirmed audit、First/Second 各一条 history/use_count=1；两探针均退出。

每阶段 Native window 均为 hidden/unfocused，`focusGainedEvents=0`，WK store 非持久且无 child Webview/layout。报告中的 DOM `inputFocused:true` 仅表示搜索框仍为 `document.activeElement`；`documentHasFocus:false` 与 Native `window.focused:false` 仍分别通过。DOM KeyboardEvent/setter 是页面级驱动，不是物理键盘验收。`LSBackgroundOnly=true` 仅用于两个自有临时 probe app，宿主保持 `hostBackgroundOnly=false`；这不证明任意用户应用经生产 `open` 后都不进入前台，生产 `open` 行为未改。

本票完成仅覆盖 macOS 隐藏 Native 切片。完整可见 UI、默认入口及用户应用前台策略仍待验；主程序继续优先，Harris 原包插件后置。R24 pending 段保留为当时证据状态，不把 browser synthetic receipt 追认为 Native 证据。

## R25 前的隐藏启动验收准备（历史）

R25 前只读核对确认生产 `open_or_reveal_path` 使用原 `open <path>`，没有代码层禁止任意目标激活的保证；旧 launcher Harness 会 show/focus 主窗与辅助窗，不适合本次 hidden 验收。R25 按独立 hidden profile 保留生产 launch 管线，仅用两个自有 `LSBackgroundOnly=true` fixtures，并收紧 Node/Rust staging 校验；marker/liveness/owner 清理用于真实运行验收。R25 已证明这两个自有 fixture 的本次 hidden launch/return 路径，不扩展为任意用户 app 的 OS 激活策略保证。此节保留当时准备边界，不覆盖上文 R25 实际证据。

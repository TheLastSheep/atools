# 51：原版 Settings About 更新入口与自动检查接入

**What to build:** 在原版 Settings About 页面保留现有 template、CSS 和 logo，显示真实 ATools 版本，并让用户从原有手动检查与自动检查开关获得可恢复、与共享 updater 协调器一致的更新体验。默认 Svelte 更新入口和行为不切换。

**Contract:** [R79 Native/Core contract](../../../output/renderer-about-update-r79-2026-11-02/native-contract.md) 冻结三入口协议与生命周期边界；[R79 资源基线](../../../output/renderer-about-update-r79-2026-11-02/baseline.md) 记录事前预算；[当前进度与验收界限](../../../output/renderer-about-update-r79-2026-11-02/verification.md)。

**Status:** R79 scoped milestone complete（Root acceptance；r69 actual Native review 为 SCOPED PASS）。本票 broader product acceptance 与全局 goal 仍开放，不标记为整个更新/发布目标完成。

## Source status

- [x] About 源码从应用版本取值；保留手动检查、busy/error/no-update 反馈和可恢复操作。
- [x] 自动开关使用单字段 revision CAS；区分未保存、冲突、写失败与保存后 runtime 未生效。
- [x] Rust 实现应用级唯一调度器：enable 后立即检查、30 分钟周期、Skip 错过时隙；disable/Exit 阻止未来调度，不伪造取消已接受 worker。
- [x] Main 和 Svelte 的偏好只门控自动发现提示；手动反馈、安装/错误状态及 popup 保护独立。候选展示与 Settings Child close/navigation 代次竞态已修复。
- [x] Settings 当前 formal provenance 为 bd89bcfdd27b0c770b6823b0c43895d6048281f26fb6f49f7af37d146cb4757b；Rust production bundle loader 从 compiled source 绑定 provenance，fresh binary/receipt 与实际运行输入一致。

## R79 scoped verification

- [x] 各自 Native test filters：updater 90/90；Settings 198 passed、1 个原有 ignored；bundle/source binding 24 passed、1 个原有 ignored；About caller 4/4。不同源码阶段和过滤器不合计，不代表全 workspace 测试总数。
- [x] Default 与 `legacy-node-smoke,ztools-multiwebview` workspace `cargo check --locked --offline -j 2` 各 exit 0；日志与固定 before/after 输入见 [workspace checks](../../../output/renderer-about-update-r79-2026-11-02/native/workspace-check/verification.md)。
- [x] Settings formal artifact 独立 APPROVE：55 文件、JS 568,663 B、emitted 806,371 B ≤ cap 812,049 B；Main provenance 0a3f…、JS 612,530/614,004 B；Updater provenance cf49…未变。默认 Svelte 仍是默认入口（16 files/2,322,098 B）。About template/styles 与 16 个 CSS 资源不变；General 既有兼容模板变更保留。
- [x] 第四次 owned headless browser run `5b5a52ad-c033-46c6-9c29-4067113bea13` scoped PASS：synthetic transport，46 个来源文件稳定，console/error/diagnostic overflow 为 0，清理成功；不替代 Native/App/OS 验收。前三次 partial 保留原状。报告与限制见[执行回执](../../../output/renderer-about-update-r79-2026-11-02/browser/live/5b5a52ad-c033-46c6-9c29-4067113bea13/execution.md)。
- [x] 一次实际隐藏 Tauri/WKWebView Native About run `64444c8c02bb4278a4d0398ed4f1e3f3`，独立 r69 review 为 SCOPED PASS。11 个 stage、Root schema、wrapper/native reports 均 PASS、errors 空；版本 3.0.0，手动 fixture 返回 available 99.78.0。Native preference projection false→true→false，两次 receipt `runtimeApplied=true`、only-auto-field/sentinel 检查成功且关闭后 raw digest 回到初值。popup 在首个 Settings close 后仍存在，重开为新 Child，旧 Child 被拒；Destroyed=1、activeWork=0、cleanup 和 sourceStable 通过。完整报告见[Native execution](../../../output/renderer-about-update-r79-2026-11-02/native/live/64444c8c02bb4278a4d0398ed4f1e3f3/execution.md)。
- [x] Fresh binary SHA `1f0d97d485fba42eeb12401e2c7593fc0f369a5f19940ea0b8a82bdabfe55c5e` 与 receipt SHA `ece65ebbcb5a64699dd966873f169c3c09e4769b21eda217a96634fa73c4e9f2` 被实际运行绑定；独立核验见[fresh artifact review](../../../output/renderer-about-update-r79-2026-11-02/native/fresh-build/reviewer-independent.md)。

## Still open

- [ ] 实际 30 分钟运行、fake-clock/Skip/disable/Exit 的 Native runtime 与 timer 观测；当前 bounded Native run 报告 fakeClock=false、timerCount=null。
- [ ] 可见 Native 窗口、物理输入、Windows/Linux 和 default Svelte 的完整 Native 回归；本次窗口 `windowVisible=false`，输入为 `rust-injected-javascript`，不切换默认入口。
- [ ] 真实 SDK 签名下载、archive 安装、重启与网络更新；不在本票运行开发机真实更新。
- [ ] Harris 插件后续验证及完整 UI/全局 goal 继续开放；R78 scoped pass 保持原范围。
- [ ] 旧 Settings `134e…` full raw provenance JSON 未保存，因此没有精确旧正式 artifact 的 Native caller 拒绝反例；保留为历史证据缺口，不由新 artifact/新 Native PASS 追溯填补。

Native wrapper `stderr.log` 为空，但 Native child stderr 为 314 B，SHA `bd2913b53a336d83f9fc85eed0533d134f529d27e3de23e71160de3a630cf15f`。CAS direct write、listener 和 timer counts 为 null/未直接观测；popup 可见性为 false，不记为可见 GUI 验收。About template/CSS/logo 未改；R79 scoped pass 不等于整票、发布或全局 goal 完成。无提交、推送或 Claim。

# 20：Node 外部程序的独立进程组回收

Status: implemented，macOS ARM64 / 产品 Node 22.23.3 的生产会话切片通过。总体目标仍是完整 ZTools 能力对齐，不以本票探针通过或源码检查代替实际插件稳定使用。

Task19 的原 Format Converter 调用链暴露：Unix `runProcess` 使用 detached:true，CLI 因而另起进程组；生产 Rust sidecar 回收当前 Node 所属组，bootstrap 尚未登记这些独立 helper。

主 Agent 已独立运行真实 `LegacyNodeSession` 探针，产品 Node 22.23.3：root PID/PGID 51111 在 stop 返回后状态 Stopped、kill0 为 ESRCH；helper PID/PGID 51114 仍 present，独立于 root 组。helper 自带 2.5 秒计时器，未收到手工信号，随后在 2505ms 等待内确认 ESRCH。断言放在确认最终退出之后，因此红测没有留下该 helper。

证据：`output/detached-helper-repro/cargo-test-main.log` 与 `detached-51057-1792837523059133000.json`。显式 ignored probe 为 `crates/atools-plugin/tests/legacy_node_detached_spawn_cleanup_probe.rs`；现有 descendant 测试覆盖 detached:false 同组程序，不能覆盖本问题。本票仅验证当前 macOS / product Node，不是 App 或其他平台验收。

后续修复必须保持原版转换的运行、错误、取消语义，同时确保 owner 关闭、sidecar 崩溃与强制终止时仍能确认子程序退出。不得凭可复用旧 PID 猜测杀进程，也不得将原 detached:true 静默改为 false 后宣称兼容；需要先明确受管进程契约与审查生命周期接口。

另有源代码级待复现项：EventEmitter.on 回调长期保留、快速 error/close 早于跨进程监听注册、输出队列与 RPC 放大。它们尚未被本票的 detached helper 红测证明，分别保留证据层级。

2026-10-24：已实现 Rust 创建并持有 detached helper、Node 保留 ChildProcess 接口的兼容路径，使用私有双 AF_UNIX 通道。保留原 detached:true；退出后只读确认进程组消失，未确认时严格失败且不释放 helper 配额。每 owner 4 / 全局 8 的配额在 IO 与 actor 收尾后释放，输出/输入队列及 PID 历史有界，没有新常驻 Node 或转换引擎迁移。

主 Agent 已独立把原泄漏探针跑绿，并用字节不变的 Harris 原 runProcess 证明 helper 的 PPID 是 Rust host，核对输出、非零退出和超时终止。真实会话还覆盖原 stdio、stdin、ENOENT、单 child kill、root crash/drop、socket/env 不继承及 exit 后读输出。后者实跑发现并修复晚到 credit 被误报 closed 的竞态。最终统计与完整边界见 [主验收记录](../../../output/managed-node-children/verification.md)。

本票没有运行桌面原生交互，也没有解除 Office 正文定位标记、Live Markdown files 入口、800KiB 容量、其它平台及所有 Harris/ZTools 插件的剩余验收。

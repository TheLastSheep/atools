# 01: Node 启动、配额与退出回收

**What to build:** Harris 原版插件在按需启动 Node 时，能可靠启动、复用和关闭其拥有的运行时；启动、取消和宿主关闭不会遗留本次拥有的 Node roots、请求或悬挂中的 TaskRun，失败/取消结果仍持久化。

**Blocked by:** None (can start immediately).

**Status:** in-progress（运行时切片已验收；用户已要求暂缓原生启动超时排查，继续 Harris 业务）

- [x] 复现并修复 Agent 入口检查期间取消、满命令队列 Drop 回收、临时 listener 锁竞争清理；旧 startup abort 测试改用真实 child 已出现且 open 仍 Pending 的确定性观测。
- [x] Legacy Node 兼容会话的根进程在 starting、running、stopping 阶段共享四槽预算；真实第四个 child 取消后、尚未退出时第五个被拒绝，退出后恢复容量。该结果不代表全应用进程树测量。
- [x] 运行时相同 owner/plugin/document/version/path 重复 open 复用、不同身份隔离、待授权零启动、关闭后根进程与 listener 清理通过定向用例；完整 UI prepare 链路仍待原生业务验收。
- [x] 一次有区分性采样假设的原生 App 尝试复现 initialize_response 超时；对应失败 TaskRun 已终态、诊断关联验证通过，最终 legacy sessions/openings、pending requests/resource leases 为 0，transport 关闭；App 和 owned Node 的两个精确 PID 均以 ESRCH 复核退出。该证据只覆盖本次失败回收，完整辅助进程树仍未知。
- [ ] 原生 App 的 initialize 偶发超时仍待定位；完整成功/取消流程、实际权限 UI、连续 UI 打开关闭仍须验收，不用重试掩盖失败。新增尝试在 5ms 写完请求、1507ms 超时；外部 sampler 未找到 LaunchServices 实际目标，未取得有效栈，本切片不继续重跑。
- [ ] 将引擎辅助进程单列记录，不计入 managed Node roots；实际原生证据与模块证据分开报告。
- [x] 源码修正：移除无条件阻断 `ExitRequested` 的宿主逻辑，保留主窗关闭隐藏；分离窗销毁接入共用资源清理。交接/取消、生产激活及 host runtime 共 106 项测试通过，1 项既有原生用例忽略；工作区编译通过。此项只确认源码和宿主策略，不代表真实退出回收通过。
- [ ] 实际托盘退出、Dock Quit、原生分离窗领取/取消/销毁及所属 App/Node 进程树归零待验；本切片未启动 App，不重跑已跳过的 initialize 超时。

本轮47项不同的定向测试通过，包含真实固定 Node 22.23.3；工作区含 legacy-node-smoke 的编译检查通过。证据：`output/harris-plugin-first-2026-10-23/p0-node-lifecycle/README.md`。

后续原生失败回收与完整 Harris preload 模块合同证据：`output/harris-plugin-first-2026-10-23/p0-node-startup/verification.json`。初始化默认预算仍为 1500ms。

窗口交接、偏好设置和退出策略源码修正见 [独立验收记录](../../../output/harris-plugin-first-2026-10-23/plugin-window-preferences/README.md)；该记录保留真实桌面与原包业务未验边界，任务仍为 in-progress。

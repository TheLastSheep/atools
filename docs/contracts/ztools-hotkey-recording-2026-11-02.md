# R71 原版设置快捷键录制

工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`。上游固定 `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。

## 用户行为与范围

原 General 的 HotkeyInput 保留普通组合键、F 键与双击修饰键的 DOM 录制。补齐宿主对 Option/Alt+Space 的临时录制，使系统快捷键不会在录制中误触发主窗。双击修饰键的全局执行属于后续任务，本批不把 DOM 录制等同系统执行。

成功、普通 DOM 确认、取消、组件卸载、路由离开、Settings 关闭、主窗隐藏、窗口销毁、主键变更和进程退出均结束临时录制；30 秒期限释放空闲录制。期限结束时原控件停止显示录制中。物理键仍按住时仅保留一个抑制重复的 handler，释放后清理；这不是继续录制，期间会删除该 handler 的主键变更明确返回 busy。进程退出强制清理且不再允许重启录制。原 Vue 模板/CSS 保持，必要脚本兼容补丁纳入来源校验。

## 传输与所有权

- 沿用 `call_renderer_settings` 身份验证，新增 `startHotkeyRecording` / `stopHotkeyRecording`，参数严格为 `{generation}`，范围为正 JavaScript safe integer。
- 回执严格为 `{version:1,sessionId,generation,active,mode}`；active 时 mode 为 `borrowed-main` 或 `temporary`，inactive 时为 null。失败使用已有 Native 错误通道，不以未注册假成功。
- 通过当前 Child 的 `__ATOOLS_SETTINGS_DELIVER_HOTKEY__` 定向交付；不广播键盘事件。
- 记录事件：`{version:1,sessionId,generation,status:'recorded',shortcut}`。shortcut 在 macOS 为 `Option+Space`，其它平台为 `Alt+Space`。
- 非输入终结事件：`{version:1,sessionId,generation,status:'stopped',reason}`，reason 为 `timeout`、`cancelled` 或 `unavailable`。前端提供内部可取消的终结订阅，仅补丁使用。
- 每个 session 的 generation 单调递增；stop tombstone 拒绝同代迟到 start。旧 session/代次/重复事件不影响当前录制。先失活再通知回调，处理事件早于 start 回执的情况。
- 复用既有 hotkey operation gate。已 owned 的 Main AltSpace 只借用事件路由，不注销主键；其它情况只注册一个规范化的 AltSpace，冲突明确失败，绝不注销不属于此 lease 的键。
- Pressed 以同一原子状态转换 claim 当时代次，只消费一次并吞掉同次重复；Released 后异步清理、释放 operation gate，再投递录制结果。与上游全局回调的按下即通知相比，这里统一到原 DOM 的按键释放确认时机，以保证不依赖已经注销的 handler 继续提供 Released。主键更新先撤销录制并确认清理，不回放旧 checkpoint 覆盖新配置。
- 项目锁定的 global-shortcut 2.3.1 在持有内部 map 锁时同步调用 callback。callback 只执行有界原子 reservation/异步调度，不同步查询注册、注销、获取 operation gate 或交付 Child；实际清理在回调返回后进行。
- cleanup 失败保持可追踪的占用与错误，不把状态清空当系统注销成功；同会话可重试。失去 session 授权立即禁止投递。

## 前端生命周期

独立 controller 管理 generation、请求、原生事件与可取消订阅。原组件 start 的 await 返回时必须仍 mounted、处于相同录制代次，才装 DOM listener；停止可先于 start 回执。原生 start 不可用时继续原 DOM fallback，保存仍走已有 General CAS/owned-main 流程。

DOM 确认先等待 Native stop 确认，再 emit change 进入原保存；失败不保存。等待期间若卸载或开始新录制，旧确认失效。已确认的 native recorded 无须重复 stop RPC。start/交付均检查父窗可见；隐藏失效代次阻止跨 hide/show 的旧 start 复活。

同一 Child 同时只允许一个 HotkeyInput 组件拥有录制。开始新组件先结束旧组件；旧组件的迟到卸载/stop 不得取消新组件，多个挂载实例不得同时确认同一原生事件。

## 性能与验证

- 不加运行进程、任意全局键流监听或常驻轮询；最多一个临时 key、一个录制 deadline、一个目标 Child。
- Main 产物保持 604426 B。Settings 从 798892 B 起，先执行既有 800742 B 门槛；新增功能预留的最大增量为 3072 B。仅在正式测量及等价收敛后必要时显式登记新里程碑，不隐藏旧门槛失败。
- 定向测试覆盖真实状态机与失败行为：借用/临时/占用，重复与迟到，stop-before-start，主键变更，清理失败，通知失败，过期和退出；前端覆盖 start 卸载竞态、订阅移除、早到与重复事件及 DOM fallback。
- 原版组件和正式 Settings 构建通过后，由非实施者复核实际 diff。共享 Rust 默认/多 WebView 编译必须通过。
- mock/合成输入不等同 OS 热键或物理键盘验收；实际注册/恢复、可见原生输入及跨平台行为分别记录，未取得证据不得关闭整项目目标。

首次正式构建测得 801647 B（较原 798892 B 增 2755 B），超过旧 800742 B 门槛 905 B，失败及旧正式产物均保留。完成重复 stop 去除后仍需新增录制协议、单控件所有权与生命周期代码，因此按事前 3072 B 增量上限登记 `original-vue-hotkey-recording-settings-2026-11-02`：基线 798892、增量上限 3072、总量及绝对上限 801964。不是把本次测量值直接设为门槛；Main 不变，运行时内存/时延不由此数字证明。

## 派单

Sol Native worker 独占相关 Rust 实现及测试；Sol renderer worker 独占 Settings bridge、脚本兼容补丁、前端测试及构建来源文件。Root 负责合同与最终验收，Terra 独立审查。禁止同文件并发写；保留已有 dirty；不提交或推送。

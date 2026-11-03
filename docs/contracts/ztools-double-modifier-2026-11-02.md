# R73 双击修饰键呼出

工作区 `/Users/harris/Desktop/atools`；开发分支 `codex/atools-ztools-parity`；固定上游 `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。

## 用户行为

接通原 HotkeyInput 已能录制的双击修饰键值，使 macOS 主呼出快捷键支持 Command、Ctrl、Option/Alt、Shift。普通快捷键与双击键共用原 General 保存、原子更新、失败恢复、冷启动恢复和退出回收。保持原版模板与样式。

以固定上游 `doubleTapManager.ts` 为行为依据：同一逻辑修饰键两次释放间隔严格小于 400ms；按上游共享的 modifierDownTime 判定超过 300ms 的长按，左右键归一化，Option 与 Alt 同义，非修饰键 down/up 分别按源码处理；第二次释放确认后只触发一次。用单调时间，显式处理重复、缺失边沿、未知初始状态和停止后的重置，不因无完整输入事实而制造 tap。

完整已观察的输入序列以实际固定上游算法作差分依据，不能自行改成更严格的规则。例如 LeftCmd down=1000、RightCmd down=1001、LeftCmd up=1010、RightCmd up=1400，上游第一次 up 清空共享计时后，仍会因两次 up 相差 390ms 而触发；本批保留该行为，不改成每侧独立的长按计时。未知初始、缺失 down 或重复 up 的完整性 guard 单独记录，不把它们混同正常左右交叠。

## 运行边界

- 本批实现 macOS 原生后端，其它平台明确拒绝且不保存虚假生效状态；Windows/Linux 完整目标继续保留。
- 使用本进程 `CGSessionEventTap` 的 listen-only 通道观察 modifier 边沿及非 modifier 干扰，不拦截按键、不保存键盘内容。仅选择双击快捷键时启用，最后租约和退出释放；无新增进程或轮询。
- 不采用只靠 NSEvent global monitor 的方案：Apple 文档明确该通道不能观测 Command-Tab 等事件，不能证明上游的干扰重置语义。参考 [Apple Monitoring Events](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/EventOverview/MonitoringEvents/MonitoringEvents.html)。CGSessionEventTap 的真实覆盖仍必须单独验收，不能由 API 存在推定。
- 读取监听权限并检查创建结果；不自动请求、授予或修改系统权限。初始已按住、tap 停用、睡眠恢复或聚合 flags 与边沿状态不一致时，失活/重置并等待可靠的全释放基线。侧键使用 SDK 命名 keycode，不猜测设备私有 flag 位。
- 无权限与平台不支持仅在确认未改资源时返回 `SETTINGS_HOTKEY_LISTEN_PERMISSION_REQUIRED` / `SETTINGS_HOTKEY_DOUBLE_TAP_UNSUPPORTED`；前后端都按已知未修改处理，并显示明确提示。部分创建或清理未知继续保留原不确定结果与恢复边界。

## 共享所有权与录制

将现有 owned Main binding 扩为 accelerator / double modifier，保留同一 registry、generation、snapshot 和 operation gate。候选取得、旧资源释放、SQLite 提交及回滚沿现有事务，不建立第二个 Main 配置存储。

资源身份与健康状态分开读回；恢复不能仅以 lease 尚存判定成功。原 healthy checkpoint 须确认恢复健康，原 inactive checkpoint 保留其状态并允许显式重试或改普通键。恢复未知保留待清理身份、禁止错误派发；previous-shortcut 入口在同一 gate 中按 owned 身份做 CAS。UI 以 active 状态投影，不清空持久配置来掩盖失效；启动时的已知权限/平台拒绝进入已有恢复路径。

OS callback 只做有界检测和异步派发；排队的窗口动作必须拒绝已撤销或被替换的租约。不能在回调或主线程排队动作中阻塞等待正被安装/移除流程持有的锁。

R71 的 borrowed-main 只适用于真实 owned Option/Alt+Space accelerator。Main 为双击键时，Option/Alt+Space 录制仍为 temporary；主键变更继续遵守 held-drain 取消和 busy 拒绝。取消、权限拒绝、tap 创建失败、旧租约释放失败及 DB 提交失败不得误改旧配置或遗失资源所有权。

双击窗口动作按原版 visible AND focused 判定隐藏，否则显示。仅显示分支设置 350ms 的自动 blur-hide 抑制，以单调期限检查实现，无常驻 timer；到期恢复普通失焦行为，显示失败还原先前期限，显式隐藏不被此期限拦截。

## 验证与预算

- 检测器与标签：300/301ms、399/400ms、左右交替、重复/缺失边沿、其它键、不同 modifier、reset、时间回退；保留旧普通 shortcut 拒绝规则。
- 宿主：普通↔双击、双击↔双击、权限/平台拒绝、候选创建与旧释放失败、DB 回滚、启动恢复、迟到派发、R71 temporary/borrowed 及退出回收；先定向，再默认/实际 feature workspace 检查。
- 原前端：两个拒绝错误的提示、回滚、后续重试与原普通输入；不把错误映射或纯 detector 单测当实际全局按键证明。
- Main 正式资源保持 604426 B。Settings 基线 801929 B，先测既有 801964 B 门槛；必要时按既有显式 milestone 机制登记本功能最多 1024 B 增量，总量上限 802953 B。保留旧门槛失败，不删校验来压体积。
- 实际系统授权、前后台双击、Command-Tab / Secure Input / 系统警告、左右交叠及跨平台仍需对应系统证据。CUA 已确认失效，本轮不重复 GUI 调用，也不扩用旧 AppleScript 授权。

普通独立复核由 Terra 执行；跨后端所有权、事件监听生命周期和事务恢复交 Astra 作限定审查。所有新作者文件不超过 500 行，无 Git 提交或推送。

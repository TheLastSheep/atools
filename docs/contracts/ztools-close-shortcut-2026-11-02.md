# R74 关闭插件快捷键与原生关闭路由

工作区 `/Users/harris/Desktop/atools`；开发分支 `codex/atools-ztools-parity`；固定上游 `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。本批承接 R69 的内置快捷键与 R71/R73 的录制、主呼出资源所有权。

## 用户行为和范围

原 ShortcutsSetting 的 Cmd/Ctrl+W 开关默认开启。开启时，原版 Main 所属窗口中的关闭动作在 Settings 会话内返回搜索，在搜索态隐藏窗口。关闭开关后移除该窗口的原生关闭快捷键，让按键到达页面；原 HotkeyInput 可以录制 CmdW，不增加第二套录制接口。开关开启时录制不享有额外豁免。

窗口关闭请求独立于快捷键开关：原版 Settings 活跃时沿正常 child-out/outAck 清理并返回搜索，搜索态隐藏。窗口关闭、显式菜单关闭和真正退出分别处理；标准 CmdQ/Quit 保持真正退出。关闭后台或隐藏窗口不得强行置前。插件退出后保留上游 100ms 防重复隐藏期限，使用单调时间检查，无常驻 timer。

依据固定上游 `windowManager.ts` 的 before-input-event 与 close 处理。其源码不能单独证明 Electron/macOS 菜单的实际行为；本批不得据此声称已做上游或 ATools 的系统按键验收。

当前仅实现 macOS 原生菜单后端。Windows/Linux 的 CtrlW 后端未实现，必须明确拒绝 native 设置操作；不得保存虚假的“已生效”。Windows 原生 Alt+F4 保留。Svelte 默认入口与现有行为保持；完整原版 UI 和跨平台目标不缩减。

## 设置、所有权与事务

- 既有严格 DTO 扩为 `{search, esc, closePlugin}` 三个布尔值；缺失 closePlugin 按 true 读取。Settings Child/frontend 的单次 patch 只允许三个已支持键之一；Core 保持旧 General 保存允许非空受支持布尔键集合的行为，加入 closePlugin 后合法组合仍可写。两层均拒绝 killPlugin 与未知键写入。
- Core 嵌套 CAS 保留其它内置键和未知字段。复用 General 保存、事件、失败后重读和原控件回滚；已接受事件胜过迟到的启动读取。
- 原版 Vue 模板和样式不改，只调整脚本兼容层和宿主 adapter。平台是否支持由 Native 决定，前端不另建平台能力判断。
- 菜单投影以已提交 General 状态为依据，只保留应用状态与代次，不成为第二份配置。Renderer patch 与旧 General save 都经同一协调锁处理；读实际状态、应用候选、DB CAS、失败补偿共享事务。焦点更新不得重读旧 DB 覆盖进行中的保存。
- `SETTINGS_CLOSE_SHORTCUT_UNSUPPORTED` 只用于确认未修改资源的平台拒绝；`SETTINGS_CLOSE_SHORTCUT_REJECTED` 只用于确认未修改或完整补偿恢复的拒绝；恢复不明保留 `SETTINGS_NATIVE_RECOVERY_FAILED`。前端分别显示固定提示并恢复实际配置。

## 原生菜单和关闭入口

Tauri 2.11.2 / muda 0.19.2 默认 macOS File、Window 菜单各有一个 CmdW Close role。generic CloseRequested 已丢失按键/红按钮来源，不能把开关直接套在此事件上。

受控默认菜单工厂为两处 Close 各保留 native、custom-CmdW、custom-no-key 三角色句柄、父 submenu 和 root 身份；保留其余 App/Edit/View/Help/Quit 行为。原版 Main 获焦时按开关在两种 custom 角色间局部交换，显式菜单点击仍可关闭；其它 ATools 窗口获焦恢复 native Close。锁定 muda 0.19.2 的 macOS `set_key_accelerator(None)` 只改缓存字段、不清实际 keyEquivalent，故不得依赖该 setter 撤销快捷键。两处交换的部分失败仍需读回并补偿。Svelte 使用原默认菜单。manual fixture 不覆盖已安装菜单。

只修改自有槽位，禁止按标题或随机 predefined ID 猜测；未知菜单/root/slot 被替换时拒绝且保留外部状态。原生读取按验证后的所有权和当前 index 定位 AppKit 项，核对实际 action、keyEquivalent、modifier 以及 root/parent/item 的实例身份；同 ID、同属性的替换也必须拒绝。身份对象保持足够的强存活，避免释放后地址复用误认，自有交换后显式更新绑定；释放遵守主线程要求。不读 muda 私有字段，也不以 Rust 缓存替代实际读回。

动作执行时重查焦点、owned host/session 与代次，拒绝旧 session 的迟到动作。Settings 的合法路由均支持关闭，不复用仅允许 General 的 R71 target 判定。沿现有 close_session 清理录制、Child、材质、布局、pending 请求与 outAck；100ms 期限在统一的成功完成点更新，包含既有 child-out/escape，失败和旧会话迟到完成不更新当前期限。重复关闭合并，旧会话关闭不能影响重开会话。原生主线程/事件回调不等待会造成锁反转的协调锁。

不新增每次按键 IPC、全局热键注册、键盘监听、常驻进程或轮询。

## 验证与预算

1. Core：默认值、合法单键/多键集合、旧字段保留、CAS、非法/kill/未知键拒绝；Child 多键拒绝独立验证。
2. 原前端：完整原 ShortcutsSetting DOM 保存、重开、失败和平台拒绝恢复，原 HotkeyInput CmdW DOM 录制，事件/启动先后顺序，search/esc 与 kill 拒绝回归。DOM 合成按键不是 OS 菜单验收。
3. Native：两处菜单槽位和实际读回、focus 投影、关闭 Settings/搜索/隐藏后台、跨会话迟到动作、100ms 防重复、Svelte/其它窗口隔离、失败补偿与退出；默认和实际 `legacy-node-smoke,ztools-multiwebview` 工作区检查。
4. Main 基线 604426 B、既有上限 606381 B；本功能不提高 Main 上限。Settings 基线 802330 B，先用既有 802953 B 门槛；确需增量时最多 1024 B，显式 milestone 上限 803354 B。保留旧门槛失败与实际构建，不删功能或校验凑体积。
5. 普通前端/Core 由非实施 Terra 复核，菜单/关闭生命周期和事务交 Astra 限定审查；审查绑定最终冻结 after、实际 diff 和源哈希。作者文件不超过 500 行。

真实 macOS 菜单点击、CmdW、红按钮、设置录制与前后台行为尚需系统证据；Windows/Linux 后端明确未实现。CUA 已重复失效，本批不再启动 GUI 验收，不扩用旧 AppleScript 授权。无 Git 提交或推送。

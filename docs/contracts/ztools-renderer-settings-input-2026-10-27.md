# R27：原设置页 SubInput 与只读状态

R26 为 progress，整体目标 active。开发工作区 `/Users/harris/Desktop/atools`、分支 `codex/atools-ztools-parity`、HEAD `c34789c0e3d19b3bf7c05d396540d891ff126abc`。只读 ZTools 固定 `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。Root 定接口/派单/独立验收，Luna 实施且不派生代理；保留已有改动，无 staging/commit/push、用户 app、CUA/AppleScript 或 foreground 操作。

依据本轮三个 source-review 及 R26 原 DOM 的真实错误。保持原 Vue/CSS 与 Tauri + Rust + 按需 Node + SQLite。插件执行后置；本票是主程序原 Setting 页的真实数据与输入接线，不新增 Node、轮询、应用依赖或任意 namespace 权限。

## 资源与文件归属

R26 固定基线：Main 全 JS 587945 B，绝对上限589824 B，仅余1879 B；不能抬高或删原页面/字典/诊断过门禁。Setting 全资源771693 B，本里程碑明确重新分配增量8192 B（有效上限779885 B），既有绝对上限786432 B不变；这是新的增量门槛，不宣称旧门槛未变。旧 manifest/provenance 存入本轮 output。Root 最终实测两份正式 dist，不把字节数当 RSS/时延证明。

Main hostAdapter477行、Child bridge459行、Native session runtime464行，均只能留小接线；新增行为放有意义的模块，必要时先抽出真实独立职责。每个作者代码文件≤500行。Root 独占 public mod hooks 与两个 source-manifest；不同 Worker 不写同一文件。Root 独占 Cargo、正式构建和实际浏览器/桌面运行；自测只能用产品 Node绝对路径，不用系统node/nvm/npx/.bin。

## 只读命令设置

新增 child operation `readCommandSettings {}`，复用 R26 page envelope，kind 固定 `commandSettings`；`readCommandDataPage` 接纳该 kind。固定只读五个 Native key：

```text
ztools-renderer:disable-commands
ztools-renderer:pinned-commands
ztools-renderer:super-panel-pinned
ztools-renderer:global-shortcuts
ztools-renderer:app-shortcuts
```

Native 用现有 Core `read_settings_bounded` 从一次事务捕获，caller 不提供 key。JSON document 恰有上述去 prefix 的五个键，值为原数组或 null；null 只表示查询确认缺失。SQL、非法 JSON、错误根类型或超限使整份快照拒绝。不得把异常当 []，不得查询用户 DB 来造 fixture，也不把 Svelte `targetCode` 静默改成上游 `target`。Main startup 14-key 快照不扩张；既有 Svelte shortcut model 保留，迁移和执行另验。

每 raw key≤128KiB、raw 合计≤640KiB、每数组≤4096行、最终 serialized snapshot≤1MiB。disable array 为有界 command ID 字符串；其它数组为 JSON object 记录，保留未知字段，单行仍受 raw key 上限约束。super-panel folder 的 items 若存在并参与展开，只展开一层且展开后总记录≤4096；非法参与记录拒绝，不截断。R26 request≤32KiB、raw page≤32KiB、actual reply≤64KiB/token/session/bundle/close 清理保持。一类最多一份 immutable snapshot，重复大读必须能重新完整分页；每页不重读 DB。

Child 同类读取 singleflight，完整解析后给每个 caller fresh clone。`internal.dbGet` 对五个键走该快照，其余保留 R26 alias/General 分流；`internal.getSuperPanelPinned()` 按原版 `isFolder && Array.isArray(items)` 展开一层，只有已确认 null 才转 []。五项写入、pin/unpin、禁用与快捷键执行本票不开放；未实现操作继续明确拒绝。`builtinAppShortcutsEnabled` 不是本快照的隐含第六键，不伪造运行时开关。

## SubInput 状态与接口

SubInput 只属于唯一当前 Native setting session。语义复用已有插件 reducer 的 generation/sequence/关闭原则，不直接复用 iframe postMessage。值只在内存，不进日志、DB、TaskRun 或长期记忆。text≤16KiB UTF-8、placeholder≤512 B；请求实际 JSON≤32KiB，所有计数为正 safe integer（valueVersion 可为0），不能回绕。

Child operation `updateSubInput` payload：

```text
{action, generation, sequence, placeholder?, focus?, value?}
action = set | remove | value | focus | blur | select
set: placeholder string, focus boolean；其它多余字段拒绝
value: value string；remove/focus/blur/select 无额外业务字段
reply = {version:1, generation, revision, valueVersion, applied:boolean}
```

Child 全局最多一个 callback。set/remove 递增 generation，所有 control 递增 sequence；每个 session 串行、有界（最多32项含在途）处理，不把旧调用重基到新 owner。队列拒绝也可能消耗本地 generation；因此 Native 对 set/remove 接受严格大于当前值的 generation，不要求恰好加一，其它动作仍须匹配当前 owner。remove 立即清本地 callback，Native 隐藏但保留当前文字；set 替换 owner，placeholder 空字符串使用“搜索”，focus 默认 true。set 时用 Native 当前 value 同步父框和新 callback，使跨 route 的显示与过滤一致；初值随后由原 hook 的 setSubInputValue 正常覆盖。value 不凭空创建可见输入，按原顺序更新 Main 文字、回声 `{text}`、请求 focus。

保持 set/remove/value 的 Promise<boolean> 形状；异步失败有明确反馈并返回 false，兼容原 hook 未 await 的调用时不制造 unhandled rejection。focus/blur/select 保留同步 boolean 的本地有界准入语义，Native acknowledgement/失败单独观察，不谎称同步 OS 焦点已成功。focus/select 的实际目标是父 Main Webview/原输入，blur 的实际目标是当前 setting child（上游正是聚焦调用方 WebContents），不开放任意窗口。

Native 输入状态持有 generation、revision、valueVersion、control sequence、user sequence、visible、placeholder、value。set/remove 切 owner；valueVersion 在同 owner 的程序设值时递增，用于拒绝在旧程序值之前排队的用户输入；focus/select 不使有效用户文字无故过期。Native revision 对所有已接受变化单调递增。过期 generation/sequence/版本、已关闭及错误 caller 拒绝；不持同步锁跨 Tauri focus/eval/emit。

沿用现有 config 格式：sessionId 为32位小写hex，bundleRevision 为64位小写hex SHA256。Main 的实际 adapter snapshot 必须暴露嵌套输入诊断（长度/计数/状态，不带输入或placeholder原文），不能仅有测试私用 accessor。

## Native → Main：复用同一 Settings view 订阅

沿用 targeted `atools://renderer-settings-view` 物理通道，保留原五种 lifecycle phase 和其 payload 不变。数据事件用独立 discriminant，不伪装第六种 lifecycle phase：

```text
{version:1, kind:"subInput", sessionId, bundleRevision,
 generation, revision, valueVersion, action,
 visible:boolean, placeholder:string, value:string, focus:boolean}
```

Main 的 settingsView client 复用已有 callback registry/唯一 Native listener，把此数据分派给独立 input 模块；不加常驻订阅或重复 lifecycle listener。仅当前/正打开且非 retired、非 closing 的 session 可以暂存，最多一份 pending packet，opened 后重放；旧 session 不得覆盖新 session pending。所有包严格校验后再变更缓存。关闭/返回/dispose 清待处理输入与 deferred focus；focus/select 以 microtask 后再次核当前 owner/revision，防同轮 remove/close 后抢焦点。

接通原五个 callbacks：`onUpdateSubInputVisible(boolean)`、`onUpdateSubInputPlaceholder({placeholder})`、`onSetSubInputValue(string)`、`onFocusSubInput()`、`onSelectSubInput()`。set 时顺序 visible→placeholder→value同步→可选focus；remove 只隐藏；value 设值后focus；blur 无虚构的 onBlur callback。原五种 lifecycle callbacks/API 名称及其顺序继续保留。所有能力标 limited，保留异常/过期/待决诊断，不靠删除诊断减字节。

## Main → Native → Child

新增 Main-only `notify_renderer_settings_input`，只接受：

```text
{request:{sessionId,bundleRevision,generation,valueVersion,sequence,text}}
```

Main 原 API `notifySubInputChange(text)` 单向；同 JS tick 合并，最多一个 Native invoke 在途及一份 latest pending，不建每键无界队列。Native 校验实际 Main root/window 和唯一当前 setting session、bundle、owner、程序值版本及递增 user sequence，不能由 main 参数指定任意 child。拒绝后不自动重试旧输入；正常 input / compositionend 送最终值，IME 中间态不额外发送。

该 Main command 回执与 control 共用 `{version:1,generation,revision,valueVersion,applied:boolean}`；只表示 Native 接受并排队了定向回声，不冒充原 DOM callback 已完成。错误仍明确拒绝。

Native 定向到现有 child 私有 `__ATOOLS_SETTINGS_DELIVER_INPUT__` hook（由 bridge.attach 安装），不为 child 开放 generic event/core/plugin 权限：

```text
{version:1,sessionId,bundleRevision,generation,revision,text}
```

Native eval 必须使用安全 JSON 编码并覆盖引号、换行/Unicode与脚本样式字符串；仅当前 child，eval 成功只是排队事实。Child 核 injected config、generation、单调 revision、live/out/dispose 后才调 callback `{text}`，异常不外泄文本。Native set/value 也走同一回声路径。bridge out 先停止输入模块再触用户 out callbacks；dispose 恢复原全局 hook、拒绝未决调用、丢迟到回声，不能让卸载旧 owner 重新显示新输入。

## 分工与验证

1. Native fixed reader + R26 buffers：独占 command_settings 与 command_data/buffers；不碰 session/commands/lifecycle。
2. Native input：独占新 input 模块及 session/commands/cleanup 必要接线；不碰 command_data/buffers、Core 或 TS。Root 加 mod hook。
3. Main adapter input：独占 settingsViewClient、新 input 模块、hostAdapter、types/event metadata与相关测试/fixture。保持≤500行，预算不足先报告具体实测。
4. Child input/读模型：独占 child bridge/API/types/新模块、Node transpile helper与对应 component/fixture 测试。不改原 Vue/CSS 或 General 写语义。

Root 先定向检查、strict、正式构建/预算，再原页面浏览器验收。使用原 Main 输入和原 Setting 过滤链，不能只在 child 注入文字回声而声称父框已验。测试先观测 DOM 和路由，沿用 R26 已确认的保存文案、`_t` hash 参数、真正 reload、悬停及过渡结束后的命中；不再猜 selector。原 UI 无新动作时五项读取和 SubInput 不应报未支持；未做的编辑操作仍明确列出。

浏览器 synthetic、Native unit/真实 SQLite、Tauri GUI/物理焦点三层独立记录；不据绿 unit 宣称整体验收。原 hook timer/IME 潜在问题如未实测仍属未验证；只有实际复现需要的改动才另定界。默认 Svelte 不切换、插件/Harris后置，整体目标不缩成这一个切片。

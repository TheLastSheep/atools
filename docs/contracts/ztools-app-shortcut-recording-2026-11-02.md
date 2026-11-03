# R80 原版 Shortcuts 录制合同

本合同是当前实现边界，不是通过证据。仅 Sol、Terra、Luna 实施/复核；主 Agent 验收。工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`。保留原模板、CSS、General 录制合同与默认 Svelte。

## 行为与资源

- Shortcuts 单编辑器录制：一次 start、至多一次 stop RPC，stop 在途去重；没有逐键 RPC、新进程、全键 tap、轮询或第二个常驻 worker。
- 录制可捕获当前实际 owned App 全局键（最多 64）和确证 owned Main AltSpace（最多 1）。其它普通键继续使用原 DOM 录制；Native start 失败时整个 Shortcuts 录制失败，禁止静默 DOM fallback。
- 暂停 ATools 的其它 owned FeatureCode、Main（含 double modifier）、Paste shelf/stack 派发。它们不产生 captured notice，但仍保持按住/释放 tombstone。外部应用快捷键不在捕获或暂停保证内。
- capture 槽最多 65；其它 owned registration 的 suppression 槽最多 132（FeatureCode 上限 128、Main 与 Paste 的窄剩余额度）。超过实际容量 start 明确拒绝。注册身份来自真实成功 receipt/owned callback 及其注册代次，不靠配置或 SDK is_registered 推断。
- 所有受管回调先处理可信 registration identity 的 Pressed/Released，取消、超时后按住的键仍吞重复 Pressed，直到真实 Released 或确认该 owned handler 已撤下。不能通过计时清零 held。
- start 与实际 action admission 共用短同步状态仲裁。正在执行的 action 有 owned permit；start 遇到已接受工作返回 busy。SDK/DB/UI/异步工作都在锁外，permit 直到真实 terminal；仅检查 epoch 后再执行存在时序窗口，不能作为最终 admission。
- 待派发工作携 pause epoch，worker/主线程 action 前重新 admission；start 清理未接受旧队列。double modifier 在暂停边界 rebaseline，禁止跨边界拼接双击。
- 注册集合变更与录制 start 使用现 OS operation lease 定序；active/held-draining 时不得换键、注销后伪称仍等得到 Release。退出/restart 先永久禁止新派发，再确认 owned unregister/drain；不在 UI 线程等待异步工作。
- 复用 App 既有 worker/Notify 交付 notice 和单次 30 秒 deadline；超时取消采集，不证明 held 已释放。

## Native 私有 RPC

仅 `startAppShortcutRecording` / `stopAppShortcutRecording`，参数均精确 `{generation}`，generation 为正的 JS safe integer。页面不能指定 scope、label、path、owner 或 token。

start 只授权当前 compiled、ready、Open、未撤销的 Settings Child，真实 parent Main、session/source/bundle 一致，实际路由 `#/shortcuts`（沿用既有合法 `_t` query 规则）、可见且 visibility epoch 一致。stop 允许同一 current Child 已离开录制路由后释放旧代次。close/nav/hide/revoke/shutdown 立即 disarm 并唤醒等待，不能只依赖 30 秒。

两个 RPC 的成功回复均精确：

```ts
interface AppRecordingAck {
  version: 1
  sessionId: string
  generation: number
  token: string | null // Native 32 lowercase hex；null 只用于从未 armed 的代次
  active: boolean
  drained: boolean
}
```

- start 成功：token 非空、active=true、drained=false。
- stop 已释放：active=false、drained=true；曾 armed 的代次返回原 token。
- stop 已取消采集但仍 held：active=false、drained=false、原 token；最后 Release 后通过 stopped notice 确认 drained。
- 同代 stop 幂等；Native 保留 session 代次 high-water/cancel，stop 先赢后同代迟到 start 不能再 arm。旧 generation/token 不得停止新代。
- 固定无效字段、busy、stale、unavailable 通过现 BridgeError 通道返回。不得为小包先对任意 Value 做无界序列化。

## 定向 notice

固定接收函数 `window.__ATOOLS_SETTINGS_DELIVER_APP_SHORTCUT_RECORDING__`，只投当前目标 Child；eval 提交不等于页面已消费。无通用 event ACL 扩权。

```ts
type AppRecordingNotice =
  | { version: 1; sessionId: string; generation: number; token: string;
      status: 'recorded'; shortcut: string }
  | { version: 1; sessionId: string; generation: number; token: string;
      status: 'stopped'; reason: 'timeout' | 'cancelled' | 'unavailable'; drained: boolean }
```

字段集合精确；token 为 32 lowercase hex；shortcut 为 Native 生成的当前平台归一化键值，非空且 UTF-8 最多 256 bytes；不伪造 DOM KeyboardEvent。每代最多一条 recorded，来自首个匹配 Pressed→Released；其它同时按住的键只 drain，不追加 recorded。取消/超时最多发送 disarmed 与最终 drained 两阶段 stopped。

## 前端与提交

- 独立 Shortcuts controller，General 保持原协议。controller 按本地路由选择，Native 再独立授权；单 active widget/recording epoch 继续保留。
- 仅接受 exact session/generation/token；start ack 前最多缓冲一条符合结构/代次的 notice，ack 后核 token。晚到回执/事件不能命中新编辑器或新 Child。
- start 在途取消与 save 不能绕过停用；stop 至多发一次，Native cancel high-water 阻止迟到 start。状态未知时不可提交。
- HotkeyInput.confirmShortcut 与 ShortcutEditor.handleSave 都必须等 stop 的 active=false 且 drained=true，或对应 token 的最终 stopped/drained notice，之后才 emit。stop ack 仍 draining 时等待相应 notice；不得以 DOM keyup 推断 Native 已释放。
- stop RPC 失败不自动重发、不假成功；保留需确认状态。取消/卸载立即撤 UI 接收者；held 的 Native tombstone 仍由真实 Release/owned teardown 回收。
- 原界面错误通道说明录制未能开始、仍需释放按键或停止失败，不展示内部注册器/锁等实现细节。

## 既有 FeatureCode 异步派发

Native emit 不代表插件已经打开。其有界 pending 表最多 128 项，每项包含随机 32 hex `shortcutDispatchId`、真实 Main 身份、code/plugin、注册身份和共享 action permit；状态为 Offered 或 Claimed。

- 原 Native 热键事件附带 ID；现有 `activate_feature` 请求通过可选同名参数携带 ID，在任何实际激活前核对真实 Main、code/plugin/注册身份并原子 claim。不新增 begin RPC，普通界面请求保持原行为。
- 录制开始前可以取消 Offered；取消与 claim 同表原子仲裁，锁外释放 permit。旧页面消息后来请求激活时必须因 claim 失效被拒绝。Claimed 则使开始录制返回 busy。
- 原前端 `activateFeature` 的 Promise 真正结束后，发送一次 `complete_native_shortcut_action {dispatchId,outcome}`，outcome 仅 committed/failed/superseded。onOutcome 只能记录结果，不能提前释放。已接收工作即使 dispose 也须等实际 settle；完成 RPC 仍校验原 Main，重复完成幂等。
- Native 实际 activation future 与 pending 表共享 permit 所有权。Main 已被确认销毁时可回收其 UI 所有者，但 Native 已接受工作仍持有 permit 到真正终结；不按标签、超时或消息提交成功假称结束。
- 退出先永久关闭新准入，取消 Offered，等待 Claimed 的真实终结/已证 Main teardown 以及 Native owner 退出。没有新常驻 worker、轮询或逐录制按键通信；额外一次完成 RPC 属于正常 Feature 激活流程。

## 验证边界

先生产协调路径的定向 Rust/原 SFC 测试，再独立 Sol/Terra 源码复核、类型检查和必要 workspace check。测试覆盖 start/action 两种胜序、旧队列、双键、held cancel/release、timeout、换键 busy、其它 scope 互斥、旧事件、新编辑器以及 stop-before-save。

Root 持唯一 Cargo lane，`--locked --offline -j 2`；四树正式构建与真实 Native 纵向验收另行执行。纯 Port、DOM、注入事件、eval 成功与编译通过均不替代物理输入、真实 OS/SDK 和平台验收。

# macOS 主搜索面板的原版行为契约

状态：R58隔离原型验证中，真实类型及恢复已有记录，非激活输入、可见画面与完整交互尚未验收。日期2026-10-29。主目标仍是以Rust/Tauri还原固定ZTools源码及UI，不以让现有错误目标的测试变绿代替。

## 已确认的语义差异

固定上游 `9b15fb1a2a9f3ec886016632761c7bb21e39557a`：

- `src/main/managers/windowManager.ts:324` 创建隐藏的 `type: panel` 主窗。
- `forceActivateWindow` 的Mac分支（803–816行）明确保留原应用前台状态：短暂抑制blur、`setAlwaysOnTop(true, 'modal-panel', 1)`、`show()`后返回。普通唤起没有调用`app.focus({steal:true})`或主窗`focus()`。
- show事件（513–525行）聚焦主WebContents并发`focus-search`；插件显示时恢复插件视图焦点。保留原应用前台状态不等于搜索框无需实际键盘焦点。
- 特殊的文件关联/安装页面流程（1441–1453行）另有显式app focus。普通面板与显式应用激活必须按意图区分。

当前ATools `window/presentation.rs` 的foreground路径是`window.show → window.set_focus → NSRunningApplication.activateWithOptions(empty)`。本地Tauri/Tao锁定为2.11.2/0.35.3；Tao `set_focus`本身还会调用`NSApplication.activateIgnoringOtherApps:YES`。这是比上游普通Mac面板更强的应用激活路径，不是原版普通唤起的准确映射。

R53证明该现有路径失败，并观察到2秒预算内没有延后的焦点事件，见[实际记录](../../output/renderer-visible-recheck-2026-10-29/verification.md)。这不证明拒绝原因，也不能把这些失败重写成成功。原有foreground测试可保留为明确应用激活路径的证据；普通面板应有自己的严格合同。

## 普通面板需要证明的行为

| 维度 | 需要的实际证据 |
|---|---|
| 原生类型 | 实际非激活NSPanel，不是普通NSWindow仅删掉激活调用 |
| 位置与层级 | 固定上游的显示器/Space策略，modal-panel相对层级+1；不改成任意更高层级 |
| 实际可见 | visible、当前Space、未遮挡及有效内容PNG；不能只看进程或visible标志 |
| 输入 | 主窗可接收键盘、实际搜索输入/当前插件目标得到焦点；DOM focus与物理键盘/IME分别验收 |
| 应用前台状态 | 显示前是外部应用时，不激活ATools且保留原前台应用；若ATools原本已活跃，不强制将它设为inactive。只记录一致性布尔，不记录其它应用身份 |
| 恢复 | 关闭/失焦后按原策略隐藏；重开恢复原搜索/子输入/插件焦点，保留原窗口上下文和自动返回取消语义 |
| 多WebView | 同一main窗口与WebView身份，Setting child仍附着同一父窗口，58px布局和租约/会话栅栏保持 |
| 生命周期 | 显示/隐藏、Focus/Close/Destroyed/Exit、delegate、布局和pending均可验证回收；不能用进程退出掩盖反复开关或deinit问题 |

普通面板成功不能只通过删除app-active门槛获得。必须同时取得真正面板类型、输入焦点、前台状态保持、可见画面及回收证据。R34/R36无焦点画面诊断也不替代普通面板的交互验收。

## 原生实现候选与未证风险

Tauri/Tao当前没有直接NSPanel创建/转换接口；Tao原类是带`focusable` ivar和`sendEvent:`行为的`TaoWindow : NSWindow`。项目已有主窗由Tauri创建，窗口角色在多WebView模式分开取Window/WebView；不能为满足某个插件接口创建第二个假main窗口。

隔离原型使用维护者[tauri-nspanel](https://github.com/ahkohd/tauri-nspanel)的固定commit **`3ffa93ed14e0f8e857e43619b4157f2a685d35a4`**，仅由非默认feature `macos-main-panel-prototype`启用。其Cargo声明2.1.1、Tauri2.8.5、objc2 0.6.1、app-kit0.3.1，许可MIT OR Apache-2.0；本地实际为Tauri2.11.2、objc2 0.6.4、app-kit0.3.2。锁文件新增该依赖及`pastey 0.2.3`、`objc2-core-video 0.3.2`三项；本次解析没有升级既有依赖。依赖编译通过不代表adapter或原生运行通过。

- [公开FromWindow/扩展](https://github.com/ahkohd/tauri-nspanel/blob/3ffa93ed14e0f8e857e43619b4157f2a685d35a4/src/lib.rs#L236)接受`WebviewWindow`，不是任意`Window`。必须先确认实际main可通过公开API取得所需对象，转换应在首次显示及子view创建前完成；不得伪造wrapper。
- [转换宏](https://github.com/ahkohd/tauri-nspanel/blob/3ffa93ed14e0f8e857e43619b4157f2a685d35a4/src/panel.rs#L682)保存原动态类、对同一指针替换为自定义NSPanel类，跳过NSPanel初始化。指针相同不等于Tao ivar/事件/生命周期已经兼容。
- 必须核对原类与目标类实例布局、Tao特有ivar/方法、delegate、键盘命令与拖动行为。重点检查canBecomeKeyWindow等配置实际是实例方法而非类方法，以及转换后`set_focusable`等原Tao操作是否仍合法；未证时不得直接调用或进入默认入口。
- 插件样式实现含selector检查后的私有`_setPreventsActivation:`，并安装文本输入window-level处理。需要明确支持版本及失败恢复，不能把README或窗口show返回当作平台兼容证明。
- 不采用会临时更改整个应用activation policy的`no_activate`捷径；面板意图应限定在main窗口，不干扰独立窗口或原生对话框。
- 若选择候选库，先冻结许可、依赖与来源，再以隔离feature和唯一自有临时应用验证。原类恢复、关闭、重复开关、子WebView关闭与退出、Touch Bar/KVO和IME均需检查。其它平台保留各自原版显示/聚焦语义。

## 下一交付边界

先完成可关闭的macOS main面板原型和上述身份/生命周期/焦点证据，再验真实原版搜索/Settings流程。当前默认入口、原版Vue/CSS、SQLite及按需Node保持；仅在精确隔离bundle作用域安装原型，不改旧失败报告。完整像素、物理输入、其它系统与发行性能仍是最终目标的一部分。

R55先交付主窗隐藏基线→显示→隐藏→切换重显→恢复的最窄观测链。`fullProductAcceptance`固定false，`visualStatus`固定`not-captured`；没有PNG、物理输入或Settings child证据时，不关闭本票。实现检查真实运行时类名、直接父类、实例大小、Tao focusable ivar区间及NSPanel自身ivar数量，并强引用原delegate/视图供恢复。这些守卫只约束已检查的布局，不证明跳过NSPanel初始化的所有私有行为安全。

隔离feature编译、窗口74项及renderer相关232项/1忽略与默认workspace check已通过，记录见[R55静态验证](../../output/renderer-main-panel-2026-10-29/verification.md)。这些是源码/单元层证据，尚未执行原型NSPanel对象转换或GUI验收。

固定库会给WK文本输入类安装进程期方法，无法撤销；报告必须保留`until-process-exit`与`runtimeMethodRemovalSupported:false`。转换后manager缺失，或`to_window`后校验失败的极窄路径，目前不能保证可重试恢复；须保留失败与未知事实，不能据此普通关闭或宣称原状态已恢复。该风险仅限自有临时进程，最终仍需证明进程终结和资源归属回收。

## R56/R57实际运行与精确KVO例外

R56真实预检观察到`NSKVONotifying_TaoWindow`，其`-class`返回`TaoWindow`；原/基类实例536字节，NSWindow/NSPanel/Raw panel均528字节，focusable offset528/编码B。包装自身无ivar，完整自有方法精确为`_isKVOA`、`class`、`dealloc`、`setContentView:`。Apple说明KVO可安装中间类，应区分运行时类与`-class`报告类（[官方说明](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/KeyValueObserving/Articles/KVOImplementation.html)）。这不自动证明换类期间的KVO行为完整。

当前隔离例外只接受该精确单层包装或普通TaoWindow：逐项比较类指针/继承、报告类、大小、0包装ivar和完整方法名单，保留原focusable与NSPanel布局约束。`originalClass`仍记录实际类，另记录九字段`originalClassAssessment`；所有额外setter、ivar、未知继承/类形态继续拒绝。锁定多WebView路径的Main/Settings均为WindowChild，其构建后增删只操作子视图，不显式替换主contentView；这不代表已证明AppKit所有内部行为。

四阶段新增主线程读取的`contentViewStable`，任一false/null均失败。关闭和退出事件在panel仍active时被拦截，正常退出须先精确恢复原KVO类、delegate、样式与content view。所有实验仍不切默认入口，不代表完整生产支持。

实测`run-258e58d6952144869849b6a41ee24a8f`已记录同一指针NSPanel、窗口/DOM焦点与occlusion、四阶段content稳定和完整恢复，但首次显示激活应用一次，故正式失败。分离order/key、库完整show-and-make-key及实际Main WKWebView作为first responder的三次后续实验均保留前台、激活增量0，却缺少真实key/occlusion/DOM可见事实，同样失败。四份原始报告已独立重新校验，仍为合法失败报告，专属临时路径均不存在，见[R57复算](../../output/renderer-main-panel-native-2026-10-29/r57-observed-verification.json)。不能以visible标志或激活计数0单独代替成功。

## R58桌面前提与构造对照

北京时间2026-10-29 18:16:56，新的只读系统查询明确得到`sessionAvailable/onConsole/loginDone=true`、`screenLocked=true`，见[带时间的系统观察](../../output/renderer-main-panel-native-2026-10-29/desktop-session-preflight-r58.json)。前述四次运行没有同时刻的锁定状态，不追溯改写结果，也不把它们全部归因为锁屏。暂停显示/焦点实验，待重新核实可交互桌面后再运行。

原生runner在创建应用前读取四项状态，结束后再次读取；锁定、缺失或未知均不能通过。查询不读取用户或外部应用身份，Swift缓存仅在专属私有临时目录中创建并回收。前置检查、原报告校验与owner回收的Node回归36项通过；这不是窗口交互验收。

新增的构造对照仅在显式诊断环境变量开启、临时profile与owner全部匹配时创建真正初始化的独立NSPanel和空白可聚焦NSView，比较AppKit构造与运行时换类的差别。它不承载Main页面，不替代Main，不进入默认入口；始终`fullProductAcceptance=false`。本批只做代码、编译与清理协调检查，尚未运行该对照，不能由其源码推出正确的显示方法或决定引入Tao分支。

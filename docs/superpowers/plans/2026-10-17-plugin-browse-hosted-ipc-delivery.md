# 插件浏览状态与 Hosted IPC 交付记录

日期：2026-10-17。长期目标仍为进行中：缩小与 ZTools/uTools 的界面、交互差距，让大部分原版插件直接可用，并验证性能。本批为一个可复验的增量，不代表多数插件已经验收。

## 产品改动

- 从插件清单进入市场，再返回已安装插件时，在同一次设置会话中保留搜索词、启用状态、来源筛选与页码。切换筛选时回第一页，目录刷新只收敛越界页码；退出设置后新会话恢复默认状态。列表仍按 30 行分页，不靠隐藏挂载保留整张列表。未证明精确 scrollTop 恢复。
- 为同插件的主界面、子窗口、同级和嵌套窗口补齐 getWebContentsId、webContents.id 与 ipcRenderer.sendTo。身份由宿主分配，消息中的同名字段不会覆盖真实 senderId；重载保持窗口 ID，关闭后重建获得新 ID。sendTo 保持 void，异步拒绝仅记录诊断，不自动重放。
- 子窗口的独立 preload 通过现有安装根目录、资源读取器和权限边界加载，并先于原版页面内联脚本执行。父窗口与并发子窗口复用一次 Node 环境准备；子窗口失效不会关闭仍有效的父窗口环境。仅子 preload 需要 Node、主入口未被识别为 Node 的情况仍被原生边界拒绝，尚未完成。

## 消息隔离与性能边界

消息路由、序列化桥与浏览状态均由独立模块承担。真实来源、窗口身份与当前 runtime nonce 必须同时匹配；排队等待权限/就绪的消息在提交前再次检查，重载、关闭或文档替换后丢弃旧消息与旧响应。RPC 与页面握手两条消息均确认同一个文档后才发布 ready，自主 reload 也重新确认。没有把所有目标无条件标为就绪。

消息仅允许有限 JSON：最多 32 个参数、128 字符通道、12 层深度、1024 个节点、16 KiB 载荷；每面板最多 32 条/256 KiB 排队，最多 33 个窗口身份，发送侧最多 32 个未完成消息，监听通道与单通道监听器各最多 64。空闲时无轮询；只对实际待处理任务设置超时。窗口控制仍受创建者边界限制，跨插件路由不开放。

独立职责已拆出，小模块保持在 500 行以内。既有 PluginPanel 与 SettingsPanel 仍为超大文件，本批仅保留必要接线与会话状态；这项历史拆分债务尚未解决，不能宣称所有触及文件均满足 500 行要求。

## 实际桌面验收

默认 opaque iframe 路径在两个串行独立临时应用运行中完整通过：native v3、native v4。每轮 24 项总检查与 9 项精确隔离探针通过，包含公开 API 的父子、同级、嵌套通信、监听器移除、重载身份、关闭 ID 不指向替代窗口、挂起创建取消和退出收尾。每轮 1 条 TaskRun 终态，数据、路径、对话、页面与资源租约全部释放；原版文件、生成包和 387 个选定输入及 3 项构建产物指纹稳定，临时环境与构建目录已删除。387 项为明确选定输入，不是完整编译依赖闭包。

原版番茄菜单案例保留完整 ContextMenuWindow 类、菜单 HTML、纯 Electron 子 preload 与 CSS 的固定原始字节。合成父页面只提供必要设置与调用记录；运行原类创建、真实子 preload 握手、原版“隐藏番茄堆”点击处理、sendTo 回传、父类处理与销毁。原目录无改动。本批只证明这条原版调用链，不能作为完整番茄插件验收。opaque srcdoc 的 URL 查询配置未保留，菜单深浅主题与 showPile 参数也没有验收。

子窗口为启动器内隔离 iframe，尚非独立原生浮窗。窗口处于 observe/hidden，输入为程序化 DOM 事件；不能作为可见前台、物理键鼠、真实编辑器打字或绘制延迟证据。真实确定性的在途导航竞态未在 native 案例中构造，身份失效逻辑由抽取实际生产接线的测试覆盖。没有使用 AppleScript、剪贴板、系统选择面板或操作用户文件。

## 验证与预算

- 最终前端 119 个测试文件、1106 项通过，类型检查零错误/零警告。全部 26 个真实共享桥调用方通过（24 条 affected 回归，加独立列出的同步句柄与系统 Shell 两条）；另有隔离、原生夹具和实际浏览器验证，加上测试与类型检查共 31 条最终验证命令通过，1134 个选定输入在验证前后稳定。
- 独立生产复核 86 项通过；最终 worker 的 98 项定向测试包括原有文档模式回归。Rust core 183、plugin 118、shim 21，共 322 项通过；桌面宿主 442 项通过、1 项既有忽略，离线工作区编译通过。Rust 所选输入与最终版本一致，没有因仅前端变动重复全量 Rust 测试。
- 实际 Chrome 的 1200 条合成插件目录仍只渲染最多 30 行；800/420 宽度、浅深色共 8 张截图及导航、权限、失败恢复用例通过。列表截图人工检查无横向溢出。此项不是 ZTools/uTools 对比验收。

- 默认生产首屏脚本静态依赖图 319833 字节（312.3 KiB），低于 573440 字节（560 KiB），与上批相同；插件面板、拼音分块继续延迟加载。182 个生产/配置输入前后稳定，临时构建目录已删除。
- 1200 多条功能的串行匹配保留 20 个样本，最慢 0.942333 ms，预算 25 ms；不含索引构建、冷进程、IPC 与 DOM。
- 两轮各 20 次串行公开 sendTo 往返，以主窗口同一 performance.now 从发送到身份匹配 ack 回调计时；两轮 P95/最大均 1 ms。0 ms 样本保留原值，不解释为零耗时。无轮询混入测量区间；仅为隐藏窗口描述统计，不是发布门槛或绘制延迟。
- 单独串行运行 5 个临时桌面进程，100 个热搜索样本 P95 32 ms；返回按钮程序化焦点恢复 P95 28 ms，iframe Escape probe 后焦点恢复 P95 26 ms。1200 条合成 metadata 加 2 条原版 typed matches 测搜索规模，不代表 1200 个原版插件兼容。自有进程组 RSS 最大 139657216 字节（133.2 MiB）；不含未归属 WebKit/XPC，也不是整应用物理内存。observe 模式且 backgroundServices=false；启动与空闲只是该隔离案例，不是常规应用的前台体验或正式空闲预算。

## 独立复核与失败保留

第一轮真实桌面流程在子窗口通信处超时。RPC ready 与页面 open 到达顺序不同，可能使路由遗失 ready，而公开句柄已报告就绪；因此该轮失败，不能算验收。补上同来源、同 nonce 的双流确认，并测试两个顺序、自主重载、旧 proof、销毁取消。随后独立复核又发现实验性文档模式未使用带身份的 transport，导致正常调用被拒绝；修复记录与回归结果分别保留。

较早前端验证也保留失败：一次因隔离环境无法监听本地端口及旧断言失败，随后一轮六个既有 caller 的初始化/生产函数定位断言失配。修正后仍严格检查纯同步 API 不发业务消息，并通过真实生产函数验证上下文菜单注入与 redirect，不用放宽断言跳过。较早 v3 全量通过仅证明其冻结版本，最终以本批后续冻结记录为准。

最终 IPC、文档 transport、6 个修订 caller 与受控诊断分别独立复核，覆盖范围内无剩余 P0/P1/P2；保留 UI/子 preload 和原生断言的早期复核范围。新增菜单诊断仅允许固定 step、错误类别与错误码，既有成功断言未放宽，不输出任意错误正文。

另一次 native v2 已通过 19 项检查，随后菜单步骤失败；旧诊断只保留错误类型，未能确认根因。添加分步诊断后 v3、v4 连续通过，但不据此宣称 v2 根因已修复。该未知失败及稳定性疑点继续保留，不能作为发布验收完成。诊断 worker 一次 pnpm 调用触发 Corepack 查询失败，随后只用既有依赖完成检查；未安装依赖，包与锁文件指纹未变。

## 后续缺口

- 多数原版插件的直接可用率仍未建立。清单、资源、manifest 就绪和少量业务案例均不能替代多数插件实际验收。
- 仍需可见前台的真实输入、JSON 编辑器聚焦/输入/格式化/诊断恢复，以及 ZTools/uTools 同机比较。
- 继续补充只有子窗口需要 Node 的入口识别、查询参数、nativeImage/剪贴板图像与独立浮窗语义。
- 常规启动/空闲、整个应用的 WebKit/XPC 资源归属、跨平台与发布包仍待验收；自有进程组 RSS 不能代表整应用物理内存。
- 既有大型宿主组件仍需按职责继续拆分。菜单默认参数的局部成功不能代表完整 Pomodoro、QuickCommand 或 Long Screenshot 可用。

[桌面功能 v3](/Users/harris/Desktop/atools/output/legacy-node-2026-10-17/native-browser-window-hosted-ipc-v3.json)、[桌面功能 v4](/Users/harris/Desktop/atools/output/legacy-node-2026-10-17/native-browser-window-hosted-ipc-v4.json)、[最终代码验证](/Users/harris/Desktop/atools/output/plugin-input-2026-10-17/hosted-ipc-code-validation-v4-final.json)、[Rust 验证](/Users/harris/Desktop/atools/output/plugin-input-2026-10-17/hosted-ipc-rust-validation-v1-final.json)、[首屏预算](/Users/harris/Desktop/atools/output/plugin-input-2026-10-17/hosted-ipc-bundle-budget-v1-final.json)、[匹配预算](/Users/harris/Desktop/atools/output/plugin-input-2026-10-17/hosted-ipc-matcher-budget-v1-final.json)、[桌面性能](/Users/harris/Desktop/atools/output/plugin-input-2026-10-17/hosted-ipc-native-performance-v1-final.json)、[目录浏览器记录](/Users/harris/Desktop/atools/output/plugin-inventory-2026-10-16/f4568264-82c4-4665-9b11-cf8378aa498b/report.json)、[总回执](/Users/harris/Desktop/atools/output/plugin-input-2026-10-17/plugin-browse-hosted-ipc-delivery-v2-final.json)。总回执保留源码指纹、完整修改前字节、失败与修正记录及独立复核。

保留既有脏文件与无关改动。本批没有暂存、提交、推送或执行系统文件操作。用户先前的四步 AppleScript 授权没有扩大使用。

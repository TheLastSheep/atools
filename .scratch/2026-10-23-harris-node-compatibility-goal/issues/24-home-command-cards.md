# 24：ZTools 双行指令卡片与内容高度

状态：本票生产实现、定向测试及浏览器切片通过。整体目标仍为参考 ZTools 源码/UI，以 Rust + Tauri 2 在 ATools 还原，Harris 原版优先；按需 Node 保留，原生 GUI/系统输入仍按此前决定暂缓。

## 来源与差距

- 固定 ZTools HEAD `9b15fb1a2a9f3ec886016632761c7bb21e39557a`，`CommandList.vue` 使用 9 列、0 gap、32px 图标、6px 间距、12px/16px 双行标签框（32px）和上下 8px padding，总卡片高度 86px。
- ATools 当前卡片为 58px、单行省略、4px grid gap；真实 800px Chrome 基线中 Harris 的“收货地址智能解析”发生截断。
- ZTools `App.updateWindowHeight` 按内容测量，经 `resize-window` 限制到显示器工作区；600 是默认值，不是最大值。ATools 首页固定 340px cap 不足以容纳双行卡片的默认行数。
- ATools `ShellFrame` 已用 `min(100vh, targetHeight)`，可在真实窗口受工作区限制后把滚动留给命令区；Rust 原主窗口 resize 尚无工作区限制。
- ZTools 空首页没有导入/市场 CTA。ATools 旧清单“import entry visible”不符合当前页面，已修正文案，不以此凭空新增与来源无关的按钮。

## 已冻结合同

1. 提取有明确视图职责的 `HomeCommandTile`，保留 HomePanel 的导航、提示身份、滚动、选择与操作语义；两者均不得超过 500 行。
2. 按来源恢复 86px 双行卡片，保持现有 32px 图标、主题 token、roving focus、ARIA 完整名称、提示、菜单及最近项删除；小宽度沿用响应式轨道，不假定永远 9 列。
3. 高度公式使用与当前 CSS 一致的 header22、垂直 padding22、rail53、内容 border1、外壳 border2、search58、status34、row86、gap0；默认无 pin 的两行 recent 为364px，一行 pin 加两行 recent 为478px。固定项独占不得再预留空 recent 区。移除静态340/600高度上限。
4. Rust expand/reset 共用工作区有界 resize：逻辑/物理像素转换、frame 空间、负屏坐标、小屏和大整数安全；保留宽度及可容纳的原 y，必要时上移。无 main 沿用 no-op，无有效显示器或 OS 失败返回诊断，不新增 IPC/进程/轮询。
5. 新 native 失败不能被 App 旧 catch-all 静默吞掉。每窗口独立 resize feedback，固定可关闭提示，不泄漏原始错误/坐标；不抢焦点、不改 shell 高度、不后台重试，过期回执及卸载后不写状态。
6. 使用真实 App/Chrome、固定 IPC 数据、Harris manifest 和原 logo 只读证据。验证真实字符换行/截断、完整无障碍名称、默认行可见、矮窗口滚动、键盘/提示/菜单/删除；不把元数据投影称为原插件启动或 native 业务验收。
7. 主 Agent 审关键实现，独立执行相关测试、严格类型、默认生产构建/首屏573440字节预算、受限离线 Cargo、真实浏览器、源码指纹与资源核对。通过后不为增加计数重复测试。

## 分工与边界

- Luna UI：HomePanel/HomeCommandTile、launcherWindowLayout 与相关 home tests；禁止改 App/Rust/浏览器。
- Luna Native：window.rs 与 resize_bounds.rs；禁止改 commands.rs/Node/frontend。纯 rustc 红绿；主统一 Cargo 通道。
- Luna Browser：共用浏览器 runner 的独立 cards mode、新 fixture/scenario；禁止启动 Chrome。主运行旧版红测及最终矩阵。
- Luna Resize feedback：独立 controller/notice/App 最小装配及测试，禁止改其他人的文件。
- 主 Agent：调用链、接口、截图目视、独立验收与记录。原生 GUI/AppleScript/系统剪贴板不恢复；不安装依赖、改原包、提交或推送。

## 当前证据

证据目录 `output/ztools-home-cards-2026-10-25/`。

- 修改前前端/测试/脚本基线1497文件；native沿用上票880文件哈希。capture 时 window.rs 已开始修改，保留原始哈希并把中间副本明确标记为 intermediate，未伪称为原始副本。
- 第一轮旧UI实际截图证明58px，但 runner report 自引用使 JSON 未写出；原 log/PNG 保留，缺失原 cleanup ACK 不补造。
- 严格重跑 `browser-2dc0c0d3-e430-4804-a4fd-5ca024333a13/report.json`：旧58px目标红，原 logo32px、源哈希稳定、严格清理通过；Node/Chrome PID55663/55672均独立确认 ESRCH、profile 删除。
- 主独立 Rust 几何7项、生产 crate 7项同组用例与离线 workspace check通过；同组不相加成14项。workspace 保留197条既有宿主警告与 nom future-compat 提示，未运行原生窗口。

整目标的设置、插件管理、原版 Harris 全业务、完整视觉对照、实机窗口和整应用资源要求继续开放，不因本票通过缩小范围。

## 本票收尾

- 86px双行卡片和内容高度已接入；主浏览器抓出展开仅改CSS高度的生产缺口后，补齐presentation到宿主resize，并覆盖设置/历史/固定项更新与选中项不重复请求。
- 主独立23文件200项、应用/本票严格类型0错0警告、默认构建及455448/573440首屏字节预算通过，比上票增加2321字节。Rust同组7项和workspace check通过，197条既有警告保留。
- 最终`e77cd746`卡片浏览器9项/5截图通过；主目视全部5图，截图等待新挂载真实有限动画结束，frame/panel均opacity1、transform none。只有scenario等待逻辑在生产核验后变化。
- 旧版展开/搜索默认mode回归`6efa0330`四矩阵9项/16截图通过。2份最终报告无未知IPC/控制台错误/被测页面外部尝试，Harris3原文件未改且无插件activation。
- 22代码文件≤500行，1497基线无超范围变化，879非本票native/runtime与44上游renderer未改；5份有效报告的10PID/10端口/profile/临时build独立确认退出。首轮缺失report的原cleanup ACK继续保留为缺口。
- 4个旧源码正则脚本仍失败于既有结构假设，不宣称全项目门禁通过。原生窗口、全UI/原版插件业务与整App性能仍待验。

完整实现、原报、失败历史、截图与验证边界见 [Task24验收记录](../../../output/ztools-home-cards-2026-10-25/verification.md)。

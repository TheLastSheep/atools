# ATools 第 33 批：固定文本、原插件列表入口与真实菜单交互

本批完成固定文本后二次筛选、`window.exports[code]` 的列表和无界面入口，并通过真实 Chromium 菜单交互回归。总体 goal 继续进行；大部分原插件直接可用、竞品体验对比及原生编辑器完整输入验收仍未建立。没有提交或推送。

## 可使用的行为

- 搜索框内 `Cmd/Ctrl+F` 固定非空文本，然后仅在支持该原文的插件候选中筛选名称、解释和别名。空输入粘贴文本保留完整原文，有输入或选择范围时正常插入替换。固定一代原文仅调用一次内容搜索，后续筛选在内存完成。
- 固定文本可点击编辑或移除；空输入退格恢复原文并全选；Escape 依次清筛选、清固定内容、隐藏窗口。切页、替换内容、关闭、目录刷新和取消激活会使旧回包失效。
- 内容候选仅使用缓存中的 `regex/over` 规则，排除普通关键词和展示名称；不会因高分关键词遮蔽实际内容规则。普通 typed 搜索与激活也统一采用 UTF-16 长度、最小长度和 over 最大长度，默认上限 10,000。支持 `match/regex` 两种字段，二者同时存在时优先 `match`；sticky `y` 要求从起点匹配，`m` 不放宽该约束。
- 激活仍进入同一插件身份校验、执行门、任务记录和开页流程；原文保持 string payload，入口类型单独传递。固定正文不进入历史、localStorage、完整 title/ARIA 或任务诊断正文；TaskRun 输入/输出仅保存身份、类型和长度等元信息。
- 插件 `window.exports[code]` 的 `list` 入口使用回调更新列表，保持完整原 item，支持搜索、方向键、Home/End、Enter 和鼠标选择。列表更新不结束插件。`none` 等待入口执行；这两种模式与普通 Ready/Enter 分支互斥，避免双执行。
- 列表回调绑定文档、入口和搜索代际；原生文档模式验证精确 origin、nonce 和 generation，拒绝旧异步回包及旧关闭消息。旧 opaque 模式仅靠 WindowProxy，仍无法证明同一 proxy 导航后的文档身份；夹具结果不代表原生导航竞态通过。父端仅渲染文本和受约束图标，按可视范围渲染行。
- 空白点击和滚轮关闭菜单后恢复搜索焦点；外部输入框接管焦点后不被抢回。单次可取消动画帧避开浏览器默认点击动作，窗口失焦、卸载或新菜单会取消旧请求。

契约来源为本机 ZTools `9b15fb1a2a9f3ec886016632761c7bb21e39557a` 的 SearchBox、文本匹配及 preload 实现，以及 [uTools 模板插件文档](https://www.u-tools.cn/docs/developer/information/window-exports.html)。这是选定契约对齐，不是完整 JS/Electron 引擎等价声明。

## 原插件与真实运行证据

未改动的 `recent-typora`、`bookmarks`、`text-copy` 共 15 份源码/manifest 已校验。其完整选定 preload 模块图覆盖 6 个固定列表/无界面流程，使用显式进程和同步 API 夹具；不能计为三个完整插件或原生验收通过。生产桥的实际序列化执行另覆盖入口类型、原文和 `$&`、`$\``、`$'`、模板占位串、`</script>` 等内容无损传递。

[Chromium 第四轮](../../../output/plugin-input-2026-10-18/batch33-browser-outcome-v1.json) 实际通过 6 项：页面就绪与焦点、真实右键菜单、空白恢复、滚轮后继续输入、外部输入接管、首页悬停及 Escape。使用真实 App 和显式 mock IPC、CDP 输入；不是 OS 输入、WKWebView、插件执行、性能或竞品比较。全部自有浏览器、端口、缓存和临时目录已清理。前三轮真实失败保留，未重写为通过。

## 性能与额度

| 项目 | 本批结果 | 范围 |
| --- | --- | --- |
| 首屏 JavaScript | 327,821 B / 573,440 B | 默认生产、未压缩；比上批增加 6,390 B |
| 插件面板独享懒加载静态依赖 | 444,092 B | 含传递依赖；比上批增加 14,919 B；组件本体 242,896 B |
| 普通搜索 | 20 样本，最慢 1.216167 ms / 25 ms | 1,200 feature，新索引每组首次及热查询 |
| 固定文本搜索 | 20 样本，最慢 7.275625 ms / 25 ms | 1,200 feature，同一缓存目录每组首次及热查询 |

全部 40 样本保留，串行检查在构建、全量测试和原生进程终态后执行。两种搜索均排除索引构建、进程启动、IPC、DOM；不是全部输入分布、前台原生 RSS/延迟或同机竞品基准。

固定内容最多 256 KiB UTF-8；列表最多 2,000 项、1 MiB JSON、65,536 节点、深度 32。稀疏数组空槽、JSON 转义膨胀、隐藏转换 hook 等在序列化之前检查，超额显式失败。没有放宽既有搜索、目录或运行时额度。Rust regex 的无 `u` Unicode 语义、JS lookaround/backreference 等仍有引擎差异；本批未补齐普通路径的全部 exclude 语义。

## 验证与修复记录

- 前端 143 个文件、1,324 项通过；Svelte/TypeScript 零错误、零警告。
- core/CLI 单元与集成共 204 项、插件层 126 个顶层用例及 1 次隔离子进程执行、API shim 23 项通过；插件日志的 127 次汇总不能视作 127 个独立用例。
- 宿主完整单元回归 465 项通过、1 项原有忽略；工作区编译检查通过。
- 菜单独立回归 50 项、驱动 Node 回归 17 项；内容链路独立复查与实际序列化入口测试通过。原插件模板定向 79 项，另有 13 项独立 JSON 边界及 5 项异步身份探针。
- 独立复查发现的普通候选/激活规则不一致、sticky 起点、输出写入失败却退出成功、稀疏数组预检等问题均已修复；失败、修改前原文及后续绿色结果保留。
- 首次全量前端 1,321 通过、1 项失败。独立对照证明旧版和当前版都可在固定延迟下触发夹具的 100 ms 文档确认超时。仅队列夹具改用生产已有的 3 秒确认额度，RPC 短时限保留；新增超过 200 ms 后成功和显式 20 ms 超时仍拒绝两项测试。没有修改生产超时或吞掉握手错误；第二次全量通过。

本批 57 个所属源码/测试文件，28 个修改、29 个新增；1,255 个明确选定输入已冻结，继承基线无未解释漂移。新增或实质修改模块最高 491 行。App、PluginPanel、commands、lib 四个历史大文件仅做接线例外。共享测试 helper 的作者版本与后续集成修改分别保留修改前原文和前置 SHA，未混作同一个基线。

## 原生固定输入：已执行，未通过

两轮均已通过自动审批并实际运行，此时不能继续沿用“容量不足、未执行”的旧状态。使用用户既有授权，仅控制本次唯一临时 ATools 编辑器；未修改输入源、剪贴板、系统设置或其他应用。两轮的选定源码和原插件字节均在各轮内部稳定，进程、运行时、临时数据和后代清理完成。

- 纯文本停在 alpha：可信 keydown 74、beforeinput/input 各 81，但全文与固定夹具不符，可信编辑区 pointer 为 0。
- JSON 停在 valid：可信 keydown 57、beforeinput/input 各 75，但 model 不符；未进入格式化、错误诊断与恢复。

观察到英文被转换为中文及 Monaco `ime-input`，强支持输入法介入，但未读取实际输入源，不能认定唯一原因。随后 AppleScript 单窗口 guard 拒绝未绕过，不能据通用错误推断窗口数量或关闭原因。没有用 DOM 写入、编辑命令或 Monaco model 修改补成通过；硬件人工输入仍未验证。

后续只有当前测试夹具发生修改，不把旧轮 source-stable 记录等同最终所有选定输入完全相同。两项编辑器、完整原插件流程、前台原生性能、ZTools/uTools 同机 UI/交互和大部分插件直接使用均继续待验。

## 材料

- [本批收据](../../../output/plugin-input-2026-10-18/batch33-delivery-v2.json)
- [源码冻结](../../../output/plugin-input-2026-10-18/batch33-code-freeze-v1.json)、[修改前原文与共享前置链](../../../output/plugin-input-2026-10-18/batch33-before-map-v1.json)
- [首屏预算](../../../output/plugin-input-2026-10-18/batch33-bundle-budget-v1.json)、[完整懒加载静态图](../../../output/plugin-input-2026-10-18/batch33-lazy-production-graph-v1.json)、[全部搜索样本](../../../output/plugin-input-2026-10-18/batch33-matcher-budget-v1.json)、[当前源码核对](../../../output/plugin-input-2026-10-18/batch33-budget-source-reconciliation-v1.json)
- [纯文本原生报告](../../../output/legacy-node-2026-10-18/batch33-local-plain-text-native-ui-input-v1.json)、[JSON 原生报告](../../../output/legacy-node-2026-10-18/batch33-local-json-editor-native-ui-input-v1.json)
- [最终完整性核对](../../../output/plugin-input-2026-10-18/batch33-final-integrity-v1.json)

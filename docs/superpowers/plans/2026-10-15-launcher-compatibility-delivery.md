# 启动器体验与 ZTools 插件兼容推进

日期：2026-10-15。状态：多批实现与隔离验证已完成，总目标继续进行。

基于当前未提交工作树开发，基线 HEAD 为 `c34789c0e3d19b3bf7c05d396540d891ff126abc`。本轮未创建提交、推送、安装或替换 `/Applications` 中的应用。现有其他改动与插件源目录均保留。

## 本轮交付

- 首页使用紧凑入口，去掉每次挂载时的插件、能力、任务历史、MCP 四次读取。设置与插件宿主代码只在进入相应页面后加载。
- 插件运行信息抽成独立组件，普通插件默认折叠；错误仍在正文显示。验证预览保持展开，便于现有桥接回归。
- 中文组词结束后再搜索，候选确认不触发启动器执行。原生按钮保留键盘操作。
- 方向键、Tab、鼠标与分组显示顺序一致。后台结果补充保留用户选中的能力和已加载的应用图标，部分来源失败有明确提示。
- 搜索结果按可视区域挂载，保留原激活索引、完整位置和选中项 ARIA 信息。查询变化时回到顶部。
- CommonJS 预加载按需预取相对 JS/CJS、JSON、目录入口及 package main，支持缓存、循环依赖、模板表达式中的字面 require、失败重试和真实 dirname/filename。未知模块不再返回假成功对象。
- 模块读取在 Rust 后端绑定数据库中的已启用插件根，限制普通文件，拒绝目录越界与软链接，并限制读取大小；关闭或切换插件会取消旧加载。

新增业务模块都少于 500 行；App、PluginPanel 的接入以替换和委托为主，减少原有巨型文件职责。

## 性能证据

| 场景 | 当前结果 | 门槛与证据边界 |
| --- | --- | --- |
| 10k/100k 三类搜索数据，20 次采样 | 最慢 P99 12.586 ms | 80 ms；本机 JS 热搜索，不是原生 IPC 或竞品对比 |
| 1,200+ 指令 Rust 匹配 | 测试通过 | 25 ms 交互预算，保留现有测试定义 |
| 1,200 条 / 12 组真实组件浏览器预览 | 首次 11 行 DOM，观测最多 16 行；挂载刷新约 10.8 ms | DOM 回归上限 32；单次浏览器预览，不是原生首帧 P99 |
| 当前生产首屏静态 JS 依赖图 | 307,384 字节 | 560 KiB；从 HTML 入口/preload 沿 manifest 静态 imports 计量，插件宿主和拼音不在首屏依赖图 |
| 相对模块图预取 | 硬限制 | 128 模块、2 MiB 总源码、1024 次读取、1000 ms 总期限 |

原组件环境曾测得 1,200 行全部挂载约 313 ms；窗口化后单独运行约 23 ms，并行测试存在波动。持续回归以 DOM 行数、滚动和激活行为为主要门槛，不把这组数值包装成原生性能结论。

本轮没有重测原生热键首帧、稳定空闲 RSS/CPU、安装包或重型 Node 插件的内存增量。旧性能文档中的数值不视为本轮验收。

## 插件覆盖现状

逐目录静态审计识别 180 个插件：

| 排他分类 | 数量 |
| --- | ---: |
| 纯 Web | 16 |
| Web 预加载 | 19 |
| Node 预加载 | 120 |
| 本机原生依赖 | 6 |
| 平台不适用 | 11 |
| 入口缺失 | 8 |

早期粗粒度审计：跨分类有 138 个需要 Node，43 个存在相对模块图；172 个仅被识别为 HTML 文件存在或无页面入口，169 个声明支持 macOS。这个 172 不能作为发布入口就绪数量，最新逐资产审计见第四批。宿主当前六种候选路径识别 179 个，额外的深层 manifest 使审计目录计数为 180。静态检查不能证明成功运行、外部服务配置、native ABI 或复杂交互。

原始 char-transform 模块的驼峰、下划线、大写下划线和中文 URL 编码已执行并核对输出。本轮又在隔离原生 WebKit 中用当前模块桥执行原始 MD5、中文 Base64 编解码，以及 file-tree 的目录扫描和本地过滤闭包，输出正确、原文件哈希未变。这些业务探针使用临时 Node HTTP fixture，不能冒充完整产品插件页面验收。

## 第二批交付：真实 Node 模块与授权生命周期

- Node 预加载仍在 opaque iframe 中执行，相对 CommonJS 闭包保持本地；Node/npm 模块委托持久 Node 进程执行，同步 API 保留同步返回，Promise 与异步回调分别处理。Electron 继续由本地宿主桥处理。
- 相对模块图发现外部字面 require 后才申请 Node；纯 Web 和仅 Electron 预加载不启动 Node。授权通过现有权限决策、TaskRun 和审计执行。进程隔离不是文件系统或网络权限沙箱，权限描述明确说明实际能力。
- 每次打开实例绑定独立会话；关闭、窗口销毁、插件禁用/卸载及权限变更会回收。快速重开、启动中关闭、后台 abort、最后会话监听器回收均有真实进程回归。
- 共享执行入口在执行前原子 claim 原任务；重复确认、参数或身份不匹配不再退回创建一个新的执行。取消和执行完成竞争时，先写入的终态保留；后台任务保留已验证记忆默认值，授权续跑不改写用户已确认输入。
- 专用 loopback 凭据与 MCP 分离，不写入 TaskRun 或审计。Node 参数、结果和原始异常细节只通过内存 ticket 返回当前插件；任务历史保存调用元数据。原始 Node primitive 不作为 Agent 公共 API，Agent 使用插件声明的结构化能力。
- 运行限额：最多 4 个 Node 会话、16 个 HTTP 并发连接、32 个在途 ticket；请求/响应 1 MiB，启动 1500 ms、调用 5000 ms、HTTP 8000 ms，stdin 写入 500 ms。V8 old-space 上限 128 MiB，不能称为进程 RSS 硬上限。回调有显式释放，300 次真实异步文件读取后常驻订阅仍正常。

原生 Tauri 隔离测试已通过：临时数据库和插件目录、incognito Wry 页面，使用产品 Rust HTTP、实际 prepare/get/close 命令、共享权限与 TaskRun 管线、真实 Node。最新原语探针为 9 项权限/生命周期检查和 12 项页面检查，包括一次授权不保存 grant、后台入口原始参数在 Created 落库前拒绝；opaque 页面同步文件读取、SHA256 链式调用、Promise、回调、原始错误返回和父页面隔离也通过。新增真实 HTTP Server 属性写入、只读属性返回 false、严格模式赋值报错。临时数据目录确认已删除。单次 Node 打开约 38–40 ms、首次同步读文件约 9 ms，仅为样本观测，不是延迟预算验收。

插件操作基线：原始 MD5 首次约 18 ms、暖调用均值约 17 ms；文件树小样本首次约 135 ms、暖均约 130 ms，每次 46 次同步 RPC。这是 WebKit + 临时 Node HTTP fixture 的开销基线，不是产品 Rust 管线的延迟分布，也不能套用 Rust matcher 的 25 ms 门槛。同步往返和页面阻塞是下一步优化重点；大目录、稳定 RSS/CPU、长期句柄回收和竞品同机对比仍待测。

已知兼容边界：动态 require、仅使用 Buffer/process 全局而无字面 require 的预加载不会自动触发 Node；同步返回值回调、prototype/instanceof、native addon、完整 Electron API 尚未普遍支持。远程对象字段现在通过真实 Reflect.set 写入，包含函数的赋值仍明确拒绝。当时安装包携带 Node 尚未交付；第四批已补可选 macOS Node22 打包配置，但正式签名、Intel 和安装验收仍待完成。多数插件直接使用的目标仍未达成。

## 第三批交付：授权交互、桌面启动环境与原插件业务

- 授权弹窗独立为 PermissionPromptHost：保守初始焦点、Tab 约束、Escape 拒绝、忙碌状态防重复与穿透、逐请求错误/队列状态、完成后恢复搜索焦点。插件名称按当前后端请求解析，只在弹窗出现时读取；不为显示弹窗拉取完整插件目录。后端队列变更在锁外发无内容通知，覆盖终态删除，其他窗口能及时关闭过期弹窗；本窗口保留真实执行失败反馈，突发通知合并，无空闲轮询。
- 隔离原生 Wry 窗口挂载真实弹窗与生产预加载器，通过真实 Tauri JavaScript IPC，以 DOM 按钮/键盘事件验证请求插件身份、一次授权、记住授权、精确工具 grant、续跑原任务、拒绝、后台取消及资源回收。最终记录 15 项检查通过，58 个 TaskRun 全部终态；新增字面 ESM 的本地同步 collector 和动态 file URL 模块，均实际经过产品 Rust 授权/HTTP 管线。此测试未挂载生产 App/PluginPanel，也不是物理键盘或辅助功能点击验收。
- Node runtime 发现不再只依赖终端 PATH：支持明确配置、打包资源候选、绝对 PATH、nvm default/Volta 和系统常见位置。不执行 shell 或自动下载，不扫描其他 major 来替代 nvm default；无插件时不解析/启动 Node。真实原生授权探针将应用 PATH 限制到 `/usr/bin:/bin` 后通过，验证了本机 GUI 环境下的 nvm 发现。
- Stats/Dirent 使用显式值传输，类型方法在本地执行，实际文件读取仍到 Node。相同原插件目录样本从 46 降到 34 次 RPC（减少 26%），五次暖调用均值从 126.6 到 100.8 ms。MD5 仍为 5 次 RPC，15.2/15.0 ms 不作为提速结论。两个报告包含源码 hash；不是大目录、p95 或产品 Rust 管线预算验收。
- 弱引用句柄缓存与按下次主动调用批量回收，不新增空闲轮询；独立真实 Node GC 探针验证 12,000 个临时句柄释放、保留引用可用。WebKit GC 时机、长期 RSS 与有持续回调的长会话仍需验证。
- 原样选取 22 个插件执行业务断言：基线 17 通过、1 部分通过、2 受 API/服务阻塞、2 受运行时模块阻塞；10 个加载发布页面并通过业务，9 个有页面操作断言。报告保留原源码 hash、失败原因和清理结果。22 个样本不能换算全部适用插件的覆盖率；临时 Node HTTP fixture 也不能替代完整产品交互验收。后续修复以独立复测报告记录，不覆盖基线失败证据。
- 新增本地 ESM 动态导入：在插件 iframe 内执行 Blob 模块，保留 DOM 与同步 collector 闭包。字面相对模块走现有受控预读，动态 file URL 只用已有授权的 Node 解析和读取；共享 128 模块、2 MiB、1024 次读取预算，校验 canonical root、普通文件与读取前后身份，关闭/超时撤销 Blob URL。扫描器保护字符串、注释、正则、模板、方法/私有成员和除法上下文。静态 ES 依赖、嵌套动态导入、import.meta、网络模块和 native addon 明确不支持，不能当作完整 ESM loader。
- 修复后整批独立复测为 20 个业务通过、2 个 API/依赖阻塞，0 个运行时模块阻塞；Webhook 启停、OpenAPI 破坏性变更 collector、HAR 请求/慢请求/错误断言通过。原始源码未变，监听器、Node 与临时目录回收。繁简转换仍有 Electron/opencc-js 缺口，Office 的宿主版本/服务 gate 没有伪造。报告为 `original-plugin-matrix-after-esm.json`，保留最初基线。
- 新模块操作样本：最终 OpenAPI 冷/暖 77/67 ms，均 22 RPC；HAR 冷/暖 321/165 ms，107/58 RPC；Webhook 启停约 91 ms、30 RPC。这些单次样本表明同步 IPC 仍有明显成本，不作为插件延迟预算通过或同机竞品对比。
- 原生测试回收跟踪本次独占进程组、已确认祖先及 opt-in Node 随机进程标签，包含 Node 自建进程组；发信号前复核观测到的进程身份。回归覆盖超时、父进程快速退出、TERM 期间新建子进程、重复中断及无关进程保留。范围是受控协作测试夹具，不能声称可清理任意恶意改名/reparent 的进程，也不是产品 OS 沙箱。模块同步代码不能被此加载器的 Promise timeout 抢占，关闭页面与 Node 会话仍是生命周期边界。

## 第四批交付：完整页面与宿主能力、可选 Node22 分发

- 真实 App/PluginPanel 隔离原生测试发现并修复 opaque srcdoc 的 hash router 问题：只将 fragment-only history URL 标准化为当前 about:srcdoc 文档 URL，保留浏览器 history、state 和同源安全检查，不增加 allow-same-origin。还修复了全局 module/exports 导致浏览器 UMD 库误判为 CJS 的问题，CJS 的 module 保留在各预加载作用域。原样字符转换发布页面已实际输入得到 13 项转换，MD5/Base64 正确；原样文件树 CodeMirror 页面实际读取临时目录，并通过原按钮更新忽略规则。返回、重新打开和 iframe Escape 均检查资源回收及搜索焦点。最终 production-plugin-panel-native.json 的 24 项检查通过，117 个 TaskRun 全终态、Node/Host 会话及监听均清零，临时数据移除；中文标题/权限来源和原始源码 hash 均核对。范围是隔离 macOS 生产组件和真实 IPC，关闭后台服务及后台节流，未覆盖文件选择器/复制导出/物理输入。
- 发布入口预检只解析真正的 script[src]，源码 TS/TSX/JSX/Vue/Svelte 入口显示需要发布产物或先构建，避免白屏；不把源字符串中的伪 script 当入口。逐资产清单 180 项：77 个磁盘发布入口、69 个需要构建、11 个当前平台不适用、9 个 headless；其余为入口/预加载/资产缺失等。77 也是静态前提，不能称已运行通过。
- 对上述 69 项再做纯读构建条件清点：均有 package/build 脚本，67 项没有根 node_modules，2 项仅具备可进一步复核的目录条件；64 项有锁文件、35 项有来源注明的上游 URL 线索。3 项 build 内嵌 npm install/i，10 项含 postbuild/prepare/verify 脚本，不能据此批量执行。该清点没有安装、构建、联网或运行插件脚本，也不能推断任何项目只能取上游产物；逐行报告为 source-build-readiness.json。
- Electron app 元数据使用真实应用信息，shell 委托现有权限宿主；移除同步剪贴板的空字符串/无操作伪成功。Clipboard 由不依赖 Node 的单独宿主能力提供：读写独立授权，未授权的同步调用立即抛错、只发送 scope，不保存正文或自动重放；用户再次操作或显式重新打开后继续。
- Clipboard 共享 capability/permission/TaskRun 管线，但正文、端点和原始私有异常仅存内存 ticket。限定当前窗口/插件实例，手动重开轮换 token；退出、禁用、撤销和过期授权不复活会话。最多 16 会话、32 在途 ticket、256 KiB 文本，与 Node/MCP token 和路由分离，无空闲 Node 或轮询。实际 macOS 独立命名 NSPasteboard 已验证空字符串、空白、Unicode/NUL 精确读写；不访问系统 general clipboard。原版 uuid-kit/subnet-calculator 的两份固定 hash preload 业务分别通过，不等同其完整插件 UI 已验收。
- Clipboard 原生报告 13 项宿主与 15 项页面检查、21 个终态 TaskRun；覆盖正文在落库前拒绝、重放、读写 scope、撤销、旧 token、旧窗口关闭和最后 listener 回收。权限 UI 单独验证友好名称、读取隐私/写入覆盖风险与再次操作提示，不向界面显示私有正文。
- Buffer 新增本地整数/浮点/64 位数值读取及 Node 别名，图片 PNG 宽高解析不增加 IPC；偏移、短 buffer、NaN/Infinity、子数组 byteOffset、修改后字节和序列化依赖用真实 Node 做差分。固定 Node22 下 58 项 Buffer/桥接回归通过；原样 Snipaste 的 PNG parser 在隔离 opaque WebKit 中核对 1×1、错误签名、短 buffer，临时 Node/监听/隔离目录均回收。该原插件探针使用 Node24 和临时传输，不是完整截图功能或产品 Rust 管线验收，也不是完整 Buffer API 实现。
- manifest.title 在数据库 manifest JSON 中保留，搜索结果、激活窗口、授权提示、能力目录和已安装列表使用中文标题，稳定 name/id 不变。旧版本已丢弃标题的现有安装记录需重新导入；没有为每次搜索新增磁盘扫描。
- 可选完整运行时配置使用固定版本 Node v22.23.3 官方 SHA-256 归档，只提取 node 与许可证；不运行下载脚本、不安装系统 Node、不自动更新。打包 externalBin 放在主可执行文件旁并优先发现，Node22 配置的最低 macOS 为 11.0；默认离线 core 配置保持独立。ARM64 实际 debug .app 已生成并从包内执行 Node/crypto 验证，受限 PATH 原生授权探针实际选择随包 Node22，子进程 node --version 同样正确，17 项检查通过。没有安装或启动该完整 .app，不代表正式签名/公证/干净机器/Intel 验收。
- 官方 ARM64 Node 二进制 112,925,600 字节（107.7 MiB）；本机 debug .app 约 267.8 MiB。该包体成本不能隐去，也不能作为 release 包体结论。前端主入口约 241.27 kB，插件宿主仍单独懒加载约 364.51 kB，560 KiB 首屏门槛通过。尚未完成原生热键 P99、release 包体及稳定 RSS/CPU 预算。
- 打包独立复审发现仅信任包内 metadata 可同时伪造二进制摘要，已将可信二进制大小/摘要与许可证摘要固定到仓库 pin，并让解包和包内校验都核对这些值；签名字节变化需绑定 App 和 Node 的同一预期 TeamIdentifier。8 项打包测试通过，包含同时替换包内二进制及 metadata 仍被拒的回归，假二进制从未执行；已有 ARM64 实际包在新校验器下执行通过。签名检查目前仅有命令契约测试，正式签名/公证仍待 CI，不称安全发布完成。

### 原插件诊断副作用与校正

扩展诊断误执行 TinyRDM 的 DOMContentLoaded 自启动钩子，原生 detached 服务曾存活于 Node 父进程之后。已按已确认 executable/PID 停止，之后已知 PID 不存在，IPv4/IPv6 8088 拒绝连接。静态二进制分析表明默认监听 0.0.0.0:8088，缺少 ADMIN_USERNAME/PASSWORD 时认证关闭；这不是 loopback-only 进程。真实 Preferences/TinyRDM 目录及配置文件 birth 时间与诊断相符，原插件还执行了 chmod/xattr。未读取配置或凭证内容、未删除/移动用户目录；无测试前 mode/xattr/目录基线，不猜测恢复。运行期外部连接、旧配置访问和精确启停时间仍待确认。

事件证据：`output/legacy-node-2026-10-15/tinyrdm-probe-incident.json`。之前 listenerClosed/nodeProcessStopped 只证明临时传输与 Node 父进程关闭，不能证明原生子进程无副作用。后续 fixture 为每次运行隔离 HOME/XDG/APPDATA/TMP，清除环境凭证并实测子/孙进程继承；这仍不是 OS 沙箱。未能约束自启动/外部监听/真实路径写入的插件保持 not_exercised，恢复执行前先审源，不再广泛运行未知原插件。

## 第五批交付：命令操作、发布包一致性与原生性能样本

- 搜索结果、最近使用和首页卡片支持右键或 Shift+F10 打开操作菜单，支持键盘选择、固定/取消固定、移除最近使用、Escape 返回搜索焦点。固定只保存有上限的显示快照，实际执行仍由当前后端解析；冷启动不额外拉取完整目录。Chromium 的生产 App + 显式模拟 IPC 验证了 7 项流程，包含重新挂载和 480×280 小窗口；不是原生后端或物理输入验收。证据为 `output/launcher-ui-2026-10-15/launcher-actions.json` 与同名 PNG。
- 增加统一 package resolver，扫描、加载、导入、更新和 Agent preload 选择同一个包根目录；只有同名同版本且本地资产完整的 dist 才能替代源码入口，不逐文件从 public/source/父目录补找。manifest Web main 前导 `/` 依据上游 path.join 行为局部规范化，原 JSON 保持不变；HTML `/assets` 按插件根解析是 ATools 兼容策略，不宣称已经核实为 ZTools 实现。headless、原生 runtime.entry、TS/Vue 源码入口、空 HTML、HTML tokenizer、base URL、路径和字节预算有合成回归。
- ZIP、ASAR/ZPX 预览共用有界入口检查。导入不执行 preload；复制后再次验证完整 typed/raw manifest，避免复制中的清单变化造成数据库和文件分叉。拒绝源/目标目录重叠且不先创建目标目录；本地重装、更新和批量覆盖均保留已有停用状态，失败时恢复既有文件/数据库。
- 目录复制预算为 4,096 条目、深度 32、单文件 32 MiB、总计 128 MiB，以实际读取字节计数；macOS/Linux 用保留的目录句柄、openat/no-follow 和文件身份复核，拒绝特殊文件，只跳过 node_modules/.bin 的链接。Windows 当前仍为有预算的路径复制，不声称具有同等竞态防护。ZIP/ASAR 文件读取限制 64 MiB，解压总计 128 MiB；清单 256 KiB，HTML/preload 各 2 MiB，HTML 引用最多 512。
- 只读 canonical 快照覆盖 180 个本地目录：92 ready、75 requires_build、12 incomplete、1 unresolved。ready 仅表示静态入口/资产完整，不表示依赖可用、当前平台或业务通过。两个已有本地 dist 及匹配 release ZIP 实际完成临时目录/SQLite 导入；这些未跟踪/忽略产物的远端发布来源未核实，没有执行它们的 UI/preload。证据为 `canonical-package-readiness.json`、`local-published-import.json`。
- 启动时内置插件只注册元数据和工具，不再为发现插件而执行所有 preload；合成危险标记和无效 JS 均未执行。旧 Node Agent 适配器也移除了跨目录补找及缺失 yaml/pdf-lib/systeminformation 的假实现；缺少依赖明确失败。该旧适配器的 Electron stub、每次调用新进程及全用户 Node 权限仍是待补差距，不能混同于已实现的 UI Node 真实传输能力或 OS 沙箱。
- 原生 App/PluginPanel fixture 做了 5 个独立 Wry 进程，每轮 20 次热查询：launcher-ready P50 286 ms，首次查询 P50 22 ms（catalog 可能已准备），100 次热查询 P50/P95 2/19 ms，10 次返回焦点 P50 29 ms。两个 750 ms quiet window 的宿主 PID CPU P50 为 0.415%/0.212%，宿主 RSS 约 127.4/129.7 MB；不含 WKWebContent/Node，后台服务关闭，插件元数据已在计时前导入，不能作为正式 App 冷启动/待机或全进程 RSS 预算。每轮关闭后本 fixture 的 Node/host 会话和监听器为零，原插件哈希未变、页面错误数组为空。证据为 `production-plugin-panel-performance.json`，早期无 quiet window 报告单独保留。
- 当前前端生产构建入口 247.27 kB（gzip 70.70 kB）；PluginPanel、SystemPanel、拼音仍独立懒加载，560 KiB 首屏检查通过。前端组件测试 243 项通过，Svelte 检查为零错误/警告；Core、API Shim、Plugin 完整测试及新增导入/复制回归通过。具体后续修改仍需按本批验证记录复验，以上不是 release 签名或多数插件业务验收。

### 旧测试的隔离修正

本轮曾误跑既有 Harris E2E，旧“发现全部 29 个插件”测试实际会执行原 preload，Node 子进程没有私有 HOME。可达的 system-manager 顶层初始化包含用户目录创建；只读元数据核对显示该目录 birth/mtime 早于本次测试，但没有运行前全量基线，不能证明所有可达路径都无副作用。未读取用户配置内容或做猜测性删除/恢复。现已将发现测试改为仅清单/文件存在性与索引；四项已审查的工具断言在清空环境、私有 HOME/XDG/APPDATA/TMP 的独立测试子进程内执行，并验证临时目录删除。私有目录不是 OS 沙箱，也没有恢复广泛执行未知插件。记录为 `harris-preload-test-isolation.json`。

## 第六批交付：插件变更、活动页面与审批一致性

- 安装、同版本覆盖、更新、导入、启停和卸载共用按插件 ID 的执行/变更门禁。既有调用完成后才替换代码；其他插件使用独立门禁。复制、解包和持久化工作在后台执行，变更 worker 最多 4 个；全局提交锁只保护最终目录切换与数据库提交，成功后的备份清理在锁外。市场下载和预检在关闭旧插件之前完成。
- 代码替换前关闭该插件的 UI Node/Clipboard 实例、私有 intent/ticket、QuickJS context、旧 Node Agent 元数据和受管理 sidecar，并关闭当前页面。前端拒绝过期激活结果，显示完成后的更新/停用/卸载提示，恢复搜索焦点，等待用户重新打开；目录刷新合并突发事件，不增加空闲轮询。无关插件的页面与激活保持可用。
- 代码替换取消旧的待审批请求，并撤销该插件的历史工具授权，覆盖工具行已被 prune 的私有能力和新清单重新引入的旧工具名。纯启停保留已保存授权，但仍取消待审批请求。排队的公开插件任务在 Created 落库前绑定能力快照，同版本替换后拒绝旧调用；私有 Node/Clipboard 高频调用沿用实例 intent 校验，避免每次 RPC 都计算摘要。
- 代码修订使用 SQLite 持久化随机标识，不依赖只有秒精度的 updatedAt。相同清单、版本与时间戳下仍可区分覆盖。写入中或中断的修订拒绝新公开任务，重新安装/更新完成后恢复，避免应用重启把未完成修订当作旧授权的原代码。
- 审批保存授权时核对当前 request ID，并在 SQLite IMMEDIATE 事务中确认任务仍待审批、客户/工具/输入一致。重复请求按 TaskRun 去重；拒绝后清理待审批 UI。终态任务不能通过旧 runId 隐式变成重试，显式 retry API 仍保留。
- UI 发起的变更留下独立 TaskRun 和持久化结果 Artifact，代码落盘不标为插件业务验收。阻塞 worker 持有门禁到工作完成，调用方取消等待不会提前释放仍在写入的插件。
- 当前前端 265 项通过，Svelte 零错误/警告；生产入口 257,151 字节，低于 573,440 字节门槛，PluginPanel/拼音保持懒加载。workspace 编译、Core 全量、Plugin 单元测试、插件变更定向测试、Agent 17 项和待审批队列 5 项通过。Finder 桌面环境测试在受限执行中失败，在桌面环境中重跑通过；未以修改断言掩盖环境差异。

原生最终合成插件报告 `plugin-mutation-native-final-after-code-revision.json`：61 项断言通过，27 个 TaskRun 全部终态，临时数据已删除。覆盖相同版本覆盖、旧面板关闭、新版显式重新打开、一次授权、旧审批取消/重放拒绝、排队取消、排队旧快照拒绝、已保存授权撤销、无关插件可用、停用后缓存代码拒绝和卸载回收。最终 Node/Host 会话、Host intent/invocation、opening 和待审批数均为零，两类 transport 均已关闭。测试只生成合成插件，未运行社区插件；不代表多数插件业务验收。

原生测试暴露同步 Wry 命令使用 tokio::spawn 时缺少当前 reactor 的崩溃，已改用 Tauri 的共享 runtime，真实 start_agent_tool IPC 的排队/取消场景已重跑通过。早期 panic、一次未定位原因的 disabled-feature 断言失败和早期 29 项基线均保留。最终 fixture 用调用前后的 TaskRun ID 集合定位本次结果，不再依赖秒精度时间戳下的 latest 排序。QuickJS 的旧回调与新 context 隔离由 crate 单元测试覆盖；原生 fixture 的 sidecar 管理器存在不等于实际启动并验证了每一种 sidecar。

`production-plugin-panel-performance-after-mutation.json` 的当前代码五轮样本通过：launcher-ready P50 291.6 ms，首次查询 P50 22 ms，100 次热查询 P50/P95 2/19 ms，返回按钮焦点 P50 28 ms、iframe Escape 探针焦点 P50 27 ms。两个 750 ms quiet window 的宿主 CPU P50 0.386%/0.234%，宿主 RSS 从插件前约 128.5 MB 到最终 file-tree 关闭约 131.8 MB。每轮原插件源码哈希不变、私有环境删除，关闭后运行资源计数归零。与第五批一样，这不包含 WKWebContent、Node 和辅助进程，关闭后台服务，不构成全应用 RSS、物理热键或 release/竞品预算；5 次启动的分位数只作样本描述。修订标识加入前的另一轮样本保留为 before-code-revision，不能混作当前代码测量。

## 第七批交付：单一插件导航、输入契约与真实首屏预算

- 插件打开后收起启动器搜索框，将返回入口、插件标题、标准子输入和窗口操作放入同一条 56 px 导航栏。插件未调用 setSubInput 时不显示输入；默认 setSubInput(callback) 可见并聚焦，removeSubInput 后焦点归还 iframe。明确返回总是关闭插件，空输入的 Escape 遵守设置，非空 Escape 先清空；空 Backspace 返回。输入列表的方向键与 Enter 只在列表接管时消费，组合输入和修饰键受保护。
- 子输入桥拆为独立模块，主回调不再依赖 onSubInput 注册。精确保留空串、零、false 和重复值；setSubInputValue 仅更新值并按已有契约请求焦点，不会重新显示已移除的输入。父页面和 iframe 的消息同时绑定文档 epoch 与配置 generation，拒绝旧页面、旧回调与已移除输入的消息；焦点动作在渲染后验证仍为当前请求。页面退出会解除监听与回调，无额外轮询或 Node 启动。
- 前端全量 300 项、子输入/导航定向测试、Svelte 零错误/警告、workspace 编译通过。两个 Chromium 浏览器回归均通过，覆盖唯一输入、几何边界、结果层、iframe 自定义 Escape 和返回焦点，控制台无错误。最终原生 `plugin-navigation-native-final-pass.json` 在真实 App/PluginPanel + Tauri/Wry 上通过 29 项断言、5 个 TaskRun 全部终态；生成纯 Web 插件无 preload，活动与关闭状态的 Node/Host 会话、intent、调用和监听计数均为零，临时目录已删除。早期失败报告保留，定位为 fixture 在输入状态提交前连续发键，调整事件等待后通过；产品代码未因此改动。仍未覆盖物理输入、多窗口和其他平台。
- 纠正了旧包体门禁只统计 HTML 入口的盲点。相同代码仅切换 Rollup onlyExplicitManualChunks 的对照构建显示：修复前入口静态导入 PluginPanel，实际首屏图 628,751 字节，新门禁拒绝；修复后静态图 307,384 字节，低于 573,440 字节预算，PluginPanel/拼音保持动态加载。历史章节中的单入口字节数和旧门禁通过不能作为完整静态图的验收。新增静态图 4 项回归，覆盖传递依赖、共享块去重、环与懒块误拉入；构建失败也会清理临时目录。证据为 `output/launcher-ui-2026-10-15/release-static-graph-regression.json`。最后将子输入 reducer 的属性判断替换为适配 Safari 14 目标的原型方法，9 项定向回归和更新后的包体对照通过；上面的原生时序样本采集在这项等价替换之前，不据此声称原生性能改善。

`production-plugin-panel-performance-after-navigation.json` 的五轮当前代码样本：启动就绪 P50 287.2 ms，首次搜索 P50 21 ms，100 次暖搜索 P50 2 ms、范围 1–20 ms；返回按钮焦点 P50 28 ms，iframe Escape 焦点 P50 27 ms。约 750 ms quiet window 的宿主 CPU P50 为启动后 0.394%、最终关闭后 0.249%，对应宿主 RSS 约 128.8 MB 与 131.7 MB。两个经过审查的原插件 char-transform/file-tree 哈希均不变，所有关闭点会话与监听计数归零，五份环境清理完成。只统计 smoke host PID，排除 WebKit/Node/辅助进程并关闭后台服务；这不是正式全应用空闲、release、物理热键或竞品预算，少量启动样本不建立稳定 P99。

## 第八批准备：上游发布包来源与有界预检

对 75 个 requires_build 目录中的五个候选，通过当前官方下载 resolver 核实实际 ZIP URL。最终只读审计为 2026-10-15 17:46:02–17:46:07 UTC，11 次官方 HTTPS 请求成功；五份 ZIP 的容器、路径、条目数、大小、软链、中央目录/本地头和 CRC 检查通过，没有识别到 native 文件。没有安装、构建、落盘解包或执行插件，临时下载目录已删除，市场信任策略保持现有流程。发布者未提供上游校验和、签名与公钥，自算 SHA 只标识本次字节。

| 候选 | 当前官方产物 | 本次结论 |
| --- | --- | --- |
| ai-helper | 1.2.1 | 本地/历史 1.1.0；新版本且扫描有不确定项 |
| color-helper | 1.1.0 | 本地/历史 1.0.0；新版本且有计算式动态 import |
| json-tools | 1.22.0 | 与历史摘要相同；静态扫描 token 预算耗尽，需复核 |
| diff-compare | 1.0.1 | 同版本但与历史摘要不同；静态扫描预算耗尽，需复核 |
| regex-editor | 1.0.0 | 字面静态引用检查通过；与历史摘要不同，尚未业务验收 |

ZIP 二进制预检与静态引用扫描拆为独立模块。下载单份最多 50 MiB、20 秒、2 次逐跳同主机重定向；内存解压总量最多 64 MiB。扫描单文件 8 MiB、总源码 16 MiB、每包最多 100 万 token、16,384 引用边和 1,024 个缺失路径，每类诊断最多 64 个样例，每条最多 240 字符。超过预算保留为 needs_review，不通过扩大预算提升就绪数；审计工具不接入启动器启动或空闲流程。

独立复核发现并已修复多行 import 漏报、ZIP 父路径的二次复杂度、重复引用造成的诊断内存放大，离线合成回归通过并接入 fast tier。早期 `json-tools assets/file` 是正则误报，已在最终报告修订记录撤回，不能据此断言官方包缺文件。最终报告含对应源码摘要、HTTP 与容器结果、扫描消耗和未覆盖项：`output/legacy-node-2026-10-15/published-artifact-source-audit.json`。本批不增加运行成功数，92/180 静态入口就绪也仍不等于业务覆盖。

## 第九批推进：可读功能名称与完整发布来源清点

- 激活结果从当前插件清单和精确 feature code 投影可读名称，依次选显式 label、explain、带标签命令和文本命令；忽略旧数据库将 code 填入 label 的回退值。搜索与激活身份、payload、权限和 TaskRun 的内部 code 不变，不增加搜索或磁盘读取。插件导航展示可读功能名，与插件标题相同时不重复；内部 code 和名称来源放入默认折叠的诊断。直接激活、旧记录、多个功能与分离窗口都有回归。
- 对最新 canonical 的全部 75 个 requires_build 目录，按 manifest name 查询官方 resolver。2026-10-15 18:03:47–18:03:48 UTC 的 76 次请求（目录一次、resolver 75 次）返回 75 个官方 ZIP 地址；目录版本中 18 项与本地不同、52 项相同、5 项未知。此处只读元数据，没有下载 ZIP、安装或执行，地址存在不证明 ZIP 可取得、版本相符或业务可用。最新本地静态分类仍为 92 ready、75 requires_build、12 incomplete、1 unresolved；180 项未因查到地址而增加运行通过数。逐行证据为 `published-source-catalog.json`，绑定重新扫描的同一候选集合与脚本摘要。
- resolver 审计有并发 3、全局 120 秒、单次 20 秒/2 MiB、逐跳同主机 HTTPS 和 URL 长度限制；业务状态错误、HTTP 200 非 JSON、非官方下载主机分别保留，未把无效响应视作可用。合成离线回归加入 fast tier，网络审计不加入常规快速测试，也不进入启动器空闲路径。
- 为正则编辑器选定当前官方 1.0.0 ZIP，固定 SHA-256 `fee84e6dd54f77651b8cef0c9485a10d71c5fa1e18a9eac897f771f1884b0c49`。仅在私有临时目录保留 7 个原始文件，ZIP/CRC、路径、清单及逐文件字节验证后审阅 preload 与页面入口；审阅工具使用同一份已验证归档缓冲，避免验证后重新按路径读取造成时序空隙。没有修改社区源包或虚构 AI 接口，实际离线业务与加载器修复的结果另行记录。
- 真实发布包暴露 head 外链 defer 被宿主内联后提前执行的缺陷。按 [HTML 脚本调度规则](https://html.spec.whatwg.org/multipage/scripting.html#attr-script-defer)，classic defer/async 保留为真正的本地外链，由解析器调度；保留原属性、MIME essence、base、查询/fragment 字节和 currentScript 的目录，不再读取或复制这些 bundle 到 srcdoc。原生 asset 协议在不含 allow-same-origin 的隔离 iframe 中实测为 interactive 时执行且正文已存在。Chromium 基线重现提前执行，修复后顺序、跨脚本全局变量、module/async 边界、Webpack publicPath 和普通相对图片解析均通过，控制台无错误；父页面 Blob 方案未通过隔离加载验证，已经完整撤下，失败快照保留，没有以放开同源隔离绕过。对应单独 baseline/parent-blob-failure 报告；旧固定名通过报告在第十二批运行时被覆盖，不能再作为原时点快照，当前通过证据与保存说明见第十二批。
- 当前完整前端 40 文件/319 项通过，Svelte 0 错误/0 警告；资源 HTML/runtime、测试分层与静态依赖图回归通过。资源 runtime 旧测试补上生产子输入桥的真实序列化工厂，恢复原有动态资源断言，没有用空实现绕过。

`published-regex-editor-native-final.json` 在真实 App/PluginPanel、Rust 导入/搜索/激活、一次性权限和 Node22 管线上通过 35 项检查、8 个 TaskRun 全终态。原包实际页面验证两次全局匹配、捕获组、g 开关、非法输入及恢复、中文范例的两个匹配片段和本地 canvas；真实缺失的可选 allAiModels API 保持缺失，原包走离线分支，没有伪造模型或 AI 结果。只核对离线提示和画布存在，未验证本地解释文本的语义准确性；AI、文件读写、剪贴板、物理输入和其他插件不在这次验收范围。renderer CSP/console 诊断均为零；Node 不具有 OS 网络或文件系统沙箱，关闭后本 fixture 的会话、intent、调用、opening、待审批和 transport 均为零。7 个原文件再次核验未变后，精确的准备目录与 ZIP 已删除，source-review 的 retention 字段单独记录清理；审源阶段与后续业务运行分开保留。

早期 setup reactor、fixture CSP/目录 scope、加载空白、缺失 API 的 typeof 断言及 Vue 更新前读取状态等失败分别留档。产品只修复真实脚本调度；fixture 对异步渲染等待真实 DOM 状态。原生 runner 另修了固定输出路径可能读取旧报告的隐患：后续子进程只写入本次唯一 scratch 路径，校验后再发布，不读取调用方的旧输出。此 runner 新鲜度修复在上述已独立命名的最终运行后完成，不据此虚称又执行了一遍原插件。

`production-plugin-panel-performance-after-feature-labels-and-defer.json` 的五轮当前工作树样本全部通过：launcher-ready P50 288.7 ms，首搜 P50 21 ms，100 次暖搜索 P50/P95 2/19 ms（范围 1–21 ms），返回按钮焦点 P50 28 ms，iframe Escape 焦点 P50 27 ms。约 751 ms quiet window 的宿主 PID CPU P50 为启动后 0.383%、最终关闭后 0.223%，对应 RSS 约 128.6 MB 与 131.7 MB（十进制）。5 轮原插件哈希不变，环境删除，关闭点的运行资源计数为零。仅统计 smoke host PID，排除 WebKit/Node/辅助进程、关闭后台服务；阶段时间还包含只读探针可能的重试等待，不是插件冷启动预算。少量启动样本不建立稳定 P99，也不代表 release、物理热键、完整待机或竞品性能。最新生产构建首屏静态图为 307,384/573,440 字节，宿主/拼音保持懒加载，见 `release-static-graph-after-feature-labels-and-defer.json`。

## 第十批推进：源码候选到发布版的可操作路径

- 需要构建的候选保持不可勾选，状态明确为“需要发布版”，提供“在官方市场查找发布版”。导航使用校验后的 manifest name，精确匹配目录 ID，不使用展示标题或目录名猜测。候选行提取为独立组件，复用原有选择标签、键盘焦点和禁用状态。
- 官方查找是本次访问的临时来源，保留用户保存的自定义地址；可清除目标、搜索本次返回的目录、恢复原来源。接口当前只返回有限条目，页面明确说明没有加载的分页不在列表，找不到目标不等同于官方没有发布包。
- 市场目录、事务和会话拆为独立模块；解析之前加锁，冻结来源、插件、签名、公钥和安装/更新动作。来源变化或离开页面后，未执行的解析和确认失效；已确认的任务跨设置页与首页导航保留锁、进度和取消入口。迟到响应不能覆盖新来源，安装成功后的列表刷新失败不变成重新安装。失败重试继续使用原来源快照并重新确认。
- 会话按需创建，进度采用事件订阅，没有轮询；页面和进行中的任务均不存在时释放目录、列表与进度缓存。此处只保证单窗口渲染进程内恢复，不保证跨窗口下载互斥或应用重启恢复；下载前的 resolver 失败也没有因此获得持久 TaskRun。真正的安装命令继续走已有 Rust 校验与 mutation 管线。
- 无签名安装须同时匹配 ZTools 类型和精确 HTTPS 官方目录主机/路径，拒绝 userinfo 与冒充来源；任一签名或公钥字段存在时必须完整且本地 pin，不能回退为官方无签名。新安装插件保持停用，完成后提供“查看并启用”，沿用权限审阅。市场“打开来源”和通用配置“打开市场地址”共用组件，通过现有结构化能力打开并显示失败原因。
- 当前前端 45 文件/366 项通过，Svelte 0 错误/0 警告，workspace 离线编译通过；两个 Rust 市场信任定向测试分别通过。独立复核重新执行 38 项市场测试，未发现新的 P1/P2。原来依赖函数名和整行表达式的市场断言改由真实组件点击和 App 路由行为覆盖。生产首屏静态图为 307,928/573,440 字节，宿主/拼音保持懒加载，见 `release-static-graph-after-market-recovery.json`。

真实 Chromium 的最终 run `2026-10-15T19-07-00.164Z` 通过 8 项检查，runner 以 0 退出：实际 App → 导入行 → 市场的 Enter/Space、精确 ID 排除相似条目、搜索空结果、原来源恢复、480×400 无横向溢出和滚动后可操作、取消确认零安装调用、再次确认恰好一次官方来源安装调用且不自动启用。来源按钮与成功反馈在滚动后均完整可见；不要求长页面内容同时位于首屏。4 张截图有独立 run ID 和实际尺寸，18 个产品/fixture 文件起止摘要一致，控制台与 CDP 超时为零，三项自有资源清理成功，独立确认测试端口已关闭。全部市场、下载地址、打开来源和安装接口均模拟，没有访问上游目录、下载 ZIP、执行社区代码或验收真实后端安装。fixture 预热懒组件以避免开发服务器优化重载，此探针不验证懒加载时序，首屏预算由生产构建单独证明。早期选择器、页面重载、截图等待和 runner 收尾失败保持与最终通过分离；早期固定路径曾覆盖部分失败报告，不声称保留了全部失败历史。

`production-plugin-panel-performance-after-market-recovery.json` 的五轮已审阅原始 char-transform/file-tree 样本全部通过：launcher-ready P50 292.2 ms，首搜 P50 22 ms，100 次暖搜索 P50/P95 2/19 ms（范围 0–21 ms），返回按钮焦点 P50 28 ms，iframe Escape 焦点 P50 27 ms。约 752 ms quiet window 的宿主 CPU P50 为启动后 0.370%、最终关闭后 0.230%，RSS P50 约 129.2/132.2 十进制 MB。五轮原文件哈希不变、临时环境删除，关闭阶段受管会话与连接计数为零。此夹具没有打开市场页，未测市场活跃时的资源占用；只统计 smoke host PID，排除 WebKit/Node/辅助进程，关闭后台服务，既非正式发布包、物理输入、完整待机，也不建立竞品性能或稳定启动 P99。当前批次汇总为 `market-recovery-delivery-verification.json`，整体目标仍 active，没有将 92/180 静态入口就绪或 75 条发布地址转换成运行覆盖率。

## 第十一批推进：官方单插件查询与版本锁定

- 新增按精确插件 ID 查询官方发布元数据。Rust 命令固定请求 ZTools 的 latest 接口并区分可用、未找到、当前平台不支持和请求/响应错误；UI 对应展示状态并提供重试。安装与更新把用户确认时看到的版本传给后端，归档清单版本不匹配时在生命周期变更前拒绝，保留现有安装。新元数据 HTTP helper 限制 URL 2048 字节、总时限 15 秒、响应体 2 MiB、同主机同端口最多两次重定向；没有常驻轮询。
- `official-market-target-native-probe.json` 记录 7 次真实 Rust 元数据请求：regex-editor 1.0.0 可用、5 个 Windows 专属 ID 在 macOS 返回 unsupported_platform、固定不存在探针 ID 返回 not_found。总耗时 380 ms 仅是本轮请求描述，不构成性能承诺；探针不经过 Tauri IPC、GUI、ZIP 下载或插件安装。
- 官方目录复查纠正了第十批对有限分页的推断：`/api/market/plugins?limit=30&platform=darwin` 实际返回 220 个分类插件 ID，`limit=30` 只限制最新列表。原先五个版本未知的 ID 是 Win32 专属条目，并非目录分页缺失。第十批结论保留为当时证据，本批不据元数据查询增加插件运行覆盖。
- `plugin-market-target-browser.json` 的真实 Chromium 运行通过 10 项检查，20 个产品/fixture 文件起止哈希一致。覆盖 App 到导入行的 Enter/Space、480×400 滚动与无横溢、未找到/平台不支持/请求错误及重试、确认取消与确认安装、安装和更新都携带 1.0.1，且新安装保持停用。所有 IPC 均为模拟，没有下载 ZIP、执行社区代码或验收真实后端安装。
- 前端 46 文件/380 项通过，Svelte 0 错误/0 警告；5 个离线 Node 脚本通过。Rust 共 30 项不同的定向用例通过（目标查询 11、HTTP 边界 7、版本校验 6、探针 4、目录解析 2），工作区离线编译在格式恢复后通过；没有声称全量 Rust 测试重跑。生产首屏静态图 307,961/573,440 字节，比上一批增加 33 字节；PluginPanel 与拼音继续懒加载。
- `production-plugin-panel-performance-after-market-target.json` 的五轮已审阅 char-transform/file-tree 样本保留了 386.4 ms 启动尾值：launcher-ready P50 287.6 ms、范围 283.0–386.4 ms；100 次暖查询 P50/P95 2/19 ms，首搜 22 ms，返回焦点 28 ms，iframe Escape 焦点 27 ms。quiet-window 宿主 CPU P50 为 0.425%/0.242%，RSS 为 129.0/132.2 十进制 MB。仅统计宿主 PID，排除 WebKit/Node/helper；关闭后台服务，市场未打开。这不是 release、物理输入、竞品或稳定 P99 结论。原插件哈希不变、临时环境已清理，关闭计数归零。
- `src-tauri/src/commands.rs` 一度被格式化工具改写；现已从可验证的 turn-start 快照恢复，只保留本批四个函数和 import。独立非写入 formatter 等价核验见 `market-commands-format-recovery.json`。探针和性能样本编译时的 commands 摘要是恢复前版本；汇总报告分别记录编译/测量摘要与当前摘要。

本批汇总见 `output/legacy-node-2026-10-15/market-target-delivery-verification.json`。本批仍未扩大已审源码插件的真实业务矩阵。最新静态清点仍为 92 ready、75 requires_build、12 incomplete、1 unresolved；不能据此声称多数插件已直接可用。

## 下一阶段：让多数插件实际直接使用

1. 单一插件导航、标准子输入契约、Escape/Backspace、组合输入和可读功能名称已完成隔离回归；继续补齐多窗口与真实物理输入。
2. 在 CI 中验证可选 Node22 完整运行时的正式签名/公证、Intel 构建与干净机器安装，测 release 包体、原生冷/热启动和关闭后的空闲资源。ARM64 debug 打包与包内 Node 执行已验证；没有运行插件时不得常驻启动 Node。
3. 减少同步往返，处理长期句柄资源与目录扫描阻塞；活动会话、Agent context 和 sidecar 已接入统一失效，还需扩展多窗口、真实 sidecar 和纯 QuickJS 原生场景。补齐动态 require、Node globals 和 Electron 的真实能力及明确错误，不用空对象模拟成功。
4. 对适用插件逐项执行原发布入口与代表功能，记录版本、平台、入口、结果断言和失败原因。工作目标为当前平台适用插件至少 90% 直接运行；未经过真实交互验证的项目继续标为待验。
5. 对 75 个需要构建的目录、缺失发布入口、原生 addon、专属平台和外部服务依赖保留明确例外；按 ID 官方元数据查询已接入，目录复查确认 limit=30 只限制最新区，分类中有 220 个 ID。下一步扩展经过源审阅的发布产物真实业务矩阵，并补齐跨窗口下载互斥与恢复。不能把源码目录扫描成功、元数据存在或 resolver 地址存在算作可直接使用。
6. 按同机固定样本测原生启动、热键、插件冷/热启动、退出回收和稳定空闲资源，再进行 ZTools/uTools 对照。搜索或清单解析通过不能代替这些指标。

## 已执行验证与复现

- Core：124 项通过（包含匹配性能和 Harness）。Plugin：47 项通过。API Shim：20 项通过。
- 后端模块读取边界：4 项通过。组件与行为测试：48 项通过。
- Svelte：0 错误、0 警告。生产构建、首屏包体门槛、`cargo check --workspace` 通过。第二批组件/行为测试 89 项通过；Core/Plugin/API 全量再次通过；HTTP 10 项、会话 10 项、TaskRun 状态竞争 10 项、宿主 pipeline 8 项通过。
- 第四批阶段验证：前端全量 231 项，Core/Plugin/API 全量、类型检查、生产构建、首屏预算和 workspace 编译通过；宿主 Clipboard 6 项及权限上下文 1 项通过，原生报告分别保留。第三批最终前端全量 175 项、Core/Plugin/API 全量、类型检查、生产构建、首屏预算和 workspace 编译通过；独立真实 Node 属性/回调/值复制、跨窗口队列、原生授权 UI 与原插件矩阵证据分别保留，不相互替代。
- 真实浏览器：首页明暗与紧凑布局、中文输入、键盘、按需加载、长列表滚动与分组几何通过；控制台 0 警告/错误。现有插件宿主浏览器回归通过。
- 插件模块加载和搜索经过独立复审；发现的路径越界、旧加载回调、部分失败提示和图标覆盖问题均已修正。
- 扩展宿主 `agent_tools::` 测试中的现有 Finder 环境测试曾在受限环境失败：连续原生读取的错误文本不一致。随后在原生桌面环境定向重跑通过，保留该环境差异；本次 TaskRun pipeline 的定向测试通过。

本机 pnpm 包装器解析固定版本时因无法读取 registry 元数据而停住，验证直接使用现有本地 Node、Vite、Vitest 和 Svelte 工具完成，无需安装新依赖。

```sh
node node_modules/vitest/vitest.mjs run --config vitest.config.ts
node node_modules/svelte-check/bin/svelte-check --tsconfig ./tsconfig.json
node scripts/test-launcher-ui-browser.mjs
node scripts/test-launcher-list-browser.mjs
node scripts/test-launcher-actions-browser.mjs
node scripts/test-permission-dialog-browser.mjs
node scripts/test-plugin-host-smoke-browser.mjs
node scripts/test-release-bundle-budget.mjs
node --test scripts/test-release-bundle-graph.mjs
node scripts/test-ztools-published-artifacts.mjs
node scripts/audit-ztools-published-artifacts.mjs --selection-only
node scripts/audit-ztools-published-artifacts.mjs
node scripts/test-ztools-published-sources.mjs
node scripts/audit-ztools-published-sources.mjs
node scripts/test-published-plugin-fixture.mjs
node scripts/test-plugin-deferred-scripts-browser.mjs
node scripts/test-plugin-market-recovery-browser.mjs
cargo test -p atools --lib plugin_resources::tests --offline
cargo test -p atools --lib plugin_packages:: --offline
cargo test -p atools --lib plugin_directory_copy::tests --offline
cargo test -p atools --lib ztools_import:: --offline
cargo test -p atools --test ztools_import_tests --offline
ATOOLS_NODE_BINARY="$PWD/src-tauri/binaries/node-aarch64-apple-darwin" cargo test -p atools-plugin --test preload_adapter_tests --offline
cargo run -p atools-plugin --example inspect_packages --offline -- ZTools-plugins/plugins /private/tmp/canonical-package-readiness.json
node scripts/benchmark-plugin-panel-native.mjs
node scripts/probe-plugin-mutation-native.mjs
node scripts/probe-plugin-navigation-native.mjs
cargo check --workspace
node scripts/probe-ztools-node-business.mjs
node scripts/probe-legacy-node-desktop.mjs
node scripts/probe-legacy-node-desktop.mjs --permission-ui --gui-path
node scripts/probe-ztools-plugin-matrix.mjs
node scripts/test-native-smoke-cleanup.mjs
cargo test -p atools --lib legacy_runtime:: --offline
cargo test -p atools --lib agent_tools::task_run_pipeline:: --offline
cargo test -p atools-core --test task_run_claim_tests --offline
node scripts/audit-ztools-runtime-readiness.mjs --output /private/tmp/atools-readiness.json
```

证据目录：`output/launcher-ui-2026-10-15/`、`output/legacy-node-2026-10-15/`。逐插件静态快照：`output/ztools-runtime-gap-audit-2026-10-15.json`。审计脚本纯读插件，不执行、安装或构建插件。


## 第十二批推进：真实发布模块、进入事件与业务边界

本批汇总为 `output/legacy-node-2026-10-15/published-plugin-business-delivery-verification.json`。整体目标仍 active，未确认多数插件可直接使用。官方原包 color-helper 1.1.0（14 文件）、com-ztools-timestamp 1.0.0（5 文件）和 todo-neo 0.0.1（8 文件）经过 ZIP 固定校验值、逐文件审查和运行前后字节核对；仅前两者显式执行，Todo 始终只读审源。没有改写原包、安装依赖、提交/推送代码或替换已安装应用。

- 模块入口保留原 URL、查询/fragment 与原生模块身份，解决内联后的相对 import/import.meta 和重复求值问题。Chromium 合成模块图 9 项与 defer 回归通过。原生 Timestamp 曾因内置 asset CORS 与 opaque iframe 的 null 来源不匹配而空白；生产与夹具共用 `atools-plugin` 协议，按窗口/插件/打开实例及代码 revision 撤销资源租约。8 路读取、64 个待处理请求、10 秒读队列、每文件 8 MiB，Unix 从根 fd 逐段拒绝 symlink；关闭/更新/禁用/销毁取消排队准备和已读未交付响应。新模块均低于 500 行，旧大文件仅薄接线。Windows 未实机验收，以上不构成 OS 沙箱。
- 子 HTML 按自身路径解析资源；已有单元检查证明 pages/assets 路径及同一租约复用，没有宣称完成原生子窗口模块矩阵。内联模块、modulepreload、import map 和更广泛动态模块仍未完整迁移。
- Color 首次能渲染菜单但默认页为空。原包 React componentDidMount 晚绑定 onPluginEnter；按本地 ZTools 参考实现补齐单回调替换、只缓存最新未交付 Enter、微任务回放和退出取消，未用固定延迟。复验已进入原始颜色页，红色 HEX/RGB/预览、无效色值保留及绿色恢复通过。收藏仍失败：原包同步检查遇到 Promise 会误判已收藏；实际 data 权限弹窗尚未批准，最小夹具也未注册五个生产 DB 命令，不能归因于 Rust SQLite 执行失败。真实 SQLite snapshot、收藏重挂载和渐变未到达，不记为绿色插件。
- Timestamp 最终原生 run `98ead133-a012-407f-931a-4b7f005fdae6` 通过限定夹具，正常秒/毫秒日期、无效输入恢复、日历反向转换、暂停/恢复和退出清理有效；纯 Web 激活时无 Node/剪贴板 session。业务结果仍为 partial：原包“UTC+00:00 伦敦”使用 Europe/London，Unix 零点显示 01:00，fixedUtcEpochAccepted=false。未修改上游时区实现或把该缺陷标记验收。

当前前端 50 文件/419 项通过，最终类型检查 0 错误/警告；Rust 协议 9、reader 2、包解析 27 项通过，带 legacy-node-smoke feature 的工作区编译通过。23 个原始桥 VM 消费者接入同一真实 factory：首次 22 通过、1 个旧返回按钮源码断言失败，按当前父子回调链修正后仅重跑 events 并通过；首次记录保留，不伪称修正后整组重跑，也未给首次未采集的起始源码摘要补当前值。VM 临时诊断已逐文件保留后删除自建目录。

性能完整样本为 `production-plugin-panel-performance-after-resource-lifecycle-validated.json`：五次独立进程，launcher-ready P50 290.0 ms、范围 287.5–306.7 ms；100 次暖搜索 P50/P95 2/19 ms，首搜 P50 22 ms，返回焦点 P50 29 ms，iframe Escape 26 ms。约 752 ms quiet window 的宿主 CPU P50 为启动后 0.412%、关闭后 0.308%，RSS P50 为 129.4/132.7 十进制 MB。36 个选定输入及生成 JS/CSS/原生二进制起止校验一致，五个环境和构建临时目录删除。字符转换真实 module 入口打开/重开严格持有一个租约，目录树 classic 为零，启动/关闭/静置均归零。首次误把字符转换当 classic 的失败采样完整保留，修正的是夹具观察，不是泄漏断言。仅统计 smoke host PID，排除 WebKit/Node/helpers；关闭后台服务，未打开 Color/市场，非发布包、物理输入、完整待机、竞品结论或稳定 P99。首屏静态 JS 图为 307961/573440 字节，plugin-panel/pinyin 继续延迟加载。

三份审包最后逐文件校验不变后，仅删除各自精确私有临时根；全部原生尝试的受管进程/连接和临时环境完成清理。capture 的“未执行、保留待审”字段属于历史阶段，当前执行与删除以 runtimeFollowup/finalCleanup 为准。另一次旧 defer runner 覆盖了固定名 `deferred-plugin-scripts-browser.json`，原时点字节未能从 Git 恢复；不能继续引用该固定名证明旧执行。已单独保留 follow-up，并让新运行预先生成 UUID。当前通过报告为 `deferred-plugin-scripts-browser-4623c844-f3cf-41d9-b188-2ffb32ffa6b3.json` 和 `plugin-module-graph-65cdbdcd-45c2-44f9-a1c9-69648fa969ba.json`。

下一批优先实现真正同步的 Rust 插件数据 adapter：实际 data 授权先于同步调用，复用有界 loopback/private-ticket/TaskRun 生命周期，纯 Web 不依赖 Node，资源只读租约不能授权 DB 写；db.promises 独立异步，revision 同事务返回，dbStorage 与官方一致存放在同一 plugin_data 文档 store，allDocs 在 SQL 层限量。Color 夹具须先补实际 DB 命令及正确同库存储 snapshot，再验收藏、渐变和关闭重开持久化。`DESIGN.md` 的“同步缓存/异步 flush 已实现”过时描述已纠正。历史静态 92 ready/75 requires_build/12 incomplete/1 unresolved 未在本批重跑，不能换算实际可用率。

## 第十三批推进：真实同步 SQLite 数据与授权生命周期

汇总：`output/legacy-node-2026-10-15/plugin-data-delivery-verification.json`。目标仍 active，未确认多数插件即装即用；没有创建提交、推送、替换已安装应用或修改用户插件库。原包仅导入隔离桌面夹具。

- 生产插件在原始 preload 和页面执行前完成实际 data 授权。`db` 同步读取真实 SQLite，`db.promises` 独立异步，`dbStorage` 与文档共库，版本检查/写入/返回值同事务；附件独立保存元数据并兼容旧表迁移。256 KiB 文档/附件、512 KiB 请求/响应、1000 文档、128 keys；SQL 用直接列 octet_length 和 CASE 阻止旧超大 cell 在投影时载入，批量重复 ID 整批拒绝，mutation 为传输包络预留 64 B，预算失败先回滚再返回。
- 新数据能力走统一 registry/permission/TaskRun，正文、存储键和 bearer 不入历史。源提示每文件 2 MiB、总 8 MiB，仅决定预授权，不是权限依据。未探测到使用时不创建 listener；动态调用缺授权明确抛错，不保留或自动重放写入。重开同时轮换数据与剪贴板会话；退出、撤权、代码替换及窗口销毁清理。复审修正晚到 prepare、跨插件 successor 身份、过期 pending、private memory defaults、storage 逻辑错误和取消后迟入权限队列；前端事件仅刷新权威队列，避免旧弹窗复活。
- 原版 Color 1.1.0 最终 run `0a55e2ca-f1f4-4ac6-8e7e-df70834bd971` 通过 50 项检查：红色转换、无效值恢复、真实收藏验证、独立 SQLite 文档与排序 snapshot、页内重挂载、完整退出插件/新一次授权/新 iframe 后收藏保留，以及原始 452 行渐变页面。12 条 data TaskRun 全终态，固定收藏正文/键和 bearer 泄漏检查通过；关闭后资源计数归零。此前两轮因夹具错误假设最近使用/目录标题而未通过，记录完整保留，不记作产品回归通过。
- 原版 Timestamp run `be0e6d68-0f97-448c-a115-1e9092dcb522` 通过 46 项限定宿主检查；打开期间 data/Node/clipboard session 与 transport 均零，只有一个模块资源租约。业务仍 partial：原包 London 历史时区缺陷未改，fixedUtcEpochAccepted=false。

最终前端 52 文件/452 项、core 157 项、API shim 20 项及后端 42 项定向检查通过；类型检查 0 错误/警告，带 legacy-node-smoke feature 的工作区编译通过。所有新语义模块均少于 500 行，旧大文件仅薄接线。独立复审报告的问题已逐项关闭。

性能 run `bba8e158-dbb4-471c-a198-5a4c87cf95e5` 五次独立进程通过：启动 ready P50 293.1 ms、范围 291.3–304.4 ms，100 次热搜索 P50/P95 2/19 ms，返回焦点 P50 29 ms，Escape 27 ms。字符转换无 data listener，目录树为真实主题读取先批准 data、只在打开期间持有一个会话，关闭/静置归零。生产静态初始 JS 为 308477/573440 bytes，插件面板和拼音仍懒加载。源和生成产物起止一致，五个临时环境、构建 scratch 与两个原包准备目录均删除，删除前再次核对 14/5 个原文件未变。CPU/RSS 只覆盖隔离宿主 PID、背景服务关闭；以上不替代发布包、全进程、物理热键、竞品或稳定 P99 验收。

下一批优先修搜索结果主标题：最终原生观察仍为内部功能码 `color`，中文功能名目前只在描述/插件导航显示；须保留真实执行 code，不能靠推断改写身份。随后继续扩展已审原包业务覆盖。附件原插件交互、跨平台、剪贴板/导出/AI/屏幕动作及多数插件可用率仍待验证。

## 第十四批推进：可读名称、目录缓存与准确选择

汇总：`output/legacy-node-2026-10-15/launcher-catalog-delivery-verification.json`。目标仍 active，多数插件直接可用尚未确认；没有提交、推送、替换已安装应用或写入用户插件库。

- 搜索、目录和激活导航共用真实功能名称与来源规则，保留原始执行 code。中文功能名、插件标题和拼音可搜索；双索引按最高匹配分合并，同分保留原始规则的 match type，不重复加分。动态显式 `MD5` 等名称保留，旧数据库回退增加独立来源列迁移，缺少功能名时只在列表使用插件显示名。
- 结果行突出名称，抑制重复说明，来源和匹配诊断收进悬停提示，选中项用回车符号，动作由底栏和无障碍名称说明。54px 行高和虚拟化不变；方向键沿分组视觉顺序移动。异步结果未被用户选择时跟随最高排序项，主动移动/悬停/聚焦后按身份保留；paste 撤销相同查询的旧回包，组首选中时恢复被裁切的标题。Chromium 明暗主题、800/480px、真实键盘事件、原 code/预期 owner 激活及返回焦点通过，4 张截图在 `result-presentation-960f0189-e76a-494e-b9eb-3f29a6bc44ae/`。
- 历史在禁用时只隐藏，重新启用恢复；目录仅为相同 `(plugin_id, code)` 更新名称/图标。记录、首页、搜索历史、固定项、单项删除、设置页删除、热键和独立窗口贯穿来源身份。旧无来源 payload 只在当前目录唯一时回退。后端锁定预期 owner 并持执行 gate 复查，变化时写 Failed TaskRun，不写使用记录或进入成功副作用；前端回包也复查并显示中文恢复提示。独立复审发现并关闭 cold pin、同 code 历史及设置页误删三个缺口。
- core 共用目录快照，按本地成功提交版本与 SQLite data_version 失效；热查询不再全表读取、解析 manifest 或检查图标文件。读取在同一事务先以直接列 octet_length/COUNT 预检：20,000 功能、65,536 原始规则、16 MiB 元数据、32 MiB 自有索引数据 allowance，超限明确失败。宿主图标缓存按 Weak 快照身份，最多 4 代、每代 8 MiB。共享正则程序、分配器、SQLite/WebView/RSS 不在这些数据额度内，不能把它称为进程内存上限。

验证：完整 core 测试、API shim 专项、后端 projection/owner gate 专项和带 legacy-node-smoke feature 的工作区编译通过；最终前端 57 文件/472 项，类型检查 0 错误/警告。Rust 1,200 功能 debug 冷建 15.71ms，120 次缓存查询最大 0.668ms，低于 25ms 匹配预算。新增语义模块均少于 500 行，既有大文件仅接线；独立最终复审无剩余 P1/P2。

原生性能 run `a9398ee5-1f50-448d-8af9-f8d2d18e8a88` 五次独立进程通过：1,200 条无入口的合成功能加两个原版功能，交替查询每次 600 条合成命中和一个合法原版 over 命中，共 601 条；不激活合成项。100 次热查询 P50/P95 30/32ms（含 16ms 防抖、IPC 和选中行 DOM 就绪，非绘制时间），启动 ready P50 295.6ms、范围 293.2–303.6ms；首搜 P50 21ms，返回/iframe Escape 焦点 P50 28/27ms。就绪时 5 行 DOM，契约上限 32；字符转换 Base64/MD5 和目录树真实目录/过滤、data/Node 授权路径保留。约 752ms quiet window 宿主 CPU P50 0.384%/0.200%，RSS 134.9/138.1 十进制 MB，关闭时自有会话/监听器归零。源/生成产物起止一致，五个临时环境及构建 scratch 均删除。只统计 smoke host PID，背景服务关闭；不是完整待机、发布包、物理热键、竞品或稳定 P99 结论，也不证明 1,200 个插件兼容。

原版 Color 1.1.0 run `704cf70d-ed71-4fab-878d-00472b687f14` 通过 53 项限定检查，新增实际 Rust 中文目录/插件标题搜索和原码激活；颜色转换、无效输入恢复、真实 SQLite 收藏、页内/整插件重开持久化及 452 行渐变继续通过。14 个源文件与固定 ZIP 在运行前后和最终删除前均不变，精确私有准备根已删除；source-review 的静态未执行字段是历史阶段，runtimeFollowup/清理记录保存当前状态和旧摘要链。Timestamp 本批未重跑，之前的 London 历史时区缺陷仍 partial。

生产首屏静态 JS 图为 312600/573440 bytes（约 305/560 KiB），面板和拼音仍延迟加载；最终预算构建保存源起止摘要并删除临时输出。失败尝试完整保留：浏览器先暴露默认项和组标题滚动问题；前两次原生性能夹具分别把插件标题误作功能名、遗漏原版 over 结果，未记为通过。一次前端全量 470/471，原因是测试控制的等待回包被真实拼音加载重发查询替换，隔离该无关加载并单独验拼音后，最终全量 472/472；首次输出仅保存在工具记录，不伪补当时源码摘要。受限进程清理测试首次受权限限制失败，提升权限后 timeout/快速退出/中断清理回归通过。

下一批扩大已审发布原包的实际业务覆盖，并继续缩小插件管理/导入/授权与 ZTools、uTools 的交互差距；所有可用率必须来自逐插件实际结果。Todo 等仍未执行的样本、市场安装、附件/剪贴板/导出/AI/屏幕动作及跨平台继续单列待验。不能用静态 ready、分层分类或本批 1,200 条搜索样本替代多数插件业务验收。

## 第十五批推进：同步路径、市场详情与 Todo 实际业务

汇总：`output/legacy-node-2026-10-15/system-paths-market-todo-delivery-verification.json`。整体目标仍 active，多数插件直接可用尚未确认；本批改动在工作区，没有提交、推送、替换安装版或修改原包。

- `ztools/utools.getPath` 与 Electron `app.getPath` 共用真实同步快照：12 个标准名称，未知名返回空字符串；`pluginData` 独立申请 PluginData 权限并真实创建目录。标准路径仅投影元数据，读取实际文件仍需相应能力。原 preload/page 前经过真实授权，动态遗漏同步报错并提示手动重开，不伪造 Promise 或重放业务。`userData` 使用实际宿主根；`logs` 是新增的 `base/logs` 投影约定，不保证目录或日志已存在。Unix pluginData 从目录描述符逐段拒绝 symlink。
- 路径能力走统一 registry/permission/TaskRun，真实值仅保存在私有快照，不进普通任务输出和记忆默认值。13 个名称、单值 16 KiB、快照 128 KiB，64 个活动 intent/preparation/snapshot、60 秒 intent TTL；源提示每文件 2 MiB、总 8 MiB、128 源文件。路径本身不启动 Node、loopback 或空闲轮询。关闭、代码变化、窗口销毁、撤权和策略变化统一失效；独立复审修正了撤权公共入口遗漏。已交付给页面的字符串无法被收回，本批只证明宿主快照与 Node 停止，未声称旧页面忘记路径值。
- 市场详情使用原生模态框，保留目录、查询与滚动，Tab/Shift+Tab、Esc/按钮返回原焦点；安装前进入现有确认流程。安装/更新后的最近安装项在启用后刷新对象，避免“立即打开”继续持有旧 disabled 状态，真实插件 ID/code 保留。离线 Chromium 使用 220 个合成目录项，800/480px 明暗主题四张截图和真实键盘/取消流程通过；完整设置页启用/打开链由组件测试覆盖，没有宣称实际市场下载安装完成。普通安装仍缺按点击查询平台/最新版本的前置检查。

Todo 0.0.1 原包 run `b196ed27-e63a-4b45-a3b9-01a8edbfa1d3` 通过 71 项限定检查：原始三个默认组、两条任务新增/编辑/完成/恢复、正负搜索、隐藏已完成设置、第四组新增/改名/切换，实际 SQLite 投影与原 UI 一致。整插件退出后重新授权、新 iframe 中任务/分组/设置保留；无 Node，退出资源归零。仅证明同一应用进程内重开，未验应用重启、崩溃恢复或大任务量。99 条 TaskRun 中 86 成功、13 失败且全部终态；保留报告没有失败方法/错误码，不能认定全是重复 put 冲突或宣称 DB 调用全成功。

Regex 1.0.0 原包 run `3ead3c40-71ae-4182-b610-026ac9724731` 通过 59 项限定检查：真实权限框前不启动页面/Node，三种同步路径别名各重复 120 次，路径任务数保持 1。调用原始 preload 的 `writeTextFile(text)` 一次，在预先验证的实际私有 HOME/Downloads 中生成恰好一个内容精确的 31 字节文件；未覆盖 UI 导出按钮。实际 revoke 命令后宿主路径快照和 Node 归零。15 条任务成功。匹配/捕获/错误恢复/本地示例继续通过，但原页中文表达式说明已有准确性缺口，宿主或上游归因待确认，因此不记为完整业务验收。

Todo 首次停在 frame state 探针超时，失败记录保留。测试 transport 增加每个当前文档的只读 ready/nonce 握手：仅 ready 可以在 5 秒内每 50ms 重试，业务请求仍只发送一次，响应丢失也不重放。17 项回归和独立复审通过。复验成功不能单独证明首次超时的唯一根因。两个原包最终逐文件校验 8/7 个源文件与固定 ZIP 未变后，仅删除各自精确私有准备根；历史静态未执行/保留字段不改写为运行证据，新的 runtimeFollowup、摘要链与清理记录说明后续状态。

验证：最终前端 63 文件/540 项通过，类型检查 0 错误/警告；路径 Rust 12 项、私有流水线/权限 4 项、发布夹具 18 项和目录/匹配预算 4 项定向检查通过，带 legacy-node-smoke feature 的工作区编译通过。新增职责模块均低于 500 行，旧大文件仅接线。首屏静态 JS 图为 313546/573440 bytes（约 306/560 KiB），面板与拼音仍延迟加载，源起止摘要一致且临时构建已删除。

最终原生性能 run `2495a076-8278-4c39-9a6b-74e9b3d886e3` 为五次独立进程：1,200 条合成元数据加两个真实功能，查询每次命中 601 项，不激活合成项；100 次热查询 DOM-ready P50/P95 30/31ms，含防抖/IPC而非绘制。启动 ready P50 302.4ms、范围 296.0–319.4ms，返回按钮 P50 28ms；最新 Escape 25–27ms，真实消息抵达为 0–1ms。约 752ms quiet window 的宿主 CPU P50 0.387%/0.194%，RSS 135.1/138.6 十进制 MB，路径/data/Node/资源归零，源/产物起止稳定，临时环境清理完成。

性能仍有明确待确认项：此前完整五进程样本的 Escape 为 223/26/223/225/26ms，中间复测也有类似慢值，全部保留。最新加入被动捕获阶段观察后较快，没有生产改动能证明已经修复延迟；原父/子文档实际报告 hidden、未获焦，不能替代可见前台或物理按键验收。中间被动监听在生产 iframe 销毁后才运行，消息时间为空；最终监听顺序修正后才取得有效分段。CPU/RSS 只统计 smoke host，背景服务关闭，不是完整待机、发布包、竞品或稳定 P99 结论。

下一批优先闭合普通市场安装的平台/版本前置检查、真正同步的文件选择/保存对话框及 BrowserWindow 返回契约，并验证可见前台 Escape 慢样本。Todo 失败任务分类、Regex 说明语义、跨平台及发布包继续单列；仍不能用静态 ready、路径 API 覆盖数量或 1,200 条合成搜索样本替代多数插件实际可用率。

## 第十六批推进：市场确认、真实文件窗口与前台性能

汇总为 `output/legacy-node-2026-10-15/plugin-dialog-market-delivery-verification.json`。本批结果是 progress，整体目标仍 active；多数插件直接可用、原版图片导出的完整四步和发布包验收均未通过。没有创建提交、推送、替换已安装应用或修改原版插件。

- 普通官方安装、更新与重试先按实际点击 ID 查当前平台/发布版本，失败在解析下载地址与确认之前中止；只刷新该行，同一次版本变化使用现有一次明确确认。自定义源保持自身路径，浏览不会预取 220 个插件的发布数据。确认框与应用主题一致，初始焦点在取消，长内容可滚动；原生详情、全局权限与安装确认共用明确的焦点所有权。实际 ShellFrame 层级、相反 OS/应用主题的 4.5:1 对比、Tab/Escape/回焦通过离线 Chromium 检查。详情 9 项/11 张截图，完整 App 恢复流程 10 项/4 张截图；安装调用仍是 mock，没有宣称真实下载/安装通过。
- macOS 原生 open/save adapter 实现 ZTools/uTools 同步形状及 Electron 同步/异步形状，实际授权先于原页面执行，每次选择走同一 registry/permission/TaskRun。每窗口 1、全局 4 个面板；32 KiB 参数、128 个路径、512 KiB 选择结果、120 秒原生 deadline。关闭、撤权、替换与窗口销毁取消真实面板，动态缺授权抛错并要求手动重开，不重放动作。非 macOS 明确不支持；书签等未支持的语义仍拒绝。
- 实测发现长等待故障：`transport.read_eof` 在请求约 11,001.914 ms 先出现，随后同一 handler/native waiter Drop、实际面板取消。没有用户取消，也不能据此断言 WebKit 内部超时原因。仅 dialog 改为关闭定界 JSON 响应，等待期间每 2 秒一个空白、最多额外 65 字节，保留同一个 pinned handler 与 128 秒总预算；写入/关闭限 1 秒，断连仍取消，其他 transport 保持 8 秒。后续真实面板持续到 120 秒原生 deadline，没有再次 EOF；这次因控制脚本尚未识别实际控件而停，不能算四步通过。7 个新增和 3 个既有 transport 检查通过；普通构建没有临时事件 recorder。
- 用户仅授权 AppleScript 操作隔离临时应用的四步。真实 AXSheet 无标题，按钮在嵌套组内，Go To 路径编辑器还会延迟收完键盘输入；控制脚本按实际观察修正，限定确切 PID、阶段、私有目标、唯一且启用的按钮。v3 真正完成目录取消和指定目录选择，原始 `result[0]` 扫描与编辑器正确，两个 TaskRun 成功。v4 对延迟输入严格停止后，Root 只读核对确切私有路径，续接同一次待完成导航/确认，补充脚本与审计保留，没有重发插件按钮。
- v4 明确捕获原始导出错误：`SecurityError: Sandbox access violation`，两个 sandboxed frame 均缺 `allow-same-origin`。本地 html2canvas 1.4.1 创建子 iframe 后读取其 document，与当前 opaque 隔离冲突；错误发生在保存调用之前。第三个 transport/Save TaskRun 均未出现，PNG 为 0。**实际取消保存、选择保存及独立 PNG 验收仍未到达，不能把它归成 save adapter 已通过，也不放宽 srcdoc 的隔离。** 错误观察完整转发原 console 的 this/参数/返回/异常，最多处理 4,096 字符、输出 280 字符、12×3 条，统一屏蔽四类 bearer 与夹具 token。失败时保留最后真实 UI 状态。
- 全 TaskRun 扫描保留旧 `privateMarkersAbsent=false`，独立验证唯一例外为原版安装元数据 `plugin.feature.file-tree` 的 `/output/plugin_path`、`/output/preload_path` 两个确切字段/值。选择目录、保存路径与连接凭据没有进入任务历史；没有通过放宽通用匹配消除失败。原版 12 文件 SHA 仍为 `219451b5ed9294aea0013ca78dfdc95b8528ada9ddac013076f0399544e3b07d`；所有本批临时原生环境/构建目录已清理，临时应用进程为 0。当前 AS 输入等待修正仅做语法/范围测试，下一次真实四步仍待安全宿主修复后重试。

最终前端 72 文件/605 项通过，类型检查 0 错误/警告；带 legacy-node-smoke 的工作区编译通过。Rust dialog 取消/lease、事件上限、隐私与新 transport 定向检查通过，独立复审发现的焦点、载入失败清理及诊断泄漏/无界问题已关闭。1,200 功能目录冷建实测 12.912 ms，120 次缓存查询最大 0.545 ms，低于 25 ms 热查询预算；通用 5,000 功能测试另有 500/50 ms 的普通/索引预算，不能混同。静态首屏 JS 314,965/573,440 bytes（约 308/560 KiB），140 个输入与先前构建逐一核对仍一致，面板/拼音继续延迟加载。

严格前台性能 run `1d66360a-ca65-4be9-9b1c-68df7bd4e5be` 五个独立进程全通过，100 次热搜索 DOM-ready P50/P95 30/31 ms；launcher ready P50 394.1 ms、范围 387.7–508.0 ms；返回按钮 P50 28 ms，Escape 26–27 ms。新的 Escape 分段均用父文档接收时钟，frame 本地 dispatch 单独计时；不同 WebKit 文档的 epoch 不再相减，缺失/重复/FIFO 错误仍失败。前一次严格前台采样第四进程实际失焦、首轮观察模式负 1 ms 均保留，没有放宽条件；新报告源与产物起止稳定，五个环境和 scratch 删除。

性能范围仍有限：DOM-ready 包含防抖和 IPC，非绘制；Escape 为程序化输入，总值保留 25 ms 轮询精度。约 752 ms quiet window 的宿主 CPU P50 为 3.84%/2.57%，RSS 146.5/151.5 十进制 MB；只包含 smoke host，后台服务关闭，不能称正式待机、完整进程资源、发布包、竞品优势或稳定 P99 验收。

下一批首先验证安全页面宿主可行性：每 instance 真正独立 origin、同一插件不同 instance 互不访问、无父 DOM/Tauri、generation 绑定的整页 bridge 交付、精确 Origin/CORS、导航后身份撤销，以及新增 storage/worker 生命周期与内存预算。现协议 session 在路径上而非 origin，不能直接复用共享整页 HTML 或仅加 sandbox 标志。先用双插件/双 instance 的实际 WKWebView 验证隔离和 nested clone，再进入原版目录树保存两步。BrowserWindow、无 preload 的主页 Node 使用、正式市场安装与多数插件业务覆盖继续推进。

## 第十七批推进：独立来源与文档交接的原生可行性

汇总为 `output/legacy-node-2026-10-15/plugin-origin-bootstrap-delivery-verification.json`。本批仍为 progress、整体目标 active，生产 `PluginPanel` 没有切换来源模式，原版文件树的保存两步仍未到达。未提交、推送或替换已安装应用。

- 第一个独立原生实验 `native-origin-feasibility-initial.json`（run `42093a14-defc-4bf3-8a93-64de6b5860c9`）11 项通过：父页、两个同插件实例与另一插件实例形成四个非 null 来源，实际 DOM 双向访问拒绝，子页/嵌套页无 Tauri。原版未改动的 html2canvas 1.4.1 对合成内容生成三张 128×48 PNG，Rust 独立解码并核对两个像素，均 472 bytes、同一 SHA。原生 benign command 仅父页正控进入一次，错/缺 invoke key 没有进入；原生 stdout/stderr 丢弃，避免当前 Tauri 错 key 日志暴露临时 expected key。三个 localStorage 自有键实际隔离并清理，但没有验收生产持久存储策略。
- 该实验 9 次资源 GET 的 Origin/Referer 都缺失；因此不能用这两个请求头给生成整页配置授权。第二个实验将一次性 GET 限为不含 endpoint、父 nonce、marker、payload 的引导页；父页核对实际 WindowProxy、精确来源、文档随机值和当前代次，端口 ACK 后才通过专属 MessageChannel 交付完整 HTML。超时、错误绑定与 UTF-8 内容超预算均永久关闭本次交接；父页错误仅透传静态白名单。
- 第二个原生实验 `native-bootstrap-feasibility-initial.json`（run `5fc82249-3299-4092-8d4c-e7bbab8f2c14`）10 项通过。两页各一次交付，document.write 后保持独立来源；实际同步 text/plain 与异步 JSON 请求成功，复用真实 `BridgeServer` 的原生计数为 4 次业务执行、2 次允许预检、3 次来源拒绝、1 次撤销后的认证拒绝。每页在正确结果前发送错误文档随机值、错误代次两包，父页分别拒绝，三次尝试只接收一次。原生执行记录没有外国/opaque/撤销请求的业务调用。
- 受控导航前显式失效并关闭端口后，将 A 的同一 WindowProxy 导航到 B 已消费的链接，原生实际返回 410、无脚本响应，没有再次交付。另一个同 host 原始 HTML 由响应 CSP 强制 opaque，实际消息来源为 null，父/兄弟 DOM 不可读，撤销前后的请求分别被来源/认证门禁拒绝。**这里只证明导航前绑定负例、显式撤销和已消费链接拒绝，未验收导航后活跃重放或生产自动导航策略。** 本实验 5 次 GET 的 Origin/Referer 也均缺失。

生产 shared transport 增加受控 `OriginPolicy`：token 认证后选择不可由插件 payload 自报的策略，Exact 只接受受控实例的规范来源，缺失/null/错误来源不会降级，POST/OPTIONS 共用门禁，普通与 dialog 响应只使用已验证 CORS。四个生产 Router 仍默认 Opaque。新增三类门禁观察只存在 test/smoke，既有 dialog recorder 忽略，不增加普通诊断内容或空闲任务/监听器。保持 8/128 秒、1 MiB 响应、16 KiB 头预算；Exact owner 将来仍须执行前复核撤销，认证、策略读取、执行并非原子授权。

最新 shared Origin/dialog 15 项、bootstrap Rust 合同 4 项、真实 Node MessageChannel 离线语义检查通过；原独立来源合同 3 项、既有 HTTP 11 项通过。默认库与带 smoke feature 工作区编译通过，仅旧 nom 未来兼容提示。独立审查已修复真实 HTTP envelope 误读、预检只信 JS 布尔、过期交接仍 ACK 等验收问题，没有剩余 P1/P2 范围内发现。bootstrap 的 25 个选定源与二进制前后稳定，当前逐项一致；两个临时环境删除，临时主进程为 0。没有把选定源绑定称为完整编译闭包。

本批没有修改生产前端，也没有重测完整进程性能；前一批性能结果保留为历史证据，不能重新绑定到本批变化后的 Rust。下一步将页面注册/一次性交接接入真实父页，并同时迁移四类 runtime owner、主/子 frame、待授权与结果的来源/文档/代次失效规则，验证 storage/worker 和资源预算后，继续用户已授权的原版文件树取消保存与确切私有路径 PNG 保存。多数原版插件业务覆盖、BrowserWindow、跨平台、发布包与完整性能验收继续保持待完成。

## 第十八批推进：真实面板文档交接与原版四步导出

汇总为 `output/legacy-node-2026-10-15/plugin-document-host-delivery-verification.json`。本批为 progress，整体目标仍 active；新加载模式接入真实 App/PluginPanel 与四类生产 runtime，但仅由专用 macOS 原生夹具显式开启，普通构建继续 opaque。没有提交、推送、替换安装版或修改原版插件。

- Rust 为每个文档生成独立 origin 和单次 bootstrap ticket。GET 只返回无凭据引导页；父页校验实际来源、WindowProxy、文档随机值和代次，经端口 ACK 与 native claim 后仅交付一次完整 HTML。UTF-8 HTML/单资源各限 8 MiB；每窗口 4、全局 32 个文档；资源沿用 64 个待处理/8 个读取预算，取得待处理名额后才派生任务。只有实际引导 GET 后开始 5 秒交接倒计时，人工授权前不消耗该时间；没有新增空闲清扫线程。
- Node、剪贴板、数据和原生对话框可选持有同一 native document binding；撤销后认证、预检、执行及异步回复不降级为 opaque。关闭先失效本地身份，再取消对话框与其余资源；同 window/instance 的其他插件文档不会被整 owner 清掉。窗口销毁、托管代码变化与显式关闭接入原生失效。外部直接改开发目录没有自动文件监听，不能算已覆盖的代码更新路径。
- 主 frame 的权限和结果携带精确来源及文档 envelope；待授权项捕获 plugin ID/身份，旧文档不能给新文档授权或回包。合法早期 outPlugin 先完成交接再转结果层，清理权限等待；重开清掉旧输出并为挂载设定 5 秒边界。静态宿主桥转换发生在填入插件数据之前，原包脚本不改写，DOCTYPE 保留标准模式。交付后父页释放暂存 HTML，不再把普通 opaque 探针注入新模式。独立审查发现的跨插件清理、读取排队、早期输出、权限等待与数据转换问题均已修正。

真实四步报告 `published-file-tree-native-document-integration-initial.json`，run `421d131f-14d3-4a37-8695-f7b063c10391`，39 项限定检查通过。用户授权的 AppleScript 仅控制唯一临时应用，四阶段共 11 个审阅过的子操作，首个真实面板保持至少 15 秒；每步对应恰好一个成功终态 TaskRun，未替换系统选择结果。实际 atools-page 来源、空 srcdoc、无 Tauri 和加载中文档计数 1 被观察；原版目录取消/选择、保存取消/选择均完成。原始本地 html2canvas 生成唯一 PNG，Rust 独立解码 696×294、20,384 bytes，SHA `95494ba586a0ffafc3ca047055895933baaefd2e5fffe9adec79cd292492f788`。取消保存时 PNG 为 0。

原版 12 文件 SHA 仍为 `219451b5ed9294aea0013ca78dfdc95b8528ada9ddac013076f0399544e3b07d`。本次返回的 78 条 TaskRun、3,344 个扫描节点未触及查询/扫描预算；选择目录、保存目标与 dialog endpoint 未进入这些字段，唯一根目录例外仍是两项确切安装元数据。整插件退出后文档、Node/data/dialog/host/path、租约与 listener 计数归零；临时环境、构建 scratch 删除，临时进程只读复核为 0。222 个所选输入和生成产物起止稳定，独立复算当前所选源一致；这不是完整编译依赖闭包，也不是已删除 PNG/二进制的再次实物读取。

验证：前端 78 文件/653 项通过，类型检查 0 错误/警告；native document 注册表 8 项、四 runtime 文档撤销 11 项、范围/flags/源绑定/bridge/BrowserWindow 默认路径定向检查通过。默认工作区及 smoke feature 库编译通过。最终默认首屏静态 JS 图仍为 314,965/573,440 bytes，面板与拼音继续延迟加载，最终预算构建选定源起止一致。1,200 功能交互预算定向测试通过。

默认 opaque 路径最新前台性能 run `c8882a19-da2a-4712-99ce-bdce77455f25`（`production-plugin-panel-performance-document-integration-foreground-v2.json`）五进程全通过。1,200 个合成元数据加两个原版功能，100 次热搜索 DOM-ready P50/P95 为 29/32 ms；启动 ready P50 364.8 ms、357.8–369.9 ms；返回按钮 P50 28 ms、27–30 ms；Escape 25–27 ms。第一组第三进程在 file-tree-opened 后实际 OS 非前台、失焦，严格失败并保留，未通过放宽门禁合并成成功。第二组源与产物稳定、五个私有环境及 scratch 删除。

性能边界：程序化输入，DOM-ready 含防抖/IPC而非绘制，Escape 保留 25 ms 轮询精度；约 752 ms quiet window 仅宿主 PID，CPU P50 3.41%/3.10%、RSS 146.4/151.3 十进制 MB。后台服务关闭，WebContent/Node/helper 不计入，不能称完整待机、发布包、竞品优势或稳定 P99；此性能组使用默认 opaque，新 document 模式的完整进程资源预算未验。

下一步继续生产启用前的实际 WKWebView 导航撤销、浏览器存储语义/配额/清理与 worker 阻断验证；当前 worker-src 为 none，不宣称支持 worker 插件。新模式 BrowserWindow 在创建前明确拒绝，需要独立子文档身份与完整 RPC 迁移；fixture-only observer/parent origin 门禁也要与生产入口拆清。随后扩大经过源审查的原包真实业务矩阵，持续推进搜索、导入、授权、插件管理与竞品的交互差距。多数插件实际可用率、市场真实安装、跨平台、完整进程与发布包仍未验收，不能用本次单插件四步或合成搜索数量替代。

## 第十九批推进：真实导航撤销与 Worker 能力实报

汇总为 `output/legacy-node-2026-10-15/plugin-navigation-worker-delivery-verification.json`。本批为 progress，整体目标 active；普通构建仍 opaque，新增原生观察/撤销仅在 macOS 专用 fixture 再显式选择。未提交、推送、替换安装版或再次控制系统选择框；第十八批用户授权的原版四步记录保留，不把本批合成包算作原版业务覆盖。

- 拆出独立 Worker adapter，保留已有本地 classic-worker URL 转换、options、原生 prototype 与 terminate，补上构造失败、error 和 terminate 的幂等 Blob URL 回收。模块/远程 Worker 仍交给原生。ServiceWorker 不再返回伪造注册成功；可包装原生 container 时返回固定 NotSupportedError，其他方法和事件属性保持原生 receiver。缺失/抛 SecurityError 的 container 不制造假对象，也不阻断整桥。原有普通函数调用/subclass new.target 差异未改，不宣称完整 Worker 构造器兼容。
- 在锁定 Wry/objc2 契约下接入原生 target frame 快照，匹配请求来源与 security origin 后，先同步撤销精确 window/origin 的共享绑定，再通知前端、异步清理并转交原 delegate；只实现原 delegate 的七个 selector，不添加会替代旧 action 回调的 preferences overload。安装支持并发、超时/取消及原生窗口销毁。独立复审修正的取消竞争与类名匹配问题均关闭。
- 原生 NSString 先检查 UTF-16 长度再复制：完整 URL 8192、scheme 32、host 1024；长 URL 省略整串仍独立提取有界 origin。缺失/不一致来源、userinfo、非法端口不放行；诊断只保留 128 条固定类别、随机文档 ID 和限长布尔，不记录原始地址或查询。

实际观察 run `52825705-cbad-4403-81a2-e4afc5838526`（`synthetic-page-navigation-observe-v2.json`）及撤销 run `891bf70d-4d23-4253-b518-5245e0fba30d`（`synthetic-page-navigation-revoke-initial.json`）各 76 项检查、五种导航通过。生成的纯 Web 包仅复用两个导入名，无社区源码、Node、剪贴板操作或 OS picker；实际 dbStorage 读写仍走真实一次性授权、生产会话及 TaskRun。每例均先验证嵌套 about:blank 可写读且父数据会话仍存活，再挂起真实但不批准的 clipboard.write 权限。replace、reload、meta、自身 about:blank 与长 history 后跳转均准确匹配；长 history 原生 `targetUrlOversized=true` 仍识别当前文档。撤销组五例均在 delegate 转交前共享 binding 失效，待授权 UI、文档、会话和 transport 随后归零；观察组明确不声称原生撤销。

两个实际 WKWebView 进程中，classic/module/shared Blob Worker 都产生真实 `worker-src` CSP 事件，脚本执行标记为 false；所有自有 worker、port、Blob、timer 和 listener 清理成功。不是只凭 worker-src 配置或等待不到消息推断阻断，也没有调用 ServiceWorker.register。此证据证明当前隔离模式拒绝 Worker，不证明依赖后台 worker 的插件已可用。

每组 15 条 native events、0 丢弃；239 个选定输入与生成产物起止稳定，临时环境和构建 scratch 删除，终态后只读进程检查为 0。初次观察安装类名守卫失败记录 `synthetic-page-navigation-observe-initial.json` 保留；修正为锁定版本实际生成的完整 Objective-C 名称，并继续严格校验 selector，不绕过守卫。公开报告的权限标题等待超时是后续现象，根因是页面准备前 observer 安装失败。

回归：前端 79 文件/657 项、类型检查 0 错误/警告、native page runtime 22 项、Worker/resource/桥/flag/源绑定与夹具离线检查通过，默认工作区与 smoke 库编译通过；新增职责模块均少于 500 行。默认静态首屏 JS 图 314,965/573,440 bytes，面板和拼音继续延迟加载，预算构建所选源起止一致。1,200 功能目录冷建 13.017 ms，120 次缓存查询最大 0.544 ms，热查询低于 25 ms；不是本批完整桌面导航或多进程性能验收。第十八批默认 opaque 前台样本保留为历史数据，不重新绑定到变化后的原生代码。

下一步仍需浏览器存储持久化/配额/销毁语义、独立子文档与通用 native IPC 身份迁移，以及原生在途结果的撤销排序。本批只覆盖四类已绑定 runtime 的原生身份撤销和实际待授权项；不能扩大为所有 native 能力的原子权限保证。正式入口、完整进程/发布包、跨平台、市场真实安装和多数原版插件业务可用率继续待验。后续继续围绕真实原包扩充矩阵，并改进搜索、授权恢复和插件管理的日常交互。

## 第二十批推进：打开结果反馈、窄窗口设置与同步子窗口契约

本批持续至 2026-10-16，汇总见 `output/legacy-node-2026-10-15/plugin-open-window-delivery-verification.json`。整体目标仍 active；未提交、推送或替换安装版。原有第十八批四步系统选择框授权与证据保留，本批没有新增系统选择框、剪贴板或 AppleScript 操作。

- 安装、启用后的“立即打开”现在等待真实 App 激活结果。请求绑定具体插件、功能和请求 ID；App 核对来源且提交 activePlugin 后才确认成功。等待期间禁用重复点击，失败保留“重试打开”；离开页面、切换请求或卸载组件会取消请求，迟到结果不能挂载或替换页面。插件自有功能与保留指令重名时仍经过后端来源校验。
- 打开状态抽为独立 `PluginOpenStatus.svelte`，由发起区域展示失败，普通启动器失败仍有 alert。新增独立紧凑布局样式：640px 以下设置导航横向滚动，正文占满宽度，按钮保持单行。没有继续向 SettingsPanel 堆叠新职责。
- BrowserWindow 创建立即返回非 thenable 句柄，同步 isDestroyed 反映实际状态；`.ready` 等待子页面加载及 RPC 握手。创建回调只在实际就绪时触发一次，sendToParent 使用独立 IPC。待创建时关闭、关闭拒绝或 false ACK、排队操作顺序、就绪后关闭/销毁的回调抑制均有回归；失败关闭保留真实句柄供重试。
- 创建者 source、完整文档身份及 host generation 共同约束就绪路由和迟到提交，子窗口可操作自己和其实际创建的直接子窗口，不能操作同级或祖先。WindowProxy 存入普通 Map，逐关闭或整体失效时清理，避免 Svelte 深代理访问 opaque 跨源窗口。默认 opaque 隔离保持，文档模式的子窗口仍明确拒绝。

实际原生 run `f87a6dcd-0529-4562-be96-b788df38c46f`（`native-browser-window-contract-v3.json`）通过 16 项流程和精确 9 项隔离检查。真实 App/PluginPanel 执行固定 SHA `c30d5d96251165fcb63b01104c3f50b17cffd6049f937fbe0c8219ba60fb3909` 的原版番茄钟完整 TipsWindow 类，页面和 manifest 是生成的纯 Web 夹具，不执行原版其余页面或 preload。同步句柄、原类 ready 回调的置顶状态、原类 destroy、已发创建请求的取消、嵌套创建者回调、IPC/executeJavaScript 和输出时清理均通过。全部 runtime 归零，1 个 TaskRun 终态，临时数据及构建删除。范围是宿主内隔离 iframe，不能当作独立系统浮窗或整个番茄钟插件通过。

最终浏览器 run `56a0f68a-0f3d-4855-afd3-ccb93d69bbd5` 的报告在 `output/launcher-ui-2026-10-15/plugin-open-outcome-56a0f68a-0f3d-4855-afd3-ccb93d69bbd5/report.json`。先编译专用测试页面，再静态预览，真实 App 搜索进入设置，使用合成 IPC 安装/授权并执行等待、拒绝、重试提交及离开取消。前后仅一次主页面导航，源码哈希稳定；无意外 IPC、外网或非预期控制台错误，仅一次固定的预期激活失败日志。四张浅色截图经 Root 实看，800×600 与 420×560 状态和按钮均可读；420 下正文 418px，横向溢出仅导航，重复全局提示为 0。浏览器、预览服务与 scratch 清理确认。此处是浏览器合成 IPC 验收，不能替代真实市场安装或原版插件业务。

保留的失败包括：初次前端全套的 effect 读写循环（增加 untrack 和实际挂载不重复加载回归）；初次原生跨源 SecurityError（WindowProxy 移出深响应式状态）；开发服务器迟到 reload、选择器与预期日志断言失败。早期 V2 搜索超时没有足够 DOM 采样，具体瞬时根因不作补写；后续 V3 已实际采样到输入后页面卸载和第二次主导航，最终用预构建静态页面消除此干扰。旧 run `4759ffd0…` 虽流程通过，Root 因窄屏竖排与重复提示拒收，截图保留，新组件与布局修复后才接受最终截图。

验证与预算：前端 81 文件 / 674 项通过，类型检查 0 错误/警告，工作区编译通过；原生、桥/归属/就绪/取消/关闭失败及夹具离线检查通过，独立源码复核无剩余 P1/P2。新增职责模块均少于 500 行。默认生产首屏静态 JS 图为 318,285 / 573,440 bytes，宿主和拼音继续延迟加载；1,200 功能目录冷建 13.207 ms，120 次缓存查询最大 0.746 ms，低于 25 ms 热查询门槛。默认限制为每 frame 8 个待创建窗口、每窗口 32 个在途操作与 32 个就绪回调、每 Panel 32 个存活或创建中窗口，没有新增空闲轮询。

原生和预算运行当时的 260 个选定输入及产物起止稳定；最后仅截图 runner、其静态预览 helper 和证据 collector 改动。汇总额外核对当前全部所选产品源码仍与该原生/预算快照完全相同，不把测试工具更新伪装成原生重跑。选定输入不是完整编译闭包。完整进程长期 RSS/CPU、正式包、跨平台、完整原版窗口生命周期/同步几何 getter、Worker 插件及多数插件真实业务可用率仍待推进。
## 第二十一批推进：首页实际行导航与隔离页面持久存储

汇总为 `output/legacy-node-2026-10-16/plugin-storage-home-delivery-verification.json`。本批为 progress，整体目标 active；多数原版插件实际可用仍未验收。未提交、推送或替换安装版，本批没有操作系统选择框、剪贴板或 AppleScript。

首页按每个分区实际的九列行移动；短行按列夹取，再进入相邻分区，左右不穿行。选中项只调整 HomePanel 自身滚动，输入法与 Tab 原有行为保持。最终真实 Chromium run `8cec95af-6279-4649-8340-04e3e6a46ff8` 在 800×280、420×280 两种矮视口通过方向键、边界、IME、Tab/Shift-Tab、精确 Enter owner/code 与失败反馈；window/ShellFrame 不滚动或移动，搜索焦点保持。四张首尾选中截图均由 root 逐张查看。使用静态构建，无 HMR、外网或未知 IPC；期望的一条固定 activation 错误之外 console issues 为 0。所有自有浏览器资源删除，选定源起止及当前一致。

默认 opaque 页仅在原生 localStorage getter 抛 SecurityError 时安装适配器，同步访问复用已有私有数据权限、TaskRun 与 SQLite WAL 管线；可访问的原生 Storage 保持原样。独立表保存 UTF-16LE 字符串，包括孤代理；关闭/重开与禁用保留，卸载随插件外键删除，clear 不动 db/dbStorage。配额为 key 2 KiB、value 128 KiB、4096 项、keys 合计 256 KiB、总数据 5 MiB，均按 UTF-16 字节计；编码前先拒绝超限输入，拒绝写入不缓存或重放。没有新增 sessionStorage 适配或文档模式持久化声明。

Object.keys 通过不超过 64 页、每页至多 384 KiB JSON 的 entries 读取，保留 512 KiB transport 上限；描述符快照只活在当前同步调用栈，在消费、微任务、mutation 与 close 时清除。独立描述符只做一次实时读取。分页不保留跨页事务；并发写入可能跳过条目或因重复/进度校验拒绝，不宣称原子快照，也没有把 Object.values/JSON 序列化算进该往返上限。

宿主只转发事件元数据；frame 经当前身份、权限及私有异步接口取得正文，写入 TaskRun 成功后才发布给写入时已有且仍有效的会话。原始 key/value/source URL 不进入持久审计参数，clientId 仅排除写者。事件正文每插件最多 32 条、全局 8 MiB、TTL 10 秒，无空闲轮询；旧会话、rotate、close、invalidate、stop 清理。高频写入会触达容量边界，本次 burst 实际淘汰 104 条事件记录，不能声称无限或完整 Web Storage 事件交付。

最终真实 WKWebView run `1c5363b5-242f-48cd-89cf-f780f7018a2a`（`native-web-storage-contract-v2.json`）38 项检查通过。两个生成的 no-preload 纯 Web 包只复用 file-tree/char-transform 导入名，其中 A 原样嵌入固定 SHA 的完整 ThemeManager 与 UIManager 类。真实 App 搜索、Enter、逐实例一次性数据授权、双 PluginPanel 会话均执行；原方法应用 dark、切换真实侧栏按钮，关闭后重新实例化恢复主题/侧栏；同插件实际 storage 事件、写者排除、同值写入无新增 native event、孤代理、配额失败保留旧值、dbStorage 分表及 B 插件隔离均验证。原构造器不会恢复 radio，报告保留实际 false，没有改写类补造行为。这里没有新增任何完整原插件业务验收。

原生样本 128 个合成键枚举为 1 次 entries、单次 7 ms，只记录该规模，不能代替 4096 项的原生耗时预算。193 条 TaskRun 全部终态，事件、数据、路径、对话框、租约和文档均清理；临时环境与构建目录删除，退出后只读核对临时原生可执行程序为 0。289 个选定源和生成产物/包起止稳定且当前源一致；这是选定证据边界，不是完整编译闭包。

验证：前端 85 文件/699 项、三 Rust 核心包共 40 组/304 项、Tauri 数据路径 25 项、catalog fixture 2 项通过；类型检查 0 错误/警告、默认工作区编译及相关 bridge/flags/source-binding 检查通过，仅旧 nom 未来兼容提示。默认构建 156 个前端/构建源起止及当前一致，首屏静态 JS 图 319,460/573,440 bytes，面板与拼音仍延迟加载；1200 功能冷建 13.255291 ms、120 次热查询最大 0.945417 ms，满足 25 ms 内核热查询门禁。未重验完整进程 CPU/RSS、绘制延迟或发布包。

独立审查修正了 host document identity/envelope、编码前配额、StorageEvent brand、异步事件等待与生成包标签。所有新模块低于 500 行。保留初次沙箱端口拒绝、两项浏览器脚本错误、未实际需要滚动的视口断言、旧 mock listener 导致的四项测试失败；最终版本均重验通过。native V1 实际流程通过但数据集误称原包，未作为最终验收；V2 已将 original 计数清零并单列 generated=2。错误的首次 Rust catalog filter 命中 0 项，其日志保留，修正后的两项确实执行通过。

下一步仍需扩大经源审查的真实原包业务覆盖，处理无 preload 页面直接 require Node、同步 BrowserWindow geometry、Worker 依赖，以及高频 storage 事件与最大容量成本；持续改进插件导入、授权与管理交互。不能把本批两段原类、1200 条合成元数据或静态兼容分类当成多数插件已经可用。

## 第二十二批推进：页面 Node、正确字节语义与 ATools 品牌

汇总见 `output/legacy-node-2026-10-16/plugin-node-page-brand-delivery-verification.json`。本批仍为 progress，整体目标 active；未提交、推送、替换安装版或新增 AppleScript/系统选择框操作。第十八批已完成的四步授权和证据保持原范围。

无 preload 页面现在经生产只读分析命令决定是否需要 Node，沿用原 capability/permission/TaskRun 和文档生命周期；未知结果不启动 Node。扫描仅限选中 HTML、实际 inline handler/本地脚本和静态依赖，4 MiB/64 sources/16层。已修复 `./preload.js`、bracket require、静态 ESM 本地依赖漏扫。独立盘点又发现 webpack 的 exports 属性、UMD 探测与 Vue process 方法被误当 Node 全局，现只标 unknown，避免多余授权/进程；`require.resolve` 也为 unknown，未声称支持该 API 或通用 Node ESM。实际页面始终留在隔离 WebView，Node 只以可信 manifest 的本地 HTML 作为 createRequire 锚点，不执行 HTML。

盘点 v2 为 180 个直接目录中的 17 个已解析无 preload 包：仅 image-stitch 检出模块需求，16 个 unknown；ctool 的固定入口未解析，另列 unresolved。此前 18 是候选数，不能算 18 个已确认 Node 消费者。静态分类不等于业务可用率；旧 heuristic readiness 脚本仅检查 preload，本批生产扫描结果单列在 `no-preload-page-node-inventory-v2.json`。

本地 Buffer 子集修复原版 Base64 的错误输出，支持常见编码、视图/复制、JSON、concat 和既有数值读取，单个 buffer 限 16 MiB，不启动 Node。getPathForFile 不再把具名 File 的 name 冒充本地路径，原图像 UI 可以实际 FileReader 导入。RPC 在 Base64 编码前对整次调用预检：单 binary 512 KiB、累计保守估算 900 KiB、深度64、节点8192，transport 再限 1 MiB UTF-8 JSON；超限拒绝不截断。重复对象只快照一次，重复编码仍累计计费；4096及以上回调的 close 死循环已通过独立分包修复。上述预算不是总堆内存上限，也不是 Node 文件系统沙箱。

最终真实 macOS WKWebView run `6df0a2e8-8a23-48de-b12a-acaaa80c5d70`（`native-plugin-page-node-v5.json`）35 项通过。两个生成 manifest 复用完整原版 image-stitch/codec UI 资源且字节 SHA 不变，不等同两个完整原包。A实际 App 搜索/Enter，先精确一次性数据和选择框能力授权（不调用选择框），再拒绝/重开允许 Node。拒绝无进程/文件；允许后真实 fs/Buffer/进程访问及原 UI 的单图顺序拖入、竖排/横排/反转/清空均验证。完整原 save 函数只在 fixture harness 中调用，保存路径与 reveal/notification 是固定 mock；真实 Node 写出195-byte、4×6 PNG，Rust 解码像素与 SHA。B 原版 UI 完成 Unicode Base64 往返和非法输入报错，实际 Node session/transport/permission 为0；函数形状的浏览器占位 API 没被误当真实 Node。

23 条 TaskRun 全终态，固定保存路径未进入扫描的 TaskRun 字段；数据/路径/选择框/文档/租约和 Node 会话均回收，临时目录删除。340 项选定源与 JS/CSS/native 产物、生成包起止及汇总时一致；这是显式证据边界，非完整编译闭包。退出后单次精确可执行文件计数：临时 app=0、固定 Node=0；不宣称 WebKit 后代全清单或完整进程性能。

品牌统一为与现有图标一致的 A 标记，覆盖搜索、设置、关于、浮球和超级面板；真实键盘焦点可见。组件静态浏览器 run `35724630-d158-45bb-b497-cb419ee8a358` 的800/420px、浅/深色8张截图与键盘菜单通过，Root逐张查看；实际 App 首页 run `9c545986-efee-4f15-a18a-302245d98e0f` 的4张矮视口首尾选择图和行导航通过并实看。两者为 Chromium、合成 IPC/回调证据，macOS 品牌视觉清单仍待确认。

验证：前端86文件/730项、三个Rust核心包42组（37非空）/318项、Tauri入口4项、类型/默认workspace编译和相关桥/资源/flags/source-binding检查通过。默认生产构建164项前端/构建输入稳定，初始静态JS为319,534/573,440 bytes，239,411-byte PluginPanel/Node chunk保持lazy；父进程4个测试环境变量实际被清除。1200功能目录单次冷建12.859041ms、120次热查询最大0.562958ms，满足25ms内核热查询预算；未重测长期CPU/RSS、绘制、正式包或竞品性能。

失败证据保留：品牌fixture文字溢出与CDP Enter驱动错误；首次native的数据/选择框授权顺序遗漏；第三次把兼容函数占位误当Node。v4流程通过但扫描器随后修正，最终以v5为当前证据。下一步继续扩大完整原包业务覆盖、同步窗口几何与Worker兼容、最大容量/长期进程预算和插件导入授权管理体验；多数可用及UI对标目标仍未验收。

## 第二十三批推进：导入恢复、内联模块与完整本地原包

详细契约、来源与验收范围见 `2026-10-16-import-original-package-delivery.md`；汇总为 `output/legacy-node-2026-10-16/plugin-import-original-delivery-verification.json`，run `77b30748-cfe2-47a0-b708-4301de11d18a`。本批 progress，整体 goal active；未提交、推送、替换安装版或新增 AppleScript 操作。

导入页在选择框前即互斥，保留真实部分成功报告；按失败原路径重试，不用清洗后的插件 ID 反推来源。读取失败独立重读；启用成功后不重复启用，确认真实状态才经 App 激活握手打开。结果行显示友好标题，状态与动作在窄屏正常换行。真实 App 静态 Chromium run `e3e80d73-a3ad-4001-b769-f2e6a6c7d40e` 的八张浅深色、800/420px截图经 Root 实看；关键操作可见、无横溢。该页面验收使用合成 IPC，不能替代真实导入/系统选择框验收。

真实原包暴露了 inline module 相对依赖无法加载的宿主缺口，现经有界词法定位改写到既有资源会话，外部与内联依赖复用每 Panel 一个 lease。只处理活动脚本，跳过注释/template/rawtext示例，原文件不变，CSP、opaque 隔离和目录边界保持。单模块256KiB、同页全部扫描模块2MiB、全部本地引用128次，解析前检查、重复照计、一次分段拼接；不新增Node/网络/LLM依赖，也不宣称完整ESM支持。

最终 native v6 四个完整本地目录为 cron@1.0.6、content-workbench@0.1.0、calculation-paper@1.4.2、developer-codec-tools@0.1.0，共40文件，33/34/35/36项检查和17条终态TaskRun通过。来源为 `local_full_directory`，没有生成清单，也不是官方ZIP来源声明。经真实目录导入、禁用/启用、搜索精确选中与Enter、PluginPanel和权限管线执行限定业务；计算稿纸历史/持久化、Cron高级令牌、加密/JWT及其他原包仍不在结论中。

各run371项所选源、四类产物和原包起止稳定；汇总核对当前374项源并集及四个完整原目录仍一致，当前原生二进制也匹配。Node未启动；运行时归零、自有临时目录删除，退出后一次精确原生可执行文件计数为0，不冒称WebKit后代全清单。模块图与延后脚本最终合成浏览器回归通过，9项所选测试依赖起止及当前一致。

验证：前端87文件/746项、三个Rust核心包318项及Tauri额外11项通过，JS原包验证器11项、类型0错误/警告、workspace与资源/来源/adapter检查通过。默认生产构建168项源及输入稳定，首屏静态JS319,534/573,440bytes，239,411-byte PluginPanel命名chunk仍lazy；1200功能目录冷建24.472834ms、热查询最大2.108666ms，满足25ms热查询门槛。没有重测长期CPU/RSS、绘制或正式包。

保留42份完整日志及各次失败报告：临时目录拒绝、三个场景脚本假设、真实内联模块加载失败、惰性HTML/词法误改回归，以及全套首次两项生命周期mock未就绪失败。最后一项补明确的mock就绪条件及组件身份断言，目标与全套重验通过；历史具体竞态仅为推断。已报P1/P2在本次范围内关闭，多数插件实际可用率、竞品UI对齐与完整性能预算仍待后续推进。

第二十四批库存流程、来源校验及资源采样的独立验收见 `2026-10-16-installed-plugin-workflow-delivery.md`；整体目标继续 active。

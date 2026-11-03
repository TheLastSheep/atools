**ATools 新一轮目标：Harris 插件优先的有限交付**

> **2026-10-23 当前目标已调整**：保留 Tauri WebView＋Rust 核心＋按需 Node，优先使 Harris 原版插件稳定可用；先减少通信次数、控制进程数量并完成退出回收，进一步 Rust 迁移须有明确测量依据。当前优先级和完成标准以 [Harris Node 兼容目标](2026-10-23-harris-node-compatibility-goal.md) 为准。本文保留首批范围和历史交付证据；下文早期的迁移建议不再自动生成后续任务。

用户已明确恢复开发，并指定作者为 `harris`。旧的全生态目标保留未完成记录；本轮执行范围以本计划为准。目标登记接口拒绝替换尚未完成的旧目标，因此不把旧目标标记为完成来创建新目标。

交付目标是一个可体验的候选版本、一份统一结果表，以及与该版本绑定的性能结果。首批结束即收尾，不自动扩大到原来的 213 个插件名单。作者名大小写不敏感；Harris 插件优先于下载量门槛，低于 30 次下载也不排除。其他插件继续作为后续兼容范围。

**首批来源与操作清单**

优先读取作者仓库 `/Users/harris/Desktop/ZTools-plugins/plugins/` 的现有发布产物，外部仓库保持只读；宿主缺口在 ATools 共用层修复。相同版本号也必须核对实际包内容。旧的 `typora-markdown` 不能代替当前 `live-markdown`。

| 插件 | 当前版本和发布入口 | 本轮核心操作 | 当前状态 |
|---|---|---|---|
| Live Markdown | 0.1.0；`live-markdown/plugin.json` → `dist/index.html` | 打开固定 Markdown、真实编辑与预览/源码切换、保存后重开 | 当前原包文档模块的Node回退与native读写契约分支均通过；Rust真实会话读写/取消通过；完整安装/WebView IPC/UI业务待验 |
| Paste剪切板 | 1.3.1；`pasteboard-pro/dist/ztools/plugin.json` | 安装正确产物、打开/查询固定文本与图片历史、预览与单条复制/粘贴 | 共用选择逻辑已修，实际原包正确选择 nested 发布目录；安装及业务待验 |
| Snipaste Pro | 2.0.1；`snipaste/plugin.json` → `dist/index.html` | 工作台可打开、固定图片标注/保存、贴图入口及独立窗口行为 | 当前原包入口/资源检查通过；业务待验；系统截屏/独立原生窗口单列 |
| 图片批处理 | 0.1.3；`image-batch-studio/dist/plugin.json` | 导入固定图片、完成一条缩放/转换路线、导出并验证文件 | 当前原包入口/资源检查通过；Sharp 原生依赖按需安装，安装及业务未验 |
| 格式转换 | 0.1.0；`format-converter/dist/plugin.json` | 完成文本/JSON/CSV核心转换；一条图片路线的引擎预检、转换与错误恢复 | 原始文本模块经生产CJS和限定Node回退完成固定Markdown→HTML；仍需fs/promises与iconv-lite；安装、其余转换及UI待验 |

可选 AI 模型、Office 引擎等不是编辑器/文本核心路线的安装前提。尚未配置的能力必须说明具体原因，不能让整个插件安装失败，也不能把不可用路线记为通过。破坏性系统管理、外网设备连接、全量模型下载不进入本轮默认验证。

**先解决的共用问题**

1. 原生 App 的 Node initialize 偶发/重复超时：保持 1500 ms 原预算，不自动重试掩盖问题。已有独立 CLI/bootstrap 和 Rust 会话成功记录只作对照；补齐一次有区分力的 stdout poll/字节/EOF 观察后，按现场证据修复。
2. 多目标源码仓库的发布产物选择：支持固定、非递归的 `dist/ztools/plugin.json`，沿用名称/版本一致、完整包根和资源边界；不按插件 ID 特判，不借用源码目录缺失资源，不自动构建或安装依赖。
3. 第一批原包的打开、返回、失败恢复与核心操作，按上述表逐项推进。只修真实失败的共用能力，不先扩建全套平台设施。

**验收与性能**

- 单一台账就是本表及下方进度；每项结果必须注明包版本/来源、实际操作和运行环境。静态扫描、模拟 IPC、安装、原生业务分别标记。
- 已存在的相关单测/集成先跑最小目标，确认非零命中；主 agent 审关键 diff 并独立验收。没有新变化或未解决问题时不重复全套。
- 初始静态 JS ≤573,440 字节；1,200 功能 matcher ≤25 ms；合成本地搜索 P99 ≤80 ms。桌面 IPC 搜索与合成搜索分开。
- 候选版本最终复用现有 macOS runtime benchmark，分别报告启动、热键、搜索、插件激活和 RSS。既有脚本门槛为首报告5秒、热键500ms、桌面搜索150ms、插件激活1500ms、宿主RSS300MiB；宿主RSS不冒充完整WebKit/Node进程树内存。
- 核心包100MiB门槛与包含Node/按需引擎的配置分开报告。实际未测的数据保持待验，不换用旧版本数字。
- 同机竞品视觉/操作对照选首页、插件打开/返回、安装失败恢复三条任务；不以组件截图替代整个原生工作流。

**执行限制与结束条件**

- Node共用阻塞先限一个诊断/修复小轮，最多两次完整原生复现；约45分钟没有新增有效证据就保存具体阻塞，继续可独立交付项，不反复重建同一环境。
- Luna worker 实现且不再派生；主 agent 负责生产调用链、接口、关键diff和最终验收。并行任务拥有不同文件。每个worker保存必要的局部before，不创建全仓graph/逐轮冻结树。
- 不改原插件业务以绕过宿主问题；不写外部作者仓库；不访问真实用户数据来替代固定夹具。
- 需要新的原生人工操作授权时，只提出具体缺失动作，复用仍有效的授权，不重复询问。
- 首批核心任务与预算全部通过才标记本轮完成。若存在未解决项，交付明确的候选版本状态和阻塞，不宣称兼容完成，不自动扩展目标。
- 不自动创建 Git 提交、推送或替换用户已安装应用。

当前派发：

| 任务 | 负责人 | 归属 | 状态 |
|---|---|---|---|
| Node startup stdout 最小观察 | Luna `harris_runtime_startup` | sidecar IO/诊断及必要测试类型接线 | 实现及主 agent 审查、18项相关测试通过；原生观察已执行；超时根因未修复 |
| 双目标发布产物识别 | Luna `harris_package_root` | package_resolution/mod.rs + 独立nested测试 | 实现及独立审查完成；主 agent 42项集成检查通过；真实 Paste 1.3.1 目录选取正确 |
| 版本/原包与核心操作盘点 | 只读Luna + 主 agent | 五包的现有manifest/入口 | 已核对；未执行业务 |
| 关键diff/相关检查/原生复验 | 主 agent | 当前工作区与已有验收入口 | 共用改动已审；工作区编译通过；两次原生启动复验一成一败，业务未通过 |

**2026-10-23 第一轮结果与下一步**

本轮代码变更共11个文件，最大463行；保留工作区其它改动。没有创建提交、推送、替换已安装应用，或修改外部作者仓库。本轮证据统一放在 `output/harris-plugin-first-2026-10-23/`，不创建逐轮全仓冻结树。

- **已修复的产品行为**：目录扫描、本地导入、市场包解析和 loader 共用的解析器支持固定 `dist/ztools/plugin.json`。完整 root/primary 发布包仍立即优先；主发布包不完整后才尝试 nested，核对名称和版本；入口、脚本、preload 均从所选包根读取。不按 Harris 或插件 ID 特判。
- **已补齐的观察**：已有诊断授权开启时记录 stdout reader 是否运行、原始读取字节数、EOF/读错误；不存正文。默认关闭诊断仍使用原始 BufReader 路径，没有新 observer/计时器/任务。没有改变1500ms初始化预算、8MiB行限、12事件或2048B快照限。
- **检查结果**：包解析9+14+19=42项通过；IO观察6项、既有启动诊断12项通过；宿主启动/错误关联18项和图片启动投影5项通过；另有两项matcher性能测试通过，合计85项通过。工作区 `cargo check --workspace --locked --offline` 通过并有既有警告；前端生产构建和实际初始JS图预算检查通过。宿主过滤集另有1个既有取消测试失败，不能称整组全绿：沙箱中先因回环监听EPERM失败，放开本地回环后精确重跑仍在“必须观察到真实子进程”断言失败。测试只等待opening登记就立即查一次PID，而opening登记早于异步Node解析/启动；该竞态尚未修复，不能作为真实Node取消清理已验收。日志为 `host-startup-tests.log`、`host-startup-loopback-test.log`、`host-image-startup-tests.log`。本轮文件的差异/新文件空白检查通过；全仓差异检查另报本轮归属外4处文件尾部空行，未顺手修改。
- **当前性能**：初始JS为424,644/573,440字节；matcher两项性能测试通过，其中1,200功能的20个样本最慢14.002ms，小于25ms。合成搜索P99、完整桌面启动/热键/搜索/激活/RSS和竞品同机比较仍待验；不使用本次局部夹具的RSS冒充完整应用内存。
- **实际原包边界**：当前共享解析器对上述五包均选到完整入口/资源（`current-five-package-selection.json`）。这不是安装或业务通过。实际生产依赖静态检查器对五包均返回 `complete=false`，原因含模板/动态语法、作用域不确定和预检文件预算；不能把未知当缺包或兼容成功（`runtime-dependency-reports.json`）。
- **Node启动仍未解决**：第一次脚本在沙箱进程清理阶段遭EPERM，未启动App，单独保留失败记录。随后两次真正的隔离App启动使用同一个固定Node22.23.3和现有原包JSON夹具：一次在1517ms超时，reader已运行但读取0字节；另一次在1397ms收到92字节并完成初始化，之后因前台状态前置检查失败，没有执行输入。两次均清理完成；没有运行成功的编辑、格式化或恢复验收。第二次拟采样没有捕获子进程，不能声称获得堆栈。当前只能确认启动不稳定；0字节读数不能单独证明子进程没有写入，亦不能证明UI或插件业务导致超时。
- **依赖盘点纠正**：图片批处理的Sharp平台包/Libvips缺少于dist是按需安装设计，preload捕获加载失败，具体图像工作流再触发安装；不能直接定为发布缺陷。格式转换也为Sharp等引擎提供按需安装，文本/数据路线不依赖Sharp；HEIC解码器缺失只影响对应输入路线，且不在当前运行时安装组中。上述为源码事实，下载/安装/转换尚未执行。

下一步保持五包范围，先交付 Live Markdown 的固定文件打开/编辑/保存，以及格式转换的文本/JSON/CSV路线，再推进 Paste、Snipaste 的系统能力和两款图像路线。仅补实际失败的共用能力；不能为可选AI模型或全部Office/图像引擎全量安装依赖。Node本轮两次原生复现额度已用完；有明确新假设或修复后再验证，不重新无条件跑同一窗口和输入循环。本轮目标尚未完成，尚无五包业务全部通过的候选版本。

**2026-10-23 用户确认的兼容层方向与第一阶段**

保留 WebView 与原插件代码，在宿主统一分派 Web/Rust/Node API；先兼容作者 Harris 的上述五包，不按下载量排除。Luna worker 实现，主 agent 定接口、接入生产调用链、审关键代码并独立复验。实际 workspace 没有旧说明中的 `atools-system` crate，因此本次 Rust 文件基础层归属现有 `src-tauri` host，没有新增 crate 或依赖。

| API/模块 | 当前分派与交付边界 |
|---|---|
| CommonJS preload | `pluginPreload.ts` 已接 `pluginModuleAdapter.ts`，原相对模块图、循环/异常缓存和 hostRequire 授权通路保留；pagehide/plugin-out 清理本地 adapter |
| POSIX path | `path`/`node:path`/两个 posix 别名共用本地 facade；常用路径运算不经 Node RPC；256参数、聚合1MiB UTF-8输入限额；win32/matchesGlob延迟走已有host，未知属性探测不触发host |
| Electron/系统能力 | 沿用现有 Rust-backed host bridge；本次统一层不新开权限通道 |
| 文件/进程/网络/npm/原生扩展 | 尚未覆盖的操作仍走已有Node回退及其权限/TaskRun；本轮没有删掉Node准备流程或改变发布包里的Node配置 |
| Rust文档基础层 | 私有 `plugin_filesystem` 支持相对目录FD访问、UTF-8读、metadata/exists、原子写；512KiB正文、16KiB相对路径、128组件、只读/穿越/symlink/FIFO限制；**尚未接到插件IPC或前端fs API**，不称已替代Node fs |

主 agent 已执行固定 Node22.23.3 的136项前端相关测试，以及当前 Live Markdown 0.1.0 原始 `preload/fs-workspace.cjs` 的固定临时文档创建、重名处理、保存、重读和标题/摘要检查；源文件哈希前后相同，路径模块没有host调用，真实文件操作使用测试宿主的Node fs回退。该结果只证明原包文档模块经生产preload入口可运行，不是完整Live Markdown、真实IPC、权限对话框或原生编辑UI验收。原包用例通过 `ATOOLS_HARRIS_PLUGIN_SOURCE=/Users/harris/Desktop/ZTools-plugins/plugins` 显式启用，默认CI跳过该外部来源用例。

独立路径对照覆盖5,000个固定种子向量、55,000次Node比较。首次发现的4个basename/parse差异已修复，原始失败保存在 `path-node22-differential-first-failure.json`，最终 `path-node22-differential.json` 为0差异。basename/parse状态机适配自Node22源码，版权/许可保留在源码legal comment及根目录 `THIRD_PARTY_NOTICES.md`。

Rust定向11项测试通过，包含Unicode文件名与恰512KiB字节边界、超限不改原文、目录/FIFO拒绝、相对路径预算、symlink、硬链原子替换、只读与时间戳。主 agent修正了macOS variadic参数提升和新增预算常量的模块导入后完成复验。未注入fsync/unlink故障，也没有验证Windows实现（非Unix明确ENOTSUP）。

两名Luna分别只读审查其未实现的接入/文件层，主 agent复核并处理发现。保留的明确边界：path.format只接受字符串字段，不复制Node对非字符串的宽松转换；path facade不保证完整Node对象的反射/修改语义；adapter不拥有borrowed host代理的生命周期。Rust目录按打开的FD对象锚定，不保证其它进程移动真实目录后仍处于当前绝对路径祖先；调用者必须先取得内容权限并在blocking worker运行。原子写生成0600新文件，不保留原mode/ACL/xattr；故障清理尽力执行，rename后父目录fsync失败时目标可能已改变，不能盲重试。

最终复验：136项前端相关测试+11项Rust文件测试共147项定向测试通过，前端类型检查0错误/0警告。`cargo check --workspace --locked --offline` 通过，host lib有159条警告，含尚未接IPC的基础模块未使用项及工作区其它警告，不称全仓零警告/测试全绿。含许可comment的前端生产构建与产物检查通过，初始JS仍424,644/573,440字节；实际lazy JS产物保留Node版权与完整MIT许可。相关既有接线的diff空白检查及8个新增代码文件的空白/规模检查通过，最大432行。证据继续归入 `output/harris-plugin-first-2026-10-23/` 的 `module-adapter-*`、`scoped-documents-tests.log` 与上述路径对照结果，不扩建验收设施。

本阶段新增8个代码文件，修改preload和host模块声明两处接线，新增代码文件均小于500行；没有写外部作者仓库、安装可选引擎、提交/推送或替换已安装应用。五包的完整插件交互仍待验；下一步在现有授权/TaskRun中接通受限Rust文件能力，优先补Live Markdown核心读写与格式转换文本路线，再逐项推进其余Harris插件。

**2026-10-23 Rust / Bun / TypeScript 方案评估**

用户要求先评估方案，暂停进一步产品实现。本次只核对源码、官方资料和有限临时夹具；产品运行时选择、依赖和发布配置保持现状。

- **语言与职责**：Bun官方2026-07-08公告已将Zig主体迁到Rust，仍使用JavaScriptCore和C/C++组件（https://bun.com/blog/bun-in-rust）。微软官方TypeScript原生编译器为Go实现；另有Oxc的Rust编译器/语言服务器 `tsrs`（https://github.com/oxc-project/tsrs）。TypeScript编译/检查工具变快不等于编译后的插件免除JS运行时或Node系统API。当前本地TS5.9.3、svelte-check4.4.8、Vite5.4.21，不在本轮顺带升级。
- **实际归因**：已检查的Node准备发生在插件面板加载链路；不能据此声称Rust核心搜索耗时由Node造成。`pluginRuntimePreload.ts`仍对任意非electron外部require预备Node，因此path-only导入也可能启动侧车。远端属性get与call分别同步RPC，经WebView同步XHR、loopback、Rust、stdio和JSON编码/解码；更换JS引擎不会自动省掉此链路、授权或preload分析。
- **同机有限实验**：固定产品Node22.23.3（112,925,600字节，107.694MiB）对本机Bun1.4.0（59,815,792字节，57.045MiB）；使用与生产相同顺序拼接的29,000字节bootstrap、原启动参数、空CJS哨兵anchor和initialize协议。两者各20次交错初始化均成功并自然退出，Node median/P95/max=30.399/37.807/41.418ms，Bun=33.992/46.452/52.708ms。本组没有证明Bun启动更快；其可执行文件更小约47%，不能外推压缩后的应用体积或RSS。
- **实验可复核性**：主 agent审了302行夹具脚本，独立复核生产bootstrap及实际二进制SHA256、40条成功/自然退出记录和median/P95计算。正式结果 `bun-node-bootstrap-evaluation.json` 与复现脚本 `.py` 在同一output目录。早期错误选用NVM Node22.23.2的报告保留为 `bun-node22.23.2-bootstrap-evaluation.json`，不作为当前产品版本对照。实验不执行插件原包，不覆盖Tauri/WebView/loopback/资源限制/权限UI/FS或npm行为/原生模块/进程树RSS/冷页缓存，不能证明旧原生App超时已解决。
- **切换门槛**：Bun接受现有 `--max-old-space-size=128` 不证明具有同等堆限制，官方repo仍有相关复现与待处理记录（https://github.com/oven-sh/bun/issues/34917）。Bun兼容页也列有Node模块差异（https://bun.com/docs/runtime/nodejs-compat）。Sharp官方支持Node-API兼容运行时，实际Harris固定版本及平台包仍需验证，不能把官方支持范围当本地业务通过。

推荐顺序为：①Rust/WebView承担Harris核心工作流与常用模块，减少侧车启动和同步get/call往返；保持原包、权限与TaskRun，不能把原子文档API直接伪装成完整Node fs语义。②Bun作为可选兼容运行时候选，先过Live Markdown核心与格式转换文本/图像固定路线，再考虑替换默认Node组件；核心包与兼容组件的大小分别计算，不默认同时捆绑两套大运行时。③TS7/tsrs仅作后续开发工具链优化，单独核对Svelte集成和诊断一致性，不占用本轮插件运行时预算。本次没有执行生产默认Bun切换或Node移除。

**2026-10-23 用户确认后的第二阶段：减少 Node 启动及文件读取往返**

三个 Luna worker 分别实现静态路径分析、前端 fs facade、Rust 读取通道；主 agent 负责生产接线、关键审查及以下独立验收。本切片已完成，Harris 五包完整业务目标仍未完成。

- **path-only 启动**：保守分析 CommonJS 完整预加载图，只有可识别的本地 POSIX 方法/常量子集才跳过 Node 准备。未知语法、模块逃逸、计算属性、写入、遮蔽、Windows、Node 注入全局以及兄弟模块依赖均保留原流程。每份分析限制128KiB、16,384 token、64别名，按源码缓存；不执行预加载来探测后重放。不是通用 JavaScript 语义证明，反射/修改语义仍不保证完整 Node 等价。
- **Rust 正文读取**：生产 `fs`/`node:fs` 共用 facade，精确两个参数的绝对 POSIX 路径加 `utf8`/`utf-8` 调用可走 Rust。复用现有 Legacy Node 会话、广泛授权、私有 Invocation 和 TaskRun；读取前后核验文档/插件版本/启用状态/权限和 FileRead。文件插件本轮仍启动 Node，未引入目录最小授权或独立零 Node 文件会话。
- **明确预算和回退**：路径8KiB、原始文件512KiB、JSON结果小于既有1MiB传输限；2个 blocking worker，5秒截止包含排队，超时后正在执行的worker继续持有配额至结束。非法UTF-8按Node兼容替换且保留BOM。有效请求内的超限/非普通文件/叶子symlink等显式回退一次；schema、权限、ENOENT和其它真实IO错误直接传播。stat、写、Buffer、其它编码/参数/平台仍走原Node；fs facade反射描述符为其自身可配置属性，不保证monkeypatch等完整对象语义。
- **Harris 证据**：当前 Live Markdown 0.1.0 的原始 `preload/fs-workspace.cjs`，通过生产preload创建/保存/重读/重名，原包哈希不变；Node回退和native transport契约桩两分支通过，后者四次正文读取均命中新通道、Node readFileSync为零。另在真实Node会话与内存数据库下调用生产Rust handler读取真实临时文件，确认FileRead缺失、插件版本变化/禁用、document撤销被拒绝。该两层证据仍不等于已验证同一条真实WebView IPC往返或编辑器UI。
- **主验收**：18份前端测试394项通过；Rust文件测试18项及原生读取会话测试3项通过；类型检查0错误/0警告。workspace check通过，host lib145条警告（工作区仍非零警告/全仓测试全绿）。审查修正了Rust导入、fs Proxy不可配置属性、分析器的写目标/Node全局及跨模块依赖、TypeScript收窄问题。新增和修改的本切片代码文件均小于500行，最大479行。
- **生产预算**：最终默认Vite生产构建通过，初始静态JS仍424,644/573,440B，新增兼容代码保持lazy；PluginPanel专属lazy静态闭包656,292B。没有新第三方依赖或第二套JS运行时。本轮没有测出新的原生启动/RSS/完整插件激活数据，不据此声称原生App超时已解决或Rust吞吐已提升。

证据：同日output目录中的 `native-api-frontend-tests.log`、`native-api-typecheck.log`、`native-fs-tests.log`、`native-fs-session-tests.log`、`native-api-workspace-check.log`，以及最终预算 `native-api-final-frontend-budget.json`（sourceHashStable=true）。没有继续GUI/AppleScript重试、修改外部原包、提交/推送或替换已安装应用。后续仍先解决Harris所需的明确宿主缺口，并独立补齐真实WebView IPC、编辑器交互与原生性能；Bun默认切换和工具链升级继续排除。

**2026-10-23 第三阶段：Harris 文档保存走 Rust**

本切片已完成。Luna worker 分别实现写入、前端分派与原包用例；主 agent 接通生产 bridge/权限/TaskRun 路由并独立验收，另由未实现 Rust 写入的 Luna 审查生命周期。保留原包、Node 配置和其余工作区改动。

- **能力范围**：POSIX 绝对路径、字符串正文、默认UTF-8或精确 `utf8`/`utf-8` 的同步 `writeFileSync` 可走Rust。路径8KiB、正文512KiB和既有1MiB传输限制保留。Buffer、fd、options、mode、wx/append、其它编码、孤立UTF-16代理字符等原样走Node。同步签名和默认参数参考 [Node v22文件API](https://nodejs.org/docs/latest-v22.x/api/fs.html#fswritefilesyncfile-data-options)，实际边界以本轮测试为准。
- **文件语义**：写入现有inode并截断旧尾部，保留权限、所有者和硬链接关系；不复用0600原子替换接口，不新增fsync。新文件0666受宿主umask影响，已与本轮固定产品Node22.23.3真实会话的默认新建结果对照。macOS目录FD使用O_SEARCH，避免错误要求目录读取权限；UID501下的0333目录创建/覆盖测试通过。Linux/Android实现O_PATH但本机未运行，其他Unix保留保守行为，非Unix明确回退。Node进程动态更改umask、任意monkeypatch及完整跨运行时全局状态等价未覆盖。
- **权限与取消**：写入独立核验FileWrite，读取仍核验FileRead；均复用现有Legacy Node广泛授权和TaskRun，不新开旁路。读写共享两个blocking配额和5秒截止。提交创建/截断前重验权限、会话和取消/超时；排队或提交前被取消的操作不能迟到写入。独立审查发现并修复了“TaskRun已取消但sidecar尚Running”窗口，Session现在先置单调closing标志，再访问数据库、等待或停进程。已经进入OS创建/截断的写入无法回滚；真实IO失败或超时均报错，不自动回退/重放。
- **Harris原包**：Live Markdown 0.1.0 的创建、保存、重读及重名处理通过生产preload；native契约分支4读/3写均走新接口，host fallback的readFileSync/writeFileSync计数为0，stat/exists仍Node，源文件哈希不变。transport桩底层仍用Node操作临时文件；Rust另用真实会话/临时文件测试，二者仍不冒充同一条真实WebView IPC链。
- **纠正格式转换证据**：直接在Node里require原模块不能证明CJS兼容层。实际原始 `text-converter.cjs` 顶层依赖 `node:fs/promises` 和 `iconv-lite`；生产preload在只提供这两个真实Node依赖时完成固定Markdown→HTML，无host则明确MODULE_NOT_FOUND。本轮不再称它是无Node的自包含文本模块，Sharp等可选引擎仍未启动。其0600安装anchor、Live本地AI的wx/fd/锁和Buffer图片写入继续Node。
- **独立验收**：19份前端测试433项通过；Rust filesystem过滤32项、会话生命周期10项和document生命周期4项，共46项通过。会话监听项首次因沙箱禁止本机bind而EPERM，其余9项已过；放行后仅重跑该单项并通过，原失败日志保留。旧的 `aborting_real_node_startup_removes_the_opening_and_preserves_its_pending_run_for_close` 历史启动取消用例被明确排除，未宣称修复。类型检查0错误/0警告，workspace check通过，host仍有147条警告。
- **预算**：默认生产构建通过，初始静态JS仍424,644/573,440B，PluginPanel专属lazy静态闭包658,454B；新增兼容代码继续lazy，没有新依赖。22个本切片代码文件的规模/空白检查通过，最大478行。没有新的原生激活/RSS/安装包体积数据，不声称整体性能或原生App启动故障已解决。

本轮证据位于同日output目录：`native-write-frontend-tests.log`、`native-write-typecheck.log`、`native-write-filesystem-final-tests.log`、`native-write-session-lifecycle-tests.log`、`native-write-session-listener-test.log`、`native-write-document-lifecycle-tests.log`、`native-write-workspace-check.log`、`native-write-frontend-budget.json`。本切片未调用GUI/AppleScript、修改原包、安装引擎、提交/推送或替换已安装应用。原后续建议为metadata/exists迁移及真实WebView业务验收；现已由2026-10-23的新目标替代：先补启动、通信、进程与业务稳定性证据，metadata/exists保留Node，只有明确测出瓶颈才考虑下沉。

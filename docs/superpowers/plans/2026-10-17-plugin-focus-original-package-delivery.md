# 插件焦点与原版压缩包交付记录

本轮推进插件进入后的焦点、导航栏与弹窗之间的交互，并补齐原版 ZPX 的实际导入证据。多数原版插件直接可用、完整编辑器交互和与 ZTools/uTools 的视觉对照仍待继续验收，目标保持进行中。

最终汇总与源码核对：`output/plugin-input-2026-10-17/plugin-focus-original-package-delivery-v2-final.json`。v1 汇总保留，由 v2 补充额外格式化范围核对限制。

## 生产改动

新增独立的 `src/lib/pluginFrameFocus.ts`。插件 frame 挂载、加载和原有 paint 等待完成时，只在宿主已有焦点且没有其他控件占用焦点时尝试聚焦。导航输入框、按钮、权限确认、宿主 modal、子输入请求和激活中的子窗口优先；旧 frame、退出中和 Worker 清理中均拒绝抢回焦点。没有新增轮询或计时器。

子输入的异步 focus/select 在下一次渲染后重新核对请求、输入元素和权限/modal/子窗口等状态。移除子输入后的焦点恢复也经过同一守卫，避免较晚到达的请求覆盖用户已选中的按钮。独立 helper 测试和实际 PluginPanel 组件测试覆盖这些路径；组件测试使用模拟 DOM，不替代 WebKit 原生输入验收。实验性显式 page-document 模式未接入该 helper。

索引中的重复正则现在按相同原始 pattern 共享一个 `Arc<Regex>`，包含无效表达式的负缓存，避免每条命令的 `Regex.clone` 在首次查询分别初始化 scratch pool。全局正则缓存和原始 `search_all` 保持原契约；索引实现与测试拆至语义独立模块，相关文件均少于 500 行，公开导入路径保持兼容。排序、分值和既有文本/typed 匹配行为保持；同 pattern、异 pattern、结果一致性及共享索引/克隆的多线程正确性已验证。既有 Kelvin 符号等 Unicode 的 raw/index 差异单独记录，不归因本轮缓存优化。

一次误用 `cargo fmt -- <文件路径>` 的操作没有可靠限制范围，额外发现 7 个既有 Rust 文件指纹变化：`src-tauri/src/lib.rs`、`plugin_inventory.rs`，以及 `legacy_runtime/` 中的 `desktop_smoke.rs`、`desktop_smoke_panel.rs`、`desktop_smoke_published_fixture_tests.rs`、`desktop_smoke_published_plugin.rs`、`mod.rs`。它们同一时间变化，执行者未直接编辑这些文件，但未保存完整格式化输出或修改前字节，不能将“仅格式变化”当作已完成的逐字节证明。原有脏改动保留，未凭 HEAD 或猜测覆盖恢复；最终完整 Rust 回归、原生 Worker 与性能验证均绑定并覆盖当前源码。此范围核对限制在最终汇总中逐文件记录。

## 原版包导入

`src-tauri/src/ztools_import/original_archive_tests.rs` 通过真实扫描、导入器和数据库验证原版 `my-calculator@1.0.1`。输入为未修改的 `my-calculator.zpx`，83,406 字节，SHA-256 `af29034f61199203a4e3161b3e119cd9bca4d544ae7e23127b4e04e7e407b1cd`；它是 Brotli/ASAR 包。

用例复制原包至本次私有临时目录，确认候选 ready、实际导入和功能命令记录，再校验安装目录恰有 8 个预先独立钉住的文件及逐文件大小/哈希，最后确认原包与副本未变并清理。测试不执行插件 JS/preload，不能据此宣称计算器 UI 已可用，也不能将该归档版本视为当前根目录源码的构建结果。

参考生态目录属于可选本地来源，因此该用例只在显式启用 `local-original-archive-fixtures` 时注册；默认开发和 CI 测试不依赖参考目录。明确选择后，原包缺失或摘要变化仍硬失败，不静默跳过。运行方式：

```sh
cargo test -p atools --lib --features local-original-archive-fixtures ztools_import::original_archive_tests::imports_hash_pinned_original_calculator_brotli_zpx_without_execution --offline -- --exact --nocapture
```

## 原生验收与诊断

诊断及验收代码增加了窗口 occlusion 可见性、宿主/frame visibility、原版 textarea 的有限焦点事件记录，以及两个临时空输入控件的对照。日志不记录用户输入、指针坐标或其他应用身份；事件有容量限制，原生 getter 只在主线程读取本次临时应用的窗口。

最终 UI 报告 `output/plugin-input-2026-10-17/native-json-editor-v13-preconditions.json`，runId `8aaebf80-2d9f-47c6-bc4a-ddb0638d8b06`：应用激活、前台 PID、自身窗口 focus/visible 均为真，但 `windowOcclusionVisible=false` 且宿主 document 为 `hidden`，故在输入前拒绝进入 UI 验收。没有由此确认锁屏、显示器休眠或某个 WebKit 根因。

此前 v11 一度获得原版 textarea 的原生 focus 事件且编辑命令返回接受，但渲染文本仍未出现、rAF 未完成，完整 UI 断言失败。v12 原版 textarea 与两个临时空输入控件均不能聚焦，frame 为 hidden。这些失败报告保留，均不计作输入/格式化成功。

最终 Worker 独立回归 `native-json-worker-contract-v6-final.json`，runId `bd1347a4-3c8f-4b37-ad33-7abe25158f37`，49 项检查通过。额外的 `json-contract` Worker 使用原版入口完成合法/错误/恢复模型协议和关闭清理；它不替代原版 UI 编辑。原包字节、验收源码和生成产物稳定，运行时计数归零，临时应用与数据清理完成。

AppleScript 的旧四步目录/保存授权对应验收已在历史记录中完成，本轮没有扩展该授权，也未使用 AppleScript、其他系统输入工具或物理按键来控制编辑器。

## 自动检查与性能

`code-validation-v1-final.json`：前端 100 文件/893 测试通过，类型检查 0 错误/0 警告，Worker/资源/观察器/fixture 专项通过。最终 Rust 改动由 `rust-code-validation-v3-final.json` 绑定 1,021 个选定输入：完整 core/plugin/API-shim 共 322 项通过，宿主默认 423 项通过、1 项既有可选构建产物测试忽略，显式原版 ZPX 1 项通过，workspace 与原生 fixture 编译通过。最终核对确认前端源/测试/构建输入未变，并记录旧报告中已由后续 Rust 验证覆盖的差异，不将旧快照冒充最新代码。

`default-bundle-budget-v1-final.json`：生产首屏静态 JavaScript 为 319,833 / 573,440 字节，PluginPanel 为 240,340 字节且保持延迟加载；176 个构建输入在最终代码中一致。该门槛不代表启动时延或内存。

新增独立的 1,200 功能/25ms 索引查询预算，覆盖精确指令、中文、拼音首字母、全拼和 1,200 条宽结果。每类独立建索引，计时包含第一次查询和后续三次查询，不含构建；20 次均校验结果。旧有 5,000 功能的 500ms 原始搜索/50ms 索引门槛保留，不能把它描述为 25ms 检查。

`matcher-interactive-budget-v1-final.json` 保留优化前两次串行失败：首次精确查询分别为 25.49ms 和 27.70ms。最终 `matcher-interactive-budget-v2-final.json` 在代码稳定、无并行构建/测试时通过两个测试，20 样本均在 25ms 内，首次精确查询 0.53825ms、最大样本 0.918584ms。该结果属于本机未优化 test profile 的固定合成数据，不能推及插件数量、进程冷启动或正式应用 UI，也不计算改善百分比。

`regex-cache-mechanism-v2-final.json` 保留锁定 regex 1.12.3 的一次机制微实验：5 轮新向量的首次匹配及 warm 记录、固定四线程共 192,000 次匹配的布尔检查均完成。它只解释缓存成本，不能替代索引/应用预算或证明一般并发吞吐；并发块含首次初始化、线程创建与 join，未隔离纯 warm 锁开销。v1 描述误将总调用数写成每线程数，v2 仅更正该算式并保存相同原始记录与证据，没有重新采样。

最终 `native-panel-resources-v2-final.json`，runId `ef3066a6-f60e-40c0-8b9f-08eb26329438`：无并行构建或测试时完成 5 个新进程、100 次热搜索，DOM 结果就绪 P50/P95/P99 为 30/31/33ms，返回与 Escape 恢复焦点 P95 分别为 28/27ms。五次 launcher ready 样本的 P95 为 422.35ms。v1 保留优化前源码的独立五轮记录。

这轮使用 observe 模式，五轮记录均包含窗口 occlusion 不可见和 document hidden，结果是后台 DOM/IPC 观测，不是可见前台绘制、物理快捷键或竞品 UX 时延。数据包含 1,200 个合成元数据功能，只执行两个原版插件，不能描述为 1,200 插件兼容验收。源码、产物稳定，五轮临时数据及 scratch 均已清理。

已归属宿主独占进程组的 RSS 峰值最大 150,175,744 字节。WKWebContent/XPC 仍未归属，该数值不代表完整应用内存或物理 footprint；全应用常驻 CPU/内存预算保持待验收。与此前轮次存在执行状态差异，不宣称性能改善百分比。

## 下一阶段

- 原生 UI 可见前提满足后，验证原版 JSON 编辑器的实际输入、渲染、格式化、错误诊断与恢复；完整目标仍不能由 Worker 协议代替。
- 将本地原版 ZPX 作为明确的 archive 导入来源贯穿原生 fixture，实际调用 importer 的参数必须指向 `.zpx` 副本，再校验真实安装目录与原版计算器按钮/结果，不能以解压目录代替归档导入。
- 继续按原版真实包的交互路径扩展覆盖；静态 ready/build 分类与运行可用率分别统计。
- 在可见前台环境补 UI/交互对照、物理快捷键和全应用资源测量。

本轮未执行 Git 暂存、提交或推送。

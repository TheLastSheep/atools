# 08: 有边框窗口的运行时外框尺寸语义

**What to build:** 修正 native BrowserWindow.setSize / setBounds 和 DOM resizeTo 的外框尺寸与内容尺寸转换，保持 setContentSize 的内容尺寸语义。

**Blocked by:** None for source implementation and deterministic contracts. 真实 OS 尺寸仍依赖已暂缓的原生验收。

**Status:** source-contract verified — initial/runtime size basis and confirmed content geometry; actual OS geometry pending

## 修复前已确认的源码证据

- 当前 Cargo.lock 的 tauri 与 tauri-runtime-wry 均为 2.11.2。
- 本地 tauri 2.11.2 `src/webview/webview_window.rs:2219` 将 WebviewWindow.set_size 转发到 window.set_size。
- 本地 tauri-runtime-wry 2.11.2 `src/lib.rs:3531` 的 WindowMessage::SetSize 调用 window.set_inner_size。
- 项目 `src-tauri/src/plugin_browser_window_native/actions/geometry.rs` 的 SetSize、SetContentSize、SetBounds 都直接调用 window.set_size。
- `adapter.rs::calibrate_outer_size` 仅在 framed 且 !use_content_size 的创建阶段测量并校正边框差值，运行时动作尚未复用该转换。

因此有边框窗口的外框尺寸动作存在源码层语义缺口。Harris Snipaste 2.0.1 创建目标为 frame:false；Task07 的原包 DOM 合同不证明通用 framed 尺寸语义或真实 OS 几何已经通过。

## 验收要求

- 在同一可信 native action / UI thread 内使用真实当前边框与 DPI 信息，不硬编码标题栏高度、不伪造尺寸；保持权限、source/owner、TaskRun 和资源预算。
- setSize / setBounds 使用外框目标；setContentSize 保持内容目标；处理不可满足的小尺寸、约束、缩放与错误传播。
- 补有区分力的确定性测试；真实跨平台 OS 尺寸单列待验，不能由无边框或数学测试替代。
- 不为本问题增加 Node 调用、常驻进程或周期轮询；按文件职责拆分，不越过 500 行。

## 本批确认与实现接口

- 前端原生快照已有contentBounds，compact geometry却漏发；getContentSize也读outer。同步getter必须保留真实content并维持零getter IPC，native实测值不因暂时超出adapter约束而被当作伪造快照丢弃，hosted约束检查继续保留。
- Electron构造min/max随useContentSize选择content/window基准，公开getter始终outer，runtime min/max先转outer再合并。因此引入明确ConstraintBasis，不把同一组raw数值混作两种基准；初始content原值保留，公开快照按当前实测frame转换。
- 独立size policy基于当前scale及physical outer/inner测量，runtime外框请求扣除chrome后交Tauri inner接口；content请求直接交inner。约束保留None无上限/下限，处理不可表达max、小于chrome目标、无效采样和舍入边界，不硬编码标题栏。
- 生产geometry executor提供fake backend seam，覆盖parser→真实executor→post-operation snapshot返回；setter不能回显请求值作为actual。Tao macOS可能异步排队原生尺寸操作，读回仅表示current observed，不能仅凭set_size返回就宣称最终布局完成。
- 继续暂缓GUI/App/AppleScript/原生探针；本卡的确定性检查不会升级为跨平台OS几何验收。

## 主 Agent 独立验收

- 54项相关Rust用例、25文件/192项前端回归通过；类型检查0错误/警告、生产构建、离线锁定工作区编译及原同步句柄脚本通过。
- 首次前端回归5项失败来自旧ready夹具：标记native但缺少真实生产链必须提供的nativeSnapshot。夹具改为生产StateFactory、reader及applySnapshot后复验，保留就绪顺序、旧文档、identity和lease断言，并增加不同outer/content getter断言；生产逻辑未因夹具失败而放宽。
- 15个代码文件均不超过500行，最大458；冻结指纹复核一致。原Snipaste 2.0.1的六个既定文件指纹与上批一致。
- 启动JS保持432,238/573,440字节；插件按需文件729,661字节，比上批增加1,103字节，原大chunk警告保留。没有新增Node调用、进程或轮询。
- setter成功只代表请求被接受，读回只代表当前观测；保留异步布局和setBounds部分提交的错误边界。完整原生几何、跨平台及进程树性能继续待验。

完整日志、源码指纹及边界见[本批记录](../../../output/native-frame-size/verification.md)。

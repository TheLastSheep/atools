# R77 原版主搜索框文件拖放

工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`；固定只读上游 `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。目标是原 SearchBox 的文件/目录拖入、高亮、文件标签与成功后清空 query；不是插件文件读取或 Settings 本地启动项登记。整体 UI、默认入口推广与真实物理拖放验收不缩减。

## 已核对的缺口与选择

原 SearchBox 从 DOM File 调用 Electron `getPathForFile`/`checkFilePaths`；当前 Main adapter 没有这些方法。Tauri 双 Webview 的 Main 是 WindowChild，原生拖放是 WebviewEvent，现有 WindowEvent 插件通道不能替代它。复用 R67 的精确 Webview 绑定模式和既有 Main 身份/导航/呈现生命周期，新增 Main 输入适配，不开放任意路径 stat 或文件内容读取接口，不伪造 File.path。

保留原模板、CSS 和原 DOM fallback 源码；允许 SHA 锁定的 SearchBox 脚本兼容补丁。Tauri 接管时原生路径为唯一文件输入来源，DOM 处理只 preventDefault/stopPropagation，不重复录入。旧插件/Settings 拖放通道保持各自归属。

## 共享边界

- 原生绑定只安装一次到真实 original Main Webview。默认 Svelte、其它窗口/URL、Settings Child、插件均不得借用该目标。需要真实 Main URL、父窗及来源校验，不凭窗口标题认身份。
- SearchBox 是接收区域，不把整个主窗口视作拖放目标。前端只在 Search 视图注册实际 `getBoundingClientRect`，以 Webview CSS 逻辑坐标提交有限矩形；Rust 用该次事件的物理坐标和实际 scale 映射。矩形仅决定 owned Main 内命中，不授予任何文件路径权限。尺寸变化更新需单在途/最新值合并，失效后不能由迟到响应复活。
- 锁定Wry0.55.1 macOS的drag_drop实现直接使用AppKit逻辑point并截为整数，Tauri-runtime-wry又将它标成PhysicalPosition；Main绑定必须仅在此平台边界先raw×当前scale规范为physical，再共用CSS换算。其它平台保留真实physical路径。实际probe也构造该backend raw逻辑point，不能用手造physical输入掩盖倍率错误；原始截断精度与真实OS命中仍待物理验收。
- Main 目标注册使用单一闭集命令 `set_renderer_main_drop_target`，外层仅有 `request`。`{op:"context"}` 返回 `{contextId}`；`{op:"set",contextId,leaseId:null|UUID,target:null|{x,y,width,height}}` 返回 `{leaseId:null|UUID}`。context随导航/Settings开始等撤销动作轮换，旧context请求不得在新文档注册；非空有限矩形注册/更新返回 opaque lease，禁用只撤销相符owned lease。事件监听成功后才查询context和注册目标，不能撤销其它代；禁止再增加通用事件转发器。
- 单一 targeted Main 事件 `renderer-main-file-drop`，公共字段严格为 `{version:1,leaseId:UUID,sequence,phase}`，sequence为递增安全整数；hover variant只另含`hovered:boolean`，drop variant只另含`files:[{path,name,isDirectory}]`，error variant只另含`code:"INVALID_BATCH"|"METADATA_FAILED"`。hover只在命中状态变化时发，不逐个转发原生Over坐标。前端严格校验闭集形状/字节/序号，未知字段或其它lease不投递。hover与输入结果分别拒旧，高序号Leave不得吞掉此前已接受Drop的异步结果；新Drop结果仍胜过旧Drop。
- 原生接受Drop时同步结束当次hover，再开始异步元数据；overlay由hover事件及lease/view失效控制。迟到的内容结果不覆盖后续新拖入的hover状态。前端集成入口固定为`onNativeMainFileDrop(element,callback) -> {setActive,dispose}`，只绑定同文档真实SearchBox元素；底层context/region命令由该控制器持有，不把路径API扩散给原组件。
- Drop 必须命中当前区域且当前 Main 文档仍有效；Settings 开始打开、导航、销毁或退出撤销目标/批次。隐藏至少取消全部旧批次并使目标失活，可保留同文档的区域配置；只有新的 Native show 意图且身份/所有者仍有效才能恢复，迟到ack不能恢复active。SearchBox 退出 Search/卸载也撤销其 owned lease。Main 和 Settings 两条处理不得重复接收同次输入。
- 只有 OS 事件给出的路径可进入元数据读取，前端命令没有 paths 参数。原始批次先限定最多64项、每路径UTF-8最多4096B、总输入最多64KiB，名称最多1024B；拒绝不合法编码/相对路径/NUL。按原顺序保留有效文件/目录，重复路径只保留第一次；不存在/不支持的条目不产生错误名字映射，不读内容/执行/登记/写TaskRun或历史。
- 上述不登记/只stat约束针对本Main输入模块。当前Tauri启用protocol-asset与assetProtocol，框架内置OS Drop另会allow_file/allow_directory(recursive=false)扩展asset scope；这是既有框架行为，不能声称整条Tauri路径没有scope副作用。私有catalog smoke关闭asset服务且直接注入binding，未覆盖该框架路径；真实OS拖放与其权限/资源范围须后续独立验收，本轮不静默修改全局权限或依赖。
- 元数据工作不占 UI 线程；同时最多1项实际工作和1项最新待处理批次。取消/过期不提前释放仍在运行的工作计费；完成后重验 lease、Main身份/生命周期和当前批次。后一个已接受 Drop 胜过前一个；Leave 只复位高亮，不能取消已接受 Drop。失效清 pending，不产生常驻轮询、Node、进程或新依赖。退出不能把仅取消 future 称作实际工作已结束。
- 成功且非空才按原版顺序更新 pastedFiles、清空 query，原 App watcher 继续处理图片/文本互斥。空、错误、非命中、迟到或取消保留原输入与文件状态，结束高亮，不记录原始路径或文件内容到日志/审计。错误沿既有受限反馈/诊断路径，不添加实现细节到产品 UI。

## 验证与预算

1. 实施前保留真实调用方失败，覆盖 native Main 接线、单目标/代次、批量元数据、有界工作及失效；不以仅 schema 自洽替代实际 Main 创建绑定。
2. 原 SFC/App 的合成浏览器流程覆盖区域高亮/leave、成功 chips/query、目录/混合失效项、错误保留、DOM/native 去重、双 Drop 乱序、切视图/卸载/注册失败与归零。模板/style 块字节相同，补丁与正式 dist provenance 绑定。
3. 用既有隔离 Native harness 复用真实 Main 和同一生产处理函数，固定 owned 临时文件/目录，取得真实 Rust→targeted Main→原 SearchBox/App→Main launch-context 及关闭清理证据；输入须标 `rust-injected-native-drop`，不能称真实 OS 拖放或物理输入。不新建通用 GUI 控制入口，不重试失效 CUA。
4. 真实 OS 拖放、可见像素/焦点、跨屏/平台分别保留待验；不得只因隐藏或合成通过切换默认 Svelte。
5. Main基线604522B，旧上限606381B；首次正式stage候选609832B（新增5310B、超旧cap3451B）已exit1拒绝且未发布，旧产物/112项来源hash保持。Root据本次完整Main输入、闭集验证及取消恢复行为，明确批准R77增量预算6144B，新绝对上限610666B；此决策在重建前记录，不删校验或把内存/时延当已测。Settings803857B/804189B，本任务不应增长；旧失败及旧cap来源保留，新门槛须重新正式stage构建、来源复核后才发布。无新运行时依赖/Node/轮询/生产进程。
6. 无新运行时/公共服务/账号/网络/轮询。单 Cargo lane，`--locked --offline -j 2`；产品 Node22.23.3。作者文件≤500行，按职责归属拆分。源变更冻结后由非实施 Sol/Terra 复核；Main输入路径/工作生命周期交 Astra 限定关键复核，Root负责实际运行准入及最终验收。

证据目录 `output/renderer-main-file-drop-r77-2026-11-02/`。会话探针的 default `sessionAvailable=false` 与 elevated `true/onConsole=true/loginDone=true/screenLocked=null` 仅证明查询上下文差异，不能声称锁屏、解锁或 NSPanel 已验收。

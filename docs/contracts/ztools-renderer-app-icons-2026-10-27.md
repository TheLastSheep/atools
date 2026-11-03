# 原版 renderer 应用图标

工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`。固定上游 Vue/CSS不改；默认入口暂不切换。R18的窗口验收等待解锁不阻塞本切片。

## 用户行为

原Vue的AdaptiveIcon接收应用目录的真实图标URL，沿用原懒加载、图像分析和失败占位。列表读取只生成URL，不批量解码图标、不启动Node、不添加轮询。缺失图标继续走原占位，不伪造图像成功。

## Native协议

- `atools-app-icon://localhost/<64 lowercase hex>.png`，平台转换形式仅允许`http(s)://atools-app-icon.localhost/<id>.png`。ID为SHA256(每宿主进程随机32字节盐 || SHA256(应用路径UTF-8))，两段输入固定长度；URL不含原始路径或盐。同进程同路径稳定，宿主重启即失效，避免无referrer的远程frame由已知路径猜出URL探测应用。
- GET only；无query/fragment/credentials/port。只允许本地主main Webview，子视图和远程页面拒绝。
- 用AppState当前catalog source的实际成员身份解析ID；不接收前端文件路径。没有成员返回404；未就绪503；准入超限429；错误响应无文件名/路径/用户内容。
- 200仅返回image/png，带nosniff和private短期缓存。仅对明确本地origin响应CORS；不创建任意目标代理。Origin/Referer均缺省时，只在已确认本地主main页面接受，依赖不可猜的进程级ID及catalog成员复核；不能宣称仅凭Webview label就区分了frame来源。
- 协议注册、普通桌面及隔离renderer共用host_builder，不能只在fixture中可用。

## 资源预算

- 最多2个实际图标生成任务，最多128个总在途请求；不建立无限等待队列。
- 热缓存最多256项/8MiB，TTL 5分钟；单PNG≤64KiB、64×64像素。锁不跨生成/OS调用。
- permits必须计费至实际阻塞工作结束，不能因等待者取消提前释放。重复暖缓存请求不再生成。
- macOS用系统图标API绘制到固定64×64离屏位图，保护graphics context并使用autorelease pool；不启动或聚焦目标应用。其他平台明确unsupported，不伪称已验。
- 这些是自有队列/位图/缓存预算，不是AppKit内部RSS或端到端时延测量。
- 前端全部JS仍≤586,528 bytes，不重设基线/增长阈值；setting资源保持原门槛。

## 接口与归属

- `launcher_app_icons::icon_url(&str)->String` 供catalog建立元数据URL；`register(Builder<Wry>)->Builder<Wry>` 供共享host注册。
- image模块：`ICON_EDGE: u32=64`，`MAX_PNG_BYTES: usize=65536`，`load_icon_png(&Path)->Option<Vec<u8>>`；所有返回字节必须满足PNG/尺寸/字节门槛。
- protocol/service worker只拥有该模块的mod/service与对应测试，不修改image模块、catalog、AppState或host wiring。
- image worker只拥有image模块与对应测试，不修改protocol/service或已有commands.rs图标实现。
- frontend worker只拥有imageAnalysis的精确URL支持与相关测试，不改Vue/CSS/mapper/hostAdapter或预算。
- Root负责catalog/host/CSP接线、关键diff审查、统一Cargo/实际验证和证据。

## 验收

Rust验证URI/调用方/成员拒绝，源切换隔离，暖缓存、TTL/淘汰、并发准入和取消后实际worker计费；自建临时app的OS离屏图标确实输出64×64 PNG。前端验证精确scheme/ID规则，保留其他asset/data防线，并通过原有图像分析/完整类型/构建门槛。解锁后再验原Tauri页面的真实img decode/错误占位与完整窗口回归；锁屏不能视为通过。

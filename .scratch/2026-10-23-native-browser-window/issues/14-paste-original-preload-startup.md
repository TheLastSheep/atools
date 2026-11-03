# 14: Paste原构建后台业务启动验证（Task13子项）

**What to build:** 沿生产 WebView/Electron adapter/按需Node/PluginData路径加载Harris的Paste 1.3.1原构建preload，验证持久贴图队列初始化、失效项修剪与回写；不得只执行auto-start helper便宣称原插件后台可用。

**Blocked by:** 13的原生启动准入与持续文档宿主接线。Task13在本子项未验收时仍保持in progress，不以拆票缩减其原验收范围。

**Status:** source-and-isolated-runtime verified; native integration and original UI remain deferred, Task13 remains in progress

- 原构建：`/Users/harris/Desktop/ZTools-plugins/plugins/pasteboard-pro/dist/ztools/preload.js`，SHA256 `6566635ba6f1143379ec980e42248cd666b2fa8d871a621f65e76c04ab1c98d3`；manifest SHA256 `58e89b2e6b9d3c95711fe5f41852b24e2de32e0c2575c4866eb9fc1cc9e62ae8`。执行前重新校验。
- 原业务入口：`apps/ztools/preload/index.ts`的primary window分支构造`PasteStackRuntime`并调用`initialize()`；队列文档为`pasteboard-pro:paste-stack`。原`paste-stack-runtime.ts`与`paste-stack-store.ts`承担读取、解析记录、清理、revision冲突处理及持久写回。
- 已有ATools`plugin-background-startup.test.ts`仅测试原Snipaste登记preload及Paste的auto-start helper；`harris-snipaste-paster-queue.test.ts`是Snipaste的paster payload队列，不是Paste的持久队列。
- 生产CJS加载保留WebView侧Electron adapter；Node module bridge将electron路由回本地adapter。不得将fallback shim或一次性no-op harness当生产实现，也不得据sidecar拒绝electron推断整条生产链缺失。
- 无GUI协议验收应使用隔离临时目录和可观察的持久数据，明确受控OS输入钩子/剪贴板边界；不得启动实际全局输入监听或伪造成功回执。记录真实原build的模块图、Node路径与worker启动/退出。
- 文件队列消费调用`clipboard.writeBuffer`；已用未修改的原`writePreparedStackItem`与生产序列化adapter复现缺少provider错误，原始失败保留于`output/paste-original-startup/harris-paste-file-queue.red.log`。通用文件列表decoder与现有typed file-write接线正在主审；完整built preload的文件队列仍待独立验收。
- 主Agent已独立通过原preload与历史worker源码图准备、safeStorage前置拒绝/允许及环境复用合同2/2，默认源码预算未放宽；见`output/paste-original-startup/graph-main.json`。这不等于执行原业务或实际启动Node。

GUI/App/AppleScript/原生输入钩子验收仍按用户指示暂缓。原包只读；测试替身、生产适配、业务协议与实际系统验收分层记录。

主Agent最终独立通过42个文件/351次用例执行（0失败/跳过）、应用类型检查与默认生产构建。完整原build文字/文件队列均完成初始化修剪、SQLite重开与消费，实际fixture Node及Worker退出确认；不把受控权限、输入和clipboard端口当作Tauri/Rust/OS验收。启动JS保持449,118字节，独占按需JS791,421字节（+6,889）；11个归属代码文件≤500行且最终指纹稳定。详见`output/paste-original-startup/verification.md`，总体目标与Task13保持进行中。

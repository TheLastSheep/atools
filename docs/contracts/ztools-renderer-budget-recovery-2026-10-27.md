# R28：主程序资源回收与原双视图输入验收

R27 是实际进展，整体目标仍 active。其 Native203/前端207、严格检查和 Setting 正式构建通过；Main594310 >589824 B，未发布，原双向界面未验。本轮继续原 ZTools UI/Tauri 目标，不用更窄演示替代原界面。

开发工作区 `/Users/harris/Desktop/atools`，分支 `codex/atools-ztools-parity`，HEAD `c34789c0e3d19b3bf7c05d396540d891ff126abc`。上游只读 ZTools 固定 `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。保留所有已有改动，不 staging/commit/push。Root 定接口、派 Luna 实施、审查与独立验收；Worker 不派生。

## 有证据的下一步

三路只读分析确认现有 pinyin ESM、Vue runtime、Fuse basic 与 draggable source 入口合理，没有足以弥补4486 B的安全重复消除。现有字典、多音词与高亮行为保留；不关闭未验证 WebKit 的 modulepreload，也不删除校验/诊断或改资源门槛。

Root 使用固定 Product Node、`--ignore-scripts` 在临时目录安装 Terser5.51.2，对冻结的 R26三个JS做安全 post-minify：587945→581537 B，减少6408 B。只是旧产物候选测量，尚未证明当前构建或运行正确。完整旧dist冻结在 `output/renderer-budget-recovery-2026-10-27/baseline-main-dist`，失败预算日志保持原样。

采用仅构建期 devDependency，精确版本与 package-lock 保留在 Main package；不加入应用运行时、Node侧车、网络启动路径或新永久订阅。原 Main JS 总量≤589824、相对587945基线增量≤1879保持不变；Setting已通过的777963 B产物不作无关改写。

## 模块与验收

独立 post-minifier 模块隐藏加载、版本/完整依赖树和lock身份、语义安全策略与源漂移验证。builder只接入 Rollup post renderChunk hook、发布前校验及provenance。文件≤500行，不将职责继续堆入461行builder。源码/依赖/扫描/原子发布及两个原budget检查保留。

策略：ESM，ecma2020，passes2，pure_getters=false，unsafe=false，属性混淆关闭，保留legal comments；不得新增 drop_console、pure_funcs、unsafe_* 或运行期解码。每次创建fresh options，防工具修改配置对象。错误拒绝构建，不回退或伪造通过。

先以真实工具运行语义fixture，覆盖 getter、pure调用参数副作用、异常、async/callback、公开键/全局hook和导出身份；版本/lock/实际transitive文件漂移要拒绝。临时副本用于漂移测试，不改真实install或共享源码。Root审关键diff并独立跑测试，再正式构建；只有实际发布的新Main来源与当前TS完全绑定、原预算通过，才运行已准备的原Main＋原Setting双页面浏览器。

原 DOM 验收保留 Cmd+,、Main原输入→Setting目录过滤、Child程序设值→Main、IME最终值、Ctrl/Cmd+F选择、原sidebar切页、迟到代次、关闭/重开与alias冲突保留草稿。先inspect观察DOM，按实际文案/路由/过渡进行。Headless Chrome仅为自有隔离fixture，不能替代SQLite、Tauri/Wry、OS焦点/真实键盘或可见UI。Root独占正式构建与实际浏览器/Native运行；不操作用户浏览器或系统输入源。

本轮不是完整目标：原生可见UI、默认入口切换、完整设置写入/迁移、Harris原包插件、跨平台、整应用性能与可选同步仍要各自证据。

## 实测退出竞态增量

当前Main已实测587776 B通过原门槛，原Main回归15检查/6截图、Native203与workspace编译通过。原双页流程已实际验证输入/清空、Child反向设值/选择、原菜单alias跳Shortcuts、sidebar回切、旧gen、IME和Cmd+F。完整Cmd+F流程的真实trusted pagehide witness捕获底层pending=1；旧run也记录关闭后的rejected输入控制。不是缺失witness就放宽清理门槛。

冻结本地输入stop语义：会话终止时无论visible与否都阻止后续输入准入，清本地callback/可见态、settle排队和在途控制false并忽略晚回执/回声；不再发Native remove，因为Native close负责隐藏和释放。stop不提前恢复hook，dispose保持幂等恢复；外层close/outAcknowledged可继续。正常route remove仍允许。已派发SDK工作不宣称已取消。

独立审查补齐 Escape 入口：所有 close intent 在等待 Native close 前终止输入；outPlugin/外部 deliverOut 必须先 stop 再 callback。关闭失败沿用原错误并允许重试 close，不恢复旧队列或输入 owner；只有新会话恢复输入。组合输入中或已被页面消费的 Escape 不触发终止。浏览器验收在输入 owner 仍可见时直接退出，不手工 remove；以退出前后输入 RPC 数量相等及 trusted pagehide pending=0 验证。

该增量只改Child输入生命周期及其测试。Root重建Setting并重新核对原8192 B增量及786432 B总上限、来源和原双页全流程；不能复用旧Setting产物。修改前源码与provenance保存在本轮output。Native实际UI仍由19票单独证明。

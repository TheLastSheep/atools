# B56–B57 PNG 路径与搜索重试：阶段交付记录

> 本批有界交付记录。root acceptance 接受代码检查与限定的真实 Node consumer 验证；完整 B57 浏览器旅程仍未验收。

B56 让已授权的 legacy Node 插件通过 `nativeImage.createFromPath()` 读取本地 PNG。读取复用现有 legacy Node / FileRead 授权，不增加新的文件授权入口。实现限制绝对路径和 8192 字节路径长度、PNG 最大 512 KiB；Unix 文件以只读、非阻塞、禁止跟随最终符号链接的标志打开；打开前后核验常规文件、设备/inode、大小与高精度时间戳；读取最多分配文件大小加一字节并在 `finally` 关闭句柄。适配器在每次调用时读取当前 Node session，避免初始化顺序早于 Node bridge 时保留空 reader；返回内容复制到拥有的 BrowserBuffer 快照。JS/CJS 只验证 PNG 签名与 IHDR 头部；完整像素解码发生在 Rust 的显式 `image_write` 路径。

B57 在主搜索处于错误或部分失败、结果为零且当前上下文允许时，给用户提供显式同查询重试。Enter 只重发当前主搜索原词；请求 pending 时后续 Enter 不增加请求。正常空结果不显示错误态重试提示；有搜索结果时仍使用原有选择与 Enter 打开行为。文本、媒体、插件、菜单、对话框、IME、组合键等非适用上下文不触发重试。实现复用现有查询 generation、debounce 与 deadline；不引入自动重试、缓存或 idle 轮询。

证据分层需保持清楚：TypeScript 单元/App 测试使用受控 IPC；原函数消费者夹具使用生产序列化模块和 FakeXHR。B56 后续真实 Node consumer v4 通过 8/8，覆盖两个原插件函数体、生产序列化 builder、真实 Node sidecar child 与 FakeXHR ACK；它不等同真实 Rust host 授权或原生剪贴板。B57 的 5 个 App 定向用例通过；浏览器 v4 有 3 项早期检查通过，但尚未完成插件打开与 Escape 返回旅程。后续 browser v5 及两个微型控制页均在 `Page.navigate` 超时，HTTP 控制服务记录 0 个请求；确切原因未确认。已停止进一步取证，不能据此判断为产品或环境根因。

## 已验证的代码检查

Root 汇总记录为 `completed-code-checks-v1.json`，对应最终 `source-freeze-v2.json`（1605 个选定源，非完整编译闭包；25 个 owned 候选中 16 个修改、7 个新增、2 个未改 owned 候选；选定源漂移 0）。本轮 `App.svelte` 从 2,922 行增至 2,942 行，增加的 20 行仅为薄接线；大部分既有超长文件债务保留，新增业务逻辑放在独立 helper。其他新增或修改文件均不超过 500 行。代码级结果如下：

- 前端定向：7 文件、83 项通过；前端全量：198 文件、1854 项通过；`svelte-check` 0 错误、0 警告。
- Rust：core/plugin/API shim 合计 58 suites、416 项通过、2 项显式忽略；legacy runtime 53 项通过；合计唯一通过 469 项。PNG path 新定向项 1 项且也在 crate 全量范围。workspace check 退出码 0，保留 4 条既有 warning；`nom 1.2.4` future notice 是另外一条通知，不计入这 4 条。两项 ignored 保持未接受状态，其中 `heterogeneous_regex_selectivity_stays_under_25ms` 是未运行的 regex 预算用例，不能按通过或 25ms 验收计。另有 `matcher_performance_tests` 的 2 项通过、20 个样本，只支持该 benchmark 自身覆盖的场景。
- B55→B56/B57 initial JS 为 367,118 bytes，相对 B55 增加 1,031 bytes，预算 573,440 bytes。被单独追踪的 lazy panel 产物 246,614 bytes，报告明确它不是整个 bundle graph。构建 scratch 已清理，源 hash 稳定。
- Matcher：1200 features、20 个样本，最大 794,709 ns（约 0.795ms），预算 25,000,000 ns；这是独立 matcher 测量，不能解释成输入到 UI 的总延迟。
- 原始图片写入函数的 minified consumer regression：19 个场景通过；范围是当前 serialized builders + Node VM/FakeXHR，原 B55 写入函数未改，不代表系统剪贴板或真实 Node child 已写入文件。

## B56 真实 Node consumer 隔离运行

Root 报告 `real-node-consumers-v4/report.json`（23,691 bytes，SHA-256 `fb8c9e89227db4e181624bdd709354b56e5103256ad89ba33f826a98f6679dc5`）为 `passed`，8/8 cases 通过。它逐字节绑定两个原插件方法体：IdeaDock `copyEntryImage(file)`（SHA-256 `c032f678eaff50984fa60061d64144e40d44fffed6f18606e64fab3d03b905f7`）与 DeviceLink `async copyMessage(messageId)`（SHA-256 `d8aa03db53052c5f6234e2f46cf9fec6dba4ca9d80fc5163ec02a734eabc254f`）。运行时构建并执行生产 serialized builders，图片读取由 Node 24.15.0 的真实 child process 加载生产 `codec.cjs`、`bounded_png_path.cjs`、`bootstrap.cjs`；同步 Node bridge 由测试 worker thread/SharedArrayBuffer 承接。Host 的 `image`/`image_write` 请求和 ACK 是 FakeXHR 受控端点，不是 Rust host；root acceptance 接受的也仅是这个限定范围，不包含 Rust host/TaskRun 或系统剪贴板验收。

图片路径用原始计算纸 PNG（5031 bytes，200×200，完整 CRC 与 RGBA 解码摘要已校验）及同像素 524,288-byte CRC-checked padding PNG。每项路径/consumer 延迟均为 6 个样本（首个 + 5 个 warm）：小图 Node 读取 p95 0.987ms / 25ms 目标；小图 DeviceLink 原函数读图至 FakeXHR ACK p95 1.486ms / 100ms 目标；512KiB 路径读取 p95 3.987ms / 250ms 目标；近上限 DeviceLink 原函数至 FakeXHR ACK p95 64.498ms / 250ms 目标。计时排除了 Vite build、child initialize、fixture PNG 生成和磁盘准备，属于 Node/FakeXHR 隔离测量，不是 UI、Rust transport、原生剪贴板或插件启动延迟。

8/8 case 覆盖缺少 Node FileRead session、旧 text-write grant 不得写图且授权后不重放、两原函数的图片路径、缺失/超限/非 PNG 拒绝和关闭 session。报告确认 child close/worker exit 均为 0、未发信号、pending fetch 为 0、临时 environment 与 scratch 删除、source 与 freeze pins 前后稳定。该结果仍不覆盖 Rust host 授权/TaskRun、OS clipboard、完整 preload/插件启动、打包 Node 或任意插件业务；不能与 B57 浏览器旅程合并声称已完成。

历史红项保留并分层说明：定向 v1 的 1 个失败来自旧的 unsupported 文案断言，迁移后最终定向通过；legacy sandbox v1 的 13 个失败为 loopback mock bind `EPERM`，后续 v2 本地 loopback 的 53 项通过；browser v1/v2 是 fixture ESM 加载失败、0 个 Chrome 检查，v3 是初始空查询前置条件 fixture 错误、0 个检查，v4 有 3 项实际浏览器检查通过但未完成返回旅程。后续 v5 和两个控制页在 `Page.navigate` 超时，控制 HTTP 服务收到 0 个请求，未能确定确切原因。Chrome 清理有独立核验；已停止进一步取证。B56 私有候选 v4 的 2 个文件缺少精确的编辑前副本；保留已有 pins 与失败报告，不重建或声称完整可复现。上述记录不构成 B57 用户旅程验收。

**交付状态：有界代码与真实 Node consumer 已接受；B57 完整浏览器旅程待验收。** root acceptance 状态为 `code_and_bounded_real_node_accepted_full_browser_journey_pending`。App 定向测试中 5 个 B57 用例通过，browser v4 的 3 项早期检查通过；真实 App/Chrome 搜索错误→Enter 重试→结果恢复→打开插件→Escape 返回流程仍未完成。未证明完整原插件工作流、跨平台运行、插件多数可直接使用、竞品 parity、release 或 formal acceptance；goal 仍 active，未做 Git mutation。

历史记录需如实保留：B56 初始化顺序的早期阻断已在候选中修正；B55 中旧的 `createFromPath` unsupported 文案测试断言是测试迁移问题，不是新生产故障。作者早期调试中 Vitest 全局 `Buffer` 污染夹具的问题应注明为 fixture 修正，不归类为生产失败。

## 交付索引

交付证据见 [delivery JSON](../../../output/plugin-input-2026-10-19/batch56-57-delivery-v1.json)、[evidence manifest](../../../output/plugin-input-2026-10-19/batch56-57-evidence-manifest-v1.json) 与 [`batch56-57-evidence-v1`](../../../output/plugin-input-2026-10-19/batch56-57-evidence-v1/)。归档按 root acceptance 的 87 个 `evidencePins`、四份 B56/B57 source index 和 before/after 精确源快照生成；每项记录原始绝对路径、归档相对路径、字节数与 SHA-256。manifest 不自包含。选定的 1605 个源不是完整编译闭包；归档不含 `dist`、`target` 或 `node_modules` 整目录，但包含固定验收 IIFE、报告等已 pin 的证据文件。

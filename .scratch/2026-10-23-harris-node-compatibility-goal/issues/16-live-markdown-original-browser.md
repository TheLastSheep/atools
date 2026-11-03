# 16: Live Markdown 原版编辑器文件流程

Status: in-progress。按用户“先跳过这个继续”，原生 App、GUI、AppleScript、系统选择器继续暂缓；不将跳过记为通过。

## 实跑后调整（2026-10-24）

`files` 入口已两次在首次源码切换时复现卡住，记录保留在 `output/playwright/live-markdown-original/attempt-05-main-tests.*` 与 `attempt-06-main-tests.*`。后一次 3,125 次 native-text 请求全部读取同一 `documents/input.md`，同时反复调用 `statSync` / `readFileSync`，无原 UI JavaScript 错误或未知网络请求。CPU profile 停止也超时，不能称为成功采样；所有 Node、端口、数据库和 Chrome 均确认收尾。

原包源码和已发布 JS 均包含不稳定入口回调；React effect 因回调变化重新订阅时，原 preload 会同步重放 `lastEnterAction`，再打开文件并更新状态。这条回路与同一路径重复读取吻合；尚无同版本 ZTools 实跑对照，不能归因为 Tauri 或 Node 本身变慢。保留原包和失败入口，不在宿主层偷偷抑制原插件订阅。

增加显式 `ATOOLS_LIVE_MARKDOWN_BROWSER_ROUTE=menu-open` 路线：原 `typora-workbench` 文本入口不带文件，再用原菜单“打开文件”经生产 dialog bridge 选择固定临时路径，接续原全部正文、切视图、保存、冲突、另存与重开断言。文件入口保持默认且其失败不被菜单路线结果覆盖。打开与另存的选择结果是受控端口，不是系统选择器或权限验收。

菜单路线最终实跑通过1项，相关既有回归27项通过；两个 Node、Chrome、监听、DB、临时目录均确认回收，原包40文件 SHA 不变。主 Agent 目视冲突提示与重开截图；重开后的“未保存”状态还待解释。原生/文件入口/整体兼容继续未完成。结果与原始失败见 `output/playwright/live-markdown-original/verification.md`。本轮未修改生产兼容层，冻结的1,254个生产源码文件未变，10个测试代码文件最多407行；没有新的整应用性能测量。

## 固定范围

- Harris Live Markdown 0.1.0，`plugin.json` → `dist/index.html`，完整 `preload/services.cjs` 相对模块图及实际加载资源保持原字节。作者目录只读。
- 真实隔离 Chrome 执行原版 React 编辑器；通过生产 preload loader、编译桥和 `typora-workbench` files action 打开固定临时 Markdown。
- 产品 Node 22.23.3 按需启动，一次最多一个本票 Node，关闭并确认退出后才重开；复用生产 codec/bootstrap，私有 HOME、文件权限及拒绝 OS 命令/外网的夹具策略。
- 文件端口的 `readTextPath` / `writeTextPath` 明确返回 `handled:false`，本票覆盖真实 Node fallback；不冒充 Rust 文件能力。临时 SQLite 和固定 Save As 返回值是受控宿主端口，不冒充真实权限、TaskRun、系统选择器。
- 不修改原插件，不安装引擎，不提交或推送，不替换已安装 App；没有可复现生产缺陷时不凭静态扫描增加兼容分支。

## 通过条件

1. 打开固定文件，原 UI 切换源码和实时预览，DOM 焦点与键入产生指定正文。自动保存应通过原 UI 关闭，或明确作为固定初始偏好，不让自动保存抢先完成保存操作。
2. 原保存按钮写入精确字节；关闭文档和旧 Node 后，以新 owner/session/端点/Node 重开，正文一致。
3. 编辑本地正文后外部修改文件，保存出现可见冲突反馈，保留编辑内容且不覆盖外部字节。
4. 原 File → 另存为，经生产同步 dialog bridge 返回另一固定临时路径，保存编辑内容，原文件不变，恢复后可以继续编辑保存。
5. 保留实际失败与源码哈希、网络诊断、精确进程退出/监听关闭证据。只在上述条件全部实际执行后记录本票浏览器路线通过；Tauri/WKWebView/Rust/真实 OS/整应用资源验收仍未完成。

## 归属

- `node_close_finish`：本票 Node session、隔离策略、HTTP 宿主端口。
- `paste_startup_coverage`：本票原包副本、浏览器文档与原 UI 操作；现有 Chrome helper 仅增加 origin 参数并修正进程类型。
- 主 Agent：接口与范围、关键 diff 审查、独立执行和记录；独立 reviewer 只读核查业务断言和清理边界。

## 验证

使用仓库产品 Node 直接运行 Vitest；浏览器测试仅在 `ATOOLS_LIVE_MARKDOWN_BROWSER_ACCEPTANCE=1` 显式开启，普通测试不启动浏览器。证据写入 `output/playwright/live-markdown-original/`。先执行本票，再执行因共享 Chrome helper 改动而确有必要的回归；不重复无关 Rust 或全库检查。

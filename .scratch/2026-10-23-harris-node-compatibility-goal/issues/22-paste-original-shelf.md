# 22：Harris Paste 原版历史面板交互

状态：本票共用消息适配及原版历史面板切片通过，完整 UI/原生业务仍未完成。继续保持 WebView + Rust + 按需 Node；原生 App、系统剪贴板、AppleScript、原生子窗口暂缓。

## 本票范围

启动器返回链只读检查未发现新缺陷，主 Agent 当前运行 4 个相关文件 / 29 项回归通过，因此不为这条链额外造生产修改。本票转向 Harris Paste 1.3.1 的原版 Shelf 历史页面。

原 App 仅在 `?shelf=1` 渲染 Shelf；明确的独立“预览”操作经 `openPanel` 创建子窗口。因此本票直接加载原 Shelf 页面，在私有 Chrome 中验证：查询固定历史正文、键盘选卡、核对卡片摘要、空结果与清除查询后恢复。卡片摘要不等同于独立 Preview 窗口，也不等同于完整 ATools 原生打开流程。

## 验收合同

- 保持实际加载的 10 个原包文件 SHA 不变；不改原包，不安装依赖。
- 产品 Node 22.23.3、生产 preload/数据桥、临时 SQLite 原记录；查询不能由夹具假数据响应替代。宿主系统历史端口仍为空，明确说明来源。
- 原 Shelf 使用 HistoryRpcClient 向 primary 请求。两页属于同一插件的受控临时数据域，但各自使用独立 Node、owner/session 和端点；夹具只把精确的 history-query 请求交给原 primary `window.pasteboardPro.searchHistoryPage`，把其原始结果按 history-result 回送。不实现筛选或分页，不把该 relay 当作 Rust IPC、原 ipcRenderer handler 或 ShelfWindowManager 验收。
- 实际 CDP 输入和键盘行为；选中态、焦点、可见文本与空结果必须来自原 DOM。
- 无系统剪贴板读写、外部网络、原生窗口操作；受控 monitor/permission 端口不计作真实系统业务。
- 保存原报告与截图；失败不得降级期望后计通过；精确记录 Node/Chrome 退出、Worker/数据库关闭、临时目录回收。
- 生产代码若未变，只做相关定向回归与本票夹具检查，不重复 Cargo 全库编译。

## 归属

- Luna：独占 Shelf 页面资源路由与控制器。
- Luna：独占浏览器 test 与操作场景。
- 主 Agent：调用边界、关键 diff、真正运行浏览器、目视验收、进程/原包/源码指纹检查。
- 另一 Luna 在实现后只读审查；实现者不代替主验收。

证据目录：`output/harris-paste-history-2026-10-25/`、`output/playwright/paste-original-shelf/`。不引入生产进程、依赖、通信策略或 UI 改写。

## 实际失败保留

首次默认环境启动未到 UI；独立端口探针确认当前默认环境绑定127.0.0.1返回EPERM，原聚合异常当时缺少内因记录，不能伪称已经从原报告读到EPERM。后续临时本地权限内重跑。首次宿主退出、无该私有根的Node/Chrome匹配后清理遗留副本，原 cleanup ACK 未确认状态保留。

第二次在父文档CSP sandbox生效后才window.open，夹具创建顺序错误。已改为blank阶段先创建目标，不放宽CSP。

之后两次原Shelf可见但没有卡片，history relay为0。原primary启动镜像正常需要受控空host/history端口，已纠正夹具对其误拦；Shelf查询仍不得直接使用这个空端口。最新被动诊断确认原API/relay端口均存在、页面可见持焦点且无JS异常。调用链同时发现首版夹具跨文档共享单个Node：各renderer callback编号独立递增、poll消费同一事件队列，不符合现有文档隔离边界。先将夹具改为独立会话再重验；当前不将停滞判为产品或原包缺陷。

本票严格TS检查整体仍红：17条共享旧fixture诊断，在仅编译旧helper时完全相同；新增4项类型/未用变量问题已修。不可将新增helper的定向TS绿报作整个driver严格检查通过。

## 最终交付

主 Agent 最终定位并派 Luna 修复第一方消息 binder：原 `postMessage(message,'*')` 被错误地把 `'*'` 传给结构化 transport 的 transfer 参数。显式 postLegacy 保留宿主origin与第三参数transfer，发送失败会拒绝Promise，结构化post语义不变。真正生产改动只有两个共用transport文件，不改原包。

原版Shelf最终浏览器四次查询2/1/0/2、ArrowDown焦点/完整卡片摘要、空态与清空恢复通过；原编辑器失败/重试/持久化回归通过，同文档通知实测1次但跨窗口仍未测。主独立26文件214项回归、应用类型0错0警告、生产构建和449118字节首屏预算通过。严格fixture类型仍17条继承错误，生产与原生边界不混算。10个本票代码文件最多495行，原包10文件及上票20冻结文件指纹未改，Node/Chrome/临时环境收尾确认。

完整原始报告、截图、失败归因和限制见[主验收记录](../../../output/harris-paste-history-2026-10-25/verification.md)。

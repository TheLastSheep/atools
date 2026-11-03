# R41：原设置应用别名的真实 Native 链路

仓库/工作区 `/Users/harris/Desktop/atools`，开发分支 `codex/atools-ztools-parity`，上游只读固定 `9b15fb1a2a9f3ec886016632761c7bb21e39557a`。延续R26别名模型与R40刷新修复，主程序优先、插件后置；不更换SQLite、运行时或默认入口。

## 用户路径与事实来源

复用原settings-input私有应用、数据库与已有只读系统应用目录目标，所有修改只在本次私有数据库，不启动或改动目标应用。原AllCommands菜单→自定义别名→原Shortcuts别名页及编辑控件：

1. 原DOM新增固定别名A并保存；用同一文件的独立DB连接确认提交；原outPlugin关闭设置，在真实Main输入A，唯一结果必须对应该应用。
2. 清空Main查询，重新打开原设置，以原别名行编辑为B并保存；独立DB连接确认，再原out关闭，Main查A为0、查B为1。
3. 清空查询并重开fresh Child，从原别名页读回B；使用原删除及确认控件删除，独立DB连接确认；关闭设置后Main查B为0，最后清空查询以保留原cleanup门禁。

只允许标准DOM setter/InputEvent和原控件click，不直接调用alias mutation来替代UI步骤，不改Vue/CSS、注入假DOM或取消transition来通过。实际DOM结果必须和Pinia的direct/app、alias name、originalName及路径身份一致；不能在SubInput仍接管时用store getter代替返回主搜索。

Node与Native报告分开验证：Native记录原始观察，Node绑定同一run/root/identifier/真实进程PID，并从facts独立计算通过。未知保留null，不能折叠为0或false。监听/写入后事件允许有界只读等待，写入不因回执不确定而自动重试。无关General/history/pins和已有legacy/unknown别名数据应保持。

## 报告与探针契约

固定sidecar `native-command-aliases-report.json`。顶层精确字段为schemaVersion=1、journey=settings-command-aliases、scope=hidden-original-vue-command-aliases、identifier、root、pid、runId、observations、errors；不提供Native passed位。

observations包含20个nullable bool：initialStateValid、addMenuDispatched、addDialogOpened、addSaveDispatched、addStored、addMainMatched、editSaveDispatched、editStored、editMainUpdated、closedAfterEdit、freshSessionOnReopen、reopenReadBack、deleteDialogOpened、deleteConfirmed、deleteStored、deleteMainExcluded、unrelatedPreserved、noAppCatalogReload、pluginUiOpened、preloadStarted。后两项必须false，其余true。

10个nullable 0..4096整数：aliasEventsBefore、aliasEventsAfterAdd、aliasEventsAfterEdit、aliasEventsAfterDelete、appListReadsBefore、appListReadsAfter、addMatchCount、editOldMatchCount、editNewMatchCount、deleteMatchCount。事件逐次+1；list_launcher_apps调用数前后相同；搜索计数依次1/0/1/0。所有值非null且errors为空才通过。

探针仍经既有token/operation/probeId/caller身份链：Child方法commandAliasesOpenAdd/AddSave/EditSave/ReadBack/Delete，Main方法commandAliasesSearch/Inspect。Main search显式expectedCount只用于有界等待，返回实际DOM resultCount、storeTargetCount与matchedTarget；store不可用为null，不可假装verified zero。Main inspect返回nullable eventSourceListening、aliasEvents、appListReads，只有真正listening与已知计数才采用。

固定errors为settings-command-aliases-前缀加baseline-invalid、open-failed、add-failed、edit-failed、reopen-failed、delete-failed、main-search-invalid、state-invalid、unrelated-changed、counter-invalid、report-write-failed。Native失败仍写partial报告并使总run失败。

首次实际运行保留为失败记录（run `c2afee6b29b947e2bcd1b1847edcd0e0`）：旧12阶段通过，新增open-add未收到回包，保存未执行，退出清理完成。修正探针串行等待预算：open-add各阶段共享9秒截止时间，Native仍保持12秒；异常/到期尽力回报原布尔证据。open-add失败后只经同一session/probe协议读取一次`childAliasOpenAddDiagnostic`，用owner writer写独立`native-command-aliases-open-add-diagnostic.json`。该报告仅含固定phase/sendState/route枚举、4项nullable饱和计数和4项布尔，不含应用名、路径、DOM或异常原文；诊断失败保留null及固定错误。诊断不改变原操作结果，不参与通过判定，也不重试写入。Root隔离VM检查仅证明总截止时间与异常回包，真实Native结果另记。

第二次实际运行`0ddc6ed489ad4703b114e31b965aef28`仍失败并已清理：旧12阶段通过，但诊断自身也被拒绝。Root进一步追踪`state.rs::validate_caller`，确认其另一套fragment白名单没有允许原`jumpFunctionShortcutsSetting`生成的`/shortcuts?_t=...`。修复为委托生产`is_expected_settings_url`，只在smoke特性下重导出该函数；不增加生产权限、不仅凭截断query放行。定向回归覆盖合法时间戳和错误会话、来源、路径、顶层query、附加参数、编码路由、零值、前导零拒绝。此前仅检查`native::child_matches`不完整，等待预算修复与本处回报校验修复分别记录，不将前者误报为已查明的实际根因。

## 复用、预算与验收

在原12阶段/17应用/10指令禁用/inventory切片后、finalCleanup前增加独立alias段；旧门禁全部保留。journey.rs原500行，先把独立updater状态收集提取为语义模块，再增加orchestration，不将alias职责追加到search pins模块。不新增QA CLI分支、controller、Node进程或产品依赖。

Main资源593891B、上限593920B（余29B），Settings782503B保持。新脚本仅Native QA include_str注入，不进入正式前端bundle。Native源改变后Root重新构建并绑定receipt，先相关Core/Native/Node检查，再实际Native与R39回归；实现者自测不替代Main独立验收。

本证据限真实Tauri中的DOM事件、Rust桥、私有SQLite和原Main消费；不是物理键鼠、输入法、可见画面、全部设置或Harris原包验收。并发冲突/越限/角色拒绝沿现有Core/Native定向回归核对，不将成功路径外推为所有I/O故障已验。

## 结果

第三次运行`c58dc9af732a415ba2d104e92dce6e46`的有效诊断定位到输入框范围：原别名文本框和嵌套目标搜索框被一并计数。探针改为限定原`.alias-dialog-main`内固定placeholder，仍要求唯一，不改原版页面。

最终运行`1abb931d39ef466fbd9affd779bf8558`通过：原12阶段与全部旧门禁通过，别名搜索1/0/1/0、通知0→1→2→3、应用列表读取1→1、fresh Child读回、数据保留、正常exit0和owned cleanup全部确认。同一最终构建的R39两进程持久状态回归`25a29dc0c9eb43acb340c8cf288c0843`亦通过。Main/Settings资源哈希未变。完整证据见[本次验收记录](/Users/harris/Desktop/atools/output/renderer-command-aliases-native-2026-10-29/verification.md)；可见UI与整体目标仍未完成。

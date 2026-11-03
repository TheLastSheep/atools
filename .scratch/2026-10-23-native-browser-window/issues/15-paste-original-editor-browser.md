# 15: Paste原版编辑页的隔离浏览器业务验收

**Status:** in progress; original UI recovery and fresh-session readback verified in isolated browser, visible-error criterion failed

上位目标与Task13/14的原生待验项保持不变。本项补原版Vue编译UI的真实输入与持久保存证据，不把原preload模块测试或fixture通过升级为Tauri原生可用。

固定包：Harris Paste1.3.1，`dist/ztools/index.html`及其原CSS/JS，与Task14原preload。具体协议见`../paste-editor-browser-protocol.md`。

先执行原版`?panel=editor&mode=create`独立页面，输入固定标题/正文，保存，核对真实临时SQLite文档；注入一次明确的fixture写入拒绝时应保留输入并允许显式重试。关闭并重开页面后用原bridge读回持久记录。此入口不要求启动原生Shelf；主子窗口检索/预览以及真实系统复制仍待后续。

Playwright CLI与ui-skills CLI在本次离线检查中未安装/缓存，不安装依赖。复用仓库现有headless Chrome/CDP工具，独立临时profile，不操作用户浏览器、桌面或已安装App。

不得改原包、伪造窗口角色使Shelf运行成primary、替换原业务方法、启动全局输入或真实clipboard。结构化权限/父窗口通知可以作为严格受控fixture端口，但必须记录精确契约和边界；未知调用拒绝。没有复现生产故障前不修改生产兼容层。

## 主审发现与浏览器实证

原 `apps/ztools/src/App.vue` 的 `saveEditor` catch（约360行）只写 `status.value`；约1217行的状态节点由 `v-if="isShelfMode"` 限定。独立`panel=editor`传给`TextEditor.vue`的props没有错误信息，组件没有错误节点。原编译UI截图与DOM已确认此处不显示保存失败；保留该项未通过。不改原包、不删失败断言、不冒充ATools宿主接口缺陷，保留输入和显式重试已取得独立运行证据。

## 主Agent最终实测

原编译页面已实证上述缺陷：保存被明确拒绝后，输入保留、保存恢复可用，但没有可见错误。显式重试真实写入一条SQLite记录，原doc关闭；先确认旧Node结束，再创建新owner/session/endpoint/Node，以同一DB重开并通过原`getHistoryItem`读回相同标题正文。原包未改、资源退出确认。最终回归3通过/1失败/0跳过；失败保留在可见错误条件。9个测试/夹具文件≤455行，生产输入416文件未变。详见`output/playwright/paste-original-editor/verification.md`。本项与总目标仍未完成，不把浏览器fixture升级为Tauri/App验收。

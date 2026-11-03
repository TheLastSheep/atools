# 05: 原生 child self facade 的来源标记

**What to build:** 父页 createBrowserWindow 返回的 facade 已带 hostKind=native，并明确拒绝无原生实现的媒体源/进程 ID getter。原生 child bootstrap 内部构建 self facade 时仍只带 id/clientCreateId/geometrySnapshot，尚未传递 native 标记。下一批应明确传递该来源信息并补实际序列化 bridge 测试，保持 hosted preview 行为。

**Blocked by:** None.

**Status:** code-contract-complete (原生桌面验收仍暂缓)

来源：pluginPanelBridgeCompiler.ts 注入上下文；pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts 的 child bootstrap；browser-window-state-and-events.ts 的 hostKind 判定。Harris Snipaste 2.0.1 当前主路径不调用这些 ID getter，本轮不得由父 facade 的2项测试宣称 child self 同样完成。不要伪造真实 OS ID。

本批已通过独立 windowHostKind 注入与真实序列化 bridge/VM 回归补齐 child self；main/preview/hosted 默认不变。self facade 仍是桥接闭包私有对象，此项是内部来源边界修复，不能计作新增公开业务 API。见 [主 Agent 验收记录](../../../output/harris-plugin-first-2026-10-23/native-window-self-provenance/verification.md)。

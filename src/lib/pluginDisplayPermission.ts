import type { PendingAgentToolRequest } from "./types";
import type { PermissionRequestContext } from "./permissionPresentation";

/** A backend-validated identity and the exact metadata scope select this wording. */
export function pluginDisplayPermissionPresentation(request: PendingAgentToolRequest, context: PermissionRequestContext | null) {
  if (context?.kind !== "plugin_display" || request.scopes.length !== 1 || request.scopes[0] !== "display_read") return null;
  return {
    title: `${context.pluginName || "此插件"} 请求读取显示器信息`,
    riskHints: ["此插件可以获取显示器布局、缩放比例和当前鼠标位置。", "此权限不读取屏幕内容、不移动鼠标，也不监听键盘。鼠标位置不会保存在历史记录中。"],
    retryHint: "首次允许后插件会继续打开；如果已在插件内操作，请重新打开插件后再试。",
  };
}

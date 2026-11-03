import type { PendingAgentToolRequest } from "./types";

export type PermissionRequestContext = {
  pluginName: string | null;
  kind: "tool" | "legacy_node" | "host_clipboard" | "plugin_data" | "plugin_paths_standard" | "plugin_paths_data" | "plugin_dialog_open" | "plugin_dialog_save" | "plugin_main_push" | "plugin_display" | "plugin_secret_storage" | "plugin_file_drop" | "plugin_ai" | "plugin_browser_window" | "plugin_background";
  clipboardAccess: "read" | "write" | "image" | "image_write" | "content_write" | "paste" | "history_read" | "history_delete" | null;
};

export function permissionRequestContext(value: unknown): PermissionRequestContext {
  const input=value && typeof value==="object"?value as Record<string,unknown>:{};
  return {
    pluginName:typeof input.pluginName==="string"?input.pluginName.trim() || null:null,
    kind:input.kind==="legacy_node" || input.kind==="host_clipboard" || input.kind==="plugin_data" || input.kind==="plugin_paths_standard" || input.kind==="plugin_paths_data" || input.kind==="plugin_dialog_open" || input.kind==="plugin_dialog_save" || input.kind==="plugin_main_push" || input.kind==="plugin_display" || input.kind==="plugin_secret_storage" || input.kind==="plugin_file_drop" || input.kind==="plugin_ai" || input.kind==="plugin_browser_window" || input.kind==="plugin_background"?input.kind:"tool",
    clipboardAccess:input.clipboardAccess==="read" || input.clipboardAccess==="write" || input.clipboardAccess==="image" || input.clipboardAccess==="image_write"
      || input.clipboardAccess==="content_write" || input.clipboardAccess==="paste"
      || input.clipboardAccess==="history_read" || input.clipboardAccess==="history_delete"?input.clipboardAccess:null,
  };
}

/** Only the backend-validated plugin AI capability and its sole Network scope select this prompt. */
export function pluginAiPermissionPresentation(request: PendingAgentToolRequest, context: PermissionRequestContext | null) {
  if (context?.kind !== "plugin_ai" || request.scopes.length !== 1 || request.scopes[0] !== "network"
    || !/^atools\.plugin\.ai\.[0-9a-f]{24}$/.test(request.tool_name)) return null;
  return {
    title: `${context.pluginName || "此插件"} 请求使用已配置的 AI`,
    riskHints: ["本次对话内容和图片会发送到你已配置的 AI 服务。", "ATools 的执行历史不包含 API 密钥或提示词正文；服务会按其自身规则处理数据。"],
    retryHint: "允许后会继续本次请求；拒绝后，插件需要由你重新发起请求。",
  };
}

/** Only the backend-validated BrowserWindow capability and its exact input select this prompt. */
export function pluginBrowserWindowPermissionPresentation(request: PendingAgentToolRequest, context: PermissionRequestContext | null) {
  const args = request.arguments;
  if (context?.kind !== "plugin_browser_window"
    || request.scopes.length !== 1
    || request.scopes[0] !== "plugin_window"
    || !/^atools\.host\.browser-window\.[0-9a-f]{24}$/.test(request.tool_name)
    || !args || typeof args !== "object" || Array.isArray(args)) return null;

  const input = args as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  if (keys.length !== 2 || keys[0] !== "intentId" || keys[1] !== "operation"
    || (input.operation !== "open" && input.operation !== "action")
    || typeof input.intentId !== "string" || !/^[0-9a-f]{64}$/.test(input.intentId)) return null;

  return {
    title: `${context.pluginName || "此插件"} 申请创建/管理独立窗口`,
    scopeLabel: "仅管理此插件自己的独立窗口",
    riskHints: [
      "此插件可以创建、显示、调整和关闭它自己的独立窗口。",
      "这不允许管理其他插件、系统或其他应用的窗口，也不会授予文件、网络或其他系统权限。",
    ],
    retryHint: "允许后会继续本次插件窗口请求；拒绝后，请在插件中重新发起操作。",
  };
}

/** Only the backend-validated persistent runtime capability selects this consent copy. */
export function pluginBackgroundPermissionPresentation(request: PendingAgentToolRequest, context: PermissionRequestContext | null) {
  const args = request.arguments;
  if (context?.kind !== "plugin_background"
    || request.scopes.length !== 1
    || request.scopes[0] !== "plugin_background"
    || !/^atools\.host\.plugin-background\.[0-9a-f]{24}\.start$/.test(request.tool_name)
    || !args || typeof args !== "object" || Array.isArray(args)) return null;

  const input = args as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  if (keys.length !== 5
    || keys[0] !== "codeRevision"
    || keys[1] !== "operation"
    || keys[2] !== "pluginId"
    || keys[3] !== "requestId"
    || keys[4] !== "sessionId"
    || input.operation !== "start"
    || typeof input.pluginId !== "string"
    || !input.pluginId.trim()
    || typeof input.requestId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.requestId)
    || typeof input.sessionId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.sessionId)
    || typeof input.codeRevision !== "string"
    || !/^[0-9a-f]{64}$/i.test(input.codeRevision)) return null;

  return {
    title: `${context.pluginName || "此插件"} 申请在后台持续运行`,
    scopeLabel: "只保持此插件自己的页面和 Node 会话运行",
    riskHints: [
      "允许后，此插件会在主窗口隐藏时继续运行，直到你停止、禁用或卸载它。",
      "这不会授予文件、网络、剪贴板或其他系统权限；这些能力仍需单独授权。",
    ],
    retryHint: "拒绝不会启动插件；如需后台运行，请从插件设置中重新启用并授权。",
  };
}

/** Only the audited drop source and its exact one-shot FileRead scope select this copy. */
export function pluginFileDropPermissionPresentation(request: PendingAgentToolRequest, context: PermissionRequestContext | null) {
  if (context?.kind !== "plugin_file_drop" || request.scopes.length !== 1 || request.scopes[0] !== "file_read"
    || !/^atools\.host\.file-drop\.[0-9a-f]{24}$/.test(request.tool_name)) return null;
  return { title: `${context.pluginName || "此插件"} 请求读取拖入的文件`,
    riskHints: ["本次操作只读取你刚拖入的文件，最多 16 个、每个 4 MiB、合计 8 MiB。", "路径和文件内容不会写入执行历史。"],
    retryHint: "拒绝后不会保留文件；如仍需使用，请重新拖入。" };
}

/** Only the backend's exact private source context and scope select this prompt. */
export function pluginSecretStoragePermissionPresentation(request: PendingAgentToolRequest, context: PermissionRequestContext | null) {
  if (context?.kind !== "plugin_secret_storage" || request.scopes.length !== 1 || request.scopes[0] !== "secret_storage") return null;
  return {
    title: `${context.pluginName || "此插件"} 请求加密保存凭据`,
    riskHints: ["此插件可以使用系统安全存储加密和解密其自己的凭据。", "凭据明文和加密密钥不会写入执行历史；旧格式密文不会自动迁移。"],
    retryHint: "授权仅用于当前插件会话。拒绝或会话失效会阻止原 preload 执行；请重新打开插件并按提示处理。",
  };
}

/** Backend-owned identity selects this prompt; empty scopes grant no resource access. */
export function pluginMainPushPermissionPresentation(request: PendingAgentToolRequest, context: PermissionRequestContext | null) {
  if (context?.kind !== "plugin_main_push" || request.scopes.length !== 0) return null;
  return { title: `${context.pluginName || "此插件"} 查询搜索结果`, scopeLabel: "在主搜索中运行此插件",
    riskHints: ["此插件会收到你当前输入的文字，并返回可选择的搜索结果。", "文件、网络、剪贴板和本机进程仍按各自的权限处理。"],
    retryHint: "本次允许仅对当前插件搜索会话有效；修改搜索文字后只查询最新内容。" };
}

export function pluginDataPermissionPresentation(request: PendingAgentToolRequest, context: PermissionRequestContext | null) {
  if (context?.kind !== "plugin_data" || request.scopes.length !== 1 || request.scopes[0] !== "plugin_data") return null;
  return {
    title: `${context.pluginName || "此插件"} 请求访问自己的数据`,
    riskHints: ["此插件可以读取、保存和删除自己保存的本地数据，包括收藏、设置及附件。", "此权限仅限当前插件的数据，数据内容不会写入执行历史。"],
    retryHint: "首次允许后插件会继续打开；如果已在插件内操作，请再次操作或重新打开插件。",
  };
}

/** Only stored backend capability context plus its exact requested scope can select this UI. */
export function clipboardPermissionPresentation(request:PendingAgentToolRequest,context:PermissionRequestContext | null) {
  const access = context?.clipboardAccess;
  const expected = access === "paste" ? ["clipboard_write", "input_keyboard"]
    : access === "content_write" ? ["clipboard_write"]
      : access === "image" || access === "history_read" ? ["clipboard_read"]
        : access === "image_write" ? ["clipboard_write"]
          : access === "history_delete" ? ["clipboard_delete"]
            : access ? [`clipboard_${access}`] : [];
  if(context?.kind!=="host_clipboard" || !access || request.scopes.length!==expected.length
      || expected.some((scope, index) => request.scopes[index] !== scope))return null;
  const action=access==="write" || access==="image_write" || access==="content_write"?"写入"
    :access==="paste"?"写入并粘贴"
    :access==="history_delete"?"删除":"读取";
  const target=access==="image" || access==="image_write"?"剪贴板图片"
    :access==="history_read" || access==="history_delete"?"剪贴板历史":"剪贴板";
  return {
    title:`${context.pluginName || "此插件"} 请求${action}${target}`,
    riskHints:[access==="paste"
      ?"此插件可以写入剪贴板，并向确认时记录的前台应用发送一次粘贴快捷键。图片、文本和文件路径不会写入执行历史。"
      :access==="content_write"
        ?"此插件可以复制文本、受限 PNG 图片或文件路径到系统剪贴板；不会自动粘贴，内容不会写入执行历史。"
      :access==="image"
      ?"此插件可以读取当前剪贴板图片内容。图片数据不会写入执行历史。"
      :access==="image_write"
        ?"此插件可以用图片替换当前剪贴板内容。图片数据不会写入执行历史。"
      :access==="history_read"
        ?"此插件可以分页读取剪贴板文本历史并按需读取正文。"
      :access==="history_delete"
        ?"此插件可以删除一条剪贴板历史记录或清空剪贴板历史。"
      :access==="read"
        ?"此插件可以读取当前剪贴板的完整文本，其中可能包含敏感信息。"
        :"此插件可以写入剪贴板，替换当前剪贴板文本。",
      "请仅向你信任的插件开放此权限。"],
    retryHint:"授权后，请在插件中重新执行操作；如果插件未打开，请重新打开插件。",
  };
}

/** Select only a backend-validated path capability and its exact scope. */
export function pluginPathsPermissionPresentation(request: PendingAgentToolRequest, context: PermissionRequestContext | null) {
  const standard = context?.kind === "plugin_paths_standard";
  if ((!standard && context?.kind !== "plugin_paths_data") || request.scopes.length !== 1 || request.scopes[0] !== (standard ? "file_read" : "plugin_data")) return null;
  return {
    title: `${context?.pluginName || "此插件"} ${standard ? "请求读取常用目录路径" : "请求创建自己的数据目录"}`,
    riskHints: standard
      ? ["此插件可以获取用户目录、下载目录及宿主程序等常用位置的路径，可能包含你的用户名。", "本权限不读取文件内容、不修改这些目录，真实路径不会写入执行历史。"]
      : ["ATools 将为此插件创建一个独立的数据目录，并返回它的真实路径。", "本权限只准备目录；其他文件操作仍需对应能力。真实路径不会写入执行历史。"],
    retryHint: "首次允许后插件会继续打开；如果已在插件内操作，请手动重新打开插件，不会自动重放原操作。",
  };
}

/** Only an exact stored native-picker capability can select this wording. */
export function pluginDialogPermissionPresentation(request: PendingAgentToolRequest, context: PermissionRequestContext | null) {
  const open = context?.kind === "plugin_dialog_open";
  if ((!open && context?.kind !== "plugin_dialog_save") || request.scopes.length !== 1 || request.scopes[0] !== (open ? "file_read" : "file_write")) return null;
  return { title: `${context?.pluginName || "此插件"} ${open ? "请求打开文件选择窗口" : "请求选择文件保存位置"}`,
    riskHints: ["每次操作都会由你在系统窗口中选择文件、文件夹或保存位置。", "本权限只返回选择的路径；文件读写仍需其他能力。路径和文件名不会写入执行历史。"],
    retryHint: "首次允许后插件会继续打开；如果已在插件内操作，请手动重新打开，原操作不会自动重放。" };
}

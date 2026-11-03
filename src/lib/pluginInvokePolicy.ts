import {
  PluginFrameSourceRegistry, runPluginFrameOperation,
  type PluginFrameIdentity,
} from "./pluginFrameDocumentIdentity";
export {
  PluginFrameSourceRegistry, identifyPluginMessageEvent, runPluginFrameOperation, postPluginFrameMessageIfCurrent,
  type PluginFrameIdentity,
} from "./pluginFrameDocumentIdentity";

export type PluginInvokeCommand =
  | "get_plugin_data"
  | "get_plugin_data_item"
  | "put_plugin_data"
  | "put_plugin_data_bulk"
  | "remove_plugin_data"
  | "copy_text"
  | "show_notification"
  | "system_get_path"
  | "shell_open";

export type ResolvedPluginInvokeRequest = {
  reqId: number;
  command: PluginInvokeCommand;
  args: Record<string, unknown>;
  permission: string;
};

const NATIVE_PLUGIN_PERMISSIONS = {
  showOpenDialog: "dialog.open",
  showSaveDialog: "dialog.save",
  copyImage: "clipboard.write",
  copyFile: "clipboard.write",
  hideMainWindowPasteText: "clipboard.write",
  hideMainWindowPasteImage: "clipboard.write",
  hideMainWindowPasteFile: "clipboard.write",
  getCopyedFiles: "clipboard.read",
  getNativeIpSnapshot: "network.read",
  performNativeHttpRequest: "network.http",
  translateNativeText: "translation.request",
  readNativeHosts: "system.hosts.read",
  writeNativeHosts: "system.hosts.write",
  listNativeTodos: "todo.read",
  saveNativeTodo: "todo.write",
  deleteNativeTodo: "todo.delete",
  calculateNativeSheet: "calculation.write",
  listNativeCalculationHistory: "calculation.read",
  clearNativeCalculationHistory: "calculation.delete",
  nativeCodecTransform: "codec.transform",
  nativeTimeSnapshot: "time.read",
  convertNativeTime: "time.convert",
  generateNativeQr: "qr.generate",
  nativeJsonTransform: "json.transform",
  convertNativeColor: "color.convert",
  listNativeProcesses: "process.read",
  terminateNativeProcess: "process.terminate",
  shellOpenPath: "shell.openPath",
  shellOpenExternal: "shell.openExternal",
  shellShowItemInFolder: "shell.showItemInFolder",
  shellTrashItem: "shell.trashItem",
  shellBeep: "shell.beep",
  screenCapture: "screen.capture",
  screenColorPick: "screen.colorPick",
  desktopCaptureSources: "screen.desktopCaptureSources",
  readCurrentBrowserUrl: "context.browser",
  readCurrentFolderPath: "context.finder",
  simulateKeyboardTap: "input.keyboard",
  hideMainWindowTypeString: "input.keyboard",
  startDrag: "file.drag",
  createBrowserWindow: "browserWindow",
  sendToParent: "browserWindow",
  sendTo: "browserWindow",
  browserWindowAction: "browserWindow",
  redirect: "settings.redirect",
  redirectHotKeySetting: "settings.redirect",
  redirectAiModelsSetting: "settings.redirect",
} as const;

const KNOWN_PLUGIN_PERMISSIONS = new Set<string>([
  "data",
  "clipboard.write",
  "shell.openExternal",
  "shell.openPath",
  "system.path",
  "notification",
  ...Object.values(NATIVE_PLUGIN_PERMISSIONS),
]);

const SYSTEM_PATH_NAMES = new Set([
  "home",
  "desktop",
  "downloads",
  "documents",
  "pictures",
  "music",
  "videos",
  "appData",
  "appdata",
  "temp",
]);

export function pluginPermissionListAllows(permissions: unknown, permission: unknown) {
  if (!Array.isArray(permissions)) return false;
  const value = typeof permission === "string" ? permission.trim() : "";
  if (!value) return false;
  const dotIndex = value.indexOf(".");
  const group = dotIndex > 0 ? value.slice(0, dotIndex) : value;
  return permissions.some((item) => {
    const allowed = typeof item === "string" ? item.trim() : "";
    if (!allowed) return false;
    if (allowed === "*" || allowed === value || allowed === group) return true;
    return allowed.endsWith(".*") && value.startsWith(allowed.slice(0, -1));
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isPluginBridgeRequestId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function invalidInvokeArgs(command: string, detail: string): never {
  throw new Error(`Invalid plugin invoke args for ${command}: ${detail}`);
}

function requiredString(
  args: Record<string, unknown>,
  key: string,
  command: string,
  trim = false,
) {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    invalidInvokeArgs(command, `${key} must be a non-empty string`);
  }
  return trim ? value.trim() : value;
}

function sanitizeJsonValue(
  value: unknown,
  command: string,
  path: string,
  ancestors = new Set<object>(),
  depth = 0,
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidInvokeArgs(command, `${path} must contain only finite numbers`);
    return value;
  }
  if (!value || typeof value !== "object") {
    invalidInvokeArgs(command, `${path} must be JSON-compatible`);
  }
  if (depth >= 32) invalidInvokeArgs(command, `${path} exceeds the maximum nesting depth`);
  if (ancestors.has(value)) invalidInvokeArgs(command, `${path} must not contain circular references`);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => sanitizeJsonValue(item, command, `${path}[${index}]`, ancestors, depth + 1));
    }
    if (!isPlainRecord(value)) invalidInvokeArgs(command, `${path} must be a plain object`);
    const sanitized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        invalidInvokeArgs(command, `${path}.${key} is not allowed`);
      }
      sanitized[key] = sanitizeJsonValue(item, command, `${path}.${key}`, ancestors, depth + 1);
    }
    return sanitized;
  } finally {
    ancestors.delete(value);
  }
}

function sanitizedDocument(value: unknown, command: string, path: string) {
  const document = sanitizeJsonValue(value, command, path);
  if (!isPlainRecord(document)) invalidInvokeArgs(command, `${path} must be a document object`);
  if (typeof document._id !== "string" || !document._id.trim()) {
    invalidInvokeArgs(command, `${path}._id must be a non-empty string`);
  }
  return document;
}

function shellPermission(target: string) {
  if (/^file:/i.test(target)) return "shell.openPath";
  if (/^[a-z][a-z\d+.-]*:/i.test(target)) return "shell.openExternal";
  return "shell.openPath";
}

function sanitizeInvokeArgs(
  command: PluginInvokeCommand,
  args: Record<string, unknown>,
  pluginId: string,
): Pick<ResolvedPluginInvokeRequest, "args" | "permission"> {
  if (!pluginId.trim()) throw new Error("Trusted plugin id must be a non-empty string");
  switch (command) {
    case "get_plugin_data":
      return { args: { pluginId }, permission: "data" };
    case "get_plugin_data_item":
    case "remove_plugin_data":
      return {
        args: { pluginId, docId: requiredString(args, "docId", command) },
        permission: "data",
      };
    case "put_plugin_data":
      return {
        args: { pluginId, doc: sanitizedDocument(args.doc, command, "doc") },
        permission: "data",
      };
    case "put_plugin_data_bulk": {
      if (!Array.isArray(args.docs)) invalidInvokeArgs(command, "docs must be an array");
      return {
        args: {
          pluginId,
          docs: args.docs.map((doc, index) => sanitizedDocument(doc, command, `docs[${index}]`)),
        },
        permission: "data",
      };
    }
    case "copy_text":
      return { args: { text: requiredString(args, "text", command) }, permission: "clipboard.write" };
    case "show_notification":
      return { args: { message: requiredString(args, "message", command) }, permission: "notification" };
    case "system_get_path": {
      const name = requiredString(args, "name", command);
      if (!SYSTEM_PATH_NAMES.has(name)) invalidInvokeArgs(command, `unsupported path name: ${name}`);
      return { args: { name }, permission: "system.path" };
    }
    case "shell_open": {
      const url = requiredString(args, "url", command, true);
      return { args: { url }, permission: shellPermission(url) };
    }
  }
}

function pluginInvokeCommand(value: unknown): PluginInvokeCommand {
  switch (value) {
    case "get_plugin_data":
    case "get_plugin_data_item":
    case "put_plugin_data":
    case "put_plugin_data_bulk":
    case "remove_plugin_data":
    case "copy_text":
    case "show_notification":
    case "system_get_path":
    case "shell_open":
      return value;
    default:
      throw new Error(`Unsupported plugin invoke command: ${String(value ?? "") || "(empty)"}`);
  }
}

export function resolvePluginInvokeRequest(message: unknown, pluginId: string): ResolvedPluginInvokeRequest {
  if (!isPlainRecord(message)) throw new Error("Plugin invoke request must be a plain object");
  if (!isPluginBridgeRequestId(message.reqId)) {
    throw new Error("Plugin invoke reqId must be a positive safe integer");
  }
  const command = pluginInvokeCommand(message.cmd);
  if (!isPlainRecord(message.args)) {
    throw new Error(`Plugin invoke ${command} args must be a plain object`);
  }
  const resolved = sanitizeInvokeArgs(command, message.args, pluginId);
  return { reqId: message.reqId, command, ...resolved };
}

export async function dispatchPluginInvokeMessage(options: {
  source: unknown;
  message: unknown;
  sources: PluginFrameSourceRegistry;
  identity?: PluginFrameIdentity;
  pluginId: string;
  authorize: (permission: string, identity: PluginFrameIdentity) => Promise<void>;
  invoke: (command: PluginInvokeCommand, args: Record<string, unknown>) => Promise<unknown>;
}) {
  const identity = options.identity ?? options.sources.identify(options.source);
  if (!identity || !options.sources.isCurrent(options.source, identity)) return { handled: false } as const;
  const request = resolvePluginInvokeRequest(options.message, options.pluginId);
  await options.authorize(request.permission, identity);
  const result = await runPluginFrameOperation({
    source: options.source,
    identity,
    sources: options.sources,
    operation: () => options.invoke(request.command, request.args),
  });
  return { handled: true, identity, request, result } as const;
}

export function nativePluginPermissionForMethod(method: unknown): string | null {
  if (typeof method !== "string") return null;
  return NATIVE_PLUGIN_PERMISSIONS[method as keyof typeof NATIVE_PLUGIN_PERMISSIONS] ?? null;
}

export function resolvePluginPermissionRequest(message: unknown) {
  if (!isPlainRecord(message)) throw new Error("Plugin permission request must be a plain object");
  if (!isPluginBridgeRequestId(message.reqId)) {
    throw new Error("Plugin permission reqId must be a positive safe integer");
  }
  const permission = typeof message.permission === "string" ? message.permission.trim() : "";
  if (!KNOWN_PLUGIN_PERMISSIONS.has(permission)) {
    throw new Error(`Unsupported plugin permission: ${permission || "(empty)"}`);
  }
  return { reqId: message.reqId, permission };
}

export function bindNativeBridgeArgsToSource(
  method: unknown,
  args: unknown,
  identity: PluginFrameIdentity,
  options: { authorizeBrowserWindowTarget?: (targetId: string, identity: PluginFrameIdentity) => boolean } = {},
): Record<string, unknown> {
  if (!isPlainRecord(args)) throw new Error("Native bridge args must be a plain object");
  if (method === "browserWindowAction") {
    const suppliedId = typeof args.id === "string" && args.id.trim() ? args.id.trim() : "";
    let id: string;
    if (identity.kind === "child") {
      if (!suppliedId || suppliedId === identity.windowId) id = identity.windowId;
      else if (!options.authorizeBrowserWindowTarget) id = identity.windowId;
      else if (options.authorizeBrowserWindowTarget(suppliedId, identity)) id = suppliedId;
      else throw new Error("browserWindowAction target is not owned by this current plugin frame");
    } else {
      id = requiredString(args, "id", "browserWindowAction");
      if (options.authorizeBrowserWindowTarget && !options.authorizeBrowserWindowTarget(id, identity)) {
        throw new Error("browserWindowAction target is not owned by this current plugin frame");
      }
    }
    const action = requiredString(args, "action", "browserWindowAction");
    if (!Array.isArray(args.args)) invalidInvokeArgs("browserWindowAction", "args must be an array");
    return {
      id,
      action,
      args: sanitizeJsonValue(args.args, "browserWindowAction", "args"),
    };
  }
  if (method !== "sendToParent") return args;
  const channel = requiredString(args, "channel", "sendToParent");
  if (!Array.isArray(args.args)) invalidInvokeArgs("sendToParent", "args must be an array");
  const messageArgs = sanitizeJsonValue(args.args, "sendToParent", "args");
  return {
    channel,
    args: messageArgs,
    windowType: identity.kind === "child" ? "browserWindow" : "main",
    browserWindowId: identity.kind === "child" ? identity.windowId : "",
  };
}

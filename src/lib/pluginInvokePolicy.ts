export type PluginFrameIdentity =
  | { kind: "main"; generation: number }
  | { kind: "child"; windowId: string; generation: number };

type PluginMessageSource = object;

type PluginFrameSourceEntry = {
  source: PluginMessageSource;
  generation: number;
};

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

export class PluginFrameSourceRegistry {
  private mainSource: PluginFrameSourceEntry | null = null;
  private readonly childSources = new Map<string, PluginFrameSourceEntry>();
  private generation = 0;

  private nextGeneration() {
    if (this.generation >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Plugin frame source generation exhausted");
    }
    this.generation += 1;
    return this.generation;
  }

  setMain(source: unknown) {
    this.mainSource = isMessageSource(source)
      ? { source, generation: this.nextGeneration() }
      : null;
  }

  unregisterMain(expectedSource?: unknown) {
    if (expectedSource !== undefined && this.mainSource?.source !== expectedSource) return;
    this.mainSource = null;
  }

  registerChild(windowId: string, source: unknown) {
    const id = windowId.trim();
    if (!id || !isMessageSource(source)) return;
    for (const [registeredId, registeredEntry] of this.childSources) {
      if (registeredEntry.source === source && registeredId !== id) {
        this.childSources.delete(registeredId);
      }
    }
    this.childSources.set(id, { source, generation: this.nextGeneration() });
  }

  unregisterChild(windowId: string, expectedSource?: unknown) {
    const id = windowId.trim();
    const registered = this.childSources.get(id);
    if (!registered) return;
    if (expectedSource !== undefined && registered.source !== expectedSource) return;
    this.childSources.delete(id);
  }

  identify(source: unknown): PluginFrameIdentity | null {
    if (!isMessageSource(source)) return null;
    if (source === this.mainSource?.source) {
      return { kind: "main", generation: this.mainSource.generation };
    }
    for (const [windowId, registeredEntry] of this.childSources) {
      if (source === registeredEntry.source) {
        return { kind: "child", windowId, generation: registeredEntry.generation };
      }
    }
    return null;
  }

  isCurrent(source: unknown, identity: PluginFrameIdentity) {
    return sameFrameIdentity(this.identify(source), identity);
  }

  clear() {
    this.mainSource = null;
    this.childSources.clear();
  }
}

export function identifyPluginMessageEvent(
  sources: PluginFrameSourceRegistry,
  event: Pick<MessageEvent, "source">,
): PluginFrameIdentity | null {
  return sources.identify(event.source);
}

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

function isMessageSource(value: unknown): value is PluginMessageSource {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function sameFrameIdentity(current: PluginFrameIdentity | null, expected: PluginFrameIdentity) {
  if (!current || current.kind !== expected.kind || current.generation !== expected.generation) return false;
  return current.kind === "main"
    || (expected.kind === "child" && current.windowId === expected.windowId);
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

function assertPluginFrameSourceCurrent(
  sources: PluginFrameSourceRegistry,
  source: unknown,
  identity: PluginFrameIdentity,
) {
  if (!sources.isCurrent(source, identity)) {
    throw new Error("Plugin message source is no longer active");
  }
}

export async function runPluginFrameOperation<T>(options: {
  source: unknown;
  identity: PluginFrameIdentity;
  sources: PluginFrameSourceRegistry;
  operation: () => Promise<T>;
}): Promise<T> {
  assertPluginFrameSourceCurrent(options.sources, options.source, options.identity);
  try {
    const result = await options.operation();
    assertPluginFrameSourceCurrent(options.sources, options.source, options.identity);
    return result;
  } catch (error) {
    assertPluginFrameSourceCurrent(options.sources, options.source, options.identity);
    throw error;
  }
}

export function postPluginFrameMessageIfCurrent(options: {
  source: unknown;
  identity: PluginFrameIdentity;
  sources: PluginFrameSourceRegistry;
  message: unknown;
  targetOrigin?: string;
}) {
  if (!options.sources.isCurrent(options.source, options.identity)) return false;
  const target = options.source as { postMessage?: (message: unknown, targetOrigin: string) => void };
  if (typeof target?.postMessage !== "function") return false;
  try {
    target.postMessage(options.message, options.targetOrigin ?? "*");
    return true;
  } catch {
    return false;
  }
}

export async function dispatchPluginInvokeMessage(options: {
  source: unknown;
  message: unknown;
  sources: PluginFrameSourceRegistry;
  pluginId: string;
  authorize: (permission: string, identity: PluginFrameIdentity) => Promise<void>;
  invoke: (command: PluginInvokeCommand, args: Record<string, unknown>) => Promise<unknown>;
}) {
  const identity = options.sources.identify(options.source);
  if (!identity) return { handled: false } as const;
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
): Record<string, unknown> {
  if (!isPlainRecord(args)) throw new Error("Native bridge args must be a plain object");
  if (method === "browserWindowAction") {
    const id = identity.kind === "child"
      ? identity.windowId
      : requiredString(args, "id", "browserWindowAction");
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

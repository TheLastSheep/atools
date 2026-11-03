import type { TaskRun } from "./types";
import type { ClipboardAccess, HostClipboardConfig } from "./hostClipboardBridge";
import { postPluginFrameMessageIfCurrent, type PluginFrameIdentity, type PluginFrameSourceRegistry } from "./pluginInvokePolicy";
type Invoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Open = { sessionId?: string; permission_required?: boolean; runId?: string; tool?: string; error?: string; unavailable?: boolean; endpoint?: string; access?: ClipboardAccess; expiresInMs?: number | null };
export type HostClipboardStatus = { state: "pending" | "ready" | "error"; access: ClipboardAccess; message: string };
function accessLabel(access: ClipboardAccess): string {
  if (access === "image") return "读取剪贴板图片";
  if (access === "image_write") return "写入剪贴板图片";
  if (access === "history_read") return "读取剪贴板历史（文本、图片和文件）";
  if (access === "history_delete") return "删除剪贴板历史";
  if (access === "content_write") return "写入剪贴板内容";
  if (access === "paste") return "写入并粘贴剪贴板内容";
  return "剪贴板" + (access === "read" ? "读取" : "写入");
}

/** Active only during an explicit opening/approval; no idle polling or listener. */
export function createHostClipboardController(
  invoke: Invoke,
  pluginId: string,
  isCurrent: () => boolean,
  onStatus: (status: HostClipboardStatus) => void,
  initial?: HostClipboardConfig,
  wait: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 200)),
  monotonicNow: () => number = () => performance.now(),
) {
  const instanceId = initial?.instanceId || crypto.randomUUID();
  const endpoints = { ...initial?.endpoints };
  const pending = new Map<ClipboardAccess, Promise<string | undefined>>();
  const invalidators = new Set<() => void>();
  const expiryTimers = new Set<ReturnType<typeof setTimeout>>();
  function notifyInvalidated() { for (const callback of [...invalidators]) { try { callback(); } catch {} } }
  function onInvalidated(callback: () => void) {
    if (closed) { try { callback(); } catch {} return () => undefined; }
    invalidators.add(callback);
    return () => invalidators.delete(callback);
  }
  let closed = false, requested = Boolean(initial), handedOff = false;
  let closing: Promise<unknown> | undefined;
  function current() { return !closed && isCurrent(); }
  function assertCurrent() { if (!current()) throw new Error("Clipboard opening was cancelled"); }
  function invalidateLocal() {
    for (const timer of expiryTimers) clearTimeout(timer);
    expiryTimers.clear();
    notifyInvalidated();
  }
  function close() {
    if (closed) return closing || Promise.resolve();
    closed = true;
    invalidateLocal();
    if (requested && !handedOff && !closing) closing = invoke("close_host_clipboard", { pluginId, instanceId }).catch(() => { console.warn("Plugin clipboard cleanup failed"); });
    return closing || Promise.resolve();
  }
  async function open(access: ClipboardAccess, requestPermission: boolean): Promise<string | undefined> {
    assertCurrent();
    if (endpoints[access]) return endpoints[access];
    requested = true;
    const opened = await invoke<Open>("prepare_host_clipboard", { pluginId, instanceId, access, requestPermission });
    assertCurrent();
    if (!opened || opened.unavailable) return undefined;
    let sessionId = opened.sessionId;
    if (!sessionId) {
      if (!opened.permission_required || !opened.runId || !opened.tool) throw new Error(opened.error || "剪贴板授权未完成");
      onStatus({ state: "pending", access, message: "请在授权窗口选择是否允许" + accessLabel(access) });
      while (!sessionId) {
        await wait(); assertCurrent();
        const run: TaskRun | null = await invoke<TaskRun | null>("get_task_run", { id: opened.runId });
        assertCurrent();
        if (!run || run.id !== opened.runId || run.capabilityId !== opened.tool || run.initiator.clientId !== "atools-ui") throw new Error("剪贴板授权任务已失效");
        if (run.status === "succeeded") {
          sessionId = (run.output as Open)?.sessionId;
          if (!sessionId) throw new Error("剪贴板授权已结束，但未建立会话");
        } else if (["failed", "cancelled", "partial"].includes(run.status)) throw new Error("剪贴板授权未完成，可再次操作或重新打开插件");
      }
    }
    const sessionRequestStartedAt = monotonicNow();
    const config = await invoke<Open>("get_host_clipboard_session", { pluginId, instanceId, sessionId });
    assertCurrent();
    if (config.access !== access) throw new Error("剪贴板会话权限不匹配");
    if (config.expiresInMs !== undefined && config.expiresInMs !== null) {
      if (!Number.isSafeInteger(config.expiresInMs) || config.expiresInMs < 0 || config.expiresInMs > 600000) throw new Error("剪贴板授权期限无效");
      const elapsed = Math.max(0, monotonicNow() - sessionRequestStartedAt);
      const remaining = config.expiresInMs - Math.ceil(elapsed);
      if (remaining <= 0) {
        await close();
        throw new Error("剪贴板授权在会话建立前已过期");
      }
      const timer = setTimeout(() => { expiryTimers.delete(timer); void close(); }, remaining);
      expiryTimers.add(timer);
    }
    endpoints[access] = config.endpoint;
    return config.endpoint;
  }
  async function prepareGranted() {
    for (const access of ["read", "write"] as const) await open(access, false);
    if (initial?.restoreImageSession) await open("image", false);
    return { instanceId, endpoints: { ...endpoints } };
  }
  function request(access: ClipboardAccess) {
    if (access !== "read" && access !== "write" && access !== "image" && access !== "image_write"
      && access !== "content_write" && access !== "paste"
      && access !== "history_read" && access !== "history_delete") return Promise.reject(new Error("Invalid clipboard scope"));
    const existing = pending.get(access);
    if (existing) return existing;
    const result = open(access, true).then((endpoint) => {
      if (endpoint && current()) onStatus({ state: "ready", access, message: accessLabel(access) + "已允许，请再次操作或重新打开插件" });
      return endpoint;
    }).catch((error) => {
      if (current()) onStatus({ state: "error", access, message: accessLabel(access) + "授权未完成，请再次操作或重新打开插件" });
      throw error;
    }).finally(() => pending.delete(access));
    pending.set(access, result);
    return result;
  }
  async function reopen(): Promise<HostClipboardConfig> {
    assertCurrent();
    const nextInstanceId = crypto.randomUUID();
    if (Object.keys(endpoints).length) {
      const restoreImageSession = Boolean(endpoints.image);
      await invoke("rotate_host_clipboard", { pluginId, instanceId, nextInstanceId });
      if (!current()) {
        await invoke("close_host_clipboard", { pluginId, instanceId: nextInstanceId }).catch(() => {});
        throw new Error("Clipboard reopen was cancelled");
      }
      invalidateLocal();
      handedOff = true;
      closed = true;
      return { instanceId: nextInstanceId, ...(restoreImageSession ? { restoreImageSession: true } : {}) };
    } else await close();
    closed = true;
    return { instanceId: nextInstanceId };
  }
  return { instanceId, prepareGranted, request, close, reopen, onInvalidated,
    configuration: () => ({ instanceId, endpoints: closed ? {} : { ...endpoints } }) };
}

export function dispatchHostClipboardPermission(options: {
  controller: ReturnType<typeof createHostClipboardController> | undefined;
  message: Record<string, unknown>; source: MessageEventSource | null;
  identity: PluginFrameIdentity; sources: PluginFrameSourceRegistry;
}): boolean {
  const { controller, message, source, identity, sources } = options;
  if (message.__atools_host_clipboard_open__ !== true) return false;
    if (!controller || message.instanceId !== controller.instanceId || (message.access !== "read" && message.access !== "write"
      && message.access !== "image" && message.access !== "image_write"
      && message.access !== "content_write" && message.access !== "paste"
      && message.access !== "history_read" && message.access !== "history_delete")) return true;
  const access = message.access;
  void controller.request(access).then((endpoint) => {
    postPluginFrameMessageIfCurrent({ source, identity, sources, message: { __atools_host_clipboard_session__: true, instanceId: controller.instanceId, access, endpoint } });
  }, () => {
    postPluginFrameMessageIfCurrent({ source, identity, sources, message: { __atools_host_clipboard_session__: true, instanceId: controller.instanceId, access } });
  });
  return true;
}

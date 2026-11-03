import type { TaskRun } from "./types";
import type { PluginDisplayConfig } from "./pluginDisplayBridge";
import type { PluginDataStatus } from "./pluginDataController";
import type { PluginFrameIdentity, PluginFrameSourceRegistry } from "./pluginInvokePolicy";
type Invoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Opening = { sessionId?: string; permission_required?: boolean; runId?: string; tool?: string; unavailable?: boolean; usage?: string };

/** Explicit operations only. Approval never posts credentials or replays a plugin call. */
export function createPluginDisplayController(invoke: Invoke, pluginId: string, isCurrent: () => boolean,
  onStatus: (status: PluginDataStatus | null) => void, initial?: PluginDisplayConfig,
  wait: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 200)), now: () => number = Date.now) {
  const instanceId = initial?.instanceId ?? crypto.randomUUID();
  let sessionId = initial?.sessionId, endpoint: string | undefined, closed = false, requested = Boolean(initial), handedOff = false;
  let pending: Promise<boolean> | undefined, closing: Promise<unknown> | undefined;
  const current = () => !closed && isCurrent();
  function assertCurrent() { if (!current()) throw new Error("Display preparation was cancelled"); }
  function close() {
    closed = true; endpoint = undefined;
    if (requested && !handedOff && !closing) closing = invoke("close_plugin_display", { pluginId, instanceId }).catch(() => { console.warn("Plugin display cleanup failed"); });
    return closing ?? Promise.resolve();
  }
  async function read(id: string) {
    const result = await invoke<{ endpoint: string }>("get_plugin_display_session", { pluginId, instanceId, sessionId: id });
    assertCurrent();
    if (!result || typeof result.endpoint !== "string" || (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/display\/[0-9a-f]{64}$/.test(result.endpoint) || Number(result.endpoint.split(":")[2].split("/")[0]) > 65535)) throw new Error("Invalid display session");
    sessionId = id; endpoint = result.endpoint;
  }
  async function open(requestPermission: boolean): Promise<{ available: boolean; detected: boolean }> {
    assertCurrent(); requested = true;
    try {
      if (sessionId) { await read(sessionId); return { available: true, detected: true }; }
      const opened = await invoke<Opening>("prepare_plugin_display", { pluginId, instanceId, requestPermission });
      assertCurrent();
      if (!opened || opened.unavailable) return { available: false, detected: opened?.usage === "detected" };
      let id = opened.sessionId;
      if (!id) {
        if (!opened.permission_required || !opened.runId || !opened.tool) throw new Error("显示器授权未完成");
        onStatus({ state: "pending", message: "请允许此插件读取显示器和鼠标位置" });
        const deadline = now() + 120_000; let polls = 0;
        while (!id) {
          if (++polls > 600 || now() >= deadline) throw new Error("显示器授权等待超时，请重新打开插件");
          await wait(); assertCurrent();
          if (now() >= deadline) throw new Error("显示器授权等待超时，请重新打开插件");
          const run: TaskRun | null = await invoke<TaskRun | null>("get_task_run", { id: opened.runId }); assertCurrent();
          if (!run || run.id !== opened.runId || run.capabilityId !== opened.tool || run.initiator?.clientId !== "atools-ui") throw new Error("显示器授权任务已失效");
          if (run.status === "succeeded") { id = (run.output as Opening)?.sessionId; if (!id) throw new Error("显示器会话初始化未完成"); }
          else if (["failed", "cancelled", "partial"].includes(run.status)) throw new Error("显示器授权未完成");
          else if (!["created", "awaiting_permission", "running"].includes(run.status)) throw new Error("显示器授权任务状态无效");
        }
      }
      if (typeof id !== "string" || !id) throw new Error("Invalid display session identity");
      await read(id); return { available: true, detected: true };
    } finally {
      if (!current() && !handedOff) await invoke("close_plugin_display", { pluginId, instanceId }).catch(() => {});
    }
  }
  async function prepare() {
    try {
      const result = await open(false);
      if (!result.available && result.detected && !(await open(true)).available) throw new Error("显示器授权未完成");
      assertCurrent(); onStatus(null); return configuration();
    } catch (error) { if (current()) onStatus({ state: "error", message: "显示器授权未完成，允许后可重新打开" }); throw error; }
  }
  function request() {
    if (pending) return pending;
    onStatus({ state: "pending", message: "此插件需要显示器信息，请在授权后重新打开插件" });
    pending = open(true).then(result => {
      if (!result.available) throw new Error("显示器授权未完成");
      if (current()) onStatus({ state: "ready", message: "已允许读取显示器信息，请重新打开插件完成初始化" });
      return true;
    }).catch(error => { if (current()) onStatus({ state: "error", message: "显示器授权未完成，可重新打开后再试" }); throw error; }).finally(() => { pending = undefined; });
    return pending;
  }
  async function reopen(): Promise<PluginDisplayConfig> {
    assertCurrent(); if (pending) throw new Error("显示器授权仍在进行");
    const nextInstanceId = crypto.randomUUID();
    // An unused controller has no native session to rotate. A live rotation
    // replaces both native ID and token; the successor resolves its own owner.
    if (endpoint) await invoke("rotate_plugin_display", { pluginId, instanceId, nextInstanceId });
    else await invoke("close_plugin_display", { pluginId, instanceId });
    if (!current()) { await invoke("close_plugin_display", { pluginId, instanceId: nextInstanceId }).catch(() => {}); throw new Error("Display reopen cancelled"); }
    handedOff = true; closed = true; endpoint = undefined; sessionId = undefined;
    return { instanceId: nextInstanceId };
  }
  function configuration(): PluginDisplayConfig { return { instanceId, ...(sessionId ? { sessionId } : {}), ...(endpoint ? { endpoint } : {}) }; }
  return { instanceId, prepare, request, close, reopen, configuration };
}

export function dispatchPluginDisplayPermission(options: {
  controller?: ReturnType<typeof createPluginDisplayController>; message: Record<string, unknown>;
  source: MessageEventSource | null; identity: PluginFrameIdentity; sources: PluginFrameSourceRegistry;
}): boolean {
  if (options.message.__atools_plugin_display_open__ !== true) return false;
  if (!options.sources.isCurrent(options.source, options.identity)) return true;
  if (options.controller && options.message.instanceId === options.controller.instanceId) void options.controller.request().catch(() => {});
  return true;
}

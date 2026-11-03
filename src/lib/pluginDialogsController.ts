import type { TaskRun } from "./types";
import type { PluginDialogAccess, PluginDialogsConfig } from "./pluginNativeDialogBridge";
import type { PluginDataStatus } from "./pluginDataController";
import type { PluginFrameIdentity, PluginFrameSourceRegistry } from "./pluginInvokePolicy";
type Invoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Opening = { sessionId?: string; permission_required?: boolean; runId?: string; tool?: string; unavailable?: boolean; usage?: string };
/** Preparation never displays a picker. Only explicit plugin operations can do that. */
export function createPluginDialogsController(invoke: Invoke, pluginId: string, isCurrent: () => boolean,
  onStatus: (status: PluginDataStatus | null) => void, initial?: PluginDialogsConfig,
  wait: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 200))) {
  const instanceId = initial?.instanceId ?? crypto.randomUUID();
  const sessions = { ...initial?.sessions }, endpoints: NonNullable<PluginDialogsConfig["endpoints"]> = {};
  const pending = new Map<PluginDialogAccess, Promise<boolean>>();
  let closed = false, requested = Boolean(initial), handedOff = false, closing: Promise<unknown> | undefined;
  const current = () => !closed && isCurrent();
  function assertCurrent() { if (!current()) throw new Error("Dialog preparation was cancelled"); }
  function close() {
    closed = true; delete endpoints.open; delete endpoints.save;
    if (requested && !handedOff && !closing) closing = invoke("close_plugin_dialogs", { pluginId, instanceId }).catch(() => { console.warn("Plugin dialog cleanup failed"); });
    return closing ?? Promise.resolve();
  }
  async function read(access: PluginDialogAccess, sessionId: string) {
    const result = await invoke<{ endpoint: string; access: PluginDialogAccess }>("get_plugin_dialog_session", { pluginId, instanceId, sessionId });
    assertCurrent(); if (result.access !== access || typeof result.endpoint !== "string" || !/^http:\/\/127\.0\.0\.1:\d+\/dialog\/[a-f0-9]{64}$/.test(result.endpoint)) throw new Error("Dialog session identity mismatch");
    sessions[access] = sessionId; endpoints[access] = result.endpoint;
  }
  async function open(access: PluginDialogAccess, requestPermission: boolean): Promise<{ available: boolean; detected: boolean }> {
    assertCurrent(); requested = true;
    try {
      const existing = sessions[access]; if (existing) { await read(access, existing); return { available: true, detected: true }; }
      const opened = await invoke<Opening>("prepare_plugin_dialogs", { pluginId, instanceId, access, requestPermission });
      assertCurrent(); if (!opened || opened.unavailable) return { available: false, detected: opened?.usage === "detected" };
      let sessionId = opened.sessionId;
      if (!sessionId) {
        if (!opened.permission_required || !opened.runId || !opened.tool) throw new Error("文件选择授权未完成");
        onStatus({ state: "pending", message: access === "open" ? "请允许此插件打开文件选择窗口" : "请允许此插件打开保存位置窗口" });
        while (!sessionId) {
          await wait(); assertCurrent();
          const run: TaskRun | null = await invoke<TaskRun | null>("get_task_run", { id: opened.runId }); assertCurrent();
          if (!run || run.id !== opened.runId || run.capabilityId !== opened.tool || run.initiator.clientId !== "atools-ui") throw new Error("文件选择授权任务已失效");
          if (run.status === "succeeded") { sessionId = (run.output as Opening)?.sessionId; if (!sessionId) throw new Error("文件选择初始化未完成"); }
          else if (["failed", "cancelled", "partial"].includes(run.status)) throw new Error("文件选择授权未完成");
        }
      }
      await read(access, sessionId); return { available: true, detected: true };
    } finally { if (!current() && !handedOff) await invoke("close_plugin_dialogs", { pluginId, instanceId }).catch(() => {}); }
  }
  async function prepare() {
    try {
      for (const access of ["open", "save"] as const) {
        const result = await open(access, false);
        if (!result.available && result.detected && !(await open(access, true)).available) throw new Error("文件选择授权未完成");
      }
      assertCurrent(); onStatus(null); return configuration();
    } catch (error) { if (current()) onStatus({ state: "error", message: "文件选择授权未完成，允许后可重新打开" }); throw error; }
  }
  function request(access: PluginDialogAccess) {
    const existing = pending.get(access); if (existing) return existing;
    onStatus({ state: "pending", message: "此插件需要文件选择窗口，请授权后手动重新打开；原操作不会重放" });
    const task = open(access, true).then(result => {
      if (!result.available) throw new Error("文件选择授权未完成");
      if (current()) onStatus({ state: "ready", message: "已允许打开文件选择窗口，请手动重新打开插件" }); return true;
    }).catch(error => { if (current()) onStatus({ state: "error", message: "文件选择授权未完成，可重新打开后再试" }); throw error; }).finally(() => pending.delete(access));
    pending.set(access, task); return task;
  }
  async function reopen(): Promise<PluginDialogsConfig> {
    assertCurrent(); if (pending.size) throw new Error("文件选择授权仍在进行");
    const nextInstanceId = crypto.randomUUID();
    const result = await invoke<{ sessions: PluginDialogsConfig["sessions"] }>("rotate_plugin_dialogs", { pluginId, instanceId, nextInstanceId });
    if (!current()) { await invoke("close_plugin_dialogs", { pluginId, instanceId: nextInstanceId }).catch(() => {}); throw new Error("Dialog reopen cancelled"); }
    handedOff = true; closed = true; return { instanceId: nextInstanceId, sessions: result.sessions };
  }
  function configuration(): PluginDialogsConfig { return { instanceId, sessions: { ...sessions }, endpoints: { ...endpoints } }; }
  return { instanceId, prepare, request, close, reopen, configuration };
}
export function dispatchPluginDialogsPermission(options: {
  controller?: ReturnType<typeof createPluginDialogsController>; message: Record<string, unknown>; source: MessageEventSource | null;
  identity: PluginFrameIdentity; sources: PluginFrameSourceRegistry;
}): boolean {
  if (options.message.__atools_plugin_dialog_open__ !== true) return false;
  if (!options.sources.isCurrent(options.source, options.identity)) return true;
  const { controller, message } = options;
  if (controller && message.instanceId === controller.instanceId && (message.access === "open" || message.access === "save")) void controller.request(message.access).catch(() => {});
  return true;
}

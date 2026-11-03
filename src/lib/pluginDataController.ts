import type { TaskRun } from "./types";
import type { PluginDataConfig, PluginDataUsage } from "./pluginDataBridge";
import { postPluginFrameMessageIfCurrent, type PluginFrameIdentity, type PluginFrameSourceRegistry } from "./pluginInvokePolicy";

type Invoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Opening = { sessionId?: string; permission_required?: boolean; runId?: string; tool?: string; error?: string; unavailable?: boolean; usage?: PluginDataUsage };
export type PluginDataStatus = { state: "pending" | "ready" | "error"; message: string };

/** Only waits while an opening is active. Documents and bearer URLs never enter TaskRun inputs. */
export function createPluginDataController(
  invoke: Invoke, pluginId: string, isCurrent: () => boolean,
  onStatus: (status: PluginDataStatus | null) => void, initial?: PluginDataConfig,
  wait: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 200)),
) {
  const instanceId = initial?.instanceId || crypto.randomUUID();
  let endpoint = initial?.endpoint, usage = initial?.usage;
  let closed = false, requested = Boolean(initial), handedOff = false;
  let closing: Promise<unknown> | undefined, pending: Promise<string | undefined> | undefined;
  const current = () => !closed && isCurrent();
  function assertCurrent() { if (!current()) throw new Error("Data opening was cancelled"); }
  function close() {
    closed = true;
    if (requested && !handedOff && !closing) closing = invoke("close_plugin_data", { pluginId, instanceId })
      .catch(() => { console.warn("Plugin data cleanup failed"); });
    return closing || Promise.resolve();
  }
  async function open(requestPermission: boolean): Promise<string | undefined> {
    assertCurrent();
    if (endpoint) return endpoint;
    try {
    requested = true;
    const opened = await invoke<Opening>("prepare_plugin_data", { pluginId, instanceId, requestPermission });
    assertCurrent();
    usage = opened?.usage ?? usage;
    if (!opened || opened.unavailable) return undefined;
    let sessionId = opened.sessionId;
    if (!sessionId) {
      if (!opened.permission_required || !opened.runId || !opened.tool) throw new Error("插件数据授权未完成");
      onStatus({ state: "pending", message: "请在授权窗口选择是否允许访问本插件保存的数据" });
      while (!sessionId) {
        await wait(); assertCurrent();
        const run: TaskRun | null = await invoke<TaskRun | null>("get_task_run", { id: opened.runId });
        assertCurrent();
        if (!run || run.id !== opened.runId || run.capabilityId !== opened.tool || run.initiator.clientId !== "atools-ui") throw new Error("插件数据授权任务已失效");
        if (run.status === "succeeded") {
          sessionId = (run.output as Opening)?.sessionId;
          if (!sessionId) throw new Error("授权已结束，但未建立插件数据会话");
        } else if (["failed", "cancelled", "partial"].includes(run.status)) throw new Error("插件数据授权未完成");
      }
    }
    const config = await invoke<{ endpoint: string }>("get_plugin_data_session", { pluginId, instanceId, sessionId });
    assertCurrent();
    const match = config.endpoint?.match(/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/data\/[0-9a-f]{64}$/);
    if (!match || Number(match[1]) > 65535) throw new Error("插件数据会话地址无效");
    endpoint = config.endpoint;
    return endpoint;
    } finally {
      // A queued prepare IPC can begin after the first close IPC. Drain again
      // after its last response, even when close() already finished earlier.
      if (!current() && !handedOff) await invoke("close_plugin_data", { pluginId, instanceId }).catch(() => {});
    }
  }
  async function prepare() {
    try {
      await open(false);
      if (!endpoint && usage === "detected") {
        onStatus({ state: "pending", message: "此插件需要读取或保存自己的数据，请选择是否允许" });
        if (!await open(true)) throw new Error("插件数据授权未完成");
      }
      assertCurrent(); onStatus(null);
      return configuration();
    } catch (error) {
      if (current()) onStatus({ state: "error", message: "插件数据授权未完成，允许后可重新打开" });
      throw error;
    }
  }
  function request() {
    if (pending) return pending;
    onStatus({ state: "pending", message: "请在授权窗口选择是否允许访问本插件保存的数据" });
    pending = open(true).then(result => {
      if (!result) throw new Error("插件数据授权未完成");
      if (current()) onStatus({ state: "ready", message: "已允许访问本插件的数据，请再次操作或重新打开插件" });
      return result;
    }).catch(error => {
      if (current()) onStatus({ state: "error", message: "插件数据授权未完成，可重新打开后再试" });
      throw error;
    }).finally(() => { pending = undefined; });
    return pending;
  }
  async function reopen(): Promise<PluginDataConfig> {
    assertCurrent();
    const nextInstanceId = crypto.randomUUID();
    if (endpoint) {
      await invoke("rotate_plugin_data", { pluginId, instanceId, nextInstanceId });
      if (!current()) {
        await invoke("close_plugin_data", { pluginId, instanceId: nextInstanceId }).catch(() => {});
        throw new Error("Data reopen was cancelled");
      }
      handedOff = true;
    } else await close();
    closed = true;
    return { instanceId: nextInstanceId, usage };
  }
  function configuration(): PluginDataConfig { return { instanceId, endpoint, usage }; }
  return { instanceId, prepare, request, close, reopen, configuration };
}

export function dispatchPluginDataPermission(options: {
  controller: ReturnType<typeof createPluginDataController> | undefined;
  message: Record<string, unknown>; source: MessageEventSource | null;
  identity: PluginFrameIdentity; sources: PluginFrameSourceRegistry;
}): boolean {
  const { controller, message, source, identity, sources } = options;
  if (message.__atools_plugin_data_open__ !== true) return false;
  if (!controller || message.instanceId !== controller.instanceId) return true;
  void controller.request().then(endpoint => {
    postPluginFrameMessageIfCurrent({ source, identity, sources, message: {
      __atools_plugin_data_session__: true, instanceId: controller.instanceId, endpoint,
    } });
  }, () => {});
  return true;
}

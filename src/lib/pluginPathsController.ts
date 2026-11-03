import type { TaskRun } from "./types";
import type { PluginPathAccess, PluginPathsConfig } from "./pluginPathsBridge";
import type { PluginDataStatus } from "./pluginDataController";
import type { PluginFrameIdentity, PluginFrameSourceRegistry } from "./pluginInvokePolicy";

type Invoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Opening = { snapshotId?: string; permission_required?: boolean; runId?: string; tool?: string; unavailable?: boolean; usage?: string };
/** No idle work: only an active authorization waits, and paths never enter logs. */
export function createPluginPathsController(invoke: Invoke, pluginId: string, isCurrent: () => boolean,
  onStatus: (status: PluginDataStatus | null) => void, initial?: PluginPathsConfig,
  wait: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 200))) {
  const instanceId = initial?.instanceId ?? crypto.randomUUID();
  const snapshots = { ...initial?.snapshots };
  const paths: Record<string, string> = {};
  const pending = new Map<PluginPathAccess, Promise<boolean>>();
  let closed = false, requested = Boolean(initial), handedOff = false;
  let closing: Promise<unknown> | undefined;
  const current = () => !closed && isCurrent();
  function assertCurrent() { if (!current()) throw new Error("Path preparation was cancelled"); }
  function close() {
    closed = true; for (const key of Object.keys(paths)) delete paths[key];
    if (requested && !handedOff && !closing) closing = invoke("close_plugin_paths", { pluginId, instanceId }).catch(() => { console.warn("Plugin path cleanup failed"); });
    return closing ?? Promise.resolve();
  }
  async function read(access: PluginPathAccess, snapshotId: string) {
    const result = await invoke<{ paths: Record<string, string>; access: PluginPathAccess }>("get_plugin_path_snapshot", { pluginId, instanceId, snapshotId });
    assertCurrent();
    if (result.access !== access || !result.paths || typeof result.paths !== "object" || Array.isArray(result.paths)) throw new Error("Path snapshot identity mismatch");
    snapshots[access] = snapshotId; Object.assign(paths, result.paths);
  }
  async function open(access: PluginPathAccess, requestPermission: boolean): Promise<{ available: boolean; detected: boolean }> {
    assertCurrent(); requested = true;
    try {
      const existing = snapshots[access];
      if (existing) { await read(access, existing); return { available: true, detected: true }; }
      const opened = await invoke<Opening>("prepare_plugin_paths", { pluginId, instanceId, access, requestPermission });
      assertCurrent();
      if (!opened || opened.unavailable) return { available: false, detected: opened?.usage === "detected" };
      let snapshotId = opened.snapshotId;
      if (!snapshotId) {
        if (!opened.permission_required || !opened.runId || !opened.tool) throw new Error("目录路径授权未完成");
        onStatus({ state: "pending", message: access === "plugin_data" ? "请允许此插件创建自己的数据目录" : "请允许此插件读取常用目录路径" });
        while (!snapshotId) {
          await wait(); assertCurrent();
          const run: TaskRun | null = await invoke<TaskRun | null>("get_task_run", { id: opened.runId });
          assertCurrent();
          if (!run || run.id !== opened.runId || run.capabilityId !== opened.tool || run.initiator.clientId !== "atools-ui") throw new Error("目录路径授权任务已失效");
          if (run.status === "succeeded") { snapshotId = (run.output as Opening)?.snapshotId; if (!snapshotId) throw new Error("目录路径初始化未完成"); }
          else if (["failed", "cancelled", "partial"].includes(run.status)) throw new Error("目录路径授权未完成");
        }
      }
      await read(access, snapshotId); return { available: true, detected: true };
    } finally {
      // Drain an IPC that was queued behind an earlier close, including failures.
      if (!current() && !handedOff) await invoke("close_plugin_paths", { pluginId, instanceId }).catch(() => {});
    }
  }
  async function prepare() {
    try {
      for (const access of ["standard", "plugin_data"] as const) {
        const result = await open(access, false);
        if (!result.available && result.detected && !(await open(access, true)).available) throw new Error("目录路径授权未完成");
      }
      assertCurrent(); onStatus(null); return configuration();
    } catch (error) { if (current()) onStatus({ state: "error", message: "目录路径授权未完成，允许后可重新打开" }); throw error; }
  }
  function request(access: PluginPathAccess) {
    const existing = pending.get(access); if (existing) return existing;
    onStatus({ state: "pending", message: "此插件需要目录路径，请在授权后重新打开插件" });
    const task = open(access, true).then(result => {
      if (!result.available) throw new Error("目录路径授权未完成");
      if (current()) onStatus({ state: "ready", message: "已允许访问目录路径，请重新打开插件完成初始化" });
      return true;
    }).catch(error => { if (current()) onStatus({ state: "error", message: "目录路径授权未完成，可重新打开后再试" }); throw error; }).finally(() => pending.delete(access));
    pending.set(access, task); return task;
  }
  async function reopen(): Promise<PluginPathsConfig> {
    assertCurrent();
    if (pending.size) throw new Error("目录路径授权仍在进行");
    const nextInstanceId = crypto.randomUUID();
    await invoke("rotate_plugin_paths", { pluginId, instanceId, nextInstanceId });
    if (!current()) { await invoke("close_plugin_paths", { pluginId, instanceId: nextInstanceId }).catch(() => {}); throw new Error("Path reopen cancelled"); }
    handedOff = true; closed = true;
    return { instanceId: nextInstanceId, snapshots: { ...snapshots } };
  }
  function configuration(): PluginPathsConfig { return { instanceId, snapshots: { ...snapshots }, paths: { ...paths } }; }
  return { instanceId, prepare, request, close, reopen, configuration };
}

export function dispatchPluginPathsPermission(options: {
  controller?: ReturnType<typeof createPluginPathsController>; message: Record<string, unknown>;
  source: MessageEventSource | null; identity: PluginFrameIdentity; sources: PluginFrameSourceRegistry;
}): boolean {
  if (options.message.__atools_plugin_paths_open__ !== true) return false;
  if (!options.sources.isCurrent(options.source, options.identity)) return true;
  const { controller, message } = options;
  if (controller && message.instanceId === controller.instanceId && (message.access === "standard" || message.access === "plugin_data")) {
    // Do not deliver a snapshot to the old frame or replay its failed operation.
    void controller.request(message.access).catch(() => {});
  }
  return true;
}

import type { TaskRun } from "./types";
import type { PluginSecretStorageConfig } from "./pluginSecretStorageBridge";

type Invoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Opening = { sessionId?: string; permission_required?: boolean; runId?: string; tool?: string; error?: string; unavailable?: boolean };
export type SecretStorageStatus = { state: "pending" | "error"; message: string };
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Prepares one owner-bound native session before the original preload executes. */
export function createPluginSecretStorageController(
  invoke: Invoke, pluginId: string, isCurrent: () => boolean,
  onStatus: (status: SecretStorageStatus | null) => void,
  wait: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 200)),
) {
  const instanceId = crypto.randomUUID();
  let requested = false, closed = false, config: PluginSecretStorageConfig | undefined;
  let opening: Promise<PluginSecretStorageConfig> | undefined, closing: Promise<unknown> | undefined;
  const current = () => !closed && isCurrent();
  function assertCurrent() { if (!current()) throw new Error("ERR_ATOOLS_SECRET_STORAGE_CANCELLED"); }
  function closeSession() {
    if (requested && !closing) closing = invoke("close_plugin_secret_storage", { pluginId, instanceId })
      .catch(() => { console.warn("Plugin safeStorage cleanup failed"); });
    return closing ?? Promise.resolve();
  }
  function close() {
    closed = true;
    config = undefined;
    opening = undefined;
    return closeSession();
  }
  async function prepareOnce(): Promise<PluginSecretStorageConfig> {
    assertCurrent(); requested = true;
    try {
      const opened = await invoke<Opening>("prepare_plugin_secret_storage", { pluginId, instanceId, requestPermission: true });
      assertCurrent();
      if (!opened || opened.unavailable) throw new Error("ERR_ATOOLS_SECRET_STORAGE_UNAVAILABLE: 当前系统不支持安全存储");
      let sessionId = opened.sessionId;
      if (!sessionId) {
        if (!opened.permission_required || !opened.runId || !opened.tool) {
          throw new Error("ERR_ATOOLS_SECRET_STORAGE_PERMISSION");
        }
        onStatus({ state: "pending", message: "此插件需要加密保存凭据，请在授权窗口确认" });
        while (!sessionId) {
          await wait(); assertCurrent();
          const taskRun: TaskRun | null = await invoke<TaskRun | null>("get_task_run", { id: opened.runId });
          assertCurrent();
          if (!taskRun || taskRun.id !== opened.runId || taskRun.capabilityId !== opened.tool || taskRun.initiator.clientId !== "atools-ui") {
            throw new Error("ERR_ATOOLS_SECRET_STORAGE_TASK_INVALID");
          }
          if (taskRun.status === "succeeded") {
            sessionId = (taskRun.output as Opening | null)?.sessionId;
            if (!sessionId) throw new Error("ERR_ATOOLS_SECRET_STORAGE_SESSION_MISSING");
          } else if (["failed", "cancelled", "partial"].includes(taskRun.status)) {
            throw new Error("ERR_ATOOLS_SECRET_STORAGE_PERMISSION_DENIED");
          }
        }
      }
      if (!SESSION.test(sessionId)) throw new Error("ERR_ATOOLS_SECRET_STORAGE_SESSION_INVALID");
      const ready = await invoke<{ endpoint: string; available: boolean }>("get_plugin_secret_storage_session", { pluginId, instanceId, sessionId });
      assertCurrent();
      const endpoint: unknown = ready && typeof ready === "object" ? ready.endpoint : undefined;
      if (typeof endpoint !== "string") {
        throw new Error("ERR_ATOOLS_SECRET_STORAGE_SESSION_INVALID");
      }
      const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/secrets\/[0-9a-f]{64}$/.exec(endpoint);
      if (!match || Number(match[1]) > 65535 || ready.available !== true) {
        throw new Error("ERR_ATOOLS_SECRET_STORAGE_SESSION_INVALID");
      }
      return { instanceId, endpoint, available: true };
    } finally {
      // Drain a prepare that completed after its document owner was closed.
      if (!current()) await closeSession();
    }
  }
  function prepare(): Promise<PluginSecretStorageConfig> {
    if (config) return Promise.resolve(config);
    if (opening) return opening;
    opening = prepareOnce().then(value => { assertCurrent(); config = value; onStatus(null); return value; }, error => {
      if (current()) onStatus({ state: "error", message: "安全存储授权未完成，已阻止插件预加载" });
      throw error;
    });
    return opening;
  }
  function configuration() {
    if (!current()) throw new Error("ERR_ATOOLS_SECRET_STORAGE_UNAVAILABLE");
    return config;
  }
  return { instanceId, prepare, close, configuration };
}

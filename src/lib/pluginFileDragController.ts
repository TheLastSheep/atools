import type { TaskRun } from "./types";
import { isPluginFileDragEndpoint, type PluginFileDragConfig } from "./pluginFileDragBridge";

type Invoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Opening = { sessionId?: string; unavailable?: boolean; permission_required?: boolean; runId?: string; tool?: string };
export type PluginFileDragStatus = { state: "pending" | "ready" | "error"; message: string };
type Options = {
  invoke: Invoke;
  pluginId: string;
  isCurrent: () => boolean;
  pageDocumentId?: () => string | undefined;
  onStatus?: (status: PluginFileDragStatus | null) => void;
  wait?: () => Promise<void>;
  now?: () => number;
};

const MAX_PERMISSION_WAIT_MS = 120_000;
const MAX_PERMISSION_POLLS = 600;

/** One panel generation owns one document-bound file drag session. */
export function createPluginFileDragController(options: Options) {
  const instanceId = crypto.randomUUID();
  const owner = { pluginId: options.pluginId, instanceId };
  const wait = options.wait ?? (() => new Promise(resolve => setTimeout(resolve, 200)));
  const now = options.now ?? Date.now;
  let endpoint: string | undefined, closed = false, requested = false;
  let preparing: Promise<void> | undefined, closing: Promise<void> | undefined;
  let status: PluginFileDragStatus | null = null;

  function current() { return !closed && options.isCurrent(); }
  function assertCurrent() {
    if (!current()) throw Error("ERR_ATOOLS_FILE_DRAG_CANCELLED");
  }
  function publish(next: PluginFileDragStatus | null) {
    status = next;
    if (current()) options.onStatus?.(next);
  }
  function pageArgs() {
    const pageDocumentId = options.pageDocumentId?.();
    return typeof pageDocumentId === "string" && pageDocumentId ? { pageDocumentId } : {};
  }
  function sessionFrom(value: unknown): string | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const id = (value as { sessionId?: unknown }).sessionId;
    return typeof id === "string" && id.length > 0 && id.length <= 128 ? id : undefined;
  }
  function unavailableMessage(error?: unknown) {
    const reason = error instanceof Error && /timeout/i.test(error.message)
      ? "文件拖动授权等待超时"
      : error instanceof Error && /cancel/i.test(error.message)
        ? "插件已关闭"
        : "文件拖动未获授权或当前平台不支持";
    return `${reason}；插件仍可使用，允许后重新打开即可恢复`;
  }
  async function readSession(id: string) {
    assertCurrent();
    const result = await options.invoke<{ endpoint: string }>("get_plugin_file_drag_session", {
      ...owner, sessionId: id,
    });
    assertCurrent();
    if (!result || !isPluginFileDragEndpoint(result.endpoint)) throw Error("ERR_ATOOLS_FILE_DRAG_SESSION");
    endpoint = result.endpoint;
  }
  async function prepareAfterPermission(opened: Opening): Promise<string> {
    const runId = opened.runId, tool = opened.tool;
    if (!runId || !tool) throw Error("ERR_ATOOLS_FILE_DRAG_PERMISSION");
    publish({ state: "pending", message: "请允许此插件启动文件拖动" });
    const deadline = now() + MAX_PERMISSION_WAIT_MS;
    let polls = 0;
    while (true) {
      if (++polls > MAX_PERMISSION_POLLS || now() >= deadline) throw Error("ERR_ATOOLS_FILE_DRAG_TIMEOUT");
      await wait();
      assertCurrent();
      if (now() >= deadline) throw Error("ERR_ATOOLS_FILE_DRAG_TIMEOUT");
      const run: TaskRun | null = await options.invoke<TaskRun | null>("get_task_run", { id: runId });
      assertCurrent();
      if (!run || run.id !== runId || run.capabilityId !== tool || run.initiator?.clientId !== "atools-ui") {
        throw Error("ERR_ATOOLS_FILE_DRAG_TASK");
      }
      if (run.status === "succeeded") {
        let id = sessionFrom(run.output);
        if (!id) {
          const prepared = await options.invoke<Opening>("prepare_plugin_file_drag", {
            ...owner, requestPermission: false, ...pageArgs(),
          });
          assertCurrent();
          if (prepared.unavailable || prepared.permission_required) throw Error("ERR_ATOOLS_FILE_DRAG_PERMISSION");
          id = prepared.sessionId;
        }
        if (typeof id !== "string" || !id) throw Error("ERR_ATOOLS_FILE_DRAG_SESSION");
        return id;
      }
      if (["failed", "cancelled", "partial"].includes(run.status)) throw Error("ERR_ATOOLS_FILE_DRAG_DENIED");
      if (!["created", "awaiting_permission", "running"].includes(run.status)) throw Error("ERR_ATOOLS_FILE_DRAG_TASK");
    }
  }
  async function open() {
    assertCurrent();
    const opened = await options.invoke<Opening>("prepare_plugin_file_drag", {
      ...owner, requestPermission: true, ...pageArgs(),
    });
    assertCurrent();
    if (!opened || typeof opened !== "object") throw Error("ERR_ATOOLS_FILE_DRAG_RESPONSE");
    if (opened.unavailable) throw Error("ERR_ATOOLS_FILE_DRAG_UNAVAILABLE");
    let id = opened.sessionId;
    if (!id) {
      if (opened.permission_required !== true) throw Error("ERR_ATOOLS_FILE_DRAG_PERMISSION");
      id = await prepareAfterPermission(opened);
    }
    if (typeof id !== "string" || !id) throw Error("ERR_ATOOLS_FILE_DRAG_SESSION");
    await readSession(id);
  }
  async function prepare(): Promise<PluginFileDragConfig | undefined> {
    if (preparing) { await preparing; return configuration(); }
    if (!current()) return undefined;
    requested = true;
    preparing = (async () => {
      try {
        await open();
        if (current()) publish({ state: "ready", message: "文件拖动会话已就绪" });
      } catch (error) {
        if (current()) publish({ state: "error", message: unavailableMessage(error) });
      }
    })();
    await preparing;
    return configuration();
  }
  function configuration(): PluginFileDragConfig | undefined {
    return current() && endpoint ? { endpoint } : undefined;
  }
  function close() {
    if (!closed) { closed = true; endpoint = undefined; }
    if (!requested) return Promise.resolve();
    return closing ??= (async () => {
      await preparing?.catch(() => {});
      await options.invoke("close_plugin_file_drag", owner).catch(() => {
        console.warn("Plugin file drag cleanup failed");
      });
    })();
  }
  return { instanceId, prepare, configuration, status: () => status, close };
}

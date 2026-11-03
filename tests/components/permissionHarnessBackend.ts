import type { PendingAgentToolRequest, TaskRunStatus } from "../../src/lib/types";
import type { PermissionApprovalInvoke } from "../../src/lib/permissionApproval";
import type { PermissionEventListen } from "../../src/lib/permissionQueue";

/** Browser/unit fixture only: real UI, explicitly simulated IPC and task events. */
export function createPermissionHarnessBackend() {
  const requests = new Map<string, PendingAgentToolRequest>();
  const runs = new Map<string, { id: string; capabilityId: string; initiator: { clientId: string }; status: TaskRunStatus; input: unknown }>();
  const contexts = new Map<string, Record<string, unknown>>();
  const handlers = new Map<string, Set<(event: { payload: any }) => void>>();
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const failures = new Map<string, string>();
  const holds = new Map<string, Promise<void>>();
  let sequence = 0;
  const emit = (name: string, payload: unknown) => handlers.get(name)?.forEach((handler) => handler({ payload }));
  const listen: PermissionEventListen = async (name, handler) => {
    let listeners = handlers.get(name);
    if (!listeners) { listeners = new Set(); handlers.set(name, listeners); }
    listeners.add(handler);
    return () => { listeners?.delete(handler); };
  };
  const invoke: PermissionApprovalInvoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ command, args });
    await holds.get(command);
    const failure = failures.get(command);
    if (failure) { failures.delete(command); throw new Error(failure); }
    if (command === "list_pending_agent_requests") return [...requests.values()].map((request) => ({ ...request })) as T;
    if (command === "get_task_run") return (runs.get(String(args?.id)) ?? null) as T;
    if (command === "get_permission_request_context") return (contexts.get(String(args?.requestId))
      ?? { pluginName: requests.has(String(args?.requestId)) ? `示例插件 · ${args?.requestId}` : null }) as T;
    if (command === "dismiss_pending_agent_request") {
      const request = requests.get(String(args?.requestId));
      requests.delete(String(args?.requestId));
      const run = request && runs.get(request.run_id!);
      if (run?.status === "awaiting_permission") run.status = "cancelled";
      if (request) emit("permission-requests-changed", null);
      return Boolean(request) as T;
    }
    if (command === "call_agent_tool") {
      const run = runs.get(String(args?.runId));
      if (!run || run.status === "cancelled") throw new Error("任务已取消");
      run.status = "succeeded";
      emit("task-run-updated", run.id);
      return { runId: run.id, status: run.status } as T;
    }
    return undefined as T;
  };
  return {
    invoke, listen, calls, requests, runs, contexts, emit,
    add(id: string, node = false) {
      const request: PendingAgentToolRequest = {
        id, run_id: `run-${id}`, client_id: "atools-ui", tool_name: node ? `legacy_node_${id}` : `读取文件 · ${id}`,
        arguments: node ? { operation: "open", intentId: "opaque-fixture-authorization" } : { path: "/Users/demo/Documents/example.txt", encoding: "utf8" },
        scopes: node ? ["file_read", "file_write", "network", "shell", "clipboard_read", "clipboard_write", "screenshot", "browser_context", "plugin_data", "system_settings"] : ["file_read"],
        created_at: `2026-10-15T12:00:${String(sequence++).padStart(2, "0")}Z`,
      };
      requests.set(id, request);
      runs.set(request.run_id!, { id: request.run_id!, capabilityId: request.tool_name, initiator: { clientId: request.client_id }, status: "awaiting_permission", input: request.arguments });
      emit("permission-requests-changed", null);
      emit("agent-permission-request", request);
      return request;
    },
    cancel(id: string) {
      const request = requests.get(id);
      requests.delete(id);
      if (request?.run_id) { runs.get(request.run_id)!.status = "cancelled"; emit("task-run-updated", request.run_id); }
      if (request) emit("permission-requests-changed", null);
    },
    failNext(command: string, error = "数据库暂时繁忙，请重试") { failures.set(command, error); },
    hold(command: string) {
      let release!: () => void;
      holds.set(command, new Promise<void>((resolve) => { release = resolve; }));
      return () => { holds.delete(command); release(); };
    },
    listenerCount() { return [...handlers.values()].reduce((count, listeners) => count + listeners.size, 0); },
  };
}

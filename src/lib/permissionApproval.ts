import type { PendingAgentToolRequest, TaskRun, TaskRunStatus } from "./types";

export type PermissionApprovalInvoke = <T = unknown>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export type PermissionApprovalOutcome = {
  dismissed: boolean;
  error: string;
};

type ApprovalRun = Pick<TaskRun, "id" | "capabilityId" | "initiator" | "status" | "input">;
type ApprovalOptions = { remember: boolean; invoke: PermissionApprovalInvoke };
const approvingRuns = new Set<string>();
const TERMINAL_STATUSES = new Set<TaskRunStatus>(["succeeded", "partial", "failed", "cancelled"]);

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error) || "未知错误"; }
  catch { return "未知错误"; }
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => sameJson(value, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object"
    || Array.isArray(left) || Array.isArray(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index]
    && sameJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

function matchesRequest(run: ApprovalRun | null, request: PendingAgentToolRequest, runId: string): run is ApprovalRun {
  return Boolean(run && run.id === runId && run.capabilityId === request.tool_name
    && run.initiator?.clientId === request.client_id && sameJson(run.input, request.arguments));
}

async function dismissTerminal(
  request: PendingAgentToolRequest,
  invoke: PermissionApprovalInvoke,
  error = "",
): Promise<PermissionApprovalOutcome> {
  try {
    await invoke("dismiss_pending_agent_request", { requestId: request.id });
    return { dismissed: true, error };
  } catch (dismissError) {
    return { dismissed: false, error: `${error ? `${error}；` : ""}无法关闭权限请求：${message(dismissError)}` };
  }
}

/** Resume the existing pending run; never dismiss an unconfirmed or running task. */
export async function approvePendingPermission(
  request: PendingAgentToolRequest,
  options: ApprovalOptions,
): Promise<PermissionApprovalOutcome> {
  const runId = request.run_id?.trim();
  if (!runId) return { dismissed: false, error: "此权限请求缺少原任务标识，请重新发起任务。" };
  if (approvingRuns.has(runId)) return { dismissed: false, error: "此权限请求正在处理中，请稍候。" };
  approvingRuns.add(runId);
  const { invoke } = options;
  try {
    let before: ApprovalRun | null;
    try { before = await invoke<ApprovalRun | null>("get_task_run", { id: runId }); }
    catch (error) { return { dismissed: false, error: `无法确认原任务状态：${message(error)}` }; }
    if (!matchesRequest(before, request, runId)) {
      return { dismissed: false, error: "原任务与权限请求不匹配，请重新发起任务。" };
    }
    if (TERMINAL_STATUSES.has(before.status)) {
      const error = before.status === "failed" || before.status === "cancelled"
        ? `原任务已${before.status === "failed" ? "失败" : "取消"}，请从结果中心重新发起。` : "";
      return await dismissTerminal(request, invoke, error);
    }
    if (before.status !== "created" && before.status !== "awaiting_permission") {
      return { dismissed: false, error: "原任务仍在执行，权限请求已保留。" };
    }
    if (options.remember) {
      try { await invoke("grant_agent_tool", { clientId: request.client_id, toolName: request.tool_name, requestId: request.id }); }
      catch (error) { return { dismissed: false, error: `无法保存权限：${message(error)}` }; }
    }

    let executionError = "";
    try {
      await invoke("call_agent_tool", {
        name: request.tool_name,
        arguments: request.arguments,
        clientId: request.client_id,
        confirmed: true,
        runId,
      });
    } catch (error) { executionError = `执行失败：${message(error)}`; }

    let after: ApprovalRun | null;
    try { after = await invoke<ApprovalRun | null>("get_task_run", { id: runId }); }
    catch (error) {
      return { dismissed: false, error: `${executionError ? `${executionError}；` : ""}无法确认执行状态，权限请求已保留：${message(error)}` };
    }
    // Defaults are initialized before the authorization prompt is created. A
    // continuation must preserve the input the user actually reviewed.
    if (!matchesRequest(after, request, runId)) {
      return { dismissed: false, error: "无法确认原任务的执行结果，权限请求已保留。" };
    }
    if (!TERMINAL_STATUSES.has(after.status)) {
      return { dismissed: false, error: executionError || "原任务尚未完成，权限请求已保留。" };
    }
    if (!executionError && (after.status === "failed" || after.status === "cancelled")) {
      executionError = `原任务已${after.status === "failed" ? "失败" : "取消"}，请查看结果中心。`;
    }
    return await dismissTerminal(request, invoke, executionError);
  } finally {
    approvingRuns.delete(runId);
  }
}

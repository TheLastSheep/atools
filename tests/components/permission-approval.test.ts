// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { approvePendingPermission, type PermissionApprovalInvoke } from "../../src/lib/permissionApproval";
import type { PendingAgentToolRequest, TaskRunStatus } from "../../src/lib/types";

const pending = (): PendingAgentToolRequest => ({
  id: "request-1", run_id: "run-1", client_id: "atools-ui", tool_name: "plugin_start",
  arguments: { pluginId: "demo", options: { a: 1, b: 2 } }, scopes: ["shell"], created_at: "2026-10-15",
});

function setup(statuses: Array<TaskRunStatus | null> = ["awaiting_permission", "succeeded"]) {
  const request = pending();
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const perform = vi.fn(async (_command: string, _args?: Record<string, unknown>): Promise<unknown> => undefined);
  const invoke: PermissionApprovalInvoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ command, args });
    await perform(command, args);
    if (command === "get_task_run") {
      const status = statuses.shift();
      return (status ? {
        id: "run-1", capabilityId: request.tool_name, initiator: { type: "human", clientId: request.client_id },
        status, input: request.arguments,
      } : null) as T;
    }
    return undefined as T;
  };
  return { request, calls, perform, invoke };
}

describe("pending permission approval", () => {
  it("allows once by resuming the exact pending run before dismissing it", async () => {
    const f = setup();
    expect(await approvePendingPermission(f.request, { invoke: f.invoke, remember: false }))
      .toEqual({ dismissed: true, error: "" });
    expect(f.calls.map((call) => call.command)).toEqual([
      "get_task_run", "call_agent_tool", "get_task_run", "dismiss_pending_agent_request",
    ]);
    expect(f.calls[1].args).toEqual({
      name: f.request.tool_name, arguments: f.request.arguments, clientId: f.request.client_id,
      confirmed: true, runId: "run-1",
    });
    expect(f.calls[3].args).toEqual({ requestId: f.request.id });
  });

  it("remembers only this client/tool pair and then resumes, rather than merely closing", async () => {
    const f = setup();
    expect(await approvePendingPermission(f.request, { invoke: f.invoke, remember: true }))
      .toEqual({ dismissed: true, error: "" });
    expect(f.calls.map((call) => call.command)).toEqual([
      "get_task_run", "grant_agent_tool", "call_agent_tool", "get_task_run", "dismiss_pending_agent_request",
    ]);
    expect(f.calls[1].args).toEqual({ clientId: f.request.client_id, toolName: f.request.tool_name, requestId: f.request.id });
    expect(f.calls[2].args?.runId).toBe(f.request.run_id);
  });

  it("keeps a visible error and the pending request when saving the grant fails", async () => {
    const f = setup();
    f.perform.mockImplementation(async (command) => { if (command === "grant_agent_tool") throw Error("database busy"); });
    const outcome = await approvePendingPermission(f.request, { invoke: f.invoke, remember: true });
    expect(outcome).toEqual({ dismissed: false, error: "无法保存权限：database busy" });
    expect(f.calls.map((call) => call.command)).toEqual(["get_task_run", "grant_agent_tool"]);
  });

  it.each(["awaiting_permission", "running"] as const)("does not cancel a %s task after transport failure", async (status) => {
    const f = setup(["awaiting_permission", status]);
    f.perform.mockImplementation(async (command) => { if (command === "call_agent_tool") throw Error("connection lost"); });
    const outcome = await approvePendingPermission(f.request, { invoke: f.invoke, remember: false });
    expect(outcome).toEqual({ dismissed: false, error: "执行失败：connection lost" });
    expect(f.calls.some((call) => call.command === "dismiss_pending_agent_request")).toBe(false);
  });

  it("cleans up only a confirmed terminal failure while preserving the execution error", async () => {
    const f = setup(["awaiting_permission", "failed"]);
    f.perform.mockImplementation(async (command) => { if (command === "call_agent_tool") throw "operation rejected"; });
    expect(await approvePendingPermission(f.request, { invoke: f.invoke, remember: false }))
      .toEqual({ dismissed: true, error: "执行失败：operation rejected" });
    expect(f.calls.at(-1)?.command).toBe("dismiss_pending_agent_request");
  });

  it("does not equate an invoke success with a terminal original run", async () => {
    const f = setup(["awaiting_permission", "running"]);
    const outcome = await approvePendingPermission(f.request, { invoke: f.invoke, remember: false });
    expect(outcome.dismissed).toBe(false);
    expect(outcome.error).toContain("尚未完成");
    expect(f.calls).toHaveLength(3);
  });

  it("keeps pending when post-execution state cannot be verified", async () => {
    const f = setup();
    let reads = 0;
    f.perform.mockImplementation(async (command) => { if (command === "get_task_run" && ++reads === 2) throw Error("offline"); });
    const outcome = await approvePendingPermission(f.request, { invoke: f.invoke, remember: false });
    expect(outcome.dismissed).toBe(false);
    expect(outcome.error).toContain("无法确认执行状态");
    expect(f.calls.some((call) => call.command === "dismiss_pending_agent_request")).toBe(false);
  });

  it("reports cleanup failure and retries cleanup without repeating completed work", async () => {
    const f = setup(["awaiting_permission", "succeeded", "succeeded"]);
    let dismisses = 0;
    f.perform.mockImplementation(async (command) => { if (command === "dismiss_pending_agent_request" && ++dismisses === 1) throw Error("offline"); });
    const first = await approvePendingPermission(f.request, { invoke: f.invoke, remember: false });
    expect(first).toEqual({ dismissed: false, error: "无法关闭权限请求：offline" });
    expect(await approvePendingPermission(f.request, { invoke: f.invoke, remember: true }))
      .toEqual({ dismissed: true, error: "" });
    expect(f.calls.filter((call) => call.command === "call_agent_tool")).toHaveLength(1);
    expect(f.calls.some((call) => call.command === "grant_agent_tool")).toBe(false);
  });

  it("refuses requests without an original run or whose run has vanished", async () => {
    const f = setup([null]);
    expect((await approvePendingPermission({ ...f.request, run_id: null }, { invoke: f.invoke, remember: false })).error)
      .toContain("缺少原任务标识");
    expect(f.calls).toHaveLength(0);
    expect((await approvePendingPermission(f.request, { invoke: f.invoke, remember: false })).error)
      .toContain("不匹配");
    expect(f.calls).toHaveLength(1);
  });

  it("does not repeat a task already running or revive a failed terminal task", async () => {
    const running = setup(["running"]);
    expect((await approvePendingPermission(running.request, { invoke: running.invoke, remember: false })).error)
      .toContain("仍在执行");
    expect(running.calls).toHaveLength(1);
    const failed = setup(["failed"]);
    const outcome = await approvePendingPermission(failed.request, { invoke: failed.invoke, remember: true });
    expect(outcome.dismissed).toBe(true);
    expect(outcome.error).toContain("原任务已失败");
    expect(failed.calls.map((call) => call.command)).toEqual(["get_task_run", "dismiss_pending_agent_request"]);
  });

  it("checks task identity and input before allowing a continuation", async () => {
    const f = setup();
    const wrong: PermissionApprovalInvoke = async <T>() => ({
      id: "run-1", status: "awaiting_permission", capabilityId: "different-tool",
      initiator: { clientId: f.request.client_id }, input: f.request.arguments,
    }) as T;
    expect((await approvePendingPermission(f.request, { invoke: wrong, remember: false })).error).toContain("不匹配");
    const reordered: PermissionApprovalInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
      const value = await f.invoke<T>(command, args);
      if (command === "get_task_run") (value as any).input = { options: { b: 2, a: 1 }, pluginId: "demo" };
      return value;
    };
    expect((await approvePendingPermission(f.request, { invoke: reordered, remember: false })).error).toBe("");
  });

  it("rejects arguments changed before or after the authorized continuation", async () => {
    const mismatched = setup();
    const differentInput: PermissionApprovalInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
      const value = await mismatched.invoke<T>(command, args);
      if (command === "get_task_run") (value as any).input = { pluginId: "other" };
      return value;
    };
    expect((await approvePendingPermission(mismatched.request, { invoke: differentInput, remember: false })).error)
      .toContain("不匹配");
    expect(mismatched.calls).toHaveLength(1);

    const defaults = setup();
    let reads = 0;
    const withDefaults: PermissionApprovalInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
      const value = await defaults.invoke<T>(command, args);
      if (command === "get_task_run" && ++reads === 2) (value as any).input = { ...defaults.request.arguments as object, limit: 20 };
      return value;
    };
    expect(await approvePendingPermission(defaults.request, { invoke: withDefaults, remember: false }))
      .toEqual({ dismissed: false, error: "无法确认原任务的执行结果，权限请求已保留。" });
  });

  it("does not submit duplicate continuations while an approval is in flight", async () => {
    const f = setup();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    f.perform.mockImplementation(async (command) => { if (command === "call_agent_tool") await wait; });
    const first = approvePendingPermission(f.request, { invoke: f.invoke, remember: false });
    await vi.waitFor(() => expect(f.calls.some((call) => call.command === "call_agent_tool")).toBe(true));
    const second = await approvePendingPermission(f.request, { invoke: f.invoke, remember: true });
    expect(second.error).toContain("正在处理中");
    release();
    expect((await first).dismissed).toBe(true);
    expect(f.calls.filter((call) => call.command === "call_agent_tool")).toHaveLength(1);
    expect(f.calls.some((call) => call.command === "grant_agent_tool")).toBe(false);
  });
});

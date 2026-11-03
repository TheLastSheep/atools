import { get } from "svelte/store";
import { expect, it, vi } from "vitest";
import { createPermissionQueue } from "../../src/lib/permissionQueue";
import type { PermissionApprovalInvoke } from "../../src/lib/permissionApproval";
import { createPermissionHarnessBackend } from "./permissionHarnessBackend";

function executingParent() {
  const backend = createPermissionHarnessBackend();
  const parent = backend.add("parent");
  parent.tool_name = "plugin_main_push_fixed_fixture";
  parent.scopes = [];
  parent.arguments = { operation: "prepare", requestId: "fixed-request", runnerId: "fixed-runner" };
  const run = backend.runs.get(parent.run_id!)!;
  run.capabilityId = parent.tool_name; run.input = parent.arguments;
  let release!: () => void;
  const dependency = new Promise<void>(resolve => { release = resolve; });
  const resumed: Array<Record<string, unknown> | undefined> = [];
  const invoke: PermissionApprovalInvoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (command === "call_agent_tool" && args?.runId === parent.run_id) {
      resumed.push(args); run.status = "running"; backend.emit("task-run-updated", run.id);
      await dependency;
    }
    return backend.invoke<T>(command, args);
  };
  const queue = createPermissionQueue(invoke), stop = queue.connect(backend.listen);
  return { backend, parent, run, queue, stop, release, resumed };
}

it("allows a real nested approval while retaining the approved parent's exact durable continuation", async () => {
  const fixture = executingParent();
  const { backend, parent, run, queue, release, resumed } = fixture;
  let approval: Promise<void> | undefined;
  try {
    await queue.refresh();
    approval = queue.approve(parent.id);
    await vi.waitFor(() => expect(run.status).toBe("running"));
    const child = backend.add("node-dependency", true);
    await queue.refresh();
    expect(get(queue).items[0]).toMatchObject({ request: { id: child.id }, busy: false });
    expect(get(queue).items.find(item => item.request.id === parent.id)).toMatchObject({ busy: true });
    expect(backend.requests.has(parent.id)).toBe(true);
    expect(run.status).toBe("running");
    await queue.approve(child.id);
    expect(backend.runs.get(child.run_id!)!.status).toBe("succeeded");
    expect(backend.requests.has(child.id)).toBe(false);
    expect(get(queue).items[0]).toMatchObject({ request: { id: parent.id }, busy: true });
    expect(run.status).toBe("running");
    await queue.approve(parent.id); await queue.deny(parent.id);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ runId: parent.run_id, name: parent.tool_name,
      clientId: parent.client_id, arguments: parent.arguments, confirmed: true });
    release(); await approval;
    expect(run.status).toBe("succeeded");
    expect(get(queue).items).toEqual([]);
    expect(get(queue).feedback).toBeNull();
    expect(backend.calls.filter(call => call.command === "grant_agent_tool")).toEqual([]);
    expect(backend.calls.filter(call => call.command === "call_agent_tool").map(call => call.args?.runId))
      .toEqual([child.run_id, parent.run_id]);
  } finally {
    release(); await approval; fixture.stop();
    expect(backend.listenerCount()).toBe(0);
  }
});

it("keeps pending decisions in creation order and never transfers a running parent's busy state or denial", async () => {
  const fixture = executingParent();
  const { backend, parent, run, queue, release } = fixture;
  let approval: Promise<void> | undefined;
  try {
    await queue.refresh(); approval = queue.approve(parent.id);
    await vi.waitFor(() => expect(run.status).toBe("running"));
    const first = backend.add("first-dependency", true), second = backend.add("second-dependency", true);
    await queue.refresh();
    expect(get(queue).items.map(item => item.request.id)).toEqual([first.id, second.id, parent.id]);
    await queue.deny(first.id);
    expect(get(queue).items[0]).toMatchObject({ request: { id: second.id }, busy: false, error: "" });
    expect(backend.runs.get(first.run_id!)!.status).toBe("cancelled");
    expect(run.status).toBe("running");
    await queue.deny(second.id);
    expect(get(queue).items[0]).toMatchObject({ request: { id: parent.id }, busy: true, error: "" });
    backend.cancel(parent.id); await queue.refresh(); release(); await approval;
    expect(get(queue).items).toEqual([]);
    expect(get(queue).feedback).toMatchObject({ tool: parent.tool_name, error: expect.stringContaining("取消") });
  } finally { release(); await approval; fixture.stop(); }
});

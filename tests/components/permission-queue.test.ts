import { describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import { createPermissionQueue } from "../../src/lib/permissionQueue";
import { createPermissionHarnessBackend } from "./permissionHarnessBackend";
import type { PermissionApprovalInvoke } from "../../src/lib/permissionApproval";

describe("permission request reconciliation", () => {
  it("reconciles terminal dismissal in both windows without a TaskRun update and preserves local failure feedback", async () => {
    const backend = createPermissionHarnessBackend();
    let finishDismiss!: () => void;
    const dismissReply = new Promise<void>((resolve) => { finishDismiss = resolve; });
    const invoke: PermissionApprovalInvoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      const result = await backend.invoke<T>(command, args);
      if (command === "dismiss_pending_agent_request") await dismissReply;
      return result;
    };
    const approvingWindow = createPermissionQueue(invoke);
    const otherWindow = createPermissionQueue(backend.invoke);
    const stops = [approvingWindow.connect(backend.listen), otherWindow.connect(backend.listen)];
    backend.add("terminal");
    await Promise.all([approvingWindow.refresh(), otherWindow.refresh()]);
    backend.runs.get("run-terminal")!.status = "failed";
    const approval = approvingWindow.approve("terminal");
    await vi.waitFor(() => expect(backend.requests.has("terminal")).toBe(false));
    await vi.waitFor(() => expect(get(otherWindow).items).toEqual([]));
    expect(get(approvingWindow).items[0]).toMatchObject({ request: { id: "terminal" }, busy: true });
    finishDismiss(); await approval;
    expect(get(approvingWindow).items).toEqual([]);
    expect(get(approvingWindow).feedback?.error).toContain("原任务已失败");
    expect(get(otherWindow).feedback).toBeNull();
    // No task execution/status event or timer is needed to retire a terminal entry.
    expect(backend.calls.some((call) => call.command === "call_agent_tool")).toBe(false);
    stops.forEach((stop) => stop());
    expect(backend.listenerCount()).toBe(0);
  });

  it("coalesces queue notifications received during an authoritative read", async () => {
    const backend = createPermissionHarnessBackend();
    const queue = createPermissionQueue(backend.invoke);
    const stop = queue.connect(backend.listen);
    backend.add("dismissed"); await queue.refresh();
    const release = backend.hold("list_pending_agent_requests");
    const refreshing = queue.refresh();
    backend.requests.delete("dismissed");
    const before = backend.calls.filter((call) => call.command === "list_pending_agent_requests").length;
    for (let index = 0; index < 50; index++) backend.emit("permission-requests-changed", null);
    expect(backend.calls.filter((call) => call.command === "list_pending_agent_requests")).toHaveLength(before);
    release(); await refreshing;
    expect(get(queue).items).toEqual([]);
    expect(backend.calls.filter((call) => call.command === "list_pending_agent_requests")).toHaveLength(before + 1);
    stop();
  });

  it("has no idle polling after both windows have reconciled", async () => {
    const backend = createPermissionHarnessBackend();
    const queues = [createPermissionQueue(backend.invoke), createPermissionQueue(backend.invoke)];
    const stops = queues.map((queue) => queue.connect(backend.listen));
    await Promise.all(queues.map((queue) => queue.refresh()));
    vi.useFakeTimers();
    try {
      const before = backend.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(backend.calls).toHaveLength(before);
    } finally {
      stops.forEach((stop) => stop());
      vi.useRealTimers();
    }
  });

  it("removes a backend-cancelled dialog and does no work for unrelated task events", async () => {
    const backend = createPermissionHarnessBackend();
    const queue = createPermissionQueue(backend.invoke);
    const stop = queue.connect(backend.listen);
    backend.add("closed-plugin", true);
    await queue.refresh();
    expect(get(queue).items).toHaveLength(1);
    const before = backend.calls.length;
    backend.emit("task-run-updated", "some-other-task");
    expect(backend.calls).toHaveLength(before);
    backend.cancel("closed-plugin");
    await queue.refresh();
    expect(get(queue).items).toEqual([]);
    stop();
    expect(backend.listenerCount()).toBe(0);
  });
  it("treats a late request event as invalidation and never republishes its cancelled dialog", async () => {
    const backend = createPermissionHarnessBackend();
    const queue = createPermissionQueue(backend.invoke);
    const stop = queue.connect(backend.listen);
    await queue.refresh();
    const request = backend.add("already-closed");
    await queue.refresh();
    backend.cancel("already-closed"); await queue.refresh();
    const snapshots: unknown[] = [];
    const unsubscribe = queue.subscribe(value => snapshots.push(value.items.map(item => item.request.id)));
    const release = backend.hold("list_pending_agent_requests");
    backend.emit("agent-permission-request", request);
    expect(get(queue).items).toEqual([]);
    release(); await queue.refresh();
    expect(snapshots.every(items => Array.isArray(items) && items.length === 0)).toBe(true);
    unsubscribe(); stop();
  });

  it("does not apply a late approval result or error to the next queued request", async () => {
    const backend = createPermissionHarnessBackend();
    const queue = createPermissionQueue(backend.invoke);
    const stop = queue.connect(backend.listen);
    backend.add("first"); backend.add("second");
    await queue.refresh();
    const release = backend.hold("call_agent_tool");
    const approval = queue.approve("first");
    await vi.waitFor(() => expect(backend.calls.some((call) => call.command === "call_agent_tool")).toBe(true));
    expect(get(queue).items.find(item => item.request.id === "first")?.busy).toBe(true);
    expect(get(queue).items[0]).toMatchObject({ request: { id: "second" }, busy: false });
    backend.cancel("first");
    await queue.refresh();
    expect(get(queue).items[0]).toMatchObject({ request: { id: "second" }, busy: false, error: "" });
    release(); await approval;
    expect(get(queue).items[0]).toMatchObject({ request: { id: "second" }, busy: false, error: "" });
    expect(get(queue).feedback).toBeNull();
    stop();
  });

  it("preserves busy state through snapshots, prevents double submission and exposes retryable grant errors", async () => {
    const backend = createPermissionHarnessBackend();
    const queue = createPermissionQueue(backend.invoke);
    const stop = queue.connect(backend.listen);
    backend.add("first"); await queue.refresh();
    backend.failNext("grant_agent_tool");
    await queue.approve("first", true);
    expect(get(queue).items[0]).toMatchObject({ busy: false, error: expect.stringContaining("数据库暂时繁忙") });
    const release = backend.hold("call_agent_tool");
    const approval = queue.approve("first");
    await vi.waitFor(() => expect(backend.calls.some((call) => call.command === "call_agent_tool")).toBe(true));
    await queue.refresh();
    await queue.approve("first", true);
    await queue.deny("first");
    expect(get(queue).items[0].busy).toBe(true);
    expect(backend.calls.filter((call) => call.command === "call_agent_tool")).toHaveLength(1);
    release(); await approval;
    expect(get(queue).items).toEqual([]);
    stop();
  });

  it("keeps a new request event that arrives while an older snapshot is loading", async () => {
    const backend = createPermissionHarnessBackend();
    let resolve!: (requests: unknown[]) => void;
    const queue = createPermissionQueue(async <T>(command: string) => command === "list_pending_agent_requests"
      ? new Promise<T>((done) => { resolve = done as any; }) : { pluginName: null } as T);
    const loading = queue.refresh();
    queue.upsert(backend.add("new"));
    resolve([]); await loading;
    expect(get(queue).items[0].request.id).toBe("new");
  });

  it("loads context only for the visible request, caches it and ignores a cancelled request's late name", async () => {
    const backend = createPermissionHarnessBackend();
    let resolveFirst!: (context: { pluginName: string }) => void;
    const firstContext = new Promise<{ pluginName: string }>((resolve) => { resolveFirst = resolve; });
    const contextCalls: string[] = [];
    const invoke: PermissionApprovalInvoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command === "get_permission_request_context") {
        contextCalls.push(String(args?.requestId));
        if (args?.requestId === "first") return await firstContext as T;
      }
      return backend.invoke<T>(command, args);
    };
    const queue = createPermissionQueue(invoke);
    const stop = queue.connect(backend.listen);
    backend.add("first", true); backend.add("second", true);
    await queue.refresh();
    expect(contextCalls).toEqual(["first"]);
    backend.cancel("first"); await queue.refresh();
    await vi.waitFor(() => expect(get(queue).items[0].displayName).toBe("示例插件 · second"));
    resolveFirst({ pluginName: "已经关闭的插件" });
    await Promise.resolve(); await queue.refresh(); await queue.refresh();
    expect(get(queue).items[0]).toMatchObject({ request: { id: "second" }, displayName: "示例插件 · second" });
    expect(contextCalls).toEqual(["first", "second"]);
    stop();
  });

  it("keeps a missing plugin context optional and never retries it on every task event", async () => {
    const backend = createPermissionHarnessBackend();
    backend.failNext("get_permission_request_context", "unavailable");
    const queue = createPermissionQueue(backend.invoke);
    const stop = queue.connect(backend.listen);
    backend.add("first", true); await queue.refresh(); await queue.refresh();
    expect(get(queue).items[0]).toMatchObject({ busy: false, displayName: null });
    expect(backend.calls.filter((call) => call.command === "get_permission_request_context")).toHaveLength(1);
    await queue.deny("first");
    expect(get(queue).items).toEqual([]);
    stop();
  });
});

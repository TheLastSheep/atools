import { describe, expect, it, vi } from "vitest";
import { createPluginDisplayController, dispatchPluginDisplayPermission } from "../../src/lib/pluginDisplayController";
import { PluginFrameSourceRegistry } from "../../src/lib/pluginInvokePolicy";
const instanceId = "display-fixture", endpoint = "http://127.0.0.1:54321/display/" + "b".repeat(64);
const permission = { permission_required: true, runId: "display-run", tool: "display-tool" };
const approved: any = { id: "display-run", capabilityId: "display-tool", initiator: { clientId: "atools-ui" }, status: "succeeded", output: { sessionId: "native-session" } };
describe("display permission controller", () => {
  it("requests permission before preload only on a detected callsite and reads endpoint after exact approval", async () => {
    const statuses: any[] = [], invoke: any = vi.fn(async (command, args) => {
      if (command === "prepare_plugin_display") return args.requestPermission ? permission : { unavailable: true, usage: "detected" };
      if (command === "get_task_run") return approved; if (command === "get_plugin_display_session") return { endpoint };
    });
    const controller = createPluginDisplayController(invoke, "plugin", () => true, status => statuses.push(status), undefined, async () => {});
    expect(await controller.prepare()).toMatchObject({ endpoint, sessionId: "native-session" });
    expect(invoke.mock.calls.filter(([c]: any) => c === "prepare_plugin_display").map(([, a]: any) => a.requestPermission)).toEqual([false, true]);
    expect(statuses.at(-1)).toBeNull(); await controller.close(); expect(controller.configuration().endpoint).toBeUndefined();
  });
  it.each(["not_detected", "unknown"])("does no idle polling or prompt for %s source usage", async usage => {
    const invoke: any = vi.fn(async () => ({ unavailable: true, usage }));
    const controller = createPluginDisplayController(invoke, "plugin", () => true, vi.fn());
    expect((await controller.prepare()).endpoint).toBeUndefined(); expect(invoke.mock.calls).toHaveLength(1); expect(invoke.mock.calls[0][1].requestPermission).toBe(false);
    await controller.close();
  });
  it("bounds an active approval to 600 polls and a 120 second deadline", async () => {
    let clock = 0; const active = { ...approved, status: "awaiting_permission" };
    const invoke: any = vi.fn(async command => command === "prepare_plugin_display" ? permission : active);
    const wait = vi.fn(async () => {});
    const controller = createPluginDisplayController(invoke, "plugin", () => true, vi.fn(), undefined, wait, () => clock);
    await expect(controller.prepare()).rejects.toThrow("超时"); expect(wait).toHaveBeenCalledTimes(600);
    const deadline = createPluginDisplayController(invoke, "plugin", () => true, vi.fn(), undefined, async () => { clock += 120_000; }, () => clock);
    const before = invoke.mock.calls.length; await expect(deadline.prepare()).rejects.toThrow("超时");
    expect(invoke.mock.calls.length - before).toBe(1); await controller.close(); await deadline.close();
  });
  it("rejects malformed unknown TaskRun status instead of polling forever", async () => {
    const invoke: any = vi.fn(async command => command === "prepare_plugin_display" ? permission : { ...approved, status: "invented" });
    const controller = createPluginDisplayController(invoke, "plugin", () => true, vi.fn(), undefined, async () => {});
    await expect(controller.prepare()).rejects.toThrow("状态无效"); await controller.close();
  });
  it("uses saved grants without requesting permission", async () => {
    const invoke: any = vi.fn(async command => command === "prepare_plugin_display" ? { sessionId: "saved" } : { endpoint });
    const controller = createPluginDisplayController(invoke, "plugin", () => true, vi.fn()); await controller.prepare();
    expect(invoke.mock.calls.map(([c]: any) => c)).toEqual(["prepare_plugin_display", "get_plugin_display_session"]); await controller.close();
  });
  it.each(["wrong-id", "wrong-capability", "wrong-initiator", "failed", "cancelled", "partial", "missing-output"])("rejects %s approval identity or terminal outcome", async kind => {
    const run = structuredClone(approved); if (kind === "wrong-id") run.id = "other"; if (kind === "wrong-capability") run.capabilityId = "other";
    if (kind === "wrong-initiator") run.initiator.clientId = "other"; if (["failed", "cancelled", "partial"].includes(kind)) run.status = kind;
    if (kind === "missing-output") run.output = {};
    const invoke: any = vi.fn(async command => command === "prepare_plugin_display" ? permission : run);
    await expect(createPluginDisplayController(invoke, "plugin", () => true, vi.fn(), undefined, async () => {}).prepare()).rejects.toThrow();
    expect(invoke.mock.calls.some(([c]: any) => c === "get_plugin_display_session")).toBe(false);
  });
  it("deduplicates dynamic permission request and never posts endpoint credentials to a frame", async () => {
    let finish!: (value: any) => void; const invoke: any = vi.fn(command => command === "prepare_plugin_display" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ endpoint }));
    const controller = createPluginDisplayController(invoke, "plugin", () => true, vi.fn()); const first = controller.request(); expect(controller.request()).toBe(first);
    finish({ sessionId: "saved" }); await first; expect(invoke.mock.calls).toHaveLength(2); await controller.close();
  });
  it("authenticates frame generation and exact instance before dynamic request", async () => {
    const source: any = { postMessage: vi.fn() }, sources = new PluginFrameSourceRegistry(); sources.setMain(source); const identity = sources.identify(source)!;
    const request = vi.fn(async () => true), controller = { instanceId, request } as any;
    const dispatch = (id: string) => dispatchPluginDisplayPermission({ controller, sources, source, identity, message: { __atools_plugin_display_open__: true, instanceId: id, coordinate: "never-forwarded" } });
    expect(dispatch("other")).toBe(true); expect(request).not.toHaveBeenCalled(); dispatch(instanceId); expect(request.mock.calls).toEqual([[]]);
    sources.setMain({}); dispatch(instanceId); expect(request).toHaveBeenCalledTimes(1); expect(source.postMessage).not.toHaveBeenCalled();
  });
  it("drains late initialization after close without storing an endpoint", async () => {
    let resolve!: (value: any) => void; const invoke: any = vi.fn(command => command === "prepare_plugin_display" ? new Promise(done => { resolve = done; }) : Promise.resolve());
    const controller = createPluginDisplayController(invoke, "plugin", () => true, vi.fn()); const opening = controller.prepare(); await controller.close(); resolve({ sessionId: "late" });
    await expect(opening).rejects.toThrow("cancelled"); expect(controller.configuration().endpoint).toBeUndefined();
    expect(invoke.mock.calls.map(([c]: any) => c)).toEqual(["prepare_plugin_display", "close_plugin_display", "close_plugin_display"]);
  });
  it("rotates to a new native ID and resolves it by successor owner without stale credentials", async () => {
    let owner = instanceId, id = "old-native-id";
    const invoke: any = vi.fn(async (command, args) => {
      if (command === "rotate_plugin_display") { expect(args.instanceId).toBe(owner); owner = args.nextInstanceId; id = "replacement-id"; }
      if (command === "prepare_plugin_display") { expect(args.instanceId).toBe(owner); expect(args.requestPermission).toBe(false); return { sessionId: id }; }
      if (command === "get_plugin_display_session") { if (args.instanceId !== owner || args.sessionId !== id) throw new Error("expired session"); return { endpoint }; }
    });
    const controller = createPluginDisplayController(invoke, "plugin", () => true, vi.fn(), { instanceId, sessionId: id, endpoint });
    await controller.prepare(); const next = await controller.reopen(); await controller.close();
    expect(next.instanceId).not.toBe(instanceId); expect(next.sessionId).toBeUndefined(); expect(next.endpoint).toBeUndefined();
    const successor = createPluginDisplayController(invoke, "plugin", () => true, vi.fn(), next); await successor.prepare();
    expect(successor.configuration().sessionId).toBe("replacement-id");
    expect(invoke.mock.calls.map(([c]: any) => c)).toEqual(["get_plugin_display_session", "rotate_plugin_display", "prepare_plugin_display", "get_plugin_display_session"]); await successor.close();
  });
  it("reopens an unused plugin without rotating a nonexistent native session", async () => {
    const invoke: any = vi.fn(async command => { if (command === "rotate_plugin_display") throw new Error("No sessions to rotate"); return { unavailable: true, usage: "not_detected" }; });
    const controller = createPluginDisplayController(invoke, "plugin", () => true, vi.fn());
    await controller.prepare(); const next = await controller.reopen();
    const successor = createPluginDisplayController(invoke, "plugin", () => true, vi.fn(), next); await successor.prepare();
    expect(invoke.mock.calls.map(([c]: any) => c)).toEqual(["prepare_plugin_display", "close_plugin_display", "prepare_plugin_display"]);
    await successor.close();
  });
  it("cleans a successor when current ownership disappears during rotation", async () => {
    let current = true; const invoke: any = vi.fn(async command => { if (command === "close_plugin_display") current = false; });
    const controller = createPluginDisplayController(invoke, "plugin", () => current, vi.fn(), { instanceId });
    await expect(controller.reopen()).rejects.toThrow("cancelled"); expect(invoke.mock.calls.at(-1)[0]).toBe("close_plugin_display");
  });
});

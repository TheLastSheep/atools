import { describe, it, expect, vi } from "vitest";
import { createPluginDataController, dispatchPluginDataPermission } from "../../src/lib/pluginDataController";
import { reopenPluginHost } from "../../src/lib/pluginHostReopen";
import { PluginFrameSourceRegistry } from "../../src/lib/pluginInvokePolicy";

const endpoint = "http://127.0.0.1:12345/data/" + "a".repeat(64);
const approved = { id: "run", capabilityId: "tool", initiator: { clientId: "atools-ui" }, status: "succeeded", output: { sessionId: "session" } };
const permission = { permission_required: true, runId: "run", tool: "tool", usage: "detected" };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

describe("plugin data startup and approval ownership", () => {
  it("authorizes detected use before startup and obtains the bearer separately after approval", async () => {
    const waiting = deferred(), status = vi.fn();
    const invoke: any = vi.fn(async (command, args) => {
      if (command === "prepare_plugin_data") return args.requestPermission ? permission : { usage: "detected", unavailable: true };
      if (command === "get_task_run") return approved;
      if (command === "get_plugin_data_session") return { endpoint };
    });
    const controller = createPluginDataController(invoke, "plugin", () => true, status, undefined, () => waiting.promise);
    let ready = false;
    const preparation = controller.prepare().then(config => { ready = true; return config; });
    await vi.waitFor(() => expect(status).toHaveBeenCalledWith(expect.objectContaining({ state: "pending" })));
    expect(ready).toBe(false);
    expect(invoke.mock.calls.map(([command]: any) => command)).not.toContain("get_plugin_data_session");
    waiting.resolve();
    expect((await preparation).endpoint).toBe(endpoint);
    expect(invoke.mock.calls.filter(([command]: any) => command === "prepare_plugin_data").map(([, args]: any) => args.requestPermission)).toEqual([false, true]);
    expect(status).toHaveBeenLastCalledWith(null);
    expect(JSON.stringify(invoke.mock.calls)).not.toContain(endpoint);
    await controller.close();
  });
  it.each(["not_detected", "unknown"])("does not request permission or open a session for %s source", async usage => {
    const invoke: any = vi.fn(async () => ({ usage, unavailable: true }));
    const controller = createPluginDataController(invoke, "plugin", () => true, vi.fn());
    expect((await controller.prepare()).endpoint).toBeUndefined();
    expect(invoke.mock.calls).toHaveLength(1);
    expect(invoke.mock.calls[0][1].requestPermission).toBe(false);
    await controller.close();
  });
  it("deduplicates a dynamic request without sending any document or key", async () => {
    const waiting = deferred();
    const invoke: any = vi.fn(async command => command === "prepare_plugin_data" ? permission : command === "get_task_run" ? approved : { endpoint });
    const controller = createPluginDataController(invoke, "plugin", () => true, vi.fn(), undefined, () => waiting.promise);
    const one = controller.request(), two = controller.request();
    expect(one).toBe(two);
    await Promise.resolve(); waiting.resolve();
    expect(await one).toBe(endpoint);
    expect(invoke.mock.calls.filter(([name]: any) => name === "prepare_plugin_data")).toHaveLength(1);
    expect(Object.keys(invoke.mock.calls[0][1]).sort()).toEqual(["instanceId", "pluginId", "requestPermission"]);
    await controller.close();
  });
  it("cancels a late approval and never retrieves its bearer", async () => {
    const waiting = deferred();
    const invoke: any = vi.fn(async () => permission);
    const controller = createPluginDataController(invoke, "plugin", () => true, vi.fn(), undefined, () => waiting.promise);
    const request = controller.request();
    await Promise.resolve(); await controller.close(); waiting.resolve();
    await expect(request).rejects.toThrow("cancelled");
    expect(invoke.mock.calls.map(([name]: any) => name)).toEqual(["prepare_plugin_data", "close_plugin_data", "close_plugin_data"]);
  });
  it("drains a prepare IPC which registers after an already completed close", async () => {
    let resolve!: (value: unknown) => void;
    const invoke: any = vi.fn(command => command === "prepare_plugin_data" ? new Promise(done => { resolve = done; }) : Promise.resolve());
    const controller = createPluginDataController(invoke, "plugin", () => true, vi.fn());
    const preparation = controller.prepare();
    await controller.close();
    expect(invoke.mock.calls.map(([name]: any) => name)).toEqual(["prepare_plugin_data", "close_plugin_data"]);
    resolve({ sessionId: "late-session", usage: "detected" });
    await expect(preparation).rejects.toThrow("cancelled");
    expect(invoke.mock.calls.map(([name]: any) => name)).toEqual(["prepare_plugin_data", "close_plugin_data", "close_plugin_data"]);
  });
  it.each([
    { ...approved, capabilityId: "other" }, { ...approved, initiator: { clientId: "external" } },
    { ...approved, status: "cancelled" }, { ...approved, output: {} },
  ])("rejects an unrelated or unsuccessful approval", async run => {
    const invoke: any = vi.fn(async command => command === "prepare_plugin_data" ? permission : run);
    const controller = createPluginDataController(invoke, "plugin", () => true, vi.fn(), undefined, async () => {});
    await expect(controller.request()).rejects.toThrow();
    expect(invoke.mock.calls.map(([name]: any) => name)).not.toContain("get_plugin_data_session");
    await controller.close();
  });
  it("drains the rotated successor when the panel changes during manual reopen", async () => {
    const waiting = deferred(); let live = true;
    const invoke: any = vi.fn(async command => { if (command === "rotate_plugin_data") await waiting.promise; });
    const controller = createPluginDataController(invoke, "plugin", () => live, vi.fn(), { instanceId: "old", endpoint });
    const reopening = controller.reopen(); live = false; waiting.resolve();
    await expect(reopening).rejects.toThrow("cancelled");
    const successor = invoke.mock.calls[0][1].nextInstanceId;
    expect(successor).not.toBe("old");
    expect(invoke.mock.calls).toContainEqual(["close_plugin_data", { pluginId: "plugin", instanceId: successor }]);
  });
  it("ignores stale instance requests and does not deliver endpoints to a replaced frame", async () => {
    const sources = new PluginFrameSourceRegistry();
    const source = { postMessage: vi.fn() }, replacement = { postMessage: vi.fn() };
    sources.setMain(source);
    const identity = sources.identify(source)!;
    let resolve!: (value: string) => void;
    const controller: any = { instanceId: "current", request: vi.fn(() => new Promise<string>(done => { resolve = done; })) };
    const dispatch = (instanceId: string) => dispatchPluginDataPermission({ controller, source: source as unknown as Window, sources, identity, message: { __atools_plugin_data_open__: true, instanceId } });
    dispatch("old"); expect(controller.request).not.toHaveBeenCalled();
    dispatch("current"); sources.setMain(replacement); resolve(endpoint);
    await Promise.resolve();
    expect(source.postMessage).not.toHaveBeenCalled();
    expect(replacement.postMessage).not.toHaveBeenCalled();
  });
});

describe("manual host reopen transfers approvals together", () => {
  it("preserves both one-time approvals without reusing their bearer endpoints", async () => {
    const invoke = vi.fn();
    const next = await reopenPluginHost({ clipboard: { reopen: async () => ({ instanceId: "clipboard-next" }) }, data: { reopen: async () => ({ instanceId: "data-next" }) }, current: () => true, pluginId: "plugin", invoke });
    expect(next).toEqual({ clipboard: { instanceId: "clipboard-next" }, data: { instanceId: "data-next" } });
    expect(invoke).not.toHaveBeenCalled();
  });
  it.each([false, true])("closes successful successors after a partial transfer or stale panel (%s)", async stale => {
    const invoke = vi.fn(async () => {});
    await expect(reopenPluginHost({ clipboard: { reopen: async () => ({ instanceId: "clipboard-next" }) }, data: { reopen: async () => { if (!stale) throw new Error("transfer failed"); return { instanceId: "data-next" }; } }, current: () => !stale, pluginId: "plugin", invoke })).rejects.toThrow();
    expect(invoke).toHaveBeenCalledWith("close_host_clipboard", { pluginId: "plugin", instanceId: "clipboard-next" });
    if (stale) expect(invoke).toHaveBeenCalledWith("close_plugin_data", { pluginId: "plugin", instanceId: "data-next" });
  });
  it("cleans a completed data transfer with the original plugin identity when another transfer finishes late", async () => {
    const waiting = deferred(), invoke = vi.fn(async () => {});
    let live = true;
    const options = { clipboard: { reopen: async () => { await waiting.promise; throw new Error("cancelled"); } }, data: { reopen: async () => ({ instanceId: "A-next" }) }, current: () => live, pluginId: "A", invoke };
    const reopening = reopenPluginHost(options);
    await Promise.resolve(); live = false; options.pluginId = "B"; waiting.resolve();
    await expect(reopening).rejects.toThrow();
    expect(invoke.mock.calls).toEqual([["close_plugin_data", { pluginId: "A", instanceId: "A-next" }]]);
  });
});

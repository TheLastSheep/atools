import { describe, expect, it, vi } from "vitest";
import { createPluginPathsBridge, pluginPathsBridgeScript } from "../../src/lib/pluginPathsBridge";
import { createPluginPathsController, dispatchPluginPathsPermission } from "../../src/lib/pluginPathsController";
import { PluginFrameSourceRegistry } from "../../src/lib/pluginInvokePolicy";
import { createPluginElectronAdapter } from "../../src/lib/pluginElectronAdapter";
import { reopenPluginHost } from "../../src/lib/pluginHostReopen";
import path from "node:path";

const instanceId = "06a042c7-f1dd-4f5d-bb2d-74ac91a17571";
const permission = { permission_required: true, runId: "path-run", tool: "path-tool" };
const approved: any = { id: "path-run", capabilityId: "path-tool", initiator: { clientId: "atools-ui" }, status: "succeeded", output: { snapshotId: "snapshot" } };

describe("actual synchronous directory metadata", () => {
  it("supports an original synchronous path.join and both host aliases without IPC per read", () => {
    const request = vi.fn();
    const bridge = createPluginPathsBridge({ instanceId, paths: { downloads: "/temporary/downloads", userData: "/temporary/host", pluginData: "/temporary/plugin" } }, request);
    expect(path.join(bridge.getPath("downloads"), "file.txt")).toBe("/temporary/downloads/file.txt");
    const electron = createPluginElectronAdapter({ application: { name: "ATools", version: "test" }, getPath: bridge.getPath });
    expect(electron.app.getPath("userData")).toBe("/temporary/host");
    for (let i = 0; i < 1200; i++) expect(bridge.getPath("pluginData")).toBe("/temporary/plugin");
    expect(request).not.toHaveBeenCalled();
  });
  it("does not invent paths, promises or replay an unknown dynamic call", () => {
    const request = vi.fn(); const bridge = createPluginPathsBridge({ instanceId }, request);
    expect(bridge.getPath("cache")).toBe(""); expect(bridge.getPath("../home")).toBe("");
    expect(() => bridge.getPath("downloads")).toThrow("重新打开");
    expect(() => bridge.getPath("downloads")).toThrow("重新打开");
    expect(() => bridge.getPath("pluginData")).toThrow("重新打开");
    expect(request.mock.calls).toEqual([["standard"], ["plugin_data"]]);
    bridge.close(); expect(() => bridge.getPath("home")).toThrow("已关闭");
  });
  it("validates the metadata budget and serializes an isolated reader without leaked script markup", () => {
    expect(() => createPluginPathsBridge({ instanceId, paths: { downloads: "x".repeat(16385) } }, vi.fn())).toThrow("Invalid path metadata");
    const config = { instanceId, paths: { downloads: "/safe/</script>/downloads" } };
    const script = pluginPathsBridgeScript(config).replace(/^<script[^>]*>\n/, "").replace(/\n<\/script>$/, "");
    expect(script).not.toContain("</script>");
    const host: any = { utools: {}, ztools: {}, parent: { postMessage: vi.fn() }, addEventListener: vi.fn() };
    new Function("window", script)(host);
    expect(host.utools.getPath("downloads")).toBe(config.paths.downloads);
    expect(host.ztools.getPath).toBe(host.utools.getPath);
    expect(host.__atoolsSystemPaths.getPath).toBe(host.utools.getPath);
  });
});

describe("path snapshot authorization and lifetime", () => {
  it("only reads a private snapshot after approval and keeps unused plugins without a snapshot", async () => {
    const statuses: any[] = [];
    const invoke: any = vi.fn(async (command, args) => {
      if (command === "prepare_plugin_paths") return args.access === "plugin_data" ? { unavailable: true, usage: "not_detected" } : args.requestPermission ? permission : { unavailable: true, usage: "detected" };
      if (command === "get_task_run") return approved;
      if (command === "get_plugin_path_snapshot") return { access: "standard", paths: { downloads: "/safe/downloads" } };
    });
    const controller = createPluginPathsController(invoke, "fixture", () => true, s => statuses.push(s), undefined, async () => {});
    expect((await controller.prepare()).paths).toEqual({ downloads: "/safe/downloads" });
    expect(invoke.mock.calls.filter(([name]: any) => name === "prepare_plugin_paths").map(([, a]: any) => [a.access, a.requestPermission])).toEqual([["standard", false], ["standard", true], ["plugin_data", false]]);
    expect(statuses.at(-1)).toBeNull();
    await controller.close(); expect(invoke.mock.calls.at(-1)[0]).toBe("close_plugin_paths");
  });
  it("does not authorize or fetch paths for not-detected/unknown source usage", async () => {
    const invoke: any = vi.fn(async () => ({ unavailable: true, usage: "unknown" }));
    const controller = createPluginPathsController(invoke, "fixture", () => true, vi.fn());
    expect((await controller.prepare()).paths).toEqual({});
    expect(invoke.mock.calls.every(([, args]: any) => args.requestPermission === false)).toBe(true);
    await controller.close();
  });
  it("drains a late preparation after close and never mounts its paths", async () => {
    let resolve!: (value: unknown) => void;
    const invoke: any = vi.fn(command => command === "prepare_plugin_paths" ? new Promise(done => { resolve = done; }) : Promise.resolve());
    const controller = createPluginPathsController(invoke, "fixture", () => true, vi.fn());
    const opening = controller.prepare(); await controller.close(); resolve({ snapshotId: "late" });
    await expect(opening).rejects.toThrow("cancelled");
    expect(invoke.mock.calls.map(([c]: any) => c)).toEqual(["prepare_plugin_paths", "close_plugin_paths", "close_plugin_paths"]);
    expect(controller.configuration().paths).toEqual({});
  });
  it("rejects a replaced approval and posts no async result to the old frame", async () => {
    const source: any = { postMessage: vi.fn() }; const sources = new PluginFrameSourceRegistry(); sources.setMain(source);
    const identity = sources.identify(source)!;
    const request = vi.fn(async () => true);
    expect(dispatchPluginPathsPermission({ controller: { instanceId, request } as any, message: { __atools_plugin_paths_open__: true, instanceId, access: "standard" }, source, identity, sources })).toBe(true);
    await Promise.resolve(); expect(request).toHaveBeenCalledWith("standard"); expect(source.postMessage).not.toHaveBeenCalled();
    sources.setMain({}); dispatchPluginPathsPermission({ controller: { instanceId, request } as any, message: { __atools_plugin_paths_open__: true, instanceId, access: "plugin_data" }, source, identity, sources });
    expect(request).toHaveBeenCalledTimes(1);
    const invoke: any = vi.fn(async c => c === "prepare_plugin_paths" ? permission : { ...approved, capabilityId: "wrong" });
    await expect(createPluginPathsController(invoke, "fixture", () => true, vi.fn(), undefined, async () => {}).prepare()).rejects.toThrow("已失效");
  });
  it("transfers the private snapshot to a fresh generation on explicit reopen", async () => {
    const invoke: any = vi.fn(async c => c === "get_plugin_path_snapshot" ? { access: "standard", paths: { home: "/fixture" } } : undefined);
    const controller = createPluginPathsController(invoke, "fixture", () => true, vi.fn(), { instanceId, snapshots: { standard: "snapshot" } });
    await controller.request("standard"); const next = await controller.reopen(); await controller.close();
    expect(next.instanceId).not.toBe(instanceId); expect(next.paths).toBeUndefined(); expect(next.snapshots).toEqual({ standard: "snapshot" });
    expect(invoke.mock.calls.map(([c]: any) => c)).toEqual(["get_plugin_path_snapshot", "rotate_plugin_paths"]);
  });
  it("cleans a path successor if another approval transfer fails", async () => {
    const invoke = vi.fn(async () => {});
    await expect(reopenPluginHost({ pluginId: "fixture", invoke, current: () => true,
      clipboard: { reopen: async () => { throw new Error("closed"); } }, paths: { reopen: async () => ({ instanceId }) },
    })).rejects.toThrow("cancelled");
    expect(invoke).toHaveBeenCalledWith("close_plugin_paths", { pluginId: "fixture", instanceId });
  });
});

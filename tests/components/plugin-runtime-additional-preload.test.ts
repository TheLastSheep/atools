// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createPluginRuntimePreload } from "../../src/lib/pluginRuntimePreload";

const endpoint = `http://127.0.0.1:1234/node/${"a".repeat(64)}`;
const options = (source = "module.exports=require('node:crypto')") => ({
  pluginDir: "/plugins/demo", preloadPath: "/plugins/demo/preload.js", readTextFile: async () => source,
});
const native = () => vi.fn(async (command: string) => command === "prepare_legacy_node" ? { sessionId: "session" } : { endpoint });

describe("additional hosted preload graphs", () => {
  it("shares a single authorized Node environment across parent and concurrent child graphs", async () => {
    const invoke = native(), loader = createPluginRuntimePreload(invoke as any, "demo", () => true);
    const [parent, first, second] = await Promise.all([
      loader.prepare(options()), loader.prepareAdditional(options()), loader.prepareAdditional(options()),
    ]);
    for (const html of [parent, first, second]) {
      expect(html.indexOf("data-atools-node-modules")).toBeLessThan(html.indexOf("data-atools-plugin-preload"));
    }
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(["prepare_legacy_node", "get_legacy_node_session"]);
    await loader.close();
    expect(invoke.mock.calls.filter(([name]) => name === "close_legacy_node")).toHaveLength(1);
  });

  it("does not request Node for additional pure Electron or local graphs", async () => {
    const invoke = native(), loader = createPluginRuntimePreload(invoke as any, "demo", () => true);
    await loader.prepareAdditional(options("window.ipcRenderer=require('electron').ipcRenderer"));
    await loader.prepareAdditional(options("module.exports=42"));
    await loader.close(); expect(invoke).not.toHaveBeenCalled();
  });

  it("does not close or poison a live parent when a child preload is missing", async () => {
    const invoke = native(), loader = createPluginRuntimePreload(invoke as any, "demo", () => true);
    await loader.prepare(options());
    await expect(loader.prepareAdditional({ ...options(), readTextFile: async () => { throw Error("ERR_ATOOLS_PRELOAD_NOT_FOUND"); } }))
      .rejects.toThrow("NOT_FOUND");
    expect(invoke.mock.calls.some(([name]) => name === "close_legacy_node")).toBe(false);
    expect(await loader.prepareAdditional(options())).toContain("data-atools-node-modules");
    expect(invoke.mock.calls.filter(([name]) => name === "prepare_legacy_node")).toHaveLength(1);
    await loader.close();
  });

  it("cancels a child graph before requesting Node if its own document became stale", async () => {
    let childCurrent = true;
    const invoke = native(), loader = createPluginRuntimePreload(invoke as any, "demo", () => true);
    await expect(loader.prepareAdditional({ ...options(), isCurrent: () => childCurrent,
      readTextFile: async () => { childCurrent = false; return "require('node:fs')"; },
    })).rejects.toThrow("CANCELLED");
    expect(invoke).not.toHaveBeenCalled();
    expect(await loader.prepareAdditional(options("module.exports=42"))).toContain("data-atools-plugin-preload");
    await loader.close();
  });

  it("does not inject a child after it becomes stale during shared authorization", async () => {
    let childCurrent = true, grant!: (value: unknown) => void;
    const invoke = vi.fn((name: string) => name === "prepare_legacy_node"
      ? new Promise(resolve => { grant = resolve; }) : Promise.resolve({ endpoint }));
    const loader = createPluginRuntimePreload(invoke as any, "demo", () => true);
    const pending = loader.prepareAdditional({ ...options(), isCurrent: () => childCurrent });
    await vi.waitFor(() => expect(grant).toBeTypeOf("function")); childCurrent = false; grant({ sessionId: "session" });
    await expect(pending).rejects.toThrow("CANCELLED");
    expect(invoke.mock.calls.some(([name]) => name === "close_legacy_node")).toBe(false);
    expect(await loader.prepareAdditional(options())).toContain("data-atools-node-modules");
    await loader.close();
  });

  it("never replays a rejected Node request for another child", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "prepare_legacy_node") throw Error("permission denied");
    });
    const loader = createPluginRuntimePreload(invoke as any, "demo", () => true);
    await expect(loader.prepareAdditional(options())).rejects.toThrow("permission denied");
    await expect(loader.prepareAdditional(options())).rejects.toThrow("permission denied");
    expect(invoke.mock.calls.filter(([name]) => name === "prepare_legacy_node")).toHaveLength(1);
    expect(await loader.prepareAdditional(options("module.exports=42"))).toContain("data-atools-plugin-preload");
    await loader.close();
  });

  it("does not let a child-supplied current predicate revive the closed parent", async () => {
    const invoke = native(), loader = createPluginRuntimePreload(invoke as any, "demo", () => true);
    await loader.close();
    const read = vi.fn(async () => "require('node:fs')");
    await expect(loader.prepareAdditional({ ...options(), isCurrent: () => true, readTextFile: read })).rejects.toThrow("CANCELLED");
    expect(read).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
  });
});

// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createPluginRuntimePreload } from "../../src/lib/pluginRuntimePreload";
import { selectedNodePreloadAnchor } from "../../src/lib/pluginNodeSelectedPreload";

const endpoint = `http://127.0.0.1:1234/node/${"a".repeat(64)}`;
const parent = { pluginDir: "/plugins/demo", preloadPath: "/plugins/demo/preload.js",
  readTextFile: async () => "window.electron=require('electron')" };
const child = { ...parent, preloadPath: "/plugins/demo/child/preload-app.js",
  readTextFile: async () => "window.read=()=>require('fs').readFileSync('fixture')" };

function native() {
  return vi.fn(async (command: string, _args?: Record<string, unknown>) =>
    command === "prepare_legacy_node" ? { sessionId: "child-session" } : { endpoint });
}

describe("child-only Node preload selection", () => {
  it("sends only the selected package anchor when a pure Electron parent first opens a Node child", async () => {
    const invoke = native(), runtime = createPluginRuntimePreload(invoke as any, "demo", () => true);
    expect(await runtime.prepare(parent)).not.toContain("data-atools-node-modules");
    expect(invoke).not.toHaveBeenCalled();
    const html = await runtime.prepareAdditional(child);
    const args = invoke.mock.calls[0][1];
    expect(args).toEqual({ pluginId: "demo", instanceId: expect.any(String), selectedPreload: "child/preload-app.js" });
    expect(JSON.stringify(args)).not.toContain("/plugins/");
    expect(html.indexOf("data-atools-node-modules")).toBeLessThan(html.indexOf("data-atools-plugin-preload"));
    await runtime.close();
  });

  it("concurrent child-only Node loads share one pending approval and one environment", async () => {
    let grant!: (value: unknown) => void;
    const invoke = vi.fn((command: string, _args?: Record<string, unknown>) => command === "prepare_legacy_node"
      ? new Promise(resolve => { grant = resolve; }) : Promise.resolve({ endpoint }));
    const runtime = createPluginRuntimePreload(invoke as any, "demo", () => true);
    await runtime.prepare(parent);
    const first = runtime.prepareAdditional(child), second = runtime.prepareAdditional(child);
    await vi.waitFor(() => expect(grant).toBeTypeOf("function"));
    expect(invoke.mock.calls).toHaveLength(1);
    grant({ sessionId: "child-session" });
    expect(await first).toContain("data-atools-node-modules");
    expect(await second).toContain("data-atools-node-modules");
    expect(invoke.mock.calls.filter(([name]) => name === "get_legacy_node_session")).toHaveLength(1);
    await runtime.close();
  });

  it("keeps a main-preload session's existing anchor when a later Node child opens", async () => {
    const invoke = native(), runtime = createPluginRuntimePreload(invoke as any, "demo", () => true);
    await runtime.prepare({ ...parent, readTextFile: async () => "require('crypto')" });
    expect(invoke.mock.calls[0][1]).not.toHaveProperty("selectedPreload");
    await runtime.prepareAdditional(child);
    expect(invoke.mock.calls.filter(([name]) => name === "prepare_legacy_node")).toHaveLength(1);
    expect(invoke.mock.calls.filter(([name]) => name === "close_legacy_node")).toHaveLength(0);
    await runtime.close();
  });

  it.each(["failed", "cancelled", "expired"])("does not inject or replay a %s child authorization", async status => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "prepare_legacy_node") return { permission_required: true, runId: "run", tool: "legacy-node" };
      if (command === "get_task_run") return status === "expired" ? null : {
        id: "run", capabilityId: "legacy-node", initiator: { clientId: "atools-ui" }, status,
      };
    });
    const runtime = createPluginRuntimePreload(invoke as any, "demo", () => true, async () => {});
    await runtime.prepare(parent);
    await expect(runtime.prepareAdditional(child)).rejects.toThrow();
    await expect(runtime.prepareAdditional(child)).rejects.toThrow();
    expect(invoke.mock.calls.filter(([name]) => name === "prepare_legacy_node")).toHaveLength(1);
    expect(invoke.mock.calls.filter(([name]) => name === "get_legacy_node_session")).toHaveLength(0);
    await runtime.close();
  });

  it("does not inject after panel navigation while selected-child approval was pending", async () => {
    let current = true, grant!: (value: unknown) => void;
    const invoke = vi.fn((command: string) => command === "prepare_legacy_node"
      ? new Promise(resolve => { grant = resolve; }) : Promise.resolve({ endpoint }));
    const runtime = createPluginRuntimePreload(invoke as any, "demo", () => current);
    const pending = runtime.prepareAdditional(child);
    await vi.waitFor(() => expect(grant).toBeTypeOf("function"));
    current = false; grant({ sessionId: "late-session" });
    await expect(pending).rejects.toThrow("CANCELLED");
    expect(invoke.mock.calls.filter(([name]) => name === "get_legacy_node_session")).toHaveLength(0);
    expect(invoke.mock.calls.filter(([name]) => name === "close_legacy_node")).toHaveLength(1);
  });

  it("normalizes portable package anchors and rejects root-prefix collisions", () => {
    expect(selectedNodePreloadAnchor({ pluginDir: "C:\\plugins\\demo", preloadPath: "C:\\plugins\\demo\\child\\.\\preload.js" }))
      .toBe("child/preload.js");
    expect(selectedNodePreloadAnchor({ ...parent, preloadPath: "/plugins/demo/child/../preload-app.js" })).toBe("preload-app.js");
    for (const preloadPath of ["/plugins/demolition/preload.js", "/outside/preload.js", "/plugins/demo", "preload.js"]) {
      expect(() => selectedNodePreloadAnchor({ ...parent, preloadPath })).toThrow();
    }
  });
});

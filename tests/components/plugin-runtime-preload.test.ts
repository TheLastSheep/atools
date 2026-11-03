// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createPluginRuntimePreload } from "../../src/lib/pluginRuntimePreload";
import type { TaskRun } from "../../src/lib/types";

const endpoint = `http://127.0.0.1:1234/node/${"a".repeat(64)}`;
const options = (source = "module.exports=require('node:crypto')") => ({
  pluginDir: "/plugins/demo", preloadPath: "/plugins/demo/preload.js",
  readTextFile: async () => source,
});
const run = (status: TaskRun["status"], extra = {}) => ({
  id: "run", capabilityId: "legacy_node_demo", initiator: { clientId: "atools-ui" },
  status, output: { sessionId: "session" }, ...extra,
});

describe("plugin runtime preload lifecycle", () => {
  it("keeps pure web and local Electron preloads free of Node startup", async () => {
    for (const source of ["module.exports = 42", "module.exports=require('electron')"]) {
      const invoke = vi.fn();
      const loader = createPluginRuntimePreload(invoke, "demo", () => true);
      expect(await loader.prepare(options(source))).toContain("data-atools-plugin-preload");
      await loader.close();
      expect(invoke).not.toHaveBeenCalled();
    }
  });

  it("awaits safeStorage authorization after bounded source analysis and before exposing preload code", async () => {
    const order: string[] = [];
    const loader = createPluginRuntimePreload(vi.fn(), "demo", () => true);
    const html = await loader.prepare({ ...options("const { safeStorage } = require('electron'); module.exports = safeStorage.isEncryptionAvailable();"),
      onSafeStorageRequired: async () => { order.push("authorized"); } });
    order.push("preload-returned");
    expect(order).toEqual(["authorized", "preload-returned"]);
    expect(html).toContain("data-atools-plugin-preload");
    await loader.close();
  });

  it("preflights safeStorage found only in a bounded local ESM source through the authorized Node bridge", async () => {
    const order: string[] = [];
    const invoke = vi.fn(async (command: string) => command === "prepare_legacy_node"
      ? { sessionId: "node-session" } : { endpoint });
    const loader = createPluginRuntimePreload(invoke, "demo", () => true);
    const html = await loader.prepare({
      ...options("window.services={load:()=>import('./secret.js')};"),
      readTextFile: async path => path.endsWith("secret.js")
        ? "const {safeStorage}=window.__atoolsNodeModuleRequire('electron'); export const available=safeStorage.isEncryptionAvailable();"
        : "window.services={load:()=>import('./secret.js')};",
      onSafeStorageRequired: async () => { order.push("authorized"); },
    });
    order.push("preload-returned");
    expect(order).toEqual(["authorized", "preload-returned"]);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["prepare_legacy_node", "get_legacy_node_session"]);
    expect(html.indexOf("data-atools-node-modules")).toBeLessThan(html.indexOf("data-atools-plugin-preload"));
    await loader.close();
  });

  it("rejects ESM Electron imports explicitly without falsely preparing safeStorage", async () => {
    const preflight = vi.fn(async () => {});
    const loader = createPluginRuntimePreload(vi.fn(), "demo", () => true);
    await expect(loader.prepare({
      ...options("window.services={load:()=>import('./secret.js')};"),
      readTextFile: async path => path.endsWith("secret.js")
        ? "import {safeStorage} from 'electron'; export const available=safeStorage.isEncryptionAvailable();"
        : "window.services={load:()=>import('./secret.js')};",
      onSafeStorageRequired: preflight,
    })).rejects.toThrow("ESM_ELECTRON_UNSUPPORTED");
    expect(preflight).not.toHaveBeenCalled();
  });

  it("rejects statically detected safeStorage use in an independent child before returning its preload", async () => {
    const loader = createPluginRuntimePreload(vi.fn(), "demo", () => true);
    await expect(loader.prepareAdditional({ ...options("const { safeStorage } = require('electron'); module.exports = safeStorage;"),
      onSafeStorageRequired: async () => { throw new Error("parent session must not be reused"); } })).rejects.toThrow("CHILD_UNSUPPORTED");
  });

  it("does not return or execute a preload when safeStorage preflight is denied", async () => {
    const loader = createPluginRuntimePreload(vi.fn(), "demo", () => true);
    await expect(loader.prepare({ ...options("const { safeStorage } = require('electron'); module.exports = safeStorage;"),
      onSafeStorageRequired: async () => { throw new Error("ERR_ATOOLS_SECRET_STORAGE_PERMISSION_DENIED"); } }))
      .rejects.toThrow("PERMISSION_DENIED");
  });

  it("opens once, injects real modules before local preload and keeps the endpoint out of open arguments", async () => {
    const invoke = vi.fn(async (command: string) => command === "prepare_legacy_node"
      ? { sessionId: "session" } : { endpoint });
    const loader = createPluginRuntimePreload(invoke as any, "demo", () => true);
    const html = await loader.prepare(options());
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["prepare_legacy_node", "get_legacy_node_session"]);
    expect(html.indexOf("data-atools-node-modules")).toBeLessThan(html.indexOf("data-atools-plugin-preload"));
    expect(html).toContain("window.Buffer = window.require('buffer').Buffer");
    expect(JSON.stringify(invoke.mock.calls[0])).not.toContain(endpoint);
    await loader.close();
    await loader.close();
    expect(invoke.mock.calls.filter(([name]) => name === "close_legacy_node")).toHaveLength(1);
  });

  it("prefetches a literal self-contained ESM without requesting Node authorization", async () => {
    const invoke = vi.fn();
    const loader = createPluginRuntimePreload(invoke, "demo", () => true);
    const html = await loader.prepare({ ...options(), readTextFile: async path => path.endsWith("core.js")
      ? "export const value=42" : "window.services={load:()=>import('./core.js')}" });
    expect(html).toContain("window.__atoolsImportModule=");
    expect(html).toContain('__atoolsImportModule.bind(null,"/plugins/demo/preload.js")');
    expect(invoke).not.toHaveBeenCalled(); await loader.close();
  });

  it("requires authorization before executing computed local imports", async () => {
    const invoke = vi.fn(async (name: string) => name === "prepare_legacy_node" ? { sessionId: "session" } : { endpoint });
    const loader = createPluginRuntimePreload(invoke as any, "demo", () => true);
    const html = await loader.prepare(options("window.services={load:path=>import(path)}"));
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(["prepare_legacy_node", "get_legacy_node_session"]);
    expect(html.indexOf("data-atools-node-modules")).toBeLessThan(html.indexOf("__atoolsImportModule="));
    await loader.close();
  });

  it("waits for approval of the same run and then loads its session", async () => {
    const states = [run("awaiting_permission"), run("running"), run("succeeded")];
    const invoke = vi.fn(async (command: string) => {
      if (command === "prepare_legacy_node") return { permission_required: true, runId: "run", tool: "legacy_node_demo" };
      if (command === "get_task_run") return states.shift();
      return { endpoint };
    });
    const wait = vi.fn(async () => {});
    await createPluginRuntimePreload(invoke as any, "demo", () => true, wait).prepare(options());
    expect(wait).toHaveBeenCalledTimes(3);
    expect(invoke.mock.calls.filter(([name]) => name === "prepare_legacy_node")).toHaveLength(1);
  });

  it.each([
    run("succeeded", { id: "wrong" }), run("succeeded", { capabilityId: "wrong" }),
    run("succeeded", { initiator: { clientId: "other" } }), run("succeeded", { output: {} }),
    run("cancelled", { summary: "已拒绝授权" }), null,
  ])("does not inject a mismatched or unsuccessful authorization result", async (result) => {
    const invoke = vi.fn(async (command: string) => command === "prepare_legacy_node"
      ? { permission_required: true, runId: "run", tool: "legacy_node_demo" } : result);
    const loader = createPluginRuntimePreload(invoke as any, "demo", () => true, async () => {});
    await expect(loader.prepare(options())).rejects.toThrow();
    expect(invoke.mock.calls.some(([name]) => name === "get_legacy_node_session")).toBe(false);
    expect(invoke.mock.calls.some(([name]) => name === "close_legacy_node")).toBe(true);
  });

  it("uses distinct instance ids so late cleanup cannot close a newly opened panel", async () => {
    let resolveOpen!: (value: unknown) => void;
    const invoke = vi.fn((command: string) => command === "prepare_legacy_node"
      ? new Promise((resolve) => { resolveOpen = resolve; }) : Promise.resolve({ endpoint }));
    const old = createPluginRuntimePreload(invoke as any, "demo", () => true);
    const loading = old.prepare(options());
    await vi.waitFor(() => expect(resolveOpen).toBeTypeOf("function"));
    await old.close();
    const oldArgs = (invoke.mock.calls as unknown[][]).find(([name]) => name === "prepare_legacy_node")?.[1];
    resolveOpen({ sessionId: "old" });
    await expect(loading).rejects.toThrow("CANCELLED");
    const freshInvoke = vi.fn(async (name: string) => name === "prepare_legacy_node" ? { sessionId: "new" } : { endpoint });
    await createPluginRuntimePreload(freshInvoke as any, "demo", () => true).prepare(options());
    expect((freshInvoke.mock.calls as unknown[][])[0][1]).not.toEqual(oldArgs);
    expect(invoke.mock.calls.some(([name]) => name === "get_legacy_node_session")).toBe(false);
  });

  it("starts the audited Node session for a detected no-preload page without executing the page as preload", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "plugin_legacy_node_usage") return { usage: "detected", requiresNode: true, entryMode: "page" };
      if (command === "prepare_legacy_node") return { sessionId: "session" };
      return { endpoint };
    });
    const loader = createPluginRuntimePreload(invoke as any, "demo", () => true);
    const environment = await loader.preparePage();
    expect(invoke.mock.calls.map(([name]) => name)).toEqual([
      "plugin_legacy_node_usage", "prepare_legacy_node", "get_legacy_node_session",
    ]);
    expect(invoke.mock.calls[0][1]).toEqual({ pluginId: "demo" });
    expect(environment).toContain("data-atools-node-modules");
    expect(environment).not.toContain("data-atools-plugin-preload");
    await loader.close();
  });

  it.each([
    { usage: "not_detected", requiresNode: false, entryMode: null },
    { usage: "unknown", requiresNode: true, entryMode: "page" },
    { usage: "detected", requiresNode: false, entryMode: "page" },
    { usage: "detected", requiresNode: true, entryMode: "preload" },
    { usage: "detected", requiresNode: true, entryMode: null },
  ])("does not start Node for untrusted page analysis %#", async (usage) => {
    const invoke = vi.fn(async () => usage);
    const loader = createPluginRuntimePreload(invoke as any, "demo", () => true);
    expect(await loader.preparePage()).toBe("");
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(["plugin_legacy_node_usage"]);
    await loader.close();
  });

  it("treats page analysis failures as unknown without requesting Node permission", async () => {
    const invoke = vi.fn(async () => { throw new Error("analysis unavailable"); });
    const loader = createPluginRuntimePreload(invoke as any, "demo", () => true);
    expect(await loader.preparePage()).toBe("");
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(["plugin_legacy_node_usage"]);
    await loader.close();
  });

  it("cancels a pending page analysis without opening or replaying a Node request", async () => {
    let resolveUsage!: (value: unknown) => void;
    const invoke = vi.fn((command: string) => command === "plugin_legacy_node_usage"
      ? new Promise((resolve) => { resolveUsage = resolve; }) : Promise.resolve({ endpoint }));
    const loader = createPluginRuntimePreload(invoke as any, "demo", () => true);
    const pending = loader.preparePage();
    await vi.waitFor(() => expect(resolveUsage).toBeTypeOf("function"));
    await loader.close();
    resolveUsage({ usage: "detected", requiresNode: true, entryMode: "page" });
    await expect(pending).rejects.toThrow("CANCELLED");
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(["plugin_legacy_node_usage"]);
  });
});

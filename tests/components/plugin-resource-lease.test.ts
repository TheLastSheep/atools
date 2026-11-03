import { describe, expect, it, vi } from "vitest";
import { createPluginResourceLease, packageRelativeResourcePath, pluginLeaseResourceUrl } from "../../src/lib/pluginResourceLease";
import { preparePluginHtmlResources } from "../../src/lib/pluginResourceHtml";

const token = "12345678-1234-4abc-8abc-123456789abc";
const response = { sessionId: token, pluginRoot: "/private/plugins/example" };
function fixture(invoke = vi.fn(async (command: string) => command === "prepare_plugin_resources" ? response : undefined)) {
  return { invoke, lease: createPluginResourceLease({ invoke: invoke as never, pluginId: "example", pluginRoot: "/plugins/example",
    isCurrent: () => true, convertFileSrc: (_path, protocol) => `${protocol}://localhost/` }) };
}

describe("generation-scoped module resource leases", () => {
  it("does not allocate anything for unused/classic plugin loads or close", async () => {
    const { invoke, lease } = fixture();
    await preparePluginHtmlResources('<script defer src="app.js"></script>', { pluginDir: "/plugins/example", mainFile: "index.html",
      convertFileSrc: path => "asset://localhost/" + path, readTextFile: vi.fn(), resolveModuleSrc: lease.resolveModuleSrc });
    await lease.close(); expect(invoke).not.toHaveBeenCalled();
  });
  it("shares one lazy preparation across concurrent modules and revokes once", async () => {
    const { invoke, lease } = fixture();
    const [first, second] = await Promise.all([lease.resolveModuleSrc("/plugins/example/assets/entry.js"), lease.resolveModuleSrc("/plugins/example/assets/other.js")]);
    expect(first).toBe(`atools-plugin://localhost/${token}/assets/entry.js`);
    expect(new URL("./lazy.js", first).href).toBe(`atools-plugin://localhost/${token}/assets/lazy.js`);
    expect(second.endsWith("/assets/other.js")).toBe(true);
    expect(invoke.mock.calls.filter(([command]) => command === "prepare_plugin_resources")).toHaveLength(1);
    await Promise.all([lease.close(), lease.close()]);
    expect(invoke.mock.calls.filter(([command]) => command === "close_plugin_resources")).toHaveLength(1);
    expect(invoke.mock.calls[0][1]).toEqual(invoke.mock.calls[1][1]);
    await expect(lease.resolveModuleSrc("/plugins/example/assets/entry.js")).rejects.toThrow("CANCELLED");
  });
  it("prepares the host-private instance id through the same lazy opening", async () => {
    const { invoke, lease } = fixture();
    const [prepared, moduleUrl] = await Promise.all([
      lease.prepare(),
      lease.resolveModuleSrc("/plugins/example/app.js"),
    ]);
    expect(prepared).toMatchObject({ sessionId: token, pluginRoot: response.pluginRoot });
    expect(prepared.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(moduleUrl).toBe(`atools-plugin://localhost/${token}/app.js`);
    expect(invoke.mock.calls.filter(([command]) => command === "prepare_plugin_resources")).toHaveLength(1);
    await lease.close();
  });
  it("rejects a host prepare whose shared opening resolves after close", async () => {
    let finish!: (value: typeof response) => void;
    const invoke = vi.fn((command: string) => command === "prepare_plugin_resources"
      ? new Promise(resolve => { finish = resolve; }) : Promise.resolve());
    const { lease } = fixture(invoke as never);
    const pending = lease.prepare();
    const closing = lease.close();
    finish(response);
    await expect(pending).rejects.toThrow("CANCELLED");
    await closing;
    expect(invoke.mock.calls.filter(([command]) => command === "close_plugin_resources")).toHaveLength(1);
  });
  it("releases a late prepare response after close or generation invalidation", async () => {
    let finish!: (value: typeof response) => void;
    const invoke = vi.fn((command: string) => command === "prepare_plugin_resources" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve());
    const { lease } = fixture(invoke as never);
    const pending = lease.resolveModuleSrc("/plugins/example/app.js");
    const closing = lease.close(); finish(response);
    await expect(pending).rejects.toThrow("CANCELLED"); await closing;
    expect(invoke.mock.calls.filter(([command]) => command === "close_plugin_resources")).toHaveLength(1);
    let current = true;
    const other = createPluginResourceLease({ invoke: vi.fn(async () => { current = false; return response; }) as never,
      pluginId: "example", pluginRoot: "/plugins/example", isCurrent: () => current, convertFileSrc: () => "atools-plugin://localhost/" });
    await expect(other.resolveModuleSrc("app.js")).rejects.toThrow("CANCELLED");
  });
  it("does not request an unauthorized path and decodes URL path segments only once", async () => {
    const { invoke, lease } = fixture();
    for (const path of ["/plugins/other/file.js", "../outside.js", "assets/%2e%2e/out.js", "assets/%2fsecret.js", "assets/%5csecret.js", "assets/%00.js"])
      await expect(lease.resolveModuleSrc(path)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    expect(packageRelativeResourcePath("/plugins/example", "assets/file%20name.js")).toBe("assets/file name.js");
    expect(packageRelativeResourcePath("/plugins/example", "assets/%252e%252e.js")).toBe("assets/%2e%2e.js");
    expect(packageRelativeResourcePath("C:\\Plugins\\Example", "c:\\plugins\\example\\assets\\app.js")).toBe("assets/app.js");
  });
  it("preserves module attributes and query bytes through the scoped converter", async () => {
    const { invoke, lease } = fixture(), read = vi.fn();
    const html = await preparePluginHtmlResources('<script type="module" crossorigin src="./assets/hello%20world.js?v=a%2Fb#exact"></script>', {
      pluginDir: "/plugins/example", mainFile: "index.html", convertFileSrc: () => "asset://unused", readTextFile: read,
      resolveModuleSrc: lease.resolveModuleSrc });
    const script = new DOMParser().parseFromString(html, "text/html").querySelector("script")!;
    expect(script.src).toBe(`atools-plugin://localhost/${token}/assets/hello%20world.js?v=a%2Fb#exact`);
    expect(script.type).toBe("module"); expect(script.hasAttribute("crossorigin")).toBe(true);
    expect(read).not.toHaveBeenCalled(); await lease.close(); expect(invoke).toHaveBeenCalledTimes(2);
  });
  it("keeps directory separators on Windows custom scheme aliases and validates session/origin", () => {
    for (const origin of ["http://atools-plugin.localhost/", "https://atools-plugin.localhost/"]) {
      const url = pluginLeaseResourceUrl(origin, token, "assets/中文 %.js");
      expect(new URL("./lazy.js", url).pathname).toBe(`/${token}/assets/lazy.js`);
      expect(url).toContain("%E4%B8%AD%E6%96%87%20%25.js");
    }
    expect(() => pluginLeaseResourceUrl("https://attacker.invalid", token, "app.js")).toThrow();
    expect(() => pluginLeaseResourceUrl("atools-plugin://localhost/", "../escape", "app.js")).toThrow();
  });
  it("resolves a nested child document from its own directory using the same lease", async () => {
    const { invoke, lease } = fixture();
    const main = await lease.resolveModuleSrc("/plugins/example/assets/entry.js");
    const html = await preparePluginHtmlResources('<script type="module" src="./assets/child.js"></script>', {
      pluginDir: "/plugins/example", mainFile: "/plugins/example/pages/child.html", resourceResolution: "legacy",
      convertFileSrc: () => "asset://unused", readTextFile: vi.fn(), resolveModuleSrc: lease.resolveModuleSrc });
    expect(main).toBe(`atools-plugin://localhost/${token}/assets/entry.js`);
    expect(new DOMParser().parseFromString(html, "text/html").querySelector("script")!.src)
      .toBe(`atools-plugin://localhost/${token}/pages/assets/child.js`);
    expect(invoke).toHaveBeenCalledTimes(1); await lease.close();
  });
});

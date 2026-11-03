// @vitest-environment node
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { pluginBrowserWindowPreloadPath, preparePluginBrowserWindowPreload } from "../../src/lib/pluginBrowserWindowPreload";
import { createPluginRuntimePreload } from "../../src/lib/pluginRuntimePreload";

const root = "/plugins/demo";
const path = (preload: unknown, pluginDir = root) => pluginBrowserWindowPreloadPath(pluginDir, { webPreferences: { preload } });

describe("hosted BrowserWindow preload preparation", () => {
  it("resolves local scripts from the plugin root rather than the child HTML directory", () => {
    expect(path("base/js/preload.js")).toBe(`${root}/base/js/preload.js`);
    expect(path(`${root}/preload.js`)).toBe(`${root}/preload.js`);
    expect(path("base/../preload.js")).toBe(`${root}/preload.js`);
    expect(path("base/插件 #?.js ")).toBe(`${root}/base/插件 #?.js `);
    expect(path("base\\js\\preload.js", "C:\\plugins\\demo")).toBe("C:/plugins/demo/base/js/preload.js");
  });

  it.each([null, 1, {}, "", "   ", "../outside.js", "/plugins/demo-other/preload.js", root,
    "../../outside.js", "https://example.com/a.js", "file:///plugins/demo/a.js", "data:text/javascript,x",
    "//server/share.js", "C:relative.js", "a\0.js", "x".repeat(8193)])
  ("rejects invalid or escaping declared preload paths before any reader %#", async (preload) => {
    const read = vi.fn(), prepare = vi.fn();
    await expect(preparePluginBrowserWindowPreload({ pluginDir: root, options: { webPreferences: { preload } },
      prepare, readTextFile: read, isCurrent: () => true })).rejects.toThrow("PRELOAD_PATH");
    expect(read).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  });

  it("performs no reads or runtime preparation when no preload was requested", async () => {
    const read = vi.fn(), prepare = vi.fn();
    for (const options of [{}, { webPreferences: {} }]) {
      expect(await preparePluginBrowserWindowPreload({ pluginDir: root, options, prepare, readTextFile: read, isCurrent: () => true })).toBe("");
    }
    expect(read).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  });

  it("requires the captured creator/navigation to remain current through preparation", async () => {
    let current = true;
    const prepare = vi.fn(async () => { current = false; return "<script>old</script>"; });
    await expect(preparePluginBrowserWindowPreload({ pluginDir: root, options: { webPreferences: { preload: "preload.js" } },
      prepare, readTextFile: vi.fn(), isCurrent: () => current })).rejects.toThrow("CANCELLED");
    expect(prepare.mock.calls).toHaveLength(1);
  });

  it("executes the complete original short Electron preload before original inline page code without Node", async () => {
    const original = await readFile("ZTools-plugins/plugins/pomodoro-timer/base/js/preload.js", "utf8");
    const invoke = vi.fn(), runtime = createPluginRuntimePreload(invoke, "demo", () => true);
    const script = await preparePluginBrowserWindowPreload({ pluginDir: root,
      options: { webPreferences: { preload: "base/js/preload.js" } }, prepare: runtime.prepareAdditional,
      readTextFile: async requested => { expect(requested).toBe(`${root}/base/js/preload.js`); return original; }, isCurrent: () => true });
    const broker = { on: vi.fn() }, ztools = { getWebContentsId: () => 42 };
    const window: any = { ztools, utools: ztools, require: (name: string) => { expect(name).toBe("electron"); return { ipcRenderer: broker }; } };
    vm.runInNewContext(script.replace(/^<script[^>]*>\s*/, "").replace(/\s*<\/script>$/, ""), { window, console: { log() {} } });
    vm.runInNewContext("window.pageObservedBroker = window.ipcRenderer; window.pageObservedId = window.ztools.getWebContentsId()", { window });
    expect(window.pageObservedBroker).toBe(broker); expect(window.pageObservedId).toBe(42);
    expect(window.utools.getUser()).toBeNull(); expect(window.ztools).toBe(window.utools);
    expect(invoke).not.toHaveBeenCalled(); await runtime.close();
  });
});

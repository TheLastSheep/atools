// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { nativePluginBrowserWindowOptions } from "../../src/lib/pluginNativeBrowserWindowOptions";

const builderPath = resolve(process.env.ATOOLS_HARRIS_PLUGIN_SOURCE || "/Users/harris/Desktop/ZTools-plugins/plugins",
  "pasteboard-pro/apps/ztools/preload/window-presentation.ts");
const builderSha256 = "22838e308ee60809d1095fde6f587b774709efaea897153090fb8a2f58f89522";

describe("native BrowserWindow option normalization", () => {
  it("flattens the reviewed WebPreferences hint while preserving the full original preload options", () => {
    const options = { width: 640, webPreferences: { preload: "preload.js", nodeIntegration: false,
      contextIsolation: false, backgroundThrottling: false } };
    const normalized = nativePluginBrowserWindowOptions(options);

    expect(normalized.nativeOptions).toEqual({ width: 640, backgroundThrottling: false });
    expect(normalized.preloadOptions).toBe(options);
  });

  it.each([true, false])("accepts explicit boolean backgroundThrottling=%s", backgroundThrottling => {
    expect(nativePluginBrowserWindowOptions({ webPreferences: { backgroundThrottling } }).nativeOptions)
      .toEqual({ backgroundThrottling });
  });

  it("does not invent a Rust option when the plugin omits the preference", () => {
    expect(nativePluginBrowserWindowOptions({ width: 640 }).nativeOptions).toEqual({ width: 640 });
    expect(nativePluginBrowserWindowOptions({ webPreferences: { preload: "preload.js" } }).nativeOptions).toEqual({});
  });

  it.each([
    { webPreferences: { nodeIntegration: true } },
    { webPreferences: { nodeIntegration: 0 } },
    { webPreferences: { contextIsolation: true } },
    { webPreferences: { contextIsolation: "false" } },
    { webPreferences: { backgroundThrottling: "false" } },
    { webPreferences: { unknownWebPreference: false } },
    { backgroundThrottling: false },
  ])("rejects an unsafe or unreviewed option shape %#", options => {
    expect(() => nativePluginBrowserWindowOptions(options)).toThrow(/ERR_ATOOLS_NATIVE_BROWSER_WINDOW_OPTIONS/u);
  });

  it.skipIf(!existsSync(builderPath))("maps both original Harris Paste 1.3.1 window builders without losing preload preferences", async () => {
    const { buildPanelWindowOptions, buildShelfWindowOptions } = await import(builderPath);
    const builderBytes = await readFile(builderPath);
    expect(createHash("sha256").update(builderBytes).digest("hex")).toBe(builderSha256);
    const appPackage = JSON.parse(await readFile(resolve(builderPath, "../../package.json"), "utf8"));
    expect(["1.3.1", "1.4.0"]).toContain(appPackage.version);
    const display = { id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 },
      bounds: { x: 0, y: 0, width: 1440, height: 900 } };
    const shelf = buildShelfWindowOptions(display, "bottom", "preload.js", "modern");
    const panel = buildPanelWindowOptions(display, "privacy", "preload.js");

    for (const original of [shelf, panel]) {
      const { nativeOptions, preloadOptions } = nativePluginBrowserWindowOptions(original);
      expect(nativeOptions.backgroundThrottling).toBe(false);
      expect(nativeOptions).not.toHaveProperty("webPreferences");
      expect(nativeOptions).not.toHaveProperty("nodeIntegration");
      expect(nativeOptions).not.toHaveProperty("contextIsolation");
      expect(preloadOptions.webPreferences).toEqual(original.webPreferences);
      expect(preloadOptions.webPreferences).toMatchObject({ preload: "preload.js", nodeIntegration: false,
        contextIsolation: false, backgroundThrottling: false });
    }
  });
});

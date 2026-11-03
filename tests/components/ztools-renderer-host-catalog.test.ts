import { describe, expect, it } from "vitest";
import { createZtoolsRendererHostAdapter } from "../../packages/ztools-renderer/src/hostAdapter";
import { INACTIVE_EVENTS } from "../../packages/ztools-renderer/src/hostEventCatalog";
import { RENDERER_GENERAL_PREFERENCE_NOTIFICATIONS } from "../../packages/ztools-renderer/src/generalPreferenceEvents";
import {
  RENDERER_SETTINGS_VIEW_CALLBACKS,
} from "../../packages/ztools-renderer/src/settingsViewClient";
import { RENDERER_SETTINGS_INPUT_CALLBACKS } from "../../packages/ztools-renderer/src/settingsInput";
import type { AdapterCapabilityState, ZToolsRendererTransport } from "../../packages/ztools-renderer/src/types";

const expectedMethods: Record<string, AdapterCapabilityState> = {
  onNativeMainFileDrop: "limited",
  getApps: "available",
  getAllPlugins: "available",
  getDisabledPlugins: "available",
  dbGet: "limited",
  dbPut: "limited",
  getPlatform: "available",
  isWindows: "available",
  getSystemSettings: "unavailable",
  getLastCopiedContent: "limited",
  getSuperPanelPinned: "available_with_defaults",
  getUsageStats: "available_with_defaults",
  analyzeImage: "local_only",
  "localShortcuts.getAll": "available_with_defaults",
  updateLaunchContext: "local_only",
  getWindowMaterial: "unavailable",
  "updater.getDownloadStatus": "limited",
  "updater.showUpdateWindow": "limited",
  "updater.checkUpdate": "limited",
  launch: "limited",
  revealInFinder: "limited",
  showContextMenu: "limited",
  pinApp: "limited",
  unpinApp: "limited",
  removeFromHistory: "limited",
  updatePinnedOrder: "limited",
  resizeWindow: "available",
  resetWindow: "available",
  hideWindow: "available",
  getWindowPosition: "limited",
  setWindowPosition: "limited",
  setWindowSizeLock: "limited",
  openSettings: "limited",
  hidePlugin: "limited",
  notifySubInputChange: "limited",
};

function adapter() {
  const transport: ZToolsRendererTransport = {
    invoke: async () => undefined,
    listen: async () => () => undefined,
  };
  return createZtoolsRendererHostAdapter({ transport });
}

describe("renderer host compatibility catalog", () => {
  it("generates the five typed settings callbacks as enumerable API functions", () => {
    expect(RENDERER_SETTINGS_VIEW_CALLBACKS).toEqual([
      "onShowPluginPlaceholder",
      "onPluginOpened",
      "onPluginLoaded",
      "onPluginClosed",
      "onBackToSearch",
    ]);
    const host = adapter();

    for (const name of RENDERER_SETTINGS_VIEW_CALLBACKS) {
      const descriptor = Object.getOwnPropertyDescriptor(host.api, name);
      expect(descriptor).toMatchObject({ enumerable: true, configurable: true, writable: true });
      expect(typeof descriptor?.value).toBe("function");
      expect(() => (descriptor?.value as (callback: unknown) => unknown)(null)).toThrow(
        expect.objectContaining({ code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT" }),
      );
    }
    for (const name of RENDERER_SETTINGS_INPUT_CALLBACKS) {
      expect(typeof host.api[name]).toBe("function");
    }

    expect(Reflect.ownKeys(host.api)).toHaveLength(87);
    expect(Object.keys(host.api)).toContain("onUpdateBuiltinAppShortcutsEnabled");
    expect(Object.keys(host.api)).toContain("onPluginOpened");
    host.dispose();
  });

  it("derives fresh method and event capability maps from the executable catalogs", () => {
    const host = adapter();
    const first = host.capabilities();
    const activeEvents = [
      "onUpdateAvailable", "onUpdateDownloadStart", "onUpdateDownloadFailed",
      "onFocusSearch",
      "onAppLaunched",
      "onAppsChanged",
      "onPluginsChanged",
      "onHistoryChanged",
      "onPinnedChanged",
      "onContextMenuCommand",
      "onCommandAliasesChanged",
      "onDisabledCommandsChanged",
      "onLocalShortcutsChanged",
      ...RENDERER_SETTINGS_VIEW_CALLBACKS,
      ...RENDERER_SETTINGS_INPUT_CALLBACKS,
      ...RENDERER_GENERAL_PREFERENCE_NOTIFICATIONS.map(([, name]) => name),
    ];
    const expectedEvents = Object.fromEntries([
      ...INACTIVE_EVENTS.map((name) => [name, "inactive"] as const),
      ...activeEvents.map((name) => [name, "limited"] as const),
    ]);

    expect(first.methods).toEqual(expectedMethods);
    expect(first.events).toEqual(expectedEvents);
    expect(INACTIVE_EVENTS).not.toContain("onAppLaunched");
    expect(INACTIVE_EVENTS).not.toContain("onPluginsChanged");
    expect(INACTIVE_EVENTS).not.toContain("onCommandAliasesChanged");
    expect(INACTIVE_EVENTS).not.toContain("onDisabledCommandsChanged");
    expect(INACTIVE_EVENTS).not.toContain("onLocalShortcutsChanged");
    expect(first.events.onCommandAliasesChanged).toBe("limited");
    expect(first.events.onDisabledCommandsChanged).toBe("limited");
    expect(Object.keys(first.events)).toHaveLength(55);
    expect(first.events.onUpdateBuiltinAppShortcutsEnabled).toBe("limited");
    expect(Object.keys(first.methods)).toHaveLength(35);
    expect(first.methods.notifySubInputChange).toBe("limited");
    expect(first.methodNotes?.notifySubInputChange).toContain("internal settings view");
    expect(Object.hasOwn(host.api, "getWindowMaterial")).toBe(false);
    expect(Reflect.has(host.api, "getWindowMaterial")).toBe(false);
    expect(host.api.getWindowMaterial).toBeUndefined();
    expect(host.snapshot().unavailableMethods).toContain("getWindowMaterial");
    expect(Object.keys(host.api.localShortcuts as object)).toEqual(["getAll"]);
    expect(Object.keys(host.api.updater as object)).toEqual(["getDownloadStatus", "checkUpdate", "showUpdateWindow"]);

    first.methods.getApps = "unsupported";
    first.events.onAppsChanged = "inactive";
    first.methodNotes!.openSettings = "mutated";
    const next = host.capabilities();
    expect(next.methods.getApps).toBe("available");
    expect(next.events.onAppsChanged).toBe("limited");
    expect(next.methodNotes?.openSettings).toContain("internal settings");
    expect(next.methods).not.toBe(first.methods);
    expect(next.events).not.toBe(first.events);
    expect(next.methodNotes).not.toBe(first.methodNotes);
    host.dispose();
  });

  it("keeps unsupported namespace get, has, then, name, symbols and call diagnostics", () => {
    const host = adapter();
    const api = host.api;
    expect(api.then).toBeUndefined();
    expect(Reflect.has(api, "notInstalled")).toBe(false);
    expect("notInstalled" in api).toBe(false);

    const namespace = api.notInstalled as Record<PropertyKey, unknown>;
    expect(namespace.name).toBe("notInstalled");
    expect(Reflect.get(namespace, Symbol.hasInstance)).toBe(Function.prototype[Symbol.hasInstance]);
    const nested = namespace.privateMethod as (...args: never[]) => never;
    expect((nested as unknown as { name: string }).name).toBe("notInstalled.privateMethod");
    expect(() => Reflect.apply(nested, undefined, [])).toThrow(
      expect.objectContaining({ code: "ERR_ATOOLS_ZTOOLS_UNSUPPORTED" }),
    );
    const unknownMethod = api.notImplemented as (...args: never[]) => never;
    expect(() => unknownMethod()).toThrow(
      expect.objectContaining({ code: "ERR_ATOOLS_ZTOOLS_UNSUPPORTED" }),
    );
    expect(host.snapshot().unsupportedMethods).toEqual([
      "notImplemented",
      "notInstalled.privateMethod",
    ]);
    host.dispose();
  });
});

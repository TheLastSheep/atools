import { describe, expect, it, vi } from "vitest";
import { createZtoolsRendererHostAdapter } from "../../packages/ztools-renderer/src/hostAdapter";
import type {
  RendererHostCommand,
  ZToolsRendererTransport,
} from "../../packages/ztools-renderer/src/types";
import { NAMESPACED_READ_KEYS } from "../../packages/ztools-renderer/src/startupReadModel";

type Call = { command: RendererHostCommand; args?: Record<string, unknown> };
const appRows = [{ name: "Example", path: "/Applications/Example.app", icon: null }];
const emptyAppState = { version: 1, revision: 1, values: { "command-history": null, "pinned-commands": null }, changed: [] };
const pluginRows = [{
  id: "fixture-plugin",
  name: "Fixture Plugin",
  version: "1.0.0",
  path: "/plugins/fixture-plugin",
  enabled: true,
  source_kind: "imported",
  inventory_logo_path: "/plugins/fixture-plugin/logo.png",
  manifest: {
    name: "Fixture Plugin",
    title: "Fixture",
    version: "1.0.0",
    main: "index.html",
    logo: "logo.png",
    description: "Fixture plugin",
    features: [{ code: "hello", explain: "Hello", cmds: ["hello"] }],
  },
}];
const nativeSettingsKeys = [
  "settings-general",
  ...Array.from(NAMESPACED_READ_KEYS, (key) => `ztools-renderer:${key}`),
];

function settingsResponse(overrides: Record<string, string | null> = {}) {
  return {
    version: 1,
    settings: Object.fromEntries(nativeSettingsKeys.map((key) => [key, overrides[key] ?? null])),
  };
}

function fixtureTransport(
  handler: (command: RendererHostCommand, args?: Record<string, unknown>) => unknown | Promise<unknown>,
  calls: Call[],
): ZToolsRendererTransport {
  return {
    async invoke(command, args) {
      calls.push({ command, args });
      if (command === "get_ztools_renderer_settings") {
        try {
          return (await handler(command, args)) ?? settingsResponse();
        } catch (error) {
          if (error instanceof Error && error.message === "unexpected route: get_ztools_renderer_settings") {
            return settingsResponse();
          }
          throw error;
        }
      }
      return handler(command, args);
    },
    async listen(event) {
      if (![
        "atools://renderer-general-settings",
        "atools://renderer-apps-changed",
        "atools://renderer-plugins-changed",
        "atools://renderer-local-shortcuts",
      ].includes(event)) {
        throw new Error(`unexpected renderer event: ${event}`);
      }
      return () => undefined;
    },
  };
}

describe("ZTools renderer host adapter", () => {
  it("loads and caches the real local app directory through the typed native route", async () => {
    const calls: Call[] = [];
    const adapter = createZtoolsRendererHostAdapter({
      transport: fixtureTransport((command) => {
        if (command === "list_launcher_apps") return appRows;
        throw new Error(`unexpected route: ${command}`);
      }, calls),
    });

    await expect(adapter.api.getApps()).resolves.toEqual([
      { name: "Example", path: "/Applications/Example.app" },
    ]);
    await adapter.api.getApps();
    expect(calls).toEqual([
      { command: "get_ztools_renderer_settings", args: undefined },
      { command: "list_launcher_apps", args: undefined },
    ]);
    adapter.dispose();
  });

  it("maps the real plugin inventory and shares its snapshot for disabled paths", async () => {
    const calls: Call[] = [];
    const adapter = createZtoolsRendererHostAdapter({
      transport: fixtureTransport((command) => {
        if (command === "list_plugins") return pluginRows;
        throw new Error(`unexpected route: ${command}`);
      }, calls),
    });

    await expect(adapter.api.getAllPlugins()).resolves.toEqual([{
      id: "fixture-plugin",
      name: "Fixture Plugin",
      title: "Fixture",
      version: "1.0.0",
      path: "/plugins/fixture-plugin",
      enabled: true,
      logo: "logo.png",
      description: "Fixture plugin",
      main: "index.html",
      features: [{ code: "hello", explain: "Hello", cmds: ["hello"] }],
      sourceKind: "imported",
    }]);
    await expect(adapter.api.getDisabledPlugins()).resolves.toEqual([]);
    expect(calls).toEqual([{ command: "list_plugins", args: undefined }]);
    adapter.dispose();
  });

  it("reads only named settings and isolated ZTools keys, with per-key in-flight caching", async () => {
    const calls: Call[] = [];
    const response = settingsResponse({
      "settings-general": JSON.stringify({ theme: "dark", recentRows: 3, aiApiKey: "secret" }),
      "ztools-renderer:enabled-main-push-plugin": null,
    });
    const adapter = createZtoolsRendererHostAdapter({
      transport: fixtureTransport((command) => {
        if (command === "get_ztools_renderer_settings") return response;
        throw new Error(`unexpected route: ${command}`);
      }, calls),
    });

    const [settingsA, settingsB] = await Promise.all([
      adapter.api.dbGet("settings-general"),
      adapter.api.dbGet("settings-general"),
    ]);
    expect(settingsA).toEqual({ theme: "dark", recentRows: 3, builtinAppShortcutsEnabled: { search: true, esc: true, closePlugin: true } });
    expect(settingsB).toBe(settingsA);
    await expect(adapter.api.dbGet("enabled-main-push-plugin")).resolves.toBeNull();
    await expect(adapter.api.dbGet("arbitrary-key")).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_UNSUPPORTED",
    });
    await expect(adapter.api.dbPut("enabled-main-push-plugin", [])).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_UNSUPPORTED",
    });
    expect(calls).toEqual([{ command: "get_ztools_renderer_settings", args: undefined }]);
    expect(adapter.snapshot().unsupportedMethods).toEqual([
      "dbGet(arbitrary-key)",
      "dbPut(enabled-main-push-plugin)",
    ]);
    adapter.dispose();
  });

  it("writes only validated search preference through the isolated setting key", async () => {
    const calls: Call[] = [];
    const adapter = createZtoolsRendererHostAdapter({
      transport: fixtureTransport((command, _args) => {
        if (command === "get_ztools_renderer_settings") {
          return settingsResponse({ "ztools-renderer:search-preference": null });
        }
        if (command === "set_setting") return undefined;
        throw new Error(`unexpected route: ${command}`);
      }, calls),
    });
    await adapter.api.dbGet("search-preference");
    const value = { "fixture-query": { path: appRows[0].path, name: "Example" } };
    await adapter.api.dbPut("search-preference", value);
    await expect(adapter.api.dbGet("search-preference")).resolves.toEqual(value);
    expect(calls).toEqual([
      { command: "get_ztools_renderer_settings", args: undefined },
      {
        command: "set_setting",
        args: {
          key: "ztools-renderer:search-preference",
          value: JSON.stringify(value),
        },
      },
    ]);
    expect(adapter.capabilities().methods.dbPut).toBe("limited");
    adapter.dispose();
  });

  it("rejects non-JSON, circular, oversized and unlisted writes before native IPC", async () => {
    const calls: Call[] = [];
    const adapter = createZtoolsRendererHostAdapter({
      transport: fixtureTransport(() => undefined, calls),
    });
    const circular: Record<string, unknown> = {};
    circular.loop = circular;
    const tooLarge = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [
      `query-${index}`,
      { path: `/${"x".repeat(16_000)}`, name: "x" },
    ]));
    for (const [key, value] of [
      ["search-preference", new Date()],
      ["search-preference", circular],
      ["search-preference", tooLarge],
      ["command-history", []],
    ] as const) {
      await expect(adapter.api.dbPut(key, value)).rejects.toMatchObject({
        code: key === "command-history" ? "ERR_ATOOLS_ZTOOLS_UNSUPPORTED" : "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT",
      });
    }
    expect(calls).toEqual([]);
    adapter.dispose();
  });

  it("preserves cached search preferences when their native write fails", async () => {
    const calls: Call[] = [];
    const oldValue = { old: { path: "/Applications/Old.app", name: "Old" } };
    const adapter = createZtoolsRendererHostAdapter({
      transport: fixtureTransport((command) => {
        if (command === "get_ztools_renderer_settings") {
          return settingsResponse({ "ztools-renderer:search-preference": JSON.stringify(oldValue) });
        }
        if (command === "set_setting") throw new Error("fixture write denied");
        throw new Error(`unexpected route: ${command}`);
      }, calls),
    });
    const before = await adapter.api.dbGet("search-preference");
    await expect(adapter.api.dbPut("search-preference", { next: { path: "/x", name: "Next" } }))
      .rejects.toThrow("fixture write denied");
    await expect(adapter.api.dbGet("search-preference")).resolves.toBe(before);
    expect(calls.map((call) => call.command)).toEqual(["get_ztools_renderer_settings", "set_setting"]);
    adapter.dispose();
  });

  it("does not let a late failed read delete a successfully written preference cache", async () => {
    const calls: Call[] = [];
    const next = { fresh: { path: "/Applications/Fresh.app", name: "Fresh" } };
    let rejectRead!: (error: Error) => void;
    const adapter = createZtoolsRendererHostAdapter({
      transport: fixtureTransport((command) => {
        if (command === "get_ztools_renderer_settings") {
          return new Promise((_resolve, reject) => { rejectRead = reject; });
        }
        if (command === "set_setting") return undefined;
        throw new Error(`unexpected route: ${command}`);
      }, calls),
    });
    const oldRead = adapter.api.dbGet("search-preference");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await adapter.api.dbPut("search-preference", next);
    rejectRead(new Error("late stale read failure"));
    await expect(oldRead).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_INVALID_RESPONSE" });
    await expect(adapter.api.dbGet("search-preference")).resolves.toEqual(next);
    expect(calls.map((call) => call.command)).toEqual(["get_ztools_renderer_settings", "set_setting"]);
    adapter.dispose();
  });

  it("serves typed startup read-models from isolated keys and reports missing-domain defaults", async () => {
    const calls: Call[] = [];
    const response = settingsResponse({
      "ztools-renderer:super-panel-pinned": JSON.stringify([
        { path: "/Applications/Example.app", name: "Example" },
      ]),
      "ztools-renderer:local-shortcuts": JSON.stringify([
        {
          id: "docs-1", name: "Docs", path: "/Applications/Docs.app", type: "app", addedAt: 7,
          alias: "documents", keywords: ["docs"], pinyin: "docs", pinyinAbbr: "d",
        },
      ]),
    });
    const adapter = createZtoolsRendererHostAdapter({
      transport: fixtureTransport((command) => {
        if (command === "get_ztools_renderer_settings") return response;
        throw new Error(`unexpected route: ${command}`);
      }, calls),
    });

    await expect(adapter.api.getSuperPanelPinned()).resolves.toEqual([
      { path: "/Applications/Example.app", name: "Example" },
    ]);
    await expect(adapter.api.localShortcuts.getAll()).resolves.toEqual([
      {
        id: "docs-1", name: "Docs", path: "/Applications/Docs.app", type: "app", addedAt: 7,
        alias: "documents", keywords: ["docs"], pinyin: "docs", pinyinAbbr: "d",
      },
    ]);
    await expect(adapter.api.getUsageStats()).resolves.toEqual([]);
    expect(adapter.capabilities().methods).toMatchObject({
      getSuperPanelPinned: "available_with_defaults",
      "localShortcuts.getAll": "available_with_defaults",
      getUsageStats: "available_with_defaults",
    });
    expect(adapter.snapshot().readModelDefaults).toEqual(["command-usage-stats"]);
    expect(calls).toEqual([{ command: "get_ztools_renderer_settings", args: undefined }]);
    adapter.dispose();
  });

  it("keeps launch context bounded and renderer-local without native IPC or payload diagnostics", () => {
    const calls: Call[] = [];
    const adapter = createZtoolsRendererHostAdapter({
      transport: fixtureTransport(() => undefined, calls),
    });
    const sensitiveQuery = "private query contents";
    adapter.api.updateLaunchContext({
      searchQuery: sensitiveQuery,
      pastedImage: null,
      pastedFiles: [{ name: "note.txt", path: "/tmp/note.txt", isDirectory: false }],
      pastedText: "private paste contents",
    });
    expect(adapter.snapshot()).toMatchObject({ launchContextSet: true, nativeCalls: {} });
    expect(JSON.stringify(adapter.snapshot())).not.toContain(sensitiveQuery);
    expect(JSON.stringify(adapter.snapshot())).not.toContain("private paste contents");
    expect(adapter.capabilities().methods.updateLaunchContext).toBe("local_only");
    expect(() => Reflect.apply(adapter.api.updateLaunchContext, adapter.api, [{ searchQuery: "x" }]))
      .toThrow(/Invalid ZTools renderer input/);
    adapter.dispose();
    expect(adapter.snapshot().launchContextSet).toBe(false);
    expect(calls).toEqual([]);
  });

  it("opens only an app path present in the loaded catalogue", async () => {
    const calls: Call[] = [];
    const adapter = createZtoolsRendererHostAdapter({
      transport: fixtureTransport((command) => {
        if (command === "list_launcher_apps") return appRows;
        if (command === "launch_renderer_app") return emptyAppState;
        throw new Error(`unexpected route: ${command}`);
      }, calls),
    });

    await adapter.api.launch({ path: appRows[0].path, type: "direct", name: "Example" });
    await expect(adapter.api.launch({ path: "/tmp/arbitrary", type: "app" })).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_UNSUPPORTED",
    });
    await expect(adapter.api.launch({ path: appRows[0].path, type: "plugin" })).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_UNSUPPORTED",
    });
    await expect(adapter.api.launch({ path: "system-setting:network", type: "direct" }))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_UNSUPPORTED" });
    expect(calls).toEqual([
      { command: "list_launcher_apps", args: undefined },
      {
        command: "launch_renderer_app",
        args: { target: { path: appRows[0].path, name: "Example" } },
      },
      { command: "get_ztools_renderer_settings", args: undefined },
    ]);
    expect(calls.filter((call) => call.command === "launch_renderer_app")).toHaveLength(1);
    adapter.dispose();
  });

  it("propagates permission denial and does not dispatch a launch after disposal", async () => {
    const denial = new Error("saved capability permission denied");
    const calls: Call[] = [];
    const adapter = createZtoolsRendererHostAdapter({
      transport: fixtureTransport((command) => {
        if (command === "list_launcher_apps") return appRows;
        if (command === "launch_renderer_app") throw denial;
        throw new Error(`unexpected route: ${command}`);
      }, calls),
    });
    await expect(adapter.api.launch({ path: appRows[0].path, type: "app" })).rejects.toBe(denial);
    expect(calls.map((call) => call.command)).toEqual(["list_launcher_apps", "launch_renderer_app"]);
    adapter.dispose();

    const disposedCalls: Call[] = [];
    const disposedAdapter = createZtoolsRendererHostAdapter({
      transport: fixtureTransport(() => appRows, disposedCalls),
    });
    const pendingLaunch = disposedAdapter.api.launch({ path: appRows[0].path, type: "app" });
    disposedAdapter.dispose();
    await expect(pendingLaunch).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disposedCalls).toEqual([]);
  });

  it("maps window routes, reports unsupported methods, and marks the live app event limited", async () => {
    const calls: Call[] = [];
    const listen = vi.fn(async (_event: string) => () => undefined);
    const adapter = createZtoolsRendererHostAdapter({
      transport: {
        ...fixtureTransport(() => undefined, calls),
        listen,
      },
      platformProvider: () => "win32",
    });

    expect(adapter.api.getPlatform()).toBe("win32");
    expect(adapter.api.isWindows()).toBe(true);
    await adapter.api.resizeWindow(480);
    await adapter.api.resetWindow();
    await adapter.api.hideWindow();
    const unlisten = adapter.api.onAppsChanged(() => undefined);
    unlisten();
    expect(adapter.capabilities().events).toMatchObject({ onAppsChanged: "limited", onFocusSearch: "limited" });
    expect(listen.mock.calls.map(([event]) => event).sort()).toEqual([
      "atools://renderer-apps-changed",
      "atools://renderer-command-aliases",
      "atools://renderer-disabled-commands",
      "atools://renderer-general-settings",
    ]);
    expect(calls).toEqual([
      { command: "expand_window", args: { height: 480 } },
      { command: "reset_window", args: undefined },
      { command: "hide_main_window", args: undefined },
    ]);
    expect(adapter.capabilities().methods.setWindowSizeLock).toBe("limited");
    expect(() => (adapter.api as unknown as { plugin: { activate(): void } }).plugin.activate())
      .toThrow(/plugin.activate/);
    expect(adapter.snapshot().inactiveEvents).toEqual([]);
    adapter.dispose();
  });

  it("settles pending reads on dispose and ignores their late response", async () => {
    const calls: Call[] = [];
    let release!: (value: unknown) => void;
    const adapter = createZtoolsRendererHostAdapter({
      transport: fixtureTransport((command) => {
        if (command === "list_launcher_apps") return new Promise((resolve) => { release = resolve; });
        throw new Error(`unexpected route: ${command}`);
      }, calls),
    });
    const pending = adapter.api.getApps();
    await new Promise((resolve) => setTimeout(resolve, 0));
    adapter.dispose();
    await expect(pending).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" });
    release(appRows);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.snapshot().outstandingNativeCalls).toBe(0);
    expect(adapter.snapshot().disposed).toBe(true);
    expect(calls.map((call) => call.command)).toEqual([
      "get_ztools_renderer_settings",
      "list_launcher_apps",
    ]);
  });

  it("does not dispatch a queued native route after same-turn disposal", async () => {
    const calls: Call[] = [];
    const adapter = createZtoolsRendererHostAdapter({
      transport: fixtureTransport((command) => {
        calls.push({ command });
        return undefined;
      }, []),
    });
    const hide = adapter.api.hideWindow();
    const resize = adapter.api.resizeWindow(420);
    adapter.dispose();
    expect(hide).toBeUndefined();
    expect(resize).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([]);
  });

  it("isolates cached app catalogue references from callers and the launch allowlist", async () => {
    const calls: Call[] = [];
    const adapter = createZtoolsRendererHostAdapter({
      transport: fixtureTransport((command) => {
        if (command === "list_launcher_apps") return appRows;
        if (command === "launch_renderer_app") return emptyAppState;
        throw new Error(`unexpected route: ${command}`);
      }, calls),
    });
    const visibleApps = await adapter.api.getApps();
    visibleApps[0].path = "/tmp/replaced.app";
    visibleApps.push({ name: "Injected", path: "/tmp/injected.app" });

    await expect(adapter.api.launch({ path: "/tmp/injected.app", type: "app" }))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_UNSUPPORTED" });
    await expect(adapter.api.getApps()).resolves.toEqual([
      { name: "Example", path: "/Applications/Example.app" },
    ]);
    expect(calls.map((call) => call.command)).toEqual([
      "get_ztools_renderer_settings",
      "list_launcher_apps",
    ]);
    adapter.dispose();
  });

  it("does not expose mutable plugin inventory cache references", async () => {
    const calls: Call[] = [];
    const adapter = createZtoolsRendererHostAdapter({
      transport: fixtureTransport((command) => {
        if (command === "list_plugins") return pluginRows;
        throw new Error(`unexpected route: ${command}`);
      }, calls),
    });
    const visiblePlugins = await adapter.api.getAllPlugins();
    visiblePlugins[0].enabled = false;
    visiblePlugins[0].features[0].code = "changed";
    visiblePlugins.push({ ...visiblePlugins[0], id: "injected" });

    await expect(adapter.api.getDisabledPlugins()).resolves.toEqual([]);
    const fresh = await adapter.api.getAllPlugins();
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ enabled: true, features: [{ code: "hello" }] });
    expect(calls).toEqual([{ command: "list_plugins", args: undefined }]);
    adapter.dispose();
  });
});

import { expect, it, vi } from "vitest";
import { PluginMarketController } from "../../src/lib/pluginMarketController";
import { readOfficialMarketTarget } from "../../src/lib/pluginMarketTarget";
import { DEFAULT_ZTOOLS_MARKET_URL } from "../../src/lib/pluginMarketView";
import type { PluginMarketCatalogPlugin } from "../../src/lib/types";

const plugin: PluginMarketCatalogPlugin = { id: "exact-id", name: "当前发布版", version: "2.0.0", description: "", trust_policy: "official_ztools_confirm" };
const lookup = (status = "available", item: PluginMarketCatalogPlugin | null = plugin) => ({ plugin_id: plugin.id,
  source_url: DEFAULT_ZTOOLS_MARKET_URL, source_kind: "ztools", status, plugin: item });
const preferences = { custom: true, url: "https://custom.example/catalog.json", trustedPublicKeys: "" };
const request = { source: "official_ztools" as const, pluginName: plugin.id };
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(answer => { resolve = answer; }); return { promise, resolve }; }
function harness(response: unknown = lookup()) {
  const confirm = vi.fn(async () => true);
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (command === "list_plugins") return [];
    if (command === "fetch_official_plugin_target") return response;
    if (command === "fetch_plugin_market_catalog") return { source_url: args?.url, source_kind: "ztools", plugins: [{ ...plugin, id: "directory-only" }] };
    if (command === "resolve_plugin_market_download") return { download_url: "https://ztools.zosen.link/fixture.zip", package_format: "zip" };
    if (command === "install_plugin_from_market") return { id: plugin.id, version: plugin.version, enabled: false };
  });
  const controller = new PluginMarketController({ invoke: invoke as never, hasRuntime: () => true, confirm });
  return { controller, invoke, confirm };
}

it("reads one exact target without fetching the aggregate directory or resolving a package", async () => {
  const { controller, invoke } = harness();
  controller.configure(preferences, request); await settle();
  expect(invoke).toHaveBeenCalledWith("fetch_official_plugin_target", { pluginId: plugin.id });
  expect(invoke.mock.calls.some(([name]) => name === "fetch_plugin_market_catalog" || name === "resolve_plugin_market_download")).toBe(false);
  expect(controller.state.catalog?.plugins).toEqual([plugin]);
  expect(controller.state.targetLookup).toMatchObject({ status: "available", version: "2.0.0" });
  await controller.install(plugin.id);
  expect(invoke.mock.calls.find(([name]) => name === "install_plugin_from_market")?.[1]).toMatchObject({ expectedVersion: "2.0.0", sourceUrl: DEFAULT_ZTOOLS_MARKET_URL });
});

it.each(["not_found", "unsupported_platform"])("keeps the official %s reason distinct and starts no package action", async status => {
  const { controller, invoke, confirm } = harness(lookup(status, null));
  controller.configure(preferences, request); await settle(); await controller.install(plugin.id);
  expect(controller.state.targetLookup?.status).toBe(status);
  expect(controller.state.catalog?.plugins).toEqual([]);
  expect(invoke.mock.calls.some(([name]) => name.includes("resolve") || name.includes("install"))).toBe(false);
  expect(confirm).not.toHaveBeenCalled();
});

it("keeps a transport failure separate from absence and can explicitly retry it", async () => {
  const { controller, invoke } = harness(); const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => command === "fetch_official_plugin_target" ? Promise.reject(new Error("offline")) : original(command, args));
  controller.configure(preferences, request); await settle();
  expect(controller.state.targetLookup).toMatchObject({ status: "error", error: "Error: offline" });
  expect(controller.state.catalog).toBeNull();
  invoke.mockImplementation(original); await controller.refresh();
  expect(controller.state.targetLookup?.status).toBe("available");
});

it("loads the official directory only after clearing the target and ignores the older target reply", async () => {
  const pending = deferred<unknown>(); const { controller, invoke } = harness(pending.promise);
  controller.configure(preferences, request); await settle();
  expect(controller.state.targetLookup?.status).toBe("loading");
  controller.clearTarget(); await settle();
  expect(invoke.mock.calls.filter(([name]) => name === "fetch_plugin_market_catalog")).toHaveLength(1);
  expect(controller.state.catalog?.plugins.map(item => item.id)).toEqual(["directory-only"]);
  pending.resolve(lookup()); await settle();
  expect(controller.state.target).toBeNull(); expect(controller.state.targetLookup).toBeNull();
  expect(controller.state.catalog?.plugins.map(item => item.id)).toEqual(["directory-only"]);
});

it("does not replace the restored source when a prior target lookup finishes", async () => {
  const pending = deferred<unknown>(); const { controller } = harness(pending.promise);
  controller.configure(preferences, request); await settle(); controller.restoreSource(); await settle();
  pending.resolve(lookup()); await settle();
  expect(controller.state.sourceUrl).toBe(preferences.url); expect(controller.state.targetLookup).toBeNull();
  expect(controller.state.catalog?.source_url).toBe(preferences.url);
});

it.each([
  { ...lookup(), plugin_id: "wrong-id" },
  { ...lookup(), source_url: "https://z-tools.top.evil/api/market" },
  { ...lookup(), source_kind: "atools" },
  lookup("unknown", null), lookup("available", { ...plugin, version: "" }),
  lookup("available", { ...plugin, id: "similar-id" }), lookup("not_found", plugin),
])("rejects contradictory target identity, provenance or availability", async response => {
  const invoke = vi.fn(async () => response);
  await expect(readOfficialMarketTarget(invoke as never, plugin.id)).rejects.toThrow();
});

import { expect, it, vi } from "vitest";
import { PluginMarketController } from "../../src/lib/pluginMarketController";
import { DEFAULT_ZTOOLS_MARKET_URL, marketInstallAllowed, marketOfficialUnsigned, visibleMarketPlugins } from "../../src/lib/pluginMarketView";
import type { InstalledPlugin, PluginMarketCatalog, PluginMarketCatalogPlugin } from "../../src/lib/types";

const plugin: PluginMarketCatalogPlugin = { id: "regex-editor", name: "正则编辑器", version: "1.0.0", description: "正则", trust_policy: "official_ztools_confirm" };
const catalog = (url = DEFAULT_ZTOOLS_MARKET_URL, plugins = [plugin]): PluginMarketCatalog => ({ source_url: url, source_kind: url === DEFAULT_ZTOOLS_MARKET_URL ? "ztools" : "atools", plugins: url === DEFAULT_ZTOOLS_MARKET_URL ? plugins : plugins.map(plugin => ({ ...plugin, trust_policy: "signed_required", signature: "fixture-signature", public_key: "pinned-key" })) });
const preferences = { custom: true, url: "https://custom.example/catalog.json", trustedPublicKeys: "pinned-key" };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function harness() {
  const confirm = vi.fn(async () => true);
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (command === "list_plugins") return [];
    if (command === "fetch_plugin_market_catalog") return catalog(args?.url as string);
    if (command === "fetch_official_plugin_target") return { plugin_id: args?.pluginId, source_url: DEFAULT_ZTOOLS_MARKET_URL, source_kind: "ztools", status: "available", plugin };
    if (command === "resolve_plugin_market_download") return { download_url: "https://ztools.zosen.link/regex-editor.zip", package_format: "zip", trust_policy: plugin.trust_policy };
    if (command === "install_plugin_from_market" || command === "update_plugin_from_market") return { id: plugin.id, name: plugin.name, version: plugin.version };
  });
  const controller = new PluginMarketController({ invoke: invoke as never, confirm, hasRuntime: () => true });
  return { controller, invoke, confirm };
}

it("freezes the source at refresh entry and discards older responses and finalizers", async () => {
  const { controller, invoke } = harness();
  const old = deferred<PluginMarketCatalog>(), latest = deferred<PluginMarketCatalog>();
  invoke.mockImplementation(async command => command === "list_plugins" ? [] : old.promise);
  controller.configure(preferences);
  expect(invoke).toHaveBeenCalledWith("fetch_plugin_market_catalog", { url: preferences.url });
  invoke.mockImplementation(async command => command === "list_plugins" ? [] : latest.promise);
  controller.configure({ ...preferences, url: DEFAULT_ZTOOLS_MARKET_URL });
  expect(invoke).toHaveBeenLastCalledWith("fetch_plugin_market_catalog", { url: DEFAULT_ZTOOLS_MARKET_URL });
  old.resolve(catalog(preferences.url)); await tick();
  expect(controller.state.catalog).toBeNull(); expect(controller.state.loading).toBe(true);
  latest.resolve(catalog()); await tick();
  expect(controller.state.catalog?.source_url).toBe(DEFAULT_ZTOOLS_MARKET_URL);
  expect(controller.state.loading).toBe(false);
  expect(controller.state.selectedId).toBeNull();
});

it("does not publish a late response after disposal", async () => {
  const { controller, invoke } = harness(); const pending = deferred<PluginMarketCatalog>();
  invoke.mockImplementation(async command => command === "list_plugins" ? [] : pending.promise);
  controller.configure(preferences); const listener = vi.fn(); controller.subscribe(listener); controller.dispose();
  pending.resolve(catalog()); await tick();
  expect(listener).toHaveBeenCalledTimes(1); expect(controller.state.catalog).toBeNull();
});

it("keeps a temporary official visit after request consumption and restores the persisted preference", async () => {
  const { controller, invoke } = harness();
  const request = { source: "official_ztools" as const, pluginName: "regex-editor" };
  controller.configure(preferences, request); await tick();
  controller.configure(preferences, null);
  expect(controller.state.officialOverride).toBe(true); expect(controller.state.target).toBe("regex-editor");
  controller.clearTarget(); expect(controller.state.target).toBeNull(); expect(controller.state.sourceUrl).toBe(DEFAULT_ZTOOLS_MARKET_URL);
  controller.restoreSource(); await tick();
  expect(controller.state.sourceUrl).toBe(preferences.url); expect(preferences.custom).toBe(true);
  expect(invoke.mock.calls.filter(([name]) => name.includes("install") || name.includes("resolve"))).toEqual([]);
});

it("matches an import target by exact ID and filters ordinary loaded rows", () => {
  const similar = { ...plugin, id: "regex-editor-extra", name: "regex-editor" };
  expect(visibleMarketPlugins([similar, plugin], "regex-editor", "")).toEqual([plugin]);
  expect(visibleMarketPlugins([similar], "regex-editor", "")).toEqual([]);
  expect(visibleMarketPlugins([similar, plugin], null, "extra")).toEqual([similar]);
});

it.each(["https://custom.example/api/market", "https://z-tools.top.evil/api/market", "http://z-tools.top/api/market", "https://z-tools.top/api/market-forged", "https://z-tools.top/unrelated", "https://user:password@z-tools.top/api/market"])("rejects an unsigned catalog claiming the official policy at %s", async sourceUrl => {
  const { controller, invoke, confirm } = harness();
  invoke.mockImplementation(async command => command === "list_plugins" ? [] : { source_url: sourceUrl, source_kind: "ztools", plugins: [plugin] });
  controller.configure({ ...preferences, url: sourceUrl }); await tick(); await controller.install(plugin.id);
  expect(confirm).not.toHaveBeenCalled();
  expect(invoke.mock.calls.some(([command]) => command === "resolve_plugin_market_download")).toBe(false);
  expect(controller.state.status).toContain("已拒绝安装");
});

it("requires explicit catalog context and pinned signatures even when the policy claims official", () => {
  expect(marketInstallAllowed(plugin, "", null)).toBe(false);
  expect(marketInstallAllowed(plugin, "", { source_kind: "atools", source_url: DEFAULT_ZTOOLS_MARKET_URL })).toBe(false);
  expect(marketOfficialUnsigned(plugin, { source_kind: "ztools", source_url: `${DEFAULT_ZTOOLS_MARKET_URL}/plugins/?limit=30` })).toBe(true);
  const signed = { ...plugin, signature: "signature", public_key: "pinned-key" };
  const source = { source_kind: "ztools" as const, source_url: DEFAULT_ZTOOLS_MARKET_URL };
  expect(marketOfficialUnsigned(signed, source)).toBe(false);
  expect(marketInstallAllowed(signed, "", source)).toBe(false);
  expect(marketInstallAllowed(signed, "pinned-key", source)).toBe(true);
});

it("locks duplicate clicks throughout resolution and cancellation before confirming", async () => {
  const { controller, invoke, confirm } = harness(); controller.configure(preferences); await tick();
  const resolve = deferred<unknown>(); invoke.mockImplementation(async command => command === "resolve_plugin_market_download" ? resolve.promise : []);
  confirm.mockResolvedValue(false);
  const first = controller.install(plugin.id); const second = controller.install(plugin.id);
  expect(controller.state.pendingId).toBe(plugin.id);
  expect(invoke.mock.calls.filter(([command]) => command === "resolve_plugin_market_download")).toHaveLength(1);
  resolve.resolve({ download_url: "https://ztools.zosen.link/plugin.zip", package_format: "zip" }); await Promise.all([first, second]);
  expect(confirm).toHaveBeenCalledTimes(1); expect(controller.state.pendingId).toBe("");
  expect(controller.state.status).toContain("已取消安装");
  expect(invoke.mock.calls.some(([command]) => command === "install_plugin_from_market")).toBe(false);
});

it.each(["resolver", "confirmation"])("invalidates a %s waiting on a previous directory", async stage => {
  const { controller, invoke, confirm } = harness(); controller.configure(preferences); await tick();
  const pending = deferred<unknown>(); const answer = deferred<boolean>();
  if (stage === "resolver") invoke.mockImplementation(async command => command === "resolve_plugin_market_download" ? pending.promise : command === "list_plugins" ? [] : catalog());
  else confirm.mockImplementation(() => answer.promise);
  const action = controller.install(plugin.id); await tick();
  controller.configure({ ...preferences, url: "https://second.example/catalog.json" }); await tick();
  pending.resolve({ download_url: "https://ztools.zosen.link/plugin.zip", package_format: "zip" }); answer.resolve(true); await action;
  expect(invoke.mock.calls.some(([command]) => command === "install_plugin_from_market")).toBe(false);
  expect(controller.state.status).toContain("已变化");
});

it("retries the immutable original source and action and always asks again", async () => {
  const { controller, invoke, confirm } = harness();
  const original = catalog(DEFAULT_ZTOOLS_MARKET_URL); controller.configure(preferences, { source: "official_ztools", pluginName: plugin.id }); await tick();
  let attempts = 0;
  invoke.mockImplementation(async (command, args) => {
    if (command === "list_plugins") return [{ id: plugin.id, version: "9.0.0" }] as InstalledPlugin[];
    if (command === "fetch_plugin_market_catalog") return catalog(args?.url as string, [{ ...plugin, version: "2.0.0" }]);
    if (command === "fetch_official_plugin_target") return { plugin_id: plugin.id, source_url: DEFAULT_ZTOOLS_MARKET_URL, source_kind: "ztools", status: "available", plugin };
    if (command === "resolve_plugin_market_download") return { download_url: "https://ztools.zosen.link/plugin.zip", package_format: "zip" };
    if (command === "install_plugin_from_market") { if (++attempts === 1) throw new Error("temporary network error"); return { id: plugin.id, name: plugin.name }; }
  });
  await controller.install(plugin.id);
  expect(controller.state.retry?.sourceUrl).toBe(original.source_url);
  controller.restoreSource(); await tick(); await controller.retry();
  expect(confirm).toHaveBeenCalledTimes(2);
  const installs = invoke.mock.calls.filter(([command]) => command === "install_plugin_from_market");
  expect(installs).toHaveLength(2);
  expect(installs[1][1]).toMatchObject({ sourceKind: "ztools", sourceUrl: DEFAULT_ZTOOLS_MARKET_URL, confirmedUnsigned: true, pluginId: plugin.id });
  const resolutions = invoke.mock.calls.filter(([command]) => command === "resolve_plugin_market_download");
  expect(resolutions[1][1]?.plugin).toMatchObject({ version: "1.0.0" });
  expect(invoke.mock.calls.some(([command]) => command === "update_plugin_from_market")).toBe(false);
});

it("stops blind retry for a known bad package while preserving existing retry for unknown mutation errors", async () => {
  const known = harness(); known.controller.configure(preferences); await tick();
  const original = known.invoke.getMockImplementation()!;
  known.invoke.mockImplementation(async (command, args) => {
    if (command === "install_plugin_from_market") throw new Error("[PLUGIN_RUNTIME_DEPENDENCY_MISSING] missing lodash in preload");
    return original(command, args);
  });
  await known.controller.install(plugin.id);
  expect(known.controller.state.installFailure).toContain("PLUGIN_RUNTIME_DEPENDENCY_MISSING");
  expect(known.controller.state.retry).toBeNull();
  expect(known.controller.state.status).toContain("请查看原因");

  const unknown = harness(); unknown.controller.configure(preferences); await tick();
  const fallback = unknown.invoke.getMockImplementation()!;
  unknown.invoke.mockImplementation(async (command, args) => {
    if (command === "install_plugin_from_market") throw new Error("temporary mutation error");
    return fallback(command, args);
  });
  await unknown.controller.install(plugin.id);
  expect(unknown.controller.state.installFailure).toBe("");
  expect(unknown.controller.state.retry?.plugin.id).toBe(plugin.id);
});

it("accepts progress only for the active operation and keeps frozen fields after execution starts", async () => {
  const { controller, invoke } = harness(); controller.configure(preferences, { source: "official_ztools", pluginName: plugin.id }); await tick();
  const mutation = deferred<unknown>();
  invoke.mockImplementation(async (command, args) => {
    if (command === "resolve_plugin_market_download") return { download_url: "https://ztools.zosen.link/plugin.zip", package_format: "zip" };
    if (command === "install_plugin_from_market") return mutation.promise;
    if (command === "list_plugins") return [];
    if (command === "fetch_plugin_market_catalog") return catalog(args?.url as string);
    if (command === "fetch_official_plugin_target") return { plugin_id: plugin.id, source_url: DEFAULT_ZTOOLS_MARKET_URL, source_kind: "ztools", status: "available", plugin };
  });
  const action = controller.install(plugin.id); await tick();
  const id = controller.state.operationId; expect(id).not.toBe("");
  controller.handleProgress({ operation: "install", stage: "downloading", downloaded_bytes: 99, attempt: 1, max_attempts: 1, message: "foreign", operation_id: "other" });
  expect(controller.state.progress?.message).not.toBe("foreign");
  controller.restoreSource(); await tick();
  expect(invoke.mock.calls.find(([command]) => command === "install_plugin_from_market")?.[1]).toMatchObject({ sourceUrl: DEFAULT_ZTOOLS_MARKET_URL, sourceKind: "ztools" });
  mutation.resolve({ id: plugin.id, name: plugin.name }); await action;
});

it.each(["list", "observer"])("does not offer another install when a successful mutation has a failed %s refresh", async stage => {
  const { controller, invoke } = harness(); controller.configure(preferences); await tick();
  const base = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, args) => {
    if (command === "list_plugins") throw new Error("list unavailable");
    return base(command, args);
  });
  if (stage === "observer") {
    // A throwing subscriber on installation completion is separate from the mutation.
    const second = new PluginMarketController({ invoke: invoke as never, confirm: async () => true, hasRuntime: () => true,
      onInstalled: () => { throw new Error("observer unavailable"); } });
    invoke.mockImplementation(async (command, args) => command === "list_plugins" ? [] : base(command, args));
    second.configure(preferences); await tick(); await second.install(plugin.id);
    expect(second.state.retry).toBeNull(); expect(second.state.recentlyInstalled?.id).toBe(plugin.id);
    expect(second.state.status).toContain("已安装"); return;
  }
  await controller.install(plugin.id);
  expect(controller.state.retry).toBeNull(); expect(controller.state.recentlyInstalled?.id).toBe(plugin.id);
  expect(controller.state.installed.some(item => item.id === plugin.id)).toBe(true);
  expect(controller.state.status).toContain("列表刷新失败");
  await controller.retry(); expect(invoke.mock.calls.filter(([command]) => command === "install_plugin_from_market")).toHaveLength(1);
});

it("keeps successful installed state when an older list snapshot waits on a slow catalog", async () => {
  const { controller, invoke } = harness(); controller.configure(preferences); await tick();
  const mutation = deferred<unknown>(), slowCatalog = deferred<PluginMarketCatalog>();
  let complete = false;
  invoke.mockImplementation(async command => {
    if (command === "list_plugins") return complete ? [{ id: plugin.id, name: plugin.name, version: plugin.version }] : [];
    if (command === "fetch_plugin_market_catalog") return slowCatalog.promise;
    if (command === "resolve_plugin_market_download") return { download_url: "https://ztools.zosen.link/plugin.zip", package_format: "zip" };
    if (command === "install_plugin_from_market") return mutation.promise;
  });
  const installation = controller.install(plugin.id); await tick();
  const refresh = controller.refresh(); await tick();
  complete = true; mutation.resolve({ id: plugin.id, name: plugin.name, version: plugin.version }); await installation;
  slowCatalog.resolve(catalog(preferences.url)); await refresh;
  expect(controller.state.installed.map(item => item.id)).toEqual([plugin.id]);
});

it("retains the executing lock across a hidden visit and invalidates only pending reads/approval", async () => {
  const { controller, invoke } = harness(); controller.configure(preferences); await tick();
  const mutation = deferred<unknown>(); const base = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => command === "install_plugin_from_market" ? mutation.promise : base(command, args));
  const installation = controller.install(plugin.id); await tick(); const operationId = controller.state.operationId;
  controller.leave(); expect(controller.state.pendingId).toBe(plugin.id); expect(controller.state.operationId).toBe(operationId);
  controller.configure(preferences); await tick(); await controller.install(plugin.id);
  expect(invoke.mock.calls.filter(([command]) => command === "install_plugin_from_market")).toHaveLength(1);
  await controller.cancel(); expect(invoke).toHaveBeenCalledWith("cancel_plugin_market_operation", { operationId });
  mutation.resolve({ id: plugin.id, name: plugin.name }); await installation;
});

it("does not publish a stale install failure after leaving and switching source", async () => {
  const { controller, invoke } = harness(); controller.configure(preferences); await tick();
  const mutation = deferred<unknown>();
  const base = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => command === "install_plugin_from_market" ? mutation.promise : base(command, args));
  const installation = controller.install(plugin.id); await tick();
  expect(controller.state.operationId).not.toBe("");

  const nextSource = { ...preferences, url: "https://second.example/catalog.json" };
  controller.leave();
  controller.configure(nextSource); await tick();
  mutation.reject(new Error("[PLUGIN_RUNTIME_DEPENDENCY_MISSING] stale source failure"));
  await installation;

  expect(controller.state.catalog?.source_url).toBe(nextSource.url);
  expect(controller.state.installFailure).toBe("");
  expect(controller.state.retry).toBeNull();
  expect(controller.state.status).not.toContain("stale source failure");
});

it("releases unexecuted confirmation on leave without letting its late finalizer unlock a new transaction", async () => {
  const { controller, invoke, confirm } = harness(); controller.configure(preferences); await tick();
  const oldAnswer = deferred<boolean>(), mutation = deferred<unknown>();
  confirm.mockImplementationOnce(() => oldAnswer.promise);
  const abandoned = controller.install(plugin.id); await tick();
  controller.leave(); expect(controller.state.pendingId).toBe(""); controller.configure(preferences); await tick();
  const base = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => command === "install_plugin_from_market" ? mutation.promise : base(command, args));
  const current = controller.install(plugin.id); await tick(); const id = controller.state.operationId;
  expect(id).not.toBe(""); oldAnswer.resolve(true); await abandoned;
  expect(controller.state.operationId).toBe(id); expect(controller.state.pendingId).toBe(plugin.id);
  expect(invoke.mock.calls.filter(([command]) => command === "install_plugin_from_market")).toHaveLength(1);
  mutation.resolve({ id: plugin.id, name: plugin.name }); await current;
});

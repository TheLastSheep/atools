import { expect, it, vi } from "vitest";
import { PluginMarketController } from "../../src/lib/pluginMarketController";
import { DEFAULT_ZTOOLS_MARKET_URL, type MarketConfirm } from "../../src/lib/pluginMarketView";
import type { InstalledPlugin, PluginMarketCatalogPlugin } from "../../src/lib/types";

const row: PluginMarketCatalogPlugin = { id: "exact-clicked-id", name: "目录工具", version: "1.0.0", description: "旧目录",
  trust_policy: "official_ztools_confirm", checksum: "old-checksum", download_url: "https://ztools.zosen.link/obsolete.zip" };
const latest = { ...row, name: "当前工具", version: "2.0.0", description: "当前发布信息", checksum: "current-checksum",
  download_url: null, download_resolver_url: "https://z-tools.top/api/market/plugins/download?name=exact-clicked-id" };
const official = { custom: false, url: "", trustedPublicKeys: "pinned-key" };
const lookup = (status = "available", plugin: PluginMarketCatalogPlugin | null = latest) => ({ plugin_id: row.id,
  source_url: DEFAULT_ZTOOLS_MARKET_URL, source_kind: "ztools", status, plugin });
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(answer => { resolve = answer; }); return { promise, resolve }; }
function harness(installed: InstalledPlugin[] = []) {
  let response: unknown = lookup();
  const confirm = vi.fn(async (_request: MarketConfirm) => true);
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (command === "list_plugins") return installed;
    if (command === "fetch_plugin_market_catalog") return { source_url: args?.url, source_kind: "ztools", plugins: Array.from({ length: 220 }, (_, index) => index === 0 ? row : { ...row, id: `other-${index}` }) };
    if (command === "fetch_official_plugin_target") { if (response instanceof Error) throw response; return response; }
    if (command === "resolve_plugin_market_download") return { download_url: "https://ztools.zosen.link/current.zip", package_format: "zip" };
    if (command === "install_plugin_from_market" || command === "update_plugin_from_market") return { id: row.id, version: (args?.expectedVersion), enabled: false };
    throw Error("Unexpected IPC: " + command);
  });
  const controller = new PluginMarketController({ invoke: invoke as never, hasRuntime: () => true, confirm });
  const calls = (name: string) => invoke.mock.calls.filter(([command]) => command === name);
  return { controller, invoke, confirm, calls, respond(value: unknown) { response = value; } };
}

it("performs no per-entry or idle lookup for 220 rows; only the clicked identity is checked before resolve and approval", async () => {
  const test = harness(); test.controller.configure(official); await settle();
  test.controller.setQuery("目录"); test.controller.select(row.id); await settle();
  expect(test.calls("fetch_official_plugin_target")).toHaveLength(0);
  await test.controller.install(row.id);
  expect(test.calls("fetch_official_plugin_target")).toEqual([["fetch_official_plugin_target", { pluginId: row.id }]]);
  const commands = test.invoke.mock.calls.map(([command]) => command);
  expect(commands.indexOf("fetch_official_plugin_target")).toBeLessThan(commands.indexOf("resolve_plugin_market_download"));
  expect(test.calls("resolve_plugin_market_download")[0][1]?.plugin).toEqual(latest);
  expect(test.confirm.mock.calls[0][0]).toMatchObject({ title: "安装插件 · 发布版本已变化", confirmLabel: "安装 v2.0.0" });
  expect(test.confirm.mock.calls[0][0].message).toContain("你选择的是 v1.0.0，当前发布版为 v2.0.0");
  expect(test.calls("install_plugin_from_market")[0][1]).toMatchObject({ expectedVersion: "2.0.0", checksum: "current-checksum",
    downloadUrl: "https://ztools.zosen.link/current.zip", signature: null, publicKey: null, confirmedUnsigned: true });
  expect(test.controller.state.catalog?.plugins).toHaveLength(220); expect(test.controller.state.query).toBe("目录");
  expect(test.controller.state.catalog?.plugins[0]).toEqual(latest);
});

it("updates an installed release rather than reinstalling the obsolete aggregate version", async () => {
  const test = harness([{ id: row.id, version: "1.0.0", enabled: true } as InstalledPlugin]);
  test.controller.configure(official); await settle(); await test.controller.install(row.id);
  expect(test.confirm.mock.calls[0][0]).toMatchObject({ title: "更新插件 · 发布版本已变化", confirmLabel: "更新 v2.0.0" });
  expect(test.calls("update_plugin_from_market")[0][1]).toMatchObject({ expectedVersion: "2.0.0" });
  expect(test.calls("install_plugin_from_market")).toHaveLength(0);
});

it("cancels the changed-version approval without installing, enabling or opening anything", async () => {
  const test = harness(); test.confirm.mockResolvedValue(false);
  test.controller.configure(official); await settle(); await test.controller.install(row.id);
  expect(test.calls("install_plugin_from_market")).toHaveLength(0); expect(test.calls("update_plugin_from_market")).toHaveLength(0);
  expect(test.controller.state.recentlyInstalled).toBeNull(); expect(test.controller.state.installed).toEqual([]);
  expect(test.controller.state.pendingId).toBe(""); expect(test.controller.state.status).toContain("已取消安装");
});

it.each([...["unsupported_platform", "not_found"].map(status => ({ status, update: false })),
  ...["unsupported_platform", "not_found"].map(status => ({ status, update: true }))])("stops $status (update=$update) before resolver, approval and mutation", async ({ status, update }) => {
  const test = harness(update ? [{ id: row.id, version: "1.0.0" } as InstalledPlugin] : []); test.respond(lookup(status, null));
  test.controller.configure(official); await settle(); await test.controller.install(row.id);
  expect(test.controller.state.installTarget).toMatchObject({ id: row.id, status });
  expect(test.controller.state.status).toContain("未开始下载安装"); expect(test.confirm).not.toHaveBeenCalled();
  expect(test.calls("resolve_plugin_market_download")).toHaveLength(0); expect(test.calls("install_plugin_from_market")).toHaveLength(0);
  expect(test.calls("update_plugin_from_market")).toHaveLength(0);
});

it.each(["offline", "wrong identity", "wrong provenance", "malformed"])("fails closed on %s and permits an explicit fresh check", async failure => {
  const test = harness();
  test.respond(failure === "offline" ? Error("offline") : failure === "wrong identity" ? { ...lookup(), plugin_id: "similar-id" }
    : failure === "wrong provenance" ? { ...lookup(), source_url: "https://custom.invalid/catalog" } : { ...lookup(), plugin: { ...latest, version: "" } });
  test.controller.configure(official); await settle(); await test.controller.install(row.id);
  expect(test.controller.state.installTarget?.status).toBe("error"); expect(test.confirm).not.toHaveBeenCalled();
  expect(test.calls("resolve_plugin_market_download")).toHaveLength(0); expect(test.calls("install_plugin_from_market")).toHaveLength(0);
  test.respond(lookup()); test.confirm.mockResolvedValue(false); await test.controller.retry();
  expect(test.calls("fetch_official_plugin_target")).toHaveLength(2); expect(test.confirm).toHaveBeenCalledTimes(1);
});

it.each(["leave", "source", "dispose"])("discards an outstanding platform reply after %s without resolver or approval", async invalidation => {
  const test = harness(), pending = deferred<unknown>(); test.respond(pending.promise);
  test.controller.configure(official); await settle(); const first = test.controller.install(row.id);
  await test.controller.install(row.id); expect(test.calls("fetch_official_plugin_target")).toHaveLength(1);
  if (invalidation === "leave") test.controller.leave();
  else if (invalidation === "source") test.controller.configure({ ...official, custom: true, url: "https://custom.invalid/catalog" });
  else test.controller.dispose();
  pending.resolve(lookup()); await first;
  expect(test.calls("resolve_plugin_market_download")).toHaveLength(0); expect(test.confirm).not.toHaveBeenCalled();
  expect(test.calls("install_plugin_from_market")).toHaveLength(0);
});

it("rechecks retry against the original source and confirms another newly published version", async () => {
  const test = harness(); const original = test.invoke.getMockImplementation()!;
  test.invoke.mockImplementation((command, args) => command === "install_plugin_from_market" ? Promise.reject(Error("synthetic failure")) : original(command, args));
  test.controller.configure(official); await settle(); await test.controller.install(row.id);
  expect(test.controller.state.retry?.plugin.version).toBe("2.0.0");
  test.controller.configure({ ...official, custom: true, url: "https://custom.invalid/catalog" }); await settle();
  test.respond(lookup("available", { ...latest, version: "3.0.0" })); test.confirm.mockResolvedValue(false);
  await test.controller.retry();
  expect(test.calls("fetch_official_plugin_target")).toHaveLength(2);
  expect(test.confirm.mock.calls[1][0].message).toContain("你选择的是 v2.0.0，当前发布版为 v3.0.0");
  expect(test.confirm.mock.calls[1][0].message).toContain(DEFAULT_ZTOOLS_MARKET_URL);
  expect(test.calls("install_plugin_from_market")).toHaveLength(1);
});

it("cannot let a late abandoned preflight unlock or overwrite the current transaction", async () => {
  const test = harness(), firstReply = deferred<unknown>(), mutation = deferred<unknown>();
  test.respond(firstReply.promise); test.controller.configure(official); await settle();
  const abandoned = test.controller.install(row.id); test.controller.leave();
  test.respond(lookup()); test.controller.configure(official); await settle();
  const original = test.invoke.getMockImplementation()!;
  test.invoke.mockImplementation((command, args) => command === "install_plugin_from_market" ? mutation.promise : original(command, args));
  const current = test.controller.install(row.id); await settle(); const operationId = test.controller.state.operationId;
  expect(operationId).not.toBe(""); firstReply.resolve(lookup("unsupported_platform", null)); await abandoned;
  expect(test.controller.state.operationId).toBe(operationId); expect(test.controller.state.pendingId).toBe(row.id);
  expect(test.controller.state.installTarget?.status).toBe("available"); expect(test.calls("resolve_plugin_market_download")).toHaveLength(1);
  mutation.resolve({ id: row.id, version: latest.version, enabled: false }); await current;
});

it("freezes the checked release through resolution and does not inherit obsolete catalog fields", async () => {
  const test = harness(), resolution = deferred<unknown>(), checked = { ...latest };
  test.respond(lookup("available", checked)); test.controller.configure(official); await settle();
  const original = test.invoke.getMockImplementation()!;
  test.invoke.mockImplementation((command, args) => command === "resolve_plugin_market_download" ? resolution.promise : original(command, args));
  const installation = test.controller.install(row.id); await settle(); checked.version = "silently-mutated"; checked.checksum = "silently-mutated";
  resolution.resolve({ download_url: "https://ztools.zosen.link/current.zip", package_format: "zip" }); await installation;
  expect(test.calls("install_plugin_from_market")[0][1]).toMatchObject({ expectedVersion: "2.0.0", checksum: "current-checksum" });
  expect(test.confirm.mock.calls[0][0].message).toContain("当前发布版为 v2.0.0");
});

it("applies trust checks again to the current release before resolving a package", async () => {
  const test = harness(); test.respond(lookup("available", { ...latest, signature: "new-signature", public_key: "untrusted-key" }));
  test.controller.configure(official); await settle(); await test.controller.install(row.id);
  expect(test.controller.state.status).toContain("已拒绝安装"); expect(test.confirm).not.toHaveBeenCalled();
  expect(test.calls("resolve_plugin_market_download")).toHaveLength(0);
});

it("does not substitute official metadata for a signed custom-market release", async () => {
  const test = harness(), original = test.invoke.getMockImplementation()!;
  const custom = { ...official, custom: true, url: "https://custom.invalid/catalog" };
  const signed = { ...row, signature: "signature", public_key: "pinned-key", trust_policy: "signed_required" };
  test.invoke.mockImplementation((command, args) => command === "fetch_plugin_market_catalog"
    ? Promise.resolve({ source_url: custom.url, source_kind: "atools", plugins: [signed] }) : original(command, args));
  test.controller.configure(custom); await settle(); await test.controller.install(row.id);
  expect(test.calls("fetch_official_plugin_target")).toHaveLength(0);
  expect(test.calls("resolve_plugin_market_download")[0][1]?.plugin).toEqual(signed);
  expect(test.calls("install_plugin_from_market")[0][1]).toMatchObject({ expectedVersion: "1.0.0", signature: "signature", publicKey: "pinned-key", confirmedUnsigned: false });
});

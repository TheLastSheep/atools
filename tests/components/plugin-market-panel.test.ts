import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PluginMarketPanel from "../../src/components/PluginMarketPanel.svelte";
import SettingsPanel from "../../src/components/SettingsPanel.svelte";
import { DEFAULT_ZTOOLS_MARKET_URL } from "../../src/lib/pluginMarketView";
import { SETTINGS_STORAGE_KEY } from "../../src/lib/settings";
import type { PluginMarketCatalog, PluginMarketCatalogPlugin } from "../../src/lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
const target: PluginMarketCatalogPlugin = { id: "regex-editor", name: "正则编辑器", version: "1.0.0", description: "原版正则", trust_policy: "official_ztools_confirm" };
const closeMatch = { ...target, id: "regex-editor-extra", name: "regex-editor" };
const custom = "https://custom.example/catalog.json";
let officialRows: PluginMarketCatalogPlugin[];
const preferences = { pluginMarketCustom: true, pluginMarketUrl: custom, pluginMarketTrustedPublicKeys: [] };
beforeEach(() => {
  officialRows = [closeMatch, target]; mocks.invoke.mockReset(); mocks.listen.mockClear();
  Object.assign(window, { __TAURI_INTERNALS__: { invoke: mocks.invoke } });
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(preferences));
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "get_setting") return JSON.stringify(preferences);
    if (command === "list_plugins") return [];
    if (command === "fetch_official_plugin_target") return { plugin_id: args.pluginId, source_url: DEFAULT_ZTOOLS_MARKET_URL, source_kind: "ztools", status: officialRows.some(row => row.id === args.pluginId) ? "available" : "not_found", plugin: officialRows.find(row => row.id === args.pluginId) ?? null };
    if (command === "fetch_plugin_market_catalog") return { source_url: args.url, source_kind: args.url === DEFAULT_ZTOOLS_MARKET_URL ? "ztools" : "atools", plugins: args.url === DEFAULT_ZTOOLS_MARKET_URL ? officialRows : [{ ...target, id: "custom-only", name: "私有目录插件" }] } as PluginMarketCatalog;
    if (command === "resolve_plugin_market_download") return { download_url: "https://ztools.zosen.link/plugin.zip", package_format: "zip", trust_policy: "official_ztools_confirm" };
    if (command === "install_plugin_from_market") return { id: target.id, name: target.name, version: target.version, enabled: false, features: [] };
    return [];
  });
});
afterEach(() => { cleanup(); localStorage.clear(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });
const request = () => ({ source: "official_ztools" as const, pluginName: "regex-editor" });
function panel(confirm = vi.fn(async () => false)) {
  return { confirm, ...render(PluginMarketPanel, { custom: true, url: custom, trustedPublicKeys: "", marketRequest: request(), confirm }) };
}
const mutationCalls = () => mocks.invoke.mock.calls.filter(([command]) => command === "install_plugin_from_market" || command === "update_plugin_from_market");

it("shows only an exact manifest ID and performs no resolver or installation automatically", async () => {
  panel();
  await screen.findByRole("heading", { name: /正则编辑器/, level: 4 });
  expect(document.querySelectorAll(".plugin-row")).toHaveLength(1);
  expect(document.querySelector(".plugin-row code")?.textContent).toBe("regex-editor");
  expect(screen.getByLabelText("官方发布版查找").textContent).toContain("市场设置保持不变");
  expect(mocks.invoke.mock.calls.some(([command]) => command === "resolve_plugin_market_download")).toBe(false);
  expect(mutationCalls()).toEqual([]);
  expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!)).toMatchObject(preferences);
});

it("does not substitute a similar title or the first catalog item for a missing target", async () => {
  officialRows = [closeMatch]; panel();
  expect(await screen.findByLabelText("未找到官方发布信息")).toBeTruthy();
  expect(document.querySelectorAll(".plugin-row")).toHaveLength(0);
  expect(screen.queryByLabelText("远程详情")).toBeNull();
});

it("does not label or enable an unsigned third-party catalog as official", async () => {
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command, args) => command === "fetch_plugin_market_catalog"
    ? Promise.resolve({ source_url: "https://z-tools.top.evil/api/market", source_kind: "ztools", plugins: [target] }) : original(command, args));
  render(PluginMarketPanel, { custom: true, url: custom, trustedPublicKeys: "", confirm: async () => false });
  await screen.findByRole("heading", { name: /正则编辑器/, level: 4 });
  expect(document.querySelector(".plugin-row")?.textContent).not.toContain("官方源 · 未签名");
  expect((screen.getByRole("button", { name: "安装", exact: true }) as HTMLButtonElement).disabled).toBe(true);
});

it("clears a target to search the returned catalog then restores the saved source", async () => {
  panel(); await screen.findByRole("heading", { name: /正则编辑器/, level: 4 });
  await fireEvent.click(screen.getByRole("button", { name: "查看官方目录" }));
  await waitFor(() => expect(document.querySelectorAll(".plugin-row")).toHaveLength(2));
  await fireEvent.input(screen.getByRole("searchbox", { name: "搜索本次目录" }), { target: { value: "extra" } });
  expect(document.querySelectorAll(".plugin-row")).toHaveLength(1);
  expect(document.querySelector(".plugin-row code")?.textContent).toBe("regex-editor-extra");
  await fireEvent.click(screen.getByRole("button", { name: "恢复我的来源" }));
  await screen.findByRole("heading", { name: /私有目录插件/ });
  expect(screen.queryByLabelText("官方发布版查找")).toBeNull();
  expect(mocks.invoke).toHaveBeenCalledWith("fetch_plugin_market_catalog", { url: custom });
  expect(mutationCalls()).toEqual([]);
});

it("keeps installation disabled while resolving and a cancelled confirmation performs no mutation", async () => {
  let resolve!: (value: unknown) => void; const pending = new Promise(answer => { resolve = answer; });
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command, args) => command === "resolve_plugin_market_download" ? pending : original(command, args));
  const { confirm } = panel(); await screen.findByRole("heading", { name: /正则编辑器/, level: 4 });
  await fireEvent.click(screen.getByRole("button", { name: "安装", exact: true }));
  const busy = screen.getByRole("button", { name: "安装中" }) as HTMLButtonElement;
  expect(busy.disabled).toBe(true);
  resolve({ download_url: "https://ztools.zosen.link/plugin.zip", package_format: "zip" });
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  await screen.findByRole("button", { name: "安装", exact: true }); expect(mutationCalls()).toEqual([]);
});

it("shows actionable dependency guidance without blind retry and keeps explicit install confirmation available", async () => {
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "get_setting") return JSON.stringify(preferences);
    if (command === "list_plugins") return [];
    if (command === "fetch_official_plugin_target") return { plugin_id: args.pluginId, source_url: DEFAULT_ZTOOLS_MARKET_URL,
      source_kind: "ztools", status: "available", plugin: target };
    if (command === "resolve_plugin_market_download") return { download_url: "https://ztools.zosen.link/plugin.zip", package_format: "zip", trust_policy: "official_ztools_confirm" };
    if (command === "install_plugin_from_market") throw new Error("[PLUGIN_RUNTIME_DEPENDENCY_MISSING] 缺少 lodash（preload/index.cjs）");
    return [];
  });
  const confirm = vi.fn(async () => true);
  panel(confirm);
  await screen.findByRole("heading", { name: /正则编辑器/, level: 4 });
  await fireEvent.click(screen.getByRole("button", { name: "安装", exact: true }));
  expect(await screen.findByText("发布包缺少运行依赖")).toBeTruthy();
  expect(screen.getByText(/请改选包含运行依赖的发布包/)).toBeTruthy();
  expect(screen.getByText(/PLUGIN_RUNTIME_DEPENDENCY_MISSING/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "安装", exact: true }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByRole("button", { name: /重试.*原来源/ })).toBeNull();
  expect(mutationCalls()).toHaveLength(1);
  await fireEvent.click(screen.getByRole("button", { name: "安装", exact: true }));
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(mutationCalls()).toHaveLength(2));
});

it("a source change during confirmation invalidates the previous approval", async () => {
  let approve!: (value: boolean) => void;
  const confirm = vi.fn(() => new Promise<boolean>(resolve => { approve = resolve; }));
  panel(confirm); await screen.findByRole("heading", { name: /正则编辑器/, level: 4 });
  await fireEvent.click(screen.getByRole("button", { name: "安装", exact: true }));
  await waitFor(() => expect(confirm).toHaveBeenCalled());
  await fireEvent.click(screen.getByRole("button", { name: "恢复我的来源" }));
  await screen.findByRole("heading", { name: /私有目录插件/ }); approve(true);
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("确认已失效"));
  expect(mutationCalls()).toEqual([]);
});

it("uses the real SettingsPanel confirmation, preserves preferences, and consumes navigation once", async () => {
  render(SettingsPanel, { initialMenu: "market", marketRequest: request() });
  await screen.findByRole("heading", { name: /正则编辑器/, level: 4 });
  await fireEvent.click(screen.getByRole("button", { name: "安装", exact: true }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("未提供可验证的 SHA-256 或 Ed25519 签名");
  expect(dialog.textContent).toContain(DEFAULT_ZTOOLS_MARKET_URL);
  await fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  expect(mutationCalls()).toEqual([]);
  await fireEvent.click(screen.getByRole("button", { name: /通用设置/ }));
  await fireEvent.click(screen.getByRole("button", { name: /插件市场/ }));
  await screen.findByRole("heading", { name: /私有目录插件/ });
  expect(screen.queryByLabelText("官方发布版查找")).toBeNull();
  expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!)).toMatchObject(preferences);
});

it("retains one executing transaction across full market unmount/remount and binds new UI callbacks", async () => {
  let finish!: (value: unknown) => void;
  const mutation = new Promise(resolve => { finish = resolve; });
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command, args) => command === "install_plugin_from_market" ? mutation : original(command, args));
  const firstInstalled = vi.fn(), secondInstalled = vi.fn();
  const first = render(PluginMarketPanel, { sharedSession: true, custom: true, url: custom, trustedPublicKeys: "", marketRequest: request(), confirm: async () => true, onInstalled: firstInstalled });
  await screen.findByRole("heading", { name: /正则编辑器/, level: 4 });
  await fireEvent.click(screen.getByRole("button", { name: "安装", exact: true }));
  await screen.findByRole("button", { name: "取消下载" }); expect(mutationCalls()).toHaveLength(1);
  first.unmount();
  const secondConfirm = vi.fn(async () => false), manage = vi.fn();
  render(PluginMarketPanel, { sharedSession: true, custom: true, url: custom, trustedPublicKeys: "", marketRequest: request(), confirm: secondConfirm, onInstalled: secondInstalled, onManageInstalled: manage });
  await screen.findByRole("heading", { name: /正则编辑器/, level: 4 });
  expect((screen.getByRole("button", { name: "安装中" }) as HTMLButtonElement).disabled).toBe(true);
  await fireEvent.click(screen.getByRole("button", { name: "安装中" })); expect(mutationCalls()).toHaveLength(1);
  await fireEvent.click(screen.getByRole("button", { name: "取消下载" }));
  expect(mocks.invoke.mock.calls.some(([command]) => command === "cancel_plugin_market_operation")).toBe(true);
  finish({ id: target.id, name: target.name, enabled: false, version: target.version, features: [] });
  await screen.findByRole("button", { name: "查看并启用" });
  expect(firstInstalled).not.toHaveBeenCalled(); expect(secondInstalled).toHaveBeenCalledTimes(1);
  await fireEvent.click(screen.getByRole("button", { name: "查看并启用" })); expect(manage).toHaveBeenCalledWith(target.id);
  await fireEvent.click(screen.getByRole("button", { name: "安装", exact: true }));
  await waitFor(() => expect(secondConfirm).toHaveBeenCalledTimes(1));
  expect(mutationCalls()).toHaveLength(1);
  expect(mocks.invoke.mock.calls.some(([command]) => command === "toggle_plugin" || command === "authorize_plugin_permissions")).toBe(false);
});

it("cleans a late progress-listener registration after the only view has gone", async () => {
  let register!: (value: () => void) => void;
  mocks.listen.mockImplementationOnce(() => new Promise(resolve => { register = resolve; }));
  const view = render(PluginMarketPanel, { sharedSession: true, custom: true, url: custom, trustedPublicKeys: "", marketRequest: request(), confirm: async () => false });
  await screen.findByRole("heading", { name: /正则编辑器/, level: 4 }); view.unmount();
  const stop = vi.fn(); register(stop); await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
});

it("does not fetch the catalog before the first market visit", async () => {
  render(SettingsPanel, { initialMenu: "general" });
  await waitFor(() => expect(mocks.invoke.mock.calls.some(([command]) => command === "get_setting")).toBe(true));
  expect(mocks.invoke.mock.calls.some(([command]) => command === "fetch_plugin_market_catalog")).toBe(false);
  expect(mocks.invoke.mock.calls.some(([command]) => command === "prepare_legacy_node")).toBe(false);
});

it("closes a real pending Settings confirmation on full unmount and permits a fresh visit", async () => {
  const first = render(SettingsPanel, { initialMenu: "market", marketRequest: request() });
  await screen.findByRole("heading", { name: /正则编辑器/, level: 4 });
  await fireEvent.click(screen.getByRole("button", { name: "安装", exact: true }));
  await screen.findByRole("dialog"); first.unmount();
  render(SettingsPanel, { initialMenu: "market", marketRequest: request() });
  await screen.findByRole("heading", { name: /正则编辑器/, level: 4 });
  const button = screen.getByRole("button", { name: "安装", exact: true }) as HTMLButtonElement;
  expect(button.disabled).toBe(false); await fireEvent.click(button);
  const dialog = await screen.findByRole("dialog"); await fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  expect(mutationCalls()).toEqual([]);
});

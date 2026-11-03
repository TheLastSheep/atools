import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PluginMarketSourceAction from "../../src/components/PluginMarketSourceAction.svelte";
import SettingsPanel from "../../src/components/SettingsPanel.svelte";
import { DEFAULT_ZTOOLS_MARKET_URL } from "../../src/lib/pluginMarketView";
import { SETTINGS_STORAGE_KEY } from "../../src/lib/settings";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
const custom = "https://custom.example/catalog.json";
beforeEach(() => {
  mocks.invoke.mockReset(); Object.assign(window, { __TAURI_INTERNALS__: { invoke: mocks.invoke } });
  const preferences = { pluginMarketCustom: false, pluginMarketUrl: custom };
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(preferences));
  mocks.invoke.mockImplementation(async command => command === "get_setting" ? JSON.stringify(preferences) : []);
});
afterEach(() => { cleanup(); localStorage.clear(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });

it("opens the effective configured source from real general settings and never fetches or installs a catalog", async () => {
  render(SettingsPanel, { initialMenu: "general" });
  const button = await screen.findByRole("button", { name: "打开市场地址" });
  await fireEvent.click(button);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("call_agent_tool", {
    name: "open_url", arguments: { url: DEFAULT_ZTOOLS_MARKET_URL }, clientId: "atools-ui", confirmed: true,
  }));
  await screen.findByText("已打开插件市场地址");
  await fireEvent.click(screen.getByTitle("启用自定义插件市场地址"));
  await fireEvent.click(button);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("call_agent_tool", {
    name: "open_url", arguments: { url: custom }, clientId: "atools-ui", confirmed: true,
  }));
  expect(mocks.invoke.mock.calls.some(([command]) => command === "fetch_plugin_market_catalog" || command === "resolve_plugin_market_download" || command === "install_plugin_from_market")).toBe(false);
});

it.each(["not a URL", "file:///private/tmp/catalog.json", "javascript:alert(1)"])("shows validation failure and does not open invalid source %s", async sourceUrl => {
  const callCapability = vi.fn(async () => {});
  render(PluginMarketSourceAction, { sourceUrl, runtime: true, callCapability });
  await fireEvent.click(screen.getByRole("button", { name: "打开来源" }));
  expect(screen.getByRole("status").textContent).toMatch(/地址格式无效|仅支持 http\/https/);
  expect(callCapability).not.toHaveBeenCalled();
});

it("shows structured-capability failure and disables browser-preview opening", async () => {
  const callCapability = vi.fn(async () => { throw new Error("无法打开浏览器"); });
  const view = render(PluginMarketSourceAction, { sourceUrl: custom, runtime: true, callCapability });
  await fireEvent.click(screen.getByRole("button", { name: "打开来源" }));
  expect(await screen.findByRole("status")).toHaveProperty("textContent", "无法打开浏览器");
  await view.rerender({ sourceUrl: custom, runtime: false, callCapability });
  expect((screen.getByRole("button", { name: "打开来源" }) as HTMLButtonElement).disabled).toBe(true);
});

it("freezes the click source and ignores a late response after the configured source changes", async () => {
  let finish!: () => void;
  const callCapability = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const view = render(PluginMarketSourceAction, { sourceUrl: custom, runtime: true, callCapability });
  await fireEvent.click(screen.getByRole("button", { name: "打开来源" }));
  expect((screen.getByRole("button", { name: "正在打开…" }) as HTMLButtonElement).disabled).toBe(true);
  expect(callCapability).toHaveBeenCalledWith("open_url", { url: custom });
  await view.rerender({ sourceUrl: DEFAULT_ZTOOLS_MARKET_URL, runtime: true, callCapability }); finish();
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  expect(screen.getByRole("button", { name: "打开来源" })).toBeTruthy();
});

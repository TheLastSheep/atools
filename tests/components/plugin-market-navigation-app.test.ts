import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";
import { SETTINGS_STORAGE_KEY } from "../../src/lib/settings";
import { normalizePluginMarketRequest, officialPluginMarketRequest } from "../../src/lib/pluginMarketNavigation";
import type { ZToolsImportCandidate } from "../../src/lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), events: new Map<string, (event: unknown) => void>() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, callback) => { mocks.events.set(name, callback); return () => mocks.events.delete(name); }) }));
// The market worker tests the real market component separately. This probe checks
// only App -> SystemPanel -> SettingsPanel prop delivery and route lifetime.
vi.mock("../../src/components/SettingsPanel.svelte", async () => ({ default: (await import("./PluginMarketSettingsNavigationProbe.svelte")).default }));

const candidate: ZToolsImportCandidate = {
  path: "/synthetic/source/unrelated-directory", source_type: "directory", entry_readiness: "requires_build",
  name: "manifest-stable-id", title: "中文展示标题", version: "1.0.0", features_count: 1,
  platform_supported: true, main_exists: false, preload_exists: true, logo_exists: true,
  unsupported_cmd_types: [], warnings: [], errors: ["Source entry requires a release build"],
};
beforeEach(() => {
  mocks.invoke.mockReset(); mocks.events.clear(); window.history.replaceState(null, "", "/");
  Object.assign(window, { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: "main" } } } });
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ localAppSearch: false, autoPaste: "never", showRecentInSearch: false }));
  mocks.invoke.mockImplementation(async command => {
    if (command === "get_setting") return JSON.stringify({ localAppSearch: false, autoPaste: "never", showRecentInSearch: false });
    if (command === "scan_default_ztools_plugins") return [candidate];
    if (["feature_catalog", "list_pending_agent_requests", "list_plugins", "search_features", "search_local_apps"].includes(command)) return [];
    return undefined;
  });
});
afterEach(() => { cleanup(); localStorage.clear(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); window.history.replaceState(null, "", "/"); });

async function openSystemResult(label: string) {
  const input = await waitFor(() => {
    const value = document.querySelector<HTMLInputElement>(".search-input"); expect(value).toBeTruthy(); return value!;
  });
  await fireEvent.input(input, { target: { value: label } });
  await waitFor(() => expect(screen.getAllByRole("option", { name: new RegExp(label) }).some(option => option.getAttribute("aria-selected") === "true")).toBe(true));
  await fireEvent.keyDown(input, { key: "Enter" });
}

it("carries the exact manifest identity from the real import row through App without installing", async () => {
  render(App, { backgroundServices: false });
  await openSystemResult("导入 ZTools 插件");
  await fireEvent.click(await screen.findByRole("button", { name: "在官方市场查找发布版" }));
  const target = await screen.findByRole("region", { name: "市场导航接入夹具" });
  expect(target.querySelector("[data-menu]")?.textContent).toBe("market");
  expect(target.querySelector("[data-source]")?.textContent).toBe("official_ztools");
  expect(target.querySelector("[data-plugin]")?.textContent).toBe("manifest-stable-id");
  expect(mocks.invoke.mock.calls.some(([command]) => ["import_ztools_plugins", "install_plugin_from_market", "update_plugin_from_market", "prepare_legacy_node"].includes(command))).toBe(false);
});

it("clears the transient request on Escape and supports a later fresh import navigation", async () => {
  render(App, { backgroundServices: false });
  await waitFor(() => expect(document.querySelector(".shell-frame")?.classList.contains("expanded")).toBe(false));
  await openSystemResult("导入 ZTools 插件");
  await fireEvent.click(await screen.findByRole("button", { name: "在官方市场查找发布版" }));
  await screen.findByRole("region", { name: "市场导航接入夹具" });
  expect(document.querySelector(".shell-frame")?.classList.contains("expanded")).toBe(true);
  await fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("region", { name: "市场导航接入夹具" })).toBeNull());
  await waitFor(() => expect(document.querySelector(".shell-frame")?.classList.contains("expanded")).toBe(false));
  await openSystemResult("设置");
  let target = await screen.findByRole("region", { name: "市场导航接入夹具" });
  expect(target.querySelector("[data-plugin]")?.textContent).toBe("");
  await fireEvent.click(screen.getByRole("button", { name: "回到主搜索" }));
  await openSystemResult("导入 ZTools 插件");
  await fireEvent.click(await screen.findByRole("button", { name: "在官方市场查找发布版" }));
  target = await screen.findByRole("region", { name: "市场导航接入夹具" });
  expect(target.querySelector("[data-plugin]")?.textContent).toBe("manifest-stable-id");
});

it("rejects malformed or other-source requests without substituting display text", () => {
  expect(officialPluginMarketRequest(" 中文-stable_ID ")).toEqual({ source: "official_ztools", pluginName: "中文-stable_ID" });
  for (const value of [null, "", "a".repeat(257), "中".repeat(86), "bad\nname", "bad\u0085name"]) expect(officialPluginMarketRequest(value)).toBeNull();
  for (const value of [[], "id", { source: "custom", pluginName: "stable" }, { source: "official_ztools", title: "中文标题" }]) expect(normalizePluginMarketRequest(value)).toBeNull();
});

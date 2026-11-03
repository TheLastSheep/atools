import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";
import type { FeatureAction, SearchResult } from "../../src/lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), events: new Map<string, (event: { payload: unknown }) => void>() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, callback) => { mocks.events.set(name, callback); return () => mocks.events.delete(name); }) }));
vi.mock("../../src/components/PluginPanel.svelte", async () => ({ default: (await import("./PluginLifecyclePanelFixture.svelte")).default }));

// Lifecycle assertions start after the async manual mock is resolved. Native probes cover cold panel loading.
beforeAll(async () => {
  const fixture = await import("./PluginLifecyclePanelFixture.svelte");
  const panel = await import("../../src/components/PluginPanel.svelte");
  expect(panel.default).toBe(fixture.default);
});

const feature: SearchResult = { code: "convert", plugin_id: "converter", plugin_name: "转换插件", label: "字符转换", explain: "转换文本", icon: null, score: 100, match_type: "exact" };
const action: FeatureAction = { plugin_id: "converter", plugin_name: "转换插件", feature_code: "convert", main_url: "fixture://index.html", plugin_path: "/fixture", expand_height: 400, payload: null };
let activation: Promise<FeatureAction>;
let releaseActivation: (action: FeatureAction) => void;
let catalog: SearchResult[];
const destroyed = vi.fn();
beforeEach(() => {
  catalog = [feature];
  activation = new Promise(resolve => { releaseActivation = resolve; });
  mocks.events.clear(); mocks.invoke.mockReset(); destroyed.mockReset();
  window.history.replaceState(null, "", "/");
  Object.assign(window, { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: "main" } } } });
  localStorage.setItem("atools-settings", JSON.stringify({ localAppSearch: false, autoPaste: "never" }));
  mocks.invoke.mockImplementation(async command => {
    if (command === "get_setting") return JSON.stringify({ localAppSearch: false, autoPaste: "never" });
    if (command === "feature_catalog") return catalog;
    if (command === "search_features") return catalog;
    if (command === "search_local_apps" || command === "list_pending_agent_requests") return [];
    if (command === "activate_feature") return activation;
    return undefined;
  });
  window.addEventListener("fixture-plugin-destroyed", destroyed);
});
afterEach(() => {
  cleanup(); localStorage.clear(); mocks.events.clear();
  window.removeEventListener("fixture-plugin-destroyed", destroyed);
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  window.history.replaceState(null, "", "/");
});

function change(pluginId: string, reason: string) { mocks.events.get("plugin-code-changed")?.({ payload: { pluginId, reason } }); }
const catalogReads = () => mocks.invoke.mock.calls.filter(([command]) => command === "feature_catalog").length;
const activationCalls = () => mocks.invoke.mock.calls.filter(([command]) => command === "activate_feature").length;
async function requestPlugin() {
  const input = screen.getByRole("combobox");
  await fireEvent.input(input, { target: { value: "字符转换" } });
  await fireEvent.click(await screen.findByRole("option"));
  await waitFor(() => expect(activationCalls()).toBe(1));
  return input;
}
async function openPlugin() {
  await requestPlugin(); releaseActivation(action);
  return screen.findByRole("region", { name: "隔离插件面板" });
}

it("does not remount an unrelated active panel, but refreshes a burst of catalog changes once", async () => {
  render(App, { backgroundServices: false });
  const panel = await openPlugin();
  const before = catalogReads();
  change("other", "updated"); change("other", "enabled"); change("other", "installed");
  await waitFor(() => expect(catalogReads()).toBe(before + 1));
  expect(screen.getByRole("region", { name: "隔离插件面板" })).toBe(panel);
  expect(destroyed).not.toHaveBeenCalled();
  expect(activationCalls()).toBe(1);
});

it("a reset destroys the matching panel, announces recovery and restores search focus without a catalog read", async () => {
  render(App, { backgroundServices: false });
  await openPlugin();
  const before = catalogReads();
  change("converter", "reset");
  await waitFor(() => expect(screen.queryByRole("region", { name: "隔离插件面板" })).toBeNull());
  expect(destroyed).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status").textContent).toContain("运行环境已重置");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox")));
  expect(catalogReads()).toBe(before);
  catalog = [];
  change("converter", "disabled");
  await waitFor(() => expect(catalogReads()).toBe(before + 1));
  expect(screen.getByRole("status").textContent).toContain("已停用");
  expect(activationCalls()).toBe(1);
  await fireEvent.click(screen.getByRole("button", { name: "继续搜索" }));
  expect(screen.queryByText(/运行环境已重置/)).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("combobox"));
});

it.each([
  ["removed", "插件已卸载，可从插件管理重新安装。"],
  ["disabled", "插件已停用，启用后可从搜索重新打开。"],
  ["updated", "插件已更新，请从搜索重新打开。"],
])("updates the existing reset notice after the final %s event", async (reason, message) => {
  render(App, { backgroundServices: false });
  await openPlugin();
  change("converter", "reset");
  await screen.findByText("插件运行环境已重置，请从搜索重新打开。");
  change("converter", reason);
  expect(await screen.findByText(message)).toBeTruthy();
  expect(destroyed).toHaveBeenCalledTimes(1);
  expect(activationCalls()).toBe(1);
});

it("keeps a new plugin and its internal focus when a previous reset finishes resizing later", async () => {
  render(App, { backgroundServices: false });
  await openPlugin();
  let releaseResize!: () => void;
  const heldResize = new Promise<void>(resolve => { releaseResize = resolve; });
  const originalInvoke = mocks.invoke.getMockImplementation()!;
  let holdNextResize = true;
  const otherFeature = { ...feature, code: "other", plugin_id: "other-plugin", label: "其他插件" };
  const otherAction = { ...action, feature_code: "other", plugin_id: "other-plugin", plugin_name: "其他插件" };
  mocks.invoke.mockImplementation((command, args) => {
    if (command === "expand_window" && holdNextResize) { holdNextResize = false; return heldResize; }
    if (command === "activate_feature") return Promise.resolve(otherAction);
    return originalInvoke(command, args);
  });
  change("converter", "reset");
  await waitFor(() => expect(screen.queryByRole("region", { name: "隔离插件面板" })).toBeNull());
  expect(holdNextResize).toBe(false);
  catalog = [otherFeature];
  await fireEvent.input(screen.getByRole("combobox"), { target: { value: "其他插件" } });
  await fireEvent.click(await screen.findByRole("option"));
  const otherPanel = await screen.findByRole("region", { name: "隔离插件面板" });
  const internalButton = screen.getByRole("button", { name: "插件内部操作" });
  internalButton.focus();
  expect(document.activeElement).toBe(internalButton);
  releaseResize();
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(document.activeElement).toBe(internalButton);
  change("converter", "removed");
  await waitFor(() => expect(catalogReads()).toBeGreaterThan(1));
  expect(screen.getByRole("region", { name: "隔离插件面板" })).toBe(otherPanel);
  expect(otherPanel.getAttribute("data-plugin-id")).toBe("other-plugin");
  expect(screen.queryByText("插件已卸载，可从插件管理重新安装。")).toBeNull();
  expect(destroyed).toHaveBeenCalledTimes(1);
});

it("drops a delayed activation result after that plugin resets and cleans the subscription on unmount", async () => {
  const view = render(App, { backgroundServices: false });
  await requestPlugin();
  change("converter", "reset");
  releaseActivation(action);
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(screen.queryByRole("region", { name: "隔离插件面板" })).toBeNull();
  expect(mocks.invoke.mock.calls.some(([command, args]) => command === "expand_window" && args?.height === 400)).toBe(false);
  view.unmount();
  expect(mocks.events.has("plugin-code-changed")).toBe(false);
});

it("allows a pending activation when only a different plugin resets", async () => {
  render(App, { backgroundServices: false });
  await requestPlugin();
  change("other", "reset");
  releaseActivation(action);
  expect(await screen.findByRole("region", { name: "隔离插件面板" })).toBeTruthy();
});

it("does not restart search when an event-triggered catalog read completes after unmount", async () => {
  const view = render(App, { backgroundServices: false });
  await fireEvent.input(screen.getByRole("combobox"), { target: { value: "字符转换" } });
  await screen.findByRole("option");
  let releaseCatalog!: (value: SearchResult[]) => void;
  const held = new Promise<SearchResult[]>(resolve => { releaseCatalog = resolve; });
  mocks.invoke.mockImplementation(command => {
    if (command === "feature_catalog") return held;
    if (command === "search_features") return Promise.resolve(catalog);
    return Promise.resolve([]);
  });
  change("other", "updated");
  await waitFor(() => expect(catalogReads()).toBe(2));
  view.unmount();
  const before = mocks.invoke.mock.calls.length;
  releaseCatalog(catalog);
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(mocks.invoke.mock.calls).toHaveLength(before);
});

it("subscribes in the detached window before activation and drops a result invalidated during startup", async () => {
  window.history.replaceState(null, "", "/#/plugin-detach?feature_code=convert");
  Object.assign(window, { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: "plugin-detach-fixture" } } } });
  const view = render(App, { backgroundServices: false });
  await waitFor(() => expect(activationCalls()).toBe(1));
  expect(mocks.events.has("plugin-code-changed")).toBe(true);
  expect(catalogReads()).toBe(0);
  change("converter", "reset");
  releaseActivation(action);
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(screen.queryByRole("region", { name: "隔离插件面板" })).toBeNull();
  view.unmount();
  expect(mocks.events.has("plugin-code-changed")).toBe(false);
});

it("closes a detached active panel and offers the main search without automatically reopening code", async () => {
  window.history.replaceState(null, "", "/#/plugin-detach?feature_code=convert");
  Object.assign(window, { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: "plugin-detach-fixture" } } } });
  render(App, { backgroundServices: false });
  await waitFor(() => expect(activationCalls()).toBe(1));
  releaseActivation(action);
  await screen.findByRole("region", { name: "隔离插件面板" });
  change("converter", "removed");
  expect(await screen.findByText("插件已卸载，可从插件管理重新安装。")).toBeTruthy();
  await fireEvent.click(screen.getByRole("button", { name: "返回主搜索" }));
  expect(mocks.invoke).toHaveBeenCalledWith("show_main_window");
  expect(activationCalls()).toBe(1);
  expect(destroyed).toHaveBeenCalledTimes(1);
});

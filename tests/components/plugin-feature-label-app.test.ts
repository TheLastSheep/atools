import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";
import { PLUGIN_OPEN_REQUESTED_EVENT, PluginOpenController, type PluginOpenState } from "../../src/lib/pluginOpen";
import { COMMAND_HISTORY_STORAGE_KEY } from "../../src/lib/commandHistory";

import { SETTINGS_STORAGE_KEY } from "../../src/lib/settings";
import type { FeatureAction, InstalledPlugin, SearchResult } from "../../src/lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), readTextFile: vi.fn(), events: new Map<string, (event: unknown) => void>(), listenerGate: null as Promise<void> | null, listenerStarted: false }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke, convertFileSrc: (file: string) => `asset://fixture/${encodeURIComponent(file)}` }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, callback) => { if (name === "plugin-code-changed" && mocks.listenerGate) { mocks.listenerStarted = true; await mocks.listenerGate; } mocks.events.set(name, callback); return () => mocks.events.delete(name); }) }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readTextFile: mocks.readTextFile }));

const first: FeatureAction = {
  plugin_id: "format-plugin", plugin_name: "格式工具", feature_code: "format-entry",
  feature_label: "格式化 JSON", feature_label_source: "declared", main_url: "index.html",
  plugin_path: "/synthetic/format-plugin", expand_height: 541, payload: null,
};
let actions: Map<string, FeatureAction>;
// This suite checks activation labels. Native probes measure cold loading separately.
beforeAll(async () => { await import("../../src/components/PluginPanel.svelte"); });
beforeEach(() => {
  actions = new Map([[first.feature_code, first]]);
  mocks.events.clear(); mocks.invoke.mockReset(); mocks.readTextFile.mockReset();
  mocks.listenerGate = null; mocks.listenerStarted = false;
  window.history.replaceState(null, "", "/");
  Object.assign(window, { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: "main" } } } });
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ localAppSearch: false, autoPaste: "never" }));
  mocks.readTextFile.mockResolvedValue("<!doctype html><html><head></head><body><main>synthetic feature presentation</main></body></html>");
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "get_setting") return JSON.stringify({ localAppSearch: false, autoPaste: "never" });
    if (command === "activate_feature") return actions.get(args.code);
    if (command === "prepare_plugin_display") return { unavailable: true, usage: "not_detected" };
    if (command === "prepare_host_clipboard") return { unavailable: true };
    if (command === "prepare_plugin_paths") return { usage: "not_detected", unavailable: true };
    if (command === "prepare_plugin_dialogs") return { usage: "not_detected", unavailable: true };
    if (command === "prepare_plugin_data") return { usage: "not_detected", unavailable: true };
    if (["feature_catalog", "list_pending_agent_requests", "search_local_apps", "search_features"].includes(command)) return [];
    return undefined;
  });
});
afterEach(() => { cleanup(); localStorage.clear(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); window.history.replaceState(null, "", "/"); });

async function mountedApp() {
  render(App, { backgroundServices: false });
  await waitFor(() => expect(mocks.events.has("plugin-code-changed")).toBe(true));
}
async function directOpen(code: string) {
  await fireEvent(window, new CustomEvent(PLUGIN_OPEN_REQUESTED_EVENT, { detail: { code, pluginId: first.plugin_id } }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("activate_feature", { code, payload: null, expectedPluginId: first.plugin_id }));
  await waitFor(() => expect(document.querySelector('[data-plugin-feature-code]')?.textContent).toBe(code));
  const frame = await waitFor(() => {
    const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]');
    expect(iframe?.srcdoc).toContain(`featureCode: ${JSON.stringify(code)}`);
    return iframe!;
  });
  return { navigation: screen.getByRole("banner", { name: "插件导航" }), frame };
}

it("uses the activated readable feature name without searching and keeps internal identity in folded diagnostics", async () => {
  await mountedApp();
  const { navigation } = await directOpen(first.feature_code);
  expect(navigation.querySelector(".feature-tag")?.textContent).toBe("格式化 JSON");
  expect(navigation.querySelector(".plugin-title")?.textContent).toBe("格式工具");
  expect(navigation.querySelector(".plugin-source")).toBeNull();
  expect(navigation.textContent).not.toContain("format-entry");
  expect(navigation.textContent).not.toContain("format-plugin");
  expect((document.querySelector(".plugin-diagnostics") as HTMLDetailsElement).open).toBe(false);
  expect(document.querySelector('[data-plugin-source]')?.textContent).toBe("format-plugin");
  expect(mocks.invoke.mock.calls.some(([command]) => command === "search_features")).toBe(false);
  expect(mocks.invoke.mock.calls.some(([command]) => command === "prepare_legacy_node")).toBe(false);
});

it("loads a mounted PluginPanel once and stays idle after the next reactive tick", async () => {
  await mountedApp();
  await directOpen(first.feature_code);
  await tick();
  await tick();
  await new Promise(resolve => setTimeout(resolve, 0));

  expect(document.querySelector('iframe[title="Plugin"]')).not.toBeNull();
  expect(mocks.readTextFile).toHaveBeenCalledTimes(1);
});

it("retries an ordinary App PluginPanel load failure without repeating activation", async () => {
  await mountedApp();
  let rejectFirstHtmlRead = true;
  mocks.readTextFile.mockImplementation(async () => {
    if (rejectFirstHtmlRead) {
      rejectFirstHtmlRead = false;
      throw new Error("Synthetic first HTML read failure");
    }
    return "<!doctype html><html><head></head><body><main>retry mounted</main></body></html>";
  });

  await fireEvent(window, new CustomEvent(PLUGIN_OPEN_REQUESTED_EVENT, { detail: { code: first.feature_code, pluginId: first.plugin_id } }));
  await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "activate_feature")).toHaveLength(1));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("无法加载插件");
  expect(document.querySelector('[data-plugin-feature-code]')?.textContent).toBe(first.feature_code);
  expect(document.querySelector('iframe[title="Plugin"]')).toBeNull();

  await fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
  await waitFor(() => expect(document.querySelector('iframe[title="Plugin"]')?.srcdoc).toContain("retry mounted"));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "activate_feature")).toHaveLength(1);
  expect(document.querySelector('[data-plugin-feature-code]')?.textContent).toBe(first.feature_code);
  expect(document.querySelectorAll('iframe[title="Plugin"]')).toHaveLength(1);
});

it.each(["legacy", "duplicate"] as const)("hides the feature tag for a %s action without changing activation code", async mode => {
  const action = { ...first };
  if (mode === "legacy") { delete action.feature_label; delete action.feature_label_source; }
  else action.feature_label = first.plugin_name;
  actions.set(first.feature_code, action);
  await mountedApp();
  const { navigation } = await directOpen(first.feature_code);
  expect(navigation.querySelector(".feature-tag")).toBeNull();
  expect(navigation.querySelector(".plugin-title")?.textContent).toBe("格式工具");
  expect(document.querySelector('[data-plugin-feature-code]')?.textContent).toBe(first.feature_code);
});

it("keeps distinct readable names and original bridge identities when switching two entries of one plugin", async () => {
  const second: FeatureAction = { ...first, feature_code: "compact-entry", feature_label: "压缩 JSON", feature_label_source: "command_label" };
  actions.set(second.feature_code, second);
  await mountedApp();
  expect((await directOpen(first.feature_code)).navigation.querySelector(".feature-tag")?.textContent).toBe("格式化 JSON");
  expect((await directOpen(second.feature_code)).navigation.querySelector(".feature-tag")?.textContent).toBe("压缩 JSON");
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "activate_feature").map(([, args]) => args.code)).toEqual(["format-entry", "compact-entry"]);
  expect(mocks.readTextFile.mock.calls.every(([file]) => file === "/synthetic/format-plugin/index.html")).toBe(true);
});

it("shows the same returned label for a detached direct activation without a catalog read", async () => {
  window.history.replaceState(null, "", "/#/plugin-detach?feature_code=format-entry&plugin_id=format-plugin");
  Object.assign(window, { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: "plugin-detach-feature-name" } } } });
  render(App, { backgroundServices: false });
  const navigation = await screen.findByRole("banner", { name: "插件导航" });
  expect(navigation.querySelector(".feature-tag")?.textContent).toBe("格式化 JSON");
  expect(mocks.invoke).toHaveBeenCalledWith("activate_feature", { code: "format-entry", payload: null, expectedPluginId: first.plugin_id });
  expect(mocks.invoke.mock.calls.some(([command]) => command === "feature_catalog" || command === "search_features")).toBe(false);
});

it("retries a real App activation after rejection and consumes the request only after one exact-owner mount", async () => {
  const original = mocks.invoke.getMockImplementation()!;
  let rejectOnce = true;
  mocks.invoke.mockImplementation((command, args) => {
    if (command === "activate_feature" && rejectOnce) {
      rejectOnce = false;
      return Promise.reject(new Error("private fixture path must not appear in UI"));
    }
    return original(command, args);
  });
  let state: PluginOpenState = { requestId: null, pluginId: null, busy: false, message: "" };
  let commits = 0;
  const opener = new PluginOpenController(value => { state = value; }, () => { commits += 1; });
  const recentlyInstalled: InstalledPlugin = {
    id: first.plugin_id, name: first.plugin_name, version: "1.0.0", enabled: true,
    path: first.plugin_path, created_at: "2026-10-15", updated_at: "2026-10-15",
    manifest: { title: first.plugin_name, main: first.main_url, features: [{ code: first.feature_code }] },
  };
  try {
    await mountedApp();
    await fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    // Settings is behind App's lazy SystemPanel import; wait for the actual
    // settings content rather than only the shell after the route changes.
    await screen.findByRole("heading", { name: "通用设置概览" }, { timeout: 5000 });
    expect(opener.open(recentlyInstalled)).toBe(true);
    await waitFor(() => expect(state.message).toBe("插件未能打开，请检查插件状态后重试。"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(state.message).not.toContain("private fixture path");
    expect(document.querySelector('iframe[title="Plugin"]')).toBeNull();
    expect(commits).toBe(0);

    expect(opener.open(recentlyInstalled)).toBe(true);
    await waitFor(() => expect(state.busy).toBe(false));
    await waitFor(() => expect(document.querySelector('iframe[title="Plugin"]')?.srcdoc).toContain(`featureCode: ${JSON.stringify(first.feature_code)}`));
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "activate_feature")).toHaveLength(2);
    expect(document.querySelectorAll('iframe[title="Plugin"]')).toHaveLength(1);
    expect(document.querySelector('[data-plugin-source]')?.textContent).toBe(first.plugin_id);
    expect(commits).toBe(1);
  } finally { opener.cancel(); }
});

it("keeps ordinary launcher activation failures visible in the search alert", async () => {
  const launcherFeature: SearchResult = {
    code: "launcher-failure", plugin_id: "launcher-failure-plugin", plugin_name: "搜索失败插件",
    label: "搜索失败入口", explain: "普通启动器路径", icon: null, score: 100, match_type: "exact",
  };
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command, args) => {
    if (command === "feature_catalog" || command === "search_features") return Promise.resolve([launcherFeature]);
    if (command === "activate_feature") return Promise.reject(new Error("private launcher fixture path"));
    return original(command, args);
  });

  await mountedApp();
  await fireEvent.input(screen.getByRole("combobox"), { target: { value: "搜索失败入口" } });
  await fireEvent.click(await screen.findByRole("option", { name: /搜索失败入口/ }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("插件未能打开，请检查插件状态后重试。");
  expect(alert.textContent).not.toContain("private launcher fixture path");
});

it("cancels an in-flight App activation when its opening owner leaves", async () => {
  const original = mocks.invoke.getMockImplementation()!;
  let resolveActivation!: (action: FeatureAction) => void;
  const pendingActivation = new Promise<FeatureAction>(resolve => { resolveActivation = resolve; });
  mocks.invoke.mockImplementation((command, args) => command === "activate_feature" ? pendingActivation : original(command, args));
  let commits = 0;
  const opener = new PluginOpenController(() => {}, () => { commits += 1; });
  const recentlyInstalled: InstalledPlugin = {
    id: first.plugin_id, name: first.plugin_name, version: "1.0.0", enabled: true,
    path: first.plugin_path, created_at: "2026-10-15", updated_at: "2026-10-15",
    manifest: { title: first.plugin_name, main: first.main_url, features: [{ code: first.feature_code }] },
  };
  try {
    await mountedApp();
    opener.open(recentlyInstalled);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("activate_feature", {
      code: first.feature_code, payload: null, expectedPluginId: first.plugin_id,
    }));
    opener.cancel();
    resolveActivation(first);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.querySelector('iframe[title="Plugin"]')).toBeNull();
    expect(commits).toBe(0);
  } finally { opener.cancel(); }
});

function installedFor(action: FeatureAction): InstalledPlugin {
  return {
    id: action.plugin_id, name: action.plugin_name, version: "1.0.0", enabled: true,
    path: action.plugin_path, created_at: "2026-10-15", updated_at: "2026-10-15",
    manifest: { title: action.plugin_name, main: action.main_url, features: [{ code: action.feature_code }] },
  };
}

it("routes a synthetic owned paste-clipboard code through native owner checking", async () => {
  const action: FeatureAction = { ...first, plugin_id: "fixture.clipboard-code", plugin_name: "剪贴板", feature_code: "paste-clipboard" };
  actions.set(action.feature_code, action);
  const opener = new PluginOpenController(() => {}, () => {});
  await mountedApp();
  opener.open(installedFor(action));
  await waitFor(() => expect(document.querySelector('iframe[title="Plugin"]')?.srcdoc).toContain(`featureCode: ${JSON.stringify(action.feature_code)}`));
  expect(mocks.invoke).toHaveBeenCalledWith("activate_feature", { code: "paste-clipboard", payload: null, expectedPluginId: "fixture.clipboard-code" });
  expect(mocks.invoke.mock.calls.some(([command]) => command === "open_pasteboard_shelf_window" || command === "hide_main_window")).toBe(false);
  opener.cancel();
});

it("routes a plugin system: collision through its exact plugin owner", async () => {
  const action: FeatureAction = { ...first, plugin_id: "vendor.settings-collision", plugin_name: "外部设置工具", feature_code: "system:settings" };
  actions.set(action.feature_code, action);
  const opener = new PluginOpenController(() => {}, () => {});
  await mountedApp();
  opener.open(installedFor(action));
  await waitFor(() => expect(document.querySelector('iframe[title="Plugin"]')?.srcdoc).toContain(`featureCode: ${JSON.stringify(action.feature_code)}`));
  expect(mocks.invoke).toHaveBeenCalledWith("activate_feature", { code: "system:settings", payload: null, expectedPluginId: action.plugin_id });
  expect(screen.queryByRole("heading", { name: "通用设置概览" })).toBeNull();
  opener.cancel();
});

it("cancels a synthetic owned clipboard-code open without performing the native shortcut", async () => {
  const action: FeatureAction = { ...first, plugin_id: "fixture.clipboard-code", plugin_name: "剪贴板", feature_code: "paste-clipboard" };
  let resolveActivation!: (action: FeatureAction) => void;
  const pending = new Promise<FeatureAction>(resolve => { resolveActivation = resolve; });
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command, args) => command === "activate_feature" && args.code === action.feature_code ? pending : original(command, args));
  const opener = new PluginOpenController(() => {}, () => {});
  await mountedApp();
  opener.open(installedFor(action));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("activate_feature", { code: action.feature_code, payload: null, expectedPluginId: action.plugin_id }));
  opener.cancel();
  resolveActivation(action);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.querySelector('iframe[title="Plugin"]')).toBeNull();
  expect(mocks.invoke.mock.calls.some(([command]) => command === "open_pasteboard_shelf_window" || command === "hide_main_window")).toBe(false);
});

it("cancels an owned open while the plugin listener is still starting", async () => {
  let resolveListener!: () => void;
  mocks.listenerGate = new Promise<void>((resolve) => { resolveListener = resolve; });
  const opener = new PluginOpenController(() => {}, () => {});
  render(App, { backgroundServices: false });
  await waitFor(() => expect(mocks.listenerStarted).toBe(true));
  opener.open(installedFor(first));
  opener.cancel();
  resolveListener();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(mocks.invoke.mock.calls.some(([command]) => command === "activate_feature")).toBe(false);
  expect(document.querySelector('iframe[title="Plugin"]')).toBeNull();
});

function searchResult(code: string, pluginId: string, pluginName: string, label: string): SearchResult {
  return { code, plugin_id: pluginId, plugin_name: pluginName, label, explain: label, icon: null, score: 100, match_type: "exact" };
}

it("opens the actual clipboard launcher result as its owned plugin, not the native shelf", async () => {
  const action: FeatureAction = { ...first, plugin_id: "clipboard", plugin_name: "剪贴板", feature_code: "clipboard" };
  actions.set(action.feature_code, action);
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command, args) => command === "search_features"
    ? Promise.resolve([searchResult("clipboard", "clipboard", "剪贴板", "剪贴板历史")])
    : original(command, args));

  await mountedApp();
  await fireEvent.input(screen.getByRole("combobox"), { target: { value: "剪贴板历史" } });
  await fireEvent.click(await screen.findByRole("option", { name: /剪贴板历史/ }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("activate_feature", {
    code: "clipboard", payload: null, expectedPluginId: "clipboard",
  }));
  await waitFor(() => expect(document.querySelector('[data-plugin-feature-code]')?.textContent).toBe("clipboard"));
  expect(mocks.invoke.mock.calls.some(([command]) => command === "open_pasteboard_shelf_window" || command === "hide_main_window")).toBe(false);
});

it("replays an owned reserved-code history entry using its stored plugin identity", async () => {
  const action: FeatureAction = { ...first, plugin_id: "clipboard", plugin_name: "剪贴板", feature_code: "clipboard" };
  actions.set(action.feature_code, action);
  localStorage.setItem(COMMAND_HISTORY_STORAGE_KEY, JSON.stringify([{
    code: "clipboard", label: "剪贴板历史入口", explain: "原插件历史记录", plugin_id: "clipboard", plugin_name: "剪贴板",
    icon: "", input: "clipboard query", usedAt: "2026-10-22T12:00:00.000Z", useCount: 1,
  }]));

  const original = mocks.invoke.getMockImplementation()!;
  const clipboardCatalogEntry = searchResult("clipboard", "clipboard", "剪贴板", "剪贴板历史入口");
  mocks.invoke.mockImplementation((command, args) => command === "feature_catalog"
    ? Promise.resolve([clipboardCatalogEntry])
    : command === "search_features" ? Promise.resolve([]) : original(command, args));

  await mountedApp();
  await fireEvent.input(screen.getByRole("combobox"), { target: { value: "剪贴板历史入口" } });
  const historyResultOption = await screen.findByRole("option", { name: /剪贴板历史入口/ });
  expect(historyResultOption.getAttribute("data-result-code")).toMatch(/^history:/);
  await fireEvent.click(historyResultOption);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("activate_feature", {
    code: "clipboard", payload: null, expectedPluginId: "clipboard",
  }));
  await waitFor(() => expect(document.querySelector('[data-plugin-feature-code]')?.textContent).toBe("clipboard"));
  expect(mocks.invoke.mock.calls.some(([command]) => command === "open_pasteboard_shelf_window" || command === "hide_main_window")).toBe(false);
});

it("keeps the unowned ATools system shortcut on its native app route", async () => {
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command, args) => command === "search_features"
    ? Promise.resolve([searchResult("system:settings", "system", "ATools", "设置")])
    : original(command, args));

  await mountedApp();
  await fireEvent.input(screen.getByRole("combobox"), { target: { value: "设置" } });
  await fireEvent.click(await screen.findByRole("option", { name: /设置/ }));
  await screen.findByRole("heading", { name: "通用设置概览" });
  expect(mocks.invoke.mock.calls.some(([command]) => command === "activate_feature")).toBe(false);
});

it("does not route a third-party feature that shares the market system code", async () => {
  const action: FeatureAction = { ...first, plugin_id: "market-code-owner", plugin_name: "市场撞码插件",
    feature_code: "system:market", feature_label: "市场插件入口" };
  actions.set(action.feature_code, action);
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command, args) => command === "search_features"
    ? Promise.resolve([searchResult(action.feature_code, action.plugin_id, action.plugin_name, action.feature_label)])
    : original(command, args));

  await mountedApp();
  await fireEvent.input(screen.getByRole("combobox"), { target: { value: "市场插件入口" } });
  await fireEvent.click(await screen.findByRole("option", { name: /市场插件入口/ }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("activate_feature", {
    code: action.feature_code, payload: null, expectedPluginId: action.plugin_id,
  }));
  await waitFor(() => expect(document.querySelector('[data-plugin-feature-code]')?.textContent).toBe(action.feature_code));
  expect(mocks.invoke.mock.calls.some(([command]) => command === "fetch_plugin_market_catalog")).toBe(false);
});

it("cancels an owned reserved-code launcher result before its activation resolves", async () => {
  const action: FeatureAction = { ...first, plugin_id: "clipboard", plugin_name: "剪贴板", feature_code: "clipboard" };
  actions.set(action.feature_code, action);
  let resolveActivation!: (value: FeatureAction) => void;
  const pendingActivation = new Promise<FeatureAction>(resolve => { resolveActivation = resolve; });
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command, args) => command === "search_features"
    ? Promise.resolve([searchResult("clipboard", "clipboard", "剪贴板", "剪贴板历史")])
    : command === "activate_feature" && args.code === "clipboard" ? pendingActivation : original(command, args));

  await mountedApp();
  const input = screen.getByRole("combobox");
  await fireEvent.input(input, { target: { value: "剪贴板历史" } });
  await fireEvent.click(await screen.findByRole("option", { name: /剪贴板历史/ }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("activate_feature", {
    code: "clipboard", payload: null, expectedPluginId: "clipboard",
  }));
  await fireEvent.input(input, { target: { value: "new query" } });
  resolveActivation(action);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.querySelector('iframe[title="Plugin"]')).toBeNull();
  expect(mocks.invoke.mock.calls.some(([command]) => command === "open_pasteboard_shelf_window" || command === "hide_main_window")).toBe(false);
});

it("cancels an owned reserved-code history activation when the query changes", async () => {
  const action: FeatureAction = { ...first, plugin_id: "clipboard", plugin_name: "剪贴板", feature_code: "clipboard" };
  actions.set(action.feature_code, action);
  localStorage.setItem(COMMAND_HISTORY_STORAGE_KEY, JSON.stringify([{
    code: "clipboard", label: "剪贴板历史入口", explain: "原插件历史记录", plugin_id: "clipboard", plugin_name: "剪贴板",
    icon: "", input: "clipboard query", usedAt: "2026-10-22T12:00:00.000Z", useCount: 1,
  }]));
  let resolveActivation!: (value: FeatureAction) => void;
  const pendingActivation = new Promise<FeatureAction>(resolve => { resolveActivation = resolve; });
  const original = mocks.invoke.getMockImplementation()!;
  const clipboardCatalogEntry = searchResult("clipboard", "clipboard", "剪贴板", "剪贴板历史入口");
  mocks.invoke.mockImplementation((command, args) => command === "feature_catalog"
    ? Promise.resolve([clipboardCatalogEntry])
    : command === "search_features" ? Promise.resolve([])
      : command === "activate_feature" && args.code === "clipboard" ? pendingActivation : original(command, args));

  await mountedApp();
  const input = screen.getByRole("combobox");
  await fireEvent.input(input, { target: { value: "剪贴板历史入口" } });
  const historyResultOption = await screen.findByRole("option", { name: /剪贴板历史入口/ });
  expect(historyResultOption.getAttribute("data-result-code")).toMatch(/^history:/);
  await fireEvent.click(historyResultOption);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("activate_feature", {
    code: "clipboard", payload: null, expectedPluginId: "clipboard",
  }));
  await fireEvent.input(input, { target: { value: "new query" } });
  resolveActivation(action);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.querySelector('iframe[title="Plugin"]')).toBeNull();
  expect(mocks.invoke.mock.calls.some(([command]) => command === "open_pasteboard_shelf_window" || command === "hide_main_window")).toBe(false);
});

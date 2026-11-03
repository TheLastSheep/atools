import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, expect, it, vi } from "vitest";
import PluginPanel from "../../src/components/PluginPanel.svelte";
import type { FeatureAction } from "../../src/lib/types";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), readTextFile: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readTextFile: mocks.readTextFile }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
afterEach(() => { cleanup(); mocks.invoke.mockReset(); mocks.readTextFile.mockReset(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const action: FeatureAction = { plugin_id: "dialog-load-fixture", plugin_name: "测试选择器", feature_code: "open", main_url: "index.html", plugin_path: "/inert/synthetic-fixture", expand_height: 400, payload: null };

it.each(["partial_dialog_permission", "html_read", "preload_read"])("production panel closes prepared dialog sessions when %s fails before a frame is mounted", async failure => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const onloaderror = vi.fn();
  let failFirstAttempt = true;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "prepare_plugin_data" || command === "prepare_plugin_paths" || command === "prepare_plugin_display" || command === "prepare_host_clipboard") return { unavailable: true, usage: "not_detected" };
    if (command === "prepare_plugin_dialogs") {
      if (failure === "partial_dialog_permission" && failFirstAttempt && args.access === "save") throw new Error("Save dialog permission denied");
      return { sessionId: args.access };
    }
    if (command === "get_plugin_dialog_session") return { access: args.sessionId, endpoint: "http://127.0.0.1:1234/dialog/" + "a".repeat(64) };
    if (command === "read_plugin_preload_module") {
      if (failFirstAttempt) throw new Error("Synthetic preload read failed");
      return "/* synthetic preload */";
    }
    return undefined;
  });
  mocks.readTextFile.mockImplementation(async () => {
    if (failure === "html_read" && failFirstAttempt) throw new Error("Synthetic HTML read failed");
    return "<!doctype html><html><head></head><body>synthetic</body></html>";
  });
  render(PluginPanel, { action: { ...action, ...(failure === "preload_read" ? { preload_path: `${action.plugin_path}/preload.js` } : {}) }, onclose: vi.fn(), onloaderror });
  await waitFor(() => expect(onloaderror).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("alert").textContent).toContain("无法加载插件");
  expect(document.querySelector("iframe")).toBeNull();
  const first = mocks.invoke.mock.calls.find(([command]) => command === "prepare_plugin_dialogs")![1];
  const closes = mocks.invoke.mock.calls.filter(([command]) => command === "close_plugin_dialogs");
  expect(closes).toEqual([["close_plugin_dialogs", { pluginId: action.plugin_id, instanceId: first.instanceId }]]);
  expect(mocks.invoke.mock.calls.some(([command]) => command === "prepare_legacy_node")).toBe(false);

  failFirstAttempt = false;
  await fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
  await waitFor(() => expect(document.querySelector('iframe[title="Plugin"]')?.srcdoc).toContain("synthetic"));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(onloaderror).toHaveBeenCalledTimes(1);
  const instances = mocks.invoke.mock.calls.filter(([command]) => command === "prepare_plugin_dialogs").map(([, args]) => args.instanceId);
  expect(new Set(instances).size).toBe(2);
  expect(mocks.invoke.mock.calls.some(([command]) => /(?:open|save)_plugin_dialog$/.test(command))).toBe(false);
  expect(document.querySelectorAll('iframe[title="Plugin"]')).toHaveLength(1);
});

it("ignores a late HTML read from the old action after a new action has mounted", async () => {
  const onloaderror = vi.fn();
  let resolveOldRead!: (html: string) => void;
  mocks.invoke.mockImplementation(async command => {
    if (["prepare_plugin_data", "prepare_plugin_paths", "prepare_plugin_display", "prepare_host_clipboard", "prepare_plugin_dialogs"].includes(command)) return { unavailable: true, usage: "not_detected" };
    return undefined;
  });
  mocks.readTextFile.mockImplementationOnce(() => new Promise<string>(resolve => { resolveOldRead = resolve; }))
    .mockResolvedValue("<!doctype html><html><head></head><body>new action</body></html>");
  const view = render(PluginPanel, { action: { ...action }, onclose: vi.fn(), onloaderror });
  await waitFor(() => expect(mocks.readTextFile).toHaveBeenCalledTimes(1));
  const nextAction: FeatureAction = { ...action, plugin_id: "next-plugin", feature_code: "next", plugin_path: "/inert/next-fixture" };
  await view.rerender({ action: nextAction, onclose: vi.fn(), onloaderror });
  await waitFor(() => expect(document.querySelector('iframe[title="Plugin"]')?.srcdoc).toContain("new action"));
  resolveOldRead("<!doctype html><html><head></head><body>stale old action</body></html>");
  await waitFor(() => expect(mocks.readTextFile).toHaveBeenCalledTimes(2));
  expect(document.querySelector('iframe[title="Plugin"]')?.srcdoc).toContain("new action");
  expect(document.querySelector('iframe[title="Plugin"]')?.srcdoc).not.toContain("stale old action");
  expect(onloaderror).not.toHaveBeenCalled();
  expect(document.querySelectorAll('iframe[title="Plugin"]')).toHaveLength(1);
});

it("revokes a late module-resource lease once after an action switch", async () => {
  const onloaderror = vi.fn();
  let resolveOldLease!: (session: { sessionId: string; pluginRoot: string }) => void;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (["prepare_plugin_data", "prepare_plugin_paths", "prepare_plugin_display", "prepare_host_clipboard", "prepare_plugin_dialogs"].includes(command)) return { unavailable: true, usage: "not_detected" };
    if (command === "prepare_plugin_resources" && args.pluginId === action.plugin_id) {
      return new Promise(resolve => { resolveOldLease = resolve; });
    }
    return undefined;
  });
  mocks.readTextFile.mockImplementation(async path => path === `${action.plugin_path}/index.html`
    ? '<!doctype html><html><head></head><body><script type="module" src="./entry.js"></script></body></html>'
    : '<!doctype html><html><head></head><body>new action</body></html>');

  const view = render(PluginPanel, { action: { ...action }, onclose: vi.fn(), onloaderror });
  await waitFor(() => expect(mocks.invoke.mock.calls.some(([command]) => command === "prepare_plugin_resources")).toBe(true));
  const oldPrepare = mocks.invoke.mock.calls.find(([command]) => command === "prepare_plugin_resources")![1];

  const nextAction: FeatureAction = { ...action, plugin_id: "next-plugin", feature_code: "next", plugin_path: "/inert/next-fixture" };
  await view.rerender({ action: nextAction, onclose: vi.fn(), onloaderror });
  await waitFor(() => expect(document.querySelector('iframe[title="Plugin"]')?.srcdoc).toContain("new action"));

  resolveOldLease({ sessionId: "12345678-1234-4abc-8abc-123456789abc", pluginRoot: "/private/fixture" });
  await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "close_plugin_resources")).toHaveLength(1));
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "close_plugin_resources")[0]?.[1]).toEqual(oldPrepare);
  expect(document.querySelector('iframe[title="Plugin"]')?.srcdoc).toContain("new action");
  expect(onloaderror).not.toHaveBeenCalled();
  expect(document.querySelectorAll('iframe[title="Plugin"]')).toHaveLength(1);
});

it.each(["switch", "unmount"] as const)("fences a retry whose HTML read resolves after %s", async exit => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const onloaderror = vi.fn();
  let resolveRetryRead!: (html: string) => void;
  let reads = 0;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (["prepare_plugin_data", "prepare_plugin_paths", "prepare_plugin_display", "prepare_host_clipboard"].includes(command)) return { unavailable: true, usage: "not_detected" };
    if (command === "prepare_plugin_dialogs") return { sessionId: args.access };
    if (command === "get_plugin_dialog_session") return { access: args.sessionId, endpoint: "http://127.0.0.1:1234/dialog/" + "a".repeat(64) };
    return undefined;
  });
  mocks.readTextFile.mockImplementation(async path => {
    reads++;
    if (reads === 1) throw new Error("Synthetic initial HTML failure");
    if (reads === 2) return new Promise<string>(resolve => { resolveRetryRead = resolve; });
    return "<!doctype html><html><head></head><body>new action</body></html>";
  });
  const view = render(PluginPanel, { action: { ...action }, onclose: vi.fn(), onloaderror });
  await waitFor(() => expect(onloaderror).toHaveBeenCalledTimes(1));
  await fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
  await waitFor(() => expect(reads).toBe(2));
  const dialogInstanceIds = [...new Set(mocks.invoke.mock.calls
    .filter(([command, args]) => command === "prepare_plugin_dialogs" && args.pluginId === action.plugin_id)
    .map(([, args]) => args.instanceId))];
  expect(dialogInstanceIds).toHaveLength(2);
  const retryInstanceId = dialogInstanceIds[1];

  if (exit === "switch") {
    const nextAction: FeatureAction = { ...action, plugin_id: "next-plugin", feature_code: "next", plugin_path: "/inert/next-fixture" };
    await view.rerender({ action: nextAction, onclose: vi.fn(), onloaderror });
    await waitFor(() => expect(document.querySelector('iframe[title="Plugin"]')?.srcdoc).toContain("new action"));
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command, args]) => command === "close_plugin_dialogs" && args.instanceId === retryInstanceId)).toHaveLength(1));
  } else {
    view.unmount();
    expect(document.querySelector(".plugin-panel")).toBeNull();
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command, args]) => command === "close_plugin_dialogs" && args.instanceId === retryInstanceId)).toHaveLength(1));
  }

  resolveRetryRead("<!doctype html><html><head></head><body>stale retry</body></html>");
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(onloaderror).toHaveBeenCalledTimes(1);
  expect(mocks.invoke.mock.calls.filter(([command, args]) => command === "close_plugin_dialogs" && args.instanceId === retryInstanceId)).toHaveLength(1);
  if (exit === "switch") {
    expect(reads).toBe(3);
    expect(document.querySelector('iframe[title="Plugin"]')?.srcdoc).toContain("new action");
    expect(document.querySelector('iframe[title="Plugin"]')?.srcdoc).not.toContain("stale retry");
    expect(document.querySelectorAll('iframe[title="Plugin"]')).toHaveLength(1);
  } else {
    expect(document.querySelector(".plugin-panel")).toBeNull();
  }
});

it("keeps a ready plugin mounted when desktop render-smoke reporting fails", async () => {
  vi.stubEnv("VITE_ATOOLS_DESKTOP_SMOKE", "true");
  const reportWarning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const onready = vi.fn();
  const onloaderror = vi.fn();
  const ondesktopsmokerender = vi.fn();
  mocks.invoke.mockImplementation(async command => {
    if (["prepare_plugin_data", "prepare_plugin_paths", "prepare_plugin_display", "prepare_host_clipboard", "prepare_plugin_dialogs"].includes(command)) return { unavailable: true, usage: "not_detected" };
    if (command === "read_plugin_preload_module") return "window.fixturePreloadRan = true;";
    if (command === "report_plugin_panel_render_smoke") throw new Error("Synthetic render report rejected");
    return undefined;
  });
  mocks.readTextFile.mockResolvedValue("<!doctype html><html><head></head><body>ready once</body></html>");
  render(PluginPanel, {
    action: { ...action, preload_path: `${action.plugin_path}/preload.js` },
    onclose: vi.fn(), onready, onloaderror, ondesktopsmokerender, desktopSmokeExpectedSamples: 1,
  });
  await waitFor(() => expect(onready).toHaveBeenCalledTimes(1));
  const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]')!;
  expect(frame?.srcdoc).toContain("ready once");
  window.dispatchEvent(new MessageEvent("message", {
    data: {
      __atools_desktop_smoke_bridge_probe__: true,
      pluginId: action.plugin_id,
      featureCode: action.feature_code,
      sampleIndex: 0,
      probes: [{ id: "synthetic-render-probe", passed: true }],
      nativeMethodProbes: [],
      browserWindowProbeExpected: true,
      browserWindowProbeReported: true,
      browserWindowProbes: [],
    },
    source: frame.contentWindow,
    origin: "null",
  }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("report_plugin_panel_render_smoke", expect.anything()));
  await waitFor(() => expect(reportWarning).toHaveBeenCalledWith("[PluginPanel] Failed to report desktop render smoke:", expect.any(Error)));

  expect(onready).toHaveBeenCalledTimes(1);
  expect(ondesktopsmokerender).not.toHaveBeenCalled();
  expect(onloaderror).not.toHaveBeenCalled();
  expect(mocks.readTextFile).toHaveBeenCalledTimes(1);
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "read_plugin_preload_module")).toHaveLength(1);
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "report_plugin_panel_render_smoke")).toHaveLength(1);
  expect(mocks.invoke.mock.calls.some(([command]) => command === "activate_feature")).toBe(false);
  expect(document.querySelector('iframe[title="Plugin"]')?.srcdoc).toContain("ready once");
  expect(screen.queryByRole("button", { name: "重试加载" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

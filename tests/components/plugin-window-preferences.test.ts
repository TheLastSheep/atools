import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import type { ComponentProps } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import PluginPanelChrome from "../../src/components/PluginPanelChrome.svelte";
import {
  createPluginWindowPreferencesController,
  type PluginWindowPreferencesState,
} from "../../src/lib/pluginWindowPreferences";
import { pluginHostView } from "../../src/lib/pluginHostView";
import type { FeatureAction } from "../../src/lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
let originalUrl: string | null = null;
afterEach(() => {
  cleanup();
  if (originalUrl) window.history.replaceState(null, "", originalUrl);
  originalUrl = null;
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  vi.clearAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

async function clickPluginToolbarAction(label: string) {
  await fireEvent.click(screen.getByRole("button", { name: "更多插件操作" }));
  await fireEvent.click(await screen.findByRole("menuitem", { name: label }));
}

describe("plugin window preferences", () => {
  it("exposes the host-view settings action only when a desktop or preview host enables it", () => {
    const action: FeatureAction = {
      plugin_id: "harris.live-markdown", plugin_name: "Live Markdown", feature_code: "open",
      main_url: "", plugin_path: "/plugins/live-markdown", expand_height: 0, payload: null,
    };
    const base = { subInputVisible: false, iframeReady: false, outputItems: [], selectedIndex: 0 };
    const available = (settingsAvailable?: boolean) => pluginHostView(action, { ...base, settingsAvailable })
      .actions.find(item => item.id === "settings")?.available;
    expect(available()).toBe(false);
    expect(available(true)).toBe(true);
    expect(available(false)).toBe(false);
  });

  it("loads the plugin-scoped default and persists only the deferred auto-detach preference", async () => {
    const states: PluginWindowPreferencesState[] = [];
    const invoke = vi.fn(async (command: string) => command === "get_plugin_window_preferences"
      ? { autoDetach: false }
      : { autoDetach: true });
    const controller = createPluginWindowPreferencesController({ invoke, onChange: state => states.push(state) });

    const loading = controller.open("harris.live-markdown");
    expect(controller.snapshot()).toMatchObject({ open: true, pluginId: "harris.live-markdown", autoDetach: false, loading: true });
    await loading;
    expect(controller.snapshot()).toMatchObject({ loaded: true, loading: false, autoDetach: false });
    await controller.setAutoDetach(true);

    expect(invoke.mock.calls).toEqual([
      ["get_plugin_window_preferences", { pluginId: "harris.live-markdown" }],
      ["set_plugin_auto_detach", { pluginId: "harris.live-markdown", enabled: true }],
    ]);
    expect(controller.snapshot()).toMatchObject({ open: true, pluginId: "harris.live-markdown", autoDetach: true, saving: false });
    expect(states.some(state => state.saving)).toBe(true);
    controller.dispose();
  });

  it("keeps load and save errors local and retries the failed operation", async () => {
    const invoke = vi.fn()
      .mockRejectedValueOnce(new Error("load unavailable"))
      .mockResolvedValueOnce({ autoDetach: false })
      .mockRejectedValueOnce(new Error("save unavailable"))
      .mockResolvedValueOnce({ autoDetach: true });
    const controller = createPluginWindowPreferencesController({ invoke, onChange: () => {} });

    await controller.open("plugin.one");
    expect(controller.snapshot()).toMatchObject({ error: "load unavailable", errorAction: "load", loaded: false });
    await controller.retry();
    expect(controller.snapshot()).toMatchObject({ loaded: true, autoDetach: false, error: null });
    await controller.setAutoDetach(true);
    expect(controller.snapshot()).toMatchObject({ error: "save unavailable", errorAction: "save", autoDetach: false, saving: false });
    await controller.retry();
    expect(controller.snapshot()).toMatchObject({ autoDetach: true, loaded: true, error: null, saving: false });
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "get_plugin_window_preferences",
      "get_plugin_window_preferences",
      "set_plugin_auto_detach",
      "set_plugin_auto_detach",
    ]);
    controller.dispose();
  });

  it("ignores stale reads and writes after close or plugin change", async () => {
    const firstRead = deferred<unknown>();
    const secondRead = deferred<unknown>();
    const staleWrite = deferred<unknown>();
    let currentPluginId = "plugin.first";
    const invoke = vi.fn((command: string) => {
      if (command === "get_plugin_window_preferences") return currentPluginId === "plugin.first" ? firstRead.promise : secondRead.promise;
      return staleWrite.promise;
    });
    const controller = createPluginWindowPreferencesController({ invoke, currentPluginId: () => currentPluginId, onChange: () => {} });

    const first = controller.open("plugin.first");
    currentPluginId = "plugin.second";
    controller.pluginChanged(currentPluginId);
    const second = controller.open("plugin.second");
    firstRead.resolve({ autoDetach: true });
    await first;
    expect(controller.snapshot()).toMatchObject({ open: true, pluginId: "plugin.second", loading: true, autoDetach: false });
    secondRead.resolve({ autoDetach: false });
    await second;
    expect(controller.snapshot()).toMatchObject({ open: true, pluginId: "plugin.second", loaded: true, autoDetach: false });

    const write = controller.setAutoDetach(true);
    expect(controller.snapshot().saving).toBe(true);
    controller.close();
    staleWrite.resolve({ autoDetach: true });
    await write;
    expect(controller.snapshot()).toMatchObject({ open: false, pluginId: null, autoDetach: false, saving: false });
    expect(invoke.mock.calls.at(-1)).toEqual(["set_plugin_auto_detach", { pluginId: "plugin.second", enabled: true }]);
    controller.dispose();
  });

  it("opens from the desktop toolbar, shows the false default, closes on Escape and restores trigger focus", async () => {
    mocks.invoke.mockResolvedValue({ autoDetach: false });
    Object.assign(window, { __TAURI_INTERNALS__: { invoke: mocks.invoke } });
    const onAction = vi.fn();
    const view = render(PluginPanelChrome, { props: chromeProps({ onAction }) });
    const trigger = screen.getByRole("button", { name: "更多插件操作" });
    trigger.focus();
    await fireEvent.click(trigger);
    await fireEvent.click(await screen.findByRole("menuitem", { name: "设置" }));

    const dialog = await screen.findByRole("dialog");
    expect(mocks.invoke).toHaveBeenCalledWith("get_plugin_window_preferences", { pluginId: "harris.live-markdown" });
    expect(screen.getByRole("switch", { name: "自动分离为独立窗口" }).getAttribute("aria-checked")).toBe("false");
    const close = dialog.querySelector<HTMLButtonElement>("[data-confirm-cancel]")!;
    await waitFor(() => expect(document.activeElement).toBe(close));
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    close.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(onAction).not.toHaveBeenCalled();
    view.unmount();
  });

  it("keeps the setting desktop-only unless an explicit preview stub exposes it", async () => {
    const view = render(PluginPanelChrome, { props: chromeProps() });
    await fireEvent.click(screen.getByRole("button", { name: "更多插件操作" }));
    const settings = screen.getByRole("menuitem", { name: "设置" }) as HTMLButtonElement;
    expect(settings.disabled).toBe(true);
    await view.rerender({ actions: [{ id: "settings", label: "设置", available: true }] });
    expect((screen.getByRole("menuitem", { name: "设置" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("hides the no-op detach action in detached windows and preserves main-window actions", async () => {
    originalUrl = window.location.href;
    window.history.replaceState(null, "", "/#/plugin-detach?feature_code=open&plugin_id=harris.live-markdown");
    const actions = [
      { id: "settings", label: "设置", available: true },
      { id: "detach", label: "分离", available: true },
    ] as const;
    const view = render(PluginPanelChrome, { props: chromeProps({ actions: [
      ...actions,
    ] }) });

    await fireEvent.click(screen.getByRole("button", { name: "更多插件操作" }));
    expect(screen.queryByRole("menuitem", { name: "分离" })).toBeNull();
    expect((screen.getByRole("menuitem", { name: "设置" }) as HTMLButtonElement).disabled).toBe(false);
    view.unmount();

    window.history.replaceState(null, "", "/");
    const onAction = vi.fn();
    render(PluginPanelChrome, { props: chromeProps({ actions: [...actions], onAction }) });
    await fireEvent.click(screen.getByRole("button", { name: "更多插件操作" }));
    const detach = screen.getByRole("menuitem", { name: "分离" });
    expect((detach as HTMLButtonElement).disabled).toBe(false);
    await fireEvent.click(detach);
    await waitFor(() => expect(onAction).toHaveBeenCalledWith("detach"));
  });

  it("closes the plugin-scoped dialog on identity change and ignores the old read result", async () => {
    const pending = deferred<unknown>();
    mocks.invoke.mockReturnValue(pending.promise);
    Object.assign(window, { __TAURI_INTERNALS__: { invoke: mocks.invoke } });
    const view = render(PluginPanelChrome, { props: chromeProps() });
    await clickPluginToolbarAction("设置");
    expect(await screen.findByRole("dialog")).toBeTruthy();
    await view.rerender({ diagnosticIdentity: { featureCode: "open", source: "harris.other-plugin" } });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    pending.resolve({ autoDetach: true });
    await Promise.resolve();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.invoke).toHaveBeenCalledWith("get_plugin_window_preferences", { pluginId: "harris.live-markdown" });
  });

  it("shows a local save error and retries without changing plugin scope", async () => {
    mocks.invoke
      .mockResolvedValueOnce({ autoDetach: false })
      .mockRejectedValueOnce(new Error("write denied"))
      .mockResolvedValueOnce({ autoDetach: true });
    Object.assign(window, { __TAURI_INTERNALS__: { invoke: mocks.invoke } });
    render(PluginPanelChrome, { props: chromeProps() });
    await clickPluginToolbarAction("设置");
    const toggle = await screen.findByRole("switch", { name: "自动分离为独立窗口" });
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
    await fireEvent.click(toggle);
    expect((await screen.findByRole("alert")).textContent).toContain("write denied");
    await fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(document.activeElement).toBe(screen.getByRole("dialog").querySelector("[data-confirm-cancel]"));
    await waitFor(() => expect(screen.getByRole("switch", { name: "自动分离为独立窗口" }).getAttribute("aria-checked")).toBe("true"));
    expect(mocks.invoke.mock.calls).toEqual([
      ["get_plugin_window_preferences", { pluginId: "harris.live-markdown" }],
      ["set_plugin_auto_detach", { pluginId: "harris.live-markdown", enabled: true }],
      ["set_plugin_auto_detach", { pluginId: "harris.live-markdown", enabled: true }],
    ]);
  });

  it("lets the user explicitly reset an unreadable preference to the confirmed default", async () => {
    mocks.invoke
      .mockRejectedValueOnce(new Error("stored plugin preference is invalid"))
      .mockResolvedValueOnce({ autoDetach: false });
    Object.assign(window, { __TAURI_INTERNALS__: { invoke: mocks.invoke } });
    render(PluginPanelChrome, { props: chromeProps() });
    await clickPluginToolbarAction("设置");
    expect((await screen.findByRole("alert")).textContent).toContain("stored plugin preference is invalid");
    expect((screen.getByRole("switch", { name: "自动分离为独立窗口" }) as HTMLButtonElement).disabled).toBe(true);

    await fireEvent.click(screen.getByRole("button", { name: "重置为默认" }));
    expect(document.activeElement).toBe(screen.getByRole("dialog").querySelector("[data-confirm-cancel]"));
    await waitFor(() => expect((screen.getByRole("switch", { name: "自动分离为独立窗口" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByRole("status").textContent).toContain("已恢复默认设置");
    expect(mocks.invoke.mock.calls).toEqual([
      ["get_plugin_window_preferences", { pluginId: "harris.live-markdown" }],
      ["set_plugin_auto_detach", { pluginId: "harris.live-markdown", enabled: false }],
    ]);
  });
});

function chromeProps(overrides: Partial<ComponentProps<typeof PluginPanelChrome>> = {}): ComponentProps<typeof PluginPanelChrome> {
  return {
    visible: true,
    title: "Live Markdown",
    feature: "打开编辑器",
    actions: [{ id: "settings", label: "设置", available: false }],
    inputVisible: false,
    value: "",
    placeholder: "输入关键词",
    onInput: vi.fn(),
    onReturn: vi.fn(),
    onEscape: vi.fn(),
    onMove: () => false,
    onBoundary: () => false,
    onActivate: () => false,
    onAction: vi.fn(),
    showDiagnostics: false,
    diagnosticsChips: [],
    diagnosticIdentity: { featureCode: "open", source: "harris.live-markdown" },
    displayStatus: null,
    fileDropStatus: null,
    hostClipboardStatus: null,
    dialogsStatus: null,
    pathsStatus: null,
    dataStatus: null,
    reopening: false,
    onReopenData: vi.fn(),
    onReopenClipboard: vi.fn(),
    onReopenPaths: vi.fn(),
    ...overrides,
  };
}

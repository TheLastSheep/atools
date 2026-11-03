import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import PluginContextMenuOverlay from "../../src/components/PluginContextMenuOverlay.svelte";
import { createPluginContextMenuController } from "../../src/lib/pluginContextMenuController.svelte";
import { normalizePluginContextMenu } from "../../src/lib/pluginContextMenuSchema";
import { PluginFrameSourceRegistry } from "../../src/lib/pluginFrameDocumentIdentity";
import { createPluginElectronAdapter, pluginElectronAdapterScript } from "../../src/lib/pluginElectronAdapter";
import { createPluginHostedIpcBridge } from "../../src/lib/pluginHostedIpcBridge";
import { createPluginHostedIpcRouter } from "../../src/lib/pluginHostedIpcRouter";
import { createPluginNativeBridgeRouter } from "../../src/lib/pluginPanelNativeBridgeRouter";

afterEach(cleanup);

function frameSetup() {
  const iframe = document.createElement("iframe");
  document.body.append(iframe);
  vi.spyOn(iframe, "getBoundingClientRect").mockReturnValue({
    x: 40, y: 30, left: 40, top: 30, right: 440, bottom: 330, width: 400, height: 300, toJSON: () => ({}),
  } as DOMRect);
  const sources = new PluginFrameSourceRegistry(), source = iframe.contentWindow!;
  sources.setMain(source);
  return { iframe, source, sources, identity: sources.currentIdentityForHost(source)! };
}

const sampleMenu = [
  { type: "separator" },
  { id: "disabled", label: "不可选", enabled: false },
  { type: "checkbox", id: "checked", label: "已勾选", checked: true },
  { label: "更多", submenu: [{ label: "子菜单命令", submenu: [{ id: "leaf-command", label: "叶子命令" }] }] },
];

describe("bounded Electron show-context-menu contract", () => {
  it("preserves only supported native menu fields and rejects malformed or oversized trees", () => {
    expect(normalizePluginContextMenu(sampleMenu)).toEqual([
      { type: "separator" },
      { enabled: false, label: "不可选", id: "disabled" },
      { label: "已勾选", type: "checkbox", id: "checked", checked: true },
      { label: "更多", submenu: [{ label: "子菜单命令", submenu: [{ label: "叶子命令", id: "leaf-command" }] }] },
    ]);
    expect(() => normalizePluginContextMenu([{ id: "same", label: "一" }, { id: "same", label: "二" }])).toThrow("duplicate");
    expect(() => normalizePluginContextMenu([{ id: "x", label: "x", click: () => undefined }])).toThrow("property");
    const getter = Object.defineProperty({ id: "x" }, "label", { enumerable: true, get: () => "x" });
    expect(() => normalizePluginContextMenu([getter])).toThrow("property");
    expect(() => normalizePluginContextMenu([{ id: "x", label: "x", extra: true }])).toThrow("property");
    expect(() => normalizePluginContextMenu([{ label: "一", submenu: [{ label: "二", submenu: [{ label: "三", submenu: [{ label: "四", submenu: [{ id: "deep", label: "深" }] }] }] }] }])).toThrow("depth");
    expect(() => normalizePluginContextMenu(Array.from({ length: 33 }, (_, index) => ({ id: String(index), label: "项目" })))).toThrow("1 to 32");
    expect(() => normalizePluginContextMenu([{ id: "x", label: "界".repeat(100) }])).toThrow("label");
  });

  it("invokes the single allowed channel once, returns undefined, and never replays a failure", async () => {
    const showContextMenu = vi.fn(async () => null);
    const electron = createPluginElectronAdapter({ application: { name: "ATools", version: "test" }, showContextMenu }, undefined, normalizePluginContextMenu);
    await expect(electron.ipcRenderer.invoke("show-context-menu", sampleMenu)).resolves.toBeUndefined();
    expect(showContextMenu).toHaveBeenCalledOnce();
    expect(showContextMenu).toHaveBeenCalledWith(normalizePluginContextMenu(sampleMenu));
    await expect(electron.ipcRenderer.invoke("show-context-menu", sampleMenu, "extra")).rejects.toThrow("exactly one");
    await expect(electron.ipcRenderer.invoke("unknown", sampleMenu)).rejects.toThrow("channel");
    await expect(electron.ipcRenderer.invoke("show-context-menu", [{ id: "same", label: "一" }, { id: "same", label: "二" }])).rejects.toThrow("duplicate");
    expect(showContextMenu).toHaveBeenCalledOnce();
    const denied = new Error("route rejected"), rejectRoute = vi.fn(async () => { throw denied; });
    const rejecting = createPluginElectronAdapter({ application: { name: "ATools", version: "test" }, showContextMenu: rejectRoute }, undefined, normalizePluginContextMenu);
    await expect(rejecting.ipcRenderer.invoke("show-context-menu", [{ id: "one", label: "一" }])).rejects.toBe(denied);
    expect(rejectRoute).toHaveBeenCalledOnce();
  });

  it("serializes the same validated alias through the production Electron adapter script", async () => {
    const broker = { on() {} }, show = vi.fn(async () => null);
    const hostWindow: any = { console, require: (name: string) => name === "electron" ? { ipcRenderer: broker } : {},
      utools: { getAppName: () => "ATools", getAppVersion: () => "test", __atoolsShowContextMenu: (items: unknown) => show(items) } };
    const script = pluginElectronAdapterScript().replace(/^<script[^>]*>\n/, "").replace(/\n<\/script>$/, "");
    new Function("window", script)(hostWindow);
    await expect(hostWindow.require("electron").ipcRenderer.invoke("show-context-menu", [{ id: "roundtrip", label: "菜单" }])).resolves.toBeUndefined();
    expect(show).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledWith([{ label: "菜单", id: "roundtrip" }]);
    await expect(hostWindow.require("electron").ipcRenderer.invoke("show-context-menu", [{ id: "x", label: "x", click() {} }])).rejects.toThrow("property");
    expect(show).toHaveBeenCalledOnce();
  });

  it("keeps ancestor submenus mounted through a nested leaf selection", async () => {
    const { source, sources } = frameSetup(), controller = createPluginContextMenuController(sources);
    render(PluginContextMenuOverlay, { controller });
    const selected = vi.fn();
    await controller.open(sampleMenu, source, sources.currentIdentityForHost(source)!, selected);
    await waitFor(() => expect(screen.getByRole("menuitemcheckbox", { name: "已勾选" })).toBeTruthy());
    const disabled = screen.getByRole("menuitem", { name: "不可选" }) as HTMLButtonElement;
    expect(disabled.disabled).toBe(true);
    expect(controller.select("disabled")).toBe(false);
    const checkbox = screen.getByRole("menuitemcheckbox", { name: "已勾选" });
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    const submenu = screen.getByRole("menuitem", { name: "更多" }) as HTMLButtonElement;
    submenu.focus();
    await fireEvent.keyDown(submenu, { key: "ArrowRight" });
    const child = await screen.findByRole("menuitem", { name: "子菜单命令" });
    await waitFor(() => expect(document.activeElement).toBe(child));
    await fireEvent.keyDown(child, { key: "ArrowRight" });
    await screen.findByRole("menuitem", { name: "叶子命令" });
    await fireEvent.click(child);
    expect(screen.queryByRole("menuitem", { name: "叶子命令" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "更多" })).toBeTruthy();
    await fireEvent.click(child);
    await fireEvent.click(await screen.findByRole("menuitem", { name: "叶子命令" }));
    expect(selected).toHaveBeenCalledOnce();
    expect(selected).toHaveBeenCalledWith("leaf-command");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps Escape reachable with no enabled items and closes on native Tab focus leave", async () => {
    const { source, sources } = frameSetup(), controller = createPluginContextMenuController(sources);
    const { container } = render(PluginContextMenuOverlay, { controller });
    const outside = document.createElement("button");
    document.body.append(outside);
    const items = [{ type: "separator" as const }, { id: "disabled", label: "不可用", enabled: false }];

    const escaped = controller.open(items, source, sources.currentIdentityForHost(source)!);
    await escaped;
    const backdrop = container.querySelector<HTMLElement>(".plugin-context-menu-backdrop")!;
    await waitFor(() => expect(document.activeElement).toBe(backdrop));
    await fireEvent.keyDown(backdrop, { key: "Escape" });
    expect(controller.menu).toBeNull();

    const tabbed = controller.open(items, source, sources.currentIdentityForHost(source)!);
    await tabbed;
    const tabBackdrop = container.querySelector<HTMLElement>(".plugin-context-menu-backdrop")!;
    await waitFor(() => expect(document.activeElement).toBe(tabBackdrop));
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    tabBackdrop.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(tab.cancelBubble).toBe(false);
    outside.focus();
    expect(controller.menu).toBeNull();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("cancels the previous request on replacement, Escape, outside click, or frame invalidation", async () => {
    const { iframe, source, sources, identity } = frameSetup(), controller = createPluginContextMenuController(sources);
    const { container } = render(PluginContextMenuOverlay, { controller });
    const first = controller.open([{ id: "old", label: "旧" }], source, identity);
    const second = controller.open([{ id: "new", label: "新" }], source, identity);
    await expect(first).rejects.toThrow("closed before becoming visible");
    await second;
    await fireEvent.keyDown(screen.getByRole("menuitem", { name: "新" }), { key: "Escape" });
    expect(controller.menu).toBeNull();
    expect(document.activeElement).toBe(iframe);
    const outside = controller.open([{ id: "outside", label: "外部点击" }], source, identity);
    await outside;
    await screen.findByRole("menuitem", { name: "外部点击" });
    await fireEvent.click(container.querySelector(".plugin-context-menu-backdrop")!);
    expect(controller.menu).toBeNull();
    const invalidated = controller.open([{ id: "stale", label: "失效" }], source, identity);
    sources.setMain(source);
    await expect(invalidated).rejects.toThrow("closed before becoming visible");
    expect(controller.menu).toBeNull();
    iframe.remove();
  });

  it("authenticates showContextMenu and delivers its leaf event through the exact hosted listener broker", async () => {
    const sourceListeners = new Map<string, Set<(event: MessageEvent) => void>>();
    const parent = { postMessage() {} };
    const nativeResponses: any[] = [];
    const source = { postMessage: (data: any) => {
      if (data.__atools_hosted_ipc__) for (const listener of sourceListeners.get("message") ?? []) listener({ source: parent, data } as MessageEvent);
      if (data.__atools_native_response__) nativeResponses.push(data);
    } };
    const pageWindow: any = { parent, crypto: { getRandomValues(bytes: Uint8Array) { bytes.fill(5); } },
      addEventListener(name: string, listener: (event: MessageEvent) => void) { const list = sourceListeners.get(name) ?? new Set(); list.add(listener); sourceListeners.set(name, list); },
      removeEventListener(name: string, listener: (event: MessageEvent) => void) { sourceListeners.get(name)?.delete(listener); } };
    const bridge = createPluginHostedIpcBridge(pageWindow, { webContentsId: 41, invoke: vi.fn(async () => null) });
    const sources = new PluginFrameSourceRegistry(), router = createPluginHostedIpcRouter({ sources });
    const id = router.reserve({ kind: "main" });
    sources.setMain(source);
    let identity = sources.currentIdentityForHost(source)!;
    router.bind({ kind: "main" }, source, identity, true);
    router.handleLifecycle({ source, identity }, { __atools_hosted_ipc_document__: true, webContentsId: id, documentNonce: bridge.documentNonce, phase: "open" });
    identity = sources.currentIdentityForHost(source)!;
    const received = vi.fn();
    bridge.ipcRenderer.on("context-menu-command", received);
    let chooseMenuItem: ((id: string) => void) | undefined;
    const showContextMenu = vi.fn(async (items: any, ownerSource: unknown, ownerIdentity: unknown, onselect: (id: string) => void) => {
      expect(items).toEqual([{ label: "放大", id: "petdex:zoom-in" }]);
      expect(ownerSource).toBe(source);
      expect(ownerIdentity).toBe(identity);
      chooseMenuItem = onselect;
    });
    const native = createPluginNativeBridgeRouter({
      invoke: vi.fn(async () => null), sources, hostedIpc: router,
      getBrowserWindows: () => [], creatorFor: () => undefined, ensurePermission: vi.fn(async () => { throw Error("unexpected permission request"); }),
      onclose: vi.fn(), writePluginImage: vi.fn(async () => {}), pathFromBridgeValue: value => String(value), pathsFromBridgeValue: () => [],
      runAppleScript: vi.fn(async () => ""), appleScriptString: value => value, normalizeCopiedFileEntries: () => [],
      runCommand: vi.fn(async () => ""), writeText: vi.fn(async () => {}), hidePanelForPaste: vi.fn(async () => {}),
      pluginFileClipboardAppleScript: () => "", pickScreenColorWithEyeDropper: vi.fn(async () => ({ hex: "", rgb: "" })),
      dispatchPluginBrowserWindowParentMessage: () => null, handlePluginBrowserWindowAction: () => null,
      createPluginBrowserWindow: vi.fn(async () => null), shellOpen: vi.fn(async () => {}), showContextMenu,
    });
    await native.handleNativeBridgeCall({ source } as MessageEvent, {
      __atools_native_call__: true, reqId: 1, method: "showContextMenu", hostedDocumentNonce: bridge.documentNonce,
      args: { items: [{ id: "petdex:zoom-in", label: "放大" }] },
    }, identity);
    expect(nativeResponses).toEqual([{ __atools_native_response__: true, reqId: 1, result: null }]);
    expect(received).not.toHaveBeenCalled();
    chooseMenuItem!("petdex:zoom-in");
    chooseMenuItem!("petdex:zoom-in");
    await waitFor(() => expect(received).toHaveBeenCalledOnce());
    expect(received).toHaveBeenCalledOnce();
    expect(received.mock.calls[0][0]).toMatchObject({ channel: "context-menu-command", senderId: id });
    expect(received.mock.calls[0][1]).toBe("petdex:zoom-in");
    expect(showContextMenu).toHaveBeenCalledOnce();
    received.mockClear();
    bridge.dispose();
    sources.setMain(source);
    identity = sources.currentIdentityForHost(source)!;
    const nextBridge = createPluginHostedIpcBridge(pageWindow, { webContentsId: 41, invoke: vi.fn(async () => null) });
    router.bind({ kind: "main" }, source, identity, true);
    router.handleLifecycle({ source, identity }, { __atools_hosted_ipc_document__: true, webContentsId: id, documentNonce: nextBridge.documentNonce, phase: "open" });
    identity = sources.currentIdentityForHost(source)!;
    nextBridge.ipcRenderer.on("context-menu-command", received);
    await native.handleNativeBridgeCall({ source } as MessageEvent, {
      __atools_native_call__: true, reqId: 2, method: "showContextMenu", hostedDocumentNonce: nextBridge.documentNonce,
      args: { items: [{ id: "petdex:zoom-in", label: "放大" }] },
    }, identity);
    expect(nativeResponses.at(-1)).toEqual({ __atools_native_response__: true, reqId: 2, result: null });
    sources.setMain(source);
    chooseMenuItem!("petdex:zoom-in");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(received).not.toHaveBeenCalled();
    nextBridge.dispose();
    router.clear();
  });
});

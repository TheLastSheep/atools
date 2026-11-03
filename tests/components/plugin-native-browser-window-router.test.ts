import { describe, expect, it, vi } from "vitest";
import { createPluginHostedIpcRouter } from "../../src/lib/pluginHostedIpcRouter";
import { PluginFrameSourceRegistry } from "../../src/lib/pluginFrameDocumentIdentity";
import { createPluginNativeBridgeRouter } from "../../src/lib/pluginPanelNativeBridgeRouter";
import type { PluginBrowserWindowCreator } from "../../src/lib/pluginBrowserWindowReady";

const NONCE = "a".repeat(32);

function hostedMainDocument() {
  const sources = new PluginFrameSourceRegistry();
  const hostedIpc = createPluginHostedIpcRouter({ sources, creatorFor: () => undefined });
  const source = { postMessage: vi.fn() };
  const webContentsId = hostedIpc.reserve({ kind: "main" });
  const reservation = sources.reserveDocument({ kind: "main", source, pageDocumentId: "main-document",
    expectedOrigin: "https://plugin.example", parentOrigin: "https://atools.example" });
  if (!sources.activateDocument(reservation, NONCE)) throw Error("document activation failed");
  const identity = hostedIpc.registerFrame({ kind: "main" }, source, true, true);
  if (!identity) throw Error("main source registration failed");
  hostedIpc.handleLifecycle({ source, identity }, { __atools_hosted_ipc_document__: true,
    phase: "open", webContentsId, documentNonce: NONCE });
  return { sources, hostedIpc, source, identity };
}

function bridge(fixture: ReturnType<typeof hostedMainDocument>, options: {
  useNative: boolean;
  windows?: Array<{ id: string }>;
  creatorFor?: (id: string) => PluginBrowserWindowCreator | undefined;
}) {
  const ensurePermission = vi.fn(async () => undefined);
  const createPluginBrowserWindow = vi.fn(async () => ({ id: "native-window" }));
  const handlePluginBrowserWindowAction = vi.fn(async () => true);
  const router = createPluginNativeBridgeRouter({
    invoke: vi.fn(async () => undefined),
    sources: fixture.sources,
    hostedIpc: fixture.hostedIpc,
    getBrowserWindows: () => options.windows ?? [],
    creatorFor: options.creatorFor ?? (() => undefined),
    ensurePermission,
    onclose: vi.fn(),
    writePluginImage: vi.fn(async () => undefined),
    pathFromBridgeValue: value => String(value ?? ""),
    pathsFromBridgeValue: value => Array.isArray(value) ? value.map(String) : [],
    runAppleScript: vi.fn(async () => ""),
    appleScriptString: value => JSON.stringify(value),
    normalizeCopiedFileEntries: entries => Array.isArray(entries) ? entries : [],
    runCommand: vi.fn(async () => ""),
    writeText: vi.fn(async () => undefined),
    hidePanelForPaste: vi.fn(async () => undefined),
    pluginFileClipboardAppleScript: () => "",
    pickScreenColorWithEyeDropper: vi.fn(async () => ({ hex: "#000000", rgb: "0,0,0" })),
    dispatchPluginBrowserWindowParentMessage: vi.fn(),
    handlePluginBrowserWindowAction,
    createPluginBrowserWindow,
    shouldUseNativeBrowserWindow: vi.fn(() => options.useNative),
    shellOpen: vi.fn(async () => undefined),
  } as Parameters<typeof createPluginNativeBridgeRouter>[0]);
  return { router, ensurePermission, createPluginBrowserWindow, handlePluginBrowserWindowAction };
}

describe("native BrowserWindow bridge routing", () => {
  it("passes the authenticated hosted-document lease and skips the legacy prompt for native create", async () => {
    const fixture = hostedMainDocument();
    const { router, ensurePermission, createPluginBrowserWindow } = bridge(fixture, { useNative: true });
    const args = { url: "paster.html?id=42&windowRole=paster" };

    await router.handleNativeBridgeCall({ source: fixture.source, origin: "https://plugin.example" } as MessageEvent,
      { __atools_native_call__: true, reqId: 1, method: "createBrowserWindow", hostedDocumentNonce: NONCE, args },
      fixture.identity);

    expect(ensurePermission).not.toHaveBeenCalled();
    expect(createPluginBrowserWindow).toHaveBeenCalledTimes(1);
    const [receivedArgs, creator, lease] = createPluginBrowserWindow.mock.calls[0];
    expect(receivedArgs).toEqual(args);
    expect(creator).toEqual({ source: fixture.source, identity: fixture.identity });
    expect(lease.documentNonce).toBe(NONCE);
    expect(() => lease.assertCurrent()).not.toThrow();
    expect(fixture.source.postMessage).toHaveBeenCalledWith(expect.objectContaining(
      { __atools_native_response__: true, reqId: 1, result: { id: "native-window" } }), "https://plugin.example");
  });

  it("keeps the legacy permission prompt for the preview/overlay route", async () => {
    const fixture = hostedMainDocument();
    const { router, ensurePermission } = bridge(fixture, { useNative: false });

    await router.handleNativeBridgeCall({ source: fixture.source, origin: "https://plugin.example" } as MessageEvent,
      { __atools_native_call__: true, reqId: 2, method: "createBrowserWindow", hostedDocumentNonce: NONCE,
        args: { url: "https://preview.invalid" } }, fixture.identity);

    expect(ensurePermission).toHaveBeenCalledWith("browserWindow", fixture.source);
  });

  it("routes native window actions with the caller's current document lease", async () => {
    const fixture = hostedMainDocument();
    const owner: PluginBrowserWindowCreator = { source: fixture.source, identity: fixture.identity };
    const { router, ensurePermission, handlePluginBrowserWindowAction } = bridge(fixture, {
      useNative: true, windows: [{ id: "native-window" }], creatorFor: () => owner,
    });

    await router.handleNativeBridgeCall({ source: fixture.source, origin: "https://plugin.example" } as MessageEvent,
      { __atools_native_call__: true, reqId: 4, method: "browserWindowAction", hostedDocumentNonce: NONCE,
        args: { id: "native-window", action: "setAlwaysOnTop", args: [true, "floating"] } }, fixture.identity);

    expect(ensurePermission).not.toHaveBeenCalled();
    expect(handlePluginBrowserWindowAction).toHaveBeenCalledTimes(1);
    const [args, creator, lease] = handlePluginBrowserWindowAction.mock.calls[0];
    expect(args).toEqual({ id: "native-window", action: "setAlwaysOnTop", args: [true, "floating"] });
    expect(creator).toEqual(owner);
    expect(lease.documentNonce).toBe(NONCE);
    expect(() => lease.assertCurrent()).not.toThrow();
  });

  it("rejects renderer attempts to call host-only renderer-ready", async () => {
    const fixture = hostedMainDocument();
    const owner: PluginBrowserWindowCreator = { source: fixture.source, identity: fixture.identity };
    const { router, ensurePermission, handlePluginBrowserWindowAction } = bridge(fixture, {
      useNative: true, windows: [{ id: "native-window" }], creatorFor: () => owner,
    });

    await router.handleNativeBridgeCall({ source: fixture.source, origin: "https://plugin.example" } as MessageEvent,
      { __atools_native_call__: true, reqId: 3, method: "browserWindowAction", hostedDocumentNonce: NONCE,
        args: { id: "native-window", action: "__renderReady", args: [] } }, fixture.identity);

    expect(ensurePermission).not.toHaveBeenCalled();
    expect(handlePluginBrowserWindowAction).not.toHaveBeenCalled();
    expect(fixture.source.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      __atools_native_response__: true, reqId: 3, error: "ERR_ATOOLS_NATIVE_BROWSER_WINDOW_PRIVATE_ACTION",
    }), "https://plugin.example");
  });
});

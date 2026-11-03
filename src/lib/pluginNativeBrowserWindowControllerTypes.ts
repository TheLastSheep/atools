import type { PluginBrowserWindowState } from "./pluginBrowserWindowTypes";
import type { PluginBrowserWindowCreator } from "./pluginBrowserWindowReady";
import type { PluginHostedDocumentLease } from "./pluginHostedIpcRouter";
import type { PluginFrameReplyTarget, PluginFrameSourceRegistry } from "./pluginFrameDocumentIdentity";
import type { HostedBrowserWindowNavigationTokens, HostedBrowserWindowRpcHost } from "./hostedBrowserWindowRpc";
import type { createPluginBrowserWindowGeometryHost } from "./pluginBrowserWindowGeometryHost";
import type { createPluginHostedIpcRouter } from "./pluginHostedIpcRouter";
import type { PluginNativeBrowserWindowBinding } from "./pluginNativeBrowserWindowBindings";
import type { PluginNativeBrowserWindowEvent } from "./pluginNativeBrowserWindowTypes";
import type { PluginBrowserWindowHostKind } from "./pluginPanelBridgeCompiler";

export type PluginNativeBrowserWindowMountedFrame = { destroy?: () => void; update?: (id: string) => void };
export type PluginNativeBrowserWindowShellDocument = {
  frame: HTMLIFrameElement; replyTarget: PluginFrameReplyTarget; setLocation: (location: string) => void;
};
export type PluginNativeBrowserWindowShellRoute = {
  waitForShell: (timeoutMs?: number) => Promise<PluginNativeBrowserWindowShellDocument>; dispose: () => void;
};
export type PluginNativeBrowserWindowRecord = {
  id: string; nativeLabel: string; sourceBinding: PluginNativeBrowserWindowBinding; creator: PluginBrowserWindowCreator;
  creatorLease: PluginHostedDocumentLease; route: PluginNativeBrowserWindowShellRoute;
  shell?: PluginNativeBrowserWindowShellDocument; mount?: PluginNativeBrowserWindowMountedFrame;
  unregisterRenderer?: () => void; ownerKey: string; hostGeneration: number; rendered: boolean; renderPromise?: Promise<void>;
  nativeCreated: boolean; openRequested: boolean; active: boolean; disposed: boolean; pendingEvent?: PluginNativeBrowserWindowEvent;
};
export type PluginNativeBrowserWindowActionResult = { windowId: string; nativeLabel: string; value: unknown; snapshot: unknown };
export type PluginNativeBrowserWindowOpenResult = { windowId: string; nativeLabel: string; snapshot: unknown };
export type PluginNativeBrowserWindowFrameAction = (
  node: HTMLIFrameElement, id: string, replyTarget: PluginFrameReplyTarget,
) => PluginNativeBrowserWindowMountedFrame;
export type PluginNativeBrowserWindowReservation = { ownerKey?: string; nativeCreated: boolean };

export type PluginNativeBrowserWindowControllerPorts = {
  pluginId: () => string; pluginPath: () => string; previewPluginPath: string; mainUrl: () => string;
  resources: () => {
    prepare?: () => Promise<{ sessionId: string; pluginRoot: string; instanceId: string }>;
    resolveModuleSrc?: (path: string) => string | Promise<string>;
  } | undefined;
  runtime: () => { prepareAdditional: (options: import("./pluginRuntimePreload").PluginRuntimePreloadOptions) => Promise<string> } | undefined;
  preparePreload: (options: Record<string, unknown>, isCurrent: () => boolean) => Promise<string>;
  injectBridge: (html: string, type: "browserWindow", id: string, preload: string, geometry: unknown, windowHostKind?: PluginBrowserWindowHostKind,
    entryMode?: "activate" | "preload", nativeBackgroundThrottling?: boolean) => string;
  mountFrame: PluginNativeBrowserWindowFrameAction;
  invoke: <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
  windows: PluginBrowserWindowState[]; setWindows: (value: PluginBrowserWindowState[]) => void;
  windowSequence: number; setWindowSequence: (value: number) => void;
  creatingCount: number; setCreatingCount: (value: number) => void; hostGeneration: number;
  sources: PluginFrameSourceRegistry; hostedIpc: ReturnType<typeof createPluginHostedIpcRouter>;
  navigation: HostedBrowserWindowNavigationTokens; rpc: HostedBrowserWindowRpcHost; frames: Map<string, HTMLIFrameElement>;
  geometry: ReturnType<typeof createPluginBrowserWindowGeometryHost>; creators: Map<string, PluginBrowserWindowCreator>;
  insertedCss: Map<string, unknown>; clearInsertedCss: (id: string) => void;
  dispatchWindowEvent: (id: string, name: string, args?: unknown[]) => void;
  pageTitle: (id: string, fallback: string) => Promise<string>; tick: () => Promise<unknown>;
  listen?: <T>(event: string, receive: (event: { payload: T }) => void) => Promise<() => void>;
  isTauri?: () => boolean; resourceOrigin?: () => string;
};

export const NATIVE_BROWSER_WINDOW_LABEL = /^atools-native-browser-[0-9a-f]{32}$/;
export const NATIVE_BROWSER_WINDOW_TOKEN = /^[0-9a-f]{64}$/;
export const nativeBrowserWindowOwnerKey = (binding: PluginNativeBrowserWindowBinding) =>
  JSON.stringify([binding.pluginId, binding.instanceId]);

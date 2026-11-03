import type { PluginBrowserWindowState, PluginBrowserWindowHistoryEntry, PluginBrowserWindowInsertedCss, PluginBrowserWindowParentMessage } from "./pluginBrowserWindowTypes";
import type { HostedBrowserWindowNavigationTokens, HostedBrowserWindowRpcHost } from "./hostedBrowserWindowRpc";
import type { PluginBrowserWindowCreator } from "./pluginBrowserWindowReady";
import { isPluginBrowserWindowCreateCurrent } from "./pluginBrowserWindowReady";
import type { PluginFrameSourceRegistry } from "./pluginInvokePolicy";
import { browserWindowTitle } from "./pluginBrowserWindowPresentation";

type Ports = {
  windows: PluginBrowserWindowState[];
  lastMessage: PluginBrowserWindowParentMessage | null;
  navigation: HostedBrowserWindowNavigationTokens;
  hostedIpc: ReturnType<typeof import("./pluginHostedIpcRouter").createPluginHostedIpcRouter>;
  sources: PluginFrameSourceRegistry;
  geometry: ReturnType<typeof import("./pluginBrowserWindowGeometryHost").createPluginBrowserWindowGeometryHost>;
  rpc: HostedBrowserWindowRpcHost;
  creators: Map<string, PluginBrowserWindowCreator>;
  insertedCss: Map<string, PluginBrowserWindowInsertedCss>;
  clearInsertedCss: (id: string) => void;
  navigationResult: (window: PluginBrowserWindowState, extra?: Record<string, unknown>) => Record<string, unknown>;
  runNavigation: <T>(id: string, token: number, operation: () => Promise<T>) => Promise<T>;
  pageTitle: (id: string, fallback: string) => Promise<string>;
  readyFrame: (id: string, label: string) => Promise<HTMLIFrameElement>;
  loadHtml: (url: string) => Promise<string>;
  preparePreload: (options: Record<string, unknown>, isCurrent: () => boolean) => Promise<string>;
  injectBridge: (html: string, type: "main" | "browserWindow", id: string, preload: string, geometry: unknown) => string;
  tick: () => Promise<unknown>;
  hostGeneration: number;
};

export function createPluginBrowserWindowNavigationLoader(ports: Ports) {
  function pluginBrowserWindowHistoryForLoad(
    existing: PluginBrowserWindowState,
    entry: PluginBrowserWindowHistoryEntry,
    reloaded: boolean
  ) {
    if (reloaded) {
      const history = existing.history.length > 0 ? [...existing.history] : [entry];
      const historyIndex = Math.max(0, Math.min(existing.historyIndex, history.length - 1));
      history[historyIndex] = entry;
      return { history, historyIndex };
    }
    const history = existing.history.slice(0, existing.historyIndex + 1);
    history.push(entry);
    return { history, historyIndex: history.length - 1 };
  }

  async function loadPluginBrowserWindowUrl(existing: PluginBrowserWindowState, url: string, reloaded = false, ignoreCache = false) {
    const nextUrl = url.trim();
    if (!nextUrl) throw new Error("browserWindow loadURL requires a non-empty url");
    const navigationToken = ports.navigation.begin(existing.id);
    ports.hostedIpc.invalidate({ kind: "child", windowId: existing.id });
    ports.sources.unregisterChild(existing.id);
    const html = await ports.runNavigation(
      existing.id,
      navigationToken,
      () => ports.loadHtml(nextUrl),
    );
    const creator = ports.creators.get(existing.id);
    const hostGeneration = ports.hostGeneration;
    const preloadScript = await ports.preparePreload(existing.preloadOptions, () => !!creator
      && ports.navigation.isCurrent(existing.id, navigationToken)
      && isPluginBrowserWindowCreateCurrent({ capturedGeneration: hostGeneration, currentGeneration: ports.hostGeneration, creator, sources: ports.sources }));
    const geometrySnapshot = ports.geometry.snapshot({ ...existing, documentGeneration: navigationToken });
    if (!geometrySnapshot) throw new Error("BrowserWindow owner changed before navigation geometry initialization");
    const srcdoc = ports.injectBridge(html, "browserWindow", existing.id, preloadScript, geometrySnapshot);
    const title = reloaded ? existing.title : browserWindowTitle(nextUrl, {});
    const entry = { url: nextUrl, title, srcdoc };
    const nextHistory = pluginBrowserWindowHistoryForLoad(existing, entry, reloaded);
    ports.clearInsertedCss(existing.id);
    ports.rpc.invalidate(existing.id, "reloaded");
    ports.windows = ports.windows.map((childWindow) =>
      childWindow.id === existing.id
        ? {
            ...childWindow,
            url: nextUrl,
            title,
            srcdoc,
            documentGeneration: navigationToken,
            visible: true,
            loading: true,
            crashed: false,
            ...nextHistory,
          }
        : childWindow
    );
    ports.geometry.publish(ports.windows.find(candidate => candidate.id === existing.id)!);
    ports.lastMessage = {
      windowId: existing.id,
      channel: reloaded ? "window:reload" : "window:loadURL",
      args: [nextUrl],
    };
    await ports.runNavigation(existing.id, navigationToken, () => ports.tick());
    await ports.runNavigation(
      existing.id,
      navigationToken,
      () => ports.readyFrame(existing.id, reloaded ? "webContents.reload" : "webContents.loadURL"),
    );
    const finalTitle = await ports.runNavigation(
      existing.id,
      navigationToken,
      () => ports.pageTitle(existing.id, title),
    );
    ports.navigation.assertCurrent(existing.id, navigationToken);
    let updatedWindow: PluginBrowserWindowState | undefined;
    ports.windows = ports.windows.map((childWindow) => {
      if (childWindow.id !== existing.id) return childWindow;
      updatedWindow = { ...childWindow, title: finalTitle, loading: false, crashed: false };
      updatedWindow.history[updatedWindow.historyIndex] = {
        ...updatedWindow.history[updatedWindow.historyIndex],
        title: finalTitle,
      };
      return updatedWindow;
    });
    return ports.navigationResult(updatedWindow || { ...existing, url: nextUrl, title: finalTitle, srcdoc, loading: false, ...nextHistory }, {
      reloaded,
      ignoreCache,
    });
  }


  return { loadPluginBrowserWindowUrl, pluginBrowserWindowHistoryForLoad };
}

import type {
  PluginBrowserWindowInsertedCss,
  PluginBrowserWindowParentMessage,
  PluginBrowserWindowState,
} from "./pluginBrowserWindowTypes";
import { PluginFrameSourceRegistry, postPluginFrameMessageIfCurrent } from "./pluginInvokePolicy";
import { HostedBrowserWindowNavigationTokens, HostedBrowserWindowRpcHost } from "./hostedBrowserWindowRpc";
import { createPluginBrowserWindowState } from "./pluginBrowserWindowState";
import { createPluginBrowserWindowGeometryHost } from "./pluginBrowserWindowGeometryHost";
import { createPluginHostedIpcRouter } from "./pluginHostedIpcRouter";
import type { PluginBrowserWindowCreator } from "./pluginBrowserWindowReady";

/** Per-panel mutable state and identity resources for hosted BrowserWindow frames. */
export function createPluginPanelBrowserWindowState() {
  let windows = $state<PluginBrowserWindowState[]>([]);
  let lastMessage = $state<PluginBrowserWindowParentMessage | null>(null);
  const creators = new Map<string, PluginBrowserWindowCreator>();
  let creatingCount = 0;
  let hostGeneration = 0;
  let sequence = 0;
  let cssSequence = 0;
  let findSequence = 0;
  const frames = new Map<string, HTMLIFrameElement>();
  const insertedCss = new Map<string, PluginBrowserWindowInsertedCss>();
  const navigation = new HostedBrowserWindowNavigationTokens();
  const rpc = new HostedBrowserWindowRpcHost();
  const sources = new PluginFrameSourceRegistry();
  const post = (source: unknown, message: unknown, identity = sources.currentIdentityForHost(source)) =>
    identity ? postPluginFrameMessageIfCurrent({ source, identity, sources, message }) : false;
  const windowState = createPluginBrowserWindowState({
    getWindows: () => windows,
    setWindows: value => { windows = value; },
    setLastMessage: value => { lastMessage = value; },
  });
  const geometry = createPluginBrowserWindowGeometryHost({
    creatorFor: id => creators.get(id),
    sourceFor: id => frames.get(id)?.contentWindow,
    sources,
    post,
    nonce: () => crypto.randomUUID(),
  });
  const hostedIpc = createPluginHostedIpcRouter({ sources, creatorFor: id => creators.get(id) });
  function clearInsertedCss(windowId: string) {
    for (const [key, entry] of insertedCss) if (entry.windowId === windowId) insertedCss.delete(key);
  }

  return {
    get windows() { return windows; }, set windows(value) { windows = value; },
    get lastMessage() { return lastMessage; }, set lastMessage(value) { lastMessage = value; },
    creators,
    get creatingCount() { return creatingCount; }, set creatingCount(value) { creatingCount = value; },
    get hostGeneration() { return hostGeneration; }, set hostGeneration(value) { hostGeneration = value; },
    get sequence() { return sequence; }, set sequence(value) { sequence = value; },
    get cssSequence() { return cssSequence; }, set cssSequence(value) { cssSequence = value; },
    get findSequence() { return findSequence; }, set findSequence(value) { findSequence = value; },
    frames, insertedCss, navigation, rpc, sources, post, windowState, geometry, hostedIpc, clearInsertedCss,
  };
}

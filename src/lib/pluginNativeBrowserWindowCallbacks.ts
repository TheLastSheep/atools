import type { PluginHostedDocumentLease } from "./pluginHostedIpcRouter";

type MessageHandler = (event: MessageEvent) => unknown;
type RendererReadyHandler = (lease: PluginHostedDocumentLease) => Promise<void> | void;

const messageHandlers = new Set<MessageHandler>();
const rendererReadyHandlers = new WeakMap<object, Map<string, RendererReadyHandler>>();

/** Native shells forward the original event to all active panel routers; only its owning source registry accepts it. */
export function registerPluginNativeBrowserWindowMessages(handler: MessageHandler) {
  messageHandlers.add(handler);
  return () => messageHandlers.delete(handler);
}

export function dispatchPluginNativeBrowserWindowMessage(event: MessageEvent) {
  if (messageHandlers.size === 0) return false;
  for (const handler of [...messageHandlers]) {
    try { handler(event); } catch { /* Other panel routers still need to inspect the original event. */ }
  }
  return true;
}

/** Readiness is keyed by the actual opaque iframe WindowProxy plus local id, never by an id alone. */
export function registerPluginNativeBrowserWindowRendererReady(
  source: unknown,
  windowId: string,
  handler: RendererReadyHandler,
) {
  if (!source || (typeof source !== "object" && typeof source !== "function"))
    throw Error("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_FRAME_SOURCE");
  const key = source as object;
  let windows = rendererReadyHandlers.get(key);
  if (!windows) { windows = new Map(); rendererReadyHandlers.set(key, windows); }
  if (windows.has(windowId)) throw Error("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_FRAME_DUPLICATE");
  windows.set(windowId, handler);
  return () => {
    windows?.delete(windowId);
    if (windows?.size === 0) rendererReadyHandlers.delete(key);
  };
}

export async function finalizePluginNativeBrowserWindowRenderer(
  source: unknown,
  windowId: string,
  lease: PluginHostedDocumentLease,
) {
  const windows = source && (typeof source === "object" || typeof source === "function")
    ? rendererReadyHandlers.get(source as object) : undefined;
  const handler = windows?.get(windowId);
  if (handler) await handler(lease);
}

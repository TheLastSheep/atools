import { postPluginFrameMessageIfCurrent, type PluginFrameSourceRegistry } from "./pluginFrameDocumentIdentity";

export const PLUGIN_WEB_STORAGE_CHANGED_EVENT = "atools-plugin-web-storage-changed";
type Listener = (event: string, receive: (event: { payload: unknown }) => void) => Promise<() => void>;
type Owner = { pluginId: string; instanceId: string; authorized: boolean };

/** The host only forwards an opaque event ID, never storage contents or credentials. */
export function createPluginWebStorageRelay(options: {
  listen: Listener;
  owner: () => Owner | null;
  targets: () => unknown[];
  sources: PluginFrameSourceRegistry;
}) {
  let closed = false;
  let unlisten: (() => void) | undefined;
  let pending: Promise<void> | undefined;

  function receive(event: { payload: unknown }) {
    if (closed) return;
    const value = event.payload;
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const data = value as Record<string, unknown>;
    if (Object.keys(data).length !== 3 || typeof data.pluginId !== "string"
      || typeof data.instanceId !== "string" || typeof data.eventId !== "string"
      || !/^[0-9a-f]{32}$/.test(data.eventId)) return;
    const owner = options.owner();
    if (!owner?.authorized || data.pluginId !== owner.pluginId || data.instanceId !== owner.instanceId) return;
    for (const source of new Set(options.targets())) {
      const identity = options.sources.currentIdentityForHost(source);
      if (!identity) continue;
      postPluginFrameMessageIfCurrent({ source, identity, sources: options.sources, message: {
        __atools_web_storage_event__: true, instanceId: owner.instanceId, eventId: data.eventId,
      } });
    }
  }

  function start() {
    if (closed) return Promise.reject(new Error("Plugin storage relay is closed"));
    if (pending) return pending;
    pending = options.listen(PLUGIN_WEB_STORAGE_CHANGED_EVENT, receive).then(stop => {
      if (typeof stop !== "function") throw new Error("Plugin storage listener is unavailable");
      if (closed) stop(); else unlisten = stop;
    }).catch(error => { pending = undefined; throw error; });
    return pending;
  }

  function close() {
    if (closed) return;
    closed = true;
    unlisten?.();
    unlisten = undefined;
  }
  return { start, close };
}

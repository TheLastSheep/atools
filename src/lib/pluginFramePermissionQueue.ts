import type { PluginFrameIdentity, PluginFrameSourceRegistry } from "./pluginFrameDocumentIdentity";

export type PluginRuntimePermissionRequest = Readonly<{
  id: string; pluginId: string; permission: string; source: Window | null;
  identity: PluginFrameIdentity; bridgeReqId: number | null;
}>;

/** Permission UI owns captured documents, never the plugin selected at reply time. */
export function createPluginFramePermissionQueue(options: {
  sources: PluginFrameSourceRegistry; pluginId: () => string;
  allowed: (permission: string) => boolean;
  changed: (requests: PluginRuntimePermissionRequest[]) => void;
  grant: (pluginId: string, permission: string, persistent: boolean) => void;
}) {
  const entries = new Map<string, { request: PluginRuntimePermissionRequest; resolve?: (allowed: boolean) => void }>();
  let sequence = 0;
  const current = (request: PluginRuntimePermissionRequest) => request.pluginId === options.pluginId()
    && options.sources.isCurrent(request.source, request.identity);
  function reply(request: PluginRuntimePermissionRequest, allowed: boolean) {
    if (request.bridgeReqId !== null) options.sources.reply(request.source, request.identity, {
      __atools_permission_response__: true, reqId: request.bridgeReqId, permission: request.permission, allowed,
    });
  }
  function remove(id: string, allowed: boolean) {
    const entry = entries.get(id); if (!entry) return false;
    entries.delete(id);
    reply(entry.request, allowed);
    entry.resolve?.(allowed);
    options.changed([...entries.values()].map(value => value.request));
    return true;
  }
  function request(permission: string, source: Window | null, bridgeReqId: number | null = null) {
    const value = String(permission || "").trim(), identity = options.sources.currentIdentityForHost(source);
    if (!value || !identity) return Promise.resolve(false);
    const captured: PluginRuntimePermissionRequest = Object.freeze({ id: `permission:${++sequence}`,
      pluginId: options.pluginId(), permission: value, source, identity, bridgeReqId });
    if (options.allowed(value)) { reply(captured, true); return Promise.resolve(true); }
    if (entries.size >= 32) { reply(captured, false); return Promise.resolve(false); }
    const entry: { request: PluginRuntimePermissionRequest; resolve?: (allowed: boolean) => void } = { request: captured };
    const result = bridgeReqId === null ? new Promise<boolean>(resolve => { entry.resolve = resolve; }) : Promise.resolve(false);
    entries.set(captured.id, entry);
    options.changed([...entries.values()].map(item => item.request));
    return result;
  }
  function respond(request: PluginRuntimePermissionRequest, allowed: boolean, persistent = false) {
    const entry = entries.get(request.id);
    if (!entry || entry.request !== request) return false;
    const accepted = allowed && current(request);
    if (accepted) options.grant(request.pluginId, request.permission, persistent);
    remove(request.id, accepted);
    return accepted;
  }
  function clear() { for (const id of [...entries.keys()]) remove(id, false); }
  return { request, respond, clear };
}

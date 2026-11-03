import { createPluginFramePermissionQueue, type PluginRuntimePermissionRequest } from "./pluginFramePermissionQueue";
import {
  isPluginBridgeRequestId, pluginPermissionListAllows, postPluginFrameMessageIfCurrent,
  resolvePluginPermissionRequest, type PluginFrameIdentity, type PluginFrameSourceRegistry,
} from "./pluginInvokePolicy";
import type { FeatureAction } from "./types";

type PermissionRequest = ReturnType<typeof resolvePluginPermissionRequest>;

export interface PluginPanelPermissionPorts {
  action(): FeatureAction;
  sources: PluginFrameSourceRegistry;
  approved(): string[];
  setApproved(value: string[]): void;
  persistent(): string[];
  setPersistent(value: string[]): void;
  changed(requests: PluginRuntimePermissionRequest[]): void;
  smokePermissionEnabled(): boolean;
  grantPersistent(pluginId: string, permission: string): void;
  persistentForPlugin(pluginId: string): string[];
}

export function createPluginPanelPermissionController(ports: PluginPanelPermissionPorts) {
  const normalized = (permission: string | null | undefined) => String(permission || "").trim();
  const smokePermissionAllowed = (permission: string | null | undefined) => {
    const value = normalized(permission);
    return Boolean(value && ports.smokePermissionEnabled() && [
      "system.path", "screen.desktopCaptureSources", "context.browser", "context.finder", "browserWindow",
    ].includes(value));
  };
  const hostPermissionAllowed = (permission: string | null | undefined) => {
    const value = normalized(permission);
    return Boolean(value && (pluginPermissionListAllows(ports.approved(), value)
      || pluginPermissionListAllows(ports.persistent(), value)
      || pluginPermissionListAllows(ports.action().plugin_permissions, value)));
  };
  const queue = createPluginFramePermissionQueue({
    sources: ports.sources, pluginId: () => ports.action().plugin_id,
    allowed: permission => hostPermissionAllowed(permission) || smokePermissionAllowed(permission),
    changed: ports.changed,
    grant: (pluginId, permission, persistent) => {
      if (persistent) ports.grantPersistent(pluginId, permission);
      ports.setPersistent(ports.persistentForPlugin(pluginId));
      const value = normalized(permission);
      if (value && !ports.approved().includes(value)) ports.setApproved([...ports.approved(), value]);
    },
  });
  const enqueue = (permission: string, source: Window | null, bridgeReqId: number | null = null) =>
    queue.request(permission, source, bridgeReqId);
  const handleRequest = (event: MessageEvent, data: Record<string, unknown>, identity: PluginFrameIdentity) => {
    if (!isPluginBridgeRequestId(data.reqId)) return;
    try {
      const request: PermissionRequest = resolvePluginPermissionRequest(data);
      void enqueue(request.permission, event.source as Window | null, request.reqId);
    } catch {
      const value = normalized(data.permission as string | undefined);
      const message = { __atools_permission_response__: true, reqId: data.reqId,
        permission: value, allowed: false, error: "Invalid plugin permission request" };
      postPluginFrameMessageIfCurrent({ source: event.source, identity, sources: ports.sources, message });
    }
  };
  const ensure = async (permission: string | null | undefined, source: Window | null) => {
    const value = normalized(permission);
    if (!value) throw new Error("Unsupported plugin permission");
    if (!await enqueue(value, source)) throw new Error(`Plugin permission denied: ${value}`);
  };
  return {
    queue, normalized, clear: () => queue.clear(), enqueue, ensure, handleRequest,
    respond: (request: PluginRuntimePermissionRequest, allowed: boolean, persistent = false) => queue.respond(request, allowed, persistent),
  };
}

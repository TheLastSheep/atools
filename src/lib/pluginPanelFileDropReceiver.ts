import { createPluginFileIdentityRegistry } from "./pluginFileIdentity";
import { parsePluginFileDropPacket } from "./pluginFileDropPacket";

export type ReceiverWindow = Window & { File: typeof File; DataTransfer: typeof DataTransfer; DragEvent: typeof DragEvent;
  __ATOOLS_BOOTSTRAP_HANDOFF__?: Record<string, unknown>;
  __ATOOLS_FILE_DROP_IDENTITY__?: { getPathForFile(file: unknown): string } };
type ReceiverConfig = { pluginId: string; windowType: "main" | "browserWindow"; windowId: string; documentNonce: string };

/** Runs in the receiving plugin realm, before the original preload and page scripts. */
export function createPluginPanelFileDropReceiver(hostWindow: ReceiverWindow, config: ReceiverConfig,
  parsePacket: typeof parsePluginFileDropPacket, createIdentityRegistry: typeof createPluginFileIdentityRegistry) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const nonce = config.documentNonce;
  if (!/^[0-9a-f]{32}$/.test(nonce) || !config.pluginId || config.pluginId.length > 256
    || new TextEncoder().encode(config.pluginId).byteLength > 256
    || (config.windowType !== "main" && config.windowType !== "browserWindow")
    || (config.windowType === "browserWindow" && !config.windowId)) throw new Error("ERR_ATOOLS_FILE_DROP_RECEIVER_BINDING");
  const identities = createIdentityRegistry();
  Object.defineProperty(hostWindow, "__ATOOLS_FILE_DROP_IDENTITY__", {
    value: Object.freeze({ getPathForFile: identities.getPathForFile }), configurable: false, writable: false,
  });
  let binding: { frameGeneration: number; pageDocumentId?: string; instanceId: string } | undefined;
  let closed = false;
  const handoff = hostWindow.__ATOOLS_BOOTSTRAP_HANDOFF__;
  function ack(data: Record<string, unknown>) {
    try { hostWindow.parent.postMessage({ __atools_plugin_file_drop_ack__: true,
      documentNonce: nonce, pluginId: config.pluginId, windowType: config.windowType, windowId: config.windowId, ...data }, "*"); }
    catch { /* The host's bounded acknowledgement timeout owns transport failure. */ }
  }
  function validCommon(data: Record<string, unknown>) {
    return !closed && data.pluginId === config.pluginId && data.windowType === config.windowType
      && data.windowId === config.windowId && data.documentNonce === nonce
      && Number.isSafeInteger(data.frameGeneration) && Number(data.frameGeneration) > 0
      && typeof data.instanceId === "string" && uuid.test(data.instanceId);
  }
  function onMessage(event: MessageEvent) {
    if (event.source !== hostWindow.parent || !event.data || typeof event.data !== "object" || Array.isArray(event.data)) return;
    const data = event.data as Record<string, unknown>;
    if (data.__atools_plugin_file_drop__ !== true || !validCommon(data)) return;
    if (handoff && (typeof data.pageDocumentId !== "string" || data.pageDocumentId !== handoff.runId
      || handoff.id !== data.pageDocumentId || handoff.docNonce !== nonce
      || handoff.generation !== data.frameGeneration)) return;
    if (data.phase === "revokeAll") { identities.revokeAll(); return; }
    if (data.phase === "revoke" && typeof data.leaseId === "string") { identities.revoke(data.leaseId); return; }
    if (data.phase === "bind") {
      if (binding && binding.frameGeneration !== data.frameGeneration) identities.revokeAll();
      binding = { frameGeneration: Number(data.frameGeneration), instanceId: data.instanceId as string,
        ...(typeof data.pageDocumentId === "string" ? { pageDocumentId: data.pageDocumentId } : {}) };
      return;
    }
    if (data.phase !== "deliver" || !binding || binding.frameGeneration !== data.frameGeneration
      || binding.instanceId !== data.instanceId || data.requestId === undefined || typeof data.requestId !== "string"
      || !uuid.test(data.requestId) || !(data.packet instanceof ArrayBuffer)
      || !Number.isFinite(data.x) || !Number.isFinite(data.y) || !Number.isFinite(data.contentWidth)
      || !Number.isFinite(data.contentHeight) || Number(data.x) < 0 || Number(data.y) < 0
      || Number(data.contentWidth) <= 0 || Number(data.contentHeight) <= 0) return;
    const packet = data.packet;
    let registeredLease: string | undefined;
    try {
      const parsed = parsePacket(packet, data.requestId);
      const viewportWidth = Number(hostWindow.innerWidth), viewportHeight = Number(hostWindow.innerHeight);
      if (!Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight)
        || Math.abs(viewportWidth - Number(data.contentWidth)) > 1
        || Math.abs(viewportHeight - Number(data.contentHeight)) > 1
        || Number(data.x) >= viewportWidth || Number(data.y) >= viewportHeight) throw new Error("ERR_ATOOLS_FILE_DROP_VIEWPORT");
      const target = hostWindow.document.elementFromPoint(Number(data.x), Number(data.y));
      const DataTransferCtor = hostWindow.DataTransfer;
      if (!target || typeof DataTransferCtor !== "function") throw new Error("ERR_ATOOLS_FILE_DROP_TARGET");
      const files = parsed.files.map(file => new hostWindow.File(
        [parsed.bytes.subarray(file.offset, file.offset + file.size)], file.name,
        { type: file.type, lastModified: file.lastModified }));
      const lease = identities.register(parsed.leaseId, parsed.expiresAt,
        files.map((file, index) => ({ file, path: parsed.files[index].path })));
      registeredLease = lease.id;
      const transfer = new DataTransferCtor();
      for (const file of files) transfer.items.add(file);
      for (const type of ["dragenter", "dragover", "drop"]) {
        const drag = new hostWindow.DragEvent(type, { bubbles: true, cancelable: true,
          clientX: Number(data.x), clientY: Number(data.y), dataTransfer: transfer });
        target.dispatchEvent(drag);
      }
      ack({ requestId: data.requestId, instanceId: data.instanceId, frameGeneration: data.frameGeneration,
        outcome: "dispatched", fileCount: files.length, byteCount: parsed.bytes.byteLength,
        leaseId: lease.id, isTrusted: false });
    } catch (error) {
      if (registeredLease) identities.revoke(registeredLease);
      const code = error instanceof Error && /^ERR_ATOOLS_FILE_DROP_[A-Z_]+$/.test(error.message)
        ? error.message : "ERR_ATOOLS_FILE_DROP_RECEIVER";
      ack({ requestId: data.requestId, instanceId: data.instanceId, frameGeneration: data.frameGeneration,
        outcome: "rejected", error: code });
    }
  }
  function close() {
    if (closed) return;
    closed = true; binding = undefined;
    identities.revokeAll();
    hostWindow.removeEventListener("message", onMessage);
    hostWindow.removeEventListener("pagehide", close);
  }
  hostWindow.addEventListener("message", onMessage);
  hostWindow.addEventListener("pagehide", close, { once: true });
  return { getPathForFile: identities.getPathForFile, close };
}

/** Functions are serialized into the host bridge's own script, not plugin source. */
export function pluginPanelFileDropReceiverFactorySource() {
  return `(function(){var parse=${parsePluginFileDropPacket.toString()};var identities=${createPluginFileIdentityRegistry.toString()};var create=${createPluginPanelFileDropReceiver.toString()};return function(host,config){return create(host,config,parse,identities);};})()`;
}

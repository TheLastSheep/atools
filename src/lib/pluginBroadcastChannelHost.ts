import { isPluginDocumentIdentity, type PluginFrameIdentity, type PluginFrameSourceRegistry } from "./pluginFrameDocumentIdentity";
import { measurePluginBroadcastPayload } from "./pluginBroadcastPayload";

const FLAG = "__atools_broadcast_channel__";
const CHANNEL_ID = /^([0-9a-f]{32}):([1-9][0-9]*)$/;
const DOCUMENT_NONCE = /^[0-9a-f]{32}$/;
const MAX_INSTANCES = 256;
const MAX_INSTANCES_PER_DOCUMENT = 32;
const MAX_PENDING_DELIVERIES = 128;
const MAX_PENDING_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_PER_DOCUMENT = 32;
const MAX_PENDING_BYTES_PER_DOCUMENT = 8 * 1024 * 1024;
const ENVELOPE_OVERHEAD = 512;

type Lease = { assertCurrent: () => void };
type Sender = { source: unknown; identity: PluginFrameIdentity };
type Channel = { id: string; name: string; document: DocumentEntry };
type DocumentEntry = {
  source: object;
  identity: PluginFrameIdentity;
  identityKey: string;
  documentNonce: string;
  lease: Lease;
  pluginId: string;
  prefix: string;
  lastChannelCounter: number;
  lastSequence: number;
  channels: Map<string, Channel>;
  pending: Map<number, number>;
  pendingBytes: number;
  unlisten?: () => void;
};
type Delivery = { target: DocumentEntry; bytes: number };
type HostOptions = {
  sources: PluginFrameSourceRegistry;
  pluginId: () => string;
  post: (source: unknown, message: unknown, identity: PluginFrameIdentity) => boolean;
  captureDocumentLease: (sender: Sender, nonce: string) => Lease;
  clone?: (value: unknown) => unknown;
};

function identityKey(identity: PluginFrameIdentity) {
  const role = identity.kind === "main" ? "main" : `child:${identity.windowId}`;
  const document = "mode" in identity
    ? `${identity.pageDocumentId}:${identity.docNonce}:${identity.expectedOrigin}:${identity.parentOrigin}` : "";
  return `${role}:${identity.generation}:${document}`;
}

function isSource(value: unknown): value is object {
  return !!value && (typeof value === "object" || typeof value === "function");
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function ownValue(value: Record<string, unknown>, name: string) {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function fields(value: Record<string, unknown>, names: string[], documentEnvelope: boolean) {
  const allowed = documentEnvelope ? [...names, "__atoolsDocument"] : names;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== allowed.length || keys.some(key => typeof key !== "string" || !allowed.includes(key))) return null;
  const result: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !("value" in descriptor)) return null;
    result[name] = descriptor.value;
  }
  return result;
}

function safeError(error: unknown) {
  if (!error || typeof error !== "object") return "ERR_ATOOLS_BROADCAST_REJECTED";
  const message = Object.getOwnPropertyDescriptor(error, "message");
  const name = Object.getOwnPropertyDescriptor(error, "name");
  let text = message && "value" in message && typeof message.value === "string" ? message.value : "";
  let kind = name && "value" in name ? name.value : "";
  if (typeof DOMException === "function") {
    // Built-in brand getters do not invoke plugin-provided accessors.
    for (const property of ["message", "name"] as const) {
      const getter = Object.getOwnPropertyDescriptor(DOMException.prototype, property)?.get;
      if (typeof getter !== "function") continue;
      try {
        const value = Reflect.apply(getter, error, []);
        if (property === "message" && typeof value === "string") text = value;
        if (property === "name") kind = value;
      } catch { /* Not a DOMException from this realm. */ }
    }
  }
  if (text.includes("ERR_ATOOLS_BROADCAST_BUDGET")) return "ERR_ATOOLS_BROADCAST_BUDGET";
  if (text.includes("ERR_ATOOLS_BROADCAST_DATA_CLONE") || kind === "DataCloneError") return "ERR_ATOOLS_BROADCAST_DATA_CLONE";
  return "ERR_ATOOLS_BROADCAST_REJECTED";
}

/** Per-panel BroadcastChannel rooms. Frame/document leases remain the authority. */
export function createPluginBroadcastChannelHost(options: HostOptions) {
  const documents = new Set<DocumentEntry>();
  const deliveries = new Map<number, Delivery>();
  let nextDeliveryId = 1;
  let outstandingBytes = 0;
  let closed = false;

  function currentPluginId() {
    try { return options.pluginId().trim(); } catch { return ""; }
  }
  function current(document: DocumentEntry) {
    if (closed || !documents.has(document) || !document.pluginId || document.pluginId !== currentPluginId()
      || !options.sources.isCurrent(document.source, document.identity)) return false;
    try { document.lease.assertCurrent(); return true; } catch { return false; }
  }
  function send(document: DocumentEntry, message: Record<string, unknown>) {
    if (!current(document)) return false;
    try {
      return options.post(document.source, { ...message, targetDocumentNonce: document.documentNonce }, document.identity);
    } catch { return false; }
  }
  function releaseDelivery(id: number) {
    const delivery = deliveries.get(id);
    if (!delivery) return false;
    deliveries.delete(id);
    delivery.target.pending.delete(id);
    delivery.target.pendingBytes = Math.max(0, delivery.target.pendingBytes - delivery.bytes);
    outstandingBytes = Math.max(0, outstandingBytes - delivery.bytes);
    return true;
  }
  function removeDocument(document: DocumentEntry) {
    if (!documents.delete(document)) return;
    document.unlisten?.();
    document.unlisten = undefined;
    document.channels.clear();
    for (const [id, delivery] of deliveries) if (delivery.target === document) releaseDelivery(id);
  }
  function prune() {
    if (closed) return;
    const pluginId = currentPluginId();
    for (const document of [...documents]) {
      if (!pluginId || document.pluginId !== pluginId || !current(document)) removeDocument(document);
    }
    for (const [id, delivery] of deliveries) if (!current(delivery.target)) releaseDelivery(id);
  }
  function findDocument(source: object, identity: PluginFrameIdentity, nonce: string) {
    const key = identityKey(identity);
    return [...documents].find(document => document.source === source
      && document.identityKey === key && document.documentNonce === nonce);
  }
  function ensureDocument(source: unknown, identity: PluginFrameIdentity, nonce: string, lease: Lease): DocumentEntry | undefined {
    if (!isSource(source) || closed || !options.sources.isCurrent(source, identity)) return undefined;
    const pluginId = currentPluginId();
    if (!pluginId) return undefined;
    const existing = findDocument(source, identity, nonce);
    if (existing) return existing.pluginId === pluginId ? existing : undefined;
    // A hosted document nonce may rotate while its WindowProxy and registry identity stay stable.
    for (const document of [...documents]) {
      if (document.source === source && document.identityKey === identityKey(identity)) removeDocument(document);
    }
    const entry: DocumentEntry = { source, identity, identityKey: identityKey(identity), documentNonce: nonce, lease, pluginId,
      prefix: "", lastChannelCounter: 0, lastSequence: 0, channels: new Map(), pending: new Map(), pendingBytes: 0 };
    documents.add(entry);
    entry.unlisten = options.sources.onFrameInvalidated(source, identity, () => removeDocument(entry));
    return documents.has(entry) ? entry : undefined;
  }
  function error(document: DocumentEntry, channelId: unknown, code: string) {
    if (typeof channelId !== "string" || channelId.length > 64) return false;
    return send(document, { [FLAG]: true, op: "error", channelId, error: code });
  }
  function accepted(document: DocumentEntry, channelId: string, sequence: number, code?: string) {
    return send(document, { [FLAG]: true, op: "accepted", channelId, sequence, ...(code ? { error: code } : {}) });
  }
  function parseId(value: unknown) {
    if (typeof value !== "string" || value.length > 50) return null;
    const match = CHANNEL_ID.exec(value);
    if (!match || match[0] !== value) return null;
    const counter = Number(match[2]);
    return Number.isSafeInteger(counter) && counter > 0 ? { prefix: match[1], counter } : null;
  }
  function removeChannel(document: DocumentEntry, channelId: string) {
    return document.channels.delete(channelId);
  }
  function releaseTargetDeliveries(document: DocumentEntry) {
    for (const [id, delivery] of deliveries) if (delivery.target === document) releaseDelivery(id);
  }
  function totalInstances() {
    let total = 0;
    for (const document of documents) total += document.channels.size;
    return total;
  }
  function admitJoin(document: DocumentEntry, channelId: unknown, name: unknown) {
    const id = parseId(channelId);
    if (typeof channelId !== "string" || !id || typeof name !== "string" || name.length > 128) {
      error(document, channelId, "ERR_ATOOLS_BROADCAST_INVALID");
      return;
    }
    if ((document.prefix && document.prefix !== id.prefix) || id.counter <= document.lastChannelCounter
      || document.channels.has(channelId)) {
      error(document, channelId, "ERR_ATOOLS_BROADCAST_REPLAY");
      return;
    }
    if (totalInstances() >= MAX_INSTANCES || document.channels.size >= MAX_INSTANCES_PER_DOCUMENT) {
      error(document, channelId, "ERR_ATOOLS_BROADCAST_LIMIT");
      return;
    }
    document.prefix ||= id.prefix;
    document.lastChannelCounter = id.counter;
    document.channels.set(channelId, { id: channelId, name, document });
  }
  function acknowledge(document: DocumentEntry, deliveryId: unknown) {
    if (!Number.isSafeInteger(deliveryId) || Number(deliveryId) <= 0) return;
    const id = Number(deliveryId), delivery = deliveries.get(id);
    if (delivery?.target !== document || !current(document)) return;
    releaseDelivery(id);
  }
  function post(document: DocumentEntry, channelId: unknown, sequence: unknown, data: unknown, origin: unknown) {
    if (!Number.isSafeInteger(sequence) || Number(sequence) <= document.lastSequence || Number(sequence) <= 0) {
      if (typeof channelId === "string" && Number.isSafeInteger(sequence) && Number(sequence) > 0)
        accepted(document, channelId, Number(sequence), "ERR_ATOOLS_BROADCAST_REPLAY");
      return;
    }
    document.lastSequence = Number(sequence);
    const channel = typeof channelId === "string" ? document.channels.get(channelId) : undefined;
    if (!channel || channel.document !== document || !current(document)) {
      if (typeof channelId === "string") accepted(document, channelId, document.lastSequence, "ERR_ATOOLS_BROADCAST_CLOSED");
      return;
    }
    if (typeof origin !== "string" || origin.length > 2048) {
      accepted(document, channel.id, document.lastSequence, "ERR_ATOOLS_BROADCAST_INVALID");
      return;
    }

    let payloadBytes: number;
    try { payloadBytes = measurePluginBroadcastPayload(data); }
    catch (cause) { accepted(document, channel.id, document.lastSequence, safeError(cause)); return; }

    const groups = new Map<DocumentEntry, string[]>();
    for (const target of documents) {
      if (target.pluginId !== document.pluginId || !current(target)) continue;
      for (const recipient of target.channels.values()) {
        if (recipient.name !== channel.name || (recipient.document === document && recipient.id === channel.id)) continue;
        const recipients = groups.get(target) ?? [];
        recipients.push(recipient.id);
        groups.set(target, recipients);
      }
    }
    const bytesByTarget = new Map<DocumentEntry, number>();
    for (const [target, recipients] of groups) {
      const bytes = payloadBytes + ENVELOPE_OVERHEAD + (channel.name.length + origin.length) * 2 + recipients.length * 64;
      bytesByTarget.set(target, bytes);
      if (target.pending.size >= MAX_PENDING_PER_DOCUMENT
        || target.pendingBytes + bytes > MAX_PENDING_BYTES_PER_DOCUMENT) {
        accepted(document, channel.id, document.lastSequence, "ERR_ATOOLS_BROADCAST_BUDGET");
        return;
      }
    }
    const fanoutBytes = [...bytesByTarget.values()].reduce((sum, bytes) => sum + bytes, 0);
    if (groups.size + deliveries.size > MAX_PENDING_DELIVERIES || outstandingBytes + fanoutBytes > MAX_PENDING_BYTES) {
      accepted(document, channel.id, document.lastSequence, "ERR_ATOOLS_BROADCAST_BUDGET");
      return;
    }
    if (groups.size && (nextDeliveryId <= 0 || nextDeliveryId > Number.MAX_SAFE_INTEGER - groups.size + 1)) {
      accepted(document, channel.id, document.lastSequence, "ERR_ATOOLS_BROADCAST_LIMIT");
      return;
    }

    let pinned: unknown;
    try {
      const clone = options.clone ?? (value => {
        if (typeof structuredClone !== "function") throw new DOMException("Structured clone is unavailable", "DataCloneError");
        return structuredClone(value);
      });
      pinned = clone(data);
    } catch (cause) { accepted(document, channel.id, document.lastSequence, safeError(cause)); return; }

    const reserved: Array<{ target: DocumentEntry; id: number; recipients: string[] }> = [];
    for (const [target, recipients] of groups) {
      const id = nextDeliveryId++, bytes = bytesByTarget.get(target)!;
      deliveries.set(id, { target, bytes });
      target.pending.set(id, bytes);
      target.pendingBytes += bytes;
      outstandingBytes += bytes;
      reserved.push({ target, id, recipients });
    }
    let failed = false;
    for (const delivery of reserved) {
      const sent = send(delivery.target, { [FLAG]: true, op: "message", deliveryId: delivery.id,
        recipients: delivery.recipients, name: channel.name, origin, data: pinned });
      if (!sent) { releaseDelivery(delivery.id); failed = true; }
    }
    accepted(document, channel.id, document.lastSequence, failed ? "ERR_ATOOLS_BROADCAST_DELIVERY" : undefined);
  }
  function dispatch(source: unknown, identity: PluginFrameIdentity, data: unknown, origin: string): boolean {
    prune();
    if (closed || !record(data)) return false;
    const flag = ownValue(data, FLAG), op = ownValue(data, "op");
    if (flag !== true) return false;
    if (typeof op !== "string" || !["join", "leave", "post", "ack", "dispose"].includes(op)) return true;
    const identified = options.sources.identifyEvent({ source, origin, data });
    if (!identified || identityKey(identified) !== identityKey(identity)) return true;
    const nonce = ownValue(data, "documentNonce");
    if (typeof nonce !== "string" || nonce.length !== 32 || !DOCUMENT_NONCE.test(nonce)) return true;
    let lease: Lease;
    try {
      lease = options.captureDocumentLease({ source, identity }, nonce);
      lease.assertCurrent();
    } catch { return true; }
    const document = ensureDocument(source, identity, nonce, lease);
    if (!document) return true;
    const hasDocumentEnvelope = isPluginDocumentIdentity(identity);
    const common = [FLAG, "op", "documentNonce"];
    if (op === "join") {
      const message = fields(data, [...common, "channelId", "name"], hasDocumentEnvelope);
      if (message) admitJoin(document, message.channelId, message.name);
      else error(document, ownValue(data, "channelId"), "ERR_ATOOLS_BROADCAST_INVALID");
    } else if (op === "leave") {
      const message = fields(data, [...common, "channelId"], hasDocumentEnvelope);
      if (message && typeof message.channelId === "string") removeChannel(document, message.channelId);
    } else if (op === "post") {
      const message = fields(data, [...common, "channelId", "sequence", "data"], hasDocumentEnvelope);
      if (message) post(document, message.channelId, message.sequence, message.data, origin);
      else {
        const channelId = ownValue(data, "channelId"), sequence = ownValue(data, "sequence");
        if (typeof channelId === "string" && Number.isSafeInteger(sequence) && Number(sequence) > 0)
          accepted(document, channelId, Number(sequence), "ERR_ATOOLS_BROADCAST_INVALID");
      }
    } else if (op === "ack") {
      const message = fields(data, [...common, "deliveryId"], hasDocumentEnvelope);
      if (message) acknowledge(document, message.deliveryId);
    } else {
      const message = fields(data, common, hasDocumentEnvelope);
      if (message) {
        document.channels.clear();
        releaseTargetDeliveries(document);
      }
    }
    return true;
  }
  function invalidateSource(source: unknown) {
    if (!isSource(source) || closed) return;
    prune();
    for (const document of [...documents]) if (document.source === source && current(document)) removeDocument(document);
  }
  function close() {
    if (closed) return;
    closed = true;
    for (const document of [...documents]) removeDocument(document);
    for (const id of [...deliveries.keys()]) releaseDelivery(id);
    outstandingBytes = 0;
  }
  function diagnostics() {
    let instances = 0;
    for (const document of documents) instances += document.channels.size;
    return { documents: documents.size, instances, deliveries: deliveries.size, outstandingBytes };
  }
  return { dispatch, invalidateSource, prune, close, diagnostics };
}

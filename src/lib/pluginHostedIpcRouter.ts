import { type PluginFrameIdentity, type PluginFrameReplyTarget, PluginFrameSourceRegistry, runPluginFrameOperation, isPluginDocumentIdentity } from "./pluginFrameDocumentIdentity";

type Role = { kind: "main" } | { kind: "child"; windowId: string };
type Sender = { source: unknown; identity: PluginFrameIdentity };
export type PluginHostedDocumentLease = Sender & {
  documentNonce: string;
  pageDocumentId?: string;
  assertCurrent: () => void;
};
type Document = Sender & { documentNonce?: string; loadTicket: boolean; ready: boolean; readyPromise: Promise<void>; resolveReady: () => void };
type ReadyWaiter = { source: unknown; nonce: string; promise: Promise<void>; resolve: () => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> };
type Slot = { id: number; role: Role; document?: Document; replyTarget?: PluginFrameReplyTarget; replySource?: unknown; readyWaiter?: ReadyWaiter; awaitingOpenAfterLoad?: boolean };
type Captured = { dispose: () => void; deliver: () => Promise<boolean> };
let contentsSequence = 0;
const roleKey = (role: Role) => role.kind === "main" ? "main" : "child:" + role.windowId;
const failure = (detail: string) => new Error("ERR_ATOOLS_HOSTED_IPC: " + detail);

/** Strict JSON snapshots prevent mutation while a permission or document handshake is pending. */
export function normalizeHostedIpcMessage(channel: unknown, args: unknown) {
  if (typeof channel !== "string" || !channel.trim() || channel.length > 128 || channel.includes("\0")) throw failure("invalid channel");
  if (!Array.isArray(args) || args.length > 32) throw failure("at most 32 JSON arguments are allowed");
  const seen = new Set<object>();
  let nodes = 0, estimatedBytes = channel.length;
  const encoder = new TextEncoder();
  function charge(value: string) {
    if (value.length > 16_384 || (estimatedBytes += encoder.encode(value).byteLength) > 16_384) throw failure("message exceeds 16384 bytes");
  }
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > 1024) throw failure("JSON node budget exceeds 1024");
    if (depth > 12) throw failure("JSON depth exceeds 12");
    if (typeof value === "string") { charge(value); return value; }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object" || seen.has(value)) throw failure("arguments must be finite acyclic JSON");
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw failure("arguments must be plain JSON");
    seen.add(value);
    const result: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : Object.create(null);
    if (Array.isArray(value)) {
      if (value.length > 1024) throw failure("JSON array budget exceeds 1024");
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) throw failure("JSON requires own data properties");
        (result as unknown[]).push(copy(descriptor.value, depth + 1));
      }
    } else for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (++nodes > 1024) throw failure("JSON node budget exceeds 1024");
      charge(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in descriptor)) throw failure("JSON requires own data properties");
      (result as Record<string, unknown>)[key] = copy(descriptor.value, depth + 1);
    }
    seen.delete(value);
    return result;
  }
  const copiedArgs = copy(args, 0) as unknown[];
  const bytes = new TextEncoder().encode(JSON.stringify({ channel, args: copiedArgs })).byteLength;
  if (bytes > 16_384) throw failure("message exceeds 16384 bytes");
  return { channel, args: copiedArgs, bytes };
}

/** IDs locate a panel frame; every admitted message separately pins both exact documents. */
export function createPluginHostedIpcRouter(options: {
  sources: PluginFrameSourceRegistry;
  creatorFor: (windowId: string) => Sender | undefined;
  timeoutMs?: number;
}) {
  const slots = new Map<string, Slot>();
  const pending = new Set<{ sender: Document; target: Document; cancel: () => void }>();
  let pendingBytes = 0;
  function reserve(role: Role) {
    const key = roleKey(role);
    const existing = slots.get(key);
    if (existing) return existing.id;
    if (slots.size >= 33 || contentsSequence >= Number.MAX_SAFE_INTEGER) throw failure("frame ID limit");
    const id = ++contentsSequence;
    slots.set(key, { id, role: { ...role } });
    return id;
  }
  function hasReservation(role: Role) { return slots.has(roleKey(role)); }
  function cancelDocument(document: Document | undefined) {
    if (!document) return;
    for (const message of [...pending]) if (message.sender === document || message.target === document) message.cancel();
  }
  function bind(role: Role, source: unknown, identity: PluginFrameIdentity, ready = false, replyTarget?: PluginFrameReplyTarget) {
    const slot = slots.get(roleKey(role));
    if (!slot || roleKey(identity) !== roleKey(role) || !options.sources.isCurrent(source, identity)) throw failure("unregistered document");
    const existing = slot.document;
    // Message handlers may bind the same actual WindowProxy after a document
    // handshake. Retain that slot's shell transport only for the same source.
    if (replyTarget !== undefined) slot.replyTarget = replyTarget;
    else if (slot.replySource !== source) slot.replyTarget = undefined;
    slot.replySource = source;
    if (existing && existing.source === source && existing.identity === identity) {
      if (ready) { existing.ready = true; existing.resolveReady(); }
      return slot.id;
    }
    // Legacy registry identities are copied. A current identical generation is the same document.
    if (existing && existing.source === source && options.sources.isCurrent(source, existing.identity)) {
      if (ready) { existing.ready = true; existing.resolveReady(); }
      return slot.id;
    }
    cancelDocument(slot.document);
    let resolveReady!: () => void;
    const readyPromise = new Promise<void>(resolve => { resolveReady = resolve; });
    slot.document = { source, identity, ready, readyPromise, resolveReady, loadTicket: false };
    if (ready) resolveReady();
    return slot.id;
  }
  function markReady(role: Role, source: unknown, identity: PluginFrameIdentity) {
    const slot = slots.get(roleKey(role));
    if (!slot?.document || slot.document.source !== source || !options.sources.isCurrent(source, slot.document.identity)
      || !options.sources.isCurrent(source, identity)) return false;
    slot.document.ready = true;
    slot.document.resolveReady();
    return true;
  }
  function invalidate(role: Role, remove = false, expectedSource?: unknown) {
    const slot = slots.get(roleKey(role));
    if (expectedSource !== undefined && slot?.document?.source !== expectedSource) return;
    cancelDocument(slot?.document);
    if (slot) { cancelReady(slot); slot.document = undefined; slot.awaitingOpenAfterLoad = false; }
    if (remove) slots.delete(roleKey(role));
  }
  function current(document: Document) { return options.sources.isCurrent(document.source, document.identity); }
  function cancelReady(slot: Slot) {
    const waiter = slot.readyWaiter;
    if (!waiter) return;
    slot.readyWaiter = undefined;
    clearTimeout(waiter.timer);
    waiter.reject(failure("RPC readiness document was invalidated"));
  }
  function mergeReady(slot: Slot) {
    const document = slot.document, waiter = slot.readyWaiter;
    if (!document?.documentNonce || !waiter) return;
    if (document.source !== waiter.source || document.documentNonce !== waiter.nonce || !current(document)) { cancelReady(slot); return; }
    document.ready = true;
    document.resolveReady();
    slot.readyWaiter = undefined;
    clearTimeout(waiter.timer);
    waiter.resolve();
  }
  function readinessFailureIsCurrent(role: Role, source: unknown, nonce: unknown) {
    const document = slots.get(roleKey(role))?.document;
    return !!document && document.source === source && current(document)
      && (nonce === undefined || !document.documentNonce || document.documentNonce === nonce);
  }
  /** RPC MessagePort and window.postMessage have independent queues; join their exact nonce proofs. */
  async function confirmReady(role: Role, source: unknown, nonce: unknown) {
    const slot = slots.get(roleKey(role)), document = slot?.document;
    if (!slot || !document || document.source !== source || !current(document)
      || typeof nonce !== "string" || !/^[0-9a-f]{32}$/.test(nonce)) throw failure("RPC readiness requires its current runtime document nonce");
    if (document.documentNonce && document.documentNonce !== nonce) throw failure("RPC readiness nonce does not match the current document");
    if (slot.readyWaiter && (slot.readyWaiter.source !== source || slot.readyWaiter.nonce !== nonce)) cancelReady(slot);
    if (!slot.readyWaiter) {
      let resolve!: () => void, reject!: (reason: Error) => void;
      const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
      void promise.catch(() => undefined);
      const waiter: ReadyWaiter = { source, nonce, promise, resolve, reject,
        timer: setTimeout(() => { if (slot.readyWaiter === waiter) { slot.readyWaiter = undefined; reject(failure("runtime document confirmation timed out")); } }, options.timeoutMs ?? 3000) };
      slot.readyWaiter = waiter;
    }
    const confirmation = slot.readyWaiter.promise;
    mergeReady(slot);
    await confirmation;
    const identity = options.sources.currentIdentityForHost(source);
    if (!identity) throw failure("RPC readiness document is no longer current");
    return captureDocumentLease({ source, identity }, nonce);
  }
  function captureDocumentLease(sender: Sender, nonce: unknown) {
    const slot = slots.get(roleKey(sender.identity)), document = slot?.document;
    function assertCurrent() {
      if (!document || typeof nonce !== "string" || document.documentNonce !== nonce || slot?.document !== document
        || document.source !== sender.source || !current(document) || !options.sources.isCurrent(sender.source, sender.identity)) throw failure("stale or missing native document lease");
    }
    assertCurrent();
    const pageDocumentId = isPluginDocumentIdentity(sender.identity) ? sender.identity.pageDocumentId : undefined;
    return { source: sender.source, identity: sender.identity, documentNonce: String(nonce), pageDocumentId, assertCurrent };
  }
  function captureReadyDocumentLease(source: unknown) {
    const identity = options.sources.currentIdentityForHost(source);
    if (!identity) throw failure("unregistered file-drop document");
    const slot = slots.get(roleKey(identity)), document = slot?.document;
    if (!document || document.source !== source || !document.ready || !document.documentNonce
      || !/^[0-9a-f]{32}$/.test(document.documentNonce) || !current(document)) throw failure("file-drop document is not ready");
    const capturedDocument = document, capturedIdentity = identity, nonce = document.documentNonce;
    const pageDocumentId = isPluginDocumentIdentity(identity) ? identity.pageDocumentId : undefined;
    function assertCurrent() {
      if (slot?.document !== capturedDocument || capturedDocument.source !== source || capturedDocument.documentNonce !== nonce
        || !capturedDocument.ready || !current(capturedDocument) || !options.sources.isCurrent(source, capturedIdentity)) throw failure("stale file-drop document lease");
    }
    assertCurrent();
    return { source, identity, documentNonce: nonce, pageDocumentId, assertCurrent };
  }
  /** A confirmed runtime has already established this document before its load event. */
  function registerFrame(role: Role, source: unknown, ready = false, loaded = true, replyTarget?: PluginFrameReplyTarget) {
    const slot = slots.get(roleKey(role));
    if (slot) {
      slot.replyTarget = role.kind === "child" ? replyTarget : undefined;
      slot.replySource = source;
    }
    const document = slot?.document;
    const confirmed = document?.documentNonce && document.source === source && current(document);
    if (confirmed && (!loaded || document.loadTicket)) {
      if (loaded) document.loadTicket = false;
    } else {
      invalidate(role);
      const slot = slots.get(roleKey(role));
      if (slot) slot.awaitingOpenAfterLoad = loaded;
      if (role.kind === "main") options.sources.setMain(source); else options.sources.registerChild(role.windowId, source, replyTarget);
    }
    const identity = options.sources.currentIdentityForHost(source);
    if (identity) bind(role, source, identity, ready, replyTarget);
    return identity;
  }
  function handleLifecycle(sender: Sender, data: Record<string, unknown>) {
    if (data.__atools_hosted_ipc_document__ !== true) return false;
    const slot = slots.get(roleKey(sender.identity)), document = slot?.document;
    if (!slot || !document || document.source !== sender.source || !current(document)
      || !options.sources.isCurrent(sender.source, sender.identity) || data.webContentsId !== slot.id
      || typeof data.documentNonce !== "string" || !/^[0-9a-f]{32}$/.test(data.documentNonce)) throw failure("invalid document handshake");
    if (data.phase === "close") {
      if (document.documentNonce === data.documentNonce) invalidate(slot.role);
    } else if (data.phase === "open") {
      if (document.documentNonce !== data.documentNonce) {
        cancelDocument(document);
        // Rotate legacy source identity at the FIFO runtime handshake, before preload calls.
        // Document-mode identities already have their own authenticated reservation.
        if (!isPluginDocumentIdentity(sender.identity)) {
          if (sender.identity.kind === "main") options.sources.setMain(sender.source);
          else options.sources.registerChild(sender.identity.windowId, sender.source, slot.replyTarget);
        }
        const identity = options.sources.currentIdentityForHost(sender.source);
        if (!identity || roleKey(identity) !== roleKey(sender.identity)) throw failure("document handshake lost its registered source");
        let resolveReady!: () => void;
        const readyPromise = new Promise<void>(resolve => { resolveReady = resolve; });
        slot.document = { source: sender.source, identity, documentNonce: data.documentNonce, loadTicket: !slot.awaitingOpenAfterLoad, ready: identity.kind === "main", readyPromise, resolveReady };
        slot.awaitingOpenAfterLoad = false;
        if (slot.document.ready) resolveReady();
        mergeReady(slot);
      }
    } else throw failure("invalid document lifecycle phase");
    return true;
  }
  function capture(sender: Sender, targetId: unknown, channel: unknown, args: unknown): Captured {
    if (!Number.isSafeInteger(targetId) || Number(targetId) <= 0) throw failure("target ID must be a positive safe integer");
    const senderSlot = slots.get(roleKey(sender.identity));
    const senderDocument = senderSlot?.document;
    const targetSlot = [...slots.values()].find(slot => slot.id === targetId);
    const targetDocument = targetSlot?.document;
    if (!senderDocument || senderDocument.source !== sender.source || !current(senderDocument)
      || !options.sources.isCurrent(sender.source, sender.identity)) throw failure("sender is not a current authenticated document");
    if (!senderDocument.documentNonce) throw failure("sender document handshake is incomplete");
    if (!targetDocument || !current(targetDocument) || !targetDocument.documentNonce) throw failure("target is not a current document in this panel");
    const message = normalizeHostedIpcMessage(channel, args);
    if (pending.size >= 32 || pendingBytes + message.bytes > 262_144) throw failure("pending message budget exceeded");
    let cancelled = false, settled = false, delivered = false;
    let rejectCancelled!: (reason: Error) => void;
    const cancellation = new Promise<never>((_, reject) => { rejectCancelled = reject; });
    void cancellation.catch(() => undefined);
    const entry = { sender: senderDocument, target: targetDocument, cancel: () => {
      if (settled) return;
      cancelled = true;
      rejectCancelled(failure("captured document was invalidated"));
      dispose();
    } };
    function dispose() {
      if (settled) return;
      settled = true;
      pending.delete(entry);
      pendingBytes -= message.bytes;
    }
    pending.add(entry);
    pendingBytes += message.bytes;
    function assertCurrent() {
      if (cancelled || !current(senderDocument!) || !current(targetDocument!)
        || senderSlot!.document !== senderDocument || targetSlot!.document !== targetDocument) throw failure("captured document is no longer current");
    }
    return { dispose, async deliver() {
      if (delivered || settled) throw failure("message cannot be replayed");
      delivered = true;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        assertCurrent();
        if (!targetDocument.ready) await Promise.race([targetDocument.readyPromise, cancellation,
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(failure("target readiness timed out")), options.timeoutMs ?? 3000); })]);
        assertCurrent();
        return await runPluginFrameOperation({ ...sender, sources: options.sources, operation: async () => {
          assertCurrent();
          if (!options.sources.reply(targetDocument.source, targetDocument.identity, {
            __atools_hosted_ipc__: true, channel: message.channel, args: message.args, senderId: senderSlot!.id,
            targetDocumentNonce: targetDocument.documentNonce,
          })) throw failure("delivery failed");
          return true;
        } });
      } finally { if (timeout !== undefined) clearTimeout(timeout); dispose(); }
    } };
  }
  /** Capture only the fixed menu-result event for the exact initiating document. */
  function captureContextMenuCommand(sender: Sender, id: unknown) {
    if (typeof id !== "string" || !id.trim() || id.length > 128) throw failure("invalid context menu command id");
    const slot = slots.get(roleKey(sender.identity));
    const document = slot?.document;
    if (!slot || !document || document.source !== sender.source || !current(document)
      || !options.sources.isCurrent(sender.source, sender.identity)) throw failure("caller is not a current hosted document");
    return capture(sender, slot.id, "context-menu-command", [id]);
  }
  function captureNative(method: string, args: Record<string, unknown>, sender: Sender, documentNonce?: unknown): Captured | undefined {
    const routing = method === "sendTo" || method === "sendToParent"
      || method === "browserWindowAction" && typeof args.action === "string" && args.action.trim() === "webContents.send";
    if (routing && (typeof documentNonce !== "string" || slots.get(roleKey(sender.identity))?.document?.documentNonce !== documentNonce)) throw failure("stale or missing sender document nonce");
    if (method === "sendTo") return capture(sender, args.targetId, args.channel, args.args);
    if (method === "browserWindowAction" && typeof args.action === "string" && args.action.trim() === "webContents.send") {
      const slot = slots.get("child:" + (typeof args.id === "string" ? args.id.trim() : ""));
      const values = Array.isArray(args.args) ? args.args : [];
      return capture(sender, slot?.id, values[0], values.slice(1));
    }
    if (method === "sendToParent") {
      if (sender.identity.kind !== "child") throw failure("sendToParent requires a child document");
      const creator = options.creatorFor(sender.identity.windowId);
      if (!creator || !options.sources.isCurrent(creator.source, creator.identity)) throw failure("parent document is no longer current");
      return capture(sender, slots.get(roleKey(creator.identity))?.id, args.channel, args.args);
    }
    return undefined;
  }
  return { reserve, hasReservation, bind, registerFrame, markReady, confirmReady, readinessFailureIsCurrent, invalidate, capture, captureContextMenuCommand, captureNative, captureDocumentLease, captureReadyDocumentLease, handleLifecycle,
    pendingReadyCount: () => [...slots.values()].filter(slot => slot.readyWaiter).length,
    clearChildren() { for (const slot of [...slots.values()]) if (slot.role.kind === "child") invalidate(slot.role, true); },
    clear() { for (const slot of [...slots.values()]) invalidate(slot.role, true); },
    stats: () => ({ frames: slots.size, pending: pending.size, pendingBytes }),
  };
}

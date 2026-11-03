export type PluginBroadcastChannelTransport = {
  post: (message: Record<string, unknown>) => unknown;
  accept: (event: MessageEvent) => boolean;
};

export type PluginBroadcastPayloadMeasure = (value: unknown) => number;

type BroadcastWindow = Window & typeof globalThis & {
  BroadcastChannel?: unknown;
  structuredClone?: <T>(value: T) => T;
};

/** Self-contained for compiler serialization; it only uses the authenticated frame transport. */
export function createPluginBroadcastChannelBridge(
  target: BroadcastWindow,
  transport: PluginBroadcastChannelTransport | undefined,
  measure: PluginBroadcastPayloadMeasure | undefined,
  documentNonce: string,
): { dispose: () => void } {
  const marker = "__atools_broadcast_channel__";
  const maxInstances = 32;
  const maxPendingMessages = 32;
  const maxPendingBytes = 8 * 1024 * 1024;
  const noop = () => {};
  const originalDescriptor = Object.getOwnPropertyDescriptor(target, "BroadcastChannel");
  const clone = target.structuredClone;
  if (!transport || typeof transport.post !== "function" || typeof transport.accept !== "function"
    || typeof measure !== "function" || typeof documentNonce !== "string" || !documentNonce
    || typeof target.EventTarget !== "function" || typeof target.MessageEvent !== "function"
    || typeof clone !== "function") return { dispose: noop };
  const activeTransport = transport;
  const measurePayload = measure;

  type ChannelState = {
    id: string;
    name: string;
    closed: boolean;
    onmessage: unknown;
    onmessageerror: unknown;
    messageListenerAdded: boolean;
    messageErrorListenerAdded: boolean;
    messageListener: EventListener | null;
    messageErrorListener: EventListener | null;
  };
  type PendingPost = { channelId: string; bytes: number };
  const states = new WeakMap<object, ChannelState>();
  const channels = new Map<string, PluginBroadcastChannel>();
  const pending = new Map<number, PendingPost>();
  const EventTargetConstructor = target.EventTarget;
  const MessageEventConstructor = target.MessageEvent;
  let sequence = 0;
  let channelSequence = 0;
  let pendingBytes = 0;
  let disposed = false;
  let installedDescriptor: PropertyDescriptor | undefined;
  let prefix = "";

  const random = new Uint8Array(16);
  try {
    if (typeof target.crypto?.getRandomValues === "function") target.crypto.getRandomValues(random);
    else for (let index = 0; index < random.length; index++) random[index] = Math.floor(Math.random() * 256);
  } catch {
    for (let index = 0; index < random.length; index++) random[index] = Math.floor(Math.random() * 256);
  }
  for (const byte of random) prefix += byte.toString(16).padStart(2, "0");

  function makeError(name: string, message: string, code?: string): Error {
    const fullMessage = code ? code + ": " + message : message;
    let error: Error;
    if (typeof target.DOMException === "function") error = new target.DOMException(fullMessage, name);
    else { error = new Error(fullMessage); error.name = name; }
    if (code) {
      try { Object.defineProperty(error, "atoolsCode", { value: code, configurable: true }); } catch { /* best effort */ }
    }
    return error;
  }
  function quotaError(message: string): Error {
    return makeError("QuotaExceededError", message, "ERR_ATOOLS_BROADCAST_BUDGET");
  }
  function stateFor(receiver: object): ChannelState {
    const state = states.get(receiver);
    if (!state) throw new target.TypeError("Illegal BroadcastChannel receiver");
    return state;
  }
  function cloneValue(value: unknown): unknown {
    return clone.call(target, value);
  }
  function postHost(message: Record<string, unknown>): boolean {
    if (disposed) return false;
    try { return activeTransport.post({ [marker]: true, documentNonce, ...message }) !== false; }
    catch { return false; }
  }
  function dispatchMessageError(channel: PluginBroadcastChannel) {
    try { channel.dispatchEvent(new MessageEventConstructor("messageerror", { origin: "" })); }
    catch { channel.dispatchEvent(new target.Event("messageerror")); }
  }
  function closeChannel(channel: PluginBroadcastChannel, sendLeave: boolean) {
    const state = stateFor(channel);
    if (state.closed) return;
    state.closed = true;
    channels.delete(state.id);
    if (sendLeave && !disposed) postHost({ op: "leave", channelId: state.id });
  }
  function markAllClosed() {
    for (const channel of channels.values()) {
      const state = states.get(channel);
      if (state) state.closed = true;
    }
    channels.clear();
    pending.clear();
    pendingBytes = 0;
  }

  class PluginBroadcastChannel extends EventTargetConstructor {
    constructor(name: unknown) {
      super();
      if (arguments.length < 1) throw new target.TypeError("BroadcastChannel requires a name");
      if (disposed) throw makeError("InvalidStateError", "BroadcastChannel document is disposed");
      if (channels.size >= maxInstances) throw quotaError("channel instance limit exceeded");
      let channelName: string;
      try { channelName = "" + name; }
      catch { throw new target.TypeError("BroadcastChannel name must be a DOMString"); }
      if (channelName.length > 128) throw makeError("SyntaxError", "BroadcastChannel name exceeds 128 UTF-16 code units");
      if (channelSequence >= Number.MAX_SAFE_INTEGER) throw quotaError("channel identifier limit exceeded");
      const id = prefix + ":" + String(++channelSequence);
      const state: ChannelState = {
        id, name: channelName, closed: false, onmessage: null, onmessageerror: null,
        messageListenerAdded: false, messageErrorListenerAdded: false,
        messageListener: null, messageErrorListener: null,
      };
      state.messageListener = event => {
        const current = state.onmessage;
        if (typeof current === "function") current.call(this, event as MessageEvent);
      };
      state.messageErrorListener = event => {
        const current = state.onmessageerror;
        if (typeof current === "function") current.call(this, event as MessageEvent);
      };
      states.set(this, state);
      channels.set(id, this);
      if (!postHost({ op: "join", channelId: id, name: channelName })) {
        state.closed = true;
        channels.delete(id);
        throw makeError("NetworkError", "BroadcastChannel join transport failed", "ERR_ATOOLS_BROADCAST_TRANSPORT");
      }
    }

    postMessage(value: unknown): void {
      if (arguments.length < 1) throw new target.TypeError("BroadcastChannel.postMessage requires a message");
      const state = stateFor(this);
      if (disposed || state.closed) throw makeError("InvalidStateError", "BroadcastChannel is closed");
      const bytes = measurePayload(value);
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw makeError("DataCloneError", "Invalid BroadcastChannel payload measurement");
      if (bytes > maxPendingBytes) throw quotaError("message exceeds per-document pending byte budget");
      if (pending.size >= maxPendingMessages || pendingBytes + bytes > maxPendingBytes)
        throw quotaError("pending message budget exceeded");
      // Clone before reserving any queue credit so subsequent plugin mutation cannot alter the send.
      const cloned = cloneValue(value);
      if (sequence >= Number.MAX_SAFE_INTEGER) throw quotaError("message sequence limit exceeded");
      const nextSequence = ++sequence;
      pending.set(nextSequence, { channelId: state.id, bytes });
      pendingBytes += bytes;
      const sent = postHost({ op: "post", channelId: state.id, sequence: nextSequence, data: cloned });
      if (!sent) {
        const reservation = pending.get(nextSequence);
        if (reservation) { pending.delete(nextSequence); pendingBytes -= reservation.bytes; }
        throw makeError("NetworkError", "BroadcastChannel transport post failed", "ERR_ATOOLS_BROADCAST_TRANSPORT");
      }
    }

    close(): void { closeChannel(this, true); }
  }
  Object.defineProperty(PluginBroadcastChannel, "name", { configurable: true, value: "BroadcastChannel" });

  function setHandler(receiver: object, type: "message" | "messageerror", value: unknown) {
    const channel = receiver as PluginBroadcastChannel;
    const state = stateFor(receiver);
    const key = type === "message" ? "onmessage" : "onmessageerror";
    const next = value === null || (typeof value !== "object" && typeof value !== "function") ? null : value;
    state[key] = next;
    const addedKey = type === "message" ? "messageListenerAdded" : "messageErrorListenerAdded";
    const listener = type === "message" ? state.messageListener : state.messageErrorListener;
    if (next === null) {
      if (state[addedKey] && listener) {
        channel.removeEventListener(type, listener);
        state[addedKey] = false;
      }
      return;
    }
    if (!state[addedKey] && listener) {
      channel.addEventListener(type, listener);
      state[addedKey] = true;
    }
  }
  Object.defineProperties(PluginBroadcastChannel.prototype, {
    name: {
      configurable: true, enumerable: true,
      get: function(this: object) { return stateFor(this).name; },
    },
    onmessage: {
      configurable: true, enumerable: true,
      get: function(this: object) { return stateFor(this).onmessage; },
      set: function(this: object, value: unknown) { setHandler(this, "message", value); },
    },
    onmessageerror: {
      configurable: true, enumerable: true,
      get: function(this: object) { return stateFor(this).onmessageerror; },
      set: function(this: object, value: unknown) { setHandler(this, "messageerror", value); },
    },
  });
  const SymbolConstructor = (target as unknown as { Symbol?: SymbolConstructor }).Symbol;
  if (SymbolConstructor?.toStringTag) {
    Object.defineProperty(PluginBroadcastChannel.prototype, SymbolConstructor.toStringTag, {
      configurable: true, value: "BroadcastChannel",
    });
  }

  function onMessage(event: MessageEvent) {
    if (disposed) return;
    try { if (!activeTransport.accept(event)) return; } catch { return; }
    const message = event.data as Record<string, unknown> | null;
    if (!message || typeof message !== "object" || Array.isArray(message) || message[marker] !== true
      || message.targetDocumentNonce !== documentNonce || typeof message.op !== "string") return;
    if (message.op === "accepted") {
      const number = message.sequence;
      if (!Number.isSafeInteger(number) || (number as number) <= 0 || typeof message.channelId !== "string") return;
      const reservation = pending.get(number as number);
      if (!reservation || reservation.channelId !== message.channelId) return;
      pending.delete(number as number);
      pendingBytes -= reservation.bytes;
      if (typeof message.error === "string") {
        const channel = channels.get(reservation.channelId);
        if (channel) dispatchMessageError(channel);
      }
      return;
    }
    if (message.op === "error") {
      if (typeof message.channelId !== "string") return;
      const channel = channels.get(message.channelId);
      if (!channel) return;
      closeChannel(channel, false);
      dispatchMessageError(channel);
      return;
    }
    if (message.op !== "message") return;
    const deliveryId = message.deliveryId;
    if (!Number.isSafeInteger(deliveryId) || (deliveryId as number) <= 0) return;
    try {
      if (!Array.isArray(message.recipients) || typeof message.name !== "string" || typeof message.origin !== "string"
        || !Object.prototype.hasOwnProperty.call(message, "data")) return;
      const seen = new Set<string>();
      for (const recipient of message.recipients) {
        if (typeof recipient !== "string" || seen.has(recipient)) continue;
        seen.add(recipient);
        const channel = channels.get(recipient);
        if (!channel) continue;
        const state = states.get(channel);
        if (!state || state.closed || state.name !== message.name) continue;
        try {
          const data = cloneValue(message.data);
          channel.dispatchEvent(new MessageEventConstructor("message", { data, origin: message.origin }));
        } catch { dispatchMessageError(channel); }
      }
    } finally {
      // The host reserved one delivery per destination document; acknowledge even when no local receiver survives.
      postHost({ op: "ack", deliveryId });
    }
  }

  function restoreConstructor() {
    const current = Object.getOwnPropertyDescriptor(target, "BroadcastChannel");
    if (!installedDescriptor || !current || current.value !== PluginBroadcastChannel
      || current.configurable !== installedDescriptor.configurable
      || current.enumerable !== installedDescriptor.enumerable || current.writable !== installedDescriptor.writable) return;
    try {
      if (originalDescriptor) Object.defineProperty(target, "BroadcastChannel", originalDescriptor);
      else delete (target as { BroadcastChannel?: unknown }).BroadcastChannel;
    } catch { /* A later host change must not break document teardown. */ }
  }

  try {
    Object.defineProperty(target, "BroadcastChannel", {
      configurable: originalDescriptor?.configurable ?? true,
      enumerable: originalDescriptor?.enumerable ?? false,
      writable: originalDescriptor?.writable ?? true,
      value: PluginBroadcastChannel,
    });
    installedDescriptor = Object.getOwnPropertyDescriptor(target, "BroadcastChannel");
    if (!installedDescriptor || installedDescriptor.value !== PluginBroadcastChannel) throw new Error("constructor install failed");
    target.addEventListener("message", onMessage);
    target.addEventListener("pagehide", dispose);
    target.addEventListener("atools-plugin-out", dispose);
  } catch {
    restoreConstructor();
    return { dispose: noop };
  }

  function dispose() {
    if (disposed) return;
    postHost({ op: "dispose" });
    disposed = true;
    target.removeEventListener("message", onMessage);
    target.removeEventListener("pagehide", dispose);
    target.removeEventListener("atools-plugin-out", dispose);
    markAllClosed();
    restoreConstructor();
  }

  return { dispose };
}

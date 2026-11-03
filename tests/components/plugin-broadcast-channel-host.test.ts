import { describe, expect, it, vi } from "vitest";
import { PluginFrameSourceRegistry, pluginDocumentEnvelope, type PluginFrameIdentity } from "../../src/lib/pluginFrameDocumentIdentity";
import { createPluginBroadcastChannelHost } from "../../src/lib/pluginBroadcastChannelHost";
import { createPluginHostedIpcRouter } from "../../src/lib/pluginHostedIpcRouter";

const FLAG = "__atools_broadcast_channel__";
const nonce = (digit: string) => digit.repeat(32);
type Frame = { id: string; source: object; identity: PluginFrameIdentity; nonce: string; sent: Array<Record<string, unknown>> };

function harness(clone?: (value: unknown) => unknown, shouldPost?: (source: unknown, message: Record<string, unknown>) => boolean) {
  const sources = new PluginFrameSourceRegistry();
  const frames = new Map<object, Frame>();
  let activePlugin = "harris-snipaste";
  const host = createPluginBroadcastChannelHost({
    sources, pluginId: () => activePlugin, clone,
    post(source, message, identity) {
      const frame = frames.get(source as object);
      if (!frame || !sources.isCurrent(source, identity)) return false;
      const envelope = message as Record<string, unknown>;
      if (shouldPost && !shouldPost(source, envelope)) return false;
      frame.sent.push(envelope);
      return true;
    },
    captureDocumentLease(sender, documentNonce) {
      const frame = frames.get(sender.source as object);
      if (!frame || frame.nonce !== documentNonce || !sources.isCurrent(sender.source, sender.identity)) throw new Error("stale document");
      const capturedNonce = documentNonce;
      return { assertCurrent() {
        if (frames.get(sender.source as object) !== frame || frame.nonce !== capturedNonce
          || !sources.isCurrent(sender.source, sender.identity)) throw new Error("stale document lease");
      } };
    },
  });
  function frame(id: string, digit: string) {
    const source = { id };
    sources.registerChild(id, source);
    const identity = sources.currentIdentityForHost(source)!;
    const result: Frame = { id, source, identity, nonce: nonce(digit), sent: [] };
    frames.set(source, result);
    return result;
  }
  function replace(previous: Frame, digit: string) {
    const source = { id: previous.id, replacement: true };
    sources.registerChild(previous.id, source);
    const identity = sources.currentIdentityForHost(source)!;
    const next: Frame = { id: previous.id, source, identity, nonce: nonce(digit), sent: [] };
    frames.set(source, next);
    return next;
  }
  function send(frame: Frame, op: string, fields: Record<string, unknown> = {}, documentNonce = frame.nonce) {
    return host.dispatch(frame.source, frame.identity, { [FLAG]: true, op, documentNonce, ...fields }, "null");
  }
  function join(frame: Frame, channelId: string, name = "room") {
    send(frame, "join", { channelId, name });
  }
  return { host, frames, frame, replace, send, join, sources, setPlugin: (id: string) => { activePlugin = id; } };
}

describe("hosted BroadcastChannel broker", () => {
  it("requires a current source and document nonce, and ignores old identities after source replacement", () => {
    const h = harness();
    const old = h.frame("child-a", "a");
    const fake = { id: "not-registered" };
    expect(h.host.dispatch(fake, old.identity, { [FLAG]: true, op: "join", documentNonce: old.nonce,
      channelId: `${"a".repeat(32)}:1`, name: "room" }, "null")).toBe(true);
    expect(h.send(old, "join", { channelId: `${"a".repeat(32)}:1`, name: "room" }, nonce("b"))).toBe(true);
    expect(h.host.diagnostics()).toEqual({ documents: 0, instances: 0, deliveries: 0, outstandingBytes: 0 });

    h.join(old, `${"a".repeat(32)}:1`);
    expect(h.host.diagnostics().instances).toBe(1);
    const next = h.replace(old, "c");
    expect(h.host.diagnostics()).toEqual({ documents: 0, instances: 0, deliveries: 0, outstandingBytes: 0 });
    h.send(old, "dispose");
    expect(h.host.diagnostics().documents).toBe(0);
    h.join(next, `${"c".repeat(32)}:1`);
    expect(h.host.diagnostics()).toEqual({ documents: 1, instances: 1, deliveries: 0, outstandingBytes: 0 });

    const before = h.host.diagnostics();
    expect(() => h.send(next, "not an op", { op: { toString: null } as unknown as string })).not.toThrow();
    expect(h.host.diagnostics()).toEqual(before);
  });

  it("accepts only the standard authenticated document envelope through join, post, and ACK", () => {
    const sources = new PluginFrameSourceRegistry();
    const ipc = createPluginHostedIpcRouter({ sources, creatorFor: () => undefined });
    type Posted = { message: Record<string, unknown>; targetOrigin: string };
    function document(role: { kind: "main" } | { kind: "child"; windowId: string }, name: string, generation: string) {
      const posted: Posted[] = [];
      const source = { postMessage(message: unknown, targetOrigin: string) { posted.push({ message: message as Record<string, unknown>, targetOrigin }); } };
      const reservation = sources.reserveDocument({ ...role, source, pageDocumentId: `page-${name}`,
        expectedOrigin: "https://plugin.example", parentOrigin: "https://app.example" });
      const identity = sources.activateDocument(reservation, generation.repeat(32))!;
      const webContentsId = ipc.reserve(role);
      ipc.bind(role, source, identity, false);
      expect(ipc.handleLifecycle({ source, identity }, { __atools_hosted_ipc_document__: true,
        webContentsId, documentNonce: generation.repeat(32), phase: "open" })).toBe(true);
      return { source, identity, nonce: generation.repeat(32), posted };
    }
    const sender = document({ kind: "main" }, "sender", "a");
    const receiver = document({ kind: "child", windowId: "native-window" }, "receiver", "b");
    const host = createPluginBroadcastChannelHost({ sources, pluginId: () => "harris-snipaste",
      captureDocumentLease: (sender, nonce) => ipc.captureDocumentLease(sender, nonce),
      post: (source, message, identity) => sources.reply(source, identity, message) });
    const dispatch = (frame: typeof sender, message: Record<string, unknown>) => host.dispatch(frame.source, frame.identity,
      { [FLAG]: true, documentNonce: frame.nonce, ...message, __atoolsDocument: pluginDocumentEnvelope(frame.identity as Extract<PluginFrameIdentity, { mode: "document" }>) },
      "https://plugin.example");
    const senderChannel = `${"a".repeat(32)}:1`, receiverChannel = `${"b".repeat(32)}:1`;
    dispatch(sender, { op: "join", channelId: senderChannel, name: "document-room" });
    dispatch(receiver, { op: "join", channelId: receiverChannel, name: "document-room" });
    dispatch(sender, { op: "post", channelId: senderChannel, sequence: 1, data: { value: new Map([["binary", new Uint8Array([4, 5])]]) } });

    const deliveryPost = receiver.posted.find(value => value.message.op === "message")!;
    const delivery = deliveryPost.message;
    expect(deliveryPost.targetOrigin).toBe("https://plugin.example");
    expect(delivery.targetDocumentNonce).toBe(receiver.nonce);
    expect(delivery.__atoolsDocument).toEqual(pluginDocumentEnvelope(receiver.identity as Extract<PluginFrameIdentity, { mode: "document" }>));
    expect(host.diagnostics().deliveries).toBe(1);
    dispatch(receiver, { op: "ack", deliveryId: delivery.deliveryId });
    expect(host.diagnostics().deliveries).toBe(0);

    const forged = { ...pluginDocumentEnvelope(receiver.identity as Extract<PluginFrameIdentity, { mode: "document" }>), docNonce: nonce("f") };
    host.dispatch(receiver.source, receiver.identity, { [FLAG]: true, op: "join", documentNonce: receiver.nonce,
      channelId: `${"b".repeat(32)}:2`, name: "forged", __atoolsDocument: forged }, "https://plugin.example");
    expect(receiver.posted.some(value => value.message.op === "error" && value.message.channelId === `${"b".repeat(32)}:2`)).toBe(false);
    expect(host.diagnostics().instances).toBe(2);
    host.close();
    ipc.clear();
  });

  it("keeps document metadata across leave/dispose, sequences per bridge, and excludes only the exact same-document sender", () => {
    const h = harness();
    const sender = h.frame("sender", "a"), otherDoc = h.frame("other", "b");
    const prefix = "a".repeat(32), collision = `${prefix}:1`;
    h.join(sender, collision);
    h.join(sender, `${prefix}:2`);
    // Channel IDs are scoped by document and are not authority; a different doc may collide.
    h.join(otherDoc, collision);

    h.send(sender, "post", { channelId: collision, sequence: 1, data: new Map([["k", new Uint8Array([1, 2])]]) });
    const senderReply = sender.sent.find(value => value.op === "accepted");
    const sameDocDelivery = sender.sent.find(value => value.op === "message");
    const crossDocDelivery = otherDoc.sent.find(value => value.op === "message");
    expect(senderReply?.targetDocumentNonce).toBe(sender.nonce);
    expect(sameDocDelivery?.recipients).toEqual([`${prefix}:2`]);
    expect(crossDocDelivery?.recipients).toEqual([collision]);
    expect(crossDocDelivery?.targetDocumentNonce).toBe(otherDoc.nonce);
    const binary = (crossDocDelivery?.data as Map<string, Uint8Array>).get("k");
    expect(ArrayBuffer.isView(binary)).toBe(true);
    expect(Array.from(binary ?? [])).toEqual([1, 2]);

    h.send(sender, "post", { channelId: `${prefix}:2`, sequence: 1, data: "replay across channel" });
    expect(sender.sent.filter(value => value.op === "accepted").at(-1)?.error).toBe("ERR_ATOOLS_BROADCAST_REPLAY");
    h.send(sender, "post", { channelId: `${prefix}:2`, sequence: 2, data: "next" });
    expect(sender.sent.filter(value => value.op === "message").length).toBe(2);

    h.send(sender, "leave", { channelId: `${prefix}:1` });
    h.send(sender, "dispose");
    expect(h.host.diagnostics().documents).toBe(2);
    expect(h.host.diagnostics().instances).toBe(1);
    // Same live bridge cannot reset the counter/prefix by disposing all channels.
    h.join(sender, `${prefix}:1`);
    expect(sender.sent.at(-1)?.error).toBe("ERR_ATOOLS_BROADCAST_REPLAY");
  });

  it("does not let an old nonce or stale delivery ACK release a replacement document's credit", () => {
    const h = harness();
    const sender = h.frame("sender", "a"), receiver = h.frame("receiver", "b");
    h.join(sender, `${"a".repeat(32)}:1`);
    h.join(receiver, `${"b".repeat(32)}:1`);
    h.send(sender, "post", { channelId: `${"a".repeat(32)}:1`, sequence: 1, data: "old" });
    const oldDelivery = receiver.sent.find(value => value.op === "message")!.deliveryId as number;
    expect(h.host.diagnostics().deliveries).toBe(1);

    receiver.nonce = nonce("c");
    h.join(receiver, `${"c".repeat(32)}:1`);
    expect(h.host.diagnostics().deliveries).toBe(0);
    h.send(sender, "post", { channelId: `${"a".repeat(32)}:1`, sequence: 2, data: "new" });
    const newDelivery = receiver.sent.filter(value => value.op === "message").at(-1)!.deliveryId as number;
    expect(newDelivery).not.toBe(oldDelivery);

    h.send(receiver, "ack", { deliveryId: oldDelivery }, nonce("b"));
    expect(h.host.diagnostics().deliveries).toBe(1);
    h.send(receiver, "ack", { deliveryId: oldDelivery });
    expect(h.host.diagnostics().deliveries).toBe(1);
    h.send(receiver, "ack", { deliveryId: newDelivery });
    expect(h.host.diagnostics()).toEqual({ documents: 2, instances: 2, deliveries: 0, outstandingBytes: 0 });
  });

  it("surfaces structured-clone validation failures as a safe per-channel error", () => {
    const h = harness();
    const source = h.frame("sender", "a");
    h.join(source, `${"a".repeat(32)}:1`);
    h.send(source, "post", { channelId: `${"a".repeat(32)}:1`, sequence: 1, data: () => "not cloneable" });
    const reply = source.sent.at(-1);
    expect(reply?.op).toBe("accepted");
    expect(reply?.error).toBe("ERR_ATOOLS_BROADCAST_DATA_CLONE");
    expect(reply?.targetDocumentNonce).toBe(source.nonce);
  });

  it("preflights global and per-document budgets before fanout or clone", () => {
    const clone = vi.fn((value: unknown) => structuredClone(value));
    const global = harness(clone);
    const sender = global.frame("sender", "a");
    global.join(sender, `${"a".repeat(32)}:1`);
    const receivers = Array.from({ length: 5 }, (_, index) => {
      const receiver = global.frame(`receiver-${index}`, String(index + 1));
      global.join(receiver, `${String(index + 1).repeat(32)}:1`);
      return receiver;
    });
    clone.mockClear();
    global.send(sender, "post", { channelId: `${"a".repeat(32)}:1`, sequence: 1, data: new Uint8Array(3_500_000) });
    expect(clone).not.toHaveBeenCalled();
    expect(receivers.every(receiver => !receiver.sent.some(value => value.op === "message"))).toBe(true);
    expect(sender.sent.at(-1)?.error).toBe("ERR_ATOOLS_BROADCAST_BUDGET");
    expect(global.host.diagnostics().deliveries).toBe(0);

    const perDocument = harness();
    const source = perDocument.frame("sender", "a"), destination = perDocument.frame("receiver", "b");
    perDocument.join(source, `${"a".repeat(32)}:1`);
    perDocument.join(destination, `${"b".repeat(32)}:1`);
    for (let sequence = 1; sequence <= 3; sequence++) {
      perDocument.send(source, "post", { channelId: `${"a".repeat(32)}:1`, sequence, data: new Uint8Array(2_850_000) });
    }
    expect(destination.sent.filter(value => value.op === "message")).toHaveLength(2);
    expect(source.sent.filter(value => value.op === "accepted").at(-1)?.error).toBe("ERR_ATOOLS_BROADCAST_BUDGET");
    expect(perDocument.host.diagnostics().deliveries).toBe(2);
  });

  it("enforces per-document delivery-count credits and reopens one slot after ACK", () => {
    const h = harness();
    const sender = h.frame("sender", "a"), receiver = h.frame("receiver", "b");
    h.join(sender, `${"a".repeat(32)}:1`);
    h.join(receiver, `${"b".repeat(32)}:1`);
    for (let sequence = 1; sequence <= 32; sequence++) {
      h.send(sender, "post", { channelId: `${"a".repeat(32)}:1`, sequence, data: sequence });
    }
    h.send(sender, "post", { channelId: `${"a".repeat(32)}:1`, sequence: 33, data: 33 });
    expect(receiver.sent.filter(value => value.op === "message")).toHaveLength(32);
    expect(sender.sent.filter(value => value.op === "accepted").at(-1)?.error).toBe("ERR_ATOOLS_BROADCAST_BUDGET");
    expect(h.host.diagnostics().deliveries).toBe(32);

    const firstDelivery = receiver.sent.find(value => value.op === "message")!.deliveryId as number;
    h.send(receiver, "ack", { deliveryId: firstDelivery });
    h.send(sender, "post", { channelId: `${"a".repeat(32)}:1`, sequence: 34, data: 34 });
    expect(receiver.sent.filter(value => value.op === "message")).toHaveLength(33);
    expect(h.host.diagnostics().deliveries).toBe(32);
  });

  it("enforces the global delivery-count cap before sending to any destination", () => {
    const h = harness();
    const sender = h.frame("sender", "a");
    h.join(sender, `${"a".repeat(32)}:1`);
    const receivers = Array.from({ length: 5 }, (_, index) => {
      const receiver = h.frame(`receiver-${index}`, String(index + 1));
      h.join(receiver, `${String(index + 1).repeat(32)}:1`);
      return receiver;
    });
    for (let sequence = 1; sequence <= 25; sequence++) {
      h.send(sender, "post", { channelId: `${"a".repeat(32)}:1`, sequence, data: sequence });
    }
    expect(h.host.diagnostics().deliveries).toBe(125);
    expect(receivers.every(receiver => receiver.sent.filter(value => value.op === "message").length === 25)).toBe(true);
    h.send(sender, "post", { channelId: `${"a".repeat(32)}:1`, sequence: 26, data: 26 });
    expect(h.host.diagnostics().deliveries).toBe(125);
    expect(receivers.every(receiver => receiver.sent.filter(value => value.op === "message").length === 25)).toBe(true);
    expect(sender.sent.filter(value => value.op === "accepted").at(-1)?.error).toBe("ERR_ATOOLS_BROADCAST_BUDGET");
  });

  it("enforces per-document and global live-instance caps", () => {
    const h = harness();
    const frames = Array.from({ length: 9 }, (_, index) => h.frame(`frame-${index}`, String(index + 1)));
    const ids = (index: number) => `${String(index + 1).repeat(32)}:`;
    for (let counter = 1; counter <= 32; counter++) h.join(frames[0], `${ids(0)}${counter}`);
    h.join(frames[0], `${ids(0)}33`);
    expect(frames[0].sent.at(-1)?.error).toBe("ERR_ATOOLS_BROADCAST_LIMIT");
    expect(h.host.diagnostics().instances).toBe(32);

    for (let frameIndex = 1; frameIndex < 8; frameIndex++) {
      for (let counter = 1; counter <= 32; counter++) h.join(frames[frameIndex], `${ids(frameIndex)}${counter}`);
    }
    expect(h.host.diagnostics().instances).toBe(256);
    h.join(frames[8], `${ids(8)}1`);
    expect(frames[8].sent.at(-1)?.error).toBe("ERR_ATOOLS_BROADCAST_LIMIT");
    expect(h.host.diagnostics().instances).toBe(256);
  });

  it("releases reservations when a destination post or the structured clone fails", () => {
    const postFailure = harness(undefined, (_source, message) => message.op !== "message");
    const sender = postFailure.frame("sender", "a"), receiver = postFailure.frame("receiver", "b");
    postFailure.join(sender, `${"a".repeat(32)}:1`);
    postFailure.join(receiver, `${"b".repeat(32)}:1`);
    postFailure.send(sender, "post", { channelId: `${"a".repeat(32)}:1`, sequence: 1, data: "payload" });
    expect(sender.sent.at(-1)?.error).toBe("ERR_ATOOLS_BROADCAST_DELIVERY");
    expect(postFailure.host.diagnostics().deliveries).toBe(0);
    expect(postFailure.host.diagnostics().outstandingBytes).toBe(0);

    const cloneFailure = harness(() => { throw new DOMException("blocked", "DataCloneError"); });
    const cloneSender = cloneFailure.frame("sender", "c"), cloneReceiver = cloneFailure.frame("receiver", "d");
    cloneFailure.join(cloneSender, `${"c".repeat(32)}:1`);
    cloneFailure.join(cloneReceiver, `${"d".repeat(32)}:1`);
    cloneFailure.send(cloneSender, "post", { channelId: `${"c".repeat(32)}:1`, sequence: 1, data: "cloneable" });
    expect(cloneSender.sent.at(-1)?.error).toBe("ERR_ATOOLS_BROADCAST_DATA_CLONE");
    expect(cloneFailure.host.diagnostics().deliveries).toBe(0);
    expect(cloneFailure.host.diagnostics().outstandingBytes).toBe(0);
  });

  it("releases receiver credits only for its exact authenticated ACK and prunes on plugin/source invalidation", () => {
    const h = harness();
    const sender = h.frame("sender", "a"), receiver = h.frame("receiver", "b");
    h.join(sender, `${"a".repeat(32)}:1`);
    h.join(receiver, `${"b".repeat(32)}:1`);
    h.send(sender, "post", { channelId: `${"a".repeat(32)}:1`, sequence: 1, data: "payload" });
    const deliveryId = receiver.sent.find(value => value.op === "message")!.deliveryId as number;
    h.host.dispatch(sender.source, sender.identity, { [FLAG]: true, op: "ack", documentNonce: sender.nonce, deliveryId }, "null");
    expect(h.host.diagnostics().deliveries).toBe(1);
    h.sources.unregisterChild("receiver", receiver.source);
    expect(h.host.diagnostics()).toEqual({ documents: 1, instances: 1, deliveries: 0, outstandingBytes: 0 });

    h.setPlugin("another-plugin");
    h.host.prune();
    expect(h.host.diagnostics()).toEqual({ documents: 0, instances: 0, deliveries: 0, outstandingBytes: 0 });
    h.host.close();
    expect(h.host.diagnostics()).toEqual({ documents: 0, instances: 0, deliveries: 0, outstandingBytes: 0 });
  });
});

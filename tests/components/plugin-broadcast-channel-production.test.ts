import { describe, expect, it } from "vitest";
import { createPluginBroadcastChannelProductionFixture, snipasteFixtureAction } from "./pluginBroadcastChannelProductionFixture";

const MAIN_HTML = "<!doctype html><html><head><title>main fixture</title></head><body><main id='root'>main</main></body></html>";
const CHILD_HTML = "<!doctype html><html><head><title>native child</title></head><body><main>child</main></body></html>";
const name = "snipaste-pro-bus";

function openChannel(frame: { window: Window & typeof globalThis }, channelName = name) {
  const BroadcastChannelCtor = frame.window.BroadcastChannel as unknown as new (channel: string) => BroadcastChannel;
  return new BroadcastChannelCtor(channelName);
}

function documentEnvelope(frame: { pageDocumentId: string; bootstrapNonce: string; identity: { generation: number } }) {
  return { pageDocumentId: frame.pageDocumentId, docNonce: frame.bootstrapNonce, generation: frame.identity.generation };
}

function expectDocumentEnvelope(frame: { pageDocumentId: string; bootstrapNonce: string; hostedNonce?: string; identity: { generation: number } },
  entries: Array<{ data: Record<string, unknown> }>, op: string) {
  const matching = entries.filter(entry => entry.data.op === op && entry.data.documentNonce === frame.hostedNonce);
  expect(matching.length).toBeGreaterThan(0);
  for (const entry of matching) expect(entry.data.__atoolsDocument).toEqual(documentEnvelope(frame));
}

describe("production serialized BroadcastChannel chain", () => {
  it("routes structured-clone values through current main/native documents, preserves order, and excludes only the exact sender", async () => {
    const fixture = createPluginBroadcastChannelProductionFixture();
    try {
      const main = fixture.createDocument({ role: { kind: "main" }, html: MAIN_HTML, url: "https://snipaste-fixture.invalid/index.html" });
      const child = fixture.createDocument({ role: { kind: "child", windowId: "native-child-1" }, html: CHILD_HTML,
        url: "https://snipaste-fixture.invalid/paster.html?id=1&windowRole=child", hostKind: "native" });
      await fixture.flush();

      expect(main.hostedNonce).toMatch(/^[0-9a-f]{32}$/);
      expect(child.hostedNonce).toMatch(/^[0-9a-f]{32}$/);
      expect(fixture.observedLifecycle.filter(item => item.phase === "open")).toHaveLength(2);

      const sender = openChannel(main), sameDocumentReceiver = openChannel(main), nativeReceiver = openChannel(child);
      const sameDocumentEvents: unknown[] = [], childEvents: Array<{ data: any; origin: string }> = [], senderEvents: unknown[] = [];
      sender.onmessage = event => senderEvents.push(event.data);
      sameDocumentReceiver.onmessage = event => sameDocumentEvents.push(event.data);
      nativeReceiver.onmessage = event => childEvents.push({ data: event.data, origin: event.origin });
      await fixture.flush();
      expect(fixture.broker.diagnostics()).toEqual({ documents: 2, instances: 3, deliveries: 0, outstandingBytes: 0 });

      const cyclic: Record<string, any> = {
        date: new Date("2026-10-23T08:00:00.000Z"),
        map: new Map([["key", { value: 7 }]]),
        set: new Set(["alpha", 12]),
        bytes: new Uint8Array([3, 5, 8]),
        buffer: new Uint16Array([13, 21]).buffer,
      };
      cyclic.self = cyclic;
      sender.postMessage(cyclic);
      sender.postMessage({ order: 2 });
      await fixture.flush();

      expect(senderEvents).toEqual([]);
      expect(sameDocumentEvents).toHaveLength(2);
      expect(childEvents).toHaveLength(2);
      expect(childEvents.map(item => item.data.order ?? 1)).toEqual([1, 2]);
      expect(childEvents[0].origin).toBe("https://snipaste-fixture.invalid");
      const siblingCopy = sameDocumentEvents[0] as any;
      const childCopy = childEvents[0].data;
      expect(siblingCopy.self).toBe(siblingCopy);
      expect(childCopy.self).toBe(childCopy);
      expect(siblingCopy.date).toEqual(new Date("2026-10-23T08:00:00.000Z"));
      expect(siblingCopy.map).toBeInstanceOf(Map);
      expect(siblingCopy.set).toBeInstanceOf(Set);
      expect(Array.from(siblingCopy.bytes)).toEqual([3, 5, 8]);
      expect(Array.from(new Uint16Array(siblingCopy.buffer))).toEqual([13, 21]);
      expect(childEvents.map(item => item.origin)).toEqual(["https://snipaste-fixture.invalid", "https://snipaste-fixture.invalid"]);

      // The authenticated main document uses the real document envelope for all
      // ingress, including the ACK generated when its same-document peer receives.
      expectDocumentEnvelope(main, fixture.observedBroadcastIngress.filter(item => item.source === main.source), "join");
      expectDocumentEnvelope(main, fixture.observedBroadcastIngress.filter(item => item.source === main.source), "post");
      expectDocumentEnvelope(main, fixture.observedBroadcastIngress.filter(item => item.source === main.source), "ack");
      expect(fixture.observedBroadcastIngress.some(item => item.source === child.source
        && item.origin === "null" && !Object.prototype.hasOwnProperty.call(item.data, "__atoolsDocument"))).toBe(true);

      siblingCopy.map.get("key").value = 999;
      siblingCopy.bytes[0] = 99;
      expect(childCopy.map.get("key").value).toBe(7);
      expect(Array.from(childCopy.bytes)).toEqual([3, 5, 8]);
      expect(fixture.broker.diagnostics()).toEqual({ documents: 2, instances: 3, deliveries: 0, outstandingBytes: 0 });

      sender.close();
      sameDocumentReceiver.close();
      nativeReceiver.close();
      await fixture.flush();
    } finally { fixture.close(); }
  });

  it("authenticates document-mode provenance and hosted nonce through the ordered router, including same-WindowProxy replacement", async () => {
    const fixture = createPluginBroadcastChannelProductionFixture();
    try {
      const old = fixture.createDocument({ role: { kind: "main" }, html: MAIN_HTML,
        url: "https://snipaste-fixture.invalid/index.html", documentMode: true });
      await fixture.flush();
      const oldNonce = old.hostedNonce;
      expect(oldNonce).toMatch(/^[0-9a-f]{32}$/);

      const oldChannel = openChannel(old, "replacement-room");
      await fixture.flush();
      expect(fixture.broker.diagnostics().instances).toBe(1);

      const current = fixture.createDocument({ role: old.role, html: MAIN_HTML,
        url: "https://snipaste-fixture.invalid/index.html", documentMode: true });
      await fixture.flush();
      expect(current.source).toBe(old.source);
      expect(current.bootstrapNonce).not.toBe(old.bootstrapNonce);
      expect(current.hostedNonce).toMatch(/^[0-9a-f]{32}$/);
      expect(current.hostedNonce).not.toBe(oldNonce);
      expect(fixture.broker.diagnostics()).toEqual({ documents: 0, instances: 0, deliveries: 0, outstandingBytes: 0 });

      const currentChannel = openChannel(current, "replacement-room");
      const received: unknown[] = [];
      currentChannel.onmessage = event => received.push(event.data);
      await fixture.flush();
      const id = "c".repeat(32) + ":1";
      const common = { __atools_broadcast_channel__: true, op: "join", documentNonce: current.hostedNonce,
        channelId: id, name: "forged-room" };

      fixture.spoofFrom(current, { ...common, __atoolsDocument: { ...documentEnvelope(current), docNonce: "f".repeat(32) } });
      fixture.spoofFrom(current, { ...common, documentNonce: oldNonce, __atoolsDocument: documentEnvelope(current) });
      oldChannel.postMessage("old document cannot join successor");
      await fixture.flush();
      expect(fixture.broker.diagnostics()).toEqual({ documents: 1, instances: 1, deliveries: 0, outstandingBytes: 0 });
      expect(received).toEqual([]);
      const currentIngress = fixture.observedBroadcastIngress.filter(item => item.source === current.source);
      expect(currentIngress.some(item => item.data.op === "join" && item.data.name === "forged-room"
        && item.data.documentNonce === oldNonce)).toBe(true); // Router authenticated identity; host rejected stale hosted lease.
      expect(currentIngress.some(item => item.data.op === "join" && item.data.name === "forged-room"
        && (item.data.__atoolsDocument as { docNonce?: unknown } | undefined)?.docNonce === "f".repeat(32))).toBe(false);

      currentChannel.postMessage({ ok: true });
      await fixture.flush();
      expect(fixture.broker.diagnostics()).toEqual({ documents: 1, instances: 1, deliveries: 0, outstandingBytes: 0 });
      expectDocumentEnvelope(current, fixture.observedBroadcastIngress.filter(item => item.source === current.source), "join");
      expectDocumentEnvelope(current, fixture.observedBroadcastIngress.filter(item => item.source === current.source), "post");

      fixture.spoofFrom(current, { ...common, channelId: "d".repeat(32) + ":2" }, "https://attacker.invalid");
      expect(fixture.broker.diagnostics().instances).toBe(1);

      fixture.spoofFromSource({ postMessage() {} }, { ...common, channelId: "e".repeat(32) + ":1",
        __atoolsDocument: documentEnvelope(current) });
      expect(fixture.broker.diagnostics()).toEqual({ documents: 1, instances: 1, deliveries: 0, outstandingBytes: 0 });
      expect(currentIngress.some(item => item.data.channelId === "e".repeat(32) + ":1")).toBe(false);
    } finally { fixture.close(); }
  });
});

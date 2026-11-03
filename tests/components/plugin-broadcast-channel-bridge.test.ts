import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { createPluginBroadcastChannelBridge } from "../../src/lib/pluginBroadcastChannelBridge";
import { measurePluginBroadcastPayload } from "../../src/lib/pluginBroadcastPayload";
import { createPluginBridgeDocument } from "../../src/lib/pluginPanelBridgeCompiler";

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function makeFixture() {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "https://plugin.example/", runScripts: "outside-only",
  });
  const target = dom.window as unknown as Window & {
    structuredClone: typeof structuredClone;
    BroadcastChannel?: unknown;
    __ATOOLS_FRAME_TRANSPORT__?: { post: (message: Record<string, unknown>) => boolean; accept: (event: MessageEvent) => boolean };
  };
  target.structuredClone = structuredClone;
  const posted: Record<string, unknown>[] = [];
  const documentNonce = "document-nonce-fixture";
  let accepts = true, postWorks = true;
  const transport = {
    post: vi.fn((message: Record<string, unknown>) => { posted.push(message); return postWorks; }),
    accept: vi.fn((event: MessageEvent) => accepts && event.source === target.parent),
  };
  target.__ATOOLS_FRAME_TRANSPORT__ = transport;
  const bridge = createPluginBroadcastChannelBridge(target, transport, value => JSON.stringify(value).length, documentNonce);
  function receive(data: Record<string, unknown>, source: MessageEventSource | null = target.parent) {
    target.dispatchEvent(new target.MessageEvent("message", { data: { targetDocumentNonce: documentNonce, ...data }, source, origin: "https://host.example" }));
  }
  return {
    dom, target, bridge, transport, posted, receive, documentNonce,
    setAccept(value: boolean) { accepts = value; },
    setPostWorks(value: boolean) { postWorks = value; },
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("plugin BroadcastChannel bridge", () => {
  it("requires new and a name, exposes a readonly DOMString name and EventTarget handlers", () => {
    const f = makeFixture();
    try {
      const Channel = f.target.BroadcastChannel as new (name: string) => BroadcastChannel;
      let callWithoutNewError: unknown;
      try { (Channel as unknown as (name: string) => BroadcastChannel)("x"); }
      catch (error) { callWithoutNewError = error; }
      expect(callWithoutNewError).toMatchObject({ name: "TypeError" });
      expect(() => new (Channel as unknown as new () => BroadcastChannel)()).toThrow(f.target.TypeError);
      const channel = new (Channel as new (name: string, ...extra: unknown[]) => BroadcastChannel)(
        "fixture", "ignored extra constructor argument",
      );
      expect(channel.name).toBe("fixture");
      expect(channel).toBeInstanceOf(f.target.EventTarget);
      expect(Object.prototype.toString.call(channel)).toBe("[object BroadcastChannel]");
      expect((Channel as unknown as { name: string }).name).toBe("BroadcastChannel");
      expect(Object.getOwnPropertyDescriptor(channel, "name")).toBeUndefined();
      const nameDescriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(channel), "name")!;
      expect(nameDescriptor).toMatchObject({ configurable: true, enumerable: true, set: undefined });
      expect(typeof nameDescriptor.get).toBe("function");
      expect(() => nameDescriptor.get!.call({})).toThrow(expect.objectContaining({ name: "TypeError" }));
      expect(() => { (channel as unknown as { name: string }).name = "changed"; }).toThrow(TypeError);
      const Derived = class DerivedBroadcastChannel extends Channel {};
      const derived = new Derived("derived");
      expect(derived.name).toBe("derived");
      const buffer = new ArrayBuffer(8);
      (channel.postMessage as unknown as (...args: unknown[]) => void)(buffer, [buffer]);
      expect(buffer.byteLength).toBe(8);
      expect((f.posted.at(-1)?.data as ArrayBuffer).byteLength).toBe(8);
      expect(f.posted[0]).toMatchObject({ __atools_broadcast_channel__: true, op: "join", name: "fixture", documentNonce: f.documentNonce });
      channel.close();
      derived.close();
    } finally { f.bridge.dispose(); f.dom.window.close(); }
  });

  it("clones outgoing data, enforces pending count/byte budgets, and releases accepted credits", () => {
    const f = makeFixture();
    try {
      const channel = new (f.target.BroadcastChannel as new (name: string) => BroadcastChannel)("bounded");
      const input = { when: new Date("2026-10-23T00:00:00Z"), values: new Map([["k", 7]]) };
      channel.postMessage(input);
      input.values.set("k", 99);
      const post = f.posted.at(-1)!;
      expect(post).toMatchObject({ op: "post", sequence: 1, channelId: expect.stringMatching(/^[0-9a-f]{32}:1$/) });
      const sent = post.data as typeof input;
      expect(sent.values.get("k")).toBe(7);
      expect(sent.when).toEqual(input.when);
      const accepted = { __atools_broadcast_channel__: true, op: "accepted", channelId: post.channelId, sequence: 1 };
      f.receive(accepted);
      expect(f.transport.accept).toHaveBeenCalledTimes(1);
      channel.close();
    } finally { f.bridge.dispose(); f.dom.window.close(); }
  });

  it("caps unacknowledged posts and frees a slot only for the matching document nonce", () => {
    const f = makeFixture();
    try {
      f.bridge.dispose();
      const clone = vi.fn((value: unknown) => structuredClone(value));
      f.target.structuredClone = clone;
      const bridge = createPluginBroadcastChannelBridge(f.target, f.transport, () => 250_000, f.documentNonce);
      const channel = new (f.target.BroadcastChannel as new (name: string) => BroadcastChannel)("pending");
      for (let index = 0; index < 32; index++) channel.postMessage(index);
      expect(clone).toHaveBeenCalledTimes(32);
      expect(() => channel.postMessage(32)).toThrow(/ERR_ATOOLS_BROADCAST_BUDGET/);
      expect(clone).toHaveBeenCalledTimes(32);
      const first = f.posted.find(item => item.op === "post")!;
      f.receive({ __atools_broadcast_channel__: true, op: "accepted", channelId: first.channelId,
        sequence: first.sequence, targetDocumentNonce: "stale-document" });
      expect(() => channel.postMessage(32)).toThrow(/ERR_ATOOLS_BROADCAST_BUDGET/);
      f.receive({ __atools_broadcast_channel__: true, op: "accepted", channelId: first.channelId, sequence: first.sequence });
      expect(() => channel.postMessage(32)).not.toThrow();
      channel.close(); bridge.dispose();
    } finally { f.bridge.dispose(); f.dom.window.close(); }
  });

  it("caps aggregate unacknowledged payload bytes without releasing credits on a wrong channel", () => {
    const f = makeFixture();
    try {
      f.bridge.dispose();
      const bridge = createPluginBroadcastChannelBridge(f.target, f.transport, () => 3 * 1024 * 1024, f.documentNonce);
      const channel = new (f.target.BroadcastChannel as new (name: string) => BroadcastChannel)("pending-bytes");
      channel.postMessage(1);
      channel.postMessage(2);
      expect(() => channel.postMessage(3)).toThrow(/ERR_ATOOLS_BROADCAST_BUDGET/);
      const posts = f.posted.filter(item => item.op === "post");
      f.receive({ __atools_broadcast_channel__: true, op: "accepted", channelId: "other-channel", sequence: posts[0].sequence });
      expect(() => channel.postMessage(3)).toThrow(/ERR_ATOOLS_BROADCAST_BUDGET/);
      f.receive({ __atools_broadcast_channel__: true, op: "accepted", channelId: posts[0].channelId, sequence: posts[0].sequence });
      expect(() => channel.postMessage(3)).not.toThrow();
      channel.close(); bridge.dispose();
    } finally { f.bridge.dispose(); f.dom.window.close(); }
  });

  it("rejects oversized payloads and transport failures without keeping pending credits", () => {
    const f = makeFixture();
    try {
      f.bridge.dispose();
      const bridge = createPluginBroadcastChannelBridge(f.target, f.transport, measurePluginBroadcastPayload, f.documentNonce);
      const channel = new (f.target.BroadcastChannel as new (name: string) => BroadcastChannel)("quota");
      const error = (fn: () => void) => { try { fn(); } catch (caught) { return caught as Error; } throw new Error("expected failure"); };
      expect(error(() => channel.postMessage("x".repeat(4 * 1024 * 1024 + 1))).message).toContain("ERR_ATOOLS_BROADCAST_BUDGET");
      f.setPostWorks(false);
      expect(error(() => channel.postMessage("transport")).message).toContain("ERR_ATOOLS_BROADCAST_TRANSPORT");
      f.setPostWorks(true);
      expect(() => channel.postMessage("recovered")).not.toThrow();
      const submitted = f.posted.filter(item => item.op === "post");
      expect(submitted.map(item => item.sequence)).toEqual([1, 2]);
      channel.close(); bridge.dispose();
    } finally { f.bridge.dispose(); f.dom.window.close(); }
  });

  it("ignores unauthenticated host events and delivers independently cloned MessageEvents to captured recipients", async () => {
    const f = makeFixture();
    try {
      const first = new (f.target.BroadcastChannel as new (name: string) => BroadcastChannel)("same");
      const second = new (f.target.BroadcastChannel as new (name: string) => BroadcastChannel)("same");
      const firstData: unknown[] = [], secondData: unknown[] = [];
      first.onmessage = event => firstData.push(event.data);
      second.addEventListener("message", event => secondData.push((event as MessageEvent).data));
      const delivery = { __atools_broadcast_channel__: true, op: "message", deliveryId: 4,
        recipients: [] as string[], name: "same", origin: "https://sender.example",
        data: { items: [1, 2] } };
      f.setAccept(false);
      f.receive(delivery);
      expect(firstData).toEqual([]);
      f.setAccept(true);
      f.receive({ ...delivery, targetDocumentNonce: "old-document-nonce" });
      expect(firstData).toEqual([]);
      // Channel ids are deliberately private; host fixture uses the joined ids it observed.
      const joins = f.posted.filter(item => item.op === "join");
      delivery.recipients = joins.map(item => item.channelId as string);
      f.receive(delivery);
      expect(firstData).toHaveLength(1);
      expect(secondData).toHaveLength(1);
      expect(firstData[0]).not.toBe(secondData[0]);
      (firstData[0] as { items: number[] }).items[0] = 99;
      expect((secondData[0] as { items: number[] }).items).toEqual([1, 2]);
      expect(f.posted.at(-1)).toMatchObject({ op: "ack", deliveryId: 4 });
      expect(f.transport.accept).toHaveBeenCalledTimes(3);
      first.close(); second.close();
    } finally { f.bridge.dispose(); f.dom.window.close(); }
  });

  it("dispatches messageerror and closes a channel after host join rejection or post rejection", () => {
    const f = makeFixture();
    try {
      const failedJoin = new (f.target.BroadcastChannel as new (name: string) => BroadcastChannel)("denied");
      const joinError = vi.fn(); failedJoin.onmessageerror = joinError;
      const join = f.posted.find(item => item.op === "join")!;
      f.receive({ __atools_broadcast_channel__: true, op: "error", channelId: join.channelId, error: "ERR_CHANNEL_LIMIT" });
      expect(joinError).toHaveBeenCalledTimes(1);
      expect(() => failedJoin.postMessage("x")).toThrow(expect.objectContaining({ name: "InvalidStateError" }));

      const channel = new (f.target.BroadcastChannel as new (name: string) => BroadcastChannel)("rejected");
      const errors = vi.fn(); channel.onmessageerror = errors;
      channel.postMessage("x");
      const post = f.posted.at(-1)!;
      f.receive({ __atools_broadcast_channel__: true, op: "accepted", channelId: post.channelId,
        sequence: post.sequence, error: "ERR_FANOUT_LIMIT" });
      expect(errors).toHaveBeenCalledTimes(1);
      channel.close();
    } finally { f.bridge.dispose(); f.dom.window.close(); }
  });

  it("preserves replacement order, deactivates null handlers, and ignores noncallable objects", () => {
    const f = makeFixture();
    try {
      const channel = new (f.target.BroadcastChannel as new (name: string) => BroadcastChannel)("order");
      const order: string[] = [];
      channel.addEventListener("message", () => order.push("before"));
      (channel as unknown as { onmessage: unknown }).onmessage = () => order.push("first handler");
      channel.addEventListener("message", () => order.push("after"));
      (channel as unknown as { onmessage: unknown }).onmessage = () => order.push("replacement handler");
      channel.dispatchEvent(new f.target.MessageEvent("message"));
      expect(order).toEqual(["before", "replacement handler", "after"]);

      (channel as unknown as { onmessage: unknown }).onmessage = null;
      expect(channel.onmessage).toBeNull();
      order.length = 0;
      channel.dispatchEvent(new f.target.MessageEvent("message"));
      expect(order).toEqual(["before", "after"]);

      const handleEvent = vi.fn();
      const objectHandler = { handleEvent };
      (channel as unknown as { onmessage: unknown }).onmessage = objectHandler;
      expect(channel.onmessage).toBe(objectHandler);
      order.length = 0;
      channel.dispatchEvent(new f.target.MessageEvent("message"));
      expect(order).toEqual(["before", "after"]);
      expect(handleEvent).not.toHaveBeenCalled();

      (channel as unknown as { onmessage: unknown }).onmessage = () => order.push("new handler");
      order.length = 0;
      channel.dispatchEvent(new f.target.MessageEvent("message"));
      expect(order).toEqual(["before", "after", "new handler"]);

      (channel as unknown as { onmessage: unknown }).onmessage = 7;
      expect(channel.onmessage).toBeNull();
      channel.close();
    } finally { f.bridge.dispose(); f.dom.window.close(); }
  });

  it("acks a delivery even when all captured local receivers closed, and disposes without clobbering replacement properties", () => {
    const f = makeFixture();
    const channel = new (f.target.BroadcastChannel as new (name: string) => BroadcastChannel)("late");
    channel.close();
    const id = (f.posted.find(item => item.op === "join")?.channelId) as string;
    f.receive({ __atools_broadcast_channel__: true, op: "message", deliveryId: 8, recipients: [id], name: "late",
      origin: "https://sender.example", data: "no receiver" });
    expect(f.posted.at(-1)).toMatchObject({ op: "ack", deliveryId: 8 });
    const replacement = function LaterPluginConstructor() {};
    Object.defineProperty(f.target, "BroadcastChannel", { configurable: true, value: replacement });
    f.bridge.dispose();
    expect(f.target.BroadcastChannel).toBe(replacement);
    expect(f.posted.at(-1)).toMatchObject({ op: "dispose", documentNonce: f.documentNonce });
    f.dom.window.close();
  });

  it("leaves the native constructor untouched when the authenticated transport is unavailable", () => {
    const f = makeFixture();
    try {
      f.bridge.dispose();
      const original = f.target.BroadcastChannel;
      const bridge = createPluginBroadcastChannelBridge(f.target, { post: () => true } as any, value => Number(value), f.documentNonce);
      expect(f.target.BroadcastChannel).toBe(original);
      bridge.dispose();
    } finally { f.bridge.dispose(); f.dom.window.close(); }
  });

  it("leaves the native constructor untouched when structuredClone is unavailable", () => {
    const f = makeFixture();
    try {
      f.bridge.dispose();
      const original = f.target.BroadcastChannel;
      const clone = f.target.structuredClone;
      Reflect.deleteProperty(f.target, "structuredClone");
      const bridge = createPluginBroadcastChannelBridge(f.target, f.transport, measurePluginBroadcastPayload, f.documentNonce);
      expect(f.target.BroadcastChannel).toBe(original);
      bridge.dispose();
      f.target.structuredClone = clone;
    } finally { f.bridge.dispose(); f.dom.window.close(); }
  });

  it.each(["pagehide", "atools-plugin-out"] as const)("disables captured channels on %s", eventName => {
    const f = makeFixture();
    try {
      const channel = new (f.target.BroadcastChannel as new (name: string) => BroadcastChannel)("lifecycle");
      const installed = f.target.BroadcastChannel;
      f.target.dispatchEvent(new f.target.Event(eventName));
      expect(f.target.BroadcastChannel).not.toBe(installed);
      expect(f.posted.at(-1)).toMatchObject({ op: "dispose", documentNonce: f.documentNonce });
      expect(() => channel.postMessage("late")).toThrow(expect.objectContaining({ name: "InvalidStateError" }));
    } finally { f.bridge.dispose(); f.dom.window.close(); }
  });

  it("injects the serializable adapter into main, hosted and native plugin documents only", () => {
    const action = { plugin_id: "fixture", plugin_name: "Fixture", feature_code: "fixture", main_url: "index.html",
      plugin_path: "/fixture", expand_height: 0, payload: null };
    for (const windowType of ["main", "browserWindow"] as const) {
      for (const windowHostKind of ["hosted", "native"] as const) {
        const html = createPluginBridgeDocument({ action, windowType, windowHostKind, browserWindowId: "fixture-window",
          geometrySnapshot: null, workerScope: "fixture", mainPushConfig: null, webContentsId: 1, subInputEpoch: 0,
          appName: "ATools", appVersion: "test", baseBridgeScript: "" });
        expect(html).toContain("createPluginBroadcastChannelBridge");
        expect(html).not.toContain("__ATOOLS_BROADCAST_CHANNEL_FACTORY__");
        expect(html).not.toContain("__ATOOLS_BROADCAST_PAYLOAD_MEASURE__");
      }
    }
  });
});

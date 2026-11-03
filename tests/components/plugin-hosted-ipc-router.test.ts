import { describe, expect, it, vi } from "vitest";
import { PluginFrameSourceRegistry } from "../../src/lib/pluginFrameDocumentIdentity";
import { createPluginHostedIpcRouter, normalizeHostedIpcMessage } from "../../src/lib/pluginHostedIpcRouter";

function setup() {
  const sources = new PluginFrameSourceRegistry();
  const creators = new Map<string, any>();
  const router = createPluginHostedIpcRouter({ sources, creatorFor: id => creators.get(id), timeoutMs: 15 });
  function frame(windowId?: string, ready = true, existingSource?: any) {
    const role = windowId ? { kind: "child" as const, windowId } : { kind: "main" as const };
    const source = existingSource || { postMessage: vi.fn() };
    const id = router.reserve(role);
    if (windowId) sources.registerChild(windowId, source); else sources.setMain(source);
    let identity = sources.currentIdentityForHost(source)!;
    router.bind(role, source, identity, ready);
    const documentNonce = id.toString(16).padStart(32, "0");
    router.handleLifecycle({ source, identity }, { __atools_hosted_ipc_document__: true, webContentsId: id, documentNonce, phase: "open" });
    identity = sources.currentIdentityForHost(source)!;
    if (ready) router.markReady(role, source, identity);
    return { role, source, identity, id, documentNonce };
  }
  return { sources, router, creators, frame };
}

describe("Hosted IPC document routing", () => {
  it("allocates distinct positive integer IDs across panels and preserves an existing frame ID", () => {
    const a = setup(), b = setup(), main = a.frame(), child = a.frame("child");
    expect([main.id, child.id, b.frame().id].every(id => Number.isSafeInteger(id) && id > 0)).toBe(true);
    expect(new Set([main.id, child.id, b.frame("child").id]).size).toBe(3);
    expect(a.router.reserve(child.role)).toBe(child.id);
    a.router.invalidate(child.role, true);
    expect(a.frame("child").id).not.toBe(child.id);
  });

  it("routes main, children, siblings, and nested documents with authenticated sender IDs", async () => {
    const { router, creators, frame } = setup(), main = frame(), a = frame("a"), b = frame("b"), nested = frame("nested");
    creators.set("a", main); creators.set("b", main); creators.set("nested", a);
    for (const [sender, target] of [[main, a], [a, main], [a, b], [nested, b], [b, nested]]) {
      await expect(router.capture(sender, target.id, "channel", [{ senderId: 99999 }]).deliver()).resolves.toBe(true);
      expect(target.source.postMessage).toHaveBeenLastCalledWith({ __atools_hosted_ipc__: true,
        channel: "channel", args: [{ senderId: 99999 }], senderId: sender.id, targetDocumentNonce: target.documentNonce }, "*");
    }
    await router.captureNative("sendToParent", { channel: "up", args: [1] }, nested, nested.documentNonce)!.deliver();
    expect(a.source.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ channel: "up", senderId: nested.id }), "*");
    expect(router.stats().pending).toBe(0);
  });

  it("waits for the exact target readiness and snapshots mutable JSON before the wait", async () => {
    const { router, frame } = setup(), main = frame(), child = frame("child", false), value = { item: "before" };
    const admitted = router.capture(main, child.id, "wait", [value]); value.item = "after";
    const result = admitted.deliver();
    expect(child.source.postMessage).not.toHaveBeenCalled();
    router.markReady(child.role, child.source, child.identity);
    await expect(result).resolves.toBe(true);
    expect(child.source.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ args: [{ item: "before" }] }), "*");
    await expect(admitted.deliver()).rejects.toThrow("cannot be replayed");
  });

  it.each(["sender", "target"])("rejects a %s reload during a permission wait, including the same WindowProxy", async target => {
    const { router, frame } = setup(), main = frame(), child = frame("child");
    const admitted = router.capture(main, child.id, "permission-wait", []);
    const old = target === "sender" ? main : child;
    frame(target === "sender" ? undefined : "child", true, old.source);
    await expect(admitted.deliver()).rejects.toThrow(/cannot be replayed|no longer current/);
    expect(child.source.postMessage).not.toHaveBeenCalled();
    expect(router.stats().pending).toBe(0);
  });

  it("cancels a readiness wait on close and never sends to a replacement frame", async () => {
    const { router, frame } = setup(), main = frame(), child = frame("child", false);
    const result = router.capture(main, child.id, "wait", []).deliver();
    router.invalidate(child.role, true);
    const replacement = frame("child", true, child.source);
    await expect(result).rejects.toThrow("invalidated");
    expect(replacement.id).not.toBe(child.id);
    expect(child.source.postMessage).not.toHaveBeenCalled();
    expect(router.stats()).toEqual({ frames: 2, pending: 0, pendingBytes: 0 });
  });
  it("ignores a delayed old iframe destroy callback after its replacement has bound", async () => {
    const { router, frame } = setup(), main = frame(), old = frame("child"), replacement = frame("child");
    router.invalidate(old.role, false, old.source);
    await expect(router.capture(main, replacement.id, "current", []).deliver()).resolves.toBe(true);
    expect(replacement.source.postMessage).toHaveBeenCalledOnce();
  });

  it.each(["out", "reopen"])("clears all admitted messages on %s", async () => {
    const { router, frame } = setup(), main = frame(), child = frame("child");
    const admitted = router.capture(main, child.id, "message", []);
    router.clear();
    await expect(admitted.deliver()).rejects.toThrow("cannot be replayed");
    expect(router.stats()).toEqual({ frames: 0, pending: 0, pendingBytes: 0 });
  });

  it("rejects unknown, cross-panel, forged and unregistered documents", () => {
    const { router, frame } = setup(), main = frame(), child = frame("child"), other = setup().frame();
    for (const id of [undefined, "1", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, other.id]) {
      expect(() => router.capture(main, id, "message", [])).toThrow();
    }
    expect(() => router.capture({ source: {}, identity: main.identity }, child.id, "message", [])).toThrow("sender");
    expect(() => router.capture({ source: main.source, identity: { ...main.identity, generation: -1 } }, child.id, "message", [])).toThrow("sender");
    const id = router.reserve({ kind: "child", windowId: "not-mounted" });
    expect(() => router.capture(main, id, "message", [])).toThrow("current document");
  });

  it("expires only active readiness waits and releases the admission budget", async () => {
    const { router, frame } = setup(), main = frame(), child = frame("child", false);
    await expect(router.capture(main, child.id, "timeout", []).deliver()).rejects.toThrow("timed out");
    expect(router.stats().pendingBytes).toBe(0);
    expect(child.source.postMessage).not.toHaveBeenCalled();
  });

  it("bounds pending count and bytes and releases every entry on lifecycle cleanup", () => {
    const a = setup(), main = a.frame(), child = a.frame("child", false);
    for (let i = 0; i < 32; i++) a.router.capture(main, child.id, "small", []);
    expect(() => a.router.capture(main, child.id, "overflow", [])).toThrow("budget");
    a.router.clearChildren();
    expect(a.router.stats()).toEqual({ frames: 1, pending: 0, pendingBytes: 0 });
    const b = a.frame("large", false);
    for (let i = 0; i < 16; i++) a.router.capture(main, b.id, "bytes", ["x".repeat(16_000)]);
    expect(() => a.router.capture(main, b.id, "bytes", ["x".repeat(16_000)])).toThrow("budget");
    a.router.clear();
    expect(a.router.stats().pendingBytes).toBe(0);
  });

  it.each(["", " ", "x\0y", "x".repeat(129)])("rejects invalid channel %j", channel => {
    expect(() => normalizeHostedIpcMessage(channel, [])).toThrow("channel");
  });
  it("bounds JSON depth, UTF-8 bytes, arrays, numbers and cycles", () => {
    let deep: any = {}; for (let i = 0; i < 13; i++) deep = { nested: deep };
    const cycle: any = {}; cycle.cycle = cycle;
    for (const args of [[deep], [cycle], [undefined], [Infinity], [() => {}], [new Date()], Array(33).fill(0), ["文".repeat(6000)]]) {
      expect(() => normalizeHostedIpcMessage("channel", args)).toThrow();
    }
  });
  it("rejects huge containers before reading children and never executes getters", () => {
    const getter = vi.fn(() => "value"), wide: Record<string, unknown> = {};
    for (let i = 0; i < 1500; i++) wide["k" + i] = i;
    Object.defineProperty(wide, "neverRead", { enumerable: true, get: getter });
    const huge = new Array(1_000_000); Object.defineProperty(huge, "0", { get: getter });
    expect(() => normalizeHostedIpcMessage("channel", [huge])).toThrow("array budget");
    expect(() => normalizeHostedIpcMessage("channel", [wide])).toThrow("node budget");
    expect(() => normalizeHostedIpcMessage("channel", [{ get value() { return getter(); } }])).toThrow("data properties");
    expect(() => normalizeHostedIpcMessage("channel", ["x".repeat(1_000_000)])).toThrow("bytes");
    expect(getter).not.toHaveBeenCalled();
    const shared = { value: "shared" };
    expect(normalizeHostedIpcMessage("文", [shared, shared]).args).toEqual([shared, shared]);
  });
});

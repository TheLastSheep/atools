import { describe, expect, it, vi } from "vitest";
import {
  PluginFrameSourceRegistry, pluginDocumentEnvelope,
} from "../../src/lib/pluginFrameDocumentIdentity";
import {
  createPluginFramePermissionQueue, type PluginRuntimePermissionRequest,
} from "../../src/lib/pluginFramePermissionQueue";

const PARENT = "atools-panel://localhost";

function fixture() {
  const sources = new PluginFrameSourceRegistry();
  const source = { postMessage: vi.fn() };
  let pluginId = "first-plugin";
  let visible: PluginRuntimePermissionRequest[] = [];
  const grant = vi.fn(), allowed = vi.fn(() => false);
  const changed = vi.fn((requests: PluginRuntimePermissionRequest[]) => { visible = requests; });
  const queue = createPluginFramePermissionQueue({ sources, pluginId: () => pluginId, allowed, changed, grant });
  function document(id: string, nonce: string) {
    const reservation = sources.reserveDocument({ kind: "main", source, pageDocumentId: id,
      expectedOrigin: `atools-page://${id}.localhost`, parentOrigin: PARENT });
    const identity = sources.activateDocument(reservation, nonce)!;
    return { reservation, identity };
  }
  const first = document("a".repeat(32), "b".repeat(32));
  return { sources, source, first, document, queue, grant, allowed, changed,
    pending: () => visible, select: (id: string) => { pluginId = id; } };
}

describe("frame-bound plugin permission queue", () => {
  it("captures plugin and native document identity, grants once, and replies through the registry", async () => {
    const f = fixture();
    await expect(f.queue.request("  screen.capture  ", f.source as unknown as Window, 42)).resolves.toBe(false);
    const request = f.pending()[0];
    expect(Object.isFrozen(request)).toBe(true);
    expect(request).toMatchObject({ pluginId: "first-plugin", permission: "screen.capture", bridgeReqId: 42 });
    expect(request.identity).toBe(f.first.identity);
    expect(request.source).toBe(f.source);
    expect(f.grant).not.toHaveBeenCalled();
    expect(f.source.postMessage).not.toHaveBeenCalled();

    // A copied UI object cannot replace the queue's captured authorization.
    expect(f.queue.respond({ ...request }, true, true)).toBe(false);
    expect(f.pending()).toEqual([request]);
    expect(f.queue.respond(request, true, true)).toBe(true);
    expect(f.grant).toHaveBeenCalledTimes(1);
    expect(f.grant).toHaveBeenCalledWith("first-plugin", "screen.capture", true);
    expect(f.source.postMessage).toHaveBeenCalledTimes(1);
    expect(f.source.postMessage).toHaveBeenCalledWith({
      __atools_permission_response__: true, reqId: 42, permission: "screen.capture", allowed: true,
      __atoolsDocument: pluginDocumentEnvelope(f.first.identity),
    }, f.first.identity.expectedOrigin);
    expect(f.pending()).toEqual([]);
    expect(f.queue.respond(request, true)).toBe(false);
    expect(f.grant).toHaveBeenCalledTimes(1);
  });

  it("cannot transfer an old approval or reply to a new document using the same WindowProxy", async () => {
    const f = fixture();
    const internal = f.queue.request("clipboard.write", f.source as unknown as Window);
    await f.queue.request("screen.capture", f.source as unknown as Window, 7);
    const [oldInternal, oldBridge] = f.pending();
    f.select("second-plugin");
    const next = f.document("c".repeat(32), "d".repeat(32));

    expect(f.queue.respond(oldInternal, true, true)).toBe(false);
    expect(f.queue.respond(oldBridge, true, true)).toBe(false);
    await expect(internal).resolves.toBe(false);
    expect(f.grant).not.toHaveBeenCalled();
    expect(f.source.postMessage).not.toHaveBeenCalled();
    expect(f.pending()).toEqual([]);

    await f.queue.request("screen.capture", f.source as unknown as Window, 8);
    expect(f.queue.respond(f.pending()[0], true)).toBe(true);
    expect(f.grant).toHaveBeenCalledTimes(1);
    expect(f.grant).toHaveBeenCalledWith("second-plugin", "screen.capture", false);
    expect(f.source.postMessage).toHaveBeenCalledTimes(1);
    expect(f.source.postMessage).toHaveBeenCalledWith({
      __atools_permission_response__: true, reqId: 8, permission: "screen.capture", allowed: true,
      __atoolsDocument: pluginDocumentEnvelope(next.identity),
    }, next.identity.expectedOrigin);
  });

  it("rejects a changed plugin even when the old document is still registered", async () => {
    const f = fixture();
    const pending = f.queue.request("shell.open", f.source as unknown as Window);
    const captured = f.pending()[0];
    f.select("second-plugin");
    expect(f.queue.respond(captured, true, true)).toBe(false);
    await expect(pending).resolves.toBe(false);
    expect(f.grant).not.toHaveBeenCalled();
    expect(f.pending()).toEqual([]);
  });

  it("clears internal waits and queued bridge requests without granting or keeping stale approvals", async () => {
    const f = fixture();
    const internal = f.queue.request("clipboard.write", f.source as unknown as Window);
    await f.queue.request("screen.capture", f.source as unknown as Window, 19);
    const captured = [...f.pending()];
    f.queue.clear();
    await expect(internal).resolves.toBe(false);
    expect(f.pending()).toEqual([]);
    expect(f.grant).not.toHaveBeenCalled();
    expect(f.source.postMessage).toHaveBeenCalledTimes(1);
    expect(f.source.postMessage).toHaveBeenCalledWith({
      __atools_permission_response__: true, reqId: 19, permission: "screen.capture", allowed: false,
      __atoolsDocument: pluginDocumentEnvelope(f.first.identity),
    }, f.first.identity.expectedOrigin);
    for (const request of captured) expect(f.queue.respond(request, true)).toBe(false);
    const notifications = f.changed.mock.calls.length;
    f.queue.clear();
    expect(f.changed).toHaveBeenCalledTimes(notifications);
  });

  it("bounds pending prompts at 32 and releases all slots and internal promises on clear", async () => {
    const f = fixture();
    const internal: Promise<boolean>[] = [];
    for (let index = 0; index < 32; index++) {
      if (index % 2) await f.queue.request(`permission.${index}`, f.source as unknown as Window, index);
      else internal.push(f.queue.request(`permission.${index}`, f.source as unknown as Window));
    }
    expect(f.pending()).toHaveLength(32);
    await expect(f.queue.request("overflow", f.source as unknown as Window, 99)).resolves.toBe(false);
    expect(f.pending()).toHaveLength(32);
    expect(f.source.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ reqId: 99, allowed: false }), f.first.identity.expectedOrigin);
    f.queue.clear();
    expect(await Promise.all(internal)).toEqual(Array(16).fill(false));
    expect(f.pending()).toEqual([]);
    expect(f.grant).not.toHaveBeenCalled();
    await f.queue.request("fresh", f.source as unknown as Window, 100);
    expect(f.pending()).toHaveLength(1);
    f.queue.clear();
  });

  it("does not queue unregistered or reserved frames and uses a live identity for already allowed replies", async () => {
    const f = fixture();
    f.allowed.mockReturnValue(true);
    await expect(f.queue.request("screen.capture", null, 1)).resolves.toBe(false);
    await expect(f.queue.request("screen.capture", {} as Window, 2)).resolves.toBe(false);
    const reservation = f.sources.reserveDocument({ kind: "main", source: f.source, pageDocumentId: "e".repeat(32),
      expectedOrigin: `atools-page://${"e".repeat(32)}.localhost`, parentOrigin: PARENT });
    await expect(f.queue.request("screen.capture", f.source as unknown as Window, 3)).resolves.toBe(false);
    expect(f.allowed).not.toHaveBeenCalled();
    const identity = f.sources.activateDocument(reservation, "f".repeat(32))!;
    await expect(f.queue.request("screen.capture", f.source as unknown as Window, 4)).resolves.toBe(true);
    expect(f.pending()).toEqual([]);
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.grant).not.toHaveBeenCalled();
    expect(f.source.postMessage).toHaveBeenCalledTimes(1);
    expect(f.source.postMessage).toHaveBeenCalledWith({
      __atools_permission_response__: true, reqId: 4, permission: "screen.capture", allowed: true,
      __atoolsDocument: pluginDocumentEnvelope(identity),
    }, identity.expectedOrigin);
  });
});

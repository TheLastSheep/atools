import { describe, expect, it } from "vitest";
import { createPluginBrowserWindowGeometry } from "../../src/lib/pluginBrowserWindowGeometry";
import { createPluginBrowserWindowGeometryHost } from "../../src/lib/pluginBrowserWindowGeometryHost";
import { PluginFrameSourceRegistry } from "../../src/lib/pluginFrameDocumentIdentity";

function host() {
  const sources = new PluginFrameSourceRegistry(), owner = {}, child = {}, sibling = {};
  sources.setMain(owner); sources.registerChild("child", child); sources.registerChild("sibling", sibling);
  const creator = { source: owner, identity: sources.currentIdentityForHost(owner)! };
  const deliveries: any[] = [];
  const geometry = createPluginBrowserWindowGeometryHost({ creatorFor: () => creator, sourceFor: () => child,
    sources, nonce: () => "host-instance", post(source, message, identity) { deliveries.push({ source, message, identity }); return sources.isCurrent(source, identity); } });
  const state = { id: "child", clientCreateId: "create-one", documentGeneration: 1, x: -25, y: -9, width: 400, height: 300,
    minimumWidth: 100, minimumHeight: 80, maximumWidth: 1000, maximumHeight: 800 };
  return { geometry, state, sources, owner, child, sibling, creator, deliveries };
}

describe("host-confirmed BrowserWindow geometry", () => {
  it("synchronously copies all six getters without retaining caller-owned objects", () => {
    const h = host(), seed = h.geometry.snapshot(h.state)!;
    const mirror = createPluginBrowserWindowGeometry(seed);
    seed.bounds.x = 123; seed.minimumSize[0] = 999;
    expect(mirror.read("getBounds")).toEqual({ x: -25, y: -9, width: 400, height: 300 });
    for (const method of ["getSize", "getContentSize"]) expect(mirror.read(method)).toEqual([400, 300]);
    expect(mirror.read("getPosition")).toEqual([-25, -9]);
    expect(mirror.read("getMinimumSize")).toEqual([100, 80]);
    expect(mirror.read("getMaximumSize")).toEqual([1000, 800]);
    (mirror.read("getBounds") as any).width = 1;
    (mirror.read("getSize") as number[])[0] = 1;
    expect((mirror.read("getBounds") as any).width).toBe(400);
    expect(mirror.read("getSize")).toEqual([400, 300]);
  });

  it("fails synchronously without an authoritative create snapshot and cannot bootstrap from unsolicited updates", () => {
    const mirror = createPluginBrowserWindowGeometry(null), h = host();
    expect(() => mirror.read("getBounds")).toThrow("ERR_ATOOLS_BROWSER_WINDOW_NOT_READY");
    expect(mirror.apply(h.geometry.snapshot(h.state))).toBe(false);
    expect(() => mirror.read("getSize")).toThrow("ERR_ATOOLS_BROWSER_WINDOW_NOT_READY");
  });

  it.each(["windowId", "clientCreateId", "ownerKey", "instanceNonce", "documentNonce"])("rejects a mismatched %s", field => {
    const h = host(), seed = h.geometry.snapshot(h.state)!;
    const mirror = createPluginBrowserWindowGeometry(seed);
    expect(mirror.apply({ ...seed, [field]: "other", revision: 2, bounds: { ...seed.bounds, x: 1 } })).toBe(false);
    expect(mirror.read("getPosition")).toEqual([-25, -9]);
  });

  it("rejects stale revisions and old document generations after reload", () => {
    const h = host(), first = h.geometry.snapshot(h.state)!, mirror = createPluginBrowserWindowGeometry(first);
    const next = h.geometry.snapshot({ ...h.state, x: 8, documentGeneration: 2 })!;
    expect(mirror.apply(next)).toBe(true);
    expect(mirror.apply(first)).toBe(false);
    expect(mirror.apply({ ...next, revision: next.revision + 1, documentGeneration: 1 })).toBe(false);
    expect(mirror.apply({ ...next, bounds: { ...next.bounds, x: 99 } })).toBe(false);
    expect(mirror.read("getPosition")).toEqual([8, -9]);
  });

  it("preserves actual normalized min/max constraints and rejects malformed snapshots", () => {
    const h = host(), first = h.geometry.snapshot(h.state)!, mirror = createPluginBrowserWindowGeometry(first);
    const updated = h.geometry.snapshot({ ...h.state, minimumWidth: 500, width: 500, maximumWidth: 700 })!;
    expect(mirror.apply(updated)).toBe(true);
    expect(mirror.read("getMinimumSize")).toEqual([500, 80]);
    expect(mirror.read("getMaximumSize")).toEqual([700, 800]);
    expect(mirror.read("getSize")).toEqual([500, 300]);
    for (const bounds of [{ ...updated.bounds, x: NaN }, { ...updated.bounds, width: 1 }, { ...updated.bounds, height: Infinity }])
      expect(mirror.apply({ ...updated, revision: updated.revision + 1, bounds })).toBe(false);
  });

  it("treats zero native size edges as unconstrained and still enforces positive edges", () => {
    const h = host(), seed = h.geometry.snapshot(h.state)!;
    const unbounded = { ...seed, minimumSize: [0, 0] as [number, number], maximumSize: [0, 0] as [number, number] };
    const mirror = createPluginBrowserWindowGeometry(unbounded);
    expect(mirror.read("getMinimumSize")).toEqual([0, 0]);
    expect(mirror.read("getMaximumSize")).toEqual([0, 0]);

    const partiallyBounded = {
      ...unbounded,
      revision: seed.revision + 1,
      minimumSize: [200, 0] as [number, number],
      maximumSize: [0, 600] as [number, number],
    };
    expect(mirror.apply(partiallyBounded)).toBe(true);
    expect(mirror.read("getMinimumSize")).toEqual([200, 0]);
    expect(mirror.read("getMaximumSize")).toEqual([0, 600]);

    expect(mirror.apply({
      ...partiallyBounded,
      revision: partiallyBounded.revision + 1,
      bounds: { ...partiallyBounded.bounds, height: 601 },
    })).toBe(false);
    expect(mirror.read("getSize")).toEqual([400, 300]);
  });

  it("rejects a changed creation identity even when all geometry fields are identical", () => {
    const h = host();
    expect(h.geometry.snapshot(h.state)).toBeDefined();
    expect(h.geometry.snapshot({ ...h.state, clientCreateId: "another-create" })).toBeUndefined();
  });

  it("clears confirmed state permanently on close", () => {
    const h = host(), seed = h.geometry.snapshot(h.state)!, mirror = createPluginBrowserWindowGeometry(seed);
    mirror.close();
    expect(() => mirror.read("getPosition")).toThrow("ERR_ATOOLS_BROWSER_WINDOW_CLOSED");
    expect(mirror.apply({ ...seed, revision: 99 })).toBe(false);
    expect(mirror.snapshot()).toBeUndefined();
  });

  it("delivers snapshots only to exact creator and current self child", () => {
    const h = host(); h.geometry.publish(h.state);
    expect(h.deliveries.map(entry => entry.source)).toEqual([h.owner, h.child]);
    expect(h.deliveries.some(entry => entry.source === h.sibling)).toBe(false);
    h.sources.setMain(h.owner);
    expect(h.geometry.snapshot(h.state)).toBeUndefined();
    const before = h.deliveries.length;
    h.geometry.publish(h.state);
    expect(h.deliveries.length).toBe(before);
  });

  it("routes nested windows to their exact creator without leaking to main or siblings", () => {
    const h = host(), nested = {};
    h.sources.registerChild("nested", nested);
    const creator = { source: h.child, identity: h.sources.currentIdentityForHost(h.child)! };
    const delivered: unknown[] = [];
    const geometry = createPluginBrowserWindowGeometryHost({ sources: h.sources, creatorFor: () => creator,
      sourceFor: () => nested, nonce: () => "nested-instance", post: source => { delivered.push(source); return true; } });
    geometry.publish({ ...h.state, id: "nested" });
    expect(delivered).toEqual([h.child, nested]);
  });
});

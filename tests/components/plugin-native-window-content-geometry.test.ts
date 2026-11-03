import { describe, expect, it } from "vitest";
import { createPluginBrowserWindowGeometry } from "../../src/lib/pluginBrowserWindowGeometry";
import { createPluginBrowserWindowGeometryHost, type PluginBrowserWindowGeometryState } from "../../src/lib/pluginBrowserWindowGeometryHost";
import { readPluginNativeBrowserWindowSnapshot } from "../../src/lib/pluginNativeBrowserWindowSnapshot";
import type { PluginNativeBrowserWindowSnapshot } from "../../src/lib/pluginNativeBrowserWindowTypes";
import { PluginFrameSourceRegistry } from "../../src/lib/pluginFrameDocumentIdentity";
import {
  compileNativeFrameDocument,
  makeNativeFrameDocumentSourceHost,
  NATIVE_FRAME_HTML,
  NATIVE_FRAME_ID,
} from "./compiledPluginNativeWindowFrameFixture";

const nativeSnapshot = (overrides: Partial<PluginNativeBrowserWindowSnapshot> = {}): PluginNativeBrowserWindowSnapshot => ({
  bounds: { x: -25, y: 10, width: 640, height: 480 },
  contentBounds: { x: -17, y: 45, width: 620, height: 430 },
  minimumSize: [800, 700], maximumSize: [900, 900],
  visible: true, focused: true, alwaysOnTop: false, minimized: false, maximized: false,
  fullScreen: false, resizable: true, title: "Native window", nativeSequence: 1, constraintsSource: "adapter",
  ...overrides,
});

function setup(state: PluginBrowserWindowGeometryState) {
  const sources = new PluginFrameSourceRegistry(), parent = {}, child = {};
  sources.setMain(parent);
  sources.registerChild(state.id, child);
  const creator = { source: parent, identity: sources.currentIdentityForHost(parent)! };
  const host = createPluginBrowserWindowGeometryHost({
    creatorFor: id => id === state.id ? creator : undefined,
    sourceFor: id => id === state.id ? child : undefined,
    sources,
    nonce: () => "native-test-nonce",
    post: (_source, _message, identity) => sources.isCurrent(parent, identity),
  });
  return { host, sources, parent, child };
}

function nativeState(overrides: Partial<PluginBrowserWindowGeometryState> = {}): PluginBrowserWindowGeometryState {
  return {
    id: NATIVE_FRAME_ID, clientCreateId: "native-create-1", documentGeneration: 1,
    // These renderer-side/overlay values are deliberately stale: native geometry must come from Rust's snapshot.
    x: 900, y: 901, width: 902, height: 903,
    minimumWidth: 904, minimumHeight: 905, maximumWidth: 906, maximumHeight: 907,
    hostKind: "native", nativeSnapshot: nativeSnapshot(),
    ...overrides,
  };
}

describe("native BrowserWindow outer and content geometry", () => {
  it("passes the validated native snapshot through the host and production bridge as distinct synchronous getters", () => {
    const actual = nativeSnapshot({
      bounds: { x: -25.25, y: 10.75, width: 640.5, height: 480.25 },
      contentBounds: { x: -17.5, y: 45.25, width: 620.25, height: 430.125 },
    });
    const state = nativeState({ nativeSnapshot: actual }), { host } = setup(state);
    const compact = host.snapshot(state)!;
    const sourceHost = makeNativeFrameDocumentSourceHost();
    const html = sourceHost.host.injectBridge(NATIVE_FRAME_HTML, "browserWindow", NATIVE_FRAME_ID,
      "", compact, "native");
    const frame = compileNativeFrameDocument(html);
    const handle = frame.window.__testSelfWindowHandle;
    const before = frame.messages.length;

    expect(frame.window.__testWindowHostKind).toBe("native");
    expect(JSON.parse(JSON.stringify(handle.getSize()))).toEqual([640.5, 480.25]);
    expect(JSON.parse(JSON.stringify(handle.getContentSize()))).toEqual([620.25, 430.125]);
    expect(JSON.parse(JSON.stringify(handle.getBounds()))).toEqual({ x: -25.25, y: 10.75, width: 640.5, height: 480.25 });
    expect(JSON.parse(JSON.stringify(handle.getMinimumSize()))).toEqual([800, 700]);
    expect(JSON.parse(JSON.stringify(handle.getMaximumSize()))).toEqual([900, 900]);
    handle.getBounds().width = 1;
    handle.getContentSize()[0] = 1;
    expect(JSON.parse(JSON.stringify(handle.getSize()))).toEqual([640.5, 480.25]);
    expect(JSON.parse(JSON.stringify(handle.getContentSize()))).toEqual([620.25, 430.125]);

    for (let index = 0; index < 1000; index++) {
      handle.getSize();
      handle.getContentSize();
      handle.getBounds();
    }
    expect(frame.messages.length).toBe(before);
    frame.dispose();
  });

  it("revises content-only changes and keeps every confirmed snapshot detached from mutable inputs", () => {
    const state = nativeState(), { host } = setup(state);
    const first = host.snapshot(state)!;
    const mirror = createPluginBrowserWindowGeometry(first);
    const priorNative = state.nativeSnapshot as PluginNativeBrowserWindowSnapshot;
    state.nativeSnapshot = nativeSnapshot({
      bounds: { ...priorNative.bounds },
      contentBounds: { ...priorNative.contentBounds, width: 600 },
      nativeSequence: 2,
    });
    const second = host.snapshot(state)!;

    expect(second.bounds).toEqual(first.bounds);
    expect(second.contentBounds).toEqual({ x: -17, y: 45, width: 600, height: 430 });
    expect(second.revision).toBe(first.revision + 1);
    expect(mirror.apply(second)).toBe(true);
    expect(mirror.read("getSize")).toEqual([640, 480]);
    expect(mirror.read("getContentSize")).toEqual([600, 430]);
    expect(mirror.acceptEvent(second)).toBe(true);
    expect(mirror.acceptEvent({ ...second, contentBounds: { ...second.contentBounds!, width: 599 } })).toBe(false);
    expect(mirror.apply(first)).toBe(false);

    state.nativeSnapshot!.bounds.width = 1;
    state.nativeSnapshot!.contentBounds.width = 2;
    expect(first.bounds.width).toBe(640);
    expect(second.bounds.width).toBe(640);
    expect(second.contentBounds!.width).toBe(600);
    const callerOwned = mirror.read("getContentSize") as number[];
    callerOwned[0] = 1;
    expect(mirror.read("getContentSize")).toEqual([600, 430]);
    const copiedState = mirror.snapshot()!;
    copiedState.bounds.width = 2;
    copiedState.contentBounds!.width = 3;
    copiedState.minimumSize[0] = 4;
    expect(mirror.read("getSize")).toEqual([640, 480]);
    expect(mirror.read("getContentSize")).toEqual([600, 430]);
    expect(mirror.read("getMinimumSize")).toEqual([800, 700]);
  });

  it("uses the native snapshot reader and accepts actual OS bounds outside configured constraints", () => {
    const actual = nativeSnapshot();
    expect(readPluginNativeBrowserWindowSnapshot(actual)).toMatchObject({
      bounds: actual.bounds, contentBounds: actual.contentBounds, minimumSize: [800, 700], maximumSize: [900, 900],
    });
    const state = nativeState({ nativeSnapshot: actual }), { host } = setup(state);
    const compact = host.snapshot(state)!;
    expect(compact.bounds).toEqual(actual.bounds);
    expect(compact.contentBounds).toEqual(actual.contentBounds);
    expect(compact.boundsSource).toBe("native");
    const mirror = createPluginBrowserWindowGeometry(compact);
    expect(mirror.read("getSize")).toEqual([640, 480]);
    expect(mirror.read("getContentSize")).toEqual([620, 430]);
    expect(mirror.read("getMinimumSize")).toEqual([800, 700]);
  });

  it("keeps hosted-window validation and its legacy outer-size content fallback", () => {
    const state = nativeState({ hostKind: "overlay", nativeSnapshot: undefined,
      x: -5, y: 8, width: 400, height: 300,
      minimumWidth: 100, minimumHeight: 80, maximumWidth: 600, maximumHeight: 500 });
    const { host } = setup(state), compact = host.snapshot(state)!;
    expect(compact.boundsSource).toBeUndefined();
    expect(compact.contentBounds).toBeUndefined();
    const mirror = createPluginBrowserWindowGeometry(compact);
    expect(mirror.read("getSize")).toEqual([400, 300]);
    expect(mirror.read("getContentSize")).toEqual([400, 300]);
    expect(mirror.apply({ ...compact, revision: compact.revision + 1,
      bounds: { ...compact.bounds, width: 601 } })).toBe(false);
    expect(mirror.read("getSize")).toEqual([400, 300]);
  });

  it("rejects absent, closed, malformed, or content-less native geometry without synthesizing values", () => {
    const missing = nativeState({ nativeSnapshot: undefined }), m = setup(missing);
    expect(m.host.snapshot(missing)).toBeUndefined();
    expect(m.host.synchronizeSelf(missing, m.child)).toBe(false);
    expect(m.host.publish(missing)).toBeFalsy();

    const closed = nativeState({ nativeSnapshot: { closed: true, nativeSequence: 2 } });
    expect(setup(closed).host.snapshot(closed)).toBeUndefined();
    const invalid = nativeState({ nativeSnapshot: nativeSnapshot({ contentBounds: { x: 0, y: 0, width: NaN, height: 10 } }) });
    expect(setup(invalid).host.snapshot(invalid)).toBeUndefined();

    const mirror = createPluginBrowserWindowGeometry(null);
    expect(mirror.apply({ ...nativeState(), nativeSnapshot: undefined })).toBe(false);
    expect(mirror.apply({ ...nativeState(), boundsSource: "native", contentBounds: undefined })).toBe(false);
    expect(() => mirror.read("getContentSize")).toThrow("ERR_ATOOLS_BROWSER_WINDOW_NOT_READY");
  });

  it("rejects stale, foreign, malformed, and unsupported marker updates", () => {
    const state = nativeState(), { host } = setup(state), seed = host.snapshot(state)!;
    const mirror = createPluginBrowserWindowGeometry(seed);
    for (const patch of [
      { windowId: "foreign-window" }, { clientCreateId: "foreign-create" }, { ownerKey: "foreign-owner" },
      { instanceNonce: "foreign-instance" }, { documentNonce: "foreign-document" },
    ]) expect(mirror.apply({ ...seed, ...patch, revision: seed.revision + 1 })).toBe(false);
    expect(mirror.apply({ ...seed, revision: seed.revision - 1 })).toBe(false);
    expect(mirror.apply({ ...seed, revision: seed.revision + 1, boundsSource: "invented" })).toBe(false);
    expect(mirror.apply({ ...seed, revision: seed.revision + 1, contentBounds: { ...seed.contentBounds!, width: Infinity } })).toBe(false);
    expect(mirror.read("getContentSize")).toEqual([620, 430]);
  });

  it("keeps bounds provenance fixed for a window identity across revisions", () => {
    const native = nativeState({ nativeSnapshot: nativeSnapshot({
      bounds: { x: 10, y: 20, width: 850, height: 800 },
      contentBounds: { x: 14, y: 50, width: 820, height: 760 },
    }) });
    const nativeSeed = setup(native).host.snapshot(native)!;
    const nativeMirror = createPluginBrowserWindowGeometry(nativeSeed);
    expect(nativeMirror.apply({ ...nativeSeed, revision: nativeSeed.revision + 1,
      boundsSource: undefined, contentBounds: undefined })).toBe(false);
    expect(nativeMirror.snapshot()).toEqual(nativeSeed);
    expect(nativeMirror.read("getContentSize")).toEqual([820, 760]);

    const hosted = nativeState({ hostKind: "overlay", nativeSnapshot: undefined,
      x: 10, y: 20, width: 400, height: 300,
      minimumWidth: 100, minimumHeight: 80, maximumWidth: 1000, maximumHeight: 800 });
    const hostedSeed = setup(hosted).host.snapshot(hosted)!;
    const hostedMirror = createPluginBrowserWindowGeometry(hostedSeed);
    expect(hostedMirror.apply({ ...hostedSeed, revision: hostedSeed.revision + 1,
      boundsSource: "native", contentBounds: { ...hostedSeed.bounds } })).toBe(false);
    expect(hostedMirror.snapshot()).toEqual(hostedSeed);
    expect(hostedMirror.read("getContentSize")).toEqual([400, 300]);
  });
});

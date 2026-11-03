import type { PluginBrowserWindowCreator } from "./pluginBrowserWindowReady";
import type { PluginFrameIdentity } from "./pluginFrameDocumentIdentity";
import { readPluginNativeBrowserWindowSnapshot } from "./pluginNativeBrowserWindowSnapshot";
import type { PluginNativeBrowserWindowSnapshotResult } from "./pluginNativeBrowserWindowTypes";

export type PluginBrowserWindowGeometryState = {
  id: string; clientCreateId?: string; documentGeneration: number;
  x: number; y: number; width: number; height: number;
  minimumWidth: number; minimumHeight: number; maximumWidth: number; maximumHeight: number;
  hostKind?: "overlay" | "native"; nativeSnapshot?: PluginNativeBrowserWindowSnapshotResult;
};
/** Compact snapshots retain actual host constraints; they never consume unconfirmed renderer options. */
export function createPluginBrowserWindowGeometryHost(options: {
  creatorFor: (id: string) => PluginBrowserWindowCreator | undefined;
  sourceFor: (id: string) => unknown;
  sources: { isCurrent: (source: unknown, identity: PluginFrameIdentity) => boolean; currentIdentityForHost: (source: unknown) => PluginFrameIdentity | null };
  post: (source: unknown, message: unknown, identity: PluginFrameIdentity) => boolean;
  nonce: () => string;
}) {
  const deliveredRevisions = new Map<string, number>();
  const entries = new Map<string, { key: string; snapshot: ReturnType<typeof makeSnapshot> }>();
  type Geometry = {
    bounds: { x: number; y: number; width: number; height: number };
    contentBounds?: { x: number; y: number; width: number; height: number };
    minimumSize: [number, number]; maximumSize: [number, number]; boundsSource?: "native";
  };
  function ownerKey(creator: PluginBrowserWindowCreator) {
    const i = creator.identity;
    return JSON.stringify([i.kind, i.kind === "child" ? i.windowId : "", i.generation,
      "docNonce" in i ? i.docNonce : "", "pageDocumentId" in i ? i.pageDocumentId : ""]);
  }
  function geometryFor(state: PluginBrowserWindowGeometryState): Geometry | undefined {
    if (state.hostKind === "native") {
      if (!state.nativeSnapshot) return undefined;
      try {
        const snapshot = readPluginNativeBrowserWindowSnapshot(state.nativeSnapshot);
        if ("closed" in snapshot) return undefined;
        return { bounds: { ...snapshot.bounds }, contentBounds: { ...snapshot.contentBounds },
          minimumSize: [...snapshot.minimumSize], maximumSize: [...snapshot.maximumSize], boundsSource: "native" };
      } catch { return undefined; }
    }
    return { bounds: { x: state.x, y: state.y, width: state.width, height: state.height },
      minimumSize: [state.minimumWidth, state.minimumHeight], maximumSize: [state.maximumWidth, state.maximumHeight] };
  }
  function makeSnapshot(state: PluginBrowserWindowGeometryState, geometry: Geometry, owner: string, nonce: string, documentNonce: string, revision: number) {
    return { windowId: state.id, clientCreateId: state.clientCreateId || "", ownerKey: owner,
      instanceNonce: nonce, documentGeneration: state.documentGeneration, documentNonce, revision,
      bounds: { ...geometry.bounds }, ...(geometry.contentBounds ? { contentBounds: { ...geometry.contentBounds } } : {}),
      ...(geometry.boundsSource ? { boundsSource: geometry.boundsSource } : {}),
      minimumSize: [...geometry.minimumSize], maximumSize: [...geometry.maximumSize] };
  }
  function snapshot(state: PluginBrowserWindowGeometryState) {
    const creator = options.creatorFor(state.id);
    if (!creator || !state.clientCreateId || !options.sources.isCurrent(creator.source, creator.identity)) return undefined;
    const geometry = geometryFor(state);
    if (!geometry) return undefined;
    const owner = ownerKey(creator);
    const key = JSON.stringify([owner, state.documentGeneration, geometry.bounds, geometry.contentBounds ?? null, geometry.boundsSource ?? null,
      geometry.minimumSize, geometry.maximumSize]);
    const old = entries.get(state.id);
    if (old && (old.snapshot.clientCreateId !== state.clientCreateId || old.snapshot.ownerKey !== owner || state.documentGeneration < old.snapshot.documentGeneration)) return undefined;
    if (old?.key === key) return structuredClone(old.snapshot);
    const revision = (old?.snapshot.revision || 0) + 1;
    if (!Number.isSafeInteger(revision)) throw Error("BrowserWindow geometry revision exhausted");
    const value = makeSnapshot(state, geometry, owner, old?.snapshot.instanceNonce || options.nonce(),
      old?.snapshot.documentGeneration === state.documentGeneration ? old.snapshot.documentNonce : options.nonce(), revision);
    entries.set(state.id, { key, snapshot: value });
    return structuredClone(value);
  }
  function deliver(id: string, message: Record<string, unknown>) {
    const creator = options.creatorFor(id);
    let delivered = false;
    if (creator && options.sources.isCurrent(creator.source, creator.identity))
      delivered = options.post(creator.source, message, creator.identity);
    const source = options.sourceFor(id), identity = options.sources.currentIdentityForHost(source);
    if (identity?.kind === "child" && identity.windowId === id && source !== creator?.source)
      delivered = options.post(source, message, identity) || delivered;
    const geometry = message.geometrySnapshot as { revision?: unknown } | undefined;
    if (delivered && Number.isSafeInteger(geometry?.revision)) deliveredRevisions.set(id, geometry!.revision as number);
    return delivered;
  }
  /** A document may have missed updates while its listener was bootstrapping. */
  function synchronizeSelf(state: PluginBrowserWindowGeometryState, expectedSource: unknown) {
    if (!expectedSource || options.sourceFor(state.id) !== expectedSource) return false;
    const identity = options.sources.currentIdentityForHost(expectedSource);
    if (identity?.kind !== "child" || identity.windowId !== state.id || !options.sources.isCurrent(expectedSource, identity)) return false;
    const geometrySnapshot = snapshot(state);
    return geometrySnapshot ? options.post(expectedSource, { __atools_browser_window_geometry__: true,
      windowId: state.id, clientCreateId: state.clientCreateId, geometrySnapshot }, identity) : false;
  }
  function publish(state: PluginBrowserWindowGeometryState) {
    const geometrySnapshot = snapshot(state);
    return geometrySnapshot && deliveredRevisions.get(state.id) !== geometrySnapshot.revision ? deliver(state.id, { __atools_browser_window_geometry__: true,
      windowId: state.id, clientCreateId: state.clientCreateId, geometrySnapshot }) : false;
  }
  return { snapshot, publish, synchronizeSelf, deliver, remove: (id: string) => { deliveredRevisions.delete(id); return entries.delete(id); }, clear: () => { entries.clear(); deliveredRevisions.clear(); } };
}

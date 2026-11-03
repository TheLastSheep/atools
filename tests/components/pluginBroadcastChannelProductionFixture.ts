import { JSDOM } from "jsdom";
import type { FeatureAction } from "../../src/lib/types";
import { createPluginBroadcastChannelHost } from "../../src/lib/pluginBroadcastChannelHost";
import { createPluginBridgeDocument, injectPluginBridgeHtml } from "../../src/lib/pluginPanelBridgeCompiler";
import { PluginFrameSourceRegistry, identifyPluginMessageEvent, type PluginFrameIdentity } from "../../src/lib/pluginFrameDocumentIdentity";
import { createPluginHostedIpcRouter } from "../../src/lib/pluginHostedIpcRouter";
import { createPluginPanelMessageRouter } from "../../src/lib/pluginPanelMessageRouter";
import { pluginFrameTransportScript } from "../../src/lib/pluginFrameTransport";

const PARENT_ORIGIN = "tauri://localhost";
const PLUGIN_ORIGIN = "https://snipaste-fixture.invalid";

type Role = { kind: "main" } | { kind: "child"; windowId: string };
type FrameSource = { postMessage: (message: unknown, targetOrigin?: string) => void };
type FixtureDocument = {
  role: Role;
  roleKey: string;
  webContentsId: number;
  source: FrameSource;
  parent: { postMessage: (message: unknown, targetOrigin?: string, transfer?: Transferable[]) => void };
  dom: JSDOM;
  window: Window & typeof globalThis;
  origin: string;
  pageDocumentId: string;
  bootstrapNonce: string;
  identity: PluginFrameIdentity;
  hostedNonce?: string;
  close: () => void;
};
type Incoming = { source: FrameSource; origin: string; data: unknown };
type Outgoing = { document: FixtureDocument; origin: string; data: unknown };

function key(role: Role) { return role.kind === "main" ? "main" : `child:${role.windowId}`; }

export function snipasteFixtureAction(pluginId = "harris-snipaste"): FeatureAction {
  return {
    plugin_id: pluginId,
    plugin_name: "Snipaste Pro",
    feature_code: "paster",
    main_url: "dist/index.html",
    plugin_path: "/fixture/snipaste",
    expand_height: 0,
    payload: null,
    plugin_permissions: [],
  };
}

/** Compiles actual plugin bridge HTML and routes every ingress through the ordered production router. */
export function createPluginBroadcastChannelProductionFixture() {
  const sources = new PluginFrameSourceRegistry();
  const hostedIpc = createPluginHostedIpcRouter({ sources, creatorFor: () => undefined });
  const sourceByRole = new Map<string, FrameSource>();
  const activeDocuments = new Map<string, FixtureDocument>();
  const activeChildren = new Set<string>();
  const fromPlugin: Incoming[] = [];
  const toPlugin: Outgoing[] = [];
  const observedLifecycle: Array<{ phase: string; source: FrameSource; nonce: string }> = [];
  const observedBroadcastIngress: Array<{ source: FrameSource; identity: PluginFrameIdentity; origin: string; data: Record<string, unknown> }> = [];
  const rejectedOrOtherMessages: unknown[] = [];
  let documentSequence = 0;
  let draining = false;

  const broker = createPluginBroadcastChannelHost({
    sources,
    pluginId: () => "harris-snipaste",
    post: (source, message, identity) => sources.reply(source, identity, message),
    captureDocumentLease: (sender, nonce) => hostedIpc.captureDocumentLease(sender, nonce),
  });

  const router = createPluginPanelMessageRouter({
    isBlocked: () => false,
    handlePageMessage: () => false,
    identify: event => identifyPluginMessageEvent(sources, event),
    receiveMainPush: () => false,
    presentationDenied: () => false,
    rejectPresentationDenied: () => undefined,
    isActiveChild: windowId => activeChildren.has(windowId),
    unregisterChild: (windowId, source) => sources.unregisterChild(windowId, source),
    bindLifecycle: (event, identity, data) => {
      try {
        hostedIpc.bind(identity, event.source, identity, identity.kind === "main");
        if (data.__atools_hosted_ipc_document__ !== true) return false;
        const nonce = data.documentNonce;
        if (typeof nonce === "string" && (data.phase === "open" || data.phase === "close")) {
          observedLifecycle.push({ phase: data.phase, source: event.source as FrameSource, nonce });
        }
        let confirmedClose = false;
        if (data.phase === "close") {
          try {
            hostedIpc.captureDocumentLease({ source: event.source, identity }, nonce).assertCurrent();
            confirmedClose = true;
          } catch { /* A late close from an older document cannot clear its successor. */ }
        }
        const handled = hostedIpc.handleLifecycle({ source: event.source, identity }, data);
        if (handled && data.phase === "open") broker.prune();
        if (handled && data.phase === "close" && confirmedClose) broker.invalidateSource(event.source);
        return handled;
      } catch { return true; }
    },
    dispatchPermissions: () => false,
    dispatchAuthenticated: (event, data, identity) => {
      if (data.__atools_broadcast_channel__ === true)
        observedBroadcastIngress.push({ source: event.source as FrameSource, identity, origin: event.origin, data });
      if (!broker.dispatch(event.source, identity, data, event.origin)) rejectedOrOtherMessages.push(data);
    },
  });

  function frameSource(role: Role): FrameSource {
    const roleKey = key(role);
    const existing = sourceByRole.get(roleKey);
    if (existing) return existing;
    const source: FrameSource = { postMessage: () => undefined };
    sourceByRole.set(roleKey, source);
    return source;
  }

  function createDocument(options: {
    role: Role;
    html: string;
    url: string;
    hostKind?: "native" | "hosted";
    documentMode?: boolean;
    services?: Record<string, unknown>;
    closeWindow?: () => void;
  }): FixtureDocument {
    const roleKey = key(options.role), source = frameSource(options.role);
    const previous = activeDocuments.get(roleKey);
    const webContentsId = hostedIpc.reserve(options.role);
    if (options.role.kind === "child") activeChildren.add(options.role.windowId);
    const pageDocumentId = `plugin-document-${++documentSequence}`;
    const bootstrapNonce = (++documentSequence).toString(16).padStart(32, "0").slice(-32);
    // Main panel documents use the real document reservation/envelope. Native child
    // renderers remain opaque sandbox frames and therefore use the legacy source
    // identity with a null MessageEvent.origin, matching their production transport.
    const documentMode = options.documentMode ?? options.role.kind === "main";
    let identity: PluginFrameIdentity;
    if (documentMode) {
      const reservation = sources.reserveDocument({
        ...options.role,
        source,
        pageDocumentId,
        expectedOrigin: PLUGIN_ORIGIN,
        parentOrigin: PARENT_ORIGIN,
      });
      const activated = sources.activateDocument(reservation, bootstrapNonce);
      if (!activated) throw Error("Fixture could not activate its exact frame document reservation");
      identity = activated;
    } else {
      if (options.role.kind !== "child") throw Error("Only a hosted child can use the opaque legacy-source fixture");
      sources.registerChild(options.role.windowId, source);
      const current = sources.currentIdentityForHost(source);
      if (!current) throw Error("Fixture could not register its opaque child source");
      identity = current;
    }
    // Bind the source identity that the reservation just authenticated before the
    // bridge's FIFO open event, so the hosted lease is captured against that identity.
    hostedIpc.bind(options.role, source, identity, false);

    const origin = documentMode ? PLUGIN_ORIGIN : "null";
    const parent = {
      postMessage: (raw: unknown, targetOrigin = "*", _transfer?: Transferable[]) => {
        if (targetOrigin !== "*" && targetOrigin !== PARENT_ORIGIN) return;
        fromPlugin.push({ source, origin, data: structuredClone(raw) });
      },
    };
    const handoff = { runId: pageDocumentId, id: pageDocumentId, docNonce: bootstrapNonce, generation: identity.generation };
    const hostKind = options.hostKind ?? "hosted";
    const geometry = options.role.kind === "child" && hostKind === "native" ? {
      windowId: options.role.windowId,
      clientCreateId: `fixture-${options.role.windowId}`,
      ownerKey: JSON.stringify(["child", "fixture-parent", 1, "a".repeat(32), "document"]),
      instanceNonce: "b".repeat(32),
      documentGeneration: 1,
      documentNonce: bootstrapNonce,
      revision: 1,
      bounds: { x: 10.5, y: 21.25, width: 640, height: 480 },
      contentBounds: { x: 10.5, y: 21.25, width: 638, height: 450 },
      minimumSize: [0, 0],
      maximumSize: [0, 0],
      boundsSource: "native",
    } : null;
    const baseBridgeScript = documentMode
      ? pluginFrameTransportScript({ pageDocumentId, parentOrigin: PARENT_ORIGIN })
      : pluginFrameTransportScript();
    const bridge = createPluginBridgeDocument({
      action: snipasteFixtureAction(),
      windowType: options.role.kind === "main" ? "main" : "browserWindow",
      windowHostKind: hostKind,
      browserWindowId: options.role.kind === "child" ? options.role.windowId : "",
      geometrySnapshot: geometry,
      workerScope: "broadcast-channel-fixture",
      mainPushConfig: null,
      webContentsId,
      subInputEpoch: 1,
      appName: "ATools",
      appVersion: "test",
      baseBridgeScript,
    });
    const injected = injectPluginBridgeHtml(options.html, bridge);
    const dom = new JSDOM(injected, { url: options.url, runScripts: "outside-only", pretendToBeVisual: true });
    const window = dom.window as unknown as Window & typeof globalThis;
    Object.defineProperty(window, "parent", { configurable: true, value: parent });
    Object.defineProperty(window, "__ATOOLS_BOOTSTRAP_HANDOFF__", { configurable: true, value: handoff });
    Object.defineProperty(window, "TextEncoder", { configurable: true, value: TextEncoder });
    Object.defineProperty(window, "TextDecoder", { configurable: true, value: TextDecoder });
    Object.defineProperty(window, "structuredClone", { configurable: true, value: structuredClone });
    if (options.services) Object.defineProperty(window, "services", { configurable: true, value: options.services });
    if (options.closeWindow) Object.defineProperty(window, "close", { configurable: true, value: options.closeWindow });

    const record: FixtureDocument = {
      role: options.role, roleKey, webContentsId, source, parent, dom, window, origin,
      pageDocumentId, bootstrapNonce, identity, close: () => dom.window.close(),
    };
    activeDocuments.set(roleKey, record);
    source.postMessage = (message, targetOrigin = "*") => {
      const current = activeDocuments.get(roleKey);
      if (!current || (targetOrigin !== "*" && targetOrigin !== PLUGIN_ORIGIN)) return;
      toPlugin.push({ document: current, origin: PARENT_ORIGIN, data: structuredClone(message) });
    };

    const scripts = Array.from(window.document.querySelectorAll("script"));
    if (scripts.some(script => script.src)) throw Error("Fixture HTML has an external script that must be prepared through package resources first");
    for (const script of scripts) {
      const text = script.textContent ?? "";
      if (text.trim()) window.eval(text);
    }
    if (previous) previous.close();
    return record;
  }

  async function flush(limit = 1000) {
    if (draining) return;
    draining = true;
    try {
      for (let turn = 0; fromPlugin.length || toPlugin.length; turn++) {
        if (turn >= limit) throw Error("Fixture message queues did not settle");
        const incoming = fromPlugin.splice(0);
        for (const item of incoming) {
          const event = { source: item.source, origin: item.origin, data: item.data } as unknown as MessageEvent;
          router.handle(event);
          const lifecycle = item.data && typeof item.data === "object"
            ? item.data as Record<string, unknown> : undefined;
          const currentIdentity = sources.currentIdentityForHost(item.source);
          const currentDocument = activeDocuments.get(keyForSource(item.source));
          if (currentDocument && currentIdentity) currentDocument.identity = currentIdentity;
          if (lifecycle?.__atools_hosted_ipc_document__ === true && lifecycle.phase === "open") {
            const current = activeDocuments.get(keyForSource(item.source));
            if (current && typeof lifecycle.documentNonce === "string") current.hostedNonce = lifecycle.documentNonce;
          }
        }
        const outgoing = toPlugin.splice(0);
        for (const item of outgoing) {
          const current = activeDocuments.get(item.document.roleKey);
          if (current !== item.document) continue;
          const event = new item.document.window.MessageEvent("message", {
            data: item.data,
            origin: item.origin,
            source: item.document.parent as unknown as MessageEventSource,
          });
          item.document.window.dispatchEvent(event);
        }
        await Promise.resolve();
      }
    } finally { draining = false; }
  }

  function keyForSource(source: FrameSource) {
    for (const [roleKey, candidate] of sourceByRole) if (candidate === source) return roleKey;
    return "";
  }

  function spoofFrom(document: FixtureDocument, data: unknown, origin = document.origin) {
    router.handle({ source: document.source, origin, data } as unknown as MessageEvent);
  }

  function spoofFromSource(source: FrameSource, data: unknown, origin = PLUGIN_ORIGIN) {
    router.handle({ source, origin, data } as unknown as MessageEvent);
  }

  function close() {
    broker.close();
    hostedIpc.clear();
    for (const document of activeDocuments.values()) document.close();
    activeDocuments.clear();
    sources.clear();
  }

  return {
    createDocument,
    flush,
    spoofFrom,
    spoofFromSource,
    broker,
    sources,
    hostedIpc,
    observedLifecycle,
    observedBroadcastIngress,
    rejectedOrOtherMessages,
    activeDocuments,
    close,
  };
}

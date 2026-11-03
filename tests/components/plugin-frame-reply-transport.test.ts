import { describe, expect, it, vi } from "vitest";
import { MessageChannel as NodeMessageChannel, MessagePort as NodeMessagePort } from "node:worker_threads";
import { HostedBrowserWindowRpcHost } from "../../src/lib/hostedBrowserWindowRpc";
import { PluginFrameSourceRegistry, type PluginFrameReplyTarget } from "../../src/lib/pluginFrameDocumentIdentity";
import { createPluginHostedIpcRouter } from "../../src/lib/pluginHostedIpcRouter";
import { createPluginPanelFrameMounts } from "../../src/lib/pluginPanelFrameMount";

const CHILD_ID = "native-child";
const NONCE = "a".repeat(32);

function makeFrame(source: Window) {
  const listeners = new Set<EventListener>();
  return {
    node: {
      contentWindow: source,
      addEventListener: (_type: string, listener: EventListener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: EventListener) => listeners.delete(listener),
    } as unknown as HTMLIFrameElement,
    dispatchLoad() {
      for (const listener of [...listeners]) listener(new Event("load"));
    },
  };
}

function mountNativeChild(openBeforeLoad: boolean) {
  const sources = new PluginFrameSourceRegistry();
  const hostedIpc = createPluginHostedIpcRouter({ sources, creatorFor: () => undefined, timeoutMs: 100 });
  const role = { kind: "child" as const, windowId: CHILD_ID };
  const webContentsId = hostedIpc.reserve(role);
  const source = { postMessage: vi.fn() } as unknown as Window;
  const outgoing: Array<{ message: unknown; targetOrigin: string; transfer: Transferable[] }> = [];
  const readiness = vi.fn();
  const replyTarget: PluginFrameReplyTarget = {
    postMessage(message, targetOrigin, transfer = []) {
      outgoing.push({ message, targetOrigin, transfer });
      const init = message as Record<string, unknown>;
      if (init.__atools_hosted_browser_window_rpc_init__ === true) {
        const port = transfer[0] as MessagePort;
        port.postMessage({
          __atools_hosted_browser_window_rpc_ready__: true,
          generation: init.generation,
          documentNonce: NONCE,
        });
      }
    },
  };
  const rpc = new HostedBrowserWindowRpcHost({ createChannel: () => new NodeMessageChannel() as unknown as MessageChannel, timeoutMs: 100 });
  const frame = makeFrame(source);
  const frames = new Map<string, HTMLIFrameElement>();
  const childWindow = { id: CHILD_ID, clientCreateId: "create-native-child" } as any;
  const mounts = createPluginPanelFrameMounts({
    activePage: () => undefined,
    hasMainReservation: () => false,
    registerFrame: (frameRole, frameSource, ready, loaded, target) =>
      hostedIpc.registerFrame(frameRole, frameSource, ready, loaded, target),
    invalidateFrame: (frameRole, close, frameSource) => hostedIpc.invalidate(frameRole, close, frameSource),
    unregisterMain: frameSource => sources.unregisterMain(frameSource),
    registerChild: (windowId, frameSource, target) => sources.registerChild(windowId, frameSource, target),
    unregisterChild: (windowId, frameSource) => sources.unregisterChild(windowId, frameSource),
    currentIdentity: frameSource => sources.currentIdentityForHost(frameSource),
    bind: (frameRole, frameSource, identity, ready, target) => hostedIpc.bind(frameRole, frameSource, identity, ready, target),
    confirmReady: (frameRole, frameSource, nonce) => hostedIpc.confirmReady(frameRole, frameSource, nonce),
    readinessFailureIsCurrent: (frameRole, frameSource, nonce) =>
      hostedIpc.readinessFailureIsCurrent(frameRole, frameSource, nonce),
    sources,
    rpc,
    frames,
    windows: () => [childWindow],
    geometry: { synchronizeSelf: () => true },
    creators: new Map(),
    postReadiness: () => { readiness(); return true; },
    post: () => true,
    focusMainFrame: () => true,
    reportReady: () => {},
  });
  const action = mounts.pluginBrowserWindowFrame(frame.node, CHILD_ID, replyTarget);
  if (openBeforeLoad) {
    const identity = sources.currentIdentityForHost(source)!;
    hostedIpc.handleLifecycle({ source, identity }, {
      __atools_hosted_ipc_document__: true, webContentsId, documentNonce: NONCE, phase: "open",
    });
  }
  frame.dispatchLoad();
  return { action, frame, hostedIpc, outgoing, readiness, replyTarget, rpc, source, sources, webContentsId };
}

describe("native child reply transport", () => {
  it("keeps the iframe WindowProxy as identity and sends replies through its host target", () => {
    const sources = new PluginFrameSourceRegistry();
    const actualSource = { postMessage: vi.fn() };
    const targetPost = vi.fn();
    const replyTarget: PluginFrameReplyTarget = { postMessage: targetPost };
    sources.registerChild(CHILD_ID, actualSource, replyTarget);
    const identity = sources.currentIdentityForHost(actualSource)!;

    expect(sources.identifyEvent({ source: actualSource, origin: "null" })).toEqual(identity);
    expect(sources.identifyEvent({ source: replyTarget, origin: "null" })).toBeNull();
    expect(sources.reply(actualSource, identity, { result: "ready" })).toBe(true);
    expect(targetPost).toHaveBeenCalledWith({ result: "ready" }, "*");
    expect(actualSource.postMessage).not.toHaveBeenCalled();
  });

  it("rejects a replaced, unregistered, or cleared source without reusing an old reply target", () => {
    const sources = new PluginFrameSourceRegistry();
    const source = { postMessage: vi.fn() };
    const firstPost = vi.fn();
    const secondPost = vi.fn();
    const firstTarget: PluginFrameReplyTarget = { postMessage: firstPost };
    const secondTarget: PluginFrameReplyTarget = { postMessage: secondPost };
    sources.registerChild(CHILD_ID, source, firstTarget);
    const firstIdentity = sources.currentIdentityForHost(source)!;

    sources.registerChild(CHILD_ID, source, secondTarget);
    const secondIdentity = sources.currentIdentityForHost(source)!;
    expect(sources.reply(source, firstIdentity, "late-old-generation")).toBe(false);
    expect(firstPost).not.toHaveBeenCalled();
    expect(sources.reply(source, secondIdentity, "current-generation")).toBe(true);
    expect(secondPost).toHaveBeenCalledWith("current-generation", "*");

    sources.unregisterChild(CHILD_ID, source);
    expect(sources.reply(source, secondIdentity, "after-unregister")).toBe(false);
    sources.registerChild(CHILD_ID, source);
    const defaultIdentity = sources.currentIdentityForHost(source)!;
    expect(sources.reply(source, defaultIdentity, "default-target")).toBe(true);
    expect(source.postMessage).toHaveBeenCalledWith("default-target", "*");
    expect(secondPost).toHaveBeenCalledTimes(1);

    sources.clear();
    expect(sources.reply(source, defaultIdentity, "after-clear")).toBe(false);
    expect(source.postMessage).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("retains the native reply sender across lifecycle order (openBeforeLoad=%s)", async openBeforeLoad => {
    const f = mountNativeChild(openBeforeLoad);
    await f.rpc.waitReady(CHILD_ID);
    if (!openBeforeLoad) {
      const identity = f.sources.currentIdentityForHost(f.source)!;
      f.hostedIpc.handleLifecycle({ source: f.source, identity }, {
        __atools_hosted_ipc_document__: true, webContentsId: f.webContentsId, documentNonce: NONCE, phase: "open",
      });
    }
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const init = f.outgoing.find(entry => (entry.message as Record<string, unknown>).__atools_hosted_browser_window_rpc_init__ === true);
    expect(init).toBeDefined();
    expect(init?.targetOrigin).toBe("*");
    expect(init?.transfer).toHaveLength(1);
    expect(init?.transfer[0]).toBeInstanceOf(NodeMessagePort);
    expect(f.readiness).toHaveBeenCalledOnce();

    const identity = f.sources.currentIdentityForHost(f.source)!;
    expect(f.sources.identifyEvent({ source: f.source, origin: "null" })).toEqual(identity);
    expect(f.sources.reply(f.source, identity, { nativeResponse: true })).toBe(true);
    expect(f.outgoing.at(-1)).toMatchObject({ message: { nativeResponse: true }, targetOrigin: "*", transfer: [] });
    expect(f.source.postMessage).not.toHaveBeenCalled();

    f.action.destroy();
    expect(f.sources.reply(f.source, identity, { late: true })).toBe(false);
    expect(f.outgoing).toHaveLength(2);
  });

  it("keeps a slot sender across same-source lifecycle binds, then drops it on source replacement", () => {
    const sources = new PluginFrameSourceRegistry();
    const hostedIpc = createPluginHostedIpcRouter({ sources, creatorFor: () => undefined });
    const role = { kind: "child" as const, windowId: CHILD_ID };
    const webContentsId = hostedIpc.reserve(role);
    const source = { postMessage: vi.fn() };
    const reply = vi.fn();
    const replyTarget: PluginFrameReplyTarget = { postMessage: reply };
    sources.registerChild(CHILD_ID, source, replyTarget);
    const firstIdentity = sources.currentIdentityForHost(source)!;
    hostedIpc.bind(role, source, firstIdentity, false, replyTarget);
    hostedIpc.handleLifecycle({ source, identity: firstIdentity }, {
      __atools_hosted_ipc_document__: true, webContentsId, documentNonce: NONCE, phase: "open",
    });
    let currentIdentity = sources.currentIdentityForHost(source)!;
    hostedIpc.bind(role, source, currentIdentity);
    expect(sources.reply(source, currentIdentity, { afterLifecycle: true })).toBe(true);
    expect(reply).toHaveBeenCalledWith({ afterLifecycle: true }, "*");
    expect(source.postMessage).not.toHaveBeenCalled();

    const beforeSecondOpen = currentIdentity;
    hostedIpc.handleLifecycle({ source, identity: currentIdentity }, {
      __atools_hosted_ipc_document__: true, webContentsId, documentNonce: "b".repeat(32), phase: "open",
    });
    currentIdentity = sources.currentIdentityForHost(source)!;
    hostedIpc.bind(role, source, currentIdentity);
    expect(sources.reply(source, beforeSecondOpen, { staleNonce: true })).toBe(false);
    expect(sources.reply(source, currentIdentity, { afterSecondOpen: true })).toBe(true);
    expect(reply).toHaveBeenLastCalledWith({ afterSecondOpen: true }, "*");

    hostedIpc.invalidate(role);
    const replacement = { postMessage: vi.fn() };
    sources.registerChild(CHILD_ID, replacement);
    currentIdentity = sources.currentIdentityForHost(replacement)!;
    hostedIpc.bind(role, replacement, currentIdentity);
    expect(sources.reply(replacement, currentIdentity, { replacement: true })).toBe(true);
    expect(replacement.postMessage).toHaveBeenCalledWith({ replacement: true }, "*");
    expect(reply).toHaveBeenCalledTimes(2);
    expect(sources.reply(source, firstIdentity, { staleOwner: true })).toBe(false);
  });

  it.each(["remove", "clear"]) ("does not reuse a removed slot sender after %s when the source object is reused", mode => {
    const sources = new PluginFrameSourceRegistry();
    const hostedIpc = createPluginHostedIpcRouter({ sources, creatorFor: () => undefined });
    const role = { kind: "child" as const, windowId: CHILD_ID };
    let webContentsId = hostedIpc.reserve(role);
    const source = { postMessage: vi.fn() };
    const oldTargetPost = vi.fn();
    const oldTarget: PluginFrameReplyTarget = { postMessage: oldTargetPost };
    sources.registerChild(CHILD_ID, source, oldTarget);
    const oldIdentity = sources.currentIdentityForHost(source)!;
    hostedIpc.bind(role, source, oldIdentity, false, oldTarget);
    hostedIpc.handleLifecycle({ source, identity: oldIdentity }, {
      __atools_hosted_ipc_document__: true, webContentsId, documentNonce: NONCE, phase: "open",
    });

    if (mode === "remove") hostedIpc.invalidate(role, true);
    else hostedIpc.clearChildren();
    webContentsId = hostedIpc.reserve(role);
    sources.registerChild(CHILD_ID, source);
    const reboundIdentity = sources.currentIdentityForHost(source)!;
    hostedIpc.bind(role, source, reboundIdentity);
    hostedIpc.handleLifecycle({ source, identity: reboundIdentity }, {
      __atools_hosted_ipc_document__: true, webContentsId, documentNonce: "b".repeat(32), phase: "open",
    });
    const currentIdentity = sources.currentIdentityForHost(source)!;

    expect(sources.reply(source, oldIdentity, { stale: true })).toBe(false);
    expect(sources.reply(source, currentIdentity, { current: true })).toBe(true);
    expect(source.postMessage).toHaveBeenCalledWith({ current: true }, "*");
    expect(oldTargetPost).not.toHaveBeenCalled();
  });

  it("moves the mount to a new child id with a fresh reply route and rejects the old id identity", () => {
    const f = mountNativeChild(false);
    const oldIdentity = f.sources.currentIdentityForHost(f.source)!;
    const nextId = `${CHILD_ID}-next`;
    const nextWebContentsId = f.hostedIpc.reserve({ kind: "child", windowId: nextId });
    f.action.update(nextId);
    let currentIdentity = f.sources.currentIdentityForHost(f.source)!;
    f.hostedIpc.handleLifecycle({ source: f.source, identity: currentIdentity! }, {
      __atools_hosted_ipc_document__: true, webContentsId: nextWebContentsId, documentNonce: "b".repeat(32), phase: "open",
    });
    currentIdentity = f.sources.currentIdentityForHost(f.source)!;

    expect(f.sources.reply(f.source, oldIdentity, { oldId: true })).toBe(false);
    expect(f.sources.reply(f.source, currentIdentity!, { newId: true })).toBe(true);
    expect(f.outgoing.at(-1)).toMatchObject({ message: { newId: true }, targetOrigin: "*", transfer: [] });

    f.action.destroy();
    expect(f.sources.reply(f.source, currentIdentity!, { late: true })).toBe(false);
  });
});

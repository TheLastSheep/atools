import { describe, expect, it, vi } from "vitest";
import { PluginFrameSourceRegistry, isPluginDocumentIdentity } from "../../src/lib/pluginFrameDocumentIdentity";
import { createPluginHostedIpcRouter } from "../../src/lib/pluginHostedIpcRouter";
import { createPluginPanelMessageHost } from "../../src/lib/pluginPanelMessageHost";

const FLAG = "__atools_broadcast_channel__";
const mainNonce = "a".repeat(32);
const childNonce = "b".repeat(32);
const pluginId = "message-host-broadcast-fixture";
type Frame = { source: { postMessage: ReturnType<typeof vi.fn> }; webContentsId: number; nonce: string };

function setup() {
  const sources = new PluginFrameSourceRegistry();
  const hostedIpc = createPluginHostedIpcRouter({ sources, creatorFor: () => undefined });
  const makeFrame = (nonce: string): Frame => ({
    source: { postMessage: vi.fn((_message: unknown, _targetOrigin: string) => {}) },
    webContentsId: 0,
    nonce,
  });
  const main = makeFrame(mainNonce), child = makeFrame(childNonce);
  sources.setMain(main.source);
  sources.registerChild("child-window", child.source);
  main.webContentsId = hostedIpc.reserve({ kind: "main" });
  child.webContentsId = hostedIpc.reserve({ kind: "child", windowId: "child-window" });
  hostedIpc.bind({ kind: "main" }, main.source, sources.currentIdentityForHost(main.source)!, false);
  hostedIpc.bind({ kind: "child", windowId: "child-window" }, child.source,
    sources.currentIdentityForHost(child.source)!, false);

  const invoke = vi.fn(async () => undefined);
  const ensurePermission = vi.fn(async () => undefined);
  const createBrowserWindow = vi.fn(async () => undefined);
  const browserWindowAction = vi.fn(() => undefined);
  const runAppleScript = vi.fn(async () => "");
  const runCommand = vi.fn(async () => "");
  const shellOpen = vi.fn(async () => undefined);
  const action = { plugin_id: pluginId, plugin_name: "fixture", feature_code: "fixture", main_url: "index.html",
    plugin_path: "/fixture", expand_height: 0, payload: null };
  const portValues = {
    action: () => action,
    sources,
    hostedIpc,
    browserWindows: () => [{ id: "child-window" }],
    creatorFor: () => undefined,
    invoke,
    ensurePermission,
    createBrowserWindow,
    browserWindowAction,
    runAppleScript,
    runCommand,
    shellOpen,
    mainPushMode: () => "visible" as const,
    receiveMainPush: () => false,
    workerBlocking: () => false,
    closingActionIsCurrent: () => false,
    activePage: () => undefined,
    activeClipboard: () => undefined,
    activeDisplay: () => undefined,
    activeData: () => undefined,
    activeDialogs: () => undefined,
    activePaths: () => undefined,
    featureList: () => ({}),
    subInputState: () => ({}),
    dynamicFeatures: () => [],
    registeredTools: () => [],
    isDocumentIdentity: isPluginDocumentIdentity,
  };
  const ports = new Proxy(portValues, {
    get(target, key) { return key in target ? target[key as keyof typeof target] : () => undefined; },
  }) as any;
  const messageHost = createPluginPanelMessageHost(ports);
  function send(source: unknown, data: Record<string, unknown>, origin = "null") {
    messageHost.handleMessage({ source, origin, data } as MessageEvent);
  }
  function open(frame: Frame, role: { kind: "main" } | { kind: "child"; windowId: string }) {
    send(frame.source, { __atools_hosted_ipc_document__: true, phase: "open",
      webContentsId: frame.webContentsId, documentNonce: frame.nonce });
    if (role.kind === "child") expect(() => hostedIpc.captureReadyDocumentLease(frame.source)).toThrow(/not ready/);
  }
  function join(frame: Frame, channelId: string, name: string) {
    send(frame.source, { [FLAG]: true, op: "join", documentNonce: frame.nonce, channelId, name });
  }
  function post(frame: Frame, channelId: string, sequence: number, data: unknown, nonce = frame.nonce) {
    send(frame.source, { [FLAG]: true, op: "post", documentNonce: nonce, channelId, sequence, data });
  }
  function assertNoCapabilityPath() {
    expect(invoke).not.toHaveBeenCalled();
    expect(ensurePermission).not.toHaveBeenCalled();
    expect(createBrowserWindow).not.toHaveBeenCalled();
    expect(browserWindowAction).not.toHaveBeenCalled();
    expect(runAppleScript).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
    expect(shellOpen).not.toHaveBeenCalled();
  }
  return { main, child, hostedIpc, messageHost, send, open, join, post, assertNoCapabilityPath };
}

describe("BroadcastChannel through the production panel message host", () => {
  it("admits early joins without RPC readiness, routes delivery and ACK by exact hosted document", () => {
    const h = setup();
    try {
      h.open(h.main, { kind: "main" });
      h.open(h.child, { kind: "child", windowId: "child-window" });

      const fake = { postMessage: vi.fn() };
      h.send(fake, { [FLAG]: true, op: "join", documentNonce: childNonce,
        channelId: `${"f".repeat(32)}:1`, name: "room" });
      h.join(h.main, `${"a".repeat(32)}:1`, "room");
      h.join(h.child, `${"b".repeat(32)}:1`, "room");
      h.post(h.main, `${"a".repeat(32)}:1`, 1, "stale must not reserve sequence", "c".repeat(32));
      expect(h.main.source.postMessage).not.toHaveBeenCalled();
      expect(h.child.source.postMessage).not.toHaveBeenCalled();

      for (let sequence = 1; sequence <= 33; sequence++) h.post(h.main, `${"a".repeat(32)}:1`, sequence, { sequence });
      const childMessages = () => h.child.source.postMessage.mock.calls
        .map(call => call[0] as Record<string, unknown>).filter(message => message.op === "message");
      expect(childMessages()).toHaveLength(32);
      expect(childMessages()[0]).toMatchObject({ targetDocumentNonce: childNonce, name: "room", origin: "null",
        data: { sequence: 1 } });
      const mainAccepted = h.main.source.postMessage.mock.calls
        .map(call => call[0] as Record<string, unknown>).filter(message => message.op === "accepted");
      expect(mainAccepted.at(-1)).toMatchObject({ targetDocumentNonce: mainNonce, sequence: 33,
        error: "ERR_ATOOLS_BROADCAST_BUDGET" });

      const firstDeliveryId = childMessages()[0].deliveryId as number;
      h.send(h.child.source, { [FLAG]: true, op: "ack", documentNonce: childNonce, deliveryId: firstDeliveryId });
      h.post(h.main, `${"a".repeat(32)}:1`, 34, { sequence: 34 });
      expect(childMessages()).toHaveLength(33);
      expect(childMessages().at(-1)).toMatchObject({ data: { sequence: 34 } });
      expect(fake.postMessage).not.toHaveBeenCalled();
      h.assertNoCapabilityPath();
    } finally { h.messageHost.close(); h.hostedIpc.clear(); }
  });

  it("ignores stale close nonces and removes the exact document channels on current close", () => {
    const h = setup();
    try {
      h.open(h.main, { kind: "main" });
      h.open(h.child, { kind: "child", windowId: "child-window" });
      h.join(h.main, `${"a".repeat(32)}:1`, "close-room");
      h.join(h.child, `${"b".repeat(32)}:1`, "close-room");
      h.post(h.main, `${"a".repeat(32)}:1`, 1, "before stale close");

      h.send(h.child.source, { __atools_hosted_ipc_document__: true, phase: "close",
        webContentsId: h.child.webContentsId, documentNonce: "d".repeat(32) });
      h.post(h.main, `${"a".repeat(32)}:1`, 2, "after stale close");
      const messages = () => h.child.source.postMessage.mock.calls
        .map(call => call[0] as Record<string, unknown>).filter(message => message.op === "message");
      expect(messages()).toHaveLength(2);
      expect(messages().at(-1)?.data).toBe("after stale close");

      h.send(h.child.source, { __atools_hosted_ipc_document__: true, phase: "close",
        webContentsId: h.child.webContentsId, documentNonce: childNonce });
      h.post(h.main, `${"a".repeat(32)}:1`, 3, "after current close");
      expect(messages()).toHaveLength(2);

      const nextNonce = "e".repeat(32);
      h.child.nonce = nextNonce;
      h.open(h.child, { kind: "child", windowId: "child-window" });
      h.join(h.child, `${"e".repeat(32)}:1`, "close-room");
      h.post(h.main, `${"a".repeat(32)}:1`, 4, "after reopened document");
      expect(messages()).toHaveLength(3);
      expect(messages().at(-1)).toMatchObject({ targetDocumentNonce: nextNonce, data: "after reopened document" });
      h.assertNoCapabilityPath();
    } finally { h.messageHost.close(); h.hostedIpc.clear(); }
  });
});

import { describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { createPluginPanelFileDropHost } from "../../src/lib/pluginPanelFileDropHost";
import { createPluginHostedIpcRouter } from "../../src/lib/pluginHostedIpcRouter";
import { PluginFrameSourceRegistry } from "../../src/lib/pluginFrameDocumentIdentity";
import type { TaskRun } from "../../src/lib/types";

const PLUGIN = "fixture.plugin";
const REQUEST = "22222222-2222-4222-8222-222222222222";
const RUN = "44444444-4444-4444-8444-444444444444";
const UI_REQUEST = "55555555-5555-4555-8555-555555555555";
const LEASE = "33333333-3333-4333-8333-333333333333";
const NONCE = "0123456789abcdef0123456789abcdef";

function stubElementFromPoint(frame: HTMLIFrameElement) {
  const previous = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
  const point = vi.fn(() => frame);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: point });
  return { point, restore: () => {
    if (previous) Object.defineProperty(document, "elementFromPoint", previous);
    else Reflect.deleteProperty(document, "elementFromPoint");
  } };
}

function packet() {
  const raw = new TextEncoder().encode("payload"), header = new TextEncoder().encode(JSON.stringify({ requestId: REQUEST,
    leaseId: LEASE, expiresAt: Date.now() + 30_000, files: [{ name: "note.txt", path: "/private/note.txt",
      type: "text/plain", lastModified: 1, size: raw.byteLength, offset: 0 }] }));
  const value = new ArrayBuffer(9 + header.byteLength + raw.byteLength), bytes = new Uint8Array(value), view = new DataView(value);
  bytes.set([65, 84, 70, 68, 1]); view.setUint32(5, header.byteLength, true); bytes.set(header, 9); bytes.set(raw, 9 + header.byteLength);
  return value;
}

describe("owned native file-drop host flow", () => {
  it("uses the private request UUID, validates the approved TaskRun and delivers only to the captured frame", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const iframe = document.createElement("iframe"); document.body.append(iframe);
    Object.defineProperties(iframe, { clientWidth: { value: 640 }, clientHeight: { value: 480 }, offsetWidth: { value: 640 }, offsetHeight: { value: 480 } });
    iframe.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 480, width: 640, height: 480, toJSON() {} });
    const source = iframe.contentWindow!, registry = new PluginFrameSourceRegistry(); registry.setMain(source);
    const router = createPluginHostedIpcRouter({ sources: registry, creatorFor: () => undefined });
    const webContentsId = router.reserve({ kind: "main" });
    let identity = registry.currentIdentityForHost(source)!; router.bind({ kind: "main" }, source, identity, true);
    router.handleLifecycle({ source, identity }, { __atools_hosted_ipc_document__: true, phase: "open", webContentsId, documentNonce: NONCE });
    identity = registry.currentIdentityForHost(source)!;
    const { point, restore: restorePoint } = stubElementFromPoint(iframe);
    const messages: Record<string, unknown>[] = [];
    Object.defineProperty(source, "postMessage", { configurable: true, value: (data: Record<string, unknown>) => {
      messages.push(data);
      if (data.phase === "deliver") queueMicrotask(() => window.dispatchEvent(new MessageEvent("message", { source, data: {
          __atools_plugin_file_drop_ack__: true, documentNonce: NONCE, pluginId: PLUGIN, windowType: "main", windowId: "",
          frameGeneration: identity.generation, requestId: REQUEST, instanceId: data.instanceId, outcome: "dispatched", isTrusted: false,
          leaseId: LEASE, fileCount: 1, byteCount: 7,
        } })));
    } });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PLUGIN));
    const capability = "atools.host.file-drop." + [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("").slice(0, 24);
    const task: TaskRun = { id: RUN, capabilityId: capability, initiator: { type: "human", clientId: "atools-ui" }, status: "succeeded",
      input: { operation: "read", requestId: REQUEST }, output: { requestId: REQUEST, readCompleted: true, fileCount: 1,
        totalBytes: 7, runtime: "plugin-file-drop" }, artifacts: [], warnings: [], errors: [], actions: [], memoryIds: [], metrics: null,
      validation: { status: "not_run" } };
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const closeResolvers: Array<() => void> = [];
    const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
      calls.push({ command, args });
      if (command === "prepare_plugin_file_drop") return { requestId: REQUEST, tool: capability, runId: RUN,
        permission_required: true, request_id: UI_REQUEST, client_id: "atools-ui", arguments: { operation: "read", requestId: REQUEST },
        scopes: ["file_read"], retry_after_grant: true } as T;
      if (command === "get_task_run") return task as T;
      if (command === "get_plugin_file_drop_delivery") return packet() as T;
      if (command === "close_plugin_file_drop") return new Promise<void>(resolve => closeResolvers.push(resolve)) as T;
      return undefined as T;
    };
    const receivers = new Map<string, (event: { payload: unknown }) => void>();
    const status = vi.fn();
    const host = createPluginPanelFileDropHost({ pluginId: PLUGIN, isCurrent: () => true, invoke,
      listen: async (name, callback) => { receivers.set(name, callback); return () => { receivers.delete(name); }; },
      iframe: () => iframe, childFrames: new Map(), sources: registry, hostedIpc: router, onStatus: status, wait: async () => undefined });
    await host.start();
    receivers.get("atools://plugin-file-drop")!({ payload: { intentId: "66666666-6666-4666-8666-666666666666", xPhysical: 10, yPhysical: 10, scaleFactor: 1, fileCount: 1 } });
    await vi.waitFor(() => expect(calls.some(item => item.command === "get_plugin_file_drop_delivery")).toBe(true));
    const prepare = calls.find(item => item.command === "prepare_plugin_file_drop")!;
    expect(prepare.args).toMatchObject({ pluginId: PLUGIN, intentId: "66666666-6666-4666-8666-666666666666",
      frameGeneration: identity.generation, documentNonce: NONCE });
    expect(prepare.args).not.toHaveProperty("pageDocumentId");
    expect(prepare.args).not.toHaveProperty("documentId");
    expect(calls.find(item => item.command === "get_plugin_file_drop_delivery")?.args.requestId).toBe(REQUEST);
    expect(calls.find(item => item.command === "get_plugin_file_drop_delivery")?.args.requestId).not.toBe(UI_REQUEST);
    expect(calls.find(item => item.command === "get_plugin_file_drop_delivery")?.args).toEqual({ pluginId: PLUGIN,
      instanceId: prepare.args.instanceId, requestId: REQUEST });
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(1));
    expect(messages.filter(message => message.__atools_plugin_file_drop__ === true).map(message => message.phase)).toEqual(["bind", "deliver"]);
    expect(point).toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith(null);
    receivers.get("atools://plugin-file-drop-invalidated")!({ payload: { pluginId: null } });
    expect(messages.some(message => message.phase === "revokeAll")).toBe(true);
    expect(closeResolvers).toHaveLength(1);
    closeResolvers.splice(0).forEach(resolve => resolve());
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    expect(receivers.has("atools://plugin-file-drop")).toBe(true);
    receivers.get("atools://plugin-file-drop")!({ payload: { intentId: "77777777-7777-4777-8777-777777777777", xPhysical: 10, yPhysical: 10, scaleFactor: 1, fileCount: 1 } });
    await vi.waitFor(() => expect(messages.filter(message => message.phase === "deliver")).toHaveLength(2));
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(3));
    const closing = host.close();
    expect(messages.some(message => message.phase === "revoke" && message.leaseId === LEASE)).toBe(true);
    expect(closeResolvers).toHaveLength(1);
    closeResolvers.splice(0).forEach(resolve => resolve());
    await closing;
    expect(receivers.size).toBe(0);
    expect(calls.some(item => item.command === "close_plugin_file_drop")).toBe(true);
    restorePoint(); iframe.remove();
    vi.unstubAllGlobals();
  });

  it("cancels a registered owner while prepare is pending and closes again after its late response", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const iframe = document.createElement("iframe"); document.body.append(iframe);
    Object.defineProperties(iframe, { clientWidth: { value: 640 }, clientHeight: { value: 480 }, offsetWidth: { value: 640 }, offsetHeight: { value: 480 } });
    iframe.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 480, width: 640, height: 480, toJSON() {} });
    const source = iframe.contentWindow!, registry = new PluginFrameSourceRegistry(); registry.setMain(source);
    const router = createPluginHostedIpcRouter({ sources: registry, creatorFor: () => undefined });
    const webContentsId = router.reserve({ kind: "main" });
    let identity = registry.currentIdentityForHost(source)!; router.bind({ kind: "main" }, source, identity, true);
    router.handleLifecycle({ source, identity }, { __atools_hosted_ipc_document__: true, phase: "open", webContentsId, documentNonce: NONCE });
    identity = registry.currentIdentityForHost(source)!;
    const { restore: restorePoint } = stubElementFromPoint(iframe);
    let resolvePrepare!: (value: unknown) => void;
    const prepare = new Promise<unknown>(resolve => { resolvePrepare = resolve; });
    const calls: string[] = [];
    const invoke = async <T>(command: string): Promise<T> => {
      calls.push(command);
      if (command === "prepare_plugin_file_drop") return await prepare as T;
      return undefined as T;
    };
    const receivers = new Map<string, (event: { payload: unknown }) => void>();
    const host = createPluginPanelFileDropHost({ pluginId: PLUGIN, isCurrent: () => true, invoke,
      listen: async (name, callback) => { receivers.set(name, callback); return () => { receivers.delete(name); }; },
      iframe: () => iframe, childFrames: new Map(), sources: registry, hostedIpc: router, onStatus: vi.fn() });
    await host.start();
    receivers.get("atools://plugin-file-drop")!({ payload: { intentId: "66666666-6666-4666-8666-666666666666", xPhysical: 10, yPhysical: 10, scaleFactor: 1, fileCount: 1 } });
    await vi.waitFor(() => expect(calls).toContain("prepare_plugin_file_drop"));
    receivers.get("atools://plugin-file-drop-invalidated")!({ payload: { pluginId: "other.plugin" } });
    expect(calls).not.toContain("close_plugin_file_drop");
    receivers.get("atools://plugin-file-drop-invalidated")!({ payload: { pluginId: PLUGIN } });
    await vi.waitFor(() => expect(calls.filter(command => command === "close_plugin_file_drop")).toHaveLength(1));
    expect(calls.filter(command => command === "close_plugin_file_drop")).toHaveLength(1);
    expect(receivers.has("atools://plugin-file-drop")).toBe(true);
    resolvePrepare({ requestId: REQUEST, tool: "atools.host.file-drop.0123456789abcdef01234567", runId: RUN,
      permission_required: false });
    await vi.waitFor(() => expect(calls.filter(command => command === "close_plugin_file_drop")).toHaveLength(2));
    expect(calls).not.toContain("get_plugin_file_drop_delivery");
    await host.close(); restorePoint(); iframe.remove(); vi.unstubAllGlobals();
  });

  it("cancels when the frame moves under the same host hit point during prepare", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const iframe = document.createElement("iframe"); document.body.append(iframe);
    Object.defineProperties(iframe, { clientWidth: { value: 640 }, clientHeight: { value: 480 }, offsetWidth: { value: 640 }, offsetHeight: { value: 480 } });
    let left = 0;
    iframe.getBoundingClientRect = () => ({ x: left, y: 0, left, top: 0, right: left + 640, bottom: 480, width: 640, height: 480, toJSON() {} });
    const source = iframe.contentWindow!, registry = new PluginFrameSourceRegistry(); registry.setMain(source);
    const router = createPluginHostedIpcRouter({ sources: registry, creatorFor: () => undefined });
    const webContentsId = router.reserve({ kind: "main" });
    let identity = registry.currentIdentityForHost(source)!; router.bind({ kind: "main" }, source, identity, true);
    router.handleLifecycle({ source, identity }, { __atools_hosted_ipc_document__: true, phase: "open", webContentsId, documentNonce: NONCE });
    identity = registry.currentIdentityForHost(source)!;
    const { restore: restorePoint } = stubElementFromPoint(iframe);
    let resolvePrepare!: (value: unknown) => void;
    const prepare = new Promise<unknown>(resolve => { resolvePrepare = resolve; });
    const calls: string[] = [];
    const invoke = async <T>(command: string): Promise<T> => {
      calls.push(command);
      if (command === "prepare_plugin_file_drop") return await prepare as T;
      return undefined as T;
    };
    const receivers = new Map<string, (event: { payload: unknown }) => void>();
    const host = createPluginPanelFileDropHost({ pluginId: PLUGIN, isCurrent: () => true, invoke,
      listen: async (name, callback) => { receivers.set(name, callback); return () => { receivers.delete(name); }; },
      iframe: () => iframe, childFrames: new Map(), sources: registry, hostedIpc: router, onStatus: vi.fn() });
    await host.start();
    receivers.get("atools://plugin-file-drop")!({ payload: { intentId: "66666666-6666-4666-8666-666666666666", xPhysical: 10, yPhysical: 10, scaleFactor: 1, fileCount: 1 } });
    await vi.waitFor(() => expect(calls).toContain("prepare_plugin_file_drop"));
    left = 2;
    resolvePrepare({ requestId: REQUEST, tool: "atools.host.file-drop.0123456789abcdef01234567", runId: RUN,
      permission_required: false });
    await vi.waitFor(() => expect(calls).toContain("close_plugin_file_drop"));
    expect(calls).not.toContain("get_plugin_file_drop_delivery");
    await host.close(); restorePoint(); iframe.remove(); vi.unstubAllGlobals();
  });

  it("reports a current-document drop failure instead of suppressing it during cleanup", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const iframe = document.createElement("iframe"); document.body.append(iframe);
    Object.defineProperties(iframe, { clientWidth: { value: 640 }, clientHeight: { value: 480 }, offsetWidth: { value: 640 }, offsetHeight: { value: 480 } });
    iframe.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 480, width: 640, height: 480, toJSON() {} });
    const source = iframe.contentWindow!, registry = new PluginFrameSourceRegistry(); registry.setMain(source);
    const router = createPluginHostedIpcRouter({ sources: registry, creatorFor: () => undefined });
    const webContentsId = router.reserve({ kind: "main" });
    let identity = registry.currentIdentityForHost(source)!; router.bind({ kind: "main" }, source, identity, true);
    router.handleLifecycle({ source, identity }, { __atools_hosted_ipc_document__: true, phase: "open", webContentsId, documentNonce: NONCE });
    identity = registry.currentIdentityForHost(source)!;
    const { restore: restorePoint } = stubElementFromPoint(iframe);
    const status = vi.fn();
    const receivers = new Map<string, (event: { payload: unknown }) => void>();
    const host = createPluginPanelFileDropHost({ pluginId: PLUGIN, isCurrent: () => true,
      invoke: async <T>(command: string): Promise<T> => {
        if (command === "prepare_plugin_file_drop") throw new Error("native read denied");
        return undefined as T;
      }, listen: async (name, callback) => { receivers.set(name, callback); return () => { receivers.delete(name); }; },
      iframe: () => iframe, childFrames: new Map(), sources: registry, hostedIpc: router, onStatus: status });
    await host.start();
    receivers.get("atools://plugin-file-drop")!({ payload: { intentId: "66666666-6666-4666-8666-666666666666", xPhysical: 10, yPhysical: 10, scaleFactor: 1, fileCount: 1 } });
    await vi.waitFor(() => expect(status).toHaveBeenCalledWith("拖入文件未能交给插件；请重新拖入并按提示授权"));
    await host.close(); restorePoint(); iframe.remove(); vi.unstubAllGlobals();
  });
});

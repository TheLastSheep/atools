import { invoke } from "@tauri-apps/api/core";
import type { TaskRun } from "./types";
import type { PluginFrameIdentity, PluginFrameSourceRegistry } from "./pluginFrameDocumentIdentity";
import type { createPluginHostedIpcRouter } from "./pluginHostedIpcRouter";
import { mapPluginFileDropPoint } from "./pluginFileDropGeometry";
import { exactPluginFileDropBuffer, parsePluginFileDropPacket } from "./pluginFileDropPacket";

type NativeIntent = { intentId: string; xPhysical: number; yPhysical: number; scaleFactor: number; fileCount: number };
type FrameMap = Map<string, HTMLIFrameElement>;
type Lease = ReturnType<ReturnType<typeof createPluginHostedIpcRouter>["captureReadyDocumentLease"]>;
type Target = { frame: HTMLIFrameElement; source: Window; identity: PluginFrameIdentity; lease: Lease;
  role: "main" | "browserWindow"; windowId: string; point: ReturnType<typeof mapPluginFileDropPoint>; devicePixelRatio: number };
type Pending = { target: Target; event: NativeIntent; intentId: string; instanceId: string; cancelled: boolean;
  unbind: () => void; requestId?: string; leaseId?: string; cleanup?: Promise<void> };
type NativeOpen = { requestId?: string; request_id?: string; runId?: string; permission_required?: boolean;
  client_id?: string; tool?: string; arguments?: unknown; scopes?: string[]; error?: string; unavailable?: boolean;
  readCompleted?: boolean; fileCount?: number; totalBytes?: number; runtime?: string };
type Ports = { pluginId: string; isCurrent: () => boolean; invoke?: <T = unknown>(name: string, args?: Record<string, unknown>) => Promise<T>;
  listen: (event: string, receive: (event: { payload: unknown }) => void) => Promise<() => void>;
  iframe: () => HTMLIFrameElement | null; childFrames: FrameMap; sources: PluginFrameSourceRegistry;
  hostedIpc: ReturnType<typeof createPluginHostedIpcRouter>;
  onStatus: (message: string | null) => void; wait?: () => Promise<void>; now?: () => number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const toolName = /^atools\.host\.file-drop\.[0-9a-f]{24}$/;
const fail = (code: string) => new Error("ERR_ATOOLS_FILE_DROP_" + code);
async function expectedTool(pluginId: string) {
  if (!pluginId || pluginId.length > 256 || !globalThis.crypto?.subtle) throw fail("TOOL_ID_UNAVAILABLE");
  const pluginBytes = new TextEncoder().encode(pluginId);
  if (pluginBytes.byteLength > 256) throw fail("TOOL_ID_UNAVAILABLE");
  const digest = await crypto.subtle.digest("SHA-256", pluginBytes);
  const suffix = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("").slice(0, 24);
  return `atools.host.file-drop.${suffix}`;
}

/** Main-window native drop listener; every operation stays bound to one captured iframe document. */
export function createPluginPanelFileDropHost(ports: Ports) {
  const call = ports.invoke ?? invoke;
  const wait = ports.wait ?? (() => new Promise<void>(resolve => setTimeout(resolve, 200)));
  const now = ports.now ?? Date.now;
  let closed = false, unlisten: (() => void) | undefined;
  let unlistenInvalidated: (() => void) | undefined;
  const live = new Map<string, { target: Target; instanceId: string; leaseId: string; timer: ReturnType<typeof setTimeout>; unbind: () => void }>();
  const pending = new Map<string, Pending>();
  let handling = false;
  const current = () => !closed && ports.isCurrent();
  function locate(event: NativeIntent): Target {
    if (!Number.isFinite(event.xPhysical) || !Number.isFinite(event.yPhysical) || !Number.isFinite(event.scaleFactor)
      || event.scaleFactor <= 0 || !UUID.test(event.intentId) || !Number.isSafeInteger(event.fileCount) || event.fileCount < 1 || event.fileCount > 16) throw fail("INVALID_INTENT");
    const x = event.xPhysical / event.scaleFactor, y = event.yPhysical / event.scaleFactor;
    const top = document.elementFromPoint(x, y);
    if (!(top instanceof HTMLIFrameElement)) throw fail("NO_FRAME_TARGET");
    let role: "main" | "browserWindow" | undefined, windowId = "", frame: HTMLIFrameElement | null = null;
    if (top === ports.iframe()) { role = "main"; frame = top; }
    else for (const [id, child] of ports.childFrames) if (top === child) { role = "browserWindow"; windowId = id; frame = child; break; }
    if (!frame?.contentWindow || !role) throw fail("UNREGISTERED_FRAME");
    const source = frame.contentWindow;
    const identity = ports.sources.currentIdentityForHost(source);
    if (!identity || (role === "main" ? identity.kind !== "main" : identity.kind !== "child" || identity.windowId !== windowId)) throw fail("STALE_FRAME");
    const lease = ports.hostedIpc.captureReadyDocumentLease(source);
    const devicePixelRatio = window.devicePixelRatio;
    const point = mapPluginFileDropPoint(event, frame, devicePixelRatio);
    return { frame, source, identity, lease, role, windowId, point, devicePixelRatio };
  }
  function sameTarget(target: Target, event: NativeIntent) {
    target.lease.assertCurrent();
    if (!current() || !ports.sources.isCurrent(target.source, target.identity)
      || (target.role === "main" ? ports.iframe() !== target.frame : ports.childFrames.get(target.windowId) !== target.frame)
      || document.elementFromPoint(event.xPhysical / event.scaleFactor, event.yPhysical / event.scaleFactor) !== target.frame) throw fail("TARGET_CHANGED");
    const devicePixelRatio = window.devicePixelRatio;
    const point = mapPluginFileDropPoint(event, target.frame, devicePixelRatio);
    if (devicePixelRatio !== target.devicePixelRatio || point.x !== target.point.x || point.y !== target.point.y
      || point.contentWidth !== target.point.contentWidth || point.contentHeight !== target.point.contentHeight) throw fail("TARGET_CHANGED");
  }
  function isTargetCurrent(target: Target, event: NativeIntent) {
    try { sameTarget(target, event); return true; } catch { return false; }
  }
  async function discard(intentId: string) { await call("discard_plugin_file_drop_intent", { intentId }).catch(() => undefined); }
  function assertPending(item: Pending) {
    if (item.cancelled || pending.get(item.instanceId) !== item) throw fail("CANCELLED");
    sameTarget(item.target, item.event);
  }
  async function cancelPending(item: Pending, revokeAll = false) {
    if (item.cleanup) return item.cleanup;
    if (item.cancelled) return;
    item.cancelled = true;
    pending.delete(item.instanceId);
    item.unbind();
    if (revokeAll || item.leaseId) try { post(item.target, { phase: revokeAll ? "revokeAll" : "revoke",
      ...(item.leaseId ? { leaseId: item.leaseId } : {}), instanceId: item.instanceId,
      frameGeneration: item.target.identity.generation }); } catch { /* stale document */ }
    const cleanup = [discard(item.intentId)];
    cleanup.push(call("close_plugin_file_drop", { pluginId: ports.pluginId, instanceId: item.instanceId }).then(() => undefined, () => undefined));
    item.cleanup = Promise.all(cleanup).then(() => undefined);
    await item.cleanup;
  }
  async function invalidatePlugin(payload: unknown) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const value = payload as Record<string, unknown>;
    if (Object.keys(value).length !== 1 || !(value.pluginId === null || typeof value.pluginId === "string")) return;
    if (value.pluginId !== null && value.pluginId !== ports.pluginId) return;
    const cleanup: Promise<unknown>[] = [...pending.values()].map(item => cancelPending(item, true));
    for (const [key, item] of [...live]) {
      live.delete(key); clearTimeout(item.timer); item.unbind();
      try { post(item.target, { phase: "revokeAll", instanceId: item.instanceId,
        frameGeneration: item.target.identity.generation }); } catch { /* stale document */ }
      cleanup.push(call("close_plugin_file_drop", { pluginId: ports.pluginId, instanceId: item.instanceId }).catch(() => undefined));
    }
    await Promise.all(cleanup);
    ports.onStatus(null);
  }
  function validateRun(run: TaskRun | null, opened: NativeOpen, requestId: string, expectedCapability: string) {
    const input = run?.input, output = run?.output;
    if (!run || !opened.runId || run.id !== opened.runId || run.capabilityId !== expectedCapability
      || run.initiator?.type !== "human" || run.initiator?.clientId !== "atools-ui" || !input || typeof input !== "object" || Array.isArray(input)
      || (input as Record<string, unknown>).operation !== "read" || (input as Record<string, unknown>).requestId !== requestId
      || Object.keys(input).length !== 2 || !output || typeof output !== "object" || Array.isArray(output)
      || (output as Record<string, unknown>).requestId !== requestId || (output as Record<string, unknown>).readCompleted !== true
      || (output as Record<string, unknown>).runtime !== "plugin-file-drop"
      || !Number.isSafeInteger((output as Record<string, unknown>).fileCount) || Number((output as Record<string, unknown>).fileCount) < 1
      || Number((output as Record<string, unknown>).fileCount) > 16 || !Number.isSafeInteger((output as Record<string, unknown>).totalBytes)
      || Number((output as Record<string, unknown>).totalBytes) < 0 || Number((output as Record<string, unknown>).totalBytes) > 8 * 1024 * 1024) {
      throw fail("TASK_BINDING_MISMATCH");
    }
    return run;
  }
  async function waitForRun(opened: NativeOpen, requestId: string, expectedCapability: string, assertTarget: () => void): Promise<TaskRun> {
    if (opened.permission_required !== true) throw fail("INVALID_PERMISSION_TASK");
    if (!opened.runId || !UUID.test(opened.runId) || opened.tool !== expectedCapability || !toolName.test(opened.tool) || opened.client_id !== "atools-ui"
      || typeof opened.request_id !== "string" || !opened.request_id
      || !Array.isArray(opened.scopes) || opened.scopes.length !== 1 || opened.scopes[0] !== "file_read") throw fail("INVALID_PERMISSION_TASK");
    const args = opened.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args) || (args as Record<string, unknown>).operation !== "read"
      || (args as Record<string, unknown>).requestId !== requestId || Object.keys(args).length !== 2) throw fail("INVALID_PERMISSION_INPUT");
    const started = now();
    while (now() - started < 120_000) {
      await wait(); assertTarget();
      const run: TaskRun | null = await call<TaskRun | null>("get_task_run", { id: opened.runId }); assertTarget();
      if (!run || run.id !== opened.runId || run.capabilityId !== opened.tool || run.initiator?.type !== "human"
        || run.initiator?.clientId !== "atools-ui"
        || !run.input || typeof run.input !== "object" || Array.isArray(run.input)
        || (run.input as Record<string, unknown>).operation !== "read" || (run.input as Record<string, unknown>).requestId !== requestId
        || Object.keys(run.input).length !== 2) throw fail("TASK_BINDING_MISMATCH");
      if (run.status === "succeeded") return validateRun(run, opened, requestId, expectedCapability);
      if (["failed", "cancelled", "partial"].includes(run.status)) throw fail("PERMISSION_DENIED");
    }
    throw fail("PERMISSION_TIMEOUT");
  }
  function post(target: Target, data: Record<string, unknown>, transfer?: Transferable[]) {
    target.lease.assertCurrent();
    const origin = "expectedOrigin" in target.identity ? target.identity.expectedOrigin : "*";
    target.source.postMessage({ __atools_plugin_file_drop__: true, pluginId: ports.pluginId, windowType: target.role,
      windowId: target.windowId, frameGeneration: target.identity.generation, documentNonce: target.lease.documentNonce,
      ...(target.lease.pageDocumentId ? { pageDocumentId: target.lease.pageDocumentId } : {}), ...data }, origin, transfer ?? []);
  }
  async function acknowledgement(target: Target, requestId: string, instanceId: string, leaseId: string, fileCount: number, totalBytes: number) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(fail("ACK_TIMEOUT")), 2000);
      const finish = (error?: Error) => { clearTimeout(timer); window.removeEventListener("message", onMessage); error ? reject(error) : resolve(); };
      const onMessage = (event: MessageEvent) => {
        if (event.source !== target.source || !event.data || typeof event.data !== "object") return;
        const data = event.data as Record<string, unknown>;
        if (data.__atools_plugin_file_drop_ack__ !== true || data.documentNonce !== target.lease.documentNonce
          || data.pluginId !== ports.pluginId || data.windowType !== target.role || data.windowId !== target.windowId
          || data.frameGeneration !== target.identity.generation || data.requestId !== requestId || data.instanceId !== instanceId) return;
        finish(data.outcome === "dispatched" && data.isTrusted === false && data.leaseId === leaseId
          && data.fileCount === fileCount && data.byteCount === totalBytes ? undefined : fail("RECEIVER_REJECTED"));
      };
      window.addEventListener("message", onMessage);
    });
  }
  async function evictIfNeeded(target: Target, event: NativeIntent) {
    const entries = [...live.entries()].filter(([, item]) => item.target.source === target.source && item.target.identity.generation === target.identity.generation);
    if (entries.length < 4) return;
    const [key, old] = entries[0];
    live.delete(key); clearTimeout(old.timer); old.unbind();
    post(old.target, { phase: "revoke", leaseId: old.leaseId, instanceId: old.instanceId, frameGeneration: old.target.identity.generation });
    await call("close_plugin_file_drop", { pluginId: ports.pluginId, instanceId: old.instanceId }).catch(() => undefined);
    sameTarget(target, event);
  }
  async function handle(raw: unknown) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const event = raw as NativeIntent;
    if (Object.keys(raw).sort().join(",") !== "fileCount,intentId,scaleFactor,xPhysical,yPhysical") {
      if (typeof event.intentId === "string" && UUID.test(event.intentId)) await discard(event.intentId);
      return;
    }
    if (handling) { if (UUID.test(event.intentId)) await discard(event.intentId); return; }
    handling = true;
    let target: Target | undefined;
    let pendingOwner: Pending | undefined;
    try {
      target = locate(event); sameTarget(target, event);
      const instanceId = crypto.randomUUID();
      pendingOwner = { target, event, intentId: event.intentId, instanceId, cancelled: false, unbind: () => undefined };
      pending.set(instanceId, pendingOwner);
      pendingOwner.unbind = ports.sources.onFrameInvalidated(target.source, target.identity, () => { void cancelPending(pendingOwner!); });
      const assertOwner = () => assertPending(pendingOwner!);
      const capability = await expectedTool(ports.pluginId); assertOwner();
      post(target, { phase: "bind", instanceId, frameGeneration: target.identity.generation });
      const args = { pluginId: ports.pluginId, instanceId, intentId: event.intentId,
        ...(target.lease.pageDocumentId ? { pageDocumentId: target.lease.pageDocumentId } : {}),
        frameGeneration: target.identity.generation, documentNonce: target.lease.documentNonce };
      const opened = await call<NativeOpen>("prepare_plugin_file_drop", args);
      if (pendingOwner.cancelled) {
        await discard(event.intentId);
        await call("close_plugin_file_drop", { pluginId: ports.pluginId, instanceId }).catch(() => undefined);
        throw fail("CANCELLED");
      }
      if (opened?.requestId && UUID.test(opened.requestId)) pendingOwner.requestId = opened.requestId;
      assertOwner();
      if (!opened || opened.unavailable) throw fail("UNAVAILABLE");
      const requestId = opened.requestId;
      if (!requestId || !UUID.test(requestId) || opened.tool !== capability || !toolName.test(opened.tool)) throw fail("REQUEST_ID_MISSING");
      const permissionPending = opened.permission_required === true;
      let readRun: TaskRun;
      if (permissionPending) readRun = await waitForRun(opened, requestId, capability, assertOwner);
      else {
        if (!opened.runId || !UUID.test(opened.runId)) throw fail("TASK_BINDING_MISMATCH");
        const run = await call<TaskRun | null>("get_task_run", { id: opened.runId }); assertOwner();
        if (!run || run.status !== "succeeded" || opened.readCompleted !== true) throw fail(opened.error || "READ_NOT_COMPLETED");
        readRun = validateRun(run, opened, requestId, capability);
        const openedOutput = readRun.output as Record<string, unknown>;
        if (opened.fileCount !== openedOutput.fileCount || opened.totalBytes !== openedOutput.totalBytes
          || opened.runtime !== openedOutput.runtime) throw fail("TASK_BINDING_MISMATCH");
      }
      assertOwner();
      const delivery = await call<unknown>("get_plugin_file_drop_delivery", { pluginId: ports.pluginId, instanceId,
        requestId });
      assertOwner();
      if (!(delivery instanceof ArrayBuffer)) throw fail("BINARY_TRANSPORT_UNAVAILABLE");
      const packet = exactPluginFileDropBuffer(delivery);
      const parsed = parsePluginFileDropPacket(packet, requestId, now());
      pendingOwner.leaseId = parsed.leaseId;
      const fileCount = parsed.files.length, totalBytes = parsed.bytes.byteLength;
      const output = readRun.output as Record<string, unknown>;
      if (fileCount !== event.fileCount || output.fileCount !== fileCount || output.totalBytes !== totalBytes) {
        throw fail("FILE_COUNT_MISMATCH");
      }
      await evictIfNeeded(target, event);
      post(target, { phase: "deliver", instanceId, requestId, frameGeneration: target.identity.generation,
        x: target.point.x, y: target.point.y, contentWidth: target.point.contentWidth, contentHeight: target.point.contentHeight,
        packet }, [packet]);
      await acknowledgement(target, requestId, instanceId, parsed.leaseId, fileCount, totalBytes); assertOwner();
      const key = `${target.identity.generation}:${parsed.leaseId}`;
      const timer = setTimeout(() => { const item = live.get(key); if (!item) return; live.delete(key); item.unbind();
        try { post(item.target, { phase: "revoke", leaseId: item.leaseId, instanceId: item.instanceId, frameGeneration: item.target.identity.generation }); } catch { /* document is already stale */ }
        void call("close_plugin_file_drop", { pluginId: ports.pluginId, instanceId: item.instanceId }).catch(() => undefined);
      }, Math.max(1, parsed.expiresAt - now()));
      const unbind = ports.sources.onFrameInvalidated(target.source, target.identity, () => {
        const item = live.get(key); if (!item) return;
        live.delete(key); clearTimeout(item.timer); item.unbind();
        try { post(item.target, { phase: "revoke", leaseId: item.leaseId, instanceId: item.instanceId,
          frameGeneration: item.target.identity.generation }); } catch { /* the replaced document is already stale */ }
        void call("close_plugin_file_drop", { pluginId: ports.pluginId, instanceId: item.instanceId }).catch(() => undefined);
      });
      sameTarget(target, event);
      live.set(key, { target, instanceId, leaseId: parsed.leaseId, timer, unbind });
      pending.delete(instanceId); pendingOwner.unbind();
      ports.onStatus(null);
    } catch (error) {
      const wasCancelled = pendingOwner?.cancelled ?? false;
      if (pendingOwner) {
        if (!wasCancelled) await cancelPending(pendingOwner);
      }
      else if (event.intentId && UUID.test(event.intentId)) await discard(event.intentId);
      if (!wasCancelled && current() && (!target || isTargetCurrent(target, event))) ports.onStatus("拖入文件未能交给插件；请重新拖入并按提示授权");
    } finally {
      if (pendingOwner && pending.get(pendingOwner.instanceId) === pendingOwner) {
        pending.delete(pendingOwner.instanceId); pendingOwner.unbind();
      }
      handling = false;
    }
  }
  async function start() {
    if (!current() || unlisten) return;
    unlisten = await ports.listen("atools://plugin-file-drop", event => { void handle(event.payload); });
    if (!current()) { unlisten(); unlisten = undefined; return; }
    unlistenInvalidated = await ports.listen("atools://plugin-file-drop-invalidated", event => { void invalidatePlugin(event.payload); });
    if (!current()) { unlistenInvalidated(); unlistenInvalidated = undefined; unlisten?.(); unlisten = undefined; }
  }
  async function close() {
    if (closed) return;
    closed = true; unlisten?.(); unlisten = undefined; unlistenInvalidated?.(); unlistenInvalidated = undefined;
    const cleanup: Promise<unknown>[] = [...pending.values()].map(item => cancelPending(item));
    for (const item of live.values()) { clearTimeout(item.timer); item.unbind(); try { post(item.target, { phase: "revoke", leaseId: item.leaseId,
      instanceId: item.instanceId, frameGeneration: item.target.identity.generation }); } catch { /* document is already stale */ }
      cleanup.push(call("close_plugin_file_drop", { pluginId: ports.pluginId, instanceId: item.instanceId }).catch(() => undefined)); }
    live.clear();
    await Promise.all(cleanup);
    ports.onStatus(null);
  }
  return { start, close };
}

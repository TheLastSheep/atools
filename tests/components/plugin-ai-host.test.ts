import { afterEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "@tauri-apps/api/core";
import { createPluginAiBridge } from "../../src/lib/pluginAiBridge";
import { createPluginAiController } from "../../src/lib/pluginAiController";
import { createPluginBridgeDocument } from "../../src/lib/pluginPanelBridgeCompiler";
import { PluginFrameSourceRegistry, type PluginFrameIdentity } from "../../src/lib/pluginFrameDocumentIdentity";
import { createPluginHostedIpcRouter } from "../../src/lib/pluginHostedIpcRouter";
import type { TaskRun } from "../../src/lib/types";

vi.mock("@tauri-apps/api/core", async importOriginal => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, Channel: class TestChannel<T> { onmessage?: (message: T) => void } };
});

class TestPort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  peer?: TestPort;
  closed = false;
  listeners = new Set<(event: MessageEvent) => void>();
  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (type === "message") this.listeners.add(typeof listener === "function" ? listener as (event: MessageEvent) => void : event => listener.handleEvent(event));
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (type === "message") for (const value of this.listeners) if (value === listener) this.listeners.delete(value);
  }
  start() {}
  close() { this.closed = true; }
  postMessage(data: unknown) {
    if (this.closed || !this.peer || this.peer.closed) throw new Error("port closed");
    queueMicrotask(() => {
      const peer = this.peer!;
      if (peer.closed) return;
      const event = { data, currentTarget: peer } as MessageEvent;
      peer.onmessage?.(event); for (const listener of [...peer.listeners]) listener(event);
    });
  }
}
class TestChannel {
  port1 = new TestPort();
  port2 = new TestPort();
  constructor() { this.port1.peer = this.port2; this.port2.peer = this.port1; testChannels.push(this); }
}
const testChannels: TestChannel[] = [];

const UUIDS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
const TASK_RUN_ID = `run-${UUIDS[3]}`, APPROVAL_ID = `agent-confirm-${UUIDS[2]}`;
const pluginId = "ai-fixture-plugin";

describe("shared Plugin AI bridge and host", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("connects an exact live document port, streams deltas, collects full output, and honors caps/options", async () => {
    vi.stubGlobal("MessageChannel", TestChannel);
    let uuid = 0;
    vi.stubGlobal("crypto", { randomUUID: () => UUIDS[uuid++ % UUIDS.length], subtle: { digest: async () => new Uint8Array(32).fill(0xab).buffer } });
    const source = window.parent, identity: PluginFrameIdentity = { kind: "main", generation: 7 };
    let current = true;
    const sources = {
      identifyEvent: (event: MessageEvent) => event.source === source ? identity : null,
      isCurrent: (candidate: unknown) => current && candidate === source,
      onFrameInvalidated: (_candidate: unknown, _identity: PluginFrameIdentity, callback: () => void) => () => { if (!current) callback(); },
    } as unknown as PluginFrameSourceRegistry;
    const lease = { identity, documentNonce: "a".repeat(32), pageDocumentId: undefined, assertCurrent() { if (!current) throw new Error("stale"); } };
    const router = { captureReadyDocumentLease: (candidate: unknown) => { if (candidate !== source || !current) throw new Error("stale"); return lease; } } as unknown as ReturnType<typeof createPluginHostedIpcRouter>;
    const tool = "atools.plugin.ai." + "ab".repeat(12);
    let collectedMessage = { role: "assistant", content: "hello", reasoning_content: "thinking" };
    let approvalNext = false, invalidApprovalId: "bare-task" | "bare-request" | undefined, activeRequestId = "", pendingChannel: Channel<{ kind: "delta" | "terminal"; requestId: string; seq: number;
      delta?: { content?: string; reasoning_content?: string }; status?: "succeeded"; outputBytes?: number }> | undefined;
    let holdPrepare = false, releasePrepare!: () => void, failCancel = false;
    const prepareGate = new Promise<void>(resolve => { releasePrepare = resolve; });
    let holdExecution = false, releaseExecution!: () => void;
    const executionGate = new Promise<void>(resolve => { releaseExecution = resolve; });
    let holdModels = false, releaseModels!: () => void;
    const modelsGate = new Promise<void>(resolve => { releaseModels = resolve; });
    let nextNativeDeltaBytes: number | undefined;
    const taskFor = (requestId: string): TaskRun => ({ id: TASK_RUN_ID, capabilityId: tool, status: "succeeded",
      initiator: { type: "human", clientId: "atools-ui" }, input: { operation: "execute", requestId },
      output: { requestId, status: "completed", outputBytes: 24, deltaCount: 1 } } as TaskRun);
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const invoke = vi.fn(async <T>(command: string, args: Record<string, unknown> = {}) => {
      calls.push({ command, args });
      if (command === "list_plugin_ai_models") {
        if (holdModels) await modelsGate;
        return { configured: true, models: [{ id: "provider/default", value: "provider/default", label: "provider/default" }] } as T;
      }
      if (command === "prepare_plugin_ai_request") {
        const clientRequestId = args.clientRequestId as string;
        activeRequestId = clientRequestId;
        if (holdPrepare) await prepareGate;
        return { ok: true, requestId: clientRequestId, clientRequestId,
          model: "provider/default", expiresInMs: 120_000 } as T;
      }
      if (command === "execute_plugin_ai_request") {
        const channel = args.onDelta as Channel<{ kind: "delta" | "terminal"; requestId: string; seq: number; delta?: { content?: string; reasoning_content?: string }; status?: "succeeded"; outputBytes?: number }>;
        if (approvalNext) {
          approvalNext = false; pendingChannel = channel;
          return { permission_required: true, runId: invalidApprovalId === "bare-task" ? UUIDS[3] : TASK_RUN_ID,
            request_id: invalidApprovalId === "bare-request" ? UUIDS[2] : APPROVAL_ID, client_id: "atools-ui", tool,
            arguments: { operation: "execute", requestId: args.requestId }, scopes: ["network"], retry_after_grant: true } as T;
        }
        if (holdExecution) await executionGate;
        let content = "hello", delta: { content?: string; reasoning_content?: string } = { content, reasoning_content: "thinking" };
        if (nextNativeDeltaBytes !== undefined) {
          const empty = { kind: "delta", requestId: args.requestId as string, seq: 1, delta: { content: "" } };
          content = "x".repeat(nextNativeDeltaBytes - new TextEncoder().encode(JSON.stringify(empty)).byteLength);
          delta = { content };
          if (new TextEncoder().encode(JSON.stringify({ ...empty, delta })).byteLength !== nextNativeDeltaBytes) throw new Error("fixture event size mismatch");
          nextNativeDeltaBytes = undefined;
        }
        channel.onmessage?.({ kind: "delta", requestId: args.requestId as string, seq: 1, delta });
        channel.onmessage?.({ kind: "terminal", requestId: args.requestId as string, seq: 2, status: "succeeded", outputBytes: 24 });
        return { status: "completed", requestId: args.requestId, model: "provider/default", outputBytes: 24, deltaCount: 1 } as T;
      }
      if (command === "ack_plugin_ai_delta") return undefined as T;
      if (command === "take_plugin_ai_result") return { requestId: args.requestId, model: "provider/default",
        outputBytes: new TextEncoder().encode(collectedMessage.content).byteLength + new TextEncoder().encode(collectedMessage.reasoning_content ?? "").byteLength,
        message: collectedMessage } as T;
      if (command === "get_task_run") {
        pendingChannel?.onmessage?.({ kind: "delta", requestId: activeRequestId, seq: 1, delta: { content: "approved" } });
        pendingChannel?.onmessage?.({ kind: "terminal", requestId: activeRequestId, seq: 2, status: "succeeded", outputBytes: 8 });
        pendingChannel = undefined;
        return taskFor(activeRequestId) as T;
      }
      if (command === "cancel_plugin_ai_request") { if (failCancel) throw new Error("fixture cancel unavailable"); return undefined as T; }
      throw new Error("unexpected command " + command);
    });
    const controller = createPluginAiController({ pluginId, invoke, isCurrent: () => current, sources, hostedIpc: router, targetWindow: window, wait: async () => {} });
    const dispatchFrameMessage = (data: unknown, port: TestPort) => {
      const event = new Event("message");
      Object.defineProperties(event, { source: { value: source }, origin: { value: "null" }, data: { value: data }, ports: { value: [port as unknown as MessagePort] } });
      window.dispatchEvent(event);
    };
    const foreignPort = new TestPort();
    current = false;
    dispatchFrameMessage({ protocol: "another-host" }, foreignPort);
    current = true;
    expect(foreignPort.closed).toBe(false);
    const malformedAiPort = new TestPort();
    dispatchFrameMessage({ __atools_plugin_ai_connect__: true, pluginId: "other-plugin", connectId: UUIDS[0] }, malformedAiPort);
    expect(malformedAiPort.closed).toBe(true);
    const pageTarget = new EventTarget() as unknown as Window;
    Object.defineProperty(pageTarget, "crypto", { value: { randomUUID: () => UUIDS[uuid++ % UUIDS.length] } });
    const transport = { post: (data: Record<string, unknown>, transfer: Transferable[] = []) => {
      const event = new Event("message");
      Object.defineProperties(event, { source: { value: source }, origin: { value: "null" }, data: { value: data }, ports: { value: transfer } });
      window.dispatchEvent(event); return true;
    } };
    const api = createPluginAiBridge(pluginId, pageTarget, transport);
    const modelsPromise = api.allAiModels();
    await expect(modelsPromise).resolves.toEqual([{ id: "provider/default", value: "provider/default", label: "provider/default" }]);
    const response = api.ai({ messages: [{ role: "user", content: "question" }] });
    await expect(response).resolves.toEqual({ role: "assistant", content: "hello", reasoning_content: "thinking" });
    collectedMessage = { role: "assistant", content: "😀".repeat(262_144) };
    await expect(api.ai({ messages: [{ role: "user", content: "raw budget" }] })).resolves.toEqual(collectedMessage);
    collectedMessage = { role: "assistant", content: "hello", reasoning_content: "thinking" };
    await expect(api.ai({ messages: Array.from({ length: 64 }, () => ({ role: "user", content: "x" })) })).resolves.toEqual({
      role: "assistant", content: "hello", reasoning_content: "thinking" });
    const deltas: Array<{ content?: string; reasoning_content?: string }> = [];
    await expect(api.ai({ messages: [{ role: "user", content: "stream" }] }, delta => deltas.push(delta))).resolves.toBeUndefined();
    expect(deltas).toEqual([{ content: "hello", reasoning_content: "thinking" }]);
    approvalNext = true;
    const approvedDeltas: Array<{ content?: string; reasoning_content?: string }> = [];
    await expect(api.ai({ messages: [{ role: "user", content: "approval" }] }, delta => approvedDeltas.push(delta))).resolves.toBeUndefined();
    expect(approvedDeltas).toEqual([{ content: "approved" }]);
    expect(calls.filter(value => value.command === "get_task_run")).toHaveLength(1);
    expect(calls.filter(value => value.command === "ack_plugin_ai_delta")).toHaveLength(10);
    expect(calls.filter(value => value.command === "take_plugin_ai_result")).toHaveLength(3);
    invalidApprovalId = "bare-task"; approvalNext = true;
    await expect(api.ai({ messages: [{ role: "user", content: "bare task run id" }] }, () => undefined))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_PLUGIN_AI_PERMISSION_ENVELOPE" });
    invalidApprovalId = "bare-request"; approvalNext = true;
    await expect(api.ai({ messages: [{ role: "user", content: "bare approval id" }] }, () => undefined))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_PLUGIN_AI_PERMISSION_ENVELOPE" });
    invalidApprovalId = undefined;
    holdPrepare = true;
    const beforePrepareCount = calls.filter(value => value.command === "prepare_plugin_ai_request").length;
    const aborted = api.ai({ messages: [{ role: "user", content: "cancel" }] });
    await vi.waitFor(() => expect(calls.filter(value => value.command === "prepare_plugin_ai_request")).toHaveLength(beforePrepareCount + 1));
    failCancel = true;
    aborted.abort(); releasePrepare();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    holdPrepare = false;
    await expect(api.ai({ messages: [{ role: "user", content: "after abort" }] })).resolves.toEqual({
      role: "assistant", content: "hello", reasoning_content: "thinking" });
    failCancel = false;
    await vi.waitFor(() => expect(calls.filter(value => value.command === "cancel_plugin_ai_request").length).toBeGreaterThan(0));
    expect(() => api.ai({ messages: Array.from({ length: 65 }, () => ({ role: "user", content: "x" })) })).toThrow("ERR_ATOOLS_PLUGIN_AI_UNSUPPORTED_OPTIONS");
    expect(calls.filter(value => value.command === "execute_plugin_ai_request")).toHaveLength(8);
    for (const entry of calls.filter(value => value.command !== "get_task_run")) {
      expect(entry.args.pluginId).toBe(pluginId);
      expect(entry.args.instanceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(entry.args.frameGeneration).toBe(7);
      expect(entry.args.documentNonce).toBe("a".repeat(32));
    }
    expect(() => api.ai({ messages: [{ role: "user", content: "x" }], tools: [] })).toThrow("ERR_ATOOLS_PLUGIN_AI_UNSUPPORTED_OPTIONS");
    expect(() => api.ai({ messages: ["x".repeat(3 * 1024 * 1024 + 1)] })).toThrow("ERR_ATOOLS_PLUGIN_AI_REQUEST_TOO_LARGE");
    holdExecution = true;
    const detached = api.ai({ messages: [{ role: "user", content: "disconnect" }] });
    const executeCount = calls.filter(value => value.command === "execute_plugin_ai_request").length;
    await vi.waitFor(() => expect(calls.filter(value => value.command === "execute_plugin_ai_request")).toHaveLength(executeCount + 1));
    expect(() => api.ai({ messages: [{ role: "user", content: "overflow" }] })).toThrow("ERR_ATOOLS_PLUGIN_AI_BUSY");
    pageTarget.dispatchEvent(new Event("atools-plugin-out"));
    await expect(detached).rejects.toMatchObject({ code: "ERR_ATOOLS_PLUGIN_AI_CLOSED" });
    releaseExecution();
    await vi.waitFor(() => expect(calls.filter(value => value.command === "cancel_plugin_ai_request").length).toBeGreaterThan(1));

    const hostClosedTarget = new EventTarget() as unknown as Window;
    Object.defineProperty(hostClosedTarget, "crypto", { value: { randomUUID: () => UUIDS[uuid++ % UUIDS.length] } });
    const hostClosedApi = createPluginAiBridge(pluginId, hostClosedTarget, transport);
    const acceptedBoundary: string[] = [];
    nextNativeDeltaBytes = 16 * 1024;
    await expect(hostClosedApi.ai({ messages: [{ role: "user", content: "native max" }] }, delta => acceptedBoundary.push(delta.content ?? ""))).resolves.toBeUndefined();
    const boundaryRequestId = calls.filter(value => value.command === "execute_plugin_ai_request").at(-1)?.args.requestId;
    expect(new TextEncoder().encode(JSON.stringify({ kind: "delta", requestId: boundaryRequestId, seq: 1,
      delta: { content: acceptedBoundary[0] } })).byteLength).toBe(16 * 1024);
    nextNativeDeltaBytes = 16 * 1024 + 1;
    await expect(hostClosedApi.ai({ messages: [{ role: "user", content: "native over limit" }] }, () => undefined))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_PLUGIN_AI_CHANNEL_INVALID" });
    expect(calls.filter(value => value.command === "execute_plugin_ai_request")).toHaveLength(11);
    holdModels = true;
    const beforeModelCalls = calls.filter(value => value.command === "list_plugin_ai_models").length;
    const disconnected = hostClosedApi.allAiModels();
    await vi.waitFor(() => expect(calls.filter(value => value.command === "list_plugin_ai_models")).toHaveLength(beforeModelCalls + 1));
    const pagePort = testChannels.at(-1)!.port1;
    let busyModelReply = false;
    const duplicateCallId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    pagePort.addEventListener("message", event => {
      if (event.data?.kind === "reply" && event.data.callId === duplicateCallId
        && event.data.ok === false && event.data.code === "ERR_ATOOLS_PLUGIN_AI_BUSY") busyModelReply = true;
    });
    pagePort.postMessage({ kind: "request", callId: duplicateCallId, operation: "models" });
    await vi.waitFor(() => expect(busyModelReply).toBe(true));
    expect(calls.filter(value => value.command === "list_plugin_ai_models")).toHaveLength(beforeModelCalls + 1);
    await expect(hostClosedApi.allAiModels()).rejects.toMatchObject({ code: "ERR_ATOOLS_PLUGIN_AI_BUSY" });
    controller.close();
    await expect(disconnected).rejects.toMatchObject({ code: "ERR_ATOOLS_PLUGIN_AI_DISCONNECTED" });
    releaseModels();
  });

  it("starts a fresh running deadline after a permission wait", async () => {
    vi.stubGlobal("MessageChannel", TestChannel);
    let uuid = 0, now = 1_000, polls = 0, waitCount = 0, blockPoll = false;
    let markPollStarted!: () => void, releasePoll!: () => void;
    const pollStarted = new Promise<void>(resolve => { markPollStarted = resolve; });
    const pollGate = new Promise<void>(resolve => { releasePoll = resolve; });
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.stubGlobal("crypto", { randomUUID: () => UUIDS[uuid++ % UUIDS.length], subtle: { digest: async () => new Uint8Array(32).fill(0xab).buffer } });
    const source = window.parent, identity: PluginFrameIdentity = { kind: "main", generation: 7 };
    const sources = { identifyEvent: () => identity, isCurrent: () => true, onFrameInvalidated: () => () => undefined } as unknown as PluginFrameSourceRegistry;
    const lease = { identity, documentNonce: "b".repeat(32), pageDocumentId: undefined, assertCurrent() {} };
    const router = { captureReadyDocumentLease: () => lease } as unknown as ReturnType<typeof createPluginHostedIpcRouter>;
    const tool = "atools.plugin.ai." + "ab".repeat(12);
    let channel: Channel<{ kind: "delta" | "terminal"; requestId: string; seq: number; delta?: { content?: string }; status?: "succeeded"; outputBytes?: number }> | undefined;
    const invoke = vi.fn(async <T>(command: string, args: Record<string, unknown> = {}) => {
      if (command === "list_plugin_ai_models") return { configured: true, models: [{ id: "m", value: "m", label: "m" }] } as T;
      if (command === "prepare_plugin_ai_request") return { ok: true, requestId: UUIDS[1], clientRequestId: args.clientRequestId, model: "m", expiresInMs: 120_000 } as T;
      if (command === "execute_plugin_ai_request") {
        channel = args.onDelta as typeof channel;
        return { permission_required: true, runId: TASK_RUN_ID, request_id: APPROVAL_ID, client_id: "atools-ui", tool,
          arguments: { operation: "execute", requestId: UUIDS[1] }, scopes: ["network"], retry_after_grant: true } as T;
      }
      if (command === "get_task_run") {
        polls += 1;
        const status = (["awaiting_permission", "running", "succeeded"] as const)[polls - 1];
        if (status === "succeeded") {
          channel?.onmessage?.({ kind: "delta", requestId: UUIDS[1], seq: 1, delta: { content: "ok" } });
          channel?.onmessage?.({ kind: "terminal", requestId: UUIDS[1], seq: 2, status, outputBytes: 2 });
        }
        return { id: TASK_RUN_ID, capabilityId: tool, status, initiator: { type: "human", clientId: "atools-ui" },
          input: { operation: "execute", requestId: UUIDS[1] }, output: { requestId: UUIDS[1], status: "completed", outputBytes: 2, deltaCount: 1 } } as T;
      }
      if (command === "ack_plugin_ai_delta" || command === "cancel_plugin_ai_request") return undefined as T;
      throw new Error("unexpected command " + command);
    });
    const controller = createPluginAiController({ pluginId, invoke, isCurrent: () => true, sources, hostedIpc: router, targetWindow: window,
      wait: async () => {
        if (blockPoll) { markPollStarted(); await pollGate; return; }
        now += [70_000, 40_000, 110_000][waitCount++] ?? 1;
      } });
    const pageTarget = new EventTarget() as unknown as Window;
    Object.defineProperty(pageTarget, "crypto", { value: { randomUUID: () => UUIDS[uuid++ % UUIDS.length] } });
    const api = createPluginAiBridge(pluginId, pageTarget, { post: (data, transfer = []) => {
      const event = new Event("message");
      Object.defineProperties(event, { source: { value: source }, origin: { value: "null" }, data: { value: data }, ports: { value: transfer } });
      window.dispatchEvent(event); return true;
    } });
    await expect(api.ai({ messages: [{ role: "user", content: "deadline" }] }, () => undefined)).resolves.toBeUndefined();
    expect(polls).toBe(3);
    blockPoll = true;
    const pendingApproval = api.ai({ messages: [{ role: "user", content: "cancel approval wait" }] }, () => undefined);
    await pollStarted;
    const callsBeforeCancel = invoke.mock.calls.filter(call => call[0] === "get_task_run").length;
    pendingApproval.abort();
    await expect(pendingApproval).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(invoke.mock.calls.some(call => call[0] === "cancel_plugin_ai_request")).toBe(true));
    expect(invoke.mock.calls.filter(call => call[0] === "get_task_run")).toHaveLength(callsBeforeCancel);
    releasePoll();
    controller.close(); api.close();
  });

  it("installs the public methods after the actual UTools bridge in the production compiler output", () => {
    const script = createPluginBridgeDocument({ action: { plugin_id: pluginId, plugin_name: "AI fixture", feature_code: "ai",
      main_url: "index.html", plugin_path: "/fixture", expand_height: 0, payload: null }, windowType: "main", browserWindowId: "",
      geometrySnapshot: null, workerScope: "fixture", mainPushConfig: null, webContentsId: 3, subInputEpoch: 0, appName: "ATools", appVersion: "test" });
    expect(script.indexOf("window.utools =")).toBeLessThan(script.indexOf("data-atools-plugin-ai"));
    expect(script).toContain("target.allAiModels=api.allAiModels;target.ai=api.ai");
    expect(script).toContain("MessageChannel");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishedScenarioContext, RuntimeState, TaskRun } from "./nativePublishedPluginCommon";
const baselineTransport = vi.hoisted(() => ({ invoke: vi.fn(), nonce: "a".repeat(32) as string | undefined }));
vi.mock("./nativePublishedPluginCommon", async original => ({
  ...(await original<typeof import("./nativePublishedPluginCommon")>()),
  invoke: baselineTransport.invoke,
  currentPublishedFrameDocument: () => baselineTransport.nonce,
}));
import registry from "../fixtures/converted-source-cases.json";
import { requiresLegacyNodeSession } from "./nativePublishedRuntimeRequirement";
import { isDeepReadStorageWrite, isExactAwaitingDeepReadDataRun, isExactAwaitingDeepReadNodeRun,
  matchesDeepReadDataRequest, matchesExactDeepReadNodeRequest, isDeepReadFilesFeatureTaskRun,
  summarizeDeepReadFilesStorageRuns, waitForDeepReadActivationReadiness, captureDeepReadFrameIdentity,
  waitForDeepReadDataIdleBaseline }
  from "./nativeDeepReadReviewedPermissionFlow";

const dataRequest = { id: "request-1", run_id: "run-1", client_id: "atools-ui", tool_name: "atools.host.data.14ff3d75f7a75dc386ed3777", scopes: ["plugin_data"] };
const awaitingRun = { id: "run-1", capabilityId: dataRequest.tool_name, initiator: { clientId: "atools-ui" }, status: "awaiting_permission" } as TaskRun;

describe("fixed DeepRead permission flow", () => {
  it("matches only the single exact data request and its own pending TaskRun", () => {
    const request = matchesDeepReadDataRequest("DeepRead 深读 请求访问自己的数据", [dataRequest]);
    expect(request).toEqual(dataRequest);
    expect(isExactAwaitingDeepReadDataRun(awaitingRun, request!)).toBe(true);
    expect(matchesDeepReadDataRequest("Other 请求访问自己的数据", [dataRequest])).toBeNull();
    expect(matchesDeepReadDataRequest("DeepRead 深读 请求访问自己的数据", [dataRequest, dataRequest])).toBeNull();
    expect(matchesDeepReadDataRequest("DeepRead 深读 请求访问自己的数据", [{ ...dataRequest, client_id: "other" }])).toBeNull();
    expect(matchesDeepReadDataRequest("DeepRead 深读 请求访问自己的数据", [{ ...dataRequest, scopes: ["plugin_data", "file_read"] }])).toBeNull();
    expect(isExactAwaitingDeepReadDataRun({ ...awaitingRun, id: "other" }, request!)).toBe(false);
    expect(isExactAwaitingDeepReadDataRun({ ...awaitingRun, status: "succeeded" }, request!)).toBe(false);
  });

  it("binds the import TaskRun to the fixed owner and redacted one-file array payload summary", () => {
    const before = new Set(["old-run"]);
    const expectedBytes = 68;
    const run = (id: string, input: unknown): TaskRun & { input: unknown } => ({
      ...awaitingRun, id, capabilityId: "plugin.feature.deepread-import", status: "succeeded", input,
    } as TaskRun & { input: unknown });
    const exact = run("import-run", { code: "deepread-import", expectedPluginId: "deepread",
      payloadSummary: { type: "array", jsonBytes: expectedBytes, contentRedacted: true } });
    expect(isDeepReadFilesFeatureTaskRun(exact, before, expectedBytes)).toBe(true);
    expect(isDeepReadFilesFeatureTaskRun(run("old-run", exact.input), before, expectedBytes)).toBe(false);
    expect(isDeepReadFilesFeatureTaskRun(run("wrong-code", { ...(exact.input as object), code: "deepread" }), before, expectedBytes)).toBe(false);
    expect(isDeepReadFilesFeatureTaskRun(run("wrong-owner", { ...(exact.input as object), expectedPluginId: "other" }), before, expectedBytes)).toBe(false);
    expect(isDeepReadFilesFeatureTaskRun(run("wrong-kind", { ...(exact.input as object), payloadSummary: { type: "string", jsonBytes: expectedBytes, contentRedacted: true } }), before, expectedBytes)).toBe(false);
    expect(isDeepReadFilesFeatureTaskRun(run("wrong-count", { ...(exact.input as object), payloadSummary: { type: "array", jsonBytes: expectedBytes + 2, contentRedacted: true } }), before, expectedBytes)).toBe(false);
    expect(isDeepReadFilesFeatureTaskRun(run("unredacted", { ...(exact.input as object), payloadSummary: { type: "array", jsonBytes: expectedBytes, contentRedacted: false } }), before, expectedBytes)).toBe(false);
  });

  it("waits past an old ready frame until the same activation exposes its fresh nonce", async () => {
    const seen = [
      { kind: "ready" as const, nonce: "old-document", value: "stale-frame" },
      { kind: "ready" as const, nonce: "new-document", value: "fresh-frame" },
    ];
    let reads = 0, activationCalls = 0;
    activationCalls += 1;
    const until = async <T>(read: () => T | Promise<T>, label: string): Promise<NonNullable<T>> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const value = await read();
        if (value) return value as NonNullable<T>;
      }
      throw Error(label);
    };
    const result = await waitForDeepReadActivationReadiness({ until }, async () => seen[reads++] ?? null, "old-document", true);
    expect(result).toEqual({ kind: "ready", nonce: "new-document", value: "fresh-frame" });
    expect(reads).toBe(2);
    expect(activationCalls).toBe(1);
  });

  it("accepts only the source-backed 5..6 successful writes from one settled files activation", () => {
    const before = new Set(["consent-run"]);
    const run = (id: string, method: string, status = "succeeded", clientId = "atools-ui") => ({
      ...awaitingRun, id, status, initiator: { clientId }, input: { method },
    } as TaskRun & { input: unknown; initiator: { clientId: string } });
    const activity = (writes: number) => summarizeDeepReadFilesStorageRuns([
      ...Array.from({ length: writes }, (_, index) => run(`write-${writes}-${index}`, "dbStorage.setItem")),
      run(`db-read-${writes}`, "dbStorage.getItem"), run(`fallback-read-${writes}`, "webStorage.getItem"),
      { ...awaitingRun, id: `session-open-${writes}`, status: "succeeded", input: { operation: "open", intentId: "intent-1" } },
    ], before);
    expect(activity(5)).toEqual({ settled: true, successfulWrites: 5, complete: true });
    expect(activity(6)).toEqual({ settled: true, successfulWrites: 6, complete: true });
    expect(activity(2).complete).toBe(false);
    expect(summarizeDeepReadFilesStorageRuns([
      ...Array.from({ length: 5 }, (_, index) => run(`pending-write-${index}`, "dbStorage.setItem")),
      run("still-running", "dbStorage.getItem", "running"),
    ], before).complete).toBe(false);
    expect(() => activity(7)).toThrow(/write budget/);
    expect(() => summarizeDeepReadFilesStorageRuns([run("failed", "dbStorage.setItem", "failed")], before)).toThrow(/did not succeed/);
    expect(() => summarizeDeepReadFilesStorageRuns([
      ...Array.from({ length: 5 }, (_, index) => run(`owned-${index}`, "dbStorage.setItem")),
      run("foreign", "dbStorage.setItem", "succeeded", "agent"),
    ], before)).toThrow(/foreign plugin-data caller/);
    expect(() => summarizeDeepReadFilesStorageRuns([run("unknown", "webStorage.setItem")], before)).toThrow(/unreviewed/);
    expect(() => summarizeDeepReadFilesStorageRuns([run("unknown-method", "webStorage.clear")], before)).toThrow(/unreviewed/);
    expect(() => summarizeDeepReadFilesStorageRuns([{ ...awaitingRun, id: "missing-method", input: { operation: "request" } }], before))
      .toThrow(/unreviewed/);
    expect(() => summarizeDeepReadFilesStorageRuns([{ ...awaitingRun, id: "malformed-open", input: { operation: "open", intentId: "intent", extra: true } }], before))
      .toThrow(/unreviewed/);
    expect(isDeepReadStorageWrite(run("new-write", "dbStorage.setItem"), before)).toBe(true);
    expect(isDeepReadStorageWrite(run("consent-run", "dbStorage.setItem"), before)).toBe(false);
  });

  it("approves only DeepRead's exact Node request shape without promoting the Web profile", () => {
    const deepRead = registry.cases.find(item => item.caseId === "converted-deepread-source")!;
    expect(deepRead.runtime).toBe("web");
    expect(requiresLegacyNodeSession({ caseId: deepRead.caseId, runtime: "web" })).toBe(true);
    expect(requiresLegacyNodeSession({ caseId: "converted-tetris-source", runtime: "web" })).toBe(false);
    const scopes = ["file_read", "file_write", "network", "shell", "clipboard_read", "clipboard_write",
      "screenshot", "browser_context", "plugin_data", "system_settings"];
    const request = { id: "node-request", run_id: "node-run", client_id: "atools-ui",
      tool_name: "legacy_node_14ff3d75f7a75dc386ed3777b20c268612e207571b56d0fcedcd234184682cdb", scopes };
    const match = matchesExactDeepReadNodeRequest("DeepRead 深读 请求访问本机", [request]);
    expect(match).toEqual(request);
    const run = { id: "node-run", capabilityId: request.tool_name, initiator: { clientId: "atools-ui" }, status: "awaiting_permission" } as TaskRun;
    expect(isExactAwaitingDeepReadNodeRun(run, match!)).toBe(true);
    expect(isExactAwaitingDeepReadNodeRun({ ...run, id: "wrong-run" }, match!)).toBe(false);
    expect(isExactAwaitingDeepReadNodeRun({ ...run, initiator: { clientId: "agent" } }, match!)).toBe(false);
    expect(isExactAwaitingDeepReadNodeRun({ ...run, status: "succeeded" }, match!)).toBe(false);
    expect(matchesExactDeepReadNodeRequest("DeepRead 深读 请求访问本机", [{ ...request, scopes: [...scopes, "system_settings"] }])).toBeNull();
    expect(matchesExactDeepReadNodeRequest("Other 请求访问本机", [request])).toBeNull();
    expect(matchesExactDeepReadNodeRequest("DeepRead 深读 请求访问本机", [request, request])).toBeNull();
  });
});

const idleRuntime = { pendingRequests: 0, dataInvocations: 0, dataPreparations: 0 } as RuntimeState;
function baselineHarness(onRead?: (command: string, index: number) => void) {
  let reads = 0;
  baselineTransport.nonce = "a".repeat(32);
  baselineTransport.invoke.mockReset().mockImplementation(async (command: string) => {
    onRead?.(command, reads++);
    if (command === "native_published_runtime_state") return idleRuntime;
    if (command === "list_task_runs") return [];
    throw Error(`Unexpected baseline command: ${command}`);
  });
  document.body.innerHTML = '<iframe title="Plugin" srcdoc="<main>DeepRead</main>"></iframe>';
  const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]')!;
  const observations = {};
  let attempts = 0;
  const context = { profile: { caseId: "converted-deepread-source", id: "deepread" }, fixture: {}, observations,
    until: async (read: () => unknown | Promise<unknown>, label: string) => {
      for (let index = 0; index < 5; index++) { attempts++; const value = await read(); if (value) return value; }
      throw Error(label);
    } } as unknown as PublishedScenarioContext;
  return { context, frame, identity: captureDeepReadFrameIdentity(context, frame), attempts: () => attempts };
}

describe("DeepRead idle baseline waits for authenticated, stable state", () => {
  beforeEach(() => { document.body.innerHTML = ""; baselineTransport.invoke.mockReset(); });
  afterEach(() => { document.body.innerHTML = ""; baselineTransport.invoke.mockReset(); });

  it.each(["pending", "invocation", "preparation"])("does not capture baseline while %s remains active", async field => {
    let firstRuntime = true;
    const h = baselineHarness();
    baselineTransport.invoke.mockImplementation(async (command: string) => {
      if (command === "native_published_runtime_state") {
        if (firstRuntime) { firstRuntime = false; return { ...idleRuntime, [field === "pending" ? "pendingRequests" : field === "invocation" ? "dataInvocations" : "dataPreparations"]: 1 }; }
        return idleRuntime;
      }
      if (command === "list_task_runs") return [];
      throw Error(`Unexpected baseline command: ${command}`);
    });
    await expect(waitForDeepReadDataIdleBaseline(h.context, h.identity)).resolves.toEqual([]);
    expect(h.attempts()).toBe(2);
  });

  it("waits for nonterminal data runs to settle before returning a baseline", async () => {
    let taskReads = 0;
    const h = baselineHarness();
    baselineTransport.invoke.mockImplementation(async (command: string) => {
      if (command === "native_published_runtime_state") return idleRuntime;
      if (command === "list_task_runs") {
        taskReads++;
        return taskReads === 1 ? [{ id: "data-run", capabilityId: dataRequest.tool_name, status: "running" }] : [];
      }
      throw Error(`Unexpected baseline command: ${command}`);
    });
    await expect(waitForDeepReadDataIdleBaseline(h.context, h.identity)).resolves.toEqual([]);
    expect(h.attempts()).toBe(2);
    expect(taskReads).toBe(3);
  });

  it("rechecks pending runtime state after the final task-list read", async () => {
    let runtimeReads = 0;
    const h = baselineHarness();
    baselineTransport.invoke.mockImplementation(async (command: string) => {
      if (command === "native_published_runtime_state") {
        runtimeReads++;
        return runtimeReads === 3 ? { ...idleRuntime, pendingRequests: 1 } : idleRuntime;
      }
      if (command === "list_task_runs") return [];
      throw Error(`Unexpected baseline command: ${command}`);
    });
    await expect(waitForDeepReadDataIdleBaseline(h.context, h.identity)).resolves.toEqual([]);
    expect(h.attempts()).toBe(2);
  });

  it("rejects a document replaced during an awaited baseline read", async () => {
    let replaced = false;
    const h = baselineHarness(command => {
      if (command === "list_task_runs" && !replaced) { replaced = true; baselineTransport.nonce = "b".repeat(32); }
    });
    await expect(waitForDeepReadDataIdleBaseline(h.context, h.identity)).rejects.toThrow(/document changed/);
  });

  it("does not return a baseline when a permission dialog appears during task-list reads", async () => {
    let inserted = false;
    const h = baselineHarness(command => {
      if (command === "list_task_runs" && !inserted) {
        inserted = true;
        document.body.insertAdjacentHTML("beforeend", '<div data-permission-dialog><h2>DeepRead permission</h2></div>');
      }
    });
    await expect(waitForDeepReadDataIdleBaseline(h.context, h.identity)).rejects.toThrow(/authenticated, terminal data baseline/);
  });
});

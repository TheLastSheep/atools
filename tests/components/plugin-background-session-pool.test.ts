import { expect, it, vi } from "vitest";
import type { FeatureAction } from "../../src/lib/types";
import { createPluginBackgroundSessionPool, type PluginBackgroundCandidate, type PluginBackgroundSessionView } from "../../src/lib/pluginBackgroundSessionPool";

const action = (pluginId: string): FeatureAction => ({ plugin_id: pluginId, plugin_name: pluginId, feature_code: "",
  main_url: "index.html", plugin_path: `/fixture/${pluginId}`, expand_height: 0, payload: null, auto_detach: false });
const candidate = (pluginId: string, revision = "a".repeat(64)): PluginBackgroundCandidate => ({ pluginId, pluginName: pluginId, codeRevision: revision, action: action(pluginId) });
const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
const ticket = (index: number) => `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`;
type Invoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;

function fixture(candidates: PluginBackgroundCandidate[], closePanelStrict: (sessionId: string) => Promise<void> = async () => {},
  options: { postcheckFailed?: boolean } = {}) {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  const runs = new Map<string, { id: string; status: string; capabilityId: string; initiator: { clientId: string }; input: unknown; output: unknown }>();
  const invoke: Invoke = async <T,>(command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    if (command === "list_plugin_background_candidates") return candidates as T;
    if (command === "run_plugin_background") {
      const runId = `task-${runs.size + 1}`;
      const tool = `atools.host.plugin-background.${"f".repeat(24)}.${String(args.operation)}`;
      runs.set(runId, { id: runId, status: "running", capabilityId: tool, initiator: { clientId: "atools-ui" }, input: args, output: null });
      return { runId, tool, status: "running" } as T;
    }
    if (command === "get_task_run") {
      const run = runs.get(String(args.id));
      return (run && options.postcheckFailed && run.status === "succeeded" ? { ...run, status: "failed" } : run ?? null) as T;
    }
    if (command === "complete_plugin_background") {
      const run = [...runs.values()].find(value => (value.input as Record<string, unknown>).requestId === args.requestId);
      const input = run?.input as Record<string, unknown> | undefined;
      if (run) {
        run.status = args.outcome === "failed" ? "failed" : "succeeded";
        run.output = { runtime: "plugin-background", operation: input?.operation,
          outcome: input?.operation === "start" ? "ready" : "closed", sessionId: input?.sessionId,
          pluginId: input?.pluginId, codeRevision: input?.codeRevision };
      }
      return undefined as T;
    }
    if (command === "verify_plugin_background_session") return { valid: true } as T;
    return undefined as T;
  };
  const pool = createPluginBackgroundSessionPool({
    invoke, listen: async (name, receive) => { listeners.set(name, receive as (event: { payload: unknown }) => void); return () => listeners.delete(name); },
    changed: vi.fn<(sessions: PluginBackgroundSessionView[]) => void>(), closePanelStrict,
    activatePanel: vi.fn(async () => true), setPanelVisible: vi.fn(),
  });
  const dispatchStart = (pluginId: string, number: number) => {
    const run = [...runs.values()].find(value => (value.input as Record<string, unknown>).pluginId === pluginId)!;
    const input = run.input as Record<string, unknown>;
    listeners.get("plugin-background-dispatch")?.({ payload: {
      requestId: input.requestId, ticket: ticket(number), sessionId: input.sessionId, operation: "start", pluginId,
      codeRevision: input.codeRevision, action: action(pluginId),
    } });
    return { run, input };
  };
  const ready = async (pluginId: string, number: number) => {
    const started = dispatchStart(pluginId, number);
    await vi.waitFor(() => expect(pool.snapshot().find(session => session.pluginId === pluginId)?.mountReady).toBe(true));
    pool.panelReady(String(started.input.sessionId));
    await vi.waitFor(() => expect(started.run.status).toBe("succeeded"));
    await vi.waitFor(() => expect(pool.snapshot().find(session => session.pluginId === pluginId)?.stage).toBe("ready"));
    return started;
  };
  return { calls, listeners, runs, invoke, pool, dispatchStart, ready };
}

it("serializes startup attempts, caps them at two, and keeps only two resident sessions", async () => {
  const f = fixture([candidate("one"), candidate("two", "b".repeat(64)), candidate("three", "c".repeat(64))]);
  void f.pool.connect();
  await vi.waitFor(() => expect(f.runs.size).toBe(1));
  await f.ready("one", 1);
  await vi.waitFor(() => expect(f.runs.size).toBe(2));
  await f.ready("two", 2);
  await flush();
  expect(f.calls.filter(call => call.command === "run_plugin_background")).toHaveLength(2);
  expect(f.pool.snapshot().map(session => session.pluginId)).toEqual(["one", "two"]);
  await f.pool.close();
});

it("holds the next startup until strict teardown completes after a failed ready receipt", async () => {
  let finishClose!: () => void;
  const closeGate = new Promise<void>(resolve => { finishClose = resolve; });
  const closePanelStrict = vi.fn(async () => closeGate);
  const f = fixture([candidate("one"), candidate("two", "b".repeat(64))], closePanelStrict);
  void f.pool.connect();
  await vi.waitFor(() => expect(f.runs.size).toBe(1));
  const started = f.dispatchStart("one", 1);
  await vi.waitFor(() => expect(f.pool.snapshot()[0]?.mountReady).toBe(true));
  await f.pool.panelFailed(String(started.input.sessionId), Error("fixed panel failure"));
  await vi.waitFor(() => expect(closePanelStrict).toHaveBeenCalledOnce());
  await flush();
  expect(f.calls.filter(call => call.command === "run_plugin_background")).toHaveLength(1);
  finishClose();
  await vi.waitFor(() => expect(f.runs.size).toBe(2));
  expect(f.calls.filter(call => call.command === "close_plugin_background_session")).toHaveLength(1);
  await f.pool.close();
});

it("tears down after a ready receipt when the native TaskRun postcheck is failed", async () => {
  let finishClose!: () => void;
  const closeGate = new Promise<void>(resolve => { finishClose = resolve; });
  const closePanelStrict = vi.fn(async () => closeGate);
  const f = fixture([candidate("postcheck")], closePanelStrict, { postcheckFailed: true });
  void f.pool.connect();
  await vi.waitFor(() => expect(f.runs.size).toBe(1));
  const started = f.dispatchStart("postcheck", 1);
  await vi.waitFor(() => expect(f.pool.snapshot()[0]?.mountReady).toBe(true));
  let foregroundFinished = false;
  const foreground = f.pool.foreground({ ...action("postcheck"), feature_code: "selected-feature", payload: { source: "real-action" } })
    .then(value => { foregroundFinished = true; return value; });
  f.pool.panelReady(String(started.input.sessionId));
  await vi.waitFor(() => expect(f.calls.some(call => call.command === "complete_plugin_background" && call.args.outcome === "ready")).toBe(true));
  await vi.waitFor(() => expect(closePanelStrict).toHaveBeenCalledOnce());
  await flush();
  expect(f.calls.some(call => call.command === "verify_plugin_background_session")).toBe(false);
  expect(foregroundFinished).toBe(false);
  finishClose();
  await expect(foreground).resolves.toBe(false);
  expect(f.pool.snapshot()).toEqual([]);
  expect(f.calls.some(call => call.command === "cancel_plugin_background")).toBe(true);
  await f.pool.close();
});

it("waits for exact pending-admission cleanup before allowing a matching foreground fallback", async () => {
  let finishClose!: () => void;
  const closeGate = new Promise<void>(resolve => { finishClose = resolve; });
  const closePanelStrict = vi.fn(async () => closeGate);
  const f = fixture([candidate("matching")], closePanelStrict);
  void f.pool.connect();
  await vi.waitFor(() => expect(f.runs.size).toBe(1));
  const foregroundAction = { ...action("matching"), feature_code: "real-feature", payload: { selected: true } };
  let completed = false;
  const foreground = f.pool.foreground(foregroundAction).then(value => { completed = true; return value; });
  await vi.waitFor(() => expect(f.calls.some(call => call.command === "cancel_plugin_background")).toBe(true));
  await vi.waitFor(() => expect(closePanelStrict).toHaveBeenCalledOnce());
  await flush();
  expect(completed).toBe(false);
  expect(f.calls.some(call => call.command === "verify_plugin_background_session")).toBe(false);
  finishClose();
  await expect(foreground).resolves.toBe(false);
  expect(f.pool.snapshot()).toEqual([]);
  await f.pool.close();
});

it("forwards permission waiting to the admitted ticket without replacing the TaskRun event path", async () => {
  const f = fixture([candidate("waiting")]);
  void f.pool.connect();
  await vi.waitFor(() => expect(f.runs.size).toBe(1));
  const started = f.dispatchStart("waiting", 1);
  await vi.waitFor(() => expect(f.pool.snapshot()[0]?.mountReady).toBe(true));
  await f.pool.setWaiting(String(started.input.sessionId), true);
  expect(f.calls.at(-1)).toEqual({ command: "set_plugin_background_waiting", args: {
    requestId: started.input.requestId, ticket: ticket(1), waiting: true,
  } });
  await f.pool.setWaiting(String(started.input.sessionId), true);
  expect(f.calls.filter(call => call.command === "set_plugin_background_waiting")).toHaveLength(1);
  await f.pool.setWaiting(String(started.input.sessionId), false);
  expect(f.calls.at(-1)).toEqual({ command: "set_plugin_background_waiting", args: {
    requestId: started.input.requestId, ticket: ticket(1), waiting: false,
  } });
  f.pool.panelReady(String(started.input.sessionId));
  await vi.waitFor(() => expect(started.run.status).toBe("succeeded"));
  await f.pool.close();
});

it("rejects host close when strict resource teardown fails", async () => {
  const closePanelStrict = vi.fn(async () => { throw Error("ERR_FIXED_STRICT_RESOURCE_CLOSE"); });
  const f = fixture([candidate("strict-failure")], closePanelStrict);
  void f.pool.connect();
  await vi.waitFor(() => expect(f.runs.size).toBe(1));
  await expect(f.pool.close()).rejects.toThrow("ERR_FIXED_STRICT_RESOURCE_CLOSE");
  expect(closePanelStrict).toHaveBeenCalledOnce();
  expect(f.calls.some(call => call.command === "close_plugin_background_session")).toBe(true);
  expect(f.pool.snapshot()).toEqual([expect.objectContaining({
    sessionId: expect.any(String), pluginId: "strict-failure", stage: "cleanup-failed", visible: false,
  })]);
});

it("retains failed owners, blocks same-plugin fallback, and retries only the exact owner", async () => {
  let failedSessionId = "", failedCloseCalls = 0;
  const strictCloseAttempts: Array<[string, boolean | undefined]> = [];
  const closePanelStrict = vi.fn(async (sessionId: string, retry?: boolean) => {
    strictCloseAttempts.push([sessionId, retry]);
    if (sessionId === failedSessionId && ++failedCloseCalls <= 2) throw Error("ERR_FIXED_STRICT_RESOURCE_CLOSE");
  });
  const f = fixture([candidate("retained"), candidate("retained", "b".repeat(64)), candidate("companion", "c".repeat(64))], closePanelStrict);
  void f.pool.connect();
  await vi.waitFor(() => expect(f.runs.size).toBe(1));
  const started = f.dispatchStart("retained", 1);
  failedSessionId = String(started.input.sessionId);
  await vi.waitFor(() => expect(f.pool.snapshot()[0]?.mountReady).toBe(true));
  await f.pool.panelFailed(failedSessionId, Error("private panel failure"));
  await vi.waitFor(() => expect(f.pool.snapshot().find(session => session.sessionId === failedSessionId)?.stage).toBe("cleanup-failed"));

  const failed = f.pool.snapshot().find(session => session.sessionId === failedSessionId);
  expect(failed).toEqual(expect.objectContaining({
    sessionId: failedSessionId, pluginId: "retained", codeRevision: "a".repeat(64), mountReady: true, visible: false,
    stage: "cleanup-failed",
  }));
  expect(failed).not.toHaveProperty("panelFailed");
  expect(failed).not.toHaveProperty("cleanupFailure");
  expect(JSON.stringify(f.pool.snapshot())).not.toContain("ERR_FIXED_STRICT_RESOURCE_CLOSE");
  await vi.waitFor(() => expect(f.runs.size).toBe(2));
  const companion = await f.ready("companion", 2);
  const retainedPluginStarts = f.calls.filter(call => call.command === "run_plugin_background" && call.args.pluginId === "retained").length;
  await expect(f.pool.foreground({ ...action("retained"), feature_code: "selected" })).resolves.toBe(false);
  expect(f.calls.filter(call => call.command === "run_plugin_background" && call.args.pluginId === "retained")).toHaveLength(retainedPluginStarts);

  expect(f.pool.snapshot().map(session => session.stage)).toEqual(["cleanup-failed", "ready"]);
  expect(await f.pool.retryCleanup(failedSessionId)).toBe(false);
  expect(f.pool.snapshot().find(session => session.sessionId === companion.input.sessionId)?.stage).toBe("ready");

  expect(await f.pool.retryCleanup(failedSessionId)).toBe(true);
  expect(strictCloseAttempts.filter(([sessionId]) => sessionId === failedSessionId)).toEqual([
    [failedSessionId, false], [failedSessionId, true], [failedSessionId, true],
  ]);
  expect(f.pool.snapshot().map(session => session.sessionId)).toEqual([String(companion.input.sessionId)]);
  await f.pool.panelFailed(failedSessionId, Error("stale panel callback"));
  await f.pool.stop(failedSessionId);
  expect(f.pool.snapshot().map(session => session.sessionId)).toEqual([String(companion.input.sessionId)]);
  await f.pool.close();
});

it("closes every owner, retaining only failed cleanup records and allowing repeated close to finish them", async () => {
  let firstSessionId = "", firstCloseCalls = 0;
  const strictCloseAttempts: Array<[string, boolean | undefined]> = [];
  const closePanelStrict = vi.fn(async (sessionId: string, retry?: boolean) => {
    strictCloseAttempts.push([sessionId, retry]);
    if (sessionId === firstSessionId && ++firstCloseCalls === 1) throw Error("ERR_FIRST_OWNER_CLOSE");
  });
  const f = fixture([candidate("one"), candidate("two", "b".repeat(64))], closePanelStrict);
  void f.pool.connect();
  await vi.waitFor(() => expect(f.runs.size).toBe(1));
  const first = await f.ready("one", 1);
  firstSessionId = String(first.input.sessionId);
  await vi.waitFor(() => expect(f.runs.size).toBe(2));
  await f.ready("two", 2);

  await expect(f.pool.close()).rejects.toThrow("ERR_FIRST_OWNER_CLOSE");
  expect(f.pool.snapshot()).toEqual([expect.objectContaining({
    sessionId: firstSessionId, pluginId: "one", stage: "cleanup-failed", visible: false,
  })]);
  expect(f.calls.filter(call => call.command === "close_plugin_background_session")).toHaveLength(2);

  await f.pool.close();
  expect(f.pool.snapshot()).toEqual([]);
  expect(closePanelStrict).toHaveBeenCalledTimes(3);
  expect(strictCloseAttempts.filter(([sessionId]) => sessionId === firstSessionId)).toEqual([
    [firstSessionId, false], [firstSessionId, true],
  ]);
});

it("shares concurrent close work and handles an ignored close rejection", async () => {
  let finishClose!: () => void;
  const closeGate = new Promise<void>(resolve => { finishClose = resolve; });
  const closePanelStrict = vi.fn(async () => closeGate);
  const f = fixture([candidate("concurrent-close")], closePanelStrict);
  void f.pool.connect();
  await vi.waitFor(() => expect(f.runs.size).toBe(1));
  await f.ready("concurrent-close", 1);

  const firstClose = f.pool.close();
  const secondClose = f.pool.close();
  let secondCloseFinished = false;
  void secondClose.then(() => { secondCloseFinished = true; });
  await vi.waitFor(() => expect(closePanelStrict).toHaveBeenCalledOnce());
  await flush();
  expect(secondCloseFinished).toBe(false);
  finishClose();
  await Promise.all([firstClose, secondClose]);
  expect(f.pool.snapshot()).toEqual([]);
});

it("keeps an ignored close rejection observable without leaking an unhandled promise", async () => {
  let firstClose = true;
  const closePanelStrict = vi.fn(async () => {
    if (firstClose) { firstClose = false; throw Error("ERR_IGNORED_CLOSE"); }
  });
  const f = fixture([candidate("ignored-close")], closePanelStrict);
  void f.pool.connect();
  await vi.waitFor(() => expect(f.runs.size).toBe(1));
  const started = await f.ready("ignored-close", 1);

  void f.pool.close();
  await vi.waitFor(() => expect(f.pool.snapshot()[0]?.stage).toBe("cleanup-failed"));
  expect(f.pool.snapshot()[0]?.sessionId).toBe(started.input.sessionId);
  expect(await f.pool.retryCleanup(String(started.input.sessionId))).toBe(true);
  expect(f.pool.snapshot()).toEqual([]);
});

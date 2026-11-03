import { afterEach, expect, it, vi } from "vitest";
import { createPluginMainPushNative } from "../../src/lib/pluginMainPushNative";
import type { MainPushCandidate, MainPushDispatch } from "../../src/lib/pluginMainPushProtocol";
const candidate: MainPushCandidate = { pluginId: "fixed", featureCode: "search", commandType: "over", codeRevision: "revision",
  result: { plugin_id: "fixed", code: "search", plugin_name: "Fixed", label: "Search", explain: "", icon: null, match_type: "over", score: 5 } };
afterEach(() => vi.useRealTimers());
it("maps renderer query-ready to Rust handled receipt without changing the renderer reply", async () => {
  let receive!: (event: { payload: MainPushDispatch }) => void;
  let committed!: (value: unknown) => void;
  const invoke = vi.fn(async (command: string, args: any = {}) => {
    if (command === "run_plugin_main_push") {
      queueMicrotask(() => receive({ payload: { requestId: args.requestId, runnerId: args.runnerId, operation: args.operation, ticket: "ticket", candidate,
        action: { plugin_id: "fixed", plugin_name: "Fixed", feature_code: "search", main_url: "index.html", plugin_path: "/fixture", expand_height: 400, payload: null } } }));
      return new Promise(resolve => { committed = resolve; });
    }
    if (command === "complete_plugin_main_push") {
      // Exact Rust Receipt operation guard: query permits handled|empty, never ready.
      if (!["handled", "empty", "failed", "superseded"].includes(args.outcome)) throw Error("ERR_MAIN_PUSH_RECEIPT");
      committed({ status: "succeeded" });
    }
  });
  const native = createPluginMainPushNative({ invoke: invoke as any, listen: async (name, listener) => { if (name === "plugin-main-push-dispatch") receive = listener as typeof receive; return () => undefined; }, invalidated: vi.fn() });
  const reply = await native.run({ requestId: "query", runnerId: "runner", operation: "query", candidate, generation: 1, inputBytes: 10,
    execute: async () => ({ requestId: "query", outcome: "ready", rows: [{ handle: "query:0", text: "Fixed", description: "", icon: "", highlight: true }] }) });
  expect(reply.outcome).toBe("ready");
  expect(invoke.mock.calls.find(call => call[0] === "complete_plugin_main_push")?.[1]).toMatchObject({ outcome: "handled", rowCount: 1 });
  await native.close();
});
it("a native failed TaskRun terminates a renderer callback still awaiting permission or reply", async () => {
  let receive!: (event: { payload: MainPushDispatch }) => void;
  const invoke = vi.fn(async (command: string, args: any = {}) => {
    if (command === "run_plugin_main_push") {
      queueMicrotask(() => receive({ payload: { requestId: args.requestId, runnerId: args.runnerId, operation: args.operation, ticket: "ticket", candidate,
        action: { plugin_id: "fixed", plugin_name: "Fixed", feature_code: "search", main_url: "index.html", plugin_path: "/fixture", expand_height: 400, payload: null } } }));
      return { status: "failed", error: "ERR_MAIN_PUSH_TIMEOUT" };
    }
  });
  const native = createPluginMainPushNative({ invoke: invoke as any, listen: async (name, callback) => { if (name === "plugin-main-push-dispatch") receive = callback as typeof receive; return () => undefined; }, invalidated: vi.fn() });
  let failed = false;
  const pending = native.run({ requestId: "query", runnerId: "runner", operation: "query", candidate, generation: 1, inputBytes: 10,
    execute: async () => new Promise(() => undefined) }).catch(() => { failed = true; });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(failed).toBe(true); await native.close(); await pending;
});
it("cancelling before event subscription finishes cannot start an obsolete permission task", async () => {
  let connected!: () => void;
  const subscribed = new Promise<void>(resolve => { connected = resolve; });
  const invoke = vi.fn(async () => undefined);
  const native = createPluginMainPushNative({ invoke: invoke as any, listen: async () => { await subscribed; return () => undefined; }, invalidated: vi.fn() });
  const request = native.run({ requestId: "query", runnerId: "runner", operation: "prepare", candidate, generation: 1, inputBytes: 0,
    execute: vi.fn() });
  await native.cancel("query"); connected(); expect((await request).outcome).toBe("superseded");
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(invoke.mock.calls.some((call: any) => call[0] === "run_plugin_main_push")).toBe(false); await native.close();
});
it("complete receipt acknowledgement cannot advance before the durable prepare commit", async () => {
  let receive!: (event: { payload: MainPushDispatch }) => void, commit!: (value: unknown) => void;
  let received = false, resolved = false;
  const invoke = vi.fn(async (command: string, args: any = {}) => {
    if (command === "run_plugin_main_push") {
      queueMicrotask(() => receive({ payload: { requestId: args.requestId, runnerId: args.runnerId, operation: args.operation, ticket: "ticket", candidate,
        action: { plugin_id: "fixed", plugin_name: "Fixed", feature_code: "search", main_url: "index.html", plugin_path: "/fixture", expand_height: 400, payload: null } } }));
      return new Promise(resolve => { commit = resolve; });
    }
    if (command === "complete_plugin_main_push") { received = true; return null; }
  });
  const native = createPluginMainPushNative({ invoke: invoke as any, listen: async (name, listener) => { if (name === "plugin-main-push-dispatch") receive = listener as typeof receive; return () => undefined; }, invalidated: vi.fn() });
  const pending = native.run({ requestId: "prepare", runnerId: "runner", operation: "prepare", candidate, generation: 1, inputBytes: 0,
    execute: async () => ({ requestId: "prepare", outcome: "ready" }) }).then(reply => { resolved = true; return reply; });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(received).toBe(true); expect(resolved).toBe(false);
  commit({ status: "succeeded", runId: "durable-run" }); expect((await pending).outcome).toBe("ready"); await native.close();
});
it("observes approval commit without a terminal event and clears the active-request timer", async () => {
  vi.useFakeTimers();
  let receive!: (event: { payload: MainPushDispatch }) => void;
  let committed = false, finished = false;
  const invoke = vi.fn(async (command: string, args: any = {}) => {
    if (command === "run_plugin_main_push") {
      queueMicrotask(() => receive({ payload: { requestId: args.requestId, runnerId: args.runnerId, operation: args.operation, ticket: "ticket", candidate,
        action: { plugin_id: "fixed", plugin_name: "Fixed", feature_code: "search", main_url: "index.html", plugin_path: "/fixture", expand_height: 400, payload: null } } }));
      return { permission_required: true, runId: "run" };
    }
    if (command === "get_task_run") return { id: "run", status: committed ? "succeeded" : "running",
      input: { requestId: "prepare", runnerId: "runner" }, initiator: { clientId: "atools-ui" } };
  });
  const native = createPluginMainPushNative({ invoke: invoke as any, listen: async (name, listener) => { if (name === "plugin-main-push-dispatch") receive = listener as typeof receive; return () => undefined; }, invalidated: vi.fn() });
  const pending = native.run({ requestId: "prepare", runnerId: "runner", operation: "prepare", candidate, generation: 1, inputBytes: 0,
    execute: async () => ({ requestId: "prepare", outcome: "ready" }) }).then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(1); expect(finished).toBe(false);
  committed = true; await vi.advanceTimersByTimeAsync(201); await pending; expect(finished).toBe(true);
  expect(vi.getTimerCount()).toBe(0); await native.close(); expect(vi.getTimerCount()).toBe(0);
});

it("closes every listener after cancel errors and retries only the listener whose unlisten failed", async () => {
  const stopped: string[] = [], cancelled: string[] = [];
  const invoke = vi.fn(async (command: string, args: any = {}) => {
    if (command === "run_plugin_main_push") return new Promise(() => undefined);
    if (command === "cancel_plugin_main_push") { cancelled.push(args.requestId); if (args.requestId === "first") throw Error("fixture cancel failure"); }
  });
  const native = createPluginMainPushNative({ invoke: invoke as any,
    listen: async (name, _listener) => () => { stopped.push(name); if (name === "plugin-main-push-dispatch" && stopped.filter(value => value === name).length === 1) throw Error("fixture unlisten failure"); },
    invalidated: vi.fn() });
  const run = (requestId: string) => native.run({ requestId, runnerId: "runner", operation: "query", candidate, generation: 1, inputBytes: 0,
    execute: async () => ({ requestId, outcome: "empty" }) }).then(reply => reply.outcome, error => error.message);
  const pending = [run("first"), run("second")];
  for (let i = 0; i < 30 && invoke.mock.calls.filter(call => call[0] === "run_plugin_main_push").length < 2; i++) await Promise.resolve();
  const firstClose = native.close(); expect(native.close()).toBe(firstClose);
  await expect(firstClose).rejects.toThrow("ERR_MAIN_PUSH_LISTENER_CLEANUP");
  expect(await Promise.all(pending)).toEqual(["superseded", "superseded"]);
  expect(cancelled.sort()).toEqual(["first", "second"]);
  expect(stopped.sort()).toEqual(["plugin-main-push-dispatch", "plugin-main-push-invalidated", "task-run-updated"]);
  await expect(native.run({ requestId: "after-close", runnerId: "runner", operation: "query", candidate, generation: 2, inputBytes: 0,
    execute: async () => ({ requestId: "after-close", outcome: "empty" }) })).rejects.toThrow("ERR_MAIN_PUSH_CLOSED");
  await native.close();
  expect(stopped.filter(name => name === "plugin-main-push-dispatch")).toHaveLength(2);
  expect(stopped.filter(name => name === "plugin-main-push-invalidated")).toHaveLength(1);
  expect(stopped.filter(name => name === "task-run-updated")).toHaveLength(1);
});

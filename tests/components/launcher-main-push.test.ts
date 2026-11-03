import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLauncherMainPush, type MainPushState } from "../../src/lib/launcherMainPush";
import type { MainPushCandidate, MainPushDispatch, MainPushPanel } from "../../src/lib/pluginMainPushProtocol";
import { createLauncherPluginSessionController } from "../../src/lib/launcherPluginSessionController";
import type { PluginActivationToken } from "../../src/lib/pluginCodeLifecycle";
import type { FeatureAction } from "../../src/lib/types";
type MainPushActivate = Parameters<typeof createLauncherMainPush>[0]["activate"];
const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
const candidate = (name = "fixed"): MainPushCandidate => ({ pluginId: name, featureCode: "search-" + name, commandType: "over", codeRevision: "revision-1",
  result: { code: "search-" + name, plugin_id: name, plugin_name: name, label: "Search", explain: "", icon: null, score: 50, match_type: "over" } });
function fixture() {
  const calls: Array<{ command: string; args: any }> = [], states: MainPushState[] = [];
  const listeners = new Map<string, (event: { payload: any }) => void>();
  const nativeRuns = new Map<string, { args: any; finish?: (value: unknown) => void }>();
  const tasks = new Map<string, any>();
  const queries: string[] = [], selections: string[] = [], closures: (() => void)[] = [], strictClosures: (() => void)[] = [], unmounts: (() => void)[] = [];
  const panels = new Map<string, MainPushPanel>(), runnerIds: string[] = [], stopCalls: string[] = [], closeOptions: unknown[][] = [];
  let candidates = [candidate()], permission = false, selectResult: "handled" | "enter" = "handled";
  let failRunnerCloses = 0, failStrictCloses = 0;
  let slow: ((query: string, id: string) => Promise<any>) | undefined;
  let activation: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let creation: Promise<void> | undefined;
  let lookupFailed = false;
  let selecting: Promise<void> | undefined, selectFails = false;
  async function dispatch(args: any) {
    const owner = candidates.find(value => value.pluginId === args.pluginId) ?? candidate(args.pluginId);
    listeners.get("plugin-main-push-dispatch")?.({ payload: { requestId: args.requestId, runnerId: args.runnerId, ticket: "ticket-" + args.requestId,
      operation: args.operation, candidate: owner, action: { plugin_id: owner.pluginId, plugin_name: owner.pluginId, feature_code: owner.featureCode,
        main_url: "index.html", plugin_path: "/isolated/plugin", expand_height: 400, payload: null } } satisfies MainPushDispatch });
  }
  const invoke = vi.fn(async (command: string, args: any = {}) => {
    calls.push({ command, args });
    if (command === "search_plugin_main_push_candidates") { if (lookupFailed) throw Error("fixed lookup failure"); return candidates; }
    if (command === "get_task_run") return tasks.get(args.id);
    if (command === "run_plugin_main_push") {
      if (permission && args.operation === "prepare") { nativeRuns.set(args.requestId, { args });
        tasks.set(args.requestId, { id: args.requestId, status: "awaiting_permission", input: args, initiator: { clientId: "atools-ui" } });
        return { permission_required: true, runId: args.requestId, tool: "fixed-tool" }; }
      return new Promise(resolve => { nativeRuns.set(args.requestId, { args, finish: resolve }); queueMicrotask(() => { void dispatch(args); }); });
    }
    if (command === "complete_plugin_main_push") { nativeRuns.get(args.requestId)?.finish?.({ status: "succeeded" });
      const task = tasks.get(args.requestId); if (task) { task.status = "succeeded"; queueMicrotask(() => listeners.get("task-run-updated")?.({ payload: args.requestId })); }
      nativeRuns.delete(args.requestId); return; }
    if (command === "cancel_plugin_main_push") { nativeRuns.get(args.requestId)?.finish?.({ status: "cancelled" }); nativeRuns.delete(args.requestId); return; }
    if (command === "close_plugin_main_push_runner") {
      if (failRunnerCloses > 0) { failRunnerCloses--; throw Error("fixture native runner close failure"); }
      for (const [id, run] of nativeRuns) if (run.args.runnerId === args.runnerId) { run.finish?.({ status: "cancelled" }); nativeRuns.delete(id); }
      return;
    }
  });
  const activate = vi.fn<MainPushActivate>(async (selectedCandidate, query, commit, isCurrent) => {
    await activation;
    if (isCurrent()) commit({ plugin_id: selectedCandidate.pluginId, plugin_name: selectedCandidate.result.plugin_name,
      feature_code: selectedCandidate.featureCode, main_url: "index.html", plugin_path: "/isolated/plugin",
      expand_height: 400, payload: query,
      ...(selectedCandidate.commandType === "text" ? {} : { entry_type: selectedCandidate.commandType }) });
  });
  const engine = createLauncherMainPush({ invoke: invoke as any, listen: async (name, receive) => { listeners.set(name, receive); return () => { stopCalls.push(name); listeners.delete(name); }; },
    changed: state => states.push(state), promoted: vi.fn(), activate,
    async createRunner(runner) {
      await creation;
      runnerIds.push(runner.id);
      const panel: MainPushPanel = { mainPushReady: async () => undefined, mainPushResolveIcon: async value => "safe:" + value,
        mainPushCancel: vi.fn(), mainPushPromote: vi.fn(), requestEscape: vi.fn(),
        closePersistentStrict: vi.fn(async () => { if (failStrictCloses > 0) { failStrictCloses--; throw Error("fixture strict close failure"); } await closing; }),
        async mainPushQuery(id, _generation, payload) { queries.push(payload); return slow ? slow(payload, id) : { requestId: id, outcome: "ready", rows: [{ handle: id + ":0", text: payload, description: "Fixed detail", icon: "local.png", highlight: true }] }; },
        async mainPushSelect(id) { selections.push(id); await selecting; return { requestId: id, outcome: selectFails ? "failed" : selectResult }; } };
      panels.set(runner.id, panel);
      const unmount = vi.fn(); unmounts.push(unmount);
      const close = vi.fn(async (options?: { retry?: boolean }) => {
        closeOptions.push(options === undefined ? [] : [options]);
        let failure: unknown;
        try { await panel.closePersistentStrict(); } catch (error) { failure = error; }
        try { await closing; } catch (error) { failure ??= error; }
        unmount();
        if (failure !== undefined) throw failure;
      }); closures.push(close);
      strictClosures.push(panel.closePersistentStrict);
      return { panel, ready: Promise.resolve(), resolveIcon: panel.mainPushResolveIcon, close };
    },
  });
  return { engine, calls, states, queries, selections, panels, closures, strictClosures, unmounts, activate, invoke, listeners, runnerIds, stopCalls, closeOptions,
    latest: () => states.at(-1)!, setCandidates: (value: MainPushCandidate[]) => { candidates = value; },
    setPermission: () => { permission = true; }, async grant() { permission = false; for (const value of nativeRuns.values()) if (value.args.operation === "prepare") await dispatch(value.args); },
    setSelect: (value: typeof selectResult) => { selectResult = value; },
    setSlow: (value: typeof slow) => { slow = value; }, setActivation: (value: Promise<void>) => { activation = value; },
    setClosing: (value: Promise<void>) => { closing = value; }, setCreation: (value: Promise<void>) => { creation = value; },
    failNextRunnerClose(count = 1) { failRunnerCloses = count; }, failNextStrictClose(count = 1) { failStrictCloses = count; },
    failLookup: () => { lookupFailed = true; }, failSelect: () => { selectFails = true; }, setSelecting: (value: Promise<void>) => { selecting = value; },
    failPendingSelect: () => { for (const run of nativeRuns.values()) if (run.args.operation === "select") run.finish?.({ status: "failed" }); } };
}
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const search = async (f: ReturnType<typeof fixture>, query: string) => { f.engine.update({ query, fixed: false, active: true }); await vi.advanceTimersByTimeAsync(151); await flush(); };
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("does no startup/native query for blank, whitespace or composing input; dynamic debounce is independent", async () => {
  const f = fixture(); f.engine.update({ query: "", fixed: false, active: true }); await vi.advanceTimersByTimeAsync(200);
  f.engine.update({ query: "   ", fixed: false, active: true }); await vi.advanceTimersByTimeAsync(200);
  f.engine.update({ query: "拼", fixed: false, active: true, composing: true }); await vi.advanceTimersByTimeAsync(200);
  expect(f.calls).toEqual([]);
  f.engine.update({ query: "原文", fixed: false, active: true });
  expect(f.calls).toEqual([]); expect(f.latest().rows).toEqual([]);
  await vi.advanceTimersByTimeAsync(151); await flush(); expect(f.latest().rows[0].label).toBe("原文");
  await f.engine.close(); expect(f.listeners.size).toBe(0);
});
it("normalizes display only, keeps exact original query and sends native content-redacted metadata", async () => {
  const f = fixture(); await search(f, "  原文 😀 café  ");
  expect(f.queries).toEqual(["  原文 😀 café  "]); expect(f.latest().rows[0]).toMatchObject({ label: "  原文 😀 café  ", icon: "safe:local.png", plugin_id: "fixed" });
  const executions = f.calls.filter(call => call.command === "run_plugin_main_push");
  expect(executions.map(value => value.args.operation)).toEqual(["prepare", "query"]);
  expect(JSON.stringify(executions)).not.toContain("原文");
  expect(f.calls.find(call => call.command === "complete_plugin_main_push" && call.args.outcome === "ready")?.args).not.toHaveProperty("payload");
  await f.engine.close();
});
it("keeps one stable provider permission request and executes only latest query after approval", async () => {
  const f = fixture(); f.setPermission(); await search(f, "old"); await search(f, "latest");
  expect(f.calls.filter(call => call.command === "run_plugin_main_push")).toHaveLength(1); expect(f.panels.size).toBe(0);
  await vi.advanceTimersByTimeAsync(10000); expect(f.panels.size).toBe(0);
  await f.grant(); await flush(); expect(f.queries).toEqual(["latest"]);
  await vi.waitFor(() => expect(f.latest().rows[0]?.label).toBe("latest"));
  await f.engine.close();
});
it("coalesces bursts, cancels obsolete callback and never publishes a late row", async () => {
  const f = fixture(); let finish!: (value: any) => void;
  f.setSlow((query, id) => query === "old" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ requestId: id, outcome: "ready", rows: [{ handle: id + ":0", text: query, description: "", icon: "", highlight: true }] }));
  await search(f, "old"); f.engine.update({ query: "middle", fixed: false, active: true }); f.engine.update({ query: "latest", fixed: false, active: true });
  expect(f.latest().rows).toEqual([]); await vi.advanceTimersByTimeAsync(151); await flush();
  finish({ requestId: "old", outcome: "ready", rows: [{ handle: "old:0", text: "STALE", description: "", icon: "", highlight: true }] }); await flush();
  expect(f.queries).toEqual(["old", "latest"]); expect(f.latest().rows.map(row => row.label)).toEqual(["latest"]);
  await f.engine.close();
});
it("does not overlap actual iframe callbacks after cancelling the native metadata task", async () => {
  const f = fixture(); let active = 0, maximum = 0, finish!: () => void;
  f.setSlow(async (query, id) => { active++; maximum = Math.max(maximum, active);
    if (query === "old") await new Promise<void>(resolve => { finish = resolve; });
    active--; return { requestId: id, outcome: "empty", rows: [] }; });
  await search(f, "old"); await search(f, "latest");
  expect(maximum).toBe(1); expect(f.queries).toEqual(["old"]);
  finish(); await flush(); expect(f.queries).toEqual(["old", "latest"]); expect(maximum).toBe(1);
  await f.engine.close();
});
it("caps live providers at two, reports deferred count and drains revoked providers", async () => {
  const f = fixture(); f.setCandidates([candidate("a"), candidate("b"), candidate("c")]); await search(f, "fixed");
  expect(f.panels.size).toBe(2); expect(f.latest().deferred).toBe(1); expect(f.latest().rows).toHaveLength(2);
  f.listeners.get("plugin-main-push-invalidated")?.({ payload: { pluginId: "a" } }); await flush();
  expect(f.latest().rows).toHaveLength(1); expect(f.closures[0]).toHaveBeenCalledOnce();
  await f.engine.close(); expect(f.closures[1]).toHaveBeenCalledOnce();
});
it("a second startup queues before native execution while the first provider awaits visible permission", async () => {
  const f = fixture(); f.setCandidates([candidate("a"), candidate("b")]); f.setPermission(); await search(f, "fixed");
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.calls.filter(call => call.command === "run_plugin_main_push" && call.args.operation === "prepare")).toHaveLength(1);
  expect(f.panels.size).toBe(0);
  await f.grant(); await flush(); await vi.waitFor(() => expect(f.latest().rows).toHaveLength(2));
  expect(f.calls.filter(call => call.command === "run_plugin_main_push" && call.args.operation === "prepare")).toHaveLength(2);
  await f.engine.close();
});
it("acknowledges direct select without entry and promotes literal true through owner activation once", async () => {
  const f = fixture(); await search(f, "fixed"); const code = f.latest().rows[0].code;
  await f.engine.select(code); expect(f.activate).not.toHaveBeenCalled();
  f.setSelect("enter"); await f.engine.select(code); expect(f.activate).toHaveBeenCalledOnce();
  const panel = [...f.panels.values()][0]; expect(panel.mainPushPromote).toHaveBeenCalledWith(expect.objectContaining({ payload: "fixed", type: "over", code: "search-fixed", handle: expect.any(String) }));
  f.engine.update({ query: "fixed", fixed: false, active: false });
  expect(f.latest().promotedId).not.toBeNull(); expect(f.closures[0]).not.toHaveBeenCalled();
  await f.engine.close();
});
it("auto-detaches an entered main-push action with its validated type and drains only the selected real runner", async () => {
  const f = fixture(); f.setCandidates([candidate("a"), candidate("b")]); f.setSelect("enter"); await search(f, "fixed");
  const opened: FeatureAction[] = [];
  let generation = 0;
  tauri.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command !== "activate_feature") return undefined;
    return { plugin_id: String(args.expectedPluginId), plugin_name: "Push Plugin", feature_code: String(args.code),
      main_url: "index.html", plugin_path: "/isolated/plugin", expand_height: 400, payload: args.payload, auto_detach: true } satisfies FeatureAction;
  });
  const session = createLauncherPluginSessionController({
    state: { activePlugin: null, pluginActivationError: "", results: [], selectedIndex: 0, searchRunId: 1, pluginLifecycleNotice: null,
      webQuickOpenEntries: [], localLaunchEntries: [] } as never,
    pendingPluginActivation: { cancel: () => true, isCurrent: () => false, clear: () => undefined } as never,
    pluginCodeLifecycle: { beginActivation: () => ({ generation: ++generation, mutation: 0 }), start: async () => undefined,
      isCurrent: (token: PluginActivationToken) => token.generation === generation } as never,
    contentSearch: { clear: vi.fn() } as never,
    mediaSearch: { cancelIntake: vi.fn(), clear: vi.fn() } as never,
    returnCoordinator: { invalidate: vi.fn(), returnToSearch: async () => undefined },
    returnContext: { clear: vi.fn() },
    isDetachWindow: false,
    openPluginDetachAction: async value => { opened.push(value); return true; },
    getMainPushHostInstance: () => null,
    activateSystemDestination: async () => undefined, openUrl: async () => undefined,
    openLocalLaunchEntry: async () => undefined, openLocalAppPath: async () => undefined,
    activatePastedResult: async () => undefined, activateTextQuickAction: async () => undefined,
  });
  f.activate.mockImplementation(async (selectedCandidate: MainPushCandidate, query: string,
    promote: (action: FeatureAction) => void, isCurrent: () => boolean, closeSelectedRunner: () => Promise<void>) => {
    await session.activateMainPush(selectedCandidate, query, promote, isCurrent, closeSelectedRunner);
  });
  const selected = f.latest().rows.find(row => row.plugin_id === "a")!;
  const panelsBeforeSelection = [...f.panels.values()];
  await f.engine.select(selected.code);
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatchObject({ feature_code: "search-a", plugin_id: "a", payload: "fixed", entry_type: "over" });
  expect(panelsBeforeSelection.every(panel => vi.mocked(panel.mainPushPromote).mock.calls.length === 0)).toBe(true);
  expect(f.closures[0]).toHaveBeenCalledOnce();
  expect(f.closures[1]).toHaveBeenCalledOnce();
  expect(f.latest().promotedId).toBeNull();
  expect(f.latest().rows).toEqual([]);
  expect(f.calls.some(call => call.command === "complete_plugin_main_push" && call.args.outcome === "enter")).toBe(true);
  expect(f.calls.some(call => call.command === "complete_plugin_main_push" && call.args.outcome === "superseded")).toBe(false);
  expect(tauri.invoke).not.toHaveBeenCalledWith("expand_window", expect.anything());
  await f.engine.close();
});
it("changing query while activation is pending cannot promote old option", async () => {
  const f = fixture(); f.setSelect("enter"); await search(f, "old");
  let finish!: () => void; f.setActivation(new Promise(resolve => { finish = resolve; }));
  const selection = f.engine.select(f.latest().rows[0].code); await flush();
  f.engine.update({ query: "new", fixed: false, active: true }); finish(); await selection;
  expect([...f.panels.values()][0].mainPushPromote).not.toHaveBeenCalled();
  await f.engine.close();
});
it("panel/IME/unmount cancel pending permission and do not replay after approval", async () => {
  const f = fixture(); f.setPermission(); await search(f, "fixed");
  f.engine.update({ query: "fixed", fixed: false, active: false }); await flush(); await f.grant(); await flush();
  expect(f.panels.size).toBe(0); expect(f.calls.filter(call => call.command === "cancel_plugin_main_push")).toHaveLength(1);
  await f.engine.close(); expect(f.listeners.size).toBe(0);
});
it("approval racing the next candidate lookup cannot boot a now-unmatched provider", async () => {
  const f = fixture(); f.setPermission(); await search(f, "old");
  f.setCandidates([]); f.engine.update({ query: "unmatched", fixed: false, active: true }); await f.grant(); await flush();
  expect(f.panels.size).toBe(0);
  await vi.advanceTimersByTimeAsync(151); await flush(); expect(f.panels.size).toBe(0); expect(f.queries).toEqual([]);
  await f.engine.close();
});
it("evicts the first newly created runner after thirty idle seconds and closes its native admission", async () => {
  const f = fixture(); await search(f, "fixed");
  await vi.advanceTimersByTimeAsync(29998); expect(f.latest().rows).toHaveLength(1); expect(f.closures[0]).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(3); await flush();
  expect(f.latest().rows).toEqual([]); expect(f.latest().message).toContain("继续输入");
  expect(f.closures[0]).toHaveBeenCalledOnce(); expect(f.calls.filter(call => call.command === "close_plugin_main_push_runner")).toHaveLength(1);
  await f.engine.close();
});
it("counts idle time after callbacks and direct selection, excluding visible permission and active query waits", async () => {
  const f = fixture(); f.setPermission(); await search(f, "fixed");
  await vi.advanceTimersByTimeAsync(60000); expect(f.panels.size).toBe(0);
  await f.grant(); await flush(); await vi.waitFor(() => expect(f.latest().rows).toHaveLength(1));
  await vi.advanceTimersByTimeAsync(20000); await f.engine.select(f.latest().rows[0].code);
  await vi.advanceTimersByTimeAsync(20000); expect(f.closures[0]).not.toHaveBeenCalled();
  let finish!: (reply: any) => void; f.setSlow((_query, _id) => new Promise(resolve => { finish = resolve; }));
  await search(f, "still running"); await vi.advanceTimersByTimeAsync(60000); expect(f.closures[0]).not.toHaveBeenCalled();
  finish({ requestId: "fixed", outcome: "empty", rows: [] }); await flush();
  await vi.advanceTimersByTimeAsync(30001); expect(f.closures[0]).toHaveBeenCalledOnce();
  await f.engine.close();
});
it("unmount awaits the existing invalidation drain instead of returning before its owned panel closes", async () => {
  const f = fixture(); await search(f, "fixed"); let finish!: () => void;
  f.setClosing(new Promise<void>(resolve => { finish = resolve; }));
  f.listeners.get("plugin-main-push-invalidated")?.({ payload: { pluginId: "fixed" } }); await flush();
  expect(f.closures[0]).toHaveBeenCalledOnce(); let closed = false;
  const disposal = f.engine.close().then(() => { closed = true; }); await flush(); expect(closed).toBe(false);
  finish(); await disposal; expect(closed).toBe(true); expect(f.closures[0]).toHaveBeenCalledOnce(); expect(f.listeners.size).toBe(0);
});

it("keeps foreground release blocked until the selected panel's strict resource drain finishes", async () => {
  const f = fixture(); await search(f, "fixed");
  let finish!: () => void;
  f.setClosing(new Promise<void>(resolve => { finish = resolve; }));
  let released = false;
  const release = f.engine.releaseForForeground().then(() => { released = true; });
  await flush();
  expect(f.strictClosures[0]).toHaveBeenCalledOnce();
  expect(f.closures[0]).toHaveBeenCalledOnce();
  expect(f.unmounts[0]).not.toHaveBeenCalled();
  expect(released).toBe(false);
  finish(); await release;
  expect(f.unmounts[0]).toHaveBeenCalledOnce();
  expect(released).toBe(true);
  await f.engine.close();
});
it("drains an owned panel whose asynchronous creation finishes after cancellation", async () => {
  const f = fixture(); let finish!: () => void; f.setCreation(new Promise<void>(resolve => { finish = resolve; }));
  await search(f, "fixed"); expect(f.panels.size).toBe(0); let closed = false;
  const disposal = f.engine.close().then(() => { closed = true; }); await flush(); expect(closed).toBe(false);
  finish(); await disposal; expect(closed).toBe(true); expect(f.closures[0]).toHaveBeenCalledOnce();
});
it("rejecting an oversized query drains retained providers instead of leaving an unbounded idle runner", async () => {
  const f = fixture(); await search(f, "fixed"); await search(f, "x".repeat(256 * 1024 + 1));
  expect(f.latest().message).toContain("256 KiB"); expect(f.latest().rows).toEqual([]); expect(f.closures[0]).toHaveBeenCalledOnce();
  await f.engine.close();
});
it("a failed current candidate lookup drains the old prepare permission and never boots its obsolete provider", async () => {
  const f = fixture(); f.setPermission(); await search(f, "old"); f.failLookup(); await search(f, "new");
  expect(f.calls.filter(call => call.command === "cancel_plugin_main_push")).toHaveLength(1);
  await f.grant(); await flush(); expect(f.panels.size).toBe(0); await f.engine.close();
});
it("a failed selection destroys all old options and awaits panel/native-admission cleanup before returning", async () => {
  const f = fixture(); await search(f, "fixed"); const code = f.latest().rows[0].code; f.failSelect();
  let finish!: () => void; f.setClosing(new Promise<void>(resolve => { finish = resolve; }));
  let finished = false; const selection = f.engine.select(code).then(() => { finished = true; }); await flush();
  expect(f.latest().rows).toEqual([]); expect(f.engine.owns(code)).toBe(false); expect(finished).toBe(false);
  expect(f.calls.filter(call => call.command === "close_plugin_main_push_runner")).toHaveLength(1);
  await f.engine.select(code); expect(f.calls.filter(call => call.command === "run_plugin_main_push" && call.args.operation === "select")).toHaveLength(1);
  finish(); await selection; await f.engine.close();
});
it("IME resume waits for the same-key closing runner then queries a new owned panel exactly once", async () => {
  const f = fixture(); await search(f, "fixed"); let finish!: () => void;
  f.setClosing(new Promise<void>(resolve => { finish = resolve; }));
  f.engine.update({ query: "fixed", fixed: false, active: true, composing: true }); await flush();
  f.engine.update({ query: "resumed", fixed: false, active: true }); await vi.advanceTimersByTimeAsync(151); await flush();
  expect(f.panels.size).toBe(1); expect(f.latest().rows).toEqual([]);
  finish(); await flush(); expect(f.panels.size).toBe(2); expect(f.queries).toEqual(["fixed", "resumed"]);
  expect(f.latest().rows[0]?.label).toBe("resumed"); await f.engine.close();
});
it("native selection failure drains the frame while its old callback is still pending and cannot invoke another handle", async () => {
  const f = fixture(); await search(f, "fixed"); const code = f.latest().rows[0].code; let finish!: () => void;
  f.setSelecting(new Promise<void>(resolve => { finish = resolve; })); const selection = f.engine.select(code); await flush();
  expect(f.selections).toHaveLength(1); f.failPendingSelect(); await selection;
  expect(f.latest().rows).toEqual([]); expect(f.closures[0]).toHaveBeenCalledOnce(); await f.engine.select(code); expect(f.selections).toHaveLength(1);
  finish(); await flush(); expect(f.latest().rows).toEqual([]); await f.engine.close();
});
it("a renderer select deadline rejection destroys the runner instead of retaining remaining raw options", async () => {
  const f = fixture(); await search(f, "fixed"); const code = f.latest().rows[0].code;
  f.setSelecting(new Promise<void>((_resolve, reject) => setTimeout(() => reject(Error("ERR_MAIN_PUSH_TIMEOUT")), 3000)));
  const selection = f.engine.select(code); await flush(); await vi.advanceTimersByTimeAsync(3001); await selection;
  expect(f.latest().rows).toEqual([]); expect(f.engine.owns(code)).toBe(false); expect(f.closures[0]).toHaveBeenCalledOnce(); await f.engine.close();
});

it("retains a failed native close, occupies its slot, and retries only through the explicit cleanup API", async () => {
  const f = fixture(); await search(f, "first"); f.failNextRunnerClose();
  f.listeners.get("plugin-main-push-invalidated")?.({ payload: { pluginId: "fixed" } }); await flush();
  expect(f.latest().rows).toEqual([]); expect(f.latest().message).toBe("插件搜索运行环境未能关闭，暂占用运行名额");
  expect(f.engine.retainedRuntimes()).toEqual([{ id: f.runnerIds[0], pluginId: "fixed", codeRevision: "revision-1", phase: "cleanup_failed" }]);
  expect(Object.keys(f.engine.retainedRuntimes()[0]).sort()).toEqual(["codeRevision", "id", "phase", "pluginId"].sort());
  const samePluginFeature = { ...candidate("fixed"), featureCode: "other-action", result: { ...candidate("fixed").result, code: "other-action" } };
  f.setCandidates([samePluginFeature, candidate("fixed")]);
  await search(f, "blocked");
  expect(f.runnerIds).toHaveLength(1); expect(f.calls.filter(call => call.command === "close_plugin_main_push_runner")).toHaveLength(1);
  await f.engine.retryCleanup(f.runnerIds[0]);
  expect(f.engine.retainedRuntimes()).toEqual([]);
  expect(f.calls.filter(call => call.command === "close_plugin_main_push_runner")).toHaveLength(2);
  f.setCandidates([{ ...samePluginFeature, codeRevision: "revision-2" }]);
  await search(f, "after retry"); expect(f.runnerIds).toHaveLength(2); await f.engine.close();
});

it("shares parallel release cleanup, retains strict-close failure, then isolates retry from a newer runtime", async () => {
  const f = fixture(); await search(f, "fixed"); f.failNextStrictClose();
  const firstRelease = f.engine.releaseForForeground(), secondRelease = f.engine.releaseForForeground();
  const results = await Promise.allSettled([firstRelease, secondRelease]);
  expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
  expect(f.calls.filter(call => call.command === "close_plugin_main_push_runner")).toHaveLength(1);
  expect(f.strictClosures[0]).toHaveBeenCalledOnce(); expect(f.closures[0]).toHaveBeenCalledOnce();
  expect(f.closeOptions[0]).toEqual([]);
  expect(f.stopCalls).toHaveLength(0);
  expect(f.engine.retainedRuntimes()).toEqual([{ id: f.runnerIds[0], pluginId: "fixed", codeRevision: "revision-1", phase: "cleanup_failed" }]);
  await f.engine.retryCleanup(f.runnerIds[0]);
  expect(f.engine.retainedRuntimes()).toEqual([]);
  expect(f.calls.filter(call => call.command === "close_plugin_main_push_runner")).toHaveLength(2);
  expect(f.closeOptions[1]).toEqual([{ retry: true }]);
  await search(f, "after cleanup"); expect(f.runnerIds).toHaveLength(2);
  await f.engine.retryCleanup(f.runnerIds[0]);
  expect(f.runnerIds).toHaveLength(2); expect(f.latest().rows[0]?.label).toBe("after cleanup");
  await f.engine.close();
});

it("attempts every runner and native listener cleanup before rejecting, then a later close drains retained runners", async () => {
  const f = fixture(); f.setCandidates([candidate("a"), candidate("b")]); await search(f, "fixed"); f.failNextRunnerClose();
  await expect(f.engine.close()).rejects.toThrow("ERR_MAIN_PUSH_CLEANUP");
  expect(f.calls.filter(call => call.command === "close_plugin_main_push_runner")).toHaveLength(2);
  expect(f.stopCalls).toHaveLength(3);
  expect(f.engine.retainedRuntimes()).toEqual([{ id: f.runnerIds[0], pluginId: "a", codeRevision: "revision-1", phase: "cleanup_failed" }]);
  expect(f.closeOptions[0]).toEqual([]);
  await f.engine.close();
  expect(f.calls.filter(call => call.command === "close_plugin_main_push_runner")).toHaveLength(3);
  expect(f.closeOptions[2]).toEqual([{ retry: true }]);
  expect(f.engine.retainedRuntimes()).toEqual([]);
});

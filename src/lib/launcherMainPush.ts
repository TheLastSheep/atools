import { createPluginMainPushNative } from "./pluginMainPushNative";
import { createPluginMainPushDeadline } from "./pluginMainPushDeadline";
import { MAIN_PUSH_LIMITS, mainPushCandidateKey, mainPushGroupKey, mainPushRowCode,
  type MainPushCandidate, type MainPushDispatch, type MainPushEntry, type MainPushInvoke, type MainPushPanel, type MainPushReply } from "./pluginMainPushProtocol";
import type { FeatureAction, SearchResult } from "./types";
import { searchMatchForQuery } from "./searchMatch";
type RunnerHandle = { panel: MainPushPanel; ready: Promise<void>; resolveIcon: (value: string) => Promise<string>;
  close: (options?: { retry?: boolean }) => Promise<void> };
type Runner = { id: string; key: string; candidate: MainPushCandidate; handle?: RunnerHandle; opening?: Promise<void>; creating?: Promise<RunnerHandle>;
  prepareId?: string; queryId?: string; selectId?: string; generation: number; query: string; rows: SearchResult[];
  rawHandles: Map<string, string>; closing: boolean; cleanupFailed?: boolean; closure?: Promise<void>; promoted: boolean; waiting: boolean;
  deadline?: ReturnType<typeof createPluginMainPushDeadline>; idle?: ReturnType<typeof setTimeout>; latest?: { query: string; generation: number; type: string };
  confirmed: number; confirmations: Set<() => void>; running: boolean; callbackDone?: Promise<MainPushReply> };
export type MainPushState = { rows: SearchResult[]; pending: boolean; deferred: number; message: string; promotedId: string | null };
export type MainPushRetainedRuntime = Readonly<{ id: string; pluginId: string; codeRevision: string; phase: "cleanup_failed" }>;
type Context = { query: string; fixed: boolean; active: boolean; composing?: boolean; filter?: string };
const CLEANUP_ERROR = "ERR_MAIN_PUSH_CLEANUP";
const CLEANUP_MESSAGE = "插件搜索运行环境未能关闭，暂占用运行名额";

/** Independent source: no static matcher result or render awaits this scheduler. */
export function createLauncherMainPush(options: { invoke: MainPushInvoke; listen: Parameters<typeof createPluginMainPushNative>[0]["listen"];
  createRunner: (runner: { id: string; candidate: MainPushCandidate; action: FeatureAction }, waiting: (value: boolean) => void) => Promise<RunnerHandle>;
  changed: (state: MainPushState) => void; promoted: (id: string) => void;
  activate: (candidate: MainPushCandidate, query: string, commit: (action: FeatureAction) => void, isCurrent: () => boolean,
    closeSelectedRunner: () => Promise<void>) => Promise<void> }) {
  const runners = new Map<string, Runner>();
  let context: Context = { query: "", fixed: false, active: false }, generation = 0, disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined, startup: Promise<void> = Promise.resolve();
  let deferred = 0, message = "", pendingSearch = false, selected = false, promotedId: string | null = null;
  let promotingRunnerId: string | null = null;
  let disposal: Promise<void> | undefined;
  const native = createPluginMainPushNative({ invoke: options.invoke, listen: options.listen, invalidated: pluginId => {
    for (const runner of runners.values()) if (pluginId === null || runner.candidate.pluginId === pluginId) fireRemove(runner);
    message = retainedRuntimes().length ? CLEANUP_MESSAGE : "插件权限或内容已变化，请重新搜索"; publish();
  } });
  function current(version: number) { return !disposed && version === generation && context.active && !context.composing; }
  function publish() { if (!disposed) options.changed({ rows: [...runners.values()].filter(runner => !runner.closing && runner.generation === generation)
    .flatMap(runner => runner.rows).slice(0, MAIN_PUSH_LIMITS.totalRows), pending: pendingSearch || [...runners.values()].some(runner => !runner.closing && (runner.opening || runner.running)),
    deferred, message, promotedId }); }
  function remove(runner: Runner, retryFailed = false): Promise<void> {
    if (runner.closure) return runner.closure;
    if (runner.cleanupFailed && !retryFailed) return Promise.reject(Error(CLEANUP_ERROR));
    runner.closing = true; runner.rows = []; runner.rawHandles.clear(); runner.latest = undefined;
    runner.confirmations.forEach(resolve => { try { resolve(); } catch { /* wake every waiter before strict cleanup */ } }); runner.confirmations.clear();
    clearTimeout(runner.idle); try { runner.deadline?.close(); } catch { /* strict closes still run */ }
    const operation = Promise.resolve().then(async () => {
      try { runner.handle?.panel.mainPushCancel(); } catch { /* cancellation is best effort; strict closes below decide ownership */ }
      await Promise.allSettled([runner.prepareId, runner.queryId, runner.selectId].filter((id): id is string => !!id)
        .map(id => Promise.resolve().then(() => native.cancel(id))));
      let creationFailure: unknown;
      if (runner.creating) {
        try { await runner.creating; } catch (error) { creationFailure = error; }
      }
      const creationWasSuperseded = creationFailure instanceof Error && creationFailure.message === "ERR_MAIN_PUSH_SUPERSEDED";
      const attempts: Promise<unknown>[] = [Promise.resolve().then(() => native.closeRunner(runner.id))];
      if (runner.handle && !creationFailure) attempts.push(Promise.resolve().then(() => runner.handle!.close(
        retryFailed && runner.cleanupFailed ? { retry: true } : undefined)));
      const results = await Promise.allSettled(attempts);
      const failedResource = results.some(result => result.status === "rejected");
      const failedCreationCleanup = !!runner.handle && !!creationFailure && !creationWasSuperseded;
      if (failedResource || failedCreationCleanup) throw Error(CLEANUP_ERROR);
      runner.cleanupFailed = false;
      if (runners.get(runner.key) === runner) runners.delete(runner.key);
      if (promotedId === runner.id) promotedId = null;
      publish();
    });
    runner.closure = operation;
    void operation.then(() => {
      if (runner.closure === operation) runner.closure = undefined;
    }, () => {
      if (runner.closure === operation) runner.closure = undefined;
      runner.cleanupFailed = true;
      if (!disposed) message = CLEANUP_MESSAGE;
      publish();
    });
    publish(); return operation;
  }
  function fireRemove(runner: Runner) { void remove(runner).catch(() => undefined); }
  function retainedRuntimes(): readonly MainPushRetainedRuntime[] {
    return Object.freeze([...runners.values()].filter(runner => runner.cleanupFailed).map(runner => Object.freeze({
      id: runner.id, pluginId: runner.candidate.pluginId, codeRevision: runner.candidate.codeRevision, phase: "cleanup_failed" as const,
    })));
  }
  async function retryCleanup(runnerId: string) {
    const runner = [...runners.values()].find(value => value.id === runnerId);
    if (runner) await remove(runner, true);
  }
  function armIdle(runner: Runner) {
    clearTimeout(runner.idle);
    if (disposed || runner.closing || runner.promoted || runner.running || runner.opening || runner.latest || runner.selectId || runner.waiting || !runner.handle) return;
    runner.idle = setTimeout(() => { message = "插件搜索已暂停，继续输入可重新查询"; fireRemove(runner); }, MAIN_PUSH_LIMITS.idleMs);
  }
  function waitState(runner: Runner, waiting: boolean) { runner.waiting = waiting; runner.deadline?.setWaiting(waiting);
    if (waiting) clearTimeout(runner.idle); else armIdle(runner); void native.setWaiting(runner.id, waiting); }
  async function ensure(runner: Runner) {
    if (runner.handle) return;
    if (runner.opening) return runner.opening;
    const requestId = runner.prepareId = crypto.randomUUID();
    const previous = startup;
    let release!: () => void;
    startup = new Promise<void>(resolve => { release = resolve; });
    runner.opening = (async () => {
      try {
        // A queued provider has no executing native TaskRun or startup deadline.
        // Only the one owned startup may request visible resource permissions.
        await previous;
        if (runner.closing || disposed) throw Error("ERR_MAIN_PUSH_SUPERSEDED");
        const reply = await native.run({ requestId, runnerId: runner.id, candidate: runner.candidate, operation: "prepare", inputBytes: 0, generation: 0,
          execute: async (dispatch: MainPushDispatch) => {
            while (!runner.closing && !disposed && runner.confirmed !== generation) await new Promise<void>(resolve => runner.confirmations.add(resolve));
            if (runner.closing || disposed) return { requestId, outcome: "superseded" };
            runner.deadline = createPluginMainPushDeadline(MAIN_PUSH_LIMITS.startupMs);
            try {
              const creating = runner.creating = (async () => {
                const created = await options.createRunner({ id: runner.id, candidate: runner.candidate, action: dispatch.action }, waiting => waitState(runner, waiting));
                if (runner.closing || disposed) { runner.handle = created; await created.close(); runner.handle = undefined; throw Error("ERR_MAIN_PUSH_SUPERSEDED"); }
                runner.handle = created; return created;
              })();
              void creating.finally(() => { if (runner.creating === creating) runner.creating = undefined; }).catch(() => undefined);
              const handle = await runner.deadline.wait(creating.then(async created => { await created.ready; return created; }));
              return { requestId, outcome: !runner.closing && !disposed && handle ? "ready" : "superseded" };
            } finally { runner.deadline = undefined; }
          },
        });
        if (reply.outcome !== "ready") throw Error("ERR_MAIN_PUSH_STARTUP");
      } finally { release(); }
    })().finally(() => { runner.opening = undefined; runner.prepareId = undefined; publish(); });
    return runner.opening;
  }
  function actualCallback(runner: Runner, operation: Promise<MainPushReply>) {
    const done = operation.finally(() => { if (runner.callbackDone === done) runner.callbackDone = undefined; });
    runner.callbackDone = done; void done.catch(() => undefined); return done;
  }
  async function pump(runner: Runner) {
    if (runner.running || runner.closing || runner.promoted || !runner.latest) return;
    clearTimeout(runner.idle); runner.running = true; publish();
    try {
      await ensure(runner);
      while (!runner.closing && runner.latest && !runner.promoted) {
        await runner.callbackDone;
        if (runner.closing || !runner.latest) break;
        const latest = runner.latest; runner.latest = undefined;
        if (!current(latest.generation)) continue;
        runner.query = latest.query; runner.generation = latest.generation;
        const requestId = runner.queryId = crypto.randomUUID();
        const reply = await native.run({ requestId, runnerId: runner.id, candidate: runner.candidate, operation: "query", generation: latest.generation,
          inputBytes: new TextEncoder().encode(latest.query).byteLength,
          execute: () => actualCallback(runner, runner.handle!.panel.mainPushQuery(requestId, latest.generation, latest.query, latest.type)) });
        await runner.callbackDone;
        if (!current(latest.generation) || runner.closing) continue;
        if (reply.outcome === "failed") throw Error("ERR_MAIN_PUSH_QUERY");
        const rows = await Promise.all((reply.rows ?? []).map(async row => ({ ...runner.candidate.result,
          code: mainPushRowCode(runner.id, row.handle), label: row.text, explain: row.description,
          plugin_name: `${runner.candidate.result.plugin_name} · ${runner.candidate.result.label}`,
          icon: await runner.handle!.resolveIcon(row.icon), match_type: "main_push" })));
        if (!current(latest.generation) || runner.closing) continue;
        runner.rawHandles = new Map((reply.rows ?? []).map(row => [mainPushRowCode(runner.id, row.handle), row.handle]));
        runner.rows = rows; publish();
      }
    } catch { if (!runner.closing) { message = "插件搜索未完成，可修改内容后重试"; await remove(runner).catch(() => undefined); } }
    finally { runner.running = false; if (!runner.closing && runner.latest) void pump(runner); else armIdle(runner); publish(); }
  }
  async function search(version: number) {
    pendingSearch = true; publish();
    let candidates: MainPushCandidate[];
    try {
      candidates = await options.invoke<MainPushCandidate[]>("search_plugin_main_push_candidates", { query: context.query, fixedContent: context.fixed });
    } catch {
      if (current(version)) {
        message = "插件搜索暂不可用，普通搜索仍可使用";
        const results = await Promise.allSettled([...runners.values()].filter(runner => !runner.promoted && !runner.cleanupFailed).map(runner => remove(runner)));
        if (results.some(result => result.status === "rejected")) message = CLEANUP_MESSAGE;
      }
      if (version === generation) { pendingSearch = false; publish(); }
      return;
    }
    if (!current(version)) { if (version === generation) { pendingSearch = false; publish(); } return; }
    try {
      const filtered = context.fixed && context.filter?.trim() ? candidates.filter(candidate => searchMatchForQuery(context.filter!, {
        text: candidate.result.label, extraText: `${candidate.result.plugin_name} ${candidate.result.explain}`,
      })) : candidates;
      const selectedCandidates = filtered.slice(0, MAIN_PUSH_LIMITS.runners), keys = new Set(selectedCandidates.map(mainPushCandidateKey));
      deferred = Math.max(0, filtered.length - selectedCandidates.length);
      const retainedPlugins = new Set(retainedRuntimes().map(runtime => runtime.pluginId));
      if (selectedCandidates.some(candidate => retainedPlugins.has(candidate.pluginId))) { message = CLEANUP_MESSAGE; publish(); return; }
      const closing = [...runners.values()].filter(runner => !keys.has(runner.key));
      const closeResults = await Promise.allSettled(closing.map(runner => remove(runner)));
      if (closeResults.some(result => result.status === "rejected")) {
        message = CLEANUP_MESSAGE; publish(); return;
      }
      if (!current(version)) return;
      for (const candidate of selectedCandidates) {
        const key = mainPushCandidateKey(candidate);
        let runner = runners.get(key);
        if (runner?.cleanupFailed) { message = CLEANUP_MESSAGE; publish(); return; }
        if (runner?.closing) {
          try { await runner.closure; } catch { message = CLEANUP_MESSAGE; publish(); return; }
          if (!current(version)) return;
          runner = runners.get(key);
        }
        if (!runner && runners.size >= MAIN_PUSH_LIMITS.runners) { message = CLEANUP_MESSAGE; publish(); return; }
        if (!runner) { runner = { id: crypto.randomUUID(), key, candidate, generation: version, query: context.query, rows: [], rawHandles: new Map(),
          closing: false, promoted: false, waiting: false, running: false, confirmed: version, confirmations: new Set() }; runners.set(key, runner); }
        clearTimeout(runner.idle); runner.candidate = candidate;
        runner.confirmed = version; runner.confirmations.forEach(resolve => resolve()); runner.confirmations.clear();
        runner.latest = { query: context.query, generation: version, type: candidate.commandType };
        void pump(runner);
      }
    } catch { if (current(version)) message = "插件搜索暂不可用，普通搜索仍可使用"; }
    finally { if (version === generation) { pendingSearch = false; publish(); } }
  }
  function update(next: Context) {
    if (disposed || next.query === context.query && next.fixed === context.fixed && next.active === context.active
      && !!next.composing === !!context.composing && next.filter === context.filter) return;
    context = next; generation++; selected = false; message = retainedRuntimes().length ? CLEANUP_MESSAGE : ""; deferred = 0; pendingSearch = false; clearTimeout(timer);
    for (const runner of runners.values()) {
      if (runner.promoted && !next.active) continue;
      clearTimeout(runner.idle);
      runner.rows = []; runner.rawHandles.clear(); runner.latest = undefined;
      if (runner.queryId) { void native.cancel(runner.queryId); if (!runner.callbackDone) runner.handle?.panel.mainPushCancel(); }
      if (runner.selectId) { fireRemove(runner); continue; }
      if (!next.active || next.composing || !next.query.trim() && !next.fixed) {
        if (!runner.promoted) fireRemove(runner);
      }
    }
    publish();
    if (next.active && !next.composing && (next.query.trim() || next.fixed && next.query.length)) {
      if (new TextEncoder().encode(next.query).byteLength > MAIN_PUSH_LIMITS.envelopeBytes) { message = "内容过长，插件搜索最多接收 256 KiB";
        for (const runner of runners.values()) if (!runner.promoted) fireRemove(runner); publish(); return; }
      timer = setTimeout(() => { void search(generation); }, MAIN_PUSH_LIMITS.debounceMs);
    }
  }
  async function enter(runner: Runner, entry: MainPushEntry, version: number) {
    const isCurrent = () => current(version) && !runner.closing && runner.generation === version;
    promotingRunnerId = runner.id;
    try {
      await releaseForForeground(runner.id);
      if (!isCurrent()) return;
      await options.activate(runner.candidate, runner.query, () => {
        if (!isCurrent() || !runner.handle) throw Error("ERR_MAIN_PUSH_SUPERSEDED");
        runner.handle.panel.mainPushPromote(entry); runner.promoted = true; promotedId = runner.id;
        for (const other of runners.values()) if (other !== runner) fireRemove(other);
        options.promoted(runner.id); publish();
      }, isCurrent, () => remove(runner));
    } finally { if (promotingRunnerId === runner.id) promotingRunnerId = null; }
  }
  async function releaseForForeground(selectedRunnerId?: string) {
    const preserve = selectedRunnerId ?? promotingRunnerId ?? promotedId ?? undefined;
    const results = await Promise.allSettled([...runners.values()].filter(runner => runner.id !== preserve).map(runner => remove(runner)));
    if (results.some(result => result.status === "rejected")) throw Error(CLEANUP_ERROR);
  }
  async function select(code: string) {
    if (selected) return;
    const runner = [...runners.values()].find(value => value.rawHandles.has(code)), version = generation;
    if (!runner?.handle || runner.closing || runner.generation !== version || !current(version) || !runner.queryId) return;
    clearTimeout(runner.idle); selected = true;
    const handle = runner.rawHandles.get(code)!, queryId = runner.queryId, requestId = runner.selectId = crypto.randomUUID();
    try {
      const reply = await native.run({ requestId, runnerId: runner.id, candidate: runner.candidate, operation: "select", inputBytes: 0, generation: version,
        execute: () => actualCallback(runner, runner.handle!.panel.mainPushSelect(requestId, queryId, version, handle)) });
      if (!current(version) || runner.closing) return;
      if (reply.outcome === "enter") await enter(runner, { code: runner.candidate.featureCode, type: runner.candidate.commandType,
        payload: runner.query, from: "main", queryId, handle }, version);
      else if (reply.outcome === "failed") { message = "这条结果未能执行，请重新搜索后再试"; await remove(runner); }
    } catch {
      if (current(version)) message = "这条结果未能执行，请重新搜索后再试";
      await remove(runner).catch(() => undefined);
      if (runner.cleanupFailed) { message = CLEANUP_MESSAGE; publish(); }
    }
    finally { runner.selectId = undefined; selected = false; armIdle(runner); publish(); }
  }
  return { update, select, owns: (code: string) => [...runners.values()].some(runner => !runner.closing && runner.rawHandles.has(code)),
    async enterGroup(group: string) { const runner = [...runners.values()].find(value => mainPushGroupKey(value.id) === group);
      if (runner?.queryId) { clearTimeout(runner.idle);
        try { await enter(runner, { code: runner.candidate.featureCode, type: runner.candidate.commandType, payload: runner.query, from: "main", queryId: runner.queryId }, generation); }
        finally { armIdle(runner); } } },
    activePanel: () => [...runners.values()].find(runner => runner.id === promotedId)?.handle?.panel,
    async closePromoted() { const runner = [...runners.values()].find(value => value.id === promotedId); if (runner) await remove(runner); },
    releaseForForeground,
    retryCleanup, retainedRuntimes,
    close() {
      disposed = true; clearTimeout(timer); generation++;
      if (disposal) return disposal;
      const operation = (async () => {
        const results = await Promise.allSettled([...runners.values()].map(runner => remove(runner, true)));
        let failed = results.some(result => result.status === "rejected");
        try { await native.close(); } catch { failed = true; }
        if (failed) throw Error(CLEANUP_ERROR);
      })();
      disposal = operation;
      void operation.then(() => { if (disposal === operation) disposal = undefined; }, () => { if (disposal === operation) disposal = undefined; });
      return operation;
    } };
}

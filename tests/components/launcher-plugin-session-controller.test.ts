import { beforeEach, expect, it, vi } from "vitest";
import { createLauncherPluginSessionController } from "../../src/lib/launcherPluginSessionController";
import { captureLauncherReturnContextIfCurrent, createLauncherReturnContextSnapshot, createLauncherReturnContextStore } from "../../src/lib/launcherReturnContext";
import type { FeatureAction } from "../../src/lib/types";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));

function action(code: string, autoDetach = false, pluginId = `owner:${code}`): FeatureAction {
  return {
    plugin_id: pluginId,
    plugin_name: "Test Plugin",
    feature_code: code,
    main_url: "index.html",
    plugin_path: "/plugins/test",
    expand_height: 400,
    payload: { original: code, nested: [1, 2] },
    auto_detach: autoDetach,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(options: { isDetachWindow?: boolean; open?: (value: FeatureAction, isCurrent?: () => boolean) => Promise<boolean> } = {}) {
  const state = {
    activePlugin: null as FeatureAction | null,
    pluginActivationError: "",
    results: [] as never[],
    selectedIndex: 0,
    searchRunId: 4,
    query: "selected query",
    activePanel: "home",
    pluginLifecycleNotice: null,
    webQuickOpenEntries: [] as never[],
    localLaunchEntries: [] as never[],
  };
  let generation = 0;
  let pending: { attemptId: number } | null = null;
  const pendingPluginActivation = {
    get current() { return pending; },
    isCurrent: (attempt: { attemptId: number }) => pending?.attemptId === attempt.attemptId,
    clear: (attempt?: { attemptId: number }) => { if (!attempt || pending?.attemptId === attempt.attemptId) pending = null; },
    cancel: () => { pending = null; return true; },
    setCurrent: (attempt: { attemptId: number } | null) => { pending = attempt; },
  };
  const returnCoordinator = {
    invalidate: vi.fn(),
    returnToSearch: vi.fn(async () => { state.activePlugin = null; state.searchRunId += 1; }),
  };
  const returnContext = { clear: vi.fn() };
  const openPluginDetachAction = vi.fn(options.open ?? (async () => true));
  const ports = {
    state,
    pendingPluginActivation,
    pluginCodeLifecycle: {
      beginActivation: () => ({ generation: ++generation, mutation: 0 }),
      captureActivation: () => ({ generation, mutation: 0 }),
      start: vi.fn(async () => undefined),
      isCurrent: (token: { generation: number }) => token.generation === generation,
    },
    contentSearch: { clear: vi.fn() },
    mediaSearch: { cancelIntake: vi.fn(), clear: vi.fn() },
    returnCoordinator,
    returnContext,
    isDetachWindow: options.isDetachWindow ?? false,
    openPluginDetachAction,
    getMainPushHostInstance: () => null,
    activateSystemDestination: vi.fn(async () => undefined),
    openUrl: vi.fn(async () => undefined),
    openLocalLaunchEntry: vi.fn(async () => undefined),
    openLocalAppPath: vi.fn(async () => undefined),
    activatePastedResult: vi.fn(async () => undefined),
    activateTextQuickAction: vi.fn(async () => undefined),
  } as unknown as Parameters<typeof createLauncherPluginSessionController>[0];
  return { state, ports, session: createLauncherPluginSessionController(ports), pendingPluginActivation, returnCoordinator, returnContext, openPluginDetachAction };
}

beforeEach(() => {
  tauri.invoke.mockReset();
  tauri.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "activate_feature") return action(String(args.code), false, String(args.expectedPluginId));
    return undefined;
  });
});

it("keeps normal activation in the launcher when auto_detach is false", async () => {
  const f = harness();
  const expected = action("plain", false);
  tauri.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => command === "activate_feature"
    ? expected : undefined);
  await f.session.activateFeature("plain", null, { expectedPluginId: expected.plugin_id });
  expect(f.openPluginDetachAction).not.toHaveBeenCalled();
  expect(f.state.activePlugin).toBe(expected);
  expect(f.returnCoordinator.returnToSearch).not.toHaveBeenCalled();
  expect(tauri.invoke).toHaveBeenCalledWith("expand_window", { height: expected.expand_height });
});

it("auto-detaches an owner-validated action, commits history hooks, and clears the old main panel", async () => {
  const f = harness();
  const oldAction = action("previous");
  f.state.activePlugin = oldAction;
  const expected = action("detach", true);
  tauri.invoke.mockImplementation(async (command: string) => command === "activate_feature" ? expected : undefined);
  const outcome = vi.fn(), committed = vi.fn();
  await f.session.activateFeature("detach", null, {
    expectedPluginId: expected.plugin_id,
    onOutcome: outcome,
    onCommitted: committed,
  });
  expect(f.openPluginDetachAction).toHaveBeenCalledWith(expected, expect.any(Function));
  expect(outcome).toHaveBeenCalledWith({ status: "committed" });
  expect(committed).toHaveBeenCalledWith(expected);
  expect(f.returnContext.clear).toHaveBeenCalledOnce();
  expect(f.returnCoordinator.returnToSearch).toHaveBeenCalledOnce();
  expect(f.state.activePlugin).toBeNull();
  expect(tauri.invoke).not.toHaveBeenCalledWith("expand_window", expect.anything());
});

it("auto-detaches redirects while retaining their launcher return context", async () => {
  const f = harness();
  f.state.activePlugin = action("redirect-source");
  const redirected = action("redirect-target", true);
  tauri.invoke.mockImplementation(async (command: string) => command === "activate_feature" ? redirected : undefined);
  await f.session.activateFeature("redirect-target", { from: "original redirect" }, {
    expectedPluginId: redirected.plugin_id,
    preserveLauncherReturnContext: true,
  });
  expect(f.openPluginDetachAction).toHaveBeenCalledWith(redirected, expect.any(Function));
  expect(f.returnContext.clear).not.toHaveBeenCalled();
  expect(f.returnCoordinator.returnToSearch).toHaveBeenCalledOnce();
});

it("captures the real launcher return context during detach commit and restores state if a hook throws", async () => {
  const f = harness();
  const expected = action("return-context", true);
  const item = { code: expected.feature_code, plugin_id: expected.plugin_id, plugin_name: "Test", label: "Selected", explain: "",
    icon: null, score: 10, match_type: "name" } as const;
  const context = createLauncherReturnContextSnapshot({ query: f.state.query, selection: item,
    results: [item], remoteSearchStatus: "ready", searchError: "" });
  const store = createLauncherReturnContextStore();
  f.ports.returnContext = store as never;
  const previous = action("previous");
  f.state.activePlugin = previous;
  tauri.invoke.mockImplementation(async (command: string) => command === "activate_feature" ? expected : undefined);

  await f.session.activateFeature("return-context", null, {
    expectedPluginId: expected.plugin_id,
    onCommitted: () => {
      expect(captureLauncherReturnContextIfCurrent(store,
        f.state as unknown as { searchRunId: number; query: string; activePanel: string; activePlugin: FeatureAction | null },
        { searchRunAtSelection: 4, context }, item)).toBe(true);
      throw new Error("post-capture observer failed");
    },
  });

  expect(store.consume()).toEqual(context);
  expect(f.state.activePlugin).toBeNull();
  expect(f.returnCoordinator.returnToSearch).toHaveBeenCalledOnce();
});

it("falls back to the same action and promotes only after a detach-open failure", async () => {
  const f = harness({ open: async () => { throw new Error("window unavailable"); } });
  const expected = action("fallback", true);
  tauri.invoke.mockImplementation(async (command: string) => command === "activate_feature" ? expected : undefined);
  const promote = vi.fn();
  await f.session.activateFeature("fallback", "exact", {
    expectedPluginId: expected.plugin_id,
    promoteMainPush: promote,
    detachedEntryType: "regex",
  });
  expect(f.openPluginDetachAction).toHaveBeenCalledWith({ ...expected, entry_type: "regex" }, expect.any(Function));
  expect(promote).toHaveBeenCalledWith(expected);
  expect(f.state.activePlugin).toBe(expected);
  expect(f.returnCoordinator.returnToSearch).not.toHaveBeenCalled();
  expect(tauri.invoke).toHaveBeenCalledWith("activate_feature", expect.objectContaining({ payload: "exact" }));
  expect(tauri.invoke).toHaveBeenCalledWith("expand_window", { height: expected.expand_height });
});

it("falls back to the main panel with a visible warning when the detached window is occupied", async () => {
  const f = harness({ open: async () => { throw new Error("PLUGIN_DETACH_WINDOW_OCCUPIED"); } });
  const expected = action("occupied", true);
  tauri.invoke.mockImplementation(async (command: string) => command === "activate_feature" ? expected : undefined);
  await f.session.activateFeature("occupied", null, { expectedPluginId: expected.plugin_id });
  expect(f.state.activePlugin).toBe(expected);
  expect(f.state.pluginActivationError).toBe("分离窗口正在使用，已在当前面板打开。");
  expect(tauri.invoke).toHaveBeenCalledWith("expand_window", { height: expected.expand_height });
});

it("does not open a stale auto-detach action in the main panel after native cancellation", async () => {
  const f = harness({ open: async () => false });
  const expected = action("stale-detach", true);
  tauri.invoke.mockImplementation(async (command: string) => command === "activate_feature" ? expected : undefined);
  const outcome = vi.fn();
  await f.session.activateFeature("stale-detach", null, { expectedPluginId: expected.plugin_id, onOutcome: outcome });
  expect(outcome).toHaveBeenCalledWith({ status: "superseded" });
  expect(f.state.activePlugin).toBeNull();
  expect(f.returnCoordinator.returnToSearch).not.toHaveBeenCalled();
  expect(tauri.invoke).not.toHaveBeenCalledWith("expand_window", expect.anything());
});

it("does not re-detach in a detached route and preserves main-frame smoke readiness", async () => {
  const detached = harness({ isDetachWindow: true });
  const detachedAction = action("detached", true);
  tauri.invoke.mockImplementation(async (command: string) => command === "activate_feature" ? detachedAction : undefined);
  await detached.session.activateFeature("detached", null, { expectedPluginId: detachedAction.plugin_id });
  expect(detached.openPluginDetachAction).not.toHaveBeenCalled();
  expect(detached.state.activePlugin).toBe(detachedAction);

  const smoke = harness();
  const smokeAction = action("smoke", true);
  tauri.invoke.mockImplementation(async (command: string) => command === "activate_feature" ? smokeAction : undefined);
  const ready = smoke.session.activateFeature("smoke", null, { expectedPluginId: smokeAction.plugin_id, waitForPluginReady: true });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  expect(tauri.invoke).toHaveBeenCalledWith("expand_window", { height: smokeAction.expand_height });
  smoke.session.handlePluginReady("smoke");
  expect(await ready).toBeGreaterThan(0);
  expect(smoke.openPluginDetachAction).not.toHaveBeenCalled();
  expect(smoke.returnCoordinator.returnToSearch).not.toHaveBeenCalled();
});

it("lets a newer activation keep its pending identity while an older handoff resolves", async () => {
  const firstOpen = deferred<boolean>();
  const secondAction = deferred<FeatureAction>();
  const f = harness({ open: () => firstOpen.promise });
  const first = action("first", true);
  const second = action("second", false);
  tauri.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command !== "activate_feature") return undefined;
    return args.code === "first" ? first : secondAction.promise;
  });
  const pendingFirst = { attemptId: 1 };
  const pendingSecond = { attemptId: 2 };
  f.pendingPluginActivation.setCurrent(pendingFirst);
  const firstOutcome = vi.fn();
  const firstRequest = f.session.activateFeature("first", null, {
    expectedPluginId: first.plugin_id,
    pendingPluginActivation: pendingFirst as never,
    isCancelled: () => !f.pendingPluginActivation.isCurrent(pendingFirst),
    onOutcome: firstOutcome,
  });
  await vi.waitFor(() => expect(f.openPluginDetachAction).toHaveBeenCalledOnce());
  f.pendingPluginActivation.setCurrent(pendingSecond);
  const secondRequest = f.session.activateFeature("second", null, {
    expectedPluginId: second.plugin_id,
    pendingPluginActivation: pendingSecond as never,
  });
  firstOpen.resolve();
  await firstRequest;
  expect(firstOutcome).toHaveBeenCalledWith({ status: "superseded" });
  expect(f.pendingPluginActivation.current).toBe(pendingSecond);
  expect(f.returnCoordinator.returnToSearch).not.toHaveBeenCalled();
  secondAction.resolve(second);
  await secondRequest;
  expect(f.state.activePlugin).toBe(second);
  expect(f.pendingPluginActivation.current).toBeNull();
});

it("rejects a delayed cancelled shortcut ticket before any launcher or plugin effect", async () => {
  const f = harness();
  const claim = deferred<FeatureAction>();
  const outcome = vi.fn();
  tauri.invoke.mockImplementation((command: string) => command === "activate_feature" ? claim.promise : Promise.resolve());
  const before = { ...f.state };
  const pending = f.session.activateFeature("late", null, {
    expectedPluginId: "owner:late", shortcutDispatchId: "0123456789abcdef0123456789abcdef", onOutcome: outcome,
  });
  await Promise.resolve();
  expect(f.ports.pluginCodeLifecycle.start).toHaveBeenCalledOnce();
  expect(f.returnCoordinator.invalidate).not.toHaveBeenCalled();
  claim.reject(new Error("SHORTCUT_DISPATCH_UNAVAILABLE"));
  await pending;
  expect(outcome).toHaveBeenCalledWith({ status: "failed", reason: "activation-failed" });
  expect(f.state).toEqual(before);
  expect(f.ports.mediaSearch.cancelIntake).not.toHaveBeenCalled();
  expect(f.openPluginDetachAction).not.toHaveBeenCalled();
  expect(f.returnCoordinator.returnToSearch).not.toHaveBeenCalled();
  expect(tauri.invoke).toHaveBeenCalledTimes(1);
});

it("supersedes a claimed shortcut if lifecycle identity changes during native resolution", async () => {
  const f = harness();
  const claim = deferred<FeatureAction>();
  const outcome = vi.fn();
  tauri.invoke.mockImplementation((command: string) => command === "activate_feature" ? claim.promise : Promise.resolve());
  const pending = f.session.activateFeature("late", null, {
    expectedPluginId: "owner:late", shortcutDispatchId: "0123456789abcdef0123456789abcdef", onOutcome: outcome,
  });
  await Promise.resolve();
  f.ports.pluginCodeLifecycle.beginActivation();
  claim.resolve(action("late"));
  await pending;
  expect(outcome).toHaveBeenCalledWith({ status: "superseded" });
  expect(f.state.activePlugin).toBeNull();
  expect(f.returnCoordinator.invalidate).not.toHaveBeenCalled();
  expect(f.openPluginDetachAction).not.toHaveBeenCalled();
  expect(tauri.invoke).toHaveBeenCalledTimes(1);
});

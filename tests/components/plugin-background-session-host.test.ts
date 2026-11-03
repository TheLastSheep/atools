import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/svelte";
import type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core";
import LauncherPrimarySurface from "../../src/components/LauncherPrimarySurface.svelte";
import PluginBackgroundSessionHost from "../../src/components/PluginBackgroundSessionHost.svelte";
import type { LauncherResultsSurfaceProps } from "../../src/components/LauncherResultsSurface.svelte";
import type { PluginPanelMountProps } from "../../src/lib/pluginPanelMount";
import { homeCommandStatus } from "../../src/lib/homeSurface";
import { DEFAULT_ATOOLS_SETTINGS } from "../../src/lib/settings";
import type { FeatureAction } from "../../src/lib/types";

type Invoke = <T = unknown>(command: string, args?: InvokeArgs, options?: InvokeOptions) => Promise<T>;
type Listen = <T>(event: string, receive: (event: { payload: T }) => void) => Promise<() => void>;

vi.mock("../../src/components/PluginPanel.svelte", async () => ({
  default: (await import("./PluginBackgroundPanelFixture.svelte")).default,
}));

afterEach(() => { cleanup(); document.body.replaceChildren(); });

const bootAction: FeatureAction = {
  plugin_id: "harris-plugin", plugin_name: "Harris Plugin", feature_code: "", main_url: "index.html",
  plugin_path: "/fixture/harris-plugin", expand_height: 420, payload: null, auto_detach: false,
};
const companionBootAction: FeatureAction = { ...bootAction, plugin_id: "harris-companion", plugin_name: "Harris Companion",
  plugin_path: "/fixture/harris-companion" };

function resultsSurface(): LauncherResultsSurfaceProps {
  const recentCommands: LauncherResultsSurfaceProps["recentCommands"] = [];
  return {
    results: [], selectedIndex: 0, query: "", feedback: { mode: "none", title: "", hint: "", showSpinner: false },
    onselect: () => {}, onselectionchange: () => {}, oncommandmenu: () => {}, canOpenCommandMenu: () => false,
    ongroupenter: () => {}, showQueryResults: false, showHomeRecent: false, showTabTargetStatus: false,
    recentCommands, recentSelectedIndex: 0, recentSelectedLabel: "",
    recentStatus: homeCommandStatus(recentCommands, 0, { pinnedRows: 1, recentRows: 2 }), settings: { ...DEFAULT_ATOOLS_SETTINGS },
    tabAction: "", tabTargetFeedback: "", featureCatalog: [],
    pushState: { rows: [], pending: false, deferred: 0, message: "", promotedId: null },
    onHomeCommand: () => {}, onHomePanelChange: () => {}, onRecentSelectionChange: () => {}, onRecentActivate: () => {},
    onRecentRemove: () => {}, onRecentCommandMenu: () => {}, onTargetSettings: () => {}, onBindResultsList: () => {},
  };
}

function surfaceProps(invoke: Invoke, listen: Listen, action: FeatureAction | null) {
  const panelPropsForAction = (next: FeatureAction): PluginPanelMountProps => ({
    action: next, onclose: () => {}, onescape: () => {}, onredirect: async () => false, onsettingsredirect: () => false,
    desktopSmokeExpectedSamples: 0, desktopSmokeSampleIndex: 0, desktopSmokeExternalPlanSample: false,
  });
  return {
    activePanel: "home" as const, expanded: true, contentVisible: true, searchVisible: action === null, targetHeight: 541,
    activationError: "", showSettingsHeader: false, query: "", placeholder: "Search", focusToken: 0, selectAllToken: 0,
    matchSummary: null, mediaContext: null, resultsExpanded: false, onQueryChange: () => {}, onMediaRemove: () => {},
    onMatchEdit: () => {}, onMatchRemove: () => {}, onBadgeClick: () => {}, onPaste: () => {}, onPanelChange: () => {},
    lifecycleNotice: null, detached: false, onReturn: () => {}, activePlugin: action, pluginPanelProps: panelPropsForAction(action ?? bootAction),
    backgroundEnabled: true, backgroundPanelPropsForAction: panelPropsForAction, hidePluginPanel: false, onPluginPanelInstance: () => {},
    onBackgroundPluginPanelInstance: () => {}, onBackgroundInvalidated: () => {}, resultsSurface: resultsSurface(), settingsMenu: "general" as const,
    marketRequest: null, onMarketRequest: () => {}, onMainPushInstance: () => {}, mainPushQuery: "", mainPushFixed: false,
    mainPushFilter: "", mainPushActive: false, mainPushPromotedId: null, invoke, listen, onMainPushClose: () => {}, onEscape: () => {},
    onRedirect: () => false, onSettingsRedirect: () => false, onMainPushUpdate: () => {}, onMainPushActivate: async () => {},
  };
}

it("keeps production host mounts stable across same-plugin entries and stacks a second resident", async () => {
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  const waitingCalls: Array<Record<string, unknown>> = [];
  const runs = new Map<string, { id: string; status: string; capabilityId: string; input: unknown; initiator: { clientId: string }; output: unknown }>();
  const candidates = [
    { pluginId: bootAction.plugin_id, pluginName: bootAction.plugin_name, codeRevision: "a".repeat(64), action: bootAction },
    { pluginId: companionBootAction.plugin_id, pluginName: companionBootAction.plugin_name, codeRevision: "b".repeat(64), action: companionBootAction },
  ];
  let runNumber = 0;
  const invoke: Invoke = async <T,>(command: string, rawArgs?: InvokeArgs) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    if (command === "list_plugin_background_candidates") return candidates as T;
    if (command === "run_plugin_background") {
      const runId = `background-task-${++runNumber}`, tool = `atools.host.plugin-background.${"a".repeat(24)}.${String(args.operation)}`;
      runs.set(runId, { id: runId, status: "running", capabilityId: tool, input: args, initiator: { clientId: "atools-ui" }, output: null });
      return { runId, tool, status: "running" } as T;
    }
    if (command === "get_task_run") return (runs.get(String(args.id)) ?? null) as T;
    if (command === "complete_plugin_background") {
      const run = [...runs.values()].find(value => (value.input as Record<string, unknown>).requestId === args.requestId);
      const input = run?.input as Record<string, unknown> | undefined;
      if (run) {
        run.status = "succeeded";
        run.output = { runtime: "plugin-background", operation: input?.operation, outcome: input?.operation === "start" ? "ready" : "closed",
          sessionId: args.sessionId, pluginId: input?.pluginId, codeRevision: input?.codeRevision };
      }
      return undefined as T;
    }
    if (command === "verify_plugin_background_session") return { valid: true } as T;
    if (command === "set_plugin_background_waiting") { waitingCalls.push(args); return undefined as T; }
    if (command === "close_plugin_background_session" || command === "cancel_plugin_background") return undefined as T;
    if (command === "search_plugin_main_push_candidates") return [] as T;
    return undefined as T;
  };
  const listen: Listen = async (event, receive) => {
    listeners.set(event, receive as (event: { payload: unknown }) => void);
    return () => listeners.delete(event);
  };
  const mounts: Array<{ pluginId: string; sessionId: string | null }> = [];
  const waitingControls = new Map<string, (waiting: boolean) => void>();
  const readyControls = new Map<string, () => void>();
  const stopControls = new Map<string, () => void>();
  const failCloseControls = new Map<string, () => void>();
  const strictCloseAttempts: Array<{ sessionId: string | null; retry: boolean }> = [];
  const entries: FeatureAction[] = [];
  const visibility: boolean[] = [];
  window.addEventListener("fixture-background-panel-mounted", event => {
    const detail = (event as CustomEvent).detail;
    mounts.push({ pluginId: detail.pluginId, sessionId: detail.sessionId });
    waitingControls.set(detail.pluginId, detail.setWaiting);
    readyControls.set(detail.pluginId, detail.ready);
    stopControls.set(detail.pluginId, detail.stop);
    failCloseControls.set(detail.pluginId, detail.failNextStrictClose);
  });
  window.addEventListener("fixture-background-panel-enter", event => entries.push((event as CustomEvent<FeatureAction>).detail));
  window.addEventListener("fixture-background-panel-visible", event => visibility.push((event as CustomEvent).detail.visible));
  window.addEventListener("fixture-background-panel-strict-close", event => strictCloseAttempts.push((event as CustomEvent).detail));
  const view = render(LauncherPrimarySurface, { props: surfaceProps(invoke, listen, null) });
  await waitFor(() => expect(listeners.has("plugin-background-dispatch")).toBe(true));
  const admitted = new Map<string, string>();
  for (const candidate of candidates) {
    await waitFor(() => expect(runNumber).toBe(candidates.indexOf(candidate) + 1));
    const run = [...runs.values()].find(value => (value.input as Record<string, unknown>).pluginId === candidate.pluginId)!;
    const request = run.input as Record<string, unknown>;
    admitted.set(candidate.pluginId, String(request.sessionId));
    listeners.get("plugin-background-dispatch")?.({ payload: {
      requestId: request.requestId, ticket: "11111111-1111-4111-8111-111111111111", sessionId: request.sessionId,
      operation: "start", pluginId: candidate.pluginId, codeRevision: candidate.codeRevision, action: candidate.action,
    } });
    await waitFor(() => expect(mounts.some(mount => mount.pluginId === candidate.pluginId)).toBe(true));
    if (candidate.pluginId === bootAction.plugin_id) {
      const runInput = run.input as Record<string, unknown>;
      waitingControls.get(candidate.pluginId)?.(true);
      await waitFor(() => expect(waitingCalls).toHaveLength(1));
      waitingControls.get(candidate.pluginId)?.(true);
      await waitFor(() => expect(waitingCalls).toHaveLength(1));
      waitingControls.get(candidate.pluginId)?.(false);
      await waitFor(() => expect(waitingCalls).toHaveLength(2));
      expect(waitingCalls).toEqual([
        { requestId: runInput.requestId, ticket: "11111111-1111-4111-8111-111111111111", waiting: true },
        { requestId: runInput.requestId, ticket: "11111111-1111-4111-8111-111111111111", waiting: false },
      ]);
    }
    readyControls.get(candidate.pluginId)?.();
    await waitFor(() => expect(run.status).toBe("succeeded"));
  }

  const first: FeatureAction = { ...bootAction, feature_code: "feature-one", entry_type: "over", payload: "first" };
  const second: FeatureAction = { ...bootAction, feature_code: "feature-one", entry_type: "over", payload: "second" };
  const companionEntry: FeatureAction = { ...companionBootAction, feature_code: "companion-entry", entry_type: "regex", payload: { exact: "companion" } };
  await view.rerender(surfaceProps(invoke, listen, first));
  await waitFor(() => expect(entries).toHaveLength(1));
  await waitFor(() => expect(view.container.querySelectorAll(".background-session-slot.visible")).toHaveLength(1));
  await view.rerender(surfaceProps(invoke, listen, null));
  await waitFor(() => expect(visibility.at(-1)).toBe(false));
  await view.rerender(surfaceProps(invoke, listen, second));
  await waitFor(() => expect(entries).toHaveLength(2));
  await waitFor(() => expect(view.container.querySelectorAll(".background-session-slot.visible")).toHaveLength(1));
  await view.rerender(surfaceProps(invoke, listen, null));
  await waitFor(() => expect(visibility.at(-1)).toBe(false));
  await view.rerender(surfaceProps(invoke, listen, companionEntry));
  await waitFor(() => expect(entries).toHaveLength(3));
  await waitFor(() => expect(view.container.querySelectorAll(".background-session-slot.visible")).toHaveLength(1));

  expect(mounts).toEqual([
    { pluginId: bootAction.plugin_id, sessionId: admitted.get(bootAction.plugin_id) },
    { pluginId: companionBootAction.plugin_id, sessionId: admitted.get(companionBootAction.plugin_id) },
  ]);
  expect(entries).toEqual([first, second, companionEntry]);
  expect(entries[0]).toMatchObject({ feature_code: "feature-one", entry_type: "over", payload: "first" });
  expect(entries[1]).toMatchObject({ feature_code: "feature-one", entry_type: "over", payload: "second" });
  expect(entries[2]).toMatchObject({ feature_code: "companion-entry", entry_type: "regex", payload: { exact: "companion" } });
  expect(visibility).toContain(true);
  const slots = [...view.container.querySelectorAll<HTMLElement>(".background-session-slot")];
  expect(slots).toHaveLength(2);
  expect(getComputedStyle(slots[0]).position).toBe("absolute");
  expect(slots.filter(slot => slot.classList.contains("visible"))).toEqual([slots[1]]);
  expect(view.container.querySelectorAll(".shell-frame")).toHaveLength(1);

  failCloseControls.get(companionBootAction.plugin_id)?.();
  stopControls.get(companionBootAction.plugin_id)?.();
  await waitFor(() => expect(runNumber).toBe(3));
  const stopRun = [...runs.values()].find(run => (run.input as Record<string, unknown>).operation === "stop")!;
  const stopInput = stopRun.input as Record<string, unknown>;
  listeners.get("plugin-background-dispatch")?.({ payload: {
    requestId: stopInput.requestId, ticket: "22222222-2222-4222-8222-222222222222", sessionId: stopInput.sessionId,
    operation: "stop", pluginId: companionBootAction.plugin_id, codeRevision: candidates[1].codeRevision,
    action: companionBootAction,
  } });
  const companionSessionId = admitted.get(companionBootAction.plugin_id)!;
  await waitFor(() => expect(strictCloseAttempts.filter(call => call.sessionId === companionSessionId)).toEqual([
    { sessionId: companionSessionId, retry: false }, { sessionId: companionSessionId, retry: false },
  ]));
});

it("retries a retained owner through the real background host with retry enabled", async () => {
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const runs = new Map<string, { id: string; status: string; capabilityId: string; input: unknown; initiator: { clientId: string }; output: unknown }>();
  const revision = "d".repeat(64);
  const candidate = { pluginId: bootAction.plugin_id, pluginName: bootAction.plugin_name, codeRevision: revision, action: bootAction };
  let runNumber = 0;
  const invoke: Invoke = async <T,>(command: string, rawArgs?: InvokeArgs) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    calls.push({ command, args });
    if (command === "list_plugin_background_candidates") return [candidate] as T;
    if (command === "run_plugin_background") {
      const runId = `cleanup-task-${++runNumber}`;
      const tool = `atools.host.plugin-background.${"b".repeat(24)}.${String(args.operation)}`;
      runs.set(runId, { id: runId, status: "running", capabilityId: tool, input: args, initiator: { clientId: "atools-ui" }, output: null });
      return { runId, tool, status: "running" } as T;
    }
    if (command === "get_task_run") return (runs.get(String(args.id)) ?? null) as T;
    if (command === "complete_plugin_background") {
      const run = [...runs.values()].find(value => (value.input as Record<string, unknown>).requestId === args.requestId);
      const input = run?.input as Record<string, unknown> | undefined;
      if (run) {
        run.status = args.outcome === "failed" ? "failed" : "succeeded";
        run.output = { runtime: "plugin-background", operation: input?.operation, outcome: input?.operation === "start" ? "ready" : "closed",
          sessionId: input?.sessionId, pluginId: input?.pluginId, codeRevision: input?.codeRevision };
      }
      return undefined as T;
    }
    if (command === "close_plugin_background_session" || command === "cancel_plugin_background") return undefined as T;
    return undefined as T;
  };
  const listen: Listen = async (event, receive) => {
    listeners.set(event, receive as (event: { payload: unknown }) => void);
    return () => listeners.delete(event);
  };
  const strictCloseAttempts: Array<{ sessionId: string | null; retry: boolean }> = [];
  const managed: string[][] = [];
  let failPanel!: () => void;
  let failNextStrictClose!: () => void;
  window.addEventListener("fixture-background-panel-mounted", event => {
    const detail = (event as CustomEvent).detail;
    failPanel = detail.failPanel;
    failNextStrictClose = detail.failNextStrictClose;
  });
  window.addEventListener("fixture-background-panel-strict-close", event => strictCloseAttempts.push((event as CustomEvent).detail));

  const view = render(PluginBackgroundSessionHost, { props: {
    enabled: true, activeAction: null, mainPushPromotedId: null,
    panelPropsForAction: (action: FeatureAction): PluginPanelMountProps => ({
      action, onclose: () => {}, onescape: () => {}, onredirect: async () => false, onsettingsredirect: () => false,
      desktopSmokeExpectedSamples: 0, desktopSmokeSampleIndex: 0, desktopSmokeExternalPlanSample: false,
    }),
    onPanelInstance: () => {}, onManagedPlugins: (pluginIds: string[]) => managed.push(pluginIds),
    releaseMainPushForForeground: async () => {}, onInvalidated: () => {}, invoke, listen,
  } });
  await waitFor(() => expect(runs.size).toBe(1));
  const startRun = [...runs.values()][0];
  const startInput = startRun.input as Record<string, unknown>;
  listeners.get("plugin-background-dispatch")?.({ payload: {
    requestId: startInput.requestId, ticket: "33333333-3333-4333-8333-333333333333", sessionId: startInput.sessionId,
    operation: "start", pluginId: candidate.pluginId, codeRevision: revision, action: candidate.action,
  } });
  await waitFor(() => expect(typeof failPanel).toBe("function"));
  failNextStrictClose();
  failPanel();
  const sessionId = String(startInput.sessionId);
  await waitFor(() => expect(strictCloseAttempts.filter(call => call.sessionId === sessionId)).toEqual([
    { sessionId, retry: false },
  ]));
  expect(managed.at(-1)).toContain(candidate.pluginId);

  await expect(view.component.retryCleanup(sessionId)).resolves.toBe(true);
  expect(strictCloseAttempts.filter(call => call.sessionId === sessionId)).toEqual([
    { sessionId, retry: false }, { sessionId, retry: true },
  ]);
  expect(managed.at(-1)).not.toContain(candidate.pluginId);
});

it("consumes a strict pool close rejection when the production host unmounts", async () => {
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  const runs = new Map<string, { id: string; status: string; capabilityId: string; input: unknown; initiator: { clientId: string }; output: unknown }>();
  const candidate = { pluginId: bootAction.plugin_id, pluginName: bootAction.plugin_name, codeRevision: "e".repeat(64), action: bootAction };
  let runNumber = 0;
  const invoke: Invoke = async <T,>(command: string, rawArgs?: InvokeArgs) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    if (command === "list_plugin_background_candidates") return [candidate] as T;
    if (command === "run_plugin_background") {
      const runId = `unmount-task-${++runNumber}`;
      const tool = `atools.host.plugin-background.${"c".repeat(24)}.${String(args.operation)}`;
      runs.set(runId, { id: runId, status: "running", capabilityId: tool, input: args, initiator: { clientId: "atools-ui" }, output: null });
      return { runId, tool, status: "running" } as T;
    }
    if (command === "get_task_run") return (runs.get(String(args.id)) ?? null) as T;
    if (command === "close_plugin_background_session") throw Error("ERR_FIXTURE_NATIVE_CLOSE");
    if (command === "complete_plugin_background" || command === "cancel_plugin_background") return undefined as T;
    return undefined as T;
  };
  const listen: Listen = async (event, receive) => {
    listeners.set(event, receive as (event: { payload: unknown }) => void);
    return () => listeners.delete(event);
  };
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const view = render(PluginBackgroundSessionHost, { props: {
    enabled: true, activeAction: null, mainPushPromotedId: null,
    panelPropsForAction: (action: FeatureAction): PluginPanelMountProps => ({
      action, onclose: () => {}, onescape: () => {}, onredirect: async () => false, onsettingsredirect: () => false,
      desktopSmokeExpectedSamples: 0, desktopSmokeSampleIndex: 0, desktopSmokeExternalPlanSample: false,
    }),
    onPanelInstance: () => {}, onManagedPlugins: () => {}, releaseMainPushForForeground: async () => {},
    onInvalidated: () => {}, invoke, listen,
  } });
  await waitFor(() => expect(runs.size).toBe(1));
  const startInput = [...runs.values()][0].input as Record<string, unknown>;
  listeners.get("plugin-background-dispatch")?.({ payload: {
    requestId: startInput.requestId, ticket: "44444444-4444-4444-8444-444444444444", sessionId: startInput.sessionId,
    operation: "start", pluginId: candidate.pluginId, codeRevision: candidate.codeRevision, action: candidate.action,
  } });
  await waitFor(() => expect(view.container.querySelector("[data-fixture-plugin]")).not.toBeNull());
  view.unmount();
  await waitFor(() => expect(warning).toHaveBeenCalledWith("[PluginBackground] strict session cleanup failed during unmount"));
  warning.mockRestore();
});

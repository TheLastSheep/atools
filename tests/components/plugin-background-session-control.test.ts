import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/svelte";
import type { ComponentProps } from "svelte";
import type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core";
import PluginBackgroundRuntimeControlFixture from "./PluginBackgroundRuntimeControlFixture.svelte";
import PluginBackgroundSessionHost from "../../src/components/PluginBackgroundSessionHost.svelte";
import type { PluginPanelMountProps } from "../../src/lib/pluginPanelMount";
import { createPluginRuntimeControl } from "../../src/lib/pluginRuntimeControl";
import { runtimeSessionId, type RuntimeSession } from "../../src/lib/pluginRuntimeInventory";
import type { FeatureAction } from "../../src/lib/types";

type Invoke = <T = unknown>(command: string, args?: InvokeArgs, options?: InvokeOptions) => Promise<T>;
type Listen = <T>(event: string, receive: (event: { payload: T }) => void) => Promise<() => void>;
type StoredRun = { id: string; status: string; capabilityId: string; input: Record<string, unknown>;
  initiator: { clientId: string }; output: unknown };
type FixtureHostProps = ComponentProps<typeof PluginBackgroundSessionHost>;
type MountDetail = { pluginId: string; sessionId: string; ready(): void; failNextStrictClose(): void };

const action: FeatureAction = {
  plugin_id: "harris-plugin", plugin_name: "Harris Plugin", feature_code: "", main_url: "index.html",
  plugin_path: "/fixture/harris-plugin", expand_height: 420, payload: null, auto_detach: false,
};
const revision = "a".repeat(64);
const controls: ReturnType<typeof createPluginRuntimeControl>[] = [];

vi.mock("../../src/components/PluginPanel.svelte", async () => ({
  default: (await import("./PluginBackgroundPanelFixture.svelte")).default,
}));

afterEach(() => {
  cleanup();
  for (const control of controls.splice(0)) control.dispose();
  document.body.replaceChildren();
});

function makeHarness() {
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  const runs = new Map<string, StoredRun>();
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  let sequence = 0;
  let nativeCloseFails = false;
  const candidate = { pluginId: action.plugin_id, pluginName: action.plugin_name, codeRevision: revision, action };
  const invoke: Invoke = async <T,>(command: string, rawArgs?: InvokeArgs) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    calls.push({ command, args });
    if (command === "list_plugin_background_candidates") return [candidate] as T;
    if (command === "run_plugin_background") {
      const operation = String(args.operation);
      const runId = `runtime-control-task-${++sequence}`;
      const tool = `atools.host.plugin-background.${"b".repeat(24)}.${operation}`;
      runs.set(runId, { id: runId, status: "running", capabilityId: tool, input: args,
        initiator: { clientId: "atools-ui" }, output: null });
      return { runId, tool, status: "running" } as T;
    }
    if (command === "get_task_run") return (runs.get(String(args.id)) ?? null) as T;
    if (command === "complete_plugin_background") {
      const run = [...runs.values()].find(value => value.input.requestId === args.requestId);
      if (run) {
        run.status = "succeeded";
        run.output = { runtime: "plugin-background", operation: run.input.operation, outcome: args.outcome,
          sessionId: args.sessionId, pluginId: run.input.pluginId, codeRevision: run.input.codeRevision };
      }
      return undefined as T;
    }
    if (command === "verify_plugin_background_session") return { valid: true } as T;
    if (command === "close_plugin_background_session") {
      if (nativeCloseFails) throw Error("ERR_FIXTURE_NATIVE_CLOSE");
      return undefined as T;
    }
    if (command === "cancel_plugin_background") return undefined as T;
    return undefined as T;
  };
  const listen: Listen = async (event, receive) => {
    listeners.set(event, receive as (event: { payload: unknown }) => void);
    return () => listeners.delete(event);
  };
  return {
    candidate, listeners, runs, calls, invoke, listen,
    failNativeClose() { nativeCloseFails = true; },
    latestOperation(operation: string) {
      return [...runs.values()].filter(run => run.input.operation === operation).at(-1)!;
    },
    dispatch(run: StoredRun, operation: "start" | "stop") {
      const input = run.input;
      listeners.get("plugin-background-dispatch")?.({ payload: {
        requestId: input.requestId, ticket: operation === "start"
          ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222",
        sessionId: input.sessionId, operation, pluginId: candidate.pluginId, codeRevision: revision, action,
      } });
    },
  };
}

function makeHostProps(harness: ReturnType<typeof makeHarness>): FixtureHostProps {
  const panelPropsForAction = (next: FeatureAction): PluginPanelMountProps => ({
    action: next, onclose: () => {}, onescape: () => {}, onredirect: async () => false, onsettingsredirect: async () => false,
    desktopSmokeExpectedSamples: 0, desktopSmokeSampleIndex: 0, desktopSmokeExternalPlanSample: false,
  });
  return {
    enabled: true, activeAction: null, mainPushPromotedId: null, panelPropsForAction,
    onPanelInstance: () => {}, onManagedPlugins: () => {}, releaseMainPushForForeground: async () => {},
    onInvalidated: () => {}, invoke: harness.invoke, listen: harness.listen,
  };
}

it("keeps disabled background services independent of UUID and native IPC availability", async () => {
  const control = createPluginRuntimeControl(); controls.push(control);
  const harness = makeHarness();
  const uuid = vi.spyOn(crypto, "randomUUID").mockImplementation(() => { throw new Error("UUID unavailable"); });
  try {
    const view = render(PluginBackgroundRuntimeControlFixture, { props: {
      control, hostProps: { ...makeHostProps(harness), enabled: false },
    } });
    expect(control.snapshot()).toEqual([]);
    expect(harness.calls).toEqual([]);
    view.unmount();
    await Promise.resolve();
    expect(uuid).not.toHaveBeenCalled();
  } finally { uuid.mockRestore(); }
});

async function mountReadyHost(control: ReturnType<typeof createPluginRuntimeControl>, harness: ReturnType<typeof makeHarness>) {
  const previousStarts = harness.calls.filter(call => call.command === "run_plugin_background" && call.args.operation === "start").length;
  let mounted!: MountDetail;
  const receiveMounted = (event: Event) => { mounted = (event as CustomEvent<MountDetail>).detail; };
  window.addEventListener("fixture-background-panel-mounted", receiveMounted, { once: true });
  const view = render(PluginBackgroundRuntimeControlFixture, { props: { control, hostProps: makeHostProps(harness) } });
  await waitFor(() => expect(harness.listeners.has("plugin-background-dispatch")).toBe(true));
  await waitFor(() => expect(harness.calls.filter(call => call.command === "run_plugin_background" && call.args.operation === "start").length)
    .toBeGreaterThan(previousStarts));
  const startRun = harness.latestOperation("start");
  harness.dispatch(startRun, "start");
  await waitFor(() => expect(mounted?.sessionId).toBe(String(startRun.input.sessionId)));
  mounted.ready();
  let row!: RuntimeSession;
  await waitFor(() => {
    row = control.snapshot().find(session => session.pluginId === harness.candidate.pluginId)!;
    expect(row?.phase).toBe("ready");
  });
  return { view, row, mounted };
}

it("publishes a metadata-only ready row and stops it through the production TaskRun receipt", async () => {
  const control = createPluginRuntimeControl(); controls.push(control);
  const harness = makeHarness();
  const { view, row } = await mountReadyHost(control, harness);
  const sessionId = String(harness.latestOperation("start").input.sessionId);
  expect(row).toEqual({
    id: runtimeSessionId("background", "main", sessionId), kind: "background", instanceId: sessionId,
    pluginId: action.plugin_id, windowLabel: "main", codeRevision: revision, phase: "ready", evidence: "renderer_view",
  });
  expect(row).not.toHaveProperty("action");

  const stopped = control.stop(row);
  await waitFor(() => expect(harness.calls.filter(call => call.command === "run_plugin_background")).toHaveLength(2));
  const stopRun = harness.latestOperation("stop");
  harness.dispatch(stopRun, "stop");
  await expect(stopped).resolves.toBeUndefined();
  expect(harness.calls).toContainEqual(expect.objectContaining({ command: "complete_plugin_background",
    args: expect.objectContaining({ outcome: "closed", sessionId }) }));
  expect(harness.calls).toContainEqual(expect.objectContaining({ command: "get_task_run",
    args: expect.objectContaining({ id: stopRun.id }) }));
  expect(control.snapshot()).toEqual([]);
  view.unmount();
});

it("keeps a failed stop visible as cleanup_failed instead of reporting an empty runtime", async () => {
  const control = createPluginRuntimeControl(); controls.push(control);
  const harness = makeHarness();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { view, row, mounted } = await mountReadyHost(control, harness);
  mounted.failNextStrictClose();
  const stopped = control.stop(row);
  await waitFor(() => expect(harness.calls.filter(call => call.command === "run_plugin_background")).toHaveLength(2));
  harness.dispatch(harness.latestOperation("stop"), "stop");
  await expect(stopped).rejects.toThrow("ERR_PLUGIN_RUNTIME_STOP_UNCONFIRMED");
  expect(control.snapshot()).toEqual([expect.objectContaining({ ...row, phase: "cleanup_failed" })]);
  harness.failNativeClose();
  view.unmount();
  await waitFor(() => expect(control.snapshot()).toEqual([expect.objectContaining({ ...row, phase: "cleanup_failed" })]));
  expect(warning).toHaveBeenCalledWith("[PluginBackground] strict session cleanup failed during unmount");
  warning.mockRestore();
});

it("rejects an old session snapshot without stopping a later same-plugin owner", async () => {
  const control = createPluginRuntimeControl(); controls.push(control);
  const harness = makeHarness();
  const first = await mountReadyHost(control, harness);
  const staleRow = first.row;
  first.view.unmount();
  await waitFor(() => expect(control.snapshot()).toEqual([]));

  const second = await mountReadyHost(control, harness);
  expect(second.row.pluginId).toBe(staleRow.pluginId);
  expect(second.row.instanceId).not.toBe(staleRow.instanceId);
  await expect(control.stop(staleRow)).rejects.toThrow("ERR_PLUGIN_RUNTIME_STALE");
  expect(harness.calls.filter(call => call.command === "run_plugin_background" && call.args.operation === "stop")).toHaveLength(0);
  expect(control.snapshot()).toEqual([second.row]);
  second.view.unmount();
});

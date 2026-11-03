import "../../src/styles/global.css";
import { flushSync, mount, tick, unmount } from "svelte";
import { mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { InstalledPlugin } from "../../src/lib/types";
import { createPluginRuntimeControl } from "../../src/lib/pluginRuntimeControl";
import { runtimeKinds, runtimeSessionId, type RuntimeSession, type RuntimeSnapshot } from "../../src/lib/pluginRuntimeInventory";
import PluginRuntimeBrowserFixture from "./PluginRuntimeBrowserFixture.svelte";

type IpcCall = { command: string; args: Record<string, unknown> | null };
type StopBehavior = "success" | "failure" | "hold";
type StopOutcome = "success" | "failure";
type HeldStop = { row: RuntimeSession; resolve: () => void; reject: (error: Error) => void };
type FixtureApi = {
  calls: IpcCall[];
  unexpectedCommands: string[];
  setNextRuntimeReadError(): void;
  setStopBehavior(instanceId: string, behavior: StopBehavior): void;
  resolveHeldStop(instanceId: string, outcome: StopOutcome): void;
  setNativeSnapshotEmpty(value: boolean): void;
  clearLocalRows(): void;
  dispose(): Promise<void>;
};

const failedStopId = "fixture-background-instance";
const successfulStopId = "fixture-background-success-instance";
const failedStopPluginId = "harris-pasteboard-pro-fixture";
const successfulStopPluginId = "harris-live-markdown-fixture";
const calls: IpcCall[] = [];
const unexpectedCommands: string[] = [];
const plugins = [
  plugin(failedStopPluginId, "Harris Pasteboard Pro（夹具）"),
  plugin(successfulStopPluginId, "Harris Live Markdown（夹具）"),
  plugin("harris-legacy-node-fixture", "Harris Legacy Node（夹具）"),
  plugin("harris-browser-window-fixture", "Harris Plugin Window（夹具）"),
];
const failedStopRow = session("background", "main", failedStopId, failedStopPluginId, "ready", "renderer_view", "a".repeat(64));
const successfulStopRow = session("background", "main", successfulStopId, successfulStopPluginId, "ready", "renderer_view", "b".repeat(64));
const legacyRow = session("legacy_node", null, "fixture-legacy-node-instance", "harris-legacy-node-fixture", "unknown", "node_owner", null);
const browserRow = session("browser_window", "plugin-fixture", "fixture-browser-window-instance", "harris-browser-window-fixture", "stopping", "native_window", null);
let nativeRows = [failedStopRow, successfulStopRow, legacyRow, browserRow];
let localRows: RuntimeSession[] = [failedStopRow, successfulStopRow];
let nextRuntimeReadError = false;
let nativeSnapshotEmpty = false;
let app: ReturnType<typeof mount> | undefined;
let unregister: (() => void) | undefined;
const stopBehaviors = new Map<string, StopBehavior>();
const heldStops = new Map<string, HeldStop>();
const control = createPluginRuntimeControl();

mockWindows("main");
mockConvertFileSrc("macos");
mockIPC((command, rawArgs) => {
  const args = (rawArgs ?? null) as Record<string, unknown> | null;
  calls.push({ command, args });
  switch (command) {
    case "list_plugins": return structuredClone(plugins);
    case "list_plugin_runtime_sessions": {
      if (nextRuntimeReadError) {
        nextRuntimeReadError = false;
        throw new Error("Controlled fixture read failure");
      }
      return snapshot(nativeSnapshotEmpty ? [] : nativeRows);
    }
    default:
      unexpectedCommands.push(command);
      throw new Error(`Runtime browser fixture did not authorize IPC: ${command}`);
  }
});

function plugin(id: string, title: string): InstalledPlugin {
  return {
    id, name: title, version: "0.1.0-fixture", path: `/fixture/${id}`, enabled: true, source_kind: "imported",
    created_at: "2026-10-26", updated_at: "2026-10-26",
    manifest: { title, description: "仅供运行会话浏览器验收的模拟插件", main: "index.html", features: [] },
  };
}

function session(
  kind: RuntimeSession["kind"], windowLabel: string | null, instanceId: string, pluginId: string,
  phase: RuntimeSession["phase"], evidence: RuntimeSession["evidence"], codeRevision: string | null,
): RuntimeSession {
  return { id: runtimeSessionId(kind, windowLabel, instanceId), kind, windowLabel, instanceId, pluginId, phase, evidence, codeRevision };
}

function snapshot(sessions: RuntimeSession[]): RuntimeSnapshot {
  const available = new Set<RuntimeSession["kind"]>(["background", "legacy_node", "browser_window"]);
  return {
    schemaVersion: 1,
    sessions: structuredClone(sessions),
    coverage: runtimeKinds.map(kind => ({ kind, available: available.has(kind) })),
    truncated: false,
  };
}

function controlSnapshot() { return structuredClone(localRows); }
async function stopSourceRow(row: RuntimeSession): Promise<void> {
  const behavior = stopBehaviors.get(row.instanceId) ?? "failure";
  if (behavior === "hold") {
    await new Promise<void>((resolve, reject) => heldStops.set(row.instanceId, { row, resolve, reject }));
    return;
  }
  if (behavior === "failure") throw new Error("Controlled fixture stop failure");
  removeRow(row);
}
function removeRow(row: RuntimeSession) {
  localRows = localRows.filter(current => current.id !== row.id);
  nativeRows = nativeRows.filter(current => current.id !== row.id);
  control.changed();
}

unregister = control.registerSource("browser-fixture", { snapshot: controlSnapshot, stop: stopSourceRow });
app = mount(PluginRuntimeBrowserFixture, { target: document.getElementById("app")!, props: { control } });
flushSync();

const fixture: FixtureApi = {
  calls,
  unexpectedCommands,
  setNextRuntimeReadError() { nextRuntimeReadError = true; },
  setStopBehavior(instanceId, behavior) {
    if (![failedStopId, successfulStopId].includes(instanceId)) throw new Error("Unknown fixture session identity");
    stopBehaviors.set(instanceId, behavior);
  },
  resolveHeldStop(instanceId, outcome) {
    const held = heldStops.get(instanceId);
    if (!held) throw new Error("No held stop operation for fixture identity");
    heldStops.delete(instanceId);
    if (outcome === "failure") held.reject(new Error("Controlled fixture stop failure"));
    else { removeRow(held.row); held.resolve(); }
  },
  setNativeSnapshotEmpty(value) { nativeSnapshotEmpty = value; },
  clearLocalRows() { localRows = []; control.changed(); },
  async dispose() {
    for (const held of heldStops.values()) held.reject(new Error("Fixture disposed"));
    heldStops.clear();
    if (app) await unmount(app);
    app = undefined;
    unregister?.(); unregister = undefined;
    control.dispose();
    await tick();
  },
};

Object.assign(window, { pluginRuntimeBrowserFixture: fixture });

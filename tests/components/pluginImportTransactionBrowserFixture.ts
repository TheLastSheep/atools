import "../../src/styles/global.css";
import App from "../../src/App.svelte";
import { flushSync, mount, tick, unmount } from "svelte";
import { mockConvertFileSrc, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { InstalledPlugin, TaskRun, ZToolsImportCandidate, ZToolsImportReport } from "../../src/lib/types";

const settings = { localAppSearch: false, localLaunchSearch: false, autoPaste: "never", autoBackToSearch: "never", pluginMarketCustom: false };
const blocked: ZToolsImportCandidate = {
  path: "/fixture/source/blocked", source_type: "directory", entry_readiness: "requires_build",
  name: "needs-build", title: "源码待构建", version: "1.0.0", features_count: 1,
  platform_supported: true, main_exists: true, preload_exists: true, logo_exists: true,
  unsupported_cmd_types: [], warnings: [], errors: [],
};
const successful: ZToolsImportCandidate = {
  path: "/fixture/source/success", source_type: "directory", entry_readiness: "ready",
  name: "success.plugin", title: "停用后可启用的插件", version: "1.2.0", features_count: 1,
  platform_supported: true, main_exists: true, preload_exists: false, logo_exists: false,
  unsupported_cmd_types: [], warnings: [], errors: [],
};
const failed: ZToolsImportCandidate = {
  path: "/fixture/source/retry", source_type: "directory", entry_readiness: "ready",
  name: "retry-name", title: "需要重试的插件", version: "2.0.0", features_count: 1,
  platform_supported: true, main_exists: true, preload_exists: false, logo_exists: false,
  unsupported_cmd_types: [], warnings: [], errors: [],
};
const sourceChoiceCandidates: ZToolsImportCandidate[] = [
  { ...blocked, path: "/fixture/source-choice/calculator", name: "Calculator", title: "计算器源码", version: "1.4.0",
    installation_id: "Calculator", installation_key: "calculator" },
  { ...successful, path: "/fixture/source-choice/calculator/published-calculator-0.9.0.zpx", source_type: "zpx", name: "calculator", title: "计算器发布包", version: "0.9.0",
    installation_id: "calculator", installation_key: "calculator" },
  { ...successful, path: "/fixture/source-choice/calculator/another-published-calculator-2.0.0.zip", source_type: "zip", name: "CALCULATOR", title: "计算器另一版本", version: "2.0.0",
    installation_id: "CALCULATOR", installation_key: "calculator" },
];
const manifestIdentity = (version: string, main: string) => ({ id: "needs-build", version, main, preload: null, runtime: "web" as const, featureCodes: ["needs-build.open"] });
const manifestCandidates = [
  { selection: "root" as const, status: "valid" as const, manifestSha256: "a".repeat(64), identity: manifestIdentity("1.4.0", "index.html") },
  { selection: "public" as const, status: "valid" as const, manifestSha256: "b".repeat(64), identity: manifestIdentity("0.9.0", "dist/index.html") },
];
const inspectedSourcePath = "/fixture/source/blocked";
const sourceManifestInspections: Array<{ args: Record<string, unknown>; runId: string; response: ReturnType<typeof sourceInspectionRun> }> = [];
const pendingSourceInspections = new Map<string, (run: unknown) => void>();
let inspectionPlans: string[] = [];

type IpcCall = { command: string; args: Record<string, unknown> | null; pendingKey?: string };
const calls: IpcCall[] = [];
const unexpectedCommands: string[] = [];
const listeners = new Map<number, { event: string; handler: number }>();
let sequence = 0;
let app: ReturnType<typeof mount> | undefined;
let installed: InstalledPlugin[] = [];
let pendingScans = new Map<string, (value: ZToolsImportCandidate[]) => void>();
let pendingDialog = new Map<string, (value: string | null) => void>();
let scanPlans = new Map<string, string[]>();
let dialogPlans: string[] = [];
let importReports: ZToolsImportReport[] = [];
let failListPluginsAfterImport = false;
let failNextListPlugins = false;
let activateFails = true;

const successId = "success-plugin";
function storedPlugin(id: string, name: string, enabled = false): InstalledPlugin {
  return { id, name, version: "1.0.0", enabled, path: `/fixture/installed/${id}`, created_at: "2026-10-16", updated_at: "2026-10-16",
    manifest: { title: name, main: "index.html", features: [{ code: `feature-${id}` }] } };
}
function nextPendingKey(plans: Map<string, string[]>, command: string) {
  const list = plans.get(command);
  if (!list?.length) return undefined;
  const key = list.shift()!;
  if (list.length === 0) plans.delete(command);
  return key;
}

mockWindows("main");
mockConvertFileSrc("macos");
mockIPC((command, rawArgs) => {
  const args = (rawArgs ?? null) as Record<string, unknown> | null;
  if (command === "plugin:event|listen") {
    const id = ++sequence;
    listeners.set(id, { event: String(args?.event), handler: Number(args?.handler) });
    return id;
  }
  if (command === "plugin:event|unlisten") {
    listeners.delete(Number(args?.eventId));
    return;
  }
  if (command === "plugin:dialog|open") {
    const key = dialogPlans.shift();
    calls.push({ command, args, pendingKey: key });
    if (!key) return "/fixture/picked/default-ztools-directory";
    return new Promise<string | null>(resolve => pendingDialog.set(key, resolve));
  }
  const pendingKey = command === "scan_default_ztools_plugins" || command === "scan_ztools_plugins" ? nextPendingKey(scanPlans, command) : undefined;
  calls.push({ command, args, pendingKey });
  if (command === "start_agent_tool") {
    if (args?.name !== "inspect_ztools_source_build" || args.clientId !== "atools-ui" || args.confirmed !== false
      || !args.arguments || typeof args.arguments !== "object" || Array.isArray(args.arguments)) {
      unexpectedCommands.push("start_agent_tool:unrecognized");
      throw new Error("Fixture rejected an unrecognized source inspection request");
    }
    const input = args.arguments as Record<string, unknown>;
    if (input.sourcePath !== inspectedSourcePath
      || Object.keys(input).some(key => key !== "sourcePath" && key !== "manifestSelection")
      || input.manifestSelection !== undefined && input.manifestSelection !== "root" && input.manifestSelection !== "public") {
      unexpectedCommands.push("start_agent_tool:invalid-source-selection");
      throw new Error("Fixture rejected an unexpected source inspection identity");
    }
    const runId = `fixture-source-inspection-${sourceManifestInspections.length + 1}`;
    const selection = input.manifestSelection as "root" | "public" | undefined;
    const run = sourceInspectionRun(runId, input, selection);
    sourceManifestInspections.push({ args: structuredClone(args), runId, response: run });
    const pendingInspection = inspectionPlans.shift();
    if (pendingInspection) return new Promise(resolve => pendingSourceInspections.set(pendingInspection, resolve));
    return run;
  }
  switch (command) {
    case "get_setting": return JSON.stringify(settings);
    case "set_setting": return;
    case "get_accessibility_permission_status": return { supported: false, trusted: false };
    case "get_home_dir": return "/fixture/home";
    case "system_get_path": return "/fixture/home";
    case "feature_catalog":
    case "search_features":
    case "search_local_apps":
    case "list_pending_agent_requests": return [];
    case "scan_default_ztools_plugins":
    case "scan_ztools_plugins":
      if (pendingKey) return new Promise<ZToolsImportCandidate[]>(resolve => pendingScans.set(pendingKey, resolve));
      return [blocked, successful, failed];
    case "import_ztools_plugins": {
      if (failListPluginsAfterImport) {
        failListPluginsAfterImport = false;
        failNextListPlugins = true;
      }
      const next = importReports.shift();
      if (!next) throw new Error("Fixture has no queued import report");
      for (const id of next.imported) {
        const name = id === successId ? "停用后可启用的插件" : "重试后导入的插件";
        installed = [...installed.filter(plugin => plugin.id !== id), storedPlugin(id, name, false)];
      }
      return next;
    }
    case "list_plugins":
      if (failNextListPlugins) { failNextListPlugins = false; throw new Error("Synthetic first list_plugins failure"); }
      return installed;
    case "toggle_plugin": {
      const pluginId = String(args?.pluginId ?? "");
      const enabled = Boolean(args?.enabled);
      if (enabled !== true || !installed.some(plugin => plugin.id === pluginId)) throw new Error("Fixture rejected unexpected toggle_plugin arguments");
      installed = installed.map(plugin => plugin.id === pluginId ? { ...plugin, enabled: true } : plugin);
      failNextListPlugins = true;
      return;
    }
    case "activate_feature":
      if (activateFails) throw new Error("Synthetic activation unavailable");
      throw new Error("Fixture does not execute plugin code");
    case "expand_window": case "reset_window": case "show_main_window": case "hide_main_window":
    case "open_url": case "copy_text": case "set_floating_ball_visible": case "set_super_panel_visible":
      return null;
    default:
      unexpectedCommands.push(command);
      throw new Error(`Plugin import fixture did not authorize IPC: ${command}`);
  }
});

function sourceInspectionRun(runId: string, input: Record<string, unknown>, selection: "root" | "public" | undefined): TaskRun {
  const selectedIndex = selection === "root" ? 0 : selection === "public" ? 1 : -1;
  return {
      id: runId, capabilityId: "inspect_ztools_source_build", initiator: { type: "human", clientId: "atools-ui" },
      status: "succeeded", input, output: {
        status: "eligible", pluginId: "needs-build", version: selectedIndex < 0 ? "1.4.0" : manifestCandidates[selectedIndex].identity.version,
        blockers: [], sourceRevision: "c".repeat(64), buildSteps: [{ kind: "viteBuild" }],
        manifestSelection: selection ?? null,
        manifestSha256: selectedIndex < 0 ? null : manifestCandidates[selectedIndex].manifestSha256,
        manifestIdentity: selectedIndex < 0 ? null : manifestCandidates[selectedIndex].identity,
        manifestCandidates, manifestDifferences: ["version", "main"],
      }, summary: "Synthetic source inspection fixture", artifacts: [], warnings: [], errors: [], actions: [], memoryIds: [], metrics: null,
      validation: { status: "not_run" }, createdAt: "2026-10-21T00:00:00.000Z", updatedAt: "2026-10-21T00:00:00.000Z",
    };
}

export async function mountFresh() {
  if (app) await unmount(app);
  calls.length = 0;
  unexpectedCommands.length = 0;
  installed = [];
  pendingScans = new Map();
  pendingDialog = new Map();
  scanPlans = new Map([["scan_default_ztools_plugins", ["initial-default-scan"]]]);
  dialogPlans = [];
  importReports = [];
  failListPluginsAfterImport = false;
  failNextListPlugins = false;
  activateFails = true;
  sourceManifestInspections.length = 0;
  pendingSourceInspections.clear();
  inspectionPlans = [];
  localStorage.clear();
  localStorage.setItem("atools-settings", JSON.stringify(settings));
  app = mount(App, { target: document.getElementById("app")!, props: { backgroundServices: false } });
  flushSync();
  await tick();
}

export async function dispose() {
  if (!app) return;
  await unmount(app);
  app = undefined;
}

export const fixture = {
  calls, unexpectedCommands, listeners, candidates: [blocked, successful, failed], sourceChoiceCandidates, sourceManifestInspections,
  get installed() { return installed; },
  mountFresh, dispose,
  planScan(command: "scan_default_ztools_plugins" | "scan_ztools_plugins", key: string) {
    scanPlans.set(command, [...(scanPlans.get(command) ?? []), key]);
  },
  resolveScan(key: string, value: ZToolsImportCandidate[] = [blocked, successful, failed]) {
    const resolve = pendingScans.get(key);
    if (!resolve) throw new Error(`No pending scan: ${key}`);
    pendingScans.delete(key); resolve(value);
  },
  planDialog(key: string) { dialogPlans.push(key); },
  resolveDialog(key: string, value: string | null) {
    const resolve = pendingDialog.get(key);
    if (!resolve) throw new Error(`No pending dialog: ${key}`);
    pendingDialog.delete(key); resolve(value);
  },
  queueImport(report: ZToolsImportReport) { importReports.push(report); },
  planSourceInspection(key: string) { inspectionPlans.push(key); },
  resolveSourceInspection(key: string) {
    const resolve = pendingSourceInspections.get(key);
    const latest = sourceManifestInspections.at(-1);
    if (!resolve || !latest) throw new Error("No pending source inspection");
    pendingSourceInspections.delete(key);
    resolve(latest.response);
  },
  failNextListAfterNextImport() { failListPluginsAfterImport = true; },
};
Object.assign(window, { pluginImportTransactionFixture: fixture });
void mountFresh();

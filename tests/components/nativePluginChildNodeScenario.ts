import { invoke as rawInvoke } from "@tauri-apps/api/core";
import { tick } from "svelte";
import { approveNativePanelPermission } from "./nativePanelPermissionGate";

type Runtime = Record<string, number | boolean>;
type Child = { kind: string; ready: boolean; rejected: boolean; readyCallbackCount: number; destroyed: boolean };
type State = { opaque: boolean; noTauri: boolean; parentPreloadExecuted: boolean; parentElectronIpc: boolean;
  mainReady: boolean; mainNodeEnvironment: boolean; children: Child[] };
type Fixture = { token: string; childNodeAcceptance: boolean; capabilities: Record<string, { node: string; data: string }> };
type Pending = { tool_name: string; client_id: string; scopes: string[] };
const NODE_SCOPES = ["file_read", "file_write", "network", "shell", "clipboard_read", "clipboard_write", "screenshot", "browser_context", "plugin_data", "system_settings"];
const pause = () => new Promise(resolve => setTimeout(resolve, 50));
const FIXTURE_QUERY = "synthetic child only node";
const FIXTURE_OPTION = '[role="option"][data-plugin-id="file-tree"][data-result-code="child-node-contract"]';
const ERROR_CLASSES = ["Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError", "UnknownError"];
const DATA_CODES = ["ERR_ATOOLS_DATA_PERMISSION_REQUIRED", "ERR_ATOOLS_DATA_SESSION", "ERR_ATOOLS_DATA_CLOSED", "ERR_ATOOLS_DATA_RESPONSE", "ERR_ATOOLS_DATA_TRANSPORT", "ERR_ATOOLS_DATA_REJECTED", "ERR_ATOOLS_DATA_LIMIT", "UNKNOWN_ERROR"];
const FAILURE_CODES = ["SCENARIO_ASSERTION_FAILED", "FIXTURE_WAIT_TIMEOUT", "MAIN_READY_TIMEOUT", "NATIVE_COMMAND_TIMEOUT", "NATIVE_COMMAND_REJECTED", "MAIN_FRAME_MISSING", "FRAME_REPLY_TIMEOUT", "FRAME_REPLY_REJECTED", "LAUNCHER_INPUT_REPLACED"];
function failure(code: string) { return Object.assign(Error("Fixed child fixture failure"), { fixtureCode: code }); }
/** Only fixed booleans, bounded counts and fixed error enums may leave the frame as diagnostics. */
export function nativeChildNodeMainDiagnostic(value: unknown) {
  const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const bools = ["opaque", "noTauri", "parentPreloadExecuted", "parentElectronIpc", "mainReady", "mainNodeEnvironment",
    "mainScriptEntered", "mainStorageApiAvailable", "mainDataAttempted", "mainDataCompleted"];
  const counts = item.observedErrorCounts && typeof item.observedErrorCounts === "object" ? item.observedErrorCounts as Record<string, unknown> : {};
  const bounded = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 32 ? value as number : 0;
  return { ...Object.fromEntries(bools.map(key => [key, item[key] === true])),
    mainDataErrorClass: item.mainDataErrorClass === "" ? "" : ERROR_CLASSES.includes(item.mainDataErrorClass as string) ? item.mainDataErrorClass : "UnknownError",
    mainDataErrorCode: item.mainDataErrorCode === "" ? "" : DATA_CODES.includes(item.mainDataErrorCode as string) ? item.mainDataErrorCode : "UNKNOWN_ERROR",
    observedErrorCount: bounded(item.observedErrorCount),
    observedErrorCounts: Object.fromEntries(ERROR_CLASSES.map(key => [key, bounded(counts[key])])) };
}
export function nativeChildNodeLauncherSnapshot(root: ParentNode = document) {
  const input = root.querySelector<HTMLInputElement>('input[data-atools-search-input="true"]') ?? root.querySelector<HTMLInputElement>(".search-input");
  const option = root.querySelector(FIXTURE_OPTION);
  const count = (selector: string) => Math.min(2048, root.querySelectorAll(selector).length);
  return { inputPresent: !!input, inputConnected: input?.isConnected === true, inputEmpty: input?.value === "",
    inputMatchesFixedQuery: input?.value === FIXTURE_QUERY, inputComposing: input?.getAttribute("data-atools-composing") === "true",
    pluginPanelPresent: !!root.querySelector(".plugin-panel"), pluginFramePresent: !!root.querySelector('iframe[title="Plugin"]'),
    permissionDialogPresent: !!root.querySelector("[data-permission-dialog]"),
    fixtureOptionPresent: !!option, fixtureOptionSelected: option?.getAttribute("aria-selected") === "true",
    optionCount: count('[role="option"]'), fixturePluginOptionCount: count('[role="option"][data-plugin-id="file-tree"]'),
    exactFeatureOptionCount: count(FIXTURE_OPTION), selectedExactFeatureOptionCount: count(FIXTURE_OPTION + '[aria-selected="true"]'),
    selectedOtherFixtureFeatureCount: count('[role="option"][data-plugin-id="file-tree"]:not([data-result-code="child-node-contract"])[aria-selected="true"]'),
    selectedOtherPluginCount: count('[role="option"]:not([data-plugin-id="file-tree"])[aria-selected="true"]') };
}
/** Use actual input events with a render turn between clear and re-search. Never call App state or manufacture rows. */
export async function submitNativeChildNodeSearch(input: HTMLInputElement, flush: () => Promise<void> = tick) {
  const InputEvent = input.ownerDocument.defaultView!.Event;
  input.focus(); input.value = ""; input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await flush();
  if (!input.isConnected) throw failure("LAUNCHER_INPUT_REPLACED");
  input.value = FIXTURE_QUERY; input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await flush();
}
export function childNodeRuntimeDrained(value: Runtime) {
  return ["sessions", "openings", "nodeIntents", "nodeInvocations", "pending", "resourceLeases", "pageDocuments", "hostSessions", "hostIntents", "hostInvocations",
    "dataSessions", "dataIntents", "dataInvocations", "dataPreparations", "webStorageEvents", "webStorageEventBytes",
    "activePathSnapshots", "activePathIntents", "activePathPreparations", "pathSnapshotBytes",
    "dialogSessions", "dialogIntents", "dialogInvocations", "dialogPreparations", "nativeDialogs"].every(key => value[key] === 0)
    && ["transport", "hostTransport", "dataTransport", "dialogTransport"].every(key => value[key] === false);
}
export function childNodePendingMatches(pending: Pending[], tool: string) {
  const scopes = (values: string[]) => [...values].sort().join("|");
  return pending.length === 1 && pending[0].tool_name === tool && pending[0].client_id === "atools-ui"
    && scopes(pending[0].scopes) === scopes(NODE_SCOPES);
}
async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(failure("NATIVE_COMMAND_TIMEOUT")), 8000);
    rawInvoke<T>(command, args).then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); reject(failure("NATIVE_COMMAND_REJECTED")); }); });
}
async function until<T>(read: () => T | Promise<T>, _message: string, code = "FIXTURE_WAIT_TIMEOUT"): Promise<NonNullable<T>> {
  const end = performance.now() + 12000;
  while (performance.now() < end) { const value = await read(); if (value) return value as NonNullable<T>; await pause(); }
  throw failure(code);
}

export async function runNativePluginChildNodeScenario() {
  const checks: Record<string, boolean> = {}, observations: Record<string, unknown> = {};
  let phase = "setup", stage = "setup", token = "", sequence = 0;
  const check = (value: unknown, label: string) => { if (!value) throw failure("SCENARIO_ASSERTION_FAILED"); checks[label] = true; };
  const runtime = () => invoke<Runtime>("native_panel_runtime_state");
  const frame = () => document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]');
  const childCount = () => document.querySelectorAll(".plugin-browser-window").length;
  async function request<T>(operation: string): Promise<T> {
    const source = frame()?.contentWindow, id = "child-node-" + (++sequence);
    if (!source) throw failure("MAIN_FRAME_MISSING");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.removeEventListener("message", receive); reject(failure("FRAME_REPLY_TIMEOUT")); }, 12000);
      function receive(event: MessageEvent) {
        if (event.source !== source || event.origin !== "null" || event.data?.kind !== "atools-child-node-result"
          || event.data.token !== token || event.data.id !== id) return;
        clearTimeout(timer); window.removeEventListener("message", receive);
        if (event.data.error) reject(failure("FRAME_REPLY_REJECTED")); else resolve(event.data.result);
      }
      window.addEventListener("message", receive); source.postMessage({ kind: "atools-child-node-probe", token, id, operation }, "*");
    });
  }
  async function closePlugin() {
    document.querySelector<HTMLButtonElement>('button[aria-label="返回搜索"]')?.click();
    return until(async () => { const value = await runtime(), launcher = nativeChildNodeLauncherSnapshot();
      observations.lastCloseLauncher = launcher;
      return !launcher.pluginPanelPresent && !frame() && launcher.inputPresent && launcher.inputConnected
        && childCount() === 0 && childNodeRuntimeDrained(value) ? value : null; },
      "Whole plugin close did not drain owned runtime resources");
  }
  async function openParent(dataTool: string, label: string) {
    stage = "parent-search-input";
    const searchObservation = { polls: 0, lastSnapshot: nativeChildNodeLauncherSnapshot() };
    observations["launcherSearch-" + label] = searchObservation;
    const input = await until(() => { searchObservation.polls++; searchObservation.lastSnapshot = nativeChildNodeLauncherSnapshot();
      return document.querySelector<HTMLInputElement>('input[data-atools-search-input="true"]') ?? document.querySelector<HTMLInputElement>(".search-input"); }, "Launcher search missing");
    stage = "parent-search-clear-and-query";
    await submitNativeChildNodeSearch(input);
    stage = "parent-search-exact-feature";
    const option = await until(() => { searchObservation.polls++; searchObservation.lastSnapshot = nativeChildNodeLauncherSnapshot();
      return document.querySelector<HTMLElement>(FIXTURE_OPTION); }, "Exact generated plugin feature missing");
    // The production row focus handler selects this exact feature, as in nativePublishedPluginScenario.
    stage = "parent-search-selection"; option.focus();
    await until(() => { searchObservation.polls++; searchObservation.lastSnapshot = nativeChildNodeLauncherSnapshot();
      return option.isConnected && option.getAttribute("aria-selected") === "true"; }, "Exact generated feature not selected by focus");
    input.focus();
    check(option.dataset.pluginId === "file-tree" && option.dataset.resultCode === "child-node-contract"
      && option.getAttribute("aria-selected") === "true", "Production focus selects the exact child-only Node feature: " + label);
    stage = "parent-search-activate";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    stage = "parent-data-permission";
    await approveNativePanelPermission({ title: "子窗口 Node 验收 请求访问自己的数据", tool: dataTool,
      scopes: ["plugin_data"], label: "child-main-data-" + label, invoke, until, check });
    stage = "parent-frame";
    const main = await until(frame, "Actual PluginPanel main frame missing");
    check(!!main.srcdoc && !main.getAttribute("src") && main.getAttribute("sandbox") === "allow-scripts allow-popups",
      "Parent uses actual default opaque PluginPanel: " + label);
    stage = "parent-main-readiness";
    const readiness = { attempts: 0, replies: 0, lastMainState: null as ReturnType<typeof nativeChildNodeMainDiagnostic> | null };
    observations["parentReadiness-" + label] = readiness;
    const state = await until(async () => { readiness.attempts++; const value = await request<State>("state");
      readiness.replies++; readiness.lastMainState = nativeChildNodeMainDiagnostic(value); return value.mainReady ? value : null;
    }, "Generated main page not ready", "MAIN_READY_TIMEOUT");
    stage = "parent-main-runtime-read";
    const value = await runtime();
    stage = "parent-preload-assertion";
    check(state.opaque && state.noTauri && state.parentPreloadExecuted && state.parentElectronIpc && !state.mainNodeEnvironment,
      "Pure Electron parent preload executes without Node environment: " + label);
    stage = "parent-zero-node-assertion";
    check(value.sessions === 0 && value.openings === 0 && value.transport === false && value.pending === 0 && childCount() === 0,
      "Data-authorized main starts no Node process, opening, transport or child: " + label);
    observations["mainBeforeChild-" + label] = { state, runtime: value };
  }
  async function nodePrompt(tool: string, label: string) {
    await until(() => document.querySelector("[data-permission-dialog] h2")?.textContent?.trim() === "子窗口 Node 验收 请求访问本机", "Exact child Node permission missing");
    const pending = await invoke<Pending[]>("list_pending_agent_requests"), value = await runtime(), state = await request<State>("state");
    check(childNodePendingMatches(pending, tool), "Child requests exact Node capability, client and ten scopes: " + label);
    check(value.sessions === 0 && value.openings === 0 && !value.transport && childCount() === 0
      && state.children.length === 1 && !state.children[0].ready && state.children[0].readyCallbackCount === 0,
      "No Node runtime or executed child exists before explicit authorization: " + label);
    observations["nodePrompt-" + label] = { runtime: value, childCount: childCount(), state, exactPending: true };
  }
  try {
    check(location.href === "atools-panel://localhost/", "Native parent remains on its exact isolated URL");
    const fixture = await invoke<Fixture>("native_panel_fixture"); token = fixture.token;
    const capability = fixture.capabilities["file-tree"];
    check(fixture.childNodeAcceptance && !!capability?.node && !!capability?.data, "Explicit child-only native fixture supplies exact capability IDs");
    check(childNodeRuntimeDrained(await runtime()), "Launcher starts with every owned runtime drained");
    const usage = await invoke<{ requiresNode: boolean }>("plugin_legacy_node_usage", { pluginId: "file-tree" });
    check(usage.requiresNode === false, "Read-only main preload usage does not eagerly request child-only Node");

    phase = stage = "child-node-denial";
    await openParent(capability.data, "deny");
    stage = "denied-child-create";
    check((await request<{ synchronousHandle: boolean }>("open-generated")).synchronousHandle, "Denied child creation still returns an immediate facade");
    await nodePrompt(capability.node, "deny");
    const deny = document.querySelector<HTMLButtonElement>("[data-permission-dialog] [data-permission-deny]");
    check(deny, "Exact Node prompt exposes actual denial control"); deny!.click();
    const denied = await until(async () => { const state = await request<State>("state"), value = await runtime();
      return state.children[0]?.rejected && value.pending === 0 ? { state, runtime: value } : null; }, "Node denial did not reject pending child readiness");
    check(denied.runtime.sessions === 0 && denied.runtime.openings === 0 && !denied.runtime.transport && childCount() === 0
      && !denied.state.children[0].ready && denied.state.children[0].readyCallbackCount === 0,
      "Denied child executes nothing and causes no implicit Node replay");
    observations.denial = denied;
    observations.afterDeniedPluginClose = await closePlugin();

    phase = stage = "fresh-child-node-approval";
    await openParent(capability.data, "fresh");
    stage = "allowed-child-create";
    check((await request<{ synchronousHandle: boolean }>("open-generated")).synchronousHandle, "Fresh child creation returns an immediate facade");
    await nodePrompt(capability.node, "allow");
    await approveNativePanelPermission({ title: "子窗口 Node 验收 请求访问本机", tool: capability.node,
      scopes: NODE_SCOPES, label: "child-node-only", invoke, until, check });
    await until(async () => { const state = await request<State>("state"); return state.children[0]?.ready ? state : null; }, "Allowed child never became ready");
    const generated = await request<{ opaque: boolean; noTauri: boolean; actualNodeBridge: boolean; sentinelMatches: boolean; processId: number }>("inspect-generated");
    const firstRuntime = await runtime();
    observations.generatedChild = { ...generated, runtime: firstRuntime };
    check(generated.opaque && generated.noTauri && generated.actualNodeBridge && generated.sentinelMatches
      && Number.isSafeInteger(generated.processId) && generated.processId > 0, "Selected generated child executes real Node fs read of the fixed package sentinel");
    check(firstRuntime.sessions === 1 && firstRuntime.openings === 0 && firstRuntime.transport === true && firstRuntime.pending === 0 && childCount() === 1,
      "One-time child approval starts exactly one Node session and actual hosted child");
    const closedGenerated = await request<{ actualClose: boolean; destroyed: boolean; readyCallbackCount: number }>("close-generated");
    await until(() => childCount() === 0, "Generated child did not actually close");
    check(closedGenerated.actualClose && closedGenerated.destroyed && closedGenerated.readyCallbackCount === 1
      && (await runtime()).sessions === 1 && (await request<State>("state")).mainReady,
      "Closing a ready child preserves the live main generation and shared Node environment");
    observations.generatedChildClose = closedGenerated;

    phase = stage = "unchanged-original-child-preload";
    check((await request<{ synchronousHandle: boolean }>("open-original")).synchronousHandle, "Original child preload selection returns an immediate facade");
    const parentZoomBefore = document.documentElement.style.getPropertyValue("zoom"), parentComputedBefore = getComputedStyle(document.documentElement).getPropertyValue("zoom");
    const original = await request<Record<string, boolean>>("original-roundtrip"), secondRuntime = await runtime();
    original.parentDocumentZoomUnchanged = original.parentDocumentZoomUnchanged === true
      && document.documentElement.style.getPropertyValue("zoom") === parentZoomBefore
      && getComputedStyle(document.documentElement).getPropertyValue("zoom") === parentComputedBefore;
    observations.originalChild = { ...original, runtime: secondRuntime };
    check(["opaque", "noTauri", "actualNodeBridge", "originalFunctionsReady", "originalFsAttachmentStored", "dictionaryRoundTrip", "metadataRoundTrip", "zoomRateInitialized"].every(key => original[key] === true),
      "Complete unchanged original English child preload reads fixed package JSON through fs and round-trips attachment and metadata");
    check(["webFrameZoomAvailable", "documentZoomFactorRoundTrip", "computedDocumentZoomMatches", "documentZoomRestored", "parentDocumentZoomUnchanged"].every(key => original[key] === true),
      "Actual webFrame zoom changes only the current child CSS document to 1.25 and restores 1 without changing parent documents");
    check(secondRuntime.sessions === 1 && secondRuntime.openings === 0 && secondRuntime.transport === true && secondRuntime.pending === 0 && childCount() === 1,
      "Second selected child reuses exactly one already-authorized Node environment without a new prompt");
    const closedOriginal = await request<{ actualClose: boolean; destroyed: boolean; readyCallbackCount: number }>("close-original");
    await until(() => childCount() === 0, "Original child did not actually close");
    check(closedOriginal.actualClose && closedOriginal.destroyed && closedOriginal.readyCallbackCount === 1 && (await runtime()).sessions === 1,
      "Original child closes once while the parent Node environment remains live");
    observations.originalChildClose = closedOriginal;
    observations.finalRuntime = await closePlugin();
    const privacy = await invoke<{ complete: boolean; privateFixtureContentsAbsent: boolean; allTaskRunsTerminal: boolean; taskRuns: number }>("native_panel_child_node_privacy");
    check(privacy.complete && privacy.privateFixtureContentsAbsent && privacy.allTaskRunsTerminal && privacy.taskRuns > 0,
      "Bounded Rust scan verifies fixed fixture content is absent from every durable terminal TaskRun");
    observations.privacy = privacy;
    return { passed: true, checks, observations, acceptanceScope: { generatedPackages: true, completeOriginalChildPreloadOnly: true,
      childDocumentCssZoomOnly: true, nativeChromiumZoomParity: false,
      completeOriginalPlugin: false, documentMode: false, trueNativeFloatingWindow: false, physicalInput: false,
      osPickerOpened: false, clipboardActions: false, externalNetworkRequested: false, appleScriptUsed: false } };
  } catch (error) {
    const rawCode = error && typeof error === "object" && "fixtureCode" in error ? String(error.fixtureCode) : "";
    const diagnostic = { stage, code: FAILURE_CODES.includes(rawCode) ? rawCode : "UNKNOWN_FIXTURE_FAILURE",
      errorClass: error instanceof Error && ERROR_CLASSES.includes(error.name) ? error.name : "UnknownError" };
    observations.failureDiagnostic = diagnostic;
    observations.failureRuntime = await runtime().catch(() => null);
    observations.afterFailureCleanup = await closePlugin().catch(() => null);
    return { passed: false, checks, observations, phase, error: diagnostic.errorClass };
  }
}

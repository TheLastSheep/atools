import { invoke as rawInvoke } from "@tauri-apps/api/core";
import { approveNativePanelPermission } from "./nativePanelPermissionGate";
import { createNativeFileTreeFrameProbe, type FrameObservation, type FrameState } from "./nativeFileTreeFrameProbe";

type Fixture = {
  headFileTreeAcceptance: boolean;
  token: string;
  treePath: string;
  dataset: { originalPlugins: number; originalFeatures: number; syntheticFeatures: number };
  capabilities: Record<string, { node: string; data?: string; dialogOpen?: string; dialogSave?: string }>;
};
type RuntimeState = { sessions: number; pending: number; transport: boolean; resourceLeases: number;
  dialogInvocations: number; nativeDialogs: number; dataSessions: number; dataTransport: boolean };
type RuntimeObservation = { sessions: { count: number; overflow: boolean }; pending: { count: number; overflow: boolean };
  transport: boolean; resourceLeases: { count: number; overflow: boolean } };
type TaskRunEvidence = { matchedTaskRuns: number; succeeded: boolean; terminal: boolean; entryTypeFiles: boolean; payloadSummaryRedacted: boolean; expectedOwnerMatched: boolean; passed: boolean };
const pause = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));
function check(value: unknown, _message: string): asserts value {
  if (!value) {
    throw Error("FILE_TREE_FIXTURE_ASSERTION_FAILED");
  }
  if (scenarioProgress.passedChecks.length < 32) scenarioProgress.passedChecks.push(_message);
}
function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Native IPC deadline: " + command)), 4000);
    rawInvoke<T>(command, args).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
async function until<T>(read: () => T | Promise<T>, _message: string, timeoutMs = 10000): Promise<NonNullable<T>> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) { const value = await read(); if (value) return value as NonNullable<T>; await pause(); }
  throw Error("FILE_TREE_FIXTURE_WAIT_FAILED");
}
let activeFrameProbe: ReturnType<typeof createNativeFileTreeFrameProbe> | null = null;
const MAX_RENDERED_TREE_CHARS = 4096;
type ScenarioStage = "fixture-load" | "panel-visible" | "title-visible" | "data-permission"
  | "dialog-open-permission" | "dialog-save-permission" | "pending-permissions" | "node-permission" | "permission-settled"
  | "frame-mounted" | "initial-dom" | "filter-enter" | "filter-dom" | "filter-clear"
  | "filter-clear-dom" | "hidden-on" | "hidden-on-dom" | "hidden-off" | "hidden-off-dom"
  | "task-run-evidence" | "runtime-before-return" | "back-navigation" | "runtime-drain";
type ScenarioProgress = { currentStage: ScenarioStage | "not-started"; lastMilestone: string; passedChecks: string[];
  lastPendingCount: { count: number; overflow: boolean } | null; expectedNodePending: boolean | null; lastFrameState: FrameObservation | null;
  lastRuntimeBeforeReturn: RuntimeObservation | null };
let scenarioProgress: ScenarioProgress = { currentStage: "not-started", lastMilestone: "scenario-start", passedChecks: [],
  lastPendingCount: null, expectedNodePending: null, lastFrameState: null, lastRuntimeBeforeReturn: null };
const MAX_PENDING_COUNT_OBSERVATION = 32;
const MAX_RUNTIME_COUNT_OBSERVATION = 32;
const SAFE_FAILURE_MESSAGES = new Map<string, { code: string; message: string }>([
  ["FILE_TREE_FIXTURE_WAIT_FAILED", { code: "FILE_TREE_WAIT_FAILED", message: "Fixture wait did not reach its expected state." }],
  ["FILE_TREE_FIXTURE_ASSERTION_FAILED", { code: "FILE_TREE_ASSERTION_FAILED", message: "A fixture assertion failed." }],
  ["FILE_TREE_FRAME_STATE_INVALID", { code: "FILE_TREE_FRAME_STATE_INVALID", message: "Fixture frame returned an invalid state snapshot." }],
  ["FILE_TREE_FRAME_READY_FAILED", { code: "FILE_TREE_FRAME_READY_FAILED", message: "The FileTree frame did not become ready within the request deadline." }],
  ["FILE_TREE_FRAME_NOT_READY", { code: "FILE_TREE_FRAME_READY_FAILED", message: "The FileTree frame did not become ready within the request deadline." }],
  ["FILE_TREE_FRAME_DOCUMENT_CHANGED", { code: "FILE_TREE_FRAME_READY_FAILED", message: "The FileTree frame changed during a request." }],
  ["FILE_TREE_FRAME_POST_FAILED", { code: "FILE_TREE_FRAME_REQUEST_FAILED", message: "A fixture frame request could not be sent." }],
  ["FILE_TREE_PROBE_DISPOSED", { code: "FILE_TREE_PROBE_DISPOSED", message: "The fixture frame observer was disposed." }],
  ["FileTree probe deadline: state", { code: "FILE_TREE_FRAME_REQUEST_FAILED", message: "A fixture frame request did not respond." }],
  ["FileTree probe deadline: filter-enter", { code: "FILE_TREE_FRAME_REQUEST_FAILED", message: "A fixture frame request did not respond." }],
  ["FileTree probe deadline: hidden-toggle", { code: "FILE_TREE_FRAME_REQUEST_FAILED", message: "A fixture frame request did not respond." }],
  ["missing-ignore-input", { code: "FILE_TREE_FRAME_OPERATION_FAILED", message: "A fixture frame control was unavailable." }],
  ["missing-hidden-toggle", { code: "FILE_TREE_FRAME_OPERATION_FAILED", message: "A fixture frame control was unavailable." }],
]);
export function nativeOriginalFileTreeFailureObservation(error: unknown) {
  const rawMessage = error instanceof Error ? error.message : "";
  const known = SAFE_FAILURE_MESSAGES.get(rawMessage);
  return {
    passed: false,
    errorCode: known?.code ?? "FILE_TREE_UNKNOWN_FAILURE",
    errorMessage: (known?.message ?? "Unknown fixture failure.").slice(0, 120),
    currentStage: scenarioProgress.currentStage,
    lastMilestone: scenarioProgress.lastMilestone.slice(0, 120),
    passedChecks: scenarioProgress.passedChecks.slice(0, 32).map(label => label.slice(0, 120)),
    lastPendingCount: scenarioProgress.lastPendingCount,
    expectedNodePending: scenarioProgress.expectedNodePending,
    lastFrameState: scenarioProgress.lastFrameState,
    lastRuntimeBeforeReturn: scenarioProgress.lastRuntimeBeforeReturn,
    frameProbe: activeFrameProbe?.diagnostics() ?? null,
    unknownOrigin: !known,
  };
}
async function atStage<T>(stage: ScenarioStage, action: () => Promise<T>): Promise<T> {
  scenarioProgress.currentStage = stage;
  const value = await action();
  scenarioProgress.lastMilestone = stage;
  return value;
}
function renderedWithinBound(state: FrameState): boolean {
  return state.renderedTreeAvailable && !state.renderedTreeOverflow
    && state.renderedTreeChars > 0 && state.renderedTreeChars === state.renderedTree.length
    && state.renderedTreeChars <= MAX_RENDERED_TREE_CHARS;
}
function renderedHas(state: FrameState, ...labels: string[]): boolean {
  return renderedWithinBound(state) && labels.every(label => state.renderedTree.includes(label));
}
function renderedLacks(state: FrameState, ...labels: string[]): boolean {
  return renderedWithinBound(state) && labels.every(label => !state.renderedTree.includes(label));
}

export async function runNativeOriginalFileTreeHeadScenario() {
  scenarioProgress = { currentStage: "not-started", lastMilestone: "scenario-start", passedChecks: [],
    lastPendingCount: null, expectedNodePending: null, lastFrameState: null, lastRuntimeBeforeReturn: null };
  activeFrameProbe = null;
  const checks: Record<string, boolean> = {};
  const mark = (ok: unknown, label: string): void => {
    check(ok, label);
    checks[label] = true;
  };
  const fixture = await atStage("fixture-load", () => invoke<Fixture>("native_panel_fixture"));
  mark(fixture.headFileTreeAcceptance === true, "Dedicated source-bound FileTree HEAD fixture is active");
  mark(fixture.dataset.originalPlugins === 1 && fixture.dataset.originalFeatures === 1 && fixture.dataset.syntheticFeatures === 1200,
    "Isolated catalog contains one original FileTree feature plus existing metadata-only search fixtures");
  const frameProbe = createNativeFileTreeFrameProbe({ token: fixture.token,
    getFrame: () => document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]'),
    onState: observation => { scenarioProgress.lastFrameState = observation; } });
  activeFrameProbe = frameProbe;
  try {
  await atStage("panel-visible", () => until(() => document.querySelector<HTMLElement>(".plugin-panel"), "Production PluginPanel did not receive the actual file activation"));
  await atStage("title-visible", () => until(() => document.querySelector(".plugin-title")?.textContent?.trim() === "目录树生成器", "Original FileTree title is missing"));
  const dataDialog = () => document.querySelector<HTMLElement>("[data-permission-dialog]");
  const dataTitle = "目录树生成器 请求访问自己的数据";
  await atStage("data-permission", () => approveNativePanelPermission({ title: dataTitle, tool: fixture.capabilities["file-tree"]?.data ?? "", scopes: ["plugin_data"],
    label: "FileTree data access", invoke, until, check: mark }));
  for (const [title, key, scope] of [["请求打开文件选择窗口", "dialogOpen", "file_read"], ["请求选择文件保存位置", "dialogSave", "file_write"]] as const) {
    const tool = fixture.capabilities["file-tree"]?.[key];
    if (tool) {
      const stage = key === "dialogOpen" ? "dialog-open-permission" : "dialog-save-permission";
      await atStage(stage, () => approveNativePanelPermission({ title: "目录树生成器 " + title, tool, scopes: [scope], label: "idle dialog capability " + key, invoke, until, check: mark }));
    }
  }
  const tool = fixture.capabilities["file-tree"]?.node;
  check(tool, "FileTree Node capability is registered");
  const pending = await atStage("pending-permissions", () => until(async () => {
    const snapshot = await invoke<Array<{ tool_name: string }>>("list_pending_agent_requests");
    scenarioProgress.lastPendingCount = { count: Math.min(snapshot.length, MAX_PENDING_COUNT_OBSERVATION),
      overflow: snapshot.length > MAX_PENDING_COUNT_OBSERVATION };
    scenarioProgress.expectedNodePending = snapshot.some(request => request.tool_name === tool);
    return snapshot.length === 1 && snapshot[0]?.tool_name === tool ? snapshot : null;
  }, "Expected exactly the FileTree Node permission after data and dialog grants"));
  mark(pending.length === 1 && pending[0]?.tool_name === tool,
    "Only the exact FileTree Node permission is pending after data and idle dialog grants");
  await atStage("node-permission", () => approveNativePanelPermission({ title: "目录树生成器 请求访问本机", tool,
    scopes: ["file_read", "file_write", "network", "shell", "clipboard_read", "clipboard_write", "screenshot", "browser_context", "plugin_data", "system_settings"],
    label: "FileTree Node runtime", invoke, until, check: mark }));
  await atStage("permission-settled", () => until(() => !dataDialog(), "FileTree permission requests did not settle"));
  const frame = await atStage("frame-mounted", () => until(() => document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]'), "Original FileTree iframe did not mount"));
  const initial = await atStage("initial-dom", () => until(async () => { const value = await frameProbe.request("state");
    return value.tree.includes("src") && value.tree.includes("Button.tsx") && value.tree.includes("readme.txt")
      && value.tree.includes("ignored.log") && !value.tree.includes("secret.txt") && !value.hiddenChecked
      && renderedHas(value, "src", "Button.tsx", "readme.txt", "ignored.log") && renderedLacks(value, "secret.txt")
      ? value : null;
  }, "Initial FileTree labels did not settle in both model and CodeMirror DOM"));
  mark(initial.tree.includes("src") && initial.tree.includes("Button.tsx") && initial.tree.includes("ignored.log")
    && !initial.tree.includes("secret.txt") && !initial.hiddenChecked, "Original files entry scans the owned fixture and starts with hidden files off");
  mark(renderedHas(initial, "src", "Button.tsx", "readme.txt", "ignored.log") && renderedLacks(initial, "secret.txt"),
    "Initial CodeMirror DOM contains expected visible labels and omits the hidden file");
  mark(initial.opaqueOrigin && !initial.pageHasTauri && Boolean(frame.getAttribute("sandbox")), "Production plugin frame remains opaque without host internals");
  const filtered = await atStage("filter-enter", () => frameProbe.request("filter-enter", { value: "*.log" }));
  const filteredState = await atStage("filter-dom", () => until(async () => { const value = await frameProbe.request("state");
    return value.ignoreValue === "*.log" && !value.tree.includes("ignored.log") && value.tree.includes("readme.txt")
      && renderedHas(value, "readme.txt") && renderedLacks(value, "ignored.log") ? value : null;
  }, "Original Enter-to-refresh filter did not remove ignored.log from model and CodeMirror DOM"));
  mark(filtered.ignoreValue === "*.log" && filteredState.tree.includes("readme.txt")
    && renderedHas(filteredState, "readme.txt") && renderedLacks(filteredState, "ignored.log"),
    "Original filter keeps readme.txt and excludes ignored.log in model and rendered DOM");
  await atStage("filter-clear", () => frameProbe.request("filter-enter", { value: "" }));
  const recovered = await atStage("filter-clear-dom", () => until(async () => { const value = await frameProbe.request("state");
    return value.ignoreValue === "" && value.tree.includes("ignored.log") && value.tree.includes("readme.txt")
      && renderedHas(value, "ignored.log", "readme.txt") ? value : null;
  }, "Clearing the filter did not restore entries in model and CodeMirror DOM"));
  mark(recovered.tree.includes("readme.txt") && renderedHas(recovered, "readme.txt", "ignored.log"),
    "Original rescan restores entries after clearing the filter in model and rendered DOM");
  await atStage("hidden-on", () => frameProbe.request("hidden-toggle", { checked: true }));
  const hiddenOn = await atStage("hidden-on-dom", () => until(async () => { const value = await frameProbe.request("state");
    return value.hiddenChecked && value.tree.includes("secret.txt") && value.tree.includes(".hidden")
      && renderedHas(value, "secret.txt", ".hidden") ? value : null;
  }, "Original hidden-file control did not reveal secret.txt in model and CodeMirror DOM"));
  mark(hiddenOn.tree.includes(".hidden") && renderedHas(hiddenOn, "secret.txt", ".hidden"),
    "Original hidden-file control reveals both fixture dotfiles in model and rendered DOM");
  await atStage("hidden-off", () => frameProbe.request("hidden-toggle", { checked: false }));
  const hiddenOff = await atStage("hidden-off-dom", () => until(async () => { const value = await frameProbe.request("state");
    return !value.hiddenChecked && value.tree.includes("readme.txt") && value.tree.includes("ignored.log")
      && !value.tree.includes("secret.txt") && !value.tree.includes(".hidden")
      && renderedHas(value, "readme.txt", "ignored.log") && renderedLacks(value, "secret.txt", ".hidden")
      ? value : null;
  }, "Turning hidden-file display off did not remove hidden labels from model and CodeMirror DOM"));
  mark(hiddenOff.tree.includes("readme.txt") && hiddenOff.tree.includes("ignored.log")
    && !hiddenOff.tree.includes(".hidden") && renderedHas(hiddenOff, "readme.txt", "ignored.log")
    && renderedLacks(hiddenOff, "secret.txt", ".hidden"),
    "Original hidden-file control removes dotfiles while preserving ordinary files in model and rendered DOM");
  const taskRun = await atStage("task-run-evidence", () => invoke<TaskRunEvidence>("native_file_tree_head_task_run_evidence"));
  mark(taskRun.passed && taskRun.matchedTaskRuns === 1 && taskRun.succeeded && taskRun.terminal
    && taskRun.entryTypeFiles && taskRun.payloadSummaryRedacted && taskRun.expectedOwnerMatched,
    "Exactly one successful files-entry TaskRun is bound to file-tree and carries redacted payload summaries");
  const runtimeBeforeReturn = await atStage("runtime-before-return", () => invoke<RuntimeState>("native_panel_runtime_state"));
  scenarioProgress.lastRuntimeBeforeReturn = {
    sessions: { count: Math.min(runtimeBeforeReturn.sessions, MAX_RUNTIME_COUNT_OBSERVATION),
      overflow: runtimeBeforeReturn.sessions > MAX_RUNTIME_COUNT_OBSERVATION },
    pending: { count: Math.min(runtimeBeforeReturn.pending, MAX_RUNTIME_COUNT_OBSERVATION),
      overflow: runtimeBeforeReturn.pending > MAX_RUNTIME_COUNT_OBSERVATION },
    transport: runtimeBeforeReturn.transport === true,
    resourceLeases: { count: Math.min(runtimeBeforeReturn.resourceLeases, MAX_RUNTIME_COUNT_OBSERVATION),
      overflow: runtimeBeforeReturn.resourceLeases > MAX_RUNTIME_COUNT_OBSERVATION },
  };
  mark(runtimeBeforeReturn.nativeDialogs === 0 && runtimeBeforeReturn.dialogInvocations === 0,
    "The original directory picker and save dialog were not invoked");
  mark(runtimeBeforeReturn.sessions > 0 && runtimeBeforeReturn.transport && runtimeBeforeReturn.resourceLeases === 0,
    "The actual FileTree panel owns its live Node session and transport without opening a lazy module-resource lease");
  const back = document.querySelector<HTMLButtonElement>(".back-btn");
  check(back, "Production PluginPanel exposes its Back control");
  scenarioProgress.currentStage = "back-navigation";
  back.click();
  await atStage("back-navigation", () => until(() => !document.querySelector(".plugin-panel") && document.activeElement?.matches('input[aria-label="搜索命令"], .search-input'),
    "Back navigation did not return to launcher search"));
  await atStage("runtime-drain", () => until(async () => {
    const value = await invoke<RuntimeState>("native_panel_runtime_state");
    return value.sessions === 0 && value.pending === 0 && !value.transport && value.resourceLeases === 0 ? value : null;
  }, "FileTree return left a Node session, permission request, or resource lease"));
  return { passed: true, checks, sourceKind: "pinned-git-head-original-plugin", sourceCase: "local-file-tree-head",
    businessActions: ["original files entry", "original ignore Enter refresh", "original hidden-file toggle"],
    activation: { route: "activate_file_content_feature", taskRunCount: taskRun.matchedTaskRuns, entryType: "files", payloadSummaryRedacted: taskRun.payloadSummaryRedacted },
    frameProbe: frameProbe.diagnostics(),
    limitations: ["Programmatic fixture activation and frame controls, not physical drag/drop or keyboard UX", "CodeMirror DOM text confirms rendered widget content, not visual same-machine comparison", "No OS picker/save invocation or clipboard operation was requested", "Node permission is broader than the fixed fixture path; no global filesystem or network sandbox is claimed", "No export/save path, arbitrary user files, or ecosystem-wide compatibility is established"] };
  } finally {
    frameProbe.dispose();
  }
}

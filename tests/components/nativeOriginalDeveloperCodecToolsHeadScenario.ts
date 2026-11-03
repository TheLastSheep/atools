import { invoke as rawInvoke } from "@tauri-apps/api/core";

type RuntimeState = { sessions: number; openings: number; pending: number; transport: boolean; resourceLeases: number };
type Fixture = { token: string; headDeveloperCodecToolsAcceptance: boolean; windowMode: "observe" | "foreground" };
type Profile = { caseId: string; id: string; version: string; featureCode: string; sourceCommit: string;
  sourceTree: string; directorySha256: string; fileCount: number; expandedBytes: number };
type FrameObservation = { appInitialized: boolean; handlerStarted: boolean; completionObserved: boolean;
  runDisabled: boolean; statusPhase: "empty" | "processing" | "complete" | "error" | "other" };
type FrameResult = { ready?: boolean; appInitialized?: boolean; opaqueOrigin?: boolean; pageHasTauri?: boolean; appControlsPresent?: boolean;
  operationSelected?: boolean; completed?: boolean; outputMatchesExpected?: boolean; errorVisible?: boolean;
  outputCleared?: boolean; expectedErrorShown?: boolean };
type TaskRunEvidence = { matchedTaskRuns: number; succeeded: boolean; terminal: boolean;
  expectedOwnerMatched: boolean; expectedCapabilityMatched: boolean; passed: boolean };

class FrameProbeError extends Error {
  constructor(code: string, readonly observation?: FrameObservation) { super(code); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseFrameObservation(value: unknown): FrameObservation | undefined {
  if (!isRecord(value)) return undefined;
  const phase = value.statusPhase;
  if (typeof value.appInitialized !== "boolean" || typeof value.handlerStarted !== "boolean"
    || typeof value.completionObserved !== "boolean" || typeof value.runDisabled !== "boolean"
    || !(phase === "empty" || phase === "processing" || phase === "complete" || phase === "error" || phase === "other")) return undefined;
  return { appInitialized: value.appInitialized, handlerStarted: value.handlerStarted,
    completionObserved: value.completionObserved, runDisabled: value.runDisabled, statusPhase: phase };
}
export type ScenarioStage = "bootstrap" | "fixture" | "search" | "panel" | "frame" | "encode" | "decode" | "malformed" | "recovery" | "task-run" | "return";
const SAMPLE = "ATools 编码 ✅";
const pause = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));
function check(value: unknown, code: string): asserts value { if (!value) throw Error(code); }
function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("DEVELOPER_CODEC_IPC_TIMEOUT")), 4000);
    rawInvoke<T>(command, args).then(value => { clearTimeout(timer); resolve(value); }, () => {
      clearTimeout(timer); reject(Error("DEVELOPER_CODEC_IPC_FAILED"));
    });
  });
}
async function until<T>(read: () => T | Promise<T>, code: string, timeoutMs = 10000): Promise<NonNullable<T>> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await pause();
  }
  throw Error(code);
}
function searchInput() {
  return document.querySelector<HTMLInputElement>('input[aria-label="搜索命令"]')
    || document.querySelector<HTMLInputElement>(".search-input");
}
function permissionDialog() {
  return document.querySelector<HTMLElement>("[data-permission-dialog], .permission-dialog, .plugin-permission-dialog");
}
function encodeUtf8Base64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function runNativeOriginalDeveloperCodecToolsHeadScenario(setStage: (stage: ScenarioStage) => void) {
  let token = "";
  let requestId = 0;
  let activeFrame: HTMLIFrameElement | null = null;
  const frameForCleanup = (): HTMLIFrameElement | null => activeFrame;
  const frameRequest = (operation: string, args: Record<string, unknown> = {}) => new Promise<FrameResult>((resolve, reject) => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]');
    if (!frame?.contentWindow) { reject(Error("DEVELOPER_CODEC_FRAME_UNAVAILABLE")); return; }
    activeFrame = frame;
    const source = frame.contentWindow;
    const id = ++requestId;
    const timer = window.setTimeout(() => { window.removeEventListener("message", receive); reject(Error("DEVELOPER_CODEC_FRAME_TIMEOUT")); }, 8000);
    function receive(event: MessageEvent) {
      if (event.source !== source || event.data?.kind !== "atools-developer-codec-head-result"
        || event.data?.token !== token || event.data?.id !== id) return;
      clearTimeout(timer); window.removeEventListener("message", receive);
      if (event.data.errorCode) {
        const code = typeof event.data.errorCode === "string" && /^DEVELOPER_CODEC_[A-Z_]+$/.test(event.data.errorCode)
          ? event.data.errorCode : "DEVELOPER_CODEC_OPERATION_FAILED";
        reject(new FrameProbeError(code, parseFrameObservation(event.data.observation)));
      } else resolve(event.data.result as FrameResult);
    }
    window.addEventListener("message", receive);
    source.postMessage({ kind: "atools-developer-codec-head-probe", token, id, operation, ...args }, "*");
  });
  try {
    setStage("fixture");
    const fixture = await invoke<Fixture>("native_panel_fixture");
    const profile = await invoke<Profile>("native_developer_codec_tools_profile");
    check(fixture.headDeveloperCodecToolsAcceptance, "DEVELOPER_CODEC_FIXTURE_MODE_INVALID");
    check(profile.caseId === "local-developer-codec-tools-head" && profile.id === "developer-codec-tools"
      && profile.version === "0.1.0" && profile.featureCode === "codec-tools"
      && profile.sourceCommit === "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d"
      && profile.sourceTree === "f758b127a8af4e225d75cca1bc6d7c7b690b2008"
      && profile.directorySha256 === "676b43a647856c945633863bcdea514218115c55c69ae770682ac76d9a36894a"
      && profile.fileCount === 15 && profile.expandedBytes === 59561, "DEVELOPER_CODEC_SOURCE_PROFILE_INVALID");
    token = fixture.token;

    setStage("search");
    const input = await until(searchInput, "DEVELOPER_CODEC_SEARCH_UNAVAILABLE");
    input.focus(); input.value = "Base64"; input.dispatchEvent(new Event("input", { bubbles: true }));
    const option = await until(() => [...document.querySelectorAll<HTMLElement>('[role="option"][aria-selected="true"]')]
      .find(node => node.dataset.pluginId === "developer-codec-tools"), "DEVELOPER_CODEC_SEARCH_RESULT_MISSING");
    check(option.getAttribute("aria-selected") === "true", "DEVELOPER_CODEC_SEARCH_SELECTION_INVALID");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    setStage("panel");
    await until(() => {
      if (permissionDialog()) throw Error("DEVELOPER_CODEC_PERMISSION_PROMPT_PRESENT");
      return document.querySelector(".plugin-panel") && document.querySelector(".plugin-title")?.textContent === "开发加解密编码工具";
    }, "DEVELOPER_CODEC_PANEL_NOT_OPEN");
    const frame = await until(() => document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]'), "DEVELOPER_CODEC_FRAME_MISSING");
    check(frame.getAttribute("sandbox") === "allow-scripts allow-popups" && Boolean(frame.getAttribute("srcdoc"))
      && !frame.getAttribute("src"), "DEVELOPER_CODEC_FRAME_ISOLATION_INVALID");
    if (permissionDialog()) throw Error("DEVELOPER_CODEC_PERMISSION_PROMPT_PRESENT");

    setStage("frame");
    const ready = await until(async () => {
      if (permissionDialog()) throw Error("DEVELOPER_CODEC_PERMISSION_PROMPT_PRESENT");
      try { const state = await frameRequest("state"); return state.ready ? state : null; }
      catch (error) { if (error instanceof Error && error.message === "DEVELOPER_CODEC_FRAME_TIMEOUT") return null; throw error; }
    }, "DEVELOPER_CODEC_ORIGINAL_CONTROLS_NOT_READY");
    check(ready.appInitialized === true && ready.opaqueOrigin === true && ready.pageHasTauri === false
      && ready.appControlsPresent === true, "DEVELOPER_CODEC_FRAME_STATE_INVALID");

    setStage("encode");
    const expectedBase64 = encodeUtf8Base64(SAMPLE);
    const encoded = await frameRequest("encode", { input: SAMPLE, expected: expectedBase64 });
    check(encoded.operationSelected === true && encoded.completed === true && encoded.outputMatchesExpected === true,
      "DEVELOPER_CODEC_BASE64_ENCODE_FAILED");
    setStage("decode");
    const decoded = await frameRequest("decode", { input: expectedBase64, expected: SAMPLE });
    check(decoded.operationSelected === true && decoded.completed === true && decoded.outputMatchesExpected === true,
      "DEVELOPER_CODEC_BASE64_DECODE_FAILED");
    setStage("malformed");
    const malformed = await frameRequest("malformed");
    check(malformed.operationSelected === true && malformed.errorVisible === true && malformed.outputCleared === true
      && malformed.expectedErrorShown === true, "DEVELOPER_CODEC_MALFORMED_INPUT_NOT_REPORTED");
    setStage("recovery");
    const recovered = await frameRequest("decode", { input: expectedBase64, expected: SAMPLE });
    check(recovered.operationSelected === true && recovered.completed === true && recovered.outputMatchesExpected === true,
      "DEVELOPER_CODEC_RECOVERY_FAILED");

    setStage("task-run");
    const taskRun = await invoke<TaskRunEvidence>("native_developer_codec_tools_task_run_evidence");
    check(taskRun.passed && taskRun.matchedTaskRuns === 1 && taskRun.succeeded && taskRun.terminal
      && taskRun.expectedOwnerMatched && taskRun.expectedCapabilityMatched, "DEVELOPER_CODEC_ACTIVATION_TASK_RUN_INVALID");

    setStage("return");
    const runtimeBeforeReturn = await invoke<RuntimeState>("native_panel_runtime_state");
    const back = document.querySelector<HTMLButtonElement>(".back-btn");
    check(back, "DEVELOPER_CODEC_BACK_CONTROL_MISSING");
    back.click();
    await until(() => !document.querySelector(".plugin-panel") && document.activeElement === searchInput(), "DEVELOPER_CODEC_RETURN_FAILED");
    const drained = await until(async () => {
      const state = await invoke<RuntimeState>("native_panel_runtime_state");
      return state.sessions === 0 && state.openings === 0 && state.pending === 0 && !state.transport && state.resourceLeases === 0 ? state : null;
    }, "DEVELOPER_CODEC_RUNTIME_NOT_DRAINED");
    return { passed: true, sourceCase: profile.caseId, sourceRevisionFromGitHead: true,
      sourceCommit: profile.sourceCommit, sourceTree: profile.sourceTree, directorySha256: profile.directorySha256,
      sourceFileCount: profile.fileCount, sourceExpandedBytes: profile.expandedBytes,
      activation: { route: "production-search-keyboard-selection", taskRunCount: taskRun.matchedTaskRuns,
        expectedOwnerMatched: taskRun.expectedOwnerMatched, terminal: taskRun.terminal },
      originalOperations: { unicodeBase64Encode: true, unicodeBase64Decode: true, malformedBase64Error: true,
        recoveryAfterMalformedInput: true },
      frame: { appInitialized: ready.appInitialized, opaqueOrigin: ready.opaqueOrigin, pageHasTauri: ready.pageHasTauri,
        sandboxed: true, sourceDocument: "production PluginPanel srcdoc" },
      observedRuntimeBeforeReturn: { nodeSessions: runtimeBeforeReturn.sessions, nodeOpenings: runtimeBeforeReturn.openings,
        pending: runtimeBeforeReturn.pending, transport: runtimeBeforeReturn.transport, resourceLeases: runtimeBeforeReturn.resourceLeases },
      runtimeDrainedAfterReturn: drained.sessions === 0 && drained.openings === 0 && drained.pending === 0 && !drained.transport && drained.resourceLeases === 0,
      clipboardButtonsInvoked: false,
      limitations: ["One exact pinned HEAD package; programmatic DOM control events, not physical keyboard input",
        "Activation is bound to one TaskRun; the original package computes the in-page codec operations without a separate host tool call",
        "No clipboard buttons, OS dialog, filesystem operation, or network request was invoked",
        "Fixture outcomes do not establish zero eager host-preparation prompts or narrow general Node permissions"] };
  } finally {
    const frame = frameForCleanup();
    if (frame?.contentWindow && token) frame.contentWindow.postMessage({ kind: "atools-developer-codec-head-probe", token, id: ++requestId, operation: "dispose" }, "*");
  }
}

export function nativeDeveloperCodecToolsFailureObservation(error: unknown, stage: ScenarioStage) {
  const known = error instanceof Error && /^DEVELOPER_CODEC_[A-Z_]+$/.test(error.message) ? error.message : "DEVELOPER_CODEC_UNEXPECTED_FAILURE";
  const observation = error instanceof FrameProbeError ? error.observation : undefined;
  return { passed: false, failureStage: stage, failureCode: known, ...(observation ? { frameObservation: observation } : {}) };
}

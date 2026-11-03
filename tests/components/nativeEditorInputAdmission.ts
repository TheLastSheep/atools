import { currentPublishedFrameDocument, invoke, type PublishedScenarioContext } from "./nativePublishedPluginCommon";
import { createNativeUiInputTimeline } from "./nativeUiInputTimeline.mjs";

type Phase = "alpha" | "beta" | "valid" | "format" | "malformed" | "recovery";
type Native = { appActive?: boolean; appHidden?: boolean; frontmostIsSelf?: boolean; nativeFocused?: boolean;
  nativeVisible?: boolean; windowOcclusionVisible?: boolean; webviewKeyboardOwnerVerified?: boolean };
type Frame = { focusDiagnostics?: { visibilityState?: string; documentHidden?: boolean; documentHasFocus?: boolean;
  editorActive?: boolean; editorConnected?: boolean; editorWidth?: number; editorHeight?: number; textareaActive?: boolean;
  textareaConnected?: boolean; textareaWidth?: number; textareaHeight?: number } };
type Request = { pid: number; caseId: string; phase: Phase; actionOrdinal: number; documentNonce: string;
  armNonce: string; requestNonce: string };
type Stage = "foreground-request" | "native-observe" | "authenticated-frame" | "phase-arm" | "handshake-poll" | "post-click-native" | "post-click-frame" | "post-click-ack";
const instances = new WeakMap<PublishedScenarioContext, ReturnType<typeof create>>();

export function nativeEditorWindowReady(value: Native, hostVisibility: string, requireOwner = false) {
  return value.appActive === true && value.appHidden === false && value.frontmostIsSelf === true
    && value.nativeFocused === true && value.nativeVisible === true && value.windowOcclusionVisible === true
    && hostVisibility === "visible" && (!requireOwner || value.webviewKeyboardOwnerVerified === true);
}

function create(context: PublishedScenarioContext) {
  const timeline = createNativeUiInputTimeline(document, window, { context: "host", editorKind: "host" });
  let phase: Phase | "admission" = "admission", armedDocument: string | undefined, serviced = false, stopped = false;
  let configured = false, acknowledged = false, pollCount = 0, intervalTotal = 0;
  const intervals: Array<{ stage: Stage; phase: string; requestMs: number; responseMs: number; result: "resolved" | "rejected" }> = [];
  const evidence = { intervals, timeline: timeline.snapshot(), pollCount: 0, stopped: false, handshake: [] as unknown[],
    clocks: "Intervals use this host performance.now only; native, frame and controller clocks are separate." };
  context.observations.nativeEditorAdmission = evidence;
  const observe = (event: Event) => timeline.observe(event, phase);
  timeline.eventTypes.forEach(type => document.addEventListener(type, observe, true));
  const pagehide = () => stopHost();
  window.addEventListener("pagehide", pagehide);
  function stopHost() {
    if (stopped) return;
    stopped = true;
    timeline.eventTypes.forEach(type => document.removeEventListener(type, observe, true));
    window.removeEventListener("pagehide", pagehide);
    timeline.stop(); evidence.timeline = timeline.snapshot(); evidence.stopped = true;
  }
  async function measure<T>(stage: Stage, action: () => Promise<T>): Promise<T> {
    const requestMs = performance.now();
    try {
      const value = await action();
      if (intervalTotal++ < 128) intervals.push({ stage, phase, requestMs, responseMs: performance.now(), result: "resolved" });
      return value;
    } catch (error) {
      if (intervalTotal++ < 128) intervals.push({ stage, phase, requestMs, responseMs: performance.now(), result: "rejected" });
      throw error;
    } finally { evidence.timeline = timeline.snapshot(); }
  }
  async function arm(next: Phase) {
    phase = next; serviced = false; acknowledged = false; pollCount = 0;
    armedDocument = currentPublishedFrameDocument(context);
    if (!armedDocument) throw Error("NativeEditorAdmissionMissingAuthenticatedDocument");
    const result = await measure("phase-arm", () => invoke<{ configured: boolean }>("native_editor_input_exchange", {
      operation: "arm", phase: next, documentNonce: armedDocument,
    }));
    configured = result.configured;
    if (!configured) throw Error("NativeEditorAdmissionExchangeRequired");
  }
  async function service() {
    if (!configured || serviced || stopped) return;
    if (++pollCount > 400) throw Error("NativeEditorPostClickHandshakeDeadline");
    evidence.pollCount++;
    // Reuse the scenario's finite business polling; no timer, event tap or per-key IPC is installed.
    const request = await measure("handshake-poll", () => invoke<Request | null>("native_editor_input_exchange", { operation: "poll" }));
    if (!request) return;
    serviced = true;
    const native = await measure("post-click-native", () => invoke<Native>("native_panel_foreground", { ensure: false }));
    const state = await measure("post-click-frame", () => context.probe<Frame>("state"));
    const focus = state.focusDiagnostics;
    const frame = document.querySelector('iframe[title="Plugin"]');
    const currentDocument = currentPublishedFrameDocument(context);
    const host = { visible: document.visibilityState === "visible", focused: document.hasFocus(), activeIsPluginFrame: !!frame && document.activeElement === frame,
      permissionFree: !document.querySelector('[data-permission-dialog], [aria-modal="true"]') };
    const editorReady = context.profile.caseId === "local-plain-text"
      ? focus?.editorActive === true && focus.editorConnected === true && (focus.editorWidth ?? 0) > 0 && (focus.editorHeight ?? 0) > 0
      : focus?.textareaActive === true && focus.textareaConnected === true
        && (focus.textareaWidth ?? 0) > 0 && (focus.textareaHeight ?? 0) > 0;
    const passed = phase !== "admission" && request.caseId === context.profile.caseId && request.phase === phase
      && request.documentNonce === armedDocument && currentDocument === armedDocument
      && nativeEditorWindowReady(native, document.visibilityState, true)
      && host.focused && host.activeIsPluginFrame && host.permissionFree && focus?.documentHasFocus === true
      && focus.documentHidden === false && focus.visibilityState === "visible" && (phase === "format" || editorReady);
    evidence.handshake.push({ phase, actionOrdinal: request.actionOrdinal, native, host,
      documentMatches: currentDocument === armedDocument, frameFocused: focus?.documentHasFocus === true,
      frameVisible: focus?.visibilityState === "visible" && focus.documentHidden === false, editorReady, passed });
    const ack = await measure("post-click-ack", () => invoke<{ acknowledged: boolean; passed: boolean }>("native_editor_input_exchange", { operation: "ack", request, passed }));
    acknowledged = passed && ack.acknowledged === true && ack.passed === true;
    if (!passed) throw Error("NativeEditorPostClickPreconditionFailed:" + phase);
    if (!acknowledged) throw Error("NativeEditorPostClickAcknowledgmentFailed:" + phase);
  }
  async function stop() {
    stopHost();
    await invoke("native_editor_input_exchange", { operation: "stop" });
  }
  return { measure, arm, service, stop, readyForAcceptance: () => configured && acknowledged && !stopped };
}

export function installEditorInputAdmission(context: PublishedScenarioContext) {
  let instance = instances.get(context);
  if (!instance) { instance = create(context); instances.set(context, instance); }
  return instance;
}
export const editorInputAdmission = (context: PublishedScenarioContext) => instances.get(context);

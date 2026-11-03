import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PublishedScenarioContext } from "./nativePublishedPluginCommon";
const transport = vi.hoisted(() => ({ invoke: vi.fn(), document: "a".repeat(32) as string | undefined }));
vi.mock("./nativePublishedPluginCommon", () => ({ invoke: transport.invoke,
  currentPublishedFrameDocument: () => transport.document }));
import { installEditorInputAdmission, nativeEditorWindowReady } from "./nativeEditorInputAdmission";

const native = { appActive: true, appHidden: false, frontmostIsSelf: true, nativeFocused: true,
  nativeVisible: true, windowOcclusionVisible: true, webviewKeyboardOwnerVerified: true };
const disposers: Array<() => Promise<void>> = [];
beforeEach(() => {
  transport.invoke.mockReset(); transport.document = "a".repeat(32);
  document.body.innerHTML = '<iframe title="Plugin" class="plugin-iframe"></iframe>';
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  document.querySelector<HTMLIFrameElement>("iframe")!.focus();
});
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); document.body.innerHTML = ""; vi.restoreAllMocks(); });

function harness(change?: (value: any, command: string) => void, caseId = "local-plain-text") {
  let pending = true;
  transport.invoke.mockImplementation(async (command, args) => {
    let value: any = command === "native_panel_foreground" ? { ...native }
      : args.operation === "arm" ? { configured: true }
      : args.operation === "poll" ? pending ? { pid: 1234, caseId, phase: caseId === "local-plain-text" ? "alpha" : "valid", actionOrdinal: 1,
        documentNonce: "a".repeat(32), armNonce: "b".repeat(32), requestNonce: "c".repeat(32) } : null
      : args.operation === "ack" ? { acknowledged: true, passed: args.passed } : { stopped: true };
    change?.(value, command);
    if (args?.operation === "ack") pending = false;
    return value;
  });
  const probe = vi.fn(async () => ({ focusDiagnostics: { documentHidden: false, visibilityState: "visible",
    documentHasFocus: true, editorActive: true, editorConnected: true, editorWidth: 200, editorHeight: 100 } }));
  const observations: Record<string, any> = {};
  const context = { profile: { caseId }, observations, probe } as unknown as PublishedScenarioContext;
  const admission = installEditorInputAdmission(context);
  disposers.push(admission.stop);
  return { admission, probe, observations };
}

it("requires every native activation flag and an exact positive ownership proof", () => {
  expect(nativeEditorWindowReady(native, "visible", true)).toBe(true);
  for (const key of Object.keys(native)) {
    const changed = { ...native, [key]: key === "appHidden" ? true : false };
    expect(nativeEditorWindowReady(changed, "visible", true), key).toBe(false);
  }
  expect(nativeEditorWindowReady(native, "hidden", true)).toBe(false);
  expect(nativeEditorWindowReady({ ...native, webviewKeyboardOwnerVerified: undefined }, "visible", true)).toBe(false);
});

it("acknowledges one fresh document-bound post-click request after native and frame reads", async () => {
  const h = harness(); await h.admission.arm("alpha"); await h.admission.service(); await h.admission.service();
  expect(h.admission.readyForAcceptance()).toBe(true);
  expect(h.probe).toHaveBeenCalledOnce(); expect(h.probe).toHaveBeenCalledWith("state");
  expect(transport.invoke.mock.calls.map(([command, args]) => command === "native_panel_foreground" ? "native-observe" : args.operation))
    .toEqual(["arm", "poll", "native-observe", "ack"]);
  expect(transport.invoke.mock.calls.at(-1)?.[1].passed).toBe(true);
  expect(h.observations.nativeEditorAdmission.handshake[0]).toMatchObject({ passed: true, documentMatches: true, editorReady: true });
});

it("cannot advance a click-only or input phase until its own fresh handshake is acknowledged", async () => {
  const h = harness(); await h.admission.arm("alpha");
  expect(h.admission.readyForAcceptance()).toBe(false);
  transport.invoke.mockResolvedValueOnce(null);
  await h.admission.service();
  expect(h.admission.readyForAcceptance()).toBe(false);
  await h.admission.service();
  expect(h.admission.readyForAcceptance()).toBe(true);
  await h.admission.arm("beta");
  expect(h.admission.readyForAcceptance()).toBe(false);
});

it.each(["owner", "foreign-document", "changed-document", "foreign-phase", "modal", "editor-focus", "frame-focus"])
("rejects %s without substituting diagnostic counters for focus evidence", async failure => {
  const h = harness((value, command) => {
    if (failure === "owner" && command === "native_panel_foreground") value.webviewKeyboardOwnerVerified = false;
    if (value?.requestNonce && failure === "foreign-document") value.documentNonce = "f".repeat(32);
    if (value?.requestNonce && failure === "foreign-phase") value.phase = "beta";
  });
  await h.admission.arm("alpha");
  if (failure === "changed-document") transport.document = "d".repeat(32);
  if (failure === "modal") document.body.insertAdjacentHTML("beforeend", '<div aria-modal="true"></div>');
  if (failure === "editor-focus" || failure === "frame-focus") h.probe.mockResolvedValueOnce({ focusDiagnostics: {
    documentHidden: false, visibilityState: "visible", documentHasFocus: failure !== "frame-focus",
    editorActive: false, editorConnected: true, editorWidth: 200, editorHeight: 100 } });
  await expect(h.admission.service()).rejects.toThrow("PostClickPreconditionFailed:alpha");
  expect(transport.invoke.mock.calls.at(-1)?.[1].passed).toBe(false);
});

it("fails missing identity or unconfigured exchange before requesting input", async () => {
  const h = harness(); transport.document = undefined;
  await expect(h.admission.arm("alpha")).rejects.toThrow("MissingAuthenticatedDocument");
  expect(transport.invoke).not.toHaveBeenCalled();
  transport.document = "a".repeat(32); transport.invoke.mockResolvedValue({ configured: false });
  await expect(h.admission.arm("alpha")).rejects.toThrow("ExchangeRequired");
});

it.each(["visible", "disconnected", "zero-width", "zero-height"])("requires connected visible JSON textarea: %s", async variant => {
  const h = harness(undefined, "local-json-editor");
  h.probe.mockResolvedValue({ focusDiagnostics: { documentHidden: false, visibilityState: "visible", documentHasFocus: true,
    textareaActive: true, textareaConnected: variant !== "disconnected", textareaWidth: variant === "zero-width" ? 0 : 1,
    textareaHeight: variant === "zero-height" ? 0 : 20 } } as any);
  await h.admission.arm("valid");
  if (variant === "visible") await expect(h.admission.service()).resolves.toBeUndefined();
  else await expect(h.admission.service()).rejects.toThrow("PostClickPreconditionFailed:valid");
  expect(transport.invoke.mock.calls.at(-1)?.[1].passed).toBe(variant === "visible");
});

it("removes host event listeners on early stop and pagehide without reading input content", async () => {
  const h = harness();
  const event = new Event("keydown");
  for (const property of ["key", "code", "keyCode", "which", "data", "dataTransfer", "clipboardData"])
    Object.defineProperty(event, property, { get: () => { throw Error("forbidden"); } });
  document.dispatchEvent(event);
  window.dispatchEvent(new Event("pagehide"));
  const before = h.observations.nativeEditorAdmission.timeline;
  document.dispatchEvent(event); await h.admission.stop();
  expect(h.observations.nativeEditorAdmission.timeline.stopped).toBe(true);
  expect(h.observations.nativeEditorAdmission.timeline.total).toBe(before.total);
  expect(h.observations.nativeEditorAdmission.stopped).toBe(true);
});

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import source from "./nativeOriginalJsonEditorFrameOperations.js?raw";

type Adapter = {
  caseId: string;
  state: () => Record<string, unknown>;
  perform: (operation: string) => Promise<Record<string, unknown>>;
};
const owned = window as unknown as {
  __ATOOLS_PUBLISHED_CASE_OPERATIONS__?: Adapter;
  __ATOOLS_JSON_WORKER_CONTRACT__?: { run: () => Promise<Record<string, unknown>> };
  ztools?: unknown;
  services?: unknown;
};
let adapter: Adapter;
let execCommand: ReturnType<typeof vi.fn>;
let originalExecCommand: PropertyDescriptor | undefined;
const expectedValid = '{"name":"ATools","nested":{"active":true,"items":[1,2]}}';
const expectedInvalid = '{"name":"ATools","nested":[1,]}';

beforeEach(() => {
  // Minimal synthetic Monaco-shaped DOM: original package code and worker never execute here.
  document.body.innerHTML = `<main><div id="inputEditor"><div class="monaco-editor">
    <textarea class="inputarea"></textarea><div class="view-lines"></div>
  </div></div><div class="handle"><button type="button" title="reformat"></button></div></main>`;
  originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
  execCommand = vi.fn(() => true);
  Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
  owned.ztools = new Proxy({}, { get() { throw Error("Unexpected host operation"); } });
  owned.services = new Proxy({}, { get() { throw Error("Unexpected preload operation"); } });
  window.eval(source);
  adapter = owned.__ATOOLS_PUBLISHED_CASE_OPERATIONS__!;
});

afterEach(async () => {
  if (adapter) await adapter.perform("stop-focus-observation");
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  if (originalExecCommand) Object.defineProperty(document, "execCommand", originalExecCommand);
  else delete (document as Document & { execCommand?: typeof document.execCommand }).execCommand;
  delete owned.__ATOOLS_PUBLISHED_CASE_OPERATIONS__;
  delete owned.__ATOOLS_JSON_WORKER_CONTRACT__;
  delete owned.ztools;
  delete owned.services;
});

it("uses browser edit commands on the original textarea without faking Monaco input events", async () => {
  expect(adapter.caseId).toBe("local-json-editor");
  expect(adapter.state()).toMatchObject({ ready: true, inputReady: true, formatActionReady: true, malformedMarkerCount: 0 });
  const textarea = document.querySelector<HTMLTextAreaElement>("textarea.inputarea")!;
  const inputEvents = vi.fn();
  textarea.addEventListener("input", inputEvents);
  const result = await adapter.perform("enter-valid-json");
  expect(document.activeElement).toBe(textarea);
  expect(result.focusDiagnostics).toMatchObject({ textareaActive: true, textareaConnected: true, textareaDisabled: false, textareaReadOnly: false });
  expect(execCommand.mock.calls).toEqual([["selectAll"], ["insertText", false, expectedValid]]);
  expect(result.editCommandResults).toEqual([
    { command: "selectAll", accepted: true }, { command: "insertText", accepted: true },
  ]);
  // The DOM fixture intentionally does not simulate Monaco or mutate the editor value.
  // Actual document editing and model synchronization are asserted by the native scenario.
  expect(textarea.value).toBe("");
  expect(inputEvents).not.toHaveBeenCalled();
  await adapter.perform("enter-malformed-json");
  expect(execCommand.mock.calls.slice(2)).toEqual([["selectAll"], ["insertText", false, expectedInvalid]]);
});

it("returns bounded DOM diagnostics when browser focus cannot be acquired", async () => {
  const textarea = document.querySelector<HTMLTextAreaElement>("textarea.inputarea")!;
  textarea.focus = vi.fn();
  const result = await adapter.perform("enter-valid-json");
  expect(result.focusDiagnostics).toMatchObject({ textareaActive: false, textareaConnected: true });
  expect(result.focusDiagnostics).toHaveProperty("textareaWidth");
  expect(result.focusDiagnostics).toHaveProperty("textareaHeight");
  expect(Array.isArray(result.focusDiagnostics.ancestors)).toBe(true);
  expect(result.focusDiagnostics.ancestors.length).toBeLessThanOrEqual(8);
  expect(result.editCommandResults).toEqual([{ command: "focus", accepted: false }]);
  expect(execCommand).not.toHaveBeenCalled();
  expect(textarea.value).toBe("");
});

it("focuses the current textarea without editing and keeps state reads passive", async () => {
  const textarea = document.querySelector<HTMLTextAreaElement>("textarea.inputarea")!;
  const focus = vi.spyOn(textarea, "focus");
  const result = await adapter.perform("focus-input");

  expect(focus).toHaveBeenCalledOnce();
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(result.focusInputSucceeded).toBe(true);
  expect(result.focusDiagnostics).toMatchObject({ textareaActive: true, textareaConnected: true });
  expect(result.editCommandResults).toEqual([]);
  expect(execCommand).not.toHaveBeenCalled();
  expect(textarea.value).toBe("");

  expect(adapter.state().focusDiagnostics).toMatchObject({ textareaActive: true, textareaConnected: true });
  await adapter.perform("read-focus-observation");
  expect(focus).toHaveBeenCalledOnce();
  expect(textarea.value).toBe("");
  expect(execCommand).not.toHaveBeenCalled();
});

it("reports bounded document visibility and current RAF observation state", async () => {
  const snapshot = adapter.state();
  const diagnostics = snapshot.focusDiagnostics as Record<string, unknown>;
  expect(["visible", "hidden", "prerender", "other"]).toContain(diagnostics.visibilityState);
  expect(typeof diagnostics.documentHidden).toBe("boolean");
  expect(diagnostics.focusObservationFramePending).toBe(false);
  expect(diagnostics.focusObservationAfterFrame).toBeNull();
  expect((snapshot.focusObservation as Record<string, unknown>).framePending).toBe(false);
});

it("compares captured native focus on the original textarea and temporary standard controls", async () => {
  const textarea = document.querySelector<HTMLTextAreaElement>("textarea.inputarea")!;
  textarea.focus = vi.fn();
  const createElement = vi.spyOn(document, "createElement");
  const result = await adapter.perform("diagnose-focus-controls");
  const diagnostic = result.focusControlDiagnostics as Record<string, unknown>;

  expect(diagnostic).toMatchObject({
    originalTextareaNativeFocusActive: true,
    temporaryInputNativeFocusActive: true,
    temporaryTextareaNativeFocusActive: true,
    originalFocusIsCapturedNative: false,
    originalHasOwnFocus: true,
  });
  expect(typeof diagnostic.documentHasFocus).toBe("boolean");
  expect(diagnostic.documentHasFocus).toBeDefined();
  const createdElementsAfterDiagnostic = createElement.mock.calls.length;
  expect(document.querySelector("[data-atools-focus-diagnostic]")).toBeNull();
  expect(textarea.value).toBe("");
  expect(result.editCommandResults).toEqual([]);
  expect(execCommand).not.toHaveBeenCalled();

  adapter.state();
  await adapter.perform("read-focus-observation");
  expect(createElement).toHaveBeenCalledTimes(createdElementsAfterDiagnostic);
  expect(document.querySelector("[data-atools-focus-diagnostic]")).toBeNull();
  expect(textarea.value).toBe("");
  expect(execCommand).not.toHaveBeenCalled();
});

it("removes temporary focus controls when the diagnostic setup throws", async () => {
  const originalAppend = document.body.appendChild;
  vi.spyOn(document.body, "appendChild").mockImplementation(((node: Node) => {
    originalAppend.call(document.body, node);
    throw Error("diagnostic setup failed");
  }) as typeof document.body.appendChild);

  await expect(adapter.perform("diagnose-focus-controls")).rejects.toThrow("diagnostic setup failed");
  expect(document.querySelector("[data-atools-focus-diagnostic]")).toBeNull();
  expect(document.querySelector<HTMLTextAreaElement>("textarea.inputarea")!.value).toBe("");
  expect(execCommand).not.toHaveBeenCalled();
});

it("invokes only the reviewed reformat button and refuses unreviewed operations", async () => {
  const button = document.querySelector(".handle button")!;
  const click = vi.fn();
  button.addEventListener("click", click);
  expect((await adapter.perform("reformat")).formatActionReady).toBe(true);
  expect(click).toHaveBeenCalledOnce();
  await expect(adapter.perform("copy")).rejects.toThrow(/Unknown original JSON Editor operation/);
  await expect(adapter.perform("paste")).rejects.toThrow(/Unknown original JSON Editor operation/);
});

it("dispatches the explicit contract-only operation to its separate client", async () => {
  const run = vi.fn(async () => ({ completed: true, elapsedMs: 120, stages: [] }));
  owned.__ATOOLS_JSON_WORKER_CONTRACT__ = { run };
  const result = await adapter.perform("worker-contract");
  expect(run).toHaveBeenCalledOnce();
  expect(result.ready).toBe(true);
  expect(result.inputReady).toBe(true);
  expect(result.formatActionReady).toBe(true);
  expect(result.workerContract).toEqual({ completed: true, elapsedMs: 120, stages: [] });
  await expect(adapter.perform("worker-contract-unbounded")).rejects.toThrow(/Unknown original JSON Editor operation/);
});

it("lazily registers one bounded trusted focus and pointer observer and reports only safe target metadata", async () => {
  const add = vi.spyOn(document, "addEventListener");
  const frames: Array<(time: number) => void> = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  const first = await adapter.perform("begin-focus-observation");
  expect(first.focusObservation).toMatchObject({
    started: true, eventCount: 0, overflow: false, listenerCount: 4,
    before: { editorInputConnected: true, editorInputActive: false }, afterFrame: null, framePending: false,
  });
  const observedTypes = add.mock.calls.filter(([type]) => ["focus", "focusin", "blur", "pointerdown"].includes(String(type)))
    .map(([type, , capture]) => [type, capture]);
  expect(observedTypes).toEqual([["focus", true], ["focusin", true], ["blur", true], ["pointerdown", true]]);
  await adapter.perform("begin-focus-observation");
  expect(add.mock.calls.filter(([type]) => ["focus", "focusin", "blur", "pointerdown"].includes(String(type))))
    .toHaveLength(4);

  const textarea = document.querySelector<HTMLTextAreaElement>("textarea.inputarea")!;
  textarea.focus();
  textarea.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  const observed = await adapter.perform("read-focus-observation");
  const snapshot = observed.focusObservation as {
    eventCount: number; overflow: boolean; events: Array<Record<string, unknown>>; afterFrame: unknown; framePending: boolean;
  };
  expect(snapshot.eventCount).toBeGreaterThanOrEqual(2);
  expect(snapshot.overflow).toBe(false);
  expect(snapshot.events.some(event => event.type === "pointerdown" && event.inEditor === true && event.isEditorInput === true)).toBe(true);
  expect(snapshot.events.every(event => typeof event.isTrusted === "boolean")).toBe(true);
  expect(snapshot.events.find(event => event.type === "pointerdown")?.isTrusted).toBe(false);
  expect(Object.keys(snapshot.events.at(-1)!).sort()).toEqual([
    "editorInputActive", "editorInputConnected", "inEditor", "isEditorInput", "isTrusted", "targetClass", "targetTag", "type",
  ]);
  expect(Object.keys(snapshot)).not.toEqual(expect.arrayContaining(["value", "text", "inputText", "clientX", "clientY", "href", "uri"]));
  expect(frames).toHaveLength(1);
  expect(snapshot.framePending).toBe(true);
  expect(observed.focusDiagnostics).toMatchObject({ focusObservationFramePending: true, focusObservationAfterFrame: null });
  frames[0](0);

  const afterFrameResult = await adapter.perform("read-focus-observation");
  const afterFrame = afterFrameResult.focusObservation as typeof snapshot;
  expect(afterFrame.afterFrame).toEqual({ sameEditorInput: true, editorInputConnected: true, editorInputActive: true });
  expect(afterFrameResult.focusDiagnostics).toMatchObject({
    focusObservationFramePending: false,
    focusObservationAfterFrame: { sameEditorInput: true, editorInputConnected: true, editorInputActive: true },
  });
  expect(afterFrame.framePending).toBe(false);
  expect(afterFrame.eventCount).toBe(snapshot.eventCount);
  expect(frames).toHaveLength(1);
  afterFrame.events[0].targetClass = "mutated copy";
  expect(((await adapter.perform("read-focus-observation")).focusObservation as typeof snapshot).events[0].targetClass)
    .not.toBe("mutated copy");
});

it("caps focus and pointer observations at 32 events and exposes overflow", async () => {
  const frames: Array<(time: number) => void> = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  await adapter.perform("begin-focus-observation");
  const textarea = document.querySelector<HTMLTextAreaElement>("textarea.inputarea")!;
  for (let index = 0; index < 40; index++) textarea.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  const state = (await adapter.perform("read-focus-observation")).focusObservation as {
    eventCount: number; overflow: boolean; events: unknown[]; framePending: boolean;
  };
  expect(state.eventCount).toBe(33);
  expect(state.events).toHaveLength(32);
  expect(state.overflow).toBe(true);
  expect(state.framePending).toBe(true);
  expect(frames).toHaveLength(1);
});

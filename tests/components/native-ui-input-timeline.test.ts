import { afterEach, expect, it, vi } from "vitest";
import plainSource from "./nativePlainTextUiInputObservation.js?raw";
import jsonSource from "./nativeJsonUiInputObservation.js?raw";
import { createNativeUiInputTimeline, nativeUiInputObservationSource } from "./nativeUiInputTimeline.mjs";

const forbidden = ["key", "code", "keyCode", "which", "data", "dataTransfer", "clipboardData", "value",
  "textContent", "innerText", "selection", "selectionStart", "selectionEnd", "id", "className", "tagName", "url"];
afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });

function poison<T extends object>(value: T) {
  for (const name of forbidden) Object.defineProperty(value, name, {
    configurable: true, get() { throw Error("forbidden-private-field:" + name); },
  });
  return value;
}
function markup(kind: "plain" | "json") {
  document.body.innerHTML = kind === "plain"
    ? '<div class="cm-editor"><div class="cm-content" contenteditable="true"></div></div><button>outside</button>'
    : '<div id="inputEditor"><div class="monaco-editor"><textarea class="inputarea"></textarea></div></div><div class="handle"><button>format</button></div>';
  return document.querySelector(kind === "plain" ? ".cm-content" : "textarea")!;
}
function install(kind: "plain" | "json") {
  const editor = markup(kind), added = vi.spyOn(document, "addEventListener");
  window.eval(nativeUiInputObservationSource(kind === "plain" ? plainSource : jsonSource));
  const api = (window as any)[kind === "plain" ? "__ATOOLS_NATIVE_PLAIN_TEXT_UI_INPUT__" : "__ATOOLS_NATIVE_JSON_UI_INPUT__"];
  const listeners = new Map(added.mock.calls.filter(call => typeof call[1] === "function")
    .map(call => [String(call[0]), call[1] as EventListener]));
  return { api, editor, emit(type: string, target: EventTarget = editor, isTrusted = true) {
    listeners.get(type)?.(poison({ type, target, isTrusted, isComposing: false, inputType: "insertText" }) as unknown as Event);
  } };
}

it.each(["plain", "json"] as const)("%s observes admission and unrelated frame keys without promoting them to editor proof", kind => {
  const f = install(kind), phase = kind === "plain" ? "alpha" : "valid";
  expect(f.api.snapshot().timeline.entries[0]).toMatchObject({ eventType: "installed", phase: "admission" });
  f.emit("keydown", document.body);
  expect(f.api.snapshot().records).toEqual({});
  f.api.begin(phase);
  f.emit("keydown", document.body);
  f.emit("input", f.editor, false);
  const snapshot = f.api.snapshot();
  expect(snapshot).toMatchObject({ schemaVersion: 2, listenerCount: 8, lifecycleListenerCount: 2,
    records: { [phase]: { trustedKeydowns: 0, trustedBeforeInputs: 0, trustedInputs: 0, rejectedUntrusted: 1 } } });
  expect(snapshot.timeline.entries.slice(1)).toMatchObject([
    { phase: "admission", eventType: "keydown", targetKind: "body", isTrusted: true },
    { phase, eventType: "keydown", targetKind: "body", isTrusted: true },
    { phase, eventType: "input", targetKind: "exact-editor", isTrusted: false },
  ]);
  expect((window as any).createNativeUiInputTimeline).toBeUndefined();
  expect((window as any).__ATOOLS_NATIVE_UI_INPUT_TIMELINE_FACTORY__).toBeUndefined();
  f.api.stop();
});

it.each(["plain", "json"] as const)("%s ignores every poisoned content field while recording trusted editing context", kind => {
  const f = install(kind), phase = kind === "plain" ? "alpha" : "valid";
  f.api.begin(phase);
  for (const type of ["pointerdown", "keydown", "beforeinput", "input"]) f.emit(type);
  const snapshot = f.api.snapshot();
  expect(snapshot.records[phase]).toMatchObject({ trustedEditorPointers: 1, trustedKeydowns: 1,
    trustedBeforeInputs: 1, trustedInputs: 1 });
  expect(JSON.stringify(snapshot)).not.toContain("forbidden-private-field");
  expect(snapshot.timeline.entries).toHaveLength(5);
  f.api.stop();
});

it("classifies only exact static roles and reads no host content or arbitrary target properties", () => {
  document.body.innerHTML = '<iframe class="plugin-iframe"></iframe><button>private host control</button>';
  const frame = document.querySelector("iframe")!, other = document.querySelector("button")!;
  const timeline = createNativeUiInputTimeline(document, window, { context: "host", editorKind: "host" });
  for (const target of [frame, document.body, document, other, poison({})])
    timeline.observe(poison({ type: "keydown", target, isTrusted: true, isComposing: false }) as unknown as Event);
  expect(timeline.snapshot().entries.slice(1).map(entry => entry.targetKind)).toEqual([
    "host-plugin-frame", "body", "document", "other", "other"]);
  expect(JSON.stringify(timeline.snapshot())).not.toContain("private host control");
  timeline.stop();
});

it("keeps frame container and format roles separate from the exact JSON textarea", () => {
  const editor = markup("json"), timeline = createNativeUiInputTimeline(document, window, { context: "plugin", editorKind: "json" });
  for (const target of [editor, document.querySelector(".monaco-editor"), document.querySelector(".handle button")])
    timeline.observe({ type: "click", target, isTrusted: true } as Event, "format");
  expect(timeline.snapshot().entries.slice(1).map(entry => entry.targetKind)).toEqual([
    "exact-editor", "editor-container", "format-button"]);
  timeline.stop();
});

it("bounds retained events and saturated totals while preserving detached snapshots", () => {
  const timeline = createNativeUiInputTimeline(document, window, { context: "host", editorKind: "host" });
  const event = poison({ type: "input", target: document.body, isTrusted: true, isComposing: false });
  for (let i = 0; i < 9000; i++) timeline.observe(event as unknown as Event, "valid");
  const snapshot = timeline.snapshot();
  expect(snapshot).toMatchObject({ capacity: 128, counterLimit: 8192, total: 8192, overflow: true });
  expect(snapshot.entries).toHaveLength(128);
  expect(snapshot.entries.at(-1)?.seq).toBe(128);
  snapshot.entries[0].targetKind = "other";
  expect(timeline.snapshot().entries[0].targetKind).toBe("unknown");
  timeline.stop();
  timeline.observe(new Proxy({} as Event, { get() { throw Error("stopped-event-read"); } }));
  expect(timeline.snapshot().total).toBe(8192);
});

it("uses only a local monotonic clock and retains unknown observations without clock substitution", () => {
  const values = [100, 104, 102, 109];
  const localWindow = { performance: { now: () => values.shift() } } as unknown as Window;
  const timeline = createNativeUiInputTimeline(document, localWindow, { context: "host", editorKind: "host" });
  timeline.observe({ type: "keydown", target: document.body } as unknown as Event);
  timeline.observe({ type: "input", target: document.body } as unknown as Event);
  expect(timeline.snapshot().entries.map(entry => entry.elapsedMs)).toEqual([4, 4, 9]);
  expect(timeline.snapshot().entries[1]).toMatchObject({ isTrusted: "unknown", isComposing: "unknown" });
  const unavailable = createNativeUiInputTimeline({ querySelector() { throw Error("private DOM failure"); },
    hasFocus() { throw Error("private focus failure"); }, get activeElement() { throw Error("private active failure"); },
    get visibilityState() { throw Error("private visibility failure"); } } as unknown as Document,
  {} as Window, { context: "plugin", editorKind: "plain" });
  expect(unavailable.snapshot()).toMatchObject({ clock: "unavailable", entries: [{ elapsedMs: null,
    activeKind: "unknown", documentHasFocus: "unknown", visibility: "unknown" }] });
  timeline.stop(); unavailable.stop();
});

it.each(["plain", "json"] as const)("%s cleans the timeline and existing listeners even before the first phase", kind => {
  for (const end of ["pagehide", "atools-plugin-out", "explicit"]) {
    const f = install(kind);
    if (end === "explicit") f.api.stop(); else window.dispatchEvent(new Event(end));
    const before = f.api.snapshot();
    f.emit("keydown", document.body);
    expect(f.api.snapshot()).toEqual(before);
    expect(before).toMatchObject({ stopped: true, listenerCount: 0, lifecycleListenerCount: 0,
      timeline: { stopped: true } });
    expect(() => f.api.begin(kind === "plain" ? "alpha" : "valid")).toThrow("PhaseRejected");
  }
});

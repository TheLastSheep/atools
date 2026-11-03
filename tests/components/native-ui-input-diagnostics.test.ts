import { nativeUiInputObservationSource } from "./nativeUiInputTimeline.mjs";
import { afterEach, expect, it, vi } from "vitest";
import plainSource from "./nativePlainTextUiInputObservation.js?raw";
import jsonSource from "./nativeJsonUiInputObservation.js?raw";
import { nativeJsonUiInputConfirmed } from "./nativeOriginalJsonUiInputScenario";

afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });

function install(kind: "plain" | "json") {
  document.body.innerHTML = kind === "plain"
    ? '<div class="cm-editor"><div class="cm-content" contenteditable="true">private document</div></div><button>outside</button>'
    : '<div id="inputEditor"><div class="monaco-editor"><textarea class="inputarea">private document</textarea></div></div><div class="handle"><button>format</button></div>';
  const added = vi.spyOn(document, "addEventListener");
  window.eval(nativeUiInputObservationSource(kind === "plain" ? plainSource : jsonSource));
  const api = (window as any)[kind === "plain" ? "__ATOOLS_NATIVE_PLAIN_TEXT_UI_INPUT__" : "__ATOOLS_NATIVE_JSON_UI_INPUT__"];
  const listeners = new Map(added.mock.calls.filter(call => typeof call[1] === "function")
    .map(call => [String(call[0]), call[1] as EventListener]));
  const editor = document.querySelector(kind === "plain" ? ".cm-content" : "textarea")!;
  const container = document.querySelector(kind === "plain" ? ".cm-editor" : "#inputEditor")!;
  api.begin(kind === "plain" ? "alpha" : "valid");
  return { api, editor, container, emit(type: string, target = editor, values: Record<string, unknown> = {}) {
    listeners.get(type)?.({ type, target, isTrusted: true, key: "private key", data: "private data", ...values } as unknown as Event);
  } };
}

it.each(["plain", "json"] as const)("%s classifies pointer targets and composition without retaining input or arbitrary strings", kind => {
  const fixture = install(kind);
  for (const type of ["pointerdown", "mousedown", "click"]) {
    fixture.emit(type); fixture.emit(type, fixture.container); fixture.emit(type, document.body);
  }
  fixture.emit("compositionstart");
  fixture.emit("beforeinput", fixture.editor, { isComposing: true, inputType: "insertCompositionText" });
  fixture.emit("input", fixture.editor, { isComposing: true, inputType: "private input type" });
  fixture.emit("compositionend");
  fixture.emit("input", fixture.editor, { isComposing: false, inputType: "insertText" });
  const snapshot = fixture.api.snapshot(), record = snapshot.records[kind === "plain" ? "alpha" : "valid"];
  expect(snapshot).toMatchObject({ schemaVersion: 2, listenerCount: 8 });
  expect(record.diagnostics).toMatchObject({ composition: { starts: 1, ends: 1, active: false },
    composingEvents: { yes: 2, no: 1, unknown: 0 }, lastEditingIsComposing: "no",
    inputTypes: { insertCompositionText: 1, insertText: 1, other: 1 },
    targets: { pointerdown: { editor: 1, container: 1, outside: 1 }, mousedown: { editor: 1, container: 1, outside: 1 },
      click: { editor: 1, container: 1, outside: 1 } } });
  expect(JSON.stringify(snapshot)).not.toMatch(/private (document|key|data|input type)/);
  fixture.api.stop();
});

it.each(["plain", "json"] as const)("%s rejects synthetic diagnostic events and snapshots cannot mutate the observer", kind => {
  const fixture = install(kind);
  for (const type of ["pointerdown", "mousedown", "click", "compositionstart", "compositionend", "beforeinput", "input"])
    fixture.emit(type, fixture.editor, { isTrusted: false, isComposing: true, inputType: "insertCompositionText" });
  const phase = kind === "plain" ? "alpha" : "valid", snapshot = fixture.api.snapshot();
  expect(snapshot.records[phase].diagnostics).toMatchObject({ composition: { starts: 0, ends: 0, active: false },
    targets: { pointerdown: { editor: 0 }, mousedown: { editor: 0 }, click: { editor: 0 } } });
  expect(snapshot.records[phase].rejectedUntrusted).toBe(7);
  snapshot.records[phase].diagnostics.targets.pointerdown.editor = 9000;
  expect(fixture.api.snapshot().records[phase].diagnostics.targets.pointerdown.editor).toBe(0);
  fixture.api.stop();
});

it("never accepts a live IME composition merely because trusted editing counters are positive", () => {
  const fixture = install("json");
  fixture.emit("compositionstart");
  for (const type of ["keydown", "beforeinput", "input"]) fixture.emit(type, fixture.editor, { isComposing: true });
  expect(nativeJsonUiInputConfirmed(fixture.api.snapshot(), "valid")).toBe(false);
  fixture.emit("compositionend");
  fixture.emit("input", fixture.editor, { isComposing: false, inputType: "insertText" });
  expect(nativeJsonUiInputConfirmed(fixture.api.snapshot(), "valid")).toBe(true);
  fixture.api.stop();
});

it.each(["plain", "json"] as const)("%s bounds every diagnostic counter and marks overflow rather than accepting it", kind => {
  const fixture = install(kind);
  for (let count = 0; count < 8193; count++) fixture.emit("mousedown", document.body);
  const record = fixture.api.snapshot().records[kind === "plain" ? "alpha" : "valid"];
  expect(record.diagnostics.targets.mousedown.outside).toBe(8192);
  expect(record.overflow).toBe(true);
  fixture.api.stop();
});

it.each(["plain", "json"] as const)("%s ignores held callbacks after stop and removes all new diagnostic listeners", kind => {
  const removed = vi.spyOn(document, "removeEventListener"), fixture = install(kind);
  const phase = kind === "plain" ? "alpha" : "valid", before = fixture.api.snapshot().records[phase];
  fixture.api.stop();
  for (const type of ["pointerdown", "mousedown", "click", "keydown", "beforeinput", "input", "compositionstart", "compositionend"])
    fixture.emit(type, fixture.editor, { isComposing: true, inputType: "insertCompositionText" });
  expect(fixture.api.snapshot().records[phase]).toEqual(before);
  expect(removed.mock.calls.filter(call => call[2] === true).map(call => call[0])).toEqual([
    "pointerdown", "mousedown", "click", "keydown", "beforeinput", "input", "compositionstart", "compositionend"]);
});

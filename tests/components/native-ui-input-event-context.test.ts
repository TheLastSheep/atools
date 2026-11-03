import { nativeUiInputObservationSource } from "./nativeUiInputTimeline.mjs";
import { afterEach, expect, it, vi } from "vitest";
import plainSource from "./nativePlainTextUiInputObservation.js?raw";
import jsonSource from "./nativeJsonUiInputObservation.js?raw";
import { nativeUiInputDiagnosticsValid } from "../../scripts/lib/native-ui-input-diagnostics.mjs";

afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });

function install(kind: "plain" | "json") {
  document.body.innerHTML = kind === "plain"
    ? '<div class="cm-editor"><div class="cm-content" contenteditable="true" tabindex="0"></div></div>'
    : '<div id="inputEditor"><div class="monaco-editor"><textarea class="inputarea"></textarea></div></div>';
  const editor = document.querySelector<HTMLElement>(kind === "plain" ? ".cm-content" : "textarea")!;
  const added = vi.spyOn(document, "addEventListener");
  const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  window.eval(nativeUiInputObservationSource(kind === "plain" ? plainSource : jsonSource));
  const api = (window as any)[kind === "plain" ? "__ATOOLS_NATIVE_PLAIN_TEXT_UI_INPUT__" : "__ATOOLS_NATIVE_JSON_UI_INPUT__"];
  const phase = kind === "plain" ? "alpha" : "valid";
  const listeners = new Map(added.mock.calls.filter(call => typeof call[1] === "function")
    .map(call => [String(call[0]), call[1] as EventListener]));
  api.begin(phase);
  editor.focus();
  return { api, editor, focused, hidden, record: () => api.snapshot().records[phase],
    emit(type: string, trusted = true) {
      listeners.get(type)?.({ type, target: editor, isTrusted: trusted, isComposing: false,
        inputType: "insertText", key: "private key", data: "private text" } as unknown as Event);
    } };
}

it.each(["plain", "json"] as const)("%s retains event-time focus after a later polling-time focus change", kind => {
  const f = install(kind);
  f.emit("beforeinput"); f.emit("input");
  f.focused.mockReturnValue(false);
  f.hidden.mockReturnValue(true);
  f.editor.blur();
  const record = f.record();
  expect(record.diagnostics).toMatchObject({ schemaVersion: 2,
    editingContexts: { visibleFocusedEditor: 2, visibleUnfocusedEditor: 0, visibleOtherFocus: 0, hidden: 0, unknown: 0 },
    lastEditingContext: "visibleFocusedEditor" });
  expect(nativeUiInputDiagnosticsValid(record.diagnostics, record)).toBe(true);
  expect(JSON.stringify(record)).not.toMatch(/private (key|text)/);
  f.api.stop();
});

it.each(["plain", "json"] as const)("%s distinguishes focus, visibility and unavailable observations without inventing focus", kind => {
  const f = install(kind);
  f.focused.mockReturnValue(false); f.emit("beforeinput");
  f.editor.blur(); f.emit("input");
  f.hidden.mockReturnValue(true); f.emit("input");
  f.hidden.mockReturnValue(false);
  f.focused.mockImplementation(() => { throw Error("private failure"); });
  f.emit("input");
  const record = f.record();
  expect(record.diagnostics.editingContexts).toEqual({ visibleFocusedEditor: 0, visibleUnfocusedEditor: 1,
    visibleOtherFocus: 1, hidden: 1, unknown: 1 });
  expect(record.diagnostics.lastEditingContext).toBe("unknown");
  expect(nativeUiInputDiagnosticsValid(record.diagnostics, record)).toBe(true);
  expect(JSON.stringify(record)).not.toContain("private failure");
  f.api.stop();
});

it.each(["plain", "json"] as const)("%s ignores untrusted context and returns detached context counters", kind => {
  const f = install(kind);
  f.emit("input", false);
  const before = f.record();
  expect(before.diagnostics.editingContexts).toEqual({ visibleFocusedEditor: 0, visibleUnfocusedEditor: 0,
    visibleOtherFocus: 0, hidden: 0, unknown: 0 });
  before.diagnostics.editingContexts.visibleFocusedEditor = 8192;
  expect(f.record().diagnostics.editingContexts.visibleFocusedEditor).toBe(0);
  f.api.stop();
  f.emit("input");
  expect(f.record().trustedInputs).toBe(0);
});

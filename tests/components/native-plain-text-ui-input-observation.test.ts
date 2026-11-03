import { nativeUiInputObservationSource } from "./nativeUiInputTimeline.mjs";
import { afterEach, expect, it, vi } from "vitest";
import source from "./nativePlainTextUiInputObservation.js?raw";

afterEach(() => { document.body.innerHTML = ""; delete (window as any).__ATOOLS_NATIVE_PLAIN_TEXT_UI_INPUT__; vi.restoreAllMocks(); });
function install() {
  document.body.innerHTML = '<div class="cm-content" contenteditable="true">fixed visible text</div><button>unrelated control</button>';
  window.eval(nativeUiInputObservationSource(source));
  return (window as any).__ATOOLS_NATIVE_PLAIN_TEXT_UI_INPUT__ as {
    begin(phase: string): void; snapshot(): any; stop(): void;
  };
}
function dispatchUntrusted(type: string, target: EventTarget) {
  target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
}

it("counts only trusted pointer and editing events inside the serialized original contenteditable", () => {
  const added = vi.spyOn(document, "addEventListener"), observer = install();
  const editor = document.querySelector(".cm-content")!, other = document.querySelector("button")!;
  const listeners = new Map(added.mock.calls.filter(call => ["pointerdown", "keydown", "beforeinput", "input"].includes(String(call[0]))
    && typeof call[1] === "function").map(call => [String(call[0]), call[1] as EventListener]));
  observer.begin("alpha");
  for (const type of ["pointerdown", "keydown", "beforeinput", "input"]) dispatchUntrusted(type, editor);
  for (const type of ["pointerdown", "keydown", "beforeinput", "input"]) listeners.get(type)!({ target: other, isTrusted: true, type } as Event);
  for (const type of ["pointerdown", "keydown", "beforeinput", "input"]) listeners.get(type)!({ target: editor, isTrusted: true, type } as Event);
  const state = observer.snapshot();
  expect(state).toMatchObject({ phase: "alpha", stopped: false, listenerCount: 8, lifecycleListenerCount: 2,
    records: { alpha: { trustedEditorPointers: 1, trustedKeydowns: 1, trustedBeforeInputs: 1,
      trustedInputs: 1, rejectedUntrusted: 4, overflow: false } } });
  expect(JSON.stringify(state)).not.toContain("fixed visible text");
  expect(Object.keys(state.records.alpha).sort()).toEqual(["diagnostics", "overflow", "rejectedUntrusted", "trustedBeforeInputs",
    "trustedEditorPointers", "trustedInputs", "trustedKeydowns"].sort());
  observer.stop();
});

it("allows each fixed phase once and keeps observation live from alpha through beta", () => {
  const observer = install(); observer.begin("alpha");
  expect(() => observer.begin("alpha")).toThrow("PhaseRejected");
  expect(observer.snapshot()).toMatchObject({ phase: "alpha", stopped: false, listenerCount: 8 });
  observer.begin("beta");
  expect(() => observer.begin("beta")).toThrow("PhaseRejected");
  expect(observer.snapshot()).toMatchObject({ phase: "beta", stopped: false, listenerCount: 8,
    records: { alpha: expect.any(Object), beta: expect.any(Object) } });
  observer.stop();
});

it.each(["pagehide", "atools-plugin-out"])("%s removes all document and lifecycle listeners", eventName => {
  const remove = vi.spyOn(document, "removeEventListener"), observer = install(); observer.begin("alpha");
  window.dispatchEvent(new Event(eventName));
  expect(observer.snapshot()).toMatchObject({ stopped: true, listenerCount: 0, lifecycleListenerCount: 0 });
  expect(remove.mock.calls.filter(call => call[2] === true).map(call => call[0])).toEqual(["pointerdown", "mousedown", "click", "keydown", "beforeinput", "input", "compositionstart", "compositionend"]);
  observer.stop();
  expect(remove).toHaveBeenCalledTimes(8);
});

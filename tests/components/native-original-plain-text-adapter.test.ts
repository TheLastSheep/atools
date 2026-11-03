import { afterEach, beforeEach, expect, it, vi } from "vitest";
import source from "./nativeOriginalPlainTextFrameOperations.js?raw";
type Adapter = { state(): any; perform(operation: string, envelope?: unknown): any };
let adapter: Adapter;
const envelope = (operation: string) => ({ kind: "atools-published-probe", token: "fixture", id: "request", caseId: "local-plain-text",
  operation, documentNonce: "a".repeat(32), workerLeaseSessions: [] });
beforeEach(() => {
  document.body.innerHTML = '<div class="cm-content" contenteditable="true" tabindex="0"><div class="cm-line">original</div></div><button title="新建文稿"></button><button title="文稿列表"></button><button title="切换 Markdown"></button><button title="导出文件"></button>';
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  vi.spyOn(document.querySelector(".cm-content")!, "getBoundingClientRect").mockReturnValue({ width: 200, height: 100 } as DOMRect);
  Object.defineProperty(document, "execCommand", { configurable: true, writable: true, value: vi.fn(() => true) });
  window.eval(source); adapter = (window as any).__ATOOLS_PUBLISHED_CASE_OPERATIONS__;
});
afterEach(() => { document.body.innerHTML = ""; delete (window as any).__ATOOLS_PUBLISHED_CASE_OPERATIONS__;
  delete (window as any).__ATOOLS_NATIVE_PLAIN_TEXT_UI_INPUT__; vi.restoreAllMocks(); });
it.each([["enter-alpha", "ATools plain alpha document line 1234567890\nAlpha fixed body\nSecond line."],
  ["enter-beta", "# ATools markdown beta document\n\n- first\n- second"]])("%s focuses the real editor and uses only two browser commands", (operation, expected) => {
  const input = vi.fn(), exported = vi.fn(); document.querySelector(".cm-content")!.addEventListener("input", input);
  document.querySelector('[title="导出文件"]')!.addEventListener("click", exported);
  const state = adapter.perform(operation, envelope(operation));
  expect(document.activeElement).toBe(document.querySelector(".cm-content"));
  expect(document.execCommand).toHaveBeenNthCalledWith(1, "selectAll");
  expect(document.execCommand).toHaveBeenNthCalledWith(2, "insertText", false, expected);
  expect(state.editCommandResults).toEqual([{ command: "selectAll", accepted: true }, { command: "insertText", accepted: true }]);
  expect(state.focusAttempt).toMatchObject({ focusCalls: 1, editCommandsBeforeSnapshot: 0,
    immediateAfter: { editorActive: true, documentHasFocus: true, activeElementKind: "editor", editorOwnerDocumentMatches: true, editorRootIsDocument: true } });
  expect(document.querySelector(".cm-line")!.textContent).toBe("original"); expect(input).not.toHaveBeenCalled(); expect(exported).not.toHaveBeenCalled();
});
it("fails closed for focus failure, invisible document or rejected browser commands with no fallback editor write", () => {
  const node = document.querySelector<HTMLElement>(".cm-content")!;
  vi.spyOn(node, "focus").mockImplementation(() => {});
  expect(() => adapter.perform("enter-alpha")).toThrow("focus failed"); expect(document.execCommand).not.toHaveBeenCalled();
  expect(adapter.state().focusAttempt).toMatchObject({ focusCalls: 1, editCommandsBeforeSnapshot: 0,
    immediateAfter: { editorActive: false, documentHasFocus: true, activeElementKind: "body" } });
  vi.mocked(node.focus).mockRestore(); vi.mocked(document.execCommand).mockReturnValue(false);
  expect(() => adapter.perform("enter-alpha")).toThrow("selectAll failed"); expect(document.execCommand).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  expect(() => adapter.perform("enter-alpha")).toThrow("positively visible"); expect(node.textContent).toBe("original");
});
it("separates document focus loss from element focus rejection without replay or editor commands", () => {
  vi.mocked(document.hasFocus).mockReturnValue(false);
  const node = document.querySelector<HTMLElement>(".cm-content")!, focused = vi.spyOn(node, "focus");
  expect(() => adapter.perform("enter-alpha")).toThrow("focus failed");
  expect(adapter.state().focusAttempt).toMatchObject({ focusCalls: 1, editCommandsBeforeSnapshot: 0,
    immediateAfter: { editorActive: true, documentHasFocus: false, activeElementKind: "editor" } });
  expect(focused).toHaveBeenCalledTimes(1); expect(document.execCommand).not.toHaveBeenCalled();
  expect(node.textContent).toBe("original");
});
it("uses exact original controls and draft rows, excluding nested delete and export controls", () => {
  const add = vi.fn(), mode = vi.fn(), list = vi.fn(), selected = vi.fn(), deleted = vi.fn();
  document.querySelector('[title="新建文稿"]')!.addEventListener("click", add); document.querySelector('[title="切换 Markdown"]')!.addEventListener("click", mode);
  document.querySelector('[title="文稿列表"]')!.addEventListener("click", list);
  document.body.insertAdjacentHTML("beforeend", '<div class="editor-drawer"><div class="editor-drawer-item active"><div class="editor-drawer-item-title">ATools plain alpha d</div><span class="editor-drawer-delete">删除</span></div></div>');
  document.querySelector(".editor-drawer-item")!.addEventListener("click", selected); document.querySelector(".editor-drawer-delete")!.addEventListener("click", deleted);
  for (const operation of ["new-draft", "markdown", "open-list", "select-alpha"]) adapter.perform(operation, envelope(operation));
  expect(add).toHaveBeenCalledOnce(); expect(mode).toHaveBeenCalledOnce(); expect(list).toHaveBeenCalledOnce(); expect(selected).toHaveBeenCalledOnce(); expect(deleted).not.toHaveBeenCalled();
  expect(adapter.state()).toMatchObject({ text: "original", drawerOpen: true, drafts: [{ title: "ATools plain alpha d", active: true }] });
});
it("rejects extra payload, other profile, malformed identity, missing/hidden/ambiguous editor and all unreviewed operations", () => {
  for (const value of [null, {}, { ...envelope("enter-alpha"), caseId: "other" }, { ...envelope("enter-alpha"), value: "arbitrary" },
    { ...envelope("enter-alpha"), token: "" }, { ...envelope("enter-alpha"), documentNonce: "bad" }, { ...envelope("enter-alpha"), workerLeaseSessions: ["lease"] }]) {
    expect(() => adapter.perform("enter-alpha", value)).toThrow("Unapproved");
  }
  for (const operation of ["save", "export", "copy", "model", "__proto__", "constructor"]) expect(() => adapter.perform(operation)).toThrow("Unapproved");
  const node = document.querySelector<HTMLElement>(".cm-content")!; node.hidden = true; expect(() => adapter.perform("enter-alpha")).toThrow("unavailable");
  node.hidden = false; node.after(node.cloneNode(true)); expect(() => adapter.perform("enter-alpha")).toThrow("ambiguous");
  expect(document.execCommand).not.toHaveBeenCalled();
});

it("adds only fixed observer phases with an exact envelope and never edits or focuses the original editor", () => {
  const node = document.querySelector<HTMLElement>(".cm-content")!, focused = vi.spyOn(node, "focus");
  const observer = { begin: vi.fn(), stop: vi.fn(), snapshot: vi.fn(() => ({ schemaVersion: 2, phase: "alpha", stopped: false,
    listenerCount: 8, lifecycleListenerCount: 2, records: {} })) };
  (window as any).__ATOOLS_NATIVE_PLAIN_TEXT_UI_INPUT__ = observer;
  expect(() => adapter.perform("native-ui-alpha")).toThrow("Unapproved");
  expect(() => adapter.perform("native-ui-other", envelope("native-ui-other"))).toThrow("Unapproved");
  expect(() => adapter.perform("native-ui-alpha", { ...envelope("native-ui-alpha"), phase: "beta" })).toThrow("Unapproved");
  expect(adapter.perform("native-ui-alpha", envelope("native-ui-alpha"))).toMatchObject({ nativeUiInputObservation: { phase: "alpha" } });
  expect(observer.begin).toHaveBeenCalledOnce(); expect(observer.begin).toHaveBeenCalledWith("alpha");
  adapter.perform("native-ui-beta", envelope("native-ui-beta")); adapter.perform("native-ui-stop", envelope("native-ui-stop"));
  expect(observer.begin).toHaveBeenCalledTimes(2); expect(observer.begin).toHaveBeenNthCalledWith(2, "beta");
  expect(observer.stop).toHaveBeenCalledOnce(); expect(focused).not.toHaveBeenCalled();
  expect(document.execCommand).not.toHaveBeenCalled(); expect(node.textContent).toBe("original");
});

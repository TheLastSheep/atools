import { afterEach, beforeEach, expect, it, vi } from "vitest";
import source from "./nativeOriginalAsciiTreeFrameOperations.js?raw";
type Adapter = { caseId: string; state: () => Record<string, any>; perform: (operation: string, data?: unknown) => Record<string, unknown> };
let adapter: Adapter;
const envelope = (operation = "enter-level-text") => ({ kind: "atools-published-probe", token: "fixture-token", id: "request-1",
  caseId: "local-ascii-tree", operation, documentNonce: "a".repeat(32), workerLeaseSessions: [] });
beforeEach(() => {
  // Synthetic editor controls only. Input listeners are spies, not a replacement tree renderer or storage implementation.
  document.body.innerHTML = '<main><textarea id="text"></textarea><textarea id="tree"></textarea><button id="copy-output">Copy</button><button id="save-output">Save</button></main>';
  window.eval(source); adapter = (window as unknown as { __ATOOLS_PUBLISHED_CASE_OPERATIONS__: Adapter }).__ATOOLS_PUBLISHED_CASE_OPERATIONS__;
});
afterEach(() => { document.body.innerHTML = ""; delete (window as unknown as Record<string, unknown>).__ATOOLS_PUBLISHED_CASE_OPERATIONS__; });

it("reads actual editor values and reports document visibility separately", () => {
  expect(adapter.caseId).toBe("local-ascii-tree");
  document.querySelector<HTMLTextAreaElement>("#text")!.value = "original left";
  document.querySelector<HTMLTextAreaElement>("#tree")!.value = "original right";
  expect(adapter.state()).toMatchObject({ ready: true, input: "original left", output: "original right", documentHidden: document.hidden, visibilityState: document.visibilityState });
});

it.each([
  ["enter-level-text", "#text", "root\n=src\n==index.js"],
  ["enter-tree-text", "#tree", "root\n└── docs\n    └── README.md"],
])("%s dispatches one bubbling DOM input on only the fixed original editor", (operation, selector, expected) => {
  const left = vi.fn(), right = vi.fn(), bubbled = vi.fn(), copy = vi.fn(), save = vi.fn();
  document.querySelector("#text")!.addEventListener("input", left); document.querySelector("#tree")!.addEventListener("input", right);
  document.querySelector("main")!.addEventListener("input", bubbled);
  document.querySelector("#copy-output")!.addEventListener("click", copy); document.querySelector("#save-output")!.addEventListener("click", save);
  adapter.perform(operation, envelope(operation));
  expect(document.querySelector<HTMLTextAreaElement>(selector)!.value).toBe(expected);
  expect(document.activeElement).toBe(document.querySelector(selector)); expect(bubbled).toHaveBeenCalledOnce();
  expect(left).toHaveBeenCalledTimes(selector === "#text" ? 1 : 0); expect(right).toHaveBeenCalledTimes(selector === "#tree" ? 1 : 0);
  expect(copy).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
});

it.each(["render", "save", "copy", "write-file", "__proto__", "constructor"])("rejects unreviewed operation %s", operation => {
  expect(() => adapter.perform(operation, envelope(operation))).toThrow("Unapproved");
});

it("rejects wrong identity and arbitrary input/path fields before editing", () => {
  const valid = envelope(); const listener = vi.fn(); document.querySelector("#text")!.addEventListener("input", listener);
  for (const data of [null, [], {}, { ...valid, token: "" }, { ...valid, id: "" }, { ...valid, caseId: "other" },
    { ...valid, operation: "enter-tree-text" }, { ...valid, documentNonce: "bad" }, { ...valid, workerLeaseSessions: ["worker"] },
    { ...valid, value: "arbitrary" }, { ...valid, path: "/private/secret" }, { ...valid, kind: "other" }]) {
    expect(() => adapter.perform("enter-level-text", data)).toThrow("Unapproved");
  }
  expect(document.querySelector<HTMLTextAreaElement>("#text")!.value).toBe(""); expect(listener).not.toHaveBeenCalled();
});

it("rejects disabled, read-only, hidden, inert and ambiguous targets", () => {
  const node = document.querySelector<HTMLTextAreaElement>("#text")!;
  node.disabled = true; expect(() => adapter.perform("enter-level-text")).toThrow(); node.disabled = false;
  node.readOnly = true; expect(() => adapter.perform("enter-level-text")).toThrow(); node.readOnly = false;
  node.parentElement!.hidden = true; expect(() => adapter.perform("enter-level-text")).toThrow(); node.parentElement!.hidden = false;
  node.parentElement!.setAttribute("inert", ""); expect(() => adapter.perform("enter-level-text")).toThrow(); node.parentElement!.removeAttribute("inert");
  node.parentElement!.style.display = "none"; expect(() => adapter.perform("enter-level-text")).toThrow(); node.parentElement!.style.display = "";
  node.after(node.cloneNode()); expect(() => adapter.perform("enter-level-text")).toThrow(); expect(adapter.state().ready).toBe(false);
});

it("does not mutate either editor during state observations and bounds returned values", () => {
  const node = document.querySelector<HTMLTextAreaElement>("#text")!; node.value = "x".repeat(5000);
  const listener = vi.fn(); node.addEventListener("input", listener);
  expect(adapter.state().input).toHaveLength(4096); expect(node.value).toHaveLength(5000); expect(listener).not.toHaveBeenCalled();
});

import { beforeEach, afterEach, expect, it, vi } from "vitest";
import source from "./nativeOriginalCalculatorFrameOperations.js?raw";
type Adapter = { caseId: string; state: () => Record<string, unknown>; perform: (operation: string, data?: Record<string, unknown>) => unknown };
let adapter: Adapter;
const fixtureWindow = window as unknown as { __ATOOLS_PUBLISHED_ACTIVE_CASE__?: string; __ATOOLS_PUBLISHED_CASE_OPERATIONS__?: Adapter };
beforeEach(() => {
  // Synthetic controls only: these unit tests do not execute the original calculator.
  fixtureWindow.__ATOOLS_PUBLISHED_ACTIVE_CASE__ = "local-my-calculator-zpx";
  document.body.innerHTML = `<div class="calculator"><div class="display-expression">0</div><div class="display-result">0</div>
    <div class="calculator-buttons">${["AC", "1", "+", "2", "=", "9", "÷", "3"].map(label => `<button>${label}</button>`).join("")}</div>
    <button class="clear-history">clear history</button></div>`;
  window.eval(source);
  adapter = (window as unknown as { __ATOOLS_PUBLISHED_CASE_OPERATIONS__: Adapter }).__ATOOLS_PUBLISHED_CASE_OPERATIONS__;
});
afterEach(() => { document.body.innerHTML = ""; delete fixtureWindow.__ATOOLS_PUBLISHED_CASE_OPERATIONS__; delete fixtureWindow.__ATOOLS_PUBLISHED_ACTIVE_CASE__; });

it("reads only rendered fixed-input state and exposes the registered case", () => {
  expect(adapter.caseId).toBe("local-my-calculator-zpx");
  expect(adapter.state()).toMatchObject({ ready: true, expression: "0", result: "0" });
  document.querySelector(".display-result")!.textContent = "3";
  expect(adapter.state().result).toBe("3");
});

it.each([["clear", "AC"], ["one", "1"], ["plus", "+"], ["two", "2"], ["equals", "="], ["nine", "9"], ["divide", "÷"], ["three", "3"]])("%s invokes exactly one original control", (operation, label) => {
  const clicks = [...document.querySelectorAll("button")].map(node => { const click = vi.fn(); node.addEventListener("click", click); return { node, click }; });
  adapter.perform(operation);
  for (const { node, click } of clicks) expect(click).toHaveBeenCalledTimes(node.textContent === label ? 1 : 0);
});

it.each(["__proto__", "constructor", "calculate", "copy", "history"]) ("rejects unreviewed operation %s", operation => {
  expect(() => adapter.perform(operation)).toThrow();
});

it("accepts the exact authenticated envelope forwarded by the shared native frame probe", () => {
  const envelope = { kind: "atools-published-probe", token: "fixture-token", id: "fixture-command-1", caseId: adapter.caseId,
    operation: "one", documentNonce: "a".repeat(32), workerLeaseSessions: [] };
  const node = [...document.querySelectorAll<HTMLButtonElement>("button")].find(n => n.textContent === "1")!;
  const click = vi.fn(); node.addEventListener("click", click);
  adapter.perform("one", envelope); expect(click).toHaveBeenCalledOnce();
  for (const changed of [{ kind: "other" }, { caseId: "other" }, { operation: "two" }, { documentNonce: "bad" },
    { workerLeaseSessions: ["unreviewed"] }, { value: "arbitrary" }, { token: "" }]) {
    expect(() => adapter.perform("one", { ...envelope, ...changed })).toThrow();
  }
  expect(click).toHaveBeenCalledOnce();
});

it("rejects caller-selected input and hidden, disabled or ambiguous controls", () => {
  expect(() => adapter.perform("one", { value: "arbitrary" })).toThrow();
  const node = [...document.querySelectorAll<HTMLButtonElement>("button")].find(n => n.textContent === "1")!;
  node.disabled = true; expect(() => adapter.perform("one")).toThrow(); node.disabled = false;
  node.parentElement!.hidden = true; expect(() => adapter.perform("one")).toThrow(); node.parentElement!.hidden = false;
  node.style.display = "none"; expect(() => adapter.perform("one")).toThrow(); node.style.display = "";
  node.parentElement!.append(node.cloneNode(true)); expect(() => adapter.perform("one")).toThrow();
  expect(adapter.state().ready).toBe(false);
});


it("reuses the same controls only for the fixed converted handoff case", () => {
  fixtureWindow.__ATOOLS_PUBLISHED_ACTIVE_CASE__ = "converted-my-calculator-source";
  expect(adapter.caseId).toBe("converted-my-calculator-source");
  const envelope = { kind: "atools-published-probe", token: "fixture-token", id: "fixture-command-converted",
    caseId: "converted-my-calculator-source", operation: "one", documentNonce: "b".repeat(32), workerLeaseSessions: [] };
  const node = [...document.querySelectorAll<HTMLButtonElement>("button")].find(n => n.textContent === "1")!;
  const click = vi.fn(); node.addEventListener("click", click);
  adapter.perform("one", envelope); expect(click).toHaveBeenCalledOnce();
  fixtureWindow.__ATOOLS_PUBLISHED_ACTIVE_CASE__ = "other-case";
  expect(adapter.caseId).toBeNull();
  expect(() => adapter.perform("one", { ...envelope, caseId: "other-case" })).toThrow();
  expect(click).toHaveBeenCalledOnce();
});

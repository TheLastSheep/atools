import { afterEach, beforeEach, expect, it, vi } from "vitest";
import source from "./nativeOriginalMybatisFrameOperations.js?raw";
type Adapter = { caseId: string | null; state: () => Record<string, unknown>; perform: (operation: string, data?: Record<string, unknown>) => unknown };
const fixtureWindow = window as unknown as { __ATOOLS_PUBLISHED_ACTIVE_CASE__?: string; __ATOOLS_PUBLISHED_CASE_OPERATIONS__?: Adapter };
let adapter: Adapter;
const caseId = "local-mybatis-sql-formatter-head";
const envelope = (operation: string) => ({ kind: "atools-published-probe", token: "fixture-token", id: "probe-1", caseId,
  operation, documentNonce: "a".repeat(32), workerLeaseSessions: [] });
beforeEach(() => {
  fixtureWindow.__ATOOLS_PUBLISHED_ACTIVE_CASE__ = caseId;
  document.body.innerHTML = `<div class="header-actions"><button class="btn-ghost">清空</button><button class="btn-primary">格式化</button></div>
    <textarea id="input"></textarea><textarea id="output" readonly></textarea><div id="errorMsg" style="display:none"></div><div id="infoBar"></div>`;
  window.eval(source);
  adapter = (window as unknown as { __ATOOLS_PUBLISHED_CASE_OPERATIONS__: Adapter }).__ATOOLS_PUBLISHED_CASE_OPERATIONS__;
});
afterEach(() => { document.body.innerHTML = ""; delete fixtureWindow.__ATOOLS_PUBLISHED_CASE_OPERATIONS__; delete fixtureWindow.__ATOOLS_PUBLISHED_ACTIVE_CASE__; });

it("sets only the fixed sample log and clicks the original header controls", () => {
  const input = document.querySelector<HTMLTextAreaElement>("#input")!;
  const inputEvent = vi.fn(); input.addEventListener("input", inputEvent);
  const format = document.querySelector<HTMLButtonElement>(".header-actions .btn-primary")!;
  const clear = document.querySelector<HTMLButtonElement>(".header-actions .btn-ghost")!;
  const formatClick = vi.fn(); const clearClick = vi.fn(); format.addEventListener("click", formatClick); clear.addEventListener("click", clearClick);
  expect(adapter.caseId).toBe(caseId); expect(adapter.state().ready).toBe(true);
  adapter.perform("valid-input", envelope("valid-input")); expect(input.value).toContain("Preparing: SELECT * FROM user"); expect(inputEvent).toHaveBeenCalledOnce();
  adapter.perform("format", envelope("format")); expect(formatClick).toHaveBeenCalledOnce();
  adapter.perform("invalid-input", envelope("invalid-input")); expect(input.value).toContain("Parameters: invalid(Integer)");
  adapter.perform("clear", envelope("clear")); expect(clearClick).toHaveBeenCalledOnce();
});

it("sets the fixed quote/null/three-parameter edge log before the original format click", () => {
  const input = document.querySelector<HTMLTextAreaElement>("#input")!;
  const inputEvent = vi.fn(); input.addEventListener("input", inputEvent);
  const format = document.querySelector<HTMLButtonElement>(".header-actions .btn-primary")!;
  const formatClick = vi.fn(); format.addEventListener("click", formatClick);
  adapter.perform("edge-input", envelope("edge-input"));
  expect(input.value).toBe("[DEBUG] - ==>  Preparing: SELECT * FROM user WHERE name = ? AND note = ? AND id = ?\n[DEBUG] - ==> Parameters: O'Neil(String), null, 7(Integer)");
  expect(inputEvent).toHaveBeenCalledOnce();
  adapter.perform("format", envelope("format"));
  expect(formatClick).toHaveBeenCalledOnce();
});

it("rejects unknown cases, unauthenticated envelopes, and unavailable or ambiguous controls", () => {
  expect(() => adapter.perform("copy")).toThrow();
  expect(() => adapter.perform("format", { ...envelope("format"), token: "" })).toThrow();
  expect(() => adapter.perform("format", { ...envelope("format"), operation: "clear" })).toThrow();
  expect(() => adapter.perform("format", { ...envelope("format"), extra: true })).toThrow();
  const button = document.querySelector<HTMLButtonElement>(".header-actions .btn-primary")!;
  button.disabled = true; expect(() => adapter.perform("format", envelope("format"))).toThrow(); button.disabled = false;
  button.parentElement!.append(button.cloneNode(true)); expect(() => adapter.perform("format", envelope("format"))).toThrow();
  fixtureWindow.__ATOOLS_PUBLISHED_ACTIVE_CASE__ = "another-case";
  expect(adapter.caseId).toBeNull(); expect(() => adapter.perform("format", envelope("format"))).toThrow();
});

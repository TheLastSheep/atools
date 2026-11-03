import { afterEach, beforeEach, expect, it, vi } from "vitest";
import source from "./nativeOriginalRandomDataFrameOperations.js?raw";
type Adapter = { caseId: string | null; state: () => Record<string, unknown>; perform: (operation: string, data?: unknown) => Record<string, unknown> };
const caseId = "local-random-data-head";
const host = window as unknown as { __ATOOLS_PUBLISHED_ACTIVE_CASE__?: string; __ATOOLS_PUBLISHED_CASE_OPERATIONS__?: Adapter };
const envelope = (operation: string) => ({ kind: "atools-published-probe", token: "fixture-token", id: "probe-1", caseId,
  operation, documentNonce: "a".repeat(32), workerLeaseSessions: [] });
let adapter: Adapter;

beforeEach(() => {
  host.__ATOOLS_PUBLISHED_ACTIVE_CASE__ = caseId;
  document.body.innerHTML = `<main><section class="item" data-code="randomUuid"><label><input data-action="enabled" type="checkbox" checked></label>
    <div class="command-stack"><div class="command-chip"><span>uuid</span></div><input class="chip-input" data-action="add-command"></div>
    <button class="preview-button" data-action="sample">生成数据</button><div class="preview-box"><pre></pre><button data-action="copy-preview">复制</button></div></section>
    <button id="saveButton">已自动保存</button></main>`;
  window.eval(source);
  adapter = (window as unknown as { __ATOOLS_PUBLISHED_CASE_OPERATIONS__: Adapter }).__ATOOLS_PUBLISHED_CASE_OPERATIONS__;
});
afterEach(() => { document.body.innerHTML = ""; delete host.__ATOOLS_PUBLISHED_CASE_OPERATIONS__; delete host.__ATOOLS_PUBLISHED_ACTIVE_CASE__; });

it("observes the original UUID row and clicks only its sample button", () => {
  expect(adapter.caseId).toBe(caseId); expect(adapter.state()).toMatchObject({ ready: true, enabled: true, commands: ["uuid"] });
  const sample = document.querySelector<HTMLButtonElement>('[data-code="randomUuid"] [data-action="sample"]')!;
  const copy = document.querySelector<HTMLButtonElement>('[data-action="copy-preview"]')!;
  const sampleClick = vi.fn(), copyClick = vi.fn(); sample.addEventListener("click", sampleClick); copy.addEventListener("click", copyClick);
  adapter.perform("sample", envelope("sample"));
  expect(sampleClick).toHaveBeenCalledOnce(); expect(copyClick).not.toHaveBeenCalled();
  expect(adapter.state().preview).toBe("");
});

it("sends the fixed command through the original chip input Enter handler only", () => {
  const input = document.querySelector<HTMLInputElement>(".chip-input")!, listener = vi.fn(); input.addEventListener("keydown", listener);
  const clipboard = vi.fn(); document.querySelector('[data-action="copy-preview"]')!.addEventListener("click", clipboard);
  const result = adapter.perform("add-command", envelope("add-command"));
  expect(input.value).toBe("ATools Random UUID Acceptance");
  expect(listener).toHaveBeenCalledOnce(); expect(listener.mock.calls[0][0]).toMatchObject({ key: "Enter", bubbles: true });
  expect(result.input).toBe("ATools Random UUID Acceptance"); expect(clipboard).not.toHaveBeenCalled();
});

it("rejects wrong case, operation, envelope extensions and ambiguous controls", () => {
  const input = document.querySelector<HTMLInputElement>(".chip-input")!, listener = vi.fn(); input.addEventListener("keydown", listener);
  for (const value of [null, {}, { ...envelope("add-command"), extra: true }, { ...envelope("add-command"), caseId: "other" },
    { ...envelope("add-command"), operation: "copy" }, { ...envelope("add-command"), workerLeaseSessions: ["worker"] }]) {
    expect(() => adapter.perform("add-command", value)).toThrow("Unapproved");
  }
  expect(listener).not.toHaveBeenCalled(); host.__ATOOLS_PUBLISHED_ACTIVE_CASE__ = "other";
  expect(adapter.caseId).toBeNull(); expect(() => adapter.perform("sample", envelope("sample"))).toThrow("Unapproved");
  host.__ATOOLS_PUBLISHED_ACTIVE_CASE__ = caseId;
  document.querySelector('[data-code="randomUuid"]')!.append(document.querySelector('[data-action="sample"]')!.cloneNode(true));
  expect(() => adapter.perform("sample", envelope("sample"))).toThrow("ambiguous");
});

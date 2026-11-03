import { afterEach, beforeEach, expect, it, vi } from "vitest";
import source from "./nativeOriginalUuidFrameOperations.js?raw";
type Adapter = { caseId: string; state: () => Record<string, any>; perform: (operation: string, data?: unknown) => Record<string, unknown> };
let adapter: Adapter;
const envelope = (operation = "inspect-result") => ({ kind: "atools-published-probe", token: "fixture-token", id: "request-1",
  caseId: "local-uuid-kit", operation, documentNonce: "a".repeat(32), workerLeaseSessions: [] });
beforeEach(() => {
  // Synthetic original-shaped DOM only; no original UUID script or host bridge executes in this unit test.
  document.body.innerHTML = `<span id="badge">生成 UUIDv5（确定性）</span><div id="meta">命名空间 dns</div>
    <div id="selftest-fail"></div><input id="input" value="uuid5 dns example.com"><div id="out">
    <div class="row"><span class="label">标准 UUID</span><span class="value">cfbff0d1-9375-5685-968c-48ce8b15ae17</span></div>
    <div class="row action">regenerate</div></div>`;
  window.eval(source); adapter = (window as unknown as { __ATOOLS_PUBLISHED_CASE_OPERATIONS__: Adapter }).__ATOOLS_PUBLISHED_CASE_OPERATIONS__;
});
afterEach(() => { document.body.innerHTML = ""; delete (window as unknown as Record<string, unknown>).__ATOOLS_PUBLISHED_CASE_OPERATIONS__; });

it("reads only the original rendered input, badge, self-test and encoding rows", () => {
  expect(adapter.caseId).toBe("local-uuid-kit");
  expect(adapter.state()).toMatchObject({ ready: true, input: "uuid5 dns example.com", badge: "生成 UUIDv5（确定性）", selftestError: "",
    rows: [{ label: "标准 UUID", value: "cfbff0d1-9375-5685-968c-48ce8b15ae17" }] });
  document.querySelector("#selftest-fail")!.textContent = "自检失败";
  expect(adapter.state().selftestError).toBe("自检失败");
  document.querySelector("#out")!.innerHTML = '<div class="error">bad input</div>';
  expect(adapter.state()).toMatchObject({ error: "bad input", rows: [] });
});

it("accepts the exact shared frame-probe identity envelope while remaining read-only", () => {
  const input = document.querySelector<HTMLInputElement>("#input")!, listener = vi.fn(); input.addEventListener("input", listener);
  const before = document.body.innerHTML;
  expect(adapter.perform("inspect-result", envelope())).toMatchObject({ ready: true });
  expect(document.body.innerHTML).toBe(before); expect(listener).not.toHaveBeenCalled();
});

it.each(["input", "copy", "generate", "run", "__proto__", "constructor"])("rejects unreviewed operation %s", operation => {
  expect(() => adapter.perform(operation, envelope(operation))).toThrow("Unapproved");
});

it("rejects wrong, missing or extended transport fields and caller-selected payloads", () => {
  const valid = envelope();
  for (const data of [null, [], {}, { ...valid, token: "" }, { ...valid, id: "" }, { ...valid, caseId: "other" },
    { ...valid, operation: "copy" }, { ...valid, documentNonce: "invalid" }, { ...valid, workerLeaseSessions: ["worker"] },
    { ...valid, text: "arbitrary" }, { ...valid, kind: "other" }]) expect(() => adapter.perform("inspect-result", data)).toThrow("Unapproved");
  const missing = { ...valid } as Record<string, unknown>; delete missing.documentNonce;
  expect(() => adapter.perform("inspect-result", missing)).toThrow("Unapproved");
});

it("bounds observation sizes and rejects ambiguous mandatory DOM identity", () => {
  document.querySelector<HTMLInputElement>("#input")!.value = "x".repeat(1000);
  document.querySelector("#meta")!.textContent = "x".repeat(1000);
  expect(adapter.state().input).toHaveLength(256); expect(adapter.state().meta).toHaveLength(256);
  document.body.append(document.querySelector("#input")!.cloneNode()); expect(adapter.state().ready).toBe(false);
});

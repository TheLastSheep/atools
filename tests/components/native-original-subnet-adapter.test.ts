import { afterEach, beforeEach, expect, it, vi } from "vitest";
import source from "./nativeOriginalSubnetFrameOperations.js?raw";
type Adapter = { state(): any; perform(operation: string, envelope?: unknown): any };
let adapter: Adapter;
const envelope = (operation: string) => ({ kind: "atools-published-probe", token: "fixture", id: "request", caseId: "local-subnet-calculator",
  operation, documentNonce: "a".repeat(32), workerLeaseSessions: [] });
beforeEach(() => {
  document.body.innerHTML = '<div class="tabs"><div class="tab">子网计算</div><div class="tab">子网逆算</div></div><div id="calcSection"><input id="ipInput"><input id="maskInput"><button>计算</button></div><div id="reverseSection"><input id="hostCountInput" type="number"><input id="startIpInput"><button>逆算</button></div><div id="resultArea"></div>';
  window.eval(source); adapter = (window as any).__ATOOLS_PUBLISHED_CASE_OPERATIONS__;
});
afterEach(() => { document.body.innerHTML = ""; delete (window as any).__ATOOLS_PUBLISHED_CASE_OPERATIONS__; });
it.each([["calculate-24", "192.168.1.100", "/24"], ["calculate-31", "10.0.0.1", "/31"],
  ["calculate-32", "10.0.0.1", "/32"], ["invalid-mask", "192.168.1.100", "255.0.255.0"]])("%s sends only fixed DOM input events and one original button click", (operation, ip, mask) => {
  const click = vi.fn(), input = vi.fn(); document.querySelector("#calcSection button")!.addEventListener("click", click);
  document.querySelector("#calcSection")!.addEventListener("input", input);
  expect(adapter.perform(operation, envelope(operation))).toMatchObject({ ip, mask }); expect(input).toHaveBeenCalledTimes(2); expect(click).toHaveBeenCalledOnce();
});
it("selects the exact original reverse tab and enters host 30/zero through its original button", () => {
  const tab = vi.fn(), button = vi.fn(); document.querySelectorAll(".tab")[1].addEventListener("click", tab);
  document.querySelector("#reverseSection button")!.addEventListener("click", button);
  adapter.perform("reverse-tab", envelope("reverse-tab")); expect(tab).toHaveBeenCalledOnce();
  expect(adapter.perform("reverse-30", envelope("reverse-30"))).toMatchObject({ hostCount: "30", startIp: "192.168.1.100" });
  expect(adapter.perform("reverse-zero", envelope("reverse-zero"))).toMatchObject({ hostCount: "0", startIp: "192.168.1.100" }); expect(button).toHaveBeenCalledTimes(2);
});
it("reads labeled results without clicking them or invoking a calculator function", () => {
  document.querySelector("#resultArea")!.innerHTML = '<div class="result-row"><span class="result-label">网络地址</span><span class="result-value">192.168.1.0</span></div>';
  const copied = vi.fn(); document.querySelector(".result-value")!.addEventListener("click", copied);
  expect(adapter.state().rows).toEqual([{ label: "网络地址", value: "192.168.1.0" }]); expect(copied).not.toHaveBeenCalled();
});
it("rejects arbitrary inputs, wrong identity, unknown operation and unavailable controls before mutation", () => {
  for (const data of [null, {}, { ...envelope("calculate-24"), value: "1.1.1.1" }, { ...envelope("calculate-24"), caseId: "other" },
    { ...envelope("calculate-24"), operation: "reverse-30" }, { ...envelope("calculate-24"), workerLeaseSessions: ["lease"] }]) {
    expect(() => adapter.perform("calculate-24", data)).toThrow("Unapproved");
  }
  for (const operation of ["calculate", "copy", "render", "__proto__", "constructor"]) expect(() => adapter.perform(operation)).toThrow("Unapproved");
  const node = document.querySelector<HTMLInputElement>("#ipInput")!; node.readOnly = true; expect(() => adapter.perform("calculate-24")).toThrow("unavailable");
  node.readOnly = false; node.after(node.cloneNode()); expect(() => adapter.perform("calculate-24")).toThrow("ambiguous"); expect(node.value).toBe("");
});

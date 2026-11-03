import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginMainPushBridge } from "../../src/lib/pluginMainPushBridge";
import { createPluginMainPushBudget } from "../../src/lib/pluginMainPushBudget";
import { createPluginMainPushPresentation, pluginMainPushPresentationDenied } from "../../src/lib/pluginMainPushPresentation";

function fixture() {
  const target = document.createElement("iframe"); document.body.append(target);
  const frame = target.contentWindow!;
  const messages: Record<string, any>[] = [], entered: unknown[] = [];
  Object.defineProperty(frame, "__ATOOLS_FRAME_TRANSPORT__", { value: { post: (message: Record<string, unknown>) => messages.push(message), accept: () => true } });
  const config = { runnerId: "runner", nonce: "nonce", epoch: 7, featureCode: "feature", parentOrigin: window.origin, queryOnly: true };
  const bridge = createPluginMainPushBridge(frame, config);
  frame.addEventListener("atools-main-push-promote", event => entered.push((event as CustomEvent).detail));
  function send(data: Record<string, unknown>, other: Record<string, unknown> = {}) {
    frame.dispatchEvent(new MessageEvent("message", { source: frame.parent, origin: window.origin,
      data: { __atools_main_push_command__: true, ...config, ...data }, ...other }));
  }
  const query = (extra: Record<string, unknown> = {}) => send({ command: "query", requestId: "q", generation: 1, type: "over", payload: "  原文 😀 café　尾部  ", ...extra });
  const select = (extra: Record<string, unknown> = {}) => send({ command: "select", requestId: "s", queryId: "q", generation: 1, handle: messages.at(-1)?.rows?.[0]?.handle, ...extra });
  return { frame, bridge, messages, entered, send, query, select };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe("actual serialized MainPush bridge contract", () => {
  it.each(["array", "list", "promise"])("awaits %s and retains raw option identity without exposing it", async shape => {
    const f = fixture(), option = { text: "Result", title: "Detail", browser: "edge", url: "https://example.invalid/fixed", custom: { n: 42 } };
    const callback = vi.fn(() => shape === "array" ? [option] : shape === "list" ? { type: "list", data: [option] } : Promise.resolve({ type: "list", data: [option] }));
    const selected = vi.fn(() => undefined);
    f.bridge.register(callback, selected); f.bridge.boot(); f.query(); await settle();
    expect(callback).toHaveBeenCalledWith({ code: "feature", type: "over", payload: "  原文 😀 café　尾部  ", from: "main" });
    expect(f.messages.at(-1)?.rows).toEqual([{ handle: "q:0", text: "Result", description: "Detail", icon: "", highlight: true }]);
    expect(JSON.stringify(f.messages)).not.toContain("example.invalid");
    f.select(); await settle();
    expect(selected).toHaveBeenCalledTimes(1); expect(selected.mock.calls[0][0].option).toBe(option);
    expect(f.messages.at(-1)?.outcome).toBe("handled");
    f.select({ handle: "q:0" }); await settle(); expect(selected).toHaveBeenCalledTimes(1);
    f.bridge.dispose();
  });
  it.each([true, false, undefined, 1, "true", {}])("only literal true asks for entry: %s", async returned => {
    const f = fixture(); f.bridge.register(() => [{ text: "Fixed" }], () => returned); f.query(); await settle(); f.select(); await settle();
    expect(f.messages.at(-1)?.outcome).toBe(returned === true ? "enter" : "handled"); expect(f.entered).toEqual([]);
    f.bridge.dispose();
  });
  it("promotes the same live closure once with originating option and no synthetic entry during query", async () => {
    const f = fixture(); let closure = 0;
    const option = { text: "Fixed", _pending: "original state" };
    f.bridge.register(() => [option], () => { closure++; return true; }); f.bridge.boot();
    f.query(); await settle(); expect(f.entered).toEqual([]); f.select(); await settle();
    f.send({ command: "promote", queryId: "q", handle: "q:0" });
    f.send({ command: "promote", queryId: "q", handle: "q:0" });
    expect(closure).toBe(1); expect(f.entered).toHaveLength(1);
    expect((f.entered[0] as any).option).toBe(option);
    expect(f.entered[0]).toMatchObject({ code: "feature", type: "over", payload: "  原文 😀 café　尾部  ", from: "main" });
    f.bridge.dispose();
  });
  it("empty and exceptions clear old options, errors never include query or exception text", async () => {
    const f = fixture(); let result: unknown = [{ text: "first" }];
    f.bridge.register(() => { if (result === "throw") throw Error("SECRET original text"); return result; }, () => true);
    f.query(); await settle(); result = undefined; f.query({ requestId: "q2", generation: 2 }); await settle();
    expect(f.messages.at(-1)).toMatchObject({ outcome: "empty", rows: [] });
    f.select({ queryId: "q", handle: "q:0" }); await settle(); expect(f.messages.at(-1)?.outcome).toBe("superseded");
    result = "throw"; f.query({ requestId: "q3", generation: 3 }); await settle();
    expect(f.messages.at(-1)).toMatchObject({ outcome: "failed", error: "ERR_MAIN_PUSH_QUERY" });
    expect(JSON.stringify(f.messages)).not.toContain("SECRET"); f.bridge.dispose();
  });
  it("drops late async completion after cancel and rejects source/origin/nonce/epoch forgery", async () => {
    const f = fixture(); let finish!: (value: unknown) => void;
    const callback = vi.fn(() => new Promise(resolve => { finish = resolve; })); f.bridge.register(callback, () => true);
    for (const extra of [{ nonce: "wrong" }, { epoch: 8 }, { runnerId: "other" }]) f.query(extra);
    f.send({ command: "query", requestId: "fake", generation: 1, type: "text", payload: "x" }, { origin: "https://example.invalid" });
    f.send({ command: "query", requestId: "fake", generation: 1, type: "text", payload: "x" }, { source: f.frame });
    expect(callback).not.toHaveBeenCalled(); f.query(); f.send({ command: "cancel" }); finish([{ text: "stale" }]); await settle();
    expect(f.messages.some(value => value.rows)).toBe(false); f.bridge.dispose();
  });
  it("bounds rows, options, getters and cyclic data before retaining results", async () => {
    const f = fixture(); let result: unknown = Array.from({ length: 25 }, (_, n) => ({ text: String(n) }));
    f.bridge.register(() => result, null); f.query(); await settle(); expect(f.messages.at(-1)?.rows).toHaveLength(20);
    const getter = vi.fn(); result = [{ text: "x", get url() { getter(); return "x"; } }];
    f.query({ requestId: "q2" }); await settle(); expect(f.messages.at(-1)?.outcome).toBe("failed"); expect(getter).not.toHaveBeenCalled();
    result = [{ text: "x", huge: "x".repeat(16385) }]; f.query({ requestId: "q3" }); await settle(); expect(f.messages.at(-1)?.outcome).toBe("failed");
    const cycle: any = { text: "x" }; cycle.self = cycle; result = [cycle]; f.query({ requestId: "q4" }); await settle(); expect(f.messages.at(-1)?.outcome).toBe("failed");
    f.bridge.dispose();
  });
  it.each(["map", "set", "nonenumerable", "array-extra", "symbol", "custom-prototype"])("rejects non-JSON %s payloads before retaining raw options", async shape => {
    const f = fixture(), blob = "x".repeat(16385); const option: Record<string, unknown> = { text: "Fixed" };
    if (shape === "map") option.hidden = new Map([["blob", blob]]);
    if (shape === "set") option.hidden = new Set([blob]);
    if (shape === "nonenumerable") Object.defineProperty(option, "hidden", { value: blob });
    if (shape === "array-extra") { const array: any = [1]; array.hidden = blob; option.hidden = array; }
    if (shape === "symbol") Object.defineProperty(option, Symbol("hidden"), { value: blob });
    if (shape === "custom-prototype") option.hidden = Object.create({ blob });
    const selected = vi.fn(); f.bridge.register(() => [option], selected); f.query(); await settle();
    expect(f.messages.at(-1)?.outcome).toBe("failed"); expect(f.messages.at(-1)?.rows).toBeUndefined();
    f.select({ handle: "q:0" }); await settle(); expect(selected).not.toHaveBeenCalled(); f.bridge.dispose();
  });
  it("retains valid plain and dense-array option identity under the logical byte budget", async () => {
    const f = fixture(), array = [1, { key: "value" }, null], option = Object.assign(Object.create(null), { text: "Fixed", array });
    const selected = vi.fn(() => undefined); f.bridge.register(() => [option], selected); f.query(); await settle(); f.select(); await settle();
    expect(selected.mock.calls[0][0].option).toBe(option); expect((selected.mock.calls[0][0].option as any).array).toBe(array); f.bridge.dispose();
  });
});

describe("query presentation and bounded metadata", () => {
  it("focus before callback registration is passive; explicit selection can use original focus", () => {
    const frame = document.createElement("iframe"); document.body.append(frame); const target = frame.contentWindow!;
    const windowFocus = vi.spyOn(target, "focus").mockImplementation(() => undefined);
    const adapter = createPluginMainPushPresentation(target);
    expect(() => target.focus()).not.toThrow(); expect(windowFocus).not.toHaveBeenCalled();
    const input = target.document.createElement("input"); target.document.body.append(input); input.focus(); expect(target.document.activeElement).not.toBe(input);
    expect(() => target.open("https://example.invalid")).toThrow("Main search cannot open windows");
    adapter.setMode("select"); target.focus(); expect(windowFocus).toHaveBeenCalledOnce();
    adapter.setMode("visible"); expect(target.focus).toBe(windowFocus); adapter.dispose();
  });
  it("all host presentation channels are denied only during boot/query", () => {
    for (const message of [{ __ipc_main_window__: true }, { __ipc_detach_plugin__: true }, { __ipc_plugin_height__: true },
      { __atools_native_call__: true, method: "redirect" }, { __ipc_call__: true, command: "shell_open" }]) {
      expect(pluginMainPushPresentationDenied("query", message)).toBe(true);
      expect(pluginMainPushPresentationDenied("select", message)).toBe(false);
    }
    expect(pluginMainPushPresentationDenied("query", { __ipc_dynamic_feature__: true })).toBe(false);
  });
  it("rejects whole envelopes and deeply nested data without custom serialization", () => {
    const budget = createPluginMainPushBudget(), serialize = vi.fn(() => "x");
    expect(() => budget.assert({ text: "x".repeat(262144) })).toThrow("ERR_MAIN_PUSH_BYTES");
    expect(() => budget.assert({ toJSON: serialize })).toThrow("ERR_MAIN_PUSH_JSON"); expect(serialize).not.toHaveBeenCalled();
    let deep: any = {}; for (let i = 0; i < 20; i++) deep = { deep };
    expect(() => budget.assert(deep)).toThrow("ERR_MAIN_PUSH_COMPLEXITY");
  });
});

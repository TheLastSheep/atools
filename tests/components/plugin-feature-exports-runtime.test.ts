// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { exportsFixture } from "./plugin-feature-exports-fixture";

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
describe("serialized selected-feature exports runtime", () => {
  it("enters list exactly once without generic enter/ready; raw item identity and action survive selection", async () => {
    const f = exportsFixture(), generic = vi.fn(), ready = vi.fn(), item = { title: "<img onerror=x>", custom: { secret: [3] }, url: "https://fixture.invalid" };
    f.target.addEventListener("atools-plugin-enter", generic); f.target.addEventListener("atools-plugin-ready", ready);
    const select = vi.fn(); let passed: unknown;
    f.target.exports.case = { mode: "list", args: { enter: (action: unknown, cb: (items: unknown[]) => void) => { passed = action; cb([item]); return [{ title: "ignored" }]; }, select } };
    const action = { code: "case", type: "regex", payload: " fixed payload ", inputState: { exact: true } };
    f.bridge.start(action); f.bridge.start(action); await flush();
    expect(f.latestRows()[0].title).toBe(item.title); expect(passed).toBe(action);
    expect(f.latestRows()[0]).not.toHaveProperty("custom"); f.command(); await flush();
    expect(select).toHaveBeenCalledTimes(1); expect(select.mock.calls[0][0]).toBe(action); expect(select.mock.calls[0][1]).toBe(item);
    expect(generic).not.toHaveBeenCalled(); expect(ready).not.toHaveBeenCalled(); expect(f.timers).toHaveLength(0);
  });
  it("awaits none entry, exposes async failure and never emits generic lifecycle", async () => {
    const f = exportsFixture(), generic = vi.fn(); f.target.addEventListener("atools-plugin-enter", generic);
    let reject!: (error: Error) => void;
    const enter = vi.fn(() => new Promise((_, fail) => { reject = fail; }));
    f.target.exports.case = { mode: "none", args: { enter } }; f.bridge.start({ code: "case", type: "over", payload: "hello" });
    expect(f.messages.at(-1)?.busy).toBe(true); reject(Error("fixed failure")); await flush();
    expect(f.messages.at(-1)?.error).toContain("fixed failure"); expect(generic).not.toHaveBeenCalled(); expect(enter).toHaveBeenCalledTimes(1);
  });
  it("ordinary missing/unsupported/inherited exports preserve generic lifecycle once", () => {
    for (const exports of [{}, { case: { mode: "custom" } }, Object.create({ case: { mode: "none", args: {} } })]) {
      const f = exportsFixture(), generic = vi.fn(), ready = vi.fn(); f.target.exports = exports;
      f.target.addEventListener("atools-plugin-enter", generic); f.target.addEventListener("atools-plugin-ready", ready);
      f.bridge.start({ code: "case", payload: "exact" }); f.bridge.start({ code: "case" }); f.timers.forEach(callback => callback());
      expect(generic).toHaveBeenCalledTimes(1); expect(ready).toHaveBeenCalledTimes(1); expect(f.messages).toEqual([]);
    }
  });
  it("only latest enter/search/select callback can update the active list", async () => {
    const f = exportsFixture(), callbacks: ((items: unknown[]) => void)[] = [];
    f.target.exports.case = { mode: "list", args: { enter: (_: unknown, cb: typeof callbacks[0]) => callbacks.push(cb),
      search: (_: unknown, _text: string, cb: typeof callbacks[0]) => callbacks.push(cb), select: (_: unknown, _item: unknown, cb: typeof callbacks[0]) => callbacks.push(cb) } };
    f.bridge.start({ code: "case" }); f.search("a"); f.search("b"); callbacks[0]([{ title: "stale enter" }]); callbacks[1]([{ title: "stale search" }]);
    expect(f.latestRows()).toEqual([]); callbacks[2]([{ title: "current" }]); f.command(); await flush();
    callbacks[2]([{ title: "stale after select" }]); callbacks[3]([{ title: "selected update" }]); expect(f.latestRows()[0].title).toBe("selected update");
    f.dispatch("pagehide"); callbacks[3]([{ title: "closed" }]); expect(f.latestRows()[0].title).toBe("selected update");
    expect([...f.handlers.values()].every(handlers => handlers.size === 0)).toBe(true);
  });
  it("rejects stale epochs/revisions/transport sources and bounds concurrent async selection", async () => {
    const f = exportsFixture(); let finish!: () => void; const select = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    f.target.exports.case = { mode: "list", args: { enter: (_: unknown, cb: (items: unknown[]) => void) => cb([{ title: "one" }]), select } };
    f.bridge.start({ code: "case" }); f.command(0, { epoch: 6 }); f.command(0, { revision: -1 }); f.command(0, { entry: 4 });
    const latest = f.messages.at(-1)!;
    f.dispatch("message", { source: {}, data: { __atools_feature_exports_command__: true, epoch: 7, entry: latest.entry, revision: latest.revision, command: "select", index: 0 } });
    expect(select).not.toHaveBeenCalled(); f.command(); f.command(); expect(select).toHaveBeenCalledTimes(1); finish(); await flush();
    expect(f.messages.at(-1)?.busy).toBe(false);
  });
  it("surfaces malformed list count/bytes/cycle and callback throws without accepting fake success", async () => {
    for (const result of [new Array(2001).fill({ title: "a" }), [{ title: "x".repeat(1048577) }], [{ title: 3 }], (() => { const x: any = {}; x.self = x; return [x]; })()]) {
      const f = exportsFixture(); f.target.exports.case = { mode: "list", args: { enter: (_: unknown, cb: (value: unknown) => void) => cb(result) } };
      f.bridge.start({ code: "case" }); await flush(); expect(f.messages.at(-1)?.error).toBeTruthy(); expect(f.latestRows()).toEqual([]);
    }
    const f = exportsFixture(); f.target.exports.case = { mode: "list", args: { enter: () => { throw Error("enter failed"); } } };
    f.bridge.start({ code: "case" }); await flush(); expect(f.messages.at(-1)?.error).toContain("enter failed");
  });
  it("frame keys are bounded intents and IME/editor/modifiers keep their own keys", () => {
    const f = exportsFixture(); f.target.exports.case = { mode: "list", args: {} }; f.bridge.start({ code: "case" });
    for (const key of ["ArrowUp", "ArrowDown", "Home", "End", "Enter"]) {
      const preventDefault = vi.fn(); f.dispatch("keydown", { key, preventDefault, stopPropagation: vi.fn() }); expect(preventDefault).toHaveBeenCalled();
    }
    const count = f.messages.length;
    for (const event of [{ isComposing: true }, { ctrlKey: true }, { target: { closest: () => ({}) } }])
      f.dispatch("keydown", { key: "Enter", preventDefault: vi.fn(), stopPropagation: vi.fn(), ...event });
    expect(f.messages).toHaveLength(count);
  });
  it("fails closed for malformed args and bounds placeholder and unknown JSON fields before serialization", async () => {
    for (const feature of [{ mode: "list", args: null }, { mode: "none", args: {} },
      { mode: "list", args: { placeholder: "x".repeat(8193) } },
      { mode: "list", args: { enter: (_: unknown, cb: (items: unknown[]) => void) => cb([{ title: "a", custom: "x".repeat(1048577) }]) } },
      { mode: "list", args: { enter: (_: unknown, cb: (items: unknown[]) => void) => cb([{ title: "a", get custom() { throw Error("getter must not execute"); } }]) } }]) {
      const f = exportsFixture(); f.target.exports.case = feature; f.bridge.start({ code: "case" }); await flush();
      expect(f.messages.at(-1)?.error).toMatch(/ERR_ATOOLS_FEATURE_/);
    }
  });
  it("search recovers from async failure and old rejected selection cannot mutate a later search", async () => {
    const f = exportsFixture(); let reject!: (error: Error) => void;
    f.target.exports.case = { mode: "list", args: {
      enter: (_: unknown, cb: (items: unknown[]) => void) => cb([{ title: "first" }]),
      select: () => new Promise((_, fail) => { reject = fail; }),
      search: (_: unknown, text: string, cb: (items: unknown[]) => void) => text === "bad" ? Promise.reject(Error("bad search")) : cb([{ title: text }]),
    } };
    f.bridge.start({ code: "case" }); f.command(); f.search("later"); reject(Error("old selection")); await flush();
    expect(f.messages.at(-1)?.error).toBeUndefined(); expect(f.latestRows()[0].title).toBe("later");
    f.search("bad"); await flush(); expect(f.messages.at(-1)?.error).toContain("bad search");
    f.search("recovered"); await flush(); expect(f.latestRows()[0].title).toBe("recovered");
  });
  it("rejects current-parent commands when the existing document transport refuses them", () => {
    const f = exportsFixture(), select = vi.fn();
    f.target.exports.case = { mode: "list", args: { enter: (_: unknown, cb: (items: unknown[]) => void) => cb([{ title: "fixed" }]), select } };
    f.bridge.start({ code: "case" }); f.target.__ATOOLS_FRAME_TRANSPORT__.accept = () => false; f.command(); expect(select).not.toHaveBeenCalled();
    f.dispatch("atools-plugin-out"); const messages = f.messages.length; f.bridge.start({ code: "case" }); f.command(); expect(f.messages).toHaveLength(messages);
  });
  it("rejects sparse-array length and cumulative hole nodes before calling stringify", () => {
    for (const custom of [new Array(300000), new Array(65536), [new Array(40000), new Array(40000)]]) {
      const stringify = vi.fn(() => { throw Error("STRINGIFY_MUST_NOT_RUN"); });
      const f = exportsFixture({ stringify });
      f.target.exports.case = { mode: "list", args: { enter: (_: unknown, cb: (items: unknown[]) => void) => cb([{ title: "fixed", custom }]) } };
      f.bridge.start({ code: "case" });
      expect(stringify).not.toHaveBeenCalled(); expect(f.messages.at(-1)?.error).toContain("ERR_ATOOLS_FEATURE_LIST_COMPLEXITY");
    }
  });
  it("rejects JSON replacement hooks before serialization and keeps bounded normal/sparse arrays usable", () => {
    const hooks = [{ toJSON: () => new Array(300000) }, Object.defineProperty({}, "toJSON", { value: () => new Array(300000) })];
    for (const custom of hooks) {
      const stringify = vi.fn(() => { throw Error("STRINGIFY_MUST_NOT_RUN"); });
      const f = exportsFixture({ stringify });
      f.target.exports.case = { mode: "list", args: { enter: (_: unknown, cb: (items: unknown[]) => void) => cb([{ title: "fixed", custom }]) } };
      f.bridge.start({ code: "case" }); expect(stringify).not.toHaveBeenCalled(); expect(f.messages.at(-1)?.error).toContain("ERR_ATOOLS_FEATURE_LIST_JSON");
    }
    const f = exportsFixture(), select = vi.fn(), custom = [new Array(4), [null, true, 7, "fixed"]];
    const item = { title: "normal", custom };
    f.target.exports.case = { mode: "list", args: { enter: (_: unknown, cb: (items: unknown[]) => void) => cb([item]), select } };
    f.bridge.start({ code: "case" }); expect(f.latestRows()[0].title).toBe("normal"); f.command(); expect(select.mock.calls[0][1]).toBe(item);
  });
  it("accounts for JSON string escaping before stringify and rejects inherited array accessors", () => {
    const inherited = new Array(4), prototype = Object.create(Array.prototype);
    Object.defineProperty(prototype, "2", { get() { throw Error("INHERITED_GETTER_MUST_NOT_RUN"); } });
    Object.setPrototypeOf(inherited, prototype);
    for (const [custom, code] of [["\u0000".repeat(200000), "ERR_ATOOLS_FEATURE_LIST_BYTES"], [inherited, "ERR_ATOOLS_FEATURE_LIST_JSON"]] as const) {
      const stringify = vi.fn(() => { throw Error("STRINGIFY_MUST_NOT_RUN"); });
      const f = exportsFixture({ stringify });
      f.target.exports.case = { mode: "list", args: { enter: (_: unknown, cb: (items: unknown[]) => void) => cb([{ title: "fixed", custom }]) } };
      f.bridge.start({ code: "case" }); expect(stringify).not.toHaveBeenCalled(); expect(f.messages.at(-1)?.error).toContain(code);
    }
  });
});

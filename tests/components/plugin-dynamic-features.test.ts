// @vitest-environment node
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { pluginDataBridgeScript } from "../../src/lib/pluginDataBridge";

const config = { instanceId: "batch32-dynamic", endpoint: "http://127.0.0.1:12345/data/" + "a".repeat(64) };
const clone = (value: unknown) => JSON.parse(JSON.stringify(value));

/** The transport is a test double, never native/runtime acceptance. */
function fixture(authorized = true) {
  const features = new Map<string, any>();
  const requests: { method: string; args: any[]; asynchronous: boolean }[] = [];
  const handlers = new Map<string, Function[]>();
  const parent = { postMessage: vi.fn() };
  const api = { getFeatures: () => Promise.resolve([]), setFeature: () => Promise.resolve([]), removeFeature: () => Promise.resolve([]) };
  const window: any = { utools: { ...api }, ztools: { ...api } };
  let responseOverride: { value: unknown } | undefined;
  class Request {
    status = 200; responseText = ""; asynchronous = false;
    open(_method: string, target: string, asynchronous: boolean) {
      expect(target).toBe(config.endpoint); this.asynchronous = asynchronous;
    }
    setRequestHeader() {}
    send(body: string) {
      const payload = JSON.parse(body); requests.push({ ...payload, asynchronous: this.asynchronous });
      let result: unknown;
      if (responseOverride) result = responseOverride.value;
      else if (payload.method === "features.get") {
        result = [...features.values()].filter(f => !payload.args.length || payload.args[0].includes(f.code));
      } else if (payload.method === "features.set") {
        for (const feature of Array.isArray(payload.args[0]) ? payload.args[0] : [payload.args[0]]) features.set(feature.code, feature);
        result = true;
      } else if (payload.method === "features.remove") {
        const codes = Array.isArray(payload.args[0]) ? payload.args[0] : [payload.args[0]];
        result = codes.map((code: string) => features.delete(code)).some(Boolean);
      } else throw new Error("Unexpected operation " + payload.method);
      this.responseText = JSON.stringify({ ok: true, result });
    }
  }
  const script = pluginDataBridgeScript(authorized ? config : { instanceId: config.instanceId });
  runInNewContext(script.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, ""), {
    window, parent, TextEncoder, XMLHttpRequest: Request, btoa, atob,
    addEventListener(name: string, callback: Function) { handlers.set(name, [...handlers.get(name) ?? [], callback]); },
  });
  return { window, features, requests, parent,
    override(value: unknown) { responseOverride = { value }; },
    dispatch(name: string, event = {}) { handlers.get(name)?.forEach(callback => callback(event)); } };
}

it("installs synchronous dynamic-only APIs in both aliases and retains complete feature fields", () => {
  const f = fixture();
  const feature = { code: "open@fixed", explain: "固定书签", cmds: ["书签", { type: "over", label: "搜索" }],
    platform: ["win32", "darwin", "linux"], icon: "tag.png", mainHide: true };
  expect(f.window.ztools.setFeature(feature)).toBe(true);
  const result = f.window.utools.getFeatures();
  expect(Array.isArray(result)).toBe(true); expect(result.then).toBeUndefined();
  expect(clone(result)).toEqual([feature]);
  expect(clone(f.window.utools.getFeatures([feature.code]))).toEqual([feature]);
  expect(clone(f.window.utools.getFeatures([]))).toEqual([]);
  expect(clone(f.window.utools.getFeatures(["missing"]))).toEqual([]);
  expect(f.window.utools.removeFeature(feature.code)).toBe(true);
  expect(f.window.ztools.removeFeature(feature.code)).toBe(false);
  expect(f.requests.every(request => request.asynchronous === false)).toBe(true);
  expect(f.requests.map(request => request.method)).toEqual([
    "features.set", "features.get", "features.get", "features.get", "features.get", "features.remove", "features.remove",
  ]);
});

it("requires the existing data authorization without retaining or replaying a feature", () => {
  const f = fixture(false);
  expect(() => f.window.ztools.setFeature({ code: "private", cmds: ["private keyword"] })).toThrow("PERMISSION_REQUIRED");
  expect(() => f.window.ztools.getFeatures()).toThrow("PERMISSION_REQUIRED");
  expect(f.requests).toEqual([]); expect(f.parent.postMessage).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(f.parent.postMessage.mock.calls)).not.toContain("private keyword");
  f.dispatch("message", { source: (f as any).parent, data: { __atools_plugin_data_session__: true, instanceId: config.instanceId, endpoint: config.endpoint } });
  expect(f.requests).toEqual([]); expect(f.features.size).toBe(0);
  expect(clone(f.window.ztools.getFeatures())).toEqual([]);
});

it("keeps a revoked or destroyed document from reading or changing features", () => {
  const f = fixture();
  f.window.ztools.setFeature({ code: "kept", cmds: ["保留"] });
  f.dispatch("pagehide"); const count = f.requests.length;
  for (const action of [() => f.window.ztools.getFeatures(), () => f.window.ztools.setFeature({ code: "new", cmds: ["新建"] }),
    () => f.window.ztools.removeFeature("kept")]) expect(action).toThrow("CLOSED");
  expect(f.requests).toHaveLength(count); expect(f.features.has("kept")).toBe(true);
});

it("rejects malformed public arguments and transport values instead of inventing success", () => {
  const f = fixture();
  for (const codes of ["one", [123], Array(129).fill("a")]) expect(() => f.window.ztools.getFeatures(codes)).toThrow();
  for (const feature of [null, "one", {}, { code: "", cmds: [] }, Array(129).fill({ code: "a" })]) {
    expect(() => f.window.ztools.setFeature(feature)).toThrow();
  }
  expect(f.requests).toEqual([]);
  f.override({ ok: true }); expect(() => f.window.ztools.setFeature({ code: "a", cmds: [] })).toThrow("RESPONSE");
  f.override(false); expect(() => f.window.ztools.getFeatures()).toThrow("RESPONSE");
});

it("runs the unchanged memo tag business function against the installed production adapter", () => {
  const original = readFileSync(new URL("../../ZTools-plugins/plugins/memo-quick-paste/index.js", import.meta.url));
  const digest = createHash("sha256").update(original).digest("hex");
  const source = original.toString();
  const start = source.indexOf('Jd(this,"getTagOptions",(') + 'Jd(this,"getTagOptions",('.length;
  const end = source.indexOf(')),Jd(this,"autoPasteNoteItems"', start);
  expect(start).toBeGreaterThan(25); expect(end).toBeGreaterThan(start);
  const body = source.slice(start, end);
  const f = fixture();
  f.window.ztools.setFeature({ code: "tag-beta", explain: "标签", cmds: ["Beta"] });
  f.window.ztools.setFeature({ code: "tag-alpha", explain: "标签", cmds: ["Alpha"] });
  const business = runInNewContext(`(${body})`, { window: f.window });
  expect(clone(business())).toEqual([{ value: "tag-alpha", label: "Alpha" }, { value: "tag-beta", label: "Beta" }]);
  expect([...f.features.values()].every(value => value.icon === "tag.png")).toBe(true);
  expect(createHash("sha256").update(readFileSync(new URL("../../ZTools-plugins/plugins/memo-quick-paste/index.js", import.meta.url))).digest("hex")).toBe(digest);
});

it("runs URL Wizard's complete unchanged quick-open method through set/filter/remove", async () => {
  const file = new URL("../../ZTools-plugins/plugins/url-wizard/assets/index-4d792b2f.js", import.meta.url);
  const original = readFileSync(file); const digest = createHash("sha256").update(original).digest("hex");
  const source = original.toString(), start = source.indexOf("async setFly(e){"), end = source.indexOf(",changeMessage(e,t,n=2600)", start);
  expect(start).toBeGreaterThan(0); expect(end - start).toBeLessThan(2000);
  const f = fixture(); const method = runInNewContext(`({${source.slice(start, end)}}).setFly`, { utools: f.window.utools });
  const bookmark = { _id: "fixed", title: "本地书签", url: "https://example.invalid/{q}", desc: "固定内容", isFly: true,
    isOverall: true, icon: { type: "emoji", data: "tag.png" } };
  await method(bookmark);
  expect(clone(f.window.utools.getFeatures(["open@fixed"]))).toEqual([{
    code: "open@fixed", explain: "🌐 前往搜索 ➜ 本地书签 - 固定内容", platform: ["win32", "darwin", "linux"],
    icon: "tag.png", mainHide: true, cmds: ["本地书签", { type: "over", label: "本地书签" }],
  }]);
  await method({ ...bookmark, isFly: false }); expect(clone(f.window.utools.getFeatures())).toEqual([]);
  expect(createHash("sha256").update(readFileSync(file)).digest("hex")).toBe(digest);
});

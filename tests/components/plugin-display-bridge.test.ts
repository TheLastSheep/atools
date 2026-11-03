import { describe, expect, it, vi } from "vitest";
import vm from "node:vm";
import { createPluginDisplayBridge, pluginDisplayBridgeScript, type PluginDisplaySnapshot } from "../../src/lib/pluginDisplayBridge";
import { createPluginElectronAdapter } from "../../src/lib/pluginElectronAdapter";
const endpoint = "http://127.0.0.1:54321/display/" + "a".repeat(64);
export function fixtureSnapshot(): PluginDisplaySnapshot {
  const display = (id: number, x: number, y: number, width: number, height: number, scaleFactor: number) => ({ id,
    bounds: { x, y, width, height }, workArea: { x, y: y + 24, width, height: height - 24 },
    size: { width, height }, workAreaSize: { width, height: height - 24 }, scaleFactor, rotation: 0, internal: id === 2 });
  return { schemaVersion: 1, platform: "darwin", primaryId: 2, cursor: { x: -200, y: -100 },
    displays: [display(2, 0, 0, 1440, 900, 2), display(1, -1920, -200, 1920, 1080, 1), display(3, 1440, 0, 1920, 1080, 1)] };
}
function setup(snapshot = fixtureSnapshot()) { const request = vi.fn(), transport = vi.fn(() => snapshot);
  return { bridge: createPluginDisplayBridge({ instanceId: "fixture", endpoint }, request, transport), transport, request }; }
describe("fresh native display geometry", () => {
  it("gets native primary, cursor and mixed-scale negative-origin topology synchronously per call", () => {
    const { bridge, transport } = setup();
    expect(bridge.getPrimaryDisplay().id).toBe(2); expect(bridge.getCursorScreenPoint()).toEqual({ x: -200, y: -100 });
    expect(bridge.getAllDisplays().map(d => [d.id, d.scaleFactor, d.bounds.x])).toEqual([[2, 2, 0], [1, 1, -1920], [3, 1, 1440]]);
    expect(bridge.getDisplayNearestPoint({ x: -1500, y: 300 }).id).toBe(1);
    expect(transport).toHaveBeenCalledTimes(4); expect(transport.mock.calls.every(([address, payload]) => address === endpoint && JSON.stringify(payload) === '{"operation":"snapshot"}')).toBe(true);
  });
  it("uses half-open shared edges and stable IDs for outside ties, independent of enumeration", () => {
    const { bridge } = setup(); expect(bridge.getDisplayNearestPoint({ x: 0, y: 0 }).id).toBe(2);
    expect(bridge.getDisplayNearestPoint({ x: 1440, y: 0 }).id).toBe(3);
    const raw = fixtureSnapshot(); raw.displays = raw.displays.slice(0, 2); raw.displays[0].bounds.x = 100; raw.displays[0].workArea.x = 100;
    expect(setup(raw).bridge.getDisplayNearestPoint({ x: 50, y: 50 }).id).toBe(1);
    raw.displays.reverse(); expect(setup(raw).bridge.getDisplayNearestPoint({ x: 50, y: 50 }).id).toBe(1);
  });
  it("chooses maximum overlap then center-nearest fallback with zero-area rectangles", () => {
    const { bridge } = setup(); expect(bridge.getDisplayMatching({ x: -100, y: 50, width: 800, height: 300 }).id).toBe(2);
    expect(bridge.getDisplayMatching({ x: -1000, y: 4000, width: 0, height: 0 }).id).toBe(1);
    expect(bridge.getDisplayMatching({ x: -100, y: 0, width: 200, height: 100 }).id).toBe(1);
  });
  it("returns deeply frozen independent copies and reads changing cursor natively every time", () => {
    const raw = fixtureSnapshot(), { bridge } = setup(raw), display = bridge.getPrimaryDisplay();
    expect(Object.isFrozen(display.bounds)).toBe(true); expect(() => { display.bounds.x = 999; }).toThrow();
    expect(display).not.toBe(raw.displays[0]); raw.cursor.x = 111; expect(bridge.getCursorScreenPoint().x).toBe(111);
    expect(Object.isFrozen(bridge.getAllDisplays())).toBe(true);
  });
  it("validates mac identity conversion without global pixel ratio and rejects Windows-only conversions", () => {
    const { bridge, transport } = setup(), rect = { x: -100, y: 10, width: 200, height: 50 };
    expect(bridge.dipToScreenRect(rect)).toEqual(rect); expect(bridge.dipToScreenRect(null, rect)).toEqual(rect);
    expect(() => bridge.dipToScreenRect({}, rect)).toThrow("UNSUPPORTED");
    expect(() => bridge.screenToDipPoint()).toThrow("UNSUPPORTED"); expect(() => bridge.dipToScreenPoint()).toThrow("UNSUPPORTED");
    expect(() => bridge.screenToDipRect()).toThrow("UNSUPPORTED"); expect(transport).not.toHaveBeenCalled();
  });
  it("shares the actual authorized screen with Electron while unavailable hosts throw", () => {
    const { bridge } = setup(), electron = createPluginElectronAdapter({ application: { name: "ATools", version: "test" }, screen: bridge });
    expect(electron.screen.getPrimaryDisplay().id).toBe(2);
    expect(() => createPluginElectronAdapter({ application: { name: "ATools", version: "test" } }).screen.getAllDisplays()).toThrow("UNSUPPORTED");
  });
});
describe("display input, permission and lifetime bounds", () => {
  it("requests permission once, with no retained coordinates or automatic replay", () => {
    const request = vi.fn(), transport = vi.fn(); const bridge = createPluginDisplayBridge({ instanceId: "fixture" }, request, transport);
    expect(() => bridge.getCursorScreenPoint()).toThrow("PERMISSION_REQUIRED"); expect(() => bridge.getDisplayNearestPoint({ x: 1, y: 2 })).toThrow("PERMISSION_REQUIRED");
    expect(request.mock.calls).toEqual([[]]); expect(transport).not.toHaveBeenCalled(); bridge.close();
    expect(() => bridge.getAllDisplays()).toThrow("CLOSED"); expect(request).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed plugin points before transport, and never reads poison getters", () => {
    const { bridge, transport } = setup(), poison = vi.fn(() => { throw Error("poison read"); });
    const point = Object.defineProperty({ y: 1 }, "x", { get: poison, enumerable: true });
    for (const input of [point, { x: NaN, y: 1 }, { x: Infinity, y: 1 }, { x: 1, y: 1, extra: 1 }, Object.create({ x: 1, y: 2 })]) expect(() => bridge.getDisplayNearestPoint(input)).toThrow("RESPONSE");
    expect(() => bridge.getDisplayMatching({ x: 0, y: 0, width: -1, height: 1 })).toThrow("RESPONSE");
    expect(poison).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  });
  it.each(["schema", "platform", "duplicate", "primary", "scale", "size", "coordinate", "displayCount", "label", "metadata"])("rejects malformed native %s snapshots atomically", kind => {
    const raw: any = fixtureSnapshot();
    if (kind === "schema") raw.schemaVersion = 2; if (kind === "platform") raw.platform = "win32";
    if (kind === "duplicate") raw.displays[1].id = 2; if (kind === "primary") raw.primaryId = 999;
    if (kind === "scale") raw.displays[0].scaleFactor = 0; if (kind === "size") raw.displays[0].size.width = 42;
    if (kind === "coordinate") raw.cursor.x = NaN; if (kind === "displayCount") raw.displays = Array(33).fill(raw.displays[0]);
    if (kind === "label") raw.displays[0].label = "a".repeat(1025); if (kind === "metadata") raw.displays[0].pretendColorSpace = "native";
    expect(() => setup(raw).bridge.getAllDisplays()).toThrow("RESPONSE");
  });
  it("rejects prototype pollution and native getters without invoking them", () => {
    for (const target of ["root", "display", "bounds", "array", "array-prototype", "array-extra"]) {
      const raw: any = fixtureSnapshot(), poison = vi.fn(() => { throw Error("getter read"); });
      if (target === "root") Object.defineProperty(raw, "cursor", { get: poison });
      if (target === "display") Object.defineProperty(raw.displays[0], "id", { get: poison });
      if (target === "bounds") Object.setPrototypeOf(raw.displays[0].bounds, { polluted: true });
      if (target === "array") Object.defineProperty(raw.displays, "0", { get: poison });
      if (target === "array-prototype") Object.setPrototypeOf(raw.displays, Object.create(Array.prototype));
      if (target === "array-extra") raw.displays.constructor = "forged";
      expect(() => setup(raw).bridge.getPrimaryDisplay()).toThrow("RESPONSE"); expect(poison).not.toHaveBeenCalled();
    }
  });
  it("validates endpoint and closes even an already-authorized private endpoint", () => {
    for (const address of [endpoint.replace("127.0.0.1", "localhost"), endpoint.replace("/display/", "/host/"), endpoint.replace(":54321/", ":65536/"), "https://example.com"]) expect(() => createPluginDisplayBridge({ instanceId: "x", endpoint: address }, vi.fn())).toThrow("CONFIG");
    const { bridge, transport } = setup(); bridge.close(); bridge.close(); expect(() => bridge.getPrimaryDisplay()).toThrow("CLOSED"); expect(transport).not.toHaveBeenCalled();
  });
  it("serializes cleanly, uses fresh sync XHR and accepts no forged parent credential update", () => {
    const requests: any[] = [], listeners = new Map<string, Function[]>(); let raw = fixtureSnapshot();
    class Xhr { status = 200; responseText = ""; open(...args: any[]) { requests.push({ args }); } setRequestHeader() {} send(body: string) { requests.at(-1).body = body; this.responseText = JSON.stringify({ ok: true, result: raw }); } }
    const window: any = { utools: {}, ztools: {}, parent: { postMessage: vi.fn() }, addEventListener(name: string, listener: Function) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); } };
    const script = pluginDisplayBridgeScript({ instanceId: "fixture", endpoint }).replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    vm.runInNewContext(script, { window, XMLHttpRequest: Xhr, TextEncoder });
    expect(window.utools.getPrimaryDisplay().id).toBe(2); raw.cursor.x = 19; expect(window.ztools.getCursorScreenPoint().x).toBe(19);
    expect(requests).toHaveLength(2); expect(requests.every(r => r.args[2] === false && r.body === '{"operation":"snapshot"}')).toBe(true);
    expect(listeners.has("message")).toBe(false);
    listeners.get("pagehide")![0](); expect(() => window.utools.getAllDisplays()).toThrow("CLOSED");
  });
  it("rejects oversized wire body and rejected or forged success envelopes", () => {
    for (const body of ["x".repeat(65537), '{"ok":false,"error":{"message":"secret"}}', '{"ok":true}', '{"ok":true,"result":{},"injected":true}']) {
      class Xhr { status = 200; responseText = body; open() {} setRequestHeader() {} send() {} }
      const script = pluginDisplayBridgeScript({ instanceId: "fixture", endpoint }).replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
      const window: any = { addEventListener() {}, utools: {} }; vm.runInNewContext(script, { window, XMLHttpRequest: Xhr, TextEncoder });
      expect(() => window.utools.getAllDisplays()).toThrow(/DISPLAY_(LIMIT|REJECTED|RESPONSE)/);
    }
  });
});

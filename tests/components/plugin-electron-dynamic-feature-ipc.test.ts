// @vitest-environment node
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { pluginElectronAdapterScript } from "../../src/lib/pluginElectronAdapter";
import { pluginDataBridgeScript } from "../../src/lib/pluginDataBridge";

function withoutScriptTags(script: string) {
  return script.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
}

function fixture(owner: string, authorized = true, allowSet = true, installDataBridge = true) {
  const instanceId = `feature-ipc-${owner}`;
  const ownerDigest = Array.from(owner, character => character.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  const endpoint = authorized ? `http://127.0.0.1:12345/data/${ownerDigest.padEnd(64, "a").slice(0, 64)}` : undefined;
  const features = new Map<string, Record<string, unknown>>();
  const requests: Array<{ method: string; args: unknown[] }> = [];
  const handlers = new Map<string, Function[]>();
  const broker = {};
  let localFallbackCalls = 0;
  class Request {
    status = 200;
    responseText = "";
    open(method: string, url: string, asynchronous: boolean) {
      expect(method).toBe("POST");
      expect(url).toBe(endpoint);
      expect(asynchronous).toBe(false);
    }
    setRequestHeader() {}
    send(body: string) {
      const payload = JSON.parse(body) as { method: string; args: unknown[] };
      requests.push(payload);
      let result: unknown;
      if (payload.method === "features.get") {
        const filter = payload.args[0];
        result = [...features.values()].filter(feature => !Array.isArray(filter) || filter.includes(feature.code));
      } else if (payload.method === "features.set") {
        const feature = payload.args[0] as Record<string, unknown>;
        if (allowSet) features.set(String(feature.code), feature);
        result = allowSet;
      } else if (payload.method === "features.remove") {
        result = features.delete(String(payload.args[0]));
      } else throw new Error(`Unexpected owner data method: ${payload.method}`);
      this.responseText = JSON.stringify({ ok: true, result });
    }
  }
  const parent = { postMessage() {} };
  const hostWindow: Record<string, any> = {
    parent,
    require: (specifier: string) => specifier === "electron" ? { ipcRenderer: broker } : {},
    utools: {
      getAppName: () => "ATools", getAppVersion: () => "test",
      getFeatures: () => { localFallbackCalls++; return []; },
      setFeature: () => { localFallbackCalls++; return true; },
      removeFeature: () => { localFallbackCalls++; return true; },
    },
    addEventListener: (name: string, callback: Function) => handlers.set(name, [...(handlers.get(name) ?? []), callback]),
    removeEventListener() {},
    console,
  };
  const globals = {
    window: hostWindow, parent, TextEncoder, XMLHttpRequest: Request, btoa, atob,
    addEventListener: hostWindow.addEventListener,
  };
  if (installDataBridge) runInNewContext(withoutScriptTags(pluginDataBridgeScript({ instanceId, endpoint })), globals);
  new Function("window", withoutScriptTags(pluginElectronAdapterScript()))(hostWindow);
  return {
    electron: hostWindow.require("electron"),
    requests, features,
    get localFallbackCalls() { return localFallbackCalls; },
    dispatch(name: string) { handlers.get(name)?.forEach(callback => callback({})); },
  };
}

it("routes only the fixed synchronous aliases through the serialized owner data bridge", () => {
  const f = fixture("owner-a");
  const feature = { code: "open@fixed", label: "固定入口", cmds: ["固定入口"] };
  const ipc = f.electron.ipcRenderer;
  expect(ipc.sendSync("set-feature", feature)).toEqual({ success: true });
  expect(ipc.sendSync("get-features")).toEqual([feature]);
  expect(ipc.sendSync("get-features", [feature.code])).toEqual([feature]);
  expect(ipc.sendSync("get-features", ["missing"])).toEqual([]);
  expect(ipc.sendSync("remove-feature", feature.code)).toBe(true);
  expect(ipc.sendSync("remove-feature", feature.code)).toBe(false);
  expect(f.requests).toEqual([
    { method: "features.set", args: [feature] },
    { method: "features.get", args: [] },
    { method: "features.get", args: [[feature.code]] },
    { method: "features.get", args: [["missing"]] },
    { method: "features.remove", args: [feature.code] },
    { method: "features.remove", args: [feature.code] },
  ]);
});

it("keeps dynamic features isolated to each serialized plugin data owner", () => {
  const first = fixture("owner-a"), second = fixture("owner-b");
  first.electron.ipcRenderer.sendSync("set-feature", { code: "private-a", cmds: ["A"] });
  expect(second.electron.ipcRenderer.sendSync("get-features")).toEqual([]);
  expect(first.requests).toHaveLength(1);
  expect(second.requests).toEqual([{ method: "features.get", args: [] }]);
});

it("preserves an actual owner-store rejection as the documented set result", () => {
  const f = fixture("owner-rejects-set", true, false);
  expect(f.electron.ipcRenderer.sendSync("set-feature", { code: "not-saved" })).toEqual({
    success: false, error: "Dynamic feature was not stored",
  });
  expect(f.requests).toEqual([{ method: "features.set", args: [{ code: "not-saved" }] }]);
  expect(f.features.size).toBe(0);
});

it("rejects unsupported, malformed, and oversized calls before the owner transport", () => {
  const f = fixture("owner-c"), ipc = f.electron.ipcRenderer;
  for (const call of [
    () => ipc.sendSync("other-channel"),
    () => ipc.sendSync("get-features", [], []),
    () => ipc.sendSync("get-features", "open@fixed"),
    () => ipc.sendSync("get-features", ["ok", 3]),
    () => ipc.sendSync("get-features", Array(129).fill("code")),
    () => ipc.sendSync("set-feature"),
    () => ipc.sendSync("set-feature", { code: "" }),
    () => ipc.sendSync("set-feature", { code: "large", detail: "x".repeat(17 * 1024) }),
    () => ipc.sendSync("remove-feature", ["open@fixed"]),
    () => ipc.sendSync("remove-feature", "bad\ncode"),
  ]) expect(call).toThrow();
  expect(f.requests).toEqual([]);
});

it("does not convert data-session denial into empty data or successful mutation", () => {
  const f = fixture("owner-denied", false), ipc = f.electron.ipcRenderer;
  expect(() => ipc.sendSync("get-features")).toThrow("PERMISSION_REQUIRED");
  expect(ipc.sendSync("set-feature", { code: "denied", cmds: ["not retained"] })).toMatchObject({
    success: false, error: expect.stringContaining("PERMISSION_REQUIRED"),
  });
  expect(() => ipc.sendSync("remove-feature", "denied")).toThrow("PERMISSION_REQUIRED");
  expect(f.requests).toEqual([]);
  expect(f.features.size).toBe(0);
});

it("never falls back to the base local feature facade without the owner data bridge", () => {
  const f = fixture("owner-without-session", true, true, false);
  expect(() => f.electron.ipcRenderer.sendSync("get-features")).toThrow("owner-scoped feature store is unavailable");
  expect(f.localFallbackCalls).toBe(0);
  expect(f.requests).toEqual([]);
});

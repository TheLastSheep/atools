import { describe, expect, it, vi } from "vitest";
import { createHostClipboardBridge, hostClipboardBridgeScript } from "../../src/lib/hostClipboardBridge";

const endpoint = "http://127.0.0.1:12345/host/" + "a".repeat(64);
const entry = (path = "/private/tmp/空 格\n🧰.png") => ({ name: "空 格\n🧰.png", path, isFile: true, isDirectory: false });

describe("synchronous copied-file metadata through the authorized clipboard session", () => {
  it("returns fresh canonical metadata synchronously without modifying exact paths", () => {
    let current = [entry(), { name: "文件夹", path: "/private/tmp/文件夹", isFile: false, isDirectory: true }];
    const transport = vi.fn(() => current);
    const bridge = createHostClipboardBridge({ instanceId: "files", endpoints: { read: endpoint } }, vi.fn(), transport);
    const first = bridge.readFiles();
    expect(Array.isArray(first)).toBe(true);
    expect((first as any).then).toBeUndefined();
    expect(first).toEqual(current.map(value => ({ ...value, isDiractory: value.isDirectory })));
    first[0].path = "changed";
    expect(bridge.readFiles()[0].path).toBe(current[0].path);
    current = [];
    expect(bridge.readFiles()).toEqual([]);
    expect(transport.mock.calls).toEqual(Array(3).fill([endpoint, { format: "files" }]));
  });

  it("requests read once, never sends or queues paths before approval, and rejects after close", () => {
    const request = vi.fn(), transport = vi.fn(() => [entry()]);
    const bridge = createHostClipboardBridge({ instanceId: "files" }, request, transport);
    expect(() => bridge.readFiles()).toThrow("PERMISSION_REQUIRED");
    expect(() => bridge.readFiles()).toThrow("PERMISSION_REQUIRED");
    expect(request.mock.calls).toEqual([["read"]]);
    expect(transport).not.toHaveBeenCalled();
    bridge.install("read", endpoint);
    expect(transport).not.toHaveBeenCalled();
    expect(bridge.readFiles()).toHaveLength(1);
    bridge.close();
    expect(() => bridge.readFiles()).toThrow("CLOSED");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid results and atomically enforces count, path and response budgets", () => {
    let value: unknown = [];
    const bridge = createHostClipboardBridge({ instanceId: "files", endpoints: { read: endpoint } }, vi.fn(), () => value);
    for (value of [null, {}, Promise.resolve([]), ["/tmp/a"], [{ ...entry(), isDirectory: "false" }],
      [{ ...entry(), path: "" }], [{ ...entry(), path: "/tmp/a\0b" }], [{ ...entry(), isDirectory: true }]]) {
      expect(() => bridge.readFiles()).toThrow("RESPONSE");
    }
    value = Array.from({ length: 128 }, () => entry());
    expect(bridge.readFiles()).toHaveLength(128);
    value = Array.from({ length: 129 }, () => entry());
    expect(() => bridge.readFiles()).toThrow("LIMIT");
    value = [entry("/" + "x".repeat(8191))];
    expect(bridge.readFiles()).toHaveLength(1);
    value = [entry("/" + "x".repeat(8192))];
    expect(() => bridge.readFiles()).toThrow("LIMIT");
    value = Array.from({ length: 8 }, () => entry("/" + "x".repeat(8191)));
    expect(bridge.readFiles()).toHaveLength(8);
    (value as any[]).push(entry("/x"));
    expect(() => bridge.readFiles()).toThrow("LIMIT");
    value = [{ ...entry(), name: "x".repeat(256 * 1024) }];
    expect(() => bridge.readFiles()).toThrow("LIMIT");
  });

  it("installs both public spellings into the actual serialized bridge and keeps text routing", () => {
    const calls: unknown[] = [], listeners: Function[] = [], fallback = vi.fn();
    const api: any = { clipboard: {}, getCopyedFiles: fallback, getCopiedFiles: fallback };
    const window: any = { utools: api, ztools: api };
    class Xhr {
      status = 200;
      responseText = JSON.stringify({ ok: true, result: [entry()] });
      open(...args: unknown[]) { calls.push(args); }
      setRequestHeader() {}
      send(body: string) { calls.push(JSON.parse(body)); }
    }
    const source = hostClipboardBridgeScript({ instanceId: "files", endpoints: { read: endpoint } })
      .replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    new Function("window", "parent", "addEventListener", "XMLHttpRequest", source)(window, {}, (_: string, fn: Function) => listeners.push(fn), Xhr);
    expect(window.utools.getCopyedFiles()).toEqual([{ ...entry(), isDiractory: false }]);
    expect(window.ztools.getCopiedFiles()).toEqual([{ ...entry(), isDiractory: false }]);
    expect(calls).toEqual([["POST", endpoint, false], { format: "files" }, ["POST", endpoint, false], { format: "files" }]);
    expect(fallback).not.toHaveBeenCalled();
    expect(listeners).toHaveLength(1);
  });
});

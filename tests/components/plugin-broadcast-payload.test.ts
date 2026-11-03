import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { measurePluginBroadcastPayload } from "../../src/lib/pluginBroadcastPayload";

const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

function expectNamedError(run: () => unknown, name: string, code: string) {
  try {
    run();
  } catch (error) {
    expect(error).toMatchObject({ name });
    expect(String((error as Error).message)).toContain(code);
    return;
  }
  throw new Error(`Expected ${name}`);
}

describe("plugin broadcast payload accounting", () => {
  it("accepts a typical image-bearing PASTER_CREATED message below the 4 MiB budget", () => {
    const image = `data:image/png;base64,${"A".repeat(3_700_000)}`;
    const measured = measurePluginBroadcastPayload({
      type: "PASTER_CREATED",
      id: "paster-7",
      source: "clipboard",
      image,
      bounds: { x: 32, y: 48, width: 720, height: 480 },
    });

    expect(measured).toBeGreaterThan(image.length);
    expect(measured).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });

  it("rejects oversized strings and sparse arrays before scanning their contents", () => {
    expectNamedError(() => measurePluginBroadcastPayload("x".repeat(MAX_PAYLOAD_BYTES + 1)),
      "QuotaExceededError", "ERR_ATOOLS_BROADCAST_BUDGET");
    expectNamedError(() => measurePluginBroadcastPayload(new Array(100_000_000)),
      "QuotaExceededError", "ERR_ATOOLS_BROADCAST_BUDGET");
  });

  it("accounts cycles and repeated references once while keeping each reference edge", () => {
    const shared = { label: "image", bytes: new Uint8Array(1024).buffer };
    const cyclic: Record<string, unknown> = { first: shared, second: shared };
    cyclic.self = cyclic;
    const repeatedCost = measurePluginBroadcastPayload(cyclic);
    const duplicatedCost = measurePluginBroadcastPayload({
      first: { label: "image", bytes: new Uint8Array(1024).buffer },
      second: { label: "image", bytes: new Uint8Array(1024).buffer },
    });

    expect(repeatedCost).toBeGreaterThan(0);
    expect(repeatedCost).toBeLessThan(duplicatedCost);
  });

  it("enforces graph depth and node ceilings", () => {
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let index = 0; index < 65; index += 1) {
      const next: Record<string, unknown> = {};
      deep.next = next;
      deep = next;
    }
    expectNamedError(() => measurePluginBroadcastPayload(root),
      "QuotaExceededError", "ERR_ATOOLS_BROADCAST_BUDGET");

    expectNamedError(() => measurePluginBroadcastPayload(Array.from({ length: 9000 }, (_, index) => index)),
      "QuotaExceededError", "ERR_ATOOLS_BROADCAST_BUDGET");
  });

  it("handles cross-realm clone built-ins and ignores a forged toStringTag", () => {
    const crossRealm = runInNewContext(`(() => {
      const forgedDate = {};
      Object.defineProperty(forgedDate, Symbol.toStringTag, { value: "Date" });
      return {
        date: new Date(1234),
        regexp: /harris/giu,
        map: new Map([["k", new Set([1, 2, 3])]]),
        bytes: new Uint16Array([2, 4, 8]),
        view: new DataView(new Uint8Array([9, 7, 5]).buffer),
        counter: 123456789012345678901234567890n,
        forgedDate,
      };
    })()`);

    expect(measurePluginBroadcastPayload(crossRealm)).toBeGreaterThan(0);
  });

  it("supports Blob and File clone payloads when the runtime exposes them", () => {
    const values: Record<string, unknown> = { blob: new Blob(["payload"], { type: "text/plain" }) };
    if (typeof File === "function") values.file = new File(["data"], "sample.txt", { lastModified: 12 });
    expect(measurePluginBroadcastPayload(values)).toBeGreaterThan(20);
  });

  it("rejects accessors without invoking them and rejects non-cloneable values", () => {
    let getterCalls = 0;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get() { getterCalls += 1; return "must not run"; },
    });
    expectNamedError(() => measurePluginBroadcastPayload(accessor),
      "DataCloneError", "ERR_ATOOLS_BROADCAST_DATA_CLONE");
    expect(getterCalls).toBe(0);

    for (const unsupported of [Symbol("x"), () => 1, Promise.resolve(1), new WeakMap()]) {
      expectNamedError(() => measurePluginBroadcastPayload(unsupported),
        "DataCloneError", "ERR_ATOOLS_BROADCAST_DATA_CLONE");
    }
    if (typeof SharedArrayBuffer === "function") {
      expectNamedError(() => measurePluginBroadcastPayload(new SharedArrayBuffer(8)),
        "DataCloneError", "ERR_ATOOLS_BROADCAST_DATA_CLONE");
    }
  });

  it("counts UTF-8 conservatively and exposes a self-contained serialized function", () => {
    const measured = measurePluginBroadcastPayload({ text: "Aé漢🧪" });
    expect(measured).toBeGreaterThan(1 + 2 + 3 + 4);

    const serialized = runInNewContext(`(${measurePluginBroadcastPayload.toString()})`);
    expect(serialized({ ok: true, list: [1, 2, 3] })).toBeGreaterThan(0);
    expect(() => serialized("x".repeat(MAX_PAYLOAD_BYTES + 1))).toThrow();
  });
});

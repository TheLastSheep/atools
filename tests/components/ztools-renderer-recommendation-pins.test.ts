import { describe, expect, it, vi } from "vitest";
import {
  createRendererRecommendationPinWriter,
  inferRecommendationPinMutation,
  serializeRecommendationPins,
  type RendererRecommendationPin,
} from "../../packages/ztools-renderer/src/recommendationPins";
import { HOST_ERROR_CODES } from "../../packages/ztools-renderer/src/errors";
import { createStartupReadModel, serializeSearchPreferenceForWrite } from "../../packages/ztools-renderer/src/startupReadModel";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function settlePromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function pin(path: string, name = path): RendererRecommendationPin {
  return { path, name, type: "plugin", pluginName: path, featureCode: name };
}

describe("ZTools renderer recommendation pin persistence", () => {
  it("takes an independent ordered JSON snapshot and preserves unknown fields and duplicates", () => {
    const first = { ...pin("/plugins/a"), extra: { source: "fixture" } };
    const input = [first, first];
    const snapshot = serializeRecommendationPins(input);
    first.extra.source = "changed";
    input.reverse();

    expect(snapshot.serialized).toContain('"source":"fixture"');
    expect(snapshot.value).toEqual([
      { ...pin("/plugins/a"), extra: { source: "fixture" } },
      { ...pin("/plugins/a"), extra: { source: "fixture" } },
    ]);
    expect(snapshot.value[0]).not.toBe(first);
    expect(snapshot.value[0]).not.toBe(snapshot.value[1]);
  });

  it("rejects malformed plain JSON and enforces the fixed row/string budgets", () => {
    const accessor = pin("/plugins/a");
    Object.defineProperty(accessor, "name", { enumerable: true, get: () => "getter" });
    expect(() => serializeRecommendationPins([accessor])).toThrow();

    const circular = pin("/plugins/a");
    circular.extra = circular;
    expect(() => serializeRecommendationPins([circular])).toThrow();
    expect(() => serializeRecommendationPins([pin("/plugins/a"), undefined])).toThrow();
    expect(() => serializeRecommendationPins([pin("/plugins/a", "名".repeat(1366))])).toThrow();
    expect(() => serializeRecommendationPins(Array.from({ length: 4097 }, (_, index) => pin(String(index)))))
      .toThrow();
    expect(() => serializeRecommendationPins([{ ...pin("/plugins/a"), extra: "x".repeat(129 * 1024) }]))
      .toThrow();

    const extensionKey = "future-metadata-".padEnd(257, "x");
    const row = { ...pin("/plugins/long-key"), [extensionKey]: { retained: true } };
    expect(serializeRecommendationPins([row]).value[0]?.[extensionKey]).toEqual({ retained: true });
    expect(() => serializeSearchPreferenceForWrite({ [extensionKey]: { path: "/p", name: "P" } }))
      .toThrow();
  });

  it("pre-rejects cumulative string units before serialization and keeps exact JSON byte checks", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const giant = { ...pin("/plugins/a"), metadata: "x".repeat(128 * 1024 + 1) };
      expect(() => serializeRecommendationPins([giant])).toThrow();
      const cumulative = {
        ...pin("/plugins/a"),
        metadataA: "a".repeat(70 * 1024),
        metadataB: "b".repeat(60 * 1024),
      };
      expect(() => serializeRecommendationPins([cumulative])).toThrow();
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }

    const maxBytes = 128 * 1024;
    const encode = (value: string) => new TextEncoder().encode(value).byteLength;
    const row = { path: "/plugins/a", name: "A", type: "plugin", extra: "" };
    const templateBytes = encode(JSON.stringify([row]));
    const utf8Count = Math.floor((maxBytes - templateBytes) / 2);
    const utf8Within = serializeRecommendationPins([{ ...row, extra: "é".repeat(utf8Count) }]);
    expect(encode(utf8Within.serialized)).toBeLessThanOrEqual(maxBytes);
    expect(() => serializeRecommendationPins([{ ...row, extra: "é".repeat(utf8Count + 1) }]))
      .toThrow();

    const escapedCount = Math.floor((maxBytes - templateBytes) / 6);
    const escapedWithin = serializeRecommendationPins([{ ...row, extra: "\u0001".repeat(escapedCount) }]);
    expect(encode(escapedWithin.serialized)).toBeLessThanOrEqual(maxBytes);
    expect(() => serializeRecommendationPins([{ ...row, extra: "\u0001".repeat(escapedCount + 1) }]))
      .toThrow();
  });

  it("serializes saves, snapshots each call at invocation, and advances the CAS baseline after success", async () => {
    const gate = deferred<unknown>();
    const baseline: { raw: string | null; value: unknown } = { raw: null, value: null };
    const calls: Array<{ expected: string | null; value: unknown }> = [];
    const accepted: Array<{ raw: string | null; value: unknown }> = [];
    const writer = createRendererRecommendationPinWriter({
      readBaseline: async () => baseline,
      async saveNative(expected, value) {
        calls.push({ expected, value: structuredClone(value) });
        if (calls.length === 1) await gate.promise;
        const current = baseline.value === null ? [] : baseline.value as Record<string, unknown>[];
        const next = value.kind === "append" ? [...current, value.pin] : current;
        return { version: 1, changed: true, raw: JSON.stringify(next) };
      },
      accept(raw, value) {
        baseline.raw = raw;
        baseline.value = value;
        accepted.push({ raw, value });
      },
      isDisposed: () => false,
    });
    const mutable = pin("/plugins/first");
    const first = writer.save([mutable]);
    mutable.name = "mutated after call";
    const second = writer.save([pin("/plugins/first"), pin("/plugins/second")]);
    await settlePromises();

    expect(calls).toHaveLength(1);
    gate.resolve({});
    await Promise.all([first, second]);
    expect(calls).toEqual([
      { expected: null, value: { kind: "append", pin: pin("/plugins/first") } },
      {
        expected: JSON.stringify([pin("/plugins/first")]),
        value: { kind: "append", pin: pin("/plugins/second") },
      },
    ]);
    expect(accepted.map(({ value }) => value)).toEqual([
      [pin("/plugins/first")],
      [pin("/plugins/first"), pin("/plugins/second")],
    ]);
    writer.dispose();
  });

  it("rejects queued writes on dispose and never accepts a late native receipt", async () => {
    const gate = deferred<unknown>();
    const saved = vi.fn(async () => gate.promise);
    const accepted = vi.fn();
    const writer = createRendererRecommendationPinWriter({
      readBaseline: async () => ({ raw: null, value: null }),
      saveNative: saved,
      accept: accepted,
      isDisposed: () => false,
    });
    const active = writer.save([pin("/plugins/active")]);
    await settlePromises();
    const queued = Array.from({ length: 31 }, (_, index) =>
      writer.save([pin(`/plugins/queued-${index}`)]),
    );
    let overflowError: unknown;
    try {
      writer.save([pin("/plugins/overflow")]);
    } catch (error) {
      overflowError = error;
    }
    expect(overflowError).toMatchObject({ code: HOST_ERROR_CODES.INVALID_ARGUMENT });
    writer.dispose();

    const queuedResults = await Promise.allSettled(queued);
    expect(queuedResults).toHaveLength(31);
    expect(queuedResults.every((result) => result.status === "rejected"
      && (result.reason as { code?: string }).code === HOST_ERROR_CODES.DISPOSED)).toBe(true);
    expect(saved).toHaveBeenCalledTimes(1);
    gate.resolve({ version: 1, changed: true, raw: JSON.stringify([pin("/plugins/active")]) });
    await expect(active).rejects.toMatchObject({ code: HOST_ERROR_CODES.DISPOSED });
    expect(accepted).not.toHaveBeenCalled();
    expect(saved).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-exact receipt without advancing the local cache", async () => {
    const accepted = vi.fn();
    const writer = createRendererRecommendationPinWriter({
      readBaseline: async () => ({ raw: null, value: null }),
      saveNative: async () => ({ version: 1, changed: true, raw: "[]", path: "/private/path" }),
      accept: accepted,
      isDisposed: () => false,
    });
    await expect(writer.save([pin("/plugins/a")])).rejects.toMatchObject({
      code: HOST_ERROR_CODES.INVALID_RESPONSE,
    });
    expect(accepted).not.toHaveBeenCalled();
    writer.dispose();
  });

  it("validates and bounds the exact raw string returned in a receipt", async () => {
    const malformed = createRendererRecommendationPinWriter({
      readBaseline: async () => ({ raw: null, value: null }),
      saveNative: async () => ({ version: 1, changed: true, raw: "not-json" }),
      accept: () => undefined,
      isDisposed: () => false,
    });
    await expect(malformed.save([pin("/plugins/a")])).rejects.toMatchObject({
      code: HOST_ERROR_CODES.INVALID_RESPONSE,
    });
    malformed.dispose();

    const oversized = createRendererRecommendationPinWriter({
      readBaseline: async () => ({ raw: null, value: null }),
      saveNative: async () => ({ version: 1, changed: true, raw: " ".repeat(128 * 1024 + 1) }),
      accept: () => undefined,
      isDisposed: () => false,
    });
    await expect(oversized.save([pin("/plugins/a")])).rejects.toMatchObject({
      code: HOST_ERROR_CODES.INVALID_RESPONSE,
    });
    oversized.dispose();
  });

  it("keeps a successful write ahead of an older pending read", async () => {
    const oldRead = deferred<unknown>();
    const readModel = createStartupReadModel(async () => oldRead.promise, async (method) => {
      throw new Error(`unsupported:${method}`);
    });
    const pending = readModel.dbGet("recommendation-pinned");
    const written = [pin("/plugins/new")];
    const raw = JSON.stringify(written);
    readModel.acceptWrittenRecommendationPins(raw, written);
    oldRead.resolve(JSON.stringify([pin("/plugins/old")]));

    await expect(pending).resolves.toEqual(written);
    await expect(readModel.dbGet("recommendation-pinned")).resolves.toEqual(written);
    await expect(readModel.getRecommendationPinState()).resolves.toEqual({ raw, value: written });
    expect(readModel.snapshot().readModelDefaults).not.toContain("recommendation-pinned");
    readModel.dispose();
  });

  it("keeps the startup snapshot's exact raw text without an additional read", async () => {
    const raw = '[{"path":"/p","name":"P","type":"plugin","amount":9007199254740993,"ratio":0.123456789123456789}]';
    const getSetting = vi.fn(async () => raw);
    const readModel = createStartupReadModel(getSetting, async (method) => {
      throw new Error(`unsupported:${method}`);
    });

    const state = await readModel.getRecommendationPinState();
    await readModel.dbGet("recommendation-pinned");
    expect(state.raw).toBe(raw);
    expect(state.value).toEqual(JSON.parse(raw));
    expect(getSetting).toHaveBeenCalledTimes(1);
    readModel.dispose();
  });

  it("infers only original append, first removal, first move-to-front, or identity noop", () => {
    expect(inferRecommendationPinMutation(null, [])).toEqual({ kind: "noop" });
    const firstDuplicate = { ...pin("/x/first"), pluginName: "package-x", featureCode: "open" };
    const other = pin("/other");
    const secondDuplicate = {
      ...pin("/x/second"), pluginName: "package-x", featureCode: "open", extraMetadata: { keep: true },
    };
    const baseline = [firstDuplicate, other, secondDuplicate];

    expect(inferRecommendationPinMutation(baseline, [other, secondDuplicate])).toEqual({ kind: "remove", index: 0 });
    expect(() => inferRecommendationPinMutation(baseline, [firstDuplicate, other]))
      .toThrow();
    const repeated = [firstDuplicate, secondDuplicate, other];
    expect(inferRecommendationPinMutation(repeated, [secondDuplicate, other])).toEqual({ kind: "remove", index: 0 });
    expect(inferRecommendationPinMutation([other, firstDuplicate, secondDuplicate], [firstDuplicate, other, secondDuplicate]))
      .toEqual({ kind: "moveToFront", index: 1 });
    const moveWithSeparatedDuplicate = [other, firstDuplicate, pin("/middle"), secondDuplicate];
    expect(inferRecommendationPinMutation(moveWithSeparatedDuplicate, [
      firstDuplicate, other, pin("/middle"), secondDuplicate,
    ])).toEqual({ kind: "moveToFront", index: 1 });
    expect(inferRecommendationPinMutation(baseline, [
      { ...firstDuplicate, extraMetadata: { callerEdit: true } }, other, secondDuplicate,
    ])).toEqual({ kind: "noop" });
    expect(inferRecommendationPinMutation([firstDuplicate], [firstDuplicate, other]))
      .toEqual({ kind: "append", pin: other });
    expect(() => inferRecommendationPinMutation(baseline, [firstDuplicate, secondDuplicate, other]))
      .toThrow();
  });

  it("uses the lossless raw CAS baseline and sends only a new append row", async () => {
    const raw = '[{"path":"/plugins/old","name":"Old","type":"plugin","pluginName":"pkg","featureCode":"open","largeInteger":9007199254740993,"preciseDecimal":0.123456789123456789}]';
    const baselineValue = JSON.parse(raw) as Record<string, unknown>[];
    const appended = pin("/plugins/new");
    const nextRaw = `${raw.slice(0, -1)},${JSON.stringify(appended)}]`;
    const current: { raw: string | null; value: unknown } = { raw, value: baselineValue };
    const saveNative = vi.fn(async (expected: string | null, mutation: { kind: string }) => ({
      version: 1,
      changed: mutation.kind !== "noop",
      raw: mutation.kind === "noop" ? expected : nextRaw,
    }));
    const accept = vi.fn((acceptedRaw: string | null, value: unknown) => {
      current.raw = acceptedRaw;
      current.value = value;
    });
    const writer = createRendererRecommendationPinWriter({
      readBaseline: async () => current,
      saveNative,
      accept,
      isDisposed: () => false,
    });

    await writer.save([...baselineValue, appended]);
    expect(saveNative).toHaveBeenCalledWith(raw, { kind: "append", pin: appended });
    const desiredWithCallerMetadataEdit = structuredClone(current.value) as Record<string, unknown>[];
    desiredWithCallerMetadataEdit[0]!.largeInteger = 1;
    await writer.save(desiredWithCallerMetadataEdit);
    expect(saveNative).toHaveBeenNthCalledWith(2, nextRaw, { kind: "noop" });
    expect(accept).toHaveBeenLastCalledWith(nextRaw, expect.any(Array));
    expect(current.raw).toBe(nextRaw);
    writer.dispose();
  });
});

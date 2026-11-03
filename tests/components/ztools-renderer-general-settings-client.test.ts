import { describe, expect, it, vi } from "vitest";
import {
  createRendererGeneralSettingsClient,
  RendererGeneralSettingsOutcomeUnknownError,
} from "../../packages/ztools-renderer/src/generalSettingsClient";

type LoadReply = { version: number; raw: string | null };
type MutationRequest = { expected: string | null; changes: Record<string, unknown> };
type MutationReply = { version: number; raw: string; notificationDelivered: boolean };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function loadReply(raw: string | null): LoadReply {
  return { version: 1, raw };
}

function mutationReply(raw: string, notificationDelivered = true): MutationReply {
  return { version: 1, raw, notificationDelivered };
}

function mergeRaw(raw: string | null, changes: Record<string, unknown>): string {
  const base = raw === null ? {} : JSON.parse(raw) as Record<string, unknown>;
  return JSON.stringify({ ...base, ...changes });
}

function createFakeNativeStore(initial: Record<string, unknown>) {
  let raw = JSON.stringify(initial);
  return {
    load: vi.fn(async () => loadReply(raw)),
    raw: () => raw,
    apply(expected: string | null, changes: Record<string, unknown>) {
      if (expected !== raw) throw new Error("General settings changed; reload before applying the patch");
      raw = mergeRaw(raw, changes);
      return raw;
    },
  };
}

describe("ZTools renderer General settings client", () => {
  it("coalesces concurrent reads and returns snapshots detached from its cache", async () => {
    const gate = deferred<LoadReply>();
    const raw = JSON.stringify({ theme: "dark", unknown: { nested: [1, "kept"] } });
    const load = vi.fn(() => gate.promise);
    const client = createRendererGeneralSettingsClient({
      load,
      mutate: vi.fn(async () => null),
    });

    const first = client.load();
    const second = client.load();
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    gate.resolve(loadReply(raw));
    const [firstValue, secondValue] = await Promise.all([first, second]);
    expect(firstValue).toEqual({ theme: "dark", unknown: { nested: [1, "kept"] } });
    expect(secondValue).toEqual(firstValue);

    (firstValue.unknown as { nested: unknown[] }).nested[1] = "caller mutation";
    expect(secondValue.unknown).toEqual({ nested: [1, "kept"] });
    expect(client.snapshot()).toEqual({
      version: 1,
      cached: true,
      loadInFlight: false,
      pendingSaves: 0,
      loadRequests: 1,
      loadFailures: 0,
      saveRequests: 0,
      saveFailures: 0,
      committedWrites: 0,
      notificationFailures: 0,
      callbackErrors: 0,
      disposed: false,
    });
    expect(JSON.stringify(client.snapshot())).not.toContain(raw);
  });

  it("treats a missing raw value as empty without writing defaults", async () => {
    const load = vi.fn(async () => loadReply(null));
    const mutate = vi.fn(async ({ expected, changes }: MutationRequest) => {
      expect(expected).toBeNull();
      return mutationReply(JSON.stringify(changes));
    });
    const client = createRendererGeneralSettingsClient({ load, mutate });

    await expect(client.load()).resolves.toEqual({});
    expect(client.snapshot()).toMatchObject({ cached: true, loadInFlight: false, loadRequests: 1 });
    expect(mutate).not.toHaveBeenCalled();
    const result = await client.save({ theme: "dark" });
    expect(result.snapshot).toEqual({ theme: "dark" });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("serializes queued saves against the latest raw value and preserves unknown fields", async () => {
    const initialRaw = JSON.stringify({ theme: "light", unknown: { keep: true } });
    let storedRaw: string | null = initialRaw;
    const loadGate = deferred<LoadReply>();
    const committed: unknown[] = [];
    const mutate = vi.fn(async ({ expected, changes }: MutationRequest) => {
      if (expected !== storedRaw) throw new Error("General settings changed; reload before applying the patch");
      storedRaw = mergeRaw(storedRaw, changes);
      return mutationReply(storedRaw);
    });
    const client = createRendererGeneralSettingsClient({
      load: vi.fn(() => loadGate.promise),
      mutate,
      onCommitted: (settings) => committed.push(settings),
    });

    const firstSave = client.save({ theme: "dark" });
    const secondSave = client.save({ placeholder: "Search" });
    await vi.waitFor(() => expect(client.snapshot().loadInFlight).toBe(true));
    expect(mutate).not.toHaveBeenCalled();
    loadGate.resolve(loadReply(initialRaw));

    const first = await firstSave;
    const second = await secondSave;
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(mutate.mock.calls[0][0]).toEqual({ expected: initialRaw, changes: { theme: "dark" } });
    expect(mutate.mock.calls[1][0].expected).not.toBe(initialRaw);
    expect(JSON.parse(mutate.mock.calls[1][0].expected as string).theme).toBe("dark");
    expect(second.snapshot).toEqual({
      theme: "dark",
      placeholder: "Search",
      unknown: { keep: true },
    });
    expect(first.notificationDelivered).toBe(true);
    expect(second.notificationDelivered).toBe(true);
    expect(committed).toHaveLength(2);

    (first.snapshot.unknown as { keep: boolean }).keep = false;
    expect(second.snapshot.unknown).toEqual({ keep: true });
    expect((committed[1] as Record<string, unknown>).unknown).toEqual({ keep: true });
  });

  it("rejects the 33rd pending save without changing the existing queue", async () => {
    let storedRaw: string | null = JSON.stringify({ theme: "light" });
    let firstReceiptRaw = "";
    const firstReceipt = deferred<MutationReply>();
    const mutate = vi.fn(async ({ expected, changes }: MutationRequest) => {
      expect(expected).toBe(storedRaw);
      storedRaw = mergeRaw(storedRaw, changes);
      if (mutate.mock.calls.length === 1) {
        firstReceiptRaw = storedRaw;
        return firstReceipt.promise;
      }
      return mutationReply(storedRaw);
    });
    const client = createRendererGeneralSettingsClient({
      load: vi.fn(async () => loadReply(storedRaw)),
      mutate,
    });
    await client.load();

    const accepted = [client.save({ theme: "dark" })];
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    for (let index = 1; index < 32; index += 1) {
      accepted.push(client.save({ placeholder: `Search ${index}` }));
    }

    expect(client.snapshot()).toMatchObject({ pendingSaves: 32, saveRequests: 32 });
    await expect(client.save({ placeholder: "overflow" })).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT",
      message: "Renderer General settings write queue is full.",
    });
    expect(client.snapshot()).toMatchObject({ pendingSaves: 32, saveRequests: 32 });
    expect(mutate).toHaveBeenCalledTimes(1);

    firstReceipt.resolve(mutationReply(firstReceiptRaw));
    await Promise.all(accepted);
    expect(mutate).toHaveBeenCalledTimes(32);
    expect(client.snapshot()).toMatchObject({ pendingSaves: 0, committedWrites: 32 });
  });

  it("does not retry a compare-and-swap failure or change the cached snapshot", async () => {
    const raw = JSON.stringify({ theme: "light", unknown: "preserved" });
    const conflict = new Error("General settings changed; reload before applying the patch");
    const load = vi.fn(async () => loadReply(raw));
    const mutate = vi.fn(async () => { throw conflict; });
    const onCommitted = vi.fn();
    const client = createRendererGeneralSettingsClient({ load, mutate, onCommitted });

    await client.load();
    await expect(client.save({ theme: "dark" })).rejects.toBe(conflict);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(onCommitted).not.toHaveBeenCalled();
    expect(client.snapshot()).toMatchObject({ committedWrites: 0, saveFailures: 1 });

    const secondRead = await client.load();
    expect(secondRead).toEqual({ theme: "light", unknown: "preserved" });
    expect(secondRead.theme).toBe("light");
  });

  it("does not let a read that finishes after a commit replace the fresh expected raw", async () => {
    const initialRaw = JSON.stringify({ theme: "light", unknown: { value: 7 } });
    const freshRaw = JSON.stringify({ theme: "dark", unknown: { value: 7 } });
    const lateRead = deferred<LoadReply>();
    const firstWrite = deferred<MutationReply>();
    let storedRaw: string | null = initialRaw;
    const load = vi.fn()
      .mockResolvedValueOnce(loadReply(initialRaw))
      .mockImplementationOnce(() => lateRead.promise);
    const mutate = vi.fn(async ({ expected, changes }: MutationRequest) => {
      if (expected !== storedRaw) throw new Error("stale expected raw");
      if (mutate.mock.calls.length === 1) return firstWrite.promise;
      storedRaw = mergeRaw(storedRaw, changes);
      return mutationReply(storedRaw);
    });
    const client = createRendererGeneralSettingsClient({ load, mutate });

    await client.load();
    const save = client.save({ theme: "dark" });
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    const late = client.load();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));

    storedRaw = freshRaw;
    firstWrite.resolve(mutationReply(freshRaw));
    await save;
    lateRead.resolve(loadReply(initialRaw));
    await expect(late).resolves.toEqual({ theme: "dark", unknown: { value: 7 } });

    await client.save({ placeholder: "still fresh" });
    expect(mutate.mock.calls[1][0].expected).toBe(freshRaw);
  });

  it("treats notification failure as a committed write and never retries it", async () => {
    const committed: unknown[] = [];
    const initialRaw = JSON.stringify({ theme: "system", unknown: "kept" });
    const finalRaw = JSON.stringify({ theme: "dark", unknown: "kept" });
    const mutate = vi.fn(async () => mutationReply(finalRaw, false));
    const client = createRendererGeneralSettingsClient({
      load: vi.fn(async () => loadReply(initialRaw)),
      mutate,
      onCommitted: (settings) => committed.push(settings),
    });

    const result = await client.save({ theme: "dark" });
    expect(result).toEqual({
      snapshot: { theme: "dark", unknown: "kept" },
      notificationDelivered: false,
    });
    expect(committed).toEqual([{ theme: "dark", unknown: "kept" }]);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(client.snapshot()).toMatchObject({
      committedWrites: 1,
      notificationFailures: 1,
      saveFailures: 0,
    });
  });

  it("keeps the native commit successful if the post-commit observer throws", async () => {
    const initialRaw = JSON.stringify({ theme: "light" });
    const finalRaw = JSON.stringify({ theme: "dark" });
    const mutate = vi.fn(async () => mutationReply(finalRaw));
    const onCommitted = vi.fn(() => { throw new Error("observer failure"); });
    const client = createRendererGeneralSettingsClient({
      load: vi.fn(async () => loadReply(initialRaw)),
      mutate,
      onCommitted,
    });

    await expect(client.save({ theme: "dark" })).resolves.toMatchObject({
      snapshot: { theme: "dark" },
      notificationDelivered: true,
    });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(client.snapshot()).toMatchObject({
      committedWrites: 1,
      saveFailures: 0,
      callbackErrors: 1,
    });
  });

  it("rejects invalid editable values before reading or mutating native state", async () => {
    const load = vi.fn(async () => loadReply(null));
    const mutate = vi.fn(async () => null);
    const client = createRendererGeneralSettingsClient({ load, mutate });
    const dangerous = Object.create(null) as Record<string, unknown>;
    dangerous.theme = "dark";
    Object.defineProperty(dangerous, "__proto__", { value: "polluted", enumerable: true });
    const invalidChanges = [
      {},
      { unsupportedSetting: "value" },
      { theme: "system-dark" },
      { primaryColor: "cyan" },
      { customColor: "#12345g" },
      { autoClear: "30m" },
      { showRecentInSearch: true },
      { recentRows: 3 },
      { pinnedRows: 2 },
      { searchMode: "list" },
      { showMatchRecommendation: false },
      { tabKeyFunction: "navigate" },
      { tabTargetCommand: "open docs" },
      { spaceOpenCommand: true },
      { placeholder: "line\nbreak" },
      { placeholder: "界".repeat(171) },
      dangerous,
    ];

    for (const changes of invalidChanges) {
      await expect(client.save(changes)).rejects.toMatchObject({
        code: "ERR_ATOOLS_ZTOOLS_INVALID_ARGUMENT",
      });
    }
    expect(load).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it.each([
    ["non-object JSON", '"secret"'],
    ["prototype key", '{"__proto__":{"polluted":true}}'],
    ["constructor key", '{"constructor":{"polluted":true}}'],
    ["oversized raw", `{"unknown":"${"x".repeat(64 * 1024)}"}`],
  ])("rejects a General settings response with %s without exposing its raw", async (_label, raw) => {
    const client = createRendererGeneralSettingsClient({
      load: vi.fn(async () => loadReply(raw)),
      mutate: vi.fn(async () => null),
    });

    await expect(client.load()).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_INVALID_RESPONSE" });
    expect(client.snapshot()).toMatchObject({ cached: false, loadFailures: 1 });
    expect(JSON.stringify(client.snapshot())).not.toContain("polluted");
  });

  it("accepts exactly 64 KiB raw JSON and rejects the next UTF-8 byte", async () => {
    const prefix = '{"unknown":"';
    const suffix = '"}';
    const exactRaw = prefix + "x".repeat(64 * 1024 - prefix.length - suffix.length) + suffix;
    const accepted = createRendererGeneralSettingsClient({
      load: vi.fn(async () => loadReply(exactRaw)),
      mutate: vi.fn(async () => mutationReply(exactRaw)),
    });
    const acceptedValue = await accepted.load();
    expect((acceptedValue.unknown as string).length).toBe(64 * 1024 - prefix.length - suffix.length);

    const rejected = createRendererGeneralSettingsClient({
      load: vi.fn(async () => loadReply(`${exactRaw} `)),
      mutate: vi.fn(async () => mutationReply(exactRaw)),
    });
    await expect(rejected.load()).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_INVALID_RESPONSE" });
  });

  it("rejects an invalid or mismatched committed receipt without applying local side effects", async () => {
    const onCommitted = vi.fn();
    const client = createRendererGeneralSettingsClient({
      load: vi.fn(async () => loadReply(JSON.stringify({ theme: "light" }))),
      mutate: vi.fn(async () => mutationReply(JSON.stringify({ theme: "system" }))),
      onCommitted,
    });

    await expect(client.save({ theme: "dark" })).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_INVALID_RESPONSE",
    });
    expect(onCommitted).not.toHaveBeenCalled();
    expect(client.snapshot()).toMatchObject({ committedWrites: 0, saveFailures: 1 });
  });

  it("rejects in-flight reads and writes on dispose and ignores their late receipts", async () => {
    const loadGate = deferred<LoadReply>();
    const load = vi.fn(() => loadGate.promise);
    const mutate = vi.fn(async () => null);
    const client = createRendererGeneralSettingsClient({ load, mutate });
    const read = client.load();
    const write = client.save({ theme: "dark" });
    await Promise.resolve();

    client.dispose();
    await expect(read).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" });
    await expect(write).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" });
    await expect(client.load()).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" });
    await expect(client.save({ theme: "light" })).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_DISPOSED",
    });

    loadGate.resolve(loadReply(JSON.stringify({ theme: "light" })));
    await vi.waitFor(() => expect(client.snapshot().loadInFlight).toBe(false));
    expect(mutate).not.toHaveBeenCalled();
    expect(client.snapshot()).toMatchObject({ cached: false, disposed: true });
  });

  it("does not start the native read if disposed before its loader microtask", async () => {
    const load = vi.fn(async () => loadReply(null));
    const client = createRendererGeneralSettingsClient({ load, mutate: vi.fn(async () => null) });
    const read = client.load();

    client.dispose();
    await expect(read).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" });
    await Promise.resolve();
    await Promise.resolve();
    expect(load).not.toHaveBeenCalled();
    expect(client.snapshot()).toMatchObject({ cached: false, loadInFlight: false, disposed: true });
  });

  it("reports an unknown dispatched outcome and recovers the persisted value with a new client", async () => {
    const writeGate = deferred<MutationReply>();
    const nativeStore = createFakeNativeStore({ theme: "light", unknown: "preserved" });
    const onCommitted = vi.fn();
    const mutate = vi.fn(async ({ expected, changes }: MutationRequest) => {
      nativeStore.apply(expected, changes);
      return writeGate.promise;
    });
    const client = createRendererGeneralSettingsClient({
      load: nativeStore.load,
      mutate,
      onCommitted,
    });
    await client.load();
    const write = client.save({ theme: "dark" });
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(JSON.parse(nativeStore.raw()).theme).toBe("dark");
    client.dispose();
    const outcome = await write.then(() => undefined, (error: unknown) => error);
    expect(outcome).toBeInstanceOf(RendererGeneralSettingsOutcomeUnknownError);
    expect(outcome).toMatchObject({
      code: "ERR_ATOOLS_GENERAL_SETTINGS_OUTCOME_UNKNOWN",
      requiresReload: true,
    });
    expect(onCommitted).not.toHaveBeenCalled();

    const reloaded = createRendererGeneralSettingsClient({
      load: nativeStore.load,
      mutate: vi.fn(async () => null),
    });
    await expect(reloaded.load()).resolves.toEqual({ theme: "dark", unknown: "preserved" });

    writeGate.resolve(mutationReply(nativeStore.raw()));
    await vi.waitFor(() => expect(client.snapshot().pendingSaves).toBe(0));
    expect(onCommitted).not.toHaveBeenCalled();
    expect(client.snapshot()).toMatchObject({ cached: false, committedWrites: 0, disposed: true });
  });

  it("keeps a queued save undispatched when an earlier committed save has an unknown outcome", async () => {
    const writeGate = deferred<MutationReply>();
    const nativeStore = createFakeNativeStore({ theme: "light", unknown: "preserved" });
    const onCommitted = vi.fn();
    const mutate = vi.fn(async ({ expected, changes }: MutationRequest) => {
      nativeStore.apply(expected, changes);
      return writeGate.promise;
    });
    const client = createRendererGeneralSettingsClient({
      load: nativeStore.load,
      mutate,
      onCommitted,
    });
    await client.load();

    const first = client.save({ theme: "dark" });
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    const second = client.save({ placeholder: "must not persist" });
    expect(JSON.parse(nativeStore.raw())).toEqual({ theme: "dark", unknown: "preserved" });
    expect(client.snapshot().pendingSaves).toBe(2);

    client.dispose();
    const [firstOutcome, secondOutcome] = await Promise.all([
      first.then(() => undefined, (error: unknown) => error),
      second.then(() => undefined, (error: unknown) => error),
    ]);
    expect(firstOutcome).toBeInstanceOf(RendererGeneralSettingsOutcomeUnknownError);
    expect(firstOutcome).toMatchObject({
      code: "ERR_ATOOLS_GENERAL_SETTINGS_OUTCOME_UNKNOWN",
      requiresReload: true,
    });
    expect(secondOutcome).toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" });

    writeGate.resolve(mutationReply(nativeStore.raw()));
    await vi.waitFor(() => expect(client.snapshot().pendingSaves).toBe(0));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(JSON.parse(nativeStore.raw())).toEqual({ theme: "dark", unknown: "preserved" });
    expect(onCommitted).not.toHaveBeenCalled();

    const reloaded = createRendererGeneralSettingsClient({
      load: nativeStore.load,
      mutate: vi.fn(async () => null),
    });
    await expect(reloaded.load()).resolves.toEqual({ theme: "dark", unknown: "preserved" });
  });
});

import { describe, expect, it, vi } from "vitest";
import { createRendererSettingsSnapshot } from "../../packages/ztools-renderer/src/settingsSnapshot";
import { NAMESPACED_READ_KEYS } from "../../packages/ztools-renderer/src/startupReadModel";

const NATIVE_KEYS = [
  "settings-general",
  ...[...NAMESPACED_READ_KEYS].map((key) => `ztools-renderer:${key}`),
];

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const settings: Record<string, unknown> = Object.fromEntries(
    NATIVE_KEYS.map((key) => [key, `value:${key}`]),
  );
  Object.assign(settings, overrides);
  return { version: 1, settings };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("renderer settings snapshot", () => {
  it("shares one batch request across concurrent reads of all 14 fixed keys", async () => {
    const payload = validPayload();
    const load = vi.fn(async () => payload);
    const snapshot = createRendererSettingsSnapshot(load);

    const values = await Promise.all(NATIVE_KEYS.map((key) => snapshot.read(key)));

    expect(load).toHaveBeenCalledTimes(1);
    expect(values).toEqual(NATIVE_KEYS.map((key) => `value:${key}`));
    expect(snapshot.snapshot()).toEqual({
      cached: 14,
      inFlight: false,
      requests: 1,
      failures: 0,
      disposed: false,
    });
  });

  it("rejects unknown native keys before invoking the loader without echoing the key", async () => {
    const secret = "unknown-key-secret";
    const load = vi.fn(async () => validPayload());
    const snapshot = createRendererSettingsSnapshot(load);

    await expect(snapshot.read(secret)).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_UNSUPPORTED",
    });
    expect(load).not.toHaveBeenCalled();
    expect(snapshot.snapshot().requests).toBe(0);
    expect(snapshot.snapshot()).not.toHaveProperty("secret");
  });

  it.each([
    ["extra top-level fields", () => ({ ...validPayload(), debug: "private-value" })],
    ["missing version", () => ({ settings: (validPayload().settings) })],
    ["unsupported version", () => ({ ...validPayload(), version: 2 })],
    ["extra setting keys", () => validPayload({ unexpected: "private-value" })],
    ["missing setting keys", () => {
      const payload = validPayload();
      delete (payload.settings as Record<string, unknown>)[NATIVE_KEYS[0]];
      return payload;
    }],
    ["non-string setting values", () => validPayload({ [NATIVE_KEYS[0]]: 42 })],
  ])("rejects %s and keeps diagnostics free of setting contents", async (_label, makePayload) => {
    const secret = "private-value";
    const snapshot = createRendererSettingsSnapshot(async () => makePayload());

    await expect(snapshot.read(NATIVE_KEYS[0])).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_INVALID_RESPONSE",
    });
    expect(JSON.stringify(snapshot.snapshot())).not.toContain(secret);
    expect(snapshot.snapshot()).toMatchObject({ cached: 0, failures: 1 });
  });

  it("enforces the exact UTF-8 byte boundaries for general and namespaced settings", async () => {
    const generalBoundary = "😀".repeat(16_384);
    const namespacedBoundary = "😀".repeat(32_768);
    const exact = validPayload({
      "settings-general": generalBoundary,
      [NATIVE_KEYS[2]]: namespacedBoundary,
    });
    const accepted = createRendererSettingsSnapshot(async () => exact);
    await expect(accepted.read("settings-general")).resolves.toBe(generalBoundary);

    for (const [key, value] of [
      ["settings-general", `${generalBoundary}😀`],
      [NATIVE_KEYS[2], `${namespacedBoundary}😀`],
    ]) {
      const rejected = createRendererSettingsSnapshot(async () => validPayload({ [key]: value }));
      await expect(rejected.read(key)).rejects.toMatchObject({
        code: "ERR_ATOOLS_ZTOOLS_INVALID_RESPONSE",
      });
    }
  });

  it("allows the alias-only 512 KiB projection while retaining other namespace and total limits", async () => {
    const aliasesBoundary = JSON.stringify("a".repeat(512 * 1024 - 2));
    expect(new TextEncoder().encode(aliasesBoundary).byteLength).toBe(512 * 1024);
    const accepted = createRendererSettingsSnapshot(async () => validPayload({
      "ztools-renderer:command-aliases": aliasesBoundary,
    }));
    await expect(accepted.read("ztools-renderer:command-aliases")).resolves.toBe(aliasesBoundary);

    for (const [key, value] of [
      ["ztools-renderer:command-aliases", `${JSON.stringify("a".repeat(512 * 1024 - 2))}a`],
      [NATIVE_KEYS[2], "x".repeat(128 * 1024 + 1)],
    ]) {
      const rejected = createRendererSettingsSnapshot(async () => validPayload({ [key]: value }));
      await expect(rejected.read(key)).rejects.toMatchObject({
        code: "ERR_ATOOLS_ZTOOLS_INVALID_RESPONSE",
      });
    }
  });

  it("counts fixed key names and values in the exact 1 MiB UTF-8 budget", async () => {
    const keyBytes = NATIVE_KEYS.reduce((total, key) => total + new TextEncoder().encode(key).byteLength, 0);
    const valueBudget = 1024 * 1024 - keyBytes;
    const exactValues: Record<string, unknown> = Object.fromEntries(NATIVE_KEYS.map((key) => [key, null]));
    exactValues["settings-general"] = "g".repeat(64 * 1024);
    let usedValueBytes = 64 * 1024;
    let lastValueKey: string | undefined;

    for (const key of NATIVE_KEYS.slice(1)) {
      const valueBytes = Math.min(128 * 1024, valueBudget - usedValueBytes);
      if (valueBytes <= 0) break;
      exactValues[key] = "a".repeat(valueBytes);
      usedValueBytes += valueBytes;
      lastValueKey = key;
    }
    expect(usedValueBytes).toBe(valueBudget);

    const exact = createRendererSettingsSnapshot(async () => validPayload(exactValues));
    await expect(exact.read("settings-general")).resolves.toBe(exactValues["settings-general"]);
    expect(exact.snapshot().cached).toBe(14);

    const overValues = {
      ...exactValues,
      [lastValueKey as string]: `${String(exactValues[lastValueKey as string])}a`,
    };
    const over = createRendererSettingsSnapshot(async () => validPayload(overValues));
    await expect(over.read(NATIVE_KEYS[0])).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_INVALID_RESPONSE",
    });
    expect(over.snapshot()).toMatchObject({ cached: 0, failures: 1 });
  });

  it("sanitizes load errors and allows a failed batch request to retry", async () => {
    const secret = "provider-secret-value";
    const load = vi.fn()
      .mockRejectedValueOnce(new Error(secret))
      .mockResolvedValueOnce(validPayload());
    const snapshot = createRendererSettingsSnapshot(load);

    const firstError = await snapshot.read(NATIVE_KEYS[0]).catch((error: unknown) => error);
    expect(firstError).toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_INVALID_RESPONSE",
      message: "Invalid batched renderer settings response",
    });
    expect(String(firstError)).not.toContain(secret);
    await expect(snapshot.read(NATIVE_KEYS[0])).resolves.toBe(`value:${NATIVE_KEYS[0]}`);
    expect(load).toHaveBeenCalledTimes(2);
    expect(snapshot.snapshot()).toEqual({
      cached: 14,
      inFlight: false,
      requests: 2,
      failures: 1,
      disposed: false,
    });
  });

  it("rejects in-flight reads on dispose and never caches a late result", async () => {
    const gate = deferred<unknown>();
    const load = vi.fn(() => gate.promise);
    const snapshot = createRendererSettingsSnapshot(load);
    const firstRead = snapshot.read(NATIVE_KEYS[0]);
    const secondRead = snapshot.read(NATIVE_KEYS[1]);

    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    expect(snapshot.snapshot().inFlight).toBe(true);
    snapshot.dispose();

    await expect(firstRead).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" });
    await expect(secondRead).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" });
    await expect(snapshot.read(NATIVE_KEYS[0])).rejects.toMatchObject({
      code: "ERR_ATOOLS_ZTOOLS_DISPOSED",
    });

    gate.resolve(validPayload());
    await vi.waitFor(() => expect(snapshot.snapshot().inFlight).toBe(false));
    expect(snapshot.snapshot()).toEqual({
      cached: 0,
      inFlight: false,
      requests: 1,
      failures: 0,
      disposed: true,
    });
  });

});

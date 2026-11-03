import { describe, expect, it, vi } from "vitest";
import { createZtoolsRendererHostAdapter } from "../../packages/ztools-renderer/src/hostAdapter";
import type { ZToolsRendererTransport } from "../../packages/ztools-renderer/src/types";

const candidate = { candidateId: "a".repeat(32), currentVersion: "1", version: "2", date: null, body: "notes" };
function snapshot(sequence = 0, phase = "idle", extra: Record<string, unknown> = {}) {
  return { version: 1, sequence, phase, candidate: null, checked: false, operationId: null, progress: { downloaded: 0, total: null }, error: null, ...extra };
}
function setup() {
  let emit: ((payload: unknown) => void) | undefined;
  const calls: unknown[] = [], unlisten = vi.fn();
  const transport: ZToolsRendererTransport = {
    async invoke(command, args) { calls.push([command, args]); if (command !== "renderer_updater_main") throw Error(command); const op = (args?.request as { op: string }).op; return op === "show" ? { windowId: "b".repeat(32) } : snapshot(); },
    async listen(event, handler) { if (event === "renderer-updater-main-state") emit = handler; return unlisten; },
  };
  return { adapter: createZtoolsRendererHostAdapter({ transport }), calls, unlisten, emit: (v: unknown) => emit?.(v) };
}
describe("original Main updater bridge", () => {
  it("shares a listener, schedules native startup once, maps events and disposes", async () => {
    const f = setup(), available = vi.fn(), start = vi.fn(), failure = vi.fn();
    f.adapter.api.onUpdateAvailable(available); f.adapter.api.onUpdateDownloadStart(start); f.adapter.api.onUpdateDownloadFailed(failure);
    await vi.waitFor(() => expect(f.calls).toContainEqual(["renderer_updater_main", { request: { op: "startup" } }]));
    f.emit(snapshot(2, "available", { checked: true, candidate }));
    f.emit(snapshot(3, "downloading", { checked: true, candidate }));
    f.emit(snapshot(4, "error", { checked: true, candidate, error: { code: "network", message: "failed" } }));
    expect(available).toHaveBeenCalledWith({ version: "2", changelog: "notes" });
    expect(start).toHaveBeenCalledWith({ version: "2" }); expect(failure).toHaveBeenCalledWith({ error: "failed" });
    await expect(f.adapter.api.updater.getDownloadStatus()).rejects.toMatchObject({ code: "network" });
    f.adapter.dispose(); expect(f.unlisten).toHaveBeenCalled();
  });
  it("rejects malformed wire values, ignores stale snapshots, and validates show", async () => {
    const f = setup(); const available = vi.fn(); f.adapter.api.onUpdateAvailable(available);
    await vi.waitFor(() => expect(f.calls.length).toBeGreaterThan(0));
    f.emit(snapshot(5, "available", { checked: true, candidate }));
    f.emit(snapshot(4, "available", { checked: true, candidate: { ...candidate, version: "stale" } }));
    f.emit(snapshot(6, "available", { checked: true, candidate, extra: true }));
    expect(available).toHaveBeenCalledTimes(1);
    expect(await f.adapter.api.updater.getDownloadStatus()).toMatchObject({ status: "available", version: "2" });
    expect(await f.adapter.api.updater.showUpdateWindow()).toEqual({ success: true });
    f.adapter.dispose();
  });
});

describe("updater closed wire and caller recovery", () => {
  function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
  function fixture(read: (op: string) => unknown) {
    const transport: ZToolsRendererTransport = {
      async invoke(_command, args) { return read((args?.request as { op: string }).op); },
      async listen() { return () => undefined; },
    };
    return createZtoolsRendererHostAdapter({ transport });
  }
  const ready = () => snapshot(1, "available", { checked: true, candidate });
  it("accepts exact UTF-8 limits and rejects encoded expansion, overflow, missing and unknown fields", async () => {
    const maximum = { ...candidate, currentVersion: "中".repeat(42) + "ab", version: "é".repeat(64), date: "🐈".repeat(32), body: "b".repeat(48 * 1024) };
    const overWire = { ...candidate, body: "\0".repeat(11000) };
    const symbol = ready(); Object.defineProperty(symbol, Symbol("extra"), { value: 1 });
    const getter = ready(); Object.defineProperty(getter, "checked", { enumerable: true, get: () => true });
    const bad: unknown[] = [
      snapshot(1, "idle", { extra: 1 }), { ...ready(), progress: {} },
      snapshot(1, "available", { candidate: { ...candidate, extra: 1 } }),
      snapshot(1, "available", { candidate: { ...candidate, candidateId: "not-id" } }),
      snapshot(1, "available", { candidate: { ...candidate, currentVersion: "中".repeat(43) } }),
      snapshot(1, "available", { candidate: { ...candidate, version: "é".repeat(65) } }),
      snapshot(1, "available", { candidate: { ...candidate, date: "🐈".repeat(33) } }),
      snapshot(1, "available", { candidate: { ...candidate, body: "b".repeat(48 * 1024 + 1) } }),
      snapshot(1, "available", { candidate: overWire }), snapshot(1, "idle", { operationId: "wrong" }),
      snapshot(Number.MAX_SAFE_INTEGER + 1), snapshot(1, "error", { error: { code: "x", message: "y", extra: 1 } }),
      snapshot(1, "error", { error: { code: "é".repeat(65), message: "y" } }),
      snapshot(1, "error", { error: { code: "x", message: "中".repeat(2731) } }), symbol, getter,
    ];
    let value: unknown = snapshot(1, "available", { checked: true, candidate: maximum });
    const adapter = fixture(() => value);
    expect((await adapter.api.updater.getDownloadStatus()).version).toBe("é".repeat(64));
    for (const item of bad) { value = item; await expect(adapter.api.updater.getDownloadStatus()).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_INVALID_RESPONSE" }); }
    value = snapshot(2, "not-available", { checked: true });
    expect((await adapter.api.updater.getDownloadStatus()).status).toBe("not-available"); adapter.dispose();
  });
  it("shares a pending status, preserves errors and retries, and suppresses results after disposal", async () => {
    const pending = deferred<unknown>(); let count = 0;
    const adapter = fixture(() => { count++; return count === 1 ? pending.promise : snapshot(2, "error", { error: { code: "net", message: "failed" } }); });
    const one = adapter.api.updater.getDownloadStatus(), two = adapter.api.updater.getDownloadStatus();
    await vi.waitFor(() => expect(count).toBe(1)); pending.resolve(ready());
    expect(await one).toEqual(await two); expect(count).toBe(1);
    await expect(adapter.api.updater.getDownloadStatus()).rejects.toMatchObject({ code: "net", message: "failed" });
    adapter.dispose(); await expect(adapter.api.updater.getDownloadStatus()).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" });
    const late = deferred<unknown>(); const second = fixture(() => late.promise); const call = second.api.updater.getDownloadStatus();
    await Promise.resolve(); await Promise.resolve(); second.dispose();
    await expect(call).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_DISPOSED" }); late.resolve(ready());
  });
  it("reports no-update, check errors and invalid show responses without claiming success", async () => {
    let response: unknown = snapshot(1, "not-available", { checked: true });
    const adapter = fixture(() => response);
    expect(await adapter.api.updater.checkUpdate()).toMatchObject({ success: true, hasUpdate: false });
    response = snapshot(2, "error", { error: { code: "net", message: "failed" } });
    expect(await adapter.api.updater.checkUpdate()).toMatchObject({ success: false, error: "failed" });
    response = { windowId: "invalid" };
    await expect(adapter.api.updater.showUpdateWindow()).rejects.toMatchObject({ code: "ERR_ATOOLS_ZTOOLS_INVALID_RESPONSE" });
    adapter.dispose();
  });
  it("keeps transport rejection observable and permits retry", async () => {
    const failure = Object.assign(new Error("transport"), { code: "IPC_FAILED" }); let count = 0;
    const adapter = fixture(() => { if (++count === 1) throw failure; return snapshot(2, "not-available", { checked: true }); });
    await expect(adapter.api.updater.getDownloadStatus()).rejects.toBe(failure);
    expect((await adapter.api.updater.getDownloadStatus()).status).toBe("not-available"); adapter.dispose();
  });
  it("does not issue startup when native event registration fails", async () => {
    const invoke = vi.fn(async () => snapshot());
    const adapter = createZtoolsRendererHostAdapter({ transport: {
      invoke, async listen(event) { if (event === "renderer-updater-main-state") throw Error("registration failed"); return () => undefined; },
    } });
    adapter.api.onUpdateAvailable(vi.fn());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(invoke).not.toHaveBeenCalledWith("renderer_updater_main", { request: { op: "startup" } });
    adapter.dispose();
  });

});

import { describe, expect, it, vi } from "vitest";
import {
  createPluginWorkerDocumentLifecycle,
  type PluginWorkerDocumentLifecycleOptions,
} from "../../src/lib/pluginWorkerDocumentLifecycle";
import type { PluginWorkerShutdownOptions, PluginWorkerShutdownTarget, PluginWorkerShutdownResult } from "../../src/lib/pluginWorkerShutdown";

type Source = Window & { label: string };
type Shutdown = (targets: PluginWorkerShutdownTarget[], options?: PluginWorkerShutdownOptions) => Promise<PluginWorkerShutdownResult>;
function source(label: string): Source {
  return { label, postMessage: vi.fn() } as unknown as Source;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
function makeOptions(overrides: Partial<PluginWorkerDocumentLifecycleOptions> = {}) {
  let index = 0;
  return {
    source: source("current"),
    options: {
      getSource: () => source("unused"),
      randomUUID: () => `00000000-0000-4000-8000-${String(++index).padStart(12, "0")}`,
      ...overrides,
    },
  };
}

describe("plugin worker document lifecycle", () => {
  it("returns an empty result without source or scope and captures the fresh scope on shutdown", async () => {
    const target = source("frame");
    let current: Window | null = null;
    const request = vi.fn<Shutdown>(async () => ({ requested: 1, acknowledged: 1, timedOut: false }));
    const { options } = makeOptions({ getSource: () => current, shutdown: request });
    const lifecycle = createPluginWorkerDocumentLifecycle(options);

    await expect(lifecycle.shutdown()).resolves.toEqual({ requested: 0, acknowledged: 0, timedOut: false });
    expect(request).not.toHaveBeenCalled();
    const scope = lifecycle.freshScope();
    await expect(lifecycle.shutdown()).resolves.toEqual({ requested: 0, acknowledged: 0, timedOut: false });
    expect(request).not.toHaveBeenCalled();
    current = target;
    await expect(lifecycle.shutdown()).resolves.toEqual({ requested: 1, acknowledged: 1, timedOut: false });
    expect(request).toHaveBeenCalledWith([{ source: target, scopeId: scope }], expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(lifecycle.pending).toBe(0);
    expect(lifecycle.blocking).toBe(false);
  });

  it("single-flights duplicate shutdown calls for one source and document scope", async () => {
    const target = source("frame");
    const response = deferred<PluginWorkerShutdownResult>();
    const request = vi.fn<Shutdown>(() => response.promise);
    const { options } = makeOptions({ getSource: () => target, shutdown: request });
    const lifecycle = createPluginWorkerDocumentLifecycle(options);
    const scope = lifecycle.freshScope();
    const first = lifecycle.shutdown();
    const second = lifecycle.shutdown();

    expect(second).toBe(first);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith([{ source: target, scopeId: scope }], expect.any(Object));
    expect(lifecycle.pending).toBe(1);
    expect(lifecycle.blocking).toBe(true);
    response.resolve({ requested: 1, acknowledged: 1, timedOut: false });
    await expect(first).resolves.toEqual({ requested: 1, acknowledged: 1, timedOut: false });
    expect(lifecycle.pending).toBe(0);
    expect(lifecycle.blocking).toBe(false);
  });

  it("keeps an old shutdown bound to its captured scope while a fresh document starts", async () => {
    const target = source("reused-window-proxy");
    const oldResult = deferred<PluginWorkerShutdownResult>();
    const newResult = deferred<PluginWorkerShutdownResult>();
    const request = vi.fn<Shutdown>()
      .mockImplementationOnce(() => oldResult.promise)
      .mockImplementationOnce(() => newResult.promise);
    const { options } = makeOptions({ getSource: () => target, shutdown: request });
    const lifecycle = createPluginWorkerDocumentLifecycle(options);
    const oldScope = lifecycle.freshScope();
    const oldPending = lifecycle.shutdown();
    const newScope = lifecycle.freshScope();
    const newPending = lifecycle.shutdown();

    expect(oldScope).not.toBe(newScope);
    expect(request.mock.calls.map(call => call[0][0].scopeId)).toEqual([oldScope, newScope]);
    expect(lifecycle.pending).toBe(2);
    oldResult.resolve({ requested: 1, acknowledged: 1, timedOut: false });
    await oldPending;
    expect(lifecycle.pending).toBe(1);
    expect(lifecycle.blocking).toBe(true);
    const sameNewDocument = lifecycle.shutdown();
    expect(sameNewDocument).toBe(newPending);
    expect(request).toHaveBeenCalledTimes(2);

    newResult.resolve({ requested: 1, acknowledged: 1, timedOut: false });
    await newPending;
    expect(lifecycle.pending).toBe(0);
    expect(lifecycle.blocking).toBe(false);
  });

  it("clears the current scope without sending another request or canceling an older flight", async () => {
    const target = source("preview-frame");
    const oldResult = deferred<PluginWorkerShutdownResult>();
    const request = vi.fn<Shutdown>(() => oldResult.promise);
    const { options } = makeOptions({ getSource: () => target, shutdown: request });
    const lifecycle = createPluginWorkerDocumentLifecycle(options);
    lifecycle.freshScope();
    const oldPending = lifecycle.shutdown();
    lifecycle.freshScope();
    lifecycle.clearScope();

    await expect(lifecycle.shutdown()).resolves.toEqual({ requested: 0, acknowledged: 0, timedOut: false });
    expect(request).toHaveBeenCalledTimes(1);
    expect(lifecycle.pending).toBe(1);
    expect(lifecycle.blocking).toBe(true);
    oldResult.resolve({ requested: 1, acknowledged: 1, timedOut: false });
    await expect(oldPending).resolves.toEqual({ requested: 1, acknowledged: 1, timedOut: false });
    expect(lifecycle.pending).toBe(0);
    expect(lifecycle.blocking).toBe(false);
  });

  it("cancels all current handshakes promptly and can start a fresh scope afterward", async () => {
    const target = source("frame");
    const neverSettles = deferred<PluginWorkerShutdownResult>();
    const request = vi.fn<Shutdown>()
      .mockImplementationOnce(() => neverSettles.promise)
      .mockResolvedValueOnce({ requested: 1, acknowledged: 1, timedOut: false });
    const { options } = makeOptions({ getSource: () => target, shutdown: request });
    const lifecycle = createPluginWorkerDocumentLifecycle(options);
    lifecycle.freshScope();
    const pending = lifecycle.shutdown();
    const signal = request.mock.calls[0][1]?.signal;
    expect(lifecycle.blocking).toBe(true);

    await lifecycle.cancel();
    await expect(pending).resolves.toEqual({ requested: 1, acknowledged: 0, timedOut: true });
    expect(signal?.aborted).toBe(true);
    expect(lifecycle.pending).toBe(0);
    expect(lifecycle.blocking).toBe(false);

    const nextScope = lifecycle.freshScope();
    await expect(lifecycle.shutdown()).resolves.toEqual({ requested: 1, acknowledged: 1, timedOut: false });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0][0].scopeId).toBe(nextScope);
  });

  it("converts a shutdown rejection to a safe timed-out result", async () => {
    const target = source("frame");
    const request = vi.fn<Shutdown>().mockRejectedValue(new Error("private transport detail"));
    const { options } = makeOptions({ getSource: () => target, shutdown: request });
    const lifecycle = createPluginWorkerDocumentLifecycle(options);
    lifecycle.freshScope();

    await expect(lifecycle.shutdown()).resolves.toEqual({ requested: 1, acknowledged: 0, timedOut: true });
    expect(lifecycle.pending).toBe(0);
    expect(lifecycle.blocking).toBe(false);
  });

  it("requires fresh scopes to be UUIDv4 values", () => {
    const { options } = makeOptions({ randomUUID: () => "not-a-scope" });
    const lifecycle = createPluginWorkerDocumentLifecycle(options);
    expect(() => lifecycle.freshScope()).toThrow(/document scope/);
  });
});

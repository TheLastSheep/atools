import { afterEach, describe, expect, it, vi } from "vitest";
import { createSettingsEditingLifecycle } from "../../src/lib/settingsEditingLifecycle";
import type { AToolsSettings } from "../../src/lib/settings";

type Session = { settings: AToolsSettings; close: ReturnType<typeof vi.fn> };

function session(): Session {
  return { settings: {} as AToolsSettings, close: vi.fn() };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe("settings editing lifecycle", () => {
  it("closes a stale read that resolves after a replacement becomes ready", async () => {
    const oldRead = deferred<Session>();
    const newRead = deferred<Session>();
    const staleSession = session();
    const currentSession = session();
    const openSession = vi.fn()
      .mockReturnValueOnce(oldRead.promise)
      .mockReturnValueOnce(newRead.promise);
    const phases: string[] = [];
    const lifecycle = createSettingsEditingLifecycle({ onPhaseChange: phase => phases.push(phase), openSession });

    lifecycle.start();
    const oldSignal = openSession.mock.calls[0]?.[0]?.signal as AbortSignal;
    lifecycle.start();
    const currentSignal = openSession.mock.calls[1]?.[0]?.signal as AbortSignal;
    newRead.resolve(currentSession);
    await flushPromises();
    oldRead.resolve(staleSession);
    await flushPromises();

    expect(oldSignal.aborted).toBe(true);
    expect(currentSignal.aborted).toBe(false);
    expect(staleSession.close).toHaveBeenCalledOnce();
    expect(currentSession.close).not.toHaveBeenCalled();
    expect(phases).toEqual(["loading", "loading", "ready"]);
    lifecycle.dispose();
  });

  it("releases a ready lease before starting another read", async () => {
    const order: string[] = [];
    const first: Session = { settings: {} as AToolsSettings, close: vi.fn(() => { order.push("close:first"); }) };
    const second: Session = { settings: {} as AToolsSettings, close: vi.fn(() => { order.push("close:second"); }) };
    const openSession = vi.fn()
      .mockImplementationOnce(() => { order.push("open:first"); return Promise.resolve(first); })
      .mockImplementationOnce(() => { order.push("open:second"); return Promise.resolve(second); });
    const phases: string[] = [];
    const lifecycle = createSettingsEditingLifecycle({ onPhaseChange: phase => phases.push(phase), openSession });

    lifecycle.start();
    await flushPromises();
    lifecycle.start();
    await flushPromises();

    expect(order).toEqual(["open:first", "close:first", "open:second"]);
    expect(first.close).toHaveBeenCalledOnce();
    expect(phases).toEqual(["loading", "ready", "loading", "ready"]);
    lifecycle.dispose();
    expect(second.close).toHaveBeenCalledOnce();
  });

  it("turns timeout into a fixed phase and closes a late lease", async () => {
    vi.useFakeTimers();
    const pending = deferred<Session>();
    const lateSession = session();
    const openSession = vi.fn().mockReturnValue(pending.promise);
    const phases: string[] = [];
    const lifecycle = createSettingsEditingLifecycle({
      onPhaseChange: phase => phases.push(phase),
      openSession,
      timeoutMs: 25,
    });

    lifecycle.start();
    const signal = openSession.mock.calls[0]?.[0]?.signal as AbortSignal;
    await vi.advanceTimersByTimeAsync(25);
    expect(signal.aborted).toBe(true);
    expect(phases).toEqual(["loading", "error"]);

    pending.resolve(lateSession);
    await flushPromises();
    expect(lateSession.close).toHaveBeenCalledOnce();
    expect(phases).toEqual(["loading", "error"]);
    lifecycle.dispose();
  });

  it("keeps rejection details out of phase state and permits only an explicit restart", async () => {
    const recoveredSession = session();
    const openSession = vi.fn()
      .mockRejectedValueOnce(new Error("private path /private/secret"))
      .mockResolvedValueOnce(recoveredSession);
    const phases: string[] = [];
    const lifecycle = createSettingsEditingLifecycle({ onPhaseChange: phase => phases.push(phase), openSession });

    lifecycle.start();
    await flushPromises();
    expect(phases).toEqual(["loading", "error"]);
    expect(openSession).toHaveBeenCalledOnce();

    lifecycle.start();
    await flushPromises();
    expect(openSession).toHaveBeenCalledTimes(2);
    expect(phases).toEqual(["loading", "error", "loading", "ready"]);
    lifecycle.dispose();
    expect(recoveredSession.close).toHaveBeenCalledOnce();
  });

  it("aborts pending work on idempotent dispose and closes its late lease", async () => {
    const pending = deferred<Session>();
    const lateSession = session();
    const openSession = vi.fn().mockReturnValue(pending.promise);
    const phases: string[] = [];
    const lifecycle = createSettingsEditingLifecycle({ onPhaseChange: phase => phases.push(phase), openSession });

    lifecycle.start();
    const signal = openSession.mock.calls[0]?.[0]?.signal as AbortSignal;
    lifecycle.dispose();
    lifecycle.dispose();
    pending.resolve(lateSession);
    await flushPromises();

    expect(signal.aborted).toBe(true);
    expect(lateSession.close).toHaveBeenCalledOnce();
    expect(phases).toEqual(["loading"]);
    expect(openSession).toHaveBeenCalledOnce();
  });
});

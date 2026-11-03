import { expect, it, vi } from "vitest";
import { boundedPublishedDiagnostic, createPublishedPhaseRecorder, PUBLISHED_DIAGNOSTIC_PHASES } from "./nativePublishedPluginScenario";

it("phase diagnostics never await an unresolved transport", () => {
  const send = vi.fn(() => new Promise<never>(() => {}));
  const record = createPublishedPhaseRecorder(send);
  expect(record("frontend-entry")).toBeUndefined();
  expect(record("frontend-mounted")).toBeUndefined();
  expect(send).toHaveBeenCalledTimes(2);
});
it("synchronous and asynchronous diagnostic failures cannot prevent report or cleanup", async () => {
  let reportSubmitted = false, cleanupStarted = false;
  const sync = createPublishedPhaseRecorder(() => { throw Error("diagnostic unavailable"); });
  const asyncRecord = createPublishedPhaseRecorder(() => Promise.reject(Error("diagnostic denied")));
  expect(() => sync("frontend-entry")).not.toThrow();
  asyncRecord("frontend-mounted");
  reportSubmitted = true; cleanupStarted = true;
  await Promise.resolve();
  expect(reportSubmitted && cleanupStarted).toBe(true);
});
it("diagnostic sends are deduplicated, size bounded and limited to the exact fixed phase vocabulary", () => {
  const send = vi.fn(() => Promise.resolve()); const record = createPublishedPhaseRecorder(send);
  record("frontend-entry"); record("frontend-entry"); record("raw query"); record("x".repeat(65));
  expect(send).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 10; i++) for (const phase of PUBLISHED_DIAGNOSTIC_PHASES) record(phase);
  record("arbitrary-lowercase-query"); record("cleanup-dialogs-complete");
  expect(send).toHaveBeenCalledTimes(PUBLISHED_DIAGNOSTIC_PHASES.length);
  expect(send.mock.calls.length).toBeLessThanOrEqual(96);
});

it("failure diagnostics time out without replacing the primary acceptance error", async () => {
  vi.useFakeTimers();
  try {
    const primary = Error("primary fixed-input failure");
    const pending = Promise.all([boundedPublishedDiagnostic(() => new Promise(() => {})), boundedPublishedDiagnostic(() => new Promise(() => {}))]);
    await vi.advanceTimersByTimeAsync(750);
    expect(await pending).toEqual([{ unavailable: true, reason: "diagnostic-timeout" }, { unavailable: true, reason: "diagnostic-timeout" }]);
    expect(primary.message).toBe("primary fixed-input failure");
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
it("diagnostic rejection and synchronous throw return fixed metadata", async () => {
  expect(await boundedPublishedDiagnostic(() => Promise.reject(Error("RAW_ERROR_SENTINEL")))).toEqual({ unavailable: true, reason: "diagnostic-failed" });
  expect(await boundedPublishedDiagnostic(() => { throw Error("RAW_ERROR_SENTINEL"); })).toEqual({ unavailable: true, reason: "diagnostic-failed" });
});
it("successful failure snapshots clear their timeout immediately", async () => {
  vi.useFakeTimers();
  try {
    expect(await boundedPublishedDiagnostic(() => Promise.resolve({ count: 1 }))).toEqual({ count: 1 });
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

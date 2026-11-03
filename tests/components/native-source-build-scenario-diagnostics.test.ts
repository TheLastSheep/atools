import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

const RUN_TOKEN = "24d8b68f-23ad-49dd-9d07-b5a0a0b705aa";

async function loadRecorder(token: string | undefined) {
  vi.resetModules();
  mocks.invoke.mockReset();
  Object.defineProperty(window, "__atoolsSourceBuildRunToken", {
    configurable: true,
    value: token,
  });
  return import("./nativeSourceBuildScenarioDiagnostics.ts");
}

describe("bounded source-build scenario diagnostic IPC", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    delete (window as Window & { __atoolsSourceBuildRunToken?: string }).__atoolsSourceBuildRunToken;
  });

  it("rejects a never-settling IPC at eight seconds without replay", async () => {
    const { recordSourceBuildScenarioEvent } = await loadRecorder(RUN_TOKEN);
    mocks.invoke.mockReturnValue(new Promise(() => {}));
    const pending = recordSourceBuildScenarioEvent("scenario_entered");
    const rejection = expect(pending).rejects.toThrow("source_build_scenario_diagnostic_timeout");
    await vi.advanceTimersByTimeAsync(8000);
    await rejection;
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("clears the deadline after successful and rejected IPC replies", async () => {
    const success = await loadRecorder(RUN_TOKEN);
    mocks.invoke.mockResolvedValueOnce(undefined);
    await success.recordSourceBuildScenarioEvent("scenario_entered");
    expect(vi.getTimerCount()).toBe(0);

    mocks.invoke.mockRejectedValueOnce(new Error("private native error"));
    const rejected = await success.recordSourceBuildScenarioEvent("fixture_received").catch(error => error);
    expect(rejected).toEqual(Error("source_build_scenario_diagnostic_rejected"));
    expect(vi.getTimerCount()).toBe(0);
    expect(String(rejected)).not.toContain("private native error");
  });

  it("refuses the twenty-fifth event before making another IPC call", async () => {
    const { recordSourceBuildScenarioEvent } = await loadRecorder(RUN_TOKEN);
    mocks.invoke.mockResolvedValue(undefined);
    for (let index = 0; index < 24; index += 1) {
      await recordSourceBuildScenarioEvent("scenario_entered");
    }
    await expect(recordSourceBuildScenarioEvent("scenario_entered"))
      .rejects.toThrow("source_build_scenario_diagnostic_unavailable");
    expect(mocks.invoke).toHaveBeenCalledTimes(24);
  });


  it("sanitizes a synchronous bridge throw and clears the deadline", async () => {
    const { recordSourceBuildScenarioEvent } = await loadRecorder(RUN_TOKEN);
    mocks.invoke.mockImplementation(() => { throw new Error("private synchronous native error"); });
    const rejected = await recordSourceBuildScenarioEvent("scenario_entered").catch(error => error);
    expect(rejected).toEqual(Error("source_build_scenario_diagnostic_rejected"));
    expect(String(rejected)).not.toContain("private synchronous native error");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not call native IPC when the run token is missing or malformed", async () => {
    const missing = await loadRecorder(undefined);
    await expect(missing.recordSourceBuildScenarioEvent("scenario_entered"))
      .rejects.toThrow("source_build_scenario_diagnostic_unavailable");
    expect(mocks.invoke).not.toHaveBeenCalled();

    const malformed = await loadRecorder("not-a-run-token");
    await expect(malformed.recordSourceBuildScenarioEvent("scenario_entered"))
      .rejects.toThrow("source_build_scenario_diagnostic_unavailable");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

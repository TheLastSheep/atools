import { describe, expect, it, vi } from "vitest";
import { createDesktopSmokeDeepReadFilesActivationPort, type DesktopSmokeDeepReadFilesActivation } from "../../src/lib/desktopSmokeDeepReadFilesActivationPort";

const FIXTURE = "/private/tmp/atools-fixture-environment-case-1/home/Downloads/ATools-DeepRead-Reader-Fixture.txt";
const validCall = (activate: DesktopSmokeDeepReadFilesActivation) => activate("deepread-import", [FIXTURE], "deepread");

function setup(enabled = true) {
  const state = { enabled };
  const activateFeature = vi.fn(async (_code: string, _payload: null, _options: {
    expectedPluginId: string;
    mediaContent: { kind: "files"; paths: string[] };
    throwOnError: true;
    isCancelled: () => boolean;
  }) => 12);
  const scope = createDesktopSmokeDeepReadFilesActivationPort({
    desktopSmokeEnabled: () => state.enabled,
    activateFeature,
  });
  return { state, activateFeature, scope };
}

describe("desktop smoke DeepRead activation port", () => {
  it("publishes once only while the existing smoke gate is enabled and uses the normal owner-checked files activation", async () => {
    const { activateFeature, scope } = setup();
    let published: DesktopSmokeDeepReadFilesActivation | undefined;
    expect(scope.publishReady(activate => { published = activate; })).toBe(true);
    expect(scope.publishReady(() => { throw new Error("duplicate ready publication"); })).toBe(false);
    await validCall(published!);
    expect(activateFeature).toHaveBeenCalledTimes(1);
    expect(activateFeature.mock.calls[0][0]).toBe("deepread-import");
    expect(activateFeature.mock.calls[0][1]).toBeNull();
    const options = activateFeature.mock.calls[0][2];
    expect(options).toMatchObject({ expectedPluginId: "deepread", mediaContent: { kind: "files", paths: [FIXTURE] }, throwOnError: true });
    expect(options.isCancelled()).toBe(false);
  });

  it("does not publish while disabled and cannot publish a stale callback after disposal", () => {
    const disabled = setup(false);
    let called = false;
    expect(disabled.scope.publishReady(() => { called = true; })).toBe(false);
    expect(called).toBe(false);
    const disposed = setup();
    disposed.scope.dispose();
    expect(disposed.scope.publishReady(() => { called = true; })).toBe(false);
    expect(called).toBe(false);
  });

  it("revokes already-published callbacks and signals cancellation to in-flight normal activation", async () => {
    let finish!: () => void;
    let observedCancellation: (() => boolean) | undefined;
    const state = { enabled: true };
    const activateFeature = vi.fn(async (_code: string, _payload: null, options: { isCancelled: () => boolean }) => {
      observedCancellation = options.isCancelled;
      await new Promise<void>(resolve => { finish = resolve; });
      return 12;
    });
    const scope = createDesktopSmokeDeepReadFilesActivationPort({ desktopSmokeEnabled: () => state.enabled, activateFeature });
    let published: DesktopSmokeDeepReadFilesActivation | undefined;
    scope.publishReady(activate => { published = activate; });
    const pending = validCall(published!);
    await Promise.resolve();
    scope.dispose();
    expect(observedCancellation?.()).toBe(true);
    finish();
    await expect(pending).rejects.toThrow("scope ended");
    await expect(validCall(published!)).rejects.toThrow("scope is unavailable");
  });

  it("rejects arbitrary feature owners and non-fixture paths before calling the launcher", async () => {
    const { activateFeature, scope } = setup();
    let published: DesktopSmokeDeepReadFilesActivation | undefined;
    scope.publishReady(activate => { published = activate; });
    await expect(published!("other-feature", [FIXTURE], "deepread")).rejects.toThrow("fixed fixture scope");
    await expect(published!("deepread-import", ["/tmp/unrelated.txt"], "deepread")).rejects.toThrow("fixed fixture scope");
    await expect(published!("deepread-import", [FIXTURE], "other-plugin")).rejects.toThrow("fixed fixture scope");
    expect(activateFeature).not.toHaveBeenCalled();
  });
});

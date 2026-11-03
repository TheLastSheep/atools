import { describe, expect, it, vi } from "vitest";
import { createDesktopSmokeImageStitchFilesActivationPort } from "../../src/lib/desktopSmokeImageStitchFilesActivationPort";
import type { DesktopSmokeImageStitchActivation } from "../../src/lib/desktopSmokeFilesActivationContract";

const RUN_ID = "b67f93ba-7420-4c2f-8b35-67dcde4d43a2";
const TOP = "/private/tmp/atools-fixture-environment-test/home/Downloads/atools-image-stitch-top.png";
const BOTTOM = "/private/tmp/atools-fixture-environment-test/home/Downloads/atools-image-stitch-bottom.png";
const paths: readonly [string, string] = [TOP, BOTTOM];
const evidence = () => ({
  caseId: "local-image-stitch-head", pluginId: "image-stitch", featureCode: "image-stitch-files", runId: RUN_ID,
  orderedPaths: [TOP, BOTTOM], pathAccess: "none", totalBytes: 72,
  files: [
    { path: TOP, fileName: "atools-image-stitch-top.png", sha256: "a".repeat(64), bytes: 36, width: 2, height: 2 },
    { path: BOTTOM, fileName: "atools-image-stitch-bottom.png", sha256: "b".repeat(64), bytes: 36, width: 2, height: 2 },
  ],
});
const invoke = (activate: DesktopSmokeImageStitchActivation) =>
  activate("image-stitch-files", paths, "image-stitch", RUN_ID);

function setup(options: { enabled?: boolean; readFixtureEvidence?: () => Promise<unknown> } = {}) {
  const state = { enabled: options.enabled ?? true };
  const readFixtureEvidence = options.readFixtureEvidence ?? vi.fn(async () => evidence());
  const activateFeature = vi.fn(async (_code: string, _payload: null, _options: {
    expectedPluginId: string;
    mediaContent: { kind: "files"; paths: string[] };
    throwOnError: true;
    isCancelled: () => boolean;
  }) => 1);
  const port = createDesktopSmokeImageStitchFilesActivationPort({
    desktopSmokeEnabled: () => state.enabled, readFixtureEvidence, activateFeature,
  });
  let activation: DesktopSmokeImageStitchActivation | undefined;
  return {
    state, readFixtureEvidence, activateFeature, port,
    publish: () => port.publishReady(value => { activation = value; }),
    activation: () => activation!,
  };
}

describe("desktop smoke Image Stitch files activation port", () => {
  it("publishes one opt-in callback and sends only the exact run-bound ordered host paths through normal activation", async () => {
    const value = setup();
    expect(value.publish()).toBe(true);
    expect(value.publish()).toBe(false);
    await invoke(value.activation());
    expect(value.readFixtureEvidence).toHaveBeenCalledOnce();
    expect(value.activateFeature).toHaveBeenCalledOnce();
    expect(value.activateFeature).toHaveBeenCalledWith("image-stitch-files", null, expect.objectContaining({
      expectedPluginId: "image-stitch", mediaContent: { kind: "files", paths: [TOP, BOTTOM] },
      throwOnError: true, isCancelled: expect.any(Function),
    }));
    expect(value.activateFeature.mock.calls[0][2].isCancelled()).toBe(false);
  });

  it.each(["caseId", "pluginId", "featureCode", "runId", "pathAccess"] as const)("rejects host evidence with an incorrect %s", async field => {
    const invalid = evidence() as Record<string, unknown>;
    invalid[field] = field === "runId" ? "another-run" : "wrong";
    const value = setup({ readFixtureEvidence: async () => invalid });
    value.publish();
    await expect(invoke(value.activation())).rejects.toThrow(/exact host fixture evidence/);
    expect(value.activateFeature).not.toHaveBeenCalled();
  });

  it.each(["reversed order", "duplicate input"] as const)("rejects caller paths with %s even if their names look valid", async mode => {
    const value = setup();
    value.publish();
    const input = mode === "reversed order" ? [BOTTOM, TOP] : [TOP, TOP];
    await expect(value.activation()("image-stitch-files", input as unknown as [string, string], "image-stitch", RUN_ID))
      .rejects.toThrow(/exact host fixture evidence/);
    expect(value.activateFeature).not.toHaveBeenCalled();
  });

  it.each(["path", "fileName", "hash", "dimensions", "fileBytes", "totalBytes"] as const)("rejects invalid fixture %s evidence", async field => {
    const invalid = evidence();
    if (field === "path") invalid.files[0].path = BOTTOM;
    if (field === "fileName") invalid.files[0].fileName = "other.png";
    if (field === "hash") invalid.files[0].sha256 = "not-a-hash";
    if (field === "dimensions") invalid.files[0].width = 3;
    if (field === "fileBytes") invalid.files[0].bytes = 4097;
    if (field === "totalBytes") invalid.totalBytes = 71;
    const value = setup({ readFixtureEvidence: async () => invalid });
    value.publish();
    await expect(invoke(value.activation())).rejects.toThrow(/exact host fixture evidence/);
    expect(value.activateFeature).not.toHaveBeenCalled();
  });

  it("rejects another owner or feature before requesting host fixture evidence", async () => {
    const value = setup();
    value.publish();
    // Deliberately cross the typed feature-literal boundary to verify the runtime guard.
    const invalidFeature = "other-feature" as Parameters<DesktopSmokeImageStitchActivation>[0];
    await expect(value.activation()(invalidFeature, paths, "image-stitch", RUN_ID)).rejects.toThrow(/exact feature/);
    expect(value.readFixtureEvidence).not.toHaveBeenCalled();
    expect(value.activateFeature).not.toHaveBeenCalled();
  });

  it("rejects a repeated activation before a second fixture read or launcher call", async () => {
    const value = setup();
    value.publish();
    await invoke(value.activation());
    await expect(invoke(value.activation())).rejects.toThrow(/single-use/);
    expect(value.readFixtureEvidence).toHaveBeenCalledOnce();
    expect(value.activateFeature).toHaveBeenCalledOnce();
  });

  it("rejects stale fixture evidence if the smoke gate closes while evidence is being read", async () => {
    let release!: (value: unknown) => void;
    const readFixtureEvidence = vi.fn(() => new Promise<unknown>(resolve => { release = resolve; }));
    const value = setup({ readFixtureEvidence });
    value.publish();
    const pending = invoke(value.activation());
    value.state.enabled = false;
    release(evidence());
    await expect(pending).rejects.toThrow(/ended before fixture verification/);
    expect(value.activateFeature).not.toHaveBeenCalled();
  });

  it("cancels in-flight activation on disposal and rejects later calls", async () => {
    let finish!: () => void;
    let isCancelled: (() => boolean) | undefined;
    const value = setup();
    value.activateFeature.mockImplementation(async (_code, _payload, options) => {
      isCancelled = options.isCancelled;
      await new Promise<void>(resolve => { finish = resolve; });
      return 1;
    });
    value.publish();
    const pending = invoke(value.activation());
    await Promise.resolve();
    value.port.dispose();
    expect(isCancelled?.()).toBe(true);
    finish();
    await expect(pending).rejects.toThrow(/ended during feature activation/);
    await expect(invoke(value.activation())).rejects.toThrow(/scope is unavailable/);
  });

  it("does not publish or invoke when initially disabled", async () => {
    const value = setup({ enabled: false });
    expect(value.publish()).toBe(false);
    expect(value.readFixtureEvidence).not.toHaveBeenCalled();
    expect(value.activateFeature).not.toHaveBeenCalled();
  });
});

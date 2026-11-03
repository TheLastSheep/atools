import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "./nativePublishedPluginCommon";
import { runOriginalImageStitchScenario } from "./nativeOriginalImageStitchScenario";
import type { ObservedTaskRun, PublishedScenarioContext } from "./nativePublishedPluginCommon";

vi.mock("./nativePublishedPluginCommon", () => ({ invoke: vi.fn() }));
const fixed = { caseId: "local-image-stitch-head", pluginId: "image-stitch", featureCode: "image-stitch-files",
  runId: "image-stitch-run-fixed", pathAccess: "none", totalBytes: 300,
  orderedPaths: ["/fixture/atools-image-stitch-top.png", "/fixture/atools-image-stitch-bottom.png"],
  files: [
    { path: "/fixture/atools-image-stitch-top.png", fileName: "atools-image-stitch-top.png", sha256: "a".repeat(64), bytes: 150, width: 2, height: 2,
      pixels: [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 255]] },
    { path: "/fixture/atools-image-stitch-bottom.png", fileName: "atools-image-stitch-bottom.png", sha256: "b".repeat(64), bytes: 150, width: 2, height: 2,
      pixels: [[0, 255, 255, 255], [255, 0, 255, 255], [255, 255, 0, 255], [0, 0, 0, 255]] },
  ] } as const;
const payloadJsonBytes = new TextEncoder().encode(JSON.stringify(fixed.orderedPaths)).length;
function taskRun(id: string, expectedPluginId = "image-stitch", status = "succeeded", clientId = "atools-ui"): ObservedTaskRun {
  return { id, capabilityId: "plugin.feature.image-stitch-files", status, initiator: { type: "human", clientId },
    input: { code: "image-stitch-files", expectedPluginId,
      payloadSummary: { type: "array", jsonBytes: payloadJsonBytes, contentRedacted: true } } };
}
const priorRun = taskRun("prior");
const activationRun = taskRun("image-stitch-activation");
const initial = { ready: true, placeholderVisible: true, canvasVisible: false, imageCount: 0, imageLabels: [], direction: "vertical",
  resizeMode: "enlarge", spacing: "0", padding: "0", transparentBackground: true, canvasWidth: 0, canvasHeight: 0, pixelRead: false, rgba: [] };
const finalCanvas = [
  255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
  0, 255, 255, 255, 255, 0, 255, 255, 255, 255, 0, 255, 0, 0, 0, 255,
];
beforeEach(() => vi.mocked(invoke).mockReset());

it("activates only the provider's ordered pair and verifies the real TaskRun, original image list and Canvas pixels", async () => {
  let activated = false;
  const wrongOwnerRun = taskRun("wrong-owner", "other-plugin");
  vi.mocked(invoke).mockImplementation(async command => command === "native_published_image_stitch_fixture"
    ? fixed : activated ? [priorRun, wrongOwnerRun, activationRun] : [priorRun]);
  const checks: string[] = [], calls: unknown[][] = [];
  const context = {
    profile: { caseId: fixed.caseId, id: fixed.pluginId, featureCode: fixed.featureCode, runtime: "web", pathAccess: "none" },
    fixture: { runId: fixed.runId }, check: (ok: unknown, label: string) => { expect(ok).toBeTruthy(); checks.push(label); },
    until: async <T>(read: () => T | Promise<T>) => { const value = await read(); if (!value) throw Error("not ready"); return value; },
    setPhase: vi.fn(), observations: {} as Record<string, unknown>, probe: vi.fn(async operation => {
      if (operation === "set-layout") return { ...initial, placeholderVisible: false, canvasVisible: true,
        imageCount: 2, imageLabels: [fixed.files[0].fileName + " (2×2)", fixed.files[1].fileName + " (2×2)"],
        resizeMode: "none", canvasWidth: 2, canvasHeight: 4, pixelRead: true, rgba: finalCanvas };
      return activated ? { ...initial, placeholderVisible: false, canvasVisible: true, imageCount: 2,
        imageLabels: [fixed.files[0].fileName + " (2×2)", fixed.files[1].fileName + " (2×2)"],
        resizeMode: "none", canvasWidth: 2, canvasHeight: 4, pixelRead: true, rgba: finalCanvas } : initial;
    }),
    activateFilesFeature: vi.fn(async (...args: unknown[]) => { calls.push(args); activated = true; }),
  } as unknown as PublishedScenarioContext;
  const result = await runOriginalImageStitchScenario(context);
  expect(context.activateFilesFeature).toHaveBeenCalledOnce();
  expect(calls[0]).toEqual(["image-stitch-files", [...fixed.orderedPaths], "image-stitch", fixed.runId]);
  expect(invoke).toHaveBeenCalledWith("native_published_image_stitch_fixture");
  expect(context.observations.imageStitchFilesTaskRun).toMatchObject({ id: activationRun.id, status: "succeeded" });
  expect(checks).toHaveLength(5);
  expect(result.tested).toContain("2×4 Canvas RGBA pixel equality");
  expect(result.notTested).toContain("save dialog, output file or filesystem write");
  expect(JSON.stringify(context.observations)).not.toContain("/fixture/");
});

it("rejects reversed or mismatched provider evidence before activating any path", async () => {
  vi.mocked(invoke).mockImplementation(async command => command === "native_published_image_stitch_fixture"
    ? { ...fixed, orderedPaths: [...fixed.orderedPaths].reverse() } : [priorRun]);
  const activateFilesFeature = vi.fn();
  const context = { profile: { caseId: fixed.caseId, id: fixed.pluginId, featureCode: fixed.featureCode, runtime: "web", pathAccess: "none" },
    fixture: { runId: fixed.runId }, check: vi.fn(), until: async <T>(read: () => T | Promise<T>) => await read(),
    setPhase: vi.fn(), observations: {}, probe: vi.fn(async () => initial), activateFilesFeature } as unknown as PublishedScenarioContext;
  await expect(runOriginalImageStitchScenario(context)).rejects.toThrow("file identity or decoded pixel evidence is invalid");
  expect(activateFilesFeature).not.toHaveBeenCalled();
});

it("rejects an incrementally new same-capability success with the wrong plugin owner", async () => {
  let activated = false;
  vi.mocked(invoke).mockImplementation(async command => command === "native_published_image_stitch_fixture"
    ? fixed : activated ? [priorRun, taskRun("foreign-owner", "other-plugin")] : [priorRun]);
  const context = { profile: { caseId: fixed.caseId, id: fixed.pluginId, featureCode: fixed.featureCode, runtime: "web", pathAccess: "none" },
    fixture: { runId: fixed.runId }, check: vi.fn(), until: async <T>(read: () => T | Promise<T>, label: string) => {
      for (let attempt = 0; attempt < 2; attempt++) { const value = await read(); if (value) return value; }
      throw Error(label);
    },
    setPhase: vi.fn(), observations: {}, probe: vi.fn(async () => initial),
    activateFilesFeature: vi.fn(async () => { activated = true; }) } as unknown as PublishedScenarioContext;
  await expect(runOriginalImageStitchScenario(context)).rejects.toThrow("owner-bound TaskRun");
});

it("ignores a same-capability TaskRun with missing input even if it is new and succeeded", async () => {
  let activated = false;
  const missingInput = { id: "missing-input", capabilityId: "plugin.feature.image-stitch-files", status: "succeeded",
    initiator: { type: "human", clientId: "atools-ui" } } as unknown as ObservedTaskRun;
  vi.mocked(invoke).mockImplementation(async command => command === "native_published_image_stitch_fixture"
    ? fixed : activated ? [priorRun, missingInput] : [priorRun]);
  const context = { profile: { caseId: fixed.caseId, id: fixed.pluginId, featureCode: fixed.featureCode, runtime: "web", pathAccess: "none" },
    fixture: { runId: fixed.runId }, check: vi.fn(), until: async <T>(read: () => T | Promise<T>, label: string) => {
      for (let attempt = 0; attempt < 2; attempt++) { const value = await read(); if (value) return value; }
      throw Error(label);
    }, setPhase: vi.fn(), observations: {}, probe: vi.fn(async () => initial),
    activateFilesFeature: vi.fn(async () => { activated = true; }) } as unknown as PublishedScenarioContext;
  await expect(runOriginalImageStitchScenario(context)).rejects.toThrow("owner-bound TaskRun");
});

it("rejects a failed TaskRun that otherwise has the exact persisted activation identity", async () => {
  let activated = false;
  vi.mocked(invoke).mockImplementation(async command => command === "native_published_image_stitch_fixture"
    ? fixed : activated ? [priorRun, taskRun("failed-exact", "image-stitch", "failed")] : [priorRun]);
  const context = { profile: { caseId: fixed.caseId, id: fixed.pluginId, featureCode: fixed.featureCode, runtime: "web", pathAccess: "none" },
    fixture: { runId: fixed.runId }, check: vi.fn(), until: async <T>(read: () => T | Promise<T>) => await read(),
    setPhase: vi.fn(), observations: {}, probe: vi.fn(async () => initial),
    activateFilesFeature: vi.fn(async () => { activated = true; }) } as unknown as PublishedScenarioContext;
  await expect(runOriginalImageStitchScenario(context)).rejects.toThrow("TaskRun did not succeed");
});

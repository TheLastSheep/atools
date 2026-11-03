import type { ObservedTaskRun, PublishedBusinessResult, PublishedScenarioContext } from "./nativePublishedPluginCommon";
import { invoke } from "./nativePublishedPluginCommon";

type StitchFile = { path: string; fileName: string; sha256: string; bytes: number; width: number; height: number; pixels: number[][] };
type StitchFixture = { caseId: string; pluginId: string; featureCode: string; runId: string; orderedPaths: readonly [string, string];
  files: StitchFile[]; totalBytes: number; pathAccess: string };
type StitchState = { ready: boolean; placeholderVisible: boolean; canvasVisible: boolean; imageCount: number; imageLabels: string[];
  direction: string; resizeMode: string; spacing: string; padding: string; transparentBackground: boolean;
  canvasWidth: number; canvasHeight: number; pixelRead: boolean; rgba: number[] };

const CASE_ID = "local-image-stitch-head" as const, PLUGIN_ID = "image-stitch" as const, FEATURE = "image-stitch-files" as const;
const FILE_NAMES = ["atools-image-stitch-top.png", "atools-image-stitch-bottom.png"] as const;
function isOrderedPathPair(value: unknown): value is [string, string] {
  return Array.isArray(value) && value.length === 2
    && value.every((path): path is string => typeof path === "string" && path.length > 0);
}
function assertFixture(value: unknown, runId: string): StitchFixture {
  if (!value || typeof value !== "object") throw Error("Image Stitch host fixture evidence is missing");
  const fixture = value as Partial<StitchFixture>;
  const paths = fixture.orderedPaths;
  if (fixture.caseId !== CASE_ID || fixture.pluginId !== PLUGIN_ID || fixture.featureCode !== FEATURE
    || fixture.runId !== runId || fixture.pathAccess !== "none" || !isOrderedPathPair(paths)
    || paths[0] === paths[1] || !Array.isArray(fixture.files) || fixture.files.length !== 2
    || !Number.isSafeInteger(fixture.totalBytes) || (fixture.totalBytes ?? 0) <= 0 || (fixture.totalBytes ?? Infinity) > 8192) {
    throw Error("Image Stitch host fixture identity, path budget or pair shape is invalid");
  }
  fixture.files.forEach((file, index) => {
    if (!file || file.fileName !== FILE_NAMES[index] || file.path !== paths[index]
      || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > 4096
      || file.width !== 2 || file.height !== 2 || !Array.isArray(file.pixels) || file.pixels.length !== 4
      || file.pixels.some(pixel => !Array.isArray(pixel) || pixel.length !== 4
        || pixel.some(channel => !Number.isSafeInteger(channel) || channel < 0 || channel > 255))) {
      throw Error("Image Stitch host fixture file identity or decoded pixel evidence is invalid");
    }
  });
  if (fixture.files.reduce((sum, file) => sum + file.bytes, 0) !== fixture.totalBytes) {
    throw Error("Image Stitch host fixture byte total does not match its ordered files");
  }
  const orderedPaths: readonly [string, string] = [paths[0], paths[1]];
  return { ...fixture, orderedPaths } as StitchFixture;
}
function expectedRgba(fixture: StitchFixture) { return fixture.files.flatMap(file => file.pixels.flat()); }
function labelMatches(label: string, fileName: string) { return label === fileName + " (2×2)"; }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function isImageStitchTaskRun(run: ObservedTaskRun, expectedPayloadBytes: number) {
  const input = run.input;
  if (!run.id || run.capabilityId !== "plugin.feature." + FEATURE || run.initiator?.type !== "human"
    || run.initiator.clientId !== "atools-ui" || !input || typeof input !== "object" || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>, summary = record.payloadSummary;
  if (!exactKeys(record, ["code", "payloadSummary", "expectedPluginId"]) || record.code !== FEATURE
    || record.expectedPluginId !== PLUGIN_ID || !summary || typeof summary !== "object" || Array.isArray(summary)) return false;
  const payload = summary as Record<string, unknown>;
  return exactKeys(payload, ["type", "jsonBytes", "contentRedacted"]) && payload.type === "array"
    && payload.jsonBytes === expectedPayloadBytes && payload.contentRedacted === true;
}

export async function runOriginalImageStitchScenario(context: PublishedScenarioContext): Promise<PublishedBusinessResult> {
  if (context.profile.caseId !== CASE_ID || context.profile.id !== PLUGIN_ID || context.profile.featureCode !== FEATURE
    || context.profile.runtime !== "web" || context.profile.pathAccess !== "none") {
    throw Error("Image Stitch scenario rejected an unpinned profile");
  }
  const read = () => context.probe<StitchState>("state");
  const initial = await context.until(async () => { const state = await read(); return state.ready ? state : null; },
    "Original Image Stitch page controls did not mount");
  context.check(initial.imageCount === 0 && initial.placeholderVisible && !initial.canvasVisible,
    "Original Image Stitch starts on its real empty placeholder before the fixed files activation");

  const fixture = assertFixture(await invoke<unknown>("native_published_image_stitch_fixture"), context.fixture.runId);
  context.observations.imageStitchFixture = { caseId: fixture.caseId, pluginId: fixture.pluginId, featureCode: fixture.featureCode,
    runId: fixture.runId, fileOrder: fixture.files.map(file => ({ fileName: file.fileName, sha256: file.sha256, bytes: file.bytes,
      width: file.width, height: file.height })), totalBytes: fixture.totalBytes, pathAccess: fixture.pathAccess };
  const beforeRuns = await invoke<ObservedTaskRun[]>("list_task_runs", { limit: 1000 });
  const beforeRunIds = new Set(beforeRuns.map(run => run.id));
  const expectedPayloadBytes = new TextEncoder().encode(JSON.stringify(fixture.orderedPaths)).length;
  const activateFilesFeature = context.activateFilesFeature;
  if (!activateFilesFeature) throw Error("Smoke-gated Image Stitch files activation port is unavailable");
  context.setPhase("original-image-stitch-files-activation");
  await activateFilesFeature(FEATURE, fixture.orderedPaths, PLUGIN_ID, fixture.runId);
  const taskRun = await context.until(async () => {
    const created = (await invoke<ObservedTaskRun[]>("list_task_runs", { limit: 1000 }))
      .filter(run => !beforeRunIds.has(run.id));
    const exact = created.filter(run => isImageStitchTaskRun(run, expectedPayloadBytes));
    if (exact.length > 1) throw Error("Image Stitch activation produced multiple exact owner-bound TaskRuns");
    if (exact.length === 0) return null;
    const candidate = exact[0];
    if (["failed", "cancelled", "partial"].includes(candidate.status)) {
      throw Error("Image Stitch files activation TaskRun did not succeed");
    }
    return candidate.status === "succeeded" ? candidate : null;
  }, "The exact Image Stitch files activation did not produce one successful owner-bound TaskRun");
  context.check(isImageStitchTaskRun(taskRun, expectedPayloadBytes) && taskRun.status === "succeeded",
    "Run-bound image-stitch-files TaskRun records the exact code, plugin owner, UI initiator and redacted ordered-path payload summary");
  context.observations.imageStitchFilesTaskRun = { id: taskRun.id, capabilityId: taskRun.capabilityId, status: taskRun.status };

  const loaded = await context.until(async () => {
    const state = await read();
    return state.ready && state.imageCount === 2 && !state.placeholderVisible && state.canvasVisible
      && state.imageLabels.length === 2 && state.imageLabels.every((label, index) => labelMatches(label, FILE_NAMES[index])) ? state : null;
  }, "The original Image Stitch UI did not load both fixed images in the exact provider order");
  context.check(loaded.imageCount === 2 && loaded.imageLabels[0] === FILE_NAMES[0] + " (2×2)"
    && loaded.imageLabels[1] === FILE_NAMES[1] + " (2×2)",
  "Original Image Stitch list shows both provider images in order with their real 2×2 dimensions");

  const layout = await context.probe<StitchState>("set-layout");
  context.check(layout.direction === "vertical" && layout.resizeMode === "none" && layout.spacing === "0"
    && layout.padding === "0" && layout.transparentBackground,
  "Existing original controls select vertical native-size composition with zero spacing and padding");
  const expected = expectedRgba(fixture);
  const canvas = await context.until(async () => {
    const state = await read();
    return state.canvasWidth === 2 && state.canvasHeight === 4 && state.pixelRead && state.rgba.length === 32 ? state : null;
  }, "Original Image Stitch Canvas did not render a readable 2×4 result");
  context.check(canvas.rgba.length === expected.length && canvas.rgba.every((channel, index) => channel === expected[index]),
    "Original Canvas contains all eight RGBA pixels in the provider's top-then-bottom color order");
  context.observations.imageStitchCanvas = { width: canvas.canvasWidth, height: canvas.canvasHeight,
    rgba: canvas.rgba, matchesProviderPixelOrder: true, saveAttempted: false };
  return { tested: ["real original empty placeholder before file activation", "run-bound host fixture with ordered 2×2 PNG evidence",
    "successful image-stitch-files TaskRun", "original image list loaded in provider order", "real original layout controls", "2×4 Canvas RGBA pixel equality"],
    notTested: ["save dialog, output file or filesystem write", "physical file chooser, clipboard, network or other source images"],
    boundary: "Canvas pixels are read from the pinned original package after production activation; fixture file contents are fixed host test inputs, not physical user interaction." };
}

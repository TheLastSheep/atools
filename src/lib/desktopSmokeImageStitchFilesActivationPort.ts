import type { DesktopSmokeImageStitchActivation } from "./desktopSmokeFilesActivationContract";

type FixtureFile = {
  path: string;
  fileName: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
};
type FixtureEvidence = {
  caseId: string;
  pluginId: string;
  featureCode: string;
  runId: string;
  orderedPaths: [string, string];
  files: [FixtureFile, FixtureFile];
  totalBytes: number;
  pathAccess: string;
};
type FileActivationOptions = {
  expectedPluginId: string;
  mediaContent: { kind: "files"; paths: string[] };
  throwOnError: true;
  isCancelled: () => boolean;
};
type Ports = {
  desktopSmokeEnabled: () => boolean;
  readFixtureEvidence: () => Promise<unknown>;
  activateFeature: (code: string, payload: null, options: FileActivationOptions) => Promise<number | null>;
};

const FILES = ["atools-image-stitch-top.png", "atools-image-stitch-bottom.png"] as const;
const MAX_FILE_BYTES = 4096;
const MAX_PAIR_BYTES = 8192;

function exactFixturePaths(value: unknown, runId: string, paths: readonly [string, string]): value is FixtureEvidence {
  if (!value || typeof value !== "object") return false;
  const evidence = value as Partial<FixtureEvidence>;
  if (evidence.caseId !== "local-image-stitch-head" || evidence.pluginId !== "image-stitch"
    || evidence.featureCode !== "image-stitch-files" || evidence.runId !== runId || evidence.pathAccess !== "none"
    || !Array.isArray(evidence.orderedPaths) || evidence.orderedPaths.length !== 2
    || !Array.isArray(evidence.files) || evidence.files.length !== 2
    || !Number.isSafeInteger(evidence.totalBytes) || evidence.totalBytes! < 1 || evidence.totalBytes! > MAX_PAIR_BYTES) return false;
  const ordered = evidence.orderedPaths;
  if (typeof paths[0] !== "string" || typeof paths[1] !== "string" || !paths[0] || !paths[1] || paths[0] === paths[1]
    || ordered[0] !== paths[0] || ordered[1] !== paths[1]) return false;
  let totalBytes = 0;
  for (let index = 0; index < 2; index++) {
    const file = evidence.files[index];
    if (!file || typeof file !== "object" || file.path !== paths[index] || file.fileName !== FILES[index]
      || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > MAX_FILE_BYTES
      || file.width !== 2 || file.height !== 2) return false;
    totalBytes += file.bytes;
  }
  return totalBytes === evidence.totalBytes;
}

export function createDesktopSmokeImageStitchFilesActivationPort(ports: Ports) {
  let disposed = false;
  let published = false;
  let activated = false;
  let generation = 0;

  const activateImageStitchFiles: DesktopSmokeImageStitchActivation = async (code, paths, expectedPluginId, expectedRunId) => {
    if (disposed || !ports.desktopSmokeEnabled()) throw new Error("Image Stitch smoke activation scope is unavailable");
    if (activated) throw new Error("Image Stitch smoke activation is single-use");
    if (code !== "image-stitch-files" || expectedPluginId !== "image-stitch" || typeof expectedRunId !== "string"
      || !expectedRunId || !Array.isArray(paths) || paths.length !== 2) {
      throw new Error("Image Stitch activation requires its exact feature, package and two-file tuple");
    }
    activated = true;
    const callGeneration = generation;
    const isCancelled = () => disposed || generation !== callGeneration || !ports.desktopSmokeEnabled();
    const evidence = await ports.readFixtureEvidence();
    if (isCancelled()) throw new Error("Image Stitch smoke activation scope ended before fixture verification");
    if (!exactFixturePaths(evidence, expectedRunId, paths)) {
      throw new Error("Image Stitch paths do not match the current run's exact host fixture evidence");
    }
    await ports.activateFeature(code, null, {
      expectedPluginId,
      mediaContent: { kind: "files", paths: [paths[0], paths[1]] },
      throwOnError: true,
      isCancelled,
    });
    if (isCancelled()) throw new Error("Image Stitch smoke activation scope ended during feature activation");
  };

  return {
    publishReady(onReady: (activate: DesktopSmokeImageStitchActivation) => void): boolean {
      if (disposed || published || !ports.desktopSmokeEnabled()) return false;
      published = true;
      onReady(activateImageStitchFiles);
      return true;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      generation += 1;
    },
  };
}

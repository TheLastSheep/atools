/** Shared, test-only callback contract. Each route keeps its own tuple and identity. */
export type DesktopSmokeDeepReadActivation = (
  code: string,
  paths: readonly [string],
  expectedPluginId: string,
) => Promise<void>;

export type DesktopSmokeImageStitchActivation = (
  code: "image-stitch-files",
  paths: readonly [string, string],
  expectedPluginId: "image-stitch",
  expectedRunId: string,
) => Promise<void>;

/** Intersection preserves the old three-argument call and adds one pinned two-file route. */
export type DesktopSmokeFilesActivation = DesktopSmokeDeepReadActivation & DesktopSmokeImageStitchActivation;

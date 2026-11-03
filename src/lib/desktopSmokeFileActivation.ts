import type { FeatureAction } from "./types";
import { desktopSmokePluginQueueActionActive } from "./desktopSmokePluginQueue";

const EXTERNAL_PLAN_MARKER = "__atools_desktop_smoke_external_plan";
const FILE_PATHS_MARKER = "__atools_desktop_smoke_file_paths";
const MAX_FILES = 20;
const MAX_PATH_BYTES = 8192;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

type ExternalPlanFiles = {
  pluginId: string;
  featureCode: string;
  paths: string[];
};

export type DesktopSmokeFeatureActivationOptions = {
  expectedPluginId: string;
  mediaContent: { kind: "files"; paths: string[] };
  throwOnError: true;
};

export type DesktopSmokeFeatureActivator = (
  code: string,
  payload: null,
  options: DesktopSmokeFeatureActivationOptions,
) => Promise<number | null>;

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path) || /^\\\\[^\\/]+[\\/][^\\/]+/u.test(path);
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || isWindowsAbsolutePath(path);
}

function parseExternalPlanFiles(action: FeatureAction): ExternalPlanFiles | null {
  const payload = action.payload;
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const hasFilePaths = hasOwn(record, FILE_PATHS_MARKER);
  const triggerType = record.trigger_type;
  if (!hasFilePaths) {
    if (triggerType === "files") {
      throw new Error("Desktop smoke external-plan file paths are missing");
    }
    // Preserve legacy text external plans, which carry the external marker only.
    return null;
  }
  if (!hasOwn(record, EXTERNAL_PLAN_MARKER) || record[EXTERNAL_PLAN_MARKER] !== true) {
    throw new Error("Desktop smoke file activation requires a valid external-plan marker");
  }
  if (triggerType !== "files") {
    throw new Error("Desktop smoke external-plan file paths require trigger_type 'files'");
  }

  const pathsValue = record[FILE_PATHS_MARKER];
  if (!Array.isArray(pathsValue) || pathsValue.length < 1 || pathsValue.length > MAX_FILES) {
    throw new Error("Desktop smoke external-plan file paths must contain 1 to 20 paths");
  }
  if (typeof action.plugin_id !== "string" || !action.plugin_id.trim()
    || typeof action.feature_code !== "string" || !action.feature_code.trim()) {
    throw new Error("Desktop smoke external-plan action must identify its plugin and feature");
  }

  const paths: string[] = [];
  const uniquePaths = new Set<string>();
  for (const value of pathsValue) {
    if (typeof value !== "string" || !value || !isAbsolutePath(value) || CONTROL_CHARACTERS.test(value)) {
      throw new Error("Desktop smoke external-plan file path must be an absolute path without control characters");
    }
    if (new TextEncoder().encode(value).byteLength > MAX_PATH_BYTES) {
      throw new Error("Desktop smoke external-plan file path exceeds 8192 UTF-8 bytes");
    }
    if (uniquePaths.has(value)) {
      throw new Error("Desktop smoke external-plan file paths must be unique");
    }
    uniquePaths.add(value);
    paths.push(value);
  }

  return { pluginId: action.plugin_id, featureCode: action.feature_code, paths };
}

export function isDesktopSmokeActionExternalPlan(
  action: FeatureAction | null,
  queue?: readonly FeatureAction[],
  queueIndex?: number,
): boolean {
  if (!action) return false;
  const payload = action.payload;
  if (!payload || typeof payload !== "object") return false;
  const record = payload as Record<string, unknown>;
  const hasFilePaths = hasOwn(record, FILE_PATHS_MARKER);
  if (!hasFilePaths && record.trigger_type !== "files" && Boolean(record[EXTERNAL_PLAN_MARKER])) return true;

  if (!queue || queueIndex === undefined
    || !desktopSmokePluginQueueActionActive(true, action, queue, queueIndex)) return false;
  const queuedPayload = queue[queueIndex]?.payload;
  if (!queuedPayload || typeof queuedPayload !== "object") return false;
  const queuedRecord = queuedPayload as Record<string, unknown>;
  return hasOwn(queuedRecord, FILE_PATHS_MARKER)
    && queuedRecord[EXTERNAL_PLAN_MARKER] === true
    && queuedRecord.trigger_type === "files";
}

/** Converts only catalog metadata into a real files activation; ordinary actions remain untouched. */
export async function activateDesktopSmokeFileAction(
  action: FeatureAction,
  activateFeature: DesktopSmokeFeatureActivator,
): Promise<boolean> {
  const activation = parseExternalPlanFiles(action);
  if (!activation) return false;

  await activateFeature(activation.featureCode, null, {
    expectedPluginId: activation.pluginId,
    mediaContent: { kind: "files", paths: [...activation.paths] },
    throwOnError: true,
  });
  return true;
}

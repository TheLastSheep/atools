import type { TaskRun, TaskRunStatus } from "./types";
import { hasRustTrimContent, parseSourceManifestMetadata, type ManifestSelection, type SourceManifestMetadata } from "./pluginSourceBuildManifest";

export const SOURCE_BUILD_TOOL = "convert_ztools_plugin";
export const SOURCE_BUILD_INSPECT_TOOL = "inspect_ztools_source_build";
export const SOURCE_BUILD_CLIENT = "atools-ui";
export type SourceBuildStep =
  | { kind: "typecheck" }
  | { kind: "nodeTests"; files: number }
  | { kind: "viteBuild" }
  | { kind: "packageScript" };
export type SourceBuildInspection = {
  status: "eligible" | "already_ready" | "blocked";
  pluginId?: string;
  version?: string;
  blockers: Array<{ code: string; message: string }>;
  sourceRevision?: string;
  buildSteps?: SourceBuildStep[];
} & Partial<SourceManifestMetadata>;
export type SourceBuildRuntime = {
  active: boolean;
  stage: "preparing" | "building" | "installing" | "cancelling" | "finished";
  cancellable: boolean;
  cancelRequested: boolean;
};
export type SourceBuildPhase = "checking" | "eligible" | "already_ready" | "blocked" |
  "starting" | "awaiting_permission" | "preparing" | "building" | "installing" |
  "cancelling" | "succeeded" | "failed" | "cancelled";
export type SourceBuildEntry = {
  phase: SourceBuildPhase;
  inspection?: SourceBuildInspection;
  runId?: string;
  runtime?: SourceBuildRuntime;
  taskStatus?: TaskRunStatus;
  message: string;
  observationError: string;
  requestedManifestSelection?: ManifestSelection;
  manifestChoiceConfirmed?: boolean;
  taskKind?: "inspection" | "conversion";
};
export type SourceBuildState = { entries: Record<string, SourceBuildEntry>; activePath: string | null };
export type SourceBuildIdentity = { id: string; sourcePath: string; expectedRevision: string; overwrite: boolean; manifestSelection?: ManifestSelection; expectedManifestSha256?: string };
export type SourceBuildInspectIdentity = { id: string; sourcePath: string; manifestSelection?: ManifestSelection };
export type SourceBuildServices = {
  inspect: (sourcePath: string, manifestSelection?: ManifestSelection) => Promise<TaskRun>;
  start: (sourcePath: string, expectedRevision: string, manifestSelection?: ManifestSelection, expectedManifestSha256?: string) => Promise<TaskRun>;
  read: (id: string) => Promise<TaskRun | null>;
  runtime: (id: string) => Promise<SourceBuildRuntime>;
  cancel: (id: string) => Promise<TaskRun>;
  listen: (receive: (id: string) => void) => Promise<() => void>;
  installed: (pluginId: string) => Promise<void>;
  dispose?: () => void;
};
export const isSourceBuildTerminal = (status: TaskRunStatus) =>
  ["succeeded", "failed", "cancelled", "partial"].includes(status);

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function eligibleIdentity(value: SourceBuildInspection): boolean {
  return value.status === "eligible" && value.blockers.length === 0
    && typeof value.pluginId === "string" && value.pluginId.length > 0 && value.pluginId.length <= 256
    && typeof value.version === "string" && hasRustTrimContent(value.version) && value.version.length <= 4096
    && typeof value.sourceRevision === "string" && /^[a-f0-9]{64}$/.test(value.sourceRevision);
}
function validBlockers(value: unknown): value is Array<{ code: string; message: string }> {
  return Array.isArray(value) && value.length <= 64
    && value.every(item => object(item) && typeof item.code === "string" && item.code.length <= 128
      && typeof item.message === "string" && item.message.length <= 4096);
}
function inspectionShape(value: unknown): value is SourceBuildInspection {
  if (!object(value) || !["eligible", "already_ready", "blocked"].includes(String(value.status)) || !validBlockers(value.blockers)) return false;
  if (value.pluginId !== undefined && typeof value.pluginId !== "string") return false;
  if (value.version !== undefined && typeof value.version !== "string") return false;
  if (value.sourceRevision !== undefined && typeof value.sourceRevision !== "string") return false;
  return !Object.prototype.hasOwnProperty.call(value, "buildSteps") || validSourceBuildSteps(value.buildSteps);
}
export function validSourceBuildInspection(value: unknown): value is SourceBuildInspection {
  if (!inspectionShape(value)) return false;
  const manifest = parseSourceManifestMetadata(value);
  return manifest !== null
    && (value.status !== "eligible" || eligibleIdentity(value))
    && (manifest.kind === "legacy" || manifest.value.manifestIdentity === null
      || (value.pluginId === undefined || manifest.value.manifestIdentity.id === value.pluginId)
        && (value.version === undefined || manifest.value.manifestIdentity.version === value.version))
    && (value.status !== "eligible" || manifest.kind !== "current"
      || (manifest.value.manifestSelection === null
        ? manifest.value.manifestCandidates.some(candidate => candidate.status === "valid")
        : manifest.value.manifestCandidates[manifest.value.manifestSelection === "root" ? 0 : 1].status === "valid"))
    && (value.status !== "eligible" || !Object.prototype.hasOwnProperty.call(value, "buildSteps")
      || (value.buildSteps as SourceBuildStep[]).filter(step => step.kind === "viteBuild").length === 1);
}
export function validSourceBuildSteps(value: unknown): value is SourceBuildStep[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) return false;
  let totalNodeTestFiles = 0;
  const validSteps = value.every(step => {
    if (!object(step) || typeof step.kind !== "string") return false;
    const keys = Object.keys(step).sort();
    if (step.kind === "nodeTests") {
      if (keys.length !== 2 || keys[0] !== "files" || keys[1] !== "kind"
        || !Number.isInteger(step.files) || (step.files as number) < 1 || (step.files as number) > 128) return false;
      totalNodeTestFiles += step.files as number;
      return totalNodeTestFiles <= 128;
    }
    return ["typecheck", "viteBuild", "packageScript"].includes(step.kind)
      && keys.length === 1 && keys[0] === "kind";
  });
  return validSteps && totalNodeTestFiles <= 128;
}
export function matchesSourceBuildRun(run: TaskRun | null, identity: SourceBuildIdentity): run is TaskRun {
  return !!run && run.id === identity.id && run.capabilityId === SOURCE_BUILD_TOOL
    && run.initiator?.clientId === SOURCE_BUILD_CLIENT && run.initiator.type === "human"
    && ["created", "awaiting_permission", "running", "succeeded", "partial", "failed", "cancelled"].includes(run.status)
    && object(run.input) && run.input.sourcePath === identity.sourcePath
    && run.input.expectedRevision === identity.expectedRevision && run.input.overwrite === identity.overwrite
    && run.input.manifestSelection === identity.manifestSelection
    && run.input.expectedManifestSha256 === identity.expectedManifestSha256;
}
export function matchesSourceBuildInspectRun(run: TaskRun | null, identity: SourceBuildInspectIdentity): run is TaskRun {
  if (!run || run.id !== identity.id || run.capabilityId !== SOURCE_BUILD_INSPECT_TOOL
    || run.initiator?.clientId !== SOURCE_BUILD_CLIENT || run.initiator.type !== "human"
    || !["created", "awaiting_permission", "running", "succeeded", "partial", "failed", "cancelled"].includes(run.status)
    || !object(run.input) || run.input.sourcePath !== identity.sourcePath) return false;
  return identity.manifestSelection === undefined
    ? !Object.prototype.hasOwnProperty.call(run.input, "manifestSelection")
    : run.input.manifestSelection === identity.manifestSelection;
}
export function inspectionFromRun(run: TaskRun): SourceBuildInspection | null {
  return validSourceBuildInspection(run.output) ? run.output : null;
}
export function validSourceBuildRuntime(value: SourceBuildRuntime): boolean {
  return object(value) && ["preparing", "building", "installing", "cancelling", "finished"].includes(value.stage)
    && typeof value.active === "boolean" && typeof value.cancellable === "boolean" && typeof value.cancelRequested === "boolean";
}
export function sourceBuildInstalledPlugin(run: TaskRun, inspection: SourceBuildInspection, revision: string): string | null {
  const output = run.output;
  return validSourceBuildInspection(inspection) && eligibleIdentity(inspection)
    && run.status === "succeeded" && inspection.sourceRevision === revision
    && object(output) && output.installed === true && output.sourceRevision === revision
    && typeof output.pluginId === "string" && output.pluginId.length > 0
    && output.pluginId === inspection.pluginId
    && output.version === inspection.version ? output.pluginId : null;
}

import type { TaskRun, TaskRunStatus } from "./types";

export const SOURCE_DEPENDENCY_CLIENT = "atools-ui";
export const SOURCE_DEPENDENCY_TOOLS = {
  inspect: "inspect_ztools_source_dependencies",
  fetch: "fetch_ztools_source_dependencies",
  prepare: "prepare_ztools_source_dependencies",
} as const;
export type DependencyAction = keyof typeof SOURCE_DEPENDENCY_TOOLS;
export type DependencyTarget = { os: string; cpu: string };
export type DependencyInspection = {
  status: "eligible";
  sourceRevision: string;
  planSha256: string;
  dependencySetIdSha256: string;
  target: DependencyTarget;
  packageCount: number;
  skippedOptionalCount: number;
  cachedBytes: number;
  missingCount: number;
  archiveBytes: number | null;
  dependencySetPrepared: boolean;
  dependencyTreeSha256: string | null;
  dependencyTreeBytes: number | null;
  nodeBinaryBytes: number;
  nodeBinarySha256: string;
  toolchainFingerprintSha256: string;
  toolchainHashElapsedMs: number;
  lifecyclesSkipped: boolean;
  dependencyClosureVerified: false;
  businessUsabilityVerified: false;
};
export type DependencyFetchResult = {
  status: "cached";
  sourceRevision: string;
  dependencySetIdSha256: string;
  packageCount: number;
  cachedArchiveCount: number;
  fetchedArchiveCount: number;
  verifiedArchiveBytes: number;
  elapsedMs: number;
  lifecyclesSkipped: boolean;
  dependencySetPrepared: false;
  businessUsabilityVerified: false;
};
export type DependencyPrepareResult = {
  status: "prepared";
  sourceRevision: string;
  dependencySetIdSha256: string;
  manifestSha256: string;
  packageCount: number;
  archiveBytes: number;
  unpackedBytes: number;
  fileCount: number;
  treeSha256: string;
  treeEntries: number;
  treeFiles: number;
  treeBytes: number;
  nodeBinaryBytes: number;
  nodeBinarySha256: string;
  toolchainFingerprintSha256: string;
  toolchainHashElapsedMs: number;
  workerElapsedMs: number;
  dependencyClosureVerified: false;
  businessUsabilityVerified: false;
};
export type DependencyResult = DependencyInspection | DependencyFetchResult | DependencyPrepareResult;
export type DependencyPhase = "idle" | "checking" | "eligible" | "starting" | "awaiting_permission" |
  "running" | "cancelling" | "succeeded" | "failed" | "cancelled" | "observing";
export type DependencyEntry = {
  sourcePath: string;
  phase: DependencyPhase;
  action?: DependencyAction;
  runId?: string;
  taskStatus?: TaskRunStatus;
  canResume?: boolean;
  inspection?: DependencyInspection;
  fetchResult?: DependencyFetchResult;
  prepareResult?: DependencyPrepareResult;
  message: string;
  error: string;
};
export type DependencyIdentity = {
  id: string;
  action: DependencyAction;
  sourcePath: string;
  sourceRevision?: string;
};
export type DependencyServices = {
  start: (action: DependencyAction, sourcePath: string, expectedRevision?: string) => Promise<TaskRun>;
  read: (id: string) => Promise<TaskRun | null>;
  cancel: (id: string) => Promise<TaskRun>;
  listen: (receive: (id: string) => void) => Promise<() => void>;
  dispose?: () => void;
};
export type DependencyState = { activePath: string | null; entry?: DependencyEntry };

const MAX_PACKAGES = 4096;
const MAX_BYTES = 128 * 1024 * 1024;
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function count(value: unknown, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
}
function text(value: unknown, max = 128): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function exactKeys(value: Record<string, unknown>, required: string[]) {
  return Object.keys(value).sort().join("\0") === [...required].sort().join("\0");
}
export function validDependencyInspection(value: unknown): value is DependencyInspection {
  if (!object(value) || !exactKeys(value, ["status", "sourceRevision", "planSha256", "dependencySetIdSha256", "target",
    "packageCount", "skippedOptionalCount", "cachedBytes", "missingCount", "archiveBytes", "dependencySetPrepared",
    "dependencyTreeSha256", "dependencyTreeBytes", "nodeBinaryBytes", "nodeBinarySha256", "toolchainFingerprintSha256",
    "toolchainHashElapsedMs", "lifecyclesSkipped", "dependencyClosureVerified", "businessUsabilityVerified"])) return false;
  if (!object(value.target) || !exactKeys(value.target, ["os", "cpu"])) return false;
  return value.status === "eligible" && digest(value.sourceRevision) && digest(value.planSha256)
    && digest(value.dependencySetIdSha256) && text(value.target.os, 64) && text(value.target.cpu, 64)
    && count(value.packageCount, MAX_PACKAGES) && count(value.skippedOptionalCount, MAX_PACKAGES)
    && count(value.cachedBytes, MAX_BYTES) && count(value.missingCount, MAX_PACKAGES)
    && (value.archiveBytes === null || count(value.archiveBytes, MAX_BYTES))
    && typeof value.dependencySetPrepared === "boolean"
    && (value.dependencySetPrepared
      ? digest(value.dependencyTreeSha256) && count(value.dependencyTreeBytes, 537_919_488)
      : value.dependencyTreeSha256 === null && value.dependencyTreeBytes === null)
    && count(value.nodeBinaryBytes, 268_435_456) && (value.nodeBinaryBytes as number) >= 1
    && digest(value.nodeBinarySha256) && digest(value.toolchainFingerprintSha256)
    && count(value.toolchainHashElapsedMs, Number.MAX_SAFE_INTEGER) && typeof value.lifecyclesSkipped === "boolean"
    && value.dependencyClosureVerified === false && value.businessUsabilityVerified === false;
}
export function validDependencyFetchResult(value: unknown): value is DependencyFetchResult {
  return object(value) && exactKeys(value, ["status", "sourceRevision", "dependencySetIdSha256", "packageCount",
    "cachedArchiveCount", "fetchedArchiveCount", "verifiedArchiveBytes", "elapsedMs", "lifecyclesSkipped",
    "dependencySetPrepared", "businessUsabilityVerified"])
    && value.status === "cached" && digest(value.sourceRevision) && digest(value.dependencySetIdSha256)
    && count(value.packageCount, MAX_PACKAGES) && count(value.cachedArchiveCount, MAX_PACKAGES)
    && count(value.fetchedArchiveCount, MAX_PACKAGES)
    && value.cachedArchiveCount + value.fetchedArchiveCount <= MAX_PACKAGES
    && count(value.verifiedArchiveBytes, MAX_BYTES) && count(value.elapsedMs, 120_000)
    && typeof value.lifecyclesSkipped === "boolean" && value.dependencySetPrepared === false
    && value.businessUsabilityVerified === false;
}
export function validDependencyPrepareResult(value: unknown): value is DependencyPrepareResult {
  return object(value) && exactKeys(value, ["status", "sourceRevision", "dependencySetIdSha256", "manifestSha256", "packageCount",
    "archiveBytes", "unpackedBytes", "fileCount", "treeSha256", "treeEntries", "treeFiles", "treeBytes",
    "nodeBinaryBytes", "nodeBinarySha256", "toolchainFingerprintSha256", "toolchainHashElapsedMs", "workerElapsedMs",
    "dependencyClosureVerified", "businessUsabilityVerified"])
    && value.status === "prepared" && digest(value.sourceRevision) && digest(value.dependencySetIdSha256)
    && digest(value.manifestSha256) && digest(value.treeSha256) && count(value.packageCount, MAX_PACKAGES)
    && count(value.archiveBytes, MAX_BYTES) && count(value.unpackedBytes, 536_870_912)
    && count(value.fileCount, 65_536) && count(value.treeEntries, 196_609) && (value.treeEntries as number) >= 1
    && count(value.treeFiles, 65_537) && count(value.treeBytes, 537_919_488)
    && value.treeFiles <= value.treeEntries && count(value.nodeBinaryBytes, 268_435_456)
    && (value.nodeBinaryBytes as number) >= 1 && digest(value.nodeBinarySha256)
    && digest(value.toolchainFingerprintSha256) && count(value.toolchainHashElapsedMs, Number.MAX_SAFE_INTEGER)
    && count(value.workerElapsedMs, 120_000) && value.dependencyClosureVerified === false
    && value.businessUsabilityVerified === false;
}
export function matchesDependencyRun(run: TaskRun | null, identity: DependencyIdentity): run is TaskRun {
  if (!run || run.id !== identity.id || run.capabilityId !== SOURCE_DEPENDENCY_TOOLS[identity.action]
    || run.initiator?.type !== "human" || run.initiator.clientId !== SOURCE_DEPENDENCY_CLIENT
    || !["created", "awaiting_permission", "running", "succeeded", "partial", "failed", "cancelled"].includes(run.status)
    || !object(run.input) || run.input.sourcePath !== identity.sourcePath) return false;
  const expectedKeys = identity.sourceRevision === undefined ? ["sourcePath"] : ["expectedRevision", "sourcePath"];
  return Object.keys(run.input).sort().join(",") === expectedKeys.join(",")
    && (identity.sourceRevision === undefined || run.input.expectedRevision === identity.sourceRevision);
}
export function isDependencyTerminal(status: TaskRunStatus) {
  return ["succeeded", "partial", "failed", "cancelled"].includes(status);
}
export function dependencyTaskResult(run: TaskRun, action: DependencyAction): DependencyResult | null {
  if (run.status !== "succeeded") return null;
  const output = run.output;
  if (action === "inspect") return validDependencyInspection(output) ? output : null;
  if (action === "fetch") return validDependencyFetchResult(output) ? output : null;
  return validDependencyPrepareResult(output) ? output : null;
}

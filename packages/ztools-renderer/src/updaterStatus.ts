import { invalidRendererResponse } from "./errors";
import { utf8ByteLength } from "./utf8";

export interface UpdaterMetadata { candidateId: string; currentVersion: string; version: string; date: string | null; body: string | null }
export interface UpdaterSnapshot {
  version: 1; sequence: number; phase: string; candidate: UpdaterMetadata | null; checked: boolean;
  operationId: string | null; progress: { downloaded: number; total: number | null };
  error: { code: string; message: string } | null;
}
const phases = new Set(["idle", "checking", "not-available", "available", "downloading", "downloaded", "installing", "install-unknown", "restart-pending", "restarting", "error"]);
const id = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{32}$/.test(v);
const num = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const bounded = (v: unknown, max: number): v is string => typeof v === "string" && utf8ByteLength(v) <= max;
const nullable = (v: unknown, max: number) => v === null || bounded(v, max);
function record(v: unknown, keys: string[]): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return false;
  return Reflect.ownKeys(v).length === keys.length && keys.every(k => { const d = Object.getOwnPropertyDescriptor(v, k); return !!d && d.enumerable && Object.hasOwn(d, "value"); });
}
export function validateUpdaterSnapshot(value: unknown): UpdaterSnapshot {
  const fail = () => { throw invalidRendererResponse("Invalid renderer updater snapshot."); };
  if (!record(value, ["version", "sequence", "phase", "candidate", "checked", "operationId", "progress", "error"])) return fail();
  const { candidate, progress, error } = value;
  if (value.version !== 1 || !num(value.sequence) || typeof value.phase !== "string" || !phases.has(value.phase) || typeof value.checked !== "boolean" || !(value.operationId === null || id(value.operationId))) return fail();
  if (candidate !== null && (!record(candidate, ["candidateId", "currentVersion", "version", "date", "body"]) || !id(candidate.candidateId) || !bounded(candidate.currentVersion, 128) || !bounded(candidate.version, 128) || !nullable(candidate.date, 128) || !nullable(candidate.body, 48 * 1024))) return fail();
  if (!record(progress, ["downloaded", "total"]) || !num(progress.downloaded) || !(progress.total === null || num(progress.total))) return fail();
  if (error !== null && (!record(error, ["code", "message"]) || !bounded(error.code, 128) || !bounded(error.message, 8192))) return fail();
  if (utf8ByteLength(JSON.stringify(value)) > 65536) return fail();
  return value as unknown as UpdaterSnapshot;
}
export function validateUpdaterWindow(value: unknown): void {
  if (!record(value, ["windowId"]) || !id(value.windowId)) throw invalidRendererResponse("Invalid updater window response.");
}

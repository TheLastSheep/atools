import type { AppUpdateMetadata, AppUpdaterError } from "./appUpdater";
export type LegacyUpdateStatus = { operation: "idle" | "checking" | "installing" | "restarting"; update: AppUpdateMetadata | null; checked: boolean; lastError: AppUpdaterError | null };
function exact(v: unknown, keys: string[]): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return false;
  return Reflect.ownKeys(v).length === keys.length && keys.every(k => { const d = Object.getOwnPropertyDescriptor(v, k); return !!d && d.enumerable && Object.hasOwn(d, "value"); });
}
const text = (v: unknown, n: number): v is string => typeof v === "string" && new TextEncoder().encode(v).length <= n;
const nullable = (v: unknown, n: number) => v === null || text(v, n);
export function validUpdate(v: unknown): v is AppUpdateMetadata {
  return exact(v, ["candidateId", "currentVersion", "version", "date", "body"]) && typeof v.candidateId === "string" && /^[0-9a-f]{32}$/.test(v.candidateId) && text(v.currentVersion, 128) && text(v.version, 128) && nullable(v.date, 128) && nullable(v.body, 48 * 1024) && new TextEncoder().encode(JSON.stringify({ candidateId: v.candidateId, currentVersion: v.currentVersion, version: v.version, date: v.date, body: v.body })).length <= 65536;
}
export function validLegacyStatus(v: unknown): v is LegacyUpdateStatus {
  if (!exact(v, ["operation", "update", "checked", "lastError"]) || !["idle", "checking", "installing", "restarting"].includes(v.operation as string) || typeof v.checked !== "boolean" || !(v.update === null || validUpdate(v.update))) return false;
  if (v.lastError !== null && (!exact(v.lastError, ["code", "message"]) || !text(v.lastError.code, 128) || !text(v.lastError.message, 8192))) return false;
  return new TextEncoder().encode(JSON.stringify(v)).length <= 65536;
}

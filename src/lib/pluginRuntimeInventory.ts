export const runtimeKinds = ["background", "main_push", "legacy_node", "browser_window", "foreground", "detached", "sidecar", "quickjs"] as const;
export type RuntimeKind = typeof runtimeKinds[number];
export type RuntimePhase = "starting" | "ready" | "stopping" | "cleanup_failed" | "unknown";
export type RuntimeEvidence = "admission" | "node_owner" | "native_window" | "renderer_view";
export type RuntimeSession = Readonly<{
  id: string; kind: RuntimeKind; instanceId: string; pluginId: string; windowLabel: string | null;
  codeRevision: string | null; phase: RuntimePhase; evidence: RuntimeEvidence;
}>;
export type RuntimeSnapshot = Readonly<{
  schemaVersion: 1; sessions: readonly RuntimeSession[];
  coverage: readonly Readonly<{ kind: RuntimeKind; available: boolean }>[]; truncated: boolean;
}>;
const phases: readonly string[] = ["starting", "ready", "stopping", "cleanup_failed", "unknown"];
const evidence: readonly string[] = ["admission", "node_owner", "native_window", "renderer_view"];
const sessionKeys = ["id", "kind", "instanceId", "pluginId", "windowLabel", "codeRevision", "phase", "evidence"];
const invalid = () => new Error("ERR_PLUGIN_RUNTIME_SNAPSHOT");
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
export function runtimeSessionId(kind: RuntimeKind, windowLabel: string | null, instanceId: string): string {
  return JSON.stringify([kind, windowLabel, instanceId]);
}
export function parseRuntimeSession(value: unknown): RuntimeSession {
  if (!object(value) || !exact(value, sessionKeys) || !runtimeKinds.includes(value.kind as RuntimeKind)
    || !bounded(value.instanceId, 256) || !bounded(value.pluginId, 256)
    || !(bounded(value.windowLabel, 128) || value.kind === "legacy_node" && value.windowLabel === null)
    || value.id !== runtimeSessionId(value.kind as RuntimeKind, value.windowLabel, value.instanceId)
    || !(value.codeRevision === null || typeof value.codeRevision === "string" && /^[a-f\d]{64}$/i.test(value.codeRevision))
    || typeof value.phase !== "string" || !phases.includes(value.phase)
    || typeof value.evidence !== "string" || !evidence.includes(value.evidence)) throw invalid();
  return Object.freeze({ ...value }) as RuntimeSession;
}
export function parsePluginRuntimeSnapshot(value: unknown): RuntimeSnapshot {
  if (!object(value) || !exact(value, ["schemaVersion", "sessions", "coverage", "truncated"])
    || value.schemaVersion !== 1 || typeof value.truncated !== "boolean" || !Array.isArray(value.sessions)
    || value.sessions.length > 128 || !Array.isArray(value.coverage) || value.coverage.length !== runtimeKinds.length) throw invalid();
  const sessions = value.sessions.map(parseRuntimeSession);
  if (new Set(sessions.map(row => row.id)).size !== sessions.length) throw invalid();
  const coverage = value.coverage.map(item => {
    if (!object(item) || !exact(item, ["kind", "available"]) || !runtimeKinds.includes(item.kind as RuntimeKind)
      || typeof item.available !== "boolean") throw invalid();
    return Object.freeze({ kind: item.kind as RuntimeKind, available: item.available });
  });
  if (new Set(coverage.map(row => row.kind)).size !== runtimeKinds.length) throw invalid();
  return Object.freeze({ schemaVersion: 1, sessions: Object.freeze(sessions), coverage: Object.freeze(coverage), truncated: value.truncated });
}
export function sameRuntimeSession(left: RuntimeSession, right: RuntimeSession): boolean {
  return left.id === right.id && left.kind === right.kind && left.instanceId === right.instanceId
    && left.pluginId === right.pluginId && left.windowLabel === right.windowLabel && left.codeRevision === right.codeRevision;
}
/** Renderer ownership refines its matching native observation, never a new revision. */
export function mergePluginRuntimeSessions(native: readonly RuntimeSession[], local: readonly RuntimeSession[]): RuntimeSession[] {
  const rows = new Map(native.map(row => [row.id, row]));
  for (const row of local) {
    const previous = rows.get(row.id);
    if (!previous || sameRuntimeSession(previous, row)) rows.set(row.id, row);
  }
  return [...rows.values()].sort((left, right) => left.id.localeCompare(right.id)).slice(0, 160);
}

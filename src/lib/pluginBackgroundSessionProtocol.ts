import type { FeatureAction, TaskRun } from "./types";

export type PluginBackgroundCandidate = { pluginId: string; pluginName: string; codeRevision: string; action: FeatureAction };
export type PluginBackgroundOperation = "start" | "stop";
export type PluginBackgroundDispatch = { requestId: string; ticket: string; sessionId: string; operation: PluginBackgroundOperation;
  pluginId: string; codeRevision: string; action: FeatureAction };
export type PluginBackgroundSessionStage = "admitting" | "loading" | "ready" | "stopping" | "cleanup-failed";
export type PluginBackgroundSessionView = { sessionId: string; pluginId: string; pluginName: string; codeRevision: string;
  action: FeatureAction; stage: PluginBackgroundSessionStage; visible: boolean; mountReady: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isCanonicalPluginBackgroundSessionId(value: string): boolean {
  return UUID.test(value);
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && own.every(key => keys.includes(key));
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

export function samePluginBackgroundBootDescriptor(left: FeatureAction, right: FeatureAction): boolean {
  const leftKeys = Object.keys(left).sort(), rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index]
    && sameValue((left as unknown as Record<string, unknown>)[key], (right as unknown as Record<string, unknown>)[key]));
}

export function isPluginBackgroundCandidate(value: unknown): value is PluginBackgroundCandidate {
  const candidate = value as Partial<PluginBackgroundCandidate> | null;
  return !!candidate && typeof candidate === "object" && exactKeys(candidate, ["pluginId", "pluginName", "codeRevision", "action"])
    && typeof candidate.pluginId === "string" && !!candidate.pluginId
    && candidate.pluginId.length <= 256 && typeof candidate.pluginName === "string" && typeof candidate.codeRevision === "string"
    && /^[\da-f]{64}$/i.test(candidate.codeRevision) && !!candidate.action && candidate.action.plugin_id === candidate.pluginId
    && candidate.action.feature_code === "" && candidate.action.payload == null && candidate.action.auto_detach === false;
}

export function isPluginBackgroundDispatch(value: unknown): value is PluginBackgroundDispatch {
  const dispatch = value as Partial<PluginBackgroundDispatch> | null;
  return !!dispatch && typeof dispatch === "object"
    && exactKeys(dispatch, ["requestId", "ticket", "sessionId", "operation", "pluginId", "codeRevision", "action"])
    && typeof dispatch.requestId === "string" && UUID.test(dispatch.requestId)
    && typeof dispatch.ticket === "string" && UUID.test(dispatch.ticket)
    && typeof dispatch.sessionId === "string" && UUID.test(dispatch.sessionId) && typeof dispatch.pluginId === "string"
    && typeof dispatch.codeRevision === "string" && (dispatch.operation === "start" || dispatch.operation === "stop")
    && !!dispatch.action && dispatch.action.plugin_id === dispatch.pluginId;
}

type PluginBackgroundTaskIdentity = { requestId: string; runId?: string; tool?: string; operation: PluginBackgroundOperation };
type PluginBackgroundSessionIdentity = { sessionId: string; pluginId: string; codeRevision: string };

export function matchesPluginBackgroundTaskRun(
  run: TaskRun,
  session: PluginBackgroundSessionIdentity,
  operation: PluginBackgroundTaskIdentity,
): boolean {
  const input = run.input as Record<string, unknown> | null;
  return run.id === operation.runId && run.capabilityId === operation.tool && run.initiator.clientId === "atools-ui"
    && exactKeys(input, ["requestId", "sessionId", "pluginId", "codeRevision", "operation"])
    && input.requestId === operation.requestId && input.sessionId === session.sessionId
    && input.pluginId === session.pluginId && input.codeRevision === session.codeRevision && input.operation === operation.operation;
}

export function matchesPluginBackgroundTaskOutput(
  run: TaskRun,
  session: PluginBackgroundSessionIdentity,
  operation: PluginBackgroundTaskIdentity,
): boolean {
  const output = run.output as Record<string, unknown> | null;
  return !!output && output.runtime === "plugin-background" && output.operation === operation.operation
    && output.outcome === (operation.operation === "start" ? "ready" : "closed")
    && output.sessionId === session.sessionId && output.pluginId === session.pluginId && output.codeRevision === session.codeRevision;
}

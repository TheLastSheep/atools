import { expect, it } from "vitest";
import { mergePluginRuntimeSessions, parsePluginRuntimeSnapshot, parseRuntimeSession,
  runtimeKinds, runtimeSessionId, type RuntimeSession } from "../../src/lib/pluginRuntimeInventory";

function row(instanceId = "session-1"): RuntimeSession {
  return { id: runtimeSessionId("background", "main", instanceId), kind: "background", instanceId,
    pluginId: "harris-sample", windowLabel: "main", codeRevision: "a".repeat(64), phase: "ready", evidence: "admission" };
}
const snapshot = (sessions: readonly RuntimeSession[]) => ({ schemaVersion: 1, sessions,
  coverage: runtimeKinds.map(kind => ({ kind, available: kind === "background" })), truncated: false });

it("accepts bounded safe metadata and keeps agent-owned Node windows absent", () => {
  const node: RuntimeSession = { ...row(), kind: "legacy_node", windowLabel: null, codeRevision: null,
    id: runtimeSessionId("legacy_node", null, "session-1"), evidence: "node_owner", phase: "unknown" };
  const parsed = parsePluginRuntimeSnapshot(snapshot([row(), node]));
  expect(parsed.sessions[1].windowLabel).toBeNull();
  expect(parsed.sessions[1].codeRevision).toBeNull();
  expect(parsed.coverage.some(source => !source.available)).toBe(true);
  expect(Object.isFrozen(parsed.sessions[0])).toBe(true);
  expect(() => parseRuntimeSession({ ...row(), windowLabel: null })).toThrow();
});

it("rejects duplicates, forged identity, private extras, overflow and malformed states", () => {
  expect(() => parsePluginRuntimeSnapshot(snapshot([row(), row()]))).toThrow();
  expect(() => parsePluginRuntimeSnapshot(snapshot(Array.from({ length: 129 }, (_, i) => row(String(i)))))).toThrow();
  expect(() => parseRuntimeSession({ ...row(), id: "forged" })).toThrow();
  expect(() => parseRuntimeSession({ ...row(), action: { payload: "private" } })).toThrow();
  expect(() => parseRuntimeSession({ ...row(), phase: { toString: () => "ready" } })).toThrow();
  expect(() => parseRuntimeSession({ ...row(), codeRevision: "current-install-version" })).toThrow();
  expect(() => parsePluginRuntimeSnapshot({ ...snapshot([]), coverage: [] })).toThrow();
  expect(() => parseRuntimeSession({ ...row(), pluginId: "界".repeat(90) })).toThrow();
});

it("merges renderer failure only into the exact native identity and preserves loaded revisions", () => {
  const native = row();
  const local: RuntimeSession = { ...native, phase: "cleanup_failed", evidence: "renderer_view" };
  expect(mergePluginRuntimeSessions([native], [local])).toEqual([local]);
  expect(mergePluginRuntimeSessions([native], [{ ...local, codeRevision: "b".repeat(64) }])).toEqual([native]);
  expect(mergePluginRuntimeSessions([], [local])).toEqual([local]);
});

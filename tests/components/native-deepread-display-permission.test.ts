import { describe, expect, it } from "vitest";
import { displayPermissionIsolationReady, matchesPublishedDisplayRequest } from "./nativePublishedDisplayPermission";
import { requiresPluginDisplaySession } from "./nativePublishedRuntimeRequirement";
import { classifyDeepReadPermission } from "./nativePublishedNodeAuthorization";
import type { RuntimeState } from "./nativePublishedPluginCommon";

const TITLE = "DeepRead 深读 请求读取显示器信息";
const REQUEST = { id: "permission-1", run_id: "run-1", tool_name: "atools.host.display.14ff3d75f7a75dc386ed3777.read",
  client_id: "atools-ui", scopes: ["display_read"] };
const PROFILE = { caseId: "converted-deepread-source", id: "deepread", title: "DeepRead 深读" };
const WAITING: RuntimeState = {
  resourceLeases: 0, legacySessions: 0, legacyOpenings: 0, legacyTransport: false, pendingRequests: 1,
  hostSessions: 0, hostIntents: 0, hostInvocations: 0, hostTransport: false,
  dataSessions: 1, dataIntents: 0, dataInvocations: 0, dataPreparations: 0, dataTransport: true,
  pathRuntimeAvailable: true, activePathSnapshots: 0, activePathIntents: 0, activePathPreparations: 0, pathSnapshotBytes: 0,
  dialogSessions: 1, dialogIntents: 0, dialogInvocations: 0, dialogPreparations: 0, nativeDialogs: 0, dialogTransport: true,
  displayRuntimeAvailable: true, displaySessions: 0, displayIntents: 1, displayInvocations: 0,
};

describe("fixed DeepRead display permission gate", () => {
  it("recognizes only the exact display request and never classifies it as Node", () => {
    expect(matchesPublishedDisplayRequest(TITLE, PROFILE.title, [REQUEST])).toEqual(REQUEST);
    expect(classifyDeepReadPermission(TITLE, true, false, PROFILE.title)).toBe("display");
    expect(classifyDeepReadPermission("DeepRead 深读 请求访问本机", true, false, PROFILE.title)).toBe("node");
    expect(matchesPublishedDisplayRequest("Other 请求读取显示器信息", PROFILE.title, [REQUEST])).toBeNull();
    expect(matchesPublishedDisplayRequest(TITLE, "Other", [REQUEST])).toBeNull();
    expect(matchesPublishedDisplayRequest(TITLE, PROFILE.title, [REQUEST, REQUEST])).toBeNull();
  });

  it("rejects wrong capability, client, scope, or missing TaskRun identity", () => {
    for (const changed of [
      { tool_name: "atools.host.display." + "0".repeat(24) + ".read" },
      { client_id: "other-client" }, { scopes: ["screenshot"] }, { scopes: ["display_read", "screenshot"] },
      { id: "" }, { run_id: "" },
    ]) {
      expect(matchesPublishedDisplayRequest(TITLE, PROFILE.title, [{ ...REQUEST, ...changed }])).toBeNull();
    }
  });

  it("enables the gate only for the fixed converted DeepRead profile", () => {
    expect(requiresPluginDisplaySession(PROFILE)).toBe(true);
    expect(requiresPluginDisplaySession({ ...PROFILE, id: "other" })).toBe(false);
    expect(requiresPluginDisplaySession({ ...PROFILE, title: "Other" })).toBe(false);
    expect(requiresPluginDisplaySession({ ...PROFILE, caseId: "converted-tetris-source" })).toBe(false);
  });

  it("requires the exact pending display intent while all other unapproved runtimes stay closed", () => {
    expect(displayPermissionIsolationReady(WAITING, { dataAccess: true, dialogAccess: "open" })).toBe(true);
    const changes: Array<Partial<RuntimeState>> = [
      { displaySessions: 1 }, { displayIntents: 0 }, { displayInvocations: 1 }, { legacySessions: 1 },
      { legacyOpenings: 1 }, { legacyTransport: true }, { hostSessions: 1 }, { hostIntents: 1 },
      { hostInvocations: 1 }, { hostTransport: true }, { activePathSnapshots: 1 }, { pathSnapshotBytes: 1 },
      { nativeDialogs: 1 }, { pendingRequests: 0 }, { dataSessions: 0 }, { dialogSessions: 0 },
    ];
    for (const changed of changes) expect(displayPermissionIsolationReady({ ...WAITING, ...changed },
      { dataAccess: true, dialogAccess: "open" })).toBe(false);
  });
});

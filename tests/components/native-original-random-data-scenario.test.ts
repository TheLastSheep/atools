import { afterEach, expect, it, vi } from "vitest";
import { runOriginalRandomDataScenario, verifyRandomDataAfterReopen } from "./nativeOriginalRandomDataScenario";
import type { PublishedFixture, PublishedPluginProfile, PublishedScenarioContext, RuntimeState } from "./nativePublishedPluginCommon";
import { projectRandomDataState } from "./nativeRandomDataObservation";
const { native } = vi.hoisted(() => ({ native: vi.fn() }));
vi.mock("./nativePublishedPluginCommon", async original => ({ ...(await original<Record<string, unknown>>()), invoke: native }));
vi.mock("@tauri-apps/api/core", async original => ({ ...(await original<typeof import("@tauri-apps/api/core")>()), invoke: native }));

const COMMAND = "ATools Random UUID Acceptance", UUID = "52c4df9c-0cf3-44e7-9cb7-51d9af7087aa";
const profile = { caseId: "local-random-data-head", id: "random-data", version: "1.2.0", sourceKind: "local_full_directory",
  sourceCommit: "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d", sourceTree: "113232c852e07d88dce1e6ba69f3be51ead0f154",
  directorySha256: "6c62e8d69ff009636fe948694554722556799b4c5721dc865caf637bbaf02c95", fileCount: 7,
  featureCode: "randomDataSettings", searchQuery: "随机数据设置", title: "随机数据", runtime: "web", dataAccess: true,
  dialogAccess: "none", pathAccess: "none", verifyDataPersistence: true,
  sourceReview: "output/legacy-node-2026-10-21/local-random-data-head-source-review-v1.json",
  sourceReviewStatus: "prepared_for_parent_native_fixture_decision",
  frameOperations: "tests/components/nativeOriginalRandomDataFrameOperations.js" } satisfies PublishedPluginProfile;
const fixture = { token: "fixture", runId: "run-00000000-0000-4000-8000-000000000000", packageSha256: profile.directorySha256!, profile } satisfies PublishedFixture;
const feature = { code: "randomUuid", plugin_id: "random-data", plugin_name: "random-data", label: "随机 UUID",
  explain: "动态随机 UUID 功能", score: 100, match_type: "exact" };
function runtime(open: boolean): RuntimeState {
  return { resourceLeases: 0, legacySessions: 0, legacyOpenings: 0, legacyTransport: false, pendingRequests: open ? 0 : 1,
    hostSessions: 0, hostIntents: 0, hostInvocations: 0, hostTransport: false,
    dataSessions: open ? 1 : 0, dataIntents: 0, dataInvocations: 0, dataPreparations: 0, dataTransport: open,
    pathRuntimeAvailable: true, activePathSnapshots: 0, activePathIntents: 0, activePathPreparations: 0, pathSnapshotBytes: 0,
    dialogSessions: 0, dialogIntents: 0, dialogInvocations: 0, dialogPreparations: 0, nativeDialogs: 0, dialogTransport: false,
    displayRuntimeAvailable: true, displaySessions: 0, displayIntents: 0, displayInvocations: 0 };
}
function harness(options: { validSample?: boolean; savedCommands?: string[] } = {}) {
  const state = { ready: true, enabled: true, commands: options.savedCommands ?? ["uuid", "guid"], input: "", preview: "", saveStatus: "已自动保存" };
  const operations: string[] = [], phases: string[] = [], observations: Record<string, unknown> = {};
  const probe = vi.fn(async (operation: string) => {
    operations.push(operation);
    if (operation === "sample") state.preview = options.validSample === false ? "not-a-uuid" : UUID;
    if (operation === "add-command") { state.input = COMMAND; state.commands.push(COMMAND); }
    if (operation === "state") return { ...state, origin: "null", parentDocumentAccessBlocked: true,
      tauriInternalsType: "undefined", globalTauriType: "undefined" };
    return { ...state };
  });
  const context = { profile, fixture, check: (ok: unknown, label: string) => { if (!ok) throw Error(label); },
    until: async <T>(read: () => T | Promise<T>, label: string) => { const value = await read(); if (value) return value as NonNullable<T>; throw Error(label); },
    pause: async () => {}, probe, setPhase: (phase: string) => phases.push(phase), observations } as unknown as PublishedScenarioContext;
  return { context, state, operations, phases, observations };
}
afterEach(() => { document.body.innerHTML = ""; native.mockReset(); vi.restoreAllMocks(); });

it("requires UUID-shaped preview, original command Enter, SQLite write and real feature publication", async () => {
  native.mockImplementation(async (command: string) => {
    if (command === "feature_catalog") return [{ ...feature, match_type: "catalog" }];
    if (command === "search_features") return [feature];
    if (command === "native_published_data_snapshot") return { pluginId: "random-data", settingsPresent: true,
      randomUuid: { enabled: true, commands: ["uuid", "guid", COMMAND] } };
    if (command === "native_published_runtime_state") return runtime(true);
    throw Error("Unexpected native command " + command);
  });
  const h = harness(); const result = await runOriginalRandomDataScenario(h.context);
  expect(h.operations).toEqual(["state", "sample", "state", "add-command", "state"]);
  expect(h.phases).toEqual(["original-random-data-sample-preview", "original-random-data-command-autosave"]);
  expect(result.notTested).toContain("clipboard or automatic fill");
  expect(h.observations.originalRandomDataPersisted).toMatchObject({ valueCopiedOrAutofilled: false, storageWritesByFixture: false,
    pageState: { previewIsCanonicalUuid: true, inputMatchesAcceptance: true, acceptanceCommandPresent: true } });
  const report = JSON.stringify(h.observations);
  expect(report).not.toContain(UUID); expect(report).not.toContain(`"input":`); expect(report).not.toContain(`"preview":`);
});

it("rejects a non-UUID preview without continuing to persistence claims", async () => {
  const h = harness({ validSample: false });
  await expect(runOriginalRandomDataScenario(h.context)).rejects.toThrow("UUID-shaped preview");
  expect(h.operations).toEqual(["state", "sample", "state"]);
  expect(JSON.stringify(h.observations)).not.toContain("not-a-uuid");
  expect(JSON.stringify(h.observations)).not.toContain(`"input":`);
  expect(native).not.toHaveBeenCalled();
});

it("reopens through the actual launcher and fresh data permission, then checks saved command and feature", async () => {
  const previous = document.createElement("iframe"); document.body.append(previous);
  document.body.innerHTML = '<input class="search-input"><div role="option" data-plugin-id="random-data" data-result-code="randomDataSettings"></div>'
    + '<section data-permission-dialog><h2>随机数据 请求访问自己的数据</h2><button>允许一次</button></section>';
  const input = document.querySelector<HTMLInputElement>(".search-input")!, option = document.querySelector<HTMLElement>('[role="option"]')!;
  const dialog = document.querySelector<HTMLElement>("[data-permission-dialog]")!;
  document.querySelector("button")!.addEventListener("click", () => { dialog.remove(); const frame = document.createElement("iframe");
    frame.title = "Plugin"; frame.setAttribute("sandbox", "allow-scripts"); document.body.append(frame); });
  const h = harness({ savedCommands: ["uuid", "guid", COMMAND] });
  native.mockImplementation(async (command: string) => {
    if (command === "native_published_runtime_state") return runtime(!!document.querySelector('iframe[title="Plugin"]'));
    if (command === "native_published_data_snapshot") return { pluginId: "random-data", settingsPresent: true,
      randomUuid: { enabled: true, commands: ["uuid", "guid", COMMAND] } };
    if (command === "feature_catalog") return [{ ...feature, match_type: "catalog" }];
    if (command === "search_features") return [feature];
    throw Error("Unexpected native command " + command);
  });
  await verifyRandomDataAfterReopen(h.context, previous);
  expect(input.value).toBe(profile.searchQuery); expect(option.isConnected).toBe(true);
  expect(document.querySelector('iframe[title="Plugin"]')).not.toBe(previous);
  expect(h.observations.originalRandomDataAfterWholeReopen).toMatchObject({ freshOneTimeApproval: true, newIframe: true });
  expect(native).toHaveBeenCalledWith("native_published_runtime_state");
});

it("rejects a database row that exists when the reopened plugin UI did not restore its saved command", async () => {
  const previous = document.createElement("iframe"); document.body.append(previous);
  document.body.innerHTML = '<input class="search-input"><div role="option" data-plugin-id="random-data" data-result-code="randomDataSettings"></div>'
    + '<section data-permission-dialog><h2>随机数据 请求访问自己的数据</h2><button>允许一次</button></section>';
  const dialog = document.querySelector<HTMLElement>("[data-permission-dialog]")!;
  document.querySelector("button")!.addEventListener("click", () => { dialog.remove(); const frame = document.createElement("iframe");
    frame.title = "Plugin"; frame.setAttribute("sandbox", "allow-scripts"); document.body.append(frame); });
  const h = harness();
  native.mockImplementation(async (command: string) => {
    if (command === "native_published_runtime_state") return runtime(!!document.querySelector('iframe[title="Plugin"]'));
    if (command === "native_published_data_snapshot") return { pluginId: "random-data", settingsPresent: true,
      randomUuid: { enabled: true, commands: ["uuid", "guid", COMMAND] } };
    throw Error("Unexpected native command " + command);
  });
  await expect(verifyRandomDataAfterReopen(h.context, previous)).rejects.toThrow("did not restore the saved command");
  expect(h.operations).toEqual(["state"]);
  expect(native).not.toHaveBeenCalledWith("feature_catalog");
});


it("requires the fixed command to produce an exact search hit for the same dynamic feature", async () => {
  native.mockImplementation(async (command: string) => {
    if (command === "feature_catalog") return [{ ...feature, match_type: "catalog" }];
    if (command === "search_features") return [{ ...feature, match_type: "contains" }];
    if (command === "native_published_data_snapshot") return { pluginId: "random-data", settingsPresent: true,
      randomUuid: { enabled: true, commands: ["uuid", "guid", COMMAND] } };
    if (command === "native_published_runtime_state") return runtime(true);
    throw Error("Unexpected native command " + command);
  });
  const h = harness();
  await expect(runOriginalRandomDataScenario(h.context)).rejects.toThrow("exact fixed command");
  expect(native).toHaveBeenCalledWith("search_features", { query: COMMAND });
  expect(native).not.toHaveBeenCalledWith("native_published_runtime_state");
});

it("projects volatile state to bounded booleans without retaining UUID or input text", () => {
  const projected = projectRandomDataState({ ready: true, enabled: true, commands: ["uuid", COMMAND],
    input: COMMAND, preview: UUID, saveStatus: "已自动保存", secret: "must-not-project" }, COMMAND);
  expect(projected).toEqual({ ready: true, enabled: true, uuidCommandEnabled: true, acceptanceCommandPresent: true,
    commandCount: 2, inputMatchesAcceptance: true, previewIsCanonicalUuid: true, saveCompleted: true });
  const serialized = JSON.stringify(projected);
  expect(serialized).not.toContain(UUID); expect(serialized).not.toContain(COMMAND); expect(serialized).not.toContain("secret");
});

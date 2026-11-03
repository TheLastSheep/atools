import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { approvePublishedImageStitchDialogs } from "./nativePublishedImageStitchDialogPermission";
import { IMAGE_STITCH_PROFILE } from "./nativePublishedImageStitchContract";
import type { PublishedScenarioContext, RuntimeState } from "./nativePublishedPluginCommon";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("./nativePublishedPluginCommon", async original => ({
  ...await original<typeof import("./nativePublishedPluginCommon")>(), invoke,
}));

const openCapability = "atools.host.dialog.f8c39326deb6950465da3cfd.open";
const saveCapability = "atools.host.dialog.f8c39326deb6950465da3cfd.save";
const nodeCapability = "legacy_node_f8c39326deb6950465da3cfd41107f4cae39d32e2ce23609fa441b3799be0236";
const nodeScopes = ["file_read", "file_write", "network", "shell", "clipboard_read", "clipboard_write",
  "screenshot", "browser_context", "plugin_data", "system_settings"];
const activityFields = ["resourceLeases", "displaySessions", "displayIntents", "displayInvocations"] as const;
type ActivityField = typeof activityFields[number];
const request = (access: "open" | "save") => ({ id: `${access}-request`, run_id: `${access}-run`,
  tool_name: access === "open" ? openCapability : saveCapability, client_id: "atools-ui",
  scopes: [access === "open" ? "file_read" : "file_write"] });
const makeNodeRequest = () => ({ id: "node-request", run_id: "node-run", tool_name: nodeCapability,
  client_id: "atools-ui", scopes: [...nodeScopes] });
const run = (access: "open" | "save", status: "awaiting_permission" | "succeeded") => ({
  id: `${access}-run`, capabilityId: access === "open" ? openCapability : saveCapability,
  initiator: { type: "human", clientId: "atools-ui" }, status, input: {}, output: null,
  artifacts: [], warnings: [], errors: [], actions: [], memoryIds: [], metrics: {}, validation: { status: "not_run" },
});
const nodeRun = { id: "node-run", capabilityId: nodeCapability,
  initiator: { type: "human", clientId: "atools-ui" }, status: "awaiting_permission", input: {}, output: null,
  artifacts: [], warnings: [], errors: [], actions: [], memoryIds: [], metrics: {}, validation: { status: "not_run" } };
const state = (dialogSessions: number, pendingRequests: number, dialogIntents: number, node = false): RuntimeState => ({
  resourceLeases: 0, legacySessions: node ? 1 : 0, legacyOpenings: 0, legacyTransport: node, pendingRequests,
  hostSessions: 0, hostIntents: 0, hostInvocations: 0, hostTransport: false,
  dataSessions: 1, dataIntents: 0, dataInvocations: 0, dataPreparations: 0, dataTransport: true,
  pathRuntimeAvailable: true, activePathSnapshots: 0, activePathIntents: 0, activePathPreparations: 0, pathSnapshotBytes: 0,
  dialogSessions, dialogIntents, dialogInvocations: 0, dialogPreparations: 0,
  nativeDialogs: 0, dialogTransport: dialogSessions > 0,
  displayRuntimeAvailable: true, displaySessions: 0, displayIntents: 0, displayInvocations: 0,
});

let stage: 0 | 1 | 2;
let requests: ReturnType<typeof request>[];
let openRun: ReturnType<typeof run>;
let saveRun: ReturnType<typeof run>;
let runtime: RuntimeState;
let clicked: string[];
let nodeAfterSave: boolean;
let contaminateNodeHandoff: boolean;
let afterOpenContamination: ActivityField | null;
let postSaveContamination: ActivityField | null;
let wrongNodeTitle: boolean;
let nodeRequest: ReturnType<typeof makeNodeRequest>;
let taskRunObservations: Array<[string, string, string, string | null | undefined]>;
let selectedProfile: typeof IMAGE_STITCH_PROFILE;
let permissionContext: PublishedScenarioContext;

function title(access: "open" | "save") {
  return access === "open" ? "图片拼接 请求打开文件选择窗口" : "图片拼接 请求选择文件保存位置";
}

beforeEach(() => {
  stage = 0;
  requests = [request("open")];
  openRun = run("open", "awaiting_permission");
  saveRun = run("save", "awaiting_permission");
  runtime = state(0, 1, 1);
  clicked = [];
  nodeAfterSave = false;
  contaminateNodeHandoff = false;
  afterOpenContamination = null;
  postSaveContamination = null;
  wrongNodeTitle = false;
  nodeRequest = makeNodeRequest();
  nodeRun.capabilityId = nodeCapability;
  taskRunObservations = [];
  selectedProfile = IMAGE_STITCH_PROFILE;
  document.body.innerHTML = `<div data-permission-dialog><h2>${title("open")}</h2><button>允许一次</button></div>`;
  document.querySelector("button")!.addEventListener("click", () => {
    clicked.push(stage === 0 ? "open" : "save");
    if (stage === 0) {
      stage = 1; openRun.status = "succeeded"; requests = [request("save")]; runtime = state(1, 1, 1);
      if (afterOpenContamination) runtime[afterOpenContamination] = 1;
      document.querySelector("h2")!.textContent = title("save");
    } else {
      stage = 2; saveRun.status = "succeeded";
      if (nodeAfterSave) {
        requests = [{ ...nodeRequest, scopes: [...nodeRequest.scopes] }];
        runtime = state(2, 1, 0);
        if (contaminateNodeHandoff) runtime.activePathSnapshots = 1;
        if (postSaveContamination) runtime[postSaveContamination] = 1;
        document.querySelector("h2")!.textContent = wrongNodeTitle ? "Other Plugin 请求访问本机" : "图片拼接 请求访问本机";
      } else {
        requests = []; runtime = state(2, 0, 0);
        if (postSaveContamination) runtime[postSaveContamination] = 1;
        document.querySelector("[data-permission-dialog]")?.remove();
      }
    }
  });
  invoke.mockReset().mockImplementation(async (command, args) => {
    if (command === "list_pending_agent_requests") return requests;
    if (command === "native_published_runtime_state") return runtime;
    if (command === "get_task_run") {
      if (args?.id === "open-run") { taskRunObservations.push([openRun.id, openRun.status, openRun.capabilityId, openRun.initiator.clientId]); return openRun; }
      if (args?.id === "save-run") { taskRunObservations.push([saveRun.id, saveRun.status, saveRun.capabilityId, saveRun.initiator.clientId]); return saveRun; }
      if (args?.id === "node-run") { taskRunObservations.push([nodeRun.id, nodeRun.status, nodeRun.capabilityId, nodeRun.initiator.clientId]); return nodeRun; }
      return null;
    }
    throw Error("Unexpected native operation: " + command);
  });
  permissionContext = {
    profile: selectedProfile,
    fixture: { profile: selectedProfile, packageSha256: selectedProfile.directorySha256, token: "fixture-token", runId: "fixture-run" },
    observations: {}, setPhase: vi.fn(), check: (ok: unknown, label: string) => { if (!ok) throw Error(label); },
    until: async <T>(read: () => T | Promise<T>, label: string) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const value = await read(); if (value) return value as NonNullable<T>;
      }
      throw Error(label);
    },
  } as unknown as PublishedScenarioContext;
});

afterEach(() => { document.body.innerHTML = ""; });

it("approves separately scoped open and save capabilities and waits for both exact TaskRuns and sessions", async () => {
  const result = await approvePublishedImageStitchDialogs(permissionContext);
  expect(clicked).toEqual(["open", "save"]);
  expect(result).toMatchObject({
    open: { taskRunId: "open-run", capability: openCapability, scope: "file_read" },
    save: { taskRunId: "save-run", capability: saveCapability, scope: "file_write" },
    sessions: 2, nativePickerOpened: false,
  });
  expect(runtime).toMatchObject({ resourceLeases: 0, displayRuntimeAvailable: true,
    displaySessions: 0, displayIntents: 0, displayInvocations: 0 });
  expect(permissionContext.setPhase).toHaveBeenNthCalledWith(1, "image-stitch-open-dialog-permission");
  expect(permissionContext.setPhase).toHaveBeenNthCalledWith(2, "image-stitch-save-dialog-permission");
  expect(taskRunObservations).toEqual(expect.arrayContaining([
    ["open-run", "awaiting_permission", openCapability, "atools-ui"],
    ["open-run", "succeeded", openCapability, "atools-ui"],
    ["save-run", "awaiting_permission", saveCapability, "atools-ui"],
    ["save-run", "succeeded", saveCapability, "atools-ui"],
  ]));
});

it("accepts and reports only the exact next Image Stitch Node gate without approving it", async () => {
  nodeAfterSave = true;
  const result = await approvePublishedImageStitchDialogs(permissionContext);
  expect(result).toMatchObject({ nextGate: "node", nextTaskRun: "node-run", sessions: 2 });
  expect(clicked).toEqual(["open", "save"]);
  expect(runtime).toMatchObject({ resourceLeases: 0, displayRuntimeAvailable: true,
    displaySessions: 0, displayIntents: 0, displayInvocations: 0 });
  expect(taskRunObservations).toContainEqual(["node-run", "awaiting_permission", nodeCapability, "atools-ui"]);
  expect(document.querySelector("h2")?.textContent).toBe("图片拼接 请求访问本机");
});

it.each(["capability", "scope", "duplicateScope", "client", "taskRun", "title"] as const)("rejects a non-exact next Node gate: %s", async kind => {
  nodeAfterSave = true;
  if (kind === "capability") nodeRequest.tool_name = "legacy_node_" + "0".repeat(64);
  if (kind === "scope") nodeRequest.scopes = ["file_read", "file_write"];
  if (kind === "duplicateScope") nodeRequest.scopes[0] = nodeRequest.scopes[1];
  if (kind === "client") nodeRequest.client_id = "other-client";
  if (kind === "taskRun") nodeRun.capabilityId = saveCapability;
  if (kind === "title") wrongNodeTitle = true;
  await expect(approvePublishedImageStitchDialogs(permissionContext)).rejects.toThrow(/exact next Node authorization gate/);
  expect(clicked).toEqual(["open", "save"]);
});

it("rejects the exact next Node request if the handoff contaminates path isolation", async () => {
  nodeAfterSave = true;
  contaminateNodeHandoff = true;
  await expect(approvePublishedImageStitchDialogs(permissionContext)).rejects.toThrow(/exact next Node authorization gate/);
  expect(clicked).toEqual(["open", "save"]);
});

it.each(activityFields)("rejects pre-approval %s activity before either grant", async field => {
  runtime[field] = 1;
  await expect(approvePublishedImageStitchDialogs(permissionContext)).rejects.toThrow(/starts only its exact dialog intent/);
  expect(clicked).toEqual([]);
});

it.each(activityFields)("rejects %s activity during the open-to-save transition", async field => {
  afterOpenContamination = field;
  await expect(approvePublishedImageStitchDialogs(permissionContext)).rejects.toThrow(/open grant did not settle/);
  expect(clicked).toEqual(["open"]);
});

it.each(activityFields)("rejects %s activity at the clean idle handoff", async field => {
  postSaveContamination = field;
  await expect(approvePublishedImageStitchDialogs(permissionContext)).rejects.toThrow(/exact next Node authorization gate/);
  expect(clicked).toEqual(["open", "save"]);
});

it.each(activityFields)("rejects %s activity at the immediate Node handoff", async field => {
  nodeAfterSave = true;
  postSaveContamination = field;
  await expect(approvePublishedImageStitchDialogs(permissionContext)).rejects.toThrow(/exact next Node authorization gate/);
  expect(clicked).toEqual(["open", "save"]);
});

it.each(["wrongCase", "wrongSourceTree", "wrongPackageDigest"] as const)("does not approve a mismatched fixture: %s", async kind => {
  if (kind === "wrongCase") selectedProfile = { ...IMAGE_STITCH_PROFILE, id: "other-plugin" };
  if (kind === "wrongSourceTree") selectedProfile = { ...IMAGE_STITCH_PROFILE, sourceTree: "0".repeat(40) };
  permissionContext.profile = selectedProfile;
  permissionContext.fixture.profile = selectedProfile;
  if (kind === "wrongPackageDigest") permissionContext.fixture.packageSha256 = "0".repeat(64);
  await expect(approvePublishedImageStitchDialogs(permissionContext)).rejects.toThrow(/exact isolated package fixture/);
  expect(clicked).toEqual([]);
});

it.each(["capability", "scope", "client", "taskRun", "earlyNode"] as const)("refuses an unexpected first gate: %s", async kind => {
  if (kind === "capability") requests[0].tool_name = saveCapability;
  if (kind === "scope") requests[0].scopes = ["file_write"];
  if (kind === "client") requests[0].client_id = "other";
  if (kind === "taskRun") openRun.capabilityId = saveCapability;
  if (kind === "earlyNode") runtime = state(0, 1, 1, true);
  await expect(approvePublishedImageStitchDialogs(permissionContext)).rejects.toThrow();
  expect(clicked).toEqual([]);
});

it("does not approve the save scope if the second dialog gate is not exact", async () => {
  document.querySelector("button")!.addEventListener("click", () => {
    if (stage === 1) requests[0].scopes = ["file_read"];
  }, { once: true });
  await expect(approvePublishedImageStitchDialogs(permissionContext)).rejects.toThrow();
  expect(clicked).toEqual(["open"]);
});

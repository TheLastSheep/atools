import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { approvePublishedOpenDialog, approvePublishedSaveDialog } from "./nativePublishedDialogPermission";
import type { PublishedPluginProfile, PublishedScenarioContext } from "./nativePublishedPluginCommon";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("./nativePublishedPluginCommon", async original => ({
  ...await original<typeof import("./nativePublishedPluginCommon")>(), invoke,
}));
const profile = { caseId: "local-ascii-tree", id: "ascii-tree", title: "ASCII Tree", dialogAccess: "save", dataAccess: true } as PublishedPluginProfile;
const openProfile = { caseId: "converted-deepread-source", id: "deepread", title: "DeepRead 深读", dialogAccess: "open", dataAccess: true } as PublishedPluginProfile;
const capability = "atools.host.dialog." + "a".repeat(24) + ".save";
const openCapability = "atools.host.dialog.14ff3d75f7a75dc386ed3777.open";
const pending = () => [{ id: "request-1", run_id: "run-1", tool_name: capability, client_id: "atools-ui", scopes: ["file_write"] }];
const before = () => ({ pendingRequests: 1, legacySessions: 0, legacyOpenings: 0, legacyTransport: false,
  hostSessions: 0, hostIntents: 0, hostInvocations: 0, hostTransport: false,
  activePathSnapshots: 0, activePathIntents: 0, activePathPreparations: 0, pathSnapshotBytes: 0,
  dialogSessions: 0, dialogIntents: 0, dialogPreparations: 0,
  dialogTransport: false, nativeDialogs: 0, dialogInvocations: 0,
  dataSessions: 1, dataIntents: 0, dataInvocations: 0, dataPreparations: 0, dataTransport: true });
const after = () => ({ ...before(), pendingRequests: 0, dialogSessions: 1, dialogTransport: true, dialogIntents: 0, dialogPreparations: 0 });
let requests: ReturnType<typeof pending>, waiting: ReturnType<typeof before>, approved: ReturnType<typeof after>, clicked: boolean;
let permissionTask = { id: "run-1", capabilityId: "atools.host.dialog.14ff3d75f7a75dc386ed3777.open", status: "awaiting_permission" };
let nextNode: { id: string; run_id: string; tool_name: string; client_id: string; scopes: string[] } | null = null;
let nodeTask = { id: "node-run", capabilityId: "legacy_node_" + "14ff3d75f7a75dc386ed3777b20c268612e207571b56d0fcedcd234184682cdb", status: "awaiting_permission" };
let clickCount = 0;
const context = (selectedProfile = profile) => ({ profile: selectedProfile,
  check: (ok: unknown, label: string) => { if (!ok) throw Error(label); },
  until: async (read: () => unknown, label: string) => { const value = await read(); if (!value) throw Error(label); return value; },
} as unknown as PublishedScenarioContext);

beforeEach(() => {
  clicked = false; clickCount = 0; nextNode = null; requests = pending(); waiting = before(); approved = after();
  permissionTask = { id: "run-1", capabilityId: openCapability, status: "awaiting_permission" };
  nodeTask = { id: "node-run", capabilityId: "legacy_node_" + "14ff3d75f7a75dc386ed3777b20c268612e207571b56d0fcedcd234184682cdb", status: "awaiting_permission" };
  document.body.innerHTML = '<div data-permission-dialog><h2>ASCII Tree 请求选择文件保存位置</h2><button>允许一次</button></div>';
  document.querySelector("button")!.addEventListener("click", () => { clicked = true; });
  invoke.mockReset().mockImplementation(async (command, args) => {
    if (command === "list_pending_agent_requests") return clicked && nextNode ? [nextNode] : requests;
    if (command === "get_task_run") {
      if (!args || Object.keys(args).length !== 1 || typeof args.id !== "string") {
        throw Error("get_task_run requires exactly { id }");
      }
      if (args.id === "run-1") return permissionTask;
      if (args.id === "node-run") return nodeTask;
      return null;
    }
    if (command === "native_published_runtime_state") return clicked ? approved : waiting;
    throw Error("Unexpected native operation: " + command);
  });
});
afterEach(() => { document.body.innerHTML = ""; });

it("approves only the exact startup metadata and observes one idle session without opening a native panel", async () => {
  const observed = await approvePublishedSaveDialog(context());
  expect(observed.capability).toBe(capability);
  expect(observed.nativePanelRequestedByScenario).toBe(false);
  expect(observed.after.nativeDialogs).toBe(0);
  expect(invoke.mock.calls.map(call => call[0])).toEqual([
    "list_pending_agent_requests", "native_published_runtime_state", "native_published_runtime_state",
  ]);
});

it.each(["namespace", "duplicate", "scope", "client", "title", "unregistered"])("never approves an unexpected %s request", async kind => {
  let selected = profile;
  if (kind === "namespace") requests[0].tool_name = "legacy_node_" + "a".repeat(64);
  if (kind === "duplicate") requests.push({ ...requests[0] });
  if (kind === "scope") requests[0].scopes.push("file_read");
  if (kind === "client") requests[0].client_id = "other";
  if (kind === "title") document.querySelector("h2")!.textContent = "Other 请求选择文件保存位置";
  if (kind === "unregistered") selected = { ...profile, dialogAccess: undefined };
  await expect(approvePublishedSaveDialog(context(selected))).rejects.toThrow();
  expect(clicked).toBe(false);
});

it.each(["node", "clipboard", "nativePanel", "frame", "extraData"])("refuses a premature %s runtime before approval", async kind => {
  if (kind === "node") waiting.legacySessions = 1;
  if (kind === "clipboard") waiting.hostSessions = 1;
  if (kind === "nativePanel") waiting.nativeDialogs = 1;
  if (kind === "extraData") waiting.dataSessions = 2;
  if (kind === "frame") document.body.insertAdjacentHTML("beforeend", '<iframe title="Plugin"></iframe>');
  await expect(approvePublishedSaveDialog(context())).rejects.toThrow();
  expect(clicked).toBe(false);
});

it("does not accept an opened native panel as an idle save session", async () => {
  approved.nativeDialogs = 1;
  await expect(approvePublishedSaveDialog(context())).rejects.toThrow("without opening any native panel");
  expect(clicked).toBe(true);
});

it("approves only DeepRead's exact startup open-dialog capability without invoking a panel", async () => {
  waiting.dialogIntents = 1;
  requests = [{ id: "request-1", run_id: "run-1", tool_name: openCapability, client_id: "atools-ui", scopes: ["file_read"] }];
  approved.dialogSessions = 1; approved.dialogTransport = true;
  document.body.innerHTML = '<div data-permission-dialog><h2>DeepRead 深读 请求打开文件选择窗口</h2><button>允许一次</button></div>';
  document.querySelector("button")!.addEventListener("click", () => {
    clicked = true; permissionTask.status = "succeeded"; requests = [];
    document.querySelector("[data-permission-dialog]")?.remove();
  });
  const observed = await approvePublishedOpenDialog(context(openProfile));
  expect(observed.capability).toBe(openCapability);
  expect(observed.scope).toBe("file_read");
  expect(observed.nativePanelRequestedByScenario).toBe(false);
  expect(observed.before.pendingRequests).toBe(1);
  expect(observed.after.pendingRequests).toBe(0);
  expect(observed.after.nativeDialogs).toBe(0);
  expect(observed.completedTaskRun).toBe("run-1");
  expect(invoke.mock.calls.filter(([command]) => command === "get_task_run").map(([, args]) => args))
    .toEqual([{ id: "run-1" }, { id: "run-1" }]);
  expect(clicked).toBe(true);
});

it.each(["wrongCapability", "wrongScope", "wrongClient", "wrongTitle", "missingRunId", "wrongRequestRunId", "wrongTaskRun", "wrongTaskCapability", "wrongTaskId", "wrongProfileId", "unregistered", "panelOpened"])(
  "refuses a mismatched DeepRead open-dialog approval: %s", async kind => {
    waiting.dialogIntents = 1;
    requests = [{ id: "request-1", run_id: "run-1", tool_name: openCapability, client_id: "atools-ui", scopes: ["file_read"] }];
    approved.dialogSessions = 1; approved.dialogTransport = true;
    document.body.innerHTML = '<div data-permission-dialog><h2>DeepRead 深读 请求打开文件选择窗口</h2><button>允许一次</button></div>';
    document.querySelector("button")!.addEventListener("click", () => { clicked = true; permissionTask.status = "succeeded"; });
    if (kind === "wrongCapability") requests[0].tool_name = "legacy_node_" + "a".repeat(64);
    if (kind === "wrongScope") requests[0].scopes = ["file_write"];
    if (kind === "wrongClient") requests[0].client_id = "other";
    if (kind === "wrongTitle") document.querySelector("h2")!.textContent = "Other 请求打开文件选择窗口";
    if (kind === "missingRunId") requests[0].run_id = "";
    if (kind === "wrongRequestRunId") requests[0].run_id = "unrelated-run";
    if (kind === "wrongTaskRun") permissionTask.status = "running";
    if (kind === "wrongTaskCapability") permissionTask.capabilityId = "atools.host.dialog." + "b".repeat(24) + ".open";
    if (kind === "wrongTaskId") permissionTask.id = "other-run";
    if (kind === "wrongProfileId") openProfile.id = "other-plugin";
    const selected = kind === "unregistered" ? { ...openProfile, dialogAccess: "none" } as PublishedPluginProfile : openProfile;
    if (kind === "panelOpened") approved.nativeDialogs = 1;
    await expect(approvePublishedOpenDialog(context(selected))).rejects.toThrow();
    expect(clicked).toBe(kind === "panelOpened");
    openProfile.id = "deepread";
  });

it.each(["node", "clipboard", "extraData", "pathSnapshot", "frame"])(
  "does not approve DeepRead open-dialog metadata after premature %s startup", async kind => {
    waiting.dialogIntents = 1;
    requests = [{ id: "request-1", run_id: "run-1", tool_name: openCapability, client_id: "atools-ui", scopes: ["file_read"] }];
    if (kind === "node") waiting.legacySessions = 1;
    if (kind === "clipboard") waiting.hostSessions = 1;
    if (kind === "extraData") waiting.dataSessions = 2;
    if (kind === "pathSnapshot") waiting.activePathSnapshots = 1;
    document.body.innerHTML = '<div data-permission-dialog><h2>DeepRead 深读 请求打开文件选择窗口</h2><button>允许一次</button></div>';
    if (kind === "frame") document.body.insertAdjacentHTML("beforeend", '<iframe title="Plugin"></iframe>');
    document.querySelector("button")!.addEventListener("click", () => { clicked = true; });
    await expect(approvePublishedOpenDialog(context(openProfile))).rejects.toThrow();
    expect(clicked).toBe(false);
  });

it.each([["missing", 0], ["extra", 2]] as const)(
  "requires exactly one pending open-dialog intent (%s)", async (_kind, intentCount) => {
    requests = [{ id: "request-1", run_id: "run-1", tool_name: openCapability, client_id: "atools-ui", scopes: ["file_read"] }];
    waiting.dialogIntents = intentCount;
    document.body.innerHTML = '<div data-permission-dialog><h2>DeepRead 深读 请求打开文件选择窗口</h2><button>允许一次</button></div>';
    document.querySelector("button")!.addEventListener("click", () => { clicked = true; });
    await expect(approvePublishedOpenDialog(context(openProfile))).rejects.toThrow();
    expect(clicked).toBe(false);
  });

it("accepts only the exact following DeepRead Node gate and leaves its approval to the existing gate", async () => {
  waiting.dialogIntents = 1;
  requests = [{ id: "request-1", run_id: "run-1", tool_name: openCapability, client_id: "atools-ui", scopes: ["file_read"] }];
  approved.dialogSessions = 1; approved.dialogTransport = true; approved.pendingRequests = 1;
  nextNode = { id: "node-request", run_id: "node-run", tool_name: nodeTask.capabilityId, client_id: "atools-ui",
    scopes: ["file_read", "file_write", "network", "shell", "clipboard_read", "clipboard_write", "screenshot", "browser_context", "plugin_data", "system_settings"] };
  document.body.innerHTML = '<div data-permission-dialog><h2>DeepRead 深读 请求打开文件选择窗口</h2><button>允许一次</button></div>';
  document.querySelector("button")!.addEventListener("click", () => {
    clicked = true; clickCount++; permissionTask.status = "succeeded";
    document.querySelector("h2")!.textContent = "DeepRead 深读 请求访问本机";
  });
  const observed = await approvePublishedOpenDialog(context(openProfile));
  expect(observed.nextGate).toBe("node");
  expect(observed.nextTaskRun).toBe("node-run");
  expect(clicked).toBe(true); expect(clickCount).toBe(1);
  expect(nodeTask.status).toBe("awaiting_permission");
  expect(document.querySelector("h2")?.textContent).toBe("DeepRead 深读 请求访问本机");
  expect(invoke.mock.calls.filter(([command]) => command === "get_task_run").map(([, args]) => args))
    .toEqual([{ id: "run-1" }, { id: "node-run" }, { id: "run-1" }]);
});

it.each(["wrongNodeCapability", "wrongNodeScope", "wrongNodeClient", "wrongNodeTitle", "wrongNodeRequestId", "wrongPendingCount", "wrongNodeTask", "legacySession",
  "wrongNodeRunId", "wrongNodeTaskId", "wrongNodeTaskCapability", "legacyOpening", "legacyTransport", "hostSession", "hostIntent",
  "hostTransport", "pathSnapshot", "pathIntent", "pathPreparation", "extraData", "dataIntent", "dataInvocation", "dataPreparation",
  "dialogTransport", "dialogIntent", "dialogInvocation", "dialogPreparation", "frame", "nativePanel"])(
  "rejects contaminated post-approval DeepRead state: %s", async kind => {
    waiting.dialogIntents = 1;
    requests = [{ id: "request-1", run_id: "run-1", tool_name: openCapability, client_id: "atools-ui", scopes: ["file_read"] }];
    approved.dialogSessions = 1; approved.dialogTransport = true; approved.pendingRequests = 1;
    nextNode = { id: "node-request", run_id: "node-run", tool_name: nodeTask.capabilityId, client_id: "atools-ui",
      scopes: ["file_read", "file_write", "network", "shell", "clipboard_read", "clipboard_write", "screenshot", "browser_context", "plugin_data", "system_settings"] };
    document.body.innerHTML = '<div data-permission-dialog><h2>DeepRead 深读 请求打开文件选择窗口</h2><button>允许一次</button></div>';
    document.querySelector("button")!.addEventListener("click", () => { clicked = true; permissionTask.status = "succeeded";
      document.querySelector("h2")!.textContent = kind === "wrongNodeTitle" ? "Other 请求访问本机" : "DeepRead 深读 请求访问本机";
      if (kind === "frame") document.body.insertAdjacentHTML("beforeend", '<iframe title="Plugin"></iframe>'); });
    if (kind === "wrongNodeCapability") nextNode.tool_name = "legacy_node_" + "f".repeat(64);
    if (kind === "wrongNodeScope") nextNode.scopes = ["file_read"];
    if (kind === "wrongNodeClient") nextNode.client_id = "other";
    if (kind === "wrongNodeRequestId") nextNode.id = "";
    if (kind === "wrongPendingCount") approved.pendingRequests = 0;
    if (kind === "wrongNodeTask") nodeTask.status = "running";
    if (kind === "wrongNodeRunId") nextNode.run_id = "other-node-run";
    if (kind === "wrongNodeTaskId") nodeTask.id = "other-node-run";
    if (kind === "wrongNodeTaskCapability") nodeTask.capabilityId = "legacy_node_" + "e".repeat(64);
    if (kind === "legacySession") approved.legacySessions = 1;
    if (kind === "legacyOpening") approved.legacyOpenings = 1;
    if (kind === "legacyTransport") approved.legacyTransport = true;
    if (kind === "hostSession") approved.hostSessions = 1;
    if (kind === "hostIntent") approved.hostIntents = 1;
    if (kind === "hostTransport") approved.hostTransport = true;
    if (kind === "pathSnapshot") approved.activePathSnapshots = 1;
    if (kind === "pathIntent") approved.activePathIntents = 1;
    if (kind === "pathPreparation") approved.activePathPreparations = 1;
    if (kind === "extraData") approved.dataSessions = 2;
    if (kind === "dataIntent") approved.dataIntents = 1;
    if (kind === "dataInvocation") approved.dataInvocations = 1;
    if (kind === "dataPreparation") approved.dataPreparations = 1;
    if (kind === "dialogTransport") approved.dialogTransport = false;
    if (kind === "dialogIntent") approved.dialogIntents = 1;
    if (kind === "dialogInvocation") approved.dialogInvocations = 1;
    if (kind === "dialogPreparation") approved.dialogPreparations = 1;
    if (kind === "nativePanel") approved.nativeDialogs = 1;
    await expect(approvePublishedOpenDialog(context(openProfile))).rejects.toThrow();
    expect(clicked).toBe(true);
  });

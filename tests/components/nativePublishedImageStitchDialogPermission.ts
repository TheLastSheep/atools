import { invoke, permissionDialog } from "./nativePublishedPluginCommon";
import type { PublishedScenarioContext, RuntimeState } from "./nativePublishedPluginCommon";
import { isExactImageStitchProfile } from "./nativePublishedImageStitchContract";
import type { TaskRun } from "../../src/lib/types";

type Access = "open" | "save";
type PendingRequest = { id: string; run_id: string; tool_name: string; client_id: string; scopes: string[] };
const DIALOG_CAPABILITY_PREFIX = "atools.host.dialog.f8c39326deb6950465da3cfd.";
const IMAGE_STITCH_NODE_CAPABILITY = "legacy_node_f8c39326deb6950465da3cfd41107f4cae39d32e2ce23609fa441b3799be0236";
const LEGACY_NODE_SCOPES = ["file_read", "file_write", "network", "shell", "clipboard_read", "clipboard_write",
  "screenshot", "browser_context", "plugin_data", "system_settings"];

function noResourceOrDisplayActivity(value: RuntimeState) {
  return value.resourceLeases === 0 && value.displaySessions === 0
    && value.displayIntents === 0 && value.displayInvocations === 0;
}

function permissionTitle(context: PublishedScenarioContext, access: Access) {
  return access === "open"
    ? `${context.profile.title} 请求打开文件选择窗口`
    : `${context.profile.title} 请求选择文件保存位置`;
}

function exactRequest(value: unknown, access: Access): PendingRequest | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const request = value[0] as Partial<PendingRequest> | null;
  const scope = access === "open" ? "file_read" : "file_write";
  return request && typeof request.id === "string" && request.id.length > 0
    && typeof request.run_id === "string" && request.run_id.length > 0
    && request.tool_name === DIALOG_CAPABILITY_PREFIX + access
    && request.client_id === "atools-ui" && Array.isArray(request.scopes)
    && request.scopes.length === 1 && request.scopes[0] === scope
    ? request as PendingRequest : null;
}

async function readPending(context: PublishedScenarioContext, access: Access) {
  const title = permissionDialog()?.querySelector("h2")?.textContent?.trim();
  if (title !== permissionTitle(context, access)) return null;
  return exactRequest(await invoke<unknown>("list_pending_agent_requests"), access);
}

async function pendingFor(context: PublishedScenarioContext, access: Access) {
  return context.until(() => readPending(context, access),
    `Exact Image Stitch ${access} dialog capability did not reach the permission UI`);
}

async function taskRun(context: PublishedScenarioContext, request: PendingRequest, status: "awaiting_permission" | "succeeded") {
  return context.until(async () => {
    const run = await invoke<TaskRun | null>("get_task_run", { id: request.run_id });
    return run && run.id === request.run_id && run.capabilityId === request.tool_name
      && run.initiator.clientId === "atools-ui" && run.status === status ? run : null;
  }, `Image Stitch ${request.tool_name} TaskRun did not reach ${status}`);
}

function exactNextNodeRequest(value: unknown): PendingRequest | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const request = value[0] as Partial<PendingRequest> | null;
  const scopes = request?.scopes;
  return request && typeof request.id === "string" && request.id.length > 0
    && typeof request.run_id === "string" && request.run_id.length > 0
    && request.tool_name === IMAGE_STITCH_NODE_CAPABILITY && request.client_id === "atools-ui"
    && Array.isArray(scopes) && scopes.length === LEGACY_NODE_SCOPES.length
    && scopes.every(scope => typeof scope === "string" && LEGACY_NODE_SCOPES.includes(scope))
    && new Set(scopes).size === LEGACY_NODE_SCOPES.length
    ? request as PendingRequest : null;
}

async function exactAwaitingNodeRun(request: PendingRequest) {
  const run = await invoke<TaskRun | null>("get_task_run", { id: request.run_id });
  return run && run.id === request.run_id && run.capabilityId === IMAGE_STITCH_NODE_CAPABILITY
    && run.initiator.clientId === "atools-ui" && run.status === "awaiting_permission" ? run : null;
}

function exactPreApprovalState(context: PublishedScenarioContext, value: RuntimeState, access: Access, existingDialogSessions: number) {
  return noResourceOrDisplayActivity(value) && value.pendingRequests === 1
    && value.legacySessions === 0 && value.legacyOpenings === 0 && !value.legacyTransport
    && value.hostSessions === 0 && value.hostIntents === 0 && value.hostInvocations === 0 && !value.hostTransport
    && value.dataSessions === 1 && value.dataTransport && value.dataIntents === 0
    && value.dataInvocations === 0 && value.dataPreparations === 0
    && value.activePathSnapshots === 0 && value.activePathIntents === 0 && value.activePathPreparations === 0
    && value.pathSnapshotBytes === 0 && value.dialogSessions === existingDialogSessions
    && value.dialogIntents === 1 && value.dialogPreparations === 0 && value.dialogInvocations === 0
    && value.dialogTransport === (existingDialogSessions === 1) && value.nativeDialogs === 0
    && !document.querySelector('iframe[title="Plugin"]') && context.profile.dataAccess === true
    && (access === "open" ? existingDialogSessions === 0 : existingDialogSessions === 1);
}

async function approveOne(context: PublishedScenarioContext, access: Access, existingDialogSessions: number) {
  const request = await pendingFor(context, access);
  const waitingRun = await taskRun(context, request, "awaiting_permission");
  const waiting = await invoke<RuntimeState>("native_published_runtime_state");
  context.check(exactPreApprovalState(context, waiting, access, existingDialogSessions),
    `Image Stitch ${access} approval starts only its exact dialog intent without a Node session or native panel`);
  context.check(!document.querySelector('iframe[title="Plugin"]'),
    `Image Stitch page waits for its ${access} permission before mounting`);
  const allowButtons = [...(permissionDialog()?.querySelectorAll<HTMLButtonElement>("button") || [])]
    .filter(button => button.textContent?.trim() === "允许一次");
  context.check(allowButtons.length === 1, `Image Stitch ${access} capability requires one explicit one-time approval`);
  if (allowButtons.length !== 1) throw Error("Production permission UI omitted the unique one-time approval action");
  allowButtons[0].click();
  const completed = await taskRun(context, request, "succeeded");
  return { request, waitingRun, completed };
}

/** Approves only the pinned fixture's two distinct dialog grants; it never opens either picker. */
export async function approvePublishedImageStitchDialogs(context: PublishedScenarioContext) {
  if (!isExactImageStitchProfile(context.profile) || !isExactImageStitchProfile(context.fixture.profile)
    || context.fixture.packageSha256 !== context.profile.directorySha256) {
    throw Error("Image Stitch dialog approvals require the exact isolated package fixture");
  }
  context.setPhase("image-stitch-open-dialog-permission");
  const open = await approveOne(context, "open", 0);
  const afterOpen = await context.until(async () => {
    const runtime = await invoke<RuntimeState>("native_published_runtime_state");
    const save = await readPending(context, "save");
    if (!noResourceOrDisplayActivity(runtime) || !save || runtime.pendingRequests !== 1
      || runtime.dialogSessions !== 1 || !runtime.dialogTransport
      || runtime.dialogIntents !== 1 || runtime.dialogInvocations !== 0 || runtime.dialogPreparations !== 0
      || runtime.nativeDialogs !== 0 || runtime.legacySessions !== 0 || runtime.legacyOpenings !== 0
      || runtime.legacyTransport || document.querySelector('iframe[title="Plugin"]')) return null;
    return { runtime, save };
  }, "Image Stitch open grant did not settle into the separate save permission gate");
  const saveTask = await taskRun(context, afterOpen.save, "awaiting_permission");

  context.setPhase("image-stitch-save-dialog-permission");
  const save = await approveOne(context, "save", 1);
  const ready = await context.until(async () => {
    const runtime = await invoke<RuntimeState>("native_published_runtime_state");
    const isolated = noResourceOrDisplayActivity(runtime)
      && runtime.dialogSessions === 2 && runtime.dialogTransport
      && runtime.dialogIntents === 0 && runtime.dialogInvocations === 0 && runtime.dialogPreparations === 0
      && runtime.nativeDialogs === 0 && runtime.legacySessions === 0 && runtime.legacyOpenings === 0
      && !runtime.legacyTransport && runtime.hostSessions === 0 && runtime.hostIntents === 0
      && runtime.hostInvocations === 0 && !runtime.hostTransport
      && runtime.dataSessions === 1 && runtime.dataTransport && runtime.dataIntents === 0
      && runtime.dataInvocations === 0 && runtime.dataPreparations === 0
      && runtime.activePathSnapshots === 0 && runtime.activePathIntents === 0
      && runtime.activePathPreparations === 0 && runtime.pathSnapshotBytes === 0
      && !document.querySelector('iframe[title="Plugin"]');
    if (!isolated) return null;
    const pending = await invoke<unknown>("list_pending_agent_requests");
    if (runtime.pendingRequests === 0 && Array.isArray(pending) && pending.length === 0 && !permissionDialog()) {
      return { runtime, nextGate: "none" as const };
    }
    const title = permissionDialog()?.querySelector("h2")?.textContent?.trim() || "";
    const request = exactNextNodeRequest(pending);
    if (runtime.pendingRequests !== 1 || title !== "图片拼接 请求访问本机" || !request) return null;
    const nodeRun = await exactAwaitingNodeRun(request);
    return nodeRun ? { runtime, nextGate: "node" as const, nextTaskRun: nodeRun.id } : null;
  }, "Image Stitch open/save approvals did not leave idle state or the exact next Node authorization gate");
  context.check(open.completed.id === open.waitingRun.id && save.completed.id === save.waitingRun.id
    && afterOpen.save.run_id === saveTask.id,
    "Image Stitch open and save scopes each complete their own exact permission TaskRun");
  context.check(open.request.tool_name === DIALOG_CAPABILITY_PREFIX + "open" && open.request.scopes[0] === "file_read"
    && save.request.tool_name === DIALOG_CAPABILITY_PREFIX + "save" && save.request.scopes[0] === "file_write",
    "Image Stitch retains independent FileRead and FileWrite dialog grants");
  return {
    open: { taskRunId: open.completed.id, capability: open.request.tool_name, scope: "file_read" },
    save: { taskRunId: save.completed.id, capability: save.request.tool_name, scope: "file_write" },
    sessions: ready.runtime.dialogSessions, nextGate: ready.nextGate,
    nextTaskRun: ready.nextGate === "node" ? ready.nextTaskRun : undefined, nativePickerOpened: false,
  };
}

import { dataRuntimeDrained, invoke, permissionDialog } from "./nativePublishedPluginCommon";
import { matchesPublishedNodeRequest } from "./nativePublishedNodeAuthorization";
import type { PublishedPluginProfile, PublishedScenarioContext, RuntimeState } from "./nativePublishedPluginCommon";
import type { TaskRun } from "../../src/lib/types";

const DISPLAY_CAPABILITY = "atools.host.display.14ff3d75f7a75dc386ed3777.read";
const NODE_CAPABILITY = "legacy_node_14ff3d75f7a75dc386ed3777b20c268612e207571b56d0fcedcd234184682cdb";
const DISPLAY_TITLE = "DeepRead 深读 请求读取显示器信息";
const NODE_TITLE = "DeepRead 深读 请求访问本机";
const NODE_SCOPES = ["file_read", "file_write", "network", "shell", "clipboard_read", "clipboard_write",
  "screenshot", "browser_context", "plugin_data", "system_settings"];

type PendingDisplayRequest = { id: string; run_id: string; tool_name: string; client_id: string; scopes: string[] };

export function matchesPublishedDisplayRequest(title: string, pluginTitle: string, value: unknown): PendingDisplayRequest | null {
  if (title !== `${pluginTitle} 请求读取显示器信息` || pluginTitle !== "DeepRead 深读"
    || !Array.isArray(value) || value.length !== 1) return null;
  const item = value[0] as Record<string, unknown> | null;
  if (!item || typeof item !== "object" || Array.isArray(item) || item.tool_name !== DISPLAY_CAPABILITY
    || item.client_id !== "atools-ui" || !Array.isArray(item.scopes) || item.scopes.length !== 1
    || item.scopes[0] !== "display_read" || typeof item.id !== "string" || !item.id
    || typeof item.run_id !== "string" || !item.run_id) return null;
  return item as PendingDisplayRequest;
}

function exactTaskRun(task: TaskRun | null, request: PendingDisplayRequest, status: string) {
  return task !== null && task.id === request.run_id && task.capabilityId === DISPLAY_CAPABILITY
    && task.initiator?.clientId === "atools-ui" && task.status === status;
}

function hasDisplaySessionOutput(task: TaskRun | null, request: PendingDisplayRequest): task is TaskRun & {
  output: { sessionId: string };
} {
  if (!task || !exactTaskRun(task, request, "succeeded")) return false;
  const output = task.output;
  return typeof output === "object" && output !== null && !Array.isArray(output)
    && "sessionId" in output && typeof output.sessionId === "string";
}

export function displayPermissionIsolationReady(value: RuntimeState, profile: Pick<PublishedPluginProfile, "dataAccess" | "dialogAccess">) {
  const dataReady = profile.dataAccess
    ? value.dataSessions === 1 && value.dataTransport && value.dataIntents === 0
      && value.dataInvocations === 0 && value.dataPreparations === 0 : dataRuntimeDrained(value);
  const dialogReady = profile.dialogAccess === "open"
    ? value.dialogSessions === 1 && value.dialogTransport && value.dialogIntents === 0
      && value.dialogInvocations === 0 && value.dialogPreparations === 0 && value.nativeDialogs === 0
    : value.dialogSessions === 0 && value.dialogIntents === 0 && value.dialogInvocations === 0
      && value.dialogPreparations === 0 && value.nativeDialogs === 0 && !value.dialogTransport;
  return value.displayRuntimeAvailable === true && value.displaySessions === 0 && value.displayIntents === 1
    && value.displayInvocations === 0 && value.resourceLeases === 0 && value.legacySessions === 0 && value.legacyOpenings === 0
    && !value.legacyTransport && value.hostSessions === 0 && value.hostIntents === 0
    && value.hostInvocations === 0 && !value.hostTransport && dataReady && dialogReady
    && value.pathRuntimeAvailable && value.activePathSnapshots === 0 && value.activePathIntents === 0
    && value.activePathPreparations === 0 && value.pathSnapshotBytes === 0 && value.pendingRequests === 1;
}

export function displayPermissionAfterApprovalIsolated(value: RuntimeState,
  profile: Pick<PublishedPluginProfile, "dataAccess" | "dialogAccess">, ownedResourceSessionCount: number) {
  const dataReady = profile.dataAccess
    ? value.dataSessions === 1 && value.dataTransport && value.dataIntents === 0
      && value.dataInvocations === 0 && value.dataPreparations === 0 : dataRuntimeDrained(value);
  const dialogReady = profile.dialogAccess === "open"
    ? value.dialogSessions === 1 && value.dialogTransport && value.dialogIntents === 0
      && value.dialogInvocations === 0 && value.dialogPreparations === 0 && value.nativeDialogs === 0
    : value.dialogSessions === 0 && value.dialogIntents === 0 && value.dialogInvocations === 0
      && value.dialogPreparations === 0 && value.nativeDialogs === 0 && !value.dialogTransport;
  const resourceLeaseMatchesOwner = Number.isSafeInteger(ownedResourceSessionCount)
    && ownedResourceSessionCount >= 0 && ownedResourceSessionCount <= 1
    && value.resourceLeases === ownedResourceSessionCount;
  return value.displayRuntimeAvailable === true && value.displaySessions === 1 && value.displayIntents === 0
    && value.displayInvocations === 0 && resourceLeaseMatchesOwner && value.legacySessions === 0
    && value.legacyOpenings === 0 && !value.legacyTransport && value.hostSessions === 0 && value.hostIntents === 0
    && value.hostInvocations === 0 && !value.hostTransport && dataReady && dialogReady
    && value.pathRuntimeAvailable && value.activePathSnapshots === 0 && value.activePathIntents === 0
    && value.activePathPreparations === 0 && value.pathSnapshotBytes === 0 && value.nativeDialogs === 0;
}

/** Approve DeepRead's exact display-metadata startup gate; never read pixels or approve Node. */
export async function approvePublishedDisplayMetadata(context: PublishedScenarioContext) {
  if (context.profile.caseId !== "converted-deepread-source" || context.profile.id !== "deepread"
    || context.profile.title !== "DeepRead 深读" || context.profile.pathAccess !== "none"
    || context.profile.dataAccess !== true || context.profile.dialogAccess !== "open") {
    throw Error("No display-metadata permission registered for this fixed DeepRead case");
  }
  const request = await context.until(async () => {
    const title = permissionDialog()?.querySelector("h2")?.textContent?.trim() || "";
    if (title !== DISPLAY_TITLE) return null;
    const pending = await invoke<unknown>("list_pending_agent_requests");
    return matchesPublishedDisplayRequest(title, context.profile.title, pending);
  }, "Exact DeepRead display capability did not reach the real permission UI");
  const task = await invoke<TaskRun | null>("get_task_run", { id: request.run_id });
  context.check(exactTaskRun(task, request, "awaiting_permission"),
    "Display metadata approval is bound to the exact pending DeepRead TaskRun");
  const [before, beforeResourceSessions] = await Promise.all([
    invoke<RuntimeState>("native_published_runtime_state"),
    invoke<unknown>("native_published_resource_sessions"),
  ]);
  context.check(Array.isArray(beforeResourceSessions) && beforeResourceSessions.length === 0,
    "No fixture-owned package resource lease exists before display metadata approval");
  context.check(displayPermissionIsolationReady(before, context.profile),
    "Display permission retains only approved data and open-dialog sessions, with no Node, host, path snapshot or native panel");
  context.check(!document.querySelector('iframe[title="Plugin"]'),
    "Original DeepRead page waits before display metadata approval");
  const allow = [...(permissionDialog()?.querySelectorAll<HTMLButtonElement>("button") || [])]
    .find(button => button.textContent?.trim() === "允许一次");
  context.check(allow, "Display metadata requires a fresh explicit one-time approval");
  if (!allow) throw Error("Production permission UI omitted one-time display approval");
  allow.click();
  const after = await context.until(async () => {
    const [value, completed, pending, resourceSessions] = await Promise.all([
      invoke<RuntimeState>("native_published_runtime_state"),
      invoke<TaskRun | null>("get_task_run", { id: request.run_id }),
      invoke<unknown>("list_pending_agent_requests"),
      invoke<unknown>("native_published_resource_sessions"),
    ]);
    if (!hasDisplaySessionOutput(completed, request)
      || !Array.isArray(resourceSessions)
      || !displayPermissionAfterApprovalIsolated(value, context.profile, resourceSessions.length)
      || (value.pendingRequests !== 0 && value.pendingRequests !== 1)
      || document.querySelector('iframe[title="Plugin"]')) return null;
    let nextNodeTaskRun: string | undefined;
    if (value.pendingRequests === 1) {
      const title = permissionDialog()?.querySelector("h2")?.textContent?.trim() || "";
      if (title !== NODE_TITLE || !matchesPublishedNodeRequest(title, context.profile.title, pending)
        || !Array.isArray(pending)) return null;
      const item = pending[0] as Record<string, unknown>;
      const scopes = item.scopes;
      if (item.tool_name !== NODE_CAPABILITY || typeof item.run_id !== "string" || !item.run_id
        || !Array.isArray(scopes) || scopes.length !== NODE_SCOPES.length
        || scopes.some(scope => typeof scope !== "string" || !NODE_SCOPES.includes(scope))
        || new Set(scopes).size !== NODE_SCOPES.length) return null;
      const node = await invoke<TaskRun | null>("get_task_run", { id: item.run_id });
      if (!node || node.id !== item.run_id || node.capabilityId !== NODE_CAPABILITY
        || node.status !== "awaiting_permission" || node.initiator?.clientId !== "atools-ui") return null;
      nextNodeTaskRun = node.id;
    } else if (!Array.isArray(pending) || pending.length !== 0 || permissionDialog()) return null;
    return { runtime: value, nextGate: nextNodeTaskRun ? "node" as const : "none" as const, nextNodeTaskRun };
  }, "Display metadata TaskRun did not complete into one idle session or the exact next DeepRead Node gate");
  return { before, after: after.runtime, capability: request.tool_name, scope: "display_read",
    completedTaskRun: request.run_id, nextGate: after.nextGate, nextNodeTaskRun: after.nextNodeTaskRun,
    displayInvocationsAfterApproval: after.runtime.displayInvocations,
    screenPixelsRead: false, nativePanelRequestedByScenario: false };
}

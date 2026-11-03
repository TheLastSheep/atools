import { dataRuntimeDrained, invoke, permissionDialog } from "./nativePublishedPluginCommon";
import type { PublishedScenarioContext, RuntimeState } from "./nativePublishedPluginCommon";
import { matchesPublishedNodeRequest } from "./nativePublishedNodeAuthorization";
import type { TaskRun } from "../../src/lib/types";
// The dialog registry hashes the fixed plugin ID and uses its first 24 lowercase hex characters.
const DEEPREAD_OPEN_CAPABILITY = "atools.host.dialog.14ff3d75f7a75dc386ed3777.open";
const DEEPREAD_NODE_CAPABILITY = "legacy_node_14ff3d75f7a75dc386ed3777b20c268612e207571b56d0fcedcd234184682cdb";
const LEGACY_NODE_SCOPES = ["file_read", "file_write", "network", "shell", "clipboard_read", "clipboard_write",
  "screenshot", "browser_context", "plugin_data", "system_settings"];

function exactDeepReadNodeRequest(title: string, value: unknown) {
  if (!matchesPublishedNodeRequest(title, "DeepRead 深读", value) || !Array.isArray(value)) return null;
  const request = value[0] as Record<string, unknown>;
  const scopes = request.scopes;
  if (request.tool_name !== DEEPREAD_NODE_CAPABILITY || typeof request.id !== "string" || !request.id
    || typeof request.run_id !== "string" || !request.run_id || !Array.isArray(scopes)
    || scopes.length !== LEGACY_NODE_SCOPES.length || scopes.some(scope => typeof scope !== "string" || !LEGACY_NODE_SCOPES.includes(scope))
    || new Set(scopes).size !== LEGACY_NODE_SCOPES.length) return null;
  return request as { id: string; run_id: string; tool_name: string; client_id: string; scopes: string[] };
}

async function exactAwaitingDeepReadNodeRun(request: { id: string; run_id: string; tool_name: string }) {
  const task = await invoke<TaskRun | null>("get_task_run", { id: request.run_id });
  return task !== null && task.id === request.run_id && task.capabilityId === request.tool_name
    && task.status === "awaiting_permission" ? task : null;
}

/** Authorize only the registered startup save-dialog metadata; never open a native panel. */
export async function approvePublishedSaveDialog(context: PublishedScenarioContext) {
  if (context.profile.dialogAccess !== "save") throw Error("No save-dialog permission registered for this original case");
  const request = await context.until(async () => {
    const title = permissionDialog()?.querySelector("h2")?.textContent || "";
    if (!title.includes(context.profile.title) || !title.includes("请求选择文件保存位置")) return null;
    const pending = await invoke<Array<{ tool_name: string; client_id: string; scopes: string[] }>>("list_pending_agent_requests");
    return pending.length === 1 && /^atools\.host\.dialog\.[a-f0-9]{24}\.save$/.test(pending[0].tool_name)
      && pending[0].client_id === "atools-ui" && pending[0].scopes.length === 1 && pending[0].scopes[0] === "file_write" ? pending[0] : null;
  }, "Exact startup save-dialog capability did not reach the original permission UI");
  const before = await invoke<RuntimeState>("native_published_runtime_state");
  context.check(before.pendingRequests === 1 && before.legacySessions === 0 && before.legacyOpenings === 0 && !before.legacyTransport
    && before.hostSessions === 0 && !before.hostTransport && before.activePathSnapshots === 0
    && before.dialogSessions === 0 && before.nativeDialogs === 0 && before.dialogInvocations === 0
    && (context.profile.dataAccess ? before.dataSessions === 1 && before.dataTransport : dataRuntimeDrained(before)),
    "Startup save-dialog metadata approval has no Node, clipboard, path snapshot or native panel, and only its registered data runtime");
  context.check(!document.querySelector('iframe[title="Plugin"]'), "Original page waits until its startup save-dialog metadata is approved");
  const allow = [...permissionDialog()!.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent?.trim() === "允许一次");
  context.check(allow, "Startup save-dialog metadata needs a fresh explicit one-time approval");
  allow!.click();
  const after = await context.until(async () => {
    const value = await invoke<RuntimeState>("native_published_runtime_state");
    return value.dialogSessions === 1 && value.dialogTransport && value.dialogIntents === 0
      && value.dialogPreparations === 0 && value.dialogInvocations === 0 && value.nativeDialogs === 0 ? value : null;
  }, "Startup save metadata did not create one idle session without opening any native panel");
  return { before, after, capability: request.tool_name, scope: "file_write", nativePanelRequestedByScenario: false };
}

/** Approve only the registered startup open-dialog permission; never invoke the native picker. */
export async function approvePublishedOpenDialog(context: PublishedScenarioContext) {
  if (context.profile.caseId !== "converted-deepread-source" || context.profile.id !== "deepread"
    || context.profile.title !== "DeepRead 深读" || context.profile.dialogAccess !== "open") {
    throw Error("No open-dialog permission registered for this fixed DeepRead case");
  }
  const request = await context.until(async () => {
    const title = permissionDialog()?.querySelector("h2")?.textContent || "";
    if (title.trim() !== context.profile.title + " 请求打开文件选择窗口") return null;
    const pending = await invoke<Array<{ id: string; run_id?: string; tool_name: string; client_id: string; scopes: string[] }>>("list_pending_agent_requests");
    return pending.length === 1 && pending[0].tool_name === DEEPREAD_OPEN_CAPABILITY
      && pending[0].client_id === "atools-ui" && pending[0].scopes.length === 1 && pending[0].scopes[0] === "file_read"
      ? pending[0] : null;
  }, "Exact startup open-dialog capability did not reach the original permission UI");
  if (!request.id || !request.run_id) throw Error("Open-dialog permission has no exact pending TaskRun identity");
  const task = await invoke<TaskRun | null>("get_task_run", { id: request.run_id });
  context.check(task !== null && task.id === request.run_id && task.capabilityId === request.tool_name
    && task.status === "awaiting_permission",
    "Open-dialog one-time approval is bound to its exact pending TaskRun and plugin capability");
  const before = await invoke<RuntimeState>("native_published_runtime_state");
  const dataReady = context.profile.dataAccess
    ? before.dataSessions === 1 && before.dataTransport && before.dataIntents === 0
      && before.dataInvocations === 0 && before.dataPreparations === 0 : dataRuntimeDrained(before);
  context.check(before.pendingRequests === 1 && before.legacySessions === 0 && before.legacyOpenings === 0 && !before.legacyTransport
    && before.hostSessions === 0 && before.hostIntents === 0 && before.hostInvocations === 0 && !before.hostTransport
    && dataReady && before.activePathSnapshots === 0 && before.activePathIntents === 0
    && before.activePathPreparations === 0 && before.pathSnapshotBytes === 0
    && before.dialogSessions === 0 && before.dialogIntents === 1 && before.dialogInvocations === 0
    && before.dialogPreparations === 0 && before.nativeDialogs === 0 && !before.dialogTransport,
    "Open-dialog approval starts no Node, clipboard, path snapshot or native panel and retains only approved data");
  context.check(!document.querySelector('iframe[title="Plugin"]'), "Original page waits before open-dialog approval");
  const allow = [...permissionDialog()!.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent?.trim() === "允许一次");
  context.check(allow, "Open-dialog metadata requires a fresh explicit one-time approval");
  if (!allow) throw Error("Production permission UI omitted one-time open-dialog approval");
  allow.click();
  const after = await context.until(async () => {
    const value = await invoke<RuntimeState>("native_published_runtime_state");
    const pending = await invoke<unknown>("list_pending_agent_requests");
    const baseIsolated = value.legacySessions === 0 && value.legacyOpenings === 0 && !value.legacyTransport
      && value.hostSessions === 0 && value.hostIntents === 0 && value.hostInvocations === 0 && !value.hostTransport
      && value.dataSessions === 1 && value.dataTransport && value.dataIntents === 0
      && value.dataInvocations === 0 && value.dataPreparations === 0
      && value.activePathSnapshots === 0 && value.activePathIntents === 0 && value.activePathPreparations === 0
      && value.pathSnapshotBytes === 0 && value.dialogSessions === 1 && value.dialogTransport
      && value.dialogIntents === 0 && value.dialogPreparations === 0 && value.dialogInvocations === 0
      && value.nativeDialogs === 0 && !document.querySelector('iframe[title="Plugin"]');
    if (!baseIsolated) return null;
    if (value.pendingRequests === 0 && Array.isArray(pending) && pending.length === 0 && !permissionDialog()) {
      return { runtime: value, nextGate: "none" as const };
    }
    const title = permissionDialog()?.querySelector("h2")?.textContent?.trim() || "";
    const nodeRequest = exactDeepReadNodeRequest(title, pending);
    if (value.pendingRequests !== 1 || !nodeRequest || title !== "DeepRead 深读 请求访问本机") return null;
    const nodeTask = await exactAwaitingDeepReadNodeRun(nodeRequest);
    return nodeTask ? { runtime: value, nextGate: "node" as const, nextTaskRun: nodeTask.id } : null;
  }, "Open-dialog approval did not leave only idle authorized runtimes or the exact next DeepRead Node gate");
  const completed = await context.until(async () => {
    const value = await invoke<TaskRun | null>("get_task_run", { id: request.run_id });
    return value !== null && value.id === request.run_id && value.capabilityId === request.tool_name
      && value.status === "succeeded" ? value : null;
  }, "Open-dialog TaskRun did not complete after its exact one-time approval");
  return { before, after: after.runtime, nextGate: after.nextGate, nextTaskRun: after.nextGate === "node" ? after.nextTaskRun : undefined,
    completedTaskRun: completed.id, capability: request.tool_name, scope: "file_read", nativePanelRequestedByScenario: false };
}

import { approvePublishedOpenDialog } from "./nativePublishedDialogPermission";
import { approvePublishedDisplayMetadata } from "./nativePublishedDisplayPermission";
import { classifyDeepReadPermission, waitForPublishedNodeSession } from "./nativePublishedNodeAuthorization";
import { currentPublishedFrameDocument, invoke, permissionDialog } from "./nativePublishedPluginCommon";
import { waitForDeepReadLauncherReturn } from "./nativeDeepReadLauncherReturn";
import type { PublishedFrameIsolation, PublishedScenarioContext, RuntimeState, TaskRun } from "./nativePublishedPluginCommon";
import { requiresLegacyNodeSession } from "./nativePublishedRuntimeRequirement";

const CASE_ID = "converted-deepread-source";
const PLUGIN_ID = "deepread";
const PLUGIN_TITLE = "DeepRead 深读";
const DATA_CAPABILITY = "atools.host.data.14ff3d75f7a75dc386ed3777";
const NODE_CAPABILITY = "legacy_node_14ff3d75f7a75dc386ed3777b20c268612e207571b56d0fcedcd234184682cdb";
const DATA_TITLE = `${PLUGIN_TITLE} 请求访问自己的数据`;
const NODE_TITLE = `${PLUGIN_TITLE} 请求访问本机`;
const NODE_SCOPES = ["file_read", "file_write", "network", "shell", "clipboard_read", "clipboard_write",
  "screenshot", "browser_context", "plugin_data", "system_settings"];
const APPROVED_SCOPES = new Set(["plugin_data"]);
// The pinned App.vue loadState writes library + bookSources on a fresh document; upsertBook
// writes library + lastBookId and its activeBookId watcher writes lastBookId again. One
// settings-watcher write is source-reachable, so after a terminal consent baseline this is 5..6.
const MIN_FILES_STORAGE_WRITES = 5;
const MAX_FILES_STORAGE_WRITES = 6;

export type DeepReadFrameIdentity = {
  frame: HTMLIFrameElement;
  window: Window;
  srcdoc: string;
  nonce: string;
};

export type DeepReadDataRequest = {
  id: string;
  run_id: string;
  client_id: "atools-ui";
  tool_name: typeof DATA_CAPABILITY;
  scopes: ["plugin_data"];
};
type DeepReadTaskRun = TaskRun & { input?: unknown; initiator?: { clientId?: string | null } };
type DeepReadPermissionGate = "data" | "dialog" | "paths" | "display" | "node";
export type DeepReadActivationReadiness<T> =
  | { kind: "permission"; permission: DeepReadPermissionGate }
  | { kind: "ready"; nonce: string; value: T };

function taskMethod(run: DeepReadTaskRun): string | null {
  const input = run.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const method = (input as Record<string, unknown>).method;
  return typeof method === "string" ? method : null;
}

export function isDeepReadStorageSetItem(run: DeepReadTaskRun, beforeIds: ReadonlySet<string>): boolean {
  return !beforeIds.has(run.id) && run.capabilityId === DATA_CAPABILITY && run.initiator?.clientId === "atools-ui"
    && taskMethod(run) === "dbStorage.setItem";
}

export function isDeepReadStorageWrite(run: DeepReadTaskRun, beforeIds: ReadonlySet<string>): boolean {
  return isDeepReadStorageSetItem(run, beforeIds) && run.status === "succeeded";
}

export type DeepReadFilesStorageSummary = { settled: boolean; successfulWrites: number; complete: boolean };

/** Bounded source-backed activity check for one files activation after a quiescent document baseline. */
export function summarizeDeepReadFilesStorageRuns(runs: DeepReadTaskRun[], beforeIds: ReadonlySet<string>): DeepReadFilesStorageSummary {
  let successfulWrites = 0;
  let settled = true;
  for (const run of runs) {
    if (beforeIds.has(run.id) || run.capabilityId !== DATA_CAPABILITY) continue;
    if (run.initiator?.clientId !== "atools-ui") {
      throw Error("DeepRead files activation included a foreign plugin-data caller");
    }
    const method = taskMethod(run);
    const input = run.input && typeof run.input === "object" && !Array.isArray(run.input)
      ? run.input as Record<string, unknown> : null;
    const sessionOpen = method === null && input !== null && Object.keys(input).length === 2
      && input.operation === "open" && typeof input.intentId === "string" && input.intentId.length > 0;
    if (!sessionOpen && method !== "dbStorage.getItem" && method !== "dbStorage.setItem" && method !== "webStorage.getItem") {
      throw Error("DeepRead files activation used an unreviewed plugin-data method");
    }
    if (["created", "awaiting_permission", "running"].includes(run.status)) {
      settled = false;
      continue;
    }
    if (run.status !== "succeeded") throw Error("DeepRead files storage TaskRun did not succeed");
    if (method === "dbStorage.setItem") successfulWrites += 1;
    if (successfulWrites > MAX_FILES_STORAGE_WRITES) {
      throw Error("DeepRead files activation exceeded its source-backed storage write budget");
    }
  }
  return { settled, successfulWrites, complete: settled && successfulWrites >= MIN_FILES_STORAGE_WRITES };
}

/** Capture a fresh authenticated document only after consent work and its data runtime have quiesced. */
export async function waitForDeepReadDataIdleBaseline(context: PublishedScenarioContext,
  identity: DeepReadFrameIdentity): Promise<TaskRun[]> {
  return context.until(async () => {
    const ensureCurrentIdleDocument = () => {
      if (!frameIdentityStillCurrent(context, identity)) throw Error("DeepRead document changed before the files activation baseline");
      if (permissionDialog()) return false;
      return true;
    };
    if (!ensureCurrentIdleDocument()) return null;
    const runtime = await invoke<RuntimeState>("native_published_runtime_state");
    if (!ensureCurrentIdleDocument()) return null;
    if (runtime.pendingRequests !== 0 || runtime.dataInvocations !== 0 || runtime.dataPreparations !== 0) return null;
    const firstRuns = await invoke<DeepReadTaskRun[]>("list_task_runs", { limit: 1000 });
    if (!ensureCurrentIdleDocument()) return null;
    const isTerminal = (runs: DeepReadTaskRun[]) => runs.filter(run => run.capabilityId === DATA_CAPABILITY)
      .every(run => ["succeeded", "failed", "cancelled", "partial"].includes(run.status));
    if (!isTerminal(firstRuns)) return null;
    const finalRuntime = await invoke<RuntimeState>("native_published_runtime_state");
    if (!ensureCurrentIdleDocument()) return null;
    if (finalRuntime.pendingRequests !== 0 || finalRuntime.dataInvocations !== 0 || finalRuntime.dataPreparations !== 0) return null;
    const finalRuns = await invoke<DeepReadTaskRun[]>("list_task_runs", { limit: 1000 });
    if (!ensureCurrentIdleDocument()) return null;
    if (!isTerminal(finalRuns)) return null;
    const finalRuntimeCheck = await invoke<RuntimeState>("native_published_runtime_state");
    if (!ensureCurrentIdleDocument()) return null;
    if (finalRuntimeCheck.pendingRequests !== 0 || finalRuntimeCheck.dataInvocations !== 0
      || finalRuntimeCheck.dataPreparations !== 0) return null;
    const dataRuns = (runs: DeepReadTaskRun[]) => runs.filter(run => run.capabilityId === DATA_CAPABILITY)
      .map(run => `${run.id}\u0000${run.status}`).sort();
    const firstDataRuns = dataRuns(firstRuns), finalDataRuns = dataRuns(finalRuns);
    if (firstDataRuns.length !== finalDataRuns.length
      || firstDataRuns.some((run, index) => run !== finalDataRuns[index])) return null;
    return finalRuns;
  }, "DeepRead did not reach an authenticated, terminal data baseline after first-use consent");
}

function deepReadFilesInputMatches(run: DeepReadTaskRun, expectedPayloadJsonBytes: number): boolean {
  const input = run.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const fields = input as Record<string, unknown>;
  const summary = fields.payloadSummary;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return false;
  const payload = summary as Record<string, unknown>;
  return Object.keys(fields).length === 3 && fields.code === "deepread-import" && fields.expectedPluginId === PLUGIN_ID
    && Object.keys(payload).length === 3 && payload.type === "array" && payload.contentRedacted === true
    && payload.jsonBytes === expectedPayloadJsonBytes;
}

export function isDeepReadFilesFeatureTaskRun(run: DeepReadTaskRun, beforeIds: ReadonlySet<string>,
  expectedPayloadJsonBytes: number): boolean {
  return !beforeIds.has(run.id) && run.capabilityId === "plugin.feature.deepread-import"
    && run.initiator?.clientId === "atools-ui" && deepReadFilesInputMatches(run, expectedPayloadJsonBytes);
}

/** Poll read-only readiness until an authenticated document nonce actually changes; never replays activation. */
export async function waitForDeepReadActivationReadiness<T>(context: Pick<PublishedScenarioContext, "until">,
  read: () => Promise<DeepReadActivationReadiness<T> | null>, previousNonce: string | null, requireFreshDocument: boolean) {
  return context.until(async () => {
    const result = await read();
    if (!result || result.kind === "permission") return result;
    if (!result.nonce || requireFreshDocument && previousNonce && result.nonce === previousNonce) return null;
    return result;
  }, "DeepRead activation did not reach a fresh authenticated document or reviewed permission gate");
}

export function matchesDeepReadDataRequest(title: string, value: unknown): DeepReadDataRequest | null {
  if (title.trim() !== DATA_TITLE || !Array.isArray(value) || value.length !== 1) return null;
  const item = value[0] as Record<string, unknown> | null;
  if (!item || typeof item !== "object" || Array.isArray(item) || item.tool_name !== DATA_CAPABILITY
    || item.client_id !== "atools-ui" || typeof item.id !== "string" || !item.id
    || typeof item.run_id !== "string" || !item.run_id || !Array.isArray(item.scopes)
    || item.scopes.length !== 1 || item.scopes[0] !== "plugin_data"
    || item.scopes.some(scope => typeof scope !== "string" || !APPROVED_SCOPES.has(scope))) return null;
  return item as DeepReadDataRequest;
}

export function isExactAwaitingDeepReadDataRun(value: DeepReadTaskRun | null, request: DeepReadDataRequest): boolean {
  return value !== null && value.id === request.run_id && value.capabilityId === DATA_CAPABILITY
    && value.initiator?.clientId === "atools-ui" && value.status === "awaiting_permission";
}

export function isExactAwaitingDeepReadNodeRun(value: DeepReadTaskRun | null, request: Record<string, unknown>): boolean {
  return value !== null && value.id === request.run_id && value.capabilityId === NODE_CAPABILITY
    && value.initiator?.clientId === "atools-ui" && value.status === "awaiting_permission";
}

export function captureDeepReadFrameIdentity(context: Pick<PublishedScenarioContext, "observations">,
  frame = document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]')): DeepReadFrameIdentity {
  const window = frame?.contentWindow;
  const nonce = currentPublishedFrameDocument(context);
  if (!frame || !window || !frame.srcdoc || !nonce) throw Error("DeepRead frame has no authenticated current document identity");
  return { frame, window, srcdoc: frame.srcdoc, nonce };
}

export function deepReadFrameIdentityIsCurrent(context: Pick<PublishedScenarioContext, "observations">,
  identity: DeepReadFrameIdentity): boolean {
  return frameIdentityStillCurrent(context, identity);
}

function frameIdentityStillCurrent(context: Pick<PublishedScenarioContext, "observations">, identity: DeepReadFrameIdentity) {
  return document.querySelector('iframe[title="Plugin"]') === identity.frame
    && identity.frame.contentWindow === identity.window && identity.frame.srcdoc === identity.srcdoc
    && currentPublishedFrameDocument(context) === identity.nonce;
}

export function matchesExactDeepReadNodeRequest(title: string, value: unknown): Record<string, unknown> | null {
  if (title.trim() !== NODE_TITLE || !Array.isArray(value) || value.length !== 1) return null;
  const item = value[0] as Record<string, unknown> | null;
  if (!item || typeof item !== "object" || Array.isArray(item) || item.tool_name !== NODE_CAPABILITY
    || item.client_id !== "atools-ui" || typeof item.id !== "string" || !item.id
    || typeof item.run_id !== "string" || !item.run_id || !Array.isArray(item.scopes)
    || item.scopes.length !== NODE_SCOPES.length || item.scopes.some(scope => typeof scope !== "string" || !NODE_SCOPES.includes(scope))
    || new Set(item.scopes).size !== NODE_SCOPES.length) return null;
  return item;
}

export async function approveDeepReadDataPermission(context: PublishedScenarioContext,
  expectedFrame?: DeepReadFrameIdentity) {
  if (context.profile.caseId !== CASE_ID || context.profile.id !== PLUGIN_ID || context.profile.title !== PLUGIN_TITLE
    || context.profile.dataAccess !== true) throw Error("Plugin-data approval is not registered for this fixed DeepRead profile");
  const request = await context.until(async () => {
    const title = permissionDialog()?.querySelector("h2")?.textContent || "";
    const pending = await invoke<unknown>("list_pending_agent_requests");
    const match = matchesDeepReadDataRequest(title, pending);
    if (!match) return null;
    const task = await invoke<TaskRun | null>("get_task_run", { id: match.run_id });
    return isExactAwaitingDeepReadDataRun(task, match) ? match : null;
  }, "The exact DeepRead plugin-data request did not reach its pending TaskRun gate");

  const before = await invoke<RuntimeState>("native_published_runtime_state");
  context.check(before.pendingRequests === 1 && before.dataIntents === 1 && before.dataSessions === 0
    && before.dataInvocations === 0 && before.dataPreparations === 0 && !before.dataTransport,
  "DeepRead waits at exactly one plugin-data request before opening its data session");
  if (expectedFrame) {
    if (!frameIdentityStillCurrent(context, expectedFrame)) throw Error("DeepRead document changed before its data permission was approved");
  } else if (document.querySelector('iframe[title="Plugin"]')) {
    throw Error("DeepRead data gate appeared after a frame was expected to be withheld");
  }
  const dialog = permissionDialog();
  const allow = [...(dialog?.querySelectorAll<HTMLButtonElement>("button") || [])]
    .find(button => button.textContent?.trim() === "允许一次");
  context.check(allow, "DeepRead plugin data requires an explicit one-time approval");
  if (!allow) throw Error("Production permission UI omitted one-time DeepRead data approval");
  allow.click();

  const completed = await context.until(async () => {
    const task = await invoke<TaskRun | null>("get_task_run", { id: request.run_id });
    if (!task || task.id !== request.run_id || task.capabilityId !== DATA_CAPABILITY) return null;
    if (task.status === "failed" || task.status === "cancelled") throw Error("DeepRead data permission TaskRun did not complete successfully");
    const pending = await invoke<unknown>("list_pending_agent_requests");
    if (Array.isArray(pending) && pending.some(item => item && typeof item === "object"
      && (item as Record<string, unknown>).id === request.id)) return null;
    return task.status === "succeeded" ? task : null;
  }, "Exact DeepRead plugin-data authorization did not complete its TaskRun");
  const after = await invoke<RuntimeState>("native_published_runtime_state");
  return { capability: request.tool_name, scope: "plugin_data", taskRunStatus: completed.status,
    dataSessionCountAfterApproval: after.dataSessions, dataTransportAfterApproval: after.dataTransport };
}

async function approveExactDeepReadNodePermission(context: PublishedScenarioContext) {
  await context.until(async () => {
    const title = permissionDialog()?.querySelector("h2")?.textContent || "";
    const pending = await invoke<unknown>("list_pending_agent_requests");
    const match = matchesExactDeepReadNodeRequest(title, pending);
    if (!match) return null;
    const task = await invoke<TaskRun | null>("get_task_run", { id: String(match.run_id) });
    return isExactAwaitingDeepReadNodeRun(task, match) ? match : null;
  }, "The exact DeepRead Node request did not reach its pending TaskRun gate");
  const before = await invoke<RuntimeState>("native_published_runtime_state");
  context.check(before.pendingRequests === 1 && before.legacySessions === 0 && before.legacyOpenings === 0
    && !before.legacyTransport && context.profile.runtime === "web",
  "DeepRead Node startup waits for its exact one-time permission before creating a session");
  if (document.querySelector('iframe[title="Plugin"]')) throw Error("DeepRead Node permission must precede the fresh iframe");
  const allow = [...(permissionDialog()?.querySelectorAll<HTMLButtonElement>("button") || [])]
    .find(button => button.textContent?.trim() === "允许一次");
  context.check(allow, "DeepRead Node startup requires an explicit one-time approval");
  if (!allow) throw Error("Production permission UI omitted one-time DeepRead Node approval");
  allow.click();
  await waitForPublishedNodeSession(context);
  return { capability: NODE_CAPABILITY, scopeCount: NODE_SCOPES.length, sessionOpened: true };
}

async function approveObservedDeepReadGate(context: PublishedScenarioContext, permission: string) {
  if (permission === "data") {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]');
    await approveDeepReadDataPermission(context, frame ? captureDeepReadFrameIdentity(context, frame) : undefined);
  } else if (permission === "dialog") {
    context.setPhase("real-open-dialog-authorization");
    await approvePublishedOpenDialog(context);
  } else if (permission === "paths") {
    throw Error("DeepRead received a standard-path permission not registered by its fixed profile");
  } else if (permission === "display") {
    await approvePublishedDisplayMetadata(context);
  } else if (permission === "node") {
    if (!requiresLegacyNodeSession(context.profile) || context.profile.id !== PLUGIN_ID) {
      throw Error("Unexpected Node permission outside the fixed DeepRead profile");
    }
    context.setPhase("real-node-authorization");
    await approveExactDeepReadNodePermission(context);
    await waitForPublishedNodeSession(context);
  } else {
    throw Error("DeepRead activation reached an unrecognized permission gate");
  }
}

export async function waitForDeepReadAuthorizedFreshFrame(context: PublishedScenarioContext,
  previousNonce: string | null, requireFreshDocument = true) {
  const { profile, check, observations } = context;
  if (profile.caseId !== CASE_ID || profile.id !== PLUGIN_ID) throw Error("DeepRead authorization flow is outside its fixed profile");
  const gates: string[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const readiness = await waitForDeepReadActivationReadiness(context, async () => {
      const dialog = permissionDialog();
      const title = dialog?.querySelector("h2")?.textContent || "";
      const permission = classifyDeepReadPermission(title, Boolean(dialog), Boolean(document.querySelector('iframe[title="Plugin"]')),
        profile.title);
      if (permission === "unexpected") throw Error("DeepRead activation reached an unrecognized permission dialog");
      if (permission === null) return null;
      if (permission !== "ready") return { kind: "permission", permission };
      const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]');
      if (!frame) return null;
      await context.probe<PublishedFrameIsolation>("state");
      const nonce = currentPublishedFrameDocument(context);
      if (!nonce) return null;
      const state = await context.probe<{ firstUseDisclaimerVisible: boolean }>("state");
      return { kind: "ready", nonce, value: { frame, state } };
    }, previousNonce, requireFreshDocument);
    if (readiness.kind === "ready") {
      const { frame, state } = readiness.value;
      if (state.firstUseDisclaimerVisible) throw Error("DeepRead first-use disclaimer reappeared after consent storage");
      check(frame.isConnected, "Fresh DeepRead frame remains mounted after readiness probing");
      observations.deepReadPermissionFlow = { gates, freshDocument: !previousNonce || readiness.nonce !== previousNonce,
        disclaimerStillAccepted: true };
      return frame;
    }
    if (attempt === 4) throw Error("DeepRead activation exceeded its four reviewed permission gates");
    if (gates.includes(readiness.permission)) throw Error("DeepRead activation repeated a permission gate without a new activation");
    gates.push(readiness.permission);
    await approveObservedDeepReadGate(context, readiness.permission);
  }
  throw Error("DeepRead activation did not mount a fresh iframe after permission gates");
}

export async function selectDeepReadFeatureThroughLauncher(context: PublishedScenarioContext, code: string, query: string,
  priorFrame?: HTMLIFrameElement, requireFreshDocument = code === PLUGIN_ID) {
  const { profile, until } = context;
  if (profile.caseId !== CASE_ID || profile.id !== PLUGIN_ID || ![PLUGIN_ID, "deepread-next-page"].includes(code)
    || query !== (code === PLUGIN_ID ? profile.searchQuery : code)) throw Error("DeepRead launcher selection is outside the fixed case");
  const current = document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]');
  if (!priorFrame && current) await context.probe<PublishedFrameIsolation>("state");
  const previousFrame = priorFrame || current;
  const previousNonce = currentPublishedFrameDocument(context) ?? null;
  if (previousFrame && (!previousNonce || !previousFrame.contentWindow || !previousFrame.srcdoc)) {
    throw Error("DeepRead prior frame lacks authenticated document identity");
  }

  const back = document.querySelector<HTMLButtonElement>('button[aria-label="返回搜索"]');
  if (back) back.click();
  const input = await waitForDeepReadLauncherReturn(context, back !== null);
  input.value = query; input.dispatchEvent(new Event("input", { bubbles: true }));
  const option = await until(() => [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    .find(node => node.dataset.pluginId === profile.id && node.dataset.resultCode === code),
  "Production search did not return the exact DeepRead feature row");
  option.focus(); await until(() => option.getAttribute("aria-selected") === "true", "DeepRead row did not become selected");
  input.focus(); input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await until(() => !!document.querySelector(".plugin-panel"), "Production activation did not open the DeepRead panel");
  await until(() => document.querySelector(".plugin-title")?.textContent?.includes(profile.title),
    "The activated production panel does not identify the pinned DeepRead plugin");
  return waitForDeepReadAuthorizedFreshFrame(context, previousNonce, requireFreshDocument);
}

export async function waitForDeepReadFileCompletion(context: PublishedScenarioContext, before: TaskRun[], frame: DeepReadFrameIdentity,
  expectedPayloadJsonBytes: number) {
  const beforeIds = new Set(before.map(run => run.id));
  return context.until(async () => {
    if (!frameIdentityStillCurrent(context, frame)) throw Error("DeepRead authenticated files document changed before storage completed");
    const title = permissionDialog()?.querySelector("h2")?.textContent?.trim() || "";
    if (title) throw Error("DeepRead files activation reached a permission gate after readiness was established");
    const current = await invoke<DeepReadTaskRun[]>("list_task_runs", { limit: 1000 });
    const imports = current.filter(run => !beforeIds.has(run.id) && run.capabilityId === "plugin.feature.deepread-import");
    if (imports.length > 1) throw Error("DeepRead files activation created duplicate feature TaskRuns");
    if (!imports.length) return null;
    if (!isDeepReadFilesFeatureTaskRun(imports[0], beforeIds, expectedPayloadJsonBytes)) {
      throw Error("DeepRead files TaskRun input did not match the fixed owner and single-file activation summary");
    }
    if (["created", "awaiting_permission", "running"].includes(imports[0].status)) return null;
    if (imports[0].status !== "succeeded") throw Error("DeepRead files feature TaskRun did not succeed");
    const storage = summarizeDeepReadFilesStorageRuns(current, beforeIds);
    if (!storage.complete) return null;
    return { featureRun: imports[0], successfulStorageWriteCount: storage.successfulWrites };
  }, "One files activation did not finish its real feature TaskRun and plugin-data write");
}

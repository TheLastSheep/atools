import { writable } from "svelte/store";
import { approvePendingPermission, type PermissionApprovalInvoke } from "./permissionApproval";
import type { PendingAgentToolRequest } from "./types";
import { permissionRequestContext, type PermissionRequestContext } from "./permissionPresentation";

export type PermissionEventListen = <T>(name: string, handler: (event: { payload: T }) => void) => Promise<() => void>;
export type PermissionQueueItem = { request: PendingAgentToolRequest; busy: boolean; error: string; displayName: string | null; requestContext:PermissionRequestContext | null };
type QueueState = { items: PermissionQueueItem[]; feedback: { tool: string; error: string } | null };
type Entry = PermissionQueueItem & { revision: number; context: "idle" | "loading" | "done"; finalizing?: boolean; absent?: boolean };

/** The backend owns pending requests; per-request UI state cannot migrate to a new queue item. */
export function createPermissionQueue(invoke: PermissionApprovalInvoke) {
  const store = writable<QueueState>({ items: [], feedback: null });
  const entries = new Map<string, Entry>();
  const removedAt = new Map<string, number>();
  let feedback: QueueState["feedback"] = null;
  let revision = 0;
  let closed = false;
  let refreshing: Promise<void> | undefined;
  let refreshAgain = false;

  function publish() {
    if (closed) return;
    // An approved task can await another resource decision. Keep its continuation
    // while allowing the still-actionable request to reach the visible dialog.
    const ordered = [...entries.values()].sort((a, b) => Number(a.busy) - Number(b.busy)
      || a.request.created_at.localeCompare(b.request.created_at));
    store.set({ items: ordered.map(({ request, busy, error, displayName, requestContext }) => ({ request, busy, error, displayName, requestContext })), feedback });
    if (ordered[0]?.context === "idle") void loadContext(ordered[0]);
  }

  async function loadContext(entry: Entry) {
    entry.context = "loading";
    try {
      const context = permissionRequestContext(await invoke("get_permission_request_context", { requestId: entry.request.id }));
      if (!stillCurrent(entry)) return;
      entry.displayName = context.pluginName;entry.requestContext=context;
    } catch { /* Context is optional; an unavailable name must never prevent deny or approval. */ }
    if (stillCurrent(entry)) { entry.context = "done"; publish(); }
  }

  function upsert(request: PendingAgentToolRequest) {
    if (closed || !request?.id) return;
    const previous = entries.get(request.id);
    if (previous) { previous.request = request; previous.revision = ++revision; }
    else entries.set(request.id, { request, busy: false, error: "", displayName: null, requestContext:null, context: "idle", revision: ++revision });
    publish();
  }

  function refresh(): Promise<void> {
    if (closed) return Promise.resolve();
    if (refreshing) { refreshAgain = true; return refreshing; }
    refreshing = (async () => {
      do {
        refreshAgain = false;
        const startedAt = revision;
        try {
          const requests = await invoke<PendingAgentToolRequest[]>("list_pending_agent_requests");
          if (closed) return;
          const ids = new Set(requests.map((request) => request.id));
          for (const [id, entry] of entries) {
            // A request event that arrived after this snapshot began wins until
            // the next authoritative refresh; stale reads cannot erase it.
            if (!ids.has(id) && entry.revision <= startedAt) {
              // A local terminal dismissal can emit before its invoke resolves.
              // Keep only that outcome alive; other windows close immediately.
              if (entry.busy && entry.finalizing) entry.absent = true;
              else entries.delete(id);
            }
          }
          for (const request of requests) {
            if ((removedAt.get(request.id) ?? -1) > startedAt) continue;
            const previous = entries.get(request.id);
            if (previous) { previous.request = request; previous.absent = false; }
            else entries.set(request.id, { request, busy: false, error: "", displayName: null, requestContext:null, context: "idle", revision: startedAt });
          }
          for (const [id, at] of removedAt) if (at <= startedAt) removedAt.delete(id);
          publish();
        } catch (error) {
          if (!closed) console.warn("[Permissions] Unable to refresh pending requests", error);
        }
      } while (refreshAgain && !closed);
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  }

  function stillCurrent(entry: Entry): boolean {
    return !closed && entries.get(entry.request.id) === entry;
  }

  function remove(id: string) { entries.delete(id); removedAt.set(id, ++revision); }

  async function approve(id: string, remember = false) {
    const entry = entries.get(id);
    if (!entry || entry.busy || closed) return;
    entry.busy = true; entry.error = ""; feedback = null; publish();
    let outcome;
    const approvalInvoke: PermissionApprovalInvoke = (command, args) => {
      if (command === "dismiss_pending_agent_request" && args?.requestId === id && stillCurrent(entry)) entry.finalizing = true;
      return invoke(command, args);
    };
    try { outcome = await approvePendingPermission(entry.request, { remember, invoke: approvalInvoke }); }
    catch (error) {
      if (stillCurrent(entry)) { entry.finalizing = false; entry.busy = false; entry.error = `无法处理此请求：${error instanceof Error ? error.message : String(error)}`; publish(); }
      return;
    }
    if (!stillCurrent(entry)) return;
    entry.finalizing = false;
    if (outcome.dismissed || entry.absent) {
      remove(id);
      if (outcome.error) feedback = { tool: entry.request.tool_name, error: outcome.error };
    } else { entry.busy = false; entry.error = outcome.error; }
    publish();
  }

  async function deny(id: string) {
    const entry = entries.get(id);
    if (!entry || entry.busy || closed) return;
    entry.busy = true; entry.error = ""; feedback = null; publish();
    try {
      await invoke("dismiss_pending_agent_request", { requestId: id });
      if (stillCurrent(entry)) remove(id);
    } catch (error) {
      if (stillCurrent(entry)) {
        entry.busy = false;
        entry.error = `无法拒绝此请求：${error instanceof Error ? error.message : String(error)}`;
      }
    }
    publish();
  }

  function connect(listen: PermissionEventListen) {
    let disposed = false;
    const stops: Array<() => void> = [];
    const attach = (promise: Promise<() => void>) => {
      return promise.then((stop) => { if (disposed) stop(); else stops.push(stop); })
        .catch((error) => { if (!disposed) console.warn("[Permissions] Event listener unavailable", error); });
    };
    // Events may arrive after cancellation. Only the authoritative queue may
    // introduce a dialog; a late payload must never resurrect a closed request.
    const requestListener = attach(listen<PendingAgentToolRequest>("agent-permission-request", () => { void refresh(); }));
    const taskListener = attach(listen<string>("task-run-updated", ({ payload }) => {
      if ([...entries.values()].some((entry) => entry.request.run_id === payload)) void refresh();
    }));
    const queueListener = attach(listen<null>("permission-requests-changed", () => { void refresh(); }));
    void Promise.all([requestListener, taskListener, queueListener]).then(() => { if (!disposed) void refresh(); });
    return () => { disposed = true; closed = true; entries.clear(); stops.forEach((stop) => stop()); };
  }

  return { subscribe: store.subscribe, refresh, upsert, approve, deny, connect,
    clearFeedback() { feedback = null; publish(); } };
}

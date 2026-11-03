import { adapterDisposedError, assertRendererCallback, invalidRendererResponse } from "./errors";
import { createRendererEventSubscriptions } from "./eventSubscriptions";
import { createRendererCallbackRegistry, type RendererCallback } from "./callbackRegistry";
import { validateUpdaterSnapshot, validateUpdaterWindow, type UpdaterSnapshot } from "./updaterStatus";
import type { RendererHostUnlisten, ZToolsRendererTransport } from "./types";

const names = ["onUpdateAvailable", "onUpdateDownloadStart", "onUpdateDownloadFailed"] as const;
type Name = typeof names[number];
export function createRendererUpdaterClient(transport: ZToolsRendererTransport, invoke: (args: Record<string, unknown>) => Promise<unknown>) {
  const callbacks = createRendererCallbackRegistry(names, 128);
  let disposed = false, last: UpdaterSnapshot | undefined, started = false;
  let readPending: Promise<UpdaterSnapshot> | undefined;
  const events = createRendererEventSubscriptions(transport, "renderer-updater-main-state", value => {
    try { validateUpdaterSnapshot(value); return true; } catch { return false; }
  });
  let unsubscribe: RendererHostUnlisten | undefined;
  function accept(next: UpdaterSnapshot, notify: boolean): UpdaterSnapshot {
    if (disposed) throw adapterDisposedError();
    if (last && next.sequence <= last.sequence) return last;
    const previous = last; last = next;
    if (notify && next.candidate && (next.phase === "available" || next.phase === "downloaded") && (previous?.candidate?.candidateId !== next.candidate.candidateId || (previous.phase !== "available" && previous.phase !== "downloaded"))) {
      callbacks.emit("onUpdateAvailable", [{ version: next.candidate.version, changelog: next.candidate.body ?? "" }]);
    }
    if (notify && next.phase === "downloading" && previous?.phase !== "downloading") callbacks.emit("onUpdateDownloadStart", [{ version: next.candidate?.version ?? "" }]);
    if (notify && next.error && (previous?.sequence !== next.sequence)) callbacks.emit("onUpdateDownloadFailed", [{ error: next.error.message }]);
    return next;
  }
  async function request(op: string): Promise<UpdaterSnapshot> {
    const value = await invoke({ request: { op } });
    return accept(validateUpdaterSnapshot(value), false);
  }
  async function startup(): Promise<void> {
    if (started || disposed) return;
    started = true;
    if (!await events.ready() || disposed) return;
    await request("startup");
  }
  function read(): Promise<UpdaterSnapshot> {
    if (readPending) return readPending;
    const pending = request("status").finally(() => { if (readPending === pending) readPending = undefined; });
    readPending = pending; return pending;
  }
  function originalStatus(s: UpdaterSnapshot) {
    if (s.error) throw Object.assign(new Error(s.error.message), { code: s.error.code });
    return { status: s.phase, hasDownloaded: s.phase === "downloaded", checked: s.checked, hasUpdate: s.candidate !== null, ...(s.candidate ? { version: s.candidate.version, changelog: s.candidate.body ?? "" } : {}) };
  }
  return {
    subscribe(name: Name, callback: unknown): RendererHostUnlisten {
      if (disposed) throw adapterDisposedError();
      assertRendererCallback(callback);
      if (!unsubscribe) unsubscribe = events.subscribe(value => accept(validateUpdaterSnapshot(value), true));
      const remove = callbacks.add(name, callback as RendererCallback);
      if (!remove) throw invalidRendererResponse("Too many updater subscribers.");
      void startup().catch(() => undefined); return remove;
    },
    async getDownloadStatus() { return originalStatus(await read()); },
    async checkUpdate() {
      const s = await request("check");
      if (s.error) return { success: false, hasUpdate: false, status: "error", error: s.error.message };
      if (s.candidate) validateUpdaterWindow(await invoke({ request: { op: "show" } }));
      return { success: true, hasUpdate: s.candidate !== null, status: s.phase, ...(s.candidate ? { updateInfo: { version: s.candidate.version, changelog: s.candidate.body ?? "" } } : {}) };
    },
    async showUpdateWindow() { validateUpdaterWindow(await invoke({ request: { op: "show" } })); return { success: true }; },
    dispose() { if (disposed) return; disposed = true; callbacks.clear(); unsubscribe?.(); events.dispose(); },
  };
}

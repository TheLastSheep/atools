import { tick } from "svelte";
import type { PluginFrameIdentity, PluginFrameSourceRegistry } from "./pluginInvokePolicy";
import { normalizePluginContextMenu, type PluginContextMenuItem } from "./pluginContextMenuSchema";

export type PluginContextMenuView = { items: PluginContextMenuItem[]; left: number; top: number };
type PendingMenu = {
  source: unknown; identity: PluginFrameIdentity; frame: HTMLIFrameElement; ids: Set<string>;
  onselect: (id: string) => void; ready: boolean; resolveReady: () => void; rejectReady: (error: Error) => void;
  stop?: () => void;
};

/** Owns one bounded menu request and binds its lifetime to the exact caller frame. */
export function createPluginContextMenuController(sources: PluginFrameSourceRegistry) {
  let menu = $state<PluginContextMenuView | null>(null);
  let pending: PendingMenu | null = null;

  function framePosition(source: unknown) {
    if (typeof document === "undefined" || typeof window === "undefined") throw new Error("ERR_ATOOLS_CONTEXT_MENU: host window is unavailable");
    const frame = Array.from(document.querySelectorAll("iframe")).find(candidate => candidate.contentWindow === source);
    if (!frame) throw new Error("ERR_ATOOLS_CONTEXT_MENU: caller frame is not mounted");
    const rect = frame.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) throw new Error("ERR_ATOOLS_CONTEXT_MENU: caller frame is not visible");
    const maxLeft = Math.max(12, window.innerWidth - 260);
    const maxTop = Math.max(12, window.innerHeight - 300);
    return {
      frame,
      left: Math.min(maxLeft, Math.max(12, rect.left + rect.width / 2 - 130)),
      top: Math.min(maxTop, Math.max(12, rect.top + rect.height / 2 - 24)),
    };
  }
  function finish(request: PendingMenu, restoreFocus = false) {
    if (pending !== request) return;
    pending = null;
    menu = null;
    request.stop?.();
    if (!request.ready) request.rejectReady(new Error("ERR_ATOOLS_CONTEXT_MENU: menu closed before becoming visible"));
    if (restoreFocus && sources.isCurrent(request.source, request.identity)) request.frame.focus();
  }
  function idsOf(items: PluginContextMenuItem[], ids = new Set<string>()) {
    for (const item of items) {
      if (item.enabled === false) continue;
      if (item.id) ids.add(item.id);
      if (item.submenu) idsOf(item.submenu, ids);
    }
    return ids;
  }
  function open(value: unknown, source: unknown, identity: PluginFrameIdentity, onselect: (id: string) => void = () => {}): Promise<void> {
    if (!sources.isCurrent(source, identity)) throw new Error("ERR_ATOOLS_CONTEXT_MENU: caller document is stale");
    const items = normalizePluginContextMenu(value);
    const { frame, ...position } = framePosition(source);
    close();
    let resolveReady!: () => void, rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const request: PendingMenu = { source, identity, frame, ids: idsOf(items), onselect, ready: false, resolveReady, rejectReady };
    pending = request;
    menu = { items, ...position };
    request.stop = sources.onFrameInvalidated(source, identity, () => finish(request));
    if (pending !== request) request.stop();
    void tick().then(() => {
      if (pending !== request) return;
      if (!sources.isCurrent(source, identity)) { finish(request); return; }
      request.ready = true;
      request.resolveReady();
    });
    return ready;
  }
  function select(id: unknown) {
    const request = pending;
    if (!request || typeof id !== "string" || !request.ids.has(id)) return false;
    if (!sources.isCurrent(request.source, request.identity)) { finish(request); return false; }
    finish(request, true);
    try { void Promise.resolve(request.onselect(id)).catch(() => undefined); } catch { /* Keep a host event failure from breaking the menu surface. */ }
    return true;
  }
  function close(restoreFocus = false) {
    const request = pending;
    if (request) finish(request, restoreFocus);
    else menu = null;
  }
  return { get menu() { return menu; }, open, select, close };
}

export type PluginContextMenuController = ReturnType<typeof createPluginContextMenuController>;

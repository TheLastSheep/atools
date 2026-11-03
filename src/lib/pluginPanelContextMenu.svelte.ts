import type { PluginContextMenuInfo } from "./pluginPanelContracts";

function contextMenuNumber(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric) : 0;
}

/** Owns the bounded projection of untrusted iframe context-menu metadata. */
export function createPluginPanelContextMenu() {
  let current = $state<PluginContextMenuInfo | null>(null);

  function receive(data: Record<string, unknown>) {
    current = {
      x: contextMenuNumber(data.x),
      y: contextMenuNumber(data.y),
      screenX: contextMenuNumber(data.screenX),
      screenY: contextMenuNumber(data.screenY),
      tagName: typeof data.tagName === "string" ? data.tagName.slice(0, 32).toUpperCase() : "",
      editable: data.editable === true,
      selectedText: typeof data.selectedText === "string" ? data.selectedText.slice(0, 200) : "",
      defaultPrevented: data.defaultPrevented === true,
    };
  }

  return {
    get current() { return current; },
    receive,
    clear() { current = null; },
  };
}

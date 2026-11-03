import type { PluginBrowserWindowParentMessage, PluginBrowserWindowState } from "./pluginBrowserWindowTypes";

export type PluginBrowserWindowDispatchResult = { handled: false } | { handled: true; value: unknown };

export type PluginBrowserWindowActionPorts = {
  windows: PluginBrowserWindowState[];
  lastMessage: PluginBrowserWindowParentMessage | null;
  dispatchEvent: (id: string, event: string, args?: unknown[]) => void;
  nextZOrder: () => number;
  closeWindow: (id: string) => unknown;
  loadUrl: (existing: PluginBrowserWindowState, url: string, reloaded?: boolean, ignoreCache?: boolean) => unknown;
  navigateHistory: (existing: PluginBrowserWindowState, direction: "back" | "forward") => unknown;
  navigateHistoryToIndex: (existing: PluginBrowserWindowState, index: number, actionName: string) => unknown;
  clearHistory: (id: string) => unknown;
};

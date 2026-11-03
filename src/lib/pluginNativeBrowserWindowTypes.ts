import type { PluginBrowserWindowBounds, PluginBrowserWindowState } from "./pluginBrowserWindowTypes";

export type PluginNativeBrowserWindowSnapshot = {
  bounds: PluginBrowserWindowBounds;
  contentBounds: PluginBrowserWindowBounds;
  minimumSize: [number, number];
  maximumSize: [number, number];
  visible: boolean;
  focused: boolean;
  alwaysOnTop: boolean;
  minimized: boolean;
  maximized: boolean;
  fullScreen: boolean;
  resizable: boolean;
  title: string;
  nativeSequence: number;
  constraintsSource: "adapter";
};

export type PluginNativeBrowserWindowClosedSnapshot = {
  closed: true;
  nativeSequence: number;
};

export type PluginNativeBrowserWindowSnapshotResult =
  | PluginNativeBrowserWindowSnapshot
  | PluginNativeBrowserWindowClosedSnapshot;

export type PluginNativeBrowserWindowStateChangedEvent = {
  windowId: string;
  nativeLabel: string;
  kind: "NativeStateChanged";
  snapshot: PluginNativeBrowserWindowSnapshot;
  kinds: string[];
};

export type PluginNativeBrowserWindowDestroyedEvent = {
  windowId: string;
  nativeLabel: string;
  kind: "Destroyed";
};

export type PluginNativeBrowserWindowEvent =
  | PluginNativeBrowserWindowStateChangedEvent
  | PluginNativeBrowserWindowDestroyedEvent;

/** Constructor-option values/defaults, not native snapshot getter results. */
export type PluginNativeBrowserWindowConstructorState = Pick<PluginBrowserWindowState,
  "backgroundColor" | "movable" | "closable" | "minimizable" | "maximizable" | "fullScreenable"
  | "hasShadow" | "skipTaskbar" | "visibleOnAllWorkspaces" | "focusable">;

/** Frontend-owned state plus explicit provenance for fields the native snapshot cannot observe. */
export type PluginNativeBrowserWindowState = PluginBrowserWindowState & {
  nativeConstructorState: PluginNativeBrowserWindowConstructorState;
};

export type PluginNativeBrowserWindowHostState = Pick<PluginBrowserWindowState,
  "id" | "x" | "y" | "width" | "height" | "minimumWidth" | "minimumHeight"
  | "maximumWidth" | "maximumHeight" | "visible" | "focused" | "alwaysOnTop"
  | "minimized" | "maximized" | "fullScreen" | "resizable" | "title" | "positioned"> & {
    nativeSnapshot?: PluginNativeBrowserWindowSnapshotResult;
  };

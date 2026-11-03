/** Compatibility events whose native producers are not implemented by the renderer host. */
export const METHOD_CAPABILITY_STATES = [
  "available",
  "limited",
  "unavailable",
  "available_with_defaults",
  "local_only",
] as const;
export type MethodCapabilityCode = 0 | 1 | 2 | 3 | 4;

export const METHOD_NOTES = {
  openSettings: "Only internal settings; no plugin launch.",
  hidePlugin: "Only internal settings; no plugin lifecycle.",
  notifySubInputChange: "Bounded text to active internal settings view.",
  "updater.getDownloadStatus": "Read-only native snapshot; downloaded is signature-verified.",
} as const;

export const INACTIVE_EVENTS = [
  "onAiStatusChanged",
  "onFloatingBallDoubleClickCommand",
  "onFloatingBallFiles",
  "onIpcLaunch",
  "onRedirectSearch",
  "onSetSearchText",
  "onSuperPanelData",
  "onSuperPanelLaunch",
  "onSuperPanelSearch",
  "onSuperPanelSearchWindowCommands",
  "onSuperPanelTranslation",
  "onSuperPanelWindowCommandsData",
  "onUpdateAcrylicOpacity",
  "onUpdateAvatar",
  "onUpdateFloatingBallDoubleClickCommand",
  "onUpdateWindowMaterial",
  "onSuperPanelPinnedChanged",
] as const;

import type { FeatureAction } from "./types";

export interface PluginPanelMountProps {
  action: FeatureAction;
  onclose: (isKill?: boolean) => void | Promise<void>;
  persistentSessionId?: string;
  persistentVisible?: boolean;
  onescape: () => void | Promise<void>;
  onredirect: (label: unknown, payload: unknown) => Promise<boolean>;
  onsettingsredirect: (menu: "shortcuts" | "ai", detail?: Record<string, unknown>) => boolean | Promise<boolean>;
  desktopSmokeExpectedSamples: number;
  desktopSmokeSampleIndex: number;
  desktopSmokeExternalPlanSample: boolean;
  onready?: () => void | Promise<void>;
  onloaderror?: (error: unknown) => void | Promise<void>;
  ondesktopsmokerender?: () => void | Promise<void>;
  onbackgroundwaiting?: (waiting: boolean) => void;
}

export interface PluginPanelMountExports {
  requestEscape?: () => void | Promise<void>;
  activatePersistentEntry?: (action: FeatureAction) => Promise<boolean> | boolean;
  setPersistentVisible?: (visible: boolean) => void | Promise<void>;
  closePersistentStrict?: (options?: { retry?: boolean }) => Promise<void>;
}


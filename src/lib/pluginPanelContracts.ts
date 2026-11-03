import type { FeatureAction, PluginOutput } from "./types";

export type PluginPanelProps = {
  action: FeatureAction;
  onclose: (isKill?: boolean) => void | Promise<void>;
  persistentSessionId?: string;
  persistentVisible?: boolean;
  onescape?: () => void | Promise<void>;
  onoutput?: (output: PluginOutput) => void;
  onredirect?: (label: unknown, payload: unknown) => boolean | Promise<boolean>;
  onsettingsredirect?: (
    menu: "shortcuts" | "ai",
    detail?: Record<string, unknown>
  ) => boolean | Promise<boolean>;
  desktopSmokeExpectedSamples?: number;
  desktopSmokeSampleIndex?: number;
  desktopSmokeExternalPlanSample?: boolean;
  onready?: () => void | Promise<void>;
  onloaderror?: (error: unknown) => void | Promise<void>;
  ondesktopsmokerender?: () => void | Promise<void>;
  mainPushRunnerId?: string;
  onmainpushwaiting?: (waiting: boolean) => void;
  onbackgroundwaiting?: (waiting: boolean) => void;
};

export type DynamicPluginFeature = {
  code: string;
  label: string;
  explain: string;
};

export type PluginContextMenuInfo = {
  x: number;
  y: number;
  screenX: number;
  screenY: number;
  tagName: string;
  editable: boolean;
  selectedText: string;
  defaultPrevented: boolean;
};

export type UiHostProbeResult = {
  pluginId: string;
  featureCode: string;
  passed: number;
  total: number;
  failedIds: string[];
};

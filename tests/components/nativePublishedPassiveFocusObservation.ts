import { observeLauncherReturnState } from "./nativeLauncherReturnObservation";

export type PassiveFocusStage = "startupAfterShow" | "beforePluginActivation" | "afterPluginReturn";
type RendererFocus = {
  visibilityState: "visible" | "hidden" | "other";
  documentHasFocus: boolean;
  launcherInputPresent: boolean;
  launcherInputFocused: boolean;
};
type NativeFocus = {
  mode: "observe" | "foreground";
  nativeVisible: boolean;
  nativeFocused: boolean;
  appActive: boolean;
  appHidden: boolean;
  frontmostIsSelf: boolean;
  windowOcclusionVisible: boolean;
};
export type PassiveFocusRecord =
  | { status: "not_sampled" }
  | { status: "unsupported"; reason: "native_snapshot_fields_unavailable"; renderer: RendererFocus }
  | { status: "error"; reason: "native_snapshot_failed" | "renderer_snapshot_failed"; renderer?: RendererFocus }
  | { status: "observed"; native: NativeFocus; renderer: RendererFocus };

export type PassiveFocusRecords = Record<PassiveFocusStage, PassiveFocusRecord>;
type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type WithinBudget = (read: () => Promise<unknown>) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNativeFocus(value: unknown): NativeFocus | null {
  if (!isRecord(value)) return null;
  const booleanFields = ["nativeVisible", "nativeFocused", "appActive", "appHidden", "frontmostIsSelf", "windowOcclusionVisible"] as const;
  if ((value.mode !== "observe" && value.mode !== "foreground")
    || !booleanFields.every(field => typeof value[field] === "boolean")) return null;
  return {
    mode: value.mode,
    nativeVisible: value.nativeVisible as boolean,
    nativeFocused: value.nativeFocused as boolean,
    appActive: value.appActive as boolean,
    appHidden: value.appHidden as boolean,
    frontmostIsSelf: value.frontmostIsSelf as boolean,
    windowOcclusionVisible: value.windowOcclusionVisible as boolean,
  };
}

function readRendererFocus(doc: Document): RendererFocus | null {
  try {
    const state = observeLauncherReturnState(doc);
    return {
      visibilityState: state.visibilityState,
      documentHasFocus: state.documentHasFocus,
      launcherInputPresent: state.launcherInputPresent,
      launcherInputFocused: state.launcherInputFocused,
    };
  } catch {
    return null;
  }
}

/** Samples the existing fixture window once per fixed stage; this never requests activation. */
export function createPassiveFocusObserver(doc: Document, invoke: Invoke, withinBudget: WithinBudget = read => read()) {
  const records: PassiveFocusRecords = {
    startupAfterShow: { status: "not_sampled" },
    beforePluginActivation: { status: "not_sampled" },
    afterPluginReturn: { status: "not_sampled" },
  };
  const sampled = new Set<PassiveFocusStage>();
  let pluginReturnAttempted = false;

  async function sample(stage: PassiveFocusStage): Promise<void> {
    if (sampled.has(stage)) return;
    sampled.add(stage);
    let raw: unknown;
    try {
      raw = await withinBudget(() => invoke("native_panel_foreground", { ensure: false }));
    } catch {
      const renderer = readRendererFocus(doc);
      records[stage] = { status: "error", reason: "native_snapshot_failed", ...(renderer ? { renderer } : {}) };
      return;
    }
    if (isRecord(raw) && raw.unavailable === true) {
      const renderer = readRendererFocus(doc);
      records[stage] = { status: "error", reason: "native_snapshot_failed", ...(renderer ? { renderer } : {}) };
      return;
    }
    const renderer = readRendererFocus(doc);
    if (!renderer) {
      records[stage] = { status: "error", reason: "renderer_snapshot_failed" };
      return;
    }
    const native = readNativeFocus(raw);
    records[stage] = native
      ? { status: "observed", native, renderer }
      : { status: "unsupported", reason: "native_snapshot_fields_unavailable", renderer };
  }

  async function observePluginReturn(): Promise<void> {
    if (pluginReturnAttempted) await sample("afterPluginReturn");
  }

  return {
    records,
    sample,
    markPluginReturnAttempted: () => { pluginReturnAttempted = true; },
    get pluginReturnAttempted() { return pluginReturnAttempted; },
    observePluginReturn,
  };
}

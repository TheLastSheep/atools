import { invoke, until } from "./nativePublishedPluginCommon";

export type NativeForegroundSnapshot = {
  mode?: unknown;
  nativeVisible?: unknown;
  nativeFocused?: unknown;
  appActive?: unknown;
  appHidden?: unknown;
  frontmostIsSelf?: unknown;
  windowOcclusionVisible?: unknown;
};

type RendererForegroundInput = { visibilityState: unknown; documentHasFocus: unknown };
export type RendererForegroundSnapshot = { visibilityState: "visible" | "hidden" | "other"; documentHasFocus: boolean };
export type ForegroundEvidence = {
  native: {
    nativeVisible: true;
    nativeFocused: true;
    appActive: true;
    appHidden: false;
    frontmostIsSelf: true;
    windowOcclusionVisible: true;
  };
  renderer: { visibilityState: "visible"; documentHasFocus: true };
};
export type ForegroundObservation = {
  native: {
    mode: "foreground" | "observe" | "unknown";
    nativeVisible: boolean | null;
    nativeFocused: boolean | null;
    appActive: boolean | null;
    appHidden: boolean | null;
    frontmostIsSelf: boolean | null;
    windowOcclusionVisible: boolean | null;
  };
  renderer: RendererForegroundSnapshot | null;
};
type WaitFor = <T>(read: () => T | Promise<T>, label: string) => Promise<NonNullable<T>>;

function normalizeNative(snapshot: NativeForegroundSnapshot): ForegroundObservation["native"] {
  const booleanOrNull = (value: unknown) => value === true ? true : value === false ? false : null;
  return {
    mode: snapshot.mode === "foreground" || snapshot.mode === "observe" ? snapshot.mode : "unknown",
    nativeVisible: booleanOrNull(snapshot.nativeVisible),
    nativeFocused: booleanOrNull(snapshot.nativeFocused),
    appActive: booleanOrNull(snapshot.appActive),
    appHidden: booleanOrNull(snapshot.appHidden),
    frontmostIsSelf: booleanOrNull(snapshot.frontmostIsSelf),
    windowOcclusionVisible: booleanOrNull(snapshot.windowOcclusionVisible),
  };
}

function normalizeRenderer(snapshot: RendererForegroundInput): RendererForegroundSnapshot {
  return {
    visibilityState: snapshot.visibilityState === "visible" || snapshot.visibilityState === "hidden"
      ? snapshot.visibilityState : "other",
    documentHasFocus: snapshot.documentHasFocus === true,
  };
}

function isForegroundRound(native: ForegroundObservation["native"], renderer: RendererForegroundSnapshot): boolean {
  return native.mode === "foreground" && native.nativeVisible === true && native.nativeFocused === true
    && native.appActive === true && native.appHidden === false && native.frontmostIsSelf === true
    && native.windowOcclusionVisible === true && renderer.visibilityState === "visible" && renderer.documentHasFocus;
}

/** Explicit fixture opt-in: ensure once, then accept only one same-round native and renderer observation. */
export async function observeRequiredFixtureForeground(
  required: boolean,
  ensureNative: () => Promise<NativeForegroundSnapshot>,
  observeNative: () => Promise<NativeForegroundSnapshot>,
  readRenderer: () => RendererForegroundInput,
  waitFor: WaitFor,
  observe?: (snapshot: ForegroundObservation) => void,
): Promise<ForegroundEvidence | null> {
  if (!required) return null;
  const initialNative = await ensureNative();
  observe?.({ native: normalizeNative(initialNative), renderer: null });
  const evidence = await waitFor(async () => {
    const native = normalizeNative(await observeNative());
    const renderer = normalizeRenderer(readRenderer());
    observe?.({ native, renderer });
    if (!isForegroundRound(native, renderer)) return null;
    return {
      native: { nativeVisible: true, nativeFocused: true, appActive: true, appHidden: false,
        frontmostIsSelf: true, windowOcclusionVisible: true },
      renderer: { visibilityState: "visible", documentHasFocus: true },
    } satisfies ForegroundEvidence;
  }, "Fixture native and renderer foreground preconditions were not positively verified");
  return evidence;
}

export function requestFixtureForegroundPreconditions(observations: Record<string, unknown>) {
  return observeRequiredFixtureForeground(true,
    () => invoke<NativeForegroundSnapshot>("native_panel_foreground", { ensure: true }),
    () => invoke<NativeForegroundSnapshot>("native_panel_foreground", { ensure: false }),
    () => ({ visibilityState: document.visibilityState, documentHasFocus: document.hasFocus() }), until,
    snapshot => { observations.fixtureForegroundPreconditions = snapshot; });
}

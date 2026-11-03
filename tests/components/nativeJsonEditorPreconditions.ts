type RecordLike = Record<string, unknown>;

function record(value: unknown): RecordLike | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordLike : null;
}

/** True only when native activation and window visibility evidence are all positive. */
export function jsonEditorNativeUiReady(native: unknown, hostVisibility: unknown): boolean {
  try {
    const value = record(native);
    return !!value
      && value.appActive === true
      && value.appHidden === false
      && value.frontmostIsSelf === true
      && value.nativeFocused === true
      && value.nativeVisible === true
      && value.windowOcclusionVisible === true
      && hostVisibility === "visible";
  } catch {
    return false;
  }
}

/** Frame visibility is a precondition, separate from whether the editor owns focus. */
export function jsonEditorFrameUiReady(focusDiagnostics: unknown): boolean {
  try {
    const value = record(focusDiagnostics);
    return !!value && value.documentHidden === false && value.visibilityState === "visible";
  } catch {
    return false;
  }
}

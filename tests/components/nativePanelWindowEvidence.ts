export type PanelWindowMode = "observe" | "foreground";
export type NativeWindowEvidence = { mode: PanelWindowMode; nativeVisible: boolean; nativeFocused: boolean;
  appActive: boolean; appHidden: boolean; frontmostIsSelf: boolean; elapsedMs: number };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Until = <T>(read: () => T | Promise<T>, message: string) => Promise<NonNullable<T>>;
export const nativeForegroundConfirmed = (value: NativeWindowEvidence) => value.nativeVisible && value.nativeFocused
  && value.appActive && !value.appHidden && value.frontmostIsSelf;

/** Restoring foreground is opt-in and occurs before timing; after-samples never restore focus. */
export function createPanelWindowEvidence(options: { mode: PanelWindowMode; invoke: Invoke; until: Until;
  check: (ok: unknown, message: string) => void; observations: Record<string, unknown> }) {
  const samples: Array<Record<string, unknown>> = [];
  const attempts: Array<Record<string, unknown>> = [];
  options.observations.windowEvidence = { mode: options.mode, samples, attempts,
    boundary: "Native OS activation is separate from document visibility and DOM focus. Foreground restoration only occurs before measurements; observe mode never restores it." };
  async function snapshot(stage: string, when: "before" | "after") {
    const restoreRequested = when === "before" && options.mode === "foreground";
    const attempt: Record<string, unknown> = { stage, when, restoreRequested, observationCount: 0, status: "pending" };
    attempts.push(attempt);
    const observe = async (ensure: boolean) => {
      const sample = { stage, when, native: await options.invoke<NativeWindowEvidence>("native_panel_foreground", { ensure }),
        parentVisibility: document.visibilityState, parentDocumentHasFocus: document.hasFocus() };
      attempt.observationCount = Number(attempt.observationCount) + 1;
      attempt.last = sample;
      attempt.initial ??= sample;
      return sample;
    };
    try {
      let sample = await observe(restoreRequested);
      if (restoreRequested) sample = await options.until(async () => {
        const current = await observe(false);
        return nativeForegroundConfirmed(current.native) && current.parentVisibility === "visible" && current.parentDocumentHasFocus ? current : null;
      }, "OS foreground and visible focused document did not settle before " + stage);
      samples.push(sample);
      options.check(sample.native.mode === options.mode, "Native fixture and benchmark use the same explicit window mode");
      if (options.mode === "foreground") options.check(nativeForegroundConfirmed(sample.native) && sample.parentVisibility === "visible" && sample.parentDocumentHasFocus,
        "Foreground measurement retains actual OS activation, native visibility and focus: " + stage + " " + when);
      attempt.status = "complete";
      return sample;
    } catch (error) {
      attempt.status = "failed"; attempt.error = String(error instanceof Error ? error.message : error);
      throw error;
    }
  }
  return { mode: options.mode, before: (stage: string) => snapshot(stage, "before"), after: (stage: string) => snapshot(stage, "after") };
}

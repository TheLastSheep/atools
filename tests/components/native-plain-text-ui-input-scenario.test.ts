import { settledInputDiagnostics } from "./nativeUiInputDiagnosticTestFixture";
import { afterEach, expect, it, vi } from "vitest";
import { createNativeOriginalPlainTextUiInputScenario } from "./nativeOriginalPlainTextUiInputScenario";
import type { PublishedScenarioContext } from "./nativePublishedPluginCommon";

const alpha = "ATools plain alpha document line 1234567890\nAlpha fixed body\nSecond line.";
const beta = "# ATools markdown beta document\n\n- first\n- second";
const observation = (phase: "alpha" | "beta", stopped = false) => ({ schemaVersion: 2, phase, stopped,
  listenerCount: stopped ? 0 : 8, lifecycleListenerCount: stopped ? 0 : 2,
  records: { [phase]: { trustedEditorPointers: 1, trustedKeydowns: 2, trustedBeforeInputs: 2,
    trustedInputs: 2, rejectedUntrusted: 0, overflow: false, diagnostics: settledInputDiagnostics(4) } } });
const state = (phase: "alpha" | "beta", stopped = false) => ({ text: phase === "alpha" ? alpha : beta,
  editCommandResults: [], focusAttempt: null,
  focusDiagnostics: { visibilityState: "visible", documentHidden: false, documentHasFocus: true,
    editorActive: true, editorConnected: true, editorIsContentEditable: true, editorWidth: 400, editorHeight: 200,
    computedStyle: { webkitUserModify: "read-write", userSelect: "text", pointerEvents: "auto" }, inertAncestors: [],
    userActivation: { isActive: false, hasBeenActive: true } }, nativeUiInputObservation: observation(phase, stopped) });

afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });
function context() {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  let elapsed = 0; vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const observations: Record<string, unknown> = {}, phases: string[] = [], ops: string[] = [], active: { value: "alpha" | "beta" } = { value: "alpha" };
  const probe = vi.fn(async (operation: string) => {
    ops.push(operation);
    if (operation.startsWith("native-ui-")) {
      if (operation !== "native-ui-stop") active.value = operation.endsWith("beta") ? "beta" : "alpha";
      return state(active.value, operation === "native-ui-stop");
    }
    if (operation === "state") return state(active.value);
    throw Error("Unexpected operation " + operation);
  });
  const value = { fixture: { nativeUiInput: true }, profile: { caseId: "local-plain-text" }, observations,
    probe, setPhase(phase: string) { phases.push(phase); }, check(ok: unknown, label: string) { if (!ok) throw Error(label); },
    async pause(ms = 150) { elapsed += Math.max(ms, 60000); } } as unknown as PublishedScenarioContext;
  return { value, observations, phases, ops, probe };
}

it("waits for both fixed rendered documents and trusted evidence without focusing, clicking, editing or writing storage", async () => {
  const test = context();
  const focus = vi.spyOn(HTMLElement.prototype, "focus"), click = vi.spyOn(HTMLElement.prototype, "click");
  const exec = vi.fn(); Object.defineProperty(document, "execCommand", { configurable: true, value: exec });
  const storage = vi.spyOn(Storage.prototype, "setItem");
  const session = await createNativeOriginalPlainTextUiInputScenario(test.value);
  expect(document.querySelector("[data-atools-native-plain-text-input]")?.getAttribute("role")).toBe("status");
  expect((document.querySelector("[data-atools-native-plain-text-input]") as HTMLElement).style.pointerEvents).toBe("none");
  await session.enter("alpha"); await session.enter("beta"); await session.stop();
  expect(test.ops).toEqual(["native-ui-alpha", "state", "native-ui-beta", "state", "native-ui-stop"]);
  expect(focus).not.toHaveBeenCalled(); expect(click).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled();
  expect(storage).not.toHaveBeenCalled(); expect(document.querySelector("[data-atools-native-plain-text-input]")).toBeNull();
  expect(test.observations.originalPlainNativeUiInput).toMatchObject({ hardwareHumanInputVerified: false,
    phaseDeadlineMs: 60000, pollIntervalMs: 150, cleanup: { stopped: true, listenerCount: 0, lifecycleListenerCount: 0 },
  visibility: { alpha: { renderedTextMatches: true, renderedText: alpha, editCommandResults: [], focusAttempt: null },
      beta: { renderedTextMatches: true, renderedText: beta, editCommandResults: [], focusAttempt: null } } });
});

it("requires the explicit plain-text fixture flag and alpha-before-beta phase order", async () => {
  const test = context(); (test.value as any).fixture.nativeUiInput = false;
  await expect(createNativeOriginalPlainTextUiInputScenario(test.value)).rejects.toThrow("FixtureRequired");
  (test.value as any).fixture.nativeUiInput = true;
  const session = await createNativeOriginalPlainTextUiInputScenario(test.value);
  await expect(session.enter("beta")).rejects.toThrow("PhaseRejected");
  await session.enter("alpha"); await session.enter("beta"); await session.stop();
});

it("fails closed when focus, rendered text, trusted pointers, or no-script evidence is absent", async () => {
  for (const [change, message] of [
    [(value: any) => { value.focusDiagnostics.editorActive = false; }, "Deadline:alpha"],
    [(value: any) => { value.text = "incorrect"; }, "Deadline:alpha"],
    [(value: any) => { value.nativeUiInputObservation.records.alpha.trustedEditorPointers = 0; }, "Deadline:alpha"],
    [(value: any) => { value.nativeUiInputObservation.records.alpha.diagnostics.composition.active = true; }, "Deadline:alpha"],
    [(value: any) => { delete value.nativeUiInputObservation.records.alpha.diagnostics; }, "Deadline:alpha"],
    [(value: any) => { value.nativeUiInputObservation.records.alpha.diagnostics.lastEditingIsComposing = "unknown"; }, "Deadline:alpha"],
    [(value: any) => { value.editCommandResults = [{ command: "insertText", accepted: true }]; }, "Deadline:alpha"],
    [(value: any) => { value.focusAttempt = { focusCalls: 1 }; }, "Deadline:alpha"],
  ] as const) {
    const test = context(), original = test.probe.getMockImplementation()!;
    test.probe.mockImplementation(async operation => {
      const value = await original(operation);
      if (operation === "state") change(value);
      return value;
    });
    const session = await createNativeOriginalPlainTextUiInputScenario(test.value);
    await expect(session.enter("alpha")).rejects.toThrow(message);
    await session.stop();
  }
});

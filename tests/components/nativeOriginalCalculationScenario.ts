import type { PublishedBusinessResult, PublishedScenarioContext } from "./nativePublishedPluginCommon";

type CalculationState = { ready: boolean; rows: { expression: string; result: string }[]; trailingBlank: boolean };
async function waitRows(context: PublishedScenarioContext, accept: (state: CalculationState) => boolean, message: string) {
  return context.until(async () => { const value = await context.probe<CalculationState>("state"); return accept(value) ? value : null; }, message);
}
function resultFor(state: CalculationState, expression: string) { return state.rows.find(row => row.expression === expression)?.result; }

export async function runOriginalCalculationScenario(context: PublishedScenarioContext): Promise<PublishedBusinessResult> {
  const { check, probe, setPhase, observations } = context;
  let state = await waitRows(context, value => value.ready && value.trailingBlank, "Original Calculation Paper did not render its empty formula row");
  setPhase("calculation-controlled-input-decimal-and-grouping");
  await probe("set-tail-expression", { value: "0.1+0.2" });
  state = await waitRows(context, value => resultFor(value, "0.1+0.2") === "0.3" && value.trailingBlank,
    "Original React formula input did not evaluate 0.1 + 0.2 and append an empty row");
  check(resultFor(state, "0.1+0.2") === "0.3", "Original Calculation Paper renders decimal arithmetic as 0.3");
  await probe("set-tail-expression", { value: "1000+24" });
  state = await waitRows(context, value => resultFor(value, "1000+24") === "1,024" && value.trailingBlank,
    "Original React formula input did not render grouped thousands and retain a trailing blank row");
  check(resultFor(state, "1000+24") === "1,024", "Original result formatter groups four-digit values");
  setPhase("calculation-invalid-empty-recovery");
  await probe("set-tail-expression", { value: "1+" });
  state = await waitRows(context, value => value.rows.some(row => row.expression === "1+" && row.result === "") && value.trailingBlank,
    "Original invalid expression did not clear its result and append a blank row");
  check(resultFor(state, "1+") === "", "Original invalid expression leaves no stale calculation result");
  await probe("set-tail-expression", { value: "6*7" });
  state = await waitRows(context, value => resultFor(value, "6*7") === "42" && value.trailingBlank,
    "Original valid expression did not recover after invalid input");
  check(resultFor(state, "6*7") === "42", "Original calculator recovers and evaluates 6 × 7");
  observations.calculationPaper = { results: { "0.1+0.2": resultFor(state, "0.1+0.2"), "1000+24": resultFor(state, "1000+24"), "1+": resultFor(state, "1+"), "6*7": resultFor(state, "6*7") },
    finalRowCount: state.rows.length, trailingBlank: state.trailingBlank,
    boundary: "Prototype value setter plus input events on original controlled textareas; result labels are observed without clicking them." };
  return { businessOutcome: "scoped_pass", tested: ["controlled formula input and decimal arithmetic", "thousands grouping", "invalid-result clearing and recovery", "automatic trailing empty formula row"],
    notTested: ["units and advanced math expressions", "result-copy click or clipboard", "history/storage", "physical keyboard", "other original local packages"],
    boundary: "Original React input handler only; no internal React state writes, result click, clipboard or persistence calls." };
}

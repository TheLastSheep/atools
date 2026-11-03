import type { PublishedBusinessResult, PublishedScenarioContext } from "./nativePublishedPluginCommon";

type CalculationState = { ready: boolean; rows: { expression: string; result: string }[]; trailingBlank: boolean };
async function waitFor(context: PublishedScenarioContext, accept: (state: CalculationState) => boolean, message: string) {
  return context.until(async () => { const state = await context.probe<CalculationState>("state"); return accept(state) ? state : null; }, message);
}
function resultFor(state: CalculationState, expression: string) { return state.rows.find(row => row.expression === expression)?.result; }

/** A bounded fixture operation over the original controlled textarea and original calculation engine. */
export async function runHeadCalculationPaperScenario(context: PublishedScenarioContext): Promise<PublishedBusinessResult> {
  const { check, probe, setPhase, observations } = context;
  let state = await waitFor(context, value => value.ready && value.trailingBlank, "HEAD Calculation Paper did not render its empty formula row");
  setPhase("calculation-head-original-input-and-result");
  await probe("set-tail-expression", { value: "6*7" });
  state = await waitFor(context, value => resultFor(value, "6*7") === "42" && value.trailingBlank,
    "Original Calculation Paper did not calculate 6 × 7 through its UI input handler");
  check(resultFor(state, "6*7") === "42", "Original HEAD Calculation Paper calculates 6 × 7 as 42");
  const firstResult = resultFor(state, "6*7");

  setPhase("calculation-head-clear-and-reentry");
  await probe("clear-tail-expression");
  const isCleared = (value: CalculationState) => value.ready && value.trailingBlank
    && !value.rows.some(row => row.expression === "6*7")
    && value.rows.every(row => row.expression !== "" || row.result === "");
  state = await waitFor(context, isCleared, "Original Calculation Paper did not clear the previous formula and result before re-entry");
  check(isCleared(state), "Original controlled formula and its displayed result are cleared before re-entry");
  await probe("set-tail-expression", { value: "8*9" });
  state = await waitFor(context, value => resultFor(value, "8*9") === "72" && value.trailingBlank,
    "Original Calculation Paper did not recover after clear and evaluate the next formula");
  check(resultFor(state, "8*9") === "72", "Original Calculation Paper calculates 8 × 9 as 72 after clearing");
  observations.calculationPaperHead = { firstExpression: "6*7", firstResult,
    clearedBeforeReentry: true, clearHasNoStaleResult: true, secondExpression: "8*9", secondResult: resultFor(state, "8*9"),
    trailingBlank: state.trailingBlank,
    boundary: "Programmatic value setter plus input events reach the original controlled textarea handler; original package engine and result are observed." };
  return { businessOutcome: "scoped_pass", tested: ["original controlled textarea input", "6 × 7 result", "explicit clear", "re-entry and 8 × 9 recovery"],
    notTested: ["physical keyboard input", "result-copy/clipboard", "persistence", "advanced expressions", "other packages"],
    boundary: "HEAD-pinned Calculation Paper package bytes; fixture DOM operation does not replace its input handler or arithmetic implementation." };
}

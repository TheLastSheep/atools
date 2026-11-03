import type { PublishedBusinessResult, PublishedScenarioContext } from "./nativePublishedPluginCommon";
type CalculatorState = { ready: boolean; expression: string; result: string; visibilityState: string; documentHidden: boolean };

export async function runOriginalCalculatorScenario(context: PublishedScenarioContext): Promise<PublishedBusinessResult> {
  const wait = (expression?: string, result?: string) => context.until(async () => {
    const state = await context.probe<CalculatorState>("state");
    context.observations.originalCalculatorLastState = state;
    return state.ready && (expression === undefined || state.expression === expression)
      && (result === undefined || state.result === result) ? state : null;
  }, "Original calculator did not render the expected fixed button result");
  const press = async (operation: string, expression?: string, result?: string) => {
    await context.probe(operation); return wait(expression, result);
  };
  await wait();
  context.setPhase("original-calculator-button-addition");
  await press("clear", "0");
  await press("one", "1"); await press("plus", "1+"); await press("two", "1+2");
  const added = await press("equals", "1+2", "3");
  context.check(added.result === "3", "Original calculator buttons render 1+2 = 3");
  context.setPhase("original-calculator-button-division");
  await press("clear", "0"); await press("nine", "9"); await press("divide", "9÷"); await press("three", "9÷3");
  const divided = await press("equals", "9÷3", "3");
  context.check(divided.result === "3", "Original calculator buttons render 9÷3 = 3 after clear");
  context.observations.originalCalculatorVisibility = { visibilityState: divided.visibilityState, documentHidden: divided.documentHidden };
  return { tested: ["original visible-control DOM button path", "addition 1+2 = 3", "clear then division 9÷3 = 3", "rendered expression and result"],
    notTested: ["physical pointer/keyboard", "foreground paint/visual comparison", "history persistence", "clipboard", "all calculator operators"],
    boundary: "Programmatic DOM clicks on original controls in the real native host; document visibility is recorded separately. No private React model, internal calculate function or service API is substituted." };
}

import type { PublishedBusinessResult, PublishedScenarioContext } from "./nativePublishedPluginCommon";

type CronState = { ready: boolean; version: string; expression: string; minuteMode: string; minuteStart: string; minuteStep: string; versionInfo: string };
async function waitCron(context: PublishedScenarioContext, accept: (state: CronState) => boolean, message: string) {
  return context.until(async () => { const value = await context.probe<CronState>("state"); return accept(value) ? value : null; }, message);
}

export async function runOriginalCronScenario(context: PublishedScenarioContext): Promise<PublishedBusinessResult> {
  const { check, probe, setPhase, observations } = context;
  let state = await waitCron(context, value => value.ready, "Original Cron controls did not become ready");
  check(state.version === "quartz", "Original local Cron package opens with its Quartz default");
  setPhase("cron-linux-five-field-step-editor");
  await probe("select-version", { value: "linux" });
  state = await waitCron(context, value => value.version === "linux" && value.versionInfo === "格式：分 时 日 月 周"
    && value.expression.trim().split(/\s+/).length === 5, "Original Linux label and five-field expression did not render");
  check(state.expression === "* * * * *", "Original Linux mode starts with its five wildcard fields");
  await probe("choose-minute-step", { start: "0", step: "5" });
  state = await waitCron(context, value => value.expression === "0/5 * * * *" && value.minuteMode === "start"
    && value.minuteStart === "0" && value.minuteStep === "5", "Linux five-minute step did not update the original editor");
  check(state.expression.split(/\s+/).length === 5, "Linux mode generates the original five-field expression");
  setPhase("cron-spring-six-field-backfill");
  await probe("select-version", { value: "spring" });
  state = await waitCron(context, value => value.version === "spring" && value.versionInfo === "格式：秒 分 时 日 月 周"
    && value.expression.trim().split(/\s+/).length === 6, "Original Spring label and six-field expression did not render");
  await probe("set-expression", { value: "0 10/5 * * * ?" });
  state = await waitCron(context, value => value.expression === "0 10/5 * * * ?" && value.minuteMode === "start"
    && value.minuteStart === "10" && value.minuteStep === "5", "Spring expression did not backfill the real minute start/step controls");
  check(state.version === "spring" && state.expression.split(/\s+/).length === 6,
    "Original Spring input handler preserves the six-field format while filling minute controls");
  observations.cronEditor = { linuxStep: "0/5 * * * *", springBackfill: state.expression,
    boundary: "Original version selector, number/radio controls and expression input events only; advanced Quartz tokens such as L, W and # were not assessed." };
  return { businessOutcome: "scoped_pass", tested: ["Linux/Spring format switching in the original local package", "Linux five-minute step generation", "Spring six-field expression backfill into minute start and step controls"],
    notTested: ["Quartz-specific year rules", "L/W/# advanced token semantics", "next-run correctness or system clock dependence", "copy button", "physical keyboard", "other original local packages"],
    boundary: "Only fixed synthetic values through the original DOM input/change/click handlers; no clipboard or network access." };
}

import type { PublishedBusinessResult, PublishedScenarioContext } from "./nativePublishedPluginCommon";

type FrameState = {
  hasTimestampInput: boolean; input: string; activeUnit: string; timezone: string; timezoneOptionCount: number;
  dateResults: string[]; inputError: boolean; invalidMessage: string; detectHint: string;
  reverseDate: string; reverseTimestamp: string; currentTimestamp: string; paused: boolean;
  pickerOpen: boolean; pickerMonth: string; pickerSelectedDay: string; pickerSelectedTime: string[];
};
const WINTER_DATE = "2024-01-02 03:04:05", SECONDS = "1704164645", MILLISECONDS = "1704164645000";

async function waitState(context: PublishedScenarioContext, predicate: (state: FrameState) => boolean, label: string) {
  return context.until(async () => {
    const state = await context.probe<FrameState>("state"); return predicate(state) ? state : null;
  }, label);
}
async function setTimestamp(context: PublishedScenarioContext, value: string, unit: string, expected: string) {
  await context.probe("set-timestamp", { value });
  return waitState(context, state => state.input === value && state.activeUnit === unit
    && state.dateResults[0] === expected && !state.inputError, "Original timestamp/date result did not update");
}
async function chooseWinterDate(context: PublishedScenarioContext) {
  await context.probe("open-date-picker");
  let state = await waitState(context, value => value.pickerOpen && /^\d{4}-\d{2}$/.test(value.pickerMonth), "Calendar did not open");
  // Finite genuine navigation; no writing readonly fields or Vue/private plugin state.
  for (let count = 0; Number(state.pickerMonth.slice(0, 4)) !== 2024; count++) {
    context.check(count < 100, "Calendar year navigation stays within the finite 100-click bound");
    const old = state.pickerMonth;
    await context.probe("picker-year", { direction: Number(old.slice(0, 4)) > 2024 ? "previous" : "next" });
    state = await waitState(context, value => value.pickerMonth !== old, "Calendar year button did not update");
  }
  for (let count = 0; state.pickerMonth !== "2024-01"; count++) {
    context.check(count < 11, "Calendar month navigation stays within the finite 11-click bound");
    const old = state.pickerMonth;
    await context.probe("picker-month", { direction: "previous" });
    state = await waitState(context, value => value.pickerMonth !== old, "Calendar month button did not update");
  }
  await context.probe("picker-day", { day: 2 });
  await context.probe("picker-time", { part: "hour", value: 3 });
  await context.probe("picker-time", { part: "minute", value: 4 });
  await context.probe("picker-time", { part: "second", value: 5 });
  state = await waitState(context, value => value.pickerSelectedDay === "2" && value.pickerSelectedTime.join(":") === "03:04:05", "Selected calendar date/time did not render");
  context.check(state.pickerMonth === "2024-01", "Original picker selected the reviewed winter date by actual controls");
  await context.probe("confirm-date-picker");
  return waitState(context, value => !value.pickerOpen && value.reverseDate === WINTER_DATE, "Confirmed date did not reach readonly date field");
}

export async function runPublishedBusinessScenario(context: PublishedScenarioContext): Promise<PublishedBusinessResult> {
  const { check, setPhase, observations } = context;
  let state = await waitState(context, value => value.hasTimestampInput && value.timezoneOptionCount === 28, "Published timestamp UI did not mount");
  setPhase("timestamp-epoch-zone-observation");
  await context.probe("select-london");
  await context.probe("select-unit", { unit: "second" });
  await context.probe("set-timestamp", { value: "0" });
  state = await waitState(context, value => value.timezone.includes("UTC+00:00 | 伦敦") && value.input === "0"
    && value.activeUnit === "秒" && value.dateResults.length === 3, "Original Unix epoch output did not render");
  const epochObserved = state.dateResults[0], epochUtcExpected = "1970-01-01 00:00:00";
  check(epochObserved === "1970-01-01 01:00:00", "Original London epoch result exposes the reviewed historical UTC-offset mismatch");
  observations.epochUtcCorrectness = { status: "known_upstream_defect_observed", observed: epochObserved, fixedUtcExpected: epochUtcExpected,
    accepted: false, reason: "UTC+00 label uses Europe/London; no fixed-UTC option exists in this original release" };

  setPhase("timestamp-seconds-milliseconds-and-recovery");
  state = await setTimestamp(context, SECONDS, "秒", WINTER_DATE);
  check(state.dateResults.length === 3 && state.dateResults[1].includes("2024年1月2日 星期二"), "Original seconds conversion renders all three winter date formats");
  state = await setTimestamp(context, MILLISECONDS, "毫秒", WINTER_DATE);
  check(state.detectHint.includes("已识别为毫秒"), "Original 13-digit input auto-detects milliseconds and renders its hint");
  state = await setTimestamp(context, SECONDS, "秒", WINTER_DATE);
  check(state.detectHint.includes("已识别为秒"), "Original 10-digit input auto-detects seconds on recovery from milliseconds");
  await context.probe("set-timestamp", { value: "invalid-date" });
  state = await waitState(context, value => value.inputError && value.invalidMessage.includes("无效时间戳") && value.dateResults.length === 0,
    "Invalid input did not clear original conversion results");
  check(state.input === "invalid-date", "Original invalid-input error refers to the typed text and suppresses stale results");
  state = await setTimestamp(context, SECONDS, "秒", WINTER_DATE);
  check(!state.invalidMessage && !state.inputError, "Restoring a valid timestamp clears original validation feedback");

  setPhase("timestamp-reverse-calendar-controls");
  state = await chooseWinterDate(context);
  check(state.reverseTimestamp === SECONDS, "Original calendar reverse conversion produces the reviewed seconds value");
  await context.probe("select-unit", { unit: "millisecond" });
  state = await waitState(context, value => value.activeUnit === "毫秒" && value.reverseTimestamp === MILLISECONDS,
    "Reverse result did not switch to milliseconds");
  check(state.reverseDate === WINTER_DATE, "Switching units preserves the selected reverse-conversion date");

  setPhase("timestamp-live-clock-pause-resume");
  if (!state.paused) await context.probe("toggle-pause");
  state = await waitState(context, value => value.paused, "Original live clock did not pause");
  const pausedValue = state.currentTimestamp;
  check(/^\d{13}$/.test(pausedValue), "Original current clock uses the selected millisecond unit");
  await context.pause(350);
  state = await context.probe<FrameState>("state");
  check(state.currentTimestamp === pausedValue, "Original pause keeps the displayed live timestamp stable");
  await context.probe("toggle-pause");
  state = await waitState(context, value => !value.paused && Number(value.currentTimestamp) > Number(pausedValue), "Original live clock did not resume");
  await context.probe("toggle-pause");
  state = await waitState(context, value => value.paused, "Original clock did not return to paused before final observation");
  observations.finalUi = state;
  return { tested: ["original seconds/milliseconds auto-detection and winter date rendering", "invalid timestamp feedback and recovery",
    "reverse conversion through actual calendar/time buttons", "current clock pause/resume", "historical London epoch defect observation"],
    notTested: ["clipboard actions", "nanosecond correctness", "full DST/historical timezone matrix", "physical keyboard",
      "system clock mutation", "long-running interval CPU/whole-process memory", "other plugins"],
    businessOutcome: "partial",
    knownUpstreamIssues: [{ id: "london-label-is-not-fixed-utc", observed: epochObserved, expected: epochUtcExpected,
      sourceReview: "output/legacy-node-2026-10-15/published-timestamp-source-review.json",
      sourceAnchors: [{ file: "assets/index-Cp7fjPHZ.js", characterOffset: 73618, byteOffset: 73708,
        needle: '{label:"UTC+00:00 | 伦敦",offset:0,iana:"Europe/London"}' },
        { file: "assets/index-Cp7fjPHZ.js", characterOffset: 74713, byteOffset: 74883, needle: "timeZone:t.iana" },
        { file: "assets/index-Cp7fjPHZ.js", characterOffset: 75121, byteOffset: 75291, needle: "return Date.UTC(e,t-1,n,s,o,i)-r.offset*36e5" }],
      boundary: "Actual original UI observation; fixed-UTC epoch requirement remains unaccepted" }],
    acceptance: { status: "partial_with_known_upstream_defect", fixedUtcEpochAccepted: false,
      defectId: "london-label-is-not-fixed-utc", observedEpoch: epochObserved, fixedUtcExpected: epochUtcExpected },
    boundary: "DOM input/change/click only; no plugin internal conversion functions, direct reactive writes, clipboard, fake host API or clock replacement" };
}

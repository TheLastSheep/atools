import type { PublishedBusinessResult, PublishedScenarioContext } from "./nativePublishedPluginCommon";
import { invoke } from "./nativePublishedPluginCommon";

type FrameState = { hasPattern:boolean; hasText:boolean; pattern: string; text: string; flags: Array<{label:string;active:boolean}>; error: string;
  matchBadge: string; captures: string[]; matched: string[]; aiHint: string; explanation: string;
  canvasCount: number; exampleNames: string[]; allAiModelsType: string };

function activeGlobal(state: FrameState) { return state.flags.find(flag => flag.label === "g")?.active === true; }
type PathEvidence = { standardPathTaskRunCount: number; standardPathRunsSucceeded: boolean; privateMarkersAbsent: boolean;
  readOnlyEvidence: boolean; confinedToPrivateHome: boolean; fileCount: number; contentMatches: boolean; actualBytes: number; source: string };
type PathContract = { downloadsType: string; downloadsNonEmpty: boolean; allAliasesAgree: boolean; allReadsSynchronous: boolean;
  repeatedReadsPerAlias: number; unknownZtoolsEmpty: boolean; unknownUtoolsEmpty: boolean; unknownElectronEmpty: boolean; actualPathValuesRecorded: boolean };
async function verifyOriginalTextWrite(context: PublishedScenarioContext) {
  const { check, observations, probe, until, setPhase } = context;
  setPhase("regex-approved-standard-path-contract");
  const before = await invoke<PathEvidence>("native_published_path_evidence");
  check(before.confinedToPrivateHome && before.fileCount === 0 && before.readOnlyEvidence && before.standardPathTaskRunCount === 1
    && before.standardPathRunsSucceeded && before.privateMarkersAbsent,
    "Independent host evidence verifies an empty private download directory and one successful path preparation");
  const { pathContract } = await probe<{ pathContract: PathContract }>("path-contract");
  check(pathContract.downloadsType === "string" && pathContract.downloadsNonEmpty && pathContract.allReadsSynchronous
    && pathContract.allAliasesAgree && pathContract.repeatedReadsPerAlias === 120 && pathContract.actualPathValuesRecorded === false,
    "Actual ztools, utools and Electron app getPath return identical synchronous download metadata on repeated reads");
  check(pathContract.unknownZtoolsEmpty && pathContract.unknownUtoolsEmpty && pathContract.unknownElectronEmpty,
    "All actual path API aliases return an empty string for an unknown directory name");
  const afterReads = await invoke<PathEvidence>("native_published_path_evidence");
  check(afterReads.standardPathTaskRunCount === before.standardPathTaskRunCount && afterReads.fileCount === 0,
    "Repeated actual getPath reads use the approved snapshot without new TaskRuns or filesystem writes");

  setPhase("regex-original-preload-fixed-text-write");
  const result = await probe<{ originalPreloadService: boolean; exportUiClicked: boolean; returnedString: boolean;
    returnedPathRecorded: boolean; fixedTextBytes: number }>("preload-write-synthetic-text");
  const expectedBytes = new TextEncoder().encode("ATOOLS_PATH_SNAPSHOT_SYNTHETIC\n").length;
  check(result.originalPreloadService && !result.exportUiClicked && result.returnedString && !result.returnedPathRecorded
    && result.fixedTextBytes === expectedBytes,
    "Unmodified original preload writeTextFile service receives the fixed synthetic text and returns a synchronous path");
  const afterWrite = await until(async () => {
    const value = await invoke<PathEvidence>("native_published_path_evidence");
    return value.fileCount === 1 && value.contentMatches && value.actualBytes === expectedBytes ? value : null;
  }, "Original preload did not write the exact fixed text into the private download directory");
  check(afterWrite.confinedToPrivateHome && afterWrite.readOnlyEvidence && afterWrite.standardPathRunsSucceeded
    && afterWrite.privateMarkersAbsent && afterWrite.standardPathTaskRunCount === before.standardPathTaskRunCount,
    "Independent read-only host evidence confirms one exact private export without path-history leakage or additional path TaskRuns");
  observations.regexStandardPaths = { before, pathContract, afterReads, serviceResult: result, afterWrite,
    boundary: "Original preload service invocation, not an export UI click; original getPath/path/fs/Date are unchanged. No caller-controlled path, readFile, image, clipboard or AI operation." };
}
async function toggleGlobalAndWait(context: PublishedScenarioContext, expected: boolean) {
  await context.probe<FrameState>("toggle-global");
  return context.until(async () => {
    const state = await context.probe<FrameState>("state");
    return activeGlobal(state) === expected ? state : null;
  }, `Published g flag did not update to ${expected ? "enabled" : "disabled"}`);
}

export async function runPublishedBusinessScenario(context: PublishedScenarioContext): Promise<PublishedBusinessResult> {
  const { check, until, pause, setPhase, observations } = context;
  let state = await until(async () => { const value = await context.probe<FrameState>("state"); return value.hasPattern && value.hasText ? value : null; }, "Published UI did not expose the reviewed regex editor");
  check(state.allAiModelsType === "undefined", "Fixture uses the real missing optional allAiModels API without fabricating model data");
  setPhase("regex-matches-flags-captures");
  state = await context.probe<FrameState>("set-pattern",{value:"(\\d+)"});
  state = await context.probe<FrameState>("set-text",{value:"abc123def456"});
  await pause(1200);
  state = await context.probe<FrameState>("state");
  check(state.aiHint.includes("未配置 AI 时使用本地规则解释"), "Original plugin displays its real offline Chinese-rule explanation hint");
  check(state.matchBadge.includes("2") && state.matchBadge.includes("处"), "Published regex UI reports two global matches");
  check(state.matched.length === 2 && state.matched.join(",") === "123,456", "Published original UI highlights both numeric matches");
  check(state.captures[0] === "123", "Published original UI renders capture group 123");
  if (!activeGlobal(state)) state = await toggleGlobalAndWait(context, true);
  check(activeGlobal(state), "Published original UI has the global g flag enabled");
  const withoutGlobal = await toggleGlobalAndWait(context, false);
  check(!activeGlobal(withoutGlobal) && withoutGlobal.matchBadge.includes("1"), "Toggling g off leaves only the first regex match");
  const withGlobal = await toggleGlobalAndWait(context, true);
  check(activeGlobal(withGlobal) && withGlobal.matchBadge.includes("2"), "Toggling g back on restores both matches");
  setPhase("invalid-pattern-recovery");
  await context.probe<FrameState>("set-pattern",{value:"["});
  const invalid = await until(async () => {
    const current = await context.probe<FrameState>("state");
    return current.pattern === "[" && current.error.length > 0 ? current : null;
  }, "Published invalid-regex error state did not render");
  check(invalid.error.length > 0 && !invalid.matchBadge, "Invalid regex shows the original error state and suppresses stale match count");
  await context.probe<FrameState>("set-pattern",{value:"(\\d+)"});
  const recovered = await until(async () => {
    const current = await context.probe<FrameState>("state");
    return current.pattern === "(\\d+)" && !current.error && current.matchBadge.includes("2") ? current : null;
  }, "Published valid-regex recovery did not render updated matches");
  check(!recovered.error && recovered.matchBadge.includes("2"), "Restoring a valid pattern restores real matching immediately");
  setPhase("offline-example-and-visual");
  await context.probe<FrameState>("load-chinese-example");
  const example = await until(async () => {
    const current = await context.probe<FrameState>("state");
    return current.pattern === "[\\u4e00-\\u9fff]+" && current.text === "Hello 你好 World 世界"
    && current.matched.join(",") === "你好,世界" ? current : null;
  }, "Published Chinese example did not render its expected local matches");
  check(example.pattern === "[\\u4e00-\\u9fff]+" && activeGlobal(example), "Original Chinese example loads its reviewed regex and g flag");
  check(example.text === "Hello 你好 World 世界" && example.matched.join(",") === "你好,世界", "Original example produces its two expected Chinese matches");
  check(example.canvasCount > 0, "Original local visualRegex renders its canvas without an AI request");
  check(example.aiHint.includes("未配置 AI 时使用本地规则解释"), "Offline local-rule hint remains visible for the example");
  await pause(1200);
  observations.finalUi = await context.probe<FrameState>("state");
  await verifyOriginalTextWrite(context);
  return { businessOutcome: "scoped_pass", tested: ["original regex match rendering", "capture rendering", "g flag toggle", "invalid regex feedback and recovery", "local example and visual canvas",
      "approved synchronous standard-path aliases and repeated cached reads", "original preload writeTextFile service with one fixed synthetic text in a private Downloads directory"],
    notTested: ["export UI click", "readFile and arbitrary file reads", "writeImageFile", "caller-controlled paths or export content", "clipboard methods", "AI generation", "physical keyboard", "other published plugins"],
    ai: "real missing optional API guard with temporary AI-disabled settings; no fake model list or success response" };
}

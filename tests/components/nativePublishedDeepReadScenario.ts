import { invoke } from "./nativePublishedPluginCommon";
import { projectDeepReadActivationFailure } from "./nativeDeepReadActivationDiagnostic";
import { projectDeepReadImportSnapshot } from "./nativeDeepReadImportProjection";
import { assertDeepReadFixtureEvidence } from "./nativeDeepReadFixtureEvidence";
import type { DeepReadFile } from "./nativeDeepReadFixtureEvidence";
import { captureDeepReadFrameIdentity, deepReadFrameIdentityIsCurrent, isDeepReadStorageSetItem, isDeepReadStorageWrite,
  approveDeepReadDataPermission, selectDeepReadFeatureThroughLauncher, waitForDeepReadAuthorizedFreshFrame,
  waitForDeepReadDataIdleBaseline, waitForDeepReadFileCompletion } from "./nativeDeepReadReviewedPermissionFlow";
import type { PublishedBusinessResult, PublishedFrameIsolation, PublishedPluginProfile, PublishedScenarioContext, TaskRun } from "./nativePublishedPluginCommon";

const CASE_ID = "converted-deepread-source";
const PLUGIN_ID = "deepread";
const STORED_CONTENT_BYTES = 8854;
const STORED_CONTENT_SHA256 = "7a4e04785979bbcd5889557e661584f2db4117b95c1c35de9cdbd39efeb007c0";
const SNAPSHOT_KEYS = ["bookCount", "contentBytes", "contentSha256", "fixtureBookPresent", "lastBookSelected", "pathStored",
  "pluginId", "progressAdvanced", "progressIndex", "readOnly", "source", "storageKeys"];

type DeepReadSnapshot = { bookCount: number; contentBytes: number | null; contentSha256: string | null; fixtureBookPresent: boolean;
  lastBookSelected: boolean; pathStored: boolean; pluginId: string; progressAdvanced: boolean;
  progressIndex: number | null; readOnly: true; source: string; storageKeys: string[] };
type DeepReadState = { caseId: string | null; mainLibraryVisible: boolean; fixtureBookVisible: boolean;
  fixtureBookActive: boolean; progressIndicatorWidth: string | null; nodeVersion: string | null;
  firstUseDisclaimerVisible: boolean; emptyLibraryVisible: boolean;
  searchOpen: boolean; searchQuery: string;
  searchResultCount: number; fixedSearchResultCount: number };

export function assertDeepReadProfile(profile: PublishedPluginProfile) {
  if (profile.caseId !== CASE_ID || profile.id !== PLUGIN_ID || profile.version !== "1.1.2"
    || profile.runtime !== "web" || profile.featureCode !== PLUGIN_ID || profile.dataAccess !== true
    || profile.pathAccess !== "none" || profile.dialogAccess !== "open" || profile.verifyDataPersistence !== true
    || profile.sourceKind !== "converted_handoff_directory" || profile.frameOperations !== "tests/components/nativePublishedDeepReadFrameOperations.js") {
    throw Error("DeepRead scenario is not bound to its fixed converted web profile");
  }
}

export function assertDeepReadReopenedState(snapshot: DeepReadSnapshot, expectedProgressIndex: number | undefined) {
  if (!Number.isSafeInteger(expectedProgressIndex) || expectedProgressIndex! <= 0
    || snapshot.progressIndex !== expectedProgressIndex || snapshot.progressAdvanced !== true
    || snapshot.contentBytes !== STORED_CONTENT_BYTES || snapshot.contentSha256 !== STORED_CONTENT_SHA256) {
    throw Error("DeepRead did not restore the exact last observed content and reading progress");
  }
  return snapshot;
}

export function assertDeepReadUiRestored(state: DeepReadState, expectedProgressIndicatorWidth: string | undefined) {
  if (state.caseId !== CASE_ID || !state.mainLibraryVisible || !state.fixtureBookVisible || !state.fixtureBookActive
    || typeof expectedProgressIndicatorWidth !== "string" || !/^\d{1,3}(?:\.\d+)?%$/.test(expectedProgressIndicatorWidth)
    || state.progressIndicatorWidth !== expectedProgressIndicatorWidth || state.nodeVersion !== "22.23.3") {
    throw Error("DeepRead main UI did not restore the fixed book, progress indicator and pinned Node version");
  }
  return state;
}

export function assertDeepReadSnapshot(value: unknown): DeepReadSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("DeepRead snapshot is malformed");
  const snapshot = value as Record<string, unknown>;
  if (Object.keys(snapshot).length !== SNAPSHOT_KEYS.length || SNAPSHOT_KEYS.some(key => !Object.hasOwn(snapshot, key))
    || snapshot.pluginId !== PLUGIN_ID || snapshot.readOnly !== true || snapshot.source !== "isolated SQLite plugin dbStorage projection"
    || !Number.isSafeInteger(snapshot.bookCount) || (snapshot.bookCount as number) < 0 || (snapshot.bookCount as number) > 50
    || typeof snapshot.fixtureBookPresent !== "boolean" || typeof snapshot.lastBookSelected !== "boolean"
    || typeof snapshot.pathStored !== "boolean" || typeof snapshot.progressAdvanced !== "boolean"
    || snapshot.progressIndex !== null && (!Number.isSafeInteger(snapshot.progressIndex) || (snapshot.progressIndex as number) < 0)
    || snapshot.contentBytes !== null && (!Number.isSafeInteger(snapshot.contentBytes) || (snapshot.contentBytes as number) < 0)
    || snapshot.contentSha256 !== null && (typeof snapshot.contentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.contentSha256))
    || JSON.stringify(snapshot.storageKeys) !== JSON.stringify(["deepread.library.v1", "deepread.lastBookId.v1"])) {
    throw Error("DeepRead snapshot contains an invalid or unbounded projection");
  }
  return snapshot as DeepReadSnapshot;
}

async function snapshot() {
  return assertDeepReadSnapshot(await invoke<unknown>("native_published_data_snapshot"));
}

export async function activateFiles(context: PublishedScenarioContext, file: DeepReadFile) {
  if (!context.activateFilesFeature) {
    context.observations.deepReadFileActivationFailure = projectDeepReadActivationFailure(undefined, "port-unavailable");
    throw Error("The smoke-gated production files-activation port is unavailable");
  }
  try { await context.activateFilesFeature("deepread-import", [file.path], PLUGIN_ID); }
  catch (error) {
    context.observations.deepReadFileActivationFailure = projectDeepReadActivationFailure(error, "callback-reported-error");
    throw Error("The production DeepRead fixed-file activation failed");
  }
}

async function probeState(context: PublishedScenarioContext, predicate: (state: DeepReadState) => boolean, label: string) {
  return context.until(async () => {
    const state = await context.probe<DeepReadState>("state");
    return state.caseId === CASE_ID && predicate(state) ? state : null;
  }, label);
}

async function consentToFirstUseDisclaimer(context: PublishedScenarioContext, identity: ReturnType<typeof captureDeepReadFrameIdentity>) {
  const beforeRuns = await invoke<TaskRun[]>("list_task_runs", { limit: 1000 });
  const beforeIds = new Set(beforeRuns.map(run => run.id));
  await context.probe("accept-first-use-disclaimer");
  const consent = await context.until(async () => {
    if (!deepReadFrameIdentityIsCurrent(context, identity)) throw Error("DeepRead frame changed during first-use consent");
    const title = document.querySelector('[data-permission-dialog] h2')?.textContent?.trim() || "";
    if (title) {
      if (title !== "DeepRead 深读 请求访问自己的数据") throw Error("DeepRead disclaimer reached an unreviewed permission gate");
      await approveDeepReadDataPermission(context, identity);
      return null;
    }
    const state = await context.probe<DeepReadState>("state");
    const runs = await invoke<TaskRun[]>("list_task_runs", { limit: 1000 });
    const storageRuns = runs.filter(run => isDeepReadStorageSetItem(run, beforeIds));
    if (storageRuns.some(run => run.status === "failed" || run.status === "cancelled" || run.status === "partial")) {
      throw Error("DeepRead first-use consent storage TaskRun failed");
    }
    const writes = storageRuns.filter(run => isDeepReadStorageWrite(run, beforeIds));
    if (writes.length > 1) throw Error("DeepRead first-use consent created multiple storage write TaskRuns");
    return !state.firstUseDisclaimerVisible && writes.length === 1 ? writes[0] : null;
  }, "Original DeepRead consent did not close through its UI and complete one storage TaskRun");
  context.observations.deepReadFirstUseConsent = { disclaimerInitiallyVisible: true, disclaimerClosed: true,
    storageTaskRunCount: 1, storageMethod: "dbStorage.setItem", taskRunStatus: consent.status, rawKeyExposed: false };
  return consent;
}

async function jumpToFixedPassage(context: PublishedScenarioContext) {
  await probeState(context, state => state.mainLibraryVisible && state.fixtureBookVisible,
    "The imported fixed DeepRead book did not appear in the original library DOM");
  await context.probe("select-fixture-book");
  await context.probe("open-search-jump");
  await probeState(context, state => state.searchOpen, "The original DeepRead search-jump dialog did not open");
  await context.probe("set-fixed-search");
  await probeState(context, state => state.searchQuery === "DeepRead fixed reading line 020"
    && state.searchResultCount > 0 && state.fixedSearchResultCount === 1,
    "The original DeepRead search did not expose exactly one result containing the fixed passage");
  await context.probe("jump-to-fixed-match");
  await probeState(context, state => !state.searchOpen, "The original DeepRead search did not return after selecting a match");
}

export async function runDeepReadScenario(context: PublishedScenarioContext): Promise<PublishedBusinessResult> {
  assertDeepReadProfile(context.profile);
  const { check, observations, setPhase } = context;
  setPhase("deepread-original-fixed-file-import");
  const file = assertDeepReadFixtureEvidence(await invoke<unknown>("native_published_deepread_fixture"), context.fixture.deepReadTextEncoding);
  const initialState = await probeState(context, state => state.firstUseDisclaimerVisible && state.emptyLibraryVisible,
    "The original DeepRead first-use disclaimer and empty-library UI were not visible");
  check(!initialState.fixtureBookVisible, "The isolated DeepRead library starts without the fixed imported book");
  const initialFrame = captureDeepReadFrameIdentity(context);
  await consentToFirstUseDisclaimer(context, initialFrame);
  const consentedState = await context.probe<DeepReadState>("state");
  check(!consentedState.firstUseDisclaimerVisible && consentedState.emptyLibraryVisible,
    "Original consent closes the disclaimer while retaining the original empty-library UI");
  const before = await snapshot();
  check(!before.fixtureBookPresent && deepReadFrameIdentityIsCurrent(context, initialFrame),
    "Consent leaves the isolated library empty in the same authenticated main document");
  const runsBeforeImport = await waitForDeepReadDataIdleBaseline(context, initialFrame);
  await activateFiles(context, file);
  const filesFrame = await waitForDeepReadAuthorizedFreshFrame(context, initialFrame.nonce, true);
  const filesIdentity = captureDeepReadFrameIdentity(context, filesFrame);
  check(filesIdentity.nonce !== initialFrame.nonce,
    "The files activation resolves its permission gates into a fresh authenticated DeepRead document");
  setPhase("deepread-original-fixed-file-import");
  const expectedPayloadJsonBytes = new TextEncoder().encode(JSON.stringify([file.path])).byteLength;
  const importResult = await waitForDeepReadFileCompletion(context, runsBeforeImport, filesIdentity, expectedPayloadJsonBytes);
  const imported = await context.until(async () => {
    const value = await snapshot();
    observations.deepReadImportSnapshot = projectDeepReadImportSnapshot(value, file.storedContentBytes, file.storedContentSha256);
    return value.fixtureBookPresent && value.lastBookSelected && value.pathStored
      && value.contentBytes === file.storedContentBytes && value.contentSha256 === file.storedContentSha256 ? value : null;
  }, "The single production DeepRead files activation did not persist the fixed local book in its fresh authenticated document");
  check(imported.bookCount === 1 && imported.progressIndex === 0,
    "The production importer persisted exactly one fixed local book at its initial progress");
  observations.deepReadImport = { textEncodingVariant: file.textEncoding, fileName: file.fileName, rawFileBytes: file.bytes, rawFileSha256: file.sha256,
    storedContentBytes: imported.contentBytes, storedContentSha256: imported.contentSha256,
    importedBookCount: imported.bookCount, initialProgressIndex: imported.progressIndex,
    importTaskRunCount: 1, importTaskRunStatus: importResult.featureRun.status, fileActivationCount: 1,
    successfulPluginDataWrites: importResult.successfulStorageWriteCount,
    importTaskPathExposed: false, source: "real App.activateFeature files input through deepread-import" };

  setPhase("deepread-original-search-and-progress");
  const opened = await snapshot();
  check(opened.fixtureBookPresent && opened.lastBookSelected, "The original reader reopens the imported fixed book from SQLite");
  await jumpToFixedPassage(context);
  const jumped = await context.until(async () => {
    const value = await snapshot();
    return value.fixtureBookPresent && value.progressAdvanced && (value.progressIndex ?? 0) > (imported.progressIndex ?? 0) ? value : null;
  }, "Selecting the original search result did not advance SQLite reading progress");
  check(jumped.lastBookSelected, "The original search result retains the fixed book selection");

  setPhase("deepread-next-page-through-launcher");
  const beforeNext = await snapshot();
  const taskRunsBefore = await invoke<TaskRun[]>("list_task_runs", { limit: 1000 });
  await selectDeepReadFeatureThroughLauncher(context, "deepread-next-page", "deepread-next-page", undefined, false);
  const runs = await context.until(async () => {
    const current = await invoke<TaskRun[]>("list_task_runs", { limit: 1000 });
    const found = current.filter(run => !taskRunsBefore.some(old => old.id === run.id)
      && run.capabilityId === "plugin.feature.deepread-next-page");
    return found.length === 1 && found[0].status === "succeeded" ? found : null;
  }, "The real Launcher selection did not create one successful next-page feature TaskRun");
  const afterNext = await context.until(async () => {
    const value = await snapshot();
    return value.progressIndex !== null && beforeNext.progressIndex !== null
      && value.progressIndex > beforeNext.progressIndex ? value : null;
  }, "The original next-page feature did not advance the fixed book's SQLite progress");
  check(afterNext.lastBookSelected, "The original next-page action remains bound to the fixed selected book");
  const afterNextUi = await probeState(context, state => state.mainLibraryVisible && state.fixtureBookVisible
    && state.fixtureBookActive && typeof state.progressIndicatorWidth === "string"
    && /^\d{1,3}(?:\.\d+)?%$/.test(state.progressIndicatorWidth) && state.nodeVersion === "22.23.3",
  "The original main UI did not show the active fixed book, progress indicator and pinned Node version after next-page");
  context.deepReadExpectedProgressIndicatorWidth = afterNextUi.progressIndicatorWidth!;
  context.deepReadExpectedProgressIndex = afterNext.progressIndex ?? undefined;
  observations.deepReadProgress = { afterSearchJump: jumped.progressIndex, afterLauncherNextPage: afterNext.progressIndex,
    nextPageTaskRunCount: runs.length, nextPageTaskRunStatus: runs[0].status,
    mainUiProgressIndicatorWidth: afterNextUi.progressIndicatorWidth,
    source: "original search-result handler and normal Launcher feature selection" };
  observations.deepReadChildWindow = { tested: false, reason: "The published frame probe observes only the main iframe; no owner-bound child DOM reader port is exposed" };
  return { businessOutcome: "scoped_pass", tested: ["original first-use disclaimer dismissed through its UI with one successful storage TaskRun",
    "fixed text file accepted by the original files feature through one production activation",
    "original library shows the imported local book", "original search-result action advances SQLite progress",
    "normal Launcher selection of deepread-next-page advances SQLite progress", "fresh main UI restores the active book and progress indicator",
    "the fixed Node-dependent preload exposes the pinned Node version after real authorization",
    "host SQLite projection retains exact stored text identity and progress after close and reopen"],
    notTested: ["reader text rendered in the child fish.html UI and its paint", "physical input", "market installation", "all DeepRead features", "large-library performance"],
    boundary: "The handoff remains conversion evidence only. This scoped check covers the production files activation, original main-frame DOM actions and bounded SQLite projection; it does not prove complete plugin usability." };
}

export async function verifyDeepReadAfterReopen(context: PublishedScenarioContext, previousFrame: HTMLIFrameElement) {
  assertDeepReadProfile(context.profile);
  const { check, profile, observations, probe } = context;
  context.setPhase("deepread-whole-plugin-close-and-fresh-data-reopen");
  check(!previousFrame.isConnected, "Whole DeepRead close removes the previous main iframe");
  const frame = await selectDeepReadFeatureThroughLauncher(context, PLUGIN_ID, profile.searchQuery, previousFrame, true);
  check(frame !== previousFrame && frame.contentWindow !== previousFrame.contentWindow,
    "Whole DeepRead reopen creates a fresh main browsing context");
  const restoredUi = assertDeepReadUiRestored(await probeState(context, state => state.fixtureBookVisible
    && state.fixtureBookActive && state.progressIndicatorWidth === context.deepReadExpectedProgressIndicatorWidth,
  "Fresh DeepRead main UI did not restore the fixed active book and its prior progress indicator"),
  context.deepReadExpectedProgressIndicatorWidth);
  const frameState = await probe<PublishedFrameIsolation>("state");
  observations.deepReadReopenedFrameIsolation = { origin: frameState.origin,
    parentDocumentAccessBlocked: frameState.parentDocumentAccessBlocked };
  const value = await context.until(async () => {
    const current = await snapshot();
    try { return current.fixtureBookPresent && current.lastBookSelected
      ? assertDeepReadReopenedState(current, context.deepReadExpectedProgressIndex) : null; }
    catch { return null; }
  }, "DeepRead SQLite book content and exact last observed progress did not survive whole-plugin close and reopen");
  check(value.progressIndex === context.deepReadExpectedProgressIndex,
    "Fresh DeepRead host SQLite projection retains exact stored content identity and progress");
  observations.deepReadAfterWholeReopen = { bookCount: value.bookCount, fixtureBookPresent: value.fixtureBookPresent,
    lastBookSelected: value.lastBookSelected, progressIndex: value.progressIndex,
    contentBytes: value.contentBytes, contentSha256: value.contentSha256, pathStored: value.pathStored,
    newMainIframe: true, mainUiRestoredActiveBook: restoredUi.fixtureBookActive,
    mainUiRestoredProgressIndicatorWidth: restoredUi.progressIndicatorWidth,
    mainUiNodeVersion: restoredUi.nodeVersion, mainUiRenderedReaderContentVerified: false, childReaderObserved: false };
}

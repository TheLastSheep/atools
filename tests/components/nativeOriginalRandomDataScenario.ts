import type { PublishedBusinessResult, PublishedFrameIsolation, PublishedScenarioContext, RuntimeState } from "./nativePublishedPluginCommon";
import { invoke, launcherInput, approvePublishedData, publishedWebRuntimeReady, verifyPublishedFrameIsolation } from "./nativePublishedPluginCommon";
import { projectRandomDataState } from "./nativeRandomDataObservation";

type RandomDataState = { ready: boolean; enabled: boolean; commands: string[]; input: string; preview: string; saveStatus: string };
type SearchResult = { code: string; plugin_id: string; match_type: string };
const CASE_ID = "local-random-data-head", COMMAND = "ATools Random UUID Acceptance";
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertCase(context: PublishedScenarioContext) {
  const { profile } = context;
  if (profile.caseId !== CASE_ID || profile.id !== "random-data" || profile.version !== "1.2.0"
    || profile.featureCode !== "randomDataSettings" || profile.runtime !== "web" || !profile.dataAccess
    || profile.pathAccess !== "none" || profile.dialogAccess !== "none" || profile.verifyDataPersistence !== true) {
    throw Error("Random Data scenario requires the exact reviewed Web/data-only profile");
  }
}

async function readState(context: PublishedScenarioContext) {
  const state = await context.probe<RandomDataState>("state");
  context.observations.originalRandomDataLastState = projectRandomDataState(state, COMMAND);
  return state;
}
async function waitState(context: PublishedScenarioContext, predicate: (state: RandomDataState) => boolean, label: string) {
  return context.until(async () => { const state = await readState(context); return state.ready && predicate(state) ? state : null; }, label);
}
async function verifyFeature(context: PublishedScenarioContext) {
  const catalog = await invoke<SearchResult[]>("feature_catalog");
  const searched = await invoke<SearchResult[]>("search_features", { query: COMMAND });
  const feature = catalog.find(item => item.plugin_id === "random-data" && item.code === "randomUuid");
  const exactCommandHit = searched.find(item => item.plugin_id === "random-data" && item.code === "randomUuid"
    && item.match_type === "exact");
  context.check(feature && exactCommandHit,
    "Original setFeature publishes randomUuid and the exact fixed command matches that dynamic feature");
  return { catalog: !!feature, exactCommandSearchHit: !!exactCommandHit };
}
async function verifyStorage(context: PublishedScenarioContext, label: string) {
  const snapshot = await invoke<{ pluginId: string; settingsPresent: boolean; randomUuid: { enabled: boolean; commands: string[] } }>("native_published_data_snapshot");
  context.check(snapshot.pluginId === "random-data" && snapshot.settingsPresent && snapshot.randomUuid.enabled
    && snapshot.randomUuid.commands.includes(COMMAND), label + " sees the exact command in isolated SQLite settings");
  return snapshot;
}

export async function runOriginalRandomDataScenario(context: PublishedScenarioContext): Promise<PublishedBusinessResult> {
  assertCase(context);
  const { check, observations, setPhase, probe } = context;
  let state = await waitState(context, value => value.enabled && value.commands.includes("uuid"), "Original Random Data UUID controls did not mount");
  setPhase("original-random-data-sample-preview");
  await probe("sample");
  state = await waitState(context, value => UUID_SHAPE.test(value.preview), "Original Generate Sample button did not render a UUID-shaped preview");
  check(UUID_SHAPE.test(state.preview), "Original sample control displays only a UUID-shaped generated value");
  setPhase("original-random-data-command-autosave");
  await probe("add-command");
  state = await waitState(context, value => value.commands.includes(COMMAND) && value.saveStatus === "已自动保存",
    "Original command editor did not autosave the fixed command");
  const feature = await verifyFeature(context), database = await verifyStorage(context, "First Random Data page");
  const runtime = await invoke<RuntimeState>("native_published_runtime_state");
  check(publishedWebRuntimeReady(runtime, true) && runtime.legacySessions === 0 && !runtime.legacyTransport
    && runtime.activePathSnapshots === 0 && runtime.dialogSessions === 0,
    "Original Web settings page uses only its approved data session, with no Node, path snapshot or native dialog");
  observations.originalRandomDataPersisted = { command: COMMAND, sampleShape: "canonical UUID groups; value not retained in report",
    pageState: projectRandomDataState(state, COMMAND), feature, database,
    storageWritesByFixture: false, valueCopiedOrAutofilled: false };
  return { tested: ["original randomUuid sample button and UUID shape", "original command chip input and Enter handler", 
    "original autosave into SQLite", "real dynamic host feature catalog and search", "data-only Web runtime"],
    notTested: ["physical keyboard/pointer", "clipboard or automatic fill", "other generators", "custom generators", "system keyboard input"],
    boundary: "Fixed DOM operations use the original preview and command handlers; sample values are checked in memory and never copied, filled, or retained. Persistence verification reads the isolated host database." };
}

export async function verifyRandomDataAfterReopen(context: PublishedScenarioContext, previousFrame: HTMLIFrameElement) {
  assertCase(context);
  const { check, observations, setPhase, until, probe, profile } = context;
  setPhase("original-random-data-whole-close-fresh-data-reopen");
  check(!previousFrame.isConnected, "Whole Random Data close removes the previous iframe");
  const input = launcherInput(); check(input, "Launcher is available before Random Data reopens");
  input!.value = profile.searchQuery; input!.dispatchEvent(new Event("input", { bubbles: true }));
  const option = await until(() => [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    .find(node => node.dataset.pluginId === profile.id && node.dataset.resultCode === profile.featureCode), "Random Data launcher feature is missing after close");
  option.click(); observations.originalRandomDataReopenBeforePermission = await approvePublishedData(context, "Reopened original Random Data");
  const frame = await until(() => document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]'), "Random Data did not reopen");
  check(frame !== previousFrame && frame.contentWindow !== previousFrame.contentWindow, "Fresh approval creates a new Random Data iframe");
  const restored = await waitState(context, value => value.enabled && value.commands.includes(COMMAND), "Random Data did not restore the saved command in a new iframe");
  const feature = await verifyFeature(context), database = await verifyStorage(context, "Reopened Random Data page");
  observations.originalRandomDataReopenedFrameIsolation = verifyPublishedFrameIsolation(frame,
    await probe<PublishedFrameIsolation>("state"), check);
  const runtime = await invoke<RuntimeState>("native_published_runtime_state");
  check(publishedWebRuntimeReady(runtime, true) && runtime.pendingRequests === 0 && runtime.legacySessions === 0
    && !runtime.legacyTransport && runtime.activePathSnapshots === 0 && runtime.dialogSessions === 0,
    "Reopened Random Data owns only its freshly approved data session");
  observations.originalRandomDataAfterWholeReopen = { restored: projectRandomDataState(restored, COMMAND), feature, database, runtime, freshOneTimeApproval: true, newIframe: true };
}

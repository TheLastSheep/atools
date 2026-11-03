import { approvePublishedData, approvePublishedStandardPaths, invoke, launcherInput, permissionDialog, publishedPathsReady,
  verifyPublishedFrameIsolation } from "./nativePublishedPluginCommon";
import type { PublishedBusinessResult, PublishedFrameIsolation, PublishedScenarioContext, RuntimeState } from "./nativePublishedPluginCommon";
import { createNativeOriginalPlainTextUiInputScenario } from "./nativeOriginalPlainTextUiInputScenario";
import { editorInputAdmission } from "./nativeEditorInputAdmission";

type Focus = { visibilityState: string; documentHidden: boolean; documentHasFocus: boolean; editorActive: boolean;
  editorConnected: boolean; editorWidth: number; editorHeight: number; editorIsContentEditable?: boolean;
  computedStyle?: { webkitUserModify: string; userSelect: string; pointerEvents: string } | null;
  inertAncestors?: string[]; userActivation?: { isActive: boolean; hasBeenActive: boolean } | null };
type PlainState = { ready: boolean; text: string; mode: string; previewHeading: string; previewItems: string[];
  drawerOpen: boolean; drafts: Array<{ title: string; active: boolean }>; focusDiagnostics: Focus;
  focusAttempt?: unknown; editCommandResults: Array<{ command: string; accepted: boolean }>; nativeUiInputObservation?: unknown };
type Note = { id: string; title: string; content: string; mode: string };
type Snapshot = { pluginId: string; readOnly: boolean; storageKind: string; activeId: string; notes: Note[] };
const ALPHA = "ATools plain alpha document line 1234567890\nAlpha fixed body\nSecond line.";
const BETA = "# ATools markdown beta document\n\n- first\n- second";
const ALPHA_TITLE = "ATools plain alpha d", BETA_TITLE = "# ATools markdown be";

async function nativeVisible(context: PublishedScenarioContext, label: string) {
  const admission = editorInputAdmission(context);
  if (admission) await admission.measure("foreground-request", () => invoke("native_panel_foreground", { ensure: true }));
  else await invoke("native_panel_foreground", { ensure: true });
  const native = await context.until(async () => {
    const observe = () => invoke<{ appActive: boolean; appHidden: boolean; frontmostIsSelf: boolean; nativeFocused: boolean; nativeVisible: boolean }>("native_panel_foreground", { ensure: false });
    const state = admission ? await admission.measure("native-observe", observe) : await observe();
    context.observations.originalPlainNativeLast = { ...state, hostVisibility: document.visibilityState };
    return state.appActive && !state.appHidden && state.frontmostIsSelf && state.nativeFocused && state.nativeVisible
      && document.visibilityState === "visible" ? state : null;
  }, label + " requires a positively visible, foreground native window before editor commands");
  const frame = await context.until(async () => {
    const state = admission ? await admission.measure("authenticated-frame", () => context.probe<PlainState>("state"))
      : await context.probe<PlainState>("state"); context.observations.originalPlainFrameLast = state;
    const f = state.focusDiagnostics;
    return state.ready && f && f.visibilityState === "visible" && !f.documentHidden && f.editorConnected
      && f.editorWidth > 0 && f.editorHeight > 0 ? state : null;
  }, label + " original CodeMirror document is not positively visible; editor input is blocked");
  return { native, frame: frame.focusDiagnostics, hostVisibility: document.visibilityState };
}
const waitState = (context: PublishedScenarioContext, content: string, mode: string) => context.until(async () => {
  const state = await context.probe<PlainState>("state"); context.observations.originalPlainLastState = state;
  return state.ready && state.text === content && state.mode === mode ? state : null;
}, "Original plain-text CodeMirror did not retain the exact fixed text and mode");
async function enter(context: PublishedScenarioContext, operation: string, content: string) {
  let state: PlainState;
  try { state = await context.probe<PlainState>(operation); }
  catch (error) {
    const failedFrameProbe = context.observations.lastFrameProbe;
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]');
    context.observations.originalPlainInputFailure = {
      failedFrameProbe,
      frameState: await context.probe<PlainState>("state").catch(() => null),
      host: { documentHasFocus: document.hasFocus(), visibilityState: document.visibilityState,
        activeIsPluginFrame: !!frame && document.activeElement === frame,
        activeElementTag: document.activeElement?.tagName.toLowerCase().slice(0, 32) ?? "",
        permissionDialogs: document.querySelectorAll("[data-permission-dialog]").length,
        modalDialogs: document.querySelectorAll('[aria-modal="true"]').length },
      scope: "Read-only failure snapshot; original focus and editor operation are not replayed",
    };
    throw error;
  }
  context.check(state.focusDiagnostics.editorActive && state.focusDiagnostics.documentHasFocus
    && state.editCommandResults.length === 2 && state.editCommandResults[0].command === "selectAll"
    && state.editCommandResults[1].command === "insertText" && state.editCommandResults.every(item => item.accepted),
  "Original plain-text editor receives both successful browser commands with real editor and document focus");
  return waitState(context, content, "text");
}
async function snapshot(context: PublishedScenarioContext, expectedCount: 1 | 2) {
  const database = await context.until(async () => {
    const value = await invoke<Snapshot>("native_published_data_snapshot");
    const alpha = value.notes?.find(note => note.content === ALPHA);
    const beta = value.notes?.find(note => note.content === BETA);
    const active = expectedCount === 1 ? alpha : beta;
    return value.pluginId === "plain-text" && value.readOnly === true && value.storageKind === "webStorage"
      && value.notes.length === expectedCount && alpha?.title === ALPHA_TITLE && alpha.mode === "text" && alpha.id
      && (expectedCount === 1 || beta?.title === BETA_TITLE && beta.mode === "markdown" && beta.id && beta.id !== alpha.id)
      && active?.id === value.activeId ? value : null;
  }, "Independent UTF-16 SQLite webStorage projection did not retain fixed content, 20-character titles, modes and active ID");
  context.check(database.readOnly, "Original plain-text autosave is independently read from only its two fixed SQLite Web Storage keys");
  return database;
}
async function list(context: PublishedScenarioContext, active: string) {
  await context.probe("open-list");
  return context.until(async () => {
    const value = await context.probe<PlainState>("state");
    return value.drawerOpen && value.drafts.length === 2 && value.drafts.some(note => note.title === ALPHA_TITLE)
      && value.drafts.some(note => note.title === BETA_TITLE) && value.drafts.filter(note => note.active).length === 1
      && value.drafts.some(note => note.title === active && note.active) ? value : null;
  }, "Original plain-text drawer did not display exactly two fixed draft titles and active selection");
}
async function switchBoth(context: PublishedScenarioContext) {
  const betaList = await list(context, BETA_TITLE);
  await context.probe("select-alpha"); const alpha = await waitState(context, ALPHA, "text");
  const alphaList = await list(context, ALPHA_TITLE);
  await context.probe("select-beta"); const beta = await waitState(context, BETA, "markdown");
  context.check(beta.previewHeading === "ATools markdown beta document" && beta.previewItems.join("|") === "first|second",
    "Original Markdown preview renders the fixed heading and two list items after switching back to the saved draft");
  return { betaList, alpha, alphaList, beta };
}

export async function runOriginalPlainTextScenario(context: PublishedScenarioContext): Promise<PublishedBusinessResult> {
  context.setPhase("original-plain-native-visible-and-focus-preconditions");
  context.observations.originalPlainUiPreconditions = await nativeVisible(context, "Original plain-text");
  const nativeUiInput = (context.fixture as (PublishedScenarioContext["fixture"] & { nativeUiInput?: boolean }) | undefined)?.nativeUiInput === true;
  const osInput = nativeUiInput ? await createNativeOriginalPlainTextUiInputScenario(context) : null;
  let alpha: PlainState, beta: PlainState;
  let inputFailed = false;
  try {
    context.setPhase(nativeUiInput ? "original-plain-text-os-input-alpha" : "original-plain-real-codemirror-browser-entry");
    alpha = osInput ? await osInput.enter("alpha") : await enter(context, "enter-alpha", ALPHA);
    context.observations.originalPlainFirstAutosave = await snapshot(context, 1);
    await context.probe("new-draft"); await waitState(context, "", "text");
    beta = osInput ? await osInput.enter("beta") : await enter(context, "enter-beta", BETA);
    // Wait for the original 300 ms autosave before switching mode or draft; no storage write is supplied by the fixture.
    await context.until(async () => {
      const value = await invoke<Snapshot>("native_published_data_snapshot");
      return value.notes?.some(note => note.content === BETA && note.title === BETA_TITLE) ? value : null;
    }, "Original second plain-text draft did not autosave through webStorage before Markdown toggle");
  } catch (error) {
    inputFailed = true;
    throw error;
  } finally {
    if (osInput) try { await osInput.stop(); }
    catch (error) {
      context.observations.originalPlainNativeUiCleanupFailure = {
        errorClass: error instanceof Error ? "Error" : "NonError", primaryErrorPreserved: inputFailed,
      };
      if (!inputFailed) throw error;
    }
  }
  await context.probe("markdown"); await waitState(context, BETA, "markdown");
  context.setPhase("original-plain-markdown-drawer-two-draft-switch");
  const switching = await switchBoth(context), database = await snapshot(context, 2);
  context.observations.originalPlainPersisted = database;
  context.observations.originalPlainEditing = { alpha, beta, switching, database,
    inputMechanism: osInput ? "trusted OS pointer/key/beforeinput/input events on the original contenteditable editor"
      : "real contenteditable focus and browser selectAll/insertText" };
  return { tested: ["visible foreground native preconditions", nativeUiInput
    ? "trusted OS keyboard and pointer input on the original CodeMirror editor"
    : "real original CodeMirror focus and browser editing commands", "original 300 ms autosave through SQLite webStorage",
    "first-line 20-character title", "original Markdown toggle and preview", "original new-draft and drawer switching"],
    notTested: [nativeUiInput ? "human hardware input" : "physical keyboard/pointer", "visual comparison", "clipboard", "export and Mod-S", "drag/drop or filesystem services", "settings and large documents"],
    boundary: nativeUiInput
      ? "Explicit isolated OS-controlled editor input only; no fixture editor focus, browser editing commands, CodeMirror model, React state or storage injection. New-draft, Markdown and drawer controls still use fixed original DOM button/row clicks; those controls are not OS pointer acceptance. Trusted counters retain no key values or document body. Static downloads-path detection requires standard metadata permission. Full-close restoration is verified separately with fresh data/path/Node approvals."
      : "Unchanged original UI only. Focus or browser-command failure fails the case; no CodeMirror model, React state or storage injection is permitted. Static downloads-path detection requires standard metadata permission. No preload file service, clipboard or export is invoked. Full-close restoration is verified separately with fresh data/path/Node approvals." };
}

export async function verifyOriginalPlainTextAfterReopen(context: PublishedScenarioContext, previousFrame: HTMLIFrameElement) {
  const { until, check, profile, observations } = context;
  context.setPhase("original-plain-whole-close-fresh-data-path-node-reopen");
  check(!previousFrame.isConnected && !document.querySelector(".plugin-panel"), "Whole plain-text close removes the original panel and iframe before reopening");
  const previous = observations.originalPlainPersisted as Snapshot;
  check(previous?.notes?.length === 2, "Plain-text reopen has independently recorded two-draft persistence evidence");
  const input = launcherInput(); check(input, "Launcher exists before plain-text reopen");
  input!.value = profile.searchQuery; input!.dispatchEvent(new Event("input", { bubbles: true }));
  const option = await until(() => [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    .find(node => node.dataset.pluginId === profile.id && node.dataset.resultCode === profile.featureCode), "Original plain-text catalog feature missing after close");
  option.click(); observations.originalPlainReopenBeforeData = await approvePublishedData(context, "Reopened original plain-text");
  observations.originalPlainReopenBeforePaths = await approvePublishedStandardPaths(context);
  await until(async () => {
    const title = permissionDialog()?.querySelector("h2")?.textContent || "";
    const pending = await invoke<Array<{ tool_name: string; client_id: string }>>("list_pending_agent_requests");
    return title.includes(profile.title) && title.includes("请求访问本机") && pending.length === 1
      && /^legacy_node_[a-f0-9]{64}$/.test(pending[0].tool_name) && pending[0].client_id === "atools-ui";
  }, "Reopened original plain-text did not request its exact fresh Node capability");
  const waiting = await invoke<RuntimeState>("native_published_runtime_state");
  check(waiting.legacySessions === 0 && waiting.legacyOpenings === 0 && !waiting.legacyTransport && waiting.pendingRequests === 1
    && waiting.dataSessions === 1 && waiting.dataTransport && publishedPathsReady(waiting, "standard")
    && !document.querySelector('iframe[title="Plugin"]'), "Plain-text reopens data then paths while Node and original iframe still wait for fresh Node approval");
  const allow = [...permissionDialog()!.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === "允许一次");
  check(allow, "Reopened original plain-text requires one-time Node approval"); allow!.click();
  const frame = await until(() => document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]'), "Original plain-text did not open a new iframe");
  check(frame !== previousFrame && frame.contentWindow !== previousFrame.contentWindow, "Original plain-text reopens in a new iframe and browsing context");
  const preconditions = await nativeVisible(context, "Reopened original plain-text");
  const restoredActive = await waitState(context, BETA, "markdown");
  const switching = await switchBoth(context), database = await snapshot(context, 2);
  check(database.activeId === previous.activeId && previous.notes.every(old => database.notes.some(note =>
    note.id === old.id && note.title === old.title && note.content === old.content && note.mode === old.mode)),
  "Whole-plugin reopen restores the same two draft IDs, fixed contents, title, modes and active Markdown draft from SQLite");
  const isolation = verifyPublishedFrameIsolation(frame, await context.probe<PublishedFrameIsolation>("state"), check);
  const runtime = await invoke<RuntimeState>("native_published_runtime_state");
  check(runtime.dataSessions === 1 && runtime.dataTransport && runtime.legacySessions === 1 && runtime.legacyTransport
    && runtime.hostSessions === 0 && !runtime.hostTransport && publishedPathsReady(runtime, "standard")
    && runtime.pendingRequests === 0 && runtime.nativeDialogs === 0 && runtime.dialogSessions === 0 && !runtime.dialogTransport,
  "Reopened plain-text owns only fresh data, path metadata and Node sessions without clipboard or native file panels");
  observations.originalPlainAfterWholeReopen = { preconditions, restoredActive, switching, database, isolation, runtime,
    freshOneTimeApprovals: 3, newIframe: true, documentsInjected: false, storageWritesByFixture: false, nativePanelOpened: false };
}

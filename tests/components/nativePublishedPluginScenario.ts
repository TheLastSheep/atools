import { runPublishedBusinessScenario } from "./nativePublishedPluginBusiness";
import { installEditorInputAdmission } from "./nativeEditorInputAdmission";
import { jsonEditorFrameUiReady, jsonEditorNativeUiReady } from "./nativeJsonEditorPreconditions";
import { reviewedPackageImportPath, verifyOriginalArchiveConflictReport, verifyOriginalArchiveInstalled } from "./nativeOriginalArchiveImport";
import { verifyColorCollectionAfterReopen } from "./nativePublishedColorHelperScenario";
import { verifyTodoAfterReopen } from "./nativePublishedTodoScenario";
import { verifyDeepReadAfterReopen } from "./nativePublishedDeepReadScenario";
import { requiresLegacyNodeSession, requiresPluginDisplaySession } from "./nativePublishedRuntimeRequirement";
import { approvePublishedDisplayMetadata } from "./nativePublishedDisplayPermission";
import { verifyOriginalInstalledEntry } from "./nativeOriginalInventoryScenario";
import { verifyOriginalAsciiTreeAfterReopen } from "./nativeOriginalAsciiTreeScenario";
import { verifyOriginalPlainTextAfterReopen } from "./nativeOriginalPlainTextScenario";
import { verifyRandomDataAfterReopen } from "./nativeOriginalRandomDataScenario";
import { launcherSnapshot, observeLauncherReturnState } from "./nativeLauncherReturnObservation";
import { createPassiveFocusObserver } from "./nativePublishedPassiveFocusObservation";
import { requestFixtureForegroundPreconditions } from "./nativePublishedForegroundPrecondition";
import { approvePublishedNodePermission, waitForPublishedNodeSession } from "./nativePublishedNodeAuthorization";
import { approvePublishedStartupDialogs } from "./nativePublishedStartupDialogPermissions";
import { verifyConvertedImportResult } from "./nativeConvertedHandoff";
import { approvePublishedData, approvePublishedStandardPaths, blockingPublishedDiagnostics, createFrameProbe, dataRuntimeDrained, invoke, launcherInput, pause, permissionDialog, publishedPathsReady, publishedWebRuntimeReady, runtimeDrained, until,
  verifyAssetProtocolDefer, verifyFixtureProfile, verifyPublishedFrameIsolation, preparedResourceLeaseExpectation } from "./nativePublishedPluginCommon";
import type { PublishedFixture, PublishedFrameIsolation, PublishedScenarioContext, RuntimeState, TaskRun } from "./nativePublishedPluginCommon";

export const PUBLISHED_DIAGNOSTIC_PHASES = [
  "actual-catalog-search",
  "calculation-controlled-input-decimal-and-grouping",
  "calculation-head-clear-and-reentry",
  "calculation-head-original-input-and-result",
  "calculation-invalid-empty-recovery",
  "close-and-drain",
  "codec-unicode-base64-round-trip",
  "codec-url-and-json-error-recovery",
  "color-helper-collection-dialog",
  "color-helper-invalid-recovery",
  "color-helper-original-lazy-gradient",
  "color-helper-red-conversion",
  "color-helper-whole-plugin-reopen",
  "content-link-json-and-social-layout",
  "content-normalize-and-markdown-plain-text",
  "cron-linux-five-field-step-editor",
  "cron-spring-six-field-backfill",
  "fixture",
  "frontend-entry",
  "frontend-mount-failed",
  "frontend-mount-start",
  "frontend-mounted",
  "frontend-report-submit",
  "frontend-scenario-complete",
  "frontend-scenario-failed",
  "frontend-scenario-start",
  "frontend-settings-ready",
  "invalid-pattern-recovery",
  "isolated-asset-protocol-defer",
  "native-installed-plugin-entry",
  "offline-example-and-visual",
  "original-ascii-tree-level-text-input",
  "original-ascii-tree-reverse-editor-input",
  "original-ascii-tree-whole-close-fresh-permission-reopen",
  "original-calculator-button-addition",
  "original-calculator-button-division",
  "original-json-editor-initial-worker-handshake",
  "original-json-editor-json-worker-valid-format",
  "original-json-editor-native-ui-preconditions",
  "original-json-editor-os-input-format",
  "original-json-editor-os-input-malformed",
  "original-json-editor-os-input-recovery",
  "original-json-editor-os-input-valid",
  "original-json-editor-ui-focus",
  "original-json-editor-worker-diagnostics-and-recovery",
  "original-json-worker-contract-only",
  "original-mybatis-clear",
  "original-mybatis-error-recovery",
  "original-mybatis-format-sql",
  "original-plain-markdown-drawer-two-draft-switch",
  "original-plain-native-visible-and-focus-preconditions",
  "original-plain-real-codemirror-browser-entry",
  "original-plain-text-os-input-alpha",
  "original-plain-text-os-input-beta",
  "original-plain-whole-close-fresh-data-path-node-reopen",
  "original-random-data-command-autosave",
  "original-random-data-sample-preview",
  "original-random-data-whole-close-fresh-data-reopen",
  "original-subnet-invalid-mask-recovery",
  "original-subnet-ipv4-24-31-32",
  "original-subnet-reverse-30-error-recovery",
  "original-uuid-host-subinput-deterministic-generation",
  "original-uuid-host-subinput-error-recovery",
  "original-zpx-conflicting-sources-rejected",
  "real-node-authorization",
  "real-display-authorization",
  "real-path-revocation-entry",
  "real-plugin-data-authorization",
  "real-standard-path-authorization",
  "real-startup-save-metadata-authorization",
  "regex-approved-standard-path-contract",
  "regex-matches-flags-captures",
  "regex-original-preload-fixed-text-write",
  "single-original-zpx-import",
  "single-package-directory-import",
  "timestamp-epoch-zone-observation",
  "timestamp-live-clock-pause-resume",
  "timestamp-reverse-calendar-controls",
  "timestamp-seconds-milliseconds-and-recovery",
  "todo-default-groups-and-sqlite",
  "todo-original-create-edit-complete",
  "todo-original-group-create-rename-and-return",
  "todo-original-search-and-completion-filter",
  "todo-whole-plugin-close-and-fresh-data-reopen",
] as const;
const diagnosticPhases = new Set<string>(PUBLISHED_DIAGNOSTIC_PHASES);

// Diagnostics are optional: never await their transport from acceptance or cleanup.
export function createPublishedPhaseRecorder(send: (phase: string) => Promise<unknown>) {
  const seen = new Set<string>();
  return (phase: string): void => {
    if (seen.size >= 96 || seen.has(phase) || !diagnosticPhases.has(phase)) return;
    seen.add(phase);
    try { void Promise.resolve(send(phase)).catch(() => {}); } catch { /* best effort */ }
  };
}
export const recordPublishedPhase = createPublishedPhaseRecorder(phase => invoke("native_published_phase", { phase }));

type SearchResult = { code: string; plugin_id: string; label: string; plugin_name: string };
type Plugin = { id: string; version: string; enabled: boolean };
type Diagnostic = { event: string; detail?: { blocked?: unknown }; [key: string]: unknown };

// Failure-only snapshots cannot delay the primary error report indefinitely.
export async function boundedPublishedDiagnostic(read: () => Promise<unknown>, timeoutMs = 750): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(read).catch(() => ({ unavailable: true, reason: "diagnostic-failed" })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ unavailable: true, reason: "diagnostic-timeout" }), timeoutMs); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

export async function runNativePublishedPluginScenario(activateFilesFeature?: PublishedScenarioContext["activateFilesFeature"]) {
  const checks: Record<string, boolean> = {}, observations: Record<string, unknown> = {}, diagnostics: Diagnostic[] = [];
  const passiveFocus = createPassiveFocusObserver(document, invoke, read => boundedPublishedDiagnostic(read));
  observations.passiveNativeRendererFocus = passiveFocus.records;
  const check = (ok: unknown, label: string) => { if (!ok) throw Error(label); checks[label] = true; };
  let phase = "fixture", fixture: PublishedFixture | null = null;
  const setPhase = (value: string) => { phase = value; recordPublishedPhase(value); };
  setPhase("fixture");
  let pluginSource: Window | null = null;
  let editorAdmission: ReturnType<typeof installEditorInputAdmission> | undefined;
  let editorContext: PublishedScenarioContext | undefined;
  const onDiagnostic = (event: MessageEvent) => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]');
    if (frame?.contentWindow) pluginSource = frame.contentWindow;
    if (event.data?.kind === "atools-published-diagnostic" && event.data.token === fixture?.token
      && (event.source === window || event.source === pluginSource)) diagnostics.push(event.data);
  };
  window.addEventListener("message", onDiagnostic);
  try {
    fixture = await invoke<PublishedFixture>("native_published_fixture");
    await passiveFocus.sample("startupAfterShow");
    const profile = verifyFixtureProfile(fixture);
    if (fixture.requireForeground === true) await requestFixtureForegroundPreconditions(observations);
    const context: PublishedScenarioContext = { fixture, profile, check, until, pause, observations, activateFilesFeature,
      passivePluginReturn: { markAttempted: passiveFocus.markPluginReturnAttempted, observeSettled: passiveFocus.observePluginReturn },
      setPhase, probe: createFrameProbe({ fixture, check, observations }) };
    if ((fixture as PublishedFixture & { nativeUiInput?: boolean }).nativeUiInput === true) {
      editorContext = context;
      editorAdmission = installEditorInputAdmission(context);
    }
    observations.fixtureIdentity = { runId: fixture.runId, profile, packageSha256: fixture.packageSha256 };
    await until(launcherInput, "Production App search input did not mount");
    const convertedSource = profile.sourceKind === "converted_handoff_directory";
    if (convertedSource) observations.assetProtocolPathProbe = { performed: false, reason: "converted handoff paths remain host-only" };
    else {
      if (typeof fixture.assetProbePath !== "string" || fixture.assetProbePath.length === 0) {
        throw Error("Registered fixture omitted its asset protocol probe path");
      }
      setPhase("isolated-asset-protocol-defer"); await verifyAssetProtocolDefer(context, fixture.assetProbePath);
    }
    const stored = await invoke<string | null>("get_setting", { key: "settings-general" });
    const settings = JSON.parse(stored || "{}");
    check(settings.aiProvider === "disabled" && !settings.aiDefaultModel && !settings.aiApiKey,
      "Temporary production settings have AI disabled and no configured model or key");
    const archiveImport = profile.sourceKind === "local_original_archive";
    const importPath = convertedSource ? null : reviewedPackageImportPath(fixture);
    if (archiveImport) {
      setPhase("original-zpx-conflicting-sources-rejected");
      const rejected = await invoke("import_ztools_plugins", { paths: [fixture.pluginRoot, importPath], overwrite: true });
      verifyOriginalArchiveConflictReport(rejected, fixture);
      const installed = (await invoke<Plugin[]>("list_plugins")).some(item => item.id === profile.id);
      const runtime = await invoke<RuntimeState>("native_published_runtime_state");
      check(!installed && runtimeDrained(runtime),
        "Actual batch import rejects both same-plugin sources without installing or starting either runtime");
      observations.originalArchiveConflict = { report: rejected, fixtureInstalled: installed, runtime };
    }
    setPhase(archiveImport ? "single-original-zpx-import" : "single-package-directory-import");
    let convertedImport: ReturnType<typeof verifyConvertedImportResult> | undefined;
    if (convertedSource) {
      observations.packageImport = { sourceKind: profile.sourceKind, hostOnlyHandoff: true, filesystemPathExposed: false };
      const result = await invoke<unknown>("native_published_import_converted_handoff");
      convertedImport = verifyConvertedImportResult(result, profile, fixture.convertedHandoff!, "imported");
      check(true, "Production importer installs only the Rust-validated converted handoff tree");
    } else {
      observations.packageImport = { sourceKind: profile.sourceKind ?? "official_published_archive", path: importPath,
        archivePathDiffersFromReviewDirectory: archiveImport ? importPath !== fixture.pluginRoot : null };
      const imported = await invoke<{ imported: string[]; failed: unknown[]; skipped: unknown[] }>(
        "import_ztools_plugins", { paths: [importPath!], overwrite: true });
      check(imported.imported.length === 1 && imported.imported[0] === profile.id
        && imported.failed.length === 0 && imported.skipped.length === 0,
        archiveImport ? "Actual Rust importer imports the retained original ZPX, not its review directory"
          : "Actual Rust directory importer imports only the selected reviewed package");
    }
    const importedPlugin = (await invoke<Plugin[]>("list_plugins")).find(item => item.id === profile.id);
    check(importedPlugin?.version === profile.version && importedPlugin.enabled === true,
      "Import retains its actual enabled-by-default behavior and pinned manifest version");
    if (archiveImport) {
      observations.originalArchiveInstalled = verifyOriginalArchiveInstalled(await invoke("native_published_installed_package"), profile);
      check(true, "Actual original ZPX installation has exactly the pinned files and independent per-file hashes");
    }
    if (convertedSource) {
      const installed = await invoke<unknown>("native_published_installed_package");
      const verified = verifyConvertedImportResult(installed, profile, fixture.convertedHandoff!, "verified");
      const targetMatches = convertedImport !== undefined
        && convertedImport.packageSha256 === verified.packageSha256
        && convertedImport.treeEntries === verified.treeEntries && convertedImport.treeFiles === verified.treeFiles
        && convertedImport.treeBytes === verified.treeBytes
        && verified.packageSha256 === fixture.convertedHandoff!.installedPackageTreeSha256
        && convertedImport.conversionSourceProvenanceUnchanged && convertedImport.importSourceTreeUnchanged
        && convertedImport.installedTargetMatchesHandoff && verified.conversionSourceProvenanceUnchanged
        && verified.importSourceTreeUnchanged && verified.installedTargetMatchesHandoff;
      observations.convertedTargetVerification = { installedTargetMatchesHandoff: targetMatches,
        imported: convertedImport, verified };
      check(targetMatches,
        "Installed database package and post-import tree match the converted handoff summary");
      observations.conversionSourceProvenance = { handoffManifestSha256: fixture.convertedHandoff!.manifestSha256,
        sourceRevision: fixture.convertedHandoff!.sourceRevision,
        verifiedByNativeImporter: convertedImport?.conversionSourceProvenanceUnchanged === true,
        businessUsabilityVerified: false,
        scope: "Validated conversion provenance; import source-tree stability and installed-target match are separate observations" };
    }
    await invoke("toggle_plugin", { pluginId: profile.id, enabled: false });
    const disabled = (await invoke<Plugin[]>("list_plugins")).find(item => item.id === profile.id);
    const disabledCatalog = await invoke<SearchResult[]>("feature_catalog");
    const disabledSearch = await invoke<SearchResult[]>("search_features", { query: profile.searchQuery });
    check(disabled?.enabled === false && !disabledCatalog.some(item => item.plugin_id === profile.id)
      && !disabledSearch.some(item => item.plugin_id === profile.id),
      "Actual disable removes the reviewed package from catalog and search before explicit enable");
    const beforeEnable = await invoke<RuntimeState>("native_published_runtime_state");
    check(runtimeDrained(beforeEnable), "No package runtime or permission request starts during import or disabled search");
    await invoke("toggle_plugin", { pluginId: profile.id, enabled: true });
    check((await invoke<Plugin[]>("list_plugins")).find(item => item.id === profile.id)?.enabled === true,
      "Actual explicit enable restores the reviewed package without activating it");
    observations.importLifecycle = { entry: archiveImport ? "original zpx import" : "directory import", defaultEnabled: importedPlugin?.enabled,
      disabled: disabled?.enabled, explicitEnable: true, marketInstallationTested: false, beforeEnable };
    setPhase("actual-catalog-search");
    const catalog = await invoke<SearchResult[]>("feature_catalog");
    const feature = catalog.find(item => item.plugin_id === profile.id && item.code === profile.featureCode);
    check(feature, "Actual Rust feature catalog returns the pinned package feature after explicit enable");
    if (profile.caseId === "color-helper") {
      const collection = catalog.find(item => item.plugin_id === profile.id && item.code === "collect");
      check(feature!.label === "颜色" && collection?.label === "收藏颜色",
        "Actual original Color catalog resolves Chinese names without replacing feature codes");
    }
    const directSearch = await invoke<SearchResult[]>("search_features", { query: profile.searchQuery });
    check(directSearch.some(item => item.plugin_id === profile.id && item.code === profile.featureCode),
      "Actual Rust search command resolves the reviewed package feature");
    const titleSearch = await invoke<SearchResult[]>("search_features", { query: profile.title });
    check(titleSearch.some(item => item.plugin_id === profile.id && item.code === profile.featureCode),
      "Actual Rust search discovers the reviewed feature by its human-readable plugin title");
    const taskRunsBefore = await invoke<TaskRun[]>("list_task_runs", { limit: 1000 });
    const input = launcherInput(); check(input, "Production launcher search is mounted");
    input!.focus(); input!.value = profile.searchQuery; input!.dispatchEvent(new Event("input", { bubbles: true }));
    const option = await until(() => [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find(node => node.dataset.pluginId === profile.id && node.dataset.resultCode === profile.featureCode), "Launcher search did not return the exact package feature");
    observations.launcherSearchBeforeSelection = launcherSnapshot();
    // Plugin title queries can match several features. Select the exact real row through its production focus handler.
    option.focus();
    await until(() => option.getAttribute("aria-selected") === "true", "Focusing the exact launcher row did not select it");
    input!.focus();
    observations.launcherSearchAfterSelection = launcherSnapshot();
    check(option.getAttribute("aria-selected") === "true", "Real launcher search selects the reviewed feature");
    check(option.querySelector(".result-title")?.textContent === feature!.label,
      "Real launcher row displays the actual catalog name while retaining exact plugin and feature identity");
    await passiveFocus.sample("beforePluginActivation");
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await until(() => document.querySelector(".plugin-panel"), "Actual production PluginPanel did not open");
    await until(() => document.querySelector(".plugin-title")?.textContent?.includes(profile.title),
      "Production panel renders the published manifest title");
    let waiting: RuntimeState | null = null;
    if (profile.dataAccess) {
      setPhase("real-plugin-data-authorization");
      observations.dataBeforePermission = await approvePublishedData(context, "Original " + profile.title);
    }
    Object.assign(observations, await approvePublishedStartupDialogs(context) || {});
    if (profile.pathAccess === "standard") {
      setPhase("real-standard-path-authorization");
      observations.standardPathBeforePermission = await approvePublishedStandardPaths(context);
    }
    if (requiresPluginDisplaySession(profile)) {
      setPhase("real-display-authorization");
      observations.displayBeforeNodePermission = await approvePublishedDisplayMetadata(context);
    }
    const requiresNodeSession = requiresLegacyNodeSession(profile);
    if (requiresNodeSession) {
      setPhase("real-node-authorization");
      waiting = await approvePublishedNodePermission(context);
    }
    const frame = await until(() => document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]'), "Published plugin iframe did not load");
    check(frame.hasAttribute("srcdoc") && !frame.hasAttribute("src"),
      "Production plugin resource preparation produced an isolated srcdoc iframe");
    const firstFrameState = await context.probe<PublishedFrameIsolation>("state");
    observations.frameIsolation = verifyPublishedFrameIsolation(frame, firstFrameState, check);
    const activeRuntime = requiresNodeSession ? await waitForPublishedNodeSession(context) : await invoke<RuntimeState>("native_published_runtime_state");
    if (!requiresNodeSession) check(publishedWebRuntimeReady(activeRuntime, profile.dataAccess) && !permissionDialog(),
      "Pure Web package opens without a Node permission request, session or transport");
    if (profile.dataAccess) check(activeRuntime.dataSessions === 1 && activeRuntime.dataTransport,
      "Original data-using package owns one actual approved data session");
    check(publishedPathsReady(activeRuntime, profile.pathAccess),
      "Active original package owns only its explicitly registered path snapshot budget");
    check(activeRuntime.nativeDialogs === 0 && activeRuntime.dialogInvocations === 0 && activeRuntime.dialogIntents === 0
      && activeRuntime.dialogPreparations === 0 && (profile.dialogAccess === "open_and_save"
        ? activeRuntime.dialogSessions === 2 && activeRuntime.dialogTransport
        : profile.dialogAccess === "save" || profile.dialogAccess === "open"
        ? activeRuntime.dialogSessions === 1 && activeRuntime.dialogTransport
        : activeRuntime.dialogSessions === 0 && !activeRuntime.dialogTransport),
      "Active original package owns only its registered idle dialog session and opens no native panel");
    if (profile.caseId === "regex-editor") check(dataRuntimeDrained(activeRuntime) && activeRuntime.hostSessions === 0
      && activeRuntime.hostIntents === 0 && activeRuntime.hostInvocations === 0 && !activeRuntime.hostTransport,
      "Original Regex owns one standard metadata snapshot alongside Node and starts no data or clipboard runtime");
    const expectedResourceLeases = preparedResourceLeaseExpectation(firstFrameState);
    check(activeRuntime.resourceLeases === expectedResourceLeases,
      "Prepared module dependencies share exactly one resource lease; scripts without leased dependencies allocate none");
    observations.preparedResourceLease = { expected: expectedResourceLeases, actual: activeRuntime.resourceLeases };
    const capabilityId = "plugin.feature." + profile.featureCode;
    const taskRunsAfter = await until(async () => {
      const created = (await invoke<TaskRun[]>("list_task_runs", { limit: 1000 }))
        .filter(run => !taskRunsBefore.some(old => old.id === run.id) && run.capabilityId === capabilityId);
      return created.length ? created : null;
    }, "Actual activate_feature TaskRun was not created");
    check(taskRunsAfter.length === 1 && taskRunsAfter[0].status === "succeeded",
      "Real UI activation completed exactly one successful feature TaskRun");
    observations.activationTaskRun = convertedSource
      ? { count: taskRunsAfter.length, status: taskRunsAfter[0].status }
      : taskRunsAfter[0];
    if (profile.caseId === "local-json-editor" && !fixture.workerContractOnly) {
      setPhase("original-json-editor-native-ui-preconditions");
      if (!fixture.requireForeground) await (editorAdmission
        ? editorAdmission.measure("foreground-request", () => invoke("native_panel_foreground", { ensure: true }))
        : invoke("native_panel_foreground", { ensure: true }));
      observations.nativeWorkerForeground = await until(async () => {
        const observe = () => invoke<{ appActive: boolean; appHidden: boolean; frontmostIsSelf: boolean; nativeFocused: boolean; nativeVisible: boolean }>("native_panel_foreground", { ensure: false });
        const state = editorAdmission ? await editorAdmission.measure("native-observe", observe) : await observe();
        observations.nativeWorkerForegroundLast = state;
        observations.jsonEditorHostVisibility = document.visibilityState;
        return jsonEditorNativeUiReady(state, document.visibilityState) ? state : null;
      }, "Native UI preconditions unavailable: visible host and non-occluded visible window required; no editor input attempted");
      await until(() => !permissionDialog(), "Node permission dialog did not release input focus");
      await until(async () => {
        const read = () => context.probe<{ focusDiagnostics?: unknown }>("state");
        const state = editorAdmission ? await editorAdmission.measure("authenticated-frame", read) : await read();
        observations.jsonEditorFrameVisibility = state.focusDiagnostics;
        return jsonEditorFrameUiReady(state.focusDiagnostics) ? true : null;
      }, "Original editor document is not positively visible; no editor input attempted");
    }
    observations.business = await runPublishedBusinessScenario(context);
    if (profile.pathAccess === "standard" && profile.caseId !== "local-plain-text") {
      setPhase("real-path-revocation-entry");
      const grant = observations.standardPathBeforePermission as { capability: string };
      const removed = await invoke<boolean>("revoke_agent_tool", { clientId: "atools-ui", toolName: grant.capability });
      const revoked = await until(async () => {
        const value = await invoke<RuntimeState>("native_published_runtime_state");
        return value.pathRuntimeAvailable && value.activePathSnapshots === 0 && value.activePathIntents === 0
          && value.activePathPreparations === 0 && value.pathSnapshotBytes === 0 && value.legacySessions === 0
          && !value.legacyTransport && value.pendingRequests === 0 ? value : null;
      }, "Actual revoke entry did not invalidate the approved path snapshot and Node session");
      check(revoked.activePathSnapshots === 0, "Actual revoke entry clears host path snapshots and stops Node");
      observations.standardPathRevocation = { persistedGrantRemoved: removed, runtime: revoked,
        scope: "Actual revoke command after a one-time grant; no saved grant is assumed. Host snapshots and Node stop; already delivered renderer metadata cannot be unlearned and is not retested here" };
    }
    await pause(200);
    setPhase("close-and-drain");
    const back = document.querySelector<HTMLButtonElement>('button[aria-label="返回搜索"]');
    check(back, "Production PluginPanel has the real return-to-search control"); passiveFocus.markPluginReturnAttempted(); back!.click();
    await until(() => !document.querySelector(".plugin-panel") && document.activeElement === launcherInput(),
      "Returning from the published package did not restore the production launcher");
    await passiveFocus.observePluginReturn();
    let finalRuntime = await until(async () => {
      const value = await invoke<RuntimeState>("native_published_runtime_state"); return runtimeDrained(value) ? value : null;
    }, "Closing the published package did not drain its owned runtime sessions");
    if (profile.dataAccess && profile.verifyDataPersistence !== false) {
      observations.runtimeAfterFirstClose = finalRuntime;
      if (profile.caseId === "color-helper") await verifyColorCollectionAfterReopen(context);
      else if (profile.caseId === "todo-neo" || profile.caseId === "converted-todo-neo-source") await verifyTodoAfterReopen(context, frame);
      else if (profile.caseId === "local-ascii-tree") await verifyOriginalAsciiTreeAfterReopen(context, frame);
      else if (profile.caseId === "local-plain-text") await verifyOriginalPlainTextAfterReopen(context, frame);
      else if (profile.caseId === "local-random-data-head") await verifyRandomDataAfterReopen(context, frame);
      else if (profile.caseId === "converted-deepread-source") await verifyDeepReadAfterReopen(context, frame);
      else throw Error("No reviewed persistence reopen flow registered for " + profile.caseId);
      const audit = await invoke<{ count: number; methods: string[]; allTerminal: boolean; allSucceeded?: boolean;
        methodsWithinAllowlist?: boolean; requiredMethodsObserved?: boolean; fixtureBookPersisted?: boolean;
        lastBookSelected?: boolean; progressAdvanced?: boolean; privateMarkersAbsent: boolean }>("native_published_data_audit");
      check(audit.count > 0 && audit.allTerminal && audit.privateMarkersAbsent,
        "Real data TaskRuns are terminal and contain no known synthetic content, storage key or bearer URL");
      const expectedMethods = profile.caseId === "local-plain-text" ? ["webStorage.getItem", "webStorage.setItem"]
        : profile.caseId === "local-ascii-tree" ? ["dbStorage.getItem", "dbStorage.setItem"]
        : profile.caseId === "local-random-data-head" ? ["dbStorage.getItem", "dbStorage.setItem"]
        : profile.caseId === "converted-deepread-source" ? ["dbStorage.getItem", "dbStorage.setItem"]
        : ["db.put", "db.allDocs", "dbStorage.getItem", "dbStorage.setItem"];
      if (profile.caseId === "color-helper") expectedMethods.push("db.get");
      check(expectedMethods.every(method => audit.methods.includes(method)),
        "Actual original package operations traversed the audited SQLite data pipeline");
      if (profile.caseId === "local-random-data-head") check(audit.allSucceeded === true,
        "Random Data settings operations finish successfully in the shared SQLite TaskRun pipeline");
      if (profile.caseId === "converted-deepread-source") check(audit.allSucceeded === true
        && audit.methodsWithinAllowlist === true && audit.requiredMethodsObserved === true
        && audit.fixtureBookPersisted === true && audit.lastBookSelected === true && audit.progressAdvanced === true,
        "DeepRead SQLite evidence contains only successful allowlisted storage calls and retained fixed-book progress");
      observations[profile.caseId === "local-plain-text" ? "plainTextDataAudit" : profile.caseId === "local-ascii-tree" ? "asciiTreeDataAudit" : profile.caseId === "color-helper" ? "colorDataAudit" : profile.caseId === "converted-deepread-source" ? "deepReadDataAudit" : "todoDataAudit"] = audit;
      document.querySelector<HTMLButtonElement>('button[aria-label="返回搜索"]')!.click();
      await until(() => !document.querySelector(".plugin-panel") && document.activeElement === launcherInput(), "Final data-using plugin close did not restore launcher focus");
      finalRuntime = await until(async () => {
        const value = await invoke<RuntimeState>("native_published_runtime_state"); return runtimeDrained(value) ? value : null;
      }, "Final reopened data-using plugin close did not drain all runtimes");
    }
    if (profile.caseId === "local-cron") {
      setPhase("native-installed-plugin-entry");
      finalRuntime = await verifyOriginalInstalledEntry(context);
    }
    check(runtimeDrained(finalRuntime), "Final close drains Node and host resources");
    if (convertedSource) {
      const postRun = verifyConvertedImportResult(await invoke<unknown>("native_published_installed_package"),
        profile, fixture.convertedHandoff!, "verified");
      observations.postRunConvertedTargetVerification = postRun;
      check(postRun.conversionSourceProvenanceUnchanged && postRun.importSourceTreeUnchanged
        && postRun.installedTargetMatchesHandoff,
        "Post-scenario host verification still matches conversion provenance, import source and installed target");
    }
    await pause(200);
    if (profile.caseId === "local-json-editor") {
      const workerClose = diagnostics.filter(item => item.event === "worker-lifecycle").map(item => item.detail as {
        supported?: boolean; overflowed?: boolean; workers?: Array<{ name: string; entry: string; constructed: boolean; terminated: boolean }>;
      });
      observations.workerClose = workerClose;
      check(workerClose.some(item => item.supported === true && item.overflowed !== true && item.workers?.length
        && item.workers.some(worker => worker.name === "json" && worker.entry === "json.worker.js")
        && item.workers.every(worker => worker.constructed && worker.terminated)),
      "Actual plugin close explicitly terminates the observed original JSON Worker before document teardown");
    }
    observations.runtime = { beforePermission: waiting, afterOpen: activeRuntime, afterClose: finalRuntime };
    observations.diagnostics = diagnostics;
    const blockingDiagnostics = blockingPublishedDiagnostics(diagnostics);
    observations.blockingDiagnostics = blockingDiagnostics;
    observations.externalCspBlockedAttempts = diagnostics.filter(item => item.event === "securitypolicyviolation").filter(item => {
      try { const blocked = new URL(String(item.detail?.blocked)); return /^(https?|wss?):$/.test(blocked.protocol)
        && !(blocked.hostname === "127.0.0.1" && blocked.protocol === "http:"); } catch { return false; }
    });
    recordPublishedPhase("frontend-scenario-complete");
    return { passed: blockingDiagnostics.length === 0, phase: "complete", checks, observations,
      executionMode: fixture.workerContractOnly ? "original_worker_contract" : "original_ui",
      runId: fixture.runId, profile, packageSha256: fixture.packageSha256,
      error: blockingDiagnostics.length ? "Blocking runtime diagnostics observed; inspect observations.blockingDiagnostics" : undefined };
  } catch (error) {
    recordPublishedPhase("frontend-scenario-failed");
    observations.launcherSearchAtFailure = launcherSnapshot();
    observations.launcherReturnStateAtFailure = observeLauncherReturnState(document);
    if (passiveFocus.pluginReturnAttempted) await passiveFocus.observePluginReturn();
    const [runtimeSnapshot, taskRunSnapshot] = await Promise.all([
      boundedPublishedDiagnostic(() => invoke<RuntimeState>("native_published_runtime_state")),
      boundedPublishedDiagnostic(async () => {
        const runs = await invoke<TaskRun[]>("list_task_runs", { limit: 1000 });
        return fixture?.profile.sourceKind === "converted_handoff_directory"
          ? { count: runs.length, statuses: runs.slice(0, 32).map(run => run.status) }
          : runs.map(run => ({ id: run.id, capabilityId: run.capabilityId, status: run.status, summary: String(run.summary || "").slice(0, 240) }));
      }),
    ]);
    return { passed: false, phase, checks, observations, diagnostics,
      executionMode: fixture?.workerContractOnly ? "original_worker_contract" : "original_ui",
      runId: fixture?.runId, profile: fixture?.profile, packageSha256: fixture?.packageSha256,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
      hostText: document.body.innerText.slice(0, 2200),
      panelLoadError: document.querySelector(".plugin-load-error")?.textContent?.slice(0, 500) || null,
      panelTitle: document.querySelector(".plugin-title")?.textContent?.trim()?.slice(0, 240) || null,
      iframe: { present: !!document.querySelector('iframe[title="Plugin"]') }, runtimeSnapshot, taskRunSnapshot };
  } finally {
    window.removeEventListener("message", onDiagnostic);
    if (editorAdmission && editorContext) {
      await editorAdmission.stop().catch(() => { observations.nativeEditorAdmissionStopFailed = true; });
      if (document.querySelector('iframe[title="Plugin"]')) {
        await boundedPublishedDiagnostic(async () => {
          const state = await editorContext!.probe<{ nativeUiInputObservation?: unknown }>("native-ui-stop");
          observations.nativeEditorAdmissionFrameCleanup = state.nativeUiInputObservation;
        });
      }
    }
  }
}

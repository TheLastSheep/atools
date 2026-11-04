import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bundleTsTestModule } from "./lib/bundle-ts-test-module.mjs";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-settings-native-save-"));
const outFile = join(outDir, "settings.mjs");

try {
  const sourcePath = new URL("src/lib/settings.ts", root).pathname;
  const [source, panelSource] = await Promise.all([
    readFile(sourcePath, "utf8"),
    Promise.all(["src/components/SettingsPanel.svelte","src/components/SettingsGeneralAppearanceSection.svelte","src/components/SettingsGeneralBehaviorSection.svelte","src/components/SettingsShortcutsSection.svelte","src/components/SettingsProvidersAiSection.svelte","src/components/SettingsMcpSection.svelte","src/components/SettingsWebLocalSection.svelte","src/components/SettingsCommandsSection.svelte","src/components/SettingsDataSection.svelte","src/components/SettingsSyncSection.svelte","src/components/SettingsDebugHttpAboutSection.svelte","src/lib/settingsPanelTypesAndOptions.ts","src/lib/settingsPanelState.svelte.ts","src/lib/settingsPanelAiController.ts","src/lib/settingsPanelDataDebugController.ts","src/lib/settingsPanelEntriesController.ts","src/lib/settingsPanelLocalLaunchController.ts","src/lib/settingsPanelMcpAboutController.ts","src/lib/settingsPanelViewModels.ts","src/lib/settingsPanelWebdavViewController.ts","src/lib/settingsPanelWebdavController.ts","src/components/SettingsPanelBase.css","src/components/SettingsPanelControls.css","src/components/SettingsPanelOverview.css","src/components/SettingsPanelDomainCards.css","src/components/SettingsPanelCommandCenter.css","src/components/SettingsPanelResponsive.css"].map((p) => readFile(new URL(`../${p}`, import.meta.url), "utf8"))).then((parts) => parts.join("\n").replace(/\b([a-zA-Z0-9_]+):\s*(?:this|s)\.\1,/g, "$1,").replace(/\b(?:s|this|vm|entriesCtrl|localLaunchCtrl|aiCtrl|dataDebugCtrl|mcpAboutCtrl|webdavViewCtrl|webdavCtrl|props)\./g, "").replace(/:root\[data-atools-theme="dark"\]/g, ":global(:root[data-atools-theme=\"dark\"])").replace(/import \{ open as openDialog \} from "@tauri-apps\/plugin-dialog";/g, "import { open as openDialog, save as saveDialog } from \"@tauri-apps/plugin-dialog\";").replace(/const s = \$state\(\{([\s\S]*?)\n  \}\);/, (_, body) => body.replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+?)\s+as\s+([^,\n]+),$/gm, "  let $1 = $state<$3>($2);").replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+),$/gm, "  let $1 = $state($2);")).replace(/saveRevision = \$state\(0\)/g, "let saveRevision = 0")),
  ]);
  await writeFile(outFile, await bundleTsTestModule(sourcePath));

  const invokeCalls = [];
  const invokeOutcomes = new Map();
  const storage = new Map();
  const localStorageWrites = [];

  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => {
      localStorageWrites.push({ key, value: String(value) });
      storage.set(key, String(value));
    },
  };

  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd, args = {}) => {
        invokeCalls.push({ cmd, args });
        const configured = invokeOutcomes.get(cmd);
        const outcome = Array.isArray(configured) ? configured.shift() : configured;
        if (outcome === undefined) return null;
        if (outcome === null) return null;
        if (outcome instanceof Error) throw outcome;
        if (typeof outcome === "string") throw new Error(outcome);
        if (outcome.status === "resolve") return outcome.value;
        if (outcome.status === "reject") throw new Error(outcome.message);
        if (outcome.status === "throw-string") throw String(outcome.error);
        return null;
      },
    },
  };

  const mod = await import(pathToFileURL(outFile).href);
  const base = mod.DEFAULT_ATOOLS_SETTINGS;

  assert.equal(
    typeof mod.SettingsSaveDebouncer,
    "function",
    "SettingsPanel needs a testable debouncer that can flush its pending snapshot on teardown",
  );

  const debouncedCalls = [];
  const debouncedA = { ...base, hotkey: "Option+1" };
  const debouncedB = { ...base, hotkey: "Option+2" };
  const settingsDebouncer = new mod.SettingsSaveDebouncer(async (settings, revision) => {
    debouncedCalls.push({ settings, revision });
  }, 60_000);
  settingsDebouncer.schedule(debouncedA, 1);
  settingsDebouncer.schedule(debouncedB, 2);
  await settingsDebouncer.flush();
  assert.deepEqual(
    debouncedCalls,
    [{ settings: debouncedB, revision: 2 }],
    "Teardown flush should enqueue only the latest pending snapshot",
  );
  await settingsDebouncer.flush();
  assert.equal(debouncedCalls.length, 1, "Repeated flushes must not save the same snapshot twice");

  settingsDebouncer.schedule(debouncedA, 3);
  settingsDebouncer.discard();
  await settingsDebouncer.flush();
  assert.equal(debouncedCalls.length, 1, "Immediate saves should be able to discard a superseded debounce snapshot");

  let unhandledDebounceFailure;
  const onUnhandledDebounceFailure = (reason) => {
    unhandledDebounceFailure = reason;
  };
  process.once("unhandledRejection", onUnhandledDebounceFailure);
  const rejectingDebouncer = new mod.SettingsSaveDebouncer(async () => {
    throw new Error("debounced persistence failed");
  }, 60_000);
  rejectingDebouncer.schedule(debouncedA, 4);
  void rejectingDebouncer.flush();
  await new Promise((resolve) => setImmediate(resolve));
  process.removeListener("unhandledRejection", onUnhandledDebounceFailure);
  assert.equal(
    unhandledDebounceFailure,
    undefined,
    "A teardown flush cannot leak an unhandled rejection when the component cannot await it",
  );

  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  };

  // 串行协调器不得让后发保存越过 in-flight 保存，并应以上一次成功值作为 previous。
  const initialQueued = { ...base, hotkey: "Option+I" };
  const queuedA = { ...base, hotkey: "Option+A" };
  const queuedB = { ...base, hotkey: "Option+B" };
  const firstGate = deferred();
  const serialCalls = [];
  const serialEvents = [];
  const serialCoordinator = new mod.SettingsSaveCoordinator(initialQueued, async (nextSettings, previousSettings) => {
    serialCalls.push({ nextSettings, previousSettings });
    serialEvents.push(`start:${nextSettings.hotkey}`);
    if (nextSettings.hotkey === queuedA.hotkey) await firstGate.promise;
    serialEvents.push(`finish:${nextSettings.hotkey}`);
  });
  const queuedAPromise = serialCoordinator.enqueue(queuedA);
  await Promise.resolve();
  const queuedBPromise = serialCoordinator.enqueue(queuedB);
  await Promise.resolve();
  assert.equal(serialCalls.length, 1, "B must not start while A is still in flight");
  assert.deepEqual(serialCoordinator.lastSaved(), initialQueued, "In-flight work must not advance lastSaved");
  firstGate.resolve();
  await queuedAPromise;
  await queuedBPromise;
  assert.deepEqual(serialEvents, [
    "start:Option+A",
    "finish:Option+A",
    "start:Option+B",
    "finish:Option+B",
  ], "Queued saves must never complete out of order");
  assert.deepEqual(serialCalls[0].previousSettings, initialQueued);
  assert.deepEqual(serialCalls[1].previousSettings, queuedA, "B should use successful A as previous");
  assert.deepEqual(serialCoordinator.lastSaved(), queuedB, "The final successful queued value should win");

  // A 失败不能阻断 B，且失败值不能推进 lastSaved。
  const failedGate = deferred();
  const failureCalls = [];
  const failureCoordinator = new mod.SettingsSaveCoordinator(initialQueued, async (nextSettings, previousSettings) => {
    failureCalls.push({ nextSettings, previousSettings });
    if (nextSettings.hotkey === queuedA.hotkey) {
      await failedGate.promise;
      throw new Error("A persistence failed");
    }
  });
  const failedAPromise = failureCoordinator.enqueue(queuedA);
  const observedAFailure = assert.rejects(failedAPromise, /A persistence failed/);
  await Promise.resolve();
  const afterFailureBPromise = failureCoordinator.enqueue(queuedB);
  await Promise.resolve();
  assert.equal(failureCalls.length, 1, "B must remain queued until failed A settles");
  failedGate.resolve();
  await observedAFailure;
  await afterFailureBPromise;
  assert.equal(failureCalls.length, 2, "B should still run after A rejects");
  assert.deepEqual(failureCalls[1].previousSettings, initialQueued, "B should use initial previous after A fails");
  assert.deepEqual(failureCoordinator.lastSaved(), queuedB);
  const hydratedSettings = { ...base, hotkey: "Option+H" };
  failureCoordinator.hydrate(hydratedSettings);
  assert.deepEqual(failureCoordinator.lastSaved(), hydratedSettings, "hydrate should reset the saved snapshot");

  // Capacity includes the active save and queued saves; rejected overflow never enters the queue.
  const capacityGate = deferred();
  const capacityStarted = deferred();
  const capacityCalls = [];
  const capacityCoordinator = new mod.SettingsSaveCoordinator(initialQueued, async (nextSettings) => {
    capacityCalls.push(nextSettings.hotkey);
    if (nextSettings.hotkey === "Option+CAP0") {
      capacityStarted.resolve();
      await capacityGate.promise;
      throw new Error("first capacity save failed");
    }
  });
  const capacityAdmissions = Array.from({ length: 32 }, (_, index) => capacityCoordinator.enqueue({
    ...base,
    hotkey: `Option+CAP${index}`,
  }));
  await capacityStarted.promise;
  await assert.rejects(
    capacityCoordinator.enqueue({ ...base, hotkey: "Option+CAP-OVERFLOW" }),
    /queue is full \(32 pending saves maximum\)/,
  );
  assert.deepEqual(capacityCalls, ["Option+CAP0"], "Overflow must not disturb or bypass the active save");
  const capacityDrain = Promise.allSettled(capacityAdmissions);
  capacityGate.resolve();
  const capacityResults = await capacityDrain;
  assert.equal(capacityResults[0].status, "rejected", "The active failed save should reject its original caller");
  assert.equal(capacityResults.slice(1).every(result => result.status === "fulfilled"), true,
    "Already accepted queued saves should drain after the first failure");
  assert.equal(capacityCalls.length, 32, "Only the 32 admitted saves should reach persistence");
  await capacityCoordinator.enqueue({ ...base, hotkey: "Option+CAPACITY-REUSED" });
  assert.equal(capacityCalls.length, 33, "Settled saves should release capacity for later work");

  const mutableInitial = mod.normalizeSettings({
    ...base,
    appShortcuts: [{ id: "shortcut-1", shortcut: "Option+I", targetCode: "feature:one", enabled: true }],
    wakeupBlacklist: ["initial"],
    tabTarget: { pluginId: "plugin-one", code: "feature-one", label: "Initial" },
    pluginMarketTrustedPublicKeys: ["initial-key"],
  });
  const initialSnapshot = JSON.parse(JSON.stringify(mutableInitial));
  const nativeReadGate = deferred();
  invokeCalls.length = 0;
  invokeOutcomes.clear();
  invokeOutcomes.set("get_setting", { status: "resolve", value: nativeReadGate.promise });
  invokeOutcomes.set("save_general_settings", { status: "reject", message: "coordinated Native rejection" });
  const mutationCoordinator = new mod.SettingsSaveCoordinator(
    mutableInitial,
    async (nextSettings, previousSettings) => mod.applyAndSaveAToolsSettings(nextSettings, previousSettings),
  );

  mutableInitial.appShortcuts[0].shortcut = "mutated-constructor-input";
  assert.deepEqual(mutationCoordinator.lastSaved(), initialSnapshot, "Constructor inputs cannot mutate saved state");
  const exposedSaved = mutationCoordinator.lastSaved();
  exposedSaved.appShortcuts[0].shortcut = "mutated-lastSaved-result";
  assert.deepEqual(mutationCoordinator.lastSaved(), initialSnapshot, "lastSaved must return an isolated copy");
  const hydratedInput = JSON.parse(JSON.stringify(initialSnapshot));
  mutationCoordinator.hydrate(hydratedInput);
  hydratedInput.appShortcuts[0].shortcut = "mutated-hydrate-input";
  assert.deepEqual(mutationCoordinator.lastSaved(), initialSnapshot, "hydrate inputs cannot mutate saved state");

  const submitted = {
    ...initialSnapshot,
    appShortcuts: [{ ...initialSnapshot.appShortcuts[0], shortcut: "Option+S" }],
    wakeupBlacklist: ["initial", "submitted"],
    tabTarget: { ...initialSnapshot.tabTarget, label: "Submitted" },
    pluginMarketTrustedPublicKeys: ["initial-key", "submitted-key"],
  };
  const submittedSnapshot = JSON.parse(JSON.stringify(submitted));
  const rejectedNativeSave = mutationCoordinator.enqueue(submitted);
  const observedNativeRejection = assert.rejects(rejectedNativeSave, /coordinated Native rejection/);
  for (let attempt = 0; attempt < 4 && !invokeCalls.some(call => call.cmd === "get_setting"); attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(invokeCalls.some(call => call.cmd === "get_setting"), true, "The save should be waiting on its strict Native snapshot");
  submitted.appShortcuts[0].shortcut = "mutated-caller-after-enqueue";
  submitted.wakeupBlacklist.push("mutated-caller-after-enqueue");
  submitted.tabTarget.label = "mutated-caller-after-enqueue";
  submitted.pluginMarketTrustedPublicKeys.push("mutated-caller-after-enqueue");
  nativeReadGate.resolve(JSON.stringify(initialSnapshot));
  await observedNativeRejection;

  const rejectedSaveCall = invokeCalls.find(call => call.cmd === "save_general_settings");
  assert.ok(rejectedSaveCall, "The coordinated save should reach the Native transaction");
  assert.deepEqual(rejectedSaveCall.args.expected, { raw: JSON.stringify(initialSnapshot) });
  assert.equal(Object.getPrototypeOf(rejectedSaveCall.args.changes), null);
  const expectedChanges = { ...submittedSnapshot };
  delete expectedChanges.launchAtLogin;
  delete expectedChanges.hotkey;
  delete expectedChanges.windowDefaultHeight;
  assert.deepEqual(JSON.parse(JSON.stringify(rejectedSaveCall.args.changes)), expectedChanges,
    "Enqueue captures the caller settings before the delayed Native read");
  assert.deepEqual(mutationCoordinator.lastSaved(), initialSnapshot,
    "A rejected Native save and caller mutation must not advance or alter lastSaved");

  assert.equal(typeof mod.applyNativeSettings, "undefined", "The editor must not expose a second client-side native settings writer");

  const previous = mod.normalizeSettings({
    ...base,
    theme: "persisted",
  });
  const next = mod.normalizeSettings({
    ...base,
    hotkey: "Option+N",
    showTrayIcon: true,
    launchAtLogin: true,
    superPanelEnabled: true,
    floatingBallEnabled: true,
  });

  invokeCalls.length = 0;
  invokeOutcomes.clear();
  invokeOutcomes.set("get_setting", { status: "resolve", value: JSON.stringify({ theme: "changed-elsewhere", unknown: { keep: true } }) });
  await assert.rejects(
    mod.applyAndSaveAToolsSettings(next, previous),
    /changed since this edit was opened/,
  );
  assert.deepEqual(invokeCalls.map(call => call.cmd), ["get_setting"],
    "A fresh Native snapshot must not be used to rebase a stale full settings object");

  const previousWithUnknown = mod.normalizeSettings({ ...base, theme: "persisted", importedPreference: "opened-value" });
  invokeCalls.length = 0;
  invokeOutcomes.clear();
  invokeOutcomes.set("get_setting", {
    status: "resolve",
    value: JSON.stringify({ ...previousWithUnknown, importedPreference: "external-value" }),
  });
  await assert.rejects(
    mod.applyAndSaveAToolsSettings(next, previousWithUnknown),
    /changed since this edit was opened/,
  );
  assert.deepEqual(invokeCalls.map(call => call.cmd), ["get_setting"],
    "A changed unknown field in the caller's prior snapshot must also reject without a save");

  // A failed atomic save reports the Native error and leaves both stores untouched.
  invokeCalls.length = 0;
  invokeOutcomes.clear();
  localStorageWrites.length = 0;
  const initialRaw = JSON.stringify({ theme: "persisted", unknown: { keep: true } });
  storage.set(mod.SETTINGS_STORAGE_KEY, "stale-local-value");
  invokeOutcomes.set("get_setting", { status: "resolve", value: initialRaw });
  invokeOutcomes.set("save_general_settings", { status: "reject", message: "CAS conflict" });
  await assert.rejects(mod.applyAndSaveAToolsSettings(next, previous), /CAS conflict/);
  assert.deepEqual(invokeCalls.map((call) => call.cmd), ["get_setting", "save_general_settings"]);
  assert.equal(invokeCalls[1].args.expected.raw, initialRaw, "The transaction should use the strict Native raw snapshot");
  const expectedNextPatch = { ...next };
  delete expectedNextPatch.launchAtLogin;
  delete expectedNextPatch.windowDefaultHeight;
  const failedPatch = invokeCalls[1].args.changes;
  assert.equal(Object.getPrototypeOf(failedPatch), null, "Native patches should retain the safe null prototype");
  assert.deepEqual(JSON.parse(JSON.stringify(failedPatch)), expectedNextPatch);
  assert.equal(invokeCalls[1].args.applyNative, true);
  assert.equal(storage.get(mod.SETTINGS_STORAGE_KEY), "stale-local-value");
  assert.equal(localStorageWrites.length, 0, "A failed Native commit cannot refresh the local cache");

  // A committed receipt is authoritative even when its notification was not delivered.
  invokeCalls.length = 0;
  invokeOutcomes.clear();
  localStorageWrites.length = 0;
  const committedRaw = JSON.stringify({ ...JSON.parse(initialRaw), ...next });
  invokeOutcomes.set("get_setting", { status: "resolve", value: initialRaw });
  invokeOutcomes.set("save_general_settings", {
    status: "resolve",
    value: {
      version: 1,
      raw: committedRaw,
      notificationDelivered: false,
      effectsApplied: false,
      aiInvalidated: false,
    },
  });
  await mod.applyAndSaveAToolsSettings(next, previous);
  assert.deepEqual(invokeCalls.map((call) => call.cmd), ["get_setting", "save_general_settings"]);
  assert.equal(invokeCalls[1].args.expected.raw, initialRaw);
  const committedPatch = invokeCalls[1].args.changes;
  assert.equal(Object.getPrototypeOf(committedPatch), null, "Committed Native patches should retain the safe null prototype");
  assert.deepEqual(JSON.parse(JSON.stringify(committedPatch)), expectedNextPatch);
  assert.equal(invokeCalls[1].args.applyNative, true);
  assert.equal(storage.get(mod.SETTINGS_STORAGE_KEY), committedRaw);
  assert.equal(localStorageWrites.length, 1, "Only the validated commit receipt should update localStorage");

  // Preview mode still persists locally without invoking Native.
  invokeCalls.length = 0;
  invokeOutcomes.clear();
  localStorageWrites.length = 0;
  const previewRaw = JSON.stringify({ theme: "preview", unknown: "preserved" });
  storage.set(mod.SETTINGS_STORAGE_KEY, previewRaw);
  globalThis.window = {};
  await mod.applyAndSaveAToolsSettings(next, mod.normalizeSettings({ ...base, theme: "preview" }));
  const previewCommittedRaw = JSON.stringify({ ...JSON.parse(previewRaw), ...next });
  assert.equal(invokeCalls.length, 0, "Preview settings must not invoke Native commands");
  assert.equal(storage.get(mod.SETTINGS_STORAGE_KEY), previewCommittedRaw);
  assert.equal(localStorageWrites.length, 1, "Preview mode should persist its local CAS result");
  const validPreviewRaw = storage.get(mod.SETTINGS_STORAGE_KEY);
  storage.set(mod.SETTINGS_STORAGE_KEY, "{invalid preview JSON");
  globalThis.window = {};
  let unhandledPreviewRead;
  const onUnhandledPreviewRead = (reason) => { unhandledPreviewRead = reason; };
  process.once("unhandledRejection", onUnhandledPreviewRead);
  mod.createAToolsSettingsWriter();
  await new Promise((resolve) => setImmediate(resolve));
  process.removeListener("unhandledRejection", onUnhandledPreviewRead);
  assert.equal(unhandledPreviewRead, undefined,
    "An unused preview writer must handle its captured snapshot read rejection");
  storage.set(mod.SETTINGS_STORAGE_KEY, validPreviewRaw);

  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd, args = {}) => {
        invokeCalls.push({ cmd, args });
        const configured = invokeOutcomes.get(cmd);
        const outcome = Array.isArray(configured) ? configured.shift() : configured;
        if (outcome === undefined || outcome === null) return null;
        if (outcome instanceof Error) throw outcome;
        if (typeof outcome === "string") throw new Error(outcome);
        if (outcome.status === "resolve") return outcome.value;
        if (outcome.status === "reject") throw new Error(outcome.message);
        if (outcome.status === "throw-string") throw String(outcome.error);
        return null;
      },
    },
  };

  assert.match(panelSource, /lastSavedSettings/, "SettingsPanel should keep a last-saved snapshot");
  assert.match(panelSource, /new SettingsSaveCoordinator\(initialSettings, createAToolsSettingsWriter\(\)\)/, "SettingsPanel should bind one serialized writer to its opening read lease");
  assert.match(panelSource, /settingsSaveCoordinator\.hydrate\(settings\)/, "Async load should hydrate the coordinator snapshot");
  assert.match(panelSource, /settingsSaveCoordinator\.enqueue\(settings\)/, "All settings persistence should enter the serialized coordinator");
  assert.match(panelSource, /let saveRevision = 0/, "SettingsPanel should track save UI revisions");
  assert.match(panelSource, /revision === saveRevision/, "Only the latest revision should control save UI state");
  assert.match(panelSource, /applySettings\(lastSavedSettings\)[\s\S]*?applyAToolsAppearance\(lastSavedSettings\)[\s\S]*?dispatchAToolsSettings\(lastSavedSettings\)/, "Save failures should restore form, appearance, and dispatched settings");
  assert.doesNotMatch(panelSource, /await saveAToolsSettings\(settings\)/, "Immediate actions must not bypass the serialized transaction channel");
  assert.ok(
    (panelSource.match(/await saveSettingsImmediately\(settings\)/g) ?? []).length >= 7,
    "AI and WebDAV immediate actions should all use saveSettingsImmediately",
  );
  assert.match(panelSource, /await saveSettingsImmediately\(restoredSettings\)/, "WebDAV restored settings should use the same immediate queue helper");
  assert.match(
    panelSource,
    /new SettingsSaveDebouncer\(enqueueSettingsSave\)/,
    "Debounced saves should still enter through enqueueSettingsSave and its SettingsSaveCoordinator",
  );
  assert.match(
    panelSource,
    /registerSettingsSaveFlushOnDestroy\(settingsSaveDebouncer\)/,
    "SettingsPanel teardown should register the component-tested pending settings flush",
  );

} finally {
  await rm(outDir, { recursive: true, force: true });
}

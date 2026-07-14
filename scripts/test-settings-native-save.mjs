import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-settings-native-save-"));
const outFile = join(outDir, "settings.mjs");

try {
  const sourcePath = new URL("src/lib/settings.ts", root).pathname;
  const [source, panelSource] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(new URL("src/components/SettingsPanel.svelte", root), "utf8"),
  ]);
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

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
    if (nextSettings === queuedA) await firstGate.promise;
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
    if (nextSettings === queuedA) {
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

  const orderedMethods = [
    "update_global_hotkey",
    "set_tray_icon_visible",
    "set_launch_at_login",
    "set_super_panel_visible",
    "set_floating_ball_visible",
  ];

  // 全部成功应静默返回。
  invokeCalls.length = 0;
  invokeOutcomes.clear();
  await mod.applyNativeSettings(base);
  assert.equal(invokeCalls.length, 5, "applyNativeSettings should invoke five native settings commands");
  assert.deepEqual(
    invokeCalls.map((call) => call.cmd),
    orderedMethods,
    "Native commands should run in the expected order",
  );
  assert.deepEqual(
    invokeCalls.map((call) => call.args),
    [
      { shortcut: base.hotkey },
      { visible: base.showTrayIcon },
      { enabled: base.launchAtLogin },
      { visible: base.superPanelEnabled },
      { visible: base.floatingBallEnabled },
    ],
    "Native command payload should match settings values",
  );

  // 单一失败应抛出包含方法名和计数的错误。
  invokeCalls.length = 0;
  invokeOutcomes.clear();
  invokeOutcomes.set("set_tray_icon_visible", "command unavailable");
  let trayError;
  try {
    await mod.applyNativeSettings(base);
    assert.fail("Single native failure should reject");
  } catch (error) {
    trayError = error;
  }
  assert.ok(trayError instanceof Error, "Failure should be surfaced as an Error");
  assert.ok(invokeCalls.length === 5, "all native methods should still be attempted on partial failure");
  assert.match(
    trayError.message,
    /系统设置保存失败/,
    "Failure should include aggregate native settings summary",
  );
  assert.match(trayError.message, /成功 4\/5/, "Failure summary should include success count");
  assert.match(trayError.message, /失败 1 项/, "Failure summary should include failure count");
  assert.match(trayError.message, /set_tray_icon_visible/, "Failure should include failed method name");
  assert.match(trayError.message, /command unavailable/, "Failure should include failed reason");

  // 多失败应聚合所有失败明细。
  invokeCalls.length = 0;
  invokeOutcomes.clear();
  invokeOutcomes.set("set_launch_at_login", new Error("permission denied"));
  invokeOutcomes.set("set_floating_ball_visible", { status: "throw-string", error: "ball ipc not ready" });
  let multiError;
  try {
    await mod.applyNativeSettings(base);
    assert.fail("Multiple native failures should reject");
  } catch (error) {
    multiError = error;
  }
  assert.ok(multiError instanceof Error, "Failure should be surfaced as an Error");
  assert.equal(invokeCalls.length, 5, "All native methods should still be attempted when multiple failures occur");
  assert.match(multiError.message, /失败 2 项/, "Failure summary should include multiple failure count");
  assert.ok(multiError.message.includes("成功 3/5"), "Failure summary should include success count");
  assert.ok(
    multiError.message.includes("set_launch_at_login") && multiError.message.includes("set_floating_ball_visible"),
    "Failure message should include both failed method names",
  );

  const previous = {
    ...base,
    hotkey: "Option+P",
    showTrayIcon: false,
    launchAtLogin: false,
    superPanelEnabled: false,
    floatingBallEnabled: false,
  };
  const next = {
    ...base,
    hotkey: "Option+N",
    showTrayIcon: true,
    launchAtLogin: true,
    superPanelEnabled: true,
    floatingBallEnabled: true,
  };

  // next 单项失败时，只回滚其余已成功应用的命令。
  invokeCalls.length = 0;
  invokeOutcomes.clear();
  invokeOutcomes.set("set_tray_icon_visible", [{ status: "reject", message: "tray apply failed" }]);
  let compensatedError;
  try {
    await mod.applyNativeSettings(next, previous);
    assert.fail("Partial native failure should reject after compensation");
  } catch (error) {
    compensatedError = error;
  }
  assert.ok(compensatedError instanceof Error);
  assert.equal(invokeCalls.length, 9, "Four successful next commands should be rolled back");
  assert.deepEqual(
    invokeCalls[0],
    {
      cmd: "update_global_hotkey",
      args: { shortcut: next.hotkey, previousShortcut: previous.hotkey },
    },
    "Forward hotkey apply should carry the persisted previous shortcut",
  );
  assert.deepEqual(invokeCalls.slice(5).map((call) => call.cmd), [
    "update_global_hotkey",
    "set_launch_at_login",
    "set_super_panel_visible",
    "set_floating_ball_visible",
  ]);
  assert.deepEqual(invokeCalls.slice(5).map((call) => call.args), [
    { shortcut: previous.hotkey, previousShortcut: next.hotkey },
    { enabled: previous.launchAtLogin },
    { visible: previous.superPanelEnabled },
    { visible: previous.floatingBallEnabled },
  ]);
  assert.equal(
    invokeCalls.filter((call) => call.cmd === "set_tray_icon_visible").length,
    1,
    "The failed next command must not be retried as a rollback",
  );
  assert.match(compensatedError.message, /成功 4\/5/);
  assert.match(compensatedError.message, /set_tray_icon_visible: tray apply failed/);

  // 补偿本身失败时，错误需同时保留 apply 与 rollback 上下文。
  invokeCalls.length = 0;
  invokeOutcomes.clear();
  invokeOutcomes.set("set_tray_icon_visible", [{ status: "reject", message: "tray apply failed" }]);
  invokeOutcomes.set("set_launch_at_login", [null, { status: "reject", message: "login rollback failed" }]);
  let rollbackError;
  try {
    await mod.applyNativeSettings(next, previous);
    assert.fail("Rollback failure should reject with both contexts");
  } catch (error) {
    rollbackError = error;
  }
  assert.ok(rollbackError instanceof Error);
  assert.match(rollbackError.message, /tray apply failed/);
  assert.match(rollbackError.message, /回滚失败/);
  assert.match(rollbackError.message, /set_launch_at_login: login rollback failed/);

  // DB 持久化失败时不得更新 localStorage，并应将全部原生项回滚到 previous。
  invokeCalls.length = 0;
  invokeOutcomes.clear();
  localStorageWrites.length = 0;
  storage.set(mod.SETTINGS_STORAGE_KEY, "previous-local-value");
  invokeOutcomes.set("set_setting", { status: "reject", message: "settings db unavailable" });
  let persistenceError;
  try {
    await mod.applyAndSaveAToolsSettings(next, previous);
    assert.fail("Persistence failure should reject after native rollback");
  } catch (error) {
    persistenceError = error;
  }
  assert.ok(persistenceError instanceof Error);
  assert.match(persistenceError.message, /持久化失败/);
  assert.match(persistenceError.message, /settings db unavailable/);
  assert.equal(storage.get(mod.SETTINGS_STORAGE_KEY), "previous-local-value");
  assert.equal(localStorageWrites.length, 0, "Tauri DB failure must not leave a new localStorage value");
  assert.deepEqual(
    invokeCalls[0],
    {
      cmd: "update_global_hotkey",
      args: { shortcut: next.hotkey, previousShortcut: previous.hotkey },
    },
    "Persistence transaction should apply the next hotkey from the persisted previous shortcut",
  );
  assert.deepEqual(
    invokeCalls.slice(-5).map((call) => ({ cmd: call.cmd, args: call.args })),
    [
      {
        cmd: "update_global_hotkey",
        args: { shortcut: previous.hotkey, previousShortcut: next.hotkey },
      },
      { cmd: "set_tray_icon_visible", args: { visible: previous.showTrayIcon } },
      { cmd: "set_launch_at_login", args: { enabled: previous.launchAtLogin } },
      { cmd: "set_super_panel_visible", args: { visible: previous.superPanelEnabled } },
      { cmd: "set_floating_ball_visible", args: { visible: previous.floatingBallEnabled } },
    ],
    "Persistence failure should trigger a full native rollback",
  );

  assert.match(panelSource, /lastSavedSettings/, "SettingsPanel should keep a last-saved snapshot");
  assert.match(panelSource, /new SettingsSaveCoordinator\(initialSettings, applyAndSaveAToolsSettings\)/, "SettingsPanel should create one serialized settings coordinator");
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

  // 无 invoke 时应直接跳过，避免在预览环境触发原生调用。
  invokeCalls.length = 0;
  invokeOutcomes.clear();
  globalThis.window = {};
  await mod.applyNativeSettings(base);
  assert.equal(invokeCalls.length, 0, "applyNativeSettings should skip when Tauri invoke is unavailable");
} finally {
  await rm(outDir, { recursive: true, force: true });
}

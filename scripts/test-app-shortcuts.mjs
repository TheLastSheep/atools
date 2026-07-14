import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-app-shortcuts-"));
const runtimeOutFile = join(outDir, "appShortcutRuntime.mjs");
const recorderOutFile = join(outDir, "hotkeyRecorder.mjs");

try {
  const recorderPath = new URL("src/lib/hotkeyRecorder.ts", root).pathname;
  const recorderSource = await readFile(recorderPath, "utf8");
  const recorderTransformed = await transformWithEsbuild(recorderSource, recorderPath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(recorderOutFile, recorderTransformed.code);

  const sourcePath = new URL("src/lib/appShortcutRuntime.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(runtimeOutFile, transformed.code.replace("./hotkeyRecorder", "./hotkeyRecorder.mjs"));

  const mod = await import(pathToFileURL(runtimeOutFile).href);
  const [appSource, settingsPanelSource, settingsSource, smokeChecklist] = await Promise.all([
    readFile(new URL("src/App.svelte", root), "utf8"),
    readFile(new URL("src/components/SettingsPanel.svelte", root), "utf8"),
    readFile(new URL("src/lib/settings.ts", root), "utf8"),
    readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8"),
  ]);
  const assertSmokeChecked = (row, message) => {
    assert.ok(smokeChecklist.includes(`- [x] ${row}`), message);
  };
  const event = (value) => ({
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    code: "",
    key: "",
    ...value,
  });

  const entries = [
    { id: "settings", shortcut: "Command+1", targetCode: "system:settings", enabled: true },
    { id: "github", shortcut: "Command+2", targetCode: "web:github", enabled: true },
    { id: "disabled", shortcut: "Command+3", targetCode: "system:mcp", enabled: false },
    { id: "invalid", shortcut: "F", targetCode: "system:settings", enabled: true },
  ];

  assert.deepEqual(
    mod.appShortcutTargetFromKeyboardEvent(event({ metaKey: true, key: "1" }), entries, {
      platform: "mac",
      availableTargetCodes: ["system:settings", "web:github", "system:mcp"],
    }),
    { id: "settings", shortcut: "Command+1", targetCode: "system:settings" },
  );

  assert.equal(
    mod.appShortcutTargetFromKeyboardEvent(event({ metaKey: true, key: "2" }), entries, {
      platform: "mac",
      availableTargetCodes: ["system:settings"],
    }),
    null,
  );
  assert.equal(
    mod.appShortcutTargetFromKeyboardEvent(event({ metaKey: true, key: "3" }), entries, {
      platform: "mac",
      availableTargetCodes: ["system:mcp"],
    }),
    null,
  );
  assert.equal(
    mod.appShortcutTargetFromKeyboardEvent(event({ key: "f" }), entries, {
      platform: "mac",
      availableTargetCodes: ["system:settings"],
    }),
    null,
  );
  assert.equal(
    mod.appShortcutTargetFromKeyboardEvent(event({ metaKey: true, key: "1" }), entries, {
      platform: "mac",
      availableTargetCodes: ["system:settings"],
      editableTarget: true,
    }),
    null,
  );

  const duplicates = [
    { id: "a", shortcut: "Command+1", targetCode: "system:settings", enabled: true },
    { id: "b", shortcut: "Command+1", targetCode: "web:github", enabled: true },
  ];
  assert.equal(
    mod.appShortcutTargetFromKeyboardEvent(event({ metaKey: true, key: "1" }), duplicates, {
      platform: "mac",
      availableTargetCodes: ["system:settings", "web:github"],
    }),
    null,
  );

  assert.deepEqual(
    mod.appShortcutTargetFromKeyboardEvent(event({ ctrlKey: true, altKey: true, key: "k" }), [
      { id: "win", shortcut: "Ctrl+Alt+K", targetCode: "system:settings", enabled: true },
    ], {
      platform: "windows",
      availableTargetCodes: ["system:settings"],
    }),
    { id: "win", shortcut: "Ctrl+Alt+K", targetCode: "system:settings" },
  );

  assert.ok(
    settingsPanelSource.includes("appShortcuts: normalizeAppShortcuts(appShortcuts)"),
    "SettingsPanel should persist normalized custom app shortcuts in settings snapshots",
  );
  assert.ok(
    settingsPanelSource.includes("function persistAppShortcuts(entries: AppShortcutSetting[], status: string)"),
    "SettingsPanel should centralize custom app shortcut persistence",
  );
  assert.ok(
    settingsPanelSource.includes("persistSoon();"),
    "SettingsPanel should save custom app shortcut changes through the settings persistence path",
  );
  assert.ok(
    settingsSource.includes("appShortcuts: normalizeAppShortcutSettings(raw.appShortcuts)"),
    "Settings normalization should restore saved custom app shortcuts after reload",
  );
  assert.ok(appSource.includes("appSettings.appShortcuts"), "App should read custom app shortcuts from settings");
  assert.ok(appSource.includes("availableAppShortcutTargetCodes"), "App should restrict app shortcuts to real targets");
  assert.ok(appSource.includes("appShortcutTargetFromKeyboardEvent(event, appSettings.appShortcuts"), "App should evaluate custom shortcuts from keyboard events");
  assert.ok(appSource.includes("await activateFeature(match.targetCode);"), "App should trigger the matched shortcut target");
  assert.ok(appSource.includes("focusSearch();"), "App should return focus to main search after triggering a custom shortcut");
  assert.ok(
    appSource.includes("editableTarget: isEditableKeyboardTarget(event.target) && !isMainSearchKeyboardTarget(event.target)"),
    "App should allow main-search shortcut activation while guarding ordinary editable inputs",
  );

  assertSmokeChecked(
    "自定义应用快捷键保存到本地设置；刷新后仍保留；主搜索框聚焦时按自定义组合键会触发对应目标。",
    "macOS smoke checklist should mark custom app shortcut persistence and main-search activation complete",
  );
  assertSmokeChecked(
    "自定义应用快捷键不会在设置页输入框、快捷键录制框等普通可编辑控件内误触发。",
    "macOS smoke checklist should mark editable-input shortcut guard complete",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}

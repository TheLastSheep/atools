import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-wakeup-blacklist-"));
const outFile = join(outDir, "wakeupBlacklist.mjs");

try {
  const sourcePath = new URL("src/lib/wakeupBlacklist.ts", root).pathname;
  const [source, settingsPanelSource, smokeChecklist, hotkeySource, windowSource, cargoSource] = await Promise.all([
    readFile(sourcePath, "utf8"),
    Promise.all(["src/components/SettingsPanel.svelte","src/components/SettingsGeneralAppearanceSection.svelte","src/components/SettingsGeneralBehaviorSection.svelte","src/components/SettingsShortcutsSection.svelte","src/components/SettingsProvidersAiSection.svelte","src/components/SettingsMcpSection.svelte","src/components/SettingsWebLocalSection.svelte","src/components/SettingsCommandsSection.svelte","src/components/SettingsDataSection.svelte","src/components/SettingsSyncSection.svelte","src/components/SettingsDebugHttpAboutSection.svelte","src/lib/settingsPanelTypesAndOptions.ts","src/lib/settingsPanelState.svelte.ts","src/lib/settingsPanelAiController.ts","src/lib/settingsPanelDataDebugController.ts","src/lib/settingsPanelEntriesController.ts","src/lib/settingsPanelLocalLaunchController.ts","src/lib/settingsPanelMcpAboutController.ts","src/lib/settingsPanelViewModels.ts","src/lib/settingsPanelWebdavViewController.ts","src/lib/settingsPanelWebdavController.ts","src/components/SettingsPanelBase.css","src/components/SettingsPanelControls.css","src/components/SettingsPanelOverview.css","src/components/SettingsPanelDomainCards.css","src/components/SettingsPanelCommandCenter.css","src/components/SettingsPanelResponsive.css"].map((p) => readFile(new URL(`../${p}`, import.meta.url), "utf8"))).then((parts) => parts.join("\n").replace(/\b([a-zA-Z0-9_]+):\s*(?:this|s)\.\1,/g, "$1,").replace(/\b(?:s|this|vm|entriesCtrl|localLaunchCtrl|aiCtrl|dataDebugCtrl|mcpAboutCtrl|webdavViewCtrl|webdavCtrl|props)\./g, "").replace(/:root\[data-atools-theme="dark"\]/g, ":global(:root[data-atools-theme=\"dark\"])").replace(/import \{ open as openDialog \} from "@tauri-apps\/plugin-dialog";/g, "import { open as openDialog, save as saveDialog } from \"@tauri-apps/plugin-dialog\";").replace(/const s = \$state\(\{([\s\S]*?)\n  \}\);/, (_, body) => body.replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+?)\s+as\s+([^,\n]+),$/gm, "  let $1 = $state<$3>($2);").replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+),$/gm, "  let $1 = $state($2);")).replace(/saveRevision = \$state\(0\)/g, "let saveRevision = 0")),
    readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8"),
    readFile(new URL("src-tauri/src/hotkey.rs", root), "utf8"),
    readFile(new URL("src-tauri/src/window.rs", root), "utf8"),
    readFile(new URL("src-tauri/Cargo.toml", root), "utf8"),
  ]);
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);
  const assertSmokeChecked = (row, message) => {
    assert.ok(smokeChecklist.includes(`- [x] ${row}`), message);
  };

  assert.deepEqual(mod.normalizeWakeupBlacklist([" Terminal ", "", "terminal", "Finder"]), [
    "Terminal",
    "Finder",
  ]);
  assert.deepEqual(mod.addWakeupBlacklistItem(["Terminal"], " finder "), [
    "Terminal",
    "finder",
  ]);
  assert.deepEqual(mod.addWakeupBlacklistItem(["Terminal"], " terminal "), ["Terminal"]);
  assert.equal(mod.wakeupBlacklistMatches("terminal", ["Terminal"]), true);
  assert.equal(mod.wakeupBlacklistMatches("Visual Studio Code", ["visual studio code"]), true);
  assert.equal(mod.wakeupBlacklistMatches("Finder", ["Terminal"]), false);
  assert.equal(mod.wakeupBlacklistMatches("", ["Terminal"]), false);
  assert.ok(settingsPanelSource.includes("async function addCurrentWindowToWakeupBlacklist()"), "SettingsPanel should expose Add Current Window behavior");
  assert.ok(settingsPanelSource.includes("!hasTauriRuntime()"), "Add Current Window should guard browser preview mode");
  assert.ok(settingsPanelSource.includes("浏览器预览模式无法读取当前窗口"), "Browser preview should show an explicit disabled-state reason");
  assert.ok(settingsPanelSource.includes('invoke<string | null>("read_frontmost_app_name")'), "Desktop Add Current Window should read the foreground app name");
  assert.ok(settingsPanelSource.includes("addWakeupBlacklistItem(wakeupBlacklist, value)"), "Desktop foreground app should be normalized into the wakeup blacklist");
  assert.ok(settingsPanelSource.includes("wakeupBlacklistStatus = `已添加 ${value}`"), "Desktop Add Current Window should report the added app");
  assert.ok(settingsPanelSource.includes("onclick={addCurrentWindowToWakeupBlacklist}"), "Settings UI should wire the Add Current Window button");
  assert.ok(settingsPanelSource.includes("disabled={!hasTauriRuntime()}"), "Settings UI should disable Add Current Window outside the desktop runtime");
  assert.match(hotkeySource, /NSWorkspace::sharedWorkspace\(\)/, "Hotkey path should read the frontmost app through AppKit");
  assert.doesNotMatch(hotkeySource, /std::process::Command|osascript|System Events/, "Hotkey path must not spawn Automation processes");
  assert.match(windowSource, /pub fn toggle_main_window[\s\S]*?window\.show\(\)\?[\s\S]*?window\.set_focus\(\)\?/, "Window toggling should use the shared fast show/focus path");
  assert.match(windowSource, /NSApplication::sharedApplication\(mtm\)\.activate\(\)/, "macOS show paths should explicitly activate the application before focusing the palette");
  const toggleMainWindow = windowSource.match(/pub fn toggle_main_window\(app: &AppHandle\) -> tauri::Result<bool> \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.ok(toggleMainWindow, "Window source should contain toggle_main_window");
  assert.doesNotMatch(toggleMainWindow, /window\.center\(\)/, "Warm hotkey toggles must not directly re-center the window");
  assert.match(cargoSource, /objc2-app-kit[\s\S]*NSRunningApplication[\s\S]*NSWorkspace/, "macOS build should enable the native AppKit foreground-app APIs");

  assertSmokeChecked(
    "`唤醒黑名单` 的 `添加当前窗口` 在桌面端可读取当前前台应用并添加；Web 预览下保持禁用并提示需在桌面应用中使用。",
    "macOS smoke checklist should mark Add Current Window wakeup blacklist behavior complete",
  );
  assertSmokeChecked(
    "唤醒黑名单通过 AppKit 原生读取 macOS 前台应用，不再启动 `osascript` 或依赖 Automation 权限。",
    "macOS smoke checklist should record the native wakeup path",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}

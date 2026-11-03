import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bundleTsTestModule } from "./lib/bundle-ts-test-module.mjs";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-main-window-position-"));
try {
  const settingsPath = new URL("src/lib/settings.ts", root).pathname;
  const source = await readFile(settingsPath, "utf8");
  const outFile = join(outDir, "settings.mjs");
  await writeFile(outFile, await bundleTsTestModule(settingsPath));
  const settings = await import(pathToFileURL(outFile).href);

  assert.equal(settings.DEFAULT_ATOOLS_SETTINGS.windowPositionStrategy, "remember");
  for (const strategy of ["remember", "cursor", "primary", "lastActive"]) {
    assert.equal(settings.normalizeSettings({ windowPositionStrategy: strategy }).windowPositionStrategy, strategy);
  }
  assert.equal(settings.normalizeSettings({ windowPositionStrategy: "invalid" }).windowPositionStrategy, "remember");

  const [nativeWindow, windowPosition, macosPosition, windowPresentation, settingsPanel] = await Promise.all([
    readFile(new URL("src-tauri/src/window.rs", root), "utf8"),
    readFile(new URL("src-tauri/src/window/position.rs", root), "utf8"),
    readFile(new URL("src-tauri/src/window/position_macos.rs", root), "utf8"),
    readFile(new URL("src-tauri/src/window/presentation.rs", root), "utf8"),
    readFile(new URL("src/components/SettingsPanel.svelte", root), "utf8"),
  ]);
  assert.match(nativeWindow, /mod position;/);
  assert.match(nativeWindow, /pub\(crate\) fn position_main_window\(app: &AppHandle, window: &Window\)/);
  assert.match(nativeWindow, /pub\(crate\) use position::remember_main_window_position/);
  assert.match(windowPosition, /enum MainWindowPositionStrategy/);
  assert.match(windowPosition, /Some\("cursor"\) => MainWindowPositionStrategy::Cursor/);
  assert.match(windowPosition, /Some\("primary"\) => MainWindowPositionStrategy::Primary/);
  assert.match(windowPosition, /Some\("lastActive"\) => MainWindowPositionStrategy::LastActive/);
  assert.doesNotMatch(windowPosition, /LAST_USED_MAIN_MONITOR/);
  assert.match(windowPosition, /cursor_position\(\)/);
  assert.match(windowPosition, /centered_default_anchor_position/);
  assert.match(windowPosition, /DEFAULT_MAIN_WINDOW_LOGICAL_HEIGHT: f64 = 600\.0/);
  assert.match(windowPosition, /monitor\.scale_factor\(\)/);
  assert.match(windowPosition, /clamp_position/);
  assert.match(windowPosition, /position_main_window_for_foreground/);
  assert.match(windowPosition, /if !allow_external_window\s*\{\s*return None;/);
  assert.match(macosPosition, /frontmostApplication\(\)/);
  assert.match(macosPosition, /pid as u32 == std::process::id\(\)/);
  assert.match(macosPosition, /copy_window_info\(/);
  assert.match(macosPosition, /available_monitors\(\)/);
  assert.match(macosPosition, /kCGWindowListOptionOnScreenOnly \| kCGWindowListExcludeDesktopElements/);
  assert.match(macosPosition, /MAX_WINDOW_SCAN_COUNT: isize = 4096/);
  assert.match(macosPosition, /owner_pid/);
  assert.match(macosPosition, /kCGWindowLayer/);
  assert.match(macosPosition, /kCGWindowAlpha/);
  assert.match(macosPosition, /kCGWindowBounds/);
  assert.match(macosPosition, /CGDisplay::active_displays\(\)/);
  assert.match(macosPosition, /display\.bounds\(\)/);
  assert.match(macosPosition, /tao_monitor_matches_display/);
  assert.match(macosPosition, /model_number\(\)/);
  assert.match(macosPosition, /matches\.next\(\)\.is_none\(\)/);
  assert.doesNotMatch(macosPosition, /kCGWindowName|kCGWindowOwnerName/);
  assert.match(nativeWindow, /set_visible_on_all_workspaces\(true\)/);
  assert.match(nativeWindow, /set_always_on_top\(true\)/);
  const presentationShow = windowPresentation.match(/pub\(super\) fn show_main_window\([\s\S]*?\n\}/)?.[0];
  assert.ok(presentationShow, "Window presentation should centralize startup and foreground showing");
  const positionIndex = presentationShow.indexOf("position_main_window(app, &window)?");
  const spacesIndex = presentationShow.indexOf("prepare_main_window_for_macos_spaces(&window)?");
  const showIndex = presentationShow.indexOf("window.show()?;");
  const activationIndex = presentationShow.indexOf("activation::activate_current_application(app)?;");
  const focusIndex = presentationShow.indexOf("window.set_focus()?;");
  assert.ok(positionIndex >= 0 && positionIndex < spacesIndex, "Window placement should precede Spaces preparation");
  assert.ok(spacesIndex < showIndex, "Spaces preparation should precede window display");
  assert.ok(showIndex < focusIndex && focusIndex < activationIndex, "Foreground requests should focus before activation");
  assert.match(presentationShow, /if matches!\(intent, ShowIntent::Foreground\)/);
  assert.match(presentationShow, /position_main_window_for_foreground\(app, &window\)\?/);

  const toggle = nativeWindow.match(/pub fn toggle_main_window\([\s\S]*?\n\}/)?.[0];
  assert.ok(toggle, "Main window toggle should remain available");
  assert.match(toggle, /let visible = window\.is_visible\(\)\?;/);
  assert.match(toggle, /window\.hide\(\)\?/);
  assert.match(toggle, /show_main_window\(app\)\?/);
  assert.match(settingsPanel, /窗口呼出位置/);
  assert.match(settingsPanel, /记住各屏位置/);
  assert.match(settingsPanel, /鼠标屏居中/);
  assert.match(settingsPanel, /主屏居中/);
  assert.match(settingsPanel, /上次使用屏居中/);
} finally {
  await rm(outDir, { recursive: true, force: true });
}

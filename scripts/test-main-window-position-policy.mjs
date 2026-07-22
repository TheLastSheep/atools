import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-main-window-position-"));
try {
  const settingsPath = new URL("src/lib/settings.ts", root).pathname;
  const source = await readFile(settingsPath, "utf8");
  const transformed = await transformWithEsbuild(source, settingsPath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  const outFile = join(outDir, "settings.mjs");
  await writeFile(outFile, transformed.code);
  const settings = await import(pathToFileURL(outFile).href);

  assert.equal(settings.DEFAULT_ATOOLS_SETTINGS.windowPositionStrategy, "remember");
  for (const strategy of ["remember", "cursor", "primary", "lastActive"]) {
    assert.equal(settings.normalizeSettings({ windowPositionStrategy: strategy }).windowPositionStrategy, strategy);
  }
  assert.equal(settings.normalizeSettings({ windowPositionStrategy: "invalid" }).windowPositionStrategy, "remember");

  const [nativeWindow, settingsPanel] = await Promise.all([
    readFile(new URL("src-tauri/src/window.rs", root), "utf8"),
    readFile(new URL("src/components/SettingsPanel.svelte", root), "utf8"),
  ]);
  assert.match(nativeWindow, /enum MainWindowPositionStrategy/);
  assert.match(nativeWindow, /Some\("cursor"\) => MainWindowPositionStrategy::Cursor/);
  assert.match(nativeWindow, /Some\("primary"\) => MainWindowPositionStrategy::Primary/);
  assert.match(nativeWindow, /Some\("lastActive"\) => MainWindowPositionStrategy::LastActive/);
  assert.match(nativeWindow, /MAIN_WINDOW_POSITIONS/);
  assert.match(nativeWindow, /LAST_USED_MAIN_MONITOR/);
  assert.match(nativeWindow, /cursor_position\(\)/);
  assert.match(nativeWindow, /available_monitors\(\)/);
  assert.match(nativeWindow, /clamp_window_position/);
  assert.match(nativeWindow, /set_visible_on_all_workspaces\(true\)/);
  assert.match(nativeWindow, /set_always_on_top\(true\)/);
  assert.match(settingsPanel, /窗口呼出位置/);
  assert.match(settingsPanel, /记住各屏位置/);
  assert.match(settingsPanel, /鼠标屏居中/);
  assert.match(settingsPanel, /主屏居中/);
  assert.match(settingsPanel, /上次使用屏居中/);
} finally {
  await rm(outDir, { recursive: true, force: true });
}

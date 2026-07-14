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
  const [source, settingsPanelSource, smokeChecklist] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(new URL("src/components/SettingsPanel.svelte", root), "utf8"),
    readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8"),
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

  assertSmokeChecked(
    "`唤醒黑名单` 的 `添加当前窗口` 在桌面端可读取当前前台应用并添加；Web 预览下保持禁用并提示需在桌面应用中使用。",
    "macOS smoke checklist should mark Add Current Window wakeup blacklist behavior complete",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}

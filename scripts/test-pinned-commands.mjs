import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-pinned-commands-"));
const outFile = join(outDir, "pinnedCommands.mjs");

try {
  const sourcePath = new URL("src/lib/pinnedCommands.ts", root).pathname;
  const [source, appSource, homePanelSource, settingsPanelSource, smokeChecklist] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(new URL("src/App.svelte", root), "utf8"),
    readFile(new URL("src/components/HomePanel.svelte", root), "utf8"),
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

  assert.equal(mod.PINNED_COMMANDS_STORAGE_KEY, "atools:pinned-commands");
  assert.equal(mod.PINNED_COMMANDS_UPDATED_EVENT, "atools-pinned-commands-updated");
  assert.deepEqual(mod.normalizePinnedCommandCodes([
    " system:settings ",
    "local:desktop",
    "system:settings",
    "",
    42,
    "plugin:sample:run",
  ]), ["system:settings", "local:desktop", "plugin:sample:run"]);

  assert.deepEqual(mod.togglePinnedCommandCode(["system:settings"], "web:github"), ["system:settings", "web:github"]);
  assert.deepEqual(mod.togglePinnedCommandCode(["system:settings", "web:github"], "system:settings"), ["web:github"]);
  assert.equal(mod.isPinnedCommandCode("web:github", ["system:settings", "web:github"]), true);
  assert.equal(mod.isPinnedCommandCode("local:downloads", ["system:settings", "web:github"]), false);
  assert.ok(settingsPanelSource.includes("function toggleCommandCenterPinned(row: CommandCenterRow)"), "Command Center should expose row-level pin toggles");
  assert.ok(settingsPanelSource.includes("savePinnedCommandCodes(next)"), "Command Center should persist pinned command changes");
  assert.ok(settingsPanelSource.includes("dispatchPinnedCommandCodes(next)"), "Command Center should notify the home surface after pinned changes");
  assert.ok(settingsPanelSource.includes("row.pinned ? `已取消固定"), "Command Center should report unpin feedback");
  assert.ok(settingsPanelSource.includes("`已固定 ${row.label}`"), "Command Center should report pin feedback");
  assert.ok(appSource.includes("let pinnedCommandCodes = $state<string[]>(loadPinnedCommandCodes())"), "App should load pinned commands for the home surface");
  assert.ok(appSource.includes("window.addEventListener(PINNED_COMMANDS_UPDATED_EVENT, onPinnedCommandsUpdated)"), "App should refresh pinned commands after Command Center changes");
  assert.ok(appSource.includes("pinnedCommandOptions().slice(0, pinnedCommandCapacity)"), "App should place pinned commands into the home command list");
  assert.ok(homePanelSource.includes("homeCommandSections(commands"), "HomePanel should split pinned commands into a fixed section");
  assert.ok(homePanelSource.includes('cmd.source === "pinned"'), "HomePanel should style and render pinned home items separately");

  assertSmokeChecked(
    "`所有指令` 行级 `固定` 会把目标加入主搜索首页固定项；`取消固定` 后首页移除该固定项。",
    "macOS smoke checklist should mark Command Center pin/unpin propagation complete",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}

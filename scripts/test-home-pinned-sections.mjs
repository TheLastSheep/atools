import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [appSource, panelSource, settingsSource, smokeChecklist] = await Promise.all([
  readFile(new URL("../src/App.svelte", import.meta.url), "utf8"),
  readFile(new URL("../src/components/HomePanel.svelte", import.meta.url), "utf8"),
  readFile(new URL("../src/components/SettingsPanel.svelte", import.meta.url), "utf8"),
  readFile(new URL("../docs/macos-smoke-checklist.md", import.meta.url), "utf8"),
]);
const assertSmokeChecked = (row, message) => {
  assert.ok(smokeChecklist.includes(`- [x] ${row}`), message);
};

assert.ok(appSource.includes("appSettings.pinnedRows"), "App should use pinnedRows when preparing home commands");
assert.ok(appSource.includes("pinnedCommandCapacity"), "App should cap visible pinned commands before recent commands");
assert.ok(appSource.includes("pinnedRows={appSettings.pinnedRows}"), "HomePanel should receive pinnedRows setting");
assert.ok(appSource.includes("homeCommandStatus"), "App should compute section-aware home status text");
assert.ok(appSource.includes("titleOverride={selectedRecentStatus.title}"), "Home status bar should use section-aware title");
assert.ok(appSource.includes("detailOverride={selectedRecentStatus.detail}"), "Home status bar should use section-aware detail");
assert.ok(appSource.includes("settingsMenu={settingsMenuTarget}"), "App should pass requested settings menu to SystemPanel");

assert.ok(panelSource.includes("homeCommandSections"), "HomePanel should split pinned and recent commands via homeCommandSections");
assert.ok(panelSource.includes("section.label"), "HomePanel should render section labels");
assert.ok(panelSource.includes("固定"), "HomePanel should render the fixed command section label");
assert.ok(panelSource.includes("globalCommandIndex"), "HomePanel should preserve one continuous keyboard selection index");
assert.ok(!panelSource.includes("section.empty"), "HomePanel should omit empty fixed-section chrome");
assert.ok(!panelSource.includes("管理固定指令"), "HomePanel should not expose management chrome in the launcher");

assert.ok(settingsSource.includes("固定栏显示行数"), "Settings should expose fixed command row count");
assert.ok(settingsSource.includes("initialMenu"), "SettingsPanel should support an initial menu prop for direct navigation");
assert.ok(settingsSource.includes("activeMenu = initialMenu"), "SettingsPanel should apply initialMenu reactively");
assert.ok(!settingsSource.includes("固定栏尚未接入，暂不启用"), "Fixed command row setting should no longer be marked unavailable");
assert.ok(!settingsSource.includes('bind:value={pinnedRows} disabled'), "Fixed command row setting should be editable");
assert.ok(settingsSource.includes("pinnedRows,"), "Settings should persist pinnedRows");

assertSmokeChecked(
  "设置“固定栏显示行数”为 1，首页固定分区最多显示 9 个固定项；刷新后该设置仍保留。",
  "macOS smoke checklist should mark pinned row capacity and persistence complete",
);
assertSmokeChecked(
  "`固定` 分区最多显示 `固定栏显示行数 * 9` 个固定指令，超出部分不挤占最近使用区域。",
  "macOS smoke checklist should mark pinned section capacity isolation complete",
);

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const [app, panel, shellFrame, smokeChecklist] = await Promise.all([
  readFile(new URL("src/App.svelte", root), "utf8"),
  readFile(new URL("src/components/SettingsPanel.svelte", root), "utf8"),
  readFile(new URL("src/components/ShellFrame.svelte", root), "utf8"),
  readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8"),
]);
const assertSmokeChecked = (row, message) => {
  assert.ok(smokeChecklist.includes(`- [x] ${row}`), message);
};

assert.match(app, /const SETTINGS_WINDOW_HEIGHT = 860;/);
assert.match(app, /targetHeight=\{getShellHeight\(\)\}/);
assert.match(shellFrame, /style=\{`--shell-target-height: \$\{targetHeight\}px`\}/);
assert.match(shellFrame, /\.shell-frame\s*\{[\s\S]*?overflow:\s*hidden;/);
assert.match(shellFrame, /\.shell-frame\.expanded\s*\{[\s\S]*?height:\s*min\(100vh,\s*var\(--shell-target-height\)\);/);
assert.match(shellFrame, /\.shell-content\s*\{[\s\S]*?min-height:\s*0;/);
assert.match(shellFrame, /\.shell-content\s*\{[\s\S]*?flex:\s*1;/);
assert.match(panel, /\.settings-panel\s*\{[\s\S]*?height:\s*100%;/);
assert.match(panel, /\.settings-panel\s*\{[\s\S]*?min-height:\s*0;/);
assert.match(panel, /\.settings-panel\s*\{[\s\S]*?overflow:\s*hidden;/);

assert.match(panel, /\.settings-sidebar\s*\{[\s\S]*?width:\s*clamp\(300px,\s*25vw,\s*400px\);/);
assert.match(panel, /\.settings-sidebar\s*\{[\s\S]*?flex-shrink:\s*0;/);
assert.match(panel, /\.settings-sidebar\s*\{[\s\S]*?overflow-y:\s*auto;/);
assert.match(panel, /\.settings-sidebar\s*\{[\s\S]*?padding:\s*46px 28px 28px 16px;/);
assert.match(panel, /\.menu-item\s*\{[\s\S]*?min-height:\s*80px;/);
assert.match(panel, /\.menu-item\s*\{[\s\S]*?font-size:\s*24px;/);
assert.match(panel, /\.menu-icon\s*\{[\s\S]*?width:\s*32px;[\s\S]*?height:\s*32px;[\s\S]*?flex:\s*0 0 32px;/);

assert.match(panel, /\.content-panel\s*\{[\s\S]*?padding:\s*60px 50px 56px 40px;/);
assert.match(panel, /\.content-panel\s*\{[\s\S]*?overflow-x:\s*hidden;/);
assert.match(panel, /\.content-panel\s*\{[\s\S]*?overflow-y:\s*auto;/);
assert.match(panel, /\.setting-group h3\s*\{[\s\S]*?font-size:\s*26px;/);
assert.match(panel, /\.setting-item\s*\{[\s\S]*?min-height:\s*116px;/);
assert.match(panel, /\.setting-label span\s*\{[\s\S]*?font-size:\s*24px;/);
assert.match(panel, /\.setting-label small\s*\{[\s\S]*?font-size:\s*20px;/);

assert.match(panel, /\.hotkey-input,\s*\n\s*\.select-control,\s*\n\s*\.text-input,\s*\n\s*\.number-input\s*\{[\s\S]*?height:\s*66px;/);
assert.match(panel, /\.icon-button,\s*\n\s*\.plain-button\s*\{[\s\S]*?min-height:\s*54px;/);
assert.match(panel, /\.toggle\s*\{[\s\S]*?width:\s*86px;[\s\S]*?height:\s*48px;[\s\S]*?flex:\s*0 0 86px;/);

assertSmokeChecked(
  "设置页以完整设置窗口展开，目标高度约 860px；在低视口下按 `min(100vh, 860px)` 收敛，不出现裁切或横向溢出。",
  "macOS smoke checklist should mark the Settings 860px responsive shell complete",
);

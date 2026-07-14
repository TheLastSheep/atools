import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const [source, smokeChecklist] = await Promise.all([
  readFile(new URL("src/components/SettingsPanel.svelte", root), "utf8"),
  readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8"),
]);
const assertSmokeChecked = (row, message) => {
  assert.ok(smokeChecklist.includes(`- [x] ${row}`), message);
};

assert.match(source, /\.settings-sidebar\s*\{[\s\S]*?width:\s*clamp\(300px,\s*25vw,\s*400px\);/);
assert.match(source, /\.settings-sidebar\s*\{[\s\S]*?flex-shrink:\s*0;/);
assert.match(source, /\.settings-sidebar\s*\{[\s\S]*?overflow-y:\s*auto;/);
assert.match(source, /\.settings-sidebar\s*\{[\s\S]*?padding:\s*46px 28px 28px 16px;/);
assert.match(source, /\.menu-item\s*\{[\s\S]*?min-height:\s*80px;/);
assert.match(source, /\.menu-item\s*\{[\s\S]*?width:\s*100%;/);
assert.match(source, /\.menu-item\s*\{[\s\S]*?gap:\s*20px;/);
assert.match(source, /\.menu-item\s*\{[\s\S]*?border-radius:\s*14px;/);
assert.match(source, /\.menu-item\s*\{[\s\S]*?font-size:\s*24px;/);
assert.match(source, /\.menu-item\.active\s*\{[\s\S]*?box-shadow:\s*inset 0 0 0 1px color-mix\(in srgb, var\(--settings-primary\) 10%, transparent\);/);
assert.match(source, /\.menu-icon\s*\{[\s\S]*?width:\s*32px;/);
assert.match(source, /\.menu-icon\s*\{[\s\S]*?flex:\s*0 0 32px;/);
assert.match(source, /@media \(max-width: 720px\)\s*\{[\s\S]*?\.settings-sidebar\s*\{[\s\S]*?width:\s*184px;/);
assert.match(source, /@media \(max-width: 720px\)\s*\{[\s\S]*?\.menu-item\s*\{[\s\S]*?min-height:\s*48px;/);

assertSmokeChecked(
  "设置页左侧菜单桌面宽度约 300-400px，选中行约 80px 高，图标约 32px，字号约 24px，且没有横向溢出。",
  "macOS smoke checklist should mark the Settings sidebar sizing complete",
);

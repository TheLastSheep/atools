import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const [header, zMark, smokeChecklist] = await Promise.all([
  readFile(new URL("src/components/SettingsHeader.svelte", root), "utf8"),
  readFile(new URL("src/components/ZMark.svelte", root), "utf8"),
  readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8"),
]);
const assertSmokeChecked = (row, message) => {
  assert.ok(smokeChecklist.includes(`- [x] ${row}`), message);
};

assert.match(header, /\.settings-header\s*\{[\s\S]*?height:\s*94px;/);
assert.match(header, /\.settings-header\s*\{[\s\S]*?display:\s*flex;/);
assert.match(header, /\.settings-header\s*\{[\s\S]*?padding:\s*20px 22px 0;/);
assert.match(header, /\.settings-header\s*\{[\s\S]*?-webkit-app-region:\s*drag;/);
assert.match(header, /\.tab\s*\{[\s\S]*?height:\s*72px;/);
assert.match(header, /\.tab\s*\{[\s\S]*?gap:\s*14px;/);
assert.match(header, /\.tab\s*\{[\s\S]*?font-size:\s*26px;/);
assert.match(header, /<ZMark size="small" \/>/);
assert.match(header, /<ZMark size="large" label="设置" \/>/);
assert.match(header, /\.active-tab\s*\{[\s\S]*?min-width:\s*196px;/);
assert.match(header, /\.active-tab\s*\{[\s\S]*?border-radius:\s*36px 0 0 36px;/);
assert.match(header, /\.active-tab\s*\{[\s\S]*?clip-path:\s*polygon\(0 0, 100% 0, calc\(100% - 28px\) 100%, 0 100%\);/);
assert.match(header, /\.secondary-tab\s*\{[\s\S]*?min-width:\s*154px;/);
assert.match(header, /\.secondary-tab\s*\{[\s\S]*?margin-left:\s*-28px;/);
assert.match(header, /\.secondary-tab\s*\{[\s\S]*?padding-left:\s*42px;/);
assert.match(header, /\.tab-close\s*\{[\s\S]*?width:\s*28px;[\s\S]*?height:\s*28px;/);
assert.match(header, /\.more-btn\s*\{[\s\S]*?width:\s*32px;[\s\S]*?height:\s*72px;/);
assert.match(header, /\.more-btn span\s*\{[\s\S]*?width:\s*5px;[\s\S]*?height:\s*5px;/);
assert.match(header, /@media \(max-width: 1000px\)\s*\{[\s\S]*?\.settings-header\s*\{[\s\S]*?height:\s*58px;/);
assert.match(header, /@media \(max-width: 1000px\)\s*\{[\s\S]*?\.tab\s*\{[\s\S]*?height:\s*44px;[\s\S]*?font-size:\s*16px;/);
assert.match(header, /@media \(max-width: 1000px\)\s*\{[\s\S]*?\.settings-header :global\(\.z-mark\.small\),[\s\S]*?--mark-size:\s*42px;/);

assert.match(zMark, /\.z-mark\.small\s*\{[\s\S]*?--mark-size:\s*42px;/);
assert.match(zMark, /\.z-mark\.large\s*\{[\s\S]*?--mark-size:\s*72px;/);
assert.match(zMark, /\.z-mark\.large\s*\{[\s\S]*?--stroke-height:\s*7px;/);
assert.match(zMark, /\.z-mark\s*\{[\s\S]*?border-radius:\s*50%;/);
assert.match(zMark, /class="z-stroke top"/);
assert.match(zMark, /class="z-stroke diagonal"/);
assert.match(zMark, /class="z-stroke bottom"/);

assertSmokeChecked(
  "设置页顶部标签、左侧宽侧栏菜单、通用设置布局接近 ZTools，顶部小/大 Z 图标均为三笔画圆形标识。",
  "macOS smoke checklist should mark the Settings ZTools shell and Z mark structure complete",
);
assertSmokeChecked(
  "设置页在 800px 主窗下使用约 58px 顶栏、44px 标签和 42px Z 图标，更多按钮三点居中，且没有横向溢出。",
  "macOS smoke checklist should mark the Settings header sizing complete",
);

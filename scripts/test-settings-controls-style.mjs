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

assert.match(source, /\.hotkey-input,\s*\n\s*\.select-control,\s*\n\s*\.text-input,\s*\n\s*\.number-input\s*\{[\s\S]*?height:\s*66px;/);
assert.match(source, /\.hotkey-input,\s*\n\s*\.select-control,\s*\n\s*\.text-input,\s*\n\s*\.number-input\s*\{[\s\S]*?border-radius:\s*9px;/);
assert.match(source, /\.hotkey-input\s*\{[\s\S]*?width:\s*300px;/);
assert.match(source, /\.text-input\s*\{[\s\S]*?width:\s*380px;/);
assert.match(source, /\.text-input\.wide\s*\{[\s\S]*?width:\s*440px;/);
assert.match(source, /\.select-control\s*\{[\s\S]*?min-width:\s*300px;/);
assert.match(source, /\.select-control\s*\{[\s\S]*?background:[\s\S]*?calc\(100% - 29px\) 29px \/ 9px 9px no-repeat,[\s\S]*?calc\(100% - 22px\) 29px \/ 9px 9px no-repeat,/);
assert.match(source, /\.icon-button,\s*\n\s*\.plain-button\s*\{[\s\S]*?min-height:\s*54px;/);
assert.match(source, /\.icon-button\s*\{[\s\S]*?width:\s*56px;/);
assert.match(source, /\.plain-button\s*\{[\s\S]*?padding:\s*0 22px;/);
assert.match(source, /\.toggle\s*\{[\s\S]*?width:\s*86px;[\s\S]*?height:\s*48px;[\s\S]*?flex:\s*0 0 86px;/);
assert.match(source, /\.toggle span::before\s*\{[\s\S]*?top:\s*5px;[\s\S]*?left:\s*5px;[\s\S]*?width:\s*34px;[\s\S]*?height:\s*34px;/);
assert.match(source, /\.toggle input:checked \+ span::before\s*\{[\s\S]*?transform:\s*translateX\(38px\);/);
assert.match(source, /@media \(max-width: 1000px\)\s*\{[\s\S]*?\.hotkey-input,\s*\n\s*\.select-control,\s*\n\s*\.text-input,\s*\n\s*\.number-input\s*\{[\s\S]*?height:\s*40px;/);
assert.match(source, /@media \(max-width: 1000px\)\s*\{[\s\S]*?\.hotkey-input,\s*\n\s*\.select-control,\s*\n\s*\.text-input,\s*\n\s*\.number-input\s*\{[\s\S]*?max-width:\s*100%;/);
assert.match(source, /@media \(max-width: 1000px\)\s*\{[\s\S]*?\.toggle\s*\{[\s\S]*?width:\s*52px;[\s\S]*?height:\s*30px;/);

assertSmokeChecked(
  "设置页在 800px 主窗下使用约 40px 高输入/下拉、36px 按钮和 52x30px 开关，且没有横向溢出。",
  "macOS smoke checklist should mark the Settings desktop controls sizing complete",
);

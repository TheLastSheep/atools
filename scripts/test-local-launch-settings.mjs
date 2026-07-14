import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const panel = await readFile(new URL("src/components/SettingsPanel.svelte", root), "utf8");
const smokeChecklist = await readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8");

assert.match(panel, /import \{ open as openDialog, save as saveDialog \} from "@tauri-apps\/plugin-dialog";/);
assert.match(panel, /resolveLocalLaunchPath/);

assert.match(panel, /async function addLocalLaunchEntryFromPicker\(kind: LocalLaunchKind\)/);
assert.match(panel, /if \(!hasTauriRuntime\(\)\) \{\s*localLaunchStatus = "浏览器预览模式无法选择本地路径";\s*return;\s*\}/s);
assert.match(panel, /openDialog\(\{/);
assert.match(panel, /directory: kind !== "file"/);
assert.match(panel, /multiple: false/);
assert.match(panel, /createLocalLaunchEntryFromPath\(/);
assert.match(panel, /persistLocalLaunchEntries\(\[\.\.\.localLaunchEntries, entry\], `已添加 \$\{entry\.name\}`\)/);

assert.match(panel, /function createLocalLaunchEntryFromPath\(/);
assert.match(panel, /inferLocalLaunchName\(/);
assert.match(panel, /inferLocalLaunchKeyword\(/);

assert.match(panel, /function onLocalLaunchDragOver\(event: DragEvent\)/);
assert.match(panel, /async function onLocalLaunchDrop\(event: DragEvent\)/);
assert.match(panel, /event\.dataTransfer\?\.files/);
assert.match(panel, /class="local-launch-dropzone"/);
assert.match(panel, /ondragover=\{onLocalLaunchDragOver\}/);
assert.match(panel, /ondrop=\{onLocalLaunchDrop\}/);
assert.match(panel, /拖拽文件或文件夹到这里添加/);

assert.match(panel, /async function openLocalLaunchPath\(entry: LocalLaunchEntry\)/);
assert.match(panel, /invoke\("shell_open", \{ url: resolvedPath \}\)/);
assert.match(panel, /async function revealLocalLaunchPath\(entry: LocalLaunchEntry\)/);
assert.match(panel, /invoke\("shell_show_item_in_folder", \{ path: resolvedPath \}\)/);

assert.match(panel, /async function removeLocalLaunchEntry\(entry: LocalLaunchEntry\)/);
assert.match(panel, /title: "删除本地启动项"/);
assert.match(panel, /message: `确定要删除“\$\{entry\.name\}”吗？/);
assert.match(panel, /confirmLabel: "删除"/);
assert.match(panel, /localLaunchEntries\.filter\(\(item\) => item\.id !== entry\.id\)/);
assert.doesNotMatch(panel, /onclick=\{\(\) => removeLocalLaunchEntry\(entry\.id\)\}/);

assert.match(panel, />添加文件</);
assert.match(panel, />添加文件夹</);
assert.match(panel, />添加应用</);
assert.match(panel, />手动添加</);
assert.match(panel, />打开</);
assert.match(panel, />定位</);
assert.match(panel, /class="local-launch-actions"/);
assert.match(panel, /\.local-launch-row\s*\{[\s\S]*?grid-template-columns:\s*48px minmax\(0,\s*1fr\);/);
assert.match(panel, /\.local-launch-fields\s*\{[\s\S]*?grid-template-columns:\s*minmax\(120px,\s*1fr\) minmax\(96px,\s*128px\) minmax\(118px,\s*150px\);/);
assert.match(panel, /\.local-path-input\s*\{[\s\S]*?grid-column:\s*1 \/ -1;/);
assert.match(panel, /\.local-launch-actions\s*\{[\s\S]*?grid-column:\s*2;/);
assert.match(panel, /\.local-launch-actions\s*\{[\s\S]*?justify-content:\s*flex-start;/);
assert.match(panel, /\.local-launch-actions \.plain-button\s*\{[\s\S]*?min-width:\s*72px;/);
assert.match(panel, /@media\s*\(max-width:\s*1280px\)[\s\S]*?\.local-launch-row\s*\{[\s\S]*?grid-template-columns:\s*42px minmax\(0,\s*1fr\);/);
assert.match(panel, /@media\s*\(max-width:\s*1280px\)[\s\S]*?\.local-launch-actions\s*\{[\s\S]*?grid-column:\s*2;/);
assert.match(panel, /@media\s*\(max-width:\s*860px\)[\s\S]*?\.local-launch-fields\s*\{[\s\S]*?grid-template-columns:\s*1fr;/);
assert.match(panel, /@media\s*\(max-width:\s*860px\)[\s\S]*?\.local-launch-actions\s*\{[\s\S]*?grid-column:\s*2;/);

assert.ok(
  smokeChecklist.includes("- [x] 设置页 `本地启动` 显示 `添加文件`、`添加文件夹`、`添加应用`、`手动添加`、拖拽添加区域和行级 `打开` / `定位` / `删除`；Web 预览下文件选择按钮禁用，桌面端选择后会新增可搜索启动项。"),
  "macOS smoke checklist should mark the Local Launch picker and row actions complete",
);
assert.ok(
  smokeChecklist.includes("- [x] `本地启动` 删除按钮弹出应用内确认弹窗，按 `Esc` 或 `取消` 只关闭弹窗，不删除条目且仍停留在 `本地启动`；确认删除后主搜索不再匹配该条路径。"),
  "macOS smoke checklist should mark the Local Launch delete confirmation complete",
);
assert.ok(
  smokeChecklist.includes("- [x] `本地启动` 页在 1280px 和窄屏下没有横向溢出，路径输入框单独成行，行级操作按钮不挤压字段。"),
  "macOS smoke checklist should mark the Local Launch responsive row layout complete",
);

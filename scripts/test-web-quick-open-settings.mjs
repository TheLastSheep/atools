import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const panel = await Promise.all(["src/components/SettingsPanel.svelte","src/components/SettingsGeneralAppearanceSection.svelte","src/components/SettingsGeneralBehaviorSection.svelte","src/components/SettingsShortcutsSection.svelte","src/components/SettingsProvidersAiSection.svelte","src/components/SettingsMcpSection.svelte","src/components/SettingsWebLocalSection.svelte","src/components/SettingsCommandsSection.svelte","src/components/SettingsDataSection.svelte","src/components/SettingsSyncSection.svelte","src/components/SettingsDebugHttpAboutSection.svelte","src/lib/settingsPanelTypesAndOptions.ts","src/lib/settingsPanelState.svelte.ts","src/lib/settingsPanelAiController.ts","src/lib/settingsPanelDataDebugController.ts","src/lib/settingsPanelEntriesController.ts","src/lib/settingsPanelLocalLaunchController.ts","src/lib/settingsPanelMcpAboutController.ts","src/lib/settingsPanelViewModels.ts","src/lib/settingsPanelWebdavViewController.ts","src/lib/settingsPanelWebdavController.ts","src/components/SettingsPanelBase.css","src/components/SettingsPanelControls.css","src/components/SettingsPanelOverview.css","src/components/SettingsPanelDomainCards.css","src/components/SettingsPanelCommandCenter.css","src/components/SettingsPanelResponsive.css"].map((p) => readFile(new URL(`../${p}`, import.meta.url), "utf8"))).then((parts) => parts.join("\n").replace(/\b([a-zA-Z0-9_]+):\s*(?:this|s)\.\1,/g, "$1,").replace(/\b(?:s|this|vm|entriesCtrl|localLaunchCtrl|aiCtrl|dataDebugCtrl|mcpAboutCtrl|webdavViewCtrl|webdavCtrl|props)\./g, "").replace(/:root\[data-atools-theme="dark"\]/g, ":global(:root[data-atools-theme=\"dark\"])").replace(/import \{ open as openDialog \} from "@tauri-apps\/plugin-dialog";/g, "import { open as openDialog, save as saveDialog } from \"@tauri-apps/plugin-dialog\";").replace(/const s = \$state\(\{([\s\S]*?)\n  \}\);/, (_, body) => body.replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+?)\s+as\s+([^,\n]+),$/gm, "  let $1 = $state<$3>($2);").replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+),$/gm, "  let $1 = $state($2);")).replace(/saveRevision = \$state\(0\)/g, "let saveRevision = 0"));
const smokeChecklist = await readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8");

assert.match(panel, /let editingWebQuickOpenId = \$state<string \| null>\(null\)/);
assert.match(panel, /let webQuickOpenDraft = \$state<WebQuickOpenEntry \| null>\(null\)/);
assert.match(panel, /let webQuickOpenValidation = \$state\(""\)/);

assert.match(panel, /function openWebQuickOpenEditor\(entry: WebQuickOpenEntry\)/);
assert.match(panel, /function closeWebQuickOpenEditor\(\)/);
assert.match(panel, /function updateWebQuickOpenDraft\(patch: Partial<WebQuickOpenEntry>\)/);
assert.match(panel, /function saveWebQuickOpenEditor\(\)/);
assert.match(panel, /function webQuickOpenTemplateMode\(entry: WebQuickOpenEntry\)/);
assert.match(panel, /function applyWebQuickOpenMode\(mode: "search" \| "direct"\)/);
assert.match(panel, /function validateWebQuickOpenDraft\(/);
assert.match(panel, /return validateWebQuickOpenEntry\(entry\)/);
assert.match(panel, /function webQuickOpenPreviewUrl\(/);
assert.match(panel, /function onSettingsWindowKeydown\(event: KeyboardEvent\)/);
assert.match(panel, /webQuickOpenDraft && event\.key === "Escape"/);
assert.match(panel, /closeWebQuickOpenEditor\(\);/);

assert.match(panel, /async function removeWebQuickOpenEntry\(entry: WebQuickOpenEntry\)/);
assert.match(panel, /title: "删除网页快开"/);
assert.match(panel, /message: `确定要删除“\$\{entry\.name\}”吗？/);
assert.match(panel, /confirmLabel: "删除"/);
assert.doesNotMatch(panel, /onclick=\{\(\) => removeWebQuickOpenEntry\(entry\.id\)\}/);

assert.match(panel, /class="web-quick-card-grid"/);
assert.match(panel, /class="web-quick-card"/);
assert.match(panel, /class="web-quick-card-head"/);
assert.match(panel, /class="web-quick-keyword-chip"/);
assert.match(panel, /class="web-quick-preview-url"/);
assert.match(panel, /class="web-quick-card-actions"/);

assert.match(panel, /class="web-quick-editor-layer"/);
assert.match(panel, /class="web-quick-editor-panel"/);
assert.match(panel, /编辑网页快开/);
assert.match(panel, /搜索模板/);
assert.match(panel, /固定网址/);
assert.match(panel, /URL 预览/);
assert.match(panel, /onclick=\{saveWebQuickOpenEditor\}/);
assert.match(panel, /onclick=\{closeWebQuickOpenEditor\}/);

assert.match(panel, />编辑</);
assert.match(panel, />预览</);
assert.match(panel, />删除</);

assert.ok(
  smokeChecklist.includes("- [x] `网页快开` 点击 `编辑` 打开页面内编辑面板，支持 `搜索模板` / `固定网址` 类型切换、名称/关键字/URL 模板编辑和 `URL 预览`；按 `Esc` 只关闭编辑面板，不关闭设置页且仍停留在 `网页快开`。"),
  "macOS smoke checklist should mark the Web quick-open editor complete",
);
assert.ok(
  smokeChecklist.includes("- [x] `网页快开` 保存非法 URL、非 http/https URL、空名称、空关键字或带空格关键字时显示错误，不落库；删除按钮弹出应用内确认弹窗，取消或 `Esc` 不删除卡片。"),
  "macOS smoke checklist should mark the Web quick-open validation and delete confirmation complete",
);

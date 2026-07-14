import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/components/SettingsPanel.svelte", import.meta.url), "utf8");
const macosChecklist = await readFile(new URL("../docs/macos-smoke-checklist.md", import.meta.url), "utf8");

assert.ok(source.includes('activeMenu === "about"'), "Settings effect should handle the About page explicitly");
assert.ok(source.includes("refreshAboutPage"), "About page should refresh runtime/MCP facts when opened");
assert.ok(source.includes("copyAboutRuntimeInfo"), "About page should provide a copy-runtime-info action");
assert.ok(source.includes("copyAboutDiagnosticBundle"), "About page should provide a copy-diagnostic-bundle action");
assert.ok(source.includes("aboutPageStatus"), "About page should show copy/navigation feedback");
assert.ok(source.includes("复制运行信息"), "About page should render a copy runtime info button");
assert.ok(source.includes("复制脱敏诊断"), "About page should render a copy redacted diagnostics button");
assert.ok(source.includes("打开调试日志"), "About page should link to Debug Logs");
assert.ok(source.includes("打开 MCP 服务"), "About page should link to MCP Service");
assert.ok(source.includes("本地数据路径"), "About page should show local data path information");
assert.ok(source.includes("本地 Agent 能力"), "About page should summarize local Agent capability counts");
assert.ok(source.includes('appUpdater.check("manual")'), "About page should trigger an explicit manual update check");
assert.ok(source.includes("appUpdater.installAndRestart()"), "About page should install the exact discovered update on confirmation");
assert.ok(source.includes("应用更新"), "About page should render an application update section");
assert.ok(source.includes("检查更新"), "About page should render a manual update button");
assert.ok(source.includes("更新并重启"), "About page should render an install-and-restart button when an update is available");
assert.ok(source.includes("上次检查"), "About page should display the last successful check time");
assert.ok(source.includes("桌面应用中可用"), "Browser preview should explain that updates require the desktop app");
assert.doesNotMatch(source, /\{@html[^}]*update/i, "Release notes must be rendered as text, never raw HTML");
assert.match(source, /token:\s*mcp\?\.token\s*\?\s*"<hidden>"\s*:\s*""/, "Copied runtime info must not include the raw MCP token");
assert.match(source, /<button class="plain-button" onclick=\{\(\) => activeMenu = "mcp"\}>打开 MCP 服务<\/button>/, "About page should navigate directly to the MCP Service page");

const checkedAboutSmokeItems = [
  "`关于` 页不是空白页，显示 `ATools 3.0`、`Tauri + Rust`、本地 MCP、HTML/JS 插件 UI 和运行信息。",
  "`关于` 页显示 `本地环境`、`本地数据路径`、`数据库路径`、`插件目录`、`本地 Agent 能力`、`MCP 监听` 和 `运行事件`。",
  "`关于` 页提供 `复制运行信息`、`复制脱敏诊断`、`打开调试日志`、`打开 MCP 服务`；复制运行信息后显示内联成功状态，复制内容不得包含 MCP token 明文。",
  "`关于` 页点击 `打开 MCP 服务` 后左侧菜单选中 `MCP 服务`，并显示客户端配置复制入口。",
];

for (const item of checkedAboutSmokeItems) {
  assert.ok(
    macosChecklist.includes(`- [x] ${item}`),
    `macOS smoke checklist should mark About parity item as verified: ${item}`,
  );
}

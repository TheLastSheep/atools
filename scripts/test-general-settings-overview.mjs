import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-general-settings-overview-"));
const outFile = join(outDir, "settingsPages.mjs");

try {
  const sourcePath = new URL("src/lib/settingsPages.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);
  const smokeChecklist = await readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8");
  const assertSmokeChecked = (row, message) => {
    assert.ok(smokeChecklist.includes(`- [x] ${row}`), message);
  };
  assert.equal(typeof mod.generalOverviewCards, "function", "settingsPages should expose general overview cards");

  const cards = mod.generalOverviewCards({
    hotkey: "Option+Z",
    saveLabel: "已保存",
    launchAtLogin: true,
    showTrayIcon: false,
    localAppSearch: true,
    localLaunchSearch: false,
    unsupportedCount: 6,
  });
  assert.deepEqual(
    cards.map((card) => card.label),
    ["呼出快捷键", "系统入口", "搜索来源", "暂缓能力"],
  );
  assert.equal(cards[0].value, "Option+Z");
  assert.match(cards[0].detail, /已保存/);
  assert.equal(cards[0].tone, "ready");
  assert.equal(cards[1].value, "开机启动 / 托盘关闭");
  assert.match(cards[1].detail, /登录时启动/);
  assert.equal(cards[2].value, "1/2 启用");
  assert.match(cards[2].detail, /本地应用/);
  assert.equal(cards[2].tone, "warning");
  assert.equal(cards[3].value, "6 项暂缓");
  assert.match(cards[3].detail, /GPU 启动参数/);

  const noHotkeyCards = mod.generalOverviewCards({
    hotkey: "",
    saveLabel: "保存失败",
    launchAtLogin: false,
    showTrayIcon: true,
    localAppSearch: false,
    localLaunchSearch: false,
    unsupportedCount: 0,
  });
  assert.equal(noHotkeyCards[0].value, "未设置");
  assert.equal(noHotkeyCards[0].tone, "warning");
  assert.equal(noHotkeyCards[1].value, "手动启动 / 托盘显示");
  assert.equal(noHotkeyCards[2].value, "0/2 启用");

  const [panel, app] = await Promise.all([
    readFile(new URL("src/components/SettingsPanel.svelte", root), "utf8"),
    readFile(new URL("src/App.svelte", root), "utf8"),
  ]);
  assert.match(panel, /generalOverviewCards/);
  assert.match(panel, /通用设置概览/);
  assert.match(panel, /基础设置/);
  assert.match(panel, /本页设置保存在本机/);
  assert.match(panel, /class="general-overview-grid"/);
  assert.match(panel, /class="general-overview-card"/);
  assert.match(panel, /代理地址/);
  assert.match(panel, /bind:value=\{proxyUrl\}/);
  assert.match(panel, /proxyEnabled \? "代理将用于 WebDAV 同步和 AI 模型连接测试"/);
  assert.match(panel, /bind:checked=\{showRecentInSearch\}/);
  assert.match(panel, /showRecentInSearch,/);
  assert.match(app, /showHomeRecent = \$derived\(isHomeSearch && trimmedQuery\.length === 0 && appSettings\.showRecentInSearch\)/);
  assert.match(app, /expanded=\{activePlugin !== null \|\| activePanel !== "home" \|\| query\.trim\(\)\.length > 0 \|\| showHomeRecent\}/);
  assert.match(panel, /插件 DevTools 会按该偏好打开/);
  assert.match(panel, /bind:value=\{devToolsMode\}/);
  assert.match(panel, /onchange=\{persistSoon\}/);
  assert.match(panel, /openDevtoolsForWindow/);
  assert.match(panel, /invoke<DevtoolsOpenResult>\("open_devtools_for_window"/);
  assert.match(panel, /打开主窗口 DevTools/);
  assert.match(panel, /插件市场地址/);
  assert.match(panel, /bind:value=\{pluginMarketUrl\}/);
  assert.match(panel, /pluginMarketCustom \? "插件市场页将使用该地址作为外部市场入口"/);
  assert.match(panel, /openPluginMarketUrl/);
  assert.match(panel, /invoke\("shell_open", \{ url: pluginMarketUrl\.trim\(\) \}\)/);
  assert.match(panel, /打开市场地址/);
  assert.match(panel, /setFloatingBallVisible/);
  assert.match(panel, /invoke\("set_floating_ball_visible", \{ visible: floatingBallEnabled \}\)/);
  assert.match(panel, /floatingBallEnabled \? "悬浮球窗口会常驻屏幕边缘/);
  assert.match(panel, /onchange=\{persistFloatingBallChange\}/);
  assert.match(panel, /setSuperPanelVisible/);
  assert.match(panel, /invoke\("set_super_panel_visible", \{ visible: superPanelEnabled \}\)/);
  assert.match(panel, /superPanelEnabled \? "超级面板会常驻屏幕上方/);
  assert.match(panel, /onchange=\{persistSuperPanelChange\}/);
  assert.equal(panel.includes("代理设置尚未接入请求层"), false);
  assert.equal(panel.includes("插件 DevTools 位置控制尚未接入"), false);
  assert.equal(panel.includes("插件市场尚未实现，暂不启用"), false);
  assert.equal(panel.includes("超级面板尚未实现，暂不启用"), false);
  assert.equal(panel.includes("悬浮球窗口尚未实现，暂不启用"), false);

  assertSmokeChecked(
    "通用设置中“搜索框显示最近使用”关闭后，回到首页不显示最近使用。",
    "macOS smoke checklist should mark disabling home recent commands complete",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}

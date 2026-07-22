import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-settings-normalization-"));
const outFile = join(outDir, "settings.mjs");

try {
  const sourcePath = new URL("src/lib/settings.ts", root).pathname;
  const [source, panelSource, globalCss, smokeChecklist] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(new URL("src/components/SettingsPanel.svelte", root), "utf8"),
    readFile(new URL("src/styles/global.css", root), "utf8"),
    readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8"),
  ]);
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const storage = new Map();
  const styleValues = new Map();
  globalThis.window = {};
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear(),
  };
  globalThis.document = {
    documentElement: {
      dataset: {},
      style: {
        setProperty: (key, value) => styleValues.set(key, String(value)),
        getPropertyValue: (key) => styleValues.get(key) ?? "",
      },
    },
  };

  const mod = await import(pathToFileURL(outFile).href);
  const assertSmokeChecked = (row, message) => {
    assert.ok(smokeChecklist.includes(`- [x] ${row}`), message);
  };

  const restoredDefaults = mod.normalizeSettings(null);
  assert.equal(restoredDefaults.theme, "system");
  assert.equal(restoredDefaults.primaryColor, "purple");
  assert.equal(restoredDefaults.showRecentInSearch, true);
  assert.equal(restoredDefaults.recentRows, 2);
  assert.equal(restoredDefaults.pinnedRows, 1);

  const normalized = mod.normalizeSettings({
    superPanelEnabled: true,
    floatingBallEnabled: true,
    proxyEnabled: true,
    pluginMarketCustom: true,
    devToolsMode: "bottom",
    disableGpuAcceleration: true,
    windowMaterial: "acrylic",
    pinnedRows: 4,
  });

  assert.equal(normalized.superPanelEnabled, true);
  assert.equal(normalized.floatingBallEnabled, true);
  assert.equal(normalized.pluginMarketCustom, false);
  assert.equal(normalized.pluginMarketUrl, "");
  assert.equal(normalized.devToolsMode, "bottom");
  assert.equal(normalized.disableGpuAcceleration, false);
  assert.equal(normalized.windowMaterial, mod.DEFAULT_ATOOLS_SETTINGS.windowMaterial);
  assert.equal(normalized.pinnedRows, 4);

  const invalidDevToolsSettings = mod.normalizeSettings({
    devToolsMode: "attach",
  });
  assert.equal(invalidDevToolsSettings.devToolsMode, mod.DEFAULT_ATOOLS_SETTINGS.devToolsMode);

  const pluginMarketSettings = mod.normalizeSettings({
    pluginMarketCustom: true,
    pluginMarketUrl: " https://market.example.com/catalog.json ",
  });
  assert.equal(pluginMarketSettings.pluginMarketCustom, true);
  assert.equal(pluginMarketSettings.pluginMarketUrl, "https://market.example.com/catalog.json");

  const trustedPluginMarketSettings = mod.normalizeSettings({
    pluginMarketTrustedPublicKeys: [
      " BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc= ",
      "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
      "not-base64",
      42,
    ],
  });
  assert.deepEqual(trustedPluginMarketSettings.pluginMarketTrustedPublicKeys, [
    "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
  ]);
  assert.deepEqual(
    mod.normalizeSettings({ pluginMarketTrustedPublicKeys: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=" })
      .pluginMarketTrustedPublicKeys,
    [],
    "trusted plugin keys must use an explicit list so malformed persisted values fail closed",
  );

  const disabledPluginMarketSettings = mod.normalizeSettings({
    pluginMarketCustom: false,
    pluginMarketUrl: " https://market.example.com/catalog.json ",
  });
  assert.equal(disabledPluginMarketSettings.pluginMarketCustom, false);
  assert.equal(disabledPluginMarketSettings.pluginMarketUrl, "https://market.example.com/catalog.json");

  const invalidPluginMarketSettings = mod.normalizeSettings({
    pluginMarketCustom: true,
    pluginMarketUrl: " ftp://market.example.com/catalog.json ",
  });
  assert.equal(invalidPluginMarketSettings.pluginMarketCustom, false);
  assert.equal(invalidPluginMarketSettings.pluginMarketUrl, "");

  const proxySettings = mod.normalizeSettings({
    proxyEnabled: true,
    proxyUrl: " http://127.0.0.1:7890 ",
  });
  assert.equal(proxySettings.proxyEnabled, true);
  assert.equal(proxySettings.proxyUrl, "http://127.0.0.1:7890");

  const invalidProxySettings = mod.normalizeSettings({
    proxyEnabled: true,
    proxyUrl: " ftp://127.0.0.1:7890 ",
  });
  assert.equal(invalidProxySettings.proxyEnabled, false);
  assert.equal(invalidProxySettings.proxyUrl, "");

  const clampedRows = mod.normalizeSettings({
    recentRows: 0,
    pinnedRows: 99,
  });
  assert.equal(clampedRows.recentRows, 1);
  assert.equal(clampedRows.pinnedRows, 4);

  const aiSettings = mod.normalizeSettings({
    aiProvider: "compatible",
    aiBaseUrl: " https://api.example.com/v1 ",
    aiDefaultModel: " qwen-max ",
    aiApiKey: " sk-local-only ",
    aiTemperature: 1.7,
    aiUseForAgent: true,
  });

  assert.equal(aiSettings.aiProvider, "compatible");
  assert.equal(aiSettings.aiBaseUrl, "https://api.example.com/v1");
  assert.equal(aiSettings.aiDefaultModel, "qwen-max");
  assert.equal(aiSettings.aiApiKey, "sk-local-only");
  assert.equal(aiSettings.aiTemperature, 1.7);
  assert.equal(aiSettings.aiUseForAgent, true);

  const disabledAiSettings = mod.normalizeSettings({
    aiProvider: "not-a-provider",
    aiBaseUrl: 42,
    aiDefaultModel: "",
    aiApiKey: null,
    aiTemperature: 99,
    aiUseForAgent: true,
  });

  assert.equal(disabledAiSettings.aiProvider, "disabled");
  assert.equal(disabledAiSettings.aiBaseUrl, "");
  assert.equal(disabledAiSettings.aiDefaultModel, "");
  assert.equal(disabledAiSettings.aiApiKey, "");
  assert.equal(disabledAiSettings.aiTemperature, mod.DEFAULT_ATOOLS_SETTINGS.aiTemperature);
  assert.equal(disabledAiSettings.aiUseForAgent, false);

  const webdavSettings = mod.normalizeSettings({
    webdavEnabled: true,
    webdavUrl: " https://dav.example.com/remote.php/dav/files/me/ ",
    webdavUsername: " harris ",
    webdavPassword: " local-secret ",
    webdavRemotePath: " atools/sync ",
    webdavSyncSettings: true,
    webdavSyncPlugins: false,
    webdavSyncClipboard: true,
  });

  assert.equal(webdavSettings.webdavEnabled, true);
  assert.equal(webdavSettings.webdavUrl, "https://dav.example.com/remote.php/dav/files/me/");
  assert.equal(webdavSettings.webdavUsername, "harris");
  assert.equal(webdavSettings.webdavPassword, "local-secret");
  assert.equal(webdavSettings.webdavRemotePath, "/atools/sync");
  assert.equal(webdavSettings.webdavSyncSettings, true);
  assert.equal(webdavSettings.webdavSyncPlugins, false);
  assert.equal(webdavSettings.webdavSyncClipboard, true);

  const invalidWebdavSettings = mod.normalizeSettings({
    webdavEnabled: true,
    webdavUrl: " ftp://dav.example.com ",
    webdavUsername: " ",
    webdavPassword: null,
    webdavRemotePath: "",
    webdavSyncSettings: false,
    webdavSyncPlugins: false,
    webdavSyncClipboard: true,
  });

  assert.equal(invalidWebdavSettings.webdavEnabled, false);
  assert.equal(invalidWebdavSettings.webdavUrl, "");
  assert.equal(invalidWebdavSettings.webdavUsername, "");
  assert.equal(invalidWebdavSettings.webdavPassword, "");
  assert.equal(invalidWebdavSettings.webdavRemotePath, "/ATools");
  assert.equal(invalidWebdavSettings.webdavSyncSettings, true);
  assert.equal(invalidWebdavSettings.webdavSyncPlugins, true);
  assert.equal(invalidWebdavSettings.webdavSyncClipboard, false);

  const shortcutSettings = mod.normalizeSettings({
    appShortcuts: [
      { id: " a ", shortcut: " Command+1 ", targetCode: " system:settings ", enabled: false },
      { id: "", shortcut: "Command+2", targetCode: "web:github", enabled: true },
      { id: "bad-shortcut", shortcut: "", targetCode: "system:settings", enabled: true },
      { id: "bad-target", shortcut: "Command+3", targetCode: "", enabled: true },
    ],
  });
  assert.deepEqual(shortcutSettings.appShortcuts, [
    { id: "a", shortcut: "Command+1", targetCode: "system:settings", enabled: false },
    { id: "app-shortcut-1", shortcut: "Command+2", targetCode: "web:github", enabled: true },
  ]);

  const persistedSettings = mod.normalizeSettings({
    showRecentInSearch: false,
    recentRows: 1,
    pinnedRows: 1,
    theme: "dark",
    primaryColor: "custom",
    customColor: "#123456",
  });
  await mod.saveAToolsSettings(persistedSettings);
  const loadedSettings = await mod.loadAToolsSettings();
  assert.equal(loadedSettings.showRecentInSearch, false);
  assert.equal(loadedSettings.recentRows, 1);
  assert.equal(loadedSettings.pinnedRows, 1);
  assert.equal(loadedSettings.theme, "dark");
  assert.equal(loadedSettings.primaryColor, "custom");
  assert.equal(loadedSettings.customColor, "#123456");
  assert.equal(globalThis.document.documentElement.dataset.atoolsTheme, "dark");
  assert.equal(styleValues.get("--accent"), "#123456");
  assert.equal(styleValues.get("--accent-hover"), "#123456");
  assert.equal(styleValues.get("--atools-window-opacity"), "1");

  mod.applyAToolsAppearance(mod.normalizeSettings({
    theme: "dark",
    primaryColor: "orange",
  }));
  assert.equal(globalThis.document.documentElement.dataset.atoolsTheme, "dark");
  assert.equal(styleValues.get("--accent"), "#ea580c");
  assert.equal(styleValues.get("--accent-hover"), "#ea580c");
  assert.match(String(styleValues.get("--accent-subtle")), /rgba\(234,\s*88,\s*12,\s*0\.14\)/);

  mod.applyAToolsAppearance(mod.normalizeSettings({
    theme: "system",
    primaryColor: "custom",
    customColor: "#654321",
  }));
  assert.equal(styleValues.get("--accent"), "#654321");
  assert.equal(styleValues.get("--accent-hover"), "#654321");

  assert.match(globalCss, /:root\[data-atools-theme="dark"\]\s*\{/);
  assert.match(globalCss, /:root\[data-atools-theme="dark"\]\s*\{[\s\S]*?--bg-primary:\s*rgba\(24,\s*27,\s*32,\s*0\.94\);/);
  assert.match(panelSource, /:global\(:root\[data-atools-theme="dark"\]\) \.settings-panel/);
  assert.match(panelSource, /--settings-primary:\s*var\(--accent\);/);
  assert.match(panelSource, /\.toggle input:checked \+ span\s*\{[\s\S]*?background:\s*var\(--settings-primary\);/);
  assert.match(panelSource, /class:active=\{primaryColor === color\.value\}/);
  assert.match(panelSource, /onclick=\{\(\) => \{ primaryColor = color\.value; persistSoon\(\); \}\}/);
  assert.match(panelSource, /class:active=\{primaryColor === "custom"\}/);
  assert.match(panelSource, /\{#if primaryColor === "custom"\}/);
  assert.match(panelSource, /bind:value=\{customColor\}/);
  assert.match(panelSource, /bind:value=\{pluginMarketTrustedPublicKeysText\}/);
  assert.match(panelSource, /pluginMarketTrustedPublicKeys:\s*pluginMarketTrustedPublicKeysText/);
  assert.match(panelSource, /受信任 Ed25519 公钥/);
  assert.match(panelSource, /市场目录提供的公钥不会自动成为信任锚/);
  assert.match(panelSource, /applySettings\(DEFAULT_ATOOLS_SETTINGS\);\s*persistSoon\(\);/);

  assertSmokeChecked(
    "刷新页面后，上一步设置仍保留。",
    "macOS smoke checklist should mark persisted settings reload complete",
  );
  assertSmokeChecked(
    "主题设置切到暗黑后，设置页和主界面变量变为暗色。",
    "macOS smoke checklist should mark dark theme application complete",
  );
  assertSmokeChecked(
    "主题色切到橙色后，选中态和开关颜色变为橙色。",
    "macOS smoke checklist should mark orange theme color application complete",
  );
  assertSmokeChecked(
    "主题色切到 `自定义` 后显示颜色选择器，修改颜色后刷新仍保留。",
    "macOS smoke checklist should mark custom theme color persistence complete",
  );
  assertSmokeChecked(
    "测试结束后恢复为：主题 `跟随系统`、主题色 `罗兰紫`、最近使用开启、最近使用 2 行。",
    "macOS smoke checklist should mark post-test default settings restoration complete",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}

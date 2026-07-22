import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-command-history-"));
const outFile = join(outDir, "commandHistory.mjs");

try {
  const matchSourcePath = new URL("src/lib/searchMatch.ts", root).pathname;
  const matchSource = await readFile(matchSourcePath, "utf8");
  const transformedMatch = await transformWithEsbuild(matchSource, matchSourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(join(outDir, "searchMatch.mjs"), transformedMatch.code);

  const sourcePath = new URL("src/lib/commandHistory.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code.replaceAll('from "./searchMatch";', 'from "./searchMatch.mjs";'));

  const search = await import(pathToFileURL(join(outDir, "searchMatch.mjs")).href);
  search.setSearchPinyinResolver((value) => {
    if (value.trim() === "设置") return { full: "shezhi", spaced: "she zhi", initials: "sz" };
    return null;
  });

  const mod = await import(pathToFileURL(outFile).href);

  const settingsResult = {
    code: "system:settings",
    plugin_id: "system",
    plugin_name: "ATools",
    label: "设置",
    icon: null,
    explain: "打开工具设置",
    score: 100,
    match_type: "exact",
  };
  const urlResult = {
    code: "url:https%3A%2F%2Fexample.com%2Fdocs",
    plugin_id: "url-quick-open",
    plugin_name: "链接快开",
    label: "打开链接 example.com/docs",
    icon: null,
    explain: "https://example.com/docs",
    score: 99,
    match_type: "exact",
  };
  const textResult = {
    code: "text:%7B%7D",
    plugin_id: "text-quick-actions",
    plugin_name: "文本快识别",
    label: "复制格式化 JSON",
    icon: null,
    explain: "{}",
    score: 87,
    match_type: "exact",
  };
  const pluginResult = {
    code: "json-format",
    plugin_id: "json-tools",
    plugin_name: "JSON 工具",
    label: "JSON 格式化",
    icon: "/tmp/json-tools/logo.png",
    explain: "格式化 JSON",
    score: 95,
    match_type: "exact",
  };

  assert.equal(mod.commandHistoryEntryFromResult(textResult, "{}", "2026-06-02T01:00:00.000Z"), null);
  const pluginEntry = mod.commandHistoryEntryFromResult(pluginResult, "json", "2026-06-02T01:00:00.000Z");
  assert.equal(pluginEntry.code, "json-format");
  assert.equal(pluginEntry.icon, "/tmp/json-tools/logo.png");

  const first = mod.recordCommandUse([], settingsResult, "设置", "2026-06-02T01:00:00.000Z");
  assert.equal(first.length, 1);
  assert.equal(first[0].code, "system:settings");
  assert.equal(first[0].input, "设置");
  assert.equal(first[0].useCount, 1);

  const second = mod.recordCommandUse(first, urlResult, "example.com/docs", "2026-06-02T01:01:00.000Z");
  const third = mod.recordCommandUse(second, settingsResult, "设置", "2026-06-02T01:02:00.000Z");
  assert.deepEqual(third.map((entry) => entry.code), ["system:settings", "url:https%3A%2F%2Fexample.com%2Fdocs"]);
  assert.equal(third[0].useCount, 2);
  assert.equal(third[0].usedAt, "2026-06-02T01:02:00.000Z");

  const availableOnly = mod.filterCommandHistoryByCodeAvailability(
    [pluginEntry, ...third],
    (code) => code !== "json-format",
  );
  assert.deepEqual(
    availableOnly.map((entry) => entry.code),
    ["system:settings", "url:https%3A%2F%2Fexample.com%2Fdocs"],
  );

  const normalized = mod.normalizeCommandHistory([
    { code: "local:desktop", label: "打开 桌面", explain: "文件夹 · ~/Desktop", plugin_id: "local-launch", plugin_name: "本地启动", input: "desktop", usedAt: "2026-06-02T00:00:00.000Z", useCount: 1 },
    { code: "local:desktop", label: "打开 桌面", explain: "文件夹 · ~/Desktop", plugin_id: "local-launch", plugin_name: "本地启动", input: "desk", usedAt: "2026-06-02T02:00:00.000Z", useCount: 3 },
    { code: "", label: "Bad", explain: "", plugin_id: "x", plugin_name: "x", input: "", usedAt: "bad", useCount: 1 },
  ]);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].input, "desk");
  assert.equal(normalized[0].useCount, 3);

  const home = mod.homeCommandsFor(third, [
    { code: "设置", label: "设置", explain: "推荐设置", panel: "settings" },
    { code: "ip", label: "ip", explain: "查看 IP" },
  ], 4);
  assert.deepEqual(home.map((entry) => entry.code), ["system:settings", "url:https%3A%2F%2Fexample.com%2Fdocs", "ip"]);
  assert.equal(home[0].source, "history");
  assert.equal(home[2].source, "recommended");

  const pluginHome = mod.homeCommandsFor([pluginEntry], [], 1);
  assert.equal(pluginHome[0].icon, "/tmp/json-tools/logo.png");

  const pinnedHome = mod.homeCommandsFor(third, [
    { code: "system:settings", label: "设置", explain: "推荐设置", panel: "settings" },
    { code: "web:github", label: "GitHub", explain: "网页快开", plugin_id: "web-quick-open", plugin_name: "网页快开" },
    { code: "ip", label: "ip", explain: "查看 IP" },
  ], 4, [
    { code: "web:github", label: "GitHub", explain: "输入 gh 关键词快速打开", plugin_id: "web-quick-open", plugin_name: "网页快开" },
    { code: "system:settings", label: "设置", explain: "打开工具设置", plugin_id: "system", plugin_name: "ATools", panel: "settings" },
  ]);
  assert.deepEqual(pinnedHome.map((entry) => entry.code), [
    "web:github",
    "system:settings",
    "url:https%3A%2F%2Fexample.com%2Fdocs",
    "ip",
  ]);
  assert.deepEqual(pinnedHome.map((entry) => entry.source), [
    "pinned",
    "pinned",
    "history",
    "recommended",
  ]);

  const results = mod.commandHistoryResultsForQuery("docs", third);
  assert.equal(results.length, 1);
  assert.equal(results[0].plugin_name, "最近使用");
  assert.equal(results[0].match_type, "contains");
  assert.equal(mod.commandHistoryPayloadFromCode(results[0].code).code, "url:https%3A%2F%2Fexample.com%2Fdocs");

  const pinyinHistory = mod.commandHistoryResultsForQuery("sz", third)[0];
  assert.equal(pinyinHistory.label, "设置");
  assert.equal(pinyinHistory.match_type, "pinyin");

  assert.equal(typeof mod.commandHistoryStats, "function");
  assert.deepEqual(mod.commandHistoryStats(third), {
    count: 2,
    lastUsedAt: "2026-06-02T01:02:00.000Z",
    topLabel: "设置",
  });

  assert.equal(typeof mod.exportCommandHistoryJson, "function");
  const exported = JSON.parse(mod.exportCommandHistoryJson(third));
  assert.equal(exported.version, 1);
  assert.equal(exported.count, 2);
  assert.equal(exported.entries[0].code, "system:settings");

  const storage = new Map();
  const dispatched = [];
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  globalThis.window = {
    dispatchEvent: (event) => {
      dispatched.push({ type: event.type, detail: event.detail });
      return true;
    },
  };
  storage.set(mod.COMMAND_HISTORY_STORAGE_KEY, JSON.stringify(third));
  assert.equal(typeof mod.clearCommandHistoryStorage, "function");
  assert.equal(mod.clearCommandHistoryStorage(), 2);
  assert.equal(storage.has(mod.COMMAND_HISTORY_STORAGE_KEY), false);
  assert.equal(dispatched[0].type, mod.COMMAND_HISTORY_UPDATED_EVENT);
  assert.deepEqual(dispatched[0].detail, []);

  const afterRemove = mod.removeCommandHistoryEntry(third, "system:settings");
  assert.deepEqual(afterRemove.map((entry) => entry.code), ["url:https%3A%2F%2Fexample.com%2Fdocs"]);
  assert.deepEqual(mod.removeCommandHistoryEntry(third, "missing").map((entry) => entry.code), third.map((entry) => entry.code));

  storage.set(mod.COMMAND_HISTORY_STORAGE_KEY, JSON.stringify(third));
  dispatched.length = 0;
  assert.equal(mod.removeCommandHistoryEntryStorage("system:settings"), 1);
  const persistedAfterRemove = JSON.parse(storage.get(mod.COMMAND_HISTORY_STORAGE_KEY));
  assert.deepEqual(persistedAfterRemove.map((entry) => entry.code), ["url:https%3A%2F%2Fexample.com%2Fdocs"]);
  assert.equal(dispatched[0].type, mod.COMMAND_HISTORY_UPDATED_EVENT);
  assert.deepEqual(dispatched[0].detail.map((entry) => entry.code), ["url:https%3A%2F%2Fexample.com%2Fdocs"]);

  assert.equal(mod.commandHistoryPayloadFromCode("history:not-json"), null);
} finally {
  await rm(outDir, { recursive: true, force: true });
}

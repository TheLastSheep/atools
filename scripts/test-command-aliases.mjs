import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-command-aliases-"));
const outFile = join(outDir, "commandAliases.mjs");

try {
  const matchSourcePath = new URL("src/lib/searchMatch.ts", root).pathname;
  const matchSource = await readFile(matchSourcePath, "utf8");
  const transformedMatch = await transformWithEsbuild(matchSource, matchSourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(join(outDir, "searchMatch.mjs"), transformedMatch.code);

  const sourcePath = new URL("src/lib/commandAliases.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code.replaceAll('from "./searchMatch";', 'from "./searchMatch.mjs";'));

  const mod = await import(pathToFileURL(outFile).href);

  const aliases = mod.normalizeCommandAliases([
    { id: "a", alias: " cfg ", targetCode: " system:settings ", enabled: true },
    { id: "dup", alias: "CFG", targetCode: "system:plugins", enabled: true },
    { id: "off", alias: "plg", targetCode: "system:plugins", enabled: false },
    { id: "bad", alias: "", targetCode: "", enabled: true },
  ]);
  assert.equal(aliases.length, 2);
  assert.equal(aliases[0].alias, "cfg");
  assert.equal(aliases[0].targetCode, "system:settings");
  assert.equal(aliases[0].enabled, true);
  assert.equal(aliases[1].enabled, false);

  const created = mod.createCommandAlias("system:settings");
  assert.ok(created.id.startsWith("alias-"));
  assert.equal(created.targetCode, "system:settings");
  assert.equal(created.enabled, true);

  const targets = new Map([
    ["system:settings", {
      code: "system:settings",
      label: "设置",
      explain: "打开工具设置",
      plugin_id: "system",
      plugin_name: "ATools",
    }],
    ["system:plugins", {
      code: "system:plugins",
      label: "插件管理",
      explain: "管理插件",
      plugin_id: "system",
      plugin_name: "ATools",
    }],
  ]);
  const resolveTarget = (code) => targets.get(code) ?? null;

  const result = mod.commandAliasResultsForQuery("cfg", aliases, resolveTarget)[0];
  assert.equal(result.plugin_name, "别名");
  assert.equal(result.label, "设置");
  assert.equal(result.match_type, "alias");
  assert.equal(result.explain.includes("cfg"), true);
  assert.deepEqual(mod.commandAliasPayloadFromCode(result.code), {
    alias: "cfg",
    targetCode: "system:settings",
  });

  assert.equal(mod.commandAliasResultsForQuery("plg", aliases, resolveTarget).length, 0);
  assert.equal(mod.commandAliasResultsForQuery("zzzz", aliases, resolveTarget).length, 0);
  assert.equal(mod.commandAliasPayloadFromCode("alias:not-json"), null);

  const storage = new Map();
  const dispatched = [];
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  };
  globalThis.window = {
    dispatchEvent: (event) => {
      dispatched.push({ type: event.type, detail: event.detail });
      return true;
    },
  };
  mod.saveCommandAliases(aliases);
  mod.dispatchCommandAliasesUpdated(aliases);
  assert.equal(storage.has(mod.COMMAND_ALIASES_STORAGE_KEY), true);
  assert.equal(dispatched[0].type, mod.COMMAND_ALIASES_UPDATED_EVENT);
  assert.equal(dispatched[0].detail[0].alias, "cfg");
} finally {
  await rm(outDir, { recursive: true, force: true });
}

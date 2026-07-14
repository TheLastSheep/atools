import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-local-launch-"));
const outFile = join(outDir, "localLaunch.mjs");

try {
  const matchSourcePath = new URL("src/lib/searchMatch.ts", root).pathname;
  const matchSource = await readFile(matchSourcePath, "utf8");
  const transformedMatch = await transformWithEsbuild(matchSource, matchSourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(join(outDir, "searchMatch.mjs"), transformedMatch.code);

  const sourcePath = new URL("src/lib/localLaunch.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code.replaceAll('from "./searchMatch";', 'from "./searchMatch.mjs";'));

  const search = await import(pathToFileURL(join(outDir, "searchMatch.mjs")).href);
  search.setSearchPinyinResolver((value) => {
    if (value.trim() === "下载") return { full: "xiazai", spaced: "xia zai", initials: "xz" };
    return null;
  });

  const mod = await import(pathToFileURL(outFile).href);

  const entries = mod.normalizeLocalLaunchEntries([
    { id: "desk", name: " Desktop ", keyword: " desk ", path: " ~/Desktop ", kind: "folder", enabled: true },
    { id: "code", name: "VS Code", keyword: "code", path: "/Applications/Visual Studio Code.app", kind: "app", enabled: true },
    { id: "downloads", name: "下载", keyword: "downloads", path: "~/Downloads", kind: "folder", enabled: true },
    { id: "off", name: "Disabled", keyword: "off", path: "/tmp/off", kind: "file", enabled: false },
    { id: "bad", name: "", keyword: "", path: "", kind: "folder", enabled: true },
  ]);

  assert.equal(entries.length, 4);
  assert.equal(entries[0].name, "Desktop");
  assert.equal(entries[0].keyword, "desk");
  assert.equal(entries[0].path, "~/Desktop");
  assert.equal(entries[0].kind, "folder");

  assert.equal(mod.resolveLocalLaunchPath("~/Desktop", "/Users/harris"), "/Users/harris/Desktop");
  assert.equal(mod.resolveLocalLaunchPath("/tmp/file.txt", "/Users/harris"), "/tmp/file.txt");

  const keywordResult = mod.localLaunchResultsForQuery("desk", entries)[0];
  assert.equal(keywordResult.label, "打开 Desktop");
  assert.equal(keywordResult.code, "local:desk");
  assert.equal(keywordResult.match_type, "exact");

  const nameResult = mod.localLaunchResultsForQuery("visual", entries)[0];
  assert.equal(nameResult.label, "打开 VS Code");
  assert.equal(nameResult.match_type, "contains");

  const pinyinResult = mod.localLaunchResultsForQuery("xz", entries)[0];
  assert.equal(pinyinResult.label, "打开 下载");
  assert.equal(pinyinResult.match_type, "pinyin");

  assert.equal(mod.localLaunchResultsForQuery("off", entries).length, 0);
  const manyEntries = Array.from({ length: 150 }, (_, index) => ({
    id: `project-${index}`,
    name: `Shared Project ${index}`,
    keyword: `project${index}`,
    path: `/tmp/project-${index}`,
    kind: "folder",
    enabled: true,
  }));
  assert.equal(mod.localLaunchResultsForQuery("shared", manyEntries).length, 100);
  assert.equal(mod.localLaunchEntryByCode("local:code", entries)?.path, "/Applications/Visual Studio Code.app");

  const created = mod.createLocalLaunchEntry();
  assert.ok(created.id.startsWith("local-"));
  assert.equal(created.enabled, true);
  assert.equal(created.kind, "folder");
} finally {
  await rm(outDir, { recursive: true, force: true });
}

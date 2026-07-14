import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-home-quick-action-icons-"));
const outFile = join(outDir, "homeSurface.mjs");

try {
  const uiStatePath = new URL("src/lib/uiState.ts", root).pathname;
  const uiStateSource = await readFile(uiStatePath, "utf8");
  const uiStateTransformed = await transformWithEsbuild(uiStateSource, uiStatePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(join(outDir, "uiState.mjs"), uiStateTransformed.code);

  const resultIconsPath = new URL("src/lib/resultIcons.ts", root).pathname;
  const resultIconsSource = await readFile(resultIconsPath, "utf8");
  const resultIconsTransformed = await transformWithEsbuild(resultIconsSource, resultIconsPath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(join(outDir, "resultIcons.mjs"), resultIconsTransformed.code.replaceAll('from "./types";', 'from "./types.mjs";'));
  await writeFile(join(outDir, "types.mjs"), "export {};\n");

  const sourcePath = new URL("src/lib/homeSurface.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code
    .replaceAll('from "./uiState";', 'from "./uiState.mjs";')
    .replaceAll('from "./resultIcons";', 'from "./resultIcons.mjs";'));

  const mod = await import(pathToFileURL(outFile).href);
  const smokeChecklist = await readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8");
  const assertSmokeChecked = (row, message) => {
    assert.ok(smokeChecklist.includes(`- [x] ${row}`), message);
  };
  const actions = mod.homeQuickActions();

  assert.deepEqual(actions.map((action) => action.icon), [
    "download",
    "plugins",
    "agent",
    "settings",
  ]);
  assert.ok(actions.every((action) => action.ariaLabel === `打开${action.label}`));

  const [homePanel, iconComponent] = await Promise.all([
    readFile(new URL("src/components/HomePanel.svelte", root), "utf8"),
    readFile(new URL("src/components/HomeQuickActionIcon.svelte", root), "utf8"),
  ]);

  assert.match(homePanel, /import HomeQuickActionIcon from "\.\/HomeQuickActionIcon\.svelte";/);
  assert.doesNotMatch(homePanel, /quick-action-icon">\{iconLabel\(action\.label\)\}/);
  assert.match(homePanel, /<HomeQuickActionIcon icon=\{action\.icon\}/);
  assert.match(homePanel, /aria-label=\{action\.ariaLabel\}/);

  for (const icon of ["download", "plugins", "agent", "settings"]) {
    assert.match(iconComponent, new RegExp(`icon === "${icon}"`));
  }
  assert.match(iconComponent, /<svg[\s\S]*?aria-hidden="true"/);
  assert.match(iconComponent, /\.home-quick-action-icon\s*\{[\s\S]*?width:\s*28px;[\s\S]*?height:\s*28px;/);

  assertSmokeChecked(
    "四个首页常用入口使用明确功能图标，不显示入口文字首字 fallback，且按钮具备 `打开...` aria label。",
    "macOS smoke checklist should mark Home quick action icons complete",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}

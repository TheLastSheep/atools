import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lazyJavaScriptGraph, summarizeLazyJavaScriptGraph, verifyBundleBudget } from "./lib/release-bundle-budget.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, process.argv[2] || "output/legacy-node-2026-10-16/node-page-brand-default-bundle-budget.json");
if (process.argv.length > 3) throw Error("Usage: node scripts/verify-launcher-build-budget.mjs [fresh-output.json]");
try {
  await stat(output);
  throw Error(`Refusing to replace existing budget evidence: ${output}`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const fixedInputs = ["index.html", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "vite.config.ts",
  "svelte.config.js", "tsconfig.json", "tsconfig.node.json", "scripts/lib/release-bundle-budget.mjs",
  "scripts/test-release-bundle-budget.mjs", "scripts/verify-launcher-build-budget.mjs"];
const budgetBytes = 560 * 1024;

async function sourceFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(path));
    else if (entry.isFile() && /\.(?:ts|svelte|css)$/.test(entry.name)) found.push(path);
  }
  return found;
}

async function fingerprintInputs() {
  const paths = [...fixedInputs.map(path => join(root, path)), ...await sourceFiles(join(root, "src"))]
    .sort((a, b) => a.localeCompare(b));
  const values = {};
  for (const path of paths) {
    const bytes = await readFile(path);
    values[relative(root, path)] = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  }
  return values;
}

function sameFingerprints(before, after) {
  const keys = Object.keys(before);
  return keys.length === Object.keys(after).length && keys.every(key =>
    before[key].sha256 === after[key].sha256 && before[key].bytes === after[key].bytes);
}

function findPanelChunk(manifest, assets) {
  const entry = Object.entries(manifest).find(([, value]) => value.src === "src/components/PluginPanel.svelte");
  const file = entry?.[1]?.file ?? assets.find(name => /^plugin-panel-.+\.js$/.test(name));
  const matchingKeys = Object.entries(manifest).filter(([, value]) => value.file === file).map(([key]) => key);
  return { file, key: entry?.[0] ?? (matchingKeys.length === 1 ? matchingKeys[0] : null) };
}

const runId = randomUUID();
const scratch = await mkdtemp(join(tmpdir(), "atools-default-build-budget-"));
const distDir = join(scratch, "dist");
const buildEnv = { ...process.env };
const removedBuildVariables = [];
for (const key of Object.keys(buildEnv)) {
  if (key === "TAURI_ENV_DEBUG" || key === "TAURI_ENV_PLATFORM" || key.startsWith("VITE_ATOOLS_")) {
    removedBuildVariables.push(key);
    delete buildEnv[key];
  }
}

const report = { schemaVersion: 1, runId, status: "fail",
  scope: "Default production Vite initial static JavaScript graph and lazy PluginPanel/Node runtime chunk; source hash stability over all src TypeScript/Svelte/CSS plus build inputs; not an RSS or startup-time measurement",
  before: {}, after: {}, buildEnvironment: { scrubbedKeys: removedBuildVariables.sort(),
    debugMode: buildEnv.TAURI_ENV_DEBUG ?? null, platformOverride: buildEnv.TAURI_ENV_PLATFORM ?? null,
    atoolsTestVariablesRemaining: Object.keys(buildEnv).filter(key => key.startsWith("VITE_ATOOLS_")).sort() },
  budget: null, sourceHashStable: false, buildScratchRemoved: false, errors: [] };

try {
  report.before = await fingerprintInputs();
  const viteEntry = join(root, "node_modules/vite/bin/vite.js");
  const build = spawnSync(process.execPath, [viteEntry, "build", "--manifest", "--outDir", distDir], {
    cwd: root, env: buildEnv, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  if (build.status !== 0) throw Error(`Production Vite build failed (${build.status ?? build.signal ?? "unknown"}): ${(build.stderr || build.stdout || "").slice(-4000)}`);

  const budget = await verifyBundleBudget(distDir);
  const manifest = JSON.parse(await readFile(join(distDir, ".vite/manifest.json"), "utf8"));
  const assets = await readdir(join(distDir, "assets"));
  const panel = findPanelChunk(manifest, assets);
  const initialFiles = new Set(budget.initialAssets.map(asset => asset.file));
  if (!panel.file || !panel.file.startsWith("assets/plugin-panel-") || initialFiles.has(panel.file))
    throw Error("PluginPanel (and its page Node runtime dependency) must remain outside the initial static graph");
  if (!panel.key) throw Error("PluginPanel manifest entry is missing or ambiguous; cannot measure its static closure");
  const lazyFiles = lazyJavaScriptGraph(manifest, panel.key);
  const lazySizes = {};
  for (const file of lazyFiles) {
    const asset = await stat(join(distDir, file));
    if (!asset.isFile()) throw Error(`PluginPanel static JavaScript asset is not a regular file: ${file}`);
    lazySizes[file] = asset.size;
  }
  const lazyClosure = summarizeLazyJavaScriptGraph(lazyFiles, initialFiles, lazySizes);
  if (budget.initialJavaScriptBytes > budgetBytes) throw Error("Initial JavaScript graph exceeds the 573440-byte budget");
  report.budget = { ...budget, initialJavaScriptBudgetBytes: budgetBytes,
    lazyNodePlugin: { pluginPanelManifestKey: panel.key, pluginPanelFile: panel.file,
      pluginPanelBytes: (await stat(join(distDir, panel.file))).size, excludedFromInitialStaticGraph: true,
      staticJavaScriptClosure: lazyClosure,
      sourceChain: ["PluginPanelMount.svelte and LauncherMainPushHost.svelte dynamically import PluginPanel.svelte", "PluginPanel.svelte imports pluginPanelLoadController, which imports pluginRuntimePreload", "pluginRuntimePreload imports pluginLegacyNodeEnvironment"] } };
} catch (error) {
  report.errors.push(String(error instanceof Error ? error.message : error));
} finally {
  report.after = await fingerprintInputs();
  report.sourceHashStable = sameFingerprints(report.before, report.after);
  await rm(scratch, { recursive: true, force: true });
  try { await access(scratch); } catch { report.buildScratchRemoved = true; }
await mkdir(dirname(output), { recursive: true });
  if (!report.sourceHashStable) report.errors.push("Tracked source/config fingerprints changed during the build");
  if (!report.buildScratchRemoved) report.errors.push("Temporary build output was not removed");
  if (report.buildEnvironment.atoolsTestVariablesRemaining.length) report.errors.push("VITE_ATOOLS test variables leaked into the build environment");
  report.status = report.errors.length === 0 ? "pass" : "fail";
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

console.log(JSON.stringify({ output, runId, status: report.status,
  initialJavaScriptBytes: report.budget?.initialJavaScriptBytes ?? null,
  budgetBytes, lazyNodePlugin: report.budget?.lazyNodePlugin ?? null,
  sourceHashStable: report.sourceHashStable, buildScratchRemoved: report.buildScratchRemoved,
  errors: report.errors }, null, 2));
if (report.status !== "pass") process.exitCode = 1;

import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { mkdir, mkdtemp, cp, readFile, readdir, rm, writeFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildNativeSmoke, runNativeProcess } from "./lib/native-smoke-process.mjs";
import { stageNativeSmokeApp } from "./lib/native-smoke-app-bundle.mjs";
import { capturePanelSources, fingerprintFile, fingerprintsEqual } from "./lib/native-panel-source-binding.mjs";
import { mainPushSourceFiles } from "./lib/plugin-main-push-source-binding.mjs";
import { pluginDataSourceFiles } from "./lib/plugin-data-source-binding.mjs";
import { createPanelFixtureEnvironment, treeHash } from "./probe-plugin-panel-native.mjs";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const nativeSources = ["calculation-paper", "bookmarks"];
async function sources() {
  const selected = { ...await capturePanelSources(root) };
  for (const file of [...await mainPushSourceFiles(root), ...await pluginDataSourceFiles(root)])
    selected[file] = await fingerprintFile(join(root, file));
  return Object.fromEntries(Object.entries(selected).sort(([left], [right]) => left.localeCompare(right)));
}
async function exists(file) { try { await access(file); return true; } catch { return false; } }

export async function main(args = process.argv.slice(2)) {
  if (process.platform !== "darwin") throw Error("Native MainPush smoke currently targets macOS");
  const parsed = new Map();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (parsed.has(key) || !["--output", "--execute"].includes(key)) throw Error("Use --output ABSOLUTE_PATH --execute");
    parsed.set(key, key === "--execute" ? true : args[++index]);
  }
  if (!parsed.get("--execute") || !parsed.get("--output")) throw Error("Explicit --execute and fresh --output are required");
  const output = resolve(parsed.get("--output"));
  if (await exists(output)) throw Error("Preserve previous evidence; choose a fresh report path");
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const report = { schemaVersion: 1, runId: randomUUID(), passed: false, status: "preparing",
    scope: { productionApp: true, realNativeCommandsPermissionsTaskRuns: true, originalPackages: nativeSources,
      syntheticPackage: "main-push-fixture", hardwareHumanInputVerified: false,
      originalBookmarksSelection: "Excluded from native smoke: it can spawn a browser; browser recording-sink test is separate",
      sourceSelection: "Explicit selected inputs, not a complete compiler/dependency closure" } };
  const environment = await createPanelFixtureEnvironment(root);
  const scratch = await mkdtemp("/private/tmp/atools-main-push-build-");
  let originalHashes;
  try {
    originalHashes = Object.fromEntries(await Promise.all(nativeSources.map(async name => [name, await treeHash(join(root, "ZTools-plugins/plugins", name))])));
    report.originalSourceHashesBefore = originalHashes;
    report.sourceHashesBefore = await sources();
    const cohort = join(scratch, "plugins"); await mkdir(cohort, { mode: 0o700 });
    for (const name of nativeSources) await cp(join(root, "ZTools-plugins/plugins", name), join(cohort, name), { recursive: true, errorOnExist: true });
    await cp(join(root, "tests/fixtures/main-push-native"), join(cohort, "main-push-fixture"), { recursive: true, errorOnExist: true });
    report.cohortHashesBefore = Object.fromEntries(await Promise.all([...nativeSources, "main-push-fixture"]
      .map(async name => [name, await treeHash(join(cohort, name))])));
    if (nativeSources.some(name => report.cohortHashesBefore[name] !== originalHashes[name])) throw Error("Copied original package differs before import");
    const bundle = join(scratch, "panel");
    await build({ configFile: false, root, logLevel: "error",
      plugins: [svelte({ emitCss: false, compilerOptions: { css: "injected" } })],
      build: { outDir: bundle, minify: "esbuild", target: "safari14", cssCodeSplit: false,
        lib: { entry: join(root, "tests/components/nativeMainPushSmoke.ts"), formats: ["iife"], name: "NativeMainPushSmoke", fileName: () => "panel.js" },
        rollupOptions: { output: { inlineDynamicImports: true } } } });
    const css = join(scratch, "panel.css");
    const cssFiles = (await readdir(bundle)).filter(file => file.endsWith(".css"));
    await writeFile(css, (await Promise.all(cssFiles.map(file => readFile(join(bundle, file), "utf8")))).join("\n"));
    const built = await buildNativeSmoke(root);
    const app = await stageNativeSmokeApp(built, scratch, report.runId);
    report.application = app;
    console.log(JSON.stringify({ temporaryApplication: app, runId: report.runId }));
    const artifacts = { nativeExecutable: app.executable, applicationInfo: app.plistPath,
      panelJavaScript: join(bundle, "panel.js"), panelCss: css };
    report.artifactHashesBefore = Object.fromEntries(await Promise.all(Object.entries(artifacts).map(async ([key, file]) => [key, await fingerprintFile(file)])));
    const beforeSpawn = await sources();
    report.preSpawnSourcesUnchanged = fingerprintsEqual(report.sourceHashesBefore, beforeSpawn);
    if (!report.preSpawnSourcesUnchanged) throw Error("Selected source changed while building the native fixture");
    const nativeReport = join(scratch, "native-report.json");
    report.status = "running";
    try {
      report.nativeProcess = await runNativeProcess(app.executable, ["--main-push-ui", join(bundle, "panel.js"),
        "--main-push-css", css, "--main-push-probe", join(root, "tests/components/nativeMainPushFrameProbe.js"),
        "--plugin-root", cohort, "--fixture-root", join(environment.root, "native-main-push"), "--output", nativeReport],
        { cwd: root, env: environment.env, timeoutMs: 210000, stdio: "inherit",
          onProcessStarted: async ({ identity }) => {
            report.nativeLaunchIdentity = identity;
            return { report: { launchIdentity: identity, resourceSampling: false } };
          } });
    } catch (error) {
      report.nativeProcessError = String(error);
      report.nativeProcessFailureDetails = { errors: error instanceof AggregateError ? error.errors.map(String) : [],
        processObserver: error?.processObserver ?? null, processObserverError: error?.processObserverError ?? null };
    }
    if (await exists(nativeReport)) report.native = JSON.parse(await readFile(nativeReport, "utf8"));
    else report.nativeReportError = "Native event loop produced no readable report";
    report.artifactHashesAfter = Object.fromEntries(await Promise.all(Object.entries(artifacts).map(async ([key, file]) => [key, await fingerprintFile(file)])));
    report.artifactsUnchanged = fingerprintsEqual(report.artifactHashesBefore, report.artifactHashesAfter);
    report.sourceHashesAfter = await sources();
    report.sourcesUnchanged = fingerprintsEqual(report.sourceHashesBefore, report.sourceHashesAfter);
    report.originalSourceHashesAfter = Object.fromEntries(await Promise.all(nativeSources.map(async name => [name, await treeHash(join(root, "ZTools-plugins/plugins", name))])));
    report.originalSourcesUnchanged = fingerprintsEqual(originalHashes, report.originalSourceHashesAfter);
    report.cohortHashesAfter = Object.fromEntries(await Promise.all([...nativeSources, "main-push-fixture"]
      .map(async name => [name, await treeHash(join(cohort, name))])));
    report.cohortUnchanged = fingerprintsEqual(report.cohortHashesBefore, report.cohortHashesAfter);
    report.passed = !report.nativeProcessError && report.native?.passed === true && report.sourcesUnchanged
      && report.originalSourcesUnchanged && report.artifactsUnchanged && report.cohortUnchanged;
    report.status = report.passed ? "passed" : "failed";
  } catch (error) { report.status = "failed"; report.error = String(error instanceof Error ? error.stack : error); }
  finally {
    const errors = [];
    try { report.environmentCleanup = await environment.cleanup(); } catch (error) { errors.push(String(error)); }
    try { await rm(scratch, { recursive: true, force: true }); report.scratchRemoved = true; } catch (error) { errors.push(String(error)); }
    report.cleanupErrors = errors;
    if (errors.length) { report.passed = false; report.status = "failed"; }
    report.finishedAt = new Date().toISOString();
    await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }
  console.log(JSON.stringify({ output, runId: report.runId, passed: report.passed, status: report.status,
    native: report.native && { passed: report.native.passed, error: report.native.error,
      checks: Object.keys(report.native.checks ?? {}).length, runtimeDrained: report.native.runtimeDrained,
      temporaryDataRemoved: report.native.temporaryDataRemoved }, error: report.error, nativeProcessError: report.nativeProcessError }, null, 2));
  if (!report.passed) process.exitCode = 1;
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

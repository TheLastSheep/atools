import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build } from "vite";
import { createFixtureEnvironment } from "./lib/legacy-node-environment.mjs";
import { stageNativeSmokeApp } from "./lib/native-smoke-app-bundle.mjs";
import { runNativeProcess } from "./lib/native-smoke-process.mjs";
import { fingerprintHostArtifact } from "./lib/host-clipboard-native-evidence.mjs";
import { pluginDisplaySourceFiles } from "./lib/plugin-display-source-binding.mjs";

const root = resolve(new URL("../", import.meta.url).pathname);
const execute = process.argv.includes("--execute");
const values = process.argv.slice(2).filter(value => value !== "--execute");
const output = resolve(values[0] || join(root, "output/plugin-display-2026-10-19/native-display-smoke.json"));
if (values.length > 1 || process.platform !== "darwin") throw new Error("Usage: probe-plugin-display-native.mjs [output.json] [--execute] on macOS");
await mkdir(dirname(output), { recursive: true });
await readFile(output).then(() => { throw Error("Preserve earlier evidence; select a fresh output path"); }, error => { if (error.code !== "ENOENT") throw error; });

const sources = [...new Set([
  ...await pluginDisplaySourceFiles(root),
  "Cargo.toml", "crates/atools-core/src/agent.rs", "crates/atools-core/src/capability.rs",
  "scripts/lib/host-clipboard-native-evidence.mjs", "scripts/lib/legacy-node-environment.mjs",
  "scripts/lib/native-smoke-app-bundle.mjs", "scripts/lib/native-smoke-process.mjs",
  "scripts/lib/plugin-display-source-binding.mjs", "scripts/probe-plugin-display-native.mjs",
  "src-tauri/Cargo.toml", "src-tauri/src/agent_tools.rs", "src-tauri/src/legacy_runtime/desktop_smoke.rs",
  "src-tauri/src/legacy_runtime/permission_context.rs", "src-tauri/src/lib.rs", "src-tauri/src/plugin_loopback.rs",
  "tests/components/nativePluginDisplaySmoke.ts",
])].sort();
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async path => [path,
  createHash("sha256").update(await readFile(join(root, path))).digest("hex")] )));
const sameHashes = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const report = {
  schemaVersion: 1,
  passed: null,
  mode: execute ? "execute-native" : "static-build-only",
  scope: "Finite synthetic shared display adapter fixture; five synchronous metadata getters, twenty invocations, production permission and TaskRun pipeline. Not whole-plugin, multi-monitor field validation, competitor UX, or a performance SLA.",
  nativeReadPerformed: null,
  nativeProcessAttempted: false,
  staticBuildPassed: false,
  sourceHashes: {},
  artifacts: {},
  native: null,
  cleanup: {},
};
let failure;
let scratch;
let isolated;
try {
  report.sourceHashes.before = await hashes();
  scratch = await mkdtemp(join(tmpdir(), "atools-display-smoke-"));
  const built = join(scratch, "probe");
  await mkdir(built);
  await build({ configFile: false, root, logLevel: "error", build: {
    outDir: built, emptyOutDir: false, minify: "esbuild", target: "safari14",
    lib: { entry: join(root, "tests/components/nativePluginDisplaySmoke.ts"), formats: ["iife"], name: "NativeDisplaySmoke", fileName: () => "probe.js" },
    rollupOptions: { output: { inlineDynamicImports: true } },
  } });
  const probeScript = join(built, "probe.js");
  await readFile(probeScript);
  report.artifacts.bundle = await fingerprintHostArtifact(probeScript);
  report.staticBuildPassed = true;
  if (execute) {
    const cargo = await runNativeProcess("cargo", ["build", "-p", "atools", "--example", "legacy_node_desktop_smoke", "--features", "legacy-node-smoke", "--offline"], { cwd: root });
    void cargo;
    const { stdout } = await promisify(execFile)("cargo", ["metadata", "--no-deps", "--offline", "--format-version", "1"], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
    const executable = join(JSON.parse(stdout).target_directory, "debug/examples/legacy_node_desktop_smoke");
    isolated = await createFixtureEnvironment();
    const staged = await stageNativeSmokeApp(executable, scratch);
    report.artifacts.nativeBefore = {
      executable: await fingerprintHostArtifact(staged.executable),
      plist: await fingerprintHostArtifact(staged.plistPath),
      bundleId: staged.bundleId,
    };
    const nativeOutput = join(scratch, "native-report.json");
    report.sourceHashes.preSpawn = await hashes();
    report.sourceHashes.preSpawnUnchanged = sameHashes(report.sourceHashes.before, report.sourceHashes.preSpawn);
    if (!report.sourceHashes.preSpawnUnchanged) throw new Error("Selected source changed before native spawn");
    report.artifacts.probeBeforeNative = await fingerprintHostArtifact(probeScript);
    report.nativeProcessAttempted = true;
    try {
      await runNativeProcess(staged.executable, ["--display-metadata-ui", "--fixture-root", join(scratch, "profile"), "--output", nativeOutput, "--probe-script", probeScript], {
        cwd: root, env: isolated.env, timeoutMs: 95000,
      });
    } finally {
      report.native = await readFile(nativeOutput, "utf8").then(JSON.parse).catch(() => null);
      report.nativeReadPerformed = typeof report.native?.nativeReadPerformed === "boolean"
        ? report.native.nativeReadPerformed
        : null;
      report.artifacts.probeAfterNative = await fingerprintHostArtifact(probeScript);
      report.artifacts.probeBundleUnchanged = JSON.stringify(report.artifacts.probeBeforeNative) === JSON.stringify(report.artifacts.probeAfterNative);
      report.artifacts.nativeAfter = {
        executable: await fingerprintHostArtifact(staged.executable),
        plist: await fingerprintHostArtifact(staged.plistPath),
        bundleId: staged.bundleId,
      };
    }
    report.artifacts.nativeUnchanged = JSON.stringify(report.artifacts.nativeBefore) === JSON.stringify(report.artifacts.nativeAfter)
      && report.artifacts.probeBundleUnchanged === true;
    report.passed = report.native?.passed === true
      && report.native?.snapshotTaskRuns === 20
      && report.native?.successfulSnapshots === 20
      && report.nativeReadPerformed === true
      && report.artifacts.nativeUnchanged;
  } else {
    report.passed = null;
  }
} catch (error) {
  failure = error;
  report.error = String(error?.message || error).slice(0, 240);
} finally {
  try { report.sourceHashes.after = await hashes(); report.sourceHashes.unchanged = sameHashes(report.sourceHashes.before, report.sourceHashes.after); }
  catch (error) { report.sourceHashes.error = String(error?.message || error).slice(0, 180); }
  if (isolated) {
    try { report.cleanup.environmentRemoved = (await isolated.cleanup()).isolatedEnvironmentRemoved === true; }
    catch (error) { report.cleanup.environmentError = String(error?.message || error).slice(0, 180); }
  }
  if (scratch) {
    try { await rm(scratch, { recursive: true, force: true }); report.cleanup.buildAndAppScratchRemoved = true; }
    catch (error) { report.cleanup.scratchError = String(error?.message || error).slice(0, 180); }
  }
  const cleanupPassed = !execute || report.cleanup.environmentRemoved === true && report.cleanup.buildAndAppScratchRemoved === true;
  if (execute) report.passed = report.passed === true && report.sourceHashes.unchanged === true && cleanupPassed;
  else report.staticBuildPassed = report.staticBuildPassed === true && report.sourceHashes.unchanged === true;
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
}
console.log(JSON.stringify({ output, passed: report.passed, staticBuildPassed: report.staticBuildPassed, mode: report.mode, nativeReadPerformed: report.nativeReadPerformed, sourcesUnchanged: report.sourceHashes.unchanged }));
if (failure || execute && !report.passed || !execute && !report.staticBuildPassed) process.exitCode = 1;
if (process.argv[1] && fileURLToPath(import.meta.url) !== resolve(process.argv[1])) process.exitCode = 1;

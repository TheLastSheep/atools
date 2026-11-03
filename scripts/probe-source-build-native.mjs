import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, access, lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { buildNativeSmoke, runNativeProcess } from "./lib/native-smoke-process.mjs";
import { stageNativeSmokeApp } from "./lib/native-smoke-app-bundle.mjs";
import { capturePanelSources, fingerprintFile, fingerprintsEqual } from "./lib/native-panel-source-binding.mjs";
import { createPanelFixtureEnvironment } from "./probe-plugin-panel-native.mjs";
import { createSourceBuildPackages } from "./lib/source-build-native-packages.mjs";
import { prepareApplicationUninstallerPackage } from "./lib/application-uninstaller-native-package.mjs";
import { fixtureSourceTreeHash, sourcePackageManifest } from "./lib/source-build-real-package-evidence.mjs";
import { createSourceBuildProbeDiagnostics } from "./lib/source-build-probe-diagnostics.mjs";

const candidateRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidateFiles = [
  "scripts/probe-source-build-native.mjs", "scripts/lib/source-build-native-packages.mjs",
  "scripts/lib/application-uninstaller-native-package.mjs", "scripts/lib/source-build-real-package-evidence.mjs",
  "tests/components/nativeSourceBuildSmoke.ts", "tests/components/nativeSourceBuildScenario.ts",
  "tests/components/nativeApplicationUninstallerScenario.ts",
  "tests/components/nativeSourceBuildScenarioDiagnostics.ts",
  "src-tauri/src/legacy_runtime/desktop_smoke_source_build.rs",
  "src-tauri/src/legacy_runtime/desktop_smoke_source_build_failure_evidence.rs",
  "src-tauri/src/agent_tools/source_build_failure_observation.rs", "crates/atools-core/src/task_run.rs",
  "src-tauri/src/legacy_runtime/desktop_smoke_source_build_diagnostics.rs",
  "src-tauri/src/legacy_runtime/desktop_smoke_source_build_pipeline_evidence.rs",
  "src-tauri/src/legacy_runtime/desktop_smoke_source_build_scenario_diagnostics.rs",
  "src-tauri/src/legacy_runtime/desktop_smoke_source_build_inspection_observation.rs",
  "src-tauri/src/legacy_runtime/desktop_smoke_source_build_scenario_host.rs",
  "src-tauri/src/legacy_runtime/desktop_smoke_source_build_profile.rs",
  "src-tauri/src/legacy_runtime/desktop_smoke_source_build_identity.rs",
  "scripts/lib/source-build-probe-diagnostics.mjs", "scripts/test-source-build-probe-diagnostics.mjs",
];
async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function sources() {
  const selected = await capturePanelSources(root);
  const paths = ["scripts/probe-source-build-native.mjs", "scripts/lib/source-build-native-packages.mjs",
    "tests/components/SourceBuildNativeHost.svelte", "tests/components/nativeSourceBuildSmoke.ts", "tests/components/nativeSourceBuildScenario.ts",
    "src-tauri/src/legacy_runtime/desktop_smoke_source_build.rs", "src-tauri/src/legacy_runtime/desktop_smoke_source_build_failure_evidence.rs",
    "src-tauri/src/agent_tools/source_build_failure_observation.rs", "crates/atools-core/src/task_run.rs",
    "src-tauri/src/agent_tools.rs", "crates/atools-plugin/src/lib.rs", "crates/atools-core/src/capability.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_source_build_diagnostics.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_source_build_pipeline_evidence.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_source_build_profile.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_source_build_scenario_diagnostics.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_source_build_inspection_observation.rs",
    "src-tauri/src/legacy_runtime/desktop_smoke_source_build_scenario_host.rs",
    "tests/components/nativeSourceBuildScenarioDiagnostics.ts",
    "src-tauri/src/legacy_runtime/desktop_smoke_source_build_identity.rs",
    "src-tauri/src/main.rs", "src-tauri/examples/source_build_bootstrap_smoke.rs",
    "src/lib/pluginSourceBuildProtocol.ts", "src/lib/pluginSourceBuildServices.ts", "src/lib/pluginSourceBuildController.ts",
    "src/lib/pluginSourceBuildPermissions.ts", "src/lib/pluginCatalogObservation.ts", "src/lib/ztoolsImportController.ts",
    "src/lib/permissionApproval.ts", "src/lib/permissionPreview.ts", "src/lib/ztoolsImportView.ts", "src/lib/ztoolsImportSelection.ts",
    "src/components/ZToolsImportResults.svelte",
    "src/components/ZToolsSourceBuildStatus.svelte", "src/components/ZToolsImportCandidateRow.svelte", "src/components/PermissionConfirmDialog.svelte",
    "scripts/lib/source-build-probe-diagnostics.mjs", "scripts/test-source-build-probe-diagnostics.mjs"];
  async function walk(relative) {
    for (const file of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = `${relative}/${file.name}`;
      if (file.isDirectory()) await walk(path); else if (file.isFile() && file.name.endsWith(".rs")) paths.push(path);
    }
  }
  await walk("crates/atools-plugin/src/source_build"); await walk("src-tauri/src/plugin_source_build");
  for (const file of paths) selected[file] = await fingerprintFile(join(root, file));
  for (const file of candidateFiles) selected[`candidate:${file}`] = await fingerprintFile(join(candidateRoot, file));
  return Object.fromEntries(Object.entries(selected).sort(([a], [b]) => a.localeCompare(b)));
}
export async function main(args = process.argv.slice(2)) {
  const parsed = parseArgs(args);
  const output = resolve(parsed.output);
  if (await exists(output)) throw Error("Preserve prior evidence; choose a fresh report");
  const diagnosticEvidenceDir = `${output}.diagnostics`;
  const report = { schemaVersion: 2, runId: randomUUID(), passed: false, profile: parsed.profile,
    scope: parsed.profile === "application-uninstaller"
      ? "One untracked local complete package; real production inspection, permission, TaskRun, build, validation, and import; programmatic UI; no upstream denominator or broader plugin-usability claim"
      : parsed.profile === "synthetic-typescript"
      ? "Synthetic private TypeScript+Vite source project; real copied local compiler, native permissions/TaskRuns and import; programmatic production components, no original-plugin business/usability claim"
      : "Synthetic source projects; real Vite, native permissions/TaskRuns and import; programmatic production components, no original-plugin business/hardware/competitor/RSS claim",
    diagnosticEvidence: { directory: diagnosticEvidenceDir, maxFileBytes: 4 * 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024, files: {} } };
  const probeDiagnostics = createSourceBuildProbeDiagnostics({ buildBudgetMs: 180_000, nativeBudgetMs: 150_000 });
  report.sourceBuildProbeDiagnostics = probeDiagnostics.snapshot();
  let evidenceBytes = 0, environment, scratch, evidenceDirCreated = false, nativeStarted = false;
  let reportWritten = false, reportWriteFailed = false;
  report.failureObservation = null;
  async function preserveEvidenceFile(source, name) {
    if (!/^(panel\.js|panel\.css|entry\.html|native-report\.json)$/.test(name)) throw Error("Unsupported diagnostic evidence filename");
    const metadata = await lstat(source);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4 * 1024 * 1024) throw Error("Diagnostic evidence input is not a bounded regular file");
    const bytes = await readFile(source);
    if (bytes.length !== metadata.size || bytes.length > 4 * 1024 * 1024 || evidenceBytes + bytes.length > 8 * 1024 * 1024) throw Error("Diagnostic evidence exceeded its fixed byte budget");
    const destination = join(diagnosticEvidenceDir, name);
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    evidenceBytes += bytes.length;
    report.diagnosticEvidence.files[name] = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  async function preserveValidatedRunnerLog(source, expected) {
    if (expected?.status !== "retained" || expected.file !== "source-build-runner.log"
      || !Number.isInteger(expected.bytes) || expected.bytes < 0 || expected.bytes > 65536
      || typeof expected.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(expected.sha256)) {
      throw Error("Runner log lacks validated native producer metadata");
    }
    const metadata = await lstat(source);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 65536 || metadata.size !== expected.bytes) {
      throw Error("Runner log does not match its fixed native byte bound");
    }
    const bytes = await readFile(source);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== metadata.size || bytes.length !== expected.bytes || sha256 !== expected.sha256
      || evidenceBytes + bytes.length > 8 * 1024 * 1024) {
      throw Error("Runner log does not match its fixed native hash and length");
    }
    const name = "source-build-runner.log";
    await writeFile(join(diagnosticEvidenceDir, name), bytes, { flag: "wx", mode: 0o600 });
    evidenceBytes += bytes.length;
    report.diagnosticEvidence.files[name] = { bytes: bytes.length, sha256 };
  }
  async function verifyRustEntryHtml() {
    const path = join(diagnosticEvidenceDir, "entry.html");
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4 * 1024 * 1024) throw Error("Rust entry HTML evidence is not a bounded regular file");
    const bytes = await readFile(path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const expected = report.native?.server?.entryHtmlEvidence;
    if (bytes.length !== metadata.size || metadata.size > 4 * 1024 * 1024 || evidenceBytes + bytes.length > 8 * 1024 * 1024
      || expected?.stored !== true || expected.byteLength !== bytes.length || expected.sha256 !== sha256 || expected.servedFromSameBytes !== true) {
      throw Error("Rust-generated entry HTML does not match its served-byte evidence");
    }
    evidenceBytes += bytes.length;
    report.diagnosticEvidence.files["entry.html"] = { bytes: bytes.length, sha256 };
  }
  try {
    probeDiagnostics.transition("fixture_setup");
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await mkdir(diagnosticEvidenceDir, { recursive: false, mode: 0o700 });
    evidenceDirCreated = true;
    environment = await createPanelFixtureEnvironment(root);
    report.environment = environment.evidence;
    scratch = await mkdtemp("/private/tmp/atools-source-build-native-");
    if (parsed.profile === "application-uninstaller") {
      report.baselineEvidence = await fingerprintFile("/private/tmp/atools-batch70-source-build-check/baseline-v1.json");
      report.originalBuildEvidence = {
        exitCode: Number((await readFile("/private/tmp/atools-batch70-source-build-check/original-build-node24.exit", "utf8")).trim()),
        log: await fingerprintFile("/private/tmp/atools-batch70-source-build-check/original-build-node24.log"),
      };
    }
    probeDiagnostics.transition("source_fingerprint");
    report.sourceHashesBefore = await sources();
    const cohort = join(scratch, "plugins"); await mkdir(cohort, { mode: 0o700 });
    probeDiagnostics.transition("package_prepare");
    if (parsed.profile === "application-uninstaller") {
      report.realPackageSourceBefore = await sourcePackageManifest(parsed.sourceRoot);
      report.packages = await prepareApplicationUninstallerPackage({ cohort, sourceRoot: parsed.sourceRoot, repoRoot: root });
    } else {
      report.packages = await createSourceBuildPackages(root, cohort, parsed.profile);
    }
    report.cohortSourceTreeHashBefore = await fixtureSourceTreeHash(cohort);
    const bundle = join(scratch, "panel");
    probeDiagnostics.transition("vite_build");
    await build({ configFile: false, root, logLevel: "error", plugins: [svelte({ emitCss: false, compilerOptions: { css: "injected" } })],
      build: { outDir: bundle, target: "safari14", minify: "esbuild", cssCodeSplit: false,
      lib: { entry: join(candidateRoot, "tests/components/nativeSourceBuildSmoke.ts"), formats: ["iife"], name: "NativeSourceBuild", fileName: () => "panel.js" },
        rollupOptions: { output: { inlineDynamicImports: true } } } });
    const css = join(scratch, "panel.css");
    await writeFile(css, (await Promise.all((await readdir(bundle)).filter(name => name.endsWith(".css")).map(name => readFile(join(bundle, name), "utf8")))).join("\n"));
    await preserveEvidenceFile(join(bundle, "panel.js"), "panel.js");
    await preserveEvidenceFile(css, "panel.css");
    probeDiagnostics.transition("cargo_build");
    const nativeExecutable = await buildNativeSmoke(root);
    probeDiagnostics.transition("native_app_stage");
    const app = await stageNativeSmokeApp(nativeExecutable, scratch, report.runId);
    report.application = app;
    const artifacts = { nativeExecutable: app.executable, applicationInfo: app.plistPath, panelJavaScript: join(bundle, "panel.js"), panelCss: css };
    report.artifactHashesBefore = Object.fromEntries(await Promise.all(Object.entries(artifacts).map(async ([key, path]) => [key, await fingerprintFile(path)])));
    probeDiagnostics.transition("pre_native_validation");
    report.preSpawnSourcesUnchanged = fingerprintsEqual(report.sourceHashesBefore, await sources());
    if (!report.preSpawnSourcesUnchanged) throw Error("Selected source changed during fixture build");
    const nativeOutput = join(scratch, "native.json");
    nativeStarted = true;
    probeDiagnostics.markNativeExecutionRequested();
    try { report.nativeProcess = await runNativeProcess(app.executable, ["--source-build-ui", join(bundle, "panel.js"), "--source-build-css", css,
      "--plugin-root", cohort, "--fixture-root", join(environment.root, "native-source-build"), "--diagnostic-evidence-dir", diagnosticEvidenceDir, "--output", nativeOutput,
      ...(["application-uninstaller", "synthetic-typescript"].includes(parsed.profile)
        ? ["--source-build-profile", parsed.profile] : [])],
      { cwd: root, env: environment.env, timeoutMs: 150000 });
      probeDiagnostics.transition("native_process_returned"); }
    catch (error) {
      report.nativeProcessFailed = true;
      report.failureObservation = probeDiagnostics.observeFailure(error);
    }
    probeDiagnostics.transition("evidence_validation");
    if (await exists(nativeOutput)) {
      report.native = JSON.parse(await readFile(nativeOutput, "utf8"));
      await preserveEvidenceFile(nativeOutput, "native-report.json");
      await verifyRustEntryHtml();
    } else report.nativeReportError = "No native report";
    const runnerLog = join(scratch, "source-build-runner.log");
    const runnerLogExpected = report.native?.server?.sourceBuildFailureEvidence;
    if (runnerLogExpected?.status === "retained") {
      await preserveValidatedRunnerLog(runnerLog, runnerLogExpected);
    } else if (await exists(runnerLog)) {
      // Never copy an unvalidated sidecar when the native report is absent or incomplete.
      throw Error("Source-build runner-log artifact has no validated native receipt");
    }
    report.artifactHashesAfter = Object.fromEntries(await Promise.all(Object.entries(artifacts).map(async ([key, path]) => [key, await fingerprintFile(path)])));
    report.sourceHashesAfter = await sources();
    report.sourcesUnchanged = fingerprintsEqual(report.sourceHashesBefore, report.sourceHashesAfter);
    report.artifactsUnchanged = fingerprintsEqual(report.artifactHashesBefore, report.artifactHashesAfter);
    report.cohortSourceTreeHashAfter = await fixtureSourceTreeHash(cohort);
    report.cohortSourceUnchanged = report.cohortSourceTreeHashAfter === report.cohortSourceTreeHashBefore;
    if (parsed.profile === "application-uninstaller") {
      report.realPackageSourceAfter = await sourcePackageManifest(parsed.sourceRoot);
      report.realPackageSourceUnchanged = JSON.stringify(report.realPackageSourceBefore) === JSON.stringify(report.realPackageSourceAfter);
    }
    report.passed = !report.nativeProcessFailed && report.native?.passed === true && report.native?.server?.cleanupSafe === true
      && report.sourcesUnchanged && report.artifactsUnchanged && report.cohortSourceUnchanged
      && (parsed.profile !== "application-uninstaller" || report.realPackageSourceUnchanged === true);
  } catch (error) {
    report.failureCode = report.failureCode ?? "source_build_probe_or_evidence_failed";
    report.failureObservation = probeDiagnostics.observeFailure(error);
  }
  finally {
    probeDiagnostics.transition("cleanup");
    const cleanupErrors = [];
    const nativeQuiescent = !nativeStarted || report.native?.server?.cleanupSafe === true;
    if (nativeQuiescent) {
      if (environment) {
        try {
          report.environmentCleanup = await environment.cleanup();
          if (report.environmentCleanup?.isolatedEnvironmentRemoved !== true || await exists(environment.root)) {
            cleanupErrors.push("environment_removal_unconfirmed");
          }
        }
        catch { cleanupErrors.push("environment_cleanup_failed"); }
      }
      if (scratch) {
        try {
          await rm(scratch, { recursive: true, force: true });
          report.scratchRemoved = !(await exists(scratch));
          if (!report.scratchRemoved) cleanupErrors.push("scratch_removal_unconfirmed");
        }
        catch { cleanupErrors.push("scratch_cleanup_failed"); }
      }
    } else {
      report.cleanupPreserved = { environment: environment?.root ?? null, scratch: scratch ?? null,
        reason: "Native worker quiescence is not confirmed; retained for recovery" };
      report.passed = false;
    }
    report.cleanupErrors = cleanupErrors;
    if (cleanupErrors.length) report.passed = false;
    if (environment && !nativeQuiescent) report.environmentPreserved = environment.root;
    report.diagnosticEvidence.directoryCreated = evidenceDirCreated;
    probeDiagnostics.transition("complete");
    report.finishedAt = new Date().toISOString();
    report.sourceBuildProbeDiagnostics = probeDiagnostics.snapshot();
    try {
      await mkdir(dirname(output), { recursive: true, mode: 0o700 });
      await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      reportWritten = true;
    } catch { reportWriteFailed = true; }
  }
  console.log(JSON.stringify({ output, passed: report.passed && !reportWriteFailed, failureCode: report.failureCode, nativeProcessFailed: report.nativeProcessFailed,
    native: report.native && { passed: report.native.passed, checks: Object.keys(report.native.frontend?.checks ?? {}).length } }));
  if (!report.passed || !reportWritten || reportWriteFailed) process.exitCode = 1;
  return report;
}
function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--execute") {
      if (values.has(key)) throw Error("Duplicate --execute");
      values.set(key, true); continue;
    }
    if (!["--output", "--profile", "--source-root"].includes(key) || index + 1 >= args.length || args[index + 1].startsWith("--")) {
      throw Error("Unsupported or incomplete source-build fixture arguments");
    }
    if (values.has(key)) throw Error("Duplicate source-build fixture argument");
    values.set(key, args[++index]);
  }
  const output = values.get("--output"), profile = values.get("--profile") ?? "synthetic";
  if (typeof output !== "string" || !isAbsolute(output) || values.get("--execute") !== true) {
    throw Error("Use --output ABSOLUTE_FRESH_REPORT --execute");
  }
  if (["synthetic", "synthetic-typescript"].includes(profile)) {
    if (values.has("--source-root")) throw Error("Synthetic profile does not accept a source root");
    return { output, profile };
  }
  const sourceRoot = values.get("--source-root");
  if (profile !== "application-uninstaller" || sourceRoot !== "/private/tmp/atools-batch70-source-build-check/application-uninstaller") {
    throw Error("Real source-build profile is limited to the pinned local package copy");
  }
  return { output, profile, sourceRoot };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

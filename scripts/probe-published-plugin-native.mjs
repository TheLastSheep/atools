import { access, mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { pluginDisplaySourceFiles } from "./lib/plugin-display-source-binding.mjs";
import { activationObservationEnvironment } from "./lib/native-activation-observation.mjs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { buildNativeSmoke } from "./lib/native-smoke-process.mjs";
import { stageNativeSmokeApp } from "./lib/native-smoke-app-bundle.mjs";
import { createFixtureEnvironment } from "./lib/legacy-node-environment.mjs";
import { preparePublishedFixtureNodeRuntime } from "./lib/published-plugin-node-runtime.mjs";
import { requestedPublishedNodeBinaryPath, serializePublishedFixtureNodePathError } from "./lib/published-fixture-node-override.mjs";
import { assertNativeReportIdentity, assertReviewedFixture, publishedAcceptancePassed,
  readPublishedPluginProfile, profilePackageDigest } from "./lib/published-plugin-profile.mjs";
import { readConvertedSourceProfile, readConvertedSourceHandoff } from "./lib/converted-source-handoff.mjs";
import { deepReadTextEncodingArguments, validateDeepReadTextEncoding } from "./lib/deepread-text-encoding.mjs";
import { packageMaterialSourceWitness, verifyPublishedPackageMaterial } from "./lib/published-package-material-dispatch.mjs";
import { capturePanelSources, fingerprintFile, fingerprintsEqual } from "./lib/native-panel-source-binding.mjs";
import { observePublishedNativeProcess } from "./lib/published-plugin-native-process.mjs";
import { pluginDataSourceFiles } from "./lib/plugin-data-source-binding.mjs";
import { launcherSourceFiles } from "./lib/launcher-source-binding.mjs";
import { pluginPathsSourceFiles } from "./lib/plugin-paths-source-binding.mjs";
import { pluginDialogSourceFiles } from "./lib/plugin-dialog-source-binding.mjs";
import { validateNativeJsonUiInput } from "./lib/native-json-ui-input-evidence.mjs";
import { validateNativePlainUiInput } from "./lib/native-plain-text-ui-input-evidence.mjs";
import { nativeUiInputObservationSource } from "../tests/components/nativeUiInputTimeline.mjs";
import { publishedPluginProbeEnvironment } from "./lib/published-plugin-probe-env.mjs";

const root = resolve(new URL("../", import.meta.url).pathname);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const exists = async path => { try { await access(path); return true; } catch { return false; } };
const fixtureSources = ["scripts/probe-published-plugin-native.mjs", "scripts/lib/published-plugin-profile.mjs",
  "package.json", "scripts/lib/head-random-data-fixture.mjs", "scripts/test-head-random-data-fixture.mjs",
  "scripts/lib/local-native-fixture-dispatch.mjs", "scripts/test-local-native-fixture-dispatch.mjs",
  "scripts/lib/published-package-material-dispatch.mjs", "scripts/lib/published-package-material-dispatch.test.mjs",
  "scripts/lib/head-image-stitch-fixture.mjs", "scripts/test-head-image-stitch-fixture.mjs",
  "tests/fixtures/local-original-image-stitch-cases.json", "tests/fixtures/image-stitch-head-plugin.json",
  "src-tauri/src/legacy_runtime/desktop_smoke_image_stitch_fixture.rs", "src-tauri/src/legacy_runtime/published_fixture_image_stitch_profile.rs",
  "tests/components/native-original-image-stitch-frame-operations.test.ts", "tests/components/native-original-image-stitch-scenario.test.ts",
  "scripts/probe-local-original-plugin-native.mjs",
  "scripts/test-test-tiers.mjs", "tests/fixtures/local-original-random-data-cases.json",
  "tests/fixtures/random-data-head-plugin.json", "tests/components/native-original-random-data-adapter.test.ts",
  "tests/components/native-original-random-data-scenario.test.ts", "tests/components/nativeRandomDataObservation.ts",
  "src-tauri/src/legacy_runtime/desktop_smoke_random_data_data.rs",
  "src-tauri/src/legacy_runtime/published_fixture_random_data_profile.rs",
  "scripts/lib/published-plugin-node-runtime.mjs", "scripts/test-published-plugin-node-runtime.mjs",
  "scripts/lib/published-fixture-node-override.mjs", "scripts/test-published-plugin-node-override.mjs",
  "scripts/probe-local-original-plugin-native.mjs",
  "scripts/lib/local-plugin-fixture.mjs", "scripts/lib/head-calculation-paper-fixture.mjs", "scripts/test-head-calculation-paper-fixture.mjs", "scripts/test-head-calculation-paper-operations.mjs", "scripts/prepare-local-original-cohort.mjs",
  "tests/fixtures/local-original-plugin-cases.json", "src-tauri/src/legacy_runtime/local_package_verification.rs",
  "src-tauri/src/legacy_runtime/desktop_smoke_published_lifecycle_tests.rs",
  "src-tauri/examples/support/native_fixture_restoration.rs",
  "src-tauri/examples/support/native_fixture_launchservices.rs",
  "src-tauri/examples/support/native_fixture_launchservices/guard.rs",
  "src-tauri/examples/support/native_fixture_launchservices/lifecycle.rs",
  "src-tauri/examples/support/native_fixture_launchservices/process.rs",
  "src-tauri/examples/support/native_fixture_launchservices/protocol.rs",
  "src-tauri/examples/support/native_fixture_launchservices/stdio.rs",
  "tests/fixtures/local-original-input-cases.json", "tests/fixtures/local-original-mybatis-cases.json",
  "scripts/lib/local-original-registry.mjs", "scripts/test-local-original-registry.mjs",
  "scripts/lib/head-mybatis-fixture.mjs", "scripts/test-head-mybatis-fixture.mjs",
  "tests/components/nativeOriginalMybatisScenario.ts", "tests/components/nativeOriginalMybatisFrameOperations.js",
  "tests/components/native-original-mybatis-adapter.test.ts", "tests/components/native-original-mybatis-scenario.test.ts",
  "tests/fixtures/local-plain-text-cases.json", "tests/fixtures/local-subnet-calculator-cases.json",
  "src-tauri/src/legacy_runtime/desktop_smoke_original_plain_data.rs",
  "src-tauri/src/legacy_runtime/local_plain_subnet_verification_tests.rs",
  "tests/components/nativeOriginalPlainTextFrameOperations.js", "tests/components/nativeOriginalPlainTextScenario.ts",
  "tests/components/nativeOriginalSubnetFrameOperations.js", "tests/components/nativeOriginalSubnetScenario.ts",
  "tests/components/native-original-plain-text-adapter.test.ts", "tests/components/native-original-plain-text-scenario.test.ts",
  "tests/components/native-original-subnet-adapter.test.ts", "tests/components/native-original-subnet-scenario.test.ts",
  "scripts/test-local-plugin-fixture.mjs",
  "src-tauri/src/legacy_runtime/desktop_smoke_original_ascii_data.rs",
  "tests/components/nativeOriginalUuidFrameOperations.js", "tests/components/nativeOriginalUuidScenario.ts",
  "tests/components/nativeOriginalAsciiTreeFrameOperations.js", "tests/components/nativeOriginalAsciiTreeScenario.ts",
  "tests/components/native-original-uuid-adapter.test.ts", "tests/components/native-original-ascii-tree-adapter.test.ts",
  "tests/components/native-original-input-scenarios.test.ts",
  "tests/components/nativePublishedDialogPermission.ts", "tests/components/native-published-dialog-permission.test.ts",
  "tests/components/nativeDeepReadReviewedPermissionFlow.ts", "tests/components/nativeDeepReadLauncherReturn.ts",
  "tests/components/native-deepread-reviewed-permission-flow.test.ts", "tests/components/native-deepread-launcher-return.test.ts",
  "tests/components/native-deepread-disclaimer-adapter.test.ts",
  "tests/fixtures/local-original-archive-cases.json", "scripts/lib/local-original-archive-fixture.mjs",
  "scripts/test-local-original-archive-fixture.mjs", "scripts/test-local-original-native-args.mjs",
  "scripts/lib/local-original-run-finalization.mjs", "scripts/test-local-original-run-finalization.mjs",
  "src-tauri/src/legacy_runtime/local_archive_verification.rs",
  "src-tauri/src/legacy_runtime/published_fixture_profile.rs", "tests/components/nativeOriginalArchiveImport.ts",
  "tests/components/nativeOriginalCalculatorScenario.ts", "tests/components/nativeOriginalCalculatorFrameOperations.js",
  "tests/components/native-original-archive-import.test.ts", "tests/components/native-original-calculator-adapter.test.ts",
  "src-tauri/src/legacy_runtime/desktop_smoke_published_fixture_tests.rs",
  "scripts/lib/published-plugin-native-process.mjs", "scripts/lib/published-plugin-launchservices-observer.mjs",
  "scripts/lib/published-plugin-launchservices-processes.mjs", "scripts/lib/published-plugin-launchservices-cleanup-scope.mjs",
  "scripts/lib/published-plugin-launchservices-codec.mjs",
  "scripts/test-published-plugin-native-launch.mjs", "scripts/lib/native-smoke-process.mjs",
  "scripts/lib/native-smoke-descendants.mjs", "scripts/lib/legacy-node-environment.mjs", "scripts/lib/published-plugin-fixture.mjs",
  "tests/fixtures/published-plugin-cases.json", "tests/components/nativePublishedPluginSmoke.ts",
  "tests/fixtures/converted-source-cases.json", "tests/fixtures/converted-deepread-source-evidence-shape-v1.json",
  "scripts/lib/converted-source-handoff.mjs", "scripts/lib/deepread-text-encoding.mjs", "scripts/test-deepread-text-encoding.mjs",
  "tests/components/nativeDeepReadFixtureEvidence.ts", "tests/components/native-deepread-fixture-evidence.test.ts",
  "tests/components/native-deepread-scenario.test.ts",
  "tests/components/nativeDeepReadImportProjection.ts", "tests/components/native-deepread-import-projection.test.ts",
  "tests/components/nativeConvertedHandoff.ts", "tests/components/native-converted-source-handoff.test.ts",
  "tests/components/native-published-progress.test.ts",
  "tests/components/nativePublishedPluginScenario.ts", "tests/components/nativePublishedPluginCommon.ts",
  "tests/components/nativePublishedForegroundPrecondition.ts", "tests/components/native-published-foreground-precondition.test.ts",
  "tests/components/nativeLauncherReturnObservation.ts", "tests/components/native-launcher-return-observation.test.ts",
  "tests/components/nativePublishedPassiveFocusObservation.ts", "tests/components/native-published-passive-focus-observation.test.ts",
  "tests/components/nativePublishedRuntimeRequirement.ts",
  "tests/components/nativePublishedDisplayPermission.ts",
  "tests/components/native-published-display-permission.test.ts",
  "tests/components/native-deepread-display-permission.test.ts",
  "tests/components/nativeOriginalCalculatorFrameOperations.js", "tests/components/native-original-calculator-adapter.test.ts",
  "tests/components/nativePublishedPluginFrameProbe.js",
  "src-tauri/src/legacy_runtime/converted_handoff_host.rs", "src-tauri/src/legacy_runtime/converted_handoff_verification.rs",
  "src-tauri/src/legacy_runtime/converted_handoff_arguments.rs",
  "src-tauri/src/plugin_source_dependency_service/converted_package.rs", "src-tauri/src/plugin_source_dependency_service/tree_inventory.rs",
  "src-tauri/src/plugin_source_dependency_service/mod.rs", "src-tauri/src/plugin_source_build/mod.rs",
  "tests/components/nativePublishedPluginBusiness.ts", "tests/components/nativePublishedPluginFrameProbe.js",
  "scripts/lib/published-plugin-probe-env.mjs", "scripts/test-published-plugin-probe-env.mjs",
  "src/lib/launcherDesktopSmokeHost.ts", "src/lib/desktopSmokeDeepReadFilesActivationPort.ts",
  "src/lib/launcherWindowRuntimeHost.ts", "src/lib/launcherRuntimeLifecycle.ts", "src/lib/desktopSmokeOrchestration.ts",
  "tests/components/launcher-desktop-smoke-host-gate.test.ts",
  "tests/components/nativeDeepReadActivationDiagnostic.ts",
  "tests/components/native-deepread-activation-diagnostic.test.ts",
  "tests/components/native-deepread-activation-boundary.test.ts",
  "tests/components/nativeWorkerObservation.js", "scripts/test-native-worker-observation.mjs",
  "tests/components/native-original-json-editor-scenario.test.ts", "tests/components/native-original-json-editor-adapter.test.ts",
  "tests/components/nativeOriginalJsonUiInputScenario.ts", "tests/components/nativeJsonUiInputObservation.js",
  "scripts/lib/native-json-ui-input-evidence.mjs", "tests/components/native-json-ui-input.test.ts",
  "tests/components/nativeOriginalPlainTextUiInputScenario.ts", "tests/components/nativePlainTextUiInputObservation.js",
  "scripts/lib/native-plain-text-ui-input-evidence.mjs", "tests/components/native-plain-text-ui-input-observation.test.ts",
  "scripts/lib/native-ui-input-diagnostics.mjs", "scripts/lib/native-ui-input-diagnostics.d.mts",
  "tests/components/nativeUiInputDiagnosticTestFixture.ts", "tests/components/native-ui-input-diagnostics.test.ts",
  "tests/components/native-ui-input-event-context.test.ts",
  "tests/components/nativeUiInputTimeline.mjs", "tests/components/nativeUiInputTimeline.d.mts",
  "tests/components/native-ui-input-timeline.test.ts",
  "tests/components/nativeEditorInputAdmission.ts",
  "src-tauri/src/legacy_runtime/desktop_smoke_editor_input_exchange.rs",
  "src-tauri/src/legacy_runtime/desktop_smoke_keyboard_owner.rs",
  "tests/components/native-editor-input-admission.test.ts", "scripts/control-native-editor-input.py",
  "tests/components/native-ui-input-diagnostics-contract.test.ts", "tests/components/native-json-ui-input-scenario.test.ts",
  "scripts/lib/native-editor-input-source.swift", "scripts/lib/native-editor-fixed-input.applescript",
  "scripts/lib/native-editor-inspect.applescript",
  "scripts/test-native-editor-input-controller.mjs",
  "tests/components/native-plain-text-ui-input-scenario.test.ts", "tests/components/native-plain-text-ui-input-evidence.test.ts",
  "tests/components/nativeJsonEditorPreconditions.ts", "tests/components/native-json-editor-preconditions.test.ts",
  "tests/components/nativeOriginalJsonWorkerContract.js", "tests/components/nativeOriginalJsonWorkerContractScenario.ts",
  "tests/components/native-original-json-worker-contract-scenario.test.ts", "tests/components/published-frame-readiness.test.ts",
  "tests/components/native-original-json-worker-contract-client.test.ts",
  "scripts/test-plugin-browser-worker-bridge.mjs", "scripts/test-plugin-resource-html.mjs",
  "tests/components/plugin-worker-shutdown.test.ts", "tests/components/plugin-worker-document-lifecycle.test.ts",
  "src/lib/pluginSourceAnalysis.ts", "tests/components/plugin-public-path-analysis.test.ts", "scripts/test-published-plugin-profile.mjs",
  "src-tauri/src/legacy_runtime/desktop_smoke_published_plugin.rs", "src/App.svelte", "src/components/PluginPanel.svelte",
  "src-tauri/src/legacy_runtime/desktop_smoke_deepread_fixture.rs", "src-tauri/src/legacy_runtime/desktop_smoke_deepread_data.rs",
  "src-tauri/src/legacy_runtime/converted_source_evidence_verification.rs",
  "src-tauri/src/plugin_source_build/converted_source_registry.rs",
  "src-tauri/src/legacy_runtime/desktop_smoke_published_shutdown.rs",
  "src-tauri/src/legacy_runtime/mod.rs", "src-tauri/src/legacy_runtime/commands.rs",
  "src-tauri/src/legacy_runtime/sessions.rs", "src-tauri/src/legacy_runtime/intents.rs",
  "src-tauri/src/legacy_runtime/types.rs", "src-tauri/src/legacy_runtime/node_startup_diagnostic.rs",
  "src-tauri/src/legacy_runtime/native_node_startup_fixture.rs",
  "src-tauri/src/agent_tools.rs", "src-tauri/src/agent_tools/task_run_pipeline.rs",
  "src-tauri/src/agent_tools/node_startup_error_observation.rs", "src-tauri/src/agent_tools/tool_executor.rs",
  "crates/atools-plugin/src/sidecar/process_loop.rs",
  "src/components/ResultRow.svelte", "src/components/ResultsList.svelte", "src/lib/resultPresentation.ts",
  "src-tauri/src/legacy_runtime/published_package_verification.rs",
  "src-tauri/src/legacy_runtime/desktop_smoke_published_data.rs", "src-tauri/src/legacy_runtime/desktop_smoke_published_paths.rs",
  "src-tauri/src/lib.rs", "src-tauri/src/plugin_lifecycle.rs", "src-tauri/tauri.conf.json",
  "src/components/ZToolsImportPanel.svelte", "src/components/ZToolsImportResults.svelte",
  "src/components/ZToolsImportCandidateRow.svelte", "src/lib/ztoolsImportController.ts",
  "src/lib/ztoolsImportSelection.ts", "src/lib/ztoolsImportView.ts", "src/lib/pluginTypes.ts", "src/lib/types.ts",
  "src-tauri/src/ztools_import.rs", "src-tauri/src/plugin_mutations.rs",
  "crates/atools-plugin/src/package_resolution/mod.rs", "crates/atools-plugin/src/package_resolution/paths.rs",
  "src/lib/pluginResourceHtml.ts", "src/lib/pluginResourceLease.ts", "src/lib/pluginLifecycleBridge.ts", "src/lib/pluginRuntimePreload.ts", "src/lib/pluginEntryReadiness.ts",
  "src/lib/hostClipboardController.ts", "src/lib/pluginInvokePolicy.ts", "src/lib/pluginElectronAdapter.ts",
  "src/lib/pluginSystemShellBridge.ts", "tests/components/plugin-electron-adapter.test.ts",
  "scripts/test-plugin-system-shell-bridge.mjs"];
async function sourceHashes(profile) {
  const businessSources = (await readdir(join(root, "tests/components"))).filter(name => /^native(?:Published|Original)[A-Za-z]+Scenario\.ts$/.test(name)).sort();
  const backendSources = (await readdir(join(root, "src-tauri/src/plugin_asset_protocol"))).filter(name => name.endsWith(".rs")).sort();
  const importSources = (await readdir(join(root, "src-tauri/src/ztools_import"))).filter(name => name.endsWith(".rs")).sort();
  const files = [...new Set([...fixtureSources, ...launcherSourceFiles, ...await pluginDataSourceFiles(root), ...await pluginPathsSourceFiles(root), ...await pluginDialogSourceFiles(root), ...await pluginDisplaySourceFiles(root), profile.frameOperations, ...businessSources.map(name => "tests/components/" + name),
    ...backendSources.map(name => "src-tauri/src/plugin_asset_protocol/" + name),
    ...importSources.map(name => "src-tauri/src/ztools_import/" + name)])];
  const panelSources = await capturePanelSources(root);
  const selected = { ...Object.fromEntries(Object.entries(panelSources).map(([file, fingerprint]) => [file, fingerprint.sha256])),
    ...Object.fromEntries(await Promise.all(files.map(async file => [file, digest(await readFile(join(root, file)))]))) };
  for (const [relative, sha256] of packageMaterialSourceWitness(profile)) selected[relative] = sha256;
  return selected;
}

async function verifyPackage(fixture, profile, expected) {
  return (await verifyPublishedPackageMaterial(fixture, profile, expected)).verification;
}

async function artifactHashes(fixture) {
  return Object.fromEntries(await Promise.all(Object.entries({ panelJavaScript: join(fixture.bundle, "panel.js"),
    css: fixture.css, frameProbe: fixture.probe, nativeExecutable: fixture.executable,
    ...(fixture.appBundle ? { nativeApplicationInfo: fixture.appBundle.plistPath } : {}) })
    .map(async ([name, path]) => [name, await fingerprintFile(path)])));
}

async function buildFixture(scratch, profile, runId, { nativeUiInput = false } = {}) {
  const bundle = join(scratch, "panel"); await mkdir(bundle);
  await build({ configFile: false, ...publishedPluginProbeEnvironment(profile.caseId), logLevel: "error", root,
    plugins: [svelte({ emitCss: false, compilerOptions: { css: "injected" } })],
    build: { outDir: bundle, minify: "esbuild", target: "safari14", cssCodeSplit: false,
      lib: { entry: join(root, "tests/components/nativePublishedPluginSmoke.ts"), formats: ["iife"],
        name: "NativePublishedPluginSmoke", fileName: () => "panel.js" },
      rollupOptions: { output: { inlineDynamicImports: true } } } });
  const cssFiles = (await readdir(bundle)).filter(name => name.endsWith(".css")), css = join(scratch, "panel.css");
  await writeFile(css, (await Promise.all(cssFiles.map(file => readFile(join(bundle, file), "utf8")))).join("\n"));
  const probe = join(scratch, "published-frame-probe.js");
  // Package operations and common diagnostics are test-only additions; original source files stay untouched.
  await writeFile(probe, await readFile(join(root, "tests/components/nativeWorkerObservation.js"), "utf8") + "\n"
    + (nativeUiInput ? nativeUiInputObservationSource(await readFile(join(root, profile.caseId === "local-json-editor"
      ? "tests/components/nativeJsonUiInputObservation.js" : "tests/components/nativePlainTextUiInputObservation.js"), "utf8")) + "\n" : "")
    + (profile.caseId === "local-json-editor" ? await readFile(join(root, "tests/components/nativeOriginalJsonWorkerContract.js"), "utf8") + "\n" : "")
    + await readFile(join(root, profile.frameOperations), "utf8") + "\n"
    + await readFile(join(root, "tests/components/nativePublishedPluginFrameProbe.js"), "utf8"));
  const executable = await buildNativeSmoke(root);
  if (["local-json-editor", "local-plain-text"].includes(profile.caseId)) {
    const appBundle = await stageNativeSmokeApp(executable, scratch, runId);
    return { bundle, css, probe, executable: appBundle.executable, appBundle };
  }
  return { bundle, css, probe, executable };
}

async function nodeEnvironment(profile, environment, nodeRuntimeBinaryPath) {
  return preparePublishedFixtureNodeRuntime(profile, environment, root,
    nodeRuntimeBinaryPath === null ? {} : { nodeRuntimeBinaryPath });
}

export async function main(args = process.argv.slice(2), runtimeOptions = {}) {
  const flags = new Set(["--build-only", "--execute-reviewed-package", "--worker-contract-only", "--native-ui-input", "--require-foreground"]);
  const values = new Set(["--case", "--deepread-text-encoding", "--run-id", "--plugin-root", "--package-import-path", "--source-review", "--expected-sha256",
    "--converted-source-handoff", "--expected-handoff-sha256", "--output", "--native-launch-mode"]);
  const parsed = new Map();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (parsed.has(flag) || (!flags.has(flag) && !values.has(flag))) throw Error("Unknown or duplicate argument: " + flag);
    if (flags.has(flag)) parsed.set(flag, true);
    else { if (!args[i + 1] || args[i + 1].startsWith("--")) throw Error("Missing argument value: " + flag); parsed.set(flag, args[++i]); }
  }
  const buildOnly = parsed.has("--build-only"), profile = await readPublishedPluginProfile(parsed.get("--case"));
  const workerContractOnly = parsed.has("--worker-contract-only");
  const nativeUiInput = parsed.has("--native-ui-input");
  const requireForeground = parsed.has("--require-foreground");
  const nativeLaunchMode = parsed.get("--native-launch-mode") || "direct";
  const deepReadTextEncoding = validateDeepReadTextEncoding({ caseId: profile.caseId,
    value: parsed.get("--deepread-text-encoding"), executeReviewedPackage: parsed.has("--execute-reviewed-package"),
    buildOnly, workerContractOnly, nativeUiInput, nativeLaunchMode });
  const convertedSource = profile.sourceKind === "converted_handoff_directory";
  let convertedPinned = null, convertedManifestPath = null, convertedHandoffBefore = null;
  if (convertedSource) {
    const legacySourceFlags = ["--plugin-root", "--source-review", "--package-import-path", "--expected-sha256"];
    if (buildOnly || !parsed.has("--execute-reviewed-package") || workerContractOnly || nativeUiInput
      || nativeLaunchMode !== "direct" || legacySourceFlags.some(flag => parsed.has(flag))) {
      throw Error("Converted handoff case requires direct --execute-reviewed-package without legacy source inputs");
    }
    if (!parsed.has("--converted-source-handoff") || !parsed.has("--expected-handoff-sha256"))
      throw Error("Converted handoff case requires its manifest and explicit raw SHA-256 pin");
    const registered = await readConvertedSourceProfile(profile.caseId);
    convertedManifestPath = parsed.get("--converted-source-handoff");
    convertedHandoffBefore = await readConvertedSourceHandoff(convertedManifestPath,
      parsed.get("--expected-handoff-sha256"), profile, registered.handoff);
    convertedPinned = registered.handoff;
  } else if (parsed.has("--converted-source-handoff") || parsed.has("--expected-handoff-sha256")) {
    throw Error("Converted handoff arguments are reserved for registered converted source cases");
  }
  if (!["direct", "launchservices"].includes(nativeLaunchMode)) throw Error("Native launch mode must be direct or launchservices");
  if (requireForeground && (buildOnly || !parsed.has("--execute-reviewed-package") || workerContractOnly || nativeUiInput || nativeLaunchMode !== "direct"))
    throw Error("Foreground preconditions require direct reviewed-package UI execution without worker or native UI input modes");
  if (workerContractOnly && profile.caseId !== "local-json-editor") throw Error("Worker contract mode requires the registered JSON Editor case");
  if (nativeUiInput && (!["local-json-editor", "local-plain-text"].includes(profile.caseId) || workerContractOnly)) throw Error("Native UI input requires a registered editor and excludes worker-only mode");
  if (nativeLaunchMode === "launchservices" && (!nativeUiInput || !["local-json-editor", "local-plain-text"].includes(profile.caseId) || workerContractOnly))
    throw Error("LaunchServices mode requires native-ui-input for a registered plain/json editor case");
  const nodeRuntimeBinaryPath = requestedPublishedNodeBinaryPath(runtimeOptions, profile, {
    executeReviewedPackage: parsed.has("--execute-reviewed-package"), buildOnly,
    workerContractOnly, nativeUiInput, nativeLaunchMode,
  });
  const expected = convertedSource ? profilePackageDigest(profile) : parsed.get("--expected-sha256") || profilePackageDigest(profile);
  const output = resolve(parsed.get("--output") || join(root, "output/legacy-node-2026-10-15/production-" + profile.caseId + "-native.json"));
  if (expected !== profilePackageDigest(profile)) throw Error("Expected SHA is not the registered package pin");
  if (await exists(output)) throw Error("Preserve earlier evidence; choose a fresh output path");
  let review = null, packageFixture = null, pluginRoot = null, sourceReview = null, verifiedPackageFiles = [];
  if (!buildOnly) {
    if (!parsed.has("--execute-reviewed-package") || (!convertedSource && (!parsed.has("--plugin-root") || !parsed.has("--source-review"))))
      throw Error("Native execution requires --execute-reviewed-package, explicit --plugin-root and --source-review");
    if (!convertedSource) {
      if (profile.sourceKind === "local_original_archive" && !parsed.has("--package-import-path")) throw Error("Original archive execution requires --package-import-path pointing to the retained .zpx copy");
      if (profile.sourceKind !== "local_original_archive" && parsed.has("--package-import-path")) throw Error("--package-import-path is reserved for the registered original ZPX case");
      pluginRoot = resolve(parsed.get("--plugin-root")); sourceReview = resolve(parsed.get("--source-review"));
      review = JSON.parse(await readFile(sourceReview, "utf8")); packageFixture = review.fixture;
      if (review.status !== profile.sourceReviewStatus) throw Error("Source review is not prepared for explicit native decision");
      assertReviewedFixture(profile, packageFixture, pluginRoot, expected);
      if (profile.sourceKind === "local_original_archive"
        && resolve(parsed.get("--package-import-path")) !== resolve(packageFixture.packageImportPath)) {
        throw Error("Native package import path must be the reviewed retained .zpx copy");
      }
      const { verification: verified, files } = await verifyPublishedPackageMaterial(packageFixture, profile, expected);
      if (!verified.sourceBytesUnchanged || verified.unchangedFileCount !== profile.fileCount) throw Error("Pinned package verification failed");
      verifiedPackageFiles = [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: digest(bytes) }));
    }
  }
  const runId = parsed.get("--run-id") || randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) throw Error("Invalid native run identity");
  const sourceHashesBefore = await sourceHashes(profile);
  const scratch = await mkdtemp(join(tmpdir(), "atools-published-plugin-build-"));
  let isolated, nativeFixture, inputExchangeRoot = null, report = { schemaVersion: 3, runId, profile, sourceKind: profile.sourceKind || "official_published_archive", packageSha256: expected, buildOnly, nativeLaunchMode,
    executionMode: workerContractOnly ? "original_worker_contract" : "original_ui",
    inputMethod: nativeUiInput ? "external_os_ui_control_with_trusted_event_assertions" : "fixture_operations",
    nativeRuntimeExecuted: false, passed: false, acceptanceScope: workerContractOnly
      ? "Original JSON Worker protocol and algorithms in the real plugin host; no editor input/formatting UI acceptance"
      : "Only registered case assertions; fixture checks do not establish complete plugin business coverage or market installation", status: "preparing", sourceHashesBefore };
  report.sourceHashScope = "Selected fixture and production entry/resource/runtime/permission sources; not a complete compiler dependency closure";
  if (convertedSource) report.conversionSourceProvenance = { handoffManifestSha256: convertedHandoffBefore.manifestSha256,
    sourceRevision: convertedHandoffBefore.identity.sourceRevision,
    receiptStatesSourceFilesUnchanged: true, businessUsabilityVerified: false,
    scope: "Pinned handoff provenance, not an observation of this native import" };
  let failure = null;
  try {
    isolated = await createFixtureEnvironment();
    nativeFixture = await buildFixture(scratch, profile, runId, { nativeUiInput });
    report.artifactHashesBefore = await artifactHashes(nativeFixture);
    const environment = { ...isolated.env };
    inputExchangeRoot = nativeUiInput ? await mkdtemp("/private/tmp/atools-native-editor-exchange-") : null;
    if (inputExchangeRoot) {
      environment.ATOOLS_NATIVE_EDITOR_INPUT_EXCHANGE = inputExchangeRoot;
    }
    const activation = activationObservationEnvironment({ environment,
      requestedMode: process.env.ATOOLS_PANEL_ACTIVATION_OBSERVATION,
      nativeUiInput,
      stagedBundleId: nativeFixture.appBundle?.bundleId,
    });
    for (const key of Object.keys(environment)) delete environment[key];
    Object.assign(environment, activation.environment);
    if (activation.enabled) {
      report.inputMethod = "no_external_input_read_only_activation_observation";
      report.activationObservationScope = activation.reportScope;
    }
    environment.ATOOLS_PANEL_FOREGROUND_MODE = requireForeground || ["local-json-editor", "local-plain-text"].includes(profile.caseId) ? "required" : "observe";
    if (nativeFixture.appBundle) report.application = { isolated: true, identity: nativeFixture.appBundle.bundleId,
      executableCopyHashMatches: nativeFixture.appBundle.sourceExecutableSha256 === nativeFixture.appBundle.stagedExecutableSha256 };
    const node = await nodeEnvironment(profile, environment, nodeRuntimeBinaryPath);
    const evidence = { fixture: convertedSource ? "retained converted source package isolated native Wry" : "reviewed original plugin isolated native Wry", sourceKind: report.sourceKind, node,
      expectedPackageSha256: expected, archiveSha256: packageFixture?.archiveSha256 ?? null,
      sourceReview: convertedSource ? null : sourceReview, sourceReviewSha256: sourceReview ? digest(await readFile(sourceReview)) : null,
      ...(convertedSource ? { handoffManifestSha256: convertedHandoffBefore.manifestSha256,
        dependencySetIdSha256: convertedHandoffBefore.identity.dependencySetIdSha256,
        installedPackageTreeSha256: convertedHandoffBefore.identity.installedPackageTreeSha256 } : {}),
      verifiedFileHashes: verifiedPackageFiles,
      environmentKeys: Object.keys(environment).sort(), ambientEnvironmentInherited: false,
      processEnvironmentNotMutated: true, packageOrigin: convertedSource ? "rust_validated_converted_handoff" : "explicit_reviewed_root",
      pluginRootExplicitAndSingular: convertedSource ? false : !buildOnly };
    report.environment = evidence;
    if (buildOnly) { report.built = true; report.status = "built_only"; }
    else {
      // Never read the caller's publish path: only this run's owned fresh result path is accepted.
      const nativeControlDir = nativeLaunchMode === "launchservices" ? join(scratch, `launchservices-${runId}`) : null;
      const nativeOutput = nativeControlDir ? join(nativeControlDir, "native-result.json") : join(scratch, "native-result.json");
      // Build can take time. Recheck original ZIP and every source byte immediately before spawn;
      // Rust independently repeats this before GUI creation. This is not an OS sandbox.
    if (convertedSource) {
      const current = await readConvertedSourceHandoff(convertedManifestPath, parsed.get("--expected-handoff-sha256"), profile, convertedPinned);
      report.preSpawnConversionHandoff = { manifestSha256: current.manifestSha256, identity: current.identity };
      report.handoffManifestPinUnchanged = current.manifestSha256 === convertedHandoffBefore.manifestSha256;
    } else report.preSpawnSourceVerification = await verifyPackage(packageFixture, profile, expected);
      if (nativeFixture.appBundle) console.log(JSON.stringify({ temporaryApplication: {
        runId, bundlePath: nativeFixture.appBundle.bundlePath, bundleId: nativeFixture.appBundle.bundleId,
        ...(inputExchangeRoot ? { inputExchangeRoot } : {}),
      } }));
      report.nativeProcess = await observePublishedNativeProcess(nativeFixture.executable,
        ["--published-plugin-panel-ui", "--published-case", profile.caseId, "--run-id", runId,
          ...(workerContractOnly ? ["--worker-contract-only"] : []),
          ...(nativeUiInput ? ["--native-ui-input"] : []),
          ...(requireForeground ? ["--require-foreground"] : []),
          ...deepReadTextEncodingArguments(deepReadTextEncoding),
          "--execute-reviewed-package", ...(convertedSource
            ? ["--converted-source-handoff", convertedManifestPath, "--expected-handoff-sha256", parsed.get("--expected-handoff-sha256")]
            : ["--expected-sha256", expected, "--source-review", sourceReview]),
          "--panel-ui", join(nativeFixture.bundle, "panel.js"), "--panel-css", nativeFixture.css,
          "--panel-probe", nativeFixture.probe, ...(!convertedSource ? ["--plugin-root", pluginRoot] : []),
          ...(profile.sourceKind === "local_original_archive" ? ["--package-import-path", resolve(parsed.get("--package-import-path"))] : []),
          "--output", nativeOutput, "--fixture-root", join(scratch, "native-fixture")],
        { cwd: root, env: environment, timeoutMs: nativeUiInput ? 330000 : 90000, stdio: "inherit", sampleResources: profile.caseId === "local-json-editor",
          ...(nativeControlDir ? { launchServices: { controlDir: nativeControlDir, runId, caseId: profile.caseId,
            bundlePath: nativeFixture.appBundle.bundlePath, bundleId: nativeFixture.appBundle.bundleId,
            executablePath: nativeFixture.executable, targetEnv: environment, nativeReportPath: nativeOutput,
            expectedPackageSha256: expected, verifiedFileHashes: verifiedPackageFiles,
            timeoutMs: nativeUiInput ? 330000 : 90000 } } : {}) });
      if (nativeLaunchMode === "launchservices") {
        report.environment.ambientEnvironmentInherited = "unknown";
        report.environment.launchServicesEnvironment = report.nativeProcess.targetEnvironmentObservation ?? {
          requestedEnvironmentKeys: Object.keys(environment).sort(),
          requestedEnvironmentKeysComplete: false,
          ambientEnvironmentInheritance: "unknown",
          systemMayAddVariables: true,
          environmentValuesLogged: false,
          additionalEnvironmentNamesLogged: false,
        };
      }
      report.nativeRuntimeExecuted = nativeLaunchMode === "launchservices"
        ? report.nativeProcess.targetPid !== null : report.nativeProcess.pid !== null;
      let nativeReport;
      try { nativeReport = JSON.parse(await readFile(nativeOutput, "utf8")); assertNativeReportIdentity(nativeReport, profile, runId, report.executionMode); }
      catch (error) { report.nativeReportError = String(error); failure = error; }
      if (nativeReport) {
        report.nativeReport = nativeReport;
        if (nativeUiInput) report.nativeUiInputEvidence = profile.caseId === "local-json-editor"
          ? validateNativeJsonUiInput(nativeReport) : validateNativePlainUiInput(nativeReport);
        report.nativeAssertionsPassed = nativeReport.passed === true && (!nativeUiInput || report.nativeUiInputEvidence.passed);
        report.taskRunCount = nativeReport.taskRunCount;
      }
      report.reportFreshness = { source: "unique per-run owned scratch path plus native and frontend runId/profile/SHA validation",
        runId, callerPublishPathNotRead: true, identityValidated: !report.nativeReportError };
      try {
        if (convertedSource) {
          const current = await readConvertedSourceHandoff(convertedManifestPath, parsed.get("--expected-handoff-sha256"), profile, convertedPinned);
          const same = current.manifestSha256 === convertedHandoffBefore.manifestSha256;
          report.postRunConversionHandoff = { manifestSha256: current.manifestSha256, identity: current.identity };
          report.handoffManifestPinUnchanged = report.handoffManifestPinUnchanged === true && same;
          report.convertedPackageTreeVerifiedBeforeExecution =
            nativeReport?.preExecutionSourceVerification?.convertedPackageTreeVerifiedBeforeExecution === true;
          report.conversionSourceProvenanceUnchanged =
            nativeReport?.preExecutionSourceVerification?.conversionSourceProvenanceUnchanged === true;
          report.postRunConvertedTargetVerification = nativeReport?.observations?.postRunConvertedTargetVerification ?? null;
          report.postRunSourceVerification = { convertedPackageTreeVerifiedBeforeExecution: report.convertedPackageTreeVerifiedBeforeExecution,
            conversionSourceProvenanceUnchanged: report.conversionSourceProvenanceUnchanged,
            verificationScope: "Native no-follow verification of the retained converted package tree and source provenance; no original-source or dependency-tree rescan" };
        } else {
          const verified = await verifyPackage(packageFixture, profile, expected);
          delete verified.noPluginCodeExecuted;
          report.postRunSourceVerification = { ...verified, staticVerificationExecutedPackageCode: false,
            verificationScope: "Byte verification only; separate native assertions executed explicitly approved original plugin UI" };
          report.sourceBytesUnchanged = verified.sourceBytesUnchanged;
        }
      } catch (error) {
        if (convertedSource) report.postRunSourceVerification = { verified: false,
          verificationScope: "Converted handoff pin or retained package-tree verification failed" };
        else { report.sourceBytesUnchanged = false; report.postRunSourceVerification = { error: String(error) }; }
        failure ||= error;
      }
    }
  } catch (error) {
    failure = error;
    report.error = serializePublishedFixtureNodePathError(error)
      ?? String(error instanceof Error ? error.stack : error);
  }
  finally {
    const cleanup = { isolatedEnvironmentRemoved: false, scratchRemoved: false, editorExchangeRemoved: inputExchangeRoot === null, errors: [] };
    if (nativeFixture) try {
      report.artifactHashesAfter = await artifactHashes(nativeFixture);
      report.fixtureArtifactsUnchanged = fingerprintsEqual(report.artifactHashesBefore, report.artifactHashesAfter);
    } catch (error) { cleanup.errors.push(String(error)); report.fixtureArtifactsUnchanged = false; }
    if (isolated) try { await isolated.cleanup(); cleanup.isolatedEnvironmentRemoved = !await exists(isolated.root); }
    catch (error) { cleanup.errors.push(String(error)); }
    if (inputExchangeRoot) try { await rm(inputExchangeRoot, { recursive: true, force: true }); cleanup.editorExchangeRemoved = !await exists(inputExchangeRoot); }
    catch (error) { cleanup.errors.push(String(error)); }
    try { await rm(scratch, { recursive: true, force: true }); cleanup.scratchRemoved = !await exists(scratch); }
    catch (error) { cleanup.errors.push(String(error)); }
    report.cleanup = cleanup;
    report.sourceHashesAfter = await sourceHashes(profile);
    report.fixtureSourcesUnchanged = JSON.stringify(sourceHashesBefore) === JSON.stringify(report.sourceHashesAfter);
    report.passed = publishedAcceptancePassed(report) && cleanup.editorExchangeRemoved;
    report.finishedAt = new Date().toISOString();
    if (!buildOnly) report.status = report.passed ? "passed" : "failed";
    await mkdir(resolve(output, ".."), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n", {flag:"wx",mode:0o600});
  }
  console.log(JSON.stringify({ output, runId, caseId: profile.caseId, status: report.status, passed: report.passed,
    buildOnly, nativeRuntimeExecuted: report.nativeRuntimeExecuted, nativeProcess: report.nativeProcess, cleanup: report.cleanup }, null, 2));
  if (failure || (!buildOnly && !report.passed) || !report.cleanup.scratchRemoved || !report.cleanup.isolatedEnvironmentRemoved || !report.cleanup.editorExchangeRemoved)
    throw failure || Error("Published plugin fixture failed; inspect current-run report");
  return report;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();

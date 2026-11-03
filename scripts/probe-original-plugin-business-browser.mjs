import assert from "node:assert/strict";
import { mkdir, access } from "node:fs/promises";
import { dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { captureOriginalBrowserSources, captureOriginalPackages } from "./lib/original-plugin-browser-sources.mjs";
import { runOriginalBusinessBrowser } from "./lib/original-plugin-browser-runtime.mjs";
import { writeLauncherBrowserReport } from "./lib/launcher-menu-browser-report.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function parseOriginalBrowserArgs(args) {
  const validateOnly = args[0] === "--validate-only", values = validateOnly ? args.slice(1) : args;
  assert.equal(values.length, 1, "Usage: node scripts/probe-original-plugin-business-browser.mjs [--validate-only] <new-output.json>");
  assert.ok(values[0] && !values[0].startsWith("-") && values[0].endsWith(".json"), "One new JSON output path required");
  const outputPath = resolve(values[0]), rel = relative(root, outputPath);
  assert.ok(rel === ".." || rel.startsWith(`..${sep}`), "Output must stay outside the repository");
  return { outputPath, validateOnly };
}
export async function originalBrowserMain(args) {
  let options, report;
  try {
    options = parseOriginalBrowserArgs(args);
    report = { schemaVersion: 1, status: "not_started", startedAt: new Date().toISOString(), outputPath: options.outputPath,
      scope: "Actual Chromium App→PluginPanel→unchanged complete original subnet-calculator, uuid-kit and image-stitch pages; trusted CDP controls plus explicit synthetic File/DataTransfer image input. Faithful detected Node hint and real current Node protocol for image; native permission/session lookup are explicit fixture-preapproved service doubles",
      notProven: ["native Rust activation/permission/TaskRun", "OS pointer/keyboard/IME", "WebKit", "clipboard", "competitor comparison", "all plugin functions", "native document-mode isolation", "packaged Node runtime and original image-stitch fs save path"],
      selectedInputsAreCompleteDependencyClosure: false, sourceBinding: {}, originalPackages: {} };
    await access(options.outputPath).then(() => { throw Error("Output already exists; refusing overwrite"); }, error => { if (error.code !== "ENOENT") throw error; });
    report.sourceBinding.before = await captureOriginalBrowserSources(root);
    report.originalPackages.before = await captureOriginalPackages(root);
    if (options.validateOnly) { report.status = "validated_only"; console.log(JSON.stringify(report, null, 2)); return 0; }
    await mkdir(dirname(options.outputPath), { recursive: true });
    let failure;
    try { await runOriginalBusinessBrowser({ root, port: 15134, report, screenshotPath: options.outputPath + ".png" }); }
    catch (error) { failure = error; }
    try {
      report.sourceBinding.after = await captureOriginalBrowserSources(root);
      report.sourceBinding.stable = report.sourceBinding.before.sha256 === report.sourceBinding.after.sha256;
      assert.equal(report.sourceBinding.stable, true, "Selected App/PluginPanel/browser source inputs changed during run");
    } catch (error) { failure ||= error; report.finalizationError = { name: error.name, message: error.message, stack: error.stack }; }
    try {
      report.originalPackages.after = await captureOriginalPackages(root);
      report.originalPackages.stable = JSON.stringify(report.originalPackages.before) === JSON.stringify(report.originalPackages.after);
      assert.equal(report.originalPackages.stable, true, "Original full directories changed during run");
    } catch (error) { failure ||= error; report.originalFinalizationError = { name: error.name, message: error.message, stack: error.stack }; }
    report.finishedAt = new Date().toISOString(); report.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
    report.status = failure ? "failed" : "passed";
    if (failure && !report.error) report.error = { name: failure.name, message: failure.message, stack: failure.stack };
    await writeLauncherBrowserReport(report, options.outputPath);
    console.log(JSON.stringify({ status: report.status, checks: report.checks?.length || 0, sourceStable: report.sourceBinding.stable,
      originalsStable: report.originalPackages.stable, cleanup: report.cleanup?.allOwnedResourcesClean, outputPath: report.outputFallbackPath || options.outputPath }));
    return report.status === "passed" ? 0 : 1;
  } catch (error) {
    if (report && options && !options.validateOnly) {
      report.status = "failed_setup_or_finalization"; report.finishedAt = new Date().toISOString();
      report.setupOrFinalizationError = { name: error.name, message: error.message, stack: error.stack };
      try { await writeLauncherBrowserReport(report, options.outputPath); } catch (writeError) { console.error(writeError.message); }
    }
    console.error(error.stack || error.message); return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await originalBrowserMain(process.argv.slice(2));

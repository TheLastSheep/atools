import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const scriptUrl = pathToFileURL(new URL("smoke-macos-release-app.mjs", import.meta.url).pathname).href;
const smoke = await import(scriptUrl);
const [appSource, libSource] = [
  readFileSync(new URL("../src/App.svelte", import.meta.url), "utf8"),
  readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
];

assert.match(appSource, /const hotkeyToggleAttemptCount = 5/);
assert.match(appSource, /"benchmark_main_window_toggle", \{ attempts: hotkeyToggleAttemptCount \}/);
assert.doesNotMatch(appSource, /await invoke\("hide_main_window"\);\s*const showDurations/);
assert.match(libSource, /commands::benchmark_main_window_toggle/);
assert.equal(
  appSource.indexOf("void runReleaseSmokeSequence();")
    < appSource.indexOf("appUpdater.scheduleStartupCheck()"),
  true,
);
assert.match(libSource, /release_smoke\.lock\(\)\.is_some\(\)[\s\S]*?window::show_main_window\(&handle\)\?/);
assert.match(libSource, /WindowEvent::Focused[\s\S]*?release_smoke_enabled[\s\S]*?if !release_smoke_enabled[\s\S]*?window\.hide\(\)/);

let progressReads = 0;
let progressWaits = 0;
let progressReports = 0;
const completedProgress = await smoke.waitForReleaseSmokeCompletion({
  pid: 123,
  reportPath: "/tmp/release-smoke.json",
  timeoutMs: 1000,
  pollMs: 100,
  isAlive: () => true,
  readProgress: () => {
    progressReads += 1;
    return progressReads >= 3
      ? { completed: true, agent_page_opened: true }
      : { completed: false, agent_page_opened: false };
  },
  wait: async () => {
    progressWaits += 1;
  },
  onProgress: () => {
    progressReports += 1;
  },
});
assert.equal(completedProgress.completed, true);
assert.equal(completedProgress.agent_page_opened, true);
assert.equal(progressReads, 3);
assert.equal(progressWaits, 2);
assert.equal(progressReports, 3);

let incompleteReads = 0;
const incompleteProgress = await smoke.waitForReleaseSmokeCompletion({
  pid: 456,
  reportPath: "/tmp/release-smoke-incomplete.json",
  timeoutMs: 250,
  pollMs: 100,
  isAlive: () => true,
  readProgress: () => ({ completed: false, sequence: ++incompleteReads }),
  wait: async () => {},
});
assert.equal(incompleteProgress.completed, false);
assert.equal(incompleteProgress.sequence, 3);

const output = [
  "preflight",
  'ATOOLS_MACOS_RELEASE_APP_SMOKE {"status":"warn","summary":{"ok":4,"warn":2,"error":0},"checks":[{"id":"app-bundle","status":"ok","message":"bundle exists"},{"id":"release-smoke-progress","status":"warn","message":"release smoke report could not be read: no report was available"}]}',
  "done",
].join("\n");
const parsed = smoke.parseReleaseAppSmokeOutput(output);
assert.equal(parsed.status, "warn");
assert.equal(parsed.summary.ok, 4);
assert.equal(parsed.checks[0].id, "app-bundle");
assert.throws(() => smoke.parseReleaseAppSmokeOutput("missing"), /Missing ATOOLS_MACOS_RELEASE_APP_SMOKE/);

const root = mkdtempSync(join(tmpdir(), "atools-release-app-smoke-"));
const appPath = join(root, "ATools 3.0.app");
const contentsPath = join(appPath, "Contents");
const macosPath = join(contentsPath, "MacOS");
mkdirSync(macosPath, { recursive: true });
writeFileSync(
  join(contentsPath, "Info.plist"),
  [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<plist version=\"1.0\"><dict>",
    "<key>CFBundleExecutable</key>",
    "<string>ATools 3.0</string>",
    "<key>CFBundleIdentifier</key>",
    "<string>dev.atools.desktop</string>",
    "</dict></plist>",
  ].join("")
);
const executablePath = join(macosPath, "ATools 3.0");
writeFileSync(executablePath, "#!/bin/sh\nsleep 1\n");
chmodSync(executablePath, 0o755);

const bundle = smoke.inspectAppBundle(appPath);
assert.equal(bundle.ok, true);
assert.equal(bundle.executable_path, executablePath);
assert.equal(bundle.bundle_identifier, "dev.atools.desktop");

const adHocSignature = smoke.classifyCodesignResult({
  status: 0,
  output: "Executable=/tmp/ATools 3.0.app/Contents/MacOS/ATools 3.0\nSignature=adhoc\nIdentifier=dev.atools.desktop\n",
});
assert.equal(adHocSignature.status, "ok");
assert.equal(adHocSignature.signature, "adhoc");

const adHocSignatureCaps = smoke.classifyCodesignResult({
  status: 0,
  output:
    "Executable=/tmp/ATools 3.0.app/Contents/MacOS/ATools 3.0\nSignature=AdHoc\nIdentifier=dev.atools.desktop\n",
});
assert.equal(adHocSignatureCaps.status, "ok");
assert.equal(adHocSignatureCaps.signature, "AdHoc");

const rejectedGatekeeper = smoke.classifySpctlResult({
  status: 3,
  output: "/tmp/ATools 3.0.app: rejected\nsource=no usable signature\n",
});
assert.equal(rejectedGatekeeper.status, "warn");
const localAdhocGatekeeper = smoke.classifySpctlResult({
  status: 3,
  output: "/tmp/ATools 3.0.app: rejected\nsource=no usable signature\ncode has no resources but signature indicates they must be present\n",
});
const longOutput = `${"x".repeat(500)}\nsource=no usable signature\n${"y".repeat(260)} code has no resources but signature indicates they must be present\n`;
const truncatedAdhocGatekeeper = smoke.classifySpctlResult({
  status: 3,
  output: longOutput,
});
assert.equal(truncatedAdhocGatekeeper.status, "warn");
assert.equal(truncatedAdhocGatekeeper.output_preview.length <= 240, true);
assert.equal(truncatedAdhocGatekeeper.output.length > 240, true);
assert.equal(
  smoke.isKnownLocalAdhocGatekeeperWarning(localAdhocGatekeeper, adHocSignature),
  true
);
assert.equal(
  smoke.isKnownLocalAdhocGatekeeperWarning(localAdhocGatekeeper, adHocSignatureCaps),
  true
);
assert.equal(
  smoke.isKnownLocalAdhocGatekeeperWarning(truncatedAdhocGatekeeper, adHocSignature),
  true
);
assert.equal(
  smoke.isKnownLocalAdhocGatekeeperWarning(rejectedGatekeeper, adHocSignature),
  false
);

const dualTargetRoot = mkdtempSync(join(tmpdir(), "atools-release-app-default-path-"));
const rootTargetApp = join(dualTargetRoot, "target", "release", "bundle", "macos", "ATools 3.0.app");
const srcTauriTargetApp = join(dualTargetRoot, "src-tauri", "target", "release", "bundle", "macos", "ATools 3.0.app");
mkdirSync(rootTargetApp, { recursive: true });
mkdirSync(srcTauriTargetApp, { recursive: true });
assert.equal(smoke.defaultAppPath(dualTargetRoot), rootTargetApp);

const report = smoke.evaluateReleaseAppSmoke({
  appPath,
  bundle,
  launch: {
    open_status: 0,
    pid: 12345,
    stable_ms: 1200,
    terminated: true,
  },
  codesign: adHocSignature,
  spctl: rejectedGatekeeper,
  release_smoke: {
    option_z_toggled: true,
    hotkey_show_ms: 112.5,
    hotkey_toggle_attempt_count: 5,
    hotkey_toggle_success_count: 5,
    search_query: "calc",
    search_latency_ms: 24.75,
    search_result_count: 2,
    settings_page_opened: true,
    plugin_page_opened: true,
    agent_page_opened: true,
    clipboard_copy_tracked: true,
    plugin_activation_feature: "calc",
    plugin_activation_ms: 143.25,
    errors: [],
    completed: true,
  },
});
assert.equal(report.status, "warn");
assert.equal(report.checks.find((check) => check.id === "app-launch")?.status, "ok");
assert.equal(report.checks.find((check) => check.id === "first-launch-stability")?.status, "ok");
assert.equal(report.checks.find((check) => check.id === "gatekeeper-assess")?.status, "warn");
assert.equal(report.checks.find((check) => check.id === "release-smoke-option-z")?.status, "ok");
assert.equal(report.checks.find((check) => check.id === "release-smoke-hotkey-latency")?.status, "ok");
assert.equal(report.checks.find((check) => check.id === "release-smoke-hotkey-repeat")?.status, "ok");
assert.equal(report.checks.find((check) => check.id === "release-smoke-search-latency")?.status, "ok");
assert.equal(report.checks.find((check) => check.id === "release-smoke-settings")?.status, "ok");
assert.equal(report.checks.find((check) => check.id === "release-smoke-plugin")?.status, "ok");
assert.equal(report.checks.find((check) => check.id === "release-smoke-agent")?.status, "ok");
assert.equal(report.checks.find((check) => check.id === "release-smoke-clipboard-task-run")?.status, "ok");
assert.equal(report.checks.find((check) => check.id === "release-smoke-plugin-activation")?.status, "ok");
assert.equal(
  smoke.shouldFailStrictMode(report, {
    strict: true,
    strictGatekeeper: false,
    spctlResult: localAdhocGatekeeper,
    codesignResult: adHocSignature,
  }),
  false
);
assert.equal(
  smoke.shouldFailStrictMode(
    {
      ...report,
      checks: [
        ...report.checks,
        { id: "release-smoke-progress", status: "warn", message: "synthetic warning for strict" },
      ],
    },
    {
      strict: true,
      strictGatekeeper: false,
      spctlResult: localAdhocGatekeeper,
      codesignResult: adHocSignature,
    }
  ),
  true
);
assert.equal(
  smoke.shouldFailStrictMode(report, {
    strict: true,
    strictGatekeeper: true,
    spctlResult: localAdhocGatekeeper,
    codesignResult: adHocSignature,
  }),
  true
);

const impossibleStability = smoke.evaluateReleaseAppSmoke({
  appPath,
  bundle,
  launch: {
    open_status: 1,
    stable_ms: 1200,
    terminated: true,
  },
  codesign: adHocSignature,
  spctl: rejectedGatekeeper,
});
assert.equal(impossibleStability.checks.find((check) => check.id === "first-launch-stability")?.status, "error");

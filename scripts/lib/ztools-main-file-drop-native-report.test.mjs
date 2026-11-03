import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  MAIN_FILE_DROP_REPORT_LIMIT_BYTES,
  captureMainFileDropNativeReport,
  catalogMainFileDropProbeEnvironment,
  finalizeCatalogMainDropResources,
  mainFileDropProbeAllowsCleanup,
  validateMainFileDropNativeReport,
} from "./ztools-main-file-drop-native-report.mjs";
import { buildCatalogNativeArgs, parseCatalogNativeArgs } from "../test-ztools-catalog-native.mjs";

const RUN_ID = "0123456789abcdef0123456789abcdef";
const PID = 4242;
const ROOT = `/private/tmp/atools-renderer-catalog-${RUN_ID}`;
const EXPECTED = {
  schemaVersion: 1,
  kind: "renderer-main-file-drop",
  inputSource: "rust-injected-native-drop",
  contextObservation: "accepted-updateLaunchContext-call",
  runId: RUN_ID,
  pid: PID,
  root: ROOT,
  passed: true,
  errors: [],
  stagesCompleted: ["registered", "injected", "main-observed", "input-restored", "disposed"],
  observed: {
    targetRegistered: true,
    nativeDropAccepted: true,
    metadataFiles: 2,
    mainChipCount: 1,
    mainFileCount: 2,
    chipNames: ["file.txt"],
    launchContextQuery: "",
    launchContextFiles: [
      { relativePath: "r77-main-drop/file.txt", name: "file.txt", isDirectory: false },
      { relativePath: "r77-main-drop/folder", name: "folder", isDirectory: true },
    ],
    inputBefore: { query: "ATools Catalog", files: [] },
    inputAfterRestore: { query: "ATools Catalog", files: [] },
    targetRevoked: true,
    actualWorkers: 0,
    pendingBatches: 0,
  },
  guiAcceptance: "unverified",
  osDropAcceptance: "unverified",
};

const baseArgs = ["--binary", "/tmp/native", "--build-receipt", "/tmp/receipt.json"];

async function makeFixture(t) {
  const runId = randomUUID().replaceAll("-", "");
  const fixtureRoot = `/private/tmp/atools-renderer-catalog-${runId}`;
  const runDirectory = `/private/tmp/r77-main-drop-run-${runId}`;
  await mkdir(fixtureRoot, { mode: 0o700 });
  await mkdir(runDirectory, { mode: 0o700 });
  const inputRoot = join(fixtureRoot, "r77-main-drop");
  await mkdir(inputRoot, { mode: 0o700 });
  await writeFile(join(inputRoot, "file.txt"), "fixture metadata only", { mode: 0o600, flag: "wx" });
  await mkdir(join(inputRoot, "folder"), { mode: 0o700 });
  t.after(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(runDirectory, { recursive: true, force: true });
  });
  const report = structuredClone(EXPECTED);
  report.runId = runId;
  report.pid = process.pid;
  report.root = fixtureRoot;
  const reportPath = join(fixtureRoot, "main-drop-report.json");
  const writeReport = async value => writeFile(reportPath, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  const capture = (overrides = {}) => captureMainFileDropNativeReport({
    fixtureRoot,
    runDirectory,
    runId,
    pid: process.pid,
    processTerminal: true,
    ownerValidated: true,
    ...overrides,
  });
  return { fixtureRoot, runDirectory, inputRoot, runId, report, reportPath, writeReport, capture };
}

test("catalog probe flag is closed, default-off, and separate from Native argv", () => {
  const defaults = parseCatalogNativeArgs(baseArgs);
  assert.deepEqual(defaults, { binary: "/tmp/native", buildReceipt: "/tmp/receipt.json", windowDrag: false });
  assert.equal(defaults.mainFileDrop ?? false, false);
  assert.equal(parseCatalogNativeArgs([...baseArgs, "--main-file-drop", "true"]).mainFileDrop, true);
  assert.equal(parseCatalogNativeArgs([...baseArgs, "--main-file-drop", "false"]).mainFileDrop, false);
  for (const value of ["1", "TRUE", "yes"]) {
    assert.throws(() => parseCatalogNativeArgs([...baseArgs, "--main-file-drop", value]));
  }
  assert.throws(() => parseCatalogNativeArgs([...baseArgs, "--main-file-drop", "true", "--main-file-drop", "false"]));
  assert.throws(() => parseCatalogNativeArgs([...baseArgs, "--unlisted", "true"]));
  const nativeArgs = buildCatalogNativeArgs({ fixtureRoot: ROOT, rendererDist: "/tmp/dist", output: "/tmp/report", runId: RUN_ID });
  assert.equal(nativeArgs.includes("--main-file-drop"), false);
});

test("default env removes inherited opt-in; enabled env pins the exact value", () => {
  const inherited = { PATH: "/bin", ATOOLS_MAIN_DROP_PROBE: "untrusted-parent-value" };
  assert.deepEqual(catalogMainFileDropProbeEnvironment(inherited, false), { PATH: "/bin" });
  assert.deepEqual(catalogMainFileDropProbeEnvironment(inherited, true), { PATH: "/bin", ATOOLS_MAIN_DROP_PROBE: "1" });
  assert.throws(() => catalogMainFileDropProbeEnvironment([], false));
  assert.throws(() => catalogMainFileDropProbeEnvironment(inherited, "true"));
});

test("accepts the contract's literal closed report and rejects identity, key, array, stage, type, query, and worker drift", () => {
  assert.deepEqual(validateMainFileDropNativeReport(EXPECTED, { runId: RUN_ID, pid: PID, root: ROOT }), {
    valid: true, passed: true, errors: [],
  });
  const invalid = [
    ["source", report => { report.inputSource = "dom-drop"; }],
    ["context observation", report => { report.contextObservation = "attempted-call"; }],
    ["run id", report => { report.runId = "f".repeat(32); }],
    ["pid", report => { report.pid += 1; }],
    ["root", report => { report.root = "/private/tmp/other"; }],
    ["top-level key", report => { report.extra = true; }],
    ["observed key", report => { report.observed.extra = true; }],
    ["target registration", report => { report.observed.targetRegistered = false; }],
    ["native acceptance", report => { report.observed.nativeDropAccepted = false; }],
    ["metadata count", report => { report.observed.metadataFiles = 1; }],
    ["main chip count", report => { report.observed.mainChipCount = 2; }],
    ["main file badge", report => { report.observed.mainFileCount = 1; }],
    ["stage sequence", report => { report.stagesCompleted[2] = "main-ready"; }],
    ["chip array", report => { report.observed.chipNames.push("folder"); }],
    ["launch files", report => { report.observed.launchContextFiles.reverse(); }],
    ["file type", report => { report.observed.launchContextFiles[0].isDirectory = true; }],
    ["file key", report => { report.observed.launchContextFiles[0].path = "/tmp/other"; }],
    ["cleared query", report => { report.observed.launchContextQuery = "ATools Catalog"; }],
    ["restored input", report => { report.observed.inputAfterRestore.query = ""; }],
    ["input before", report => { report.observed.inputBefore.files.push("/tmp/user-file"); }],
    ["revoked target", report => { report.observed.targetRevoked = false; }],
    ["worker count", report => { report.observed.actualWorkers = 1; }],
    ["pending batch", report => { report.observed.pendingBatches = 1; }],
    ["stage missing", report => { report.stagesCompleted.pop(); }],
    ["reported native error", report => { report.errors.push("injected-error"); }],
    ["native failure", report => { report.passed = false; }],
    ["GUI overclaim", report => { report.guiAcceptance = "verified"; }],
  ];
  for (const [name, mutate] of invalid) {
    const report = structuredClone(EXPECTED);
    mutate(report);
    assert.equal(validateMainFileDropNativeReport(report, { runId: RUN_ID, pid: PID, root: ROOT }).valid, false, name);
  }
});

test("bounded no-follow capture copies raw report before validating it", async t => {
  const fixture = await makeFixture(t);
  const bytes = Buffer.from(JSON.stringify(fixture.report));
  await fixture.writeReport(fixture.report);
  const captured = await fixture.capture();
  assert.equal(captured.valid, true);
  assert.equal(captured.passed, true);
  assert.equal(captured.copyPath, "main-drop-report.json");
  assert.equal(captured.sizeBytes, bytes.byteLength);
  assert.deepEqual(await readFile(join(fixture.runDirectory, captured.copyPath)), bytes);
});

test("capture rejects wrong identity but retains bounded raw evidence", async t => {
  const fixture = await makeFixture(t);
  fixture.report.root = "/private/tmp/other-owned-root";
  await fixture.writeReport(fixture.report);
  const captured = await fixture.capture();
  assert.equal(captured.valid, false);
  assert.ok(captured.errors.includes("root-mismatch"));
  assert.equal(captured.copyPath, "main-drop-report.json");
  assert.deepEqual(await readFile(join(fixture.runDirectory, captured.copyPath)), Buffer.from(JSON.stringify(fixture.report)));
});

test("fixed fixture stats reject file and directory types that do not match", async t => {
  const fixture = await makeFixture(t);
  const filePath = join(fixture.inputRoot, "file.txt");
  const folderPath = join(fixture.inputRoot, "folder");
  await rm(filePath);
  await mkdir(filePath);
  await rm(folderPath, { recursive: true });
  await writeFile(folderPath, "not a directory", { mode: 0o600 });
  await fixture.writeReport(fixture.report);
  const captured = await fixture.capture();
  assert.equal(captured.valid, false);
  assert.ok(captured.errors.includes("fixed-input-file-type"));
  assert.ok(captured.errors.includes("fixed-input-directory-type"));
});

test("missing, oversized, symlinked, and nonterminal reports fail without unbounded reads", async t => {
  const missing = await makeFixture(t);
  const missingResult = await missing.capture();
  assert.equal(missingResult.exists, false);
  assert.ok(missingResult.errors.includes("report-missing"));
  assert.equal(await readFile(join(missing.runDirectory, "main-drop-report.json")).then(() => true, () => false), false);

  const oversized = await makeFixture(t);
  await writeFile(oversized.reportPath, Buffer.alloc(MAIN_FILE_DROP_REPORT_LIMIT_BYTES + 1), { mode: 0o600 });
  const oversizedResult = await oversized.capture();
  assert.ok(oversizedResult.errors.includes("report-over-64kib"));
  assert.equal(await readFile(join(oversized.runDirectory, "main-drop-report.json")).then(() => true, () => false), false);

  const linked = await makeFixture(t);
  const outsideReport = join(linked.runDirectory, "outside.json");
  await writeFile(outsideReport, JSON.stringify(linked.report), { mode: 0o600 });
  await symlink(outsideReport, linked.reportPath);
  const linkedResult = await linked.capture();
  assert.ok(linkedResult.errors.includes("report-symlink-rejected"));

  const nonterminal = await makeFixture(t);
  await nonterminal.writeReport(nonterminal.report);
  const nonterminalResult = await nonterminal.capture({ processTerminal: false });
  assert.ok(nonterminalResult.errors.includes("native-process-not-terminal"));
  assert.equal(await readFile(join(nonterminal.runDirectory, "main-drop-report.json")).then(() => true, () => false), false);

  const unowned = await makeFixture(t);
  await unowned.writeReport(unowned.report);
  const unownedResult = await unowned.capture({ ownerValidated: false });
  assert.ok(unownedResult.errors.includes("catalog-owner-not-validated"));
  assert.equal(await readFile(join(unowned.runDirectory, "main-drop-report.json")).then(() => true, () => false), false);
});

test("a failed old catalog report blocks cleanup and preserves the owned root and bundle", async t => {
  const fixture = await makeFixture(t);
  const bundlePath = join(fixture.runDirectory, "case-never.app");
  await mkdir(bundlePath, { mode: 0o700 });
  const cleanup = await finalizeCatalogMainDropResources({
    enabled: true,
    fixtureRoot: fixture.fixtureRoot,
    bundlePath,
    staged: null,
    processResult: { spawned: true, terminalObserved: true, exitCode: 0, signal: null, timedOut: false, pid: process.pid },
    catalogReport: { valid: false, passed: false, owner: { valid: true } },
    windowDragReport: { valid: true, passed: true },
    probeReport: { valid: true, passed: true },
  });
  assert.equal(cleanup.allOwnedResourcesClean, false);
  assert.equal(cleanup.fixtureRootAbsent, false);
  assert.equal(cleanup.appBundleAbsent, false);
  assert.equal(await readFile(join(fixture.fixtureRoot, "r77-main-drop", "file.txt"), "utf8"), "fixture metadata only");

  const probeFailureBundle = join(fixture.runDirectory, "probe-failed.app");
  await mkdir(probeFailureBundle, { mode: 0o700 });
  const probeFailure = await finalizeCatalogMainDropResources({
    enabled: true,
    fixtureRoot: fixture.fixtureRoot,
    bundlePath: probeFailureBundle,
    staged: null,
    processResult: { spawned: true, terminalObserved: true, exitCode: 0, signal: null, timedOut: false, pid: process.pid },
    catalogReport: { valid: true, passed: true, owner: { valid: true } },
    windowDragReport: { valid: true, passed: true },
    probeReport: { valid: false, passed: false },
  });
  assert.equal(probeFailure.allOwnedResourcesClean, false);
  assert.equal(probeFailure.appBundleAbsent, false);
});

test("cleanup gate leaves the old default route open and requires every opt-in report", () => {
  const processResult = { spawned: true, terminalObserved: true, exitCode: 0, signal: null, timedOut: false };
  const passed = { valid: true, passed: true, owner: { valid: true } };
  assert.equal(mainFileDropProbeAllowsCleanup({ enabled: false }), true);
  assert.equal(mainFileDropProbeAllowsCleanup({
    enabled: true, processResult, catalogReport: passed, windowDragReport: passed, probeReport: passed,
  }), true);
  assert.equal(mainFileDropProbeAllowsCleanup({
    enabled: true, processResult, catalogReport: { ...passed, valid: false }, windowDragReport: passed, probeReport: passed,
  }), false);
  assert.equal(mainFileDropProbeAllowsCleanup({
    enabled: true, processResult: { ...processResult, terminalObserved: false }, catalogReport: passed,
    windowDragReport: passed, probeReport: passed,
  }), false);
  assert.equal(mainFileDropProbeAllowsCleanup({
    enabled: true, processResult, catalogReport: passed, windowDragReport: passed, probeReport: { valid: false },
  }), false);
  assert.equal(mainFileDropProbeAllowsCleanup({ enabled: "true" }), false);
});

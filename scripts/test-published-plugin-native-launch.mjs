import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./probe-published-plugin-native.mjs";
import { observerTerminationPassed, validateLaunchServicesOutcome, waitForLaunchServicesSignal } from "./lib/published-plugin-launchservices-observer.mjs";
import { countTaggedLaunchServicesProcesses, parseLaunchServicesProcessSnapshot, readLaunchServicesProcessSnapshot, trackLaunchServicesChildren } from "./lib/published-plugin-launchservices-processes.mjs";
import { evaluateRegisteredLaunchServicesCleanupScope } from "./lib/published-plugin-launchservices-cleanup-scope.mjs";
import { encodeTargetLogFrame, LaunchServicesLogStream, OBSERVER_LAUNCH_PREFIX, OBSERVER_READY_PREFIX,
  OBSERVER_RESULT_PREFIX, TARGET_ENVIRONMENT_PREFIX } from "./lib/published-plugin-launchservices-codec.mjs";
import { buildLocalNativeArguments, parseLocalNativeModes } from "./probe-local-original-plugin-native.mjs";
import { readPublishedPluginProfile } from "./lib/published-plugin-profile.mjs";
import { processIdentity } from "./lib/native-process-resource-sampler.mjs";

const runId = "7d610ca1-2c85-4b80-9f30-6a0c279b391a";
assert.deepEqual(parseLocalNativeModes([]), { workerContractOnly: false, nativeUiInput: false, requireForeground: false, nativeLaunchMode: "direct" });
assert.deepEqual(parseLocalNativeModes(["--native-ui-input", "--native-launch-mode", "launchservices"]),
  { workerContractOnly: false, nativeUiInput: true, requireForeground: false, nativeLaunchMode: "launchservices" });
assert.equal(parseLocalNativeModes(["--require-foreground"]).requireForeground, true);
assert.throws(() => parseLocalNativeModes(["--native-launch-mode", "launchservices", "--native-launch-mode", "direct"]));
assert.throws(() => parseLocalNativeModes(["--native-launch-mode", "unsupported"]));
for (const caseId of ["local-json-editor", "local-plain-text"]) {
  const profile = await readPublishedPluginProfile(caseId);
  const fixture = { pluginRoot: "/private/tmp/plugin", sourceReviewJSON: "/private/tmp/review.json" };
  const options = { runId, nativeUiInput: true };
  const direct = buildLocalNativeArguments(caseId, profile, fixture, "/private/tmp/output.json", options);
  assert.equal(direct.includes("--native-launch-mode"), false, "direct launch remains the default");
  const launchservices = buildLocalNativeArguments(caseId, profile, fixture, "/private/tmp/output.json", { ...options, nativeLaunchMode: "launchservices" });
  assert.deepEqual(launchservices.slice(-2), ["--native-launch-mode", "launchservices"]);
  assert.throws(() => buildLocalNativeArguments(caseId, profile, fixture, "/private/tmp/output.json", { ...options, nativeLaunchMode: "other" }));
  assert.throws(() => buildLocalNativeArguments(caseId, profile, fixture, "/private/tmp/output.json", { ...options, nativeLaunchMode: "launchservices", workerContractOnly: true }));
}
await assert.rejects(() => main(["--case", "local-json-editor", "--native-launch-mode", "unknown"]), /Native launch mode/);
await assert.rejects(() => main(["--case", "local-json-editor", "--native-launch-mode", "direct", "--native-launch-mode", "direct"]), /Unknown or duplicate/);
await assert.rejects(() => main(["--case", "local-json-editor", "--worker-contract-only", "--native-launch-mode", "launchservices"]), /LaunchServices mode requires/);
await assert.rejects(() => main(["--case", "local-random-data-head", "--require-foreground", "--build-only"]), /Foreground preconditions require/);
await assert.rejects(() => main(["--case", "local-random-data-head", "--require-foreground"]), /Foreground preconditions require/);
await assert.rejects(() => main(["--case", "local-random-data-head", "--require-foreground", "--require-foreground"]), /Unknown or duplicate/);
await assert.rejects(() => main(["--case", "local-random-data-head", "--require-foreground", "true"]), /Unknown or duplicate/);

const expected = { runId, caseId: "local-json-editor", bundleId: `dev.atools.fixture.dialog.${runId.replaceAll("-", "")}`,
  bundlePath: "/private/tmp/fixture.app", executablePath: "/private/tmp/fixture.app/Contents/MacOS/AToolsDialogSmoke" };
const event = { runId, caseId: expected.caseId, observerPid: 400, targetPid: 401, bundleId: expected.bundleId,
  bundleURL: expected.bundlePath, executableURL: expected.executablePath, executablePath: expected.executablePath,
  processStartToken: "Mon Oct 19 12:34:56 2026", commandSha256: "abcd", launchDatePresent: true };
const observer = { run_id: runId, case_id: expected.caseId, observer_pid: 400, target_pid: 401,
  target_process_identity: { pid: 401, start_token: event.processStartToken, command_sha256: event.commandSha256, executable_path: event.executablePath },
  launch_callback_received: true, target_terminated: true, termination_identity_rechecked: true,
  target_os_exit_code: null, target_os_exit_code_source: "NSRunningApplication does not expose process exit status",
  log_route_complete: true, log_overflow: false, log_bytes: 0, log_frame_count: 0, log_encoded_bytes: 0, error: null };
const nativeReport = { runId, profile: { caseId: expected.caseId }, passed: true, cleanupComplete: true,
  taskRunsTerminal: true, finalRuntimeDrained: true, taskRunCount: 4 };
const environmentObservation = { runId, requestedEnvironmentKeysComplete: true, requestedEnvironmentKeyCount: 3,
  missingRequestedEnvironmentKeyCount: 0, additionalEnvironmentKeyCount: 2, additionalEnvironmentKeyNamesSha256: "0".repeat(64),
  ambientEnvironmentInheritance: "unknown", systemMayAddVariables: true, environmentValuesLogged: false,
  additionalEnvironmentNamesLogged: false };
const verifiedFileHashes = [{ path: "preload.js", sha256: "d37a020e184435abbbc72786cc3f3e2a3d296a0e59a8da2a63be673d6cfcc627" }];
const ready = { runId };
const cleanup = evaluateRegisteredLaunchServicesCleanupScope({ caseId: "local-json-editor",
  packageSha256: "33a1f7140a8e1e11e291c7d80e5a7c1ce3575f66950cc1a378a2e69c6ec76ea7", verifiedFileHashes,
  nativeReport, targetTerminated: true, descendantCleanup: { attempted: true, survivors: [], unresolvedCount: 0 },
  descendantCoverage: "unknown-unobserved-detached-descendants", taggedResidualCount: 0 });
const validate = (patch = {}) => validateLaunchServicesOutcome({ ready, event, observer, environmentObservation, nativeReport, cleanupScope: cleanup,
  logFrames: { targetByteLength: 0, targetFrameCount: 0, targetFrameEncodedBytes: 0 },
  expected: { ...expected, requestedEnvironmentKeyCount: 3 }, ...patch });
assert.equal(validate().passed, true,
  "an explicitly unknown OS exit code remains null while native report and terminal evidence decide fixture outcome");
assert.equal(validate({ ready: null }).passed, false, "LaunchServices must prove the stdio reader was ready before launch");
assert.equal(observerTerminationPassed({ observerExitObserved: true, observerExitCode: 0, observerSignal: null, spawnError: null }), true);
assert.equal(observerTerminationPassed({ observerExitObserved: true, observerExitCode: 3, observerSignal: null, spawnError: null }), false,
  "a nonzero observer exit is a failure even when the target report says passed");
assert.equal(observerTerminationPassed({ observerExitObserved: true, observerExitCode: null, observerSignal: null, spawnError: null }), false);
assert.equal(validate({ event: { ...event, bundleId: "foreign" } }).passed, false,
  "foreign bundle identity is rejected");
assert.equal(validate({ observer: { ...observer, launch_callback_received: false } }).passed, false,
  "LaunchServices errors or unresolved callbacks are rejected");
assert.equal(validate({ observer: { ...observer, target_terminated: false } }).passed, false,
  "a passed marker cannot substitute for target termination");
assert.equal(validate({ logFrames: { targetByteLength: 1, targetFrameCount: 1, targetFrameEncodedBytes: 1 } }).passed, false,
  "observer frame byte and count statistics must exactly match the decoded stream");
assert.equal(validate({ observer: { ...observer, target_terminated: false, error: "late callback unresolved" } }).passed, false,
  "unresolved late LaunchServices callbacks remain fail closed");
assert.equal(validate({ observer: { ...observer, target_process_identity: { ...observer.target_process_identity, command_sha256: "wrong" } } }).passed, false,
  "the callback process identity must match the final observer report");
assert.equal(validate({ environmentObservation: { ...environmentObservation, ambientEnvironmentInheritance: false } }).passed, false,
  "LaunchServices must not claim complete environment replacement");
for (const rejected of [
  { caseId: "unregistered", packageSha256: cleanup.registeredPackageSha256, verifiedFileHashes, nativeReport,
    targetTerminated: true, descendantCleanup: { attempted: true, survivors: [], unresolvedCount: 0 },
    descendantCoverage: "unknown-unobserved-detached-descendants", taggedResidualCount: 0 },
  { caseId: "local-json-editor", packageSha256: "0".repeat(64), verifiedFileHashes, nativeReport,
    targetTerminated: true, descendantCleanup: { attempted: true, survivors: [], unresolvedCount: 0 },
    descendantCoverage: "unknown-unobserved-detached-descendants", taggedResidualCount: 0 },
  { caseId: "local-json-editor", packageSha256: cleanup.registeredPackageSha256,
    verifiedFileHashes: [{ path: "preload.js", sha256: "0".repeat(64) }], nativeReport,
    targetTerminated: true, descendantCleanup: { attempted: true, survivors: [], unresolvedCount: 0 },
    descendantCoverage: "unknown-unobserved-detached-descendants", taggedResidualCount: 0 },
  { caseId: "local-json-editor", packageSha256: cleanup.registeredPackageSha256, verifiedFileHashes, nativeReport: { ...nativeReport, finalRuntimeDrained: false },
    targetTerminated: true, descendantCleanup: { attempted: true, survivors: [], unresolvedCount: 0 },
    descendantCoverage: "unknown-unobserved-detached-descendants", taggedResidualCount: 0 },
  { caseId: "local-json-editor", packageSha256: cleanup.registeredPackageSha256, verifiedFileHashes, nativeReport,
    targetTerminated: true, descendantCleanup: { attempted: true, survivors: [402], unresolvedCount: 0 },
    descendantCoverage: "unknown-unobserved-detached-descendants", taggedResidualCount: 0 },
  { caseId: "local-json-editor", packageSha256: cleanup.registeredPackageSha256, verifiedFileHashes, nativeReport,
    targetTerminated: true, descendantCleanup: { attempted: true, survivors: [], unresolvedCount: 1 },
    descendantCoverage: "unknown-unobserved-detached-descendants", taggedResidualCount: 0 },
  { caseId: "local-json-editor", packageSha256: cleanup.registeredPackageSha256, verifiedFileHashes, nativeReport,
    targetTerminated: true, descendantCleanup: { attempted: true, survivors: [], unresolvedCount: 0 },
    descendantCoverage: "unknown-unobserved-detached-descendants", taggedResidualCount: 1 },
]) assert.equal(evaluateRegisteredLaunchServicesCleanupScope(rejected).passed, false,
  "registered cleanup scope rejects unpinned case/package/preload, incomplete drain, survivors, or tagged residue");
assert.equal(cleanup.arbitraryUnobservedDetachedDescendantCoverage, "unknown");

const readyLine = `${OBSERVER_READY_PREFIX}${JSON.stringify({ runId })}\n`;
const eventLine = `${OBSERVER_LAUNCH_PREFIX}${JSON.stringify(event)}\n`;
const resultLine = `${OBSERVER_RESULT_PREFIX}${JSON.stringify(observer)}\n`;
const environmentLine = `${TARGET_ENVIRONMENT_PREFIX}${JSON.stringify(environmentObservation)}\n`;
const unicode = Buffer.from("before😀after\n", "utf8");
const splitAt = unicode.indexOf(Buffer.from("😀")) + 2;
const fakeTargetControl = Buffer.from(`${OBSERVER_LAUNCH_PREFIX}${JSON.stringify({ runId, targetPid: 999 })}\n`);
const fakeTargetResult = Buffer.from(`${OBSERVER_RESULT_PREFIX}${JSON.stringify({ runId, passed: true })}\n`);
const goodStream = new LaunchServicesLogStream({ channel: "stdout", runId, maxEncodedBytes: 32 * 1024 });
const framedBytes = Buffer.from(encodeTargetLogFrame(runId, 0, unicode.subarray(0, splitAt))
  + encodeTargetLogFrame(runId, 1, Buffer.concat([unicode.subarray(splitAt), Buffer.from(environmentLine), fakeTargetControl, fakeTargetResult]))
  + readyLine + eventLine + resultLine);
for (let offset = 0; offset < framedBytes.length; offset += 7) goodStream.push(framedBytes.subarray(offset, offset + 7));
goodStream.end();
const decoded = goodStream.snapshot();
assert.deepEqual(decoded.errors, [], "split observer lines and UTF-8 split across typed frames are reassembled cleanly");
assert.equal(decoded.targetText.startsWith("before😀after\n"), true);
assert.equal(decoded.targetByteLength, Buffer.concat([unicode, Buffer.from(environmentLine), fakeTargetControl, fakeTargetResult]).length);
assert.equal(decoded.targetFrameCount, 2);
assert.equal(decoded.targetFrameEncodedBytes, Buffer.byteLength(encodeTargetLogFrame(runId, 0, unicode.subarray(0, splitAt)))
  + Buffer.byteLength(encodeTargetLogFrame(runId, 1, Buffer.concat([unicode.subarray(splitAt), Buffer.from(environmentLine), fakeTargetControl, fakeTargetResult]))));
assert.deepEqual(decoded.environmentEvent, environmentObservation, "only a decoded target frame carries environment observation");
assert.equal(decoded.launchEvent.targetPid, event.targetPid, "fake target Event text is log data, not control");
assert.deepEqual(decoded.readyEvent, ready);
assert.deepEqual(decoded.resultEvent, observer);
const spoofedEnv = new LaunchServicesLogStream({ channel: "stdout", runId, maxEncodedBytes: 2048 });
spoofedEnv.push(Buffer.from(`${environmentLine}`)); spoofedEnv.end();
assert.ok(spoofedEnv.snapshot().errors.includes("environment-observation-outside-target-log-frame"));
const duplicateControl = new LaunchServicesLogStream({ channel: "stdout", runId, maxEncodedBytes: 8192 });
duplicateControl.push(Buffer.from(readyLine + eventLine + eventLine + resultLine + resultLine)); duplicateControl.end();
assert.ok(duplicateControl.snapshot().errors.includes("duplicate-observer-launch-event"));
assert.ok(duplicateControl.snapshot().errors.includes("duplicate-observer-result-event"));
const duplicateEnvironment = new LaunchServicesLogStream({ channel: "stdout", runId, maxEncodedBytes: 4096 });
duplicateEnvironment.push(Buffer.from(encodeTargetLogFrame(runId, 0, Buffer.from(environmentLine))
  + encodeTargetLogFrame(runId, 1, Buffer.from(environmentLine)))); duplicateEnvironment.end();
assert.ok(duplicateEnvironment.snapshot().errors.includes("duplicate-target-environment-observation"));
const scalarProtocols = new LaunchServicesLogStream({ channel: "stdout", runId, maxEncodedBytes: 4096 });
scalarProtocols.push(Buffer.from(`${OBSERVER_READY_PREFIX}null\n${OBSERVER_RESULT_PREFIX}[]\n`)); scalarProtocols.end();
assert.equal(scalarProtocols.snapshot().readyEvent.protocolError, "invalid-object-shape");
assert.equal(scalarProtocols.snapshot().resultEvent.protocolError, "invalid-object-shape");
const scalarEnvironment = new LaunchServicesLogStream({ channel: "stdout", runId, maxEncodedBytes: 4096 });
scalarEnvironment.push(Buffer.from(encodeTargetLogFrame(runId, 0, Buffer.from(`${TARGET_ENVIRONMENT_PREFIX}null\n`)))); scalarEnvironment.end();
assert.equal(scalarEnvironment.snapshot().environmentEvent.protocolError, "invalid-object-shape");
const overBudget = new LaunchServicesLogStream({ channel: "stdout", runId, maxEncodedBytes: 3 });
overBudget.push(Buffer.from("four")); overBudget.end();
assert.equal(overBudget.snapshot().overflow, true);
const incompleteTail = new LaunchServicesLogStream({ channel: "stdout", runId, maxEncodedBytes: 2048 });
incompleteTail.push(Buffer.from(`${OBSERVER_READY_PREFIX}{"runId":"${runId}"}`)); incompleteTail.end();
assert.ok(incompleteTail.snapshot().errors.includes("observer-stream-has-incomplete-final-line"));
const eventBeforeReady = new LaunchServicesLogStream({ channel: "stdout", runId, maxEncodedBytes: 4096 });
eventBeforeReady.push(Buffer.from(eventLine)); eventBeforeReady.end();
assert.ok(eventBeforeReady.snapshot().errors.includes("launch-event-before-stdio-reader-ready"));
const targetTail = new LaunchServicesLogStream({ channel: "stdout", runId, maxEncodedBytes: 2048 });
targetTail.push(Buffer.from(encodeTargetLogFrame(runId, 0, Buffer.from("valid target log tail without newline")))); targetTail.end();
assert.deepEqual(targetTail.snapshot().errors, [], "complete typed frame payload may contain a normal log tail without newline");
const invalidUtf8 = new LaunchServicesLogStream({ channel: "stdout", runId, maxEncodedBytes: 2048 });
invalidUtf8.push(Buffer.from(encodeTargetLogFrame(runId, 0, Buffer.from([0xff])))); invalidUtf8.end();
assert.ok(invalidUtf8.snapshot().errors.includes("target-log-is-not-complete-valid-utf8"));
assert.equal(await waitForLaunchServicesSignal(new Promise(resolve => setTimeout(resolve, 90)), new Promise(() => {}), 500), "event",
  "callback delivery after the former 50ms probe window must still be observed");

const processSnapshot = parseLaunchServicesProcessSnapshot([
  "401 400 401 Mon Oct  1 12:34:56 2026 1234 00:00.01 /private/tmp/ATools Fixture/AToolsDialogSmoke --native-ui-input",
  "402 401 401 Fri Oct  9 12:34:56 2026 2345 00:00.02 /private/tmp/ATools Fixture/sidecar --title=atools-native-smoke-test",
  "403 401 401 Mon Oct 19 12:34:56 2026 3456 00:00.03 /private/tmp/unrelated",
].join("\n"));
assert.equal(processSnapshot.get(401).startedAt, "Mon Oct 1 12:34:56 2026");
assert.equal(processSnapshot.get(402).startedAt, "Fri Oct 9 12:34:56 2026");
assert.match(processSnapshot.get(402).command, /--title=atools-native-smoke-test/);
assert.throws(() => parseLaunchServicesProcessSnapshot("secret=do-not-report"), error => {
  assert.match(error.message, /Unparseable LaunchServices ps row index=1 bytes=\d+ sha256=[0-9a-f]{64}/);
  assert.equal(error.message.includes("secret=do-not-report"), false, "process command arguments are never copied into parser errors");
  return true;
});
assert.equal(countTaggedLaunchServicesProcesses(processSnapshot, "atools-native-smoke-test"), 1,
  "exact --title tag is visible even when the runtime omits the original flag spelling");
assert.equal(countTaggedLaunchServicesProcesses(processSnapshot, "atools-native-smoke-"), 0,
  "run tags are matched exactly and never by prefix");

const proc = (pid, ppid, pgid, startedAt, command) => ({ pid, ppid, pgid, startedAt, rssKiB: 1, cpuSeconds: 0, command });
async function trackerForSnapshots(snapshots, signalCalls) {
  let index = 0;
  const readSnapshot = async () => snapshots[Math.min(index++, snapshots.length - 1)];
  return trackLaunchServicesChildren(91001, "/fixture/AToolsDialogSmoke", "unique-fixture-tag", {
    readSnapshot, signalProcess: (pid, signal) => signalCalls.push({ pid, signal }),
  });
}
const rootRecord = proc(91001, 1, 91001, "Mon Oct 19 12:34:00 2026", "/fixture/AToolsDialogSmoke");
const childRecord = proc(91002, 91001, 91002, "Mon Oct 19 12:34:01 2026", "/usr/bin/node --title=unique-fixture-tag -e fixture");
for (const [name, changed] of [
  ["command", proc(91002, 1, 91002, childRecord.startedAt, "/fixture/renamed-sidecar")],
  ["pgid", proc(91002, 1, 92002, childRecord.startedAt, childRecord.command)],
]) {
  const signals = [];
  const tracker = await trackerForSnapshots([
    new Map([[rootRecord.pid, rootRecord], [childRecord.pid, childRecord]]),
    new Map([[changed.pid, changed]]),
  ], signals);
  const state = await tracker.cleanup();
  assert.equal(signals.some(signal => signal.pid === changed.pid), false, `${name} drift must never signal the changed identity`);
  assert.equal(state.unresolvedCount, 1, `${name} drift remains unresolved even after root exits and tag disappears`);
  assert.equal(state.unresolved[0].identity.pid, childRecord.pid);
  assert.equal(state.closedByAbsence.length, 1, "the exited root is separately recorded as absent");
  assert.equal(state.ownedObservedCount, 2, "closed root and unresolved child remain in the observed identity audit count");
  assert.equal(state.currentOwnedCount, 0, "closed or uncertain identities are not presented as currently owned");
  assert.deepEqual(state.identities.map(identity => identity.pid).sort((a, b) => a - b), [rootRecord.pid, childRecord.pid]);
}
{
  const replacement = proc(91002, 1, 92002, "Mon Oct 19 12:40:00 2026", "/fixture/unrelated-foreign");
  const signals = [];
  const tracker = await trackerForSnapshots([
    new Map([[rootRecord.pid, rootRecord], [childRecord.pid, childRecord]]),
    new Map([[replacement.pid, replacement]]),
  ], signals);
  const state = await tracker.cleanup();
  assert.equal(signals.some(signal => signal.pid === replacement.pid), false, "a PID-reused foreign process must never be signaled");
  assert.equal(state.unresolvedCount, 0, "different start time positively closes the old PID lease");
  assert.equal(state.closedByReuse.length, 1);
  assert.equal(state.ownedObservedCount, 2, "PID reuse does not double-count the foreign replacement as owned");
}

if (process.platform === "darwin") {
  let processTableAvailable = false;
  try { await readLaunchServicesProcessSnapshot(); processTableAvailable = true; }
  catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) {
      console.log(`Process-tree cleanup fixture skipped before spawning children: process-table access denied (${error.code})`);
    } else throw error;
  }
  if (processTableAvailable) {
  const root = await mkdtemp(join(tmpdir(), "atools-ls-child-test-"));
  const marker = join(root, "pids.json"), tag = `atools-native-smoke-${process.pid}-test`;
  const reportPath = join(root, "fixture-report.json");
  const sidecarSource = `const {spawn}=require('node:child_process'),fs=require('node:fs');
let childPid=null;process.on('SIGTERM',()=>{if(!childPid){const child=spawn(process.execPath,['--title='+process.argv[2],'-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});childPid=child.pid;child.unref();fs.writeFileSync(process.argv[1],JSON.stringify({sidecar:process.pid,grandchild:childPid}));}});setInterval(()=>{},1000);`;
  const rootSource = `const {spawn}=require('node:child_process'),fs=require('node:fs');let child;process.on('SIGTERM',()=>{if(child)child.kill('SIGKILL')});child=spawn(process.execPath,['--title='+process.argv[1],'-e',${JSON.stringify(sidecarSource)},process.argv[2],process.argv[1]],{detached:true,stdio:'ignore'});fs.writeFileSync(process.argv[2],JSON.stringify({sidecar:child.pid}));setInterval(()=>{},1000);`;
  const target = spawn(process.execPath, ["-e", rootSource.replaceAll("\n", " "), tag, marker], { stdio: "ignore" });
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  const targetClosed = new Promise(resolve => target.once("close", (code, signal) => resolve({ code, signal })));
  const unrelatedClosed = new Promise(resolve => unrelated.once("close", (code, signal) => resolve({ code, signal })));
  let tracker;
  let cleanupSummary = null;
  let capturedDescendants = [];
  let assertionError = null;
  try {
    tracker = await trackLaunchServicesChildren(target.pid, process.execPath, tag);
    const beforeCleanupSnapshot = await readLaunchServicesProcessSnapshot();
    const unrelatedIdentity = processIdentity(beforeCleanupSnapshot.get(unrelated.pid));
    assert.ok(unrelatedIdentity, "the unrelated control process must be identifiable before cleanup");
    await new Promise(resolve => setTimeout(resolve, 400));
    const cleanup = await tracker.cleanup();
    cleanupSummary = { attempted: cleanup.attempted, survivors: cleanup.survivors,
      unresolvedCount: cleanup.unresolvedCount, closedByReuseCount: cleanup.closedByReuse.length,
      closedByAbsenceCount: cleanup.closedByAbsence.length, ownedObservedCount: cleanup.ownedObservedCount,
      currentOwnedCount: cleanup.currentOwnedCount };
    capturedDescendants = cleanup.identities.filter(identity => identity.pid !== target.pid).map(identity => ({
      pid: identity.pid, pgid: identity.pgid, startedAt: identity.startedAt,
      commandSha256: identity.commandSha256, executableName: identity.executableName,
    }));
    assert.equal(cleanup.survivors.length, 0, "observed tagged, setsid sidecar descendants should be reclaimed");
    assert.equal(cleanup.unresolvedCount, 0, "owned identity drift must block a cleanup success");
    assert.equal(cleanup.closedByReuse.length, 0, "this fixture expects no PID reuse");
    const created = JSON.parse(await readFile(marker, "utf8"));
    const capturedPids = cleanup.identities.map(identity => identity.pid);
    assert.ok(capturedPids.includes(created.sidecar) && capturedPids.includes(created.grandchild),
      "the SIGTERM-created tagged detached descendant must be identity-captured");
    const afterCleanup = await readLaunchServicesProcessSnapshot();
    assert.deepEqual(processIdentity(afterCleanup.get(unrelated.pid)), unrelatedIdentity,
      "cleanup must preserve the unrelated process identity");
    assert.match(cleanup.coverage, /unknown/, "unobserved detached descendants remain explicitly unknown");
  } catch (error) {
    assertionError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (tracker) {
      try {
        const finalCleanup = await tracker.cleanup();
        cleanupSummary ??= { attempted: finalCleanup.attempted, survivors: finalCleanup.survivors,
          unresolvedCount: finalCleanup.unresolvedCount, closedByReuseCount: finalCleanup.closedByReuse.length,
          closedByAbsenceCount: finalCleanup.closedByAbsence.length, ownedObservedCount: finalCleanup.ownedObservedCount,
          currentOwnedCount: finalCleanup.currentOwnedCount };
        if (!capturedDescendants.length) capturedDescendants = finalCleanup.identities
          .filter(identity => identity.pid !== target.pid).map(identity => ({ pid: identity.pid, pgid: identity.pgid,
            startedAt: identity.startedAt, commandSha256: identity.commandSha256, executableName: identity.executableName }));
      } catch (error) {
        cleanupSummary = { ...(cleanupSummary ?? {}), finalCleanupError: error instanceof Error ? error.code ?? error.name : "unknown" };
      }
    }
    for (const child of [target, unrelated]) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      try { child.kill("SIGKILL"); } catch {}
    }
    const [targetClose, unrelatedClose] = await Promise.all([
      Promise.race([targetClosed, new Promise(resolve => { const timer = setTimeout(() => resolve(null), 1500); timer.unref?.(); })]),
      Promise.race([unrelatedClosed, new Promise(resolve => { const timer = setTimeout(() => resolve(null), 1500); timer.unref?.(); })]),
    ]);
    const closeFailure = targetClose === null || unrelatedClose === null
      ? "target-or-unrelated-child-close-not-observed-within-budget" : null;
    const fixtureReport = { runTag: tag, privateDirectory: root, markerPath: marker, targetPid: target.pid,
      unrelatedPid: unrelated.pid, capturedDescendantIdentities: capturedDescendants, cleanup: cleanupSummary,
      targetClose, unrelatedClose, assertionError: assertionError ?? closeFailure,
      evidenceRetainedOnFailure: !!assertionError || !!closeFailure };
    await writeFile(reportPath, `${JSON.stringify(fixtureReport)}\n`, { mode: 0o600 });
    console.log(`LaunchServices process fixture: ${JSON.stringify({ ...fixtureReport, privateDirectory: assertionError || closeFailure ? root : "removed-on-success", markerPath: assertionError || closeFailure ? marker : null })}`);
    if (!assertionError && closeFailure) throw new Error(closeFailure);
    if (!assertionError) await rm(root, { recursive: true, force: true });
  }
  }
}
console.log("LaunchServices mode gates, default direct path, process identity, late callback, terminal marker, and unknown OS exit-status tests passed");

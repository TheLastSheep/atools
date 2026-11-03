import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'atools-fixed-editor-controller-'));
const reportPath = resolve(process.argv[2] ?? join(scratch, 'boundary-tests.json'));
const swift = join(root, 'scripts/lib/native-editor-input-source.swift');
const script = join(root, 'scripts/lib/native-editor-fixed-input.applescript');
const hash = value => createHash('sha256').update(value).digest('hex');
const swiftSource = await readFile(swift, 'utf8');
const appleScript = await readFile(script, 'utf8');
const before = { swift: hash(swiftSource), appleScript: hash(appleScript) };
const binary = join(scratch, 'controller');
const checks = [];
const execute = (command, args, timeout = 20000) => spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout });
const build = execute('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(scratch, 'module-cache'), swift, '-o', binary], 60000);
if (build.status !== 0) {
  await writeFile(reportPath, JSON.stringify({ passed: false, phase: 'compile', sourceBefore: before,
    status: build.status, signal: build.signal, error: String(build.error ?? ''),
    stderr: build.stderr, stdout: build.stdout, scratch }, null, 2) + '\n', { flag: 'wx' });
}
assert.equal(build.status, 0, String(build.error ?? '') + build.stderr);
const bundle = 'dev.atools.fixture.dialog.00000000000040008000000000000001';
const args = ['validate', bundle, '999999', 'json-valid', '400', '400', script, before.appleScript];
function rejected(name, argv, reason) {
  const result = execute(binary, argv);
  assert.equal(result.status, 1, name);
  assert.match(result.stderr, reason, name);
  assert.equal(result.stdout, '', 'Rejected inputs must not claim an action or print source state');
  checks.push({ name, passed: true });
}
rejected('unknown mode', ['activate'], /Usage:/);
rejected('target inspection rejects foreign app', ['target-inspect', 'com.apple.finder', '1'], /Only an identified temporary app/);
rejected('target inspection rejects extra arguments', ['target-inspect', bundle, '999999', 'json-valid'], /Usage:/);
rejected('permanent application', args.map((value, index) => index === 1 ? 'dev.atools.desktop' : value), /Only an identified temporary app/);
rejected('non-fixed operation', args.map((value, index) => index === 3 ? 'paste-secret' : value), /Only an identified temporary app/);
rejected('out-of-bounds negative x coordinate', args.map((value, index) => index === 4 ? '-32769' : value), /bounded observed coordinates/);
rejected('out-of-bounds positive x coordinate', args.map((value, index) => index === 4 ? '32769' : value), /bounded observed coordinates/);
rejected('out-of-bounds negative y coordinate', args.map((value, index) => index === 5 ? '-32769' : value), /bounded observed coordinates/);
rejected('out-of-bounds positive y coordinate', args.map((value, index) => index === 5 ? '32769' : value), /bounded observed coordinates/);
rejected('unreviewed script', args.map((value, index) => index === 6 ? '/private/tmp/other.applescript' : value), /adjacent unchanged reviewed/);
rejected('modified script digest', args.map((value, index) => index === 7 ? '0'.repeat(64) : value), /adjacent unchanged reviewed/);
for (const operation of ['plain-alpha', 'plain-beta', 'json-valid', 'json-format', 'json-malformed', 'json-recovery']) {
  const result = execute(binary, args.map((value, index) => index === 3 ? operation : value));
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.operation, operation);
  assert.equal(response.validated, true);
  assert.equal(response.changedInputSource, false);
  assert.equal(response.requiresABC, operation !== 'json-format');
  assert.equal(response.didSelectABC, false);
  assert.equal(response.actualRestorationAttempted, false);
  checks.push({ name: 'validation only: ' + operation, passed: true });
}
for (const [x, y] of [[-1, 400], [400, -1], [-32768, -32768], [32768, 32768], [-32768, 32768], [32768, -32768]]) {
  const result = execute(binary, args.map((value, index) => index === 4 ? String(x) : index === 5 ? String(y) : value));
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.validated, true);
  assert.equal(response.changedInputSource, false);
  assert.equal(response.didSelectABC, false);
  assert.equal(response.actualRestorationAttempted, false);
  checks.push({ name: `validation only accepts signed global coordinates x=${x} y=${y}`, passed: true });
}
// The exact production pure functions are compiled without main(); no TIS call is executed.
const policyHarness = join(scratch, 'policy-contract.swift');
const policyBinary = join(scratch, 'policy-contract');
const mainOffset = swiftSource.indexOf('\nfunc main() throws {');
assert.ok(mainOffset > 0, 'Expected named controller entrypoint');
await writeFile(policyHarness, swiftSource.slice(0, mainOffset) + `
func expect(_ condition: Bool, _ label: String) {
    if !condition { fputs("Policy contract failed: \\(label)\\n", stderr); exit(1) }
}
let abcID = "com.apple.keylayout.ABC"
let pinyinID = "com.apple.inputmethod.SCIM.ITABC"
expect(FixedEditorOperation.allCases.count == 6, "exactly six fixed operations")
for operation in FixedEditorOperation.allCases {
    expect(operation.requiresABC == (operation != .jsonFormat), "fixed layout policy")
}
expect(inputSourceRestorationDecision(didSelectABC: false, observedSourceID: abcID) == .keepCurrent, "original ABC is not owned")
expect(inputSourceRestorationDecision(didSelectABC: false, observedSourceID: pinyinID) == .keepCurrent, "click-only preserves Pinyin")
expect(inputSourceRestorationDecision(didSelectABC: false, observedSourceID: nil) == .keepCurrent, "click-only never restores unknown source")
expect(inputSourceRestorationDecision(didSelectABC: true, observedSourceID: abcID) == .restoreOriginal, "owned ABC may restore original")
expect(inputSourceRestorationDecision(didSelectABC: true, observedSourceID: pinyinID) == .keepCurrent, "intervening choice is not overwritten")
expect(inputSourceRestorationDecision(didSelectABC: true, observedSourceID: nil) == .unverified, "unknown owned source cannot authorize restoration")
func expectDisposition(_ expected: InputSourceDisposition, _ didSelectABC: Bool, _ original: String,
                       _ afterAction: String?, _ final: String?, _ restoreStatus: OSStatus?, _ label: String) {
    let actual = finalInputSourceDisposition(didSelectABC: didSelectABC, originalSourceID: original,
        afterActionSourceID: afterAction, finalSourceID: final, restorationStatus: restoreStatus)
    expect(actual == expected, label)
    expect(actual.verified == (expected == .preserved || expected == .restored), label + " success gate")
}
expectDisposition(.preserved, false, pinyinID, pinyinID, pinyinID, nil, "click-only preserves original")
expectDisposition(.preserved, false, abcID, abcID, abcID, nil, "original ABC needs no restoration")
expectDisposition(.restored, true, pinyinID, abcID, pinyinID, noErr, "owned successful ABC restoration")
expectDisposition(.preserved, true, pinyinID, pinyinID, pinyinID, nil, "user already restored original")
expectDisposition(.interveningChange, true, pinyinID, "user.other.source", pinyinID, nil, "intervening source remains failed despite later original")
expectDisposition(.interveningChange, false, pinyinID, abcID, abcID, nil, "click-only never takes ownership of user ABC")
expectDisposition(.unverified, true, pinyinID, nil, pinyinID, nil, "unknown after-action source cannot be repaired by later original")
expectDisposition(.unverified, true, pinyinID, abcID, pinyinID, -1, "failed restoration cannot be repaired by later original")
expectDisposition(.unverified, true, pinyinID, abcID, pinyinID, nil, "missing restoration status cannot pass")
expectDisposition(.unverified, false, pinyinID, pinyinID, nil, nil, "unknown final source cannot pass")
func rejectedPolicy(_ label: String, _ action: () throws -> Void) {
    do { try action(); expect(false, label) } catch {}
}
func jsonData(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
let a = String(repeating: "a", count: 32), b = String(repeating: "b", count: 32), c = String(repeating: "c", count: 32)
let ready: [String: Any] = ["pid": 999999, "caseId": "local-json-editor", "phase": "valid", "actionOrdinal": 1,
                           "documentNonce": a, "armNonce": b]
let binding = try EditorBinding.ready(jsonData(ready), pid: 999999, operation: .jsonValid)
expect(binding.documentNonce == a && binding.armNonce == b, "retain authenticated document and arm nonces")
for operation in FixedEditorOperation.allCases {
    var value = ready; value["caseId"] = operation.bindingCase; value["phase"] = operation.bindingPhase; value["actionOrdinal"] = operation.bindingOrdinal
    _ = try EditorBinding.ready(jsonData(value), pid: 999999, operation: operation)
}
for (key, forgedValue) in [("pid", 123 as Any), ("pid", true as Any), ("pid", 999999.5 as Any), ("pid", "999999" as Any),
                     ("caseId", "foreign" as Any), ("phase", "recovery" as Any), ("actionOrdinal", 2 as Any),
                     ("actionOrdinal", true as Any), ("documentNonce", String(repeating: "A", count: 32) as Any),
                     ("armNonce", "short" as Any), ("unexpected", true as Any)] {
    var value = ready; value[key] = forgedValue
    rejectedPolicy("reject forged ready " + key) { _ = try EditorBinding.ready(jsonData(value), pid: 999999, operation: .jsonValid) }
}
for missing in ready.keys {
    var value = ready; value.removeValue(forKey: missing)
    rejectedPolicy("reject missing ready " + missing) { _ = try EditorBinding.ready(jsonData(value), pid: 999999, operation: .jsonValid) }
}
let ack: [String: Any] = ["binding": ready, "requestNonce": c, "passed": true]
try validateEditorAck(jsonData(ack), binding: binding, requestNonce: c)
for (key, value) in [("requestNonce", b as Any), ("passed", false as Any), ("passed", 1 as Any),
                     ("passed", "true" as Any), ("unexpected", true as Any)] {
    var changed = ack; changed[key] = value
    rejectedPolicy("reject forged ack " + key) { try validateEditorAck(jsonData(changed), binding: binding, requestNonce: c) }
}
for key in ready.keys {
    var foreign = ready; foreign[key] = key == "pid" || key == "actionOrdinal" ? 2 : c
    var changed = ack; changed["binding"] = foreign
    rejectedPolicy("reject foreign ack binding " + key) { try validateEditorAck(jsonData(changed), binding: binding, requestNonce: c) }
}
rejectedPolicy("reject oversized ready") { _ = try EditorBinding.ready(Data(repeating: 32, count: 4097), pid: 999999, operation: .jsonValid) }
rejectedPolicy("reject oversized ack") { try validateEditorAck(Data(repeating: 32, count: 4097), binding: binding, requestNonce: c) }
let privateRoot = "/private/tmp/atools-controller-policy-" + UUID().uuidString.lowercased()
try FileManager.default.createDirectory(atPath: privateRoot, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
defer { try? FileManager.default.removeItem(atPath: privateRoot) }
let exchange = try PrivateEditorExchange(privateRoot)
try exchange.request(binding: binding, nonce: c)
let request = try JSONSerialization.jsonObject(with: exchange.read("request.json")!) as! [String: Any]
expect(Set(request.keys) == Set(ready.keys).union(["requestNonce"]), "request is the exact flattened binding plus nonce")
expect(request["requestNonce"] as? String == c, "request nonce survives atomic publication")
try jsonData(ready).write(to: URL(fileURLWithPath: privateRoot + "/ready.json"))
_ = try EditorBinding.ready(exchange.read("ready.json")!, pid: 999999, operation: .jsonValid)
try FileManager.default.createSymbolicLink(atPath: privateRoot + "/link.json", withDestinationPath: privateRoot + "/ready.json")
rejectedPolicy("reject symbolic exchange file") { _ = try exchange.read("link.json") }
try FileManager.default.linkItem(atPath: privateRoot + "/ready.json", toPath: privateRoot + "/hard.json")
rejectedPolicy("reject hard-linked exchange file") { _ = try exchange.read("hard.json") }
try Data(repeating: 32, count: 4097).write(to: URL(fileURLWithPath: privateRoot + "/large.json"))
rejectedPolicy("reject oversized exchange file") { _ = try exchange.read("large.json") }
expect(mkfifo(privateRoot + "/fifo.json", 0o600) == 0, "create private fixture FIFO")
rejectedPolicy("reject FIFO without blocking") { _ = try exchange.read("fifo.json") }
rejectedPolicy("missing acknowledgement times out") { try exchange.awaitAck(binding: binding, nonce: c, deadline: ProcessInfo.processInfo.systemUptime + 0.01) }
try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: privateRoot)
rejectedPolicy("reject changed root permissions") { _ = try exchange.read("request.json") }
rejectedPolicy("reject non-private root") { _ = try PrivateEditorExchange(privateRoot) }
try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: privateRoot)
rejectedPolicy("reject noncanonical root") { _ = try PrivateEditorExchange(privateRoot + "/../" + URL(fileURLWithPath: privateRoot).lastPathComponent) }
let timeline = ControllerTimeline()
try timeline.acceptScriptStages(Data("stage:click-start\\nstage:click-completed\\n".utf8), dispatch: "click")
try timeline.acceptScriptStages(Data("stage:select-all-start\\nstage:select-all-completed\\nstage:fixed-typing-start\\nstage:fixed-typing-completed\\n".utf8), dispatch: "type")
for forged in ["stage:click-completed\\nstage:click-start", "stage:unknown", "stage:fixed-typing-start", "stage:click-start", "stage:click-start\\nstage:click-completed\\nstage:private-key"] {
    rejectedPolicy("reject forged script stages") { try ControllerTimeline().acceptScriptStages(Data(forged.utf8), dispatch: "click") }
}
for _ in 0..<40 { timeline.record(.actionExit) }
expect(timeline.entries.count == 32 && timeline.overflow, "controller timeline bounds")
expect(!String(describing: timeline.entries).contains("private-key"), "no arbitrary stage strings retained")

print("Pure fixed operation and restoration ownership contracts passed")
`);
const policyBuild = execute('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(scratch, 'module-cache'), policyHarness, '-o', policyBinary], 60000);
assert.equal(policyBuild.status, 0, String(policyBuild.error ?? '') + policyBuild.stderr);
const policyResult = execute(policyBinary, []);
assert.equal(policyResult.status, 0, policyResult.stderr);
assert.match(policyResult.stdout, /Pure fixed operation and restoration ownership contracts passed/);
checks.push({ name: 'compiled pure fixed operation and mutation-owned restoration decisions', passed: true });
checks.push({ name: 'compiled final source verification retains unknown, failed restoration and intervening-change failures', passed: true });
checks.push({ name: 'compiled exact ready/ack forgery, private exchange file and bounded stage protocol policies', passed: true });
const absentTarget = execute(binary, ['target-inspect', bundle, '2147483647']);
assert.equal(absentTarget.status, 0, absentTarget.stderr);
const targetReport = JSON.parse(absentTarget.stdout);
assert.deepEqual(Object.keys(targetReport).sort(), ['targetPreflight', 'targetPreflightScope'].sort());
assert.deepEqual(targetReport.targetPreflight, { applicationRecordFound: false, recordTerminated: false,
  processPresent: false, bundleMatches: false, frontmostMatches: false, guardPassed: false });
assert.match(targetReport.targetPreflightScope, /AppKit application-record lookup and POSIX PID existence are separate/);
checks.push({ name: 'read-only target inspection reports bounded booleans for absent authorized PID', passed: true });
const presentProcess = execute(binary, ['target-inspect', bundle, String(process.pid)]);
assert.equal(presentProcess.status, 0, presentProcess.stderr);
const presentProcessReport = JSON.parse(presentProcess.stdout);
assert.equal(presentProcessReport.targetPreflight.processPresent, true);
assert.equal(presentProcessReport.targetPreflight.guardPassed, false);
checks.push({ name: 'POSIX probe distinguishes a present PID from a missing AppKit record', passed: true });
const executeWithoutTarget = execute(binary, args.map((value, index) => index === 0 ? 'execute' : value));
assert.equal(executeWithoutTarget.status, 1);
assert.match(executeWithoutTarget.stderr, /live foreground temporary app/);
const failedPreflight = JSON.parse(executeWithoutTarget.stdout).targetPreflight;
assert.equal(failedPreflight.guardPassed, false);
assert.equal(failedPreflight.applicationRecordFound, false);
assert.equal(failedPreflight.recordTerminated, false);
assert.equal(failedPreflight.processPresent, false);
assert.deepEqual(Object.keys(failedPreflight).sort(),
  ['applicationRecordFound', 'bundleMatches', 'frontmostMatches', 'guardPassed', 'processPresent', 'recordTerminated'].sort());
checks.push({ name: 'execute rejection returns precise bounded target preflight', passed: true });
const foreign = execute('/usr/bin/osascript', [script, 'com.apple.finder', '999999', 'plain-alpha', '400', '400', 'click']);
assert.equal(foreign.status, 1);
assert.match(foreign.stderr, /Temporary ATools application only/);
assert.equal(foreign.stdout, '');
checks.push({ name: 'AppleScript dynamically rejects foreign app before System Events access', passed: true });
const compiledScript = join(scratch, 'fixed-input.scpt');
const appleCompile = execute('/usr/bin/osacompile', ['-o', compiledScript, script]);
assert.equal(appleCompile.status, 0, appleCompile.stderr);
const guardHarness = join(scratch, 'guard-contract.applescript');
const systemEventsHandlerOffset = appleScript.indexOf('\non assertOwnedFocus(');
assert.ok(systemEventsHandlerOffset > 0, 'Pure guard declarations must precede System Events handler');
await writeFile(guardHarness, appleScript.slice(0, systemEventsHandlerOffset) + `
on run argv
  try
    if item 1 of argv is "window" then
      my assertOwnedWindowState((item 2 of argv is "true"), (item 3 of argv is "true"), "before-click")
    else
      my assertOwnedPID((item 2 of argv as integer), (item 3 of argv as integer), "before-character")
    end if
    return "accepted"
  on error messageText
    return messageText
  end try
end run
`);
for (const [windowIsOne, frontmost, reason] of [
  [true, true, 'accepted'], [false, true, 'window-count'],
  [true, false, 'not-frontmost'], [false, false, 'window-count'],
]) {
  const result = execute('/usr/bin/osascript', [guardHarness, 'window', String(windowIsOne), String(frontmost)]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(reason), result.stdout);
  if (reason !== 'accepted') assert.match(result.stdout, /dispatchStage=before-click/);
  checks.push({ name: `pure AppleScript window guard: windowIsOne=${windowIsOne} frontmost=${frontmost}`, passed: true });
}
for (const [actual, expected, reason] of [[123, 123, 'accepted'], [124, 123, 'pid-mismatch']]) {
  const result = execute('/usr/bin/osascript', [guardHarness, 'pid', String(actual), String(expected)]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(reason), result.stdout);
  if (reason !== 'accepted') assert.match(result.stdout, /dispatchStage=before-character/);
  checks.push({ name: `pure AppleScript PID guard: actual=${actual} expected=${expected}`, passed: true });
}
const beforeClick = appleScript.indexOf('my assertOwnedFocus(fixtureId, expectedPid, "before-click")');
const click = appleScript.indexOf('click at {pointX, pointY}');
const afterClick = appleScript.indexOf('my assertOwnedFocus(fixtureId, expectedPid, "after-click")');
const beforeSelectAll = appleScript.indexOf('my assertOwnedFocus(fixtureId, expectedPid, "before-select-all")');
const selectAll = appleScript.indexOf('keystroke "a" using command down');
const beforeCharacter = appleScript.indexOf('my assertOwnedFocus(fixtureId, expectedPid, "before-character")');
const character = appleScript.indexOf('keystroke (fixedCharacter as text)');
const beforeLinebreak = appleScript.indexOf('my assertOwnedFocus(fixtureId, expectedPid, "before-linebreak")');
const linebreak = appleScript.indexOf('key code 36 using shift down');
assert.ok(beforeClick >= 0 && beforeClick < click && click < afterClick && afterClick < beforeSelectAll && beforeSelectAll < selectAll);
assert.ok(selectAll < beforeCharacter && beforeCharacter < character && character < beforeLinebreak && beforeLinebreak < linebreak);
assert.equal((appleScript.match(/if \(count of candidates\) is not 1 then my rejectGuard\("candidate-count"/g) ?? []).length, 2);
assert.match(appleScript, /if not \(frontmost of fixtureProcess\) then my rejectGuard\("not-frontmost", dispatchStage\)/);
assert.match(appleScript, /my assertOwnedPID\(\(unix id of fixtureProcess\), expectedPid, dispatchStage\)/);
assert.match(appleScript, /set windowIsOne to \(count of windows\) is 1/);
assert.match(appleScript, /set isFrontmost to frontmost/);
assert.ok(appleScript.indexOf('set isFrontmost to frontmost') < appleScript.indexOf('my assertOwnedWindowState(windowIsOne, isFrontmost, "before-click")'));
assert.match(appleScript, /with timeout of 4 seconds/);
assert.match(swiftSource, /let actionDeadline = timeline\.started \+ 16/);
assert.match(swiftSource, /min\(actionDeadline, ProcessInfo\.processInfo\.systemUptime \+ 3\)/);
assert.doesNotMatch(appleScript, /\bactivate\b|set frontmost to|\bdelay\b/);
const inspector = await readFile(join(root, 'scripts/lib/native-editor-inspect.applescript'), 'utf8');
assert.doesNotMatch(inspector, /\bactivate\b|set frontmost to|keystroke|key code|click at/);
assert.match(appleScript, /\(count of argv\) is not 6/);
assert.match(appleScript, /actionStage is not in \{"click", "type"\}/);
assert.match(appleScript, /operation is "json-format" and actionStage is "type"/);
assert.ok(swiftSource.indexOf('let binding = try EditorBinding.ready') < swiftSource.indexOf('let original = currentSource()'));
assert.ok(swiftSource.indexOf('stage: "click", timeline:') < swiftSource.indexOf('try exchange.awaitAck('));
assert.ok(swiftSource.indexOf('try exchange.awaitAck(') < swiftSource.indexOf('stage: "type", timeline:'));
assert.doesNotMatch(swiftSource, /report\["actionResponse"\]|report\["actionError"\]/);
const abcPolicyStart = swiftSource.indexOf('if operation.requiresABC {');
const abcPolicyEnd = swiftSource.indexOf('\n        guard targetPreflight(', abcPolicyStart);
assert.ok(abcPolicyStart > 0 && abcPolicyEnd > abcPolicyStart);
const abcPolicy = swiftSource.slice(abcPolicyStart, abcPolicyEnd);
for (const required of ['sources().first', 'TISSelectInputSource(abc)', 'ABC selection unverified']) assert.ok(abcPolicy.includes(required));
assert.equal((swiftSource.match(/TISSelectInputSource\(original\)/g) ?? []).length, 1);
assert.match(swiftSource, /switch inputSourceRestorationDecision\(didSelectABC: didSelectABC, observedSourceID: afterActionID\)/);
assert.ok(swiftSource.indexOf('case .restoreOriginal:') < swiftSource.indexOf('TISSelectInputSource(original)'));
assert.match(swiftSource, /report\["passed"\] = actionError == nil && disposition\.verified && !timeline\.overflow/);
assert.match(swiftSource, /guard disposition\.verified else/);
checks.push({ name: 'static dispatch ordering, deadlines and ABC-only branch remain bounded', passed: true });
const after = { swift: hash(await readFile(swift)), appleScript: hash(await readFile(script)) };
assert.deepEqual(after, before);
const report = { schemaVersion: 1, passed: true, checks, sourceBefore: before, sourceAfter: after,
  binary: { path: binary, sha256: hash(await readFile(binary)) }, scratch,
  scope: 'Compiled boundary, validation-only and pure policy/guard handler checks; a foreign bundle was passed to AppleScript to verify rejection before System Events access. No fixed action, input source selection, System Events handler, GUI control, or UI input executed.' };
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ reportPath, passed: true, checks: checks.length, binary }));

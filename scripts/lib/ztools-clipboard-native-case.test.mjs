import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runNativeChild } from "./ztools-renderer-native-runtime.mjs";
import {
  buildClipboardNativeArgs,
  clipboardProcessTerminal,
  clipboardProcessSucceeded,
  createClipboardSpawnImpl,
  expectedClipboardOwner,
  launchStagedClipboardApp,
  parseClipboardNativeArgs,
} from "./ztools-clipboard-native-case.mjs";

const RUN_ID = "0123456789abcdef0123456789abcdef";
const ROOT = `/private/tmp/atools-renderer-clipboard-${RUN_ID}`;
const IDENTIFIER = `dev.atools.renderer-clipboard.${RUN_ID}`;

test("clipboard owner is derived only from a canonical 32-character run id", () => {
  assert.deepEqual(expectedClipboardOwner(RUN_ID), { runId: RUN_ID, root: ROOT, identifier: IDENTIFIER });
  for (const invalid of ["0123456789abcdef0123456789ABCDEf", "../bad", "0123456789abcdef"]) {
    assert.throws(() => expectedClipboardOwner(invalid));
  }
});

test("runner accepts exactly one absolute binary and build receipt", () => {
  assert.deepEqual(parseClipboardNativeArgs(["--binary", "/tmp/app", "--build-receipt", "/tmp/receipt.json"]), {
    binary: "/tmp/app", buildReceipt: "/tmp/receipt.json",
  });
  for (const invalid of [
    [],
    ["--binary", "relative", "--build-receipt", "/tmp/receipt.json"],
    ["--binary", "/tmp/app", "--build-receipt", "/tmp/receipt.json", "--journey", "settings"],
    ["--binary", "/tmp/app", "--binary", "/tmp/other", "--build-receipt", "/tmp/receipt.json"],
  ]) assert.throws(() => parseClipboardNativeArgs(invalid));
});

test("native args preserve the hidden single-process fixture contract", () => {
  assert.deepEqual(buildClipboardNativeArgs({
    fixtureRoot: ROOT, rendererDist: "/tmp/renderer", output: "/tmp/native-report.json", runId: RUN_ID,
  }), [
    "--fixture-root", ROOT,
    "--renderer-dist", "/tmp/renderer",
    "--output", "/tmp/native-report.json",
    "--auto-clear", "never",
    "--run-id", RUN_ID,
    "--journey", "clipboard-context",
  ]);
});

test("the case launches the staged bundle executable, never the build source binary", async () => {
  const sourceBinary = "/tmp/target/debug/atools";
  const bundlePath = "/tmp/run/case-never.app";
  const stagedExecutable = `${bundlePath}/Contents/MacOS/AToolsRendererSmoke`;
  let launchedPath = null;
  const launch = await launchStagedClipboardApp({
    stagedClipboard: { bundlePath, executable: stagedExecutable },
    sourceBinary,
    args: ["--journey", "clipboard-context"],
    options: { timeoutMs: 1 },
    runChild: async (binary, args, options) => {
      launchedPath = binary;
      assert.deepEqual(args, ["--journey", "clipboard-context"]);
      assert.deepEqual(options, { timeoutMs: 1 });
      return { spawned: true };
    },
  });
  assert.equal(launchedPath, stagedExecutable);
  assert.equal(launch.executablePath, stagedExecutable);
  assert.equal(launch.executablePath === sourceBinary, false);
  await assert.rejects(launchStagedClipboardApp({
    stagedClipboard: { bundlePath, executable: sourceBinary }, sourceBinary, args: [], options: {},
    runChild: async () => ({ spawned: true }),
  }));
  await assert.rejects(launchStagedClipboardApp({
    stagedClipboard: { bundlePath, executable: "/tmp/other/AToolsRendererSmoke" },
    sourceBinary, args: [], options: {}, runChild: async () => ({ spawned: true }),
  }));
});

test("natural exit requires no timeout termination attempt, no signals, and no exception", () => {
  const normal = {
    spawned: true, terminalObserved: true, exitCode: 0, signal: null, timedOut: false,
    termination: { attempted: false, signals: [] }, exception: null,
  };
  assert.equal(clipboardProcessSucceeded(normal), true);
  for (const invalid of [
    { ...normal, termination: { attempted: true, signals: [{ signal: "SIGTERM", accepted: true }] } },
    { ...normal, termination: { attempted: false, signals: [{ signal: "SIGTERM", accepted: false }] } },
    { ...normal, exception: { name: "Error", code: "EIO" } },
    { ...normal, termination: undefined },
    { ...normal, terminalObserved: false },
    { ...normal, timedOut: true },
  ]) assert.equal(clipboardProcessSucceeded(invalid), false);
});

test("sync spawn seam passes a real child through runNativeChild and waits for its close event", async () => {
  class ChildStub extends EventEmitter {
    constructor() {
      super();
      this.pid = 8123;
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
    }

    kill() { return true; }
  }

  const child = new ChildStub();
  const capture = { stdout: "", stderr: "" };
  const observation = {
    spawnAttempted: false, child: null, childHandleObserved: false, pid: null, closeObserved: false,
  };
  const spawnImpl = createClipboardSpawnImpl({
    observation,
    captures: {
      stdout: { append: chunk => { capture.stdout += Buffer.from(chunk).toString("utf8"); } },
      stderr: { append: chunk => { capture.stderr += Buffer.from(chunk).toString("utf8"); } },
    },
    spawnChild: (binary, args, options) => {
      assert.equal(binary, "/tmp/run/case-never.app/Contents/MacOS/AToolsRendererSmoke");
      assert.deepEqual(args, ["--journey", "clipboard-context"]);
      assert.equal(options.shell, false);
      assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
      return child;
    },
  });
  const launchPromise = launchStagedClipboardApp({
    stagedClipboard: {
      bundlePath: "/tmp/run/case-never.app",
      executable: "/tmp/run/case-never.app/Contents/MacOS/AToolsRendererSmoke",
    },
    sourceBinary: "/tmp/target/debug/atools",
    args: ["--journey", "clipboard-context"],
    options: { timeoutMs: 1000, spawnImpl },
    runChild: runNativeChild,
  });

  assert.strictEqual(observation.child, child);
  assert.equal(observation.childHandleObserved, true);
  assert.equal(observation.pid, 8123);
  assert.equal(clipboardProcessTerminal(observation, null), false);

  await new Promise(resolve => setImmediate(resolve));
  child.stdout.end("stdout evidence");
  child.stderr.end("stderr evidence");
  await new Promise(resolve => setImmediate(resolve));
  child.emit("close", 0, null);

  const launch = await launchPromise;
  assert.equal(launch.processResult.spawned, true);
  assert.equal(launch.processResult.terminalObserved, true);
  assert.equal(launch.processResult.exitCode, 0);
  assert.equal(launch.processResult.stdout.capturedBytes, 15);
  assert.equal(launch.processResult.stderr.capturedBytes, 15);
  assert.equal(capture.stdout, "stdout evidence");
  assert.equal(capture.stderr, "stderr evidence");
  assert.equal(observation.closeObserved, true);
  assert.equal(clipboardProcessTerminal(observation, launch.processResult), true);
});

test("an attempted spawn without a returned handle and observed close is never cleanup-safe", async () => {
  const makeObservation = overrides => ({
    spawnAttempted: true, child: null, childHandleObserved: false, pid: null, closeObserved: false,
    ...overrides,
  });
  assert.equal(clipboardProcessTerminal(makeObservation({ spawnAttempted: false }), null), true);
  assert.equal(clipboardProcessTerminal(makeObservation({ child: Promise.resolve({}) }), null), false);
  assert.equal(clipboardProcessTerminal(makeObservation({
    child: { once() {}, kill() {} }, childHandleObserved: true,
  }), null), false);
  assert.equal(clipboardProcessTerminal(makeObservation({
    child: { once() {}, kill() {} }, childHandleObserved: true, closeObserved: true,
  }), null), true);

  const observation = makeObservation();
  const failedSpawn = createClipboardSpawnImpl({
    observation,
    captures: { stdout: { append() {} }, stderr: { append() {} } },
    spawnChild() { throw Object.assign(new Error("spawn rejected"), { code: "ENOENT" }); },
  });
  const processResult = await runNativeChild("/missing/app", [], { spawnImpl: failedSpawn, timeoutMs: 10 });
  assert.equal(processResult.spawned, false);
  assert.equal(processResult.terminalObserved, false);
  assert.equal(clipboardProcessTerminal(observation, processResult), false);
});

test("a promise-shaped spawn result remains cleanup-unsafe without a child close event", async () => {
  const observation = {
    spawnAttempted: false, child: null, childHandleObserved: false, pid: null, closeObserved: false,
  };
  const spawnImpl = createClipboardSpawnImpl({
    observation,
    captures: { stdout: { append() {} }, stderr: { append() {} } },
    spawnChild: async () => ({ once() {}, kill() {}, pid: 8124 }),
  });
  const returned = spawnImpl("/tmp/app", [], {});
  assert.equal(typeof returned.then, "function");
  await returned;
  assert.equal(observation.spawnAttempted, true);
  assert.equal(observation.childHandleObserved, false);
  assert.equal(observation.pid, null);
  assert.equal(clipboardProcessTerminal(observation, null), false);
});


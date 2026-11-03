import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, chmod, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import Module from "node:module";
import { validateOfficeCliFixture, createOfficeCliProcessPolicySource } from "./office-cli-policy.mjs";
import { createOfficeCliTelemetryLineParser } from "./office-cli-telemetry.mjs";
import { createOriginalPluginNodeLaunch, originalPluginNodeOperationsPolicySource } from "./node-policy.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atools-office-cli-policy-")));
  const scratchRoot = join(root, "scratch");
  const binDirectory = join(scratchRoot, ".local", "bin");
  const inputDirectory = join(scratchRoot, "documents");
  await Promise.all([mkdir(binDirectory, { recursive: true }), mkdir(inputDirectory, { recursive: true })]);
  const binaryPath = join(binDirectory, "officecli");
  const inputPath = join(inputDirectory, "input.txt");
  const binaryBytes = Buffer.from(`pinned-officecli-${randomUUID()}`);
  await writeFile(binaryPath, binaryBytes, { mode: 0o700 });
  await chmod(binaryPath, 0o700);
  await writeFile(inputPath, "fixture input\n", { mode: 0o600 });
  t.after(async () => rm(root, { recursive: true, force: true }));
  return { root, scratchRoot, binaryPath, inputPath,
    officeCli: { binaryPath, sha256: createHash("sha256").update(binaryBytes).digest("hex"), inputPaths: [inputPath] } };
}

function fakeProcess() {
  const events = [];
  const handlers = new Map();
  const exits = [];
  const timers = new Map();
  let nextTimer = 0;
  const process = {
    env: { HOME: "/fixture/home", PATH: "/fixture/bin", OFFICECLI_NO_AUTO_RESIDENT: "0", OFFICECLI_SKIP_UPDATE: "0" },
    stderr: { write(line, callback) { if (line) events.push(JSON.parse(line.slice(line.indexOf("{")))); callback?.(); return true; } },
    stdin: { pause() {}, destroy() {} },
    once(name, callback) { handlers.set(name, callback); return this; },
    kill() { throw new Error("the fixture must never signal a numeric pid"); },
    exit(code) { exits.push(code); },
  };
  const setTimeout = (callback, milliseconds) => {
    const id = ++nextTimer;
    timers.set(id, { callback, milliseconds });
    return id;
  };
  const clearTimeout = id => timers.delete(id);
  return { process, events, handlers, exits, timers, setTimeout, clearTimeout };
}

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.killSignals = [];
  child.kill = signal => {
    child.killSignals.push(signal);
    if (child.exitCode === null && child.signalCode === null) {
      child.signalCode = signal;
      queueMicrotask(() => {
        child.emit("exit", null, signal);
        child.emit("close", null, signal);
      });
    }
    return true;
  };
  return child;
}

function codecStyleGetProperty(target, property) {
  let owner = target;
  for (let depth = 0; owner && depth < 16; depth += 1, owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, property);
    if (!descriptor) continue;
    return "value" in descriptor ? descriptor.value : descriptor.get ? descriptor.get.call(target) : undefined;
  }
  return undefined;
}

test("validates a hash-pinned executable and fixed inputs under the scratch root", async t => {
  const input = await fixture(t);
  const checked = await validateOfficeCliFixture(input.officeCli, "format-converter", input.scratchRoot);
  assert.equal(checked.binaryPath, input.binaryPath);
  assert.equal(checked.sha256, input.officeCli.sha256);
  assert.deepEqual(checked.inputPaths, [input.inputPath]);
  assert.equal(checked.scratchRoot, input.scratchRoot);
  assert.throws(() => createOfficeCliProcessPolicySource({ ...checked }, "ATFC"), /validated/u);
});

test("only the optional converter fixture enables the product Node child-process permission", async t => {
  const input = await fixture(t);
  const env = { PATH: join(input.scratchRoot, ".local", "bin"), HOME: join(input.scratchRoot, "home"),
    XDG_DATA_HOME: input.scratchRoot };
  const base = { root: process.cwd(), pluginRoot: join(input.scratchRoot, "plugin"),
    preloadPath: join(input.scratchRoot, "plugin", "preload.cjs"), scratchRoot: input.scratchRoot,
    pluginDataRoot: join(input.scratchRoot, "data"), fixtureEnv: env };
  const liveMarkdown = await createOriginalPluginNodeLaunch({ ...base, pluginId: "live-markdown" });
  assert.equal(liveMarkdown.args.includes("--allow-child-process"), false);
  const policy = await validateOfficeCliFixture(input.officeCli, "format-converter", input.scratchRoot);
  const formatConverter = await createOriginalPluginNodeLaunch({ ...base, pluginId: "format-converter", officeCli: policy });
  assert.equal(formatConverter.args.includes("--allow-child-process"), true);
  assert.match(formatConverter.args.at(-1), /OFFICECLI_NO_AUTO_RESIDENT/u);
  assert.doesNotThrow(() => new vm.Script(Module.wrap(formatConverter.args.at(-1))));
});

test("default Node mode denies common child_process methods without launching a process", () => {
  let processCalls = 0;
  const denialLines = [];
  const methods = ["execFile", "spawn", "exec", "execSync", "execFileSync", "spawnSync", "fork"];
  const fakeChildProcess = Object.fromEntries(methods.map(name => [name, () => { processCalls += 1; }]));
  Object.defineProperty(fakeChildProcess, "promises", { configurable: true, enumerable: true,
    get() { return { execFile() { processCalls += 1; } }; } });
  const fakeNet = { Socket: function Socket() {}, Server: function Server() {}, isIP: () => 0 };
  fakeNet.Socket.prototype.connect = () => {};
  fakeNet.Server.prototype.listen = () => {};
  let loadedChildProcess = fakeChildProcess;
  const fakeModule = {
    _load(request) {
      if (request === "node:module") return fakeModule;
      if (request === "node:net") return fakeNet;
      if (request === "node:child_process") return loadedChildProcess;
      throw new Error(`Unexpected module request ${request}`);
    },
  };
  const process = { stderr: { write(line) { denialLines.push(line); } } };
  const source = originalPluginNodeOperationsPolicySource("live-markdown");
  vm.runInNewContext(source, { process, require: request => fakeModule._load(request) });
  const guarded = fakeModule._load("node:child_process");
  assert.equal(codecStyleGetProperty(guarded, "execFile"), codecStyleGetProperty(guarded, "execFile"));
  for (const method of methods) {
    const callable = ["execFile", "spawn"].includes(method) ? codecStyleGetProperty(guarded, method) : guarded[method];
    assert.throws(() => Reflect.apply(callable, guarded, ["/fixture/any-command", ["--version"], () => {}]),
      { code: "ERR_ATOOLS_FIXTURE_CHILD_PROCESS_DENIED" }, method);
  }
  const guardedPromises = codecStyleGetProperty(guarded, "promises");
  const promisedExecFile = codecStyleGetProperty(guardedPromises, "execFile");
  assert.throws(() => Reflect.apply(promisedExecFile, guardedPromises, ["/fixture/any-command", []]),
    { code: "ERR_ATOOLS_FIXTURE_CHILD_PROCESS_DENIED" });
  assert.equal(processCalls, 0);
  assert.equal(denialLines.length, methods.length + 1);

  const fixedExports = {};
  Object.defineProperty(fixedExports, "execFile", { value() { processCalls += 1; }, enumerable: true });
  loadedChildProcess = fixedExports;
  const fixedGuard = fakeModule._load("node:child_process");
  assert.throws(() => codecStyleGetProperty(fixedGuard, "execFile"), /fixed child_process export/u);
  assert.equal(processCalls, 0);
});

test("rejects invalid plugin scope, changed binary, symlinks, escaping inputs and excess paths", async t => {
  const input = await fixture(t);
  await assert.rejects(validateOfficeCliFixture(input.officeCli, "live-markdown", input.scratchRoot), /format-converter/u);
  await assert.rejects(validateOfficeCliFixture({ ...input.officeCli, sha256: "0".repeat(64) }, "format-converter", input.scratchRoot), /SHA-256/u);
  await assert.rejects(validateOfficeCliFixture({ ...input.officeCli, inputPaths: [join(input.root, "outside.txt")] },
    "format-converter", input.scratchRoot), /scratchRoot/u);
  await writeFile(join(input.root, "outside.txt"), "outside\n");
  const linkPath = join(input.scratchRoot, "linked-officecli");
  const inputLinkPath = join(input.scratchRoot, "linked-input.txt");
  await symlink(input.binaryPath, linkPath);
  await symlink(input.inputPath, inputLinkPath);
  await assert.rejects(validateOfficeCliFixture({ ...input.officeCli, binaryPath: linkPath },
    "format-converter", input.scratchRoot), /symlink|canonical/u);
  await assert.rejects(validateOfficeCliFixture({ ...input.officeCli, inputPaths: [inputLinkPath] },
    "format-converter", input.scratchRoot), /symlink|canonical/u);
  await assert.rejects(validateOfficeCliFixture({ ...input.officeCli, inputPaths: Array(4).fill(input.inputPath) },
    "format-converter", input.scratchRoot), /three|3/u);
});

test("generated child policy permits only the pinned version and fixed text-view invocations", async t => {
  const input = await fixture(t);
  const policy = await validateOfficeCliFixture(input.officeCli, "format-converter", input.scratchRoot);
  const host = fakeProcess();
  const runtime = vm.runInNewContext(createOfficeCliProcessPolicySource(policy, "ATFC"), {
    process: host.process, setTimeout: host.setTimeout, clearTimeout: host.clearTimeout, queueMicrotask,
  });
  const rawCalls = [];
  const children = [];
  const childProcess = {
    execFile(...args) { rawCalls.push({ method: "execFile", args }); const child = fakeChild(4100 + children.length); children.push(child); return child; },
    spawn(...args) { rawCalls.push({ method: "spawn", args }); const child = fakeChild(4100 + children.length); children.push(child); return child; },
    execFileSync() { throw new Error("must be denied"); },
  };
  const deny = method => { throw Object.assign(new Error(`denied ${method}`), { code: "ERR_ATOOLS_FIXTURE_CHILD_PROCESS_DENIED" }); };
  const guarded = runtime.guardChildProcess(childProcess, "node:child_process", deny);
  const versionChild = guarded.execFile(input.binaryPath, ["--version"],
    { windowsHide: true, timeout: 5000, encoding: "utf8" }, () => {});
  assert.ok([...host.timers.values()].some(timer => timer.milliseconds === 5000));
  versionChild.emit("spawn");
  versionChild.exitCode = 0;
  versionChild.emit("exit", 0, null);
  versionChild.emit("close", 0, null);
  const viewChild = guarded.spawn(input.binaryPath,
    ["view", input.inputPath, "text", "--max-lines", "100000"],
    { cwd: undefined, env: { OFFICECLI_NO_AUTO_RESIDENT: "1", OFFICECLI_SKIP_UPDATE: "1", CALLER_SECRET: "untrusted" }, shell: false, windowsHide: true,
      detached: true, stdio: ["ignore", "pipe", "pipe"] });
  assert.ok([...host.timers.values()].some(timer => timer.milliseconds === 15_000));
  viewChild.emit("spawn");
  viewChild.exitCode = 0;
  viewChild.emit("exit", 0, null);
  viewChild.emit("close", 0, null);

  let deniedVersionProbe;
  let deniedVersionProbeCalls = 0;
  const rejectedProbeResult = guarded.execFile(input.binaryPath, ["--help"],
    { windowsHide: true, timeout: 5000, encoding: "utf8" }, error => {
      deniedVersionProbe = error;
      deniedVersionProbeCalls += 1;
    });
  assert.equal(rejectedProbeResult, undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(deniedVersionProbe.code, "ERR_ATOOLS_FIXTURE_CHILD_PROCESS_DENIED");
  assert.equal(deniedVersionProbeCalls, 1);
  let deniedOtherPath;
  let deniedOtherPathCalls = 0;
  guarded.execFile("/fixture/not-officecli", ["--version"],
    { windowsHide: true, timeout: 5000, encoding: "utf8" }, error => {
      deniedOtherPath = error;
      deniedOtherPathCalls += 1;
    });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(deniedOtherPath.code, "ERR_ATOOLS_FIXTURE_CHILD_PROCESS_DENIED");
  assert.equal(deniedOtherPathCalls, 1);
  assert.throws(() => guarded.spawn("/bin/sh", ["-c", "true"], { shell: false }), /denied/u);
  assert.throws(() => guarded.spawn(input.binaryPath,
    ["view", join(input.scratchRoot, "other.txt"), "text", "--max-lines", "100000"],
    { shell: false, windowsHide: true, detached: true, stdio: ["ignore", "pipe", "pipe"] }), /denied/u);
  assert.throws(() => guarded.execFileSync(input.binaryPath, ["--version"]), /denied/u);

  assert.equal(rawCalls.length, 2);
  assert.equal(rawCalls[0].args[0], input.binaryPath);
  assert.equal(rawCalls[0].args[1][0], "--version");
  assert.equal(rawCalls[0].args[2].shell, false);
  assert.equal(rawCalls[0].args[2].cwd, input.scratchRoot);
  assert.equal(rawCalls[0].args[2].timeout, 0);
  assert.equal(rawCalls[0].args[2].env.OFFICECLI_NO_AUTO_RESIDENT, "1");
  assert.equal(rawCalls[0].args[2].env.OFFICECLI_SKIP_UPDATE, "1");
  assert.equal(rawCalls[1].args[2].detached, true);
  assert.equal(rawCalls[1].args[2].shell, false);
  assert.equal(rawCalls[1].args[2].cwd, input.scratchRoot);
  assert.equal(rawCalls[1].args[2].env.OFFICECLI_SKIP_UPDATE, "1");
  assert.equal(rawCalls[1].args[2].env.CALLER_SECRET, undefined);
  assert.equal(host.process.env.OFFICECLI_NO_AUTO_RESIDENT, "0");
  assert.equal(runtime.snapshot().attempts, 2);
  assert.equal(runtime.snapshot().versionCalls, 1);
  assert.equal(runtime.snapshot().viewCalls, 1);
  assert.equal(runtime.snapshot().denials, 5);
  assert.ok(host.events.some(event => event.event === "attempt" && event.operation === "version"));
  assert.ok(host.events.some(event => event.event === "attempt" && event.operation === "view"));
  assert.equal(JSON.stringify(runtime.snapshot().environmentPolicy),
    JSON.stringify({ privateFixtureEnv: true, noAutoResident: true, skipUpdate: true,
      workingDirectoryPolicy: "scratchRoot" }));
  assert.equal(runtime.snapshot().childLifecycleScope, "direct-child-only");
});

test("codec descriptor lookup reaches the optional child gate and records serialized events", async t => {
  const input = await fixture(t);
  const policy = await validateOfficeCliFixture(input.officeCli, "format-converter", input.scratchRoot);
  const host = fakeProcess();
  const stderrChunks = [];
  host.process.stderr.write = (chunk, callback) => {
    stderrChunks.push(Buffer.from(chunk));
    callback?.();
    return true;
  };
  const rawCalls = [];
  const child = fakeChild(4501);
  const childProcess = {
    execFile(...args) { rawCalls.push({ method: "execFile", args }); return child; },
    spawn(...args) { rawCalls.push({ method: "spawn", args }); throw new Error("non-allowlisted spawn reached raw module"); },
  };
  const fakeNet = { Socket: function Socket() {}, Server: function Server() {}, isIP: () => 0 };
  fakeNet.Socket.prototype.connect = () => {};
  fakeNet.Server.prototype.listen = () => {};
  const fakeModule = {
    _load(request) {
      if (request === "node:module") return fakeModule;
      if (request === "node:net") return fakeNet;
      if (request === "node:child_process") return childProcess;
      throw new Error(`Unexpected module request ${request}`);
    },
  };
  const policySource = originalPluginNodeOperationsPolicySource("format-converter", policy);
  vm.runInNewContext(policySource, { process: host.process, require: request => fakeModule._load(request),
    setTimeout: host.setTimeout, clearTimeout: host.clearTimeout, queueMicrotask });
  const guarded = fakeModule._load("node:child_process");
  const versionMethod = codecStyleGetProperty(guarded, "execFile");
  assert.equal(versionMethod, codecStyleGetProperty(guarded, "execFile"));
  const versionChild = Reflect.apply(versionMethod, guarded, [input.binaryPath, ["--version"],
    { windowsHide: true, timeout: 5000, encoding: "utf8" }, () => {}]);
  versionChild.emit("spawn");
  versionChild.emit("exit", 0, null);
  versionChild.emit("close", 0, null);
  const spawnMethod = codecStyleGetProperty(guarded, "spawn");
  assert.throws(() => Reflect.apply(spawnMethod, guarded, ["/bin/sh", ["-c", "true"],
    { cwd: input.scratchRoot, env: { OFFICECLI_NO_AUTO_RESIDENT: "1", OFFICECLI_SKIP_UPDATE: "1" },
      shell: false, windowsHide: true, detached: true, stdio: ["ignore", "pipe", "pipe"] }]),
  { code: "ERR_ATOOLS_FIXTURE_CHILD_PROCESS_DENIED" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rawCalls.length, 1);
  assert.equal(rawCalls[0].method, "execFile");

  const rawStderr = Buffer.concat(stderrChunks);
  assert.match(rawStderr.toString("utf8"), /ATFC_OFFICECLI_EVENT .*\n/u);
  assert.equal(rawStderr.toString("utf8").includes("\\n"), false);
  const telemetry = { enabled: true, attempts: 0, versionCalls: 0, viewCalls: 0, started: 0, exited: 0, closed: 0,
    errors: 0, nonzeroExits: 0, killRequests: 0, killed: 0, denials: 0, deadlines: 0, cleanupFailures: 0,
    pids: [], events: [], activePids: new Set() };
  const stats = { pluginId: "format-converter", helperProcesses: telemetry, denials: { childProcess: 0, externalNetwork: 0 } };
  const parser = createOfficeCliTelemetryLineParser(stats, "ATFC");
  for (let offset = 0; offset < rawStderr.length;) {
    const size = Math.min((offset % 17) + 1, rawStderr.length - offset);
    parser.push(rawStderr.subarray(offset, offset + size));
    offset += size;
  }
  parser.flush();

  assert.equal(telemetry.enabled, true);
  assert.equal(telemetry.attempts, 1);
  assert.equal(telemetry.versionCalls, 1);
  assert.equal(telemetry.viewCalls, 0);
  assert.equal(telemetry.started, 1);
  assert.equal(telemetry.exited, 1);
  assert.equal(telemetry.closed, 1);
  assert.equal(telemetry.nonzeroExits, 0);
  assert.equal(telemetry.denials, 1);
  assert.equal(telemetry.activePids.size, 0);
  assert.equal(stats.denials.childProcess, 1);
  assert.equal(telemetry.events.filter(event => event.event === "attempt").length, 1);
  assert.equal(telemetry.events.filter(event => event.event === "denied").length, 1);
  assert.deepEqual(telemetry.events.filter(event => event.event === "exit").map(event => event.code), [0]);
});

test("helper shutdown signals owned ChildProcess references and waits for close", async t => {
  const input = await fixture(t);
  const policy = await validateOfficeCliFixture(input.officeCli, "format-converter", input.scratchRoot);
  const host = fakeProcess();
  const runtime = vm.runInNewContext(createOfficeCliProcessPolicySource(policy, "ATFC"), {
    process: host.process, setTimeout: host.setTimeout, clearTimeout: host.clearTimeout, queueMicrotask,
  });
  let child;
  const guarded = runtime.guardChildProcess({ spawn() { child = fakeChild(4201); return child; } },
    "node:child_process", method => { throw new Error(method); });
  guarded.spawn(input.binaryPath, ["view", input.inputPath, "text", "--max-lines", "100000"],
    { cwd: undefined, env: { OFFICECLI_NO_AUTO_RESIDENT: "1", OFFICECLI_SKIP_UPDATE: "1" }, shell: false,
      windowsHide: true, detached: false, stdio: ["ignore", "pipe", "pipe"] });
  child.emit("spawn");
  assert.equal(runtime.snapshot().closeConfirmed, false);
  await runtime.shutdown("SIGTERM");
  assert.deepEqual(child.killSignals, ["SIGTERM"]);
  assert.equal(runtime.snapshot().active, 0);
  assert.equal(runtime.snapshot().closed, 1);
  assert.equal(runtime.snapshot().closeConfirmed, true);
  assert.deepEqual(host.exits, [143]);
});

test("helper deadline terminates through its owned child reference", async t => {
  const input = await fixture(t);
  const policy = await validateOfficeCliFixture(input.officeCli, "format-converter", input.scratchRoot);
  const host = fakeProcess();
  const runtime = vm.runInNewContext(createOfficeCliProcessPolicySource(policy, "ATFC"), {
    process: host.process, setTimeout: host.setTimeout, clearTimeout: host.clearTimeout, queueMicrotask,
  });
  let child;
  const guarded = runtime.guardChildProcess({ execFile() { child = fakeChild(4301); return child; } },
    "node:child_process", method => { throw new Error(method); });
  guarded.execFile(input.binaryPath, ["--version"],
    { windowsHide: true, timeout: 5000, encoding: "utf8" }, () => {});
  child.emit("spawn");
  const deadline = [...host.timers.values()].find(timer => timer.milliseconds === 5000);
  deadline.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(child.killSignals, ["SIGTERM"]);
  assert.equal(runtime.snapshot().deadlines, 1);
  assert.equal(runtime.snapshot().killRequests, 1);
  assert.equal(runtime.snapshot().active, 0);
  assert.equal(runtime.snapshot().closeConfirmed, true);
});

test("plugin cancellation uses and records the returned owned ChildProcess reference", async t => {
  const input = await fixture(t);
  const policy = await validateOfficeCliFixture(input.officeCli, "format-converter", input.scratchRoot);
  const host = fakeProcess();
  const runtime = vm.runInNewContext(createOfficeCliProcessPolicySource(policy, "ATFC"), {
    process: host.process, setTimeout: host.setTimeout, clearTimeout: host.clearTimeout, queueMicrotask,
  });
  let child;
  const guarded = runtime.guardChildProcess({ spawn() { child = fakeChild(4351); return child; } },
    "node:child_process", method => { throw new Error(method); });
  guarded.spawn(input.binaryPath, ["view", input.inputPath, "text", "--max-lines", "100000"],
    { cwd: undefined, env: { OFFICECLI_NO_AUTO_RESIDENT: "1", OFFICECLI_SKIP_UPDATE: "1" }, shell: false,
      windowsHide: true, detached: false, stdio: ["ignore", "pipe", "pipe"] });
  child.emit("spawn");
  assert.equal(child.kill("SIGTERM"), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.snapshot().killRequests, 1);
  assert.equal(runtime.snapshot().killed, 1);
  assert.ok(host.events.some(event => event.event === "kill" && event.reason === "child-reference"));
  assert.equal(runtime.snapshot().closeConfirmed, true);
});

test("helper policy enforces two concurrent and sixteen total accepted processes", async t => {
  const input = await fixture(t);
  const policy = await validateOfficeCliFixture(input.officeCli, "format-converter", input.scratchRoot);
  const host = fakeProcess();
  const runtime = vm.runInNewContext(createOfficeCliProcessPolicySource(policy, "ATFC"), {
    process: host.process, setTimeout: host.setTimeout, clearTimeout: host.clearTimeout, queueMicrotask,
  });
  const children = [];
  const guarded = runtime.guardChildProcess({
    execFile() { const child = fakeChild(4400 + children.length); children.push(child); return child; },
  }, "node:child_process", method => { throw Object.assign(new Error(`denied ${method}`),
    { code: "ERR_ATOOLS_FIXTURE_CHILD_PROCESS_DENIED" }); });
  const start = () => guarded.execFile(input.binaryPath, ["--version"],
    { windowsHide: true, timeout: 15_000, encoding: "utf8" }, () => {});
  const close = child => {
    child.exitCode = 0;
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  };
  const first = start();
  const second = start();
  assert.throws(start, /denied/u);
  first.emit("spawn");
  second.emit("spawn");
  assert.throws(start, /denied/u);
  close(first);
  close(second);
  for (let index = 2; index < 16; index += 1) {
    const child = start();
    child.emit("spawn");
    close(child);
  }
  assert.throws(start, /denied/u);
  assert.equal(runtime.snapshot().versionCalls, 16);
  assert.equal(runtime.snapshot().started, 16);
  assert.equal(runtime.snapshot().closed, 16);
  assert.equal(runtime.snapshot().denials, 3);
  assert.equal(runtime.snapshot().active, 0);
  assert.equal(runtime.snapshot().closeConfirmed, true);
});

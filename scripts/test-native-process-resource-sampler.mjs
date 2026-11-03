import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
  captureNativeProcessIdentity, createNativeProcessResourceSampler, parseCpuTimeSeconds,
  parseProcessSnapshot, sameProcessIdentity,
} from "./lib/native-process-resource-sampler.mjs";

const line = ({ pid, ppid = 1, pgid = pid, startedAt = "Tue Oct 13 12:00:00 2026", rss = 100, cpu = "00:00:01", command = "/Applications/ATools.app/Contents/MacOS/ATools" }) =>
  `${pid} ${ppid} ${pgid} ${startedAt} ${rss} ${cpu} ${command}`;

test("parses ps CPU clocks and KiB resource rows without %CPU", () => {
  assert.equal(parseCpuTimeSeconds("00:02:03"), 123);
  assert.equal(parseCpuTimeSeconds("02:03.50"), 123.5);
  assert.equal(parseCpuTimeSeconds("152:28.86"), 9148.86);
  assert.equal(parseCpuTimeSeconds("1-02:03:04.25"), 93784.25);
  const rows = parseProcessSnapshot([line({ pid: 44, rss: 512, cpu: "00:00:02.50" })].join("\n"));
  assert.equal(rows.get(44).rssKiB, 512);
  assert.equal(rows.get(44).cpuSeconds, 2.5);
  assert.throws(() => parseCpuTimeSeconds("not-a-clock"), /Invalid cumulative/);
});

test("attributes only exact root identity and its exclusive process group, excluding baseline and WebKit candidates", async () => {
  const first = parseProcessSnapshot([
    line({ pid: 100, pgid: 100, rss: 200, cpu: "00:00:01" }),
    line({ pid: 101, ppid: 100, pgid: 100, rss: 50, cpu: "00:00:02", command: "node" }),
    line({ pid: 104, ppid: 100, pgid: 100, rss: 10, cpu: "00:00:10", command: "/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/WebKitGPU.xpc/Contents/MacOS/WebKitGPU" }),
    line({ pid: 102, ppid: 1, pgid: 1, rss: 999, cpu: "00:00:10", command: "/System/Library/Frameworks/WebKit.framework/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent" }),
    line({ pid: 103, ppid: 1, pgid: 1, rss: 777, cpu: "00:00:08", command: "unrelated" }),
  ].join("\n"));
  const identity = await captureNativeProcessIdentity(100, { readSnapshot: async () => first });
  assert.deepEqual(identity, { pid: 100, pgid: 100, startedAt: "Tue Oct 13 12:00:00 2026", command: "/Applications/ATools.app/Contents/MacOS/ATools", executableAssertion: "not-checked" });
  const wrongExecutable = parseProcessSnapshot(line({ pid: 109, command: process.execPath }).replace("\n", ""));
  await assert.rejects(captureNativeProcessIdentity(109, { readSnapshot: async () => wrongExecutable, expectedExecutable: "/bin/sh" }), /canonical executable path/);
  const fullCommand = parseProcessSnapshot(line({ pid: 110, command: process.execPath }).replace("\n", ""));
  const canonical = await captureNativeProcessIdentity(110, { readSnapshot: async () => fullCommand, expectedExecutable: process.execPath });
  assert.equal(canonical.executableAssertion, "canonical-path");
  const basenameOnlyRows = parseProcessSnapshot(line({ pid: 111, command: "node" }).replace("\n", ""));
  const basenameOnly = await captureNativeProcessIdentity(111, { readSnapshot: async () => basenameOnlyRows, expectedExecutable: process.execPath });
  assert.equal(basenameOnly.executableAssertion, "basename-only");
  let capture = 0;
  const sampler = createNativeProcessResourceSampler({ rootIdentity: identity, now: (() => { let value = 0; return () => value += 500; })(),
    readSnapshot: async () => capture++ === 0 ? first : second });
  const initial = await sampler.sample();
  assert.equal(initial.rssBytes, 260 * 1024);
  assert.deepEqual(initial.processes.map(row => row.pid), [100, 101, 104]);
  assert.deepEqual(initial.unattributedWebKitCandidates, [{ pid: 102, rssBytes: 999 * 1024 }]);
  assert.equal(initial.cpuPercentOneCore, null);

  const second = parseProcessSnapshot([
    line({ pid: 100, pgid: 100, rss: 220, cpu: "00:00:02" }),
    line({ pid: 101, ppid: 100, pgid: 100, rss: 50, cpu: "00:00:03", command: "node" }),
    line({ pid: 104, ppid: 100, pgid: 100, rss: 10, cpu: "00:00:10", command: "/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/WebKitGPU.xpc/Contents/MacOS/WebKitGPU" }),
    line({ pid: 102, ppid: 1, pgid: 1, rss: 1000, cpu: "00:00:11", command: "/System/Library/Frameworks/WebKit.framework/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent" }),
    line({ pid: 103, ppid: 1, pgid: 1, rss: 777, cpu: "00:00:09", command: "unrelated" }),
  ].join("\n"));
  const measured = await sampler.sample();
  assert.equal(measured.rssBytes, 280 * 1024);
  assert.equal(measured.cpuSecondsDelta, 2);
  assert.equal(measured.cpuPercentOneCore, 400);
  assert.equal(sampler.report().coverage.lastSampleRootLive, true);
  assert.equal(sampler.report().coverage.launchedExecutableAssertion, "not-checked");
  assert.match(sampler.report().rssMetric, /not physical footprint/);
  assert.match(sampler.report().cpuCoverage, /New or exited-between-snapshot processes are omitted/);
});

test("CPU deltas count only exact identities present at both sample endpoints", async () => {
  const root1 = parseProcessSnapshot(line({ pid: 150, pgid: 150, cpu: "00:00:01.00" }).replace("\n", ""));
  const burst = parseProcessSnapshot([
    line({ pid: 150, pgid: 150, cpu: "00:00:01.25" }),
    line({ pid: 151, ppid: 150, pgid: 150, cpu: "00:00:10.00", command: "short-lived" }),
  ].join("\n"));
  const afterBurst = parseProcessSnapshot(line({ pid: 150, pgid: 150, cpu: "00:00:01.75" }).replace("\n", ""));
  const snapshots = [root1, burst, afterBurst];
  const sampler = createNativeProcessResourceSampler({ rootIdentity: root1.get(150),
    now: (() => { let value = 0; return () => value += 500; })(), readSnapshot: async () => snapshots.shift() });
  await sampler.sample();
  const during = await sampler.sample();
  assert.equal(during.cpuSecondsDelta, 0.25);
  assert.equal(during.cpuPercentOneCore, 50);
  const after = await sampler.sample();
  assert.equal(after.cpuSecondsDelta, 0.5);
  assert.equal(after.cpuPercentOneCore, 100);
  assert.match(sampler.report().cpuCoverage, /may understate whole-group CPU/);
});

test("excludes a reused root PID when its creation identity changes", async () => {
  const original = parseProcessSnapshot(line({ pid: 200, pgid: 200 }).replace("\n", "")).get(200);
  const replacement = parseProcessSnapshot(line({ pid: 200, pgid: 200, startedAt: "Tue Oct 13 12:00:01 2026", rss: 900 }).replace("\n", "")).get(200);
  const identity = { ...original };
  assert.equal(sameProcessIdentity(identity, replacement), false);
  const sampler = createNativeProcessResourceSampler({ rootIdentity: identity, readSnapshot: async () => new Map([[200, replacement]]) });
  const sample = await sampler.sample();
  assert.equal(sample.rootLive, false);
  assert.equal(sample.rssBytes, 0);
});

test("includes an explicitly pinned helper only while its exact identity still matches", async () => {
  const root = parseProcessSnapshot(line({ pid: 300, pgid: 300 }).replace("\n", "")).get(300);
  const helper = parseProcessSnapshot(line({ pid: 301, pgid: 9, ppid: 1, command: "node" }).replace("\n", "")).get(301);
  const staleHelper = { ...helper, startedAt: "Tue Oct 13 12:00:01 2026" };
  const sampler = createNativeProcessResourceSampler({ rootIdentity: root, pinnedIdentities: [helper], readSnapshot: async () => new Map([[300, root], [301, helper]]) });
  assert.deepEqual((await sampler.sample()).processes.map(item => item.pid), [300, 301]);
  const stale = createNativeProcessResourceSampler({ rootIdentity: root, pinnedIdentities: [staleHelper], readSnapshot: async () => new Map([[300, root], [301, helper]]) });
  assert.deepEqual((await stale.sample()).processes.map(item => item.pid), [300]);
});

test("after root exit, retains only previously observed exact group descendants then closes the group", async () => {
  const initial = parseProcessSnapshot([
    line({ pid: 350, pgid: 350, rss: 100 }),
    line({ pid: 351, ppid: 350, pgid: 350, rss: 80, command: "node" }),
  ].join("\n"));
  const childOnly = parseProcessSnapshot(line({ pid: 351, ppid: 1, pgid: 350, rss: 90, command: "node" }));
  const reused = parseProcessSnapshot(line({ pid: 352, ppid: 1, pgid: 350, startedAt: "Tue Oct 13 12:00:01 2026", rss: 999, command: "unrelated" }));
  let current = initial;
  const sampler = createNativeProcessResourceSampler({ rootIdentity: initial.get(350), readSnapshot: async () => current });
  assert.deepEqual((await sampler.sample()).processes.map(item => item.pid), [350, 351]);
  current = childOnly;
  assert.deepEqual((await sampler.sample()).processes.map(item => item.pid), [351]);
  current = new Map();
  assert.equal((await sampler.sample()).processGroupClosed, true);
  current = reused;
  assert.deepEqual((await sampler.sample()).processes, []);
});

test("samples a short-lived benign owned Node process on macOS", { skip: process.platform !== "darwin" }, async t => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 2500)"], { detached: true, stdio: "ignore" });
  const exited = new Promise(resolve => child.once("exit", resolve));
  try {
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    let identity;
    try { identity = await captureNativeProcessIdentity(child.pid, { expectedExecutable: process.execPath }); }
    catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") { t.skip("system process listing is unavailable in this execution sandbox"); return; }
      throw error;
    }
    const sampler = createNativeProcessResourceSampler({ rootIdentity: identity });
    const first = await sampler.sample();
    assert.equal(first.rootLive, true);
    assert.ok(["canonical-path", "basename-only"].includes(identity.executableAssertion));
    assert.ok(first.rssBytes > 0);
    assert.equal(first.processes[0].pid, child.pid);
    await new Promise(resolve => setTimeout(resolve, 75));
    const second = await sampler.sample();
    assert.equal(second.rootLive, true);
    assert.ok(Number.isFinite(second.cpuPercentOneCore));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await exited;
  }
});

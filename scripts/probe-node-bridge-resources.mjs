#!/usr/bin/env node
// Real Node codec + current frontend runtime in one VM, with explicit GC.
// This checks ownership, not IPC latency, process isolation, WebKit GC, or RSS.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { loadHostFactories } from "./lib/legacy-node-webkit-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv.find(arg => arg.endsWith(".json"))
  ?? join(root, "output/legacy-node-2026-10-15/node-bridge-resources.json"));
if (typeof globalThis.gc !== "function") {
  const result = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), output], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
const scratch = await mkdtemp("/private/tmp/atools-node-resources-");
const report = { scope: "Current frontend bridge and actual Node codec dispatch in a Node VM with forced GC. No IPC latency, WebKit GC schedule, process RSS or production acceptance claim.", passed: false };
let runtime;
try {
  const entry = join(scratch, "preload.cjs");
  await writeFile(entry, "throw Error('preload must remain local');");
  await writeFile(join(scratch, "helper.cjs"), "module.exports={allocate(){return {value:1}},noop(){return true},sharedPromise:Promise.resolve({value:42})};");
  const codec = await readFile(join(root, "crates/atools-plugin/src/legacy_node/codec.cjs"), "utf8");
  const bootstrap = await readFile(join(root, "crates/atools-plugin/src/legacy_node/bootstrap.cjs"), "utf8");
  // Use the unchanged worker dispatch; only exclude its stdin listener.
  const source = codec + "\n" + bootstrap.slice(0, bootstrap.indexOf("readline.createInterface("))
    + "\n({dispatch,handles,promiseStates})";
  const worker = vm.runInNewContext(source, { require: createRequire(import.meta.url), Buffer, setTimeout,
    process: { ...process, env: { ...process.env, ATOOLS_PRELOAD_ENTRY: entry } }, console: {} });
  const factories = await loadHostFactories(root, scratch);
  const requests = {};
  let released = 0;
  const requestSync = (method, params) => {
    requests[method] = (requests[method] ?? 0) + 1;
    const result = worker.dispatch(method, params);
    if (method === "release") released += result.released;
    return result;
  };
  runtime = factories.makeNodeModuleRequire({ endpoint: "http://127.0.0.1:43121/node/" + "a".repeat(64) }, {
    requestSync, requestAsync: async (method, params) => requestSync(method, params),
  });
  const api = runtime("./helper.cjs"), allocate = api.allocate, noop = api.noop;
  const live = allocate(), liveMethod = api.allocate;
  const settleGc = async () => {
    for (let round = 0; round < 3; round++) {
      await new Promise(resolve => setImmediate(resolve));
      globalThis.gc();
    }
    await new Promise(resolve => setImmediate(resolve));
  };
  let maximumAfterCollection = 0;
  for (let batch = 0; batch < 120; batch++) {
    for (let index = 0; index < 100; index++) allocate();
    await settleGc();
    noop(); // Active request flushes finalizers; there is no background release.
    maximumAfterCollection = Math.max(maximumAfterCollection, worker.handles.size);
  }
  assert(released >= 11_900, "Unreachable handles did not reclaim beyond the 8192 lifetime cap");
  assert(maximumAfterCollection < 20, "Retained handle count grows across collections");
  assert.equal(api.allocate, liveMethod);
  assert.equal(live.value, 1, "A strongly held proxy was released");
  // Re-polling a live Promise must encode its result afresh after explicit release.
  const promise = worker.dispatch("get", { handleId: 1, property: "sharedPromise" });
  await new Promise(resolve => setImmediate(resolve));
  const first = worker.dispatch("pollPromise", { handleId: promise.handleId });
  worker.dispatch("release", { handleIds: [first.value.handleId] });
  const second = worker.dispatch("pollPromise", { handleId: promise.handleId });
  assert.notEqual(second.value.handleId, first.value.handleId);
  assert.equal(worker.dispatch("get", { handleId: second.value.handleId, property: "value" }).value, 42);
  report.passed = true;
  Object.assign(report, { allocations: 12000, released, maximumAfterCollection, requests,
    heldProxyAndMethodPreserved: true, repeatedPromiseResultRemainsUsable: true,
    remainingLimit: "8192 simultaneously retained handles; GC is nondeterministic, absent WeakRef keeps strong references, active callbacks/pending promises defer automatic release. No claim that every unbounded allocation loop stays below this cap." });
} catch (error) { report.error = String(error.stack || error); }
finally {
  runtime?.close();
  await rm(scratch, { recursive: true, force: true });
  report.scratchRemoved = true;
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../tests/components/nativeWorkerObservation.js", import.meta.url), "utf8");
const assetRoot = "asset://localhost/plugins/sample/";
const session = "12345678-1234-4abc-8abc-123456789abc";
function fixture({ expectedRoot = assetRoot } = {}) {
  let nextUrl = 0;
  const constructed = [];
  class Url extends URL {
    static createObjectURL() { return "blob:synthetic-" + nextUrl++; }
    static revokeObjectURL() {}
  }
  class WorkerStub {
    constructor(url, options) {
      this.url = String(url); this.options = options; this.name = options?.name;
      if (this.url === "throw-native") throw Error("synthetic native constructor failure");
      this.listeners = new Map(); this.sends = []; constructed.push(this);
    }
    addEventListener(kind, fn) { this.listeners.set(kind, fn); }
    postMessage(...args) { if (this.rejectSend) throw Error("synthetic clone failure"); this.sends.push(args); }
    terminate() { this.stopped = true; }
    emit(kind, data, isTrusted = true) { this.listeners.get(kind)?.({ data, isTrusted }); }
  }
  const target = { Worker: WorkerStub };
  vm.runInNewContext(source.replace(JSON.stringify("__ATOOLS_EXPECTED_WORKER_ASSET_ROOT__"), JSON.stringify(expectedRoot)),
    { window: target, URL: Url, Blob, document: { baseURI: "https://host.invalid/" } });
  const snapshot = sessions => JSON.parse(JSON.stringify(target.__ATOOLS_NATIVE_WORKER_OBSERVATION__(sessions)));
  return { target, Url, WorkerStub, snapshot, constructed };
}
const request = (req, method = "doValidation") => ({ vsWorker: 2, type: 0, req: String(req), method, args: ["SECRET-input"] });
const response = (seq, res = []) => ({ vsWorker: 2, type: 1, seq: String(seq), res, err: undefined });
const foreignValidation = req => ({ ...request(req, "fmr"), args: ["doValidation", ["inmemory://SECRET/model.json"]] });

test("synthetic observer contract pairs native-shaped RPC and rejects untrusted/unmatched replies", () => {
  const { target, snapshot, WorkerStub } = fixture();
  const worker = new target.Worker(assetRoot + "json.worker.js?private=SECRET", { name: "json" });
  assert(worker instanceof WorkerStub);
  const transfers = [];
  worker.postMessage(request(1), transfers);
  assert.equal(worker.sends[0][1], transfers);
  worker.emit("message", response(1), false);
  worker.emit("message", response(2));
  worker.emit("message", { ...response(1), vsWorker: 3 });
  assert.equal(snapshot().workers[0].validationResponses, 0);
  worker.emit("message", response(1, [{ code: 519, severity: 1,
    range: { start: { line: 2, character: 4 } }, message: "SECRET-diagnostic" }]));
  const record = snapshot().workers[0];
  assert.equal(record.entry, "json.worker.js");
  assert.equal(record.validationResponses, 1);
  assert.deepEqual(record.validationReplies, [{ requestOrdinal: 1, validationTransport: "direct", markerCount: 1, errorCount: 1, codes: ["519"], positions: [{ line: 3, column: 5 }] }]);
  assert(!JSON.stringify(snapshot()).includes("SECRET"));
  worker.emit("message", response(1));
  assert.equal(snapshot().workers[0].validationResponses, 1);
  const detached = target.__ATOOLS_NATIVE_WORKER_OBSERVATION__();
  detached.workers[0].validationReplies[0].codes.push("forged");
  assert.deepEqual(snapshot().workers[0].validationReplies[0].codes, ["519"]);
  assert.equal(Object.getOwnPropertyDescriptor(target, "__ATOOLS_NATIVE_WORKER_OBSERVATION__").writable, false);
});

test("synthetic observer recognizes only exact bounded production bootstrap and preserves send failure", async () => {
  const { target, Url, snapshot } = fixture();
  const url = Url.createObjectURL(new Blob([`importScripts(${JSON.stringify(assetRoot + "json.worker.js")});`]));
  const worker = new target.Worker(url, { name: "json" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(snapshot().workers[0].entry, "json.worker.js");
  worker.rejectSend = true;
  assert.throws(() => worker.postMessage(request(1)), /clone failure/);
  assert.equal(snapshot().workers[0].requests, 0);
  worker.terminate();
  assert.equal(worker.stopped, true);
  assert.equal(snapshot().workers[0].terminated, true);
  const arbitrary = Url.createObjectURL(new Blob(['importScripts("asset://localhost/json.worker.js");\nfetch("SECRET");']));
  new target.Worker(arbitrary, { name: "json" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(snapshot().workers[1].entry, "unknown");
});

test("synthetic observer bounds workers, pending requests, replies and diagnostic fields", () => {
  const { target, snapshot } = fixture();
  const worker = new target.Worker(assetRoot + "json.worker.js", { name: "json" });
  for (let i = 0; i < 20; i++) { worker.postMessage(request(i)); worker.emit("message", response(i)); }
  assert.equal(snapshot().workers[0].validationResponses, 20);
  assert.equal(snapshot().workers[0].validationReplies.length, 16);
  for (let i = 100; i < 165; i++) worker.postMessage(request(i));
  assert.equal(snapshot().overflowed, true);
  for (let i = 0; i < 10; i++) new target.Worker("unknown.js");
  assert.equal(snapshot().workers.length, 8);
  const other = fixture(), bounded = new other.target.Worker(assetRoot + "json.worker.js");
  bounded.postMessage(request(1));
  bounded.emit("message", response(1, Array.from({ length: 25 }, () => ({ code: "E", severity: 1,
    range: { start: { line: 0, character: 0 } } }))));
  assert.equal(other.snapshot().workers[0].validationReplies[0].positions.length, 16);
  bounded.postMessage(request(2)); bounded.emit("message", response(2, Array(257).fill(null)));
  assert.equal(other.snapshot().overflowed, true);
  assert.equal(other.snapshot().workers[0].validationResponses, 1);
});

test("synthetic observer attaches validation request ordinals so late replies cannot satisfy a new stage", () => {
  const { target, snapshot } = fixture();
  const worker = new target.Worker(assetRoot + "json.worker.js");
  worker.postMessage(request(1, "getMirrorModels"));
  worker.postMessage(request(2));
  const stageBaseline = snapshot().workers[0].validationRequests;
  worker.postMessage(request(3, "doComplete"));
  worker.postMessage(request(4));
  worker.emit("message", response(2));
  const lateReply = snapshot().workers[0].validationReplies.at(-1);
  assert.equal(lateReply.requestOrdinal, stageBaseline);
  assert.equal(lateReply.requestOrdinal > stageBaseline, false);
  worker.emit("message", response(1)); worker.emit("message", response(3));
  assert.equal(snapshot().workers[0].validationResponses, 1);
  worker.emit("message", response(4));
  const currentReply = snapshot().workers[0].validationReplies.at(-1);
  assert.equal(currentReply.requestOrdinal, stageBaseline + 1);
  assert.equal(currentReply.requestOrdinal > stageBaseline, true);
});

test("synthetic observer matches original fmr validation envelopes without retaining model identifiers", () => {
  const { target, snapshot } = fixture();
  const worker = new target.Worker(assetRoot + "json.worker.js", { name: "json-contract" });
  assert.equal(snapshot().workers[0].name, "json-contract");
  worker.postMessage(foreignValidation(1));
  const stageBaseline = snapshot().workers[0].validationRequests;
  worker.postMessage(foreignValidation(2));
  worker.emit("message", response(2), false);
  worker.emit("message", response(99));
  worker.emit("message", { ...response(2), vsWorker: 99 });
  assert.equal(snapshot().workers[0].validationResponses, 0);
  worker.emit("message", response(1));
  const late = snapshot().workers[0].validationReplies.at(-1);
  assert.equal(late.validationTransport, "fmr");
  assert.equal(late.requestOrdinal > stageBaseline, false);
  worker.emit("message", response(2, [{ code: 519, severity: 1 }]));
  const current = snapshot().workers[0].validationReplies.at(-1);
  assert.equal(current.requestOrdinal, stageBaseline + 1);
  assert.equal(current.validationTransport, "fmr");
  worker.emit("message", response(2));
  assert.equal(snapshot().workers[0].validationResponses, 2);
  assert(!JSON.stringify(snapshot()).includes("SECRET"));
});

test("synthetic observer excludes nonvalidation and malformed fmr payloads", () => {
  const { target, snapshot } = fixture();
  const worker = new target.Worker(assetRoot + "json.worker.js");
  const malformed = [undefined, null, [], ["doComplete", ["uri"]], ["doValidation"],
    ["doValidation", "uri"], ["doValidation", []], ["doValidation", [""]],
    ["doValidation", [42]], ["doValidation", ["uri", "other"]], ["doValidation", ["x".repeat(2049)]],
    ["doValidation", ["uri"], "extra"]];
  malformed.forEach((args, index) => {
    worker.postMessage({ ...request(index, "fmr"), args }); worker.emit("message", response(index));
  });
  assert.equal(snapshot().workers[0].requests, malformed.length);
  assert.equal(snapshot().workers[0].validationRequests, 0);
  assert.equal(snapshot().workers[0].validationResponses, 0);
  worker.postMessage(foreignValidation(100));
  worker.emit("message", { ...response(100), err: { message: "SECRET-error" } });
  worker.emit("message", response(100));
  assert.equal(snapshot().workers[0].validationResponses, 0, "an errored request cannot later be recounted as success");
});

test("synthetic observer metadata is fail-open while no-new, subclass and native failure semantics remain intact", () => {
  const { target, snapshot, constructed } = fixture();
  let nameReads = 0;
  const worker = new target.Worker(assetRoot + "json.worker.js", {
    get name() { if (++nameReads > 1) throw Error("metadata getter failed"); return "json"; }
  });
  assert.equal(worker, constructed[0]);
  assert.equal(snapshot().workers[0].name, "other");
  let sourceReads = 0;
  const sourceObject = { toString() { if (++sourceReads > 1) throw Error("metadata stringification failed"); return assetRoot + "json.worker.js"; } };
  assert.equal(new target.Worker(sourceObject), constructed[1]);
  assert.equal(sourceReads, 1);
  assert.equal(snapshot().workers[1].entry, "unknown");
  assert.throws(() => target.Worker(assetRoot + "json.worker.js"), /without 'new'/);
  assert.throws(() => new target.Worker("throw-native"), /native constructor failure/);
  assert.equal(constructed.length, 2);
  class DerivedWorker extends target.Worker {}
  const derived = new DerivedWorker(assetRoot + "editor.worker.js");
  assert(derived instanceof DerivedWorker);
  assert.equal(Object.getPrototypeOf(derived), DerivedWorker.prototype);
});

test("synthetic observer records only actual native sends and teardown bypasses subclass terminate overrides", () => {
  const { target, snapshot } = fixture();
  class SilentWorker extends target.Worker {
    postMessage() { this.customSendCalled = true; }
    terminate() { throw Error("subclass terminate must not be captured"); }
  }
  const silent = new SilentWorker(assetRoot + "json.worker.js");
  silent.postMessage(request(1)); silent.emit("message", response(1));
  assert.equal(silent.customSendCalled, true, "caller subclass send behavior is retained");
  assert.equal(snapshot().workers[0].requests, 0, "returning from a custom method does not prove a native send");
  assert.equal(snapshot().workers[0].validationResponses, 0);
  silent.terminate();
  assert.equal(silent.stopped, true);
  assert.equal(snapshot().workers[0].terminated, true);
  class ForwardingWorker extends target.Worker {
    postMessage(...args) { this.forwarded = true; return super.postMessage(...args); }
  }
  const forwarding = new ForwardingWorker(assetRoot + "json.worker.js");
  const transfers = [];
  forwarding.postMessage(request(2), transfers); forwarding.emit("message", response(2));
  assert.equal(forwarding.forwarded, true);
  assert.equal(forwarding.sends[0][1], transfers);
  assert.equal(snapshot().workers[1].validationResponses, 1);
});

test("synthetic observer recognizes only the injected asset root and leaves unsupported origins unknown", () => {
  for (const url of ["https://external.invalid/json.worker.js", "asset://localhost/plugins/other/json.worker.js",
    "asset://localhost/plugins/sample-foreign/json.worker.js", "asset://elsewhere/plugins/sample/json.worker.js",
    assetRoot + "../json.worker.js", assetRoot + "%2E%2E%2Fjson.worker.js", assetRoot + "%5Cjson.worker.js"]) {
    const { target, snapshot } = fixture(); new target.Worker(url);
    assert.equal(snapshot().workers[0].entry, "unknown", url);
  }
  const encodedRoot = "asset://localhost/%2Fplugins%2Fsample%2F";
  const encoded = fixture({ expectedRoot: encodedRoot });
  new encoded.target.Worker(encodedRoot + "json.worker.js?secret=SECRET");
  assert.equal(encoded.snapshot().workers[0].entry, "json.worker.js");
  assert(!JSON.stringify(encoded.snapshot()).includes("SECRET"));
  const unresolved = fixture({ expectedRoot: "__ATOOLS_EXPECTED_WORKER_ASSET_ROOT__" });
  new unresolved.target.Worker(assetRoot + "json.worker.js");
  assert.equal(unresolved.snapshot().workers[0].entry, "unknown");
});

test("synthetic observer uses lease IDs only for the current snapshot and never emits them", async () => {
  const { target, Url, snapshot } = fixture();
  const entry = `atools-plugin://localhost/${session}/assets/json.worker.js?secret=SECRET`;
  const bootstrap = Url.createObjectURL(new Blob([`importScripts(${JSON.stringify(entry)});`]));
  new target.Worker(bootstrap, { name: "json" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(snapshot().workers[0].entry, "unknown");
  assert.equal(snapshot([session]).workers[0].entry, "json.worker.js");
  assert.equal(snapshot().workers[0].entry, "unknown", "prior allowlist is not retained");
  assert.equal(snapshot([session.replace("12345678", "87654321")]).workers[0].entry, "unknown");
  assert.equal(snapshot(Array(5).fill(session)).workers[0].entry, "unknown");
  assert.equal(snapshot([session, "not-a-uuid"]).workers[0].entry, "unknown");
  assert(!JSON.stringify(snapshot([session])).includes(session));
  assert(!JSON.stringify(snapshot([session])).includes("SECRET"));
  const invalid = fixture();
  new invalid.target.Worker(`atools-plugin://localhost/${session.replace("4abc", "1abc")}/json.worker.js`);
  assert.equal(invalid.snapshot([session.replace("4abc", "1abc")]).workers[0].entry, "unknown");
});

test("synthetic observer retains only numeric safe diagnostic codes and bounds Blob inspection", async () => {
  const { target, Url, snapshot } = fixture();
  const worker = new target.Worker(assetRoot + "json.worker.js");
  worker.postMessage(request(1));
  worker.emit("message", response(1, [{ code: "SECRET_TOKEN", message: "SECRET_MESSAGE" },
    { code: 519 }, { code: Number.MAX_SAFE_INTEGER + 1 }, { code: NaN }, { code: 3.5 }]));
  assert.deepEqual(snapshot().workers[0].validationReplies[0].codes, ["519"]);
  assert(!JSON.stringify(snapshot()).includes("SECRET"));
  let inspected = 0;
  class ObservedBlob extends Blob { text() { inspected++; throw Error("caller Blob method must not execute"); } }
  const known = Url.createObjectURL(new ObservedBlob([`importScripts(${JSON.stringify(assetRoot + "json.worker.js")});`]));
  new target.Worker(known);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(snapshot().workers.at(-1).entry, "json.worker.js");
  assert.equal(inspected, 0, "only the captured native Blob.text method runs");
  const oversized = Url.createObjectURL(new ObservedBlob([" ".repeat(2049)]));
  new target.Worker(oversized);
  assert.equal(inspected, 0);
  for (let i = 0; i < 16; i++) Url.createObjectURL(new ObservedBlob(["/* synthetic */"]));
  const excess = Url.createObjectURL(new ObservedBlob([`importScripts(${JSON.stringify(assetRoot + "json.worker.js")});`]));
  new target.Worker(excess);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(inspected, 0);
  assert.equal(snapshot().overflowed, true);
  assert.equal(snapshot().workers.at(-1).entry, "unknown");
});

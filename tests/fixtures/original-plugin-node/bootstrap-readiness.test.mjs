import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const bootstrapSource = await readFile(
  resolve(projectRoot, "crates/atools-plugin/src/legacy_node/bootstrap.cjs"),
  "utf8",
);

function createBootstrapHarness(install) {
  const output = [];
  const exits = [];
  let onLine;
  let installationCalls = 0;
  const processStub = {
    env: { ATOOLS_PRELOAD_ENTRY: "/private/plugin/preload.js" },
    pid: 4321,
    versions: { node: "22.23.3" },
    stdin: {},
    stdout: { write(value) { output.push(String(value)); return true; } },
    exit(code) { exits.push(code); },
  };
  const readlineStub = {
    createInterface() {
      return { on(event, callback) { if (event === "line") onLine = callback; return this; } };
    },
  };
  const moduleStub = { createRequire() { return () => { throw new Error("unexpected plugin require"); }; } };
  const sandbox = {
    Buffer,
    Promise,
    process: processStub,
    console: {},
    MAX_BYTES: 1024 * 1024,
    errorData(error) { return { message: error instanceof Error ? error.message : String(error) }; },
    installManagedNodeChildren() { installationCalls++; return install(); },
    require(specifier) {
      if (specifier === "node:module") return moduleStub;
      if (specifier === "node:readline") return readlineStub;
      throw new Error(`unexpected bootstrap require: ${specifier}`);
    },
  };
  vm.runInNewContext(bootstrapSource, sandbox, { filename: "legacy_node/bootstrap.cjs" });
  return {
    output,
    exits,
    get installationCalls() { return installationCalls; },
    send(request) { onLine(JSON.stringify(request)); },
  };
}

function responses(harness) {
  return harness.output.map((line) => JSON.parse(line));
}

test("managed-child requests wait for one readiness promise and preserve order", async () => {
  let resolveReady;
  const ready = new Promise((resolveReadyValue) => { resolveReady = resolveReadyValue; });
  const harness = createBootstrapHarness(() => ready);
  harness.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  harness.send({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} });

  assert.equal(harness.installationCalls, 1);
  assert.deepEqual(responses(harness), []);
  resolveReady();
  await ready;
  await new Promise((resolveReadyValue) => setImmediate(resolveReadyValue));

  assert.deepEqual(responses(harness).map((response) => response.id), [1, 2]);
  assert.ok(responses(harness).every((response) => response.result?.protocolVersion === 1));
});

test("managed-child initialization failure returns ordered explicit RPC errors", async () => {
  const ready = Promise.reject(new Error("ERR_ATOOLS_MANAGED_CHILD_AUTH_FAILED"));
  const harness = createBootstrapHarness(() => ready);
  harness.send({ jsonrpc: "2.0", id: 3, method: "initialize", params: {} });
  harness.send({ jsonrpc: "2.0", id: 4, method: "get", params: {} });
  await new Promise((resolveReadyValue) => setImmediate(resolveReadyValue));

  const replies = responses(harness);
  assert.deepEqual(replies.map((response) => response.id), [3, 4]);
  assert.ok(replies.every((response) => response.error?.message.includes(
    "ERR_ATOOLS_MANAGED_CHILD_INITIALIZATION_FAILED",
  )));
});

test("synchronous installer errors use the same explicit initialization failure", async () => {
  const harness = createBootstrapHarness(() => {
    throw new Error("ERR_ATOOLS_MANAGED_CHILD_INVALID_ENV");
  });
  harness.send({ jsonrpc: "2.0", id: 6, method: "initialize", params: {} });
  await new Promise((resolveReadyValue) => setImmediate(resolveReadyValue));
  assert.match(
    responses(harness)[0].error.message,
    /ERR_ATOOLS_MANAGED_CHILD_INITIALIZATION_FAILED.*ERR_ATOOLS_MANAGED_CHILD_INVALID_ENV/,
  );
});

test("no managed-child transport keeps synchronous dispatch timing", () => {
  const harness = createBootstrapHarness(() => undefined);
  harness.send({ jsonrpc: "2.0", id: 5, method: "initialize", params: {} });
  assert.equal(harness.installationCalls, 1);
  assert.equal(responses(harness).length, 1);
  assert.equal(responses(harness)[0].id, 5);
});

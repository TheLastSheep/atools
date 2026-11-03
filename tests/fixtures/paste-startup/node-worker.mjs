import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { parentPort, workerData } from "node:worker_threads";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { offlineNodePolicySource } from "../../../scripts/lib/ztools-matrix-offline-policy.mjs";
import { assemblePasteNodeRuntimeSource } from "./node-source-assembly.mjs";
import { PersistentPluginData } from "./persistent-data.mjs";

const MAX_BODY_BYTES = 1024 * 1024;
const tokens = Object.fromEntries(["node", "data", "history", "write", "content", "secret"].map(name => [name, randomBytes(32).toString("hex")]));
const dbPath = join(workerData.scratchRoot, "pasteboard-pro.sqlite");
const pluginData = new PersistentPluginData(dbPath);
const filePaths = workerData.filePaths ?? [];
const stackItemId = workerData.scenario === "files" ? "files-item" : "text-old";
pluginData.seed([
  // Canonical historyFixture[0] from Paste's contract-fixtures, wrapped in its persisted record document.
  {
    _id: "pasteboard-pro:record:sha256:text-old:v1",
    type: "pasteboard-pro-record",
    record: {
      item: {
        id: "text-old", kind: "text", title: "Accounts payable notes",
        sourceApp: { bundleId: "com.apple.TextEdit", name: "TextEdit" },
        sourceDeviceId: "device-mac-studio", copiedAt: "2026-07-10T08:15:00.000Z",
        updatedAt: "2026-07-10T08:20:00.000Z", contentFingerprint: "sha256:text-old:v1",
        payload: { revision: "revision:text-old:v1", text: "Invoice #1042 is due on July 31 for USD 480.00." },
        pinboardId: "board-work", pinboardOrderKey: "a0", pinned: true,
        fieldClocks: {
          title: { wallMs: 1783671300000, counter: 0, deviceId: "device-mac-studio" },
          payload: { wallMs: 1783671300000, counter: 1, deviceId: "device-mac-studio" },
          pinboardId: { wallMs: 1783671600000, counter: 0, deviceId: "device-mac-studio" },
          pinboardOrderKey: { wallMs: 1783671600000, counter: 1, deviceId: "device-mac-studio" },
          pinned: { wallMs: 1783671600000, counter: 2, deviceId: "device-mac-studio" },
        },
      },
      origin: { host: "ztools", hostItemId: "clipboard-fixture-1", hostType: "text" },
    },
  },
  {
    _id: "pasteboard-pro:record:sha256:files-item:v1",
    type: "pasteboard-pro-record",
    record: {
      item: {
        id: "files-item", kind: "files", title: "Quarterly report attachments",
        sourceApp: { bundleId: "com.apple.finder", name: "Finder" },
        sourceDeviceId: "device-mac-studio", copiedAt: "2026-07-13T11:45:00.000Z",
        updatedAt: "2026-07-13T11:50:00.000Z", contentFingerprint: "sha256:files-item:v1",
        payload: { revision: "revision:files-item:v1", filePaths },
        pinboardId: "board-work", pinboardOrderKey: "a1", pinned: false,
        fieldClocks: {
          payload: { wallMs: 1783943100000, counter: 0, deviceId: "device-mac-studio" },
          pinboardId: { wallMs: 1783943400000, counter: 0, deviceId: "device-mac-studio" },
          pinboardOrderKey: { wallMs: 1783943400000, counter: 1, deviceId: "device-mac-studio" },
          pinned: { wallMs: 1783943400000, counter: 2, deviceId: "device-mac-studio" },
        },
      },
      origin: { host: "ztools", hostItemId: "clipboard-fixture-files-1", hostType: "file" },
    },
  },
  {
    _id: "pasteboard-pro:paste-stack",
    type: "pasteboard-pro-paste-stack",
    state: { direction: "forward", itemIds: [stackItemId, "fixture-missing-record"] },
  },
]);

const stats = {
  requests: 0,
  methods: Object.create(null),
  dataTrace: [],
  nodeModules: new Set(),
  allowedMonitorSpawns: 0,
  deniedOsCommands: 0,
  clipboardWrites: [],
  typedClipboardWrites: [],
  fileMetadata: [],
  historyReads: 0,
  secretStorageCalls: 0,
  rejectedRoutes: 0,
  nodeStartedAt: 0,
  nodeVersion: "",
  nodePid: 0,
  stderrTail: "",
};
let child;
let nodeStopped;
let stopNodePromise;
let cleanupPromise;
let startupAborted = false;
let fixtureReady = false;
let pluginDataClosed = false;
let nextRpcId = 0;
const pending = new Map();
const sockets = new Set();

function fixturePolicySource(monitorPath) {
  return `;(function(){
const Module = require('node:module');
const EventEmitter = require('node:events');
const { PassThrough } = require('node:stream');
const readline = require('node:readline');
const nativeLoad = Module._load;
let fixtureMonitor;
const monitorPath = ${JSON.stringify(monitorPath)};
function denied(name) {
  process.stderr.write('ATF_POLICY ' + JSON.stringify({ deniedOsCommands: 1, name: String(name) }) + '\\n');
  const error = new Error('ERR_ATOOLS_TEST_OS_COMMAND_DENIED: ' + String(name));
  error.code = 'ERR_ATOOLS_TEST_OS_COMMAND_DENIED';
  throw error;
}
function makeMonitor() {
  const monitor = new EventEmitter();
  monitor.stdin = new PassThrough();
  monitor.stdout = new PassThrough();
  monitor.stderr = new PassThrough();
  monitor.kill = function() {
    if (monitor.killed) return false;
    monitor.killed = true;
    monitor.stdin.end(); monitor.stdout.end(); monitor.stderr.end();
    process.nextTick(() => monitor.emit('close', null, 'SIGTERM'));
    return true;
  };
  monitor.killed = false;
  return monitor;
}
const childProcessFixture = new Proxy({
  spawn(command, args, options) {
    const allowed = command === '/usr/bin/python3' && Array.isArray(args) && args.length === 1
      && args[0] === monitorPath && Array.isArray(options && options.stdio)
      && options.stdio.length === 3 && options.stdio.every(value => value === 'pipe');
    if (!allowed || fixtureMonitor) return denied('child_process.spawn');
    fixtureMonitor = makeMonitor();
    process.stderr.write('ATF_POLICY ' + JSON.stringify({ allowedMonitorSpawns: 1 }) + '\\n');
    return fixtureMonitor;
  },
}, { get(target, key) {
  if (key in target) return target[key];
  if (key === 'then') return undefined;
  return (...args) => denied('child_process.' + String(key));
} });
Module._load = function(request, parent, isMain) {
  if (request === 'child_process' || request === 'node:child_process') return childProcessFixture;
  return Reflect.apply(nativeLoad, this, [request, parent, isMain]);
};
const nativeCreateInterface = readline.createInterface;
readline.createInterface = function(options, ...rest) {
  const result = Reflect.apply(nativeCreateInterface, this, [options, ...rest]);
  if (options && options.input === process.stdin) result.on('line', line => {
    try {
      const control = JSON.parse(line);
      if (control && control.__atoolsFixtureControl === 'paste' && fixtureMonitor && !fixtureMonitor.killed) {
        fixtureMonitor.stdout.write('paste:' + String(control.requestId) + '\\n');
      }
    } catch {}
  });
  return result;
};
})();
`;
}

async function startNode() {
  if (startupAborted) throw new Error("Paste startup was aborted before launching product Node");
  const preload = await readFile(workerData.preloadPath, "utf8");
  const policy = await offlineNodePolicySource() + fixturePolicySource(workerData.monitorPath);
  if (startupAborted) throw new Error("Paste startup was aborted before launching product Node");
  const source = await assemblePasteNodeRuntimeSource(workerData.root, policy);
  const home = workerData.fixtureEnv.HOME;
  const args = [
    "--permission", "--allow-worker",
    `--allow-fs-read=${workerData.pluginRoot}`,
    `--allow-fs-read=${home}`,
    `--allow-fs-write=${workerData.pluginDataRoot}`,
    `--allow-fs-write=${home}`,
    "-e", source,
  ];
  stats.nodeStartedAt = performance.now();
  child = spawn(workerData.nodeBinary, args, {
    env: {
      ...workerData.fixtureEnv,
      ATOOLS_PLUGIN_ID: "pasteboard-pro",
      ATOOLS_PLUGIN_DIR: workerData.pluginRoot,
      ATOOLS_PRELOAD_ENTRY: workerData.preloadPath,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  nodeStopped = new Promise(resolve => {
    child.once("exit", (code, signal) => {
      const error = new Error(`Product Node exited before RPC completion (${code ?? signal ?? "unknown"})`);
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
      pending.clear();
      stats.nodeStoppedAt = performance.now();
      resolve({ code, signal });
    });
    child.once("error", error => {
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
      pending.clear();
      stats.nodeStoppedAt = performance.now();
      resolve({ error: String(error) });
    });
  });
  createInterface({ input: child.stdout }).on("line", line => {
    let response;
    try { response = JSON.parse(line); } catch { return; }
    const waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id); clearTimeout(waiter.timer);
    if (response.error) waiter.reject(Object.assign(new Error(response.error.message), { code: response.error.code }));
    else waiter.resolve(response.result);
  });
  child.stderr.on("data", buffer => {
    stats.stderrTail = (stats.stderrTail + buffer.toString("utf8")).slice(-16_000);
    for (const line of buffer.toString("utf8").split(/\r?\n/)) {
      if (!line.startsWith("ATF_POLICY ")) continue;
      try {
        const event = JSON.parse(line.slice("ATF_POLICY ".length));
        if (Number.isInteger(event.allowedMonitorSpawns)) stats.allowedMonitorSpawns += event.allowedMonitorSpawns;
        if (Number.isInteger(event.deniedOsCommands)) stats.deniedOsCommands += event.deniedOsCommands;
      } catch { /* diagnostic only */ }
    }
  });
  const initialization = await rpc("initialize");
  stats.nodeVersion = initialization.nodeVersion;
  stats.nodePid = initialization.pid;
  if (stats.nodeVersion !== "22.23.3") throw new Error(`Expected product Node 22.23.3, got ${stats.nodeVersion}`);
}

function rpc(method, params = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.reject(new Error("Fixture Node process is unavailable"));
  return new Promise((resolve, reject) => {
    const id = ++nextRpcId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Product Node RPC timed out (${method}): ${stats.stderrTail}`));
    }, 5000);
    pending.set(id, { resolve, reject, timer });
    try { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
}

function sendJson(response, status, body, origin) {
  response.writeHead(status, {
    "Content-Type": "application/json", "Cache-Control": "no-store", "Connection": "close",
    ...(origin ? {
      "Access-Control-Allow-Origin": origin === "null" ? "*" : origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Private-Network": "true",
      "Vary": "Origin",
    } : {}),
  });
  response.end(JSON.stringify(body));
}

function allowedOrigin(value) {
  return value === "null" || value === "https://pasteboard-pro.fixture.invalid";
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("Fixture request exceeds byte budget");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function validateFixtureFileClipboard(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 2 || value.kind !== "files" || !Array.isArray(value.paths)
    || value.paths.length === 0 || value.paths.length > 16) {
    throw new Error("Fixture content_write accepts only a bounded typed file path list");
  }
  const root = await realpath(workerData.pluginDataRoot);
  const paths = [];
  const metadata = [];
  for (const candidate of value.paths) {
    if (typeof candidate !== "string" || candidate.length > 8192 || !isAbsolute(candidate)
      || candidate.includes("\0") || resolve(candidate) !== candidate) {
      throw new Error("Fixture content_write path must be canonical and absolute");
    }
    const actual = await realpath(candidate);
    const segment = relative(root, actual);
    if (actual !== candidate || segment === "" || segment === ".." || segment.startsWith(`..${sep}`) || isAbsolute(segment)) {
      throw new Error("Fixture content_write path escaped the isolated pluginData directory");
    }
    const file = await lstat(candidate);
    if (file.isSymbolicLink() || !file.isFile()) throw new Error("Fixture content_write requires an ordinary fixture file");
    paths.push(candidate);
    metadata.push({ path: candidate, isFile: true, size: file.size });
  }
  return { paths, metadata };
}

async function handle(request, response, port) {
  const origin = request.headers.origin ?? "";
  const tokenRoute = {
    [`/node/${tokens.node}`]: "node",
    [`/data/${tokens.data}`]: "data",
    [`/host/${tokens.history}`]: "history",
    [`/host/${tokens.write}`]: "write",
    [`/host/${tokens.content}`]: "content_write",
    [`/secrets/${tokens.secret}`]: "secret",
  }[request.url];
  const nodeFetchOrigin = tokenRoute === "node" && origin === "";
  if (request.headers.host !== `127.0.0.1:${port}` || (!allowedOrigin(origin) && !nodeFetchOrigin) || !tokenRoute) {
    stats.rejectedRoutes++;
    return sendJson(response, 403, { ok: false, error: "fixture route rejected" }, allowedOrigin(origin) ? origin : undefined);
  }
    if (request.method === "OPTIONS") return sendJson(response, 200, { ok: true, result: null }, origin);
  if (request.method !== "POST") return sendJson(response, 405, { ok: false }, origin);
  try {
    const body = await readBody(request);
    stats.requests++;
    if (tokenRoute === "node") {
      if (typeof body.method !== "string" || !body.params || typeof body.params !== "object") throw new Error("Invalid Node RPC envelope");
      stats.methods[`node.${body.method}`] = (stats.methods[`node.${body.method}`] ?? 0) + 1;
      if (body.method === "require" && typeof body.params.specifier === "string") stats.nodeModules.add(body.params.specifier);
      const result = await rpc(body.method, body.params);
      return sendJson(response, 200, { ok: true, result }, origin);
    }
    if (tokenRoute === "data") {
      if (typeof body.method !== "string" || !Array.isArray(body.args)) throw new Error("Invalid PluginData envelope");
      stats.methods[`data.${body.method}`] = (stats.methods[`data.${body.method}`] ?? 0) + 1;
      stats.dataTrace.push({ method: body.method, argumentCount: body.args.length,
        id: typeof body.args[0] === "string" ? body.args[0] : body.args[0]?._id });
      const result = pluginData.dispatch(body.method, body.args);
      return sendJson(response, 200, { ok: true, result }, origin);
    }
    if (tokenRoute === "history") {
      stats.historyReads++;
      stats.methods["host.history_read"] = (stats.methods["host.history_read"] ?? 0) + 1;
      return sendJson(response, 200, { ok: true, result: { items: [], total: 0, page: body.page, pageSize: body.pageSize } }, origin);
    }
    if (tokenRoute === "secret") {
      stats.secretStorageCalls++;
      stats.methods["host.secret_storage"] = (stats.methods["host.secret_storage"] ?? 0) + 1;
      return sendJson(response, 200, { ok: false, error: { code: "keychain_unavailable" } }, origin);
    }
    if (tokenRoute === "content_write") {
      const { paths, metadata } = await validateFixtureFileClipboard(body);
      stats.typedClipboardWrites.push({ kind: "files", paths });
      stats.fileMetadata.push(...metadata);
      stats.methods["host.content_write"] = (stats.methods["host.content_write"] ?? 0) + 1;
      return sendJson(response, 200, { ok: true, result: null }, origin);
    }
    if (typeof body.text !== "string" || Object.keys(body).some(key => key !== "text")) throw new Error("Fixture clipboard port accepts only text writes");
    stats.clipboardWrites.push(body.text);
    stats.methods["host.write"] = (stats.methods["host.write"] ?? 0) + 1;
    return sendJson(response, 200, { ok: true, result: null }, origin);
  } catch (error) {
    return sendJson(response, 200, { ok: false, error: { message: String(error?.message ?? error) } }, origin);
  }
}

const server = createServer((request, response) => void handle(request, response, server.address()?.port));
server.on("connection", socket => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});
function waitForExit(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

async function stopNode() {
  if (stopNodePromise) return stopNodePromise;
  stopNodePromise = (async () => {
    if (!child) return { notStarted: true };
    if (child.exitCode !== null || child.signalCode !== null) return await nodeStopped;
    child.kill("SIGTERM");
    let result = await waitForExit(nodeStopped, 2000, "Product Node did not exit after SIGTERM").catch(() => null);
    if (result) return result;
    child.kill("SIGKILL");
    result = await waitForExit(nodeStopped, 2000, "Product Node did not exit after SIGKILL");
    if (!result || ("error" in result)) throw new Error("ERR_ATOOLS_FIXTURE_NODE_EXIT_UNCONFIRMED");
    return result;
  })();
  return stopNodePromise;
}

async function closeServer() {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return;
  await new Promise((resolveClose, rejectClose) => {
    const timer = setTimeout(() => rejectClose(new Error("Paste fixture HTTP listener did not close")), 2000);
    server.close(error => {
      clearTimeout(timer);
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

function cleanupFixture() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    const failures = [];
    let childExit;
    try { childExit = await stopNode(); }
    catch (error) { failures.push(error); }
    try { await closeServer(); }
    catch (error) { failures.push(error); }
    try {
      if (!pluginDataClosed) {
        pluginData.close();
        pluginDataClosed = true;
      }
    } catch (error) { failures.push(error); }
    if (failures.length > 0) throw new AggregateError(failures, "Paste fixture cleanup did not complete all resources");
    return { childExit, listenerClosed: !server.listening, databaseClosed: pluginDataClosed };
  })();
  return cleanupPromise;
}

async function handleParentMessage(message) {
  const { id, command, value } = message ?? {};
  try {
    let result;
    if (command === "abortStartup") {
      startupAborted = true;
      result = await cleanupFixture();
    } else if (command === "shutdown") {
      result = await cleanupFixture();
      parentPort.postMessage({ id, result });
      parentPort.close();
      return;
    } else if (!fixtureReady) {
      throw new Error(`Paste fixture is not ready for command ${String(command)}`);
    } else if (command === "stats") result = snapshot();
    else if (command === "getDoc") result = pluginData.snapshot(value);
    else if (command === "reopen") { pluginData.reopen(); result = pluginData.snapshot(value); }
    else if (command === "controlPaste") {
      if (!child || child.exitCode !== null || child.signalCode !== null) throw new Error("Product Node is stopped");
      child.stdin.write(JSON.stringify({ __atoolsFixtureControl: "paste", requestId: value }) + "\n");
      result = null;
    }
    else if (command === "stopNode") result = await stopNode();
    else throw new Error(`Unknown fixture worker command: ${command}`);
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.stack ?? error) });
  }
}
parentPort.on("message", handleParentMessage);

try {
  await startNode();
  if (startupAborted) throw new Error("Paste startup was aborted before protocol listener creation");
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  if (startupAborted) throw new Error("Paste startup was aborted before readiness");
  const host = `127.0.0.1:${server.address().port}`;
  stats.nodeStartupMs = performance.now() - stats.nodeStartedAt;
  fixtureReady = true;
  parentPort.postMessage({
    type: "ready",
    endpoints: {
      node: `http://${host}/node/${tokens.node}`,
      data: `http://${host}/data/${tokens.data}`,
      history: `http://${host}/host/${tokens.history}`,
      write: `http://${host}/host/${tokens.write}`,
      contentWrite: `http://${host}/host/${tokens.content}`,
      secret: `http://${host}/secrets/${tokens.secret}`,
    },
    initialization: { protocolVersion: 1, nodeVersion: stats.nodeVersion, pid: stats.nodePid },
  });
} catch (error) {
  try { await cleanupFixture(); }
  catch (cleanupError) { error = new AggregateError([error, cleanupError], "Paste startup failed and cleanup failed"); }
  if (!startupAborted) {
    parentPort.postMessage({ type: "fatal", error: String(error?.stack ?? error) });
    throw error;
  }
}

function snapshot() {
  return {
    ...stats,
    methods: { ...stats.methods },
    dataTrace: stats.dataTrace.slice(-100),
    nodeModules: [...stats.nodeModules].sort(),
    nodeRuntimeMs: stats.nodeStoppedAt ? stats.nodeStoppedAt - stats.nodeStartedAt : performance.now() - stats.nodeStartedAt,
    clipboardWrites: [...stats.clipboardWrites],
    typedClipboardWrites: stats.typedClipboardWrites.map(value => structuredClone(value)),
    fileMetadata: stats.fileMetadata.map(value => structuredClone(value)),
  };
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { connect } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { offlineNodePolicySource } from "./ztools-matrix-offline-policy.mjs";
import { createFixtureEnvironment } from "./legacy-node-environment.mjs";
import { trackNativeDescendants } from "./native-smoke-descendants.mjs";

export function runProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { trackDescendants = false, ...spawnOptions } = options;
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], ...spawnOptions,
      ...(trackDescendants ? { detached: true } : {}) });
    const stopDescendants = trackDescendants && child.pid ? trackNativeDescendants(child, "") : null;
    let stdout = "", stderr = "";
    let settled = false;
    async function finish(error) {
      if (settled) return; settled = true; clearTimeout(timer);
      try { if (stopDescendants) await stopDescendants(); }
      catch (cleanupError) { error = error ? new AggregateError([error, cleanupError], "Fixture cleanup failed") : cleanupError; }
      if (error) reject(error); else resolve({ stdout, stderr, trackedProcessGroupCleanup: Boolean(stopDescendants) });
    }
    const timer = setTimeout(() => { child.kill("SIGKILL"); void finish(new Error("Fixture process timed out after 45000 ms")); }, 45000);
    child.stdout.on("data", data => { stdout = (stdout + data).slice(-200000); });
    child.stderr.on("data", data => { stderr = (stderr + data).slice(-200000); });
    child.once("error", error => { void finish(error); });
    child.once("close", code => { void finish(code === 0 ? null : new Error(`${executable} exited ${code}: ${stderr}`)); });
  });
}

/** Transpile current host factories without rebuilding or changing the application. */
export async function loadHostFactories(root, scratch) {
  const folder = join(scratch, "host-modules");
  await mkdir(folder, { recursive: true });
  for (const name of ["nodeBufferNumbers", "nodeModuleValues", "nodeModuleTransport", "nodeModuleBridge", "pluginSourceAnalysis", "pluginModuleImports", "pluginPreload", "pluginElectronAdapter"]) {
    const source = await readFile(join(root, "src/lib", `${name}.ts`), "utf8");
    const { outputText } = ts.transpileModule(source, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
    } });
    await writeFile(join(folder, `${name}.mjs`), outputText.replace(/from "(\.\/[^".]+)"/g, 'from "$1.mjs"'));
  }
  const bridge = await import(pathToFileURL(join(folder, "nodeModuleBridge.mjs")).href);
  const preload = await import(pathToFileURL(join(folder, "pluginPreload.mjs")).href);
  const electron = await import(pathToFileURL(join(folder, "pluginElectronAdapter.mjs")).href);
  return { ...bridge, ...preload, ...electron };
}

/** Temporary protocol fixture only: no product Rust permission gate or TaskRun. */
export async function startNodeFixture(root, pluginDir, preloadPath) {
  const bootstrap = offlineNodePolicySource() + await readFile(join(root, "crates/atools-plugin/src/legacy_node/codec.cjs"), "utf8")
    + "\n" + await readFile(join(root, "crates/atools-plugin/src/legacy_node/bootstrap.cjs"), "utf8");
  const started = performance.now();
  const isolation = await createFixtureEnvironment();
  const child = spawn(process.execPath, ["--max-old-space-size=128", "-e", bootstrap], {
    env: { ...isolation.env, ATOOLS_PLUGIN_ID: "original-business-probe", ATOOLS_PLUGIN_DIR: pluginDir,
      ATOOLS_PRELOAD_ENTRY: preloadPath }, stdio: ["pipe", "pipe", "pipe"], detached: true,
  });
  const stopDescendants = child.pid ? trackNativeDescendants(child, "") : null;
  let nextId = 0, stderr = "";
  const pending = new Map();
  child.stderr.on("data", data => { stderr = (stderr + data).slice(-10000); });
  const exited = new Promise(resolve => { child.once("exit", resolve); child.once("error", resolve); });
  async function waitForExit() {
    let timer;
    try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Fixture Node did not exit within 2000 ms after termination")), 2000); })]); }
    finally { clearTimeout(timer); }
  }
  child.on("error", error => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  });
  createInterface({ input: child.stdout }).on("line", line => {
    const response = JSON.parse(line), item = pending.get(response.id);
    if (!item) return;
    pending.delete(response.id); clearTimeout(item.timer);
    if (response.error) item.reject(new Error(response.error.message)); else item.resolve(response.result);
  });
  function rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Node ${method} timed out: ${stderr}`)); }, 5000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  const token = randomBytes(32).toString("hex");
  const sockets = new Set();
  const stats = { requests: 0, preflights: 0, rejected: 0, methods: {}, origins: {} };
  let host;
  function reply(response, status, value, cors) {
    response.writeHead(status, {
      "Content-Type": "application/json", "Cache-Control": "no-store", Connection: "close",
      ...(cors ? { "Access-Control-Allow-Origin": "null", "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Private-Network": "true" } : {}),
    });
    response.end(JSON.stringify(value));
  }
  const server = createServer(async (request, response) => {
    if (request.headers.host !== host || request.headers.origin !== "null" || request.url !== `/node/${token}`) {
      stats.rejected++; return reply(response, 401, { ok: false }, false);
    }
    stats.origins[request.headers.origin] = (stats.origins[request.headers.origin] || 0) + 1;
    if (request.method === "OPTIONS") { stats.preflights++; return reply(response, 200, null, true); }
    if (request.method !== "POST") return reply(response, 400, { ok: false }, false);
    const chunks = []; let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { request.destroy(); return; }
      chunks.push(chunk);
    }
    try {
      const payload = JSON.parse(Buffer.concat(chunks));
      stats.requests++; stats.methods[payload.method] = (stats.methods[payload.method] || 0) + 1;
      reply(response, 200, { ok: true, result: await rpc(payload.method, payload.params) }, true);
    } catch (error) { reply(response, 200, { ok: false, error: { message: error.message } }, true); }
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  let stopping;
  function stop() { return stopping ||= stopOwnedResources(); }
  async function stopOwnedResources() {
    let result;
    try {
    const closed = new Promise(resolve => server.close(resolve));
    for (const socket of sockets) socket.destroy();
    await closed;
    const listenerClosed = await new Promise(resolve => {
      const socket = connect(Number(host.split(":")[1]), "127.0.0.1");
      socket.once("error", error => resolve(error.code === "ECONNREFUSED"));
      socket.once("connect", () => { socket.destroy(); resolve(false); });
    });
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Fixture stopping")); }
    pending.clear();
    if (stopDescendants) await stopDescendants();
    result = { listenerClosed, trackedProcessGroupCleanup: Boolean(stopDescendants),
      cleanupScope: "Exclusive process group and periodically observed descendant creation identities; not an OS sandbox or proof against arbitrary reparenting." };
    } finally {
      child.kill("SIGKILL");
      let removed;
      try { await waitForExit(); } finally { removed = await isolation.cleanup(); }
      if (result) Object.assign(result, removed, { nodeProcessStopped: child.exitCode !== null || child.signalCode !== null });
    }
    return result;
  }
  try {
    const initialize = await rpc("initialize");
    const startupMs = performance.now() - started;
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    host = `127.0.0.1:${server.address().port}`;
    return { endpoint: `http://${host}/node/${token}`, startupMs, initialize, stats, stop, isolation: isolation.evidence };
  } catch (error) {
    try { if (stopDescendants) await stopDescendants(); }
    finally { child.kill("SIGKILL"); try { await waitForExit(); } finally { await isolation.cleanup(); } }
    throw error;
  }
}

export async function createWebKitRunner(root, scratch) {
  const contents = join(scratch, "OriginalPluginProbe.app/Contents");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await writeFile(join(contents, "Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>OriginalPluginProbe</string>
<key>CFBundleIdentifier</key><string>dev.atools.original-plugin-probe</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/>
<key>NSAllowsArbitraryLoadsInWebContent</key><true/></dict></dict></plist>`);
  const executable = join(contents, "MacOS/OriginalPluginProbe");
  const started = performance.now();
  await runProcess("/usr/bin/xcrun", ["swiftc", "-module-cache-path", join(scratch, "module-cache"),
    "-framework", "Cocoa", "-framework", "WebKit", join(root, "scripts/fixtures/legacy-node-webkit.swift"), "-o", executable]);
  return {
    compileMs: performance.now() - started,
    async runFrame(childHtml, name) {
      const file = join(scratch, `${name}.html`);
      await writeFile(file, `<!doctype html><meta charset="utf-8"><iframe id="fixture" sandbox="allow-scripts"></iframe><script>
const frame = document.getElementById('fixture');
addEventListener('message', event => {
  if (event.source !== frame.contentWindow || event.data?.type !== 'business-result') return;
  window.webkit.messageHandlers.transportResult.postMessage({ ...event.data.result, messageOrigin: event.origin });
});
frame.srcdoc = ${JSON.stringify(childHtml).replace(/</g, "\\u003c")};
</script>`);
      const isolation = await createFixtureEnvironment();
      try {
        const { stdout, trackedProcessGroupCleanup } = await runProcess(executable, [file], { env: isolation.env, trackDescendants: true });
        const line = stdout.split(/\r?\n/).find(line => line.startsWith("WK_TRANSPORT_RESULT "));
        assert(line, "Native WebKit did not produce a result");
        return { ...JSON.parse(line.slice("WK_TRANSPORT_RESULT ".length)), fixtureEnvironment: isolation.evidence, trackedProcessGroupCleanup };
      } finally { await isolation.cleanup(); }
    },
  };
}

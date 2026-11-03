import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { access, rm } from "node:fs/promises";
import { test } from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startOwnedViteServer } from "./lib/owned-vite-server.mjs";
import { launchOwnedViteCli } from "./lib/owned-vite-cli-process.mjs";

const root = resolve(import.meta.dirname, "..");
const workerFixture = fileURLToPath(new URL("./test-fixtures/owned-vite-worker.mjs", import.meta.url));

async function assertMissing(path) {
  await assert.rejects(access(path), error => error.code === "ENOENT");
}

test("a strict-port collision rejects without treating the sentinel HTTP 200 as owned", async () => {
  const sentinel = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("sentinel");
  });
  await new Promise(resolveListen => sentinel.listen(0, "127.0.0.1", resolveListen));
  const port = sentinel.address().port;
  let cachePath;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(await response.text(), "sentinel");
    await assert.rejects(startOwnedViteServer({ root, port,
      probeUrl: `http://localhost:${port}/`, timeoutMs: 1000 }), error => {
      assert.match(error.message, /Owned Vite startup failed/);
      assert.equal(error.ownedViteLifecycle.state, "start_failed");
      assert.equal(error.ownedViteLifecycle.cacheState, "removed");
      cachePath = error.ownedViteLifecycle.cachePath;
      return true;
    });
    const stillOwnedBySentinel = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(await stillOwnedBySentinel.text(), "sentinel");
  } finally {
    await new Promise((resolveClose, rejectClose) => sentinel.close(error => error ? rejectClose(error) : resolveClose()));
  }
  await assertMissing(cachePath);
});

test("an owned listener probes its actual socket, isolates cache, and closes idempotently", async () => {
  const owned = await startOwnedViteServer({ root, port: 0, timeoutMs: 20000 });
  const cachePath = owned.lifecycle.cachePath;
  try {
    assert.ok(cachePath.startsWith("/"));
    assert.ok(!cachePath.startsWith(`${root}/`));
    assert.equal(owned.lifecycle.requestedPort, 0);
    assert.ok(owned.lifecycle.selectedPort > 0);
    assert.notEqual(owned.lifecycle.selectedPort, 5173);
    assert.equal(owned.lifecycle.boundAddress.port, owned.lifecycle.selectedPort);
    assert.equal(owned.lifecycle.closeState, "not_attempted");
    const response = await fetch(`${owned.origin}/`);
    assert.equal(response.ok, true);
  } finally {
    await owned.close();
  }
  assert.equal(owned.lifecycle.closeState, "closed");
  assert.equal(owned.lifecycle.cacheState, "removed");
  await owned.close();
  await assertMissing(cachePath);
});

test("a network-path-like probe stays on the captured owned socket", async () => {
  let requestedProbe;
  const server = {
    httpServer: { listening: false, address: () => ({ address: "127.0.0.1", family: "IPv4", port: 15433 }) },
    async listen() { this.httpServer.listening = true; },
    async close() { this.httpServer.listening = false; },
  };
  const owned = await startOwnedViteServer({ root, host: "127.0.0.1", port: 15433,
    probeUrl: "http://localhost:15433//foreign.example/ready?fixture=1",
    createServerImpl: async () => server,
    fetchImpl: async value => {
      requestedProbe = new URL(value);
      return { ok: true, status: 200, body: { cancel: async () => {} } };
    },
  });
  try {
    assert.equal(requestedProbe.origin, "http://127.0.0.1:15433");
    assert.equal(requestedProbe.pathname, "//foreign.example/ready");
    assert.equal(requestedProbe.search, "?fixture=1");
  } finally { await owned.close(); }
});

function stubServer(port) {
  return {
    httpServer: { listening: false, address: () => ({ address: "127.0.0.1", family: "IPv4", port }) },
    async listen() { this.httpServer.listening = true; },
    async close() { this.httpServer.listening = false; },
  };
}

test("redirects and followed foreign responses are rejected without a second request", async () => {
  for (const [port, response] of [
    [15434, { ok: false, status: 302, url: "http://127.0.0.1:15434/ready" }],
    [15437, { ok: true, status: 200, url: "http://foreign.example/ready", redirected: true }],
  ]) {
    let calls = 0;
    let optionsSeen;
    const server = stubServer(port);
    await assert.rejects(startOwnedViteServer({ root, host: "127.0.0.1", port,
      probeUrl: `http://127.0.0.1:${port}/ready`, createServerImpl: async () => server,
      fetchImpl: async (_url, options) => {
        calls += 1;
        optionsSeen = options;
        return { ...response, body: { cancel: async () => {} } };
      } }), error => {
      assert.match(error.message, /Owned Vite startup failed/);
      assert.match(error.message, /rejected a redirect/);
      assert.equal(error.ownedViteLifecycle.cacheState, "removed");
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(optionsSeen.redirect, "manual");
    assert.equal(server.httpServer.listening, false);
  }
});

test("a never-settling probe is aborted at its readiness deadline and late rejection is handled", async () => {
  let requestOptions;
  const server = stubServer(15435);
  await assert.rejects(startOwnedViteServer({ root, host: "127.0.0.1", port: 15435,
    probeUrl: "http://127.0.0.1:15435/ready", timeoutMs: 25,
    createServerImpl: async () => server,
    fetchImpl: (_url, options) => {
      requestOptions = options;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => setTimeout(() => reject(new Error("late probe rejection")), 5), { once: true });
      });
    } }), error => {
    assert.match(error.message, /Owned Vite startup failed/);
    assert.match(error.message, /Timed out waiting/);
    assert.equal(error.ownedViteLifecycle.cacheState, "removed");
    assert.equal(error.ownedViteLifecycle.closeState, "closed");
    return true;
  });
  assert.equal(requestOptions.redirect, "manual");
  assert.equal(requestOptions.signal.aborted, true);
  assert.equal(server.httpServer.listening, false);
  await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
});

test("a hanging response-body cancel cannot exceed the remaining readiness budget", async () => {
  let requestSignal;
  const server = stubServer(15436);
  await assert.rejects(startOwnedViteServer({ root, host: "127.0.0.1", port: 15436,
    probeUrl: "http://127.0.0.1:15436/ready", timeoutMs: 25,
    createServerImpl: async () => server,
    fetchImpl: (_url, options) => {
      requestSignal = options.signal;
      return Promise.resolve({ ok: true, status: 200, url: "http://127.0.0.1:15436/ready",
        body: { cancel: () => new Promise(() => {}) } });
    } }), error => {
    assert.match(error.message, /Owned Vite startup failed/);
    assert.match(error.message, /Timed out waiting/);
    assert.equal(error.ownedViteLifecycle.cacheState, "removed");
    return true;
  });
  assert.equal(requestSignal.aborted, true);
  assert.equal(server.httpServer.listening, false);
});

test("the CLI owner refuses a sentinel port and never accepts its foreign HTTP 200", async () => {
  const sentinel = createHttpServer((_request, response) => response.end("foreign sentinel"));
  await new Promise(resolveListen => sentinel.listen(0, "127.0.0.1", resolveListen));
  const port = sentinel.address().port;
  try {
    await assert.rejects(launchOwnedViteCli({ cwd: root, host: "127.0.0.1", port,
      timeoutMs: 1500, workerEntry: workerFixture, workerArgs: ["normal"] }), error => {
      assert.match(error.message, /Owned Vite startup failed/);
      assert.equal(error.atoolsLifecycle.vite.processState, "exited");
      assert.equal(error.atoolsLifecycle.vite.cacheState, "removed");
      return true;
    });
    const stillForeign = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(await stillForeign.text(), "foreign sentinel");
  } finally {
    await new Promise((resolveClose, rejectClose) => sentinel.close(error => error ? rejectClose(error) : resolveClose()));
  }
});

test("the CLI deadline covers worker startup and confirmed process exit owns cache cleanup", async () => {
  await assert.rejects(launchOwnedViteCli({ cwd: root, host: "127.0.0.1", port: 0,
    timeoutMs: 100, termGraceMs: 200, killGraceMs: 200,
    workerEntry: workerFixture, workerArgs: ["hang-start"] }), error => {
    assert.match(error.message, /Timed out starting owned Vite worker/);
    assert.equal(error.atoolsLifecycle.vite.processState, "exited");
    assert.equal(error.atoolsLifecycle.vite.cacheState, "removed");
    return true;
  });
});

test("the CLI kills a listener that never reports readiness before removing its cache", async () => {
  const reservation = createHttpServer();
  await new Promise(resolveListen => reservation.listen(0, "127.0.0.1", resolveListen));
  const port = reservation.address().port;
  await new Promise((resolveClose, rejectClose) => reservation.close(error => error ? rejectClose(error) : resolveClose()));
  await assert.rejects(launchOwnedViteCli({ cwd: root, host: "127.0.0.1", port,
    timeoutMs: 100, termGraceMs: 200, killGraceMs: 200,
    workerEntry: workerFixture, workerArgs: ["hang-ready"] }), error => {
    assert.match(error.message, /Timed out starting owned Vite worker/);
    assert.equal(error.atoolsLifecycle.vite.processState, "exited");
    assert.equal(error.atoolsLifecycle.vite.cacheState, "removed");
    return true;
  });
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
});

test("the CLI owner closes its actual worker listener before cache removal", async () => {
  const owned = await launchOwnedViteCli({ cwd: root, host: "127.0.0.1", port: 0,
    timeoutMs: 2000, workerEntry: workerFixture, workerArgs: ["normal"] });
  const cachePath = owned.lifecycle.cachePath;
  const response = await fetch(owned.origin);
  assert.equal(await response.text(), "owned fixture");
  assert.equal(owned.lifecycle.requestedPort, 0);
  assert.ok(owned.lifecycle.selectedPort > 0);
  assert.notEqual(owned.lifecycle.selectedPort, 5173);
  assert.equal(owned.lifecycle.boundAddress.port, owned.lifecycle.selectedPort);
  await owned.close();
  assert.equal(owned.lifecycle.killEscalated, false);
  assert.equal(owned.lifecycle.closeState, "closed");
  assert.equal(owned.lifecycle.processState, "exited");
  assert.equal(owned.lifecycle.cacheState, "removed");
  await assertMissing(cachePath);
  await assert.rejects(fetch(owned.origin));
});

test("the CLI close deadline escalates to SIGKILL before removing its cache", async () => {
  const owned = await launchOwnedViteCli({ cwd: root, host: "127.0.0.1", port: 0,
    timeoutMs: 2000, termGraceMs: 30, killGraceMs: 1000,
    workerEntry: workerFixture, workerArgs: ["hang-close"] });
  const cachePath = owned.lifecycle.cachePath;
  const response = await fetch(owned.origin);
  assert.equal(await response.text(), "owned fixture");
  await owned.close();
  assert.equal(owned.lifecycle.killEscalated, true);
  assert.equal(owned.lifecycle.killSignalSent, true);
  assert.equal(owned.lifecycle.processState, "exited");
  assert.equal(owned.lifecycle.cacheState, "removed");
  await assertMissing(cachePath);
  await assert.rejects(fetch(owned.origin));
});

test("a rejected parent SIGKILL attempt cannot claim a concurrent SIGKILL exit", async () => {
  const port = 15439;
  for (const outcome of ["false", "throws"]) {
    const child = new EventEmitter();
    child.pid = 12345;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.send = (_message, callback) => {
      callback?.();
      queueMicrotask(() => child.emit("message", { type: "ready",
        address: { address: "127.0.0.1", family: "IPv4", port } }));
    };
    child.kill = signal => {
      if (signal === "SIGTERM") return true;
      assert.equal(signal, "SIGKILL");
      setTimeout(() => {
        child.signalCode = "SIGKILL";
        child.emit("exit", null, "SIGKILL");
      }, 0);
      if (outcome === "throws") throw new Error("child already exited during escalation");
      return false;
    };

    const owned = await launchOwnedViteCli({ cwd: root, host: "127.0.0.1", port,
      timeoutMs: 1000, termGraceMs: 1, killGraceMs: 100,
      forkImpl: () => child,
      fetchImpl: async () => ({ ok: true, status: 200,
        url: `http://127.0.0.1:${port}/?parity=1`, redirected: false,
        body: { cancel: async () => {} } }),
    });
    const cachePath = owned.lifecycle.cachePath;
    await assert.rejects(owned.close(), error => {
      assert.match(error.message, /unexpected worker exit code=null signal=SIGKILL/);
      assert.equal(error.atoolsLifecycle.vite.killEscalated, true);
      assert.equal(error.atoolsLifecycle.vite.killSignalSent, false);
      assert.equal(error.atoolsLifecycle.vite.exitSignal, "SIGKILL");
      assert.equal(error.atoolsLifecycle.vite.processState, "exited");
      assert.equal(error.atoolsLifecycle.vite.cacheState, "removed");
      if (outcome === "throws") {
        assert.match(error.atoolsLifecycle.vite.killError, /already exited during escalation/);
      }
      return true;
    });
    await assertMissing(cachePath);
  }
});

test("a worker-reported Vite close error remains a failure after owned cleanup", async () => {
  const owned = await launchOwnedViteCli({ cwd: root, host: "127.0.0.1", port: 0,
    timeoutMs: 2000, workerEntry: workerFixture, workerArgs: ["close-error"] });
  const cachePath = owned.lifecycle.cachePath;
  const response = await fetch(owned.origin);
  assert.equal(await response.text(), "owned fixture");
  await assert.rejects(owned.close(), error => {
    assert.match(error.message, /worker reported VITE_CLOSE_FAILED/);
    assert.equal(error.atoolsLifecycle.vite.workerCloseErrorCode, "VITE_CLOSE_FAILED");
    assert.equal(error.atoolsLifecycle.vite.exitCode, 1);
    assert.equal(error.atoolsLifecycle.vite.cacheState, "removed");
    assert.equal(error.atoolsLifecycle.vite.closeState, "failed");
    return true;
  });
  assert.equal(owned.lifecycle.state, "close_failed");
  await assertMissing(cachePath);
  await assert.rejects(fetch(owned.origin));
});

test("a stuck owned-cache removal fails within its cleanup budget", async () => {
  const owned = await launchOwnedViteCli({ cwd: root, host: "127.0.0.1", port: 0,
    timeoutMs: 2000, cleanupTimeoutMs: 20, workerEntry: workerFixture, workerArgs: ["normal"],
    removeCacheImpl: () => new Promise(() => {}) });
  const cachePath = owned.lifecycle.cachePath;
  try {
    await assert.rejects(owned.close(), error => {
      assert.match(error.message, /Timed out removing owned Vite cache/);
      assert.equal(error.atoolsLifecycle.vite.processState, "exited");
      assert.equal(error.atoolsLifecycle.vite.cacheState, "remove_timed_out");
      return true;
    });
    assert.equal(owned.lifecycle.state, "close_failed");
    await access(cachePath);
  } finally {
    await rm(cachePath, { recursive: true, force: true });
  }
});

test("a close that leaves the listener open fails visibly and still removes only its cache", async () => {
  let configuredCache;
  const server = {
    httpServer: { listening: false, address: () => ({ address: "127.0.0.1", family: "IPv4", port: 15432 }) },
    async listen() { this.httpServer.listening = true; },
    async close() {},
  };
  const owned = await startOwnedViteServer({ root, host: "127.0.0.1", port: 15432,
    probeUrl: false, createServerImpl: async config => { configuredCache = config.cacheDir; return server; } });
  await assert.rejects(owned.close(), error => {
    assert.match(error.message, /Owned Vite close failed/);
    assert.equal(error.ownedViteLifecycle.closeState, "failed");
    assert.equal(error.ownedViteLifecycle.cacheState, "removed");
    return true;
  });
  assert.equal(server.httpServer.listening, true);
  await assertMissing(configuredCache);
});

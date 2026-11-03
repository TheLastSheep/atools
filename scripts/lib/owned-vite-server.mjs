import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer, isIP } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

function lifecycleError(message, cause, lifecycle) {
  const error = new Error(message, { cause });
  error.ownedViteLifecycle = lifecycle;
  return error;
}

export function normalizeProbeUrl(value, address, port) {
  const requested = new URL(value);
  assert.equal(requested.protocol, "http:", "Vite readiness probe must use HTTP");
  assert.equal(requested.username + requested.password, "", "Vite readiness probe must not contain credentials");
  const requestedPort = requested.port ? Number(requested.port) : 80;
  assert.equal(requestedPort, port, "Vite readiness probe port must match the owned listener");
  let host = address;
  if (host === "0.0.0.0") host = "127.0.0.1";
  if (host === "::") host = "::1";
  assert.ok(isIP(host), "Vite listener must have a concrete IP address for the readiness probe");
  const origin = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  const ownedUrl = new URL(origin);
  ownedUrl.pathname = requested.pathname;
  ownedUrl.search = requested.search;
  assert.equal(ownedUrl.origin, origin, "Vite readiness probe escaped the owned listener origin");
  return ownedUrl.toString();
}

function reachableHost(address) {
  if (address === "0.0.0.0") return "127.0.0.1";
  if (address === "::") return "::1";
  return address;
}

/** Vite maps server.port=0 to its default port; select a free port and require strict binding. */
export async function selectVitePort(host, requestedPort) {
  if (requestedPort !== 0) return requestedPort;
  const reservation = createNetServer();
  const port = await new Promise((resolvePort, rejectPort) => {
    reservation.once("error", rejectPort);
    reservation.listen(0, host, () => {
      const address = reservation.address();
      if (!address || typeof address !== "object") {
        reservation.close(() => rejectPort(new Error("Could not determine an ephemeral Vite port")));
        return;
      }
      reservation.close(error => error ? rejectPort(error) : resolvePort(address.port));
    });
  });
  assert.ok(Number.isInteger(port) && port > 0, "Could not select an ephemeral Vite port");
  return port;
}

async function cleanupOwnedVite(server, lifecycle) {
  const errors = [];
  lifecycle.closeState = server ? "attempted" : "not_created";
  if (server) {
    try {
      await server.close();
      assert.equal(server.httpServer?.listening, false, "Owned Vite HTTP listener remains open after close");
      lifecycle.closeState = "closed";
    } catch (error) {
      lifecycle.closeState = "failed";
      lifecycle.closeError = String(error?.message || error);
      errors.push(error);
    }
  }
  if (lifecycle.cachePath) {
    try {
      await rm(lifecycle.cachePath, { recursive: true, force: true });
      try {
        await access(lifecycle.cachePath);
        throw new Error("Owned Vite cache remains after removal");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      lifecycle.cacheState = "removed";
    } catch (error) {
      lifecycle.cacheState = "remove_failed";
      lifecycle.cacheError = String(error?.message || error);
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Owned Vite listener/cache cleanup failed");
}

export function assertOwnedBoundAddress(address, requestedHost, requestedPort) {
  assert.ok(address && typeof address === "object", "Vite did not retain a bound TCP listener");
  const hostMatches = address.address === requestedHost
    || (requestedHost === "localhost" && (address.address === "127.0.0.1" || address.address === "::1"))
    || (requestedHost === "0.0.0.0" && address.address === "0.0.0.0")
    || (requestedHost === "::" && address.address === "::");
  assert.ok(hostMatches, "Vite bound a different host than the requested address");
  if (requestedPort !== 0) assert.equal(address.port, requestedPort, "Vite bound a different port than requested");
  return address;
}

function actualBoundAddress(server, requestedHost, requestedPort) {
  const address = server.httpServer?.address?.();
  assert.ok(server.httpServer?.listening && address && typeof address === "object",
    "Vite did not retain a bound TCP listener");
  return assertOwnedBoundAddress(address, requestedHost, requestedPort);
}

function withinReadinessBudget(startOperation, deadline, controller, stage) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    controller.abort();
    return Promise.reject(new Error(`Owned Vite readiness timed out during ${stage}`));
  }
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Owned Vite readiness timed out during ${stage}`));
    }, remaining);
  });
  const operation = Promise.resolve().then(startOperation);
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

function responseEscapedProbe(response, probeOrigin) {
  if ((response.status >= 300 && response.status < 400)
      || response.redirected === true || response.type === "opaqueredirect") return true;
  if (typeof response.url !== "string" || response.url === "") return false;
  try { return new URL(response.url).origin !== probeOrigin; }
  catch { return true; }
}

async function waitForOwnedProbeUntil(probeUrl, deadline, fetchImpl) {
  const probeOrigin = new URL(probeUrl).origin;
  let lastError;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    try {
      const response = await withinReadinessBudget(
        () => fetchImpl(probeUrl, { redirect: "manual", signal: controller.signal }),
        deadline, controller, "request");
      if (responseEscapedProbe(response, probeOrigin)) {
        try { await withinReadinessBudget(() => response.body?.cancel?.(), deadline, controller, "redirect body cleanup"); }
        catch { controller.abort(); }
        const error = new Error("Owned Vite readiness rejected a redirect or escaped response");
        error.code = "OWNED_VITE_PROBE_REDIRECT";
        throw error;
      }
      await withinReadinessBudget(() => response.body?.cancel?.(), deadline, controller, "response cleanup");
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (error?.code === "OWNED_VITE_PROBE_REDIRECT") throw error;
      lastError = error;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise(resolvePromise => setTimeout(resolvePromise, Math.min(250, remaining)));
  }
  throw new Error(`Timed out waiting for owned Vite listener: ${lastError?.message || "HTTP probe did not become ready"}`);
}

export function waitForOwnedProbe(probeUrl, timeoutMs, fetchImpl = fetch) {
  return waitForOwnedProbeUntil(probeUrl, Date.now() + timeoutMs, fetchImpl);
}

export function waitForOwnedProbeUntilDeadline(probeUrl, deadline, fetchImpl = fetch) {
  return waitForOwnedProbeUntil(probeUrl, deadline, fetchImpl);
}

/** Starts an API-owned Vite listener with an isolated optimizer cache and verifies its bound socket. */
export async function startOwnedViteServer(options) {
  const root = resolve(options.root);
  const host = options.host || "127.0.0.1";
  const port = Number(options.port ?? 1420);
  const timeoutMs = options.timeoutMs ?? 20000;
  const cachePrefix = options.cachePrefix ?? "atools-owned-vite-";
  assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535, "Vite port must be an integer between 0 and 65535");
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0, "Vite readiness timeout must be a positive integer");
  assert.match(cachePrefix, /^[a-z0-9-]{1,48}-$/i, "Vite cache prefix must be a short path-safe label");

  const lifecycle = { state: "starting", host, requestedPort: port, selectedPort: null, boundAddress: null,
    closeState: "not_attempted", cacheState: "not_created", cachePath: null };
  let server;
  try {
    lifecycle.selectedPort = await selectVitePort(host, port);
    lifecycle.cachePath = await mkdtemp(join(tmpdir(), cachePrefix));
    lifecycle.cacheState = "created";
    const createServerImpl = options.createServerImpl || (await import("vite")).createServer;
    server = await createServerImpl({
      ...(options.viteOptions || {}),
      root,
      configFile: options.configFile ?? resolve(root, "vite.config.ts"),
      cacheDir: lifecycle.cachePath,
      clearScreen: false,
      logLevel: options.logLevel ?? "warn",
      server: { ...(options.viteOptions?.server || {}), host, port: lifecycle.selectedPort, strictPort: true },
    });
    lifecycle.state = "created";
    await server.listen();
    const address = actualBoundAddress(server, host, lifecycle.selectedPort);
    lifecycle.boundAddress = { address: address.address, family: address.family, port: address.port };
    lifecycle.state = "listening";
    if (options.probeUrl !== false) {
      const probeInput = options.probeUrl || `http://${reachableHost(address.address)}:${address.port}/?parity=1`;
      const ownedProbeUrl = normalizeProbeUrl(probeInput, address.address, address.port);
      await waitForOwnedProbe(ownedProbeUrl, timeoutMs, options.fetchImpl || fetch);
    }
  } catch (failure) {
    lifecycle.state = "start_failed";
    try { await cleanupOwnedVite(server, lifecycle); }
    catch (cleanupFailure) { lifecycle.cleanupError = String(cleanupFailure?.message || cleanupFailure); }
    throw lifecycleError(`Owned Vite startup failed: ${failure?.message || failure}`, failure, lifecycle);
  }

  let closed = false;
  return {
    lifecycle,
    origin: `http://${reachableHost(lifecycle.boundAddress.address).includes(":") ? `[${reachableHost(lifecycle.boundAddress.address)}]` : reachableHost(lifecycle.boundAddress.address)}:${lifecycle.boundAddress.port}`,
    async close() {
      if (closed) return lifecycle;
      lifecycle.closeState = "attempted";
      try {
        await cleanupOwnedVite(server, lifecycle);
        lifecycle.state = "closed";
        closed = true;
        return lifecycle;
      } catch (failure) {
        lifecycle.state = "close_failed";
        throw lifecycleError(`Owned Vite close failed: ${failure?.message || failure}`, failure, lifecycle);
      }
    },
  };
}

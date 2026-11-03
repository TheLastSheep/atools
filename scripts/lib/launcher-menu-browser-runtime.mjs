import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { findChromePath, waitForProcessExit } from "../chrome-cdp-smoke-utils.mjs";
import { startOwnedViteServer } from "./owned-vite-server.mjs";

function lifecycleError(message, cause, lifecycle) {
  const error = new Error(message, { cause });
  error.atoolsLifecycle = lifecycle;
  return error;
}

/** Creates and owns a Vite HTTP listener; startup is accepted only after its bound socket matches. */
export async function launchOwnedVite({ root, port, host = "127.0.0.1", createServerImpl = createServer }) {
  let owned;
  try {
    owned = await startOwnedViteServer({
      root, host, port, probeUrl: false, cachePrefix: "atools-menu-browser-vite-cache-", createServerImpl,
      viteOptions: { optimizeDeps: { entries: ["tests/components/launcher-actions-browser.html"] } },
    });
  } catch (failure) {
    throw lifecycleError(`Owned Vite startup failed: ${failure.message || failure}`, failure,
      { vite: failure.ownedViteLifecycle });
  }
  return {
    lifecycle: owned.lifecycle,
    origin: owned.origin,
    close: async () => {
      try { return await owned.close(); }
      catch (failure) {
        throw lifecycleError(`Owned Vite close failed: ${failure.message || failure}`, failure,
          { vite: owned.lifecycle });
      }
    },
  };
}

function waitForDevtoolsUrl(child, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let output = "";
    const timer = setTimeout(() => finish(reject, new Error(`Timed out waiting for owned Chrome DevTools URL: ${output}`)), timeoutMs);
    const onData = chunk => {
      output += chunk.toString();
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) finish(resolvePromise, match[1]);
    };
    const onExit = (code, signal) => finish(reject, new Error(`Owned Chrome exited before DevTools was ready: code=${code} signal=${signal} ${output}`));
    const onError = failure => finish(reject, failure);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      callback(value);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function stopOwnedChrome(child, lifecycle, waitForExitImpl) {
  if (!child || child.pid == null) {
    lifecycle.processState = "not_spawned";
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    lifecycle.processState = child ? "exited" : "not_spawned";
    return;
  }
  lifecycle.processState = "stopping";
  child.kill("SIGTERM");
  let exited = await waitForExitImpl(child, 3000);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    lifecycle.killEscalated = true;
    exited = await waitForExitImpl(child, 2000);
  }
  if (!exited && child.exitCode === null && child.signalCode === null) {
    lifecycle.processState = "close_failed_process_may_still_run";
    throw new Error("Owned Chrome process did not exit after SIGTERM and SIGKILL");
  }
  lifecycle.processState = "closed";
}

async function removeOwnedProfile(profilePath, lifecycle) {
  if (!profilePath) {
    lifecycle.profileState = "not_created";
    return;
  }
  try {
    await rm(profilePath, { recursive: true, force: true });
    try {
      await access(profilePath);
      throw new Error("Owned Chrome profile still exists after removal");
    } catch (failure) {
      if (failure.code !== "ENOENT") throw failure;
    }
    lifecycle.profileState = "removed";
  } catch (failure) {
    lifecycle.profileState = "remove_failed";
    lifecycle.profileError = String(failure.message || failure);
    throw failure;
  }
}

async function cleanupChrome(child, profilePath, lifecycle, waitForExitImpl) {
  const errors = [];
  try { await stopOwnedChrome(child, lifecycle, waitForExitImpl); }
  catch (failure) { errors.push(failure); }
  try { await removeOwnedProfile(profilePath, lifecycle); }
  catch (failure) { errors.push(failure); }
  if (errors.length) throw new AggregateError(errors, "Owned Chrome process/profile cleanup failed");
}

/** Launches only the child process it creates and owns its unique user-data directory. */
export async function launchOwnedChrome({
  tempRoot = tmpdir(),
  startupTimeoutMs = 10000,
  spawnImpl = spawn,
  findChromePathImpl = findChromePath,
  waitForExitImpl = waitForProcessExit,
} = {}) {
  const lifecycle = { state: "preparing", processState: "not_spawned", profileState: "not_created", killEscalated: false };
  let profilePath;
  let child;
  try {
    const chromePath = await findChromePathImpl();
    profilePath = await mkdtemp(join(tempRoot, `atools-menu-browser-chrome-${randomUUID()}-`));
    lifecycle.profilePath = profilePath;
    lifecycle.profileState = "created";
    child = spawnImpl(chromePath, [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profilePath}`,
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-features=MediaRouter,Translate",
      "--disable-gpu",
      "--hide-scrollbars",
      "--mute-audio",
      "--no-default-browser-check",
      "--no-first-run",
      "about:blank",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    lifecycle.pid = child.pid ?? null;
    lifecycle.state = "starting";
    lifecycle.processState = "running";
    const webSocketUrl = await waitForDevtoolsUrl(child, startupTimeoutMs);
    const url = assertLocalDevtoolsEndpoint(webSocketUrl);
    lifecycle.state = "ready";
    lifecycle.devtoolsEndpoint = `${url.protocol}//${url.hostname}:${url.port}`;
    let closed = false;
    return {
      webSocketUrl,
      lifecycle,
      async close() {
        if (closed) return lifecycle;
        try {
          await cleanupChrome(child, profilePath, lifecycle, waitForExitImpl);
          lifecycle.state = "closed";
          lifecycle.cleanupState = "completed";
          closed = true;
          return lifecycle;
        } catch (failure) {
          lifecycle.state = "close_failed";
          throw lifecycleError(`Owned Chrome close failed: ${failure.message || failure}`, failure, { chrome: lifecycle });
        }
      },
    };
  } catch (failure) {
    lifecycle.state = "startup_failed";
    let cleanupFailure = null;
    try { await cleanupChrome(child, profilePath, lifecycle, waitForExitImpl); }
    catch (error) { cleanupFailure = error; }
    lifecycle.cleanupState = cleanupFailure ? "failed" : "completed";
    const detail = cleanupFailure ? `${failure.message || failure}; cleanup: ${cleanupFailure.message}` : String(failure.message || failure);
    throw lifecycleError(`Owned Chrome startup failed: ${detail}`, failure, { chrome: lifecycle });
  }
}

/** Validates Chrome DevTools endpoint belongs to the child-owned local debug port. */
export function assertLocalDevtoolsEndpoint(webSocketUrl) {
  const url = new URL(webSocketUrl);
  assert.equal(url.protocol, "ws:");
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
  assert.ok(Number(url.port) > 0);
  return url;
}

export function isOwnedResourceClean(state) {
  return state === "closed" || state === "exited" || state === "removed" || state === "not_created" || state === "not_spawned";
}

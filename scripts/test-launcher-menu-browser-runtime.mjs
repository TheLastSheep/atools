import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { launchOwnedVite } from "./lib/launcher-menu-browser-runtime.mjs";
import { navigateFocusedLauncherFixture } from "./lib/launcher-menu-browser-readiness.mjs";

const root = resolve(import.meta.dirname, "..");
const fixture = "tests/components/launcher-actions-browser.html";

function fakeServer({ listenFailure, closeFailure } = {}) {
  return {
    httpServer: { listening: false, address: () => ({ address: "127.0.0.1", family: "IPv4", port: 15132 }) },
    async listen() { if (listenFailure) throw listenFailure; this.httpServer.listening = true; },
    async close() { if (closeFailure) throw closeFailure; this.httpServer.listening = false; },
  };
}

async function missing(path) {
  assert.equal(typeof path, "string");
  await assert.rejects(access(path), error => error.code === "ENOENT");
}

test("Vite scans the explicit fixture only and owns an isolated cache removed with its listener", async () => {
  let options;
  const owned = await launchOwnedVite({ root, port: 15132, createServerImpl: async config => {
    options = config;
    return fakeServer();
  } });
  try {
    assert.deepEqual(options.optimizeDeps.entries, [fixture]);
    assert.ok(options.cacheDir.startsWith("/"));
    assert.ok(!options.cacheDir.startsWith(`${root}/`));
    assert.equal(options.cacheDir, owned.lifecycle.cachePath);
    assert.equal(owned.lifecycle.cacheState, "created");
    await access(options.cacheDir);
  } finally { await owned.close(); }
  assert.equal(owned.lifecycle.closeState, "closed");
  assert.equal(owned.lifecycle.cacheState, "removed");
  await missing(options.cacheDir);
});

test("a strict-port startup failure removes its isolated optimizer cache", async () => {
  let options;
  await assert.rejects(launchOwnedVite({ root, port: 15132, createServerImpl: async config => {
    options = config;
    return fakeServer({ listenFailure: new Error("EADDRINUSE") });
  } }), error => {
    assert.equal(error.atoolsLifecycle.vite.state, "start_failed");
    assert.equal(error.atoolsLifecycle.vite.closeState, "closed");
    assert.equal(error.atoolsLifecycle.vite.cacheState, "removed");
    return true;
  });
  await missing(options.cacheDir);
});

test("Vite creation failure removes its cache and reports that no listener was created", async () => {
  let options;
  await assert.rejects(launchOwnedVite({ root, port: 15132, createServerImpl: async config => {
    options = config;
    throw new Error("config failure");
  } }), error => {
    assert.equal(error.atoolsLifecycle.vite.closeState, "not_created");
    assert.equal(error.atoolsLifecycle.vite.cacheState, "removed");
    return true;
  });
  await missing(options.cacheDir);
});

test("listener close failure remains a failure while its owned cache is removed", async () => {
  const owned = await launchOwnedVite({ root, port: 15132,
    createServerImpl: async () => fakeServer({ closeFailure: new Error("fixture close failure") }) });
  await assert.rejects(owned.close(), error => {
    assert.equal(error.atoolsLifecycle.vite.closeState, "failed");
    assert.equal(error.atoolsLifecycle.vite.cacheState, "removed");
    return true;
  });
  await missing(owned.lifecycle.cachePath);
});

test("fixture readiness activates the owned target and still requires actual document focus", async () => {
  const calls = [];
  const states = [{ focused: false, visibility: "visible", ready: true }, { focused: true, visibility: "visible", ready: true }];
  const page = {
    async send(command, args) { calls.push({ command, args }); },
    waitForEvent(event) { calls.push({ event }); return Promise.resolve(); },
  };
  const waited = [];
  const result = await navigateFocusedLauncherFixture(page, { url: "http://127.0.0.1:15132/fixture",
    evaluate: async () => states.shift(),
    waitFor: async (_page, expression) => { waited.push(expression); },
  });
  assert.equal(result.command, "Page.bringToFront");
  assert.equal(result.focusEmulation, false);
  assert.equal(result.before.focused, false);
  assert.equal(result.after.focused, true);
  assert.ok(calls.findIndex(call => call.event === "Page.domContentEventFired")
    < calls.findIndex(call => call.command === "Page.navigate"));
  assert.equal(calls.at(-1).command, "Page.bringToFront");
  assert.ok(waited.at(-1).includes("document.hasFocus()"));
  assert.ok(waited.at(-1).includes("document.visibilityState==='visible'"));
  assert.ok(waited.at(-1).includes("window.launcherFixtureReady"));
  assert.ok(!calls.some(call => /[Ff]ocusEmulation/.test(call.command || "")));
});

test("activation cannot turn a failed focus readiness check into a pass", async () => {
  const page = { async send() {}, waitForEvent() { return Promise.resolve(); } };
  await assert.rejects(navigateFocusedLauncherFixture(page, { url: "http://127.0.0.1:15132/fixture",
    evaluate: async () => ({ focused: false, visibility: "visible", ready: true }),
    waitFor: async (_page, expression) => { if (expression.includes("document.hasFocus()")) throw new Error("actual focus missing"); },
  }), /actual focus missing/);
});

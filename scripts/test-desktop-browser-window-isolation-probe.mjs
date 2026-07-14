import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const sourceUrl = new URL("src/lib/desktopBrowserWindowIsolationProbe.ts", root);
const componentUrl = new URL("src/components/PluginPanel.svelte", root);
const outDir = await mkdtemp(join(root.pathname, ".tmp-desktop-browser-window-probe-"));
const outFile = join(outDir, "desktopBrowserWindowIsolationProbe.mjs");

const EXPECTED_IDS = [
  "desktop-browser-window-created",
  "desktop-browser-window-child-origin-opaque",
  "desktop-browser-window-self-tauri-unavailable",
  "desktop-browser-window-parent-tauri-unavailable",
  "desktop-browser-window-parent-document-blocked",
  "desktop-browser-window-send-to-parent",
  "desktop-browser-window-execute-javascript",
  "desktop-browser-window-ipc-roundtrip",
  "desktop-browser-window-cleanup",
];

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function parentProxy(parentRawInvoke) {
  return new Proxy({}, {
    get(_target, property) {
      if (property === "document") throw new DOMException("Blocked a frame with origin null", "SecurityError");
      if (property === "__TAURI_INTERNALS__" && parentRawInvoke) return { invoke: parentRawInvoke };
      if (property === "__TAURI__" && parentRawInvoke) return { core: { invoke: parentRawInvoke } };
      if (property === "__TAURI_INTERNALS__" || property === "__TAURI__") {
        throw new DOMException("Blocked cross-origin frame access", "SecurityError");
      }
      return undefined;
    },
  });
}

function createHarness({
  selfRawInvoke,
  parentRawInvoke,
  hangExecute = false,
  closeReject = false,
  closeHang = false,
  createDelayMs = 0,
} = {}) {
  let createCount = 0;
  let closeCount = 0;
  let createdUrl = "";
  let createdOptions = null;
  let childIpcOnce = null;
  let parentCallback = null;
  let destroyed = false;

  const parentWindow = parentProxy(parentRawInvoke);
  const childWindow = {
    location: { origin: "null" },
    parent: parentWindow,
  };
  if (selfRawInvoke) childWindow.__TAURI_INTERNALS__ = { invoke: selfRawInvoke };
  childWindow.require = (name) => {
    assert.equal(name, "electron");
    return {
      ipcRenderer: {
        once(channel, listener) {
          childIpcOnce = { channel, listener };
          return this;
        },
      },
    };
  };
  childWindow.utools = {
    sendToParent(channel, payload) {
      parentCallback?.(channel, payload);
      return Promise.resolve(true);
    },
  };
  childWindow.window = childWindow;
  const childContext = vm.createContext({
    window: childWindow,
    parent: parentWindow,
    location: childWindow.location,
    Promise,
    JSON,
    Error,
    String,
  });

  let executeCount = 0;
  const handle = {
    id: "plugin-browser-window-test",
    type: "browserWindow",
    windowType: "browserWindow",
    webContents: {
      executeJavaScript(code) {
        executeCount += 1;
        if (hangExecute && executeCount === 1) return new Promise(() => {});
        return Promise.resolve(vm.runInContext(String(code), childContext));
      },
      send(channel, payload) {
        assert.equal(childIpcOnce?.channel, channel, "child must register ipcRenderer.once before the parent sends");
        childIpcOnce?.listener({ channel }, payload);
        return Promise.resolve(true);
      },
    },
    close() {
      closeCount += 1;
      if (closeHang) return new Promise(() => {});
      if (closeReject) return Promise.reject(new Error("close rejected"));
      destroyed = true;
      return Promise.resolve({ closed: true });
    },
    isDestroyed() {
      return destroyed;
    },
  };

  const mainWindow = {
    utools: {
      createBrowserWindow(url, options, callback) {
        createCount += 1;
        createdUrl = url;
        createdOptions = options;
        parentCallback = callback;
        if (createDelayMs > 0) {
          return new Promise((resolve) => setTimeout(() => resolve(handle), createDelayMs));
        }
        return Promise.resolve(handle);
      },
    },
  };
  mainWindow.window = mainWindow;
  const mainContext = vm.createContext({
    window: mainWindow,
    Promise,
    JSON,
    Error,
    String,
    Number,
    setTimeout,
    clearTimeout,
  });

  return {
    run(source) {
      return Promise.resolve(vm.runInContext(source, mainContext));
    },
    snapshot() {
      return { createCount, closeCount, createdUrl, createdOptions };
    },
  };
}

try {
  let moduleExists = true;
  try {
    await access(sourceUrl, constants.R_OK);
  } catch {
    moduleExists = false;
  }
  assert.equal(moduleExists, true, "desktop BrowserWindow isolation probe runtime module must exist");

  const source = await readFile(sourceUrl, "utf8");
  const transformed = await transformWithEsbuild(source, sourceUrl.pathname, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);
  const mod = await import(pathToFileURL(outFile).href);

  assert.deepEqual(plain(mod.DESKTOP_BROWSER_WINDOW_ISOLATION_CHECK_IDS), EXPECTED_IDS);
  assert.equal(typeof mod.desktopBrowserWindowIsolationProbeSource, "function");
  assert.equal(typeof mod.normalizeDesktopBrowserWindowProbeContract, "function");
  assert.equal(typeof mod.desktopBrowserWindowSmokeQueueEnabled, "function");
  assert.equal(mod.desktopBrowserWindowSmokeQueueEnabled(0, undefined), false);
  assert.equal(mod.desktopBrowserWindowSmokeQueueEnabled(1, undefined), false);
  assert.equal(mod.desktopBrowserWindowSmokeQueueEnabled(0, () => {}), false);
  assert.equal(
    mod.desktopBrowserWindowSmokeQueueEnabled(1, () => {}),
    true,
    "only an active desktop smoke queue with a render callback may unlock smoke-only permissions",
  );
  const validContract = mod.normalizeDesktopBrowserWindowProbeContract(
    EXPECTED_IDS.map((id) => ({ id, passed: true })),
  );
  assert.equal(validContract.reported, true);
  assert.equal(validContract.passed, true);
  assert.deepEqual(plain(validContract.failedIds), []);
  for (const [label, forged] of [
    ["duplicate", [...EXPECTED_IDS.slice(0, -1), EXPECTED_IDS[0]]],
    ["unknown", [...EXPECTED_IDS.slice(0, -1), "desktop-browser-window-forged"]],
    ["missing", EXPECTED_IDS.slice(0, -1)],
    ["out-of-order", [EXPECTED_IDS[1], EXPECTED_IDS[0], ...EXPECTED_IDS.slice(2)]],
  ]) {
    const normalized = mod.normalizeDesktopBrowserWindowProbeContract(
      forged.map((id) => ({ id, passed: true })),
    );
    assert.equal(normalized.reported, true, `${label} arrays still reported but must not pass the contract`);
    assert.equal(normalized.passed, false, `${label} BrowserWindow probe IDs must fail closed`);
    assert.ok(
      normalized.failedIds.includes(mod.DESKTOP_BROWSER_WINDOW_PROBE_CONTRACT_FAILED_ID),
      `${label} BrowserWindow probe IDs must include the stable contract failure ID`,
    );
  }

  const successHarness = createHarness();
  const success = await successHarness.run(mod.desktopBrowserWindowIsolationProbeSource({
    mainUrl: "index.html",
    sampleIndex: 0,
    timeoutMs: 250,
  }));
  assert.equal(success.expected, true);
  assert.equal(success.reported, true);
  assert.deepEqual(plain(success.probes.map((probe) => probe.id)), EXPECTED_IDS);
  assert.equal(success.probes.every((probe) => probe.passed === true), true);
  assert.equal(success.created, true);
  assert.equal(success.childOriginOpaque, true);
  assert.equal(success.selfTauriUnavailable, true);
  assert.equal(success.parentTauriUnavailable, true);
  assert.equal(success.parentDocumentBlocked, true);
  assert.equal(success.sendToParentChecked, true);
  assert.equal(success.executeJavascriptChecked, true);
  assert.equal(success.ipcRoundtripChecked, true);
  assert.equal(success.cleanupChecked, true);
  assert.deepEqual(plain(successHarness.snapshot()), {
    createCount: 1,
    closeCount: 1,
    createdUrl: "index.html",
    createdOptions: { show: false },
  });

  const laterHarness = createHarness();
  const later = await laterHarness.run(mod.desktopBrowserWindowIsolationProbeSource({
    mainUrl: "index.html",
    sampleIndex: 1,
    timeoutMs: 250,
  }));
  assert.equal(later.expected, false);
  assert.equal(later.reported, false);
  assert.deepEqual(plain(later.probes), []);
  assert.equal(laterHarness.snapshot().createCount, 0, "only the first canonical sample may create the isolation canary");

  const rawCalls = [];
  const canaryHarness = createHarness({
    selfRawInvoke(command, args) {
      rawCalls.push({ command, args });
      return Promise.resolve("unexpected direct Tauri success");
    },
  });
  const canary = await canaryHarness.run(mod.desktopBrowserWindowIsolationProbeSource({
    mainUrl: "index.html",
    sampleIndex: 0,
    timeoutMs: 250,
  }));
  assert.deepEqual(plain(rawCalls), [{
    command: "get_setting",
    args: { key: "__atools_browser_window_isolation_probe__" },
  }], "a discovered raw Tauri invoker may only receive the read-only get_setting canary");
  assert.equal(canary.selfTauriUnavailable, false, "a successful raw Tauri canary must fail isolation");
  assert.equal(
    canary.probes.find((probe) => probe.id === "desktop-browser-window-self-tauri-unavailable")?.passed,
    false,
  );
  assert.equal(canary.cleanupChecked, true, "a failed isolation canary must still close the hosted child");

  const parentRawCalls = [];
  const parentCanaryHarness = createHarness({
    parentRawInvoke(command, args) {
      parentRawCalls.push({ command, args });
      return Promise.resolve("unexpected direct parent Tauri success");
    },
  });
  const parentCanary = await parentCanaryHarness.run(mod.desktopBrowserWindowIsolationProbeSource({
    mainUrl: "index.html",
    sampleIndex: 0,
    timeoutMs: 250,
  }));
  assert.deepEqual(plain(parentRawCalls), [{
    command: "get_setting",
    args: { key: "__atools_browser_window_isolation_probe__" },
  }], "a discovered parent raw Tauri invoker may only receive the read-only get_setting canary");
  assert.equal(parentCanary.parentTauriUnavailable, false, "a successful parent raw Tauri canary must fail isolation");
  assert.equal(
    parentCanary.probes.find((probe) => probe.id === "desktop-browser-window-parent-tauri-unavailable")?.passed,
    false,
  );
  assert.equal(parentCanary.cleanupChecked, true, "a failed parent isolation canary must still close the hosted child");

  for (const [label, side, rawInvoke] of [
    ["self reject", "self", () => Promise.reject(new Error("canary rejected"))],
    ["self throw", "self", () => { throw new Error("canary threw"); }],
    ["parent reject", "parent", () => Promise.reject(new Error("parent canary rejected"))],
    ["parent throw", "parent", () => { throw new Error("parent canary threw"); }],
  ]) {
    const calls = [];
    const trackedInvoke = (command, args) => {
      calls.push({ command, args });
      return rawInvoke();
    };
    const harness = createHarness(side === "self"
      ? { selfRawInvoke: trackedInvoke }
      : { parentRawInvoke: trackedInvoke });
    const probe = await harness.run(mod.desktopBrowserWindowIsolationProbeSource({
      mainUrl: "index.html",
      sampleIndex: 0,
      timeoutMs: 250,
    }));
    assert.deepEqual(plain(calls), [{
      command: "get_setting",
      args: { key: "__atools_browser_window_isolation_probe__" },
    }], `${label} may only attempt the read-only get_setting canary`);
    assert.equal(
      side === "self" ? probe.selfTauriUnavailable : probe.parentTauriUnavailable,
      false,
      `${label} must fail closed because a raw invoker exists`,
    );
    assert.equal(probe.cleanupChecked, true, `${label} must still close the hosted child`);
  }

  const timeoutHarness = createHarness({ hangExecute: true });
  const timedOut = await timeoutHarness.run(mod.desktopBrowserWindowIsolationProbeSource({
    mainUrl: "index.html",
    sampleIndex: 0,
    timeoutMs: 20,
  }));
  assert.equal(timedOut.created, true);
  assert.equal(timedOut.cleanupChecked, true, "timeout paths must close and verify the hosted child in finally");
  assert.equal(timeoutHarness.snapshot().closeCount, 1);
  assert.equal(timedOut.probes.every((probe) => probe.passed === true), false);

  const closeRejectHarness = createHarness({ closeReject: true });
  const closeRejected = await closeRejectHarness.run(mod.desktopBrowserWindowIsolationProbeSource({
    mainUrl: "index.html",
    sampleIndex: 0,
    timeoutMs: 50,
  }));
  assert.equal(closeRejected.cleanupChecked, false, "a rejected close must fail cleanup without hanging the report");
  assert.equal(closeRejectHarness.snapshot().closeCount, 1);

  const closeHangHarness = createHarness({ closeHang: true });
  const closeHangStartedAt = Date.now();
  const closeHung = await closeHangHarness.run(mod.desktopBrowserWindowIsolationProbeSource({
    mainUrl: "index.html",
    sampleIndex: 0,
    timeoutMs: 20,
  }));
  assert.equal(closeHung.cleanupChecked, false, "a hanging close must fail cleanup after its own bounded timeout");
  assert.ok(Date.now() - closeHangStartedAt < 500, "a hanging close must not hang the BrowserWindow probe report");
  assert.equal(closeHangHarness.snapshot().closeCount, 1);

  const delayedCreateHarness = createHarness({ createDelayMs: 40 });
  const delayedCreate = await delayedCreateHarness.run(mod.desktopBrowserWindowIsolationProbeSource({
    mainUrl: "index.html",
    sampleIndex: 0,
    timeoutMs: 20,
  }));
  assert.equal(delayedCreate.cleanupChecked, false, "a create that misses the probe deadline cannot claim synchronous cleanup");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(
    delayedCreateHarness.snapshot().closeCount,
    1,
    "a create that resolves after the probe timeout must still close through the finishing branch",
  );

  const componentSource = await readFile(componentUrl, "utf8");
  assert.match(componentSource, /desktopBrowserWindowIsolationProbeSource/);
  assert.match(
    componentSource,
    /normalizeDesktopBrowserWindowProbeContract\(data\.browserWindowProbes\)/,
    "PluginPanel must validate exact BrowserWindow probe IDs before reporting pass state",
  );
  assert.match(
    componentSource,
    /desktopBrowserWindowSmokeQueueEnabled\(desktopSmokeExpectedSamples, ondesktopsmokerender\)/,
    "ordinary PluginPanel props must not unlock desktop-smoke BrowserWindow permission",
  );
  assert.match(
    componentSource,
    /bridgeProbe\.browserWindowCleanupChecked\s*&&\s*pluginBrowserWindows\.length === 0/,
    "the final cleanup field must prove the hosted BrowserWindow was removed from host state",
  );
  assert.match(
    componentSource,
    /function desktopSmokeNativeProbePermissionAllowed[\s\S]*?"browserWindow"[\s\S]*?\.includes\(value\)/,
    "browserWindow permission must only be enabled inside the double-guarded desktop smoke allowlist",
  );
  for (const field of [
    "browserWindowProbeExpected",
    "browserWindowProbeReported",
    "browserWindowProbePassed",
    "browserWindowProbeChecks",
    "browserWindowProbePassedChecks",
    "browserWindowProbeFailedIds",
    "browserWindowCreated",
    "browserWindowChildOriginOpaque",
    "browserWindowSelfTauriUnavailable",
    "browserWindowParentTauriUnavailable",
    "browserWindowParentDocumentBlocked",
    "browserWindowSendToParentChecked",
    "browserWindowExecuteJavascriptChecked",
    "browserWindowIpcRoundtripChecked",
    "browserWindowCleanupChecked",
  ]) {
    assert.match(componentSource, new RegExp(`\\b${field}\\b`), `PluginPanel report must include ${field}`);
  }
  const childCreationSection = componentSource.slice(
    componentSource.indexOf("async function createPluginBrowserWindow"),
    componentSource.indexOf("function pluginBrowserWindowNavigationResult"),
  );
  assert.match(childCreationSection, /injectPluginBridge\(html, "browserWindow", id\)/);
  assert.doesNotMatch(
    childCreationSection,
    /injectDesktopSmokeBridgeProbe/,
    "hosted children must not recursively receive the desktop smoke probe",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}

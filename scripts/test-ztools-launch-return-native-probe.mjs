import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const probePath = new URL(
  "../src-tauri/src/renderer_desktop_smoke/launch_return_journey/probe.js",
  import.meta.url,
);
const probe = await readFile(probePath, "utf8");
const failureSnapshotScript =
  "(()=>{try{return window.__ATOOLS_RENDERER_LAUNCH_RETURN__?.snapshot?.()??null}catch(_){return null}})()";
const token = "0123456789abcdef0123456789abcdef";
const firstPath = "/private/tmp/first.app";
const secondPath = "/private/tmp/second.app";

function eventSource(subscribers = 1) {
  return {
    subscribers,
    listenerState: "listening",
    deliveredEvents: 0,
    registrationErrors: 0,
    callbackErrors: 0,
    registrationsPending: 0,
    lateListenerUnlistens: 0,
    cleanupPending: 0,
    cleanupErrors: 0,
  };
}

function localShortcutEvents() {
  return {
    ...eventSource(),
    invalidEvents: 0,
    staleEvents: 0,
    latestRevision: null,
    replayPending: false,
  };
}

function adapterSnapshot() {
  return {
    nativeCalls: { launch_renderer_app: 0 },
    outstandingNativeCalls: 0,
    focusEvents: { ...eventSource(), windowContextAvailable: false },
    appState: { eventSource: eventSource() },
    appCatalog: { readPending: false, eventSource: eventSource() },
    appLaunched: { eventSource: eventSource() },
    contextMenu: { eventSource: eventSource() },
    settingsView: { listenerState: "listening", registrationErrors: 0, cleanupErrors: 0 },
    generalPreferenceEvents: { invalidPayloads: 0, notifiedFields: { placeholder: null } },
    localShortcutEvents: localShortcutEvents(),
    windowDrag: { pending: 0, queued: 0, inFlight: null, lockRequests: 0, dispatchedLocks: 0 },
  };
}

async function replay({
  throwFromCurrentDom = false,
  pauseTimers = false,
  registrationSource = "core-seed",
  selectedName = null,
} = {}) {
  const input = {
    value: "",
    dispatchEvent() {
      return true;
    },
  };
  const receipts = [];
  const invokeErrors = [];
  const document = {
    visibilityState: "hidden",
    activeElement: input,
    querySelector(selector) {
      if (selector === "input.search-input") return input;
      return null;
    },
    querySelectorAll(selector) {
      return selectedName && selector === ".list-mode-results .list-item.selected"
        ? [{ querySelector: () => ({ textContent: selectedName }) }] : [];
    },
    hasFocus() {
      if (throwFromCurrentDom) throw new Error("injected currentDom document.hasFocus failure");
      return false;
    },
  };
  const core = {
    async invoke(command, args) {
      try {
        const wireArgs = JSON.parse(JSON.stringify(args));
        receipts.push({ command, receipt: wireArgs.receipt });
      } catch (error) {
        invokeErrors.push(String(error));
        throw error;
      }
    },
  };
  const window = {
    __TAURI__: { core },
    __ATOOLS_ZTOOLS_HOST_ADAPTER__: { snapshot: adapterSnapshot },
    ztools: {
      onAppLaunched() {
        return () => {};
      },
    },
  };
  const source = probe
    .replace("__ATOOLS_LAUNCH_RETURN_TOKEN__", JSON.stringify(token))
    .replace("__ATOOLS_LAUNCH_RETURN_FIRST_PATH__", JSON.stringify(firstPath))
    .replace("__ATOOLS_LAUNCH_RETURN_SECOND_PATH__", JSON.stringify(secondPath))
    .replace("__ATOOLS_LAUNCH_RETURN_TARGET_KIND__", JSON.stringify("local-shortcut"))
    .replace("__ATOOLS_LAUNCH_RETURN_REGISTRATION_SOURCE__", JSON.stringify(registrationSource));
  const vmSetTimeout = pauseTimers ? () => 1 : setTimeout;
  const context = {
    window,
    document,
    setTimeout: vmSetTimeout,
    Date,
    Object,
    Array,
    Promise,
  };
  vm.runInNewContext(source, context);

  const deadline = Date.now() + 1000;
  while (!receipts.some((entry) => entry.command === "renderer_launch_return_probe_ready")) {
    if (Date.now() > deadline) throw new Error("probe readiness receipt timed out in VM replay");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const failureSnapshot = vm.runInNewContext(failureSnapshotScript, context);
  const runPromise = window.__ATOOLS_RENDERER_LAUNCH_RETURN__.run(
    "baseline",
    "abcdef0123456789abcdef0123456789",
  );
  if (pauseTimers) {
    let settled = false;
    void runPromise.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    return { receipts, result: settled ? true : "pending", invokeErrors, failureSnapshot };
  }
  const result = await runPromise;
  return { receipts, result, invokeErrors, failureSnapshot };
}

const healthy = await replay();
assert.equal(healthy.result, true, "healthy baseline must return a receipt result");
assert.equal(healthy.invokeErrors.length, 0, "Tauri JSON serialization must not throw");
const ready = healthy.receipts.find((entry) => entry.command === "renderer_launch_return_probe_ready");
const stage = healthy.receipts.find((entry) => entry.command === "renderer_launch_return_receipt");
assert.deepEqual(ready.receipt, { token, outcome: "ready", reason: "none" });
assert.ok(stage, "baseline receipt must reach invoke after currentDom collection");
assert.deepEqual(Object.keys(stage.receipt.dom).sort(), [
  "actions",
  "adapter",
  "documentHasFocus",
  "inputFocused",
  "inputValue",
  "pastedText",
  "selectedTitle",
  "visibility",
].sort());
assert.equal(stage.receipt.dom.inputValue, "");
assert.equal(stage.receipt.dom.visibility, "hidden");
assert.equal(stage.receipt.dom.documentHasFocus, false);
assert.equal(stage.receipt.dom.adapter.listeners.localShortcutEvents.listenerState, "listening");
assert.equal(healthy.failureSnapshot.visibility, "hidden", "readonly snapshot must be available");

const injected = await replay({ throwFromCurrentDom: true });
assert.equal(injected.result, false, "a synchronous currentDom exception must fail the stage");
assert.equal(
  injected.receipts.filter((entry) => entry.command === "renderer_launch_return_receipt").length,
  0,
  "a currentDom exception occurs before the stage invoke and reproduces a no-receipt timeout",
);
assert.equal(injected.failureSnapshot, null, "snapshot getter exceptions must return null");

const hiddenTimerHeld = await replay({ pauseTimers: true });
assert.equal(
  hiddenTimerHeld.result,
  true,
  "a ready hidden-page baseline must not depend on a background timer before sending",
);
assert.ok(
  hiddenTimerHeld.receipts.some((entry) => entry.command === "renderer_launch_return_receipt"),
  "the ready hidden-page baseline must invoke the stage receipt",
);

const settingsChild = await replay({ registrationSource: "settings-child" });
assert.equal(settingsChild.result, true, "Settings-child baseline must retain the hidden timer behavior");
const settingsNames = await replay({ registrationSource: "settings-child", selectedName: "AToolsOwnedProbeSecond.app" });
assert.equal(settingsNames.failureSnapshot.selectedTitle, "AToolsOwnedProbeSecond.app", "real Settings registration keeps the app suffix");
const staleSettingsNames = await replay({ registrationSource: "settings-child", selectedName: "AToolsOwnedProbeSecond" });
assert.equal(staleSettingsNames.failureSnapshot.selectedTitle, null, "old seeded titles must not pass the Settings-child probe");

process.stdout.write(
  "healthy baseline: receipt sent; injected currentDom throw: no stage invoke; " +
    "hidden timer held after readiness: baseline receipt sent.\n",
);

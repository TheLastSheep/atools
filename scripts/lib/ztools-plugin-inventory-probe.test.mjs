import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const probeUrl = new URL(
  "../../src-tauri/src/renderer_desktop_smoke/settings_input_journey/plugin-inventory-probe.js",
  import.meta.url,
);
const probeSource = await readFile(probeUrl, "utf8");

function loadProbeWithoutCommandStore() {
  const callbacks = [];
  const window = {
    __ATOOLS_SETTINGS_INPUT_TOKEN__: "fixture-token",
    __TAURI_INTERNALS__: {
      invoke: async (command, args) => callbacks.push({ command, args }),
    },
    __ATOOLS_ZTOOLS_HOST_ADAPTER__: {
      snapshot: () => ({
        pluginCatalog: {
          cachedPlugins: 1,
          readPending: false,
          lateChangePending: false,
          callbackErrors: 0,
          invalidPayloads: 0,
          eventSource: {
            listenerState: "listening",
            deliveredEvents: 1,
            registrationErrors: 0,
            callbackErrors: 0,
            registrationsPending: 0,
            cleanupErrors: 0,
          },
        },
        nativeCalls: { list_plugins: 1 },
        outstandingNativeCalls: 0,
      }),
    },
  };
  vm.runInNewContext(probeSource, {
    window,
    document: { getElementById: () => null },
    setTimeout,
    Date,
    Promise,
    Map,
    Reflect,
    Array,
    Object,
    Number,
  });
  return { window, callbacks };
}

test("Native pluginInventoryInspect call returns a probe callback and preserves unknown store readiness", async () => {
  const { window, callbacks } = loadProbeWithoutCommandStore();
  const inspect = window.__ATOOLS_SETTINGS_INPUT_PLUGIN_INVENTORY__?.pluginInventoryInspect;
  assert.equal(typeof inspect, "function", "Native invokes pluginInventoryInspect");

  await inspect("probe-id", "Fixture App", "/fixture/app", -1, -1, -1);

  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].command, "settings_input_probe");
  assert.equal(callbacks[0].args.token, "fixture-token");
  assert.equal(callbacks[0].args.operation, "mainPluginInventory");
  assert.equal(callbacks[0].args.probeId, "probe-id");
  assert.equal(callbacks[0].args.evidence.storeReady, null);
});

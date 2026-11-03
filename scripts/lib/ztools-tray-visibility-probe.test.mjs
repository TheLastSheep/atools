import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const probeUrl = new URL(
  "../../src-tauri/src/renderer_desktop_smoke/settings_input_journey/tray-visibility-probe.js",
  import.meta.url,
);
const probeSource = await readFile(probeUrl, "utf8");

function loadProbe(initialEnabled) {
  const callbacks = [];
  const dispatched = [];
  const generalSettings = { showTrayIcon: initialEnabled };
  let now = 0;

  class FixtureInput {
    constructor(checked) {
      this.checked = checked;
    }

    get checked() {
      return this._checked;
    }

    set checked(value) {
      this._checked = value;
    }

    dispatchEvent(event) {
      dispatched.push(event.type);
      if (event.type === "change") generalSettings.showTrayIcon = this.checked;
      return true;
    }
  }

  class FixtureEvent {
    constructor(type, options) {
      this.type = type;
      this.bubbles = options.bubbles;
      this.cancelable = options.cancelable;
    }
  }

  const input = new FixtureInput(initialEnabled);
  const row = {
    querySelector: (selector) => selector === ".setting-label > span"
      ? { textContent: "显示托盘图标" }
      : null,
    querySelectorAll: (selector) => selector === ".setting-control input[type=checkbox]"
      ? [input]
      : [],
  };
  const document = {
    hidden: false,
    hasFocus: () => true,
    querySelectorAll: (selector) => selector === ".setting-item" ? [row] : [],
  };
  const window = {
    location: { hash: "#/generalSetting" },
    __ATOOLS_SETTINGS_INPUT_TOKEN__: "tray-probe-fixture-token",
    __TAURI_INTERNALS__: {
      invoke: async (command, args) => callbacks.push({ command, args }),
    },
    ztools: {
      internal: {
        dbGet: async (key) => key === "settings-general" ? { ...generalSettings } : null,
      },
    },
  };

  vm.runInNewContext(probeSource, {
    window,
    document,
    HTMLInputElement: FixtureInput,
    Event: FixtureEvent,
    Date: { now: () => {
      const current = now;
      now += 2000;
      return current;
    } },
    setTimeout: (callback) => {
      callback();
      return 0;
    },
  });
  return { window, input, generalSettings, callbacks, dispatched };
}

for (const expected of [false, true]) {
  test(`trayVisibilitySet applies boolean ${expected} through mock DOM events`, async () => {
    const fixture = loadProbe(!expected);
    const setEnabled = fixture.window.__ATOOLS_SETTINGS_INPUT_TRAY_VISIBILITY__?.setEnabled;
    assert.equal(typeof setEnabled, "function");

    await setEnabled("tray-probe-id", expected);

    assert.deepEqual(fixture.dispatched, ["input", "change"]);
    assert.equal(fixture.input.checked, expected);
    assert.equal(fixture.generalSettings.showTrayIcon, expected);
    assert.equal(fixture.callbacks.length, 1);
    assert.equal(fixture.callbacks[0].command, "settings_input_probe");
    assert.equal(fixture.callbacks[0].args.operation, "childTrayVisibilitySet");
    assert.equal(fixture.callbacks[0].args.evidence.uiEnabled, expected);
    assert.equal(fixture.callbacks[0].args.evidence.storedEnabled, expected);
    assert.equal(fixture.callbacks[0].args.evidence.inputDispatched, true);
    assert.equal(fixture.callbacks[0].args.evidence.changeDispatched, true);
  });
}

for (const invalid of ["false", "true", 0, 1, null]) {
  test(`trayVisibilitySet rejects non-boolean ${String(invalid)} without DOM dispatch`, async () => {
    const fixture = loadProbe(true);
    const setEnabled = fixture.window.__ATOOLS_SETTINGS_INPUT_TRAY_VISIBILITY__?.setEnabled;
    assert.equal(typeof setEnabled, "function");

    await setEnabled("tray-probe-id", invalid);

    assert.deepEqual(fixture.dispatched, []);
    assert.equal(fixture.input.checked, true);
    assert.equal(fixture.generalSettings.showTrayIcon, true);
    assert.equal(fixture.callbacks.length, 1);
    assert.equal(fixture.callbacks[0].args.evidence.inputDispatched, false);
    assert.equal(fixture.callbacks[0].args.evidence.changeDispatched, false);
  });
}

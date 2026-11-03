import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const probeUrl = new URL(
  "../../src-tauri/src/renderer_desktop_smoke/settings_input_journey/main_hotkey_startup/main-hotkey-startup-probe.js",
  import.meta.url,
);
const probeSource = await readFile(probeUrl, "utf8");
const NO_HOTKEY = "点击录制快捷键";

function loadProbe({ hotkey = "", currentShortcut = "", placeholder = "Before", focusDenied = false } = {}) {
  const callbacks = [];
  const domEvents = [];
  const settings = { hotkey, placeholder };
  let now = 0;
  const hotkeyControl = { textContent: NO_HOTKEY, click: () => domEvents.push("hotkey-click") };
  let document;

  class FixtureInput {
    constructor(value) { this._value = value; }
    click() { domEvents.push("placeholder-click"); }
    dispatchEvent(event) {
      event.currentTarget = this;
      domEvents.push(event.type);
      if (event.type === "blur" && event.currentTarget === this) {
        settings.placeholder = this.value;
      }
      return true;
    }
    focus() {
      domEvents.push("focus");
      if (!focusDenied) document.activeElement = this;
    }
    blur() {
      if (document.activeElement !== this) return;
      this.dispatchEvent({ type: "blur" });
      document.activeElement = null;
    }
  }
  Object.defineProperty(FixtureInput.prototype, "value", {
    get() { return this._value; },
    set(value) { this._value = value; },
  });

  const row = (label, control) => ({
    querySelector: selector => selector === ".setting-label > span" ? { textContent: label } : null,
    querySelectorAll: selector => {
      if (selector === ".setting-control .hotkey-input" && label === "呼出快捷键") return [control];
      if (selector === ".setting-control input" && label === "搜索框提示文字") return [control];
      return [];
    },
  });
  document = {
    hidden: true,
    activeElement: null,
    hasFocus: () => false,
    querySelectorAll: selector => selector === ".setting-item"
      ? [row("呼出快捷键", hotkeyControl), row("搜索框提示文字", new FixtureInput(placeholder))]
      : [],
  };
  const window = {
    location: { hash: "#/generalSetting" },
    __ATOOLS_SETTINGS_INPUT_TOKEN__: "hotkey-startup-probe-fixture-token",
    __TAURI_INTERNALS__: {
      invoke: async (command, args) => callbacks.push({ command, args }),
    },
    ztools: {
      internal: {
        dbGet: async key => key === "settings-general" ? { ...settings } : null,
        getCurrentShortcut: async () => currentShortcut,
      },
    },
  };

  vm.runInNewContext(probeSource, {
    window,
    document,
    HTMLInputElement: FixtureInput,
    Event: class FixtureEvent { constructor(type, options = {}) { this.type = type; this.bubbles = options.bubbles ?? false; } },
    Date: { now: () => { const current = now; now += 100; return current; } },
    setTimeout: callback => { callback(); return 0; },
  });
  return { window, callbacks, domEvents, settings };
}

test("startup inspect recognizes the pinned HotkeyInput div and both empty bridge facts", async () => {
  const fixture = loadProbe();
  await fixture.window.__ATOOLS_SETTINGS_INPUT_HOTKEY_STARTUP__.hotkeyStartupInspect("probe");

  assert.equal(fixture.callbacks.length, 1);
  const { command, args } = fixture.callbacks[0];
  assert.equal(command, "settings_input_probe");
  assert.equal(args.operation, "childHotkeyStartupInspect");
  assert.deepEqual({ ...args.evidence }, {
    routeGeneral: true,
    hotkeyControlUnique: true,
    hotkeyControlEmpty: true,
    projectedHotkeyEmpty: true,
    currentShortcutEmpty: true,
    documentHidden: true,
    documentHasFocus: false,
  });
});

test("placeholder edit accepts the intentionally empty child projection and preserves it", async () => {
  const fixture = loadProbe();
  await fixture.window.__ATOOLS_SETTINGS_INPUT_HOTKEY_STARTUP__.hotkeyStartupEditPlaceholder("probe", "Before", "After");

  assert.deepEqual(fixture.domEvents, ["placeholder-click", "input", "change", "blur"]);
  assert.equal(fixture.settings.placeholder, "After");
  assert.equal(fixture.settings.hotkey, "");
  assert.equal(fixture.callbacks.length, 1);
  const { command, args } = fixture.callbacks[0];
  assert.equal(command, "settings_input_probe");
  assert.equal(args.operation, "childHotkeyStartupPlaceholder");
  assert.equal(args.evidence.placeholderStored, true);
  assert.equal(args.evidence.projectedHotkeyEmpty, true);
  assert.equal(args.evidence.currentShortcutEmpty, true);
  assert.equal(Object.hasOwn(args.evidence, "invalidHotkeyPreserved"), false);
});

test("nonempty bridge hotkey facts never qualify as the recovery empty state", async () => {
  for (const facts of [{ hotkey: "Command+Command" }, { currentShortcut: "Command+Ctrl+F11" }]) {
    const fixture = loadProbe(facts);
    await fixture.window.__ATOOLS_SETTINGS_INPUT_HOTKEY_STARTUP__.hotkeyStartupInspect("probe");
    const evidence = fixture.callbacks[0].args.evidence;
    assert.equal(evidence.projectedHotkeyEmpty, facts.hotkey === undefined);
    assert.equal(evidence.currentShortcutEmpty, facts.currentShortcut === undefined);
  }
});

test("placeholder edit refuses either nonempty bridge hotkey fact", async () => {
  for (const facts of [{ hotkey: "Command+Command" }, { currentShortcut: "Command+Ctrl+F11" }]) {
    const fixture = loadProbe(facts);
    await fixture.window.__ATOOLS_SETTINGS_INPUT_HOTKEY_STARTUP__
      .hotkeyStartupEditPlaceholder("probe", "Before", "After");
    assert.deepEqual(fixture.domEvents, []);
    assert.equal(fixture.settings.placeholder, "Before");
    assert.equal(fixture.callbacks[0].args.evidence.placeholderStored, false);
  }
});

test("placeholder save must work when a hidden WebView denies input focus", async () => {
  const fixture = loadProbe({ focusDenied: true });
  await fixture.window.__ATOOLS_SETTINGS_INPUT_HOTKEY_STARTUP__
    .hotkeyStartupEditPlaceholder("probe", "Before", "After");

  assert.deepEqual(fixture.domEvents, ["placeholder-click", "input", "change", "blur"]);
  assert.equal(fixture.settings.placeholder, "After");
  assert.equal(fixture.callbacks[0].args.evidence.placeholderStored, true);
});

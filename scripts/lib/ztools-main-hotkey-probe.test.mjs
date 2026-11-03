import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const probeUrl = new URL(
  "../../src-tauri/src/renderer_desktop_smoke/settings_input_journey/main-hotkey-probe.js",
  import.meta.url,
);
const probeSource = await readFile(probeUrl, "utf8");
const HOTKEY_A = "Command+Ctrl+Option+Shift+F10";
const HOTKEY_B = "Command+Ctrl+Option+Shift+F11";
const HOTKEY_REJECTION_TOAST = "快捷键设置失败: 快捷键设置失败，请尝试其他组合。";

function loadProbe({ initial = HOTKEY_B, resulting = initial, rawBehavior = { type: "reject" },
  toastBehavior = "none" } = {}) {
  const callbacks = [];
  const rawCalls = [];
  const events = [];
  const settings = { hotkey: initial };
  let clickCount = 0;
  let now = 0;
  let conflictKeyDispatched = false;
  let postDispatchToastChecks = 0;
  const input = {
    textContent: initial,
    click: () => { clickCount += 1; },
  };
  const row = {
    querySelector: selector => selector === ".setting-label > span"
      ? { textContent: "呼出快捷键" }
      : null,
    querySelectorAll: selector => selector === ".setting-control .hotkey-input" ? [input] : [],
  };
  const document = {
    hidden: true,
    hasFocus: () => false,
    querySelectorAll: selector => {
      if (selector === ".setting-item") return [row];
      if (selector === ".toast.toast-error") {
        if (conflictKeyDispatched) postDispatchToastChecks += 1;
        const visible = toastBehavior === "stale"
          || (toastBehavior === "delayed" && conflictKeyDispatched && postDispatchToastChecks >= 3);
        return visible ? [{ textContent: HOTKEY_REJECTION_TOAST }] : [];
      }
      return [];
    },
    dispatchEvent: event => {
      events.push({ type: event.type, code: event.code, metaKey: event.metaKey === true,
        ctrlKey: event.ctrlKey === true, altKey: event.altKey === true, shiftKey: event.shiftKey === true });
      if (event.type === "keyup" && ["F10", "F11", "F12"].includes(event.code)) {
        input.textContent = resulting;
        settings.hotkey = resulting;
        if (event.code === "F12") conflictKeyDispatched = true;
      }
      return true;
    },
  };
  class FixtureKeyboardEvent {
    constructor(type, options) { Object.assign(this, { type, ...options }); }
  }
  const window = {
    location: { hash: "#/generalSetting" },
    __ATOOLS_SETTINGS_INPUT_TOKEN__: "hotkey-probe-fixture-token",
    __TAURI_INTERNALS__: {
      invoke: async (command, args) => {
        if (command === "plugin:global-shortcut|unregister_all") {
          rawCalls.push({ command, args });
          if (rawBehavior.type === "resolve") return rawBehavior.value;
          throw rawBehavior.error ?? "Command plugin:global-shortcut|unregister_all not allowed by ACL";
        }
        callbacks.push({ command, args });
      },
    },
    ztools: { internal: { dbGet: async key => key === "settings-general" ? { ...settings } : null } },
  };

  vm.runInNewContext(probeSource, {
    window,
    document,
    KeyboardEvent: FixtureKeyboardEvent,
    Date: { now: () => { const current = now; now += 1000; return current; } },
    setTimeout: callback => { callback(); return 0; },
  });
  return { window, input, settings, events, callbacks, rawCalls,
    get clickCount() { return clickCount; }, get postDispatchToastChecks() { return postDispatchToastChecks; } };
}

test("F11 recording dispatches a DOM click and key events then reports current UI and store", async () => {
  const fixture = loadProbe({ initial: HOTKEY_A, resulting: HOTKEY_B });
  await fixture.window.__ATOOLS_SETTINGS_INPUT_MAIN_HOTKEY__.record("probe", "F11", HOTKEY_B, HOTKEY_B);

  assert.equal(fixture.clickCount, 1);
  assert.deepEqual(fixture.events.map(event => [event.type, event.code]), [
    ["keydown", "MetaLeft"], ["keydown", "ControlLeft"], ["keydown", "AltLeft"],
    ["keydown", "ShiftLeft"], ["keydown", "F11"], ["keyup", "F11"],
  ]);
  for (const event of fixture.events.slice(4)) {
    assert.deepEqual([event.metaKey, event.ctrlKey, event.altKey, event.shiftKey], [true, true, true, true]);
  }
  assert.equal(fixture.settings.hotkey, HOTKEY_B);
  const evidence = fixture.callbacks[0].args.evidence;
  assert.equal(fixture.callbacks[0].args.operation, "childMainHotkeyRecord");
  assert.equal(evidence.displayValue, HOTKEY_B);
  assert.equal(evidence.storedValue, HOTKEY_B);
  assert.equal(evidence.clickDispatched, true);
  assert.equal(evidence.keyDownDispatched, true);
  assert.equal(evidence.keyUpDispatched, true);
  assert.equal(evidence.documentHidden, true);
  assert.equal(evidence.documentHasFocus, false);
});

test("F10 records the fixed Command Ctrl Option Shift chord without system input", async () => {
  const fixture = loadProbe({ initial: HOTKEY_B, resulting: HOTKEY_A });
  await fixture.window.__ATOOLS_SETTINGS_INPUT_MAIN_HOTKEY__.record(
    "probe", "F10", HOTKEY_A, HOTKEY_A,
  );

  assert.equal(fixture.clickCount, 1);
  assert.deepEqual(fixture.events.map(event => event.code), [
    "MetaLeft", "ControlLeft", "AltLeft", "ShiftLeft", "F10", "F10",
  ]);
  const mainKeyDown = fixture.events[4];
  const mainKeyUp = fixture.events[5];
  for (const event of [mainKeyDown, mainKeyUp]) {
    assert.deepEqual([event.metaKey, event.ctrlKey, event.altKey, event.shiftKey], [true, true, true, true]);
  }
  assert.equal(fixture.callbacks[0].args.evidence.displayValue, HOTKEY_A);
});

test("F12 waits for the delayed exact Vue rejection toast even when B already matches", async () => {
  const fixture = loadProbe({ initial: HOTKEY_B, resulting: HOTKEY_B, toastBehavior: "delayed" });
  await fixture.window.__ATOOLS_SETTINGS_INPUT_MAIN_HOTKEY__.record("probe", "F12", HOTKEY_B, HOTKEY_B);

  assert.equal(fixture.clickCount, 1);
  assert.deepEqual(fixture.events.map(event => event.code), [
    "MetaLeft", "ControlLeft", "AltLeft", "ShiftLeft", "F12", "F12",
  ]);
  assert.equal(fixture.callbacks[0].args.evidence.displayValue, HOTKEY_B);
  assert.equal(fixture.callbacks[0].args.evidence.storedValue, HOTKEY_B);
  assert.equal(fixture.callbacks[0].args.evidence.rejectionObserved, true);
  assert.ok(fixture.postDispatchToastChecks >= 3);
});

test("F12 matching UI and DB values do not count when no Vue rejection toast occurs", async () => {
  const fixture = loadProbe({ initial: HOTKEY_B, resulting: HOTKEY_B });
  await fixture.window.__ATOOLS_SETTINGS_INPUT_MAIN_HOTKEY__.record("probe", "F12", HOTKEY_B, HOTKEY_B);

  assert.equal(fixture.callbacks[0].args.evidence.displayValue, HOTKEY_B);
  assert.equal(fixture.callbacks[0].args.evidence.storedValue, HOTKEY_B);
  assert.equal(fixture.callbacks[0].args.evidence.rejectionObserved, false);
});

test("F12 refuses to dispatch while the exact rejection toast is stale", async () => {
  const fixture = loadProbe({ initial: HOTKEY_B, resulting: HOTKEY_B, toastBehavior: "stale" });
  await fixture.window.__ATOOLS_SETTINGS_INPUT_MAIN_HOTKEY__.record("probe", "F12", HOTKEY_B, HOTKEY_B);

  assert.equal(fixture.clickCount, 0);
  assert.deepEqual(fixture.events, []);
  assert.equal(fixture.callbacks[0].args.evidence.rejectionObserved, false);
});

test("recording rejects unsupported code types and values without clicking or dispatching", async () => {
  for (const invalid of ["F13", 11, true, null]) {
    const fixture = loadProbe({ initial: HOTKEY_B });
    await fixture.window.__ATOOLS_SETTINGS_INPUT_MAIN_HOTKEY__.record("probe", invalid, HOTKEY_B, HOTKEY_B);
    assert.equal(fixture.clickCount, 0);
    assert.deepEqual(fixture.events, []);
    assert.equal(fixture.callbacks[0].args.evidence.clickDispatched, false);
    assert.equal(fixture.callbacks[0].args.evidence.keyDownDispatched, false);
    assert.equal(fixture.callbacks[0].args.evidence.keyUpDispatched, false);
  }
});

test("recording rejects unapproved expected hotkey values", async () => {
  const fixture = loadProbe({ initial: HOTKEY_B });
  await fixture.window.__ATOOLS_SETTINGS_INPUT_MAIN_HOTKEY__.record("probe", "F12", "Other", HOTKEY_B);
  assert.equal(fixture.clickCount, 0);
  assert.deepEqual(fixture.events, []);
});

test("raw main and child probes classify only the pinned release or debug ACL denial", async () => {
  const debugDenial = "global-shortcut.unregister_all not allowed on origin [local]. Please create a capability that has this origin on the context field.\n\nFound matches for: \n\nPermissions associated with this command: global-shortcut:allow-unregister-all";
  for (const [operation, error] of [
    ["mainRawHotkeyMutation", "Command plugin:global-shortcut|unregister_all not allowed by ACL"],
    ["childRawHotkeyMutation", new Error(debugDenial)],
    ["mainRawHotkeyMutation", "global-shortcut.unregister_all not allowed. Permissions associated with this command: global-shortcut:allow-unregister-all"],
  ]) {
    const fixture = loadProbe({ rawBehavior: { type: "reject", error } });
    await fixture.window.__ATOOLS_SETTINGS_INPUT_MAIN_HOTKEY__.mainHotkeyRawMutation(31, operation);
    assert.equal(fixture.rawCalls.length, 1);
    assert.equal(fixture.rawCalls[0].command, "plugin:global-shortcut|unregister_all");
    assert.deepEqual({ ...fixture.rawCalls[0].args }, {});
    assert.equal(fixture.callbacks[0].args.operation, operation);
    assert.deepEqual({ ...fixture.callbacks[0].args.evidence }, { aclDenied: true });
  }
});

test("unknown plugin, unrelated errors, and allowed raw invocation never count as ACL denial", async () => {
  for (const rawBehavior of [
    { type: "reject", error: "Command plugin:global-shortcut|unregister_all not found" },
    { type: "reject", error: new Error("permission denied") },
    { type: "resolve" },
  ]) {
    const fixture = loadProbe({ rawBehavior });
    await fixture.window.__ATOOLS_SETTINGS_INPUT_MAIN_HOTKEY__.mainHotkeyRawMutation(32, "mainRawHotkeyMutation");
    assert.equal(fixture.rawCalls.length, 1);
    assert.equal(fixture.callbacks[0].args.evidence.aclDenied, false);
  }
});

test("unrecognized raw probe operations do not call the plugin command", async () => {
  const fixture = loadProbe();
  await fixture.window.__ATOOLS_SETTINGS_INPUT_MAIN_HOTKEY__.mainHotkeyRawMutation(33, "unknownOperation");
  assert.deepEqual(fixture.rawCalls, []);
  assert.equal(fixture.callbacks[0].args.evidence.aclDenied, false);
});

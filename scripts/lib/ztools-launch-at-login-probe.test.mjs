import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL(
  "../../src-tauri/src/renderer_desktop_smoke/settings_input_journey/launch-at-login-probe.js",
  import.meta.url,
), "utf8");

function fixture({ nativeEnabled = false, confirmed = nativeEnabled, route = "#/generalSetting",
  controlDelayMs = 0 } = {}) {
  const replies = [];
  const errors = [];
  let setterCalls = 0;
  let getterCalls = 0;
  let controlsMounted = controlDelayMs === 0;
  if (!controlsMounted) setTimeout(() => { controlsMounted = true; }, controlDelayMs);
  const model = { nativeEnabled, confirmed };
  let input;
  const row = {
    querySelector(selector) {
      return selector === ".setting-label > span" ? { textContent: "开机自动启动" } : null;
    },
    querySelectorAll(selector) {
      return selector === '.setting-control .toggle input[type="checkbox"]' ? [input] : [];
    },
  };
  class FakeInput {
    constructor() { this.checked = model.confirmed; }
    click() {
      this.checked = !this.checked;
      Promise.resolve(this.onChange?.()).catch(() => {});
    }
  }
  input = new FakeInput();
  const location = { hash: route };
  const menu = {
    querySelector(selector) { return selector === ".menu-label" ? { textContent: "通用设置" } : null; },
    click() { location.hash = "#/generalSetting"; },
  };
  const contextConsole = { error: (...args) => errors.push(args) };
  const window = {
    location,
    __ATOOLS_SETTINGS_INPUT_TOKEN__: "fixture-token",
    __TAURI_INTERNALS__: { invoke: async (_command, payload) => replies.push(payload) },
    ztools: { internal: {
      getLaunchAtLogin: async () => { getterCalls += 1; return model.confirmed; },
      setLaunchAtLogin: async value => {
        setterCalls += 1;
        if (model.confirmed !== model.nativeEnabled) {
          const error = new Error("fixed fixture rejection");
          error.code = "SETTINGS_LAUNCH_AT_LOGIN_CONFLICT";
          throw error;
        }
        model.nativeEnabled = value;
        model.confirmed = value;
      },
    } },
  };
  const document = {
    querySelectorAll(selector) {
      if (selector === ".setting-item") return controlsMounted ? [row] : [];
      if (selector === ".settings-sidebar .menu-list .menu-item") return [menu];
      return [];
    },
  };
  const context = { window, document, console: contextConsole, Date, Promise, Object, Array, setTimeout, clearTimeout };
  runInNewContext(source, context);
  runInNewContext(`window.__runOriginalHandler = async input => {
    try { await window.ztools.internal.setLaunchAtLogin(input.checked); }
    catch (error) { console.error("更新开机启动设置失败:", error); input.checked = !input.checked; }
  };`, context);
  input.onChange = () => window.__runOriginalHandler(input);
  return {
    window, input, model, replies, errors,
    get setterCalls() { return setterCalls; },
    get getterCalls() { return getterCalls; },
    probe: window.__ATOOLS_SETTINGS_INPUT_LAUNCH_AT_LOGIN__,
  };
}

const plain = value => JSON.parse(JSON.stringify(value));

test("probe exports only the two whitelisted original-control operations", () => {
  const value = fixture();
  assert.deepEqual(Object.keys(value.probe).sort(), ["launchAtLoginClick", "launchAtLoginInspect"]);
});

test("inspect reads the original checkbox and public getter without mutation", async () => {
  const value = fixture({ nativeEnabled: false });
  await value.probe.launchAtLoginInspect(1);
  assert.deepEqual(plain(value.replies[0].evidence), {
    routeGeneral: true, controlUnique: true, uiEnabled: false, getterEnabled: false,
  });
  assert.equal(value.setterCalls, 0);
});

test("inspect waits for a delayed checkbox mount on an already-ready General route", async () => {
  const value = fixture({ nativeEnabled: false, controlDelayMs: 60 });
  await value.probe.launchAtLoginInspect(5);
  assert.equal(value.replies[0].evidence.routeGeneral, true);
  assert.equal(value.replies[0].evidence.controlUnique, true);
  assert.equal(value.replies[0].evidence.uiEnabled, false);
  assert.equal(value.replies[0].evidence.getterEnabled, false);
  assert.equal(value.getterCalls, 1);
});

test("inspect samples the checkbox after it converges to the single getter read", async () => {
  const value = fixture({ nativeEnabled: false });
  value.input.checked = true;
  setTimeout(() => { value.input.checked = false; }, 60);
  await value.probe.launchAtLoginInspect(6);
  assert.equal(value.replies[0].evidence.getterEnabled, false);
  assert.equal(value.replies[0].evidence.uiEnabled, false);
  assert.equal(value.getterCalls, 1);
});

test("original checkbox click enables the service and records public readback", async () => {
  const value = fixture();
  await value.probe.launchAtLoginClick(2, "enable");
  assert.equal(value.replies[0].operation, "childLaunchAtLoginClick");
  assert.deepEqual(plain(value.replies[0].evidence), {
    routeGeneral: true, controlUnique: true, clickDispatched: true,
    uiEnabled: true, getterEnabled: true, errorCode: null,
  });
  assert.equal(value.model.nativeEnabled, true);
  assert.equal(value.setterCalls, 1);
});

test("external state conflict is observed through checkbox rollback and fixed error code", async () => {
  const value = fixture({ nativeEnabled: false, confirmed: true });
  await value.probe.launchAtLoginClick(3, "conflict");
  assert.equal(value.replies[0].evidence.clickDispatched, true);
  assert.equal(value.replies[0].evidence.uiEnabled, true);
  assert.equal(value.replies[0].evidence.errorCode, "conflict");
  assert.equal(value.model.nativeEnabled, false);
  assert.equal(value.setterCalls, 1);
  assert.equal(value.errors.length, 1);
  assert.equal(value.errors[0][1].code, "SETTINGS_LAUNCH_AT_LOGIN_CONFLICT");
});

test("probe navigates General by its original sidebar control and rejects a duplicate checkbox", async () => {
  const value = fixture({ route: "#/shortcuts" });
  await value.probe.launchAtLoginInspect(4);
  assert.equal(value.replies[0].evidence.routeGeneral, true);
  assert.equal(value.replies[0].evidence.controlUnique, true);
  assert.equal(value.setterCalls, 0);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const probeSource = await readFile(new URL("../../src-tauri/src/renderer_desktop_smoke/settings_input_journey/general-policies-probe.js", import.meta.url), "utf8");
const nativeSource = await readFile(new URL("../../src-tauri/src/renderer_desktop_smoke/settings_input_journey/general_policies_probe.rs", import.meta.url), "utf8");
const nativeMethods = [...nativeSource.matchAll(/"childGeneralPolicies\w+",\s*"(generalPolicies\w+)"/g)].map(match => match[1]);
const nativeMainMethods = [...nativeSource.matchAll(/"mainGeneralPolicies\w+",\s*"(generalPolicies\w+)"/g)].map(match => match[1]);

class FakeEvent {
  constructor(type) { this.type = type; }
}

class FakeHTMLInputElement {
  constructor(model) {
    this.model = model;
    this.pending = String(model.uiDays);
    this.events = [];
  }
  get value() { return this.pending; }
  set value(value) { this.pending = String(value); }
  dispatchEvent(event) {
    this.events.push(event.type);
    if (event.type === "blur") {
      this.model.uiDays = Number(this.pending);
      this.model.stored.clipboardRetentionDays = this.model.uiDays;
    }
    return true;
  }
}

class FakeDropdownItem {
  constructor(label, model) { this.label = label; this.model = model; }
  querySelector(selector) { return selector === ".dropdown-item-label" ? { textContent: this.label } : null; }
  click() {
    const strategy = Object.entries(this.model.labels).find(([, label]) => label === this.label)?.[0];
    if (strategy) {
      this.model.strategy = strategy;
      this.model.stored.windowPositionStrategy = strategy;
      this.model.open = false;
    }
  }
}

function makeHarness() {
  const model = {
    strategy: "remember",
    uiDays: 180,
    stored: { windowPositionStrategy: "remember", clipboardRetentionDays: 180 },
    open: false,
    labels: {
      remember: "记住上次位置", cursor: "鼠标屏居中",
      primary: "主屏居中", lastActive: "上次活动屏居中",
    },
    input: null,
  };
  model.input = new FakeHTMLInputElement(model);
  const trigger = {
    click() { model.open = !model.open; },
    querySelector(selector) {
      return selector === ".dropdown-value" ? { textContent: model.labels[model.strategy] } : null;
    },
    closest(selector) {
      if (selector !== ".dropdown") return null;
      return {
        querySelectorAll(query) {
          return query === ".dropdown-menu .dropdown-item" && model.open
            ? Object.values(model.labels).map(label => new FakeDropdownItem(label, model)) : [];
        },
      };
    },
  };
  const strategyRow = makeRow("窗口呼出位置", {
    querySelector(selector) {
      if (selector === ".setting-control .dropdown-trigger") return trigger;
      if (selector === ".dropdown-trigger") return trigger;
      return null;
    },
    querySelectorAll(selector) { return selector === ".setting-control .dropdown-trigger" ? [trigger] : []; },
  });
  const resetButton = {
    click() {
      model.uiDays = 180;
      model.stored.clipboardRetentionDays = 180;
      model.input.value = "180";
    },
  };
  const retentionRow = makeRow("剪贴板历史保存天数", {
    querySelector(selector) { return selector === '.setting-control input[type="number"]' ? model.input : null; },
    querySelectorAll(selector) {
      if (selector === '.setting-control input[type="number"]') return [model.input];
      if (selector === '.setting-control button[title="重置"]') return model.uiDays === 180 ? [] : [resetButton];
      return [];
    },
  });
  const reports = [];
  const document = {
    hidden: true,
    hasFocus: () => false,
    querySelectorAll(selector) { return selector === ".setting-item" ? [strategyRow, retentionRow] : []; },
  };
  const window = {
    __ATOOLS_SETTINGS_INPUT_TOKEN__: "fixture-token",
    location: { hash: "#/generalSetting" },
    ztools: { internal: { dbGet: async key => key === "settings-general" ? structuredClone(model.stored) : null } },
    __TAURI_INTERNALS__: { invoke: async (_command, payload) => { reports.push(payload); } },
  };
  runInNewContext(probeSource, {
    window, document, Event: FakeEvent, HTMLInputElement: FakeHTMLInputElement,
    setTimeout, clearTimeout, Date, Object, Array, Number, String, Promise,
  });
  return { model, reports, probe: window.__ATOOLS_SETTINGS_INPUT_GENERAL_POLICIES__ };
}

function makeRow(label, control) {
  return {
    querySelector(selector) {
      if (selector === ".setting-label > span") return { textContent: label };
      return control.querySelector(selector);
    },
    querySelectorAll(selector) { return control.querySelectorAll(selector); },
  };
}

test("original General controls drive window strategy and clipboard retention evidence", async () => {
  const { model, reports, probe } = makeHarness();
  assert.deepEqual(nativeMethods, [
    "generalPoliciesInspect", "generalPoliciesSelectStrategy",
    "generalPoliciesSetRetention", "generalPoliciesResetRetention",
    "generalPoliciesAutoBackInspect", "generalPoliciesAutoBackSelect",
  ]);
  assert.deepEqual(nativeMainMethods, ["generalPoliciesAutoBackMainInspect"]);
  assert.deepEqual(Object.keys(probe).sort(), [...nativeMethods, ...nativeMainMethods].sort());
  await probe[nativeMethods[0]](1);
  await probe[nativeMethods[1]](2, "cursor");
  await probe[nativeMethods[2]](3, 30);
  await probe[nativeMethods[3]](4);

  assert.deepEqual(reports.map(report => report.operation), [
    "childGeneralPoliciesInspect", "childGeneralPoliciesSelectStrategy",
    "childGeneralPoliciesSetRetention", "childGeneralPoliciesResetRetention",
  ]);
  assert.equal(reports[0].evidence.storedStrategy, "remember");
  assert.equal(reports[0].evidence.storedDays, 180);
  assert.equal(reports[1].evidence.selectionDispatched, true);
  assert.equal(reports[1].evidence.uiStrategy, "cursor");
  assert.equal(reports[1].evidence.storedStrategy, "cursor");
  assert.equal(reports[2].evidence.inputDispatched, true);
  assert.equal(reports[2].evidence.changeDispatched, true);
  assert.equal(reports[2].evidence.blurDispatched, true);
  assert.deepEqual(model.input.events, ["input", "change", "blur"]);
  assert.equal(reports[2].evidence.uiDays, 30);
  assert.equal(reports[2].evidence.storedDays, 30);
  assert.equal(reports[2].evidence.resetButtonUnique, true);
  assert.equal(reports[3].evidence.resetDispatched, true);
  assert.equal(reports[3].evidence.resetButtonUnique, false);
  assert.equal(reports[3].evidence.uiDays, 180);
  assert.equal(reports[3].evidence.storedDays, 180);
});

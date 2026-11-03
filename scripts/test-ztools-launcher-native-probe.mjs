import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const probeSource = await readFile(
  new URL("../src-tauri/src/renderer_desktop_smoke/launcher_journey/probe.js", import.meta.url),
  "utf8",
);

function createProbe(snapshot, options = {}) {
  const receipts = [];
  const events = [];
  let titles = [...(options.initialTitles ?? ["AToolsOwnedProbeFirst", "AToolsOwnedProbeSecond"])];
  let selectedTitle = Object.hasOwn(options, "initialSelected")
    ? options.initialSelected
    : (titles[0] ?? null);
  let activeElement = null;
  let input;
  let onLaunch = () => {};
  const commandDataStore = { history: [] };
  const stores = new Map([
    ["window", { spaceOpenCommand: false }],
    ["commandData", commandDataStore],
  ]);
  const appRoot = {
    __vue_app__: { config: { globalProperties: { $pinia: { _s: stores } } } },
  };
  const state = {
    getTitles: () => [...titles],
    getSelectedTitle: () => selectedTitle,
    setTitles(next) { titles = [...next]; },
    setSelectedTitle(next) { selectedTitle = next; },
    setInputValue(value) { input.value = value; },
    setHistory(next) { commandDataStore.history = next; },
  };

  class FixtureInput {
    constructor(value) {
      this._value = value;
      this.selectionStart = 0;
      this.selectionEnd = 0;
    }

    get value() { return this._value; }
    set value(value) { this._value = String(value); }
    focus() { activeElement = this; }

    dispatchEvent(event) {
      if (event.type === "input") {
        options.onInput?.(state);
        events.push({
          type: "input",
          value: this.value,
          titles: [...titles],
          selectedTitle,
        });
        return true;
      }
      if (event.type !== "keydown") return true;

      const selectedBefore = selectedTitle;
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && titles.length > 0) {
        const currentIndex = titles.indexOf(selectedTitle);
        if (currentIndex >= 0) {
          const delta = event.key === "ArrowDown" ? 1 : -1;
          selectedTitle = titles[(currentIndex + delta + titles.length) % titles.length];
        }
      } else if (event.key === "Enter" || event.key === " ") {
        onLaunch(event.key, state);
      }
      event.preventDefault();
      events.push({
        type: "keydown",
        key: event.key,
        selectedBefore,
        selectedAfter: selectedTitle,
      });
      return true;
    }
  }

  input = new FixtureInput(options.initialValue ?? "");
  const itemNodes = () => titles.map((title) => ({
    title,
    querySelector(selector) {
      return selector === ".item-title" ? { textContent: title } : null;
    },
  }));
  const document = {
    get activeElement() { return activeElement; },
    querySelector(selector) {
      if (selector === "input.search-input") return input;
      if (selector === "#app") return appRoot;
      return null;
    },
    querySelectorAll(selector) {
      const items = itemNodes();
      if (selector === ".list-mode-results .list-item.selected") {
        return items.filter((item) => item.title === selectedTitle);
      }
      if (selector === ".list-mode-results .list-item .item-title") {
        return items.map((item) => ({ textContent: item.title }));
      }
      if (selector === ".list-mode-results .list-item") return items;
      return [];
    },
  };

  class FixtureInputEvent {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  }

  class FixtureKeyboardEvent {
    constructor(type, init) {
      this.type = type;
      Object.assign(this, init);
      this.defaultPrevented = false;
    }

    preventDefault() { this.defaultPrevented = true; }
  }

  const window = {
    __TAURI__: {
      core: {
        async invoke(command, args) {
          assert.equal(command, "renderer_launcher_receipt");
          receipts.push(args.receipt);
        },
      },
    },
  };
  if (snapshot) window.__ATOOLS_ZTOOLS_HOST_ADAPTER__ = { snapshot };

  runInNewContext(probeSource, {
    window,
    document,
    HTMLInputElement: FixtureInput,
    InputEvent: FixtureInputEvent,
    KeyboardEvent: FixtureKeyboardEvent,
    setTimeout,
  });

  return {
    receipts,
    events,
    run: (operation, nonce, args) => window.__ATOOLS_RENDERER_LAUNCHER_PROBE__.run(operation, nonce, args),
    setOnLaunch(callback) { onLaunch = callback; },
  };
}

test("a present native-call map with no launch key reports zero launches", async () => {
  const probe = createProbe(() => ({ nativeCalls: {} }));
  await probe.run("space-disabled", "fixture-nonce");
  assert.equal(probe.receipts.length, 1);
  assert.equal(probe.receipts[0].evidence.launchCallDelta, 0);
});

test("an absent adapter snapshot stays unavailable and fails closed", async () => {
  const probe = createProbe(null);
  await probe.run("space-disabled", "fixture-nonce");
  assert.equal(probe.receipts.length, 1);
  assert.equal(probe.receipts[0].evidence.launchCallDelta, null);
});

test("an invalid present counter stays unavailable and fails closed", async () => {
  const probe = createProbe(() => ({ nativeCalls: { launch_renderer_app: "0" } }));
  await probe.run("space-disabled", "fixture-nonce");
  assert.equal(probe.receipts.length, 1);
  assert.equal(probe.receipts[0].evidence.launchCallDelta, null);
});

test("an unavailable launch counter never claims the expected one-call delta", async () => {
  const probe = createProbe(null);
  await probe.run("launch-denied", "fixture-nonce", {
    key: "Enter",
    targetName: "AToolsOwnedProbeSecond",
  });
  assert.equal(probe.receipts.length, 1);
  assert.equal(probe.receipts[0].evidence.launchCallDelta, null);
  assert.notEqual(probe.receipts[0].evidence.launchCallDelta, 1);
});

test("launch delta starts from zero when a partial map gains its launch counter", async () => {
  let launchCount = 0;
  const probe = createProbe(() => ({
    nativeCalls: launchCount === 0 ? {} : { launch_renderer_app: launchCount },
    outstandingNativeCalls: 0,
  }));
  probe.setOnLaunch(() => { launchCount += 1; });
  await probe.run("launch-succeeded", "fixture-nonce", {
    key: "Enter",
    targetName: "AToolsOwnedProbeSecond",
  });
  assert.equal(probe.receipts.length, 1);
  assert.equal(probe.receipts[0].evidence.launchSettled, true);
  assert.equal(probe.receipts[0].evidence.launchCallDelta, 1);
});

test("retry restores the query and reselects the same second target after list reordering", async () => {
  let launchCount = 0;
  let acceptedEvents = 0;
  const targetPath = "/owned/AToolsOwnedProbeSecond.app";
  const targetName = "AToolsOwnedProbeSecond";
  const probe = createProbe(() => ({
    nativeCalls: { launch_renderer_app: launchCount },
    outstandingNativeCalls: 0,
    appState: { acceptedEvents, acceptedReplies: 0 },
  }), {
    onInput(state) {
      if (launchCount === 0) {
        state.setTitles(["AToolsOwnedProbeFirst", "AToolsOwnedProbeSecond"]);
        state.setSelectedTitle("AToolsOwnedProbeFirst");
      } else {
        state.setTitles(["AToolsOwnedProbeSecond", "AToolsOwnedProbeFirst"]);
        state.setSelectedTitle("AToolsOwnedProbeFirst");
      }
    },
  });
  probe.setOnLaunch((_key, state) => {
    launchCount += 1;
    if (launchCount === 1) {
      state.setInputValue("");
      state.setSelectedTitle("AToolsOwnedProbeFirst");
    } else {
      acceptedEvents += 1;
      state.setHistory([{ path: targetPath, name: targetName, useCount: 1 }]);
    }
  });

  await probe.run("search", "search-nonce");
  await probe.run("launch-denied", "denied-nonce", { key: "Enter", targetPath, targetName });
  await probe.run("launch-succeeded", "success-nonce", { key: "Enter", targetPath, targetName });

  const search = probe.receipts.find((receipt) => receipt.operation === "search");
  const denied = probe.receipts.find((receipt) => receipt.operation === "launch-denied");
  const succeeded = probe.receipts.find((receipt) => receipt.operation === "launch-succeeded");
  assert.deepEqual(
    [search.evidence.selectedBefore, search.evidence.selectedAfter, search.evidence.selectionChanged],
    ["first", "second", true],
  );
  assert.equal(denied.evidence.selectedProbe, "second");
  assert.equal(denied.evidence.launchCallDelta, 1);
  assert.equal(succeeded.evidence.selectedProbe, "second");
  assert.equal(succeeded.evidence.launchCallDelta, 1);
  assert.equal(succeeded.evidence.mainHistoryApplied, true);
  assert.equal(succeeded.evidence.appStateAcceptedDelta, 1);

  const keyEvents = probe.events.filter((event) => event.type === "keydown");
  assert.deepEqual(keyEvents.map((event) => event.key), ["ArrowDown", "Enter", "ArrowUp", "Enter"]);
  assert.deepEqual(
    keyEvents.filter((event) => event.key === "Enter").map((event) => event.selectedBefore),
    ["AToolsOwnedProbeSecond", "AToolsOwnedProbeSecond"],
  );
  assert.equal(keyEvents[1].selectedAfter, "AToolsOwnedProbeFirst");
  const inputEvents = probe.events.filter((event) => event.type === "input");
  assert.equal(inputEvents.length, 2);
  assert.deepEqual(inputEvents[1].titles, ["AToolsOwnedProbeSecond", "AToolsOwnedProbeFirst"]);
  assert.equal(inputEvents[1].selectedTitle, "AToolsOwnedProbeFirst");
});

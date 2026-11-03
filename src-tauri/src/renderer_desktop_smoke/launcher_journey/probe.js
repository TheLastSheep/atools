(function installOwnedLauncherProbe(token) {
  "use strict";

  const TOKEN = token;
  const QUERY = "AToolsOwnedProbe";
  const TITLE_TO_PROBE = Object.freeze({
    AToolsOwnedProbeFirst: "first",
    AToolsOwnedProbeSecond: "second",
  });

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const inputElement = () => document.querySelector("input.search-input");
  const nativeInvoke = () => {
    const invoke = window.__TAURI__?.core?.invoke;
    return typeof invoke === "function" ? invoke.bind(window.__TAURI__.core) : null;
  };
  const adapterSnapshot = () => {
    try {
      return window.__ATOOLS_ZTOOLS_HOST_ADAPTER__?.snapshot?.() ?? null;
    } catch (_) {
      return null;
    }
  };
  const launchCalls = () => {
    try {
      const snapshot = adapterSnapshot();
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
      const nativeCalls = snapshot.nativeCalls;
      if (!nativeCalls || typeof nativeCalls !== "object" || Array.isArray(nativeCalls)) return null;
      if (!Object.hasOwn(nativeCalls, "launch_renderer_app")) return 0;
      const count = nativeCalls.launch_renderer_app;
      return Number.isSafeInteger(count) && count >= 0 ? count : null;
    } catch (_) {
      return null;
    }
  };
  const acceptedCount = () => {
    const appState = adapterSnapshot()?.appState;
    const events = appState?.acceptedEvents;
    const replies = appState?.acceptedReplies;
    return Number.isSafeInteger(events) && events >= 0 && Number.isSafeInteger(replies) && replies >= 0
      ? events + replies
      : null;
  };
  const selectedTitle = () => {
    const selected = document.querySelectorAll(".list-mode-results .list-item.selected");
    if (selected.length !== 1) return null;
    const title = selected[0].querySelector(".item-title")?.textContent?.trim();
    return Object.hasOwn(TITLE_TO_PROBE, title) ? title : null;
  };
  const selectedProbe = () => {
    const title = selectedTitle();
    return title === null ? null : TITLE_TO_PROBE[title];
  };
  const listTitles = () => Array.from(
    document.querySelectorAll(".list-mode-results .list-item .item-title"),
    (element) => element.textContent?.trim() ?? "",
  );
  const hasProbeResults = (titles) => titles.length === 2 &&
    titles.every((title) => Object.hasOwn(TITLE_TO_PROBE, title)) && new Set(titles).size === 2;
  function piniaStore(id) {
    try {
      const app = document.querySelector("#app")?.__vue_app__;
      const pinia = app?.config?.globalProperties?.$pinia;
      const stores = pinia?._s;
      if (!app || !pinia || !stores || typeof stores.get !== "function") return null;
      return stores.get(id) ?? null;
    } catch (_) {
      return null;
    }
  }

  const spaceOpenCommand = () => {
    const value = piniaStore("window")?.spaceOpenCommand;
    return typeof value === "boolean" ? value : null;
  };
  let savedInputState = null;
  let searchAttempted = false;

  async function waitUntil(predicate, timeout = 4000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      let result = false;
      try { result = predicate() === true; } catch (_) { result = false; }
      if (result) return true;
      await delay(25);
    }
    return false;
  }

  function setSearchInput() {
    const input = inputElement();
    if (!input) return false;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (typeof descriptor?.set !== "function") return false;
    descriptor.set.call(input, QUERY);
    const event = new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: QUERY,
    });
    input.dispatchEvent(event);
    input.focus();
    return input.value === QUERY;
  }

  function captureInputState() {
    const input = inputElement();
    if (!input) return false;
    const value = String(input.value);
    const selectionStart = input.selectionStart;
    const selectionEnd = input.selectionEnd;
    if (value.length > 64 || !Number.isInteger(selectionStart) || !Number.isInteger(selectionEnd) ||
        selectionStart < 0 || selectionEnd < selectionStart || selectionEnd > value.length) return false;
    savedInputState = {
      value,
      selectionStart,
      selectionEnd,
      focused: document.activeElement === input,
    };
    return true;
  }

  async function restoreInputState() {
    if (!searchAttempted) return true;
    const saved = savedInputState;
    let input = inputElement();
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (!saved || !input || typeof descriptor?.set !== "function" || typeof InputEvent !== "function") {
      return false;
    }
    descriptor.set.call(input, saved.value);
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertReplacementText",
      data: saved.value,
    }));
    await Promise.resolve();
    const inputApplied = await waitUntil(() => {
      const current = inputElement();
      return current?.value === saved.value && adapterSnapshot()?.outstandingNativeCalls === 0;
    }, 3000);
    if (!inputApplied) return false;
    input = inputElement();
    if (!input) return false;
    if (saved.focused) input.focus();
    else if (document.activeElement === input) input.blur();
    try {
      input.setSelectionRange(saved.selectionStart, saved.selectionEnd);
    } catch (_) {
      return false;
    }

    let previousLayout = null;
    let stableLayoutSamples = 0;
    const layoutSettled = await waitUntil(() => {
      const layout = `${document.querySelectorAll(".list-mode-results .list-item").length}:` +
        `${document.querySelectorAll(".list-mode-results .list-item.selected").length}`;
      stableLayoutSamples = layout === previousLayout ? stableLayoutSamples + 1 : 0;
      previousLayout = layout;
      return stableLayoutSamples >= 3 && adapterSnapshot()?.outstandingNativeCalls === 0;
    }, 3000);
    await delay(30);
    const restored = inputElement();
    const verified = layoutSettled && restored?.value === saved.value &&
      restored.selectionStart === saved.selectionStart && restored.selectionEnd === saved.selectionEnd &&
      (document.activeElement === restored) === saved.focused &&
      adapterSnapshot()?.outstandingNativeCalls === 0;
    if (verified) {
      savedInputState = null;
      searchAttempted = false;
    }
    return verified;
  }

  function dispatchKey(key) {
    const input = inputElement();
    if (!input || document.activeElement !== input) return null;
    const event = new KeyboardEvent("keydown", {
      key: key === "Space" ? " " : key,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    input.dispatchEvent(event);
    return event.defaultPrevented;
  }

  async function prepareTarget(targetName) {
    if (TITLE_TO_PROBE[targetName] !== "second") return false;
    let input = inputElement();
    if (!input) return false;
    if (input.value !== QUERY) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      if (typeof descriptor?.set !== "function" || typeof InputEvent !== "function") return false;
      descriptor.set.call(input, QUERY);
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: QUERY,
      }));
    }
    input.focus();
    if (input.value !== QUERY || document.activeElement !== input) return false;

    const resultsReady = await waitUntil(() => {
      const titles = listTitles();
      return inputElement()?.value === QUERY && hasProbeResults(titles) && selectedTitle() !== null;
    }, 4000);
    if (!resultsReady) return false;

    for (let step = 0; step < 2; step += 1) {
      const titles = listTitles();
      const current = selectedTitle();
      if (current === targetName) return true;
      const currentIndex = titles.indexOf(current);
      const targetIndex = titles.indexOf(targetName);
      if (!hasProbeResults(titles) || currentIndex < 0 || targetIndex < 0) return false;

      const key = targetIndex > currentIndex ? "ArrowDown" : "ArrowUp";
      if (dispatchKey(key) !== true) return false;
      const selectionMoved = await waitUntil(() => {
        const nextTitles = listTitles();
        const nextSelected = selectedTitle();
        return inputElement()?.value === QUERY && hasProbeResults(nextTitles) &&
          nextSelected !== null && nextSelected !== current;
      }, 1500);
      if (!selectionMoved) return false;
    }
    return selectedTitle() === targetName;
  }

  function historyApplied(targetPath, targetName) {
    const history = piniaStore("commandData")?.history;
    return Array.isArray(history) && history.some((entry) =>
      entry?.path === targetPath && entry?.name === targetName && entry?.useCount === 1,
    );
  }

  async function send(operation, nonce, evidence) {
    const invoke = nativeInvoke();
    if (!invoke) return false;
    try {
      await invoke("renderer_launcher_receipt", {
        receipt: {
          schemaVersion: 1,
          token: TOKEN,
          operation,
          nonce,
          caller: "main",
          evidence,
        },
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  async function search(nonce) {
    searchAttempted = true;
    const domInput = captureInputState() && setSearchInput();
    const resultReady = await waitUntil(() => {
      const titles = listTitles();
      return titles.length === 2 && titles[0] === "AToolsOwnedProbeFirst" &&
        titles[1] === "AToolsOwnedProbeSecond" && selectedProbe() === "first";
    });
    const selectedBefore = selectedProbe();
    const arrowPrevented = dispatchKey("ArrowDown");
    await Promise.resolve();
    await delay(0);
    const selectedAfter = selectedProbe();
    const titles = listTitles();
    const evidence = {
      domInput: domInput && inputElement()?.value === QUERY && resultReady,
      spaceEnabled: spaceOpenCommand(),
      resultCount: titles.length,
      selectedBefore,
      selectedAfter,
      selectionChanged: arrowPrevented === true && selectedBefore !== selectedAfter,
      selectedIdentityMatched: titles.length === 2 &&
        titles[0] === "AToolsOwnedProbeFirst" && titles[1] === "AToolsOwnedProbeSecond" &&
        selectedBefore === "first" && selectedAfter === "second",
    };
    return send("search", nonce, evidence);
  }

  async function spaceDisabled(nonce) {
    const selectedBefore = selectedProbe();
    const callsBefore = launchCalls();
    const defaultPrevented = dispatchKey("Space");
    await delay(75);
    const callsAfter = launchCalls();
    const evidence = {
      sent: defaultPrevented !== null,
      defaultPrevented,
      launchCallDelta: callsBefore === null || callsAfter === null ? null : callsAfter - callsBefore,
      selectionUnchanged: selectedBefore !== null && selectedProbe() === selectedBefore,
    };
    return send("space-disabled", nonce, evidence);
  }

  async function unlisted(nonce, unlistedPath) {
    const invoke = nativeInvoke();
    let rejected = false;
    let errorCode = "OTHER";
    if (invoke) {
      try {
        await invoke("launch_renderer_app", {
          target: { path: unlistedPath, name: "AToolsOwnedProbeUnlisted" },
        });
      } catch (error) {
        const message = String(error);
        rejected = true;
        if (message.includes("Application is not in the native launcher catalog")) {
          errorCode = "CATALOG_REJECTED";
        }
      }
    }
    return send("unlisted", nonce, { rejected, errorCode });
  }

  async function waitForLaunch(callsBefore) {
    return waitUntil(() => {
      const calls = launchCalls();
      const outstanding = adapterSnapshot()?.outstandingNativeCalls;
      return calls === callsBefore + 1 && outstanding === 0;
    }, 5000);
  }

  async function launch(operation, nonce, args) {
    const expectedKey = args.key === "Space" ? "Space" : "Enter";
    const targetReady = await prepareTarget(args.targetName);
    const selected = targetReady && selectedTitle() === args.targetName ? selectedProbe() : null;
    const callsBefore = launchCalls();
    const acceptedBefore = acceptedCount();
    const defaultPrevented = selected === "second" ? dispatchKey(expectedKey) : null;
    const launchSettled = selected === "second" && callsBefore !== null && await waitForLaunch(callsBefore);
    const callsAfter = launchCalls();
    const acceptedAfter = acceptedCount();
    const acceptedDelta = acceptedBefore === null || acceptedAfter === null
      ? 0
      : acceptedAfter - acceptedBefore;
    let mainHistoryApplied = false;
    if (operation === "launch-succeeded" && launchSettled && args.targetPath && args.targetName) {
      mainHistoryApplied = await waitUntil(() => historyApplied(args.targetPath, args.targetName), 2500) &&
        acceptedDelta > 0;
    }
    const evidence = {
      key: expectedKey,
      defaultPrevented: defaultPrevented === true,
      selectedProbe: selected,
      launchCallDelta: callsBefore === null || callsAfter === null ? null : callsAfter - callsBefore,
      launchSettled,
      mainHistoryApplied,
      appStateAcceptedDelta: acceptedDelta,
    };
    return send(operation, nonce, evidence);
  }

  async function run(operation, nonce, args = {}) {
    if (operation === "search") return search(nonce);
    if (operation === "restore-input") {
      return send("restore-input", nonce, { restored: await restoreInputState() });
    }
    if (operation === "space-disabled") return spaceDisabled(nonce);
    if (operation === "unlisted") return unlisted(nonce, args.unlistedPath);
    if (operation === "launch-denied" || operation === "launch-succeeded") {
      return launch(operation, nonce, args);
    }
    return false;
  }

  Object.defineProperty(window, "__ATOOLS_RENDERER_LAUNCHER_PROBE__", {
    value: Object.freeze({ run }),
    configurable: false,
    enumerable: false,
    writable: false,
  });
})("__ATOOLS_RENDERER_LAUNCHER_TOKEN__");

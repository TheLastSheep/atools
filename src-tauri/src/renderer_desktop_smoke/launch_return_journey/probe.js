(function installLaunchReturnProbe(token, firstPath, secondPath, targetKind, registrationSource) {
  "use strict";

  const TOKEN = token;
  const TARGET_KIND = targetKind;
  const suffix = registrationSource === "settings-child" ? ".app" : "";
  const FIRST = { path: firstPath, name: `AToolsOwnedProbeFirst${suffix}` };
  const SECOND = { path: secondPath, name: `AToolsOwnedProbeSecond${suffix}` };
  function launchTarget(target) {
    const identity = { type: "app", path: target.path, name: target.name };
    if (TARGET_KIND === "local-shortcut") identity.subType = "local-shortcut";
    return identity;
  }
  const EMPTY_ACTIONS = () => ({
    metaFDefaultPrevented: null,
    launchRejected: null,
    launchResolved: null,
    arrowDownDefaultPrevented: null,
    enterDefaultPrevented: null,
  });
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const inputElement = () => document.querySelector("input.search-input");
  const hostAdapter = () => window.__ATOOLS_ZTOOLS_HOST_ADAPTER__;
  const nativeInvoke = () => {
    const invoke = window.__TAURI__?.core?.invoke;
    return typeof invoke === "function" ? invoke.bind(window.__TAURI__.core) : null;
  };
  const selectedTitle = () => {
    const selected = document.querySelectorAll(".list-mode-results .list-item.selected");
    if (selected.length === 0) return "";
    if (selected.length !== 1) return null;
    const title = selected[0].querySelector(".item-title")?.textContent?.trim();
    return title === FIRST.name || title === SECOND.name ? title : null;
  };
  const pastedText = () => {
    const element = document.querySelector(".pasted-text");
    return element ? String(element.innerText ?? "").slice(0, 4096) : "";
  };
  const titles = () => Array.from(
    document.querySelectorAll(".list-mode-results .list-item .item-title"),
    (element) => element.textContent?.trim() ?? "",
  );
  const adapterSnapshot = () => {
    const adapter = hostAdapter();
    if (!adapter || typeof adapter.snapshot !== "function") return null;
    try {
      const snapshot = adapter.snapshot();
      const nativeCalls = snapshot?.nativeCalls;
      const drag = snapshot?.windowDrag;
      if (!snapshot || !nativeCalls || typeof nativeCalls !== "object" || !drag) return null;
      const launchCalls = Object.hasOwn(nativeCalls, "launch_renderer_app")
        ? nativeCalls.launch_renderer_app
        : 0;
      if (!Number.isSafeInteger(launchCalls) || launchCalls < 0 ||
          !Number.isSafeInteger(snapshot.outstandingNativeCalls) || snapshot.outstandingNativeCalls < 0) {
        return null;
      }
      return {
        launchCalls,
        outstandingNativeCalls: snapshot.outstandingNativeCalls,
        listeners: {
          focusEvents: snapshot.focusEvents,
          appState: snapshot.appState,
          appCatalog: snapshot.appCatalog,
          appLaunched: snapshot.appLaunched,
          contextMenu: snapshot.contextMenu,
          settingsView: snapshot.settingsView,
          generalPreferenceEvents: snapshot.generalPreferenceEvents,
          localShortcutEvents: snapshot.localShortcutEvents,
        },
        windowDrag: drag,
      };
    } catch (_) {
      return null;
    }
  };
  const eventSource = (adapter, group) => {
    const value = adapter?.listeners?.[group];
    if (group === "appState" || group === "appCatalog" || group === "appLaunched" || group === "contextMenu") {
      return value?.eventSource ?? null;
    }
    if (group === "focusEvents") return value ?? null;
    return null;
  };

  let latestActions = EMPTY_ACTIONS();
  let disposedStable = false;
  let launchListenerUnlisten = null;

  async function waitUntil(predicate, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        if (predicate() === true) return true;
      } catch (_) {}
      await delay(25);
    }
    return false;
  }

  function setInputValue(value, inputType) {
    const input = inputElement();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!input || typeof setter !== "function" || typeof InputEvent !== "function") return false;
    setter.call(input, value);
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType,
      data: value,
    }));
    return input.value === value;
  }

  function dispatchKey(key, options = {}) {
    const input = inputElement();
    if (!input) return null;
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      composed: true,
      ...options,
    });
    input.dispatchEvent(event);
    input.dispatchEvent(new KeyboardEvent("keyup", {
      key,
      bubbles: true,
      cancelable: true,
      composed: true,
      ...options,
    }));
    return event;
  }

  function currentDom() {
    const input = inputElement();
    const adapter = adapterSnapshot();
    return {
      inputValue: input ? String(input.value).slice(0, 256) : null,
      pastedText: pastedText(),
      selectedTitle: selectedTitle(),
      visibility: document.visibilityState,
      documentHasFocus: document.hasFocus(),
      inputFocused: Boolean(input && document.activeElement === input),
      actions: { ...latestActions },
      adapter,
    };
  }

  function launchEvents(adapter) {
    return adapter?.listeners?.appLaunched?.eventSource?.deliveredEvents ?? null;
  }

  async function waitLaunchSettled(beforeCalls, beforeEvents, expectedValue) {
    return waitUntil(() => {
      const input = inputElement();
      const adapter = adapterSnapshot();
      const events = launchEvents(adapter);
      return input?.value === expectedValue && pastedText() === "" &&
        adapter?.launchCalls === beforeCalls + 1 &&
        adapter?.outstandingNativeCalls === 0 &&
        events === beforeEvents + 1;
    }, 8000);
  }

  async function waitLockSettled(expectedRequests) {
    return waitUntil(() => {
      const adapter = adapterSnapshot();
      const drag = adapter?.windowDrag;
      return adapter?.outstandingNativeCalls === 0 && drag?.pending === 0 &&
        drag?.queued === 0 && drag?.inFlight === null &&
        drag?.lockRequests === expectedRequests && drag?.dispatchedLocks === expectedRequests;
    }, 5000);
  }

  async function baseline() {
    const ready = await waitUntil(() => {
      const input = inputElement();
      const adapter = adapterSnapshot();
      const appLaunched = eventSource(adapter, "appLaunched");
      const catalog = eventSource(adapter, "appCatalog");
      const localShortcuts = adapter?.listeners?.localShortcutEvents;
      return Boolean(input && adapter && adapter.outstandingNativeCalls === 0 &&
        appLaunched?.listenerState === "listening" && appLaunched.subscribers > 0 &&
        appLaunched.registrationsPending === 0 && catalog?.listenerState === "listening" &&
        catalog.registrationsPending === 0 && adapter.listeners.appCatalog.readPending === false &&
        localShortcuts?.listenerState === "listening" && localShortcuts.subscribers > 0 &&
        localShortcuts.registrationsPending === 0);
    }, 12000);
    return ready;
  }

  async function pasted() {
    if (!setInputValue(FIRST.name, "insertText")) return false;
    const queryReady = await waitUntil(() => inputElement()?.value === FIRST.name && titles().includes(FIRST.name));
    if (!queryReady) return false;
    const metaF = dispatchKey("f", { metaKey: true });
    const movedToPaste = await waitUntil(() => {
      const input = inputElement();
      return input?.value === "" && pastedText().includes(FIRST.name);
    });
    latestActions.metaFDefaultPrevented = metaF?.defaultPrevented ?? null;
    if (!movedToPaste) return false;
    const adapter = adapterSnapshot();
    const requests = (adapter?.windowDrag?.lockRequests ?? 0) + 1;
    window.ztools?.setWindowSizeLock?.(true);
    return latestActions.metaFDefaultPrevented === true && await waitLockSettled(requests);
  }

  async function denied() {
    const before = adapterSnapshot();
    if (!before) return false;
    let rejected = false;
    try {
      await window.ztools.launch(launchTarget(FIRST));
    } catch (_) {
      rejected = true;
    }
    latestActions.launchRejected = rejected;
    const after = adapterSnapshot();
    return rejected && inputElement()?.value === "" && pastedText().includes(FIRST.name) &&
      after?.launchCalls === before.launchCalls + 1 && after?.outstandingNativeCalls === 0;
  }

  async function directReturn() {
    const before = adapterSnapshot();
    const eventsBefore = launchEvents(before);
    if (!before || eventsBefore === null) return false;
    let resolved = false;
    try {
      await window.ztools.launch(launchTarget(FIRST));
      resolved = true;
    } catch (_) {}
    latestActions.launchResolved = resolved;
    if (!resolved) return false;
    return waitLaunchSettled(before.launchCalls, eventsBefore, "");
  }

  async function typed() {
    if (!setInputValue("AToolsOwnedProbe", "insertText")) return false;
    const hasExpectedResults = await waitUntil(() => {
      const resultTitles = titles();
      return inputElement()?.value === "AToolsOwnedProbe" && resultTitles.length === 2 &&
        resultTitles[0] === FIRST.name && resultTitles[1] === SECOND.name &&
        selectedTitle() === FIRST.name;
    });
    if (!hasExpectedResults) return false;
    const moved = dispatchKey("ArrowDown");
    const selectedSecond = await waitUntil(() => selectedTitle() === SECOND.name);
    latestActions.arrowDownDefaultPrevented = moved?.defaultPrevented ?? null;
    if (!selectedSecond || latestActions.arrowDownDefaultPrevented !== true) return false;
    const adapter = adapterSnapshot();
    const requests = (adapter?.windowDrag?.lockRequests ?? 1) + 1;
    window.ztools?.setWindowSizeLock?.(true);
    return waitLockSettled(requests);
  }

  async function keyboardReturn() {
    const before = adapterSnapshot();
    const eventsBefore = launchEvents(before);
    if (!before || eventsBefore === null || selectedTitle() !== SECOND.name) return false;
    const enter = dispatchKey("Enter");
    const settled = await waitLaunchSettled(before.launchCalls, eventsBefore, "");
    latestActions.launchResolved = settled;
    latestActions.enterDefaultPrevented = enter?.defaultPrevented ?? null;
    return settled && latestActions.enterDefaultPrevented === true;
  }

  async function dispose() {
    const adapter = hostAdapter();
    if (!adapter || typeof adapter.dispose !== "function") return false;
    const before = adapterSnapshot();
    try {
      adapter.dispose();
    } catch (_) {
      return false;
    }
    const disposed = await waitUntil(() => {
      const after = adapterSnapshot();
      const sourceGroups = ["focusEvents", "appState", "appCatalog", "appLaunched", "contextMenu"];
      const disposedSources = sourceGroups.every((group) => {
        const source = eventSource(after, group);
        return source?.listenerState === "disposed" && source.subscribers === 0 &&
          source.registrationsPending === 0 && source.cleanupPending === 0 &&
          source.cleanupErrors === 0 && source.registrationErrors === 0 &&
          source.callbackErrors === 0;
      });
      const localShortcuts = after?.listeners?.localShortcutEvents;
      const localShortcutsDisposed = localShortcuts?.listenerState === "disposed" &&
        localShortcuts.subscribers === 0 && localShortcuts.registrationsPending === 0 &&
        localShortcuts.cleanupPending === 0 && localShortcuts.cleanupErrors === 0 &&
        localShortcuts.registrationErrors === 0 && localShortcuts.callbackErrors === 0 &&
        localShortcuts.invalidEvents === 0 && localShortcuts.staleEvents === 0 &&
        localShortcuts.latestRevision === null && localShortcuts.replayPending === false;
      return Boolean(after?.outstandingNativeCalls === 0 && after.windowDrag?.disposed === true &&
        disposedSources && localShortcutsDisposed && after.listeners.settingsView.listenerState === "disposed" &&
        after.listeners.settingsView.registrationErrors === 0 &&
        after.listeners.settingsView.cleanupErrors === 0 &&
        after.listeners.generalPreferenceEvents.invalidPayloads === 0);
    }, 5000);
    if (!disposed) return false;
    await delay(100);
    const after = adapterSnapshot();
    disposedStable = Boolean(before && after && before.launchCalls === after.launchCalls &&
      after.outstandingNativeCalls === 0 && after.windowDrag.pending === 0 &&
      after.windowDrag.queued === 0 && after.windowDrag.queuedLocks === 0);
    return disposedStable;
  }

  async function send(stage, nonce, success) {
    const invoke = nativeInvoke();
    if (!invoke) return false;
    try {
      const dom = currentDom();
      await invoke("renderer_launch_return_receipt", {
        receipt: { schemaVersion: 1, token: TOKEN, stage, nonce, caller: "main", dom },
      });
      return success;
    } catch (_) {
      return false;
    }
  }

  async function run(stage, nonce) {
    latestActions = EMPTY_ACTIONS();
    let success = false;
    try {
      if (stage === "baseline") success = await baseline();
      else if (stage === "pasted") success = await pasted();
      else if (stage === "denied") success = await denied();
      else if (stage === "direct-return") success = await directReturn();
      else if (stage === "typed") success = await typed();
      else if (stage === "keyboard-return") success = await keyboardReturn();
      else if (stage === "disposed") success = await dispose();
    } catch (_) {
      success = false;
    }
    try {
      return await send(stage, nonce, success);
    } catch (_) {
      return false;
    }
  }

  async function sendReadyReceipt(outcome, reason) {
    const invoke = nativeInvoke();
    if (!invoke) return false;
    try {
      await invoke("renderer_launch_return_probe_ready", {
        receipt: { token: TOKEN, outcome, reason },
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  async function failReadiness(reason) {
    await sendReadyReceipt("failed", reason);
    return false;
  }

  async function install() {
    const apiAvailable = await waitUntil(() =>
      window.ztools !== null && typeof window.ztools === "object", 15000);
    if (!apiAvailable) return failReadiness("ztools_api_timeout");

    const methodAvailable = await waitUntil(() =>
      typeof window.ztools?.onAppLaunched === "function", 5000);
    if (!methodAvailable) return failReadiness("on_app_launched_unavailable");

    const api = window.ztools;
    try {
      launchListenerUnlisten = api.onAppLaunched(() => {});
    } catch (_) {
      return failReadiness("listener_registration_failed");
    }
    if (typeof launchListenerUnlisten !== "function") {
      return failReadiness("listener_registration_failed");
    }
    const listening = await waitUntil(() => {
      const adapter = adapterSnapshot();
      const source = eventSource(adapter, "appLaunched");
      return source?.listenerState === "listening" && source.subscribers > 0 &&
        source.registrationsPending === 0;
    }, 12000);
    if (!listening) return failReadiness("listener_ready_timeout");
    return sendReadyReceipt("ready", "none");
  }

  Object.defineProperty(window, "__ATOOLS_RENDERER_LAUNCH_RETURN__", {
    value: Object.freeze({ run, snapshot: currentDom }),
    configurable: false,
    enumerable: false,
    writable: false,
  });
  void install();
})(__ATOOLS_LAUNCH_RETURN_TOKEN__, __ATOOLS_LAUNCH_RETURN_FIRST_PATH__, __ATOOLS_LAUNCH_RETURN_SECOND_PATH__, __ATOOLS_LAUNCH_RETURN_TARGET_KIND__, __ATOOLS_LAUNCH_RETURN_REGISTRATION_SOURCE__);

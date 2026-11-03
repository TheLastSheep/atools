(() => {
  "use strict";
  if (window.__ATOOLS_SETTINGS_INPUT_MAIN__) return;

  const token = window.__ATOOLS_SETTINGS_INPUT_TOKEN__;
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const input = () => document.querySelector("input.search-input");

  async function waitFor(predicate, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await delay(25);
    }
    return Boolean(predicate());
  }

  async function send(operation, evidence, probeId) {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (typeof invoke !== "function") return false;
    try {
      await invoke("settings_input_probe", { token, operation, probeId, evidence });
      return true;
    } catch (_) {
      return false;
    }
  }

  function documentEvidence() {
    return {
      documentHidden: document.hidden === true,
      documentHasFocus: document.hasFocus() === true,
    };
  }

  function inputEvidence() {
    const element = input();
    return {
      inputFound: element instanceof HTMLInputElement,
      inputEmpty: element instanceof HTMLInputElement && element.value.length === 0,
      ...documentEvidence(),
    };
  }

  async function mainReady() {
    await waitFor(() => input() instanceof HTMLInputElement &&
      typeof window.ztools?.openSettings === "function" &&
      typeof window.__ATOOLS_ZTOOLS_HOST_ADAPTER__?.snapshot === "function");
    await send("mainReady", {
      inputFound: input() instanceof HTMLInputElement,
      ...documentEvidence(),
    }, 0);
  }

  function nativeCallCount() {
    try {
      const snapshot = window.__ATOOLS_ZTOOLS_HOST_ADAPTER__?.snapshot?.();
      const count = snapshot?.nativeCalls?.get_app_update_status;
      return Number.isSafeInteger(count) && count >= 0 ? count : 0;
    } catch (_) {
      return 0;
    }
  }

  async function updaterStatus(probeId) {
    const startupCalls = await waitFor(() => nativeCallCount() >= 1) ? nativeCallCount() : 0;
    // Let the startup getter settle so the explicit read uses a distinct Native call.
    if (startupCalls === 1) await delay(100);
    let status = null;
    try {
      status = await window.ztools?.updater?.getDownloadStatus?.();
    } catch (_) {}
    const verifiedCalls = nativeCallCount();
    await send("mainUpdater", {
      startupCalls,
      verifiedCalls,
      idle: status?.status === "idle",
      unchecked: status?.checked === false,
      hasUpdate: status?.hasUpdate === true,
      hasDownloadedAbsent: status !== null && !Object.hasOwn(status, "hasDownloaded"),
    }, probeId);
  }

  async function openSettings(probeId) {
    const open = window.ztools?.openSettings;
    const openCallAvailable = typeof open === "function";
    let openCallDispatched = false;
    if (openCallAvailable) {
      try {
        open.call(window.ztools);
        openCallDispatched = true;
      } catch (_) {}
    }
    await send("mainOpenSettings", { openCallAvailable, openCallDispatched }, probeId);
  }

  function diagnosticCount(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  async function openState(probeId) {
    let evidence = {
      openCalls: null,
      pendingOpen: null,
      openFailures: null,
      listenerState: null,
      registrationErrors: null,
      invalidPayloads: null,
    };
    try {
      const adapter = window.__ATOOLS_ZTOOLS_HOST_ADAPTER__;
      const snapshot = adapter?.snapshot?.();
      const nativeCalls = snapshot?.nativeCalls;
      const settingsView = snapshot?.settingsView;
      const validNativeCalls = nativeCalls !== null && typeof nativeCalls === "object" && !Array.isArray(nativeCalls);
      if (validNativeCalls) {
        evidence.openCalls = Object.hasOwn(nativeCalls, "open_renderer_settings")
          ? diagnosticCount(nativeCalls.open_renderer_settings)
          : 0;
      }
      if (typeof settingsView?.pendingOpen === "boolean") evidence.pendingOpen = settingsView.pendingOpen;
      evidence.openFailures = diagnosticCount(settingsView?.openFailures);
      evidence.registrationErrors = diagnosticCount(settingsView?.registrationErrors);
      evidence.invalidPayloads = diagnosticCount(settingsView?.invalidPayloads);
      const listenerState = settingsView?.listenerState;
      if (["idle", "registering", "listening", "failed", "disposed"].includes(listenerState)) {
        evidence.listenerState = listenerState;
      }
    } catch (_) {}
    await send("mainOpenState", evidence, probeId);
  }

  async function inspect(probeId) {
    await send("mainInspect", inputEvidence(), probeId);
  }

  async function valueMatches(probeId, expected) {
    const element = input();
    await send("mainValue", {
      inputFound: element instanceof HTMLInputElement,
      valueMatches: element instanceof HTMLInputElement && element.value === expected,
      inputEmpty: element instanceof HTMLInputElement && element.value.length === 0,
      ...documentEvidence(),
    }, probeId);
  }

  async function pinnedSearch(probeId, name, shouldBePresent, expectedRevision) {
    function searchViewReady() {
      return document.querySelector(
        ".app-container:not(.app-container__plugin) .scrollable-content",
      ) !== null && document.querySelector(".plugin-placeholder") === null;
    }

    function revisionMatches() {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
          expectedRevision > Number.MAX_SAFE_INTEGER) return false;
      try {
        const revision = window.__ATOOLS_ZTOOLS_HOST_ADAPTER__?.snapshot?.()?.appState?.revision;
        return Number.isSafeInteger(revision) && revision >= 0 &&
          revision <= Number.MAX_SAFE_INTEGER && revision === expectedRevision;
      } catch (_) {
        return false;
      }
    }

    function inspectPinnedGroup() {
      const sections = Array.from(document.querySelectorAll(".collapsible-section")).filter((section) =>
        section.querySelector(".section-title")?.textContent?.trim() === "已固定");
      const rows = sections.flatMap((section) => Array.from(section.querySelectorAll(".app-item")));
      const matches = rows.filter((row) => row.getAttribute("title") === name &&
        row.querySelector(".app-name")?.textContent?.trim() === name);
      return {
        pinnedGroupFound: sections.length === 1,
        targetPresent: matches.length === 1,
        targetAbsent: matches.length === 0,
      };
    }

    await waitFor(() => {
      if (!searchViewReady() || !revisionMatches()) return false;
      const current = inspectPinnedGroup();
      return shouldBePresent
        ? current.pinnedGroupFound && current.targetPresent
        : current.targetAbsent;
    });
    await send("mainPinnedSearch", {
      inputFound: input() instanceof HTMLInputElement,
      inputEmpty: input() instanceof HTMLInputElement && input().value.length === 0,
      searchViewReady: searchViewReady(),
      revisionMatches: revisionMatches(),
      ...inspectPinnedGroup(),
      ...documentEvidence(),
    }, probeId);
  }

  async function setSearchInput(probeId, query) {
    const element = input();
    let eventDispatched = false;
    if (element instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (typeof setter === "function") {
        setter.call(element, query);
        const event = new InputEvent("input", {
          bubbles: true,
          inputType: query ? "insertText" : "deleteContentBackward",
          data: query || null,
        });
        eventDispatched = element.dispatchEvent(event);
      }
    }
    const valueMatches = await waitFor(() => input() instanceof HTMLInputElement && input().value === query);
    const current = inputEvidence();
    await send("mainInput", {
      inputFound: element instanceof HTMLInputElement,
      eventDispatched,
      valueMatches,
      ...current,
    }, probeId);
  }

  window.__ATOOLS_SETTINGS_INPUT_MAIN__ = Object.freeze({
    updaterStatus,
    openSettings,
    openState,
    inspect,
    input: setSearchInput,
    valueMatches,
    pinnedSearch,
  });
  void mainReady();
})();

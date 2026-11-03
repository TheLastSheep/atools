(() => {
  "use strict";
  if (window.__ATOOLS_SETTINGS_JOURNEY_CHILD__) return;

  const FIXED_PLACEHOLDER = "atools-native-settings-fixed";
  const INITIAL_PLACEHOLDER = "atools-native-settings-initial";
  const SECRET_SENTINELS = [
    "ATools-Fake-AI-Secret-Do-Not-Expose",
    "ATools-Fake-WebDAV-Password-Do-Not-Expose",
    "ATools-Fake-Unknown-Nested-Secret-Do-Not-Expose",
    "ATools-Fake-Proxy-URL-Do-Not-Expose",
    "ATools-Fake-Terminal-Command-Do-Not-Expose",
  ];
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const config = () => window.__ATOOLS_SETTINGS_VIEW_CONFIG__;
  const invoke = () => window.__TAURI__?.core?.invoke;

  function randomDocumentIdentity() {
    try {
      if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    } catch (_) {}
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 18)}`;
  }
  const documentIdentity = randomDocumentIdentity();

  function generalInput() {
    return document.querySelector('input.input[placeholder="输入提示文字"]');
  }

  function domMounted() {
    return Boolean(
      document.querySelector('.content-panel:not([aria-busy="true"])') &&
      document.querySelector(".content-panel .setting-group") &&
      generalInput(),
    );
  }

  async function waitFor(predicate, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await delay(25);
    }
    return Boolean(predicate());
  }

  function appCommandDenied(error) {
    return error !== null && typeof error === "object" &&
      error.code === "CHILD_WEBVIEW_APP_COMMAND_DENIED" &&
      error.message === "Child WebViews cannot invoke application commands";
  }

  function allowedContext(section) {
    const prefix = "allowed on: ";
    if (typeof section !== "string" || !section.startsWith(prefix)) return false;
    let rest = section.slice(prefix.length);
    const entries = [];
    while (rest.startsWith("[")) {
      const end = rest.indexOf("]");
      if (end < 0) return false;
      entries.push(rest.slice(1, end));
      rest = rest.slice(end + 1);
      if (!rest) break;
      if (!rest.startsWith(", ")) return false;
      rest = rest.slice(2);
    }
    return rest.length === 0 && entries.length > 0 && entries.every((entry) =>
      entry === 'webviews: "main", "settings", URL: local',
    );
  }

  function frameworkAclDenied(error) {
    if (typeof error !== "string") return false;
    const current = config();
    const label = `ztools-settings-${current?.sessionId ?? ""}`;
    const expectedHeader = `window.is_visible not allowed on window "main", webview "${label}", URL: local`;
    const sections = error.split("\n\n");
    if (sections.length !== 3 || sections[0] !== expectedHeader || !allowedContext(sections[1])) {
      return false;
    }
    const prefix = "referenced by: ";
    if (!sections[2].startsWith(prefix)) return false;
    const references = sections[2].slice(prefix.length).split(" || ");
    return references.length > 0 && references.every((entry) =>
      entry === "capability: default, permission: allow-is-visible",
    );
  }

  function utf8Prefix(value, maxBytes) {
    let result = "";
    let byteLength = 0;
    for (const character of value) {
      const codePoint = character.codePointAt(0);
      const width = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
      if (byteLength + width > maxBytes) break;
      result += character;
      byteLength += width;
    }
    return result;
  }

  function coreErrorDiagnostic(error) {
    if (typeof error === "string") return utf8Prefix(error, 4096);
    return "[non-string:" + (error === null ? "null" : typeof error) + "]";
  }

  async function deniedOperations(staleSessionId) {
    const nativeInvoke = invoke();
    let genericAppDenied = false;
    let coreDenied = false;
    let coreDenialDiagnostic = "not-observed";
    let staleSessionRejected = staleSessionId === null;
    let unlistedResourceDenied = false;
    if (typeof nativeInvoke !== "function") {
      coreDenialDiagnostic = "invoke-unavailable";
    }
    if (typeof nativeInvoke === "function") {
      try {
        await nativeInvoke("get_setting", { key: "settings-general" });
      } catch (error) {
        genericAppDenied = appCommandDenied(error);
      }
      try {
        await nativeInvoke("plugin:window|is_visible", { label: "main" });
        coreDenialDiagnostic = "call-resolved";
      } catch (error) {
        coreDenied = frameworkAclDenied(error);
        coreDenialDiagnostic = coreErrorDiagnostic(error);
      }
      if (staleSessionId) {
        try {
          await window.__TAURI_INTERNALS__.invoke("call_renderer_settings", {
            sessionId: staleSessionId,
            operation: "readGeneral",
            payload: {},
          });
        } catch (error) {
          staleSessionRejected = error !== null && typeof error === "object" &&
            error.code === "SETTINGS_CALLER_REJECTED" &&
            error.message === "Settings view caller is not the active child";
        }
      }
    }
    try {
      const response = await fetch("/__atools_native_settings_unlisted_resource__", {
        cache: "no-store",
        credentials: "omit",
      });
      unlistedResourceDenied = response.status === 404 || response.status === 410;
    } catch (_) {}
    return {
      genericAppDenied,
      coreDenied,
      coreDenialDiagnostic,
      staleSessionRejected,
      unlistedResourceDenied,
    };
  }

  async function readNativeNarrowGeneral() {
    const current = config();
    const nativeInvoke = window.__TAURI_INTERNALS__?.invoke;
    if (!current || typeof nativeInvoke !== "function") {
      return { succeeded: false, fieldCount: 0, secretsAbsent: false };
    }
    try {
      const reply = await nativeInvoke("call_renderer_settings", {
        sessionId: current.sessionId,
        operation: "readGeneral",
        payload: {},
      });
      const value = reply?.value;
      if (!reply || typeof reply.revision !== "string" || !value ||
          typeof value !== "object" || Array.isArray(value) ||
          Object.keys(reply).length !== 2 || Object.hasOwn(reply, "raw")) {
        return { succeeded: false, fieldCount: 0, secretsAbsent: false };
      }
      const serialized = JSON.stringify(reply);
      return {
        succeeded: Object.keys(value).length === 43,
        fieldCount: Object.keys(value).length,
        value,
        secretsAbsent: SECRET_SENTINELS.every((sentinel) => !serialized.includes(sentinel)) &&
          value.proxyUrl === "" && value.terminalCustomCommand === "",
      };
    } catch (_) {
      return { succeeded: false, fieldCount: 0, secretsAbsent: false };
    }
  }

  function sameJsonValue(left, right, depth = 0) {
    if (left === right) return true;
    if (depth > 8 || left === null || right === null ||
        typeof left !== "object" || typeof right !== "object") return false;
    if (Array.isArray(left) || Array.isArray(right)) {
      return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
        left.every((value, index) => sameJsonValue(value, right[index], depth + 1));
    }
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length && leftKeys.every((key) =>
      Object.hasOwn(right, key) && sameJsonValue(left[key], right[key], depth + 1),
    );
  }

  function safeGeneralProjection(value) {
    return Boolean(
      value && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).length === 43 &&
      value.proxyUrl === "" && value.terminalCustomCommand === "" &&
      SECRET_SENTINELS.every((sentinel) => !JSON.stringify(value).includes(sentinel)),
    );
  }

  async function nativeReady(narrowGeneral, domReady) {
    const current = config();
    const internal = window.ztools?.internal;
    let platform = "";
    let launchAtLoginAvailable = false;
    let currentShortcutAvailable = false;
    let opacityApplied = false;
    let themeApplied = false;
    let projectionFieldCount = 0;
    let projectionMatchesNarrow = false;
    let projectionSecretsAbsent = false;
    let projected = null;

    if (!current || !internal || typeof internal.getPlatform !== "function" ||
        typeof internal.getCurrentShortcut !== "function" ||
        typeof internal.getLaunchAtLogin !== "function" ||
        typeof internal.dbGet !== "function" ||
        typeof internal.setTheme !== "function" ||
        typeof internal.setWindowOpacity !== "function") {
      return {
        platform,
        nativeReady: false,
        launchAtLoginAvailable,
        opacityApplied,
        themeApplied,
        projectionFieldCount,
        projectionMatchesNarrow,
        projectionSecretsAbsent,
      };
    }

    try {
      platform = internal.getPlatform() === "darwin" ? "darwin" : "";
    } catch (_) {}
    try {
      currentShortcutAvailable = typeof await internal.getCurrentShortcut() === "string";
    } catch (_) {}
    try {
      launchAtLoginAvailable = typeof await internal.getLaunchAtLogin() === "boolean";
    } catch (_) {}
    try {
      projected = await internal.dbGet("settings-general");
      projectionFieldCount = projected && typeof projected === "object" && !Array.isArray(projected)
        ? Object.keys(projected).length
        : 0;
      projectionSecretsAbsent = safeGeneralProjection(projected);
      projectionMatchesNarrow = projectionSecretsAbsent && narrowGeneral?.succeeded === true &&
        sameJsonValue(projected, narrowGeneral.value);
    } catch (_) {}
    if (projectionSecretsAbsent) {
      try {
        await internal.setTheme(projected.theme);
        themeApplied = true;
      } catch (_) {}
      try {
        await internal.setWindowOpacity(projected.opacity);
        opacityApplied = true;
      } catch (_) {}
    }

    return {
      platform,
      nativeReady: domReady && platform === "darwin" && currentShortcutAvailable &&
        launchAtLoginAvailable && projectionMatchesNarrow && themeApplied && opacityApplied,
      launchAtLoginAvailable,
      opacityApplied,
      themeApplied,
      projectionFieldCount,
      projectionMatchesNarrow,
      projectionSecretsAbsent,
    };
  }

  async function inspect(operation, generation, token, expectedPlaceholder, staleSessionId) {
    const mounted = await waitFor(() =>
      domMounted() && generalInput()?.value === expectedPlaceholder,
    );
    const input = generalInput();
    let narrowGeneral = null;
    let readGeneralSucceeded = false;
    try {
      narrowGeneral = await readNativeNarrowGeneral();
      readGeneralSucceeded = narrowGeneral.succeeded && narrowGeneral.fieldCount === 43 &&
        narrowGeneral.secretsAbsent;
    } catch (_) {}
    const actualDomReady = mounted && domMounted() && Boolean(input && input.value === expectedPlaceholder);
    const ready = await nativeReady(narrowGeneral, actualDomReady);
    readGeneralSucceeded = readGeneralSucceeded && ready?.projectionMatchesNarrow === true &&
      ready?.projectionSecretsAbsent === true;
    const denied = await deniedOperations(staleSessionId);
    const evidence = {
      domMounted: actualDomReady,
      inputFound: Boolean(input && input.isConnected),
      placeholderMatches: Boolean(input && input.value === expectedPlaceholder),
      notIframe: window.top === window && window.frameElement === null,
      platform: ready.platform === "darwin" ? "darwin" : "",
      nativeReady: ready.nativeReady === true && actualDomReady && readGeneralSucceeded,
      launchAtLoginAvailable: ready?.launchAtLoginAvailable === true,
      opacityApplied: ready?.opacityApplied === true,
      themeApplied: ready?.themeApplied === true,
      projectionFieldCount: narrowGeneral?.fieldCount === ready?.projectionFieldCount &&
        narrowGeneral?.fieldCount === 43 && ready.projectionMatchesNarrow ? narrowGeneral.fieldCount : 0,
      secretsAbsent: readGeneralSucceeded,
      readGeneralSucceeded,
      genericAppDenied: denied.genericAppDenied,
      coreDenied: denied.coreDenied,
      coreDenialDiagnostic: denied.coreDenialDiagnostic,
      unlistedResourceDenied: denied.unlistedResourceDenied,
      ...(operation === "childReopen" ? { staleSessionRejected: denied.staleSessionRejected } : {}),
      documentIdentity,
      sessionIdentity: typeof config()?.sessionId === "string" ? config().sessionId : "",
    };
    if (operation === "childInitial") {
      await send(token, operation, generation, evidence);
    } else {
      await send(token, operation, generation, evidence);
    }
  }

  async function save(token, generation) {
    const mounted = await waitFor(domMounted);
    const input = generalInput();
    if (!mounted || !input) {
      await send(token, "childSave", generation, {
        inputChanged: false,
        saveAcknowledged: false,
        projectionPersisted: false,
        projectionFieldCount: 0,
      });
      return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (!descriptor || typeof descriptor.set !== "function") return;
    descriptor.set.call(input, FIXED_PLACEHOLDER);
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: FIXED_PLACEHOLDER,
    }));
    input.focus();
    input.blur();
    const deadline = Date.now() + 12000;
    let projected = null;
    while (Date.now() < deadline) {
      try {
        projected = await readNativeNarrowGeneral();
      } catch (_) {
        projected = null;
      }
      if (projected?.succeeded && projected.value?.placeholder === FIXED_PLACEHOLDER) break;
      await delay(30);
    }
    await send(token, "childSave", generation, {
      inputChanged: input.value === FIXED_PLACEHOLDER,
      saveAcknowledged: input.value === FIXED_PLACEHOLDER &&
        projected?.succeeded === true && projected?.value?.placeholder === FIXED_PLACEHOLDER,
      projectionPersisted: projected?.value?.placeholder === FIXED_PLACEHOLDER &&
        projected?.succeeded === true && projected?.fieldCount === 43 &&
        projected?.secretsAbsent === true,
      projectionFieldCount: projected?.fieldCount ?? 0,
    });
  }

  function escapeAndWitness(token, generation) {
    let captureListenerObserved = false;
    const listener = (event) => {
      if (event.key !== "Escape" || event.target !== document) return;
      captureListenerObserved = true;
      document.removeEventListener("keydown", listener, true);
      void send(token, "childEscapeWitness", generation, {
        escapeEventDispatched: true,
        captureListenerObserved,
        bubbles: event.bubbles,
        cancelable: event.cancelable,
      });
    };
    document.addEventListener("keydown", listener, true);
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);
  }

  async function send(token, operation, generation, evidence) {
    const nativeInvoke = invoke();
    if (typeof nativeInvoke !== "function") return false;
    try {
      await nativeInvoke("settings_journey_probe", {
        token,
        operation,
        generation,
        evidence,
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  Object.defineProperty(window, "__ATOOLS_SETTINGS_JOURNEY_CHILD__", {
    value: Object.freeze({ inspect, save, escapeAndWitness }),
    configurable: false,
    writable: false,
  });
})();

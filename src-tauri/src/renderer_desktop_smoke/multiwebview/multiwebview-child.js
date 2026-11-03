(() => {
  const config = window.__ATOOLS_MULTIWEBVIEW_CONFIG__;
  const status = document.getElementById("probe-status");
  if (!config || !config.nonce || !Number.isInteger(config.generation)) {
    if (status) status.textContent = "Probe configuration unavailable.";
    return;
  }

  const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
  if (typeof invoke !== "function") {
    if (status) status.textContent = "Native invocation unavailable.";
    return;
  }

  function isFrameworkAclDenial(error, prettyCommand) {
    if (typeof error !== "string") return false;
    const sections = error.split("\n\n");
    if (sections.length !== 3) return false;
    if (
      sections[0] !==
      `${prettyCommand} not allowed on window "main", webview "renderer-settings-probe", URL: local`
    ) {
      return false;
    }
    if (!isFrameworkAllowedOn(sections[1])) return false;
    const referencePrefix = "referenced by: ";
    if (!sections[2].startsWith(referencePrefix)) return false;
    const references = sections[2].slice(referencePrefix.length).split(" || ");
    return references.length > 0 && references.every((reference) =>
      /^capability: [^,\r\n]+, permission: [^,\r\n]+$/.test(reference),
    );
  }

  function isFrameworkAllowedOn(section) {
    const prefix = "allowed on: ";
    if (!section.startsWith(prefix)) return false;
    let remainder = section.slice(prefix.length);
    const entries = [];
    while (remainder.startsWith("[")) {
      const end = remainder.indexOf("]");
      if (end < 0) return false;
      entries.push(remainder.slice(1, end));
      remainder = remainder.slice(end + 1);
      if (remainder.length === 0) break;
      if (!remainder.startsWith(", ")) return false;
      remainder = remainder.slice(2);
    }
    return remainder.length === 0 && entries.length > 0 && entries.every(isFrameworkContext);
  }

  function isFrameworkContext(entry) {
    let prefix = "";
    let urlPart = entry;
    if (!entry.startsWith("URL: ")) {
      const separator = entry.lastIndexOf(", URL: ");
      if (separator < 0) return false;
      prefix = entry.slice(0, separator);
      urlPart = entry.slice(separator + 2);
    }
    if (!/^URL: \S+$/.test(urlPart)) return false;

    let remainder = prefix;
    if (remainder.startsWith("windows: ")) {
      const match = remainder.match(/^windows: "[^"\r\n]+"(?:, "[^"\r\n]+")*/);
      if (!match) return false;
      remainder = remainder.slice(match[0].length);
    }
    if (remainder.startsWith(", ")) remainder = remainder.slice(2);
    if (remainder.startsWith("webviews: ")) {
      const match = remainder.match(/^webviews: "[^"\r\n]+"(?:, "[^"\r\n]+")*/);
      if (!match) return false;
      remainder = remainder.slice(match[0].length);
    }
    return remainder.length === 0;
  }

  function errorCode(error, command) {
    if (
      command === "get_setting" &&
      error !== null &&
      typeof error === "object" &&
      error.code === "CHILD_WEBVIEW_APP_COMMAND_DENIED" &&
      error.message === "Child WebViews cannot invoke application commands"
    ) {
      return "CHILD_WEBVIEW_APP_COMMAND_DENIED";
    }
    const prettyCommand = {
      "plugin:window|is_visible": "window.is_visible",
      "plugin:fs|exists": "fs.exists",
    }[command];
    if (prettyCommand && isFrameworkAclDenial(error, prettyCommand)) return "REJECTED";
    return "UNEXPECTED_ERROR";
  }

  async function attempt(command, args) {
    if (typeof invoke !== "function") {
      return { ok: false, code: "INVOKE_UNAVAILABLE", permissionDenied: false };
    }
    try {
      const value = await invoke(command, args);
      return { ok: true, value: typeof value === "boolean" ? value : undefined };
    } catch (error) {
      const code = errorCode(error, command);
      return { ok: false, code, permissionDenied: code === "REJECTED" || code === "CHILD_WEBVIEW_APP_COMMAND_DENIED" };
    }
  }

  const documentId = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  function report(fields) {
    const report = {
      version: 1,
      nonce: config.nonce,
      generation: config.generation,
      documentId,
      ...fields,
    };
    const payload = encodeURIComponent(JSON.stringify(report));
    if (payload.length > 7000) return;
    window.location.assign(
      `atools-multiwebview-probe://report/?nonce=${encodeURIComponent(config.nonce)}&payload=${payload}`,
    );
  }

  window.__ATOOLS_MULTIWEBVIEW_REPORT_FOCUS__ = () => {
    report({
      kind: "focus",
      hasFocus: document.hasFocus(),
      visibilityState: document.visibilityState,
    });
  };

  async function run() {
    const proof = {
      kind: "proof",
      getGeneralSettings: await attempt("get_setting", { key: "settings-general" }),
      windowIsVisible: await attempt("plugin:window|is_visible", { label: "main" }),
      resourceExists: await attempt("plugin:fs|exists", { path: config.resourcePath }),
    };
    if (status) status.textContent = "Boundary checks reported.";
    report(proof);
  }

  void run();
})();

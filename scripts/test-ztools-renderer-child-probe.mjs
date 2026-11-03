import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const childProbeUrl = new URL(
  "../src-tauri/src/renderer_desktop_smoke/multiwebview/multiwebview-child.js",
  import.meta.url,
);
const childProbeSource = await readFile(childProbeUrl, "utf8");
const appDenyCode = "CHILD_WEBVIEW_APP_COMMAND_DENIED";
const appDenyMessage = "Child WebViews cannot invoke application commands";
const resourcePath = "/private/tmp/owned/renderer-multiwebview-probe.txt";

function aclDiagnostic(prettyCommand, overrides = {}) {
  const window = overrides.window ?? "main";
  const webview = overrides.webview ?? "renderer-settings-probe";
  const origin = overrides.origin ?? "local";
  const allowed = overrides.allowed ?? "allowed on: [windows: \"main\", webviews: \"main\", URL: local]";
  const references = overrides.references ?? "referenced by: capability: renderer-main, permission: core:window:allow-is-visible";
  return `${prettyCommand} not allowed on window "${window}", webview "${webview}", URL: ${origin}\n\n${allowed}\n\n${references}`;
}

async function executeActualProbe(errors = {}) {
  const calls = [];
  const navigations = [];
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (Object.hasOwn(errors, command)) throw errors[command];
    if (command === "get_setting") return "PRIVATE_SETTINGS_RAW_MUST_NOT_ESCAPE";
    if (command === "plugin:window|is_visible") return true;
    if (command === "plugin:fs|exists") return true;
    throw new Error("mock has no response for command");
  };
  const window = {
    __ATOOLS_MULTIWEBVIEW_CONFIG__: {
      nonce: "0123456789abcdef0123456789abcdef",
      generation: 1,
      resourcePath,
    },
    __TAURI__: { core: { invoke } },
    location: { assign: (url) => navigations.push(url) },
  };
  const context = {
    window,
    document: {
      getElementById: () => ({ textContent: "" }),
      hasFocus: () => true,
    },
    crypto: { randomUUID: () => "fresh-document-id" },
    encodeURIComponent,
    JSON,
    Number,
    Date,
    Math,
  };
  vm.runInNewContext(childProbeSource, context, {
    filename: "multiwebview-child.js",
    timeout: 1_000,
  });
  for (let turn = 0; turn < 12 && navigations.length === 0; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(navigations.length, 1, "actual child script must report through its private scheme");
  const reportUrl = new URL(navigations[0]);
  assert.equal(reportUrl.protocol, "atools-multiwebview-probe:");
  const report = JSON.parse(reportUrl.searchParams.get("payload"));
  return { calls, report, navigations };
}

function plainCalls(calls) {
  return JSON.parse(JSON.stringify(calls));
}

test("actual child script keeps successful invocation outcomes without returning General raw data", async () => {
  const { report } = await executeActualProbe();
  assert.deepEqual(report.getGeneralSettings, { ok: true });
  assert.deepEqual(report.windowIsVisible, { ok: true, value: true });
  assert.deepEqual(report.resourceExists, { ok: true, value: true });
  assert.equal(JSON.stringify(report).includes("PRIVATE_SETTINGS_RAW_MUST_NOT_ESCAPE"), false);
});

test("actual child script reports exact app denial and command-bound Tauri ACL denials", async () => {
  const { calls, report } = await executeActualProbe({
    get_setting: { code: appDenyCode, message: appDenyMessage },
    "plugin:window|is_visible": aclDiagnostic("window.is_visible", {
      references: "referenced by: capability: renderer-main, permission: core:window:allow-is-visible",
    }),
    "plugin:fs|exists": aclDiagnostic("fs.exists", {
      references: "referenced by: capability: renderer-main, permission: core:fs:allow-exists",
    }),
  });

  assert.deepEqual(plainCalls(calls), [
    { command: "get_setting", args: { key: "settings-general" } },
    { command: "plugin:window|is_visible", args: { label: "main" } },
    { command: "plugin:fs|exists", args: { path: resourcePath } },
  ]);
  assert.deepEqual(report.getGeneralSettings, {
    ok: false,
    code: appDenyCode,
    permissionDenied: true,
  });
  assert.deepEqual(report.windowIsVisible, {
    ok: false,
    code: "REJECTED",
    permissionDenied: true,
  });
  assert.deepEqual(report.resourceExists, {
    ok: false,
    code: "REJECTED",
    permissionDenied: true,
  });
});

test("actual child script rejects app code text unless the fixed structured refusal matches", async () => {
  const invalidErrors = [
    appDenyCode,
    new Error(appDenyCode),
    { code: appDenyCode, message: "another error" },
    { code: "OTHER_CODE", message: appDenyMessage },
  ];
  for (const error of invalidErrors) {
    const { report } = await executeActualProbe({ get_setting: error });
    assert.deepEqual(report.getGeneralSettings, {
      ok: false,
      code: "UNEXPECTED_ERROR",
      permissionDenied: false,
    });
  }
});

test("actual child script fails closed for non-ACL, unknown, and mismatched authority diagnostics", async () => {
  const wrongWindow = aclDiagnostic("window.is_visible", { window: "other" });
  const wrongWebview = aclDiagnostic("window.is_visible", { webview: "main" });
  const wrongOrigin = aclDiagnostic("window.is_visible", { origin: "https://example.invalid/" });
  const wrongCommand = aclDiagnostic("window.remove");
  const missingAllowedContext = aclDiagnostic("window.is_visible", { allowed: "Command not found" });
  const malformedAllowedContext = aclDiagnostic("window.is_visible", { allowed: "allowed on: [garbage]" });
  const missingReferences = aclDiagnostic("window.is_visible", { references: "referenced by: " });
  const malformedReference = aclDiagnostic("window.is_visible", {
    references: "referenced by: arbitrary permission denied text",
  });
  const failures = [
    "window.is_visible not allowed. Command not found",
    "window.is_visible not allowed. Plugin not found",
    "permission backend unavailable",
    wrongWindow,
    wrongWebview,
    wrongOrigin,
    wrongCommand,
    missingAllowedContext,
    malformedAllowedContext,
    missingReferences,
    malformedReference,
    { code: "REJECTED", message: aclDiagnostic("window.is_visible") },
    new Error(aclDiagnostic("window.is_visible")),
  ];

  for (const error of failures) {
    const { report } = await executeActualProbe({ "plugin:window|is_visible": error });
    assert.deepEqual(report.windowIsVisible, {
      ok: false,
      code: "UNEXPECTED_ERROR",
      permissionDenied: false,
    });
  }
});

test("actual child script does not leak settings values or raw IPC errors", async () => {
  const rawAclError = aclDiagnostic("window.is_visible");
  const { report, navigations } = await executeActualProbe({
    get_setting: { code: appDenyCode, message: appDenyMessage },
    "plugin:window|is_visible": rawAclError,
  });
  const serialized = `${JSON.stringify(report)}${navigations.join("")}`;
  assert.equal(serialized.includes("PRIVATE_SETTINGS_RAW_MUST_NOT_ESCAPE"), false);
  assert.equal(serialized.includes(rawAclError), false);
});

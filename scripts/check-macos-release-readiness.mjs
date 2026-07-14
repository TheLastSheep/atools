import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";

const READINESS_PREFIX = "ATOOLS_MACOS_RELEASE_READINESS ";

export function parseReadinessOutput(output) {
  const line = output
    .split(/\r?\n/)
    .find((item) => item.startsWith(READINESS_PREFIX));
  if (!line) {
    throw new Error("Missing ATOOLS_MACOS_RELEASE_READINESS output");
  }
  return JSON.parse(line.slice(READINESS_PREFIX.length));
}

export function evaluateMacosReleaseReadiness(input) {
  const config = input.config ?? {};
  const env = input.env ?? {};
  const files = input.files ?? new Set();
  const bundle = config.bundle ?? {};
  const macOS = bundle.macOS ?? {};
  const checks = [
    bundleActiveCheck(bundle),
    bundleTargetsCheck(bundle),
    minimumSystemCheck(macOS),
    bundleIdentifierCheck(config.identifier),
    signingIdentityCheck(macOS, env),
    entitlementsCheck(macOS, files),
    notarizationCredentialsCheck(macOS, env),
    updaterConfigCheck(config),
    smokeChecklistCheck(files),
    crashRecoveryCheck(input.hasPanicHook),
    crashLogUiCheck(input.hasCrashLogUi),
  ];
  const summary = summarizeChecks(checks);

  return {
    status: summary.error > 0 ? "error" : summary.warn > 0 ? "warn" : "ok",
    summary,
    checks,
  };
}

const SIGNING_FREE_WARNING_IDS = [
  "notarization-credentials",
  "signing-identity",
  "updater-config",
];

export function assertSigningFreeReadiness(result) {
  const warningIds = result.checks
    .filter((check) => check.status === "warn")
    .map((check) => check.id)
    .sort();
  const expectedSummary = result.status === "warn"
    && result.summary?.ok === 8
    && result.summary?.warn === 3
    && result.summary?.error === 0;
  const expectedWarnings = JSON.stringify(warningIds) === JSON.stringify(SIGNING_FREE_WARNING_IDS);
  if (!expectedSummary || !expectedWarnings) {
    throw new Error(
      `Expected signing-free readiness 8 ok / 3 warn / 0 error with warnings ${SIGNING_FREE_WARNING_IDS.join(", ")}; received ${JSON.stringify({ status: result.status, summary: result.summary, warningIds })}`,
    );
  }
}

export function runMacosReleaseReadiness(options = {}) {
  const root = options.root ?? process.cwd();
  const configPath = options.configPath ?? join(root, "src-tauri", "tauri.conf.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const files = projectFileSet(root, config, configPath);
  const hasPanicHook = sourceContainsPanicHook(root);
  const hasCrashLogUi = settingsPanelContainsCrashLogUi(root);

  return {
    ...evaluateMacosReleaseReadiness({
      config,
      env: options.env ?? process.env,
      files,
      hasPanicHook,
      hasCrashLogUi,
    }),
    timestamp: new Date().toISOString(),
    config_path: relativePath(root, configPath),
  };
}

function bundleActiveCheck(bundle) {
  return bundle.active === true
    ? ok("bundle-active", "bundle.active is enabled")
    : error("bundle-active", "bundle.active must be true for distributable macOS builds");
}

function bundleTargetsCheck(bundle) {
  const targets = Array.isArray(bundle.targets) ? bundle.targets : [bundle.targets].filter(Boolean);
  const targetText = targets.join(",");
  if (targets.includes("all") || targets.includes("app") || targets.includes("dmg")) {
    return ok("bundle-targets", `bundle targets include macOS app output: ${targetText}`);
  }
  return warn("bundle-targets", "bundle.targets should include all, app, or dmg for macOS release smoke");
}

function minimumSystemCheck(macOS) {
  return stringValue(macOS.minimumSystemVersion)
    ? ok("minimum-system-version", `minimumSystemVersion=${macOS.minimumSystemVersion}`)
    : warn("minimum-system-version", "bundle.macOS.minimumSystemVersion is not set");
}

function bundleIdentifierCheck(identifier) {
  const value = stringValue(identifier);
  if (!value) {
    return warn("bundle-identifier", "Tauri identifier is not configured");
  }
  if (value.endsWith(".app")) {
    return warn("bundle-identifier", `identifier should not end with .app: ${value}`);
  }
  return ok("bundle-identifier", `identifier=${value}`);
}

function signingIdentityCheck(macOS, env) {
  const identity = stringValue(macOS.signingIdentity) || stringValue(env.APPLE_SIGNING_IDENTITY);
  return identity
    ? ok("signing-identity", "macOS signing identity is configured")
    : warn("signing-identity", "Set bundle.macOS.signingIdentity or APPLE_SIGNING_IDENTITY before signed distribution");
}

function entitlementsCheck(macOS, files) {
  const entitlements = stringValue(macOS.entitlements);
  if (!entitlements) {
    return warn("entitlements", "bundle.macOS.entitlements is not configured");
  }
  return files.has(normalize(entitlements))
    ? ok("entitlements", `entitlements file exists: ${entitlements}`)
    : error("entitlements", `configured entitlements file is missing: ${entitlements}`);
}

function notarizationCredentialsCheck(macOS, env) {
  const hasAccount = stringValue(env.APPLE_ID);
  const hasPassword = stringValue(env.APPLE_PASSWORD) || stringValue(env.APPLE_APP_SPECIFIC_PASSWORD);
  const hasTeam = stringValue(env.APPLE_TEAM_ID) || stringValue(macOS.providerShortName);
  return hasAccount && hasPassword && hasTeam
    ? ok("notarization-credentials", "Apple notarization credentials are present in environment/config")
    : warn("notarization-credentials", "Set APPLE_ID, APPLE_PASSWORD or APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID/providerShortName before notarization");
}

function updaterConfigCheck(config) {
  const updater = config.plugins?.updater;
  const hasArtifacts = config.bundle?.createUpdaterArtifacts === true;
  const hasPubkey = stringValue(updater?.pubkey);
  const hasEndpoints = Array.isArray(updater?.endpoints) && updater.endpoints.length > 0;
  return hasArtifacts && hasPubkey && hasEndpoints
    ? ok("updater-config", "Tauri updater artifacts, public key, and endpoints are configured")
    : warn("updater-config", "Configure bundle.createUpdaterArtifacts and plugins.updater pubkey/endpoints before enabling automatic updates");
}

function smokeChecklistCheck(files) {
  return files.has("docs/macos-smoke-checklist.md")
    ? ok("macos-smoke-checklist", "docs/macos-smoke-checklist.md exists")
    : warn("macos-smoke-checklist", "docs/macos-smoke-checklist.md is missing");
}

function crashRecoveryCheck(hasPanicHook) {
  return hasPanicHook
    ? ok("crash-recovery", "Rust panic hook/crash recovery hook is present")
    : warn("crash-recovery", "Rust panic hook/crash recovery hook is not configured yet");
}

function crashLogUiCheck(hasCrashLogUi) {
  return hasCrashLogUi
    ? ok("crash-log-ui", "Crash log view/export/clear UI is wired")
    : warn("crash-log-ui", "Crash log UI view/export/clear is not wired yet");
}

function summarizeChecks(checks) {
  return checks.reduce((summary, check) => {
    summary[check.status] += 1;
    return summary;
  }, { ok: 0, warn: 0, error: 0 });
}

function ok(id, message) {
  return { id, status: "ok", message };
}

function warn(id, message) {
  return { id, status: "warn", message };
}

function error(id, message) {
  return { id, status: "error", message };
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function projectFileSet(root, config, configPath = join(root, "src-tauri", "tauri.conf.json")) {
  const files = new Set();
  const smokeChecklist = "docs/macos-smoke-checklist.md";
  if (existsSync(join(root, smokeChecklist))) {
    files.add(smokeChecklist);
  }

  const entitlements = stringValue(config.bundle?.macOS?.entitlements);
  if (entitlements) {
    const absoluteCandidates = [
      join(root, entitlements),
      join(dirname(configPath), entitlements),
    ];
    if (absoluteCandidates.some((absolute) => existsSync(absolute))) {
      files.add(normalize(entitlements));
    }
  }
  return files;
}

function sourceContainsPanicHook(root) {
  const sourceRoot = join(root, "src-tauri", "src");
  if (!existsSync(sourceRoot)) return false;
  return rustSourceFiles(sourceRoot).some((file) =>
    readFileSync(file, "utf8").includes("std::panic::set_hook")
  );
}

function settingsPanelContainsCrashLogUi(root) {
  const path = join(root, "src", "components", "SettingsPanel.svelte");
  if (!existsSync(path)) return false;
  const source = readFileSync(path, "utf8");
  return [
    "list_crash_logs",
    "export_crash_log",
    "clear_crash_log",
  ].every((needle) => source.includes(needle));
}

function rustSourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return rustSourceFiles(fullPath);
    return entry.isFile() && entry.name.endsWith(".rs") ? [fullPath] : [];
  });
}

function relativePath(root, path) {
  return normalize(path).replace(`${normalize(root)}/`, "");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runMacosReleaseReadiness();
  console.log(`${READINESS_PREFIX}${JSON.stringify(result)}`);
  if (process.argv.includes("--expect-signing-free")) {
    try {
      assertSigningFreeReadiness(result);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
  if (result.status === "error" || process.argv.includes("--strict") && result.status !== "ok") {
    process.exitCode = 1;
  }
}

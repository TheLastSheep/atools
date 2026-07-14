import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const scriptUrl = pathToFileURL(new URL("check-macos-release-readiness.mjs", import.meta.url).pathname).href;
const readiness = await import(scriptUrl);

const output = [
  "preflight",
  'ATOOLS_MACOS_RELEASE_READINESS {"status":"warn","summary":{"ok":2,"warn":1,"error":0},"checks":[{"id":"bundle-active","status":"ok","message":"bundle.active is enabled"}]}',
  "done",
].join("\n");
const parsed = readiness.parseReadinessOutput(output);
assert.equal(parsed.status, "warn");
assert.equal(parsed.summary.ok, 2);
assert.equal(parsed.checks[0].id, "bundle-active");
assert.throws(() => readiness.parseReadinessOutput("missing"), /Missing ATOOLS_MACOS_RELEASE_READINESS/);

const incomplete = readiness.evaluateMacosReleaseReadiness({
  config: {
    identifier: "dev.atools.app",
    bundle: {
      active: true,
      targets: "all",
      macOS: {
        minimumSystemVersion: "10.15",
        signingIdentity: null,
        providerShortName: null,
        entitlements: null,
      },
    },
  },
  env: {},
  files: new Set(),
});
assert.equal(incomplete.status, "warn");
assert.equal(incomplete.summary.error, 0);
assert.equal(incomplete.checks.find((check) => check.id === "signing-identity")?.status, "warn");
assert.equal(incomplete.checks.find((check) => check.id === "bundle-identifier")?.status, "warn");
assert.equal(incomplete.checks.find((check) => check.id === "updater-config")?.status, "warn");
assert.equal(incomplete.checks.find((check) => check.id === "crash-recovery")?.status, "warn");
assert.equal(incomplete.checks.find((check) => check.id === "crash-log-ui")?.status, "warn");

const ready = readiness.evaluateMacosReleaseReadiness({
  config: {
    identifier: "dev.atools.desktop",
    bundle: {
      active: true,
      targets: ["app", "dmg", "updater"],
      createUpdaterArtifacts: true,
      macOS: {
        minimumSystemVersion: "10.15",
        signingIdentity: "Developer ID Application: Example",
        providerShortName: "TEAM",
        entitlements: "src-tauri/Entitlements.plist",
      },
    },
    plugins: {
      updater: {
        pubkey: "public-key",
        endpoints: ["https://example.com/latest.json"],
      },
    },
  },
  env: {
    APPLE_ID: "dev@example.com",
    APPLE_PASSWORD: "app-password",
    APPLE_TEAM_ID: "TEAMID",
  },
  files: new Set(["src-tauri/Entitlements.plist", "docs/macos-smoke-checklist.md"]),
  hasPanicHook: true,
  hasCrashLogUi: true,
});
assert.equal(ready.status, "ok");
assert.equal(ready.summary.warn, 0);
assert.equal(ready.summary.error, 0);
assert.equal(ready.checks.find((check) => check.id === "bundle-identifier")?.status, "ok");
assert.equal(ready.checks.find((check) => check.id === "notarization-credentials")?.status, "ok");

const currentProject = readiness.runMacosReleaseReadiness({
  root: new URL("../", import.meta.url).pathname,
  env: {},
});
assert.doesNotThrow(() => readiness.assertSigningFreeReadiness(currentProject));
assert.throws(
  () => readiness.assertSigningFreeReadiness(ready),
  /Expected signing-free readiness/,
);
assert.equal(currentProject.checks.find((check) => check.id === "crash-recovery")?.status, "ok");
assert.equal(currentProject.checks.find((check) => check.id === "crash-log-ui")?.status, "ok");
assert.equal(currentProject.checks.find((check) => check.id === "entitlements")?.status, "ok");
assert.equal(currentProject.checks.find((check) => check.id === "bundle-identifier")?.status, "ok");

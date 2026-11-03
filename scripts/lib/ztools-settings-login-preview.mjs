import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  captureSettingsAliasIdentity,
  compileSettingsAliasTransport,
  createSettingsAliasBootstrap,
  preflightSettingsAliasIdentity,
} from "./ztools-settings-alias-browser-fixture.mjs";
import { startZtoolsSettingsInputStaticServer } from "./ztools-settings-input-browser-server.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const settingsRoot = join(root, "packages/ztools-settings");
const settingsDist = join(settingsRoot, "dist");
const rendererDist = join(root, "packages/ztools-renderer/dist");
const outputRootName = "renderer-legacy-login-integration-2026-10-29";
const fixturePath = join(root, "tests/components/ztoolsSettingsAliasNativeTransportFixture.ts");
const authoredPaths = [
  "packages/ztools-settings/src/childBridge.ts",
  "packages/ztools-settings/src/childBridgeApi.ts",
  "packages/ztools-settings/src/childBridgeLaunchAtLogin.ts",
  "packages/ztools-settings/src/childBridgeTypes.ts",
  "packages/ztools-settings/src/compatibility-patches/general-save.mjs",
  "packages/ztools-settings/src/hostBridgeEntry.ts",
  "packages/ztools-settings/src/launchAtLoginContract.ts",
  "packages/ztools-settings/src/launchAtLoginController.ts",
  "scripts/lib/ztools-settings-alias-browser-fixture.mjs",
  "scripts/lib/ztools-settings-input-browser-server.mjs",
  "scripts/lib/ztools-settings-login-preview.mjs",
  "scripts/lib/ztools-settings-login-preview.test.mjs",
  "scripts/lib/ztools_settings_login_preview_paths.py",
  "scripts/lib/ztools_settings_login_preview_paths_test.py",
  "scripts/test-ztools-settings-login-browser.py",
  "tests/components/ztoolsSettingsAliasNativeTransportFixture.ts",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function requireRealDirectory(path, expectedPath, label) {
  const entry = await lstat(path);
  assert.ok(entry.isDirectory() && !entry.isSymbolicLink(), `${label} must be a real directory`);
  assert.equal(await realpath(path), expectedPath, `${label} must stay at its fixed path`);
}

async function createOrCheckOutputRoot(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(path, { recursive: false, mode: 0o700 });
  }
  await requireRealDirectory(path, path, "preview output root");
}

export async function prepareLoginPreviewDirectories(repositoryRoot, runId) {
  const repo = resolve(repositoryRoot);
  assert.equal(repositoryRoot, repo, "repository root must be canonical");
  assert.match(runId, /^[0-9a-f]{32}$/, "run identifier must be 32 lowercase hex characters");
  const rootEntry = await lstat(repo);
  assert.ok(rootEntry.isDirectory() && !rootEntry.isSymbolicLink(), "repository root must be a real directory");
  assert.equal(await realpath(repo), repo, "repository root must not contain a symlinked ancestor");
  const packageEntry = await lstat(join(repo, "package.json"));
  assert.ok(packageEntry.isFile() && !packageEntry.isSymbolicLink(), "repository marker must be a regular file");

  const outputParent = join(repo, "output");
  await requireRealDirectory(outputParent, outputParent, "repository output parent");
  const outputRoot = join(outputParent, outputRootName);
  await createOrCheckOutputRoot(outputRoot);
  const outputDir = join(outputRoot, `browser-${runId}`);
  await mkdir(outputDir, { recursive: false, mode: 0o700 });
  await requireRealDirectory(outputDir, outputDir, "preview run directory");
  return { outputRoot, outputDir };
}

function compactIdentity(identity) {
  return {
    provenanceSha256: identity.provenanceSha256,
    sourceManifestSha256: identity.manifestSha256,
    dist: {
      fileCount: identity.dist.count,
      totalBytes: identity.dist.bytes,
      sha256: identity.dist.sha256,
    },
    hostBridge: {
      fileCount: identity.bridge.count,
      totalBytes: identity.bridge.bytes,
      sha256: identity.bridge.sha256,
    },
    authoredFiles: identity.sourceFiles,
    build: {
      status: identity.provenance.status,
      typecheckPassed: identity.provenance.typecheckPassed,
      outputRoot: identity.provenance.build?.outputRoot,
      sourceCommit: identity.provenance.source?.commit,
    },
  };
}

async function assertFreshLoginPreviewDist(identity) {
  preflightSettingsAliasIdentity(identity);
  const patchPath = "packages/ztools-settings/src/compatibility-patches/general-save.mjs";
  const patchInput = identity.provenance.build?.localBuildInputs?.find((entry) => entry.path === patchPath);
  assert.ok(patchInput, "Strict dist provenance must include the General launch-at-login patch input");
  assert.equal(patchInput.sha256, identity.sourceFiles[patchPath]?.sha256,
    "General launch-at-login patch changed after the strict settings build");

  const resources = identity.provenance.emittedResources;
  assert.ok(Array.isArray(resources) && resources.some((entry) => entry.path === "index.html"),
    "Strict settings dist must enumerate its index document");
  const javascript = [];
  for (const resource of resources) {
    assert.equal(typeof resource.path, "string");
    assert.ok(/^(?:index\.html|logo\.png|plugin\.json|preload\/package\.json|assets\/[A-Za-z0-9._-]+)$/.test(resource.path),
      "Settings dist provenance contains an unsafe resource path");
    if (resource.path.endsWith(".js")) {
      javascript.push(await readFile(join(settingsDist, resource.path), "utf8"));
    }
  }
  const bundled = javascript.join("\n");
  for (const marker of [
    "暂不处理", "关闭旧启动项", "迁移到新机制", "重新读取", "aria-checked", "mixed", "readLaunchAtLogin",
  ]) {
    assert.ok(bundled.includes(marker), `Strict settings dist is missing the current launch-at-login UI/bridge marker: ${marker}`);
  }
}

function createLoginPreviewWrapper(baseBootstrap) {
  return `${baseBootstrap}\n;(() => {
    const core = window.__TAURI__?.core;
    if (!core || typeof core.invoke !== "function") throw new Error("preview transport is unavailable");
    const originalInvoke = core.invoke;
    const modes = new Set(["legacy", "normal", "coexisting"]);
    const mode = window.__ATOOLS_SETTINGS_LOGIN_PREVIEW_MODE__;
    if (!modes.has(mode)) throw new Error("invalid synthetic launch-at-login mode");
    const config = window.__ATOOLS_SETTINGS_VIEW_CONFIG__;
    const calls = [];
    let legacyPresent = mode !== "normal";
    let modernEnabled = mode === "coexisting";
    let revisionCounter = 1;
    let revision = String(revisionCounter).padStart(64, "0");
    let resolveMutationCount = 0;
    let setMutationCount = 0;
    const clone = value => JSON.parse(JSON.stringify(value));
    const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
    const fixedError = code => Object.assign(new Error(code), { code });
    const bumpRevision = () => {
      revisionCounter += 1;
      revision = String(revisionCounter).padStart(64, "0");
    };
    const loginOperations = new Set([
      "ready", "readLaunchAtLogin", "setLaunchAtLogin",
      "inspectLegacyLaunchAtLogin", "resolveLegacyLaunchAtLogin",
    ]);

    function snapshot() {
      const operationCounts = {};
      for (const call of calls) operationCounts[call.operation] = (operationCounts[call.operation] || 0) + 1;
      return {
        mode, calls: clone(calls), operationCounts, legacyPresent, modernEnabled, revision,
        resolveMutationCount, setMutationCount,
      };
    }

    core.invoke = async (command, args = {}) => {
      const operation = args?.operation;
      if (command !== "call_renderer_settings" || !loginOperations.has(operation)) {
        return originalInvoke(command, args);
      }
      if (args.sessionId !== config.sessionId || !exactKeys(args, ["sessionId", "operation", "payload"])) {
        throw fixedError("ERR_ATOOLS_SETTINGS_PROTOCOL");
      }
      const payload = args.payload;
      const call = { operation, status: "pending", errorCode: null };
      calls.push(call);
      try {
        let reply;
        if (operation === "ready") {
          // The actual bridge still builds the ready reply; only its launch-item facts are synthetic here.
          if (!exactKeys(payload, [])) throw fixedError("ERR_ATOOLS_SETTINGS_PROTOCOL");
          reply = clone(await originalInvoke(command, args));
          reply.runtime.launchAtLogin = legacyPresent ? null : modernEnabled;
          reply.runtime.launchAtLoginAvailable = true;
        } else if (operation === "readLaunchAtLogin") {
          if (!exactKeys(payload, [])) throw fixedError("ERR_ATOOLS_SETTINGS_PROTOCOL");
          if (legacyPresent) throw fixedError("SETTINGS_LAUNCH_AT_LOGIN_LEGACY_CONFIGURATION");
          reply = { enabled: modernEnabled };
        } else if (operation === "inspectLegacyLaunchAtLogin") {
          if (!exactKeys(payload, [])) throw fixedError("ERR_ATOOLS_SETTINGS_PROTOCOL");
          if (!legacyPresent) throw fixedError("SETTINGS_LAUNCH_AT_LOGIN_CONFLICT");
          reply = { modernEnabled, revision };
        } else if (operation === "setLaunchAtLogin") {
          if (!exactKeys(payload, ["enabled", "expected"])
              || typeof payload.enabled !== "boolean" || typeof payload.expected !== "boolean") {
            throw fixedError("ERR_ATOOLS_SETTINGS_PROTOCOL");
          }
          if (legacyPresent) throw fixedError("SETTINGS_LAUNCH_AT_LOGIN_LEGACY_CONFIGURATION");
          if (payload.expected !== modernEnabled) throw fixedError("SETTINGS_LAUNCH_AT_LOGIN_CONFLICT");
          modernEnabled = payload.enabled;
          setMutationCount += 1;
          bumpRevision();
          reply = { enabled: modernEnabled };
        } else {
          if (!exactKeys(payload, ["choice", "expectedModern", "revision"])
              || !["turnOff", "migrate"].includes(payload.choice)
              || typeof payload.expectedModern !== "boolean"
              || typeof payload.revision !== "string" || !/^[0-9a-f]{64}$/.test(payload.revision)) {
            throw fixedError("ERR_ATOOLS_SETTINGS_PROTOCOL");
          }
          if (!legacyPresent || payload.expectedModern !== modernEnabled || payload.revision !== revision) {
            throw fixedError("SETTINGS_LAUNCH_AT_LOGIN_CONFLICT");
          }
          modernEnabled = payload.choice === "migrate";
          legacyPresent = false;
          resolveMutationCount += 1;
          bumpRevision();
          reply = { enabled: modernEnabled };
        }
        call.status = "resolved";
        return clone(reply);
      } catch (error) {
        call.status = "rejected";
        call.errorCode = typeof error?.code === "string" ? error.code : "ERR_ATOOLS_SETTINGS_UNAVAILABLE";
        throw fixedError(call.errorCode);
      }
    };

    window.__ATOOLS_SETTINGS_LOGIN_PREVIEW__ = Object.freeze({
      snapshot,
      externalChange(change) {
        if (!exactKeys(change, Object.hasOwn(change, "enabled") ? ["enabled"] : ["revisionOnly"])
            || (Object.hasOwn(change, "enabled") && typeof change.enabled !== "boolean")
            || (Object.hasOwn(change, "revisionOnly") && change.revisionOnly !== true)) {
          throw new TypeError("invalid synthetic external change");
        }
        if (Object.hasOwn(change, "enabled")) modernEnabled = change.enabled;
        bumpRevision();
        return { modernEnabled, revision };
      },
    });
  })();`;
}

async function captureIdentity() {
  const identity = await captureSettingsAliasIdentity({
    root,
    distRoot: settingsDist,
    authoredFiles: authoredPaths.map((path) => join(root, path)),
  });
  return identity;
}

async function serve() {
  assert.deepEqual(process.argv.slice(2), ["--serve"], "Only the owned --serve mode is supported");
  const runId = randomUUID();
  const identityBefore = await captureIdentity();
  await assertFreshLoginPreviewDist(identityBefore);
  const fixtureBundle = await compileSettingsAliasTransport({ settingsRoot, fixturePath });
  const baseBootstrap = createSettingsAliasBootstrap({
    fixtureBundle: `${fixtureBundle.source}\nwindow.SettingsAliasTransportFixtureModule = SettingsAliasTransportFixtureModule;`,
    aliases: {},
    documentKey: `login-preview:${runId}`,
    runId,
    appName: "ATools Login Browser Fixture",
    appPath: "/Applications/ATools-Login-Browser-Fixture.app",
  });
  const bootstrap = createLoginPreviewWrapper(baseBootstrap);
  const runToken = runId.replaceAll("-", "");
  const { outputDir } = await prepareLoginPreviewDirectories(root, runToken);
  const bootstrapPath = join(outputDir, "bootstrap.js");
  await writeFile(bootstrapPath, bootstrap, { flag: "wx", mode: 0o600 });

  const resources = identityBefore.provenance.emittedResources.map((entry) => entry.path);
  const servedPaths = [...new Set(["index.html", ...resources])].sort();
  const server = await startZtoolsSettingsInputStaticServer({
    distRoots: { main: rendererDist, setting: settingsDist },
    servedPaths: { main: ["index.html"], setting: servedPaths },
  });
  assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const ready = {
    type: "ready",
    schemaVersion: 1,
    runId: runToken,
    origin: server.origin,
    outputDir: relative(root, outputDir).split(sep).join("/"),
    bootstrapPath: relative(root, bootstrapPath).split(sep).join("/"),
    bootstrapSha256: sha256(Buffer.from(bootstrap)),
    fixtureBundleSha256: fixtureBundle.sha256,
    sourceIdentity: { before: compactIdentity(identityBefore), after: null, stable: null },
    staticServer: { host: "127.0.0.1", randomPort: server.port },
  };
  let stopping = false;
  let stopPromise = null;
  async function stop() {
    if (stopping) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      const serverState = await server.close();
      const identityAfter = await captureIdentity();
      const after = compactIdentity(identityAfter);
      const stable = isDeepStrictEqual(ready.sourceIdentity.before, after);
      process.stdout.write(`${JSON.stringify({
        type: "closed", schemaVersion: 1, runId: ready.runId,
        sourceIdentity: { after, stable },
        staticServer: {
          closed: serverState.closed === true,
          rejectedRequests: serverState.rejected,
          requestCount: serverState.requests.length,
          bytesServed: serverState.bytesServed,
          browserGeneratedFaviconRequests: serverState.browserGeneratedFavicon.requestCount,
        },
      })}\n`);
    })();
    return stopPromise;
  }
  process.once("SIGTERM", () => { void stop().catch(() => { process.exitCode = 1; }); });
  process.once("SIGINT", () => { void stop().catch(() => { process.exitCode = 1; }); });
  process.stdout.write(`${JSON.stringify(ready)}\n`);
  await new Promise((resolvePromise) => {
    process.once("beforeExit", resolvePromise);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  serve().catch((error) => {
    process.stderr.write(`settings-login-preview: ${String(error?.message || error).slice(0, 500)}\n`);
    process.exitCode = 1;
  });
}

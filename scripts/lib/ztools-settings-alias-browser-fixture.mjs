import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { captureHostBridgeSources } from "../../packages/ztools-settings/src/host-bridge-build.mjs";

const coreGeneralSourceBytes = await readFile(
  new URL("../../crates/atools-core/src/db/renderer_general_settings.rs", import.meta.url),
);
const FROZEN_RENDERER_GENERAL_PREFIX = [
  "placeholder", "theme", "primaryColor", "customColor", "autoClear", "showRecentInSearch",
  "recentRows", "pinnedRows", "searchMode", "showMatchRecommendation", "tabKeyFunction",
  "tabTargetCommand", "spaceOpenCommand", "localAppSearch", "opacity", "showTrayIcon", "hotkey",
  "windowPositionStrategy", "clipboardRetentionDays", "autoBackToSearch", "autoPaste", "builtinAppShortcutsEnabled",
];
const RENDERER_GENERAL_FIXED_APPEND = ["windowDefaultHeight", "autoCheckUpdate"];
const RENDERER_GENERAL_FIELDS = [...FROZEN_RENDERER_GENERAL_PREFIX, ...RENDERER_GENERAL_FIXED_APPEND];
const parsedCoreGeneralSource = parseRendererGeneralSourceBytes(coreGeneralSourceBytes);
const editableGeneralFields = parsedCoreGeneralSource.fields;
export const RENDERER_GENERAL_SETTINGS_SOURCE_SHA256 = parsedCoreGeneralSource.sha256;

export function parseRendererGeneralSourceBytes(sourceBytes) {
  if (!(sourceBytes instanceof Uint8Array)) {
    throw new TypeError("Core renderer General source must be a byte array");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
  const fields = Object.freeze(parseRendererGeneralFields(source));
  return Object.freeze({ fields, sha256: sha(sourceBytes) });
}

export function parseRendererGeneralFields(source) {
  const declaration = source.match(
    /pub const RENDERER_GENERAL_SETTINGS_FIELDS:\s*\[&str;\s*(\d+)\]\s*=\s*\[([\s\S]*?)\];/,
  );
  if (!declaration) throw new Error("Core renderer General capability declaration was not found");
  const fields = Array.from(declaration[2].matchAll(/"([^"\\]+)"/g), (match) => match[1]);
  const validLength = fields.length === RENDERER_GENERAL_FIELDS.length || fields.length === RENDERER_GENERAL_FIELDS.length - 1;
  if (!validLength || Number(declaration[1]) !== fields.length
      || fields.some((field, index) => field !== RENDERER_GENERAL_FIELDS[index])) {
    throw new Error("Core renderer General capability declaration has an invalid fixed append");
  }
  return fields;
}

function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function hashTree(directory) {
  const files = {};
  let bytes = 0;
  async function walk(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Refusing symlink in source snapshot: ${absolute}`);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Unsupported source snapshot entry: ${absolute}`);
      const content = await readFile(absolute);
      const path = relative(directory, absolute).split(sep).join("/");
      files[path] = sha(content);
      bytes += content.byteLength;
    }
  }
  await walk(directory);
  const digest = createHash("sha256");
  for (const [path, hash] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    digest.update(path).update("\0").update(hash).update("\0");
  }
  return { count: Object.keys(files).length, bytes, sha256: digest.digest("hex"), files };
}

export async function captureSettingsAliasIdentity({ root, distRoot, authoredFiles }) {
  const bridge = await captureHostBridgeSources(root);
  const dist = await hashTree(distRoot);
  const provenanceBytes = await readFile(join(distRoot, "build-provenance.json"));
  const provenance = JSON.parse(provenanceBytes.toString("utf8"));
  const manifestBytes = await readFile(join(distRoot, "source-manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const sourceFiles = {};
  for (const path of authoredFiles) {
    const content = await readFile(path);
    sourceFiles[relative(root, path).split(sep).join("/")] = { bytes: content.byteLength, sha256: sha(content) };
  }
  return {
    bridge: {
      count: bridge.count,
      bytes: bridge.bytes,
      sha256: bridge.sha256,
      files: bridge.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    },
    provenanceSha256: sha(provenanceBytes),
    manifestSha256: sha(manifestBytes),
    dist,
    sourceFiles,
    provenance,
    manifest,
  };
}

export function preflightSettingsAliasIdentity(identity) {
  const { bridge, provenance, manifest } = identity;
  assert.equal(process.versions.node, "22.23.3", "Run with the product Node v22.23.3 binary");
  assert.equal(provenance.status, "strict/typecheck-passed", "Settings dist must be the strict frozen artifact");
  assert.equal(provenance.build?.outputRoot, "packages/ztools-settings/dist");
  assert.equal(provenance.source?.commit, "9b15fb1a2a9f3ec886016632761c7bb21e39557a");
  assert.equal(manifest.source?.commit, provenance.source.commit, "Dist provenance must match the pinned manifest");
  const declared = provenance.build?.hostBridgeSources;
  assert.ok(declared, "Settings dist must record host bridge provenance");
  assert.equal(declared.count, bridge.count, "Host bridge source count differs from the frozen dist");
  assert.equal(declared.bytes, bridge.bytes, "Host bridge source bytes differ from the frozen dist");
  assert.equal(declared.sha256, bridge.sha256, "Host bridge source hash differs from the frozen dist");
  assert.deepEqual(declared.files, bridge.files, "Host bridge source file hashes differ from the frozen dist");
  for (const required of ["childBridgeAliases.ts", "childBridgeCommandData.ts", "hostBridgeEntry.ts"]) {
    assert.ok(declared.runtimeImports.some((path) => path.endsWith(`/${required}`)),
      `Frozen settings dist is missing runtime import ${required}`);
  }
}

export function createSettingsAliasSeed(appCommandId) {
  return {
    "direct:app:/Applications/removed.app": ["legacy orphan alias"],
    "missing-plugin:feature:old-command:text": [{ alias: "uninstalled plugin alias" }],
    [appCommandId]: ["legacy current alias"],
  };
}

export function createGeneral() {
  return {
    opacity: 1,
    windowDefaultHeight: 541,
    hotkey: "Option+Z",
    placeholder: "搜索应用和指令 / 粘贴文件或图片",
    avatar: null,
    autoPaste: "off",
    autoClear: "immediately",
    autoBackToSearch: "never",
    windowPositionStrategy: "remember",
    showRecentInSearch: true,
    showMatchRecommendation: true,
    localAppSearch: true,
    recentRows: 2,
    pinnedRows: 2,
    searchMode: "aggregate",
    tabKeyFunction: "navigate",
    tabTargetCommand: "",
    spaceOpenCommand: false,
    floatingBallDoubleClickCommand: "",
    floatingBallEnabled: false,
    floatingBallLetter: "Z",
    superPanelEnabled: false,
    superPanelMouseButton: "middle",
    superPanelLongPressMs: 500,
    superPanelBlockedApps: [],
    wakeupBlacklist: [],
    superPanelTranslateEnabled: false,
    theme: "dark",
    primaryColor: "green",
    customColor: "#db2777",
    showTrayIcon: true,
    windowMaterial: "none",
    acrylicLightOpacity: 78,
    acrylicDarkOpacity: 50,
    devToolsMode: "detach",
    disableGpuAcceleration: false,
    customInternalApiPluginNames: [],
    proxyEnabled: false,
    proxyUrl: "",
    autoCheckUpdate: true,
    clipboardRetentionDays: 180,
    builtinAppShortcutsEnabled: { search: true, esc: true, closePlugin: true },
    terminal: "default",
    terminalCustomCommand: "",
  };
}

export async function compileSettingsAliasTransport({ settingsRoot, fixturePath }) {
  const esbuild = createRequire(join(settingsRoot, "package.json"))("esbuild");
  const result = await esbuild.build({
    entryPoints: [fixturePath],
    outfile: "settings-alias-transport.js",
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    globalName: "SettingsAliasTransportFixtureModule",
    target: "es2022",
    legalComments: "none",
  });
  assert.equal(result.outputFiles.length, 1, "The synthetic alias transport should emit one in-memory browser bundle");
  const output = result.outputFiles[0];
  assert.ok(output, "The synthetic alias transport TypeScript fixture must compile to JavaScript");
  const source = output.text;
  return { source, sha256: sha(Buffer.from(source)) };
}

export function createSettingsAliasBootstrap({
  fixtureBundle,
  aliases,
  documentKey,
  runId,
  appName,
  appPath,
}) {
  const config = {
    version: 1,
    sessionId: runId.replaceAll("-", ""),
    bundleRevision: createHash("sha256").update(runId).digest("hex"),
    platform: "darwin",
  };
  return `${fixtureBundle}\n;(() => {
    const fixtureModule = window.SettingsAliasTransportFixtureModule;
    const config = ${JSON.stringify(config)};
    const catalog = fixtureModule.createFixtureCommandCatalog(1024);
    catalog.commands = catalog.commands.map(command => ({ ...command, icon: "" }));
    catalog.commands[0] = { ...catalog.commands[0], name: ${JSON.stringify(appName)}, path: ${JSON.stringify(appPath)}, icon: "" };
    const fixture = new fixtureModule.SettingsAliasNativeTransportFixture({
      commands: catalog, aliases: ${JSON.stringify(aliases)}, aliasStoragePresent: true, pageBytes: 32 * 1024
    });
    const general = ${JSON.stringify(createGeneral())};
    const calls = [];
    const catalogReads = [];
    let generalRevision = "rev-1";
    let theme = "dark";
    let opacity = 1;
    const copy = value => JSON.parse(JSON.stringify(value));
    const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const editableGeneralFields = ${JSON.stringify(editableGeneralFields)};
    const makeReady = () => ({
      version: 1, sessionId: config.sessionId, bundleRevision: config.bundleRevision, platform: config.platform,
      general: { revision: generalRevision, value: copy(general) },
      runtime: {
        currentShortcut: general.hotkey, launchAtLogin: true, launchAtLoginAvailable: true,
        opacity, theme, themeApplied: true, opacityApplied: true
      },
      capabilities: { editableGeneralFields: [...editableGeneralFields] },
      action: { code: "main", type: "text", payload: "" }
    });
    async function invoke(command, args = {}) {
      if (command !== "call_renderer_settings") throw new Error("Synthetic fixture rejected command " + command);
      const operation = args.operation;
      const payload = args.payload || {};
      const call = { operation, status: "pending", payloadBytes: bytes(payload), replyBytes: 0, errorCode: null };
      calls.push(call);
      let reply;
      try {
        if (operation === "ready") reply = makeReady();
        else if (operation === "readGeneral") reply = { revision: generalRevision, value: copy(general) };
        else if (operation === "patchGeneral") {
          Object.assign(general, copy(payload.changes));
          generalRevision = "rev-" + (Number(generalRevision.slice(4)) + 1);
          reply = { revision: generalRevision, value: copy(general), notificationDelivered: true };
        } else if (operation === "setTheme") {
          theme = payload.theme;
          reply = { theme, themeApplied: true };
        } else if (operation === "setWindowOpacity") {
          opacity = payload.opacity;
          reply = { opacity, opacityApplied: true };
        } else {
          reply = await fixture.invoke(operation, payload, args.sessionId);
        }
        call.replyBytes = bytes(reply);
        call.status = "resolved";
        if (operation === "readCommands") {
          catalogReads.push({
            token: reply.token,
            totalBytes: reply.totalBytes,
            pages: [{ offset: reply.offset, nextOffset: reply.nextOffset, totalBytes: reply.totalBytes }],
          });
        }
        if (operation === "readCommandDataPage" && payload.kind === "commands") {
          const read = catalogReads.findLast(item => item.token === reply.token);
          if (read) read.pages.push({ offset: reply.offset, nextOffset: reply.nextOffset, totalBytes: reply.totalBytes });
        }
        return reply;
      } catch (error) {
        call.status = "rejected";
        call.errorCode = error && typeof error.code === "string" ? error.code : "UNKNOWN";
        throw Object.assign(new Error(error?.message || String(error)), { code: call.errorCode });
      }
    }
    Object.defineProperty(window, "__ATOOLS_SETTINGS_VIEW_CONFIG__", {
      value: config, writable: false, configurable: false
    });
    window.__TAURI__ = { core: { invoke } };
    window.__ATOOLS_SETTINGS_ALIAS_FIXTURE__ = {
      documentKey: ${JSON.stringify(documentKey)}, fixture,
      triggerAliasConflict() { fixture.replaceAliasesExternally(fixture.getAliases(), true); },
      snapshot() {
        const operationCounts = {};
        let maximumPayloadBytes = 0;
        let maximumReplyBytes = 0;
        for (const call of calls) {
          operationCounts[call.operation] = (operationCounts[call.operation] || 0) + 1;
          maximumPayloadBytes = Math.max(maximumPayloadBytes, call.payloadBytes);
          maximumReplyBytes = Math.max(maximumReplyBytes, call.replyBytes);
        }
        return {
          documentKey: ${JSON.stringify(documentKey)}, calls: copy(calls), operationCounts,
          maximumPayloadBytes, maximumReplyBytes, catalogReads: copy(catalogReads),
          expectedCatalogRows: { commands: catalog.commands.length, regexCommands: catalog.regexCommands.length, plugins: catalog.plugins.length },
          aliases: fixture.getAliases(), aliasStoragePresent: fixture.hasAliasStorageFact
        };
      }
    };
  })();`;
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";

import {
  compileSettingsAliasTransport,
  createGeneral,
  createSettingsAliasBootstrap,
  createSettingsAliasSeed,
  parseRendererGeneralFields,
  parseRendererGeneralSourceBytes,
  RENDERER_GENERAL_SETTINGS_SOURCE_SHA256,
} from "./ztools-settings-alias-browser-fixture.mjs";

const fields = [
  "placeholder", "theme", "primaryColor", "customColor", "autoClear", "showRecentInSearch",
  "recentRows", "pinnedRows", "searchMode", "showMatchRecommendation", "tabKeyFunction",
  "tabTargetCommand", "spaceOpenCommand", "localAppSearch", "opacity", "showTrayIcon", "hotkey",
  "windowPositionStrategy", "clipboardRetentionDays", "autoBackToSearch", "autoPaste", "builtinAppShortcutsEnabled",
  "windowDefaultHeight", "autoCheckUpdate",
];

function declaration(values = fields, count = values.length) {
  return `pub const RENDERER_GENERAL_SETTINGS_FIELDS: [&str; ${count}] = [${values.map(JSON.stringify).join(", ")}];`;
}

test("parses current and historical fixed General appends", () => {
  assert.deepEqual(parseRendererGeneralFields(declaration()), fields);
  assert.deepEqual(parseRendererGeneralFields(declaration(fields.slice(0, -1))), fields.slice(0, -1));
});

test("parses fields and hashes the exact same immutable byte input", () => {
  const sourceBytes = Buffer.from(declaration());
  const expectedHash = createHash("sha256").update(sourceBytes).digest("hex");
  const parsed = parseRendererGeneralSourceBytes(sourceBytes);
  sourceBytes.fill(0);

  assert.deepEqual(parsed.fields, fields);
  assert.equal(parsed.sha256, expectedHash);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.fields));
  assert.equal(Object.hasOwn(parsed, "sourceBytes"), false);

  const bomBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(declaration())]);
  const parsedBom = parseRendererGeneralSourceBytes(bomBytes);
  assert.deepEqual(parsedBom.fields, fields);
  assert.equal(parsedBom.sha256, createHash("sha256").update(bomBytes).digest("hex"));
  assert.notEqual(parsedBom.sha256, parsed.sha256);
});

test("exports the digest for the Core source parsed during module import", async () => {
  const coreSourceBytes = await readFile(
    new URL("../../crates/atools-core/src/db/renderer_general_settings.rs", import.meta.url),
  );
  const expectedHash = createHash("sha256").update(coreSourceBytes).digest("hex");
  assert.deepEqual(parseRendererGeneralSourceBytes(coreSourceBytes).fields, fields);
  assert.equal(RENDERER_GENERAL_SETTINGS_SOURCE_SHA256, expectedHash);
});

test("generated ready reply passes the real Settings protocol validator", async () => {
  const settingsRoot = fileURLToPath(new URL("../../packages/ztools-settings/", import.meta.url));
  const esbuild = createRequire(new URL("../../packages/ztools-settings/package.json", import.meta.url))("esbuild");
  const protocolBuild = await esbuild.build({
    entryPoints: [fileURLToPath(new URL("../../packages/ztools-settings/src/childBridgeProtocol.ts", import.meta.url))],
    outfile: "child-bridge-protocol.js",
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "es2022",
  });
  assert.equal(protocolBuild.outputFiles.length, 1);
  const protocolModule = await import(
    `data:text/javascript;base64,${Buffer.from(protocolBuild.outputFiles[0].contents).toString("base64")}`,
  );
  const fixtureBuild = await compileSettingsAliasTransport({
    settingsRoot,
    fixturePath: fileURLToPath(new URL("../../tests/components/ztoolsSettingsAliasNativeTransportFixture.ts", import.meta.url)),
  });
  const appPath = "/Applications/ready-projection-fixture.app";
  const bootstrap = createSettingsAliasBootstrap({
    fixtureBundle: fixtureBuild.source,
    aliases: createSettingsAliasSeed(`direct:app:${appPath}`),
    documentKey: "general-ready-projection",
    runId: "4ba0350e-a01a-4ca0-b759-05a10ec15ce0",
    appName: "Ready Projection Fixture App",
    appPath,
  });
  const sandbox = { TextEncoder, TextDecoder, btoa, atob };
  sandbox.window = sandbox;
  runInNewContext(bootstrap, sandbox, { timeout: 1_000 });
  const config = sandbox.__ATOOLS_SETTINGS_VIEW_CONFIG__;
  const readyReply = await sandbox.__TAURI__.core.invoke("call_renderer_settings", {
    operation: "ready",
    payload: {},
  });
  const transportedReadyReply = JSON.parse(JSON.stringify(readyReply));
  const transportedConfig = JSON.parse(JSON.stringify(config));
  let validationError;
  try {
    protocolModule.validateReadyReply(transportedReadyReply, transportedConfig);
  } catch (error) {
    validationError = error;
  }
  const general = transportedReadyReply.general.value;
  const failureDetails = validationError
    ? `${validationError.code ?? validationError.message}; keys=${Object.keys(general).length}; builtin=${Object.hasOwn(general, "builtinAppShortcutsEnabled")}`
    : "none";
  assert.equal(validationError?.code, undefined, `Generated ready reply failed actual validator: ${failureDetails}`);
  assert.equal(Object.keys(general).length, 44);
  assert.deepEqual(general.builtinAppShortcutsEnabled, { search: true, esc: true, closePlugin: true });
});

test("keeps the browser fixture's existing explicit numeric window height", () => {
  assert.equal(createGeneral().windowDefaultHeight, 541);
});

test("rejects a truncated 22-field prefix, extra unknown fields, and altered appends", () => {
  const stale = fields.slice(0, -2);
  const reordered = [...fields];
  [reordered[22], reordered[23]] = [reordered[23], reordered[22]];
  const prefixSwapped = [...fields];
  [prefixSwapped[0], prefixSwapped[1]] = [prefixSwapped[1], prefixSwapped[0]];
  const unknownReplacement = [...fields];
  unknownReplacement[23] = "autoCheckUnknown";
  const duplicate = [...fields.slice(0, -1), "windowPositionStrategy"];
  const extraUnknown = [...fields, "futureGeneralPreference"];
  for (const source of [
    declaration(stale), declaration(reordered), declaration(prefixSwapped), declaration(unknownReplacement),
    declaration(duplicate), declaration(extraUnknown), declaration(fields, 22),
  ]) {
    assert.throws(() => parseRendererGeneralFields(source), /invalid fixed append/);
  }
});

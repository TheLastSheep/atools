import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { classifySettingsInputSlice, isKnownUpdaterUnavailableError } from "./lib/ztools-settings-input-browser-acceptance.mjs";
import { rendererFixtureTransportScript } from "../tests/fixtures/ztools-renderer-host/fixture-transport.mjs";

const UPDATER_UNAVAILABLE_TEXT =
  "检查更新状态失败: ZToolsRendererHostError: ATools does not provide the ZTools method: updater.getDownloadStatus()";

function createFixture() {
  const window = { location: { href: "http://127.0.0.1/?color=green" } };
  runInNewContext(rendererFixtureTransportScript(), { window, URL, structuredClone });
  return {
    transport: window.__ATOOLS_ZTOOLS_RENDERER_TRANSPORT__,
    fixture: window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__,
  };
}

function classify(overrides = {}) {
  return classifySettingsInputSlice({
    mode: "acceptance",
    acceptanceCompleted: true,
    checksCount: 10,
    sourceStable: true,
    resourcesClean: true,
    cleanupErrorCount: 0,
    updaterCapability: "limited",
    consoleDiagnostics: { errors: [], expectedAliasConflict: [], exceptions: [], warnings: [], unhandled: [] },
    network: { externalAttempts: [], denied: [], failures: [], pending: 0 },
    serverRejected: 0,
    ...overrides,
  });
}

test("fixture provides a strict no-argument idle, unchecked updater snapshot", async () => {
  const { transport, fixture } = createFixture();
  const status = await transport.invoke("get_app_update_status");
  assert.deepEqual(JSON.parse(JSON.stringify(status)), {
    operation: "idle", update: null, checked: false, lastError: null,
  });

  for (const args of [null, {}]) {
    await assert.rejects(transport.invoke("get_app_update_status", args), /receive no arguments/);
  }
  await assert.rejects(transport.invoke("unknown_updater_fixture_command"), /unknown native command/);

  const snapshot = JSON.parse(JSON.stringify(fixture.snapshot()));
  assert.equal(snapshot.updaterStatusReads, 1);
  assert.equal(snapshot.calls.filter((call) => call.command === "get_app_update_status").length, 3);
  assert.equal(snapshot.calls[0].outcome, "fixture-updater-status");
  assert.deepEqual(snapshot.calls.slice(1, 3).map((call) => call.outcome), ["rejected-arguments", "rejected-arguments"]);
  assert.deepEqual(snapshot.rejected, ["unknown_updater_fixture_command"]);
});

test("limited updater capability passes only with a complete flow and no updater error", () => {
  const result = classify();
  assert.equal(result.passed, true);
  assert.deepEqual(result.knownUnsupported, []);
});

test("the exact legacy unavailable branch remains classified for R28 evidence", () => {
  const entry = { page: "main", type: "error", text: UPDATER_UNAVAILABLE_TEXT };
  assert.equal(isKnownUpdaterUnavailableError(entry), true);
  const result = classify({
    updaterCapability: "unavailable",
    consoleDiagnostics: { errors: [entry], expectedAliasConflict: [], exceptions: [], warnings: [], unhandled: [] },
  });
  assert.equal(result.passed, true);
  assert.equal(result.knownUnsupported.length, 1);
  assert.equal(result.knownUnsupported[0].capability, "unavailable");
});

test("limited status with the former updater error cannot pass", () => {
  const entry = { page: "main", type: "error", text: UPDATER_UNAVAILABLE_TEXT };
  const result = classify({
    consoleDiagnostics: { errors: [entry], expectedAliasConflict: [], exceptions: [], warnings: [], unhandled: [] },
  });
  assert.equal(result.passed, false);
  assert.ok(result.blockers.includes("limited_updater_error_count_mismatch"));
});

test("unknown updater capabilities and incomplete acceptance cannot pass", () => {
  const unknown = classify({ updaterCapability: "available" });
  assert.equal(unknown.passed, false);
  assert.ok(unknown.blockers.includes("updater_capability_mismatch"));

  const incomplete = classify({ acceptanceCompleted: false });
  assert.equal(incomplete.passed, false);
  assert.ok(incomplete.blockers.includes("acceptance_incomplete"));
});

test("unexpected console errors remain blockers for limited capability", () => {
  const result = classify({
    consoleDiagnostics: {
      errors: [{ page: "main", type: "error", text: "unexpected error" }],
      expectedAliasConflict: [], exceptions: [], warnings: [], unhandled: [],
    },
  });
  assert.equal(result.passed, false);
  assert.ok(result.blockers.includes("other_console_or_runtime_issues"));
});

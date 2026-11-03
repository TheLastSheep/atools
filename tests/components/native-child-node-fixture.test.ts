// @vitest-environment node
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { childNodePendingMatches, childNodeRuntimeDrained, nativeChildNodeMainDiagnostic,
  nativeChildNodeLauncherSnapshot, submitNativeChildNodeSearch } from "./nativePluginChildNodeScenario";
// @ts-expect-error Fixture-only Node verifier intentionally has no production declaration.
import { validateChildNodeOutcome } from "../../scripts/probe-plugin-child-node-native.mjs";

const emptyRuntime = () => Object.fromEntries([
  ...["sessions", "openings", "nodeIntents", "nodeInvocations", "pending", "resourceLeases", "pageDocuments", "hostSessions", "hostIntents", "hostInvocations", "dataSessions", "dataIntents",
    "dataInvocations", "dataPreparations", "webStorageEvents", "webStorageEventBytes", "activePathSnapshots", "activePathIntents", "activePathPreparations", "pathSnapshotBytes",
    "dialogSessions", "dialogIntents", "dialogInvocations", "dialogPreparations", "nativeDialogs"].map(key => [key, 0]),
  ...["transport", "hostTransport", "dataTransport", "dialogTransport"].map(key => [key, false]),
]);
const scopes = ["file_read", "file_write", "network", "shell", "clipboard_read", "clipboard_write", "screenshot", "browser_context", "plugin_data", "system_settings"];
const state = () => ({ opaque: true, noTauri: true, parentPreloadExecuted: true, parentElectronIpc: true,
  mainReady: true, mainNodeEnvironment: false, children: [] as Record<string, unknown>[] });
function completeReport() {
  const observations: Record<string, any> = {};
  for (const label of ["deny", "fresh"]) observations["mainBeforeChild-" + label] = { state: state(), runtime: emptyRuntime() };
  for (const label of ["deny", "allow"]) observations["nodePrompt-" + label] = { exactPending: true, childCount: 0,
    runtime: { ...emptyRuntime(), pending: 1 }, state: { ...state(), children: [{ ready: false, readyCallbackCount: 0 }] } };
  observations.denial = { runtime: emptyRuntime(), state: { children: [{ ready: false, rejected: true, readyCallbackCount: 0 }] } };
  observations.afterDeniedPluginClose = emptyRuntime(); observations.finalRuntime = emptyRuntime();
  observations.generatedChild = { opaque: true, noTauri: true, actualNodeBridge: true, sentinelMatches: true, processId: 123,
    runtime: { ...emptyRuntime(), sessions: 1, transport: true } };
  observations.originalChild = { ...observations.generatedChild, originalFunctionsReady: true, originalFsAttachmentStored: true,
    dictionaryRoundTrip: true, metadataRoundTrip: true, zoomRateInitialized: true, webFrameZoomAvailable: true,
    documentZoomFactorRoundTrip: true, computedDocumentZoomMatches: true, documentZoomRestored: true, parentDocumentZoomUnchanged: true };
  for (const key of ["generatedChildClose", "originalChildClose"]) observations[key] = { actualClose: true, destroyed: true, readyCallbackCount: 1 };
  observations.privacy = { complete: true, privateFixtureContentsAbsent: true, allTaskRunsTerminal: true,
    taskRuns: 12, queryLimit: 1000, scannedBytes: 100, maxBytes: 4 * 1024 * 1024, nodeTaskRuns: 10, nodeOpenTaskRuns: 2, nodeRequestTaskRuns: 8, nodeOpenTaskRunStatuses: ["succeeded", "cancelled"] };
  return { passed: true, dataset: { kind: "synthetic-search-metadata-plus-generated-packages", originalPlugins: 0, originalFeatures: 0,
    generatedPlugins: 2, generatedFeatures: 2, syntheticFeatures: 1200 }, temporaryDataRemoved: true, allTaskRunsTerminal: true,
    dataRuntimeDrained: true, dialogRuntimeDrained: true, pathRuntimeDrained: true, generatedPackagesUnchanged: true,
    reviewedOriginalChildPreloadOnly: true, pageDocumentMode: false, pageDocumentsAfterCleanup: 0, resourceLeasesAfterCleanup: 0,
    checks: Object.fromEntries(Array.from({ length: 20 }, (_, i) => ["fixed-" + i, true])), observations,
    scope: "Native child-only Node descriptive scope",
    acceptanceScope: { generatedPackages: true, completeOriginalChildPreloadOnly: true,
      childDocumentCssZoomOnly: true, nativeChromiumZoomParity: false,
      completeOriginalPlugin: false, documentMode: false, trueNativeFloatingWindow: false, physicalInput: false,
      osPickerOpened: false, clipboardActions: false, externalNetworkRequested: false, appleScriptUsed: false } };
}

describe("child-only Node native fixture evidence", () => {
  it("original metadata comparison accepts JSON key reordering but rejects extra, missing, changed or nested values", async () => {
    const source = await readFile(new URL("./nativePluginChildNodeFrameProbe.js", import.meta.url), "utf8");
    const start = source.indexOf("  function jsonFixtureEqual("), end = source.indexOf("  function inspectChildDocumentZoom()", start);
    expect(start >= 0 && end > start).toBe(true);
    const exact = vm.runInNewContext("(" + source.slice(start, end).trim() + ")");
    const expected = [{ id: "fixed", name: "Fixed fixture", length: 1 }], reordered = [{ id: "fixed", length: 1, name: "Fixed fixture" }];
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(expected)); expect(exact(reordered, expected)).toBe(true);
    for (const actual of [[{ id: "fixed", name: "Fixed fixture" }], [{ id: "fixed", name: "Fixed fixture", length: "1" }],
      [{ id: "fixed", name: "Changed", length: 1 }], [{ ...expected[0], extra: true }], [...expected, ...expected], []]) expect(exact(actual, expected)).toBe(false);
    const nested = { tags: ["first", { languages: ["en", "zh"] }], config: { enabled: true } };
    expect(exact({ config: { enabled: true }, tags: ["first", { languages: ["en", "zh"] }] }, nested)).toBe(true);
    for (const actual of [{ ...nested, tags: ["first", { languages: ["zh", "en"] }] },
      { ...nested, config: { enabled: false } }, { ...nested, config: { enabled: true, extra: null } },
      { ...nested, tags: ["first", { languages: ["en"] }] }]) expect(exact(actual, nested)).toBe(false);
  });
  it("child CSS zoom proof requires the real API, factor/style/computed agreement and restoration even when the trial throws", async () => {
    const source = await readFile(new URL("./nativePluginChildNodeFrameProbe.js", import.meta.url), "utf8");
    const start = source.indexOf("  function inspectChildDocumentZoom()"), end = source.indexOf("  function state()", start);
    expect(start >= 0 && end > start).toBe(true);
    const run = ({ percent = false, missing = false, wrongGet = false, wrongComputed = false, trialThrows = false, restoreThrows = false } = {}) => {
      let factor = 1; const calls: number[] = [], root = { style: { getPropertyValue: () => String(factor) } };
      const webFrame = missing ? undefined : { getZoomFactor: () => wrongGet ? 1 : factor,
        setZoomFactor: (value: number) => { calls.push(value); factor = value;
          if (trialThrows && value === 1.25 || restoreThrows && value === 1) throw Error("Fixed trial failure"); } };
      const proof = vm.runInNewContext("(" + source.slice(start, end).trim() + ")()", {
        window: { require: (name: string) => { expect(name).toBe("electron"); return { webFrame }; } }, document: { documentElement: root },
        getComputedStyle: (element: unknown) => { expect(element).toBe(root); return { getPropertyValue: () => wrongComputed ? "1" : percent ? String(factor * 100) + "%" : String(factor) }; },
      });
      return { proof, calls, factor };
    };
    for (const percent of [false, true]) {
      const result = run({ percent }); expect(Object.values(result.proof).every(value => value === true)).toBe(true);
      expect(result.calls).toEqual([1.25, 1]); expect(result.factor).toBe(1);
    }
    expect(run({ missing: true }).proof.webFrameZoomAvailable).toBe(false);
    for (const option of [{ wrongGet: true }, { wrongComputed: true }, { trialThrows: true }]) {
      const result = run(option); expect(result.proof.documentZoomFactorRoundTrip).toBe(false);
      expect(result.calls).toEqual([1.25, 1]); expect(result.factor).toBe(1);
    }
    expect(run({ restoreThrows: true }).proof.documentZoomRestored).toBe(false);
  });
  it("clears the actual launcher input and flushes before resubmitting the same query; diagnostics contain no query or row bodies", async () => {
    const dom = new JSDOM('<input class="search-input" data-atools-search-input="true"><div role="option" data-plugin-id="file-tree" data-result-code="child-node-contract" aria-selected="true">PRIVATE_ROW_BODY</div>');
    try {
      const input = dom.window.document.querySelector<HTMLInputElement>("input")!, events: string[] = [];
      input.value = "synthetic child only node";
      input.addEventListener("input", () => events.push("input:" + input.value));
      await submitNativeChildNodeSearch(input, async () => { events.push("flush"); });
      expect(events).toEqual(["input:", "flush", "input:synthetic child only node", "flush"]);
      const snapshot = nativeChildNodeLauncherSnapshot(dom.window.document);
      expect(snapshot.inputPresent && snapshot.inputConnected && snapshot.inputMatchesFixedQuery && snapshot.fixtureOptionSelected).toBe(true);
      expect(snapshot.optionCount).toBe(1); expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_");
      expect(JSON.stringify(snapshot)).not.toContain("synthetic child only node");
      await expect(submitNativeChildNodeSearch(input, async () => { input.remove(); })).rejects.toThrow();
    } finally { dom.window.close(); }
  });
  it("launcher diagnostics distinguish the exact feature from another selected feature of the same plugin", () => {
    const dom = new JSDOM('<input class="search-input"><button role="option" data-plugin-id="file-tree" data-result-code="other-feature" aria-selected="true">PRIVATE_OTHER</button><button role="option" data-plugin-id="file-tree" data-result-code="child-node-contract" aria-selected="false">PRIVATE_TARGET</button>');
    try {
      const document = dom.window.document, before = nativeChildNodeLauncherSnapshot(document);
      expect(before.fixtureOptionPresent).toBe(true); expect(before.fixtureOptionSelected).toBe(false);
      expect(before.fixturePluginOptionCount).toBe(2); expect(before.exactFeatureOptionCount).toBe(1);
      expect(before.selectedOtherFixtureFeatureCount).toBe(1); expect(before.selectedExactFeatureOptionCount).toBe(0);
      expect(JSON.stringify(before)).not.toContain("PRIVATE_");
    } finally { dom.window.close(); }
  });
  it("main readiness diagnostics keep only fixed booleans, bounded counts and fixed error enums", () => {
    const actual = nativeChildNodeMainDiagnostic({ parentPreloadExecuted: true, parentElectronIpc: false, mainReady: true,
      mainScriptEntered: true, mainStorageApiAvailable: true, mainDataAttempted: true, mainDataCompleted: true,
      mainDataErrorClass: "PRIVATE_ERROR_NAME", mainDataErrorCode: "PRIVATE_ERROR_CODE", observedErrorCount: Infinity,
      observedErrorCounts: { TypeError: 2, UnknownError: 1, Error: -1, PRIVATE_KEY: 1 }, body: "PRIVATE_BODY", path: "PRIVATE_PATH" });
    expect(actual.parentPreloadExecuted).toBe(true); expect(actual.parentElectronIpc).toBe(false); expect(actual.mainReady).toBe(true);
    expect(actual.mainDataErrorClass).toBe("UnknownError"); expect(actual.mainDataErrorCode).toBe("UNKNOWN_ERROR");
    expect(actual.observedErrorCount).toBe(0); expect(actual.observedErrorCounts.TypeError).toBe(2);
    expect(actual.observedErrorCounts.Error).toBe(0); expect(JSON.stringify(actual)).not.toContain("PRIVATE_");
  });
  it("requires exact Node tool, client, all scopes and one pending request", () => {
    const request = { tool_name: "exact", client_id: "atools-ui", scopes };
    expect(childNodePendingMatches([request], "exact")).toBe(true);
    for (const pending of [[{ ...request, tool_name: "other" }], [{ ...request, client_id: "other" }],
      [{ ...request, scopes: scopes.slice(1) }], [request, request], []]) expect(childNodePendingMatches(pending, "exact")).toBe(false);
  });
  it("missing counters and every remaining runtime resource prevent drain acceptance", () => {
    const empty = emptyRuntime(); expect(childNodeRuntimeDrained(empty)).toBe(true);
    for (const key of Object.keys(empty)) {
      const missing = { ...empty }; delete missing[key]; expect(childNodeRuntimeDrained(missing)).toBe(false);
      expect(childNodeRuntimeDrained({ ...empty, [key]: typeof empty[key] === "boolean" ? true : 1 })).toBe(false);
    }
  });
  it("independent verifier requires denial, fresh approval, both child executions and whole-plugin cleanup", () => {
    expect(validateChildNodeOutcome(completeReport()).completeOriginalPackages).toBe(0);
    const mutate = [
      (r: any) => { r.observations["mainBeforeChild-fresh"].state.mainNodeEnvironment = true; },
      (r: any) => { r.observations["nodePrompt-allow"].runtime.openings = 1; },
      (r: any) => { r.observations.denial.state.children[0].ready = true; },
      (r: any) => { r.observations.generatedChild.sentinelMatches = false; },
      (r: any) => { r.observations.originalChild.dictionaryRoundTrip = false; },
      ...["webFrameZoomAvailable", "documentZoomFactorRoundTrip", "computedDocumentZoomMatches", "documentZoomRestored", "parentDocumentZoomUnchanged"]
        .map(key => (r: any) => { r.observations.originalChild[key] = false; }),
      (r: any) => { r.observations.originalChild.runtime.sessions = 2; },
      (r: any) => { r.observations.privacy.nodeOpenTaskRunStatuses = ["succeeded", "succeeded"]; },
      (r: any) => { r.observations.privacy.complete = false; },
      (r: any) => { r.observations.finalRuntime.webStorageEvents = 1; },
      (r: any) => { r.acceptanceScope.completeOriginalPlugin = true; },
      (r: any) => { r.acceptanceScope.nativeChromiumZoomParity = true; },
      (r: any) => { r.scope = r.acceptanceScope; },
      (r: any) => { delete r.acceptanceScope; },
    ];
    for (const change of mutate) { const report = completeReport(); change(report); expect(() => validateChildNodeOutcome(report)).toThrow(); }
    expect(() => validateChildNodeOutcome({ passed: true })).toThrow();
  });
  it("retains frontend acceptance booleans after the actual Rust describe step overwrites the native scope", async () => {
    const source = await readFile(new URL("../../src-tauri/src/legacy_runtime/desktop_smoke_child_node_privacy.rs", import.meta.url), "utf8");
    const literal = source.match(/report\["scope"\]\s*=\s*json!\(\s*("(?:[^"\\]|\\.)*")\s*\)/)?.[1];
    expect(literal).toBeDefined();
    const nativeDescription: string = JSON.parse(literal!);
    const report = completeReport(), frontendBooleans = report.acceptanceScope;
    // This applies the actual fixed Rust description, preserving the frontend's independent field.
    const afterNativeDescribe = { ...report, scope: nativeDescription, reviewedOriginalChildPreloadOnly: true };
    expect(typeof afterNativeDescribe.scope).toBe("string");
    expect(afterNativeDescribe.acceptanceScope).toBe(frontendBooleans);
    expect(validateChildNodeOutcome(afterNativeDescribe).completeUnchangedOriginalChildPreload).toBe(true);
    const oldFrontendShape: any = { ...afterNativeDescribe, acceptanceScope: undefined };
    expect(() => validateChildNodeOutcome(oldFrontendShape)).toThrow();
  });
  it("rejects coercible, unbounded or incompatible durable history counters", () => {
    for (const key of ["taskRuns", "queryLimit", "scannedBytes", "maxBytes", "nodeTaskRuns", "nodeOpenTaskRuns", "nodeRequestTaskRuns"]) {
      for (const value of ["8", -1, 0, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1.5]) {
        const report = completeReport(); report.observations.privacy[key] = value;
        expect(() => validateChildNodeOutcome(report)).toThrow();
      }
    }
    for (const fields of [{ queryLimit: 1001 }, { maxBytes: 4096 }, { taskRuns: 1000 },
      { scannedBytes: 4 * 1024 * 1024 + 1 }, { nodeRequestTaskRuns: "8", nodeTaskRuns: "28" },
      { taskRuns: 9 }, { nodeRequestTaskRuns: 9 }]) {
      const report = completeReport(); Object.assign(report.observations.privacy, fields);
      expect(() => validateChildNodeOutcome(report)).toThrow();
    }
  });
  it("serialized probe creates a fixed selected child immediately, waits for real ready and never accepts an injected script", async () => {
    let listener: (event: unknown) => Promise<void> = async () => {}, resolveReady!: () => void;
    const ready = new Promise<void>(resolve => { resolveReady = resolve; }), sent: any[] = [];
    const parent = { postMessage: vi.fn((value: unknown) => sent.push(value)) };
    let destroyed = false;
    const create = vi.fn(() => ({ ready, then: undefined, isDestroyed: () => destroyed,
      close: async () => { destroyed = true; return { closed: true }; },
      webContents: { executeJavaScript: vi.fn(async () => ({ sentinelMatches: true })) } }));
    const context: any = vm.createContext({ parent, location: { origin: "null" }, window: {}, Error, Map,
      setTimeout, clearTimeout });
    context.window = context; context.top = {}; context.ztools = { createBrowserWindow: create };
    context.addEventListener = (_name: string, handler: typeof listener) => { listener = handler; };
    vm.runInContext((await readFile(new URL("./nativePluginChildNodeFrameProbe.js", import.meta.url), "utf8")).replace("__ATOOLS_PANEL_TOKEN__", "fixed-token"), context);
    const packet = (id: string, operation: string) => ({ source: parent, data: { token: "fixed-token", kind: "atools-child-node-probe", id, operation } });
    await listener({ ...packet("wrong", "open-generated"), source: {} }); expect(create).not.toHaveBeenCalled();
    await listener({ ...packet("token", "open-generated"), data: { ...packet("token", "open-generated").data, token: "other" } }); expect(create).not.toHaveBeenCalled();
    await listener(packet("open", "open-generated")); expect(sent.at(-1).result.synchronousHandle).toBe(true);
    expect(create.mock.calls[0]).toEqual(["child.html", { show: false, webPreferences: { preload: "child-preload.js" } }, expect.any(Function)]);
    await listener(packet("state", "state")); expect(sent.at(-1).result.children[0].ready).toBe(false);
    resolveReady(); await Promise.resolve(); await listener(packet("after", "state")); expect(sent.at(-1).result.children[0].ready).toBe(true);
    await listener(packet("open", "open-generated")); expect(create).toHaveBeenCalledTimes(1);
    await listener(packet("script", "executeJavaScript('injected')")); expect(sent.at(-1).error).toBe("Error");
    await listener(packet("close", "close-generated")); expect(sent.at(-1).result.actualClose).toBe(true);
  });
});

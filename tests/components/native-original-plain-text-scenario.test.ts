import { settledInputDiagnostics } from "./nativeUiInputDiagnosticTestFixture";
import { afterEach, expect, it, vi } from "vitest";
import { runOriginalPlainTextScenario, verifyOriginalPlainTextAfterReopen } from "./nativeOriginalPlainTextScenario";
import type { PublishedScenarioContext } from "./nativePublishedPluginCommon";
const { native, dataApproval, pathApproval } = vi.hoisted(() => ({ native: vi.fn(), dataApproval: vi.fn(), pathApproval: vi.fn() }));
vi.mock("./nativePublishedPluginCommon", async original => ({ ...(await original<Record<string, unknown>>()), invoke: native,
  approvePublishedData: dataApproval, approvePublishedStandardPaths: pathApproval }));
const ALPHA = "ATools plain alpha document line 1234567890\nAlpha fixed body\nSecond line.";
const BETA = "# ATools markdown beta document\n\n- first\n- second";
const alpha = { id: "alpha", title: "ATools plain alpha d", content: ALPHA, mode: "text" };
const beta = { id: "beta", title: "# ATools markdown be", content: BETA, mode: "markdown" };
afterEach(() => { document.body.innerHTML = ""; native.mockReset(); dataApproval.mockReset(); pathApproval.mockReset(); vi.restoreAllMocks(); });
function harness(options: { nativeHidden?: boolean; focusFailed?: boolean; wrongDb?: boolean; reopen?: boolean; wrongId?: boolean; nativeUiInput?: boolean } = {}) {
  let text = options.reopen ? BETA : "", mode = options.reopen ? "markdown" : "text", active = options.reopen ? "beta" : "alpha";
  let nativeUiPhase: "alpha" | "beta" = "alpha";
  let notes = options.reopen ? [alpha, beta] : [] as typeof alpha[], drawerOpen = false;
  const ops: string[] = [], order: string[] = [];
  const projection = () => ({ pluginId: "plain-text", storageKind: "webStorage", readOnly: true,
    activeId: options.wrongId ? "changed" : active, notes: options.wrongDb ? [{ ...alpha, content: "wrong" }] : notes });
  const nativeUiProof = (phase: "alpha" | "beta", stopped = false) => ({ schemaVersion: 2, phase, stopped,
    listenerCount: stopped ? 0 : 8, lifecycleListenerCount: stopped ? 0 : 2,
    records: Object.fromEntries(["alpha", "beta"].map(key => [key, { trustedEditorPointers: 1, trustedKeydowns: 2,
      trustedBeforeInputs: 2, trustedInputs: 2, rejectedUntrusted: 0, overflow: false, diagnostics: settledInputDiagnostics(4) }])) });
  const probe = vi.fn(async (operation: string) => {
    ops.push(operation);
    if (operation === "native-ui-alpha" || operation === "native-ui-beta") {
      nativeUiPhase = operation.endsWith("beta") ? "beta" : "alpha";
      text = nativeUiPhase === "alpha" ? ALPHA : BETA; mode = "text"; active = nativeUiPhase;
      notes = nativeUiPhase === "alpha" ? [alpha] : [alpha, { ...beta, mode: "text" }];
    } else if (operation === "native-ui-stop") {
      return { nativeUiInputObservation: nativeUiProof(nativeUiPhase, true) } as any;
    }
    if (operation === "enter-alpha") { text = ALPHA; mode = "text"; active = "alpha"; notes = [alpha]; }
    else if (operation === "new-draft") { text = ""; mode = "text"; active = "beta"; }
    else if (operation === "enter-beta") { text = BETA; notes = [alpha, { ...beta, mode: "text" }]; }
    else if (operation === "markdown") { mode = "markdown"; notes = [alpha, beta]; }
    else if (operation === "open-list") drawerOpen = true;
    else if (operation === "select-alpha") { text = ALPHA; mode = "text"; active = "alpha"; drawerOpen = false; }
    else if (operation === "select-beta") { text = BETA; mode = "markdown"; active = "beta"; drawerOpen = false; }
    else expect(["state", "native-ui-alpha", "native-ui-beta"]).toContain(operation);
    return { ready: true, text, mode, previewHeading: mode === "markdown" ? "ATools markdown beta document" : "", previewItems: mode === "markdown" ? ["first", "second"] : [],
      drawerOpen, drafts: drawerOpen ? notes.map(note => ({ title: note.title, active: active === note.id })) : [],
      focusDiagnostics: { documentHasFocus: !options.focusFailed, visibilityState: "visible", documentHidden: false,
        editorActive: !options.focusFailed, editorConnected: true, editorIsContentEditable: true,
        editorWidth: 200, editorHeight: 100, computedStyle: { webkitUserModify: "read-write", userSelect: "text", pointerEvents: "auto" },
        inertAncestors: [], userActivation: { isActive: false, hasBeenActive: true } },
      focusAttempt: null, editCommandResults: options.nativeUiInput ? [] : [{ command: "selectAll", accepted: true }, { command: "insertText", accepted: true }],
      nativeUiInputObservation: options.nativeUiInput ? nativeUiProof(nativeUiPhase) : undefined,
      origin: "null", parentDocumentAccessBlocked: true, tauriInternalsType: "undefined", globalTauriType: "undefined" };
  });
  const runtime = () => {
    const open = !!document.querySelector('iframe[title="Plugin"]');
    return { legacySessions: open ? 1 : 0, legacyOpenings: 0, legacyTransport: open, pendingRequests: open ? 0 : 1,
      dataSessions: 1, dataTransport: true, hostSessions: 0, hostTransport: false, pathRuntimeAvailable: true,
      activePathSnapshots: 1, activePathIntents: 0, activePathPreparations: 0, pathSnapshotBytes: 128,
      nativeDialogs: 0, dialogSessions: 0, dialogTransport: false };
  };
  native.mockImplementation(async (command: string) => {
    if (command === "native_panel_foreground") return { appActive: true, appHidden: !!options.nativeHidden,
      frontmostIsSelf: true, nativeFocused: true, nativeVisible: !options.nativeHidden };
    if (command === "native_published_data_snapshot") return projection();
    if (command === "native_published_runtime_state") return runtime();
    if (command === "list_pending_agent_requests") return [{ tool_name: "legacy_node_" + "a".repeat(64), client_id: "atools-ui" }];
    throw Error("Unexpected native command " + command);
  });
  const context = { fixture: options.nativeUiInput ? { nativeUiInput: true } : undefined,
    profile: { caseId: "local-plain-text", id: "plain-text", title: "纯文本编辑", featureCode: "editor", searchQuery: "edit" }, probe,
    check(ok: unknown, label: string) { if (!ok) throw Error(label); }, async until(read: () => unknown, label: string) {
      const value = await read(); if (!value) throw Error(label); return value;
    }, observations: options.reopen ? { originalPlainPersisted: { pluginId: "plain-text", storageKind: "webStorage", readOnly: true, activeId: "beta", notes: [alpha, beta] } } : {},
    setPhase: vi.fn() } as unknown as PublishedScenarioContext;
  if (options.reopen) {
    document.body.innerHTML = '<input class="search-input"><button role="option" data-plugin-id="plain-text" data-result-code="editor">纯文本编辑</button>';
    dataApproval.mockImplementation(async () => { order.push("data"); return {}; });
    pathApproval.mockImplementation(async () => {
      order.push("paths"); const dialog = document.createElement("section"); dialog.dataset.permissionDialog = "";
      dialog.innerHTML = '<h2>纯文本编辑 请求访问本机</h2><button>允许一次</button>'; document.body.append(dialog);
      dialog.querySelector("button")!.onclick = () => { order.push("node"); dialog.remove(); const frame = document.createElement("iframe");
        frame.title = "Plugin"; frame.setAttribute("sandbox", "allow-scripts"); document.body.append(frame); };
      return {};
    });
  }
  return { context, ops, order };
}
it("uses real editor command observations and original draft controls, requiring independent autosave content/title/mode/active ID", async () => {
  const test = harness(), result = await runOriginalPlainTextScenario(test.context);
  expect(test.ops.filter(operation => operation !== "state")).toEqual(["enter-alpha", "new-draft", "enter-beta", "markdown", "open-list", "select-alpha", "open-list", "select-beta"]);
  expect(test.context.observations.originalPlainPersisted).toMatchObject({ notes: [alpha, beta], activeId: "beta", storageKind: "webStorage" });
  expect(result.notTested).toContain("physical keyboard/pointer");
  expect(native.mock.calls.filter(call => call[0] === "native_panel_foreground")).toEqual([["native_panel_foreground", { ensure: true }], ["native_panel_foreground", { ensure: false }]]);
});
it("uses two explicit OS-input phases while retaining the original autosave, Markdown, drawer and close-reopen flow", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const test = harness({ nativeUiInput: true }), result = await runOriginalPlainTextScenario(test.context);
  expect(test.ops.filter(operation => operation.startsWith("native-ui-")).slice(0, 3)).toEqual(["native-ui-alpha", "native-ui-beta", "native-ui-stop"]);
  expect(test.ops).not.toContain("enter-alpha"); expect(test.ops).not.toContain("enter-beta");
  expect(test.ops).toContain("new-draft"); expect(test.ops).toContain("markdown");
  expect(test.context.observations.originalPlainNativeUiInput).toMatchObject({ hardwareHumanInputVerified: false,
    proofs: { alpha: { phase: "alpha" }, beta: { phase: "beta" } }, cleanup: { stopped: true, listenerCount: 0 } });
  expect(test.context.observations.originalPlainPersisted).toMatchObject({ notes: [alpha, beta], activeId: "beta" });
  expect(test.context.observations.originalPlainEditing.inputMechanism).toContain("trusted OS");
  expect(result.tested).toContain("trusted OS keyboard and pointer input on the original CodeMirror editor");
  expect(result.notTested).toContain("human hardware input");
});
it("blocks all editor input when native visibility fails, and fails without model/storage fallback when editor focus fails", async () => {
  const hidden = harness({ nativeHidden: true }); await expect(runOriginalPlainTextScenario(hidden.context)).rejects.toThrow("positively visible"); expect(hidden.ops).toEqual([]);
  const unfocused = harness({ focusFailed: true }); await expect(runOriginalPlainTextScenario(unfocused.context)).rejects.toThrow("successful browser commands");
  expect(unfocused.ops.filter(operation => operation !== "state")).toEqual(["enter-alpha"]);
});
it("rejects a rendered editor success when actual SQLite content differs", async () => {
  await expect(runOriginalPlainTextScenario(harness({ wrongDb: true }).context)).rejects.toThrow("Independent UTF-16 SQLite");
});
it("retains a read-only failure snapshot, rethrows the original error and never replays focus/input", async () => {
  const test = harness(), original = Error("fixed focus failure");
  const probe = vi.mocked(test.context.probe), previous = probe.getMockImplementation()!;
  probe.mockImplementation(async (...args) => {
    if (args[0] === "enter-alpha") {
      test.context.observations.lastFrameProbe = { operation: "enter-alpha", error: "fixed original focus error" };
      throw original;
    }
    test.context.observations.lastFrameProbe = { operation: "state", error: null };
    return previous(...args);
  });
  await expect(runOriginalPlainTextScenario(test.context)).rejects.toBe(original);
  expect(probe.mock.calls.map(call => call[0])).toEqual(["state", "enter-alpha", "state"]);
  expect(test.context.observations.originalPlainInputFailure).toMatchObject({
    failedFrameProbe: { operation: "enter-alpha", error: "fixed original focus error" },
    frameState: { text: "", editCommandResults: expect.any(Array) }, host: { permissionDialogs: 0, modalDialogs: 0 },
  });
  expect(test.context.observations.lastFrameProbe).toEqual({ operation: "state", error: null });
  expect(native.mock.calls.some(call => call[0] === "native_published_data_snapshot")).toBe(false);
});
it("whole reopen requests fresh data then paths then Node, uses a new iframe, and restores both original drafts and active Markdown mode", async () => {
  const test = harness({ reopen: true }); await verifyOriginalPlainTextAfterReopen(test.context, document.createElement("iframe"));
  expect(test.order).toEqual(["data", "paths", "node"]);
  expect(test.context.observations.originalPlainAfterWholeReopen).toMatchObject({ freshOneTimeApprovals: 3, newIframe: true,
    storageWritesByFixture: false, documentsInjected: false, nativePanelOpened: false, restoredActive: { text: BETA, mode: "markdown" } });
  expect(test.ops.filter(operation => operation !== "state")).toEqual(["open-list", "select-alpha", "open-list", "select-beta"]);
});
it("does not accept changed active ID after reopen", async () => {
  const test = harness({ reopen: true, wrongId: true }); await expect(verifyOriginalPlainTextAfterReopen(test.context, document.createElement("iframe"))).rejects.toThrow("Independent UTF-16 SQLite");
});
it("preserves the original OS input failure when observer cleanup also fails", async () => {
  const test = harness({ nativeUiInput: true }), primary = Error("fixed input failure"), cleanup = Error("fixed cleanup failure");
  const probe = vi.mocked(test.context.probe), previous = probe.getMockImplementation()!;
  probe.mockImplementation(async (...args) => {
    if (args[0] === "native-ui-alpha") throw primary;
    if (args[0] === "native-ui-stop") throw cleanup;
    return previous(...args);
  });
  await expect(runOriginalPlainTextScenario(test.context)).rejects.toBe(primary);
  expect(probe.mock.calls.map(call => call[0])).toEqual(["state", "native-ui-alpha", "native-ui-stop"]);
  expect(test.context.observations.originalPlainNativeUiCleanupFailure).toEqual({ errorClass: "Error", primaryErrorPreserved: true });
  expect(document.querySelector("[data-atools-native-plain-text-input]")).toBeNull();
});

it("fails the case when observer cleanup alone fails after both input phases", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const test = harness({ nativeUiInput: true }), cleanup = Error("fixed cleanup failure");
  const probe = vi.mocked(test.context.probe), previous = probe.getMockImplementation()!;
  probe.mockImplementation(async (...args) => {
    if (args[0] === "native-ui-stop") throw cleanup;
    return previous(...args);
  });
  await expect(runOriginalPlainTextScenario(test.context)).rejects.toBe(cleanup);
  expect(test.context.observations.originalPlainNativeUiCleanupFailure).toEqual({ errorClass: "Error", primaryErrorPreserved: false });
  expect(probe.mock.calls.filter(call => call[0] === "native-ui-stop")).toHaveLength(1);
  expect(document.querySelector("[data-atools-native-plain-text-input]")).toBeNull();
});

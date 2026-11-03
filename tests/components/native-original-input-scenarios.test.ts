import { afterEach, expect, it, vi } from "vitest";
import vm from "node:vm";
import { createHash, webcrypto } from "node:crypto";
import uuidAdapterSource from "./nativeOriginalUuidFrameOperations.js?raw";
import asciiAdapterSource from "./nativeOriginalAsciiTreeFrameOperations.js?raw";
import genericProbeSource from "./nativePublishedPluginFrameProbe.js?raw";
import { runOriginalUuidScenario } from "./nativeOriginalUuidScenario";
import { runOriginalAsciiTreeScenario, verifyOriginalAsciiTreeAfterReopen } from "./nativeOriginalAsciiTreeScenario";
import type { PublishedScenarioContext } from "./nativePublishedPluginCommon";

const { nativeInvoke, dataApproval, saveApproval } = vi.hoisted(() => ({ nativeInvoke: vi.fn(), dataApproval: vi.fn(), saveApproval: vi.fn() }));
vi.mock("./nativePublishedPluginCommon", async importOriginal => ({ ...(await importOriginal<Record<string, unknown>>()), invoke: nativeInvoke,
  approvePublishedData: dataApproval }));
vi.mock("./nativePublishedDialogPermission", () => ({ approvePublishedSaveDialog: saveApproval }));

afterEach(() => {
  document.body.innerHTML = "";
  nativeInvoke.mockReset(); dataApproval.mockReset(); saveApproval.mockReset();
  delete (window as unknown as Record<string, unknown>).__ATOOLS_PUBLISHED_CASE_OPERATIONS__;
});

function sharedProbe(caseId: string, adapterSource: string) {
  // Actual generic probe plus actual adapter on synthetic DOM. No original plugin, GUI, database or native IPC executes.
  window.eval(adapterSource);
  const adapter = (window as unknown as { __ATOOLS_PUBLISHED_CASE_OPERATIONS__: { perform: (...args: any[]) => any } }).__ATOOLS_PUBLISHED_CASE_OPERATIONS__;
  const perform = vi.spyOn(adapter, "perform"), replies: any[] = [];
  let receive: (event: any) => Promise<void>;
  const parent: any = { postMessage: (message: any) => replies.push(message) };
  Object.defineProperty(parent, "document", { get: () => { throw Error("Opaque parent"); } });
  const child = { parent, top: parent, crypto: webcrypto, __ATOOLS_PUBLISHED_CASE_OPERATIONS__: adapter,
    addEventListener(kind: string, callback: typeof receive) { if (kind === "message") receive = callback; } };
  const syntheticDocument = { URL: "about:srcdoc", readyState: "complete", title: "synthetic", scripts: [],
    body: { innerText: "synthetic" }, querySelector: () => null, addEventListener: vi.fn() };
  vm.runInNewContext(genericProbeSource.replaceAll("__ATOOLS_PUBLISHED_TOKEN__", "fixture-token").replaceAll("__ATOOLS_PUBLISHED_CASE_ID__", caseId),
    { window: child, document: syntheticDocument, location: { origin: "null" }, console: { error() {}, warn() {} } });
  const base = { token: "fixture-token", id: "request-1", caseId };
  return { perform, replies, async send(operation: string, extra: Record<string, unknown> = {}) {
    await receive!({ source: parent, data: { ...base, kind: "atools-published-probe-ready", operation: "ready" } });
    const ready = replies.at(-1); expect(ready.kind).toBe("atools-published-probe-ready-result");
    const envelope = { ...base, kind: "atools-published-probe", operation, documentNonce: ready.documentNonce, workerLeaseSessions: [], ...extra };
    await receive!({ source: parent, data: envelope }); return { envelope, reply: replies.at(-1) };
  } };
}

it("passes the real generic seven-field envelope into the UUID read-only adapter", async () => {
  document.body.innerHTML = '<input id="input"><div id="out"></div><span id="badge">解析 / 生成</span><div id="meta"></div><div id="selftest-fail"></div>';
  const test = sharedProbe("local-uuid-kit", uuidAdapterSource);
  const result = await test.send("inspect-result");
  expect(test.perform).toHaveBeenCalledOnce(); expect(test.perform).toHaveBeenCalledWith("inspect-result", result.envelope);
  expect(Object.keys(result.envelope)).toHaveLength(7);
  expect(result.reply).toMatchObject({ kind: "atools-published-probe-result", state: { ready: true, badge: "解析 / 生成" } });
  expect(result.reply.error).toBeUndefined();
  const extended = await test.send("inspect-result", { value: "arbitrary" }); expect(extended.reply.error).toContain("Unapproved");
});

it("passes the real generic seven-field envelope into one fixed ASCII DOM input operation", async () => {
  document.body.innerHTML = '<textarea id="text"></textarea><textarea id="tree"></textarea>';
  const listener = vi.fn(); document.querySelector("#text")!.addEventListener("input", listener);
  const test = sharedProbe("local-ascii-tree", asciiAdapterSource), result = await test.send("enter-level-text");
  expect(test.perform).toHaveBeenCalledOnce(); expect(test.perform).toHaveBeenCalledWith("enter-level-text", result.envelope);
  expect(result.reply).toMatchObject({ kind: "atools-published-probe-result", state: { ready: true, input: "root\n=src\n==index.js" } });
  expect(result.reply.error).toBeUndefined(); expect(listener).toHaveBeenCalledOnce();
  const extended = await test.send("enter-level-text", { path: "/arbitrary" }); expect(extended.reply.error).toContain("Unapproved");
  expect(listener).toHaveBeenCalledOnce();
});

function uuidScenarioHarness(options: { wrongUuid?: boolean; selftestError?: boolean } = {}) {
  document.body.innerHTML = '<header class="plugin-navigation"><input class="sub-input" aria-label="插件搜索"></header>';
  const input = document.querySelector<HTMLInputElement>("input")!, inputs: string[] = [], phases: string[] = [];
  let text = "";
  input.addEventListener("input", () => { text = input.value; inputs.push(text); });
  const uuid = "cfbff0d1-9375-5685-968c-48ce8b15ae17";
  const probe = vi.fn(async (operation: string) => {
    expect(operation).toBe("inspect-result");
    const invalid = text === "not/valid!!", generated = text === "uuid5 dns example.com";
    return { ready: true, input: text, badge: invalid ? "无法识别" : generated ? "生成 UUIDv5（确定性）" : "解析 / 生成",
      meta: "命名空间 dns + example.com", error: invalid ? "invalid" : "", selftestError: options.selftestError ? "failed" : "",
      rows: generated ? [{ label: "标准 UUID", value: options.wrongUuid ? "wrong" : uuid }, ...Array.from({ length: 5 }, () => ({ label: "encoding", value: "value" }))] : [],
      visibilityState: "hidden", documentHidden: true };
  });
  const context = { probe, check(ok: unknown, label: string) { if (!ok) throw Error(label); },
    async until(read: () => unknown, label: string) { const value = await read(); if (!value) throw Error(label); return value; },
    observations: {}, setPhase(phase: string) { phases.push(phase); } } as unknown as PublishedScenarioContext;
  return { input, inputs, phases, context, probe };
}

it("UUID scenario sends the three fixed values through the production-shaped host input and records hidden visibility without physical claims", async () => {
  const test = uuidScenarioHarness(), result = await runOriginalUuidScenario(test.context);
  expect(test.inputs).toEqual(["uuid5 dns example.com", "not/valid!!", "uuid5 dns example.com"]);
  expect(test.input.value).toBe("uuid5 dns example.com"); expect(result.notTested).toContain("physical keyboard/pointer");
  expect(test.context.observations.originalUuidGenerated).toMatchObject({ visibilityState: "hidden", documentHidden: true });
  expect(test.phases).toEqual(["original-uuid-host-subinput-deterministic-generation", "original-uuid-host-subinput-error-recovery"]);
});

it("does not accept a wrong deterministic UUID or the original self-test failure", async () => {
  await expect(runOriginalUuidScenario(uuidScenarioHarness({ wrongUuid: true }).context)).rejects.toThrow("deterministic generator");
  const failed = uuidScenarioHarness({ selftestError: true });
  await expect(runOriginalUuidScenario(failed.context)).rejects.toThrow("self-test failed"); expect(failed.inputs).toEqual([]);
});

it("the fixed expected UUID independently matches RFC UUIDv5 SHA-1 namespace construction", () => {
  const bytes = createHash("sha1").update(Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex")).update("example.com", "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50; bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString("hex"), uuid = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
  expect(uuid).toBe("cfbff0d1-9375-5685-968c-48ce8b15ae17");
});

function asciiScenarioHarness(wrongDatabase = false) {
  // Synthetic observations check the verifier's acceptance boundary; they do not prove original rendering or persistence.
  let input = "", output = ""; const operations: string[] = [];
  const probe = vi.fn(async (operation: string) => {
    operations.push(operation);
    if (operation === "enter-level-text") { input = "root\n=src\n==index.js"; output = "root\n└── src\n    └── index.js"; }
    else if (operation === "enter-tree-text") { input = "root\n=docs\n==README.md"; output = "root\n└── docs\n    └── README.md"; }
    else expect(operation).toBe("state");
    return { ready: true, input, output, visibilityState: "hidden", documentHidden: true };
  });
  nativeInvoke.mockImplementation(async (command: string) => {
    expect(command).toBe("native_published_data_snapshot");
    return { pluginId: "ascii-tree", readOnly: true, storage: { key: "ascii-tree:level-text", value: wrongDatabase ? "wrong" : input } };
  });
  const context = { probe, check(ok: unknown, label: string) { if (!ok) throw Error(label); },
    async until(read: () => unknown, label: string) { const value = await read(); if (!value) throw Error(label); return value; },
    observations: {}, setPhase: vi.fn() } as unknown as PublishedScenarioContext;
  return { context, operations };
}

it("ASCII scenario uses fixed original input operations and independently requires exact SQLite contents", async () => {
  const test = asciiScenarioHarness(), result = await runOriginalAsciiTreeScenario(test.context);
  expect(test.operations.filter(operation => operation !== "state")).toEqual(["enter-level-text", "enter-tree-text", "enter-level-text"]);
  expect(nativeInvoke).toHaveBeenCalledOnce(); expect(nativeInvoke).toHaveBeenCalledWith("native_published_data_snapshot");
  expect(test.context.observations.originalAsciiTreeEditing).toMatchObject({ persisted: { input: "root\n=src\n==index.js", documentHidden: true },
    database: { pluginId: "ascii-tree", readOnly: true } });
  expect(result.notTested).toContain("physical keyboard/pointer");
});

it("does not accept rendered ASCII editor values when the independent SQLite projection differs", async () => {
  await expect(runOriginalAsciiTreeScenario(asciiScenarioHarness(true).context)).rejects.toThrow("Independent SQLite projection");
});

function asciiReopenHarness(nativeDialogs = 0) {
  // Synthetic permission mocks verify scenario ordering only; no native approval, panel, plugin or persistence is executed.
  document.body.innerHTML = '<input class="search-input"><button role="option" data-plugin-id="ascii-tree" data-result-code="ascii-tree-open">ASCII Tree</button>';
  const previousFrame = document.createElement("iframe"), order: string[] = [];
  const probe = vi.fn(async (operation: string) => {
    expect(operation).toBe("state");
    return { ready: true, input: "root\n=src\n==index.js", output: "root\n└── src\n    └── index.js", origin: "null",
      parentDocumentAccessBlocked: true, tauriInternalsType: "undefined", globalTauriType: "undefined" };
  });
  dataApproval.mockImplementation(async () => { order.push("data"); return { synthetic: true }; });
  saveApproval.mockImplementation(async () => {
    order.push("save");
    const dialog = document.createElement("section"); dialog.dataset.permissionDialog = "";
    dialog.innerHTML = "<h2>ASCII Tree 请求访问本机</h2><button>允许一次</button>"; document.body.append(dialog);
    dialog.querySelector("button")!.onclick = () => {
      order.push("node"); dialog.remove();
      const frame = document.createElement("iframe"); frame.title = "Plugin"; frame.setAttribute("sandbox", "allow-scripts"); document.body.append(frame);
    };
    return { synthetic: true, nativePanelOpened: false };
  });
  nativeInvoke.mockImplementation(async (command: string) => {
    if (command === "list_pending_agent_requests") return [{ tool_name: "legacy_node_" + "a".repeat(64), client_id: "atools-ui" }];
    if (command === "native_published_runtime_state") {
      const open = !!document.querySelector('iframe[title="Plugin"]');
      return { legacySessions: open ? 1 : 0, legacyTransport: open, pendingRequests: open ? 0 : 1, dataSessions: 1, dataTransport: true,
        hostSessions: 0, hostTransport: false, activePathSnapshots: 0, dialogSessions: 1, dialogTransport: true,
        nativeDialogs, dialogIntents: 0, dialogPreparations: 0, dialogInvocations: 0 };
    }
    if (command === "native_published_data_snapshot") return { pluginId: "ascii-tree", readOnly: true,
      storage: { key: "ascii-tree:level-text", value: "root\n=src\n==index.js" } };
    throw Error("Unexpected native command in synthetic scenario test: " + command);
  });
  const context = { profile: { id: "ascii-tree", title: "ASCII Tree", searchQuery: "ascii-tree", featureCode: "ascii-tree-open" },
    probe, check(ok: unknown, label: string) { if (!ok) throw Error(label); },
    async until(read: () => unknown, label: string) { const value = await read(); if (!value) throw Error(label); return value; },
    observations: {}, setPhase: vi.fn() } as unknown as PublishedScenarioContext;
  return { context, previousFrame, order };
}

it("ASCII reopen requests data then save then Node permissions and reports three fresh approvals without opening a native panel", async () => {
  const test = asciiReopenHarness(); await verifyOriginalAsciiTreeAfterReopen(test.context, test.previousFrame);
  expect(test.order).toEqual(["data", "save", "node"]); expect(saveApproval).toHaveBeenCalledOnce(); expect(saveApproval).toHaveBeenCalledWith(test.context);
  expect(test.context.observations.originalAsciiTreeAfterWholeReopen).toMatchObject({ freshOneTimeApprovals: 3, newIframe: true,
    documentsInjected: false, nativePanelOpened: false, runtime: { dialogSessions: 1, dialogTransport: true, nativeDialogs: 0 } });
});

it("does not accept reopened ASCII state if a native panel is active", async () => {
  const test = asciiReopenHarness(1);
  await expect(verifyOriginalAsciiTreeAfterReopen(test.context, test.previousFrame)).rejects.toThrow("unused save permission");
  expect(test.context.observations.originalAsciiTreeAfterWholeReopen).toBeUndefined();
});

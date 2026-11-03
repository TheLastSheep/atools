import { afterEach, beforeEach, expect, it, vi } from "vitest";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import registry from "../fixtures/published-plugin-cases.json";
import probeSource from "./nativePublishedPluginFrameProbe.js?raw";
import calculatorOperationsSource from "./nativeOriginalCalculatorFrameOperations.js?raw";
import { createFrameProbe, preparedResourceLeaseExpectation, type PublishedFixture } from "./nativePublishedPluginCommon";

beforeEach(() => { vi.useFakeTimers(); document.body.innerHTML = ""; });
afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); vi.useRealTimers(); });

function harness(caseId = registry.cases[0].caseId, operationsSource?: string) {
  // Synthetic frame and reviewed test transport only. No original plugin, preload or GUI executes.
  const profile = { ...registry.cases[0], caseId }, token = "owned-fixture-token";
  const frame = document.createElement("iframe"); frame.title = "Plugin"; frame.srcdoc = "<!doctype html><body>synthetic frame</body>";
  document.body.append(frame);
  const source = frame.contentWindow!;
  const context = { fixture: { profile, token } as PublishedFixture, observations: {} as Record<string, any>,
    check: vi.fn((ok: unknown, label: string) => { if (!ok) throw Error(label); }) };
  const sent: any[] = [], replies: any[] = [];
  let receive: ((event: any) => void) | undefined;
  let mutateReply: (message: any) => any = value => value;
  let afterReadyReply: (() => void) | undefined;
  const parent: any = { postMessage(message: any) {
    replies.push(message);
    const result = mutateReply(message);
    if (result) window.dispatchEvent(new MessageEvent("message", { source, data: result }));
    if (message.kind === "atools-published-probe-ready-result") afterReadyReply?.();
  } };
  Object.defineProperty(parent, "document", { get: () => { throw Error("Opaque parent"); } });
  vi.spyOn(source, "postMessage").mockImplementation((message: any) => { sent.push(message); receive?.({ source: parent, data: message }); });
  const state = vi.fn(() => ({ synthetic: true })), perform = vi.fn(() => ({ changed: true }));
  function install(options: { caseId?: string; readyState?: string; url?: string; adapter?: boolean } = {}) {
    const adapter = { caseId: options.caseId ?? profile.caseId, state, perform };
    const child: any = { parent, top: parent, crypto: webcrypto,
      __ATOOLS_PUBLISHED_CASE_OPERATIONS__: operationsSource ? undefined : options.adapter === false ? undefined : adapter,
      addEventListener(kind: string, callback: (event: any) => void) { if (kind === "message") receive = callback; } };
    const documentState = { URL: options.url ?? "about:srcdoc", readyState: options.readyState ?? "complete", title: "synthetic",
      body: { innerText: "synthetic" }, scripts: [] as HTMLScriptElement[], querySelector: () => null,
      addEventListener: vi.fn() };
    const code = (operationsSource ? operationsSource + "\n" : "") + probeSource;
    const replacedCode = code.replaceAll("__ATOOLS_PUBLISHED_TOKEN__", token).replaceAll("__ATOOLS_PUBLISHED_CASE_ID__", profile.caseId);
    vm.runInNewContext(replacedCode, { window: child, document: documentState, location: { origin: "null" },
      console: { error: () => {}, warn: () => {} } });
    return { child, documentState, adapter: operationsSource ? child.__ATOOLS_PUBLISHED_CASE_OPERATIONS__ : adapter };
  }
  const probe = createFrameProbe(context);
  return { frame, source, sent, replies, probe, context, state, perform, install,
    setResponder(callback: (message: any) => void) { receive = event => callback(event.data); },
    mutateReply(callback: typeof mutateReply) { mutateReply = callback; },
    afterReady(callback: () => void) { afterReadyReply = callback; } };
}

it.each(["local-my-calculator-zpx", "converted-my-calculator-source"])(
  "keeps the runtime case property stable across Rust-style whole-script replacement for %s",
  async caseId => {
    const test = harness(caseId, calculatorOperationsSource);
    const installed = test.install();
    expect(installed.adapter.caseId).toBe(caseId);
    const result = test.probe("state");
    await expect(result).resolves.toMatchObject({ documentState: "complete", origin: "null" });
    expect(test.replies.filter(message => message.kind === "atools-published-probe-ready-result")).toHaveLength(1);
    expect(test.sent.filter(message => message.kind === "atools-published-probe-ready").length).toBeGreaterThanOrEqual(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("retries only readiness when its listener registers late, then sends the business action once", async () => {
  const test = harness(); const result = test.probe("synthetic-write");
  await vi.advanceTimersByTimeAsync(125);
  expect(test.sent.length).toBe(3); expect(test.sent.every(m => m.kind === "atools-published-probe-ready")).toBe(true);
  test.install();
  await vi.advanceTimersByTimeAsync(50);
  await expect(result).resolves.toMatchObject({ changed: true });
  expect(test.perform).toHaveBeenCalledOnce();
  expect(test.sent.filter(m => m.kind === "atools-published-probe")).toHaveLength(1);
  expect(test.context.observations.lastFrameProbe.readiness).toMatchObject({ attempts: 4, documentUrl: "about:srcdoc", documentState: "complete", documentNonceBound: true });
  expect(vi.getTimerCount()).toBe(0);
});

it("does not call adapter state or perform during repeated readiness checks", async () => {
  const test = harness(); const child = test.install({ adapter: false });
  const result = test.probe("synthetic-write"); await vi.advanceTimersByTimeAsync(100);
  expect(test.perform).not.toHaveBeenCalled(); expect(test.state).not.toHaveBeenCalled();
  child.child.__ATOOLS_PUBLISHED_CASE_OPERATIONS__ = child.adapter;
  await vi.advanceTimersByTimeAsync(50); await result;
  expect(test.perform).toHaveBeenCalledOnce();
});

it("awaits an asynchronous UI operation without replaying it or reporting a Promise as state", async () => {
  const test = harness(); test.install();
  test.perform.mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 30));
    return { changed: true, completed: true };
  });
  const result = test.probe("synthetic-async-write");
  await vi.advanceTimersByTimeAsync(20);
  expect(test.perform).toHaveBeenCalledOnce();
  expect(test.replies.filter(message => message.kind === "atools-published-probe-result")).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(10);
  await expect(result).resolves.toMatchObject({ changed: true, completed: true });
  expect(test.perform).toHaveBeenCalledOnce();
  expect(test.sent.filter(message => message.kind === "atools-published-probe")).toHaveLength(1);
});

it.each([
  ["wrong token", { token: "foreign" }], ["wrong request", { id: "old-request" }],
  ["wrong case", { caseId: "unregistered" }], ["wrong operation", { operation: "state" }],
  ["wrong kind", { kind: "atools-published-probe-result" }], ["wrong nonce", { documentNonce: "invalid" }],
])("ignores readiness replies with %s and never sends business after timeout", async (_, changed) => {
  const test = harness(); test.install();
  test.mutateReply(message => ({ ...message, ...changed }));
  const result = test.probe("synthetic-write"); const rejected = expect(result).rejects.toThrow("readiness timeout");
  await vi.advanceTimersByTimeAsync(5000); await rejected;
  expect(test.perform).not.toHaveBeenCalled(); expect(test.sent.every(m => m.kind === "atools-published-probe-ready")).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects a foreign frame reply even if all transport fields match", async () => {
  const test = harness();
  test.setResponder(message => window.dispatchEvent(new MessageEvent("message", { source: window, data: {
    kind: "atools-published-probe-ready-result", token: message.token, id: message.id, caseId: message.caseId,
    operation: "ready", ready: true, documentNonce: "a".repeat(32), documentUrl: "about:srcdoc", documentState: "complete",
  } })));
  const result = test.probe("synthetic-write"), rejected = expect(result).rejects.toThrow("readiness timeout");
  await vi.advanceTimersByTimeAsync(5000); await rejected;
  expect(test.sent.every(m => m.kind === "atools-published-probe-ready")).toBe(true);
});

it.each([
  { readyState: "loading" }, { url: "about:blank" }, { caseId: "unregistered-adapter" }, { adapter: false },
])("never reports readiness for an unloaded, wrong-document or unregistered adapter: %j", async options => {
  const test = harness(); test.install(options);
  const result = test.probe("synthetic-write"), rejected = expect(result).rejects.toThrow("readiness timeout");
  await vi.advanceTimersByTimeAsync(5000); await rejected;
  expect(test.replies).toEqual([]); expect(test.perform).not.toHaveBeenCalled(); expect(test.state).not.toHaveBeenCalled();
});

it("binds the parent element and srcdoc generation before sending any business operation", async () => {
  const test = harness();
  const result = test.probe("synthetic-write"), rejected = expect(result).rejects.toThrow("changed during readiness");
  await vi.advanceTimersByTimeAsync(10);
  test.frame.srcdoc = "<!doctype html><body>replacement</body>";
  await vi.advanceTimersByTimeAsync(50); await rejected;
  expect(test.sent.filter(m => m.kind === "atools-published-probe")).toHaveLength(0);
});

it("uses a fresh document nonce to prevent a same-WindowProxy navigation from executing a stale action", async () => {
  const test = harness(); test.install(); let replaced = false;
  test.afterReady(() => { if (!replaced) { replaced = true; test.install(); } });
  const result = test.probe("synthetic-write"), rejected = expect(result).rejects.toThrow("operation timeout (not replayed)");
  await vi.advanceTimersByTimeAsync(5001); await rejected;
  expect(test.perform).not.toHaveBeenCalled();
  expect(test.sent.filter(m => m.kind === "atools-published-probe")).toHaveLength(1);
});

it("never replays a write when its valid action response is lost", async () => {
  const test = harness(); test.install();
  test.mutateReply(message => message.kind === "atools-published-probe-result" ? null : message);
  const result = test.probe("synthetic-write"), rejected = expect(result).rejects.toThrow("operation timeout (not replayed)");
  await vi.advanceTimersByTimeAsync(5001); await rejected;
  expect(test.perform).toHaveBeenCalledOnce();
  expect(test.sent.filter(m => m.kind === "atools-published-probe")).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects stale action responses and caller attempts to replace transport identity without replay", async () => {
  const test = harness(); test.install();
  await expect(test.probe("synthetic-write", { token: "foreign" })).rejects.toThrow("transport identity");
  expect(test.sent).toEqual([]);
  test.mutateReply(message => message.kind === "atools-published-probe-result" ? { ...message, documentNonce: "0".repeat(32) } : message);
  const result = test.probe("synthetic-write"), rejected = expect(result).rejects.toThrow("operation timeout (not replayed)");
  await vi.advanceTimersByTimeAsync(5001); await rejected;
  expect(test.perform).toHaveBeenCalledOnce(); expect(test.sent.filter(m => m.kind === "atools-published-probe")).toHaveLength(1);
});

it("derives exact leases from prepared transports while keeping session IDs and URLs out of diagnostics", async () => {
  const test = harness(), child = test.install();
  const session = "12345678-1234-4234-8234-123456789abc";
  const lease = `atools-plugin://localhost/${session}/app.js`;
  function script(type: string, src?: string, marker = src) {
    const node = document.createElement("script"); node.type = type;
    if (src) node.setAttribute("src", src);
    if (marker) node.setAttribute("data-atools-plugin-script-src", marker);
    return node;
  }
  const inline = script("module"); inline.textContent = "import './local.mjs'";
  const preparedInline = script("module"); preparedInline.textContent = `import ${JSON.stringify(lease)}`;
  preparedInline.setAttribute("data-atools-plugin-module-imports", JSON.stringify([lease]));
  const classic = script("", "asset://localhost/classic.js"); classic.defer = true;
  for (const [nodes, expected] of [
    [[inline], 0], [[classic], 0], [[script("module", lease)], 1], [[preparedInline], 1],
    [[inline, classic, script("module", lease), script("module", lease.replace("app.js", "other.js"))], 1],
  ] as const) {
    child.documentState.scripts = [...nodes];
    const result = await test.probe<any>("state");
    expect(preparedResourceLeaseExpectation(result)).toBe(expected);
    expect(JSON.stringify(result.scripts)).not.toContain(session);
    expect(JSON.stringify(result.scripts)).not.toContain("app.js");
  }
  for (const nodes of [
    [script("module", lease, "asset://localhost/foreign.js")],
    [script("module", "atools-plugin://localhost/invalid/app.js")],
    [script("module", lease), script("module", lease.replace(session, "87654321-4321-4321-8321-cba987654321"))],
  ]) {
    child.documentState.scripts = nodes;
    const result = await test.probe<any>("state");
    expect(() => preparedResourceLeaseExpectation(result)).toThrow();
  }
  preparedInline.textContent = "export const untouched = true";
  child.documentState.scripts = [preparedInline];
  const unmatched = await test.probe<any>("state");
  expect(() => preparedResourceLeaseExpectation(unmatched)).toThrow(/rewritten source/);
  expect(() => preparedResourceLeaseExpectation({})).toThrow(/evidence/);
});

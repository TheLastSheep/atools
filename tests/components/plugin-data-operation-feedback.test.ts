// @vitest-environment node
import { TextEncoder } from "node:util";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginDataBridge, pluginDataBridgeScript } from "../../src/lib/pluginDataBridge";
import { createPluginDataOperationFeedback } from "../../src/lib/pluginDataOperationFeedback";
import { createPluginDataMutationFeedback } from "../../src/lib/pluginDataMutationFeedback";

const instanceId = "fbe106e1-87f6-430c-b1d0-8688dd88ab14";
const endpoint = "http://127.0.0.1:12345/data/" + "a".repeat(64);
const nextEndpoint = "http://127.0.0.1:12345/data/" + "b".repeat(64);
const alertCopy = "ATools：数据写入未完成，请在插件中重试。";
const windows: JSDOM[] = [];

class FixtureRequest {
  static requests: FixtureRequest[] = [];
  static response: unknown = { ok: false, error: { message: "raw backend secret detail" } };
  static respondAutomatically = true;
  status = 200;
  responseText = "";
  timeout = 0;
  asynchronous = false;
  body = "";
  target = "";
  onload?: () => void;
  onerror?: () => void;
  ontimeout?: () => void;
  onabort?: () => void;

  open(method: string, target: string, asynchronous: boolean) {
    expect(method).toBe("POST");
    this.target = target;
    this.asynchronous = asynchronous;
  }
  setRequestHeader(name: string, value: string) { expect([name, value]).toEqual(["Content-Type", "application/json"]); }
  send(body: string) {
    this.body = body;
    FixtureRequest.requests.push(this);
    if (!this.asynchronous) {
      this.responseText = JSON.stringify(FixtureRequest.response);
    } else if (FixtureRequest.respondAutomatically) {
      const response = FixtureRequest.response;
      queueMicrotask(() => this.complete(response));
    }
  }
  complete(response: unknown) {
    this.responseText = JSON.stringify(response);
    this.onload?.();
  }
  abort() { this.onabort?.(); }
}

function openBridgePage() {
  FixtureRequest.requests = [];
  FixtureRequest.response = { ok: false, error: { message: "raw backend secret detail" } };
  FixtureRequest.respondAutomatically = true;
  const dom = new JSDOM("<!doctype html><html><head></head><body><input id='editor' /></body></html>", {
    url: "https://fixture.invalid/", runScripts: "outside-only",
  });
  windows.push(dom);
  const page = dom.window as unknown as Window & {
    utools: Record<string, any>;
    ztools: Record<string, any>;
    XMLHttpRequest: typeof FixtureRequest;
    TextEncoder: typeof TextEncoder;
    __atoolsPluginData: ReturnType<typeof createPluginDataBridge>;
  };
  Object.defineProperties(page, {
    utools: { configurable: true, value: {} },
    ztools: { configurable: true, value: {} },
    XMLHttpRequest: { configurable: true, value: FixtureRequest },
    TextEncoder: { configurable: true, value: TextEncoder },
  });
  const source = pluginDataBridgeScript({ instanceId, endpoint })
    .replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
  page.eval(source);
  return { dom, page };
}

function host(page: Window) {
  return page.document.querySelector<HTMLElement>("[data-atools-data-operation-feedback]");
}

function alert(page: Window) {
  return host(page)?.shadowRoot?.querySelector<HTMLElement>("[role=alert]") ?? null;
}

afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close();
});

describe("plugin data operation feedback", () => {
  it("shows a safe shadow alert for an XHR write rejection and preserves explicit retry affordance", async () => {
    const { dom, page } = openBridgePage();
    const editor = dom.window.document.querySelector<HTMLInputElement>("#editor")!;
    editor.focus();
    const documentId = "pasteboard-pro:record:sha256:paste-created";
    const failedWrite = page.utools.db.promises.put({ _id: documentId, value: "fixture content" });
    await expect(failedWrite).rejects.toMatchObject({ code: "ERR_ATOOLS_DATA_REJECTED" });

    expect(FixtureRequest.requests).toHaveLength(1);
    expect(JSON.parse(FixtureRequest.requests[0]!.body).method).toBe("db.put");
    const notice = host(page);
    expect(notice).not.toBeNull();
    expect(alert(page)?.textContent).toContain(alertCopy);
    expect(alert(page)?.getAttribute("aria-live")).toBe("assertive");
    expect(notice?.shadowRoot?.textContent).not.toContain("raw backend secret detail");
    const close = notice?.shadowRoot?.querySelector<HTMLButtonElement>("button[aria-label='关闭数据错误提示']");
    expect(close).not.toBeNull();

    // An ordinary successful read must not clear an unresolved write failure.
    FixtureRequest.response = { ok: true, result: { _id: "read-only" } };
    await expect(page.utools.db.promises.get("read-only")).resolves.toEqual({ _id: "read-only" });
    expect(host(page)).toBe(notice);

    close!.focus();
    close!.click();
    expect(host(page)).toBeNull();
    expect(dom.window.document.activeElement).toBe(editor);

    FixtureRequest.response = { ok: false, error: { message: "second backend detail" } };
    await expect(page.utools.db.promises.put({ _id: documentId })).rejects.toMatchObject({ code: "ERR_ATOOLS_DATA_REJECTED" });
    expect(host(page)).not.toBeNull();
    page.__atoolsPluginData.close();
    expect(host(page)).toBeNull();
  });

  it("clears only on a newer successful write to the same document ID, then reports later failures again", async () => {
    const { page } = openBridgePage();
    const documentId = "pasteboard-pro:record:sha256:retry-target";
    await expect(page.utools.db.promises.put({ _id: documentId, value: "first" }))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_DATA_REJECTED" });
    expect(host(page)).not.toBeNull();

    FixtureRequest.response = { ok: true, result: null };
    await expect(page.utools.db.promises.put({ _id: documentId, value: "retry" })).resolves.toBeNull();
    expect(host(page)).toBeNull();

    FixtureRequest.response = { ok: false, error: { message: "third backend detail" } };
    await expect(page.utools.db.promises.put({ _id: documentId, value: "later failure" }))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_DATA_REJECTED" });
    expect(host(page)).not.toBeNull();
  });

  it("keeps the alert after a successful read or a successful write to a different document ID", async () => {
    const { page } = openBridgePage();
    const failedId = "pasteboard-pro:record:sha256:failed-target";
    await expect(page.utools.db.promises.put({ _id: failedId }))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_DATA_REJECTED" });
    expect(host(page)).not.toBeNull();

    FixtureRequest.response = { ok: true, result: { _id: "pasteboard-pro:record:sha256:read-target" } };
    await expect(page.utools.db.promises.get("pasteboard-pro:record:sha256:read-target"))
      .resolves.toMatchObject({ _id: "pasteboard-pro:record:sha256:read-target" });
    expect(host(page)).not.toBeNull();

    FixtureRequest.response = { ok: true, result: null };
    await expect(page.utools.db.promises.put({ _id: "pasteboard-pro:record:sha256:other-target" })).resolves.toBeNull();
    expect(host(page)).not.toBeNull();

    await expect(page.utools.db.promises.put({ _id: failedId })).resolves.toBeNull();
    expect(host(page)).toBeNull();
  });

  it("keeps ambiguous, long, batch, and URL-scoped writes manual-dismiss-only", async () => {
    const cases: Array<readonly [string, boolean, (page: ReturnType<typeof openBridgePage>["page"]) => unknown]> = [
      ["batch", true, page => page.utools.db.promises.bulkDocs([{ _id: "batch-target" }])],
      ["long ID", true, page => page.utools.db.promises.put({ _id: "x".repeat(513) })],
      ["web storage", false, page => page.__atoolsPluginData.webStorage.setItem("client", "https://fixture.invalid/", "key", "value")],
    ];
    for (const [name, asynchronous, write] of cases) {
      const { page } = openBridgePage();
      if (asynchronous) await expect(write(page) as Promise<unknown>).rejects.toMatchObject({ code: "ERR_ATOOLS_DATA_REJECTED" });
      else expect(() => write(page)).toThrow(expect.objectContaining({ code: "ERR_ATOOLS_DATA_REJECTED" }));
      expect(host(page), name).not.toBeNull();

      FixtureRequest.response = { ok: true, result: null };
      if (asynchronous) await expect(write(page) as Promise<unknown>).resolves.toBeNull();
      else expect(write(page)).toBeNull();
      expect(host(page), name).not.toBeNull();
      page.__atoolsPluginData.close();
    }
  });

  it("does not let an older completion clear a newer failure, but a later same-ID success can", async () => {
    const { page } = openBridgePage();
    const documentId = "pasteboard-pro:record:sha256:concurrent-target";
    FixtureRequest.respondAutomatically = false;
    const older = page.utools.db.promises.put({ _id: documentId, value: "older" });
    const olderOutcome = expect(older).resolves.toBeNull();
    const newer = page.utools.db.promises.put({ _id: documentId, value: "newer" });
    const newerOutcome = expect(newer).rejects.toMatchObject({ code: "ERR_ATOOLS_DATA_REJECTED" });
    FixtureRequest.requests[1]!.complete({ ok: false, error: { message: "newer failure" } });
    await newerOutcome;
    expect(host(page)).not.toBeNull();

    FixtureRequest.requests[0]!.complete({ ok: true, result: null });
    await olderOutcome;
    expect(host(page)).not.toBeNull();

    FixtureRequest.respondAutomatically = true;
    FixtureRequest.response = { ok: true, result: null };
    await expect(page.utools.db.promises.put({ _id: documentId, value: "latest retry" })).resolves.toBeNull();
    expect(host(page)).toBeNull();
  });

  it("does not clear an old-generation error from a successful write in a replacement session", async () => {
    const { page } = openBridgePage();
    const documentId = "pasteboard-pro:record:sha256:session-target";
    await expect(page.utools.db.promises.put({ _id: documentId }))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_DATA_REJECTED" });
    expect(host(page)).not.toBeNull();

    page.__atoolsPluginData.install(nextEndpoint);
    FixtureRequest.response = { ok: true, result: null };
    await expect(page.utools.db.promises.put({ _id: documentId })).resolves.toBeNull();
    expect(host(page)).not.toBeNull();
    page.__atoolsPluginData.close();
    expect(host(page)).toBeNull();
  });

  it("does not report read failures or stale writes canceled by session rotation and close", async () => {
    const { page } = openBridgePage();
    await expect(page.utools.db.promises.get("read-only")).rejects.toMatchObject({ code: "ERR_ATOOLS_DATA_REJECTED" });
    expect(host(page)).toBeNull();

    FixtureRequest.respondAutomatically = false;
    const rotatedWrite = page.utools.db.promises.put({ _id: "rotated" });
    page.__atoolsPluginData.install(nextEndpoint);
    await expect(rotatedWrite).rejects.toMatchObject({ code: "ERR_ATOOLS_DATA_SESSION" });
    FixtureRequest.requests[1]!.complete({ ok: false, error: { message: "late rejection" } });
    expect(host(page)).toBeNull();

    const closedWrite = page.utools.db.promises.put({ _id: "closed" });
    page.__atoolsPluginData.close();
    await expect(closedWrite).rejects.toMatchObject({ code: "ERR_ATOOLS_DATA_CLOSED" });
    expect(host(page)).toBeNull();
  });

  it("does not show a write notice before data authorization or replace the original rejection if UI rendering fails", async () => {
    const unapprovedFeedback = vi.fn();
    const unapproved = createPluginDataBridge({ instanceId }, vi.fn(), {}, undefined,
      () => ({ failed: unapprovedFeedback, resolved: vi.fn(), close: vi.fn() }), createPluginDataMutationFeedback);
    await expect(unapproved.db.promises.put({ _id: "unapproved" }))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_DATA_PERMISSION_REQUIRED" });
    expect(unapprovedFeedback).not.toHaveBeenCalled();

    const original = Object.assign(new Error("original transport failure"), { code: "ERR_FIXTURE" });
    const resilient = createPluginDataBridge({ instanceId, endpoint }, vi.fn(), {
      async: async () => { throw original; },
    }, undefined, () => ({ failed: () => { throw new Error("UI failure"); }, resolved: vi.fn(), close: vi.fn() }),
    createPluginDataMutationFeedback);
    await expect(resilient.db.promises.put({ _id: "approved" })).rejects.toBe(original);
  });

  it("registers only one DOM-ready listener and removes it if the bridge closes before the document root exists", () => {
    let registeredListener: (() => void) | undefined;
    const fakeDocument = {
      documentElement: null,
      addEventListener: vi.fn((_name: string, listener: () => void) => { registeredListener = listener; }),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("document", fakeDocument);
    const feedback = createPluginDataOperationFeedback();
    feedback.failed(); feedback.failed();
    expect(fakeDocument.addEventListener).toHaveBeenCalledTimes(1);
    feedback.close();
    expect(fakeDocument.removeEventListener).toHaveBeenCalledWith("DOMContentLoaded", registeredListener, false);
    vi.unstubAllGlobals();
  });

  it("reports failures across the mutating API set while retaining the original errors and return values", async () => {
    const failed = vi.fn();
    const resolved = vi.fn();
    const feedback = () => ({ failed, resolved, close: vi.fn() });
    const failure = Object.assign(new Error("transport detail"), { code: "ERR_FIXTURE" });
    const asyncMethods: string[] = [];
    const syncMethods: string[] = [];
    const rejected = async (_target: string, payload: { method: string }) => { asyncMethods.push(payload.method); throw failure; };
    const syncRejected = (_target: string, payload: { method: string }) => { syncMethods.push(payload.method); throw failure; };
    const bridge = createPluginDataBridge(
      { instanceId, endpoint }, vi.fn(), { sync: syncRejected, async: rejected }, undefined, feedback, createPluginDataMutationFeedback,
    );
    const mutations: Array<readonly [string, string, "async" | "sync", () => unknown]> = [
      ["db.put", "db.put", "async", () => bridge.db.promises.put({ _id: "put" })],
      ["db.remove", "db.remove", "async", () => bridge.db.promises.remove({ _id: "remove" })],
      ["db.bulkDocs", "db.bulkDocs", "async", () => bridge.db.promises.bulkDocs([{ _id: "bulk" }])],
      ["db.postAttachment", "db.postAttachment", "async", () => bridge.db.promises.postAttachment("id", new Uint8Array([1]), "text/plain")],
      ["db.putAttachment", "db.postAttachment", "async", () => bridge.db.promises.putAttachment("id", new Uint8Array([1]), "text/plain")],
      ["dbStorage.setItem", "dbStorage.setItem", "sync", () => bridge.dbStorage.setItem("key", "value")],
      ["dbStorage.removeItem", "dbStorage.removeItem", "sync", () => bridge.dbStorage.removeItem("key")],
      ["webStorage.setItem", "webStorage.setItem", "sync", () => bridge.webStorage.setItem("client", "url", "key", "value")],
      ["webStorage.removeItem", "webStorage.removeItem", "sync", () => bridge.webStorage.removeItem("client", "url", "key")],
      ["webStorage.clear", "webStorage.clear", "sync", () => bridge.webStorage.clear("client", "url")],
      ["features.set", "features.set", "sync", () => bridge.dynamicFeatureCall("features.set", ["key", "value"])],
      ["features.remove", "features.remove", "sync", () => bridge.dynamicFeatureCall("features.remove", ["key"])],
      ["startup.set", "startup.set", "async", () => bridge.startupRegistration.set(["feature-code"])],
    ];
    for (const [method, wireMethod, mode, invoke] of mutations) {
      const before = failed.mock.calls.length;
      let result: unknown;
      try { result = invoke(); }
      catch (reason) { expect(reason).toMatchObject({ code: "ERR_FIXTURE" }); }
      if (result instanceof Promise) await expect(result).rejects.toMatchObject({ code: "ERR_FIXTURE" });
      expect(failed).toHaveBeenCalledTimes(before + 1);
      expect(method).toMatch(/^(db\.|dbStorage\.|webStorage\.|features\.|startup\.)/);
      expect((mode === "async" ? asyncMethods : syncMethods).at(-1)).toBe(wireMethod);
    }

    const logicalFailure = createPluginDataBridge(
      { instanceId, endpoint }, vi.fn(), { sync: () => ({ error: true, name: "conflict" }) }, undefined, feedback,
      createPluginDataMutationFeedback,
    );
    const before = failed.mock.calls.length;
    expect(logicalFailure.dbStorage.setItem("key", "value")).toMatchObject({ error: true, name: "conflict" });
    expect(failed).toHaveBeenCalledTimes(before + 1);

    const logicalResponses: unknown[] = [{ error: true, name: "conflict" }, { unexpected: true }, null];
    const storage = createPluginDataBridge({ instanceId, endpoint }, vi.fn(), {
      sync: () => logicalResponses.shift(),
    }, undefined, feedback, createPluginDataMutationFeedback);
    const beforeStorageFailure = failed.mock.calls.length;
    expect(storage.dbStorage.setItem("settings-key", "value")).toMatchObject({ error: true, name: "conflict" });
    expect(failed).toHaveBeenCalledTimes(beforeStorageFailure + 1);
    expect(() => storage.dbStorage.setItem("settings-key", "malformed retry"))
      .toThrow(expect.objectContaining({ code: "ERR_ATOOLS_DATA_RESPONSE" }));
    expect(failed).toHaveBeenCalledTimes(beforeStorageFailure + 2);
    expect(resolved).not.toHaveBeenCalled();
    expect(storage.dbStorage.setItem("settings-key", "retry")).toBeUndefined();
    expect(resolved).toHaveBeenCalledTimes(1);
    bridge.close(); logicalFailure.close(); storage.close();
  });
});

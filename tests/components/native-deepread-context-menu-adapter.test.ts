import { afterEach, describe, expect, it, vi } from "vitest";
import { createContext, runInContext } from "node:vm";
import operations from "./nativePublishedDeepReadFrameOperations.js?raw";
import frameProbe from "./nativePublishedPluginFrameProbe.js?raw";

type Adapter = { perform: (operation: string) => Record<string, unknown> | Promise<Record<string, unknown>> };
type PublishedWindow = Window & {
  eval?: (source: string) => unknown;
  __ATOOLS_PUBLISHED_ACTIVE_CASE__?: string;
  __ATOOLS_PUBLISHED_CASE_OPERATIONS__?: Adapter;
};
type PublishedChildWindow = PublishedWindow & {
  console: Console;
  MouseEvent: typeof MouseEvent;
  Event: typeof Event;
  HTMLInputElement: typeof HTMLInputElement;
};
type SyntheticMessage = { data: unknown; source: object | null };
type SyntheticListener = (event: SyntheticMessage) => unknown;

function evaluateScript(target: PublishedWindow, source: string): void {
  const evaluate = target.eval;
  if (typeof evaluate !== "function") throw Error("Fixture window cannot evaluate the operations adapter");
  evaluate.call(target, source);
}

const CASE_ID = "converted-deepread-source";
const TOKEN = "b568-fixed-token";
const ACTIVE_CASE = "converted-tetris-source";

function mount(renderDelayMs: number | null, actionCount = 1, changeCaseAfterMs: number | null = null) {
  document.body.innerHTML = '<article class="book-card"><h3>ATools DeepRead Reader Fixture</h3></article>';
  const appWindow = window as PublishedWindow;
  appWindow.__ATOOLS_PUBLISHED_ACTIVE_CASE__ = CASE_ID;
  let contextMenuEvents = 0;
  let contextMenuDefaultPrevented = false;
  let searchActionClicks = 0;
  const card = document.querySelector(".book-card")!;
  card.addEventListener("contextmenu", event => {
    contextMenuEvents += 1;
    event.preventDefault();
    contextMenuDefaultPrevented = event.defaultPrevented;
    if (renderDelayMs !== null) {
      setTimeout(() => {
        const menu = document.createElement("div");
        menu.className = "context-menu";
        for (let index = 0; index < actionCount; index += 1) {
          const action = document.createElement("button");
          action.textContent = "搜索跳转";
          action.addEventListener("click", () => {
            searchActionClicks += 1;
            menu.remove();
            const dialog = document.createElement("section");
            dialog.setAttribute("aria-labelledby", "book-search-title");
            dialog.innerHTML = "<input value='DeepRead fixed reading line 020'>";
            document.body.append(dialog);
          });
          menu.append(action);
        }
        document.body.append(menu);
      }, renderDelayMs);
    }
    if (changeCaseAfterMs !== null) {
      setTimeout(() => { appWindow.__ATOOLS_PUBLISHED_ACTIVE_CASE__ = ACTIVE_CASE; }, changeCaseAfterMs);
    }
  });
  evaluateScript(window as PublishedWindow, operations);
  return {
    perform: appWindow.__ATOOLS_PUBLISHED_CASE_OPERATIONS__!.perform,
    counts: () => ({ contextMenuEvents, contextMenuDefaultPrevented, searchActionClicks })
  };
}

function mountAuthenticatedFrame(renderDelayMs: number | null) {
  const frame = document.createElement("iframe");
  frame.title = "Plugin";
  frame.srcdoc = "<!doctype html><html><head></head><body></body></html>";
  document.body.append(frame);
  const childWindow = frame.contentWindow;
  if (!childWindow) throw Error("Fixture iframe has no content window");
  const child = childWindow as PublishedChildWindow;
  const childDocument = frame.contentDocument!;
  Object.defineProperty(childDocument, "URL", { configurable: true, value: "about:srcdoc" });
  Object.defineProperty(childDocument, "readyState", { configurable: true, value: "complete" });
  Object.defineProperty(childDocument.body, "innerText", {
    configurable: true, get: () => childDocument.body.textContent || ""
  });
  childDocument.body.innerHTML = '<article class="book-card"><h3>ATools DeepRead Reader Fixture</h3></article>';
  let contextMenuEvents = 0;
  let searchActionClicks = 0;
  const card = childDocument.querySelector(".book-card")!;
  card.addEventListener("contextmenu", event => {
    contextMenuEvents += 1;
    event.preventDefault();
    if (renderDelayMs !== null) setTimeout(() => {
      const menu = childDocument.createElement("div");
      menu.className = "context-menu";
      const action = childDocument.createElement("button");
      action.textContent = "搜索跳转";
      action.addEventListener("click", () => {
        searchActionClicks += 1;
        menu.remove();
        const dialog = childDocument.createElement("section");
        dialog.setAttribute("aria-labelledby", "book-search-title");
        dialog.innerHTML = "<input value='DeepRead fixed reading line 020'>";
        childDocument.body.append(dialog);
      });
      menu.append(action);
      childDocument.body.append(menu);
    }, renderDelayMs);
  });
  const childListeners = new Map<string, Set<SyntheticListener>>();
  const parentListeners = new Set<SyntheticListener>();
  const parent = {
    get document(): never { throw Error("Opaque synthetic parent document"); },
    addEventListener(type: string, listener: SyntheticListener) { if (type === "message") parentListeners.add(listener); },
    removeEventListener(type: string, listener: SyntheticListener) { if (type === "message") parentListeners.delete(listener); },
    postMessage(data: unknown) {
      queueMicrotask(() => parentListeners.forEach(listener => listener({ data, source: syntheticWindow })));
    }
  };
  const syntheticWindow: Record<string, unknown> = {
    crypto: childWindow.crypto,
    console: child.console,
    document: childDocument,
    location: childWindow.location,
    parent,
    top: parent,
    addEventListener(type: string, listener: SyntheticListener) {
      const listeners = childListeners.get(type) || new Set<SyntheticListener>();
      listeners.add(listener);
      childListeners.set(type, listeners);
    },
    removeEventListener(type: string, listener: SyntheticListener) { childListeners.get(type)?.delete(listener); }
  };
  const sandbox: Record<string, unknown> = {
    window: syntheticWindow,
    document: childDocument,
    location: childWindow.location,
    console: child.console,
    performance,
    setTimeout,
    clearTimeout,
    MouseEvent: child.MouseEvent,
    Event: child.Event,
    HTMLInputElement: child.HTMLInputElement
  };
  const context = createContext(sandbox);
  const probeSource = frameProbe.replaceAll("__ATOOLS_PUBLISHED_TOKEN__", TOKEN)
    .replaceAll("__ATOOLS_PUBLISHED_CASE_ID__", CASE_ID);
  runInContext(probeSource, context);
  runInContext(operations, context);
  const syntheticParent = parent as object;
  const send = (data: Record<string, unknown>, source: object | null = syntheticParent) => {
    queueMicrotask(() => childListeners.get("message")?.forEach(listener => listener({ data, source })));
  };
  const response = (kind: string, id: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => { parentListeners.delete(receive); reject(Error("frame probe response timeout;kind=" + kind)); }, 300);
    function receive(event: SyntheticMessage) {
      const message = event.data as Record<string, unknown>;
      if (event.source !== syntheticWindow || message.kind !== kind || message.id !== id) return;
      clearTimeout(timer);
      parentListeners.delete(receive);
      resolve(message);
    }
    parentListeners.add(receive);
  });
  const counts = () => ({ contextMenuEvents, searchActionClicks });
  return { frame, childDocument, syntheticWindow, send, response, counts };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
  const appWindow = window as PublishedWindow;
  delete appWindow.__ATOOLS_PUBLISHED_CASE_OPERATIONS__;
  delete appWindow.__ATOOLS_PUBLISHED_ACTIVE_CASE__;
});

describe("DeepRead bounded context-menu DOM synchronization", () => {
  it("waits for delayed menu render through the pinned probe over explicitly synthetic message transport", async () => {
    const fixture = mountAuthenticatedFrame(20);
    const readyId = "ready-1";
    const readyResponse = fixture.response("atools-published-probe-ready-result", readyId);
    fixture.send({ kind: "atools-published-probe-ready", token: TOKEN, id: readyId, caseId: CASE_ID, operation: "ready" });
    const ready = await readyResponse;
    expect(ready.kind).toBe("atools-published-probe-ready-result");
    expect(ready.token).toBe(TOKEN);
    expect(ready.caseId).toBe(CASE_ID);
    expect(ready.ready).toBe(true);
    expect(ready.documentNonce).toMatch(/^[a-f0-9]{32}$/);

    const operationId = "operation-1";
    const operationResponse = fixture.response("atools-published-probe-result", operationId);
    fixture.send({ kind: "atools-published-probe", token: TOKEN, id: operationId, caseId: CASE_ID,
      operation: "open-search-jump", documentNonce: ready.documentNonce, workerLeaseSessions: [] });
    const result = await operationResponse;
    expect(result.kind).toBe("atools-published-probe-result");
    expect(result.token).toBe(TOKEN);
    expect(result.caseId).toBe(CASE_ID);
    expect(result.id).toBe(operationId);
    expect(result.operation).toBe("open-search-jump");
    expect(result.documentNonce).toBe(ready.documentNonce);
    expect(result.error).toBeUndefined();
    expect((result.state as Record<string, unknown>).searchOpen).toBe(true);
    expect(fixture.counts()).toEqual({ contextMenuEvents: 1, searchActionClicks: 1 });
  });

  it("fails closed with bounded diagnostics when the menu or action never renders", async () => {
    const fixture = mount(null);
    await expect(Promise.resolve().then(() => fixture.perform("open-search-jump"))).rejects.toThrow(
      "DeepRead menu probe failed;stage=render-timeout;menuCount=0;buttonCount=0;actionCount=0");
    expect(fixture.counts()).toEqual({ contextMenuEvents: 1, contextMenuDefaultPrevented: true, searchActionClicks: 0 });
  });

  it("rejects a matching action first observed after the fixed render deadline", async () => {
    vi.useFakeTimers();
    const clock = vi.spyOn(window.performance, "now").mockReturnValue(0);
    const fixture = mount(null);
    const pending = Promise.resolve(fixture.perform("open-search-jump"));
    const observed = pending.then(
      (value: unknown) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    const lateMenu = document.createElement("div");
    lateMenu.className = "context-menu";
    const lateAction = document.createElement("button");
    lateAction.textContent = "搜索跳转";
    lateAction.addEventListener("click", () => { throw Error("late action must not run"); });
    lateMenu.append(lateAction);
    document.body.append(lateMenu);
    clock.mockReturnValue(161);
    await vi.advanceTimersByTimeAsync(12);
    const outcome = await observed;
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.error).toBeInstanceOf(Error);
      if (outcome.error instanceof Error) expect(outcome.error.message).toBe(
        "DeepRead menu probe failed;stage=render-timeout;menuCount=1;buttonCount=1;actionCount=1");
    }
    expect(fixture.counts()).toEqual({ contextMenuEvents: 1, contextMenuDefaultPrevented: true, searchActionClicks: 0 });
  });

  it("rejects duplicate matching actions without clicking either", async () => {
    const fixture = mount(4, 2);
    await expect(Promise.resolve().then(() => fixture.perform("open-search-jump"))).rejects.toThrow(
      "DeepRead menu probe failed;stage=ambiguous-action;menuCount=1;buttonCount=2;actionCount=2");
    expect(fixture.counts()).toEqual({ contextMenuEvents: 1, contextMenuDefaultPrevented: true, searchActionClicks: 0 });
  });

  it("rejects a stale case scope after the awaited render window", async () => {
    const fixture = mount(null, 1, 4);
    await expect(Promise.resolve().then(() => fixture.perform("open-search-jump"))).rejects.toThrow(
      "DeepRead menu probe failed;stage=case-changed;menuCount=0;buttonCount=0;actionCount=0");
    expect(fixture.counts()).toEqual({ contextMenuEvents: 1, contextMenuDefaultPrevented: true, searchActionClicks: 0 });
  });

  it("rejects wrong source, token, case, nonce, missing id and unknown operation through the full frame protocol", async () => {
    const fixture = mountAuthenticatedFrame(2);
    const readyId = "identity-ready";
    const readyResponse = fixture.response("atools-published-probe-ready-result", readyId);
    fixture.send({ kind: "atools-published-probe-ready", token: TOKEN, id: readyId, caseId: CASE_ID, operation: "ready" });
    const ready = await readyResponse;
    const invalidMessages = [
      { kind: "atools-published-probe", token: "wrong", id: "bad-token", caseId: CASE_ID, operation: "open-search-jump", documentNonce: ready.documentNonce },
      { kind: "atools-published-probe", token: TOKEN, id: "bad-case", caseId: ACTIVE_CASE, operation: "open-search-jump", documentNonce: ready.documentNonce },
      { kind: "unknown-probe", token: TOKEN, id: "bad-kind", caseId: CASE_ID, operation: "open-search-jump", documentNonce: ready.documentNonce },
      { kind: "atools-published-probe", token: TOKEN, id: "bad-nonce", caseId: CASE_ID, operation: "open-search-jump", documentNonce: "0".repeat(32) },
      { kind: "atools-published-probe", token: TOKEN, id: "", caseId: CASE_ID, operation: "open-search-jump", documentNonce: ready.documentNonce }
    ];
    const foreignSource = {};
    for (const [index, message] of invalidMessages.entries()) {
      fixture.send(message, index === 0 ? foreignSource : window);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fixture.counts()).toEqual({ contextMenuEvents: 0, searchActionClicks: 0 });

    const unknownId = "unknown-operation";
    const unknownResponse = fixture.response("atools-published-probe-result", unknownId);
    fixture.send({ kind: "atools-published-probe", token: TOKEN, id: unknownId, caseId: CASE_ID,
      operation: "not-a-reviewed-operation", documentNonce: ready.documentNonce, workerLeaseSessions: [] });
    const rejected = await unknownResponse;
    expect(rejected.operation).toBe("not-a-reviewed-operation");
    expect(rejected.error).toBe("Unknown reviewed DeepRead operation: not-a-reviewed-operation");
    expect(fixture.counts()).toEqual({ contextMenuEvents: 0, searchActionClicks: 0 });
  });

  it("preserves synchronous validation throws for non-menu operations", () => {
    const fixture = mount(null);
    expect(() => fixture.perform("accept-first-use-disclaimer")).toThrow(
      "Reviewed DeepRead DOM missing: original first-use disclaimer");
  });
});

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import vm from "node:vm";
import source from "./nativeTetrisFrameOperations.js?raw";
import frameProbeSource from "./nativePublishedPluginFrameProbe.js?raw";
type Adapter = { caseId: string | null; state: () => Record<string, any>; perform: (operation: string, data: Record<string, unknown>) => Promise<Record<string, any>> };
const host = window as unknown as { __ATOOLS_PUBLISHED_ACTIVE_CASE__?: string; __ATOOLS_PUBLISHED_CASE_OPERATIONS__?: Adapter };
let adapter: Adapter;
let pixels: Uint8ClampedArray;
let moveListener: EventListener;
function envelope(operation: string, extra: Record<string, unknown> = {}) {
  return { kind: "atools-published-probe", token: "tetris-token", id: "tetris-operation", caseId: "converted-tetris-source",
    operation, documentNonce: "a".repeat(32), workerLeaseSessions: [], ...extra };
}
function fixture() {
  document.body.innerHTML = `<div id="homeScreen"><button>开始游戏</button><button>设 置</button></div>
    <div id="settingsScreen" style="display:none"><button class="back-btn">← 返回</button>
      <div class="theme-card"><div class="theme-card-info"><h4>现代极简</h4></div></div><div class="theme-card"><div class="theme-card-info"><h4>复古像素</h4></div></div></div>
    <div id="gameScreen" style="display:none"><div class="game-board"><canvas width="2" height="2"></canvas></div>
      <div class="control-item">← : 移动</div><div class="score-value">0</div><button>暂停</button></div>
    <div id="pauseOverlay" style="display:none"><button>继续游戏</button><button>进入设置</button></div>`;
  document.querySelector<HTMLButtonElement>("#homeScreen button")!.addEventListener("click", () => {
    document.querySelector<HTMLElement>("#homeScreen")!.style.display = "none";
    document.querySelector<HTMLElement>("#gameScreen")!.style.display = "block";
  });
  document.querySelector<HTMLButtonElement>("#gameScreen button")!.addEventListener("click", () => {
    const overlay = document.querySelector<HTMLElement>("#pauseOverlay")!;
    overlay.style.display = "flex"; overlay.classList.add("show");
  });
  document.querySelector<HTMLButtonElement>("#pauseOverlay button")!.addEventListener("click", () => {
    const overlay = document.querySelector<HTMLElement>("#pauseOverlay")!;
    overlay.style.display = "none"; overlay.classList.remove("show");
  });
  document.querySelectorAll<HTMLButtonElement>("#pauseOverlay button")[1].addEventListener("click", () => {
    document.querySelector<HTMLElement>("#gameScreen")!.style.display = "none";
    document.querySelector<HTMLElement>("#settingsScreen")!.style.display = "block";
  });
  document.querySelectorAll<HTMLElement>(".theme-card").forEach(card => card.addEventListener("click", event => {
    const target = (event.currentTarget as HTMLElement);
    document.querySelectorAll(".theme-card").forEach(node => node.classList.remove("active")); target.classList.add("active");
    const theme = target.querySelector("h4")!.textContent === "复古像素" ? "retro" : "modern";
    document.body.classList.remove("theme-neon", "theme-modern", "theme-retro"); document.body.classList.add("theme-" + theme);
    localStorage.setItem("tetrisTheme", theme);
  }));
  document.querySelector<HTMLButtonElement>("#settingsScreen button")!.addEventListener("click", () => {
    document.querySelector<HTMLElement>("#settingsScreen")!.style.display = "none";
    document.querySelector<HTMLElement>("#gameScreen")!.style.display = "block";
  });
  moveListener = event => { if ((event as KeyboardEvent).key === "ArrowLeft") { event.preventDefault(); pixels[0]++; } };
  document.addEventListener("keydown", moveListener);
}
beforeEach(() => {
  localStorage.clear(); localStorage.setItem("tetrisTheme", "modern"); document.body.classList.add("theme-modern"); pixels = new Uint8ClampedArray(16);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
    getImageData: () => ({ data: pixels })
  } as unknown as CanvasRenderingContext2D));
  host.__ATOOLS_PUBLISHED_ACTIVE_CASE__ = "converted-tetris-source"; fixture();
  const injected = source.replaceAll("__ATOOLS_PUBLISHED_CASE_ID__", "converted-tetris-source");
  window.eval(injected);
  adapter = host.__ATOOLS_PUBLISHED_CASE_OPERATIONS__!;
});
afterEach(() => { document.removeEventListener("keydown", moveListener); document.body.innerHTML = ""; localStorage.clear(); document.body.classList.remove("theme-neon", "theme-modern", "theme-retro"); delete host.__ATOOLS_PUBLISHED_ACTIVE_CASE__;
  delete host.__ATOOLS_PUBLISHED_CASE_OPERATIONS__; vi.restoreAllMocks(); });

it("uses native operations-before-probe assembly for a fresh isolated readiness and state handshake", async () => {
  const caseId = "converted-tetris-source", token = "tetris-token", requestId = "isolated-state-request";
  const bundle = `${source}\n${frameProbeSource}`.replaceAll("__ATOOLS_PUBLISHED_TOKEN__", token)
    .replaceAll("__ATOOLS_PUBLISHED_CASE_ID__", caseId);
  const messages: Array<Record<string, any>> = [], listeners = new Map<string, Array<(event: any) => unknown>>();
  const parent: any = { postMessage: (message: Record<string, any>) => messages.push(message) };
  Object.defineProperty(parent, "document", { get: () => { throw Error("opaque parent"); } });
  const child: any = {
    parent, top: parent,
    crypto: { getRandomValues: (values: Uint32Array) => { values.set([1, 2, 3, 4]); return values; } },
    addEventListener(kind: string, callback: (event: any) => unknown) {
      const entries = listeners.get(kind) ?? []; entries.push(callback); listeners.set(kind, entries);
    },
  };
  const isolatedDocument = {
    URL: "about:srcdoc", readyState: "complete", title: "isolated protocol fixture",
    body: { innerText: "", classList: { contains: () => false } }, scripts: [], querySelector: () => null, addEventListener() {},
  };
  vm.runInNewContext(bundle, {
    window: child, document: isolatedDocument, location: { origin: "null" },
    localStorage: { getItem: () => null }, console: { error() {}, warn() {} },
  });
  const operations = child.__ATOOLS_PUBLISHED_CASE_OPERATIONS__;
  expect(child.__ATOOLS_PUBLISHED_ACTIVE_CASE__).toBe(caseId);
  expect(Object.getOwnPropertyDescriptor(child, "__ATOOLS_PUBLISHED_ACTIVE_CASE__"))
    .toMatchObject({ configurable: false, enumerable: false, writable: false });
  expect(operations.caseId).toBe(caseId);
  let stateCalls = 0;
  const state = operations.state;
  operations.state = () => { stateCalls++; return state(); };

  const receive = listeners.get("message")?.[0];
  expect(receive).toBeTypeOf("function");
  await receive!({ source: parent, data: { kind: "atools-published-probe-ready", token, id: requestId,
    caseId, operation: "ready" } });
  const readyResults = messages.filter(message => message.kind === "atools-published-probe-ready-result");
  expect(readyResults).toHaveLength(1);
  expect(readyResults[0]).toMatchObject({ token, id: requestId, caseId, operation: "ready", ready: true,
    documentUrl: "about:srcdoc", documentState: "complete" });
  expect(readyResults[0].documentNonce).toMatch(/^[a-f0-9]{32}$/);
  expect(stateCalls).toBe(0); // Readiness must not query or mutate Tetris UI state.

  await receive!({ source: parent, data: { kind: "atools-published-probe", token, id: requestId,
    caseId, operation: "state", documentNonce: readyResults[0].documentNonce, workerLeaseSessions: [] } });
  const stateResults = messages.filter(message => message.kind === "atools-published-probe-result");
  expect(stateResults).toHaveLength(1);
  expect(stateResults[0].error).toBeUndefined();
  expect(stateResults[0]).toMatchObject({ token, id: requestId, caseId, operation: "state",
    state: { documentState: "complete", origin: "null", ready: false, screen: "invalid" } });
  expect(stateCalls).toBe(1);
  expect(messages.filter(message => message.kind === "atools-published-probe")).toHaveLength(0);
  // Empty isolated DOM is deliberately not treated as a Tetris business pass.
});

it("starts only through the visible home button and reports screen transition", async () => {
  expect(adapter.state()).toMatchObject({ ready: true, screen: "home" });
  const result = await adapter.perform("start-game", envelope("start-game"));
  expect(result.screen).toBe("game");
  expect(document.querySelector("#homeScreen")!.getAttribute("style")).toContain("display: none");
});

it("dispatches the displayed left binding and requires a rendered canvas change", async () => {
  await adapter.perform("start-game", envelope("start-game"));
  const before = adapter.state().board.pixelHash;
  const result = await adapter.perform("move-left", envelope("move-left"));
  expect(result.board.pixelHash).not.toBe(before);
  document.querySelector("#gameScreen .control-item")!.textContent = "UnknownKey : 移动";
  expect(() => adapter.perform("move-left", envelope("move-left"))).toThrow(/unsupported/);
  document.querySelector("#gameScreen .control-item")!.textContent = "← : 移动";
  vi.spyOn(document, "dispatchEvent").mockReturnValue(true);
  expect(() => adapter.perform("move-left", envelope("move-left"))).toThrow(/no visible board change/);
});

it("rejects a pixel-changing key event that the game handler did not consume", async () => {
  await adapter.perform("start-game", envelope("start-game"));
  document.removeEventListener("keydown", moveListener);
  const before = adapter.state().board.pixelHash;
  const unconsumed = (event: Event) => { if ((event as KeyboardEvent).key === "ArrowLeft") pixels[0]++; };
  document.addEventListener("keydown", unconsumed);
  try {
    expect(() => adapter.perform("move-left", envelope("move-left"))).toThrow(/no visible board change/);
    expect(adapter.state().board.pixelHash).not.toBe(before);
  } finally {
    document.removeEventListener("keydown", unconsumed);
  }
});

it("covers visible pause/resume, settings theme persistence and return", async () => {
  await adapter.perform("start-game", envelope("start-game"));
  await adapter.perform("pause", envelope("pause"));
  expect(adapter.state().paused).toBe(true);
  await adapter.perform("resume", envelope("resume"));
  expect(adapter.state().paused).toBe(false);
  await adapter.perform("pause", envelope("pause"));
  await adapter.perform("settings-from-pause", envelope("settings-from-pause"));
  const theme = await adapter.perform("set-theme-retro", envelope("set-theme-retro"));
  expect(theme).toMatchObject({ screen: "settings", theme: "retro", persistedTheme: "retro" });
  const returned = await adapter.perform("settings-return", envelope("settings-return"));
  expect(returned).toMatchObject({ screen: "game", paused: true, theme: "retro", persistedTheme: "retro" });
});

it("rejects a theme operation that would leave the existing persisted value unchanged", async () => {
  await adapter.perform("start-game", envelope("start-game"));
  await adapter.perform("pause", envelope("pause"));
  await adapter.perform("settings-from-pause", envelope("settings-from-pause"));
  document.querySelectorAll<HTMLElement>(".theme-card")[1].click();
  expect(() => adapter.perform("set-theme-retro", envelope("set-theme-retro"))).toThrow(/would not change/);
});

it("does not report a theme update when its persisted storage write fails", async () => {
  await adapter.perform("start-game", envelope("start-game"));
  await adapter.perform("pause", envelope("pause"));
  await adapter.perform("settings-from-pause", envelope("settings-from-pause"));
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {});
  await expect(adapter.perform("set-theme-retro", envelope("set-theme-retro"))).rejects.toThrow(/persisted theme change/);
});

it("fails closed for unsupported case, caller-selected actions and missing controls", async () => {
  host.__ATOOLS_PUBLISHED_ACTIVE_CASE__ = "another-case";
  expect(adapter.caseId).toBeNull();
  expect(() => adapter.perform("start-game", envelope("start-game"))).toThrow(/Unapproved/);
  host.__ATOOLS_PUBLISHED_ACTIVE_CASE__ = "converted-tetris-source";
  expect(() => adapter.perform("execute-script", envelope("execute-script"))).toThrow(/Unapproved/);
  expect(() => adapter.perform("start-game", envelope("start-game", { selector: "body" }))).toThrow(/Unapproved/);
  document.querySelector("#homeScreen button")!.remove();
  expect(() => adapter.perform("start-game", envelope("start-game"))).toThrow(/missing or ambiguous/);
});

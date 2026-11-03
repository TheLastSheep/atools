import { afterEach, beforeEach, expect, it, vi } from "vitest";
import source from "./nativeOriginalImageStitchFrameOperations.js?raw";
type Adapter = { caseId: string | null; state: () => Record<string, unknown>; perform: (operation: string, data: Record<string, unknown>) => Record<string, unknown> };
const host = window as unknown as { __ATOOLS_PUBLISHED_ACTIVE_CASE__?: string; __ATOOLS_PUBLISHED_CASE_OPERATIONS__?: Adapter };
const envelope = (operation: string, extra: Record<string, unknown> = {}) => ({ kind: "atools-published-probe", token: "image-stitch-token",
  id: "image-stitch-op", caseId: "local-image-stitch-head", operation, documentNonce: "a".repeat(32), workerLeaseSessions: [], ...extra });
let directionChanges: string[];

beforeEach(() => {
  document.body.innerHTML = `<div id="preview-placeholder">empty</div><canvas id="canvas" style="display:none" width="0" height="0"></canvas>
    <div id="image-list"></div><style>.radio-label input[type="radio"] { display: none; }</style>
    <label class="radio-label"><input type="radio" name="direction" value="vertical" checked>纵向</label>
    <label class="radio-label"><input type="radio" name="direction" value="horizontal">横向</label>
    <select id="resize-mode"><option value="enlarge">enlarge</option><option value="none">none</option></select>
    <input type="range" id="spacing" value="18"><input type="range" id="padding" value="7">
    <button class="color-btn" data-color="transparent"></button><button id="btn-save"></button>`;
  document.querySelector<HTMLButtonElement>('.color-btn[data-color="transparent"]')!.addEventListener("click", event => {
    (event.currentTarget as HTMLElement).classList.add("active");
  });
  directionChanges = [];
  document.querySelector<HTMLInputElement>('input[name="direction"][value="vertical"]')!.addEventListener("change", event => {
    directionChanges.push((event.currentTarget as HTMLInputElement).value);
  });
  host.__ATOOLS_PUBLISHED_ACTIVE_CASE__ = "local-image-stitch-head";
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ getImageData: () => ({ data: new Uint8ClampedArray(32) }) } as unknown as CanvasRenderingContext2D);
  window.eval(source); 
});
afterEach(() => { document.body.innerHTML = ""; delete host.__ATOOLS_PUBLISHED_ACTIVE_CASE__; delete host.__ATOOLS_PUBLISHED_CASE_OPERATIONS__; vi.restoreAllMocks(); });

it("reads the actual empty placeholder and applies only authenticated existing layout controls", () => {
  const adapter = host.__ATOOLS_PUBLISHED_CASE_OPERATIONS__!;
  expect(adapter.caseId).toBe("local-image-stitch-head");
  expect(adapter.state()).toMatchObject({ ready: true, direction: "vertical", placeholderVisible: true, imageCount: 0, canvasWidth: 0, canvasHeight: 0 });
  document.querySelector<HTMLInputElement>('input[name="direction"][value="horizontal"]')!.closest("label")!.click();
  directionChanges = [];
  const result = adapter.perform("set-layout", envelope("set-layout"));
  expect(result).toMatchObject({ direction: "vertical", resizeMode: "none", spacing: "0", padding: "0", transparentBackground: true });
  expect(document.querySelector<HTMLInputElement>("#spacing")!.value).toBe("0");
  expect(document.querySelector<HTMLInputElement>("#padding")!.value).toBe("0");
  expect(document.querySelector<HTMLInputElement>('input[name="direction"][value="vertical"]')!.checked).toBe(true);
  expect(document.querySelector<HTMLInputElement>('input[name="direction"][value="horizontal"]')!.checked).toBe(false);
  expect(directionChanges).toEqual(["vertical"]);
  expect(document.querySelector<HTMLCanvasElement>("#canvas")!.width).toBe(0);
});

it("accepts the pinned hidden-radio CSS only through one visible owning label", () => {
  const adapter = host.__ATOOLS_PUBLISHED_CASE_OPERATIONS__!;
  const vertical = document.querySelector<HTMLInputElement>('input[name="direction"][value="vertical"]')!;
  expect(getComputedStyle(vertical).display).toBe("none");
  document.querySelector<HTMLInputElement>('input[name="direction"][value="horizontal"]')!.closest("label")!.click();
  directionChanges = [];
  expect(adapter.state()).toMatchObject({ ready: true, direction: "horizontal" });
  expect(adapter.perform("set-layout", envelope("set-layout")).direction).toBe("vertical");
  expect(vertical.checked).toBe(true);
  expect(directionChanges).toEqual(["vertical"]);
});

it("rejects hidden or ambiguous visible labels for the hidden original radio", () => {
  const adapter = host.__ATOOLS_PUBLISHED_CASE_OPERATIONS__!;
  const radioMarkup = '<input id="vertical-radio" type="radio" name="direction" value="vertical">纵向';
  const visibleMarkup = '<label class="radio-label">' + radioMarkup + "</label>";
  const cases = [
    '<label class="radio-label" hidden>' + radioMarkup + "</label>",
    visibleMarkup + '<label for="vertical-radio">duplicate</label>'
  ];
  for (const labels of cases) {
    document.querySelectorAll("label.radio-label").forEach(label => {
      if (label.querySelector('input[name="direction"][value="vertical"]')) label.remove();
    });
    document.querySelectorAll('input[name="direction"][value="vertical"]').forEach(node => node.remove());
    document.querySelectorAll('label[for="vertical-radio"]').forEach(node => node.remove());
    document.querySelector("#image-list")!.insertAdjacentHTML("afterend", labels);
    expect(adapter.state().ready).toBe(false);
    expect(() => adapter.perform("set-layout", envelope("set-layout"))).toThrow("radio label");
    expect(document.querySelector<HTMLSelectElement>("#resize-mode")!.value).toBe("enlarge");
  }
});

it("rejects wrong-case, extra-field and unsupported operations without changing controls", () => {
  const adapter = host.__ATOOLS_PUBLISHED_CASE_OPERATIONS__!;
  expect(() => adapter.perform("set-layout", envelope("set-layout", { caseId: "other" }))).toThrow("Unapproved");
  expect(() => adapter.perform("set-layout", envelope("set-layout", { path: "/private/fixture.png" }))).toThrow("Unapproved");
  expect(() => adapter.perform("save", envelope("save"))).toThrow("Unapproved");
  expect(document.querySelector<HTMLSelectElement>("#resize-mode")!.value).toBe("enlarge");
});

it("reads bounded RGBA bytes from the original Canvas without changing its pixels", () => {
  const canvas = document.querySelector<HTMLCanvasElement>("#canvas")!;
  canvas.style.display = "block"; canvas.width = 2; canvas.height = 4;
  const pixels = new Uint8ClampedArray(Array.from({ length: 32 }, (_, index) => index));
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
    getImageData: () => ({ data: pixels })
  } as unknown as CanvasRenderingContext2D);
  const result = host.__ATOOLS_PUBLISHED_CASE_OPERATIONS__!.state();
  expect(result).toMatchObject({ canvasVisible: true, canvasWidth: 2, canvasHeight: 4, pixelRead: true, rgba: Array.from(pixels) });
  expect(canvas.width).toBe(2); expect(canvas.height).toBe(4);
});

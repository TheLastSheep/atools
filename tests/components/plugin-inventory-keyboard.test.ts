import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PluginInventoryPanel from "../../src/components/PluginInventoryPanel.svelte";
import type { InstalledPlugin } from "../../src/lib/types";

const mocks = vi.hoisted(() => ({ available: vi.fn(), list: vi.fn() }));
vi.mock("../../src/lib/pluginInventoryServices", () => ({ pluginInventoryServices: (confirm: unknown) => ({
  available: mocks.available, listPlugins: mocks.list, chooseDirectory: vi.fn(), installDirectory: vi.fn(), updateDirectory: vi.fn(),
  togglePlugin: vi.fn(), authorizePlugin: vi.fn(), uninstallPlugin: vi.fn(), revealPath: vi.fn(), confirm,
}) }));

const plugin = (id: string): InstalledPlugin => ({
  id, name: id, version: "1.0.0", enabled: true, source_kind: "imported", path: `/offline/plugins/${id}`,
  created_at: "2026-10-19", updated_at: "2026-10-19",
  manifest: { title: `插件 ${id}`, description: "fixture", main: "index.html", features: [{ code: `${id}-open`, label: "打开", explain: "" }] },
});
let catalogue: InstalledPlugin[];
const confirm = vi.fn(async () => true);
const detail = (id: string) => screen.getByRole("button", { name: `查看 插件 ${id} 详情` }) as HTMLButtonElement;

class ResizeObserverProbe {
  static current: ResizeObserverProbe;
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();
  readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) { this.callback = callback; ResizeObserverProbe.current = this; }
  trigger() { this.callback([], this as unknown as ResizeObserver); }
}

beforeEach(() => {
  catalogue = [plugin("alpha"), plugin("beta"), plugin("gamma")];
  mocks.available.mockReset().mockReturnValue(true);
  mocks.list.mockReset().mockImplementation(async () => catalogue);
  confirm.mockClear();
});
afterEach(() => { cleanup(); document.querySelector("[data-keyboard-test-external]")?.remove(); });

it("moves only detail-button focus with arrows and Home/End, clamps edges, and leaves Enter native", async () => {
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
  try {
    render(PluginInventoryPanel, { confirm });
    const alpha = await screen.findByRole("button", { name: "查看 插件 alpha 详情" }) as HTMLButtonElement;
    const beta = detail("beta");
    const gamma = detail("gamma");
    alpha.focus();
    const down = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    alpha.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(beta);
    expect(scroll).toHaveBeenCalledWith({ block: "nearest", inline: "nearest", behavior: "auto" });

    await fireEvent.keyDown(beta, { key: "End" });
    expect(document.activeElement).toBe(gamma);
    await fireEvent.keyDown(gamma, { key: "ArrowDown" });
    expect(document.activeElement).toBe(gamma);
    await fireEvent.keyDown(gamma, { key: "Home" });
    expect(document.activeElement).toBe(alpha);
    await fireEvent.keyDown(alpha, { key: "ArrowUp" });
    expect(document.activeElement).toBe(alpha);
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    alpha.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);

    const rowAction = screen.getByRole("button", { name: "打开 插件 alpha" });
    rowAction.focus();
    const actionArrow = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    rowAction.dispatchEvent(actionArrow);
    expect(actionArrow.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(rowAction);

    const search = screen.getByRole("textbox", { name: "筛选已安装插件" });
    search.focus();
    const searchArrow = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    search.dispatchEvent(searchArrow);
    expect(searchArrow.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(search);

    alpha.focus();
    const composing = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true, isComposing: true });
    alpha.dispatchEvent(composing);
    expect(composing.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(alpha);
    const legacyIme = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    Object.defineProperty(legacyIme, "keyCode", { value: 229 });
    alpha.dispatchEvent(legacyIme);
    expect(legacyIme.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(alpha);
    for (const modifier of ["ctrlKey", "metaKey", "altKey", "shiftKey"] as const) {
      const shortcut = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true, [modifier]: true });
      alpha.dispatchEvent(shortcut);
      expect(shortcut.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(alpha);
    }
  } finally {
    if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: originalScrollIntoView });
    else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  }
});

it("keeps search focus when filtering removes the previously focused row", async () => {
  render(PluginInventoryPanel, { confirm });
  const alpha = await screen.findByRole("button", { name: "查看 插件 alpha 详情" });
  alpha.focus();
  const search = screen.getByRole("textbox", { name: "筛选已安装插件" }) as HTMLInputElement;
  search.focus();
  await fireEvent.input(search, { target: { value: "beta" } });
  await screen.findByRole("button", { name: "查看 插件 beta 详情" });
  expect(document.activeElement).toBe(search);
});

it("returns to search when a refresh removes the focused list item", async () => {
  render(PluginInventoryPanel, { confirm });
  const beta = await screen.findByRole("button", { name: "查看 插件 beta 详情" });
  beta.focus();
  catalogue = [plugin("alpha"), plugin("gamma")];
  await fireEvent.click(screen.getByRole("button", { name: "刷新插件列表" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "查看 插件 beta 详情" })).toBeNull());
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "筛选已安装插件" }));
});

it("does not steal focus from a newly focused external control when refresh removes a row", async () => {
  render(PluginInventoryPanel, { confirm });
  const beta = await screen.findByRole("button", { name: "查看 插件 beta 详情" });
  beta.focus();
  const external = document.createElement("button");
  external.textContent = "外部控制";
  external.dataset.keyboardTestExternal = "true";
  document.body.append(external);
  external.focus();
  catalogue = [plugin("alpha"), plugin("gamma")];
  await fireEvent.click(screen.getByRole("button", { name: "刷新插件列表" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "查看 插件 beta 详情" })).toBeNull());
  expect(document.activeElement).toBe(external);
});

it("does not restore search after an external focused control is removed before the row refresh", async () => {
  render(PluginInventoryPanel, { confirm });
  const beta = await screen.findByRole("button", { name: "查看 插件 beta 详情" });
  beta.focus();
  const external = document.createElement("button");
  external.textContent = "外部控制";
  external.dataset.keyboardTestExternal = "true";
  document.body.append(external);
  external.focus();
  external.remove();
  expect(document.activeElement).toBe(document.body);

  catalogue = [plugin("alpha"), plugin("gamma")];
  await fireEvent.click(screen.getByRole("button", { name: "刷新插件列表" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "查看 插件 beta 详情" })).toBeNull());
  expect(document.activeElement).toBe(document.body);
});

it("does not return focus to search when paging was initiated outside the list", async () => {
  catalogue = Array.from({ length: 35 }, (_, index) => plugin(`item-${String(index).padStart(2, "0")}`));
  render(PluginInventoryPanel, { confirm });
  await screen.findByRole("button", { name: "查看 插件 item-00 详情" });
  const next = screen.getByRole("button", { name: "下一页" });
  next.focus();
  await fireEvent.click(next);
  await screen.findByRole("button", { name: "查看 插件 item-30 详情" });
  expect(document.activeElement).toBe(next);
});

it("keeps keyboard navigation inside the current thirty-row page", async () => {
  catalogue = Array.from({ length: 35 }, (_, index) => plugin(`item-${String(index).padStart(2, "0")}`));
  render(PluginInventoryPanel, { confirm });
  await screen.findByRole("button", { name: "查看 插件 item-29 详情" });
  expect(screen.getByRole("list", { name: "插件列表" }).querySelectorAll("[data-plugin-detail-id]")).toHaveLength(30);
  const last = detail("item-29");
  last.focus();
  const down = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
  last.dispatchEvent(down);
  expect(down.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(last);
  expect(screen.queryByRole("button", { name: "查看 插件 item-30 详情" })).toBeNull();
});

it("moves between adjacent thirty-row pages with arrows and returns detail focus to the same plugin", async () => {
  catalogue = Array.from({ length: 61 }, (_, index) => plugin(`item-${String(index).padStart(2, "0")}`));
  render(PluginInventoryPanel, { confirm });
  const firstPageLast = await screen.findByRole("button", { name: "查看 插件 item-29 详情" }) as HTMLButtonElement;
  const press = (button: HTMLButtonElement, key: string) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  };

  firstPageLast.focus();
  press(firstPageLast, "ArrowDown");
  await waitFor(() => expect(screen.getByRole("navigation", { name: "插件分页" }).textContent).toContain("2 / 3"));
  const secondPageFirst = await screen.findByRole("button", { name: "查看 插件 item-30 详情" }) as HTMLButtonElement;
  expect(document.activeElement).toBe(secondPageFirst);
  press(secondPageFirst, "ArrowUp");
  await waitFor(() => expect(screen.getByRole("navigation", { name: "插件分页" }).textContent).toContain("1 / 3"));
  await waitFor(() => expect(document.activeElement).toBe(detail("item-29")));

  await fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await waitFor(() => expect(screen.getByRole("navigation", { name: "插件分页" }).textContent).toContain("2 / 3"));
  const secondPageLast = await screen.findByRole("button", { name: "查看 插件 item-59 详情" }) as HTMLButtonElement;
  secondPageLast.focus();
  press(secondPageLast, "ArrowDown");
  await waitFor(() => expect(screen.getByRole("navigation", { name: "插件分页" }).textContent).toContain("3 / 3"));
  const thirdPageOnly = await screen.findByRole("button", { name: "查看 插件 item-60 详情" }) as HTMLButtonElement;
  expect(document.activeElement).toBe(thirdPageOnly);
  press(thirdPageOnly, "ArrowDown");
  expect(document.activeElement).toBe(thirdPageOnly);
  expect(mocks.list).toHaveBeenCalledTimes(1);

  await fireEvent.click(thirdPageOnly);
  await screen.findByRole("heading", { name: "插件 item-60" });
  await fireEvent.keyDown(screen.getByRole("heading", { name: "插件 item-60" }), { key: "Escape" });
  await waitFor(() => expect(document.activeElement).toBe(detail("item-60")));
  expect(mocks.list).toHaveBeenCalledTimes(1);
});

it("does not reclaim focus after a cross-page key when the user immediately focuses search", async () => {
  catalogue = Array.from({ length: 31 }, (_, index) => plugin(`item-${String(index).padStart(2, "0")}`));
  render(PluginInventoryPanel, { confirm });
  const last = await screen.findByRole("button", { name: "查看 插件 item-29 详情" }) as HTMLButtonElement;
  const search = screen.getByRole("textbox", { name: "筛选已安装插件" }) as HTMLInputElement;
  last.focus();
  last.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  search.focus();

  await waitFor(() => expect(screen.getByRole("navigation", { name: "插件分页" }).textContent).toContain("2 / 2"));
  await screen.findByRole("button", { name: "查看 插件 item-30 详情" });
  expect(document.activeElement).toBe(search);
  expect(mocks.list).toHaveBeenCalledTimes(1);
});

it("invalidates a pending focus handoff when explicit catalogue retry starts", async () => {
  catalogue = Array.from({ length: 31 }, (_, index) => plugin(`item-${String(index).padStart(2, "0")}`));
  let resolveRetry!: (plugins: InstalledPlugin[]) => void;
  const pendingRetry = new Promise<InstalledPlugin[]>(resolve => { resolveRetry = resolve; });
  mocks.list.mockReset()
    .mockResolvedValueOnce(catalogue)
    .mockRejectedValueOnce(new Error("read unavailable"))
    .mockReturnValueOnce(pendingRetry);
  render(PluginInventoryPanel, { confirm });
  const last = await screen.findByRole("button", { name: "查看 插件 item-29 详情" }) as HTMLButtonElement;
  await fireEvent.click(screen.getByRole("button", { name: "刷新插件列表" }));
  const retry = await screen.findByRole("button", { name: "重试读取列表" });

  last.focus();
  last.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  (retry as HTMLButtonElement).click();
  await waitFor(() => expect(screen.getByRole("navigation", { name: "插件分页" }).textContent).toContain("2 / 2"));
  const target = await screen.findByRole("button", { name: "查看 插件 item-30 详情" });
  expect(document.activeElement).not.toBe(target);
  expect(mocks.list).toHaveBeenCalledTimes(3);

  resolveRetry(catalogue);
  await waitFor(() => expect(screen.queryByRole("button", { name: "重试读取列表" })).toBeNull());
});

it("keeps the focused detail row visible after list resize and disconnects its local observer", async () => {
  vi.stubGlobal("ResizeObserver", ResizeObserverProbe);
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
  const view = render(PluginInventoryPanel, { confirm });
  try {
    const alpha = await screen.findByRole("button", { name: "查看 插件 alpha 详情" }) as HTMLButtonElement;
    alpha.focus();
    const observer = ResizeObserverProbe.current;
    expect(observer.observe).toHaveBeenCalledWith(screen.getByRole("list", { name: "插件列表" }));
    observer.trigger();
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledWith({ block: "nearest", inline: "nearest", behavior: "auto" });

    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    observer.trigger();
    expect(scroll).toHaveBeenCalledTimes(1);
    outside.remove();
  } finally {
    view.unmount();
    if (ResizeObserverProbe.current) expect(ResizeObserverProbe.current.disconnect).toHaveBeenCalledTimes(1);
    if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: originalScrollIntoView });
    else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    vi.unstubAllGlobals();
  }
});

it("preserves Escape detail return focus to the originating list entry", async () => {
  render(PluginInventoryPanel, { confirm });
  const beta = await screen.findByRole("button", { name: "查看 插件 beta 详情" });
  await fireEvent.click(beta);
  const heading = await screen.findByRole("heading", { name: "插件 beta" });
  await waitFor(() => expect(document.activeElement).toBe(heading));
  await fireEvent.keyDown(heading, { key: "Escape" });
  await waitFor(() => expect(document.activeElement).toBe(detail("beta")));
});

it("does not reclaim focus from an external control while Escape returns to the list", async () => {
  render(PluginInventoryPanel, { confirm });
  const beta = await screen.findByRole("button", { name: "查看 插件 beta 详情" });
  await fireEvent.click(beta);
  const heading = await screen.findByRole("heading", { name: "插件 beta" });
  await waitFor(() => expect(document.activeElement).toBe(heading));
  const external = document.createElement("button");
  external.textContent = "外部控制";
  external.dataset.keyboardTestExternal = "true";
  document.body.append(external);

  const escape = fireEvent.keyDown(heading, { key: "Escape" });
  external.focus();
  await escape;
  await screen.findByRole("list", { name: "插件列表" });
  expect(document.activeElement).toBe(external);
});

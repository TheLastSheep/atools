import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";
import { pageResultSelection } from "../../src/lib/resultListPaging";
import { createResultListIndex } from "../../src/lib/resultListViewport";
import { COMMAND_HISTORY_STORAGE_KEY } from "../../src/lib/commandHistory";
import type { SearchResult } from "../../src/lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../../src/lib/pinyinSearch", () => ({ loadSearchPinyinEngine: vi.fn(async () => false) }));
vi.mock("../../src/components/PluginPanel.svelte", async () => ({ default: (await import("./LauncherTextPluginFixture.svelte")).default }));

function result(index: number, pluginId = `paging-${index % 2}`): SearchResult {
  return { code: `page-command-${index}`, plugin_id: pluginId, plugin_name: pluginId,
    label: `分页命令 ${index}`, explain: "", icon: null, score: 1000 - index, match_type: "exact" };
}

describe("measured result page geometry", () => {
  it("follows grouped visual order instead of numeric result indexes", () => {
    const layout = createResultListIndex([result(0), result(1), result(2)]);
    expect(pageResultSelection(layout, 0, 1, 54)).toBe(2);
    expect(pageResultSelection(layout, 2, 1, 54)).toBe(1);
    expect(pageResultSelection(layout, 1, -1, 54)).toBe(2);
    expect(pageResultSelection(layout, 2, -1, 54)).toBe(0);
  });

  it("accounts for group headings and gaps when a page crosses sources", () => {
    const layout = createResultListIndex(Array.from({ length: 20 }, (_, index) => result(index)));
    expect(pageResultSelection(layout, 0, 1, 216)).toBe(8);
    expect(pageResultSelection(layout, 8, 1, 216)).toBe(16);
    expect(pageResultSelection(layout, 16, 1, 216)).toBe(3);
    expect(pageResultSelection(layout, 3, -1, 216)).toBe(16);
  });

  it("clamps at either end and advances with a viewport shorter than a row", () => {
    const layout = createResultListIndex([result(0), result(1)]);
    expect(pageResultSelection(layout, 0, -1, 420)).toBe(0);
    expect(pageResultSelection(layout, 1, 1, 420)).toBe(1);
    expect(pageResultSelection(layout, 0, 1, 0)).toBe(1);
    expect(pageResultSelection(layout, 1, -1, Number.NaN)).toBe(0);
    expect(pageResultSelection(layout, 99, 1, 54)).toBe(1);
    expect(pageResultSelection(createResultListIndex([]), 0, 1, 420)).toBeNull();
  });

  it("resolves equidistant rows in the requested direction", () => {
    const layout = createResultListIndex(Array.from({ length: 5 }, (_, index) => result(index, "single")));
    expect(pageResultSelection(layout, 0, 1, 81)).toBe(2);
    expect(pageResultSelection(layout, 4, -1, 81)).toBe(2);
  });
});

let found: SearchResult[];
beforeEach(() => {
  mocks.invoke.mockReset();
  localStorage.clear();
  Object.assign(window, { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: "main" } } } });
  localStorage.setItem("atools-settings", JSON.stringify({ localAppSearch: false, autoPaste: "never" }));
  found = Array.from({ length: 60 }, (_, index) => result(index));
  mocks.invoke.mockImplementation(async (command, args = {}) => {
    if (command === "get_setting") return JSON.stringify({ localAppSearch: false, autoPaste: "never" });
    if (command === "feature_catalog") return found;
    if (command === "search_features") return found;
    if (command === "search_local_apps" || command === "list_pending_agent_requests") return [];
    if (command === "activate_feature") return { plugin_id: args.expectedPluginId, plugin_name: "分页插件",
      feature_code: args.code, main_url: "index.html", plugin_path: "/fixture/paging", expand_height: 500, payload: args.payload };
  });
});
afterEach(() => {
  cleanup();
  document.querySelectorAll("[data-paging-test]").forEach(node => node.remove());
  localStorage.clear();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

const calls = (command: string) => mocks.invoke.mock.calls.filter(([name]) => name === command);
async function setup(query = "page-fixture") {
  render(App, { backgroundServices: false });
  const input = screen.getByRole("combobox") as HTMLInputElement;
  await fireEvent.input(input, { target: { value: query } });
  if (query) await screen.findByRole("option", { name: /分页命令 0，/ });
  const list = await waitFor(() => {
    const current = screen.getByRole("listbox", { name: "搜索结果" });
    if (!current.querySelector(".result-viewport")) throw new Error("Current listbox has not mounted its scroll viewport");
    return current;
  });
  return { input, list };
}
function selectedCode(input: HTMLInputElement) {
  const id = input.getAttribute("aria-activedescendant");
  const option = id && document.getElementById(id);
  expect(option).toBeTruthy();
  expect(option?.getAttribute("aria-selected")).toBe("true");
  return option?.getAttribute("data-result-code");
}
async function press(target: Element | Window, key: string, extra: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
  await fireEvent(target, event);
  return event;
}
function measure(list: HTMLElement, height: number) {
  // JSDOM has no layout engine: supply measured native element dimensions, while
  // the production ResultsList performs all paging and scroll calculations.
  Object.defineProperty(list, "clientHeight", { configurable: true, value: height });
}

it("wires PageDown/PageUp through the real App using the current measured viewport", async () => {
  const { input, list } = await setup();
  measure(list, 216);
  expect(selectedCode(input)).toBe("page-command-0");
  expect((await press(input, "PageDown")).defaultPrevented).toBe(true);
  expect(selectedCode(input)).toBe("page-command-8");
  await waitFor(() => expect(list.scrollTop).toBeGreaterThan(0));
  measure(list, 108);
  await press(input, "PageDown");
  expect(selectedCode(input)).toBe("page-command-12");
  await press(input, "PageUp");
  expect(selectedCode(input)).toBe("page-command-8");
  expect(input.value).toBe("page-fixture");
  expect(calls("activate_feature")).toHaveLength(0);
});

it("pages against the reduced list viewport below a visible feedback strip", async () => {
  const { input, list } = await setup();
  // The feedback strip is a sibling above this scrollport, so its reduced
  // clientHeight is the usable page height; it is no longer a scroll offset.
  measure(list, 216);
  await press(input, "PageDown");
  expect(selectedCode(input)).toBe("page-command-8");
  expect(calls("activate_feature")).toHaveLength(0);
});

it("pages from a result-row target and restores search focus", async () => {
  const { input, list } = await setup();
  measure(list, 216);
  await press(screen.getByRole("option", { name: /分页命令 0，/ }), "PageDown");
  expect(selectedCode(input)).toBe("page-command-8");
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(calls("activate_feature")).toHaveLength(0);
});

it("retains the page-selected identity when a higher-scored asynchronous result arrives", async () => {
  let resolve!: (rows: SearchResult[]) => void;
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command, args) => command === "search_features"
    ? new Promise<SearchResult[]>(done => { resolve = done; }) : original(command, args));
  render(App, { backgroundServices: false });
  const input = screen.getByRole("combobox") as HTMLInputElement;
  await fireEvent.input(input, { target: { value: ">" } });
  const list = await screen.findByRole("listbox", { name: "搜索结果" });
  await screen.findAllByRole("option");
  await waitFor(() => expect(resolve).toBeTypeOf("function"));
  measure(list, 108);
  await press(input, "PageDown");
  const code = selectedCode(input);
  const beforeId = input.getAttribute("aria-activedescendant");
  resolve([{ ...result(0), code: "new-remote-winner", score: 10000 }]);
  await waitFor(() => expect(input.getAttribute("aria-activedescendant")).not.toBe(beforeId));
  expect(selectedCode(input)).toBe(code);
  expect(input.value).toBe(">");
  expect(calls("activate_feature")).toHaveLength(0);
});

it("leaves page keys untouched when the current query has no results", async () => {
  found = [];
  render(App, { backgroundServices: false });
  const input = screen.getByRole("combobox") as HTMLInputElement;
  await fireEvent.input(input, { target: { value: "page-no-match" } });
  await screen.findByText("没有找到匹配 “page-no-match” 的命令");
  expect((await press(input, "PageDown")).defaultPrevented).toBe(false);
  expect((await press(input, "PageUp")).defaultPrevented).toBe(false);
  expect(input.getAttribute("aria-activedescendant")).toBeNull();
  expect(calls("activate_feature")).toHaveLength(0);
});

it("keeps a real active descendant, bounded virtual DOM and scrolling at both page boundaries", async () => {
  const { input, list } = await setup();
  measure(list, 216);
  const searches = calls("search_features").length;
  for (let index = 0; index < 20; index += 1) await press(input, "PageDown", { repeat: index > 0 });
  expect(selectedCode(input)).toBe("page-command-59");
  expect(screen.getAllByRole("option").length).toBeLessThanOrEqual(32);
  expect(screen.getAllByRole("option", { selected: true })).toHaveLength(1);
  expect((await press(input, "PageDown")).defaultPrevented).toBe(true);
  expect(selectedCode(input)).toBe("page-command-59");
  for (let index = 0; index < 20; index += 1) await press(input, "PageUp");
  expect(selectedCode(input)).toBe("page-command-0");
  await waitFor(() => expect(list.scrollTop).toBe(0));
  expect((await press(input, "PageUp")).defaultPrevented).toBe(true);
  expect(calls("search_features")).toHaveLength(searches);
  expect(calls("activate_feature")).toHaveLength(0);
  expect(input.value).toBe("page-fixture");
});

it.each([{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }])(
  "leaves guarded page keys to their owner: %j", async extra => {
    const { input, list } = await setup();
    measure(list, 216);
    for (const key of ["PageDown", "PageUp"]) expect((await press(input, key, extra)).defaultPrevented).toBe(false);
    expect(selectedCode(input)).toBe("page-command-0");
    expect(calls("activate_feature")).toHaveLength(0);
  },
);

it("respects composition markers, prevented events, other editors and caret Home/End", async () => {
  const { input } = await setup();
  input.dataset.atoolsComposing = "true";
  expect((await press(input, "PageDown")).defaultPrevented).toBe(false);
  delete input.dataset.atoolsComposing;
  const handled = new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true });
  handled.preventDefault();
  await fireEvent(input, handled);
  const textarea = document.createElement("textarea"); textarea.dataset.pagingTest = "true"; document.body.append(textarea);
  expect((await press(textarea, "PageDown")).defaultPrevented).toBe(false);
  for (const key of ["Home", "End"]) expect((await press(input, key)).defaultPrevented).toBe(false);
  expect(selectedCode(input)).toBe("page-command-0");
  expect(input.value).toBe("page-fixture");
});

it.each(["permission", "modal", "menu"])("does not page while a %s owns the interaction", async kind => {
  const { input, list } = await setup();
  measure(list, 216);
  const owner = document.createElement("div"); owner.dataset.pagingTest = "true";
  if (kind === "permission") owner.dataset.permissionDialog = "true";
  else { owner.setAttribute("role", kind === "modal" ? "dialog" : "menu"); if (kind === "modal") owner.setAttribute("aria-modal", "true"); }
  document.body.append(owner);
  expect((await press(input, "PageDown")).defaultPrevented).toBe(false);
  expect(selectedCode(input)).toBe("page-command-0");
  expect(calls("activate_feature")).toHaveLength(0);
});

it("lets the actual action menu retain ownership without moving selection", async () => {
  const { input } = await setup();
  await fireEvent.contextMenu(screen.getByRole("option", { name: /分页命令 0，/ }));
  const menu = await screen.findByRole("menu");
  await press(within(menu).getByRole("menuitemcheckbox"), "PageDown");
  expect(selectedCode(input)).toBe("page-command-0");
  expect(calls("activate_feature")).toHaveLength(0);
});

it("does not capture page navigation on the home grid or inside an activated plugin", async () => {
  localStorage.setItem(COMMAND_HISTORY_STORAGE_KEY, JSON.stringify(found.slice(0, 2).map(item => ({
    ...item, icon: "", input: item.label, usedAt: new Date().toISOString(), useCount: 1,
  }))));
  const { input } = await setup();
  await fireEvent.input(input, { target: { value: "" } });
  await screen.findByRole("button", { name: "分页命令 0" });
  const homeSelection = document.querySelector(".recent-item-shell.selected")?.getAttribute("data-home-command-index");
  expect((await press(input, "PageDown")).defaultPrevented).toBe(false);
  expect(document.querySelector(".recent-item-shell.selected")?.getAttribute("data-home-command-index")).toBe(homeSelection);
  await fireEvent.input(input, { target: { value: "page-fixture" } });
  const row = await screen.findByRole("option", { name: /分页命令 0，/ });
  await fireEvent.click(row);
  await waitFor(() => expect(calls("activate_feature")).toHaveLength(1));
  await waitFor(() => expect(document.querySelector(".plugin-panel-host")).not.toBeNull());
  await vi.dynamicImportSettled();
  await screen.findByTestId("content-entry-payload");
  expect((await press(window, "PageDown")).defaultPrevented).toBe(false);
  expect(calls("activate_feature")).toHaveLength(1);
});

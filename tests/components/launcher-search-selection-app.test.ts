import { cleanup, fireEvent, render, screen, within } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";
import type { SearchResult } from "../../src/lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
// These tests control one pending search source. Pinyin loading has its own
// checks; letting it rerun the query here can replace the deferred resolver.
vi.mock("../../src/lib/pinyinSearch", () => ({ loadSearchPinyinEngine: vi.fn(async () => false) }));

const remoteWinner: SearchResult = {
  code: "remote-winner", plugin_id: "remote-plugin", plugin_name: "远端插件", label: "最高分远端结果",
  explain: "异步插件结果", icon: null, score: 1000, match_type: "exact",
};
const remoteSecond: SearchResult = {
  code: "remote-second", plugin_id: "second-plugin", plugin_name: "第二插件", label: "第二远端结果",
  explain: "另一个异步结果", icon: null, score: 900, match_type: "fuzzy",
};
let resolveFeatures!: (results: SearchResult[]) => void;

beforeEach(() => {
  mocks.invoke.mockReset();
  resolveFeatures = undefined as unknown as typeof resolveFeatures;
  Object.assign(window, { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: "main" } } } });
  localStorage.setItem("atools-settings", JSON.stringify({ localAppSearch: false, autoPaste: "never", tabKeyFunction: "navigate" }));
  mocks.invoke.mockImplementation((command) => {
    if (command === "get_setting") return Promise.resolve(JSON.stringify({ localAppSearch: false, autoPaste: "never", tabKeyFunction: "navigate" }));
    if (command === "feature_catalog") return Promise.resolve([]);
    if (command === "search_features") return new Promise<SearchResult[]>(resolve => { resolveFeatures = resolve; });
    if (command === "search_local_apps" || command === "list_pending_agent_requests") return Promise.resolve([]);
    return Promise.resolve(undefined);
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

async function enterQuery(value: string) {
  render(App, { backgroundServices: false });
  const input = screen.getByRole("combobox") as HTMLInputElement;
  await fireEvent.input(input, { target: { value } });
  await screen.findAllByRole("option");
  await vi.waitFor(() => expect(resolveFeatures).toBeTypeOf("function"));
  return input;
}

function selectedResultIndex(): string | null {
  return screen.getAllByRole("option").find(row => row.getAttribute("aria-selected") === "true")
    ?.getAttribute("data-result-index") ?? null;
}

function dispatchKey(input: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  input.dispatchEvent(event);
  return event;
}

it("keeps the automatic first choice at zero so late higher-scored results become selected", async () => {
  const input = await enterQuery("工具");
  const localAgent = screen.getByRole("option", { name: /Agent \/ MCP/ });
  expect(localAgent.getAttribute("aria-selected")).toBe("true");

  resolveFeatures([remoteWinner]);
  const winner = await screen.findByRole("option", { name: /最高分远端结果/ });
  await vi.waitFor(() => expect(winner.getAttribute("aria-selected")).toBe("true"));
  expect(input.getAttribute("aria-activedescendant")).toBe(winner.id);
});

it("preserves a user-moved local choice by identity after a higher-scored result arrives", async () => {
  const input = await enterQuery(">");
  const initialRows = screen.getAllByRole("option");
  expect(initialRows.length).toBeGreaterThan(1);
  await fireEvent.keyDown(input, { key: "ArrowDown" });
  const locallyChosen = screen.getAllByRole("option").find((row) => row.getAttribute("aria-selected") === "true");
  expect(locallyChosen).toBeTruthy();
  const identity = [locallyChosen?.getAttribute("data-plugin-id"), locallyChosen?.getAttribute("data-result-code")];
  expect(identity[1]).not.toBe(remoteWinner.code);

  resolveFeatures([remoteWinner]);
  await screen.findByRole("option", { name: /最高分远端结果/ });
  const retained = screen.getAllByRole("option").find((row) =>
    row.getAttribute("data-plugin-id") === identity[0] && row.getAttribute("data-result-code") === identity[1],
  );
  await vi.waitFor(() => expect(retained?.getAttribute("aria-selected")).toBe("true"));
  expect(input.getAttribute("aria-activedescendant")).toBe(retained?.id);
});

it("does not count IME or caret keys as explicit selection", async () => {
  const input = await enterQuery("工具");
  await fireEvent.keyDown(input, { key: "ArrowDown", isComposing: true });
  await fireEvent.keyDown(input, { key: "ArrowLeft" });
  resolveFeatures([remoteWinner]);
  const winner = await screen.findByRole("option", { name: /最高分远端结果/ });
  await vi.waitFor(() => expect(winner.getAttribute("aria-selected")).toBe("true"));
});

it("keeps selected query text in the editor instead of navigating or activating results", async () => {
  const input = await enterQuery(">");
  expect(screen.getAllByRole("option").length).toBeGreaterThan(1);
  input.setSelectionRange(0, 1);
  const initialSelection = selectedResultIndex();
  expect(initialSelection).toBeTruthy();

  for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"]) {
    const event = dispatchKey(input, key);
    expect(event.defaultPrevented).toBe(false);
    expect(selectedResultIndex()).toBe(initialSelection);
  }
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "activate_feature")).toHaveLength(0);
  resolveFeatures([]);
});

it("does not turn an editing arrow into explicit selection before a late result arrives", async () => {
  const input = await enterQuery(">");
  input.setSelectionRange(0, 1);
  dispatchKey(input, "ArrowDown");

  resolveFeatures([remoteWinner]);
  const winner = await screen.findByRole("option", { name: /最高分远端结果/ });
  await vi.waitFor(() => expect(winner.getAttribute("aria-selected")).toBe("true"));
});

it("keeps collapsed-caret arrows and configured Tab navigation working", async () => {
  const input = await enterQuery("工具");
  resolveFeatures([remoteWinner, remoteSecond]);
  const winner = await screen.findByRole("option", { name: /最高分远端结果/ });
  await vi.waitFor(() => expect(winner.getAttribute("aria-selected")).toBe("true"));
  const initialSelection = selectedResultIndex();
  input.setSelectionRange(2, 2);

  const arrowDown = dispatchKey(input, "ArrowDown");
  expect(arrowDown.defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(selectedResultIndex()).not.toBe(initialSelection));
  const arrowUp = dispatchKey(input, "ArrowUp");
  expect(arrowUp.defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(selectedResultIndex()).toBe(initialSelection));

  input.setSelectionRange(0, 1);
  const tab = dispatchKey(input, "Tab");
  expect(tab.defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(selectedResultIndex()).not.toBe(initialSelection));
});

it("does not treat action-menu navigation as result selection", async () => {
  const input = await enterQuery("工具");
  await fireEvent.contextMenu(screen.getByRole("option", { name: /Agent \/ MCP/ }), { clientX: 700, clientY: 400 });
  const menu = await screen.findByRole("menu");
  const menuItem = within(menu).getByRole("menuitemcheckbox");
  await fireEvent.keyDown(menuItem, { key: "ArrowDown" });

  resolveFeatures([remoteWinner]);
  const winner = await screen.findByRole("option", { name: /最高分远端结果/ });
  await vi.waitFor(() => expect(winner.getAttribute("aria-selected")).toBe("true"));
  expect(input.getAttribute("aria-activedescendant")).toBe(winner.id);
});

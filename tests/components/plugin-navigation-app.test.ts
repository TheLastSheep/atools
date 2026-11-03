import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";
import type { FeatureAction, SearchResult } from "../../src/lib/types";
import { SETTINGS_STORAGE_KEY } from "../../src/lib/settings";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), events: new Map<string, (event: { payload: unknown }) => void>() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, callback) => { mocks.events.set(name, callback); return () => mocks.events.delete(name); }) }));

const feature: SearchResult = { code: "nav-fixture", plugin_id: "nav-fixture", plugin_name: "导航探针", label: "导航探针", explain: "合成插件", icon: null, score: 100, match_type: "exact" };
const action: FeatureAction = { plugin_id: feature.plugin_id, plugin_name: feature.plugin_name, feature_code: feature.code, main_url: "index.html", plugin_path: "__atools_plugin_host_preview__", expand_height: 400, payload: { srcdoc: "<!doctype html><main>synthetic navigation fixture</main>" } };
let originalFeatureViewportHeight: PropertyDescriptor | undefined;

beforeEach(() => {
  mocks.events.clear(); mocks.invoke.mockReset();
  window.history.replaceState(null, "", "/");
  Object.assign(window, { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: "main" } } } });
});
afterEach(() => {
  cleanup(); localStorage.clear(); mocks.events.clear();
  vi.unstubAllGlobals();
  if (originalFeatureViewportHeight) Object.defineProperty(HTMLDivElement.prototype, "clientHeight", originalFeatureViewportHeight);
  else delete (HTMLDivElement.prototype as { clientHeight?: number }).clientHeight;
  originalFeatureViewportHeight = undefined;
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

async function openPlugin(escapeToSearch = true) {
  const settings = { localAppSearch: false, autoPaste: "never", pluginEscapeToSearch: escapeToSearch };
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  mocks.invoke.mockImplementation(async command => {
    if (command === "get_setting") return JSON.stringify(settings);
    if (command === "feature_catalog" || command === "search_features") return [feature];
    if (command === "list_pending_agent_requests" || command === "search_local_apps") return [];
    if (command === "activate_feature") return action;
    return undefined;
  });
  render(App, { backgroundServices: false });
  await fireEvent.input(screen.getByRole("combobox"), { target: { value: "导航探针" } });
  await fireEvent.click(await screen.findByRole("option"));
  await screen.findByRole("banner", { name: "插件导航" }, { timeout: 10_000 });
  const frame = await waitFor(() => {
    const iframe = document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]');
    expect(iframe?.contentWindow).toBeTruthy();
    return iframe!;
  });
  const post = vi.spyOn(frame.contentWindow!, "postMessage");
  const epoch = Number(frame.dataset.pluginInputEpoch);
  const send = async (data: Record<string, unknown>) => {
    await fireEvent(window, new MessageEvent("message", { source: frame.contentWindow!, data: { epoch, ...data } }));
  };
  return { frame, send, post, epoch };
}

it("mounts only the plugin navigation input and obeys Escape settings from input and frame", async () => {
  const { send, post, epoch } = await openPlugin(false);
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByRole("textbox", { name: "插件搜索" })).toBeNull();
  await send({ __ipc_subinput__: true, generation: 1, opts: { visible: true, focus: true, placeholder: "" } });
  const input = await screen.findByRole("textbox", { name: "插件搜索" });
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(document.querySelectorAll("input")).toHaveLength(1);
  await fireEvent.input(input, { target: { value: "中文 query" } });
  expect(post).toHaveBeenCalledWith({ __ipc_subinput_change__: true, text: "中文 query", generation: 1, epoch }, "*");
  await fireEvent.keyDown(input, { key: "Escape" });
  expect((input as HTMLInputElement).value).toBe("");
  await fireEvent.keyDown(input, { key: "Escape" });
  await send({ __ipc_plugin_escape__: true });
  expect(screen.getByRole("banner", { name: "插件导航" })).toBeTruthy();
  await fireEvent.click(screen.getByRole("button", { name: "返回搜索" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox")));
});

it("clears the same query on frame Escape before using the global return policy", async () => {
  const { send, post, epoch } = await openPlugin();
  await send({ __ipc_subinput__: true, generation: 1, opts: { visible: true, value: "query", focus: false } });
  const input = await screen.findByRole("textbox", { name: "插件搜索" });
  await fireEvent.keyDown(input, { key: "Escape", ctrlKey: true });
  expect((input as HTMLInputElement).value).toBe("query");
  await fireEvent.keyDown(window, { key: "Escape", shiftKey: true });
  expect((input as HTMLInputElement).value).toBe("query");
  await send({ __ipc_plugin_escape__: true });
  expect((input as HTMLInputElement).value).toBe("");
  expect(post).toHaveBeenCalledWith({ __ipc_subinput_change__: true, text: "", generation: 1, epoch }, "*");
  expect(screen.queryByRole("combobox")).toBeNull();
  await send({ __ipc_plugin_escape__: true });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox")));
});

it("does not resurrect an input or accept an earlier generation after remove and reconfigure", async () => {
  const { send, post, frame } = await openPlugin();
  await send({ __ipc_subinput__: true, generation: 1, opts: { visible: true, focus: true } });
  await send({ __ipc_subinput_remove__: true, generation: 2 });
  expect(screen.queryByRole("textbox", { name: "插件搜索" })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(frame));
  await send({ __ipc_subinput__: true, generation: 2, opts: { value: "cached", focus: true } });
  expect(screen.queryByRole("textbox", { name: "插件搜索" })).toBeNull();
  await send({ __ipc_subinput__: true, generation: 3, opts: { visible: true, value: "new", focus: true } });
  const input = await screen.findByRole("textbox", { name: "插件搜索" });
  post.mockClear();
  await send({ __ipc_subinput__: true, generation: 1, opts: { value: "late", focus: true } });
  expect((input as HTMLInputElement).value).toBe("new");
  expect(post).not.toHaveBeenCalled();
});


it("binds the plugin input to only the current virtualized output option and drops stale relations", async () => {
  const { send, epoch } = await openPlugin();
  originalFeatureViewportHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "clientHeight");
  Object.defineProperty(HTMLDivElement.prototype, "clientHeight", { configurable: true, get: () => 128 });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  await send({ __ipc_subinput__: true, generation: 1, opts: { visible: true, focus: true } });
  await send({ __atools_feature_exports__: true, epoch, entry: 1, revision: 1, mode: "list", selectable: true,
    rows: Array.from({ length: 200 }, (_, index) => ({ index, title: `Feature ${index}`, description: "", icon: "" })) });
  const input = await screen.findByRole("combobox", { name: "插件搜索" });
  await waitFor(() => {
    const active = input.getAttribute("aria-activedescendant");
    expect(active).toBeTruthy();
    const option = active ? document.getElementById(active) : null;
    expect(option?.getAttribute("role")).toBe("option");
    expect(option?.getAttribute("aria-selected")).toBe("true");
  });
  const listboxId = input.getAttribute("aria-controls")!;
  expect(document.getElementById(listboxId)?.getAttribute("role")).toBe("listbox");
  const viewport = document.getElementById(listboxId) as HTMLDivElement;
  Object.defineProperty(viewport, "scrollTop", { configurable: true, writable: true, value: 64 });
  await fireEvent.scroll(viewport);
  await waitFor(() => expect(input.hasAttribute("aria-activedescendant")).toBe(false));
  expect(document.getElementById(`${listboxId}-option-0`)).toBeTruthy();
  Object.defineProperty(viewport, "scrollTop", { configurable: true, writable: true, value: 0 });
  await fireEvent.scroll(viewport);
  await waitFor(() => expect(input.getAttribute("aria-activedescendant")).toBe(`${listboxId}-option-0`));
  await fireEvent.keyDown(input, { key: "End" });
  await waitFor(() => {
    const active = input.getAttribute("aria-activedescendant");
    const option = active ? document.getElementById(active) : null;
    expect(option?.getAttribute("aria-posinset")).toBe("200");
    expect(option?.getAttribute("aria-selected")).toBe("true");
  });
  await fireEvent.keyDown(input, { key: "Home" });
  await waitFor(() => {
    const active = input.getAttribute("aria-activedescendant");
    const option = active ? document.getElementById(active) : null;
    expect(option?.getAttribute("aria-posinset")).toBe("1");
    expect(option?.getAttribute("aria-selected")).toBe("true");
  });
  const staleId = input.getAttribute("aria-activedescendant");
  await send({ __atools_feature_exports__: true, epoch, entry: 1, revision: 2, mode: "none", rows: [], selectable: false });
  const textbox = await screen.findByRole("textbox", { name: "插件搜索" });
  expect(textbox.hasAttribute("aria-controls")).toBe(false);
  expect(textbox.hasAttribute("aria-activedescendant")).toBe(false);
  expect(staleId ? document.getElementById(staleId) : null).toBeNull();
  await send({ __atools_feature_exports__: true, epoch, entry: 1, revision: 1, mode: "list", selectable: true,
    rows: [{ index: 0, title: "Stale", description: "", icon: "" }] });
  expect(screen.getByRole("textbox", { name: "插件搜索" }).hasAttribute("aria-controls")).toBe(false);
});

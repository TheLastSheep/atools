import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PluginMarketPanel from "../../src/components/PluginMarketPanel.svelte";
import { DEFAULT_ZTOOLS_MARKET_URL, type MarketConfirm } from "../../src/lib/pluginMarketView";
import type { PluginMarketCatalogPlugin } from "../../src/lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
const plugins: PluginMarketCatalogPlugin[] = Array.from({ length: 220 }, (_, index) => ({
  id: `fixture-${index}`, name: `样例工具 ${index + 1}`, version: "1.0.0", description: `样例功能说明 ${index + 1}`,
  author: "离线目录", trust_policy: "official_ztools_confirm", downloads: index,
  homepage: `https://fixture.invalid/${"long-address/".repeat(15)}${index}`,
}));
const nativeDialogMethods = ["showModal", "close"] as const;
const dialogDescriptors = new Map(nativeDialogMethods.map(name => [name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)]));

beforeEach(() => {
  mocks.invoke.mockReset(); mocks.listen.mockClear();
  Object.assign(window, { __TAURI_INTERNALS__: { invoke: mocks.invoke } });
  // jsdom has no top layer. Exercise our focus/keyboard ownership; native modality
  // and responsive geometry require the separate real-browser acceptance pass.
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.setAttribute("open", ""); }) });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.removeAttribute("open"); }) });
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "list_plugins") return [];
    if (command === "fetch_plugin_market_catalog") return { source_url: args.url, source_kind: "ztools", plugins };
    if (command === "fetch_official_plugin_target") return { plugin_id: args.pluginId, source_url: DEFAULT_ZTOOLS_MARKET_URL, source_kind: "ztools", status: "available", plugin: plugins.find(plugin => plugin.id === args.pluginId) };
    if (command === "resolve_plugin_market_download") return { download_url: "https://fixture.invalid/tool.zip", package_format: "zip" };
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(() => {
  cleanup(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  for (const name of nativeDialogMethods) {
    const descriptor = dialogDescriptors.get(name);
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});
function panel(confirm = vi.fn(async () => false)) {
  const view = render(PluginMarketPanel, { custom: false, url: "", trustedPublicKeys: "", confirm });
  return { ...view, confirm };
}

it("opens details over a 220-item catalog and returns to the same query, row and scroll position", async () => {
  panel(); await screen.findByRole("heading", { name: /^样例工具 220/, level: 4 });
  const search = screen.getByRole("searchbox", { name: "搜索本次目录" });
  await fireEvent.input(search, { target: { value: "样例" } });
  const catalog = screen.getByLabelText("插件市场"); catalog.scrollTop = 640;
  const row = document.querySelector(".plugin-row")!;
  const trigger = within(row as HTMLElement).getByRole("button", { name: "详情" }); trigger.focus();
  await fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "样例工具 1" });
  const back = within(dialog).getByRole("button", { name: /返回目录/ });
  await waitFor(() => expect(document.activeElement).toBe(back));
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(trigger.getAttribute("aria-controls")).toBe(dialog.id);
  expect(document.querySelectorAll(".plugin-row")).toHaveLength(220);
  expect(within(dialog).getByText("样例功能说明 1")).toBeTruthy();
  await fireEvent.click(back);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger); expect(catalog.scrollTop).toBe(640);
  expect((search as HTMLInputElement).value).toBe("样例");
  expect(document.querySelector(".plugin-row")).toBe(row);
  expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(["list_plugins", "fetch_plugin_market_catalog"]);
});

it("owns Escape and wraps keyboard focus without forwarding keys to the launcher", async () => {
  panel(); await screen.findByRole("heading", { name: /^样例工具 220/, level: 4 });
  const trigger = screen.getAllByRole("button", { name: "详情" })[42]; trigger.focus(); await fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "样例工具 43" });
  const back = within(dialog).getByRole("button", { name: /返回目录/ });
  const install = within(dialog).getByRole("button", { name: "安装", exact: true });
  await waitFor(() => expect(document.activeElement).toBe(back));
  await fireEvent.keyDown(back, { key: "Tab", shiftKey: true }); expect(document.activeElement).toBe(install);
  await fireEvent.keyDown(install, { key: "Tab" }); expect(document.activeElement).toBe(back);
  const globalKey = vi.fn(); window.addEventListener("keydown", globalKey);
  try {
    await fireEvent.keyDown(back, { key: "Escape", isComposing: true }); expect(screen.getByRole("dialog")).toBeTruthy();
    await fireEvent.keyDown(back, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(globalKey).not.toHaveBeenCalled(); expect(document.activeElement).toBe(trigger);
  } finally { window.removeEventListener("keydown", globalKey); }
});

it("closes the detail modality before asking separately to install the selected identity", async () => {
  const confirm = vi.fn(async (_request: MarketConfirm) => { expect(screen.queryByRole("dialog")).toBeNull(); return false; });
  panel(confirm); await screen.findByRole("heading", { name: /^样例工具 220/, level: 4 });
  await fireEvent.click(screen.getAllByRole("button", { name: "详情" })[219]);
  const dialog = await screen.findByRole("dialog", { name: "样例工具 220" });
  await fireEvent.click(within(dialog).getByRole("button", { name: "安装", exact: true }));
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  expect(mocks.invoke).toHaveBeenCalledWith("resolve_plugin_market_download", { plugin: plugins[219] });
  expect(confirm.mock.calls[0][0].message).toContain("样例工具 220 v1.0.0");
  expect(mocks.invoke.mock.calls.some(([command]) => command.includes("install_plugin"))).toBe(false);
});

it("handles native cancellation and unmounts details when leaving the market", async () => {
  const view = panel(); await screen.findByRole("heading", { name: /^样例工具 220/, level: 4 });
  const trigger = screen.getAllByRole("button", { name: "详情" })[0];
  await fireEvent.click(trigger); await fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await fireEvent.click(trigger); await screen.findByRole("dialog");
  await view.rerender({ custom: false, url: "", trustedPublicKeys: "", confirm: view.confirm, visible: false });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("keeps long untrusted detail content as literal text at a narrow window size", async () => {
  const previous = window.innerWidth; Object.defineProperty(window, "innerWidth", { value: 360, configurable: true });
  const original = mocks.invoke.getMockImplementation()!;
  const hostile = { ...plugins[0], name: "<img src=x onerror=alert(1)>", description: "<script>globalThis.leaked=true</script>" };
  mocks.invoke.mockImplementation((command, args) => command === "fetch_plugin_market_catalog"
    ? Promise.resolve({ source_url: DEFAULT_ZTOOLS_MARKET_URL, source_kind: "ztools", plugins: [hostile] }) : original(command, args));
  try {
    panel(); await screen.findByRole("heading", { name: /<img src=x onerror=alert\(1\)>/, level: 4 });
    await fireEvent.click(screen.getByRole("button", { name: "详情" }));
    const dialog = await screen.findByRole("dialog", { name: hostile.name });
    expect(within(dialog).getByText(hostile.description)).toBeTruthy();
    expect(within(dialog).getByText(hostile.homepage!)).toBeTruthy();
    expect(dialog.querySelector("img, script")).toBeNull();
    await fireEvent.click(within(dialog).getByRole("button", { name: /返回目录/ }));
  } finally { Object.defineProperty(window, "innerWidth", { value: previous, configurable: true }); }
});

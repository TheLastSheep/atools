import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SettingsPanel from "../../src/components/SettingsPanel.svelte";
import { PLUGIN_OPEN_REQUESTED_EVENT } from "../../src/lib/pluginOpen";
import { SETTINGS_STORAGE_KEY } from "../../src/lib/settings";
import { DEFAULT_ZTOOLS_MARKET_URL } from "../../src/lib/pluginMarketView";
import type { InstalledPlugin } from "../../src/lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
const candidate = { id: "fixture-owned-plugin", name: "离线插件", version: "2.0.0", description: "独立安装与授权", trust_policy: "official_ztools_confirm" };
const installed: InstalledPlugin = { id: candidate.id, name: candidate.id, version: candidate.version, enabled: false, source_kind: "imported",
  path: "/offline/atools/plugins/fixture-owned-plugin", created_at: "2026-10-15", updated_at: "2026-10-15",
  manifest: { title: candidate.name, main: "index.html", features: [{ code: "original-feature-code", label: "打开工具", explain: "准确功能身份" }] } };
let inventory: InstalledPlugin[];
const preferences = { pluginMarketCustom: false, pluginMarketTrustedPublicKeys: [] };

beforeEach(() => {
  inventory = []; mocks.invoke.mockReset(); mocks.listen.mockClear();
  Object.assign(window, { __TAURI_INTERNALS__: { invoke: mocks.invoke } });
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(preferences));
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "get_setting") return JSON.stringify(preferences);
    if (command === "list_plugins") return inventory;
    if (command === "fetch_plugin_market_catalog") return { source_url: args.url, source_kind: "ztools", plugins: [candidate] };
    if (command === "fetch_official_plugin_target") return { plugin_id: args.pluginId, source_url: DEFAULT_ZTOOLS_MARKET_URL, source_kind: "ztools", status: "available", plugin: candidate };
    if (command === "resolve_plugin_market_download") return { download_url: "https://ztools.zosen.link/fixture.zip", package_format: "zip" };
    if (command === "install_plugin_from_market" || command === "update_plugin_from_market") { inventory = [structuredClone(installed)]; return inventory[0]; }
    if (command === "authorize_plugin_permissions") { inventory = [{ ...installed, enabled: true }]; return inventory[0]; }
    return [];
  });
});
afterEach(() => { cleanup(); localStorage.clear(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });

async function readyOpen() {
  const button = await screen.findByRole("button", { name: "立即打开", exact: true });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  return button;
}

async function installAndManage(operation = "安装") {
  render(SettingsPanel, { initialMenu: "market" });
  const heading = await screen.findByRole("heading", { name: /离线插件/, level: 4 });
  await fireEvent.click(within(heading.closest("article")!).getByRole("button", { name: operation, exact: true }));
  const installConfirm = await screen.findByRole("dialog", { name: `${operation}插件` });
  await fireEvent.click(within(installConfirm).getByRole("button", { name: operation, exact: true }));
  await fireEvent.click(await screen.findByRole("button", { name: "查看并启用" }));
  await screen.findByRole("heading", { name: /^已安装插件\s+1$/, level: 3 });
  expect(screen.queryByRole("button", { name: "立即打开", exact: true })).toBeNull();
  await fireEvent.click(screen.getByRole("button", { name: "授权启用", exact: true }));
  return await screen.findByRole("dialog", { name: "授权启用插件" });
}

it.each(["安装", "更新"])("after %s and approval, opens the exact plugin/feature only when requested", async operation => {
  if (operation === "更新") inventory = [{ ...installed, version: "1.0.0", enabled: true }];
  const opened = vi.fn((event: CustomEvent) => {
    event.preventDefault();
    event.detail.respond({ status: "committed" });
  }); window.addEventListener(PLUGIN_OPEN_REQUESTED_EVENT, opened as EventListener);
  try {
    const approval = await installAndManage(operation);
    expect(opened).not.toHaveBeenCalled();
    await fireEvent.click(within(approval).getByRole("button", { name: "授权启用", exact: true }));
    const open = await readyOpen();
    expect(opened).not.toHaveBeenCalled();
    expect(inventory[0].enabled).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("authorize_plugin_permissions", { pluginId: candidate.id });
    await fireEvent.click(open);
    expect(opened).toHaveBeenCalledTimes(1);
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ pluginId: candidate.id, code: "original-feature-code" });
    expect((screen.getByRole("button", { name: "立即打开", exact: true }) as HTMLButtonElement).disabled).toBe(false);
    expect(mocks.invoke.mock.calls.some(([command]) => command === "activate_feature" || command === "prepare_legacy_node")).toBe(false);
  } finally { window.removeEventListener(PLUGIN_OPEN_REQUESTED_EVENT, opened as EventListener); }
});

it("retains the installed entry after failure and blocks duplicate opens until an explicit retry", async () => {
  const attempts: CustomEvent[] = [];
  const opened = (event: Event) => {
    const request = event as CustomEvent; event.preventDefault(); attempts.push(request);
    if (attempts.length === 1) request.detail.respond({ status: "failed", reason: "activation-failed" });
  };
  window.addEventListener(PLUGIN_OPEN_REQUESTED_EVENT, opened);
  try {
    const approval = await installAndManage();
    await fireEvent.click(within(approval).getByRole("button", { name: "授权启用", exact: true }));
    const firstOpen = await readyOpen();
    await fireEvent.click(firstOpen);
    await screen.findByText("插件未能打开，请检查插件状态后重试。");
    expect(screen.getByRole("button", { name: "重试打开", exact: true })).toBeTruthy();
    expect(attempts).toHaveLength(1);
    await fireEvent.click(screen.getByRole("button", { name: "重试打开", exact: true }));
    expect(attempts).toHaveLength(2);
    attempts[1].detail.respond({ status: "committed" });
    await waitFor(() => expect((screen.getByRole("button", { name: "立即打开", exact: true }) as HTMLButtonElement).disabled).toBe(false));
  } finally { window.removeEventListener(PLUGIN_OPEN_REQUESTED_EVENT, opened); }
});

it("disables repeated clicks while a claimed open is still pending", async () => {
  const opened = (event: Event) => { event.preventDefault(); };
  window.addEventListener(PLUGIN_OPEN_REQUESTED_EVENT, opened);
  try {
    const approval = await installAndManage();
    await fireEvent.click(within(approval).getByRole("button", { name: "授权启用", exact: true }));
    const open = await readyOpen();
    await fireEvent.click(open);
    const pending = await screen.findByRole("button", { name: "正在打开…", exact: true });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    expect((pending as HTMLButtonElement).getAttribute("aria-busy")).toBe("true");
  } finally { window.removeEventListener(PLUGIN_OPEN_REQUESTED_EVENT, opened); }
});

it("reports an unavailable receiver and keeps the installed entry when no App listener is mounted", async () => {
  const approval = await installAndManage();
  await fireEvent.click(within(approval).getByRole("button", { name: "授权启用", exact: true }));
  await fireEvent.click(await readyOpen());
  await screen.findByText("当前无法打开插件，请重试。");
  expect(screen.getByRole("button", { name: "重试打开", exact: true })).toBeTruthy();
  expect(mocks.invoke.mock.calls.some(([command]) => command === "activate_feature")).toBe(false);
});

it("ignores a late success after leaving plugin management and requires a fresh explicit open", async () => {
  let lateResponse: (outcome: { status: "committed" }) => void = () => {};
  const opened = (event: Event) => {
    const request = event as CustomEvent; event.preventDefault();
    lateResponse = request.detail.respond;
  };
  window.addEventListener(PLUGIN_OPEN_REQUESTED_EVENT, opened);
  try {
    const approval = await installAndManage();
    await fireEvent.click(within(approval).getByRole("button", { name: "授权启用", exact: true }));
    await fireEvent.click(await readyOpen());
    await screen.findByRole("button", { name: "正在打开…", exact: true });
    await fireEvent.click(screen.getByRole("button", { name: "通用设置", exact: true }));
    await fireEvent.click(screen.getByRole("button", { name: "已安装插件", exact: true }));
    const retry = await readyOpen();
    lateResponse({ status: "committed" });
    await waitFor(() => expect(screen.getByRole("button", { name: "立即打开", exact: true })).toBe(retry));
    expect((screen.getByRole("button", { name: "立即打开", exact: true }) as HTMLButtonElement).disabled).toBe(false);
  } finally { window.removeEventListener(PLUGIN_OPEN_REQUESTED_EVENT, opened); }
});

it("keeps a cancelled approval disabled and never opens the plugin", async () => {
  const opened = vi.fn(); window.addEventListener(PLUGIN_OPEN_REQUESTED_EVENT, opened);
  try {
    const approval = await installAndManage(); await fireEvent.click(within(approval).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(inventory[0].enabled).toBe(false);
    expect(screen.queryByRole("button", { name: "立即打开", exact: true })).toBeNull();
    expect(mocks.invoke.mock.calls.some(([command]) => command === "authorize_plugin_permissions")).toBe(false);
    expect(opened).not.toHaveBeenCalled();
  } finally { window.removeEventListener(PLUGIN_OPEN_REQUESTED_EVENT, opened); }
});

it("keeps a failed approval disabled and never opens the plugin", async () => {
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command, args) => command === "authorize_plugin_permissions"
    ? Promise.reject(new Error("离线授权失败")) : original(command, args));
  const opened = vi.fn(); window.addEventListener(PLUGIN_OPEN_REQUESTED_EVENT, opened);
  try {
    const approval = await installAndManage();
    await fireEvent.click(within(approval).getByRole("button", { name: "授权启用", exact: true }));
    await screen.findByText(/授权启用插件失败：离线授权失败/);
    expect(inventory[0].enabled).toBe(false); expect(opened).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "立即打开", exact: true })).toBeNull();
  } finally { window.removeEventListener(PLUGIN_OPEN_REQUESTED_EVENT, opened); }
});

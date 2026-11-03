import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PluginMarketDetailBrowserHarness from "./PluginMarketDetailBrowserHarness.svelte";
import { createPermissionHarnessBackend } from "./permissionHarnessBackend";
import { DEFAULT_ZTOOLS_MARKET_URL } from "../../src/lib/pluginMarketView";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
const rows = Array.from({ length: 220 }, (_, index) => ({ id: `offline-${index}`, name: `工具 ${index + 1}`, version: "1.0.0",
  description: "离线市场元数据", trust_policy: "official_ztools_confirm" }));
let status: "available" | "unsupported_platform" | "not_found" | "error", version: string;
const targetCalls = () => mocks.invoke.mock.calls.filter(([command]) => command === "fetch_official_plugin_target");
const packageCalls = () => mocks.invoke.mock.calls.filter(([command]) => ["resolve_plugin_market_download", "install_plugin_from_market", "update_plugin_from_market"].includes(command));

beforeEach(() => {
  status = "available"; version = "2.0.0"; mocks.invoke.mockReset();
  Object.assign(window, { __TAURI_INTERNALS__: { invoke: mocks.invoke } });
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "list_plugins") return [];
    if (command === "fetch_plugin_market_catalog") return { source_url: args.url, source_kind: "ztools", plugins: rows };
    if (command === "fetch_official_plugin_target") {
      if (status === "error") throw Error("离线查询失败");
      return { plugin_id: args.pluginId, source_url: DEFAULT_ZTOOLS_MARKET_URL, source_kind: "ztools", status,
        plugin: status === "available" ? { ...rows.find(row => row.id === args.pluginId), version } : null };
    }
    if (command === "resolve_plugin_market_download") return { download_url: "https://ztools.zosen.link/never-downloaded.zip", package_format: "zip" };
    throw Error("Fixture refuses mutation: " + command);
  });
});
afterEach(() => { cleanup(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });
async function panel() {
  render(PluginMarketDetailBrowserHarness, { recordConfirmation: vi.fn(), permissionBackend: createPermissionHarnessBackend() });
  await screen.findByRole("heading", { name: /^工具 220/, level: 4 });
}
async function clickFirst() { await fireEvent.click(screen.getAllByRole("button", { name: "安装", exact: true })[0]); }

it.each(["unsupported_platform", "not_found"] as const)("shows an actionable %s result while preserving a 220-row query and scroll", async result => {
  status = result; await panel();
  const search = screen.getByRole("searchbox"), catalog = screen.getByLabelText("插件市场");
  await fireEvent.input(search, { target: { value: "工具" } }); catalog.scrollTop = 640;
  const row = document.querySelector(".plugin-row"); expect(targetCalls()).toHaveLength(0);
  await clickFirst();
  const notice = await screen.findByLabelText(result === "unsupported_platform" ? "当前平台不支持" : "未找到官方发布信息");
  expect(notice.textContent).toContain("工具 1"); expect(notice.textContent).toContain("未开始下载安装");
  expect((search as HTMLInputElement).value).toBe("工具"); expect(catalog.scrollTop).toBe(640);
  expect(document.querySelector(".plugin-row")).toBe(row); expect(document.querySelectorAll(".plugin-row")).toHaveLength(220);
  expect(targetCalls()).toHaveLength(1); expect(packageCalls()).toHaveLength(0); expect(screen.queryByRole("dialog")).toBeNull();
});

it("uses the existing real confirmation for the changed version and cancellation never installs", async () => {
  await panel(); expect(targetCalls()).toHaveLength(0); await clickFirst();
  const dialog = await screen.findByRole("dialog", { name: "安装插件 · 发布版本已变化" });
  expect(dialog.textContent).toContain("你选择的是 v1.0.0，当前发布版为 v2.0.0");
  expect(dialog.textContent).toContain("未提供可验证的 SHA-256 或 Ed25519 签名");
  expect(within(dialog).getByRole("button", { name: "安装 v2.0.0", exact: true })).toBeTruthy();
  await fireEvent.click(within(dialog).getByRole("button", { name: "取消", exact: true }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(packageCalls().map(([command]) => command)).toEqual(["resolve_plugin_market_download"]);
  version = "3.0.0"; await clickFirst();
  const next = await screen.findByRole("dialog", { name: "安装插件 · 发布版本已变化" });
  expect(next.textContent).toContain("你选择的是 v2.0.0，当前发布版为 v3.0.0");
  await fireEvent.click(within(next).getByRole("button", { name: "取消", exact: true }));
  expect(targetCalls()).toHaveLength(2);
});

it("offers an explicit fresh check after lookup failure and retains the same install confirmation boundary", async () => {
  status = "error"; await panel(); await clickFirst();
  const error = await screen.findByLabelText("官方发布信息查询失败");
  expect(within(error).getByText("Error: 离线查询失败")).toBeTruthy(); expect(packageCalls()).toHaveLength(0);
  status = "available";
  await fireEvent.click(within(error).getByRole("button", { name: "重新检查并确认" }));
  const confirmation = await screen.findByRole("dialog", { name: "安装插件 · 发布版本已变化" });
  expect(targetCalls()).toHaveLength(2); await fireEvent.click(within(confirmation).getByRole("button", { name: "取消", exact: true }));
  expect(packageCalls().map(([command]) => command)).toEqual(["resolve_plugin_market_download"]);
});

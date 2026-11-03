import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("/Users/harris/Desktop/atools/src/lib/pinyinSearch.ts", () => ({ loadSearchPinyinEngine: vi.fn(async () => false) }));

afterEach(() => {
  cleanup();
  localStorage.clear();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

async function openSystemResult(label: string) {
  const input = await waitFor(() => {
    const value = document.querySelector<HTMLInputElement>(".search-input");
    expect(value).toBeTruthy();
    return value!;
  });
  await fireEvent.input(input, { target: { value: label } });
  await waitFor(() => expect(screen.getAllByRole("option", { name: new RegExp(label) }).some(option => option.getAttribute("aria-selected") === "true")).toBe(true));
  await fireEvent.keyDown(input, { key: "Enter" });
}

it("retains installed-plugin filters and page through the market in the real App, then resets on a new settings session", async () => {
  const settings = { localAppSearch: false, autoPaste: "never", showRecentInSearch: false };
  const installed = Array.from({ length: 95 }, (_, index) => ({
    id: `tool-${String(index).padStart(3, "0")}`,
    name: `tool-${String(index).padStart(3, "0")}`,
    version: "1.0.0",
    enabled: false,
    source_kind: "imported",
    path: `/offline/plugins/tool-${index}`,
    created_at: "2026-10-17",
    updated_at: "2026-10-17",
    manifest: { title: `工具 tool-${String(index).padStart(3, "0")}`, main: "index.html", features: [{ code: "encode", label: "编码" }] },
  }));
  Object.assign(window, { __TAURI_INTERNALS__: { invoke: mocks.invoke, metadata: { currentWindow: { label: "main" } } } });
  localStorage.setItem("atools-settings", JSON.stringify(settings));
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "get_setting") return JSON.stringify(settings);
    if (command === "list_plugins") return installed;
    if (command === "fetch_plugin_market_catalog") return { source_url: args.url, source_kind: "ztools", plugins: [] };
    if (["feature_catalog", "list_pending_agent_requests", "search_features", "search_local_apps"].includes(command)) return [];
    return undefined;
  });

  render(App, { backgroundServices: false });
  await openSystemResult("设置");
  await vi.dynamicImportSettled();
  await fireEvent.click(await screen.findByRole("button", { name: "已安装插件", exact: true }));
  const search = await screen.findByRole("textbox", { name: "筛选已安装插件" });
  await fireEvent.input(search, { target: { value: "tool-" } });
  await fireEvent.change(screen.getByRole("combobox", { name: "插件状态" }), { target: { value: "disabled" } });
  await fireEvent.change(screen.getByRole("combobox", { name: "插件来源" }), { target: { value: "imported" } });
  await fireEvent.click(screen.getByRole("button", { name: "下一页" }));

  const snapshot = () => ({
    query: (screen.getByRole("textbox", { name: "筛选已安装插件" }) as HTMLInputElement).value,
    status: (screen.getByRole("combobox", { name: "插件状态" }) as HTMLSelectElement).value,
    source: (screen.getByRole("combobox", { name: "插件来源" }) as HTMLSelectElement).value,
    page: screen.getByRole("navigation", { name: "插件分页" }).textContent?.replace(/\s+/g, " ").trim(),
    first: document.querySelector("[data-plugin-id]")?.getAttribute("data-plugin-id"),
    rows: document.querySelectorAll("[data-plugin-id]").length,
  });
  const before = snapshot();
  expect(before).toMatchObject({ query: "tool-", status: "disabled", source: "imported", first: "tool-030", rows: 30 });

  await fireEvent.click(screen.getByRole("button", { name: "浏览插件市场 →" }));
  await screen.findByRole("heading", { name: "插件市场", level: 2 });
  await fireEvent.click(screen.getByRole("button", { name: "已安装插件", exact: true }));
  await screen.findByRole("textbox", { name: "筛选已安装插件" });
  const after = snapshot();
  expect(after).toEqual(before);
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "list_plugins").length).toBeGreaterThan(1);

  await fireEvent.click(screen.getByRole("button", { name: "回到主搜索", exact: true }));
  await waitFor(() => expect(document.querySelector(".shell-frame")?.classList.contains("expanded")).toBe(false));
  await openSystemResult("设置");
  await fireEvent.click(await screen.findByRole("button", { name: "已安装插件", exact: true }));
  const newSessionSearch = await screen.findByRole("textbox", { name: "筛选已安装插件" });
  expect((newSessionSearch as HTMLInputElement).value).toBe("");
  expect((screen.getByRole("combobox", { name: "插件状态" }) as HTMLSelectElement).value).toBe("all");
  expect((screen.getByRole("combobox", { name: "插件来源" }) as HTMLSelectElement).value).toBe("all");
  expect(screen.getByRole("navigation", { name: "插件分页" }).textContent).toContain("1 / 4");
  expect(document.querySelector("[data-plugin-id]")?.getAttribute("data-plugin-id")).toBe("tool-000");
});

it("routes the market search result directly while preserving existing settings and plugin-management routes", async () => {
  const settings = { localAppSearch: false, autoPaste: "never", showRecentInSearch: false };
  const catalog = {
    source_url: "https://ztools.example/market.json", source_kind: "ztools",
    plugins: [{ id: "fixed-market-plugin", name: "固定市场样例", version: "1.0.0",
      description: "只用于启动器市场路由验收", trust_policy: "official_ztools_confirm" }],
  };
  Object.assign(window, { __TAURI_INTERNALS__: { invoke: mocks.invoke, metadata: { currentWindow: { label: "main" } } } });
  localStorage.setItem("atools-settings", JSON.stringify(settings));
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "get_setting") return JSON.stringify(settings);
    if (command === "fetch_plugin_market_catalog") return { ...catalog, source_url: args.url };
    if (command === "list_plugins") return [];
    if (["feature_catalog", "list_pending_agent_requests", "search_features", "search_local_apps"].includes(command)) return [];
    return undefined;
  });
  render(App, { backgroundServices: false });
  await openSystemResult("设置");
  await vi.dynamicImportSettled();
  await screen.findByRole("heading", { name: "通用设置概览" });
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "fetch_plugin_market_catalog")).toHaveLength(0);
  await fireEvent.click(screen.getByRole("button", { name: "回到主搜索", exact: true }));

  const search = await waitFor(() => {
    const input = document.querySelector<HTMLInputElement>(".search-input");
    expect(input).toBeTruthy();
    return input!;
  });
  await fireEvent.input(search, { target: { value: "插件市场" } });
  const marketOption = await screen.findByRole("option", { name: /^插件市场/ });
  expect(marketOption.getAttribute("data-result-code")).toBe("system:market");
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "fetch_plugin_market_catalog")).toHaveLength(0);
  await fireEvent.keyDown(search, { key: "Enter" });
  await screen.findByText("固定市场样例");
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "fetch_plugin_market_catalog")).toHaveLength(1);

  await fireEvent.click(screen.getByRole("button", { name: "回到主搜索", exact: true }));
  await openSystemResult("设置");
  await screen.findByRole("heading", { name: "插件市场", level: 2 });
  await fireEvent.click(screen.getByRole("button", { name: "回到主搜索", exact: true }));
  await openSystemResult("插件管理");
  const pluginManagement = await screen.findByRole("button", { name: "已安装插件", exact: true });
  expect(pluginManagement.classList.contains("active")).toBe(true);
});

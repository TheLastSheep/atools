import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ZToolsImportPanel from "../../src/components/ZToolsImportPanel.svelte";
import { PLUGIN_OPEN_REQUESTED_EVENT } from "../../src/lib/pluginOpen";
import type { InstalledPlugin, ZToolsImportCandidate } from "../../src/lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));

const candidate: ZToolsImportCandidate = {
  path: "/synthetic/plugin-source", source_type: "directory", entry_readiness: "ready",
  name: "imported-plugin", title: "导入插件", version: "1.0.0", features_count: 1,
  platform_supported: true, main_exists: true, preload_exists: false, logo_exists: false,
  unsupported_cmd_types: [], warnings: [], errors: [],
};
const plugin: InstalledPlugin = {
  id: "imported-plugin", name: "导入插件", version: "1.0.0", enabled: true,
  path: "/synthetic/installed-plugin", created_at: "2026-10-15", updated_at: "2026-10-15",
  manifest: { title: "导入插件", main: "index.html", features: [{ code: "imported-feature" }] },
};

beforeEach(() => {
  mocks.invoke.mockReset(); mocks.open.mockReset();
  mocks.invoke.mockImplementation(async command => {
    if (command === "scan_default_ztools_plugins") return [candidate];
    if (command === "import_ztools_plugins") return { imported: [plugin.id], skipped: [], failed: [] };
    if (command === "list_plugins") return [plugin];
    return undefined;
  });
});
afterEach(() => { cleanup(); });

async function importFixture() {
  const view = render(ZToolsImportPanel);
  await screen.findByText("导入 ZTools 插件", { selector: "h3" });
  await fireEvent.click(await screen.findByRole("button", { name: "导入 1 个插件" }));
  await screen.findByRole("button", { name: "立即打开", exact: true });
  return view;
}

it("keeps imported plugin available with a safe retry message when no App listener is present", async () => {
  await importFixture();
  await fireEvent.click(screen.getByRole("button", { name: "立即打开", exact: true }));
  await screen.findByText("当前无法打开插件，请重试。");
  expect(screen.getByRole("button", { name: "重试打开", exact: true })).toBeTruthy();
  expect(mocks.invoke.mock.calls.some(([command]) => command === "activate_feature")).toBe(false);
});

it("shows the refreshed manifest title while keeping ID and open status together in the action cell", async () => {
  const friendlyPlugin = { ...plugin, manifest: { ...plugin.manifest, title: "友好插件名" } };
  mocks.invoke.mockImplementation(async command => {
    if (command === "scan_default_ztools_plugins") return [candidate];
    if (command === "import_ztools_plugins") return { imported: [plugin.id], skipped: [], failed: [] };
    if (command === "list_plugins") return [friendlyPlugin];
    return undefined;
  });
  render(ZToolsImportPanel);
  await fireEvent.click(await screen.findByRole("button", { name: "导入 1 个插件" }));
  await screen.findByRole("button", { name: "立即打开", exact: true });
  const row = screen.getByText("友好插件名").closest(".report-row");
  expect(row?.querySelector(".result-copy small")?.textContent).toBe(plugin.id);
  expect(row?.children).toHaveLength(3);
  await fireEvent.click(screen.getByRole("button", { name: "立即打开", exact: true }));
  const actions = row?.querySelector(".report-actions");
  expect(actions?.querySelector('[role="status"]')?.textContent).toBe("当前无法打开插件，请重试。");
  expect(actions?.querySelector("button")?.textContent).toBe("重试打开");
});

it("keeps an in-flight import open single-flight and ignores a late result after unmount", async () => {
  let respond: (outcome: { status: "committed" }) => void = () => {};
  const listener = (event: Event) => {
    const request = event as CustomEvent; event.preventDefault(); respond = request.detail.respond;
  };
  window.addEventListener(PLUGIN_OPEN_REQUESTED_EVENT, listener);
  try {
    const view = await importFixture();
    await fireEvent.click(screen.getByRole("button", { name: "立即打开", exact: true }));
    expect(screen.getByRole("button", { name: "正在打开…", exact: true })).toBeTruthy();
    view.unmount();
    respond({ status: "committed" });
    expect(screen.queryByRole("button", { name: "正在打开…", exact: true })).toBeNull();
  } finally { window.removeEventListener(PLUGIN_OPEN_REQUESTED_EVENT, listener); }
});

it("invalidates an old open when a new scan replaces the imported plugin selection", async () => {
  let respond: (outcome: { status: "committed" }) => void = () => {};
  const listener = (event: Event) => {
    const request = event as CustomEvent; event.preventDefault(); respond = request.detail.respond;
  };
  window.addEventListener(PLUGIN_OPEN_REQUESTED_EVENT, listener);
  try {
    await importFixture();
    await fireEvent.click(screen.getByRole("button", { name: "立即打开", exact: true }));
    await screen.findByRole("button", { name: "正在打开…", exact: true });
    await fireEvent.click(screen.getByRole("button", { name: "扫描 ZTools", exact: true }));
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "scan_default_ztools_plugins")).toHaveLength(2));
    respond({ status: "committed" });
    expect(screen.queryByRole("heading", { name: "导入报告" })).toBeNull();
    expect(mocks.invoke.mock.calls.some(([command]) => command === "activate_feature")).toBe(false);
  } finally { window.removeEventListener(PLUGIN_OPEN_REQUESTED_EVENT, listener); }
});

it("keeps the successful report when list_plugins fails and retries only the listing", async () => {
  mocks.invoke.mockImplementation(async command => {
    if (command === "scan_default_ztools_plugins") return [candidate];
    if (command === "import_ztools_plugins") return { imported: [plugin.id], skipped: [], failed: [] };
    if (command === "list_plugins") throw new Error("temporary catalog failure");
    return undefined;
  });
  render(ZToolsImportPanel);
  await fireEvent.click(await screen.findByRole("button", { name: "导入 1 个插件" }));
  await screen.findByRole("button", { name: "重新读取插件列表" });
  expect(screen.getByText("导入报告")).toBeTruthy();
  expect(screen.getByText("成功 1 个，跳过 0 个，失败 0 个。")).toBeTruthy();
  await fireEvent.click(screen.getByRole("button", { name: "重新读取插件列表" }));
  await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "import_ztools_plugins")).toHaveLength(1));
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "list_plugins")).toHaveLength(2);
});

it("offers an explicit native enable-and-open action and opens only from the refreshed plugin record", async () => {
  const disabled = { ...plugin, enabled: false };
  let enableSucceeded = false;
  let listCalls = 0;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "scan_default_ztools_plugins") return [candidate];
    if (command === "import_ztools_plugins") return { imported: [plugin.id], skipped: [], failed: [] };
    if (command === "list_plugins") {
      listCalls += 1;
      if (enableSucceeded && listCalls === 2) throw new Error("refresh unavailable after toggle");
      return [enableSucceeded ? plugin : disabled];
    }
    if (command === "toggle_plugin") { expect(args).toEqual({ pluginId: plugin.id, enabled: true }); enableSucceeded = true; return undefined; }
    return undefined;
  });
  let openRequests = 0;
  const claimOpen = (event: Event) => {
    const request = event as CustomEvent;
    request.preventDefault();
    request.detail.respond({ status: "committed" });
    openRequests += 1;
  };
  window.addEventListener(PLUGIN_OPEN_REQUESTED_EVENT, claimOpen);
  try {
    render(ZToolsImportPanel);
    await fireEvent.click(await screen.findByRole("button", { name: "导入 1 个插件" }));
    const enable = await screen.findByRole("button", { name: "启用并打开" }) as HTMLButtonElement;
    await waitFor(() => expect(enable.disabled).toBe(false));
    await fireEvent.click(enable);
    const reread = await screen.findByRole("button", { name: "重新读取并打开" }) as HTMLButtonElement;
    await waitFor(() => expect(reread.disabled).toBe(false));
    await fireEvent.click(reread);
    expect(await screen.findByRole("button", { name: "立即打开", exact: true })).toBeTruthy();
    expect(openRequests).toBe(1);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "import_ztools_plugins")).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "toggle_plugin")).toHaveLength(1);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "list_plugins")).toHaveLength(3);
  } finally { window.removeEventListener(PLUGIN_OPEN_REQUESTED_EVENT, claimOpen); }
});

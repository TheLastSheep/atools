import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PluginInventoryPanel from "../../src/components/PluginInventoryPanel.svelte";
import type { InstalledPlugin } from "../../src/lib/types";

const services = vi.hoisted(() => ({
  available: vi.fn(), list: vi.fn(), install: vi.fn(), update: vi.fn(), toggle: vi.fn(),
  authorize: vi.fn(), uninstall: vi.fn(), reveal: vi.fn(), choose: vi.fn(),
}));
vi.mock("../../src/lib/pluginInventoryServices", () => ({ pluginInventoryServices: (confirm: unknown) => ({
  available: services.available, listPlugins: services.list, chooseDirectory: services.choose,
  installDirectory: services.install, updateDirectory: services.update, togglePlugin: services.toggle,
  authorizePlugin: services.authorize, uninstallPlugin: services.uninstall, revealPath: services.reveal, confirm,
}) }));

const plugin = (id: string): InstalledPlugin => ({
  id, name: `工具 ${id}`, version: "1.0.0", enabled: true, source_kind: "imported",
  path: `/offline/plugins/${id}`, created_at: "2026-10-19", updated_at: "2026-10-19",
  manifest: { title: `工具 ${id}`, description: "离线筛选测试", main: "index.html", features: [] },
});
const catalogue = [plugin("alpha"), plugin("beta"), plugin("gamma")];
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
};
const confirm = vi.fn(async () => true);
const toolbar = () => screen.getByRole("group", { name: "筛选插件" }).parentElement!;
const countStatus = () => within(toolbar()).getByRole("status", { name: "筛选插件结果" });
const visibleCaption = () => toolbar().querySelector(".list-caption > span[aria-hidden='true']")?.textContent?.trim();

beforeEach(() => {
  Object.values(services).forEach(mock => mock.mockReset());
  services.available.mockReturnValue(true);
  services.list.mockResolvedValue(catalogue);
});
afterEach(() => { cleanup(); localStorage.clear(); });

it("announces zero results once, keeps the search focused, then clear restores visible matches and focus", async () => {
  render(PluginInventoryPanel, { confirm });
  const search = await screen.findByRole("textbox", { name: "筛选已安装插件" });
  await screen.findByRole("button", { name: "查看 工具 alpha 详情" });
  search.focus();
  await fireEvent.input(search, { target: { value: "no-such-plugin" } });

  expect(countStatus()?.textContent).toBe("找到 0 个插件");
  expect(document.activeElement).toBe(search);
  expect(screen.getByText("没有找到插件")).toBeTruthy();
  await fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));

  expect(document.activeElement).toBe(search);
  expect((search as HTMLInputElement).value).toBe("");
  expect(screen.getByRole("button", { name: "查看 工具 alpha 详情" })).toBeTruthy();
  expect(countStatus().textContent?.trim()).toBe("");
  expect(services.list).toHaveBeenCalledTimes(1);
  expect(services.install).not.toHaveBeenCalled();
  expect(services.update).not.toHaveBeenCalled();
  expect(services.toggle).not.toHaveBeenCalled();
  expect(services.authorize).not.toHaveBeenCalled();
  expect(services.uninstall).not.toHaveBeenCalled();
});

it("announces a nonzero filtered count in one atomic toolbar status, outside the market action", async () => {
  render(PluginInventoryPanel, { confirm, onmarket: vi.fn() });
  const search = await screen.findByRole("textbox", { name: "筛选已安装插件" });
  await screen.findByRole("button", { name: "查看 工具 alpha 详情" });
  await fireEvent.input(search, { target: { value: "alpha" } });

  const status = countStatus();
  expect(status?.textContent).toBe("找到 1 个插件");
  expect(status?.getAttribute("aria-live")).toBe("polite");
  expect(status?.getAttribute("aria-atomic")).toBe("true");
  expect(within(toolbar()).getByRole("button", { name: /浏览插件市场/ }).closest("[aria-live]")).toBeNull();
  expect(screen.getByRole("button", { name: "查看 工具 alpha 详情" })).toBeTruthy();
});

it("keeps one prepared status node through initial load, query, and deferred refresh", async () => {
  const initial = deferred<InstalledPlugin[]>();
  services.list.mockReturnValueOnce(initial.promise);
  render(PluginInventoryPanel, { confirm, query: "alpha" });
  const status = countStatus();

  expect(status.textContent?.trim()).toBe("");
  expect(visibleCaption()).toBe("筛选结果待更新");
  expect(screen.getByText("正在读取插件…")).toBeTruthy();
  initial.resolve(catalogue);
  await screen.findByRole("button", { name: "查看 工具 alpha 详情" });
  expect(countStatus()).toBe(status);
  expect(status.textContent).toBe("找到 1 个插件");
  expect(visibleCaption()).toBe("找到 1 个插件");
  expect(document.querySelector(".inventory-announcement")?.textContent).toBe("已读取 3 个插件");

  expect(status.textContent).not.toBe(document.querySelector(".inventory-announcement")?.textContent);

  const refreshed = deferred<InstalledPlugin[]>();
  services.list.mockReturnValueOnce(refreshed.promise);
  await fireEvent.click(screen.getByRole("button", { name: "刷新插件列表" }));
  expect(countStatus()).toBe(status);
  expect(status.textContent?.trim()).toBe("");
  expect(visibleCaption()).toBe("筛选结果待更新");
  expect(document.querySelector(".notice")?.textContent).toContain("正在读取插件清单");

  refreshed.resolve([...catalogue, plugin("alpha-extra")]);
  await waitFor(() => expect(status.textContent).toBe("找到 2 个插件"));
  expect(countStatus()).toBe(status);
  expect(visibleCaption()).toBe("找到 2 个插件");
  expect(document.querySelector(".inventory-announcement")?.textContent).toBe("已读取 4 个插件");
  expect(services.list).toHaveBeenCalledTimes(2);
});

import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, expect, it, vi } from "vitest";
import HomePanel from "../../src/components/HomePanel.svelte";
import type { RecommendedCommand } from "../../src/lib/uiState";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke }));
afterEach(cleanup);

function props(commands: RecommendedCommand[] = []) {
  return { commands, oncommand: vi.fn(), onpanelchange: vi.fn(), ontargetsettings: vi.fn() };
}

it("shows search and paste guidance and routes empty-state buttons to existing destinations", async () => {
  const value = props();
  render(HomePanel, value);

  expect(screen.getByRole("heading", { name: "从搜索开始" })).toBeTruthy();
  expect(screen.getByText("搜索应用或指令，也可以粘贴内容快速查找。")).toBeTruthy();
  await fireEvent.click(screen.getByRole("button", { name: "浏览插件市场" }));
  await fireEvent.click(screen.getByRole("button", { name: "管理插件" }));
  expect(value.ontargetsettings).toHaveBeenCalledTimes(1);
  expect(value.ontargetsettings).toHaveBeenCalledWith("market");
  expect(value.onpanelchange).toHaveBeenCalledTimes(1);
  expect(value.onpanelchange).toHaveBeenCalledWith("plugins");
  expect(value.oncommand).not.toHaveBeenCalled();
});

it("keeps the command grid and hides first-run actions when a command is visible", () => {
  const value = props([{ code: "system:settings", label: "设置", explain: "设置", source: "pinned", panel: "settings" }]);
  render(HomePanel, value);

  expect(screen.getByRole("button", { name: "设置" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "从搜索开始" })).toBeNull();
  expect(screen.queryByRole("button", { name: "浏览插件市场" })).toBeNull();
  expect(screen.queryByRole("button", { name: "管理插件" })).toBeNull();
});

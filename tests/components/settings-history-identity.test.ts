import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, expect, it, vi } from "vitest";
import SettingsPanel from "../../src/components/SettingsPanel.svelte";
import { loadCommandHistory, saveCommandHistory, type CommandHistoryEntry } from "../../src/lib/commandHistory";

vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: vi.fn().mockResolvedValue(null),
}));
afterEach(() => { cleanup(); localStorage.clear(); });

it("deletes only the selected plugin's history when two plugins share a feature code", async () => {
  const entry = (plugin_id: string, label: string): CommandHistoryEntry => ({
    code: "shared", plugin_id, plugin_name: label, label, explain: "", icon: "", input: "",
    usedAt: "2026-10-15T00:00:00Z", useCount: 1,
  });
  saveCommandHistory([entry("plugin-a", "甲插件功能"), entry("plugin-b", "乙插件功能")]);
  render(SettingsPanel, { initialMenu: "data" });
  const target = await screen.findByText("乙插件功能", { selector: ".setting-label > span" });
  const row = target.closest(".data-row")!;
  await fireEvent.click(row.querySelector("button")!);
  expect(loadCommandHistory().map(item => [item.plugin_id, item.code])).toEqual([["plugin-a", "shared"]]);
  expect(screen.queryByText("乙插件功能", { selector: ".setting-label > span" })).toBeNull();
  expect(screen.getByText("甲插件功能", { selector: ".setting-label > span" })).toBeTruthy();
  expect(screen.getByText("已移除 1 条最近使用历史")).toBeTruthy();
});

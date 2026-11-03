import { cleanup, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, expect, it, vi } from "vitest";
import HomePanel from "../../src/components/HomePanel.svelte";
import type { RecommendedCommand } from "../../src/lib/uiState";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke }));
afterEach(cleanup);

function rect(top: number, bottom: number): DOMRect {
  return { top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

it("keeps selected commands in their own scroll region and leaves common navigation outside it", async () => {
  const commands: RecommendedCommand[] = Array.from({ length: 15 }, (_, index) => ({
    code: `history-${index}`,
    label: `最近 ${index}`,
    explain: "最近使用",
    source: "history",
  }));
  const props = {
    commands,
    oncommand: vi.fn(),
    onpanelchange: vi.fn(),
    selectedIndex: 0,
  };
  const view = render(HomePanel, props);
  const home = screen.getByRole("region", { name: "ATools 首页" });
  const panel = screen.getByRole("region", { name: "固定指令与最近使用" });
  const navigation = home.querySelector<HTMLElement>(".home-navigation");
  expect(home.contains(panel)).toBe(true);
  expect(navigation).toBeTruthy();
  expect(panel.contains(navigation)).toBe(false);
  const search = document.createElement("input");
  document.body.append(search);
  search.focus();

  Object.defineProperty(panel, "clientHeight", { configurable: true, value: 100 });
  Object.defineProperty(panel, "clientTop", { configurable: true, value: 0 });
  panel.getBoundingClientRect = () => rect(100, 200);
  const selected = panel.querySelector<HTMLElement>('[data-home-command-index="14"]');
  expect(selected).toBeTruthy();
  if (!selected) return;
  selected.getBoundingClientRect = () => rect(220, 278);

  home.scrollTop = 23;

  await view.rerender({ ...props, selectedIndex: 14 });
  await waitFor(() => expect(panel.scrollTop).toBe(78));
  expect(home.scrollTop).toBe(23);
  expect(document.activeElement).toBe(search);

  selected.getBoundingClientRect = () => rect(50, 108);
  const expandedCommands = [...commands, {
    code: "history-extra",
    label: "最近 extra",
    explain: "最近使用",
    source: "history" as const,
  }];
  await view.rerender({ ...props, commands: expandedCommands, selectedIndex: 14 });
  await waitFor(() => expect(panel.scrollTop).toBe(28));
  expect(home.scrollTop).toBe(23);
  expect(document.activeElement).toBe(search);

  const first = panel.querySelector<HTMLElement>('[data-home-command-index="0"]');
  expect(first).toBeTruthy();
  if (!first) return;
  first.getBoundingClientRect = () => rect(50, 108);
  await view.rerender({ ...props, commands: expandedCommands });
  await waitFor(() => expect(panel.scrollTop).toBe(0));
  expect(home.scrollTop).toBe(23);
  expect(document.activeElement).toBe(search);

  search.remove();
});

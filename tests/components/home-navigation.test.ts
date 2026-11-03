import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, expect, it, vi } from "vitest";
import HomeCapabilityRail from "../../src/components/HomeCapabilityRail.svelte";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
afterEach(cleanup);

it("opens common destinations directly and performs no startup catalog/history reads", async () => {
  const onpanelchange = vi.fn();
  const oncommand = vi.fn();
  render(HomeCapabilityRail, { onpanelchange, oncommand });
  expect(screen.getByRole("navigation", { name: "常用入口" })).toBeTruthy();
  for (const [name, panel] of [["结果中心", "results"], ["插件管理", "plugins"], ["Agent / MCP", "agent"]]) {
    await fireEvent.click(screen.getByRole("button", { name }));
    expect(onpanelchange).toHaveBeenLastCalledWith(panel);
  }
  await fireEvent.click(screen.getByRole("button", { name: "剪贴板" }));
  expect(oncommand).toHaveBeenCalledWith("Paste剪切板");
  expect(invoke).not.toHaveBeenCalled();
});

import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, expect, it } from "vitest";
import PluginInventoryViewTabs from "../../src/components/PluginInventoryViewTabs.svelte";

afterEach(() => cleanup());

it("defaults to installed plugins and changes the pressed view on activation", async () => {
  render(PluginInventoryViewTabs);
  const installed = screen.getByRole("button", { name: "全部插件" });
  const running = screen.getByRole("button", { name: "运行会话" });

  expect(installed.getAttribute("aria-pressed")).toBe("true");
  expect(running.getAttribute("aria-pressed")).toBe("false");
  await fireEvent.click(running);
  expect(installed.getAttribute("aria-pressed")).toBe("false");
  expect(running.getAttribute("aria-pressed")).toBe("true");
});

it("accepts the parent-controlled view value", async () => {
  const view = render(PluginInventoryViewTabs, { value: "running" });
  expect(screen.getByRole("button", { name: "运行会话" }).getAttribute("aria-pressed")).toBe("true");
  await view.rerender({ value: "installed" });
  expect(screen.getByRole("button", { name: "全部插件" }).getAttribute("aria-pressed")).toBe("true");
});

import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, expect, it } from "vitest";
import PluginOpenStatus from "../../src/components/PluginOpenStatus.svelte";

afterEach(cleanup);

it("keeps activation failure in the installed-plugin status area and exposes retry", () => {
  render(PluginOpenStatus, {
    message: "已安装 打开失败后可重试",
    openMessage: "插件未能打开，请检查插件状态后重试。",
    canOpen: true,
    busy: false,
  });

  expect(screen.getByText("插件未能打开，请检查插件状态后重试。")).toBeTruthy();
  expect(screen.getByText("插件未能打开，请检查插件状态后重试。").getAttribute("role")).toBe("status");
  expect(screen.getByRole("button", { name: "重试打开" }).hasAttribute("disabled")).toBe(false);
});

it("keeps the open button single-purpose and disabled while activation is pending", () => {
  render(PluginOpenStatus, {
    message: "已安装 打开失败后可重试",
    openMessage: "正在打开…",
    canOpen: true,
    busy: true,
  });

  const button = screen.getByRole("button", { name: "正在打开…" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.textContent?.trim()).toBe("正在打开…");
});

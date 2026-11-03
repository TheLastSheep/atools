import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import SearchStatusBar from "../../src/components/SearchStatusBar.svelte";
import { searchStatusBarView } from "../../src/lib/searchStatusBar";

afterEach(cleanup);
const input = { mode: "results" as const, count: 1200, selectedIndex: 16, selectedLabel: "分页命令 64", tabAction: "select" as const };

describe("status bar responsive information", () => {
  it("keeps primary keycaps and the complete result counter in the component markup", () => {
    render(SearchStatusBar, input);
    const keycaps = [...document.querySelectorAll(".status-hints .keycap")].map(key => key.textContent?.trim());
    expect(keycaps).toEqual(expect.arrayContaining(["Enter", "Tab", "Esc"]));
    expect(document.querySelector(".status-position")?.textContent).toBe("17 / 1200");
  });

  it("keeps a bounded position independent of the selected command's label", () => {
    const view = searchStatusBarView({ ...input, selectedLabel: "一个很长的本地工具指令名称".repeat(10) });
    expect(view.position).toBe("17 / 1200");
    expect(view.detail).toContain("一个很长的本地工具指令名称");
    render(SearchStatusBar, { ...input, selectedLabel: "一个很长的本地工具指令名称".repeat(10) });
    expect(document.querySelector(".status-position")?.textContent).toBe("17 / 1200");
    expect(document.querySelector(".status-copy")?.getAttribute("title")).toContain("一个很长的本地工具指令名称");
  });

  it.each(["home", "results"] as const)("shows the action-menu discovery hint only when available in %s", mode => {
    const available = searchStatusBarView({ ...input, mode, actionMenuAvailable: true });
    const unavailable = searchStatusBarView({ ...input, mode, actionMenuAvailable: false });
    expect(available.hints).toContainEqual({ key: "⇧F10", label: "更多操作 · 右键" });
    expect(unavailable.hints.some(hint => hint.key === "⇧F10")).toBe(false);
    render(SearchStatusBar, { ...input, mode, actionMenuAvailable: true });
    expect(screen.getByText("更多操作 · 右键")).toBeTruthy();
    const compact = document.querySelector(".action-menu-compact");
    expect(compact?.textContent).toBe("更多操作");
    expect(compact?.hasAttribute("aria-hidden")).toBe(false);
    cleanup();
  });

  it("preserves the pinned section's position instead of the combined home index", () => {
    const view = searchStatusBarView({ ...input, mode: "home", titleOverride: "固定", detailOverride: "2 / 4 · GitHub" });
    expect(view.position).toBe("2 / 4");
    expect(view.title).toBe("固定");
  });

  it.each(["home", "results"] as const)("renders an explicit empty %s state without inventing a selected row", mode => {
    const view = searchStatusBarView({ ...input, mode, count: 0 });
    expect(view.position).toBe(mode === "home" ? "0 项" : "0 项匹配");
    render(SearchStatusBar, { ...input, mode, count: 0 });
    expect(document.querySelector(".compact-navigation")).toBeNull();
    expect(document.querySelector(".status-position")?.textContent).toBe(view.position);
  });

  it("keeps the Tab hint passive and separates its settings action", async () => {
    const settings = vi.fn();
    const targetHint = "交给 很长的字符转换工具名称";
    render(SearchStatusBar, { ...input, tabAction: "target", tabTargetHint: targetHint, ontargetsettings: settings });
    const passiveHint = document.querySelector(".target-tab-hint");
    expect(passiveHint?.tagName).toBe("SPAN");
    expect(passiveHint?.getAttribute("role")).toBe("group");
    expect(passiveHint?.getAttribute("aria-label")).toBe(`Tab：${targetHint}`);
    expect(passiveHint?.getAttribute("title")).toBe(targetHint);
    expect(passiveHint?.querySelector(".keycap")?.textContent).toBe("Tab");
    expect(passiveHint?.querySelector(".full-tab-label")?.textContent).toBe(targetHint);
    expect(passiveHint?.querySelector(".compact-tab-label")?.textContent).toBe("目标");

    const button = screen.getByRole("button", { name: "设置 Tab 目标" });
    expect(button.textContent?.trim()).toBe("设置目标");
    expect(button.getAttribute("title")).toBe("打开 Tab 目标设置");
    expect(button.querySelector(".keycap")).toBeNull();
    expect(passiveHint?.contains(button)).toBe(false);
    expect(document.querySelector(".status-hints")?.classList.contains("has-target-settings")).toBe(true);
    await fireEvent.click(button);
    expect(settings).toHaveBeenCalledOnce();
  });

  it("does not infer a settings action from the target copy when no callback is supplied", () => {
    render(SearchStatusBar, { ...input, tabAction: "target", tabTargetHint: "设置目标" });
    expect(screen.queryByRole("button", { name: "设置 Tab 目标" })).toBeNull();
    expect(document.querySelector(".target-tab-hint")?.textContent).toContain("Tab");
    expect(document.querySelector(".status-hints")?.classList.contains("has-target-settings")).toBe(false);
  });

  it("only marks the shortcut group when the target settings button is actually rendered", () => {
    const settings = vi.fn();
    const { rerender } = render(SearchStatusBar, { ...input, tabAction: "select", ontargetsettings: settings });
    expect(document.querySelector(".status-hints")?.classList.contains("has-target-settings")).toBe(false);
    rerender({ ...input, tabAction: "target", ontargetsettings: settings });
    expect(screen.getByRole("button", { name: "设置 Tab 目标" })).toBeTruthy();
    expect(document.querySelector(".status-hints")?.classList.contains("has-target-settings")).toBe(true);
  });

  it("keeps feedback as the original live status instead of replacing it with a guessed summary", () => {
    const message = "Tab 目标已禁用、移除或来源已变化，请重新选择工具。";
    render(SearchStatusBar, { ...input, tabAction: "target", tabTargetFeedback: message, actionMenuAvailable: true });
    const status = screen.getByRole("status");
    expect(status.textContent).toBe(message);
    expect(status.getAttribute("title")).toBe(message);
    expect(document.querySelector(".status-position")).toBeNull();
    expect(document.querySelector(".status-copy")?.classList.contains("has-feedback")).toBe(true);
    expect(document.querySelector(".action-menu-hint .action-menu-label")?.textContent).toBe("更多操作 · 右键");
    expect(document.querySelector(".action-menu-hint .action-menu-compact")?.textContent).toBe("更多操作");
    expect(screen.queryByRole("button", { name: "设置 Tab 目标" })).toBeNull();
  });
});

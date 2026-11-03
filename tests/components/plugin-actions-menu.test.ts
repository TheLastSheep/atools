import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import PluginActionsMenu from "../../src/components/PluginActionsMenu.svelte";
import type { PluginHostAction } from "../../src/lib/pluginHostView";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const actions: PluginHostAction[] = [
  { id: "settings", label: "设置", available: true },
  { id: "detach", label: "分离", available: true },
];

function keydown(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

async function openMenu(props: { identity?: string; actions?: PluginHostAction[]; onaction?: (id: PluginHostAction["id"]) => void } = {}) {
  render(PluginActionsMenu, { identity: "plugin-one", actions, onaction: vi.fn(), ...props });
  const trigger = screen.getByRole("button", { name: "更多插件操作" });
  await fireEvent.click(trigger);
  const menu = await screen.findByRole("menu", { name: "插件操作" });
  return { trigger, menu };
}

describe("plugin actions menu", () => {
  it("portals the compact menu outside clipping containers and exposes its trigger state", async () => {
    const view = render(PluginActionsMenu, { identity: "plugin-one", actions, onaction: vi.fn() });
    const trigger = screen.getByRole("button", { name: "更多插件操作" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await fireEvent.click(trigger);
    const menu = await screen.findByRole("menu", { name: "插件操作" });
    expect(menu.parentElement).toBe(document.body);
    expect(view.container.contains(menu)).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("does not take over prevented or modified shortcuts and leaves Shift+Tab native", async () => {
    render(PluginActionsMenu, { identity: "plugin-one", actions, onaction: vi.fn() });
    const trigger = screen.getByRole("button", { name: "更多插件操作" });
    for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const) {
      keydown(trigger, "ArrowDown", { [modifier]: true });
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    }
    const alreadyHandled = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    alreadyHandled.preventDefault();
    trigger.dispatchEvent(alreadyHandled);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await fireEvent.click(trigger);
    const settings = screen.getByRole("menuitem", { name: "设置" });
    const shiftTab = keydown(settings, "Tab", { shiftKey: true });
    expect(shiftTab.defaultPrevented).toBe(false);
    expect(screen.getByRole("menu")).toBeTruthy();
    const handledEscape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    handledEscape.preventDefault();
    settings.dispatchEvent(handledEscape);
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("skips disabled items during initial focus and menu navigation", async () => {
    const onaction = vi.fn();
    const { menu } = await openMenu({ actions: [
      { id: "settings", label: "设置", available: false },
      { id: "detach", label: "分离", available: true },
    ], onaction });
    const settings = screen.getByRole("menuitem", { name: "设置" }) as HTMLButtonElement;
    const detach = screen.getByRole("menuitem", { name: "分离" }) as HTMLButtonElement;
    expect(settings.disabled).toBe(true);
    expect(detach.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(detach);
    await fireEvent.click(settings);
    expect(onaction).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBe(menu);

    await fireEvent.keyDown(detach, { key: "ArrowDown" });
    expect(document.activeElement).toBe(detach);
    await fireEvent.keyDown(detach, { key: "ArrowUp" });
    expect(document.activeElement).toBe(detach);
    expect(menu.contains(document.activeElement)).toBe(true);
  });

  it("wraps enabled items and supports Home and End", async () => {
    const { menu } = await openMenu();
    const settings = screen.getByRole("menuitem", { name: "设置" });
    const detach = screen.getByRole("menuitem", { name: "分离" });
    expect(document.activeElement).toBe(settings);
    await fireEvent.keyDown(settings, { key: "ArrowDown" });
    expect(document.activeElement).toBe(detach);
    await fireEvent.keyDown(detach, { key: "ArrowDown" });
    expect(document.activeElement).toBe(settings);
    await fireEvent.keyDown(settings, { key: "ArrowUp" });
    expect(document.activeElement).toBe(detach);
    await fireEvent.keyDown(detach, { key: "Home" });
    expect(document.activeElement).toBe(settings);
    await fireEvent.keyDown(settings, { key: "End" });
    expect(document.activeElement).toBe(detach);
    expect(menu.contains(document.activeElement)).toBe(true);
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const { trigger, menu } = await openMenu();
    const item = screen.getByRole("menuitem", { name: "设置" });
    expect(document.activeElement).toBe(item);
    await fireEvent.keyDown(item, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it.each([false, true])("returns focus before native Tab traversal (shift=%s) without trapping it", async shiftKey => {
    const { trigger, menu } = await openMenu();
    const item = screen.getByRole("menuitem", { name: "设置" });
    const globalShortcut = vi.fn();
    window.addEventListener("keydown", globalShortcut);
    try {
      const tab = keydown(item, "Tab", { shiftKey });
      expect(tab.defaultPrevented).toBe(false);
      expect(globalShortcut).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(trigger);
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(menu.isConnected).toBe(false);
    } finally {
      window.removeEventListener("keydown", globalShortcut);
    }
  });

  it("dismisses an outside pointer without reclaiming focus", async () => {
    const { trigger } = await openMenu();
    const outside = document.createElement("button");
    outside.textContent = "其他操作";
    document.body.append(outside);
    try {
      await fireEvent.pointerDown(outside);
      outside.focus();
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(document.activeElement).toBe(outside);
      expect(document.activeElement).not.toBe(trigger);
    } finally {
      outside.remove();
    }
  });

  it("closes on window blur without returning focus to the trigger", async () => {
    const { trigger } = await openMenu();
    window.dispatchEvent(new FocusEvent("blur"));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).not.toBe(trigger);
  });

  it("removes open listeners and dismisses the menu when caller identity changes", async () => {
    const view = render(PluginActionsMenu, { identity: "plugin-one", actions, onaction: vi.fn() });
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    const trigger = screen.getByRole("button", { name: "更多插件操作" });
    await fireEvent.click(trigger);
    await screen.findByRole("menu");
    const pointerListener = add.mock.calls.find(([type]) => type === "pointerdown")?.[1];
    expect(pointerListener).toBeTypeOf("function");

    await view.rerender({ identity: "plugin-two" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(remove).toHaveBeenCalledWith("pointerdown", pointerListener, true);
    await fireEvent.click(trigger);
    await screen.findByRole("menu");
    const nextPointerListener = add.mock.calls.filter(([type]) => type === "pointerdown").at(-1)?.[1];
    await view.rerender({ actions: [] });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(remove).toHaveBeenCalledWith("pointerdown", nextPointerListener, true);
    await view.rerender({ actions });
    const reopenedTrigger = screen.getByRole("button", { name: "更多插件操作" });
    await fireEvent.click(reopenedTrigger);
    await screen.findByRole("menu");
    const finalPointerListener = add.mock.calls.filter(([type]) => type === "pointerdown").at(-1)?.[1];
    view.unmount();
    expect(remove).toHaveBeenCalledWith("pointerdown", finalPointerListener, true);
    add.mockRestore();
    remove.mockRestore();
  });

  it.each(["Enter", " "])("activates %s through the native menuitem button click", async key => {
    let trigger: HTMLElement | null = null;
    const onaction = vi.fn(() => {
      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
    trigger = (await openMenu({ onaction })).trigger;
    const settings = screen.getByRole("menuitem", { name: "设置" }) as HTMLButtonElement;
    settings.focus();
    const keydown = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    settings.dispatchEvent(keydown);
    expect(keydown.defaultPrevented).toBe(false);
    await fireEvent.click(settings);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onaction).toHaveBeenCalledOnce();
    expect(onaction).toHaveBeenCalledWith("settings");
  });

  it("does not invoke a queued action after unmount and removes the portal", async () => {
    const onaction = vi.fn();
    const view = render(PluginActionsMenu, { identity: "plugin-one", actions, onaction });
    await fireEvent.click(screen.getByRole("button", { name: "更多插件操作" }));
    const settings = await screen.findByRole("menuitem", { name: "设置" });

    settings.click();
    view.unmount();
    expect(screen.queryByRole("menu")).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(onaction).not.toHaveBeenCalled();
  });
});

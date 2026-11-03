import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, expect, it, vi } from "vitest";
import SettingsHeader from "../../src/components/SettingsHeader.svelte";

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const onclose = vi.fn();

function setClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

async function openMoreMenu() {
  await fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  expect(screen.getByRole("menu", { name: "设置更多操作" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "更多操作" }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("menuitem", { name: "回到主搜索" })).toBe(document.activeElement);
}

afterEach(() => {
  cleanup();
  onclose.mockReset();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

it("exposes one settings title and a reachable return-to-search action", async () => {
  render(SettingsHeader, { props: { onclose } });

  expect(screen.getAllByRole("heading", { name: "设置" })).toHaveLength(1);
  await fireEvent.click(screen.getByRole("button", { name: "回到主搜索" }));
  expect(onclose).toHaveBeenCalledOnce();
});

it("copies runtime information and announces success", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  setClipboard(writeText);
  render(SettingsHeader, { props: { onclose } });
  await openMoreMenu();

  await fireEvent.click(screen.getByRole("menuitem", { name: "复制运行信息" }));
  expect(writeText).toHaveBeenCalledOnce();
  expect(writeText.mock.calls[0][0]).toContain("ATools 3.0");
  expect(await screen.findByText("已复制运行信息")).toBeTruthy();
});

it("announces clipboard failures", async () => {
  const writeText = vi.fn().mockRejectedValue(new Error("clipboard denied"));
  setClipboard(writeText);
  render(SettingsHeader, { props: { onclose } });
  await openMoreMenu();

  await fireEvent.click(screen.getByRole("menuitem", { name: "复制运行信息" }));
  expect(await screen.findByText("复制失败")).toBeTruthy();
  expect(onclose).not.toHaveBeenCalled();
});

it("closes the more menu on Escape without closing settings", async () => {
  render(SettingsHeader, { props: { onclose } });
  await openMoreMenu();

  await fireEvent.keyDown(screen.getByRole("menuitem", { name: "复制运行信息" }), { key: "Escape" });
  expect(screen.queryByRole("menu", { name: "设置更多操作" })).toBeNull();
  expect(screen.getByRole("button", { name: "更多操作" }).getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByRole("button", { name: "更多操作" })).toBe(document.activeElement);
  expect(onclose).not.toHaveBeenCalled();
});

it("toggles the menu from the native trigger and keeps aria-expanded current", async () => {
  render(SettingsHeader, { props: { onclose } });
  const trigger = screen.getByRole("button", { name: "更多操作" });
  await openMoreMenu();

  await fireEvent.click(trigger);
  expect(screen.queryByRole("menu", { name: "设置更多操作" })).toBeNull();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(onclose).not.toHaveBeenCalled();
});

it("moves menu focus with arrows and Home/End, wrapping at both ends", async () => {
  render(SettingsHeader, { props: { onclose } });
  await openMoreMenu();
  const first = screen.getByRole("menuitem", { name: "回到主搜索" });
  const last = screen.getByRole("menuitem", { name: "复制运行信息" });

  await fireEvent.keyDown(first, { key: "ArrowUp" });
  expect(last).toBe(document.activeElement);
  await fireEvent.keyDown(last, { key: "ArrowDown" });
  expect(first).toBe(document.activeElement);
  await fireEvent.keyDown(first, { key: "End" });
  expect(last).toBe(document.activeElement);
  await fireEvent.keyDown(last, { key: "Home" });
  expect(first).toBe(document.activeElement);
});

it.each([{ shiftKey: false }, { shiftKey: true }])(
  "closes on Tab and leaves native traversal unblocked (shift=%s)",
  async ({ shiftKey }) => {
    render(SettingsHeader, { props: { onclose } });
    await openMoreMenu();
    const item = screen.getByRole("menuitem", { name: shiftKey ? "回到主搜索" : "复制运行信息" });
    item.focus();
    const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });

    item.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.getByRole("button", { name: "更多操作" })).toBe(document.activeElement);
    await waitFor(() => expect(screen.queryByRole("menu", { name: "设置更多操作" })).toBeNull());
    expect(onclose).not.toHaveBeenCalled();
  },
);

it("closes on an outside click without stealing its focus", async () => {
  render(SettingsHeader, { props: { onclose } });
  await openMoreMenu();
  const outside = document.createElement("button");
  outside.textContent = "外部目标";
  document.body.append(outside);
  outside.focus();

  await fireEvent.click(outside);
  expect(screen.queryByRole("menu", { name: "设置更多操作" })).toBeNull();
  expect(outside).toBe(document.activeElement);
  outside.remove();
});

it("does not let a late copy result repopulate a reopened menu", async () => {
  let resolveWrite: () => void = () => {};
  const writeText = vi.fn(() => new Promise<void>(resolve => { resolveWrite = resolve; }));
  setClipboard(writeText);
  render(SettingsHeader, { props: { onclose } });
  await openMoreMenu();
  await fireEvent.click(screen.getByRole("menuitem", { name: "复制运行信息" }));
  await fireEvent.keyDown(screen.getByRole("menuitem", { name: "复制运行信息" }), { key: "Escape" });
  await openMoreMenu();

  resolveWrite();
  await Promise.resolve();
  expect(screen.queryByText("已复制运行信息")).toBeNull();
  expect(screen.getByRole("menu")).toBeTruthy();
});

it("ignores composing activation and menu navigation keys", async () => {
  render(SettingsHeader, { props: { onclose } });
  const trigger = screen.getByRole("button", { name: "更多操作" });
  const composingKeydown = new KeyboardEvent("keydown", {
    key: "Enter", isComposing: true, bubbles: true, cancelable: true,
  });
  const composingKeyup = new KeyboardEvent("keyup", {
    key: "Enter", isComposing: true, bubbles: true, cancelable: true,
  });
  trigger.dispatchEvent(composingKeydown);
  trigger.dispatchEvent(composingKeyup);
  expect(composingKeydown.defaultPrevented).toBe(true);
  expect(composingKeyup.defaultPrevented).toBe(true);
  expect(screen.queryByRole("menu", { name: "设置更多操作" })).toBeNull();

  await openMoreMenu();
  const first = screen.getByRole("menuitem", { name: "回到主搜索" });
  await fireEvent.keyDown(first, { key: "ArrowDown", isComposing: true, keyCode: 229 });
  expect(first).toBe(document.activeElement);
  expect(screen.getByRole("menu")).toBeTruthy();
});

it.each(["Enter", " "])("prevents composing %s from activating a menu action", async (key) => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  setClipboard(writeText);
  render(SettingsHeader, { props: { onclose } });
  await openMoreMenu();
  const copy = screen.getByRole("menuitem", { name: "复制运行信息" });
  copy.focus();
  const event = new KeyboardEvent("keydown", {
    key,
    isComposing: true,
    bubbles: true,
    cancelable: true,
  });

  copy.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(writeText).not.toHaveBeenCalled();
  expect(screen.getByRole("menu")).toBeTruthy();
  expect(onclose).not.toHaveBeenCalled();
});

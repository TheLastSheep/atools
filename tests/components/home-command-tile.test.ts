import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, expect, it, vi } from "vitest";
import HomeCommandTile from "../../src/components/HomeCommandTile.svelte";
import type { RecommendedCommand } from "../../src/lib/uiState";

afterEach(cleanup);

function command(overrides: Partial<RecommendedCommand> = {}): RecommendedCommand {
  return {
    code: "address-parser",
    plugin_id: "address-parser",
    label: "收货地址智能解析",
    explain: "收货地址智能解析",
    icon: null,
    source: "history",
    ...overrides,
  };
}

function createEvents() {
  return {
    activate: vi.fn(),
    keydown: vi.fn(),
    focus: vi.fn(),
    blur: vi.fn(),
    pointerEnter: vi.fn(),
    pointerLeave: vi.fn(),
    removePointerEnter: vi.fn(),
    removeFocus: vi.fn(),
    contextMenu: vi.fn(),
    remove: vi.fn(),
  };
}

type TileTestProps = {
  command: RecommendedCommand;
  commandIndex: number;
  selected: boolean;
  pinned: boolean;
  hintId: string;
  hintActive: boolean;
  events: Omit<ReturnType<typeof createEvents>, "remove"> & {
    remove?: ReturnType<typeof createEvents>["remove"];
  };
};

function renderTile(overrides: Partial<TileTestProps> = {}) {
  const handlers = createEvents();
  render(HomeCommandTile, {
    props: {
      command: command(),
      commandIndex: 3,
      selected: false,
      pinned: false,
      hintId: "home-hint-3",
      hintActive: false,
      events: handlers,
      ...overrides,
    },
  });
  return handlers;
}

it("keeps the existing tile identity, selected tab stop, hint relationship, and command icon", () => {
  renderTile({ selected: true, pinned: true, hintActive: true, command: command({ icon: "https://example.test/address.svg" }) });
  const shell = document.querySelector<HTMLElement>('[data-home-command-index="3"]');
  const button = screen.getByRole("button", { name: "收货地址智能解析" });

  expect(shell?.classList.contains("pinned-item")).toBe(true);
  expect(shell?.classList.contains("selected")).toBe(true);
  expect(button.tabIndex).toBe(0);
  expect(button.getAttribute("aria-describedby")).toBe("home-hint-3");
  expect(button.getAttribute("aria-haspopup")).toBe("menu");
  expect(button.querySelector(".recent-label")?.textContent).toBe("收货地址智能解析");
  expect(button.querySelector(".recent-icon img")?.getAttribute("src")).toBe("https://example.test/address.svg");
});

it("passes card pointer, focus, keyboard, menu, activation, and remove events to the host", async () => {
  const handlers = renderTile();
  const button = screen.getByRole("button", { name: "收货地址智能解析" });
  const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  button.dispatchEvent(press);
  expect(press.defaultPrevented).toBe(true);

  await fireEvent.mouseEnter(button);
  await fireEvent.focus(button);
  await fireEvent.keyDown(button, { key: "ArrowRight" });
  await fireEvent.contextMenu(button);
  await fireEvent.click(button);
  await fireEvent.blur(button);
  await fireEvent.mouseLeave(button);

  expect(handlers.pointerEnter).toHaveBeenCalledOnce();
  expect(handlers.pointerEnter).toHaveBeenCalledWith(command(), 3, button);
  expect(handlers.focus).toHaveBeenCalledWith(command(), 3, button);
  expect(handlers.keydown).toHaveBeenCalledWith(expect.objectContaining({ key: "ArrowRight" }), 3, command());
  expect(handlers.contextMenu).toHaveBeenCalledWith(expect.anything(), command());
  expect(handlers.activate).toHaveBeenCalledOnce();
  expect(handlers.blur).toHaveBeenCalledWith(button);
  expect(handlers.pointerLeave).toHaveBeenCalledWith(button);

  const remove = screen.getByRole("button", { name: "移除 收货地址智能解析" });
  expect(remove.tabIndex).toBe(-1);
  expect(remove.title).toBe("从最近使用移除");
  await fireEvent.mouseEnter(remove);
  await fireEvent.focus(remove);
  await fireEvent.click(remove);
  expect(handlers.removePointerEnter).toHaveBeenCalledWith(3);
  expect(handlers.removeFocus).toHaveBeenCalledWith(3);
  expect(handlers.remove).toHaveBeenCalledOnce();
  expect(handlers.remove).toHaveBeenCalledWith(expect.anything(), command(), 3);
  expect(handlers.activate).toHaveBeenCalledOnce();
});

it("uses the existing semantic fallback icon and omits remove for non-history commands", () => {
  renderTile({ command: command({ source: "recommended", code: "system:settings" }), events: { ...createEvents(), remove: undefined } });
  const button = screen.getByRole("button", { name: "收货地址智能解析" });
  expect(button.querySelector(".recent-icon .tone-settings")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "移除 收货地址智能解析" })).toBeNull();
  expect(button.hasAttribute("aria-describedby")).toBe(false);
});

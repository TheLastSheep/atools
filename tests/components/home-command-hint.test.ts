import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import HomePanel from "../../src/components/HomePanel.svelte";
import HomePanelCommandRefreshFixture from "./HomePanelCommandRefreshFixture.svelte";
import { boundedHomeCommandHintText } from "../../src/lib/homeCommandHintText";
import type { RecommendedCommand } from "../../src/lib/uiState";

vi.mock("../../src/lib/launcherCommandActions", () => ({ isLauncherMenuShortcut: () => false }));
afterEach(cleanup);

function command(overrides: Partial<RecommendedCommand> = {}): RecommendedCommand {
  return { code: "translate", plugin_id: "text-tools", label: "翻译", explain: "将选中文本转换为英文", source: "history", ...overrides };
}

function props(commands: RecommendedCommand[], overrides: {
  onactivate?: (command: RecommendedCommand) => void;
  oncommandmenu?: (event: MouseEvent | KeyboardEvent, command: RecommendedCommand) => void;
  onselectionchange?: (index: number, returnFocusToSearch?: boolean) => void;
} = {}) {
  return { commands, oncommand: vi.fn(), onpanelchange: vi.fn(), selectedIndex: 0, ...overrides };
}

it("exposes the current purpose for pointer and keyboard focus without replacing the command label", async () => {
  const view = render(HomePanel, props([command()]));
  const card = screen.getByRole("button", { name: "翻译" });

  await fireEvent.mouseEnter(card);
  let hint = screen.getByRole("tooltip");
  expect(hint.textContent).toBe("将选中文本转换为英文");
  expect(hint.parentElement).toBe(document.body);
  expect(card.getAttribute("aria-describedby")).toBe(hint.id);
  expect(card.querySelector(".recent-label")?.textContent).toBe("翻译");
  expect(card.title).toBe("");

  await fireEvent.mouseLeave(card);
  expect(screen.queryByRole("tooltip")).toBeNull();
  card.focus();
  await tick();
  hint = screen.getByRole("tooltip");
  expect(card.getAttribute("aria-describedby")).toBe(hint.id);
  expect(hint.textContent).toContain("转换为英文");
  await view.unmount();
  expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
});

it("closes on bare Escape but keeps the hint through IME composition", async () => {
  const activate = vi.fn();
  render(HomePanel, props([command()], { onactivate: activate }));
  const card = screen.getByRole("button", { name: "翻译" });
  card.focus();
  await tick();
  expect(screen.getByRole("tooltip")).toBeTruthy();

  const composingEscape = new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true });
  card.dispatchEvent(composingEscape);
  await tick();
  expect(screen.getByRole("tooltip")).toBeTruthy();
  const webkitComposingEscape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  Object.defineProperty(webkitComposingEscape, "keyCode", { value: 229 });
  card.dispatchEvent(webkitComposingEscape);
  await tick();
  expect(screen.getByRole("tooltip")).toBeTruthy();
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  card.dispatchEvent(escape);
  await tick();
  expect(escape.defaultPrevented).toBe(true);
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(activate).not.toHaveBeenCalled();
});

it("dismisses on focus loss and on a changed search input", async () => {
  const view = render(HomePanel, props([command()]));
  const card = screen.getByRole("button", { name: "翻译" });
  card.focus();
  await tick();
  expect(screen.getByRole("tooltip")).toBeTruthy();
  const other = document.createElement("button");
  document.body.append(other);
  other.focus();
  await tick();
  expect(screen.queryByRole("tooltip")).toBeNull();

  await fireEvent.mouseEnter(card);
  expect(screen.getByRole("tooltip")).toBeTruthy();
  const search = document.createElement("input");
  document.body.append(search);
  await fireEvent.input(search, { target: { value: "q" } });
  expect(screen.queryByRole("tooltip")).toBeNull();
  other.remove();
  search.remove();
  await view.unmount();
});

it("dismisses before activation and before opening the command menu without changing either callback", async () => {
  const item = command();
  const activate = vi.fn();
  const menu = vi.fn();
  const view = render(HomePanel, props([item], { onactivate: activate, oncommandmenu: menu }));
  const card = screen.getByRole("button", { name: "翻译" });

  card.focus();
  await tick();
  await fireEvent.click(card);
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(activate).toHaveBeenCalledOnce();
  expect(activate).toHaveBeenCalledWith(item);

  const focusReturn = document.createElement("input");
  document.body.append(focusReturn);
  focusReturn.focus();
  await tick();
  card.focus();
  await tick();
  expect(screen.getByRole("tooltip")).toBeTruthy();
  await fireEvent.contextMenu(card);
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(menu).toHaveBeenCalledOnce();
  expect(menu).toHaveBeenCalledWith(expect.anything(), item);
  focusReturn.remove();
  await view.unmount();
});

it("does not show empty purpose text and removes a hint when its command owner disappears", async () => {
  const item = command();
  const view = render(HomePanel, props([item]));
  const card = screen.getByRole("button", { name: "翻译" });
  card.focus();
  await tick();
  expect(screen.getByRole("tooltip")).toBeTruthy();

  await view.rerender(props([command({ code: "translate", plugin_id: "text-tools", explain: "" })]));
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(screen.getByRole("button", { name: "翻译" }).hasAttribute("aria-describedby")).toBe(false);

  const noPurpose = screen.getByRole("button", { name: "翻译" });
  const focusReturn = document.createElement("input");
  document.body.append(focusReturn);
  focusReturn.focus();
  await tick();
  noPurpose.focus();
  await tick();
  expect(screen.queryByRole("tooltip")).toBeNull();
  await view.rerender(props([command()]));
  focusReturn.focus();
  await tick();
  screen.getByRole("button", { name: "翻译" }).focus();
  await tick();
  expect(screen.getByRole("tooltip")).toBeTruthy();
  await view.rerender(props([command({ plugin_id: "another-plugin", explain: "另一个插件的翻译命令" })]));
  expect(screen.queryByRole("tooltip")).toBeNull();
  await view.rerender(props([]));
  expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
  focusReturn.remove();
});

it("bounds third-party explanations to 256 Unicode code points before trimming", () => {
  const symbol = "🧪";
  const long = `${symbol.repeat(100_000)}<img src=x onerror=alert(1)>`;
  const bounded = boundedHomeCommandHintText(long);
  expect(Array.from(bounded)).toHaveLength(256);
  expect(bounded).toBe(`${symbol.repeat(255)}…`);
  expect(boundedHomeCommandHintText(symbol.repeat(256))).toBe(symbol.repeat(256));
  expect(boundedHomeCommandHintText(`  ${symbol}  `)).toBe(symbol);
});

it("uses the bounded explanation in the live HomePanel hint", async () => {
  const long = `${"🧪".repeat(100_000)}<img src=x onerror=alert(1)>`;
  const view = render(HomePanel, props([command({ explain: long })]));
  await fireEvent.mouseEnter(screen.getByRole("button", { name: "翻译" }));
  const hint = screen.getByRole("tooltip");
  expect(Array.from(hint.textContent ?? "")).toHaveLength(256);
  expect(hint.textContent).toBe(`${"🧪".repeat(255)}…`);
  expect(hint.querySelector("img")).toBeNull();
  await view.unmount();
});

it("renders markup-like explanation text as inert text", async () => {
  const unsafe = '<img src="x" onerror="alert(1)">';
  const view = render(HomePanel, props([command({ explain: unsafe })]));
  await fireEvent.mouseEnter(screen.getByRole("button", { name: "翻译" }));
  const hint = screen.getByRole("tooltip");
  expect(hint.textContent).toBe(unsafe);
  expect(hint.querySelector("img")).toBeNull();
  await view.unmount();
});

it("lets pointer-only Escape reach the launcher while dismissing the hint", async () => {
  const view = render(HomePanel, props([command()]));
  const card = screen.getByRole("button", { name: "翻译" });
  const search = document.createElement("input");
  document.body.append(search);
  search.focus();
  await tick();
  await fireEvent.mouseEnter(card);
  expect(screen.getByRole("tooltip")).toBeTruthy();

  const bubbledEscape = vi.fn();
  window.addEventListener("keydown", bubbledEscape, { once: true });
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  search.dispatchEvent(escape);
  await tick();
  expect(escape.defaultPrevented).toBe(false);
  expect(bubbledEscape).toHaveBeenCalledOnce();
  expect(screen.queryByRole("tooltip")).toBeNull();
  search.remove();
  await view.unmount();
});

it("drops a hint when an unkeyed command reorder moves another owner onto its anchor", async () => {
  const first = command({ code: "alpha", label: "Alpha", explain: "Alpha purpose" });
  const second = command({ code: "beta", label: "Beta", explain: "Beta purpose" });
  const view = render(HomePanel, props([first, second]));
  const alpha = screen.getByRole("button", { name: "Alpha" });
  await fireEvent.mouseEnter(alpha);
  expect(screen.getByRole("tooltip").textContent).toBe("Alpha purpose");

  await view.rerender(props([second, first]));
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(screen.getByRole("button", { name: "Alpha" }).hasAttribute("aria-describedby")).toBe(false);
  expect(screen.getByRole("button", { name: "Beta" }).hasAttribute("aria-describedby")).toBe(false);
});

it("keeps large input payloads intact when distinguishing duplicate command codes", async () => {
  const largeInput = "q".repeat(1_000_000);
  const first = command({ code: "duplicate", label: "Same command", input: largeInput, explain: "Same purpose" });
  const second = command({ code: "duplicate", label: "Same command", input: "different input", explain: "Same purpose" });
  const view = render(HomePanel, props([first, second]));
  const card = screen.getAllByRole("button", { name: "Same command" })[0];
  await fireEvent.mouseEnter(card);
  expect(screen.getByRole("tooltip").textContent).toBe("Same purpose");

  await view.rerender(props([second, first]));
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(screen.getAllByRole("button", { name: "Same command" })[0].hasAttribute("aria-describedby")).toBe(false);
});

it("uses the pointer event's owner and index while the parent rebuilds commands", async () => {
  const view = render(HomePanelCommandRefreshFixture);
  const beta = screen.getByRole("button", { name: "Beta" });

  await fireEvent.mouseEnter(beta);
  expect(screen.getByTestId("command-refresh-count").textContent).toBe("1");
  expect(screen.getByRole("tooltip").textContent).toBe("Beta purpose");
  expect(beta.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);
  await view.unmount();
});

it("uses the focus event's owner and index while the parent rebuilds commands", async () => {
  const view = render(HomePanelCommandRefreshFixture);
  const beta = screen.getByRole("button", { name: "Beta" });

  beta.focus();
  await tick();
  expect(screen.getByTestId("command-refresh-count").textContent).toBe("1");
  expect(screen.getByRole("tooltip").textContent).toBe("Beta purpose");
  expect(beta.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);
  await view.unmount();
});

it("keeps hover and focus hints tied to the current command across activation", async () => {
  const alpha = command({ code: "alpha", label: "Alpha", explain: "Alpha purpose" });
  const beta = command({ code: "beta", label: "Beta", explain: "Beta purpose" });
  const activate = vi.fn();
  const view = render(HomePanel, props([alpha, beta], { onactivate: activate }));
  const alphaButton = screen.getByRole("button", { name: "Alpha" });
  const betaButton = screen.getByRole("button", { name: "Beta" });

  await fireEvent.mouseEnter(alphaButton);
  expect(screen.getByRole("tooltip").textContent).toBe("Alpha purpose");
  betaButton.focus();
  await tick();
  expect(screen.getByRole("tooltip").textContent).toBe("Beta purpose");
  expect(alphaButton.hasAttribute("aria-describedby")).toBe(false);
  expect(betaButton.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);

  await fireEvent.click(betaButton);
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(activate).toHaveBeenCalledWith(beta);
  await fireEvent.mouseEnter(alphaButton);
  expect(screen.getByRole("tooltip").textContent).toBe("Alpha purpose");
  expect(alphaButton.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);
  expect(betaButton.hasAttribute("aria-describedby")).toBe(false);
  await view.unmount();
});

it("tracks one command through production-style pointer return-to-search and refocus", async () => {
  const item = command({ code: "alpha", label: "Alpha", explain: "Alpha purpose" });
  const search = document.createElement("input");
  document.body.append(search);
  const onselectionchange = vi.fn((_index: number, returnFocusToSearch?: boolean) => {
    if (returnFocusToSearch !== false) search.focus();
  });
  const view = render(HomePanel, props([item], { onselectionchange }));
  const card = screen.getByRole("button", { name: "Alpha" });

  card.focus();
  await tick();
  expect(screen.getByRole("tooltip").textContent).toBe("Alpha purpose");

  await fireEvent.mouseEnter(card);
  await tick();
  expect(document.activeElement).toBe(search);
  expect(screen.getByRole("tooltip").textContent).toBe("Alpha purpose");
  expect(card.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);

  card.focus();
  await tick();
  expect(document.activeElement).toBe(card);
  expect(screen.getByRole("tooltip").textContent).toBe("Alpha purpose");
  expect(card.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);
  expect(onselectionchange).toHaveBeenCalledWith(0);

  await view.unmount();
  search.remove();
});

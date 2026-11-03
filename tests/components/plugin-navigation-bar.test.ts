import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import PluginNavigationBar from "../../src/components/PluginNavigationBar.svelte";
import PluginNavigationHarness from "./PluginNavigationHarness.svelte";

afterEach(cleanup);
const key = (input: HTMLElement, name: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
  input.dispatchEvent(event);
  return event;
};

describe("plugin navigation bar", () => {
  it("shows one explicitly requested search input, title, feature and real chrome action states", async () => {
    const onreturn = vi.fn(); const onaction = vi.fn();
    const view = render(PluginNavigationBar, {
      title: "字符转换", feature: "transform", source: "char-transform", onreturn, onaction,
      actions: [{ id: "settings", label: "设置", available: false }, { id: "detach", label: "分离", available: true }],
    });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(view.container.querySelector(".plugin-title")?.textContent).toBe("字符转换");
    expect(screen.getByText("transform")).toBeTruthy();
    expect(screen.getByText("char-transform")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "返回搜索" }));
    expect(onreturn).toHaveBeenCalledOnce();
    await fireEvent.click(screen.getByRole("button", { name: "更多插件操作" }));
    const settings = screen.getByRole("menuitem", { name: "设置" }) as HTMLButtonElement;
    expect(settings.disabled).toBe(true);
    expect(settings.title).toBe("设置未接入");
    await fireEvent.click(screen.getByRole("menuitem", { name: "分离" }));
    await waitFor(() => expect(onaction).toHaveBeenCalledWith("detach"));
    await view.rerender({ inputVisible: true });
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect((screen.getByRole("textbox", { name: "插件搜索" }) as HTMLInputElement).placeholder).toBe("输入关键词");
  });

  it("submits the final composition once and never navigates or exits while selecting candidates", async () => {
    const oninput = vi.fn(); const onreturn = vi.fn(); const onescape = vi.fn();
    const onmove = vi.fn(() => true); const onactivate = vi.fn(() => true);
    render(PluginNavigationBar, { title: "插件", inputVisible: true, oninput, onreturn, onescape, onmove, onactivate });
    const input = screen.getByRole("textbox") as HTMLInputElement;
    await fireEvent.compositionStart(input);
    await fireEvent.input(input, { target: { value: "fan" }, isComposing: true });
    expect(input.dataset.atoolsComposing).toBe("true");
    for (const name of ["Backspace", "Escape", "ArrowUp", "ArrowDown", "Enter"]) expect(key(input, name).defaultPrevented).toBe(false);
    expect(oninput).not.toHaveBeenCalled(); expect(onreturn).not.toHaveBeenCalled(); expect(onescape).not.toHaveBeenCalled();
    expect(onmove).not.toHaveBeenCalled(); expect(onactivate).not.toHaveBeenCalled();
    await fireEvent.input(input, { target: { value: "翻译" }, isComposing: true });
    await fireEvent.compositionEnd(input, { data: "翻译" });
    await fireEvent.input(input, { target: { value: "翻译" }, isComposing: false });
    expect(oninput.mock.calls).toEqual([["翻译"]]);
    expect(input.value).toBe("翻译");
    expect(input.dataset.atoolsComposing).toBeUndefined();
    await fireEvent.input(input, { target: { value: "翻译文本" } });
    expect(oninput.mock.calls).toEqual([["翻译"], ["翻译文本"]]);
  });

  it("ignores event-level IME markers even when compositionstart was not observed", async () => {
    const oninput = vi.fn(); const onreturn = vi.fn(); const onactivate = vi.fn(() => true);
    render(PluginNavigationBar, { title: "插件", inputVisible: true, oninput, onreturn, onactivate });
    const input = screen.getByRole("textbox");
    await fireEvent.input(input, { target: { value: "候选" }, isComposing: true });
    expect(oninput).not.toHaveBeenCalled();
    expect(key(input, "Enter", { isComposing: true }).defaultPrevented).toBe(false);
    const webkit = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    Object.defineProperty(webkit, "keyCode", { value: 229 }); input.dispatchEvent(webkit);
    expect(webkit.defaultPrevented).toBe(false); expect(onactivate).not.toHaveBeenCalled();
  });

  it("clears nonempty Escape once, then delegates empty Escape without directly returning", async () => {
    const oninput = vi.fn(); const onreturn = vi.fn(); const onescape = vi.fn();
    render(PluginNavigationBar, { title: "插件", inputVisible: true, value: "筛选", oninput, onreturn, onescape });
    const input = screen.getByRole("textbox") as HTMLInputElement;
    input.focus();
    expect(key(input, "Escape").defaultPrevented).toBe(true);
    await fireEvent.keyUp(input, { key: "Escape" });
    expect(input.value).toBe(""); expect(oninput.mock.calls).toEqual([[""]]);
    expect(onescape).not.toHaveBeenCalled(); expect(onreturn).not.toHaveBeenCalled();
    expect(key(input, "Escape").defaultPrevented).toBe(true);
    expect(onescape).toHaveBeenCalledOnce(); expect(onreturn).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("clears with the pointer once and returns focus to the same plugin input", async () => {
    const oninput = vi.fn();
    render(PluginNavigationBar, {
      title: "插件", inputVisible: true, value: "筛选内容", controlsId: "plugin-results",
      activeDescendantId: "plugin-result-current", oninput, onreturn: vi.fn(),
    });
    const input = screen.getByRole("combobox", { name: "插件搜索" }) as HTMLInputElement;
    const clear = screen.getByRole("button", { name: "清除插件搜索" });
    expect(input.getAttribute("aria-controls")).toBe("plugin-results");
    expect(input.getAttribute("aria-activedescendant")).toBe("plugin-result-current");
    clear.focus();
    await fireEvent.click(clear);
    expect(oninput.mock.calls).toEqual([[""]]);
    expect(input.value).toBe("");
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-controls")).toBe("plugin-results");
    expect(input.getAttribute("aria-activedescendant")).toBe("plugin-result-current");
    expect(screen.queryByRole("button", { name: "清除插件搜索" })).toBeNull();
  });

  it("does not reclaim focus when the clear callback removes the input", async () => {
    let hideInput = () => {};
    const oninput = vi.fn((text: string) => {
      if (text === "") hideInput();
    });
    const view = render(PluginNavigationBar, {
      title: "插件", inputVisible: true, value: "筛选内容", oninput, onreturn: vi.fn(),
    });
    hideInput = () => { void view.rerender({ inputVisible: false, value: "" }); };
    const input = screen.getByRole("textbox", { name: "插件搜索" });
    const clear = screen.getByRole("button", { name: "清除插件搜索" });
    clear.focus();

    await fireEvent.click(clear);

    expect(oninput.mock.calls).toEqual([[""]]);
    await waitFor(() => expect(input.isConnected).toBe(false));
    expect(document.activeElement).toBe(document.body);
  });

  it("uses native keyboard button activation once and hides/guards clear throughout IME composition", async () => {
    const oninput = vi.fn();
    const view = render(PluginNavigationBar, { title: "插件", inputVisible: true, value: "筛选内容", oninput, onreturn: vi.fn() });
    const input = screen.getByRole("textbox", { name: "插件搜索" }) as HTMLInputElement;
    const clear = screen.getByRole("button", { name: "清除插件搜索" });
    clear.focus();
    await fireEvent.keyDown(clear, { key: "Enter" });
    await fireEvent.keyUp(clear, { key: "Enter" });
    await fireEvent.click(clear);
    expect(oninput.mock.calls).toEqual([[""]]);
    await waitFor(() => expect(document.activeElement).toBe(input));

    await view.rerender({ value: "再次筛选" });
    const currentInput = screen.getByRole("textbox", { name: "插件搜索" }) as HTMLInputElement;
    expect(currentInput.isConnected).toBe(true);
    const spaceClear = screen.getByRole("button", { name: "清除插件搜索" });
    spaceClear.focus();
    await fireEvent.keyDown(spaceClear, { key: " " });
    await fireEvent.keyUp(spaceClear, { key: " " });
    await fireEvent.click(spaceClear);
    expect(oninput.mock.calls).toEqual([[""], [""]]);
    await waitFor(() => expect(document.activeElement).toBe(currentInput));

    await fireEvent.input(currentInput, { target: { value: "候选查询" } });
    const staleClear = screen.getByRole("button", { name: "清除插件搜索" });
    await fireEvent.compositionStart(currentInput);
    expect(screen.queryByRole("button", { name: "清除插件搜索" })).toBeNull();
    await fireEvent.click(staleClear);
    expect(oninput.mock.calls).toEqual([[""], [""], ["候选查询"]]);
    await fireEvent.input(currentInput, { target: { value: "候选结果" }, isComposing: true });
    expect(oninput.mock.calls).toEqual([[""], [""], ["候选查询"]]);
    await fireEvent.compositionEnd(currentInput, { data: "候选结果" });
    expect(oninput.mock.calls).toEqual([[""], [""], ["候选查询"], ["候选结果"]]);
    expect(screen.getByRole("button", { name: "清除插件搜索" })).toBeTruthy();
  });

  it("returns only on bare empty Backspace and leaves modified editing shortcuts alone", async () => {
    const onreturn = vi.fn();
    render(PluginNavigationBar, { title: "插件", inputVisible: true, onreturn });
    const input = screen.getByRole("textbox");
    for (const modifier of ["metaKey", "ctrlKey", "altKey", "shiftKey"]) expect(key(input, "Backspace", { [modifier]: true }).defaultPrevented).toBe(false);
    expect(onreturn).not.toHaveBeenCalled();
    expect(key(input, "Backspace").defaultPrevented).toBe(true); expect(onreturn).toHaveBeenCalledOnce();
    await fireEvent.input(input, { target: { value: "内容" } });
    expect(key(input, "Backspace").defaultPrevented).toBe(false); expect(onreturn).toHaveBeenCalledOnce();
  });

  it("shows only the current SubInput shortcut as its single non-live description", async () => {
    const view = render(PluginNavigationBar, { title: "插件", inputVisible: true, onreturn: vi.fn() });
    const input = screen.getByRole("textbox", { name: "插件搜索" }) as HTMLInputElement;
    let hint = view.container.querySelector<HTMLElement>(".navigation-key-hint");
    expect(hint?.textContent).toContain("⌫");
    expect(hint?.querySelector(".navigation-key-hint-visual")?.textContent).toContain("⌫");
    expect(hint?.id).toMatch(/^atools-plugin-navigation-key-hint-\d+$/);
    expect(input.getAttribute("aria-describedby")).toBe(hint?.id);
    expect(hint?.querySelector(".sr-only")?.textContent).toBe("按 Backspace 返回搜索");

    await fireEvent.input(input, { target: { value: "筛选" } });
    hint = view.container.querySelector<HTMLElement>(".navigation-key-hint");
    expect(hint?.querySelector(".navigation-key-hint-visual")?.textContent).toContain("Esc");
    expect(hint?.querySelector(".navigation-key-hint-visual")?.textContent).toContain("清空");
    expect(input.getAttribute("aria-describedby")).toBe(hint?.id);
    expect(hint?.querySelector(".sr-only")?.textContent).toBe("按 Escape 清空插件搜索");
    expect(view.container.querySelector(".navigation-key-hint[aria-live]")).toBeNull();

    await fireEvent.compositionStart(input);
    expect(view.container.querySelector(".navigation-key-hint")).toBeNull();
    expect(input.getAttribute("aria-describedby")).toBeNull();
    await fireEvent.compositionEnd(input, { data: "候选" });
    expect(view.container.querySelector(".navigation-key-hint-visual")?.textContent).toContain("Esc");

    const second = render(PluginNavigationBar, { title: "第二个插件", inputVisible: true, onreturn: vi.fn() });
    const secondHint = second.container.querySelector<HTMLElement>(".navigation-key-hint");
    const secondInput = second.container.querySelector<HTMLInputElement>("input");
    expect(secondHint?.id).toBeTruthy();
    expect(secondHint?.id).not.toBe(hint?.id);
    expect(secondInput?.getAttribute("aria-describedby")).toBe(secondHint?.id);
  });

  it("consumes output navigation only when the caller handled it, and preserves native button keys", async () => {
    const onreturn = vi.fn(); const onmove = vi.fn(() => false); const onactivate = vi.fn(() => false);
    render(PluginNavigationBar, { title: "插件", inputVisible: true, onreturn, onmove, onactivate });
    const input = screen.getByRole("textbox");
    expect(key(input, "ArrowDown").defaultPrevented).toBe(false);
    expect(key(input, "Enter").defaultPrevented).toBe(false);
    onmove.mockReturnValue(true); onactivate.mockReturnValue(true);
    expect(key(input, "ArrowUp").defaultPrevented).toBe(true);
    expect(key(input, "ArrowDown").defaultPrevented).toBe(true);
    expect(key(input, "Enter").defaultPrevented).toBe(true);
    expect(onmove.mock.calls).toEqual([[1], [-1], [1]]); expect(onactivate).toHaveBeenCalledTimes(2);
    const back = screen.getByRole("button", { name: "返回搜索" }); back.focus();
    expect(key(back, "Enter").defaultPrevented).toBe(false);
    expect(key(back, "ArrowDown").defaultPrevented).toBe(false);
    expect(key(back, "Tab").defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(back); expect(onreturn).not.toHaveBeenCalled();
  });

  it("does not bubble owned Escape to the launcher or re-handle prevented keys", async () => {
    const onescape = vi.fn(); const onreturn = vi.fn(); const launcher = vi.fn();
    render(PluginNavigationBar, { title: "插件", inputVisible: true, onreturn, onescape });
    const input = screen.getByRole("textbox");
    window.addEventListener("keydown", launcher);
    try {
      key(input, "Escape"); expect(onescape).toHaveBeenCalledOnce(); expect(launcher).not.toHaveBeenCalled();
      const handled = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
      handled.preventDefault(); input.dispatchEvent(handled); expect(onreturn).not.toHaveBeenCalled();
    } finally { window.removeEventListener("keydown", launcher); }
  });

  it("exposes the live input ref for focus/select and clears it when hidden", async () => {
    let live: HTMLInputElement | null | undefined;
    const view = render(PluginNavigationHarness, { title: "插件", inputVisible: true, value: "可选择", onreturn: vi.fn(), onrefchange: input => { live = input; } });
    expect(live).toBe(screen.getByRole("textbox"));
    live!.focus(); live!.select();
    expect(document.activeElement).toBe(live); expect(live!.selectionEnd).toBe(3);
    await view.rerender({ value: "外部更新", placeholder: "搜索内容" });
    expect(live!.value).toBe("外部更新"); expect(live!.placeholder).toBe("搜索内容");
    await view.rerender({ inputVisible: false });
    expect(live).toBeNull(); expect(screen.queryByRole("textbox")).toBeNull();
    await view.rerender({ inputVisible: true });
    expect(live).toBe(screen.getByRole("textbox"));
  });
});

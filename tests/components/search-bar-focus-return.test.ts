import { cleanup, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, expect, it, vi } from "vitest";
import { tick } from "svelte";
import SearchBar from "../../src/components/SearchBar.svelte";

let originalVisibilityDescriptor: PropertyDescriptor | undefined;
let visibilityWasOverridden = false;

function setVisibilityState(value: "hidden" | "visible") {
  if (!visibilityWasOverridden) {
    originalVisibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
    visibilityWasOverridden = true;
  }
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  if (!visibilityWasOverridden) return;
  if (originalVisibilityDescriptor) Object.defineProperty(document, "visibilityState", originalVisibilityDescriptor);
  else Reflect.deleteProperty(document, "visibilityState");
  originalVisibilityDescriptor = undefined;
  visibilityWasOverridden = false;
});

it("misses a focus token while a transition control owns focus, then claims focus on a new post-resize token", async () => {
  const { rerender } = render(SearchBar, { props: { query: "fixture query", onchange: vi.fn(), focusToken: 0 } });
  const input = screen.getByRole("textbox", { name: "搜索应用和指令" });
  const transitionButton = document.createElement("button"); document.body.append(transitionButton); transitionButton.focus();

  await rerender({ focusToken: 1 });
  await waitFor(() => expect(document.activeElement).toBe(transitionButton));
  transitionButton.remove();
  await rerender({ focusToken: 2 });
  await waitFor(() => expect(document.activeElement).toBe(input));
});

it("does not focus on mount when the generic SearchBar receives no initial-focus intent", async () => {
  render(SearchBar, { props: { query: "fixture query", onchange: vi.fn() } });
  const input = screen.getByRole("textbox", { name: "搜索应用和指令" });
  await waitFor(() => expect(document.activeElement).toBe(document.body));
  expect(document.activeElement).not.toBe(input);
});

it("defers an explicit initial request until the window and document are available", async () => {
  setVisibilityState("hidden");
  const { unmount } = render(SearchBar, {
    props: { query: "fixture query", onchange: vi.fn(), initialFocus: true },
  });
  const input = screen.getByRole("textbox", { name: "搜索应用和指令" });
  window.dispatchEvent(new Event("blur"));
  await tick();
  expect(document.activeElement).not.toBe(input);

  setVisibilityState("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await tick();
  expect(document.activeElement).not.toBe(input);

  setVisibilityState("hidden");
  window.dispatchEvent(new Event("focus"));
  await tick();
  expect(document.activeElement).not.toBe(input);

  setVisibilityState("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await waitFor(() => expect(document.activeElement).toBe(input));
  unmount();
});

it("cancels a deferred initial request if another control takes focus", async () => {
  setVisibilityState("hidden");
  const { unmount } = render(SearchBar, {
    props: { query: "fixture query", onchange: vi.fn(), initialFocus: true },
  });
  const input = screen.getByRole("textbox", { name: "搜索应用和指令" });
  await tick();
  const competitor = document.createElement("button");
  document.body.append(competitor);
  competitor.focus();
  expect(document.activeElement).toBe(competitor);

  setVisibilityState("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
  await tick();
  expect(document.activeElement).toBe(competitor);
  expect(document.activeElement).not.toBe(input);
  competitor.remove();
  unmount();
});

it("keeps the first later focus token distinct from the initial-focus request", async () => {
  const { rerender, unmount } = render(SearchBar, {
    props: { query: "fixture query", onchange: vi.fn(), initialFocus: true, focusToken: 0 },
  });
  const input = screen.getByRole("textbox", { name: "搜索应用和指令" });
  await waitFor(() => expect(document.activeElement).toBe(input));

  window.dispatchEvent(new Event("blur"));
  input.blur();
  await rerender({ focusToken: 1 });
  expect(document.activeElement).not.toBe(input);
  window.dispatchEvent(new Event("focus"));
  await waitFor(() => expect(document.activeElement).toBe(input));
  unmount();
});

it("keeps the existing connected-input focus guard after a later focus request", async () => {
  const { rerender } = render(SearchBar, { props: { query: "fixture query", onchange: vi.fn(), focusToken: 0 } });
  const search = screen.getByRole("textbox", { name: "搜索应用和指令" });
  const other = document.createElement("input"); document.body.append(other); other.focus();

  await rerender({ focusToken: 1 });
  await waitFor(() => expect(document.activeElement).toBe(other));
  expect(document.activeElement).not.toBe(search);
});

it("completes one hidden focus-and-select request when the same document becomes available", async () => {
  setVisibilityState("hidden");
  const select = vi.spyOn(HTMLInputElement.prototype, "select");
  const { rerender, unmount } = render(SearchBar, {
    props: { query: "fixture query", onchange: vi.fn(), focusToken: 0, selectAllToken: 0 },
  });
  const input = screen.getByRole("textbox", { name: "搜索应用和指令" });
  window.dispatchEvent(new Event("blur"));
  await rerender({ focusToken: 1, selectAllToken: 1 });
  expect(document.activeElement).not.toBe(input);
  expect(select).not.toHaveBeenCalled();

  setVisibilityState("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await tick();
  expect(document.activeElement).not.toBe(input);
  expect(select).not.toHaveBeenCalled();

  setVisibilityState("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
  await tick();
  expect(document.activeElement).not.toBe(input);
  expect(select).not.toHaveBeenCalled();

  setVisibilityState("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(select).toHaveBeenCalledTimes(1);

  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
  await Promise.resolve();
  expect(select).toHaveBeenCalledTimes(1);
  unmount();
});

it("removes the pending focus listener when a competing control takes focus", async () => {
  setVisibilityState("hidden");
  const select = vi.spyOn(HTMLInputElement.prototype, "select");
  const { rerender, unmount } = render(SearchBar, {
    props: { query: "fixture query", onchange: vi.fn(), focusToken: 0, selectAllToken: 0 },
  });
  const input = screen.getByRole("textbox", { name: "搜索应用和指令" });
  window.dispatchEvent(new Event("blur"));
  await rerender({ focusToken: 1, selectAllToken: 1 });

  const removeListener = vi.spyOn(document, "removeEventListener");
  const competitor = document.createElement("button");
  document.body.append(competitor);
  competitor.focus();
  expect(document.activeElement).toBe(competitor);
  expect(removeListener).toHaveBeenCalledWith("focusin", expect.any(Function));
  competitor.remove();
  expect(document.activeElement).toBe(document.body);

  setVisibilityState("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
  await tick();
  expect(document.activeElement).not.toBe(input);
  expect(select).not.toHaveBeenCalled();
  unmount();
});

it("does not claim focus without a token or steal it from a competing control", async () => {
  setVisibilityState("hidden");
  const { rerender, unmount } = render(SearchBar, {
    props: { query: "fixture query", onchange: vi.fn(), focusToken: 0, selectAllToken: 0 },
  });
  const input = screen.getByRole("textbox", { name: "搜索应用和指令" });
  await waitFor(() => expect(document.activeElement).toBe(document.body));
  const other = document.createElement("button");
  document.body.append(other);
  other.focus();
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
  await Promise.resolve();
  expect(document.activeElement).toBe(other);

  setVisibilityState("visible");
  window.dispatchEvent(new Event("blur"));
  await rerender({ focusToken: 1, selectAllToken: 0 });
  other.focus();
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  await Promise.resolve();
  expect(document.activeElement).toBe(other);
  expect(document.activeElement).not.toBe(input);
  unmount();
  other.remove();
});

it("replaces a pending select-all with the latest focus request", async () => {
  setVisibilityState("hidden");
  const select = vi.spyOn(HTMLInputElement.prototype, "select");
  const first = render(SearchBar, {
    props: { query: "fixture query", onchange: vi.fn(), focusToken: 0, selectAllToken: 0 },
  });
  const input = screen.getByRole("textbox", { name: "搜索应用和指令" });
  await first.rerender({ focusToken: 1, selectAllToken: 1 });
  await first.rerender({ focusToken: 2, selectAllToken: 1 });

  setVisibilityState("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(select).not.toHaveBeenCalled();
  first.unmount();
});

it("drops a pending request when its input unmounts", async () => {
  setVisibilityState("hidden");
  const view = render(SearchBar, {
    props: { query: "fixture query", onchange: vi.fn(), focusToken: 0 },
  });
  const input = screen.getByRole("textbox", { name: "搜索应用和指令" });
  await view.rerender({ focusToken: 1 });
  view.unmount();

  setVisibilityState("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
  await Promise.resolve();
  expect(input.isConnected).toBe(false);
});

it("cancels a deferred request when its bound input is replaced", async () => {
  setVisibilityState("hidden");
  const view = render(SearchBar, {
    props: { query: "fixture query", onchange: vi.fn(), focusToken: 0 },
  });
  const input = screen.getByRole("textbox", { name: "搜索应用和指令" });
  const replacement = document.createElement("input");
  await view.rerender({ focusToken: 1 });
  input.replaceWith(replacement);
  document.dispatchEvent(new Event("visibilitychange"));

  setVisibilityState("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
  await Promise.resolve();
  expect(input.isConnected).toBe(false);
  expect(document.activeElement).not.toBe(replacement);
  view.unmount();
});

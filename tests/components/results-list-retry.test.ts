import { cleanup, render, screen, fireEvent } from "@testing-library/svelte";
import { afterEach, expect, it, vi } from "vitest";
import ResultsList from "../../src/components/ResultsList.svelte";
import { searchFeedbackFor } from "../../src/lib/searchFeedback";
import { alphaPlugin } from "./launcherReturnContextFixture";

afterEach(cleanup);

it("renders a native retry action only for an eligible zero-result error outside listbox semantics", async () => {
  const onretry = vi.fn();
  const feedback = searchFeedbackFor({ query: "missing command", resultCount: 0, remoteStatus: "error", error: "offline" });
  render(ResultsList, { results: [], selectedIndex: 0, query: "missing command", feedback,
    onselect: vi.fn(), onretry });

  const button = screen.getByRole("button", { name: "重试搜索" });
  expect(button.tagName).toBe("BUTTON");
  expect(button.getAttribute("type")).toBe("button");
  const listbox = screen.getByRole("listbox", { name: "搜索结果" });
  expect(listbox.id).toBe("launcher-results");
  expect(listbox.children).toHaveLength(0);
  expect(listbox.contains(screen.getByRole("status"))).toBe(false);
  expect(listbox.contains(button)).toBe(false);
  await fireEvent.click(button);
  expect(onretry).toHaveBeenCalledOnce();
});

it("updates eligibility across empty, loading, retryable empty failures and populated failures", async () => {
  const onretry = vi.fn();
  const onselect = vi.fn();
  const query = "absent";
  const ordinaryEmpty = searchFeedbackFor({ query, resultCount: 0, remoteStatus: "ready" });
  const { rerender } = render(ResultsList, { results: [], selectedIndex: 0, query, feedback: ordinaryEmpty,
    onselect, onretry });
  expect(screen.getByRole("listbox", { name: "搜索结果" }).id).toBe("launcher-results");
  expect(screen.queryByRole("button", { name: "重试搜索" })).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("没有找到匹配");
  expect(screen.getByRole("status").closest('[role="listbox"]')).toBeNull();

  const retryable = searchFeedbackFor({ query, resultCount: 0, remoteStatus: "error", error: "offline" });
  await rerender({ results: [], selectedIndex: 0, query: "   ", feedback: retryable, onselect, onretry });
  expect(screen.getByRole("listbox", { name: "搜索结果" }).id).toBe("launcher-results");
  expect(screen.queryByRole("button", { name: "重试搜索" })).toBeNull();

  const loading = searchFeedbackFor({ query, resultCount: 0, remoteStatus: "searching" });
  await rerender({ results: [], selectedIndex: 0, query, feedback: loading, onselect, onretry });
  expect(screen.getByRole("listbox", { name: "搜索结果" }).id).toBe("launcher-results");
  expect(screen.queryByRole("button", { name: "重试搜索" })).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("正在搜索");

  const partialFailure = searchFeedbackFor({ query, resultCount: 0, remoteStatus: "partial", error: "部分不可用" });
  await rerender({ results: [], selectedIndex: 0, query, feedback: partialFailure, onselect, onretry });
  expect(screen.getByRole("listbox", { name: "搜索结果" }).id).toBe("launcher-results");
  expect(screen.getByRole("button", { name: "重试搜索" })).toBeTruthy();

  const populatedFeedback = searchFeedbackFor({ query, resultCount: 1, remoteStatus: "partial", error: "部分不可用" });
  await rerender({ results: [alphaPlugin], selectedIndex: 0, query, feedback: populatedFeedback, onselect, onretry });
  expect(screen.getByRole("listbox", { name: "搜索结果" })).toBeTruthy();
  const retryButton = screen.getByRole("button", { name: "重试搜索" });
  expect(retryButton.tagName).toBe("BUTTON");
  expect(retryButton.getAttribute("type")).toBe("button");
  expect(retryButton.textContent).toBe("重试");
  expect(retryButton.closest('[role="listbox"]')).toBeNull();
  expect(document.body.textContent).toContain("可重试以补齐更多结果");
  retryButton.focus();
  expect(document.activeElement).toBe(retryButton);
  await fireEvent.click(retryButton);
  expect(onretry).toHaveBeenCalledOnce();

  const loadingWithResults = searchFeedbackFor({ query, resultCount: 1, remoteStatus: "searching" });
  await rerender({ results: [alphaPlugin], selectedIndex: 0, query, feedback: loadingWithResults, onselect, onretry });
  expect(screen.queryByRole("button", { name: "重试搜索" })).toBeNull();

  const failedWithResults = searchFeedbackFor({ query, resultCount: 1, remoteStatus: "error" });
  await rerender({ results: [alphaPlugin], selectedIndex: 0, query, feedback: failedWithResults, onselect, onretry });
  expect(screen.getByRole("button", { name: "重试搜索" })).toBeTruthy();
});

it("requires an explicit retry callback after an eligible error loses its callback", async () => {
  const onretry = vi.fn();
  const query = "absent";
  const feedback = searchFeedbackFor({ query, resultCount: 0, remoteStatus: "error" });
  const { rerender } = render(ResultsList, { results: [], selectedIndex: 0, query, feedback, onselect: vi.fn(), onretry });
  expect(screen.getByRole("button", { name: "重试搜索" })).toBeTruthy();

  const populatedFailure = searchFeedbackFor({ query, resultCount: 1, remoteStatus: "partial" });
  await rerender({ results: [alphaPlugin], selectedIndex: 0, query, feedback: populatedFailure, onselect: vi.fn(), onretry: undefined });
  expect(screen.queryByRole("button", { name: "重试搜索" })).toBeNull();
});

it("keeps partial-search feedback outside the independently scrolling result list", () => {
  const query = "plugin command";
  const feedback = searchFeedbackFor({ query, resultCount: 1, remoteStatus: "partial", error: "one source unavailable" });
  const { container } = render(ResultsList, { results: [alphaPlugin], selectedIndex: 0, query, feedback,
    onselect: vi.fn(), onretry: vi.fn() });

  const frame = container.querySelector(".results-list");
  const status = screen.getByRole("status");
  const listbox = screen.getByRole("listbox", { name: "搜索结果" });
  expect(frame).toBeTruthy();
  expect(status.classList.contains("feedback-strip")).toBe(true);
  expect(listbox.classList.contains("result-scrollport")).toBe(true);
  expect(status.parentElement).toBe(frame);
  expect(listbox.parentElement).toBe(frame);
  expect(status.nextElementSibling).toBe(listbox);
  expect(listbox.contains(status)).toBe(false);
  expect(listbox.querySelector('[role="option"]')?.getAttribute("aria-selected")).toBe("true");
});

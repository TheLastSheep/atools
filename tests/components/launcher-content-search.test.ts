import { afterEach, expect, it, vi } from "vitest";
import { createLauncherContentSearch, emptyLauncherContentSearchState, launcherContentSearchFeedback, type LauncherContentSearchState } from "../../src/lib/launcherContentSearch";
import { launcherTextSummary, launcherTextWithinBudget, MAX_LAUNCHER_TEXT_BYTES } from "../../src/lib/launcherMatchContext";
import type { SearchResult } from "../../src/lib/types";

const result = (code: string, match_type = "regex"): SearchResult => ({
  code, plugin_id: "tools", plugin_name: "文本工具", label: code, explain: "处理文本", icon: null,
  score: 70, match_type, content_search_terms: ["original alias"],
});
afterEach(() => vi.useRealTimers());
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

it("bounds UTF-8 bytes exactly without truncating a multi-byte or surrogate input", () => {
  expect(launcherTextWithinBudget("a".repeat(MAX_LAUNCHER_TEXT_BYTES))).toBe(true);
  expect(launcherTextWithinBudget("a".repeat(MAX_LAUNCHER_TEXT_BYTES + 1))).toBe(false);
  expect(launcherTextWithinBudget("界".repeat(87381) + "a")).toBe(true);
  expect(launcherTextWithinBudget("界".repeat(87381) + "ab")).toBe(false);
  expect(launcherTextWithinBudget("😀".repeat(65536))).toBe(true);
  expect(launcherTextWithinBudget("😀".repeat(65536) + "x")).toBe(false);
});

it("keeps the visible preview compact and does not split a Unicode surrogate pair", () => {
  const summary = launcherTextSummary("  " + "😀".repeat(30) + "\nprivate tail");
  expect(summary).toBe("😀".repeat(24) + "…");
  expect(summary).not.toContain("private tail");
  expect(launcherTextSummary("hello\n  world")).toBe("hello world");
});

it("maintains owner identity and original match type during local alias filtering", async () => {
  let state = emptyLauncherContentSearchState();
  const first = result("first"), second = { ...result("first", "over"), plugin_id: "another" };
  const search = vi.fn(async () => [first, second, { ...first }, result("not-text", "exact")]);
  const controller = createLauncherContentSearch({ search, available: () => true, isActive: () => true, onUpdate: value => state = value });
  controller.pin("body"); await vi.waitFor(() => expect(state.status).toBe("ready"));
  controller.filter("original alias");
  expect(state.results.map(row => [row.plugin_id, row.match_type])).toEqual([["tools", "regex"], ["another", "over"]]);
  controller.filter("missing target"); expect(state.results).toHaveLength(0);
  controller.filter(""); expect(state.results).toHaveLength(2);
  expect(search).toHaveBeenCalledTimes(1); controller.dispose();
});

it("expires a stalled query and discards even a later successful response", async () => {
  vi.useFakeTimers(); let state = emptyLauncherContentSearchState();
  let resolve!: (value: SearchResult[]) => void;
  const controller = createLauncherContentSearch({ search: () => new Promise(done => resolve = done), available: () => true, isActive: () => true, onUpdate: value => state = value });
  controller.pin("private body"); await settle();
  await vi.advanceTimersByTimeAsync(1200);
  expect(state.status).toBe("error");
  expect(state.error).not.toContain("private body");
  resolve([result("late")]); await settle();
  expect(state.results).toEqual([]); expect(state.status).toBe("error"); controller.dispose();
});

it("does not publish an unmounted controller's response or leave its timeout running", async () => {
  vi.useFakeTimers(); const onUpdate = vi.fn();
  let resolve!: (value: SearchResult[]) => void;
  const controller = createLauncherContentSearch({ search: () => new Promise(done => resolve = done), available: () => true, isActive: () => true, onUpdate });
  controller.pin("body"); await settle(); controller.dispose();
  const count = onUpdate.mock.calls.length;
  resolve([result("late")]); await settle();
  expect(onUpdate).toHaveBeenCalledTimes(count); expect(vi.getTimerCount()).toBe(0);
});

it("keeps fixed-text feedback relevant to plugin handling without echoing raw content", () => {
  const state: LauncherContentSearchState = { ...emptyLauncherContentSearchState(), content: "private body", status: "searching" };
  expect(launcherContentSearchFeedback(state)).toMatchObject({ mode: "loading", title: "正在匹配文本处理命令" });
  expect(JSON.stringify(launcherContentSearchFeedback(state))).not.toContain("private body");
  expect(launcherContentSearchFeedback({ ...state, status: "ready", filter: "absent" }).hint).toContain("别名");
  expect(launcherContentSearchFeedback({ ...state, status: "ready" }).title).toBe("没有插件可以处理此文本");
});

import { describe, expect, it } from "vitest";
import { canRetrySearch, canRetrySearchFromPointer, searchFeedbackFor, shouldRetrySearchOnEnter } from "../../src/lib/searchFeedback";
import { searchStatusBarView } from "../../src/lib/searchStatusBar";

const errorFeedback = searchFeedbackFor({ query: "plugin query", resultCount: 0, remoteStatus: "error", error: "offline" });

function context(patch: Partial<Parameters<typeof shouldRetrySearchOnEnter>[0]> = {}) {
  return {
    key: "Enter",
    query: "plugin query",
    resultCount: 0,
    feedback: errorFeedback,
    isHomeSearch: true,
    isMainSearchFocused: true,
    hasTextOrMediaContext: false,
    modalOpen: false,
    isComposing: false,
    keyCode: 13,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...patch,
  };
}

describe("explicit launcher search retry", () => {
  it("marks only completed zero-result errors and partial failures as retryable", () => {
    expect(errorFeedback.retryOnEnter).toBe(true);
    expect(errorFeedback.hint).toContain("Enter 重试搜索");
    const partial = searchFeedbackFor({ query: "x", resultCount: 0, remoteStatus: "partial", error: "one source failed" });
    expect(partial.retryOnEnter).toBe(true);
    expect(partial.title).toBe("部分搜索结果暂不可用");
    expect(partial.hint).toContain("Enter 重试搜索");
    expect(partial.retryOnPointer).toBeUndefined();
    expect(searchFeedbackFor({ query: "x", resultCount: 1, remoteStatus: "error" }).retryOnEnter).toBeUndefined();
    expect(searchFeedbackFor({ query: "x", resultCount: 1, remoteStatus: "error" }).retryOnPointer).toBe(true);
    expect(searchFeedbackFor({ query: "x", resultCount: 0, remoteStatus: "searching" }).retryOnEnter).toBeUndefined();
    expect(searchFeedbackFor({ query: "x", resultCount: 0, remoteStatus: "ready" }).retryOnEnter).toBeUndefined();
  });

  it("keeps backend error text out of visible failure feedback while preserving diagnostics state", () => {
    const error = "Error: fixed offline retry fixture\n    at retry (/private/tmp/private stack.js:4:2)";
    const input = { query: "plugin query", resultCount: 0, remoteStatus: "error" as const, error };
    const feedback = searchFeedbackFor(input);

    expect(feedback.title).toBe("搜索暂不可用");
    expect(feedback.hint).toBe("当前没有可用结果。按 Enter 重试搜索。");
    expect(feedback.hint).not.toContain("Error:");
    expect(feedback.hint).not.toContain("/private/");
    expect(input.error).toBe(error);
    expect(shouldRetrySearchOnEnter(context({ feedback }))).toBe(true);

    const partial = searchFeedbackFor({ ...input, remoteStatus: "partial", error });
    expect(partial.hint).toBe("当前没有可用结果。按 Enter 重试搜索。");
    expect(partial.hint).not.toContain("fixed offline retry fixture");
    expect(partial.retryOnEnter).toBe(true);
  });

  it("keeps returned results usable after partial or failed plugin search", () => {
    const partial = searchFeedbackFor({ query: "plugin query", resultCount: 2, remoteStatus: "partial",
      error: "Error: one source failed" });
    expect(partial.mode).toBe("strip");
    expect(partial.title).toBe("部分搜索结果暂不可用");
    expect(partial.hint).toBe("已显示可用结果；可重试以补齐更多结果。");
    expect(partial.retryOnEnter).toBeUndefined();
    expect(partial.retryOnPointer).toBe(true);

    const failed = searchFeedbackFor({ query: "plugin query", resultCount: 2, remoteStatus: "error",
      error: "Error: network timeout at /private/tmp" });
    expect(failed.mode).toBe("strip");
    expect(failed.title).toBe("搜索暂不可用");
    expect(failed.hint).toBe("已有结果仍可用；可重试搜索更多结果。");
    expect(failed.hint).not.toContain("network timeout");
    expect(failed.hint).not.toContain("/private/tmp");
    expect(failed.retryOnEnter).toBeUndefined();
    expect(failed.retryOnPointer).toBe(true);
  });

  it("requires the ordinary focused search, no modal, and an unmodified non-IME Enter", () => {
    expect(canRetrySearch(context())).toBe(true);
    expect(shouldRetrySearchOnEnter(context())).toBe(true);
    for (const patch of [
      { isHomeSearch: false },
      { isMainSearchFocused: false },
      { hasTextOrMediaContext: true },
      { modalOpen: true },
      { isComposing: true },
      { keyCode: 229 },
      { key: "Escape" },
      { metaKey: true },
      { ctrlKey: true },
      { altKey: true },
      { shiftKey: true },
      { query: "  " },
      { resultCount: 1 },
      { feedback: searchFeedbackFor({ query: "x", resultCount: 0, remoteStatus: "ready" }) },
    ]) {
      expect(shouldRetrySearchOnEnter(context(patch))).toBe(false);
    }
  });

  it("shares the retryable failure boundary with pointer actions", () => {
    for (const patch of [
      { query: "  " },
      { resultCount: 1 },
      { isHomeSearch: false },
      { hasTextOrMediaContext: true },
      { modalOpen: true },
      { feedback: searchFeedbackFor({ query: "x", resultCount: 0, remoteStatus: "ready" }) },
    ]) expect(canRetrySearch(context(patch))).toBe(false);
  });

  it("allows an explicit pointer retry for preserved results without changing Enter activation", () => {
    const feedback = searchFeedbackFor({ query: "plugin query", resultCount: 2, remoteStatus: "partial" });
    const state = context({ resultCount: 2, feedback, isMainSearchFocused: true });
    expect(canRetrySearch(state)).toBe(false);
    expect(shouldRetrySearchOnEnter(state)).toBe(false);
    expect(canRetrySearchFromPointer(state)).toBe(true);
    for (const patch of [
      { isHomeSearch: false },
      { hasTextOrMediaContext: true },
      { modalOpen: true },
      { query: "  " },
      { feedback: searchFeedbackFor({ query: "plugin query", resultCount: 2, remoteStatus: "ready" }) },
    ]) expect(canRetrySearchFromPointer({ ...state, ...patch })).toBe(false);
  });

  it("keeps ordinary empty status honest and exposes retry only for a retryable failure", () => {
    const base = { mode: "results" as const, count: 0, selectedIndex: 0, selectedLabel: "", tabAction: "select" as const };
    const empty = searchStatusBarView(base);
    expect(empty.hints.some(({ key }) => key === "Enter")).toBe(false);
    const retry = searchStatusBarView({ ...base, retryOnEnter: true });
    expect(retry.hints).toContainEqual({ key: "Enter", label: "重试搜索" });
  });
});

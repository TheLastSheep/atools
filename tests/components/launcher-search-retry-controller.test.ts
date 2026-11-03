import { expect, it, vi } from "vitest";
import { createLauncherSearchRetryController } from "../../src/lib/launcherSearchRetryController";
import { searchFeedbackFor, type SearchRetryEligibilityContext } from "../../src/lib/searchFeedback";

function failedSearch(query = "plugin query"): SearchRetryEligibilityContext {
  return {
    query,
    resultCount: 0,
    feedback: searchFeedbackFor({ query, resultCount: 0, remoteStatus: "error", error: "offline" }),
    isHomeSearch: true,
    hasTextOrMediaContext: false,
    modalOpen: false,
  };
}

it("retries the live failed query once and restores search focus", () => {
  let state = failedSearch();
  let generation = 1;
  const retry = vi.fn(() => {
    generation += 1;
    state.feedback = searchFeedbackFor({ query: state.query, resultCount: state.resultCount, remoteStatus: "searching" });
  });
  const focusSearch = vi.fn();
  const controller = createLauncherSearchRetryController({ current: () => state, searchGeneration: () => generation, retry, focusSearch });

  expect(controller.retryFromPointer()).toBe(true);
  expect(retry).toHaveBeenCalledOnce();
  expect(retry).toHaveBeenCalledWith("plugin query");
  expect(focusSearch).toHaveBeenCalledOnce();
  expect(controller.retryFromPointer()).toBe(false);
  expect(retry).toHaveBeenCalledOnce();

  state = failedSearch("next query");
  generation += 1;
  expect(controller.retryFromPointer()).toBe(true);
  expect(retry).toHaveBeenLastCalledWith("next query");
});

it("keeps a synchronously launched search pending and ignores an older A attempt after A-B-A", async () => {
  let state = failedSearch("A");
  let generation = 1;
  let releaseOld!: () => void;
  let releaseNew!: () => void;
  const retry = vi.fn()
    .mockImplementationOnce(() => {
      generation += 1;
      state.feedback = searchFeedbackFor({ query: state.query, resultCount: state.resultCount, remoteStatus: "searching" });
      return new Promise<void>(resolve => { releaseOld = resolve; });
    })
    .mockImplementationOnce(() => {
      generation += 1;
      state.feedback = searchFeedbackFor({ query: state.query, resultCount: state.resultCount, remoteStatus: "searching" });
      return new Promise<void>(resolve => { releaseNew = resolve; });
    });
  const controller = createLauncherSearchRetryController({ current: () => state, searchGeneration: () => generation, retry, focusSearch: vi.fn() });

  expect(controller.retryFromPointer()).toBe(true);
  expect(controller.retryFromPointer()).toBe(false);
  state = failedSearch("B");
  generation += 1;
  state = failedSearch("A");
  generation += 1;
  expect(controller.retryFromPointer()).toBe(true);
  expect(retry).toHaveBeenCalledTimes(2);
  expect(controller.retryFromPointer()).toBe(false);

  releaseOld();
  await Promise.resolve();
  await Promise.resolve();
  expect(controller.retryFromPointer()).toBe(false);

  releaseNew();
  await Promise.resolve();
  await Promise.resolve();
  state.feedback = failedSearch("A").feedback;
  expect(controller.retryFromPointer()).toBe(true);
  expect(retry).toHaveBeenCalledTimes(3);
});

it("uses the same live failure policy for Enter and keeps composition/modifier guards", () => {
  const state = failedSearch();
  let generation = 1;
  const retry = vi.fn(() => {
    generation += 1;
    state.feedback = searchFeedbackFor({ query: state.query, resultCount: state.resultCount, remoteStatus: "searching" });
  });
  const controller = createLauncherSearchRetryController({ current: () => state, searchGeneration: () => generation, retry, focusSearch: vi.fn() });
  const enter = { key: "Enter", isMainSearchFocused: true, isComposing: false, keyCode: 13,
    metaKey: false, ctrlKey: false, altKey: false, shiftKey: false } as const;

  expect(controller.retryFromEnter(enter)).toBe(true);
  expect(retry).toHaveBeenCalledWith("plugin query");
  expect(controller.retryFromEnter({ ...enter, ctrlKey: true })).toBe(false);
  expect(controller.retryFromEnter({ ...enter, isComposing: true })).toBe(false);
  expect(retry).toHaveBeenCalledOnce();
});

it("retries a partial query with results by pointer while leaving Enter for the selected result", () => {
  const state = failedSearch();
  state.resultCount = 2;
  state.feedback = searchFeedbackFor({ query: state.query, resultCount: 2, remoteStatus: "partial" });
  let generation = 4;
  const retry = vi.fn(() => {
    generation += 1;
    state.feedback = searchFeedbackFor({ query: state.query, resultCount: state.resultCount, remoteStatus: "searching" });
  });
  const controller = createLauncherSearchRetryController({ current: () => state, searchGeneration: () => generation,
    retry, focusSearch: vi.fn() });
  const enter = { key: "Enter", isMainSearchFocused: true, isComposing: false, keyCode: 13,
    metaKey: false, ctrlKey: false, altKey: false, shiftKey: false } as const;

  expect(controller.retryFromEnter(enter)).toBe(false);
  expect(controller.retryFromPointer()).toBe(true);
  expect(retry).toHaveBeenCalledOnce();
  expect(retry).toHaveBeenCalledWith("plugin query");
  expect(controller.retryFromPointer()).toBe(false);
  expect(retry).toHaveBeenCalledOnce();
  state.feedback = searchFeedbackFor({ query: state.query, resultCount: 2, remoteStatus: "ready" });
  expect(controller.retryFromPointer()).toBe(false);
});

it("does not retry ordinary empty results, non-home states, or searches with context", () => {
  const state = failedSearch();
  let generation = 1;
  const retry = vi.fn(() => { generation += 1; });
  const controller = createLauncherSearchRetryController({ current: () => state, searchGeneration: () => generation, retry, focusSearch: vi.fn() });
  state.feedback = searchFeedbackFor({ query: state.query, resultCount: 0, remoteStatus: "ready" });
  expect(controller.retryFromPointer()).toBe(false);

  state.feedback = failedSearch().feedback;
  state.hasTextOrMediaContext = true;
  expect(controller.retryFromPointer()).toBe(false);
  state.hasTextOrMediaContext = false;
  state.isHomeSearch = false;
  expect(controller.retryFromPointer()).toBe(false);
  expect(retry).not.toHaveBeenCalled();
});

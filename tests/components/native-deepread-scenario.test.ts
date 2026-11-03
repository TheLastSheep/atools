import { describe, expect, it } from "vitest";
import type { PublishedPluginProfile } from "./nativePublishedPluginCommon";
import registry from "../fixtures/converted-source-cases.json";
import operations from "./nativePublishedDeepReadFrameOperations.js?raw";
import { assertDeepReadProfile, assertDeepReadReopenedState, assertDeepReadSnapshot, assertDeepReadUiRestored } from "./nativePublishedDeepReadScenario";
import { requiresLegacyNodeSession } from "./nativePublishedRuntimeRequirement";
import { classifyDeepReadPermission } from "./nativePublishedNodeAuthorization";

describe("converted DeepRead consumer contract", () => {
  const deepReadCaseId = "converted-deepread-source";
  // Keep the imported JSON values intact; the runtime assertion below detects fixture drift.
  const profile = registry.cases.find(item => item.caseId === deepReadCaseId) as unknown as PublishedPluginProfile;
  const handoff = registry.handoffs[deepReadCaseId];
  it("keeps source conversion evidence-only while exposing a separate Web consumer profile", () => {
    expect(profile).toMatchObject({ caseId: "converted-deepread-source", id: "deepread", runtime: "web",
      featureCode: "deepread", dataAccess: true, pathAccess: "none", dialogAccess: "open", verifyDataPersistence: true });
    expect(handoff).toMatchObject({ sourceCaseId: "fixed-head-deepread-public",
      artifactKind: "converted_source_evidence", handoffStatus: "conversion_evidence_only", nativeUiConsumerSupported: false });
    expect(() => assertDeepReadProfile(profile)).not.toThrow();
    expect(() => assertDeepReadProfile({ ...profile, pathAccess: "standard" })).toThrow();
    expect(() => assertDeepReadProfile({ ...profile, dialogAccess: "save" })).toThrow();
  });
  it("requires the real Node gate for a Web UI whose fixed preload uses Node modules", () => {
    expect(profile.runtime).toBe("web");
    expect(requiresLegacyNodeSession(profile)).toBe(true);
    expect(requiresLegacyNodeSession({ ...profile, caseId: "converted-tetris-source" })).toBe(false);
    expect(requiresLegacyNodeSession({ ...profile, runtime: "node" })).toBe(true);
  });
  it("classifies only DeepRead's exact open-dialog prompt as its own authorization gate", () => {
    expect(classifyDeepReadPermission("DeepRead 深读 请求打开文件选择窗口", true, false, "DeepRead 深读")).toBe("dialog");
    expect(classifyDeepReadPermission("Other 请求打开文件选择窗口", true, false, "DeepRead 深读")).toBe("unexpected");
    expect(classifyDeepReadPermission("DeepRead 深读 请求打开文件选择窗口", true, true, "DeepRead 深读")).toBe("dialog");
  });
  it("requires exact stored content and progress after full close and reopen", () => {
    const snapshot = { pluginId: "deepread", bookCount: 1, fixtureBookPresent: true, lastBookSelected: true,
      progressIndex: 18, progressAdvanced: true, contentBytes: 8854,
      contentSha256: "7a4e04785979bbcd5889557e661584f2db4117b95c1c35de9cdbd39efeb007c0", pathStored: true,
      storageKeys: ["deepread.library.v1", "deepread.lastBookId.v1"],
      source: "isolated SQLite plugin dbStorage projection", readOnly: true as const };
    expect(assertDeepReadReopenedState(snapshot, 18)).toEqual(snapshot);
    expect(() => assertDeepReadReopenedState(snapshot, 12)).toThrow();
    expect(() => assertDeepReadReopenedState({ ...snapshot, contentSha256: "0".repeat(64) }, 18)).toThrow();
  });
  it("requires the fresh main UI to restore the active book and its observed progress indicator", () => {
    const state = { caseId: "converted-deepread-source", mainLibraryVisible: true, fixtureBookVisible: true,
      fixtureBookActive: true, progressIndicatorWidth: "12.4%", nodeVersion: "22.23.3", firstUseDisclaimerVisible: false,
      emptyLibraryVisible: false, searchOpen: false, searchQuery: "",
      searchResultCount: 0, fixedSearchResultCount: 0 };
    expect(assertDeepReadUiRestored(state, "12.4%")).toBe(state);
    expect(() => assertDeepReadUiRestored({ ...state, progressIndicatorWidth: "12.3%" }, "12.4%")).toThrow();
    expect(() => assertDeepReadUiRestored({ ...state, fixtureBookActive: false }, "12.4%")).toThrow();
    expect(() => assertDeepReadUiRestored({ ...state, nodeVersion: "22.23.4" }, "12.4%")).toThrow();
  });
  it("accepts only the bounded two-key path-free SQLite projection", () => {
    const projection = { pluginId: "deepread", bookCount: 1, fixtureBookPresent: true, lastBookSelected: true,
      progressIndex: 18, progressAdvanced: true, contentBytes: 8854,
      contentSha256: "7a4e04785979bbcd5889557e661584f2db4117b95c1c35de9cdbd39efeb007c0", pathStored: true,
      storageKeys: ["deepread.library.v1", "deepread.lastBookId.v1"],
      source: "isolated SQLite plugin dbStorage projection", readOnly: true as const };
    expect(assertDeepReadSnapshot(projection)).toEqual(projection);
    expect(() => assertDeepReadSnapshot({ ...projection, path: "/private/tmp/book.txt" })).toThrow();
    expect(() => assertDeepReadSnapshot({ ...projection, contentSha256: "not-a-sha" })).toThrow();
    expect(() => assertDeepReadSnapshot({ ...projection, progressIndex: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(() => assertDeepReadSnapshot({ ...projection, storageKeys: ["other-plugin.secret"] })).toThrow();
  });
});


describe("DeepRead original search result binding", () => {
  function mountResults(snippets: string[]) {
    document.body.innerHTML = `<article class="book-card"><h3>ATools DeepRead Reader Fixture</h3></article>
      <section aria-labelledby="book-search-title"><input value="DeepRead fixed reading line 020">
      <div class="search-list book-search-list">${snippets.map((snippet, index) =>
        `<button data-index="${index}"><strong>${index + 1}</strong><span>${snippet}</span></button>`).join("")}</div></section>`;
    (window as Window & { __ATOOLS_PUBLISHED_ACTIVE_CASE__?: string }).__ATOOLS_PUBLISHED_ACTIVE_CASE__ = "converted-deepread-source";
    window.eval(operations);
  }

  it("rejects a misleading first result and clicks only the exact fixed passage", () => {
    mountResults(["unrelated result", "DeepRead fixed reading line 020 is visible here"]);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".book-search-list button")];
    const clicked: string[] = [];
    buttons.forEach(button => button.addEventListener("click", () => clicked.push(button.dataset.index!)));
    const adapter = (window as Window & { __ATOOLS_PUBLISHED_CASE_OPERATIONS__?: { perform: (operation: string) => unknown } })
      .__ATOOLS_PUBLISHED_CASE_OPERATIONS__!;
    expect((adapter as unknown as { state: () => { fixedSearchResultCount: number } }).state().fixedSearchResultCount).toBe(1);
    adapter.perform("jump-to-fixed-match");
    expect(clicked).toEqual(["1"]);
  });

  it("fails closed when no visible result contains the fixed passage", () => {
    mountResults(["unrelated result", "also unrelated"]);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".book-search-list button")];
    const clicked: string[] = [];
    buttons.forEach(button => button.addEventListener("click", () => clicked.push(button.dataset.index!)));
    const adapter = (window as Window & { __ATOOLS_PUBLISHED_CASE_OPERATIONS__?: { perform: (operation: string) => unknown } })
      .__ATOOLS_PUBLISHED_CASE_OPERATIONS__!;
    expect(() => adapter.perform("jump-to-fixed-match")).toThrow("exactly one visible result");
    expect(clicked).toEqual([]);
  });
  it("reads the original book-card class and bounded rendered progress from the main DOM", () => {
    document.body.innerHTML = `<article class="book-card active"><strong class="book-title-text">ATools DeepRead Reader Fixture</strong>
      <div class="progress-track"><span style="width: 12.4%"></span></div></article>`;
    const appWindow = window as Window & { __ATOOLS_PUBLISHED_ACTIVE_CASE__?: string; process?: { versions: { node: string } } };
    const previousProcess = appWindow.process;
    appWindow.__ATOOLS_PUBLISHED_ACTIVE_CASE__ = "converted-deepread-source";
    appWindow.process = { versions: { node: "22.23.3" } };
    try {
      window.eval(operations);
      const adapter = (window as Window & { __ATOOLS_PUBLISHED_CASE_OPERATIONS__?: { state: () => Record<string, unknown> } })
        .__ATOOLS_PUBLISHED_CASE_OPERATIONS__!;
      expect(adapter.state()).toMatchObject({ caseId: "converted-deepread-source", fixtureBookVisible: true,
        fixtureBookActive: true, progressIndicatorWidth: "12.4%", nodeVersion: "22.23.3" });
    } finally {
      if (previousProcess) appWindow.process = previousProcess;
      else delete appWindow.process;
    }
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import operations from "./nativePublishedDeepReadFrameOperations.js?raw";

type Operations = { perform: (name: string) => unknown; state: () => Record<string, unknown> };
type PublishedWindow = Window & { __ATOOLS_PUBLISHED_ACTIVE_CASE__?: string; __ATOOLS_PUBLISHED_CASE_OPERATIONS__?: Operations };

describe("DeepRead first-use consent adapter", () => {
  afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; delete (window as PublishedWindow).__ATOOLS_PUBLISHED_CASE_OPERATIONS__;
    delete (window as PublishedWindow).__ATOOLS_PUBLISHED_ACTIVE_CASE__; });

  it("clicks only the original visible consent button and does not write plugin storage", () => {
    document.body.innerHTML = `<div class="empty-state"><strong>书架空空如也</strong></div>
      <section class="disclaimer-dialog" role="alertdialog" aria-modal="true"><button class="disclaimer-accept-button">同意并继续使用</button></section>`;
    const appWindow = window as PublishedWindow;
    appWindow.__ATOOLS_PUBLISHED_ACTIVE_CASE__ = "converted-deepread-source";
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const button = document.querySelector<HTMLButtonElement>(".disclaimer-accept-button")!;
    const clicked = vi.fn(() => document.querySelector(".disclaimer-dialog")?.remove());
    button.addEventListener("click", clicked);
    window.eval(operations);
    appWindow.__ATOOLS_PUBLISHED_CASE_OPERATIONS__!.perform("accept-first-use-disclaimer");
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(storageWrite).not.toHaveBeenCalled();
    expect(appWindow.__ATOOLS_PUBLISHED_CASE_OPERATIONS__!.state()).toMatchObject({
      caseId: "converted-deepread-source", firstUseDisclaimerVisible: false, emptyLibraryVisible: true,
    });
    storageWrite.mockRestore();
  });

  it("refuses an absent or mismatched original consent control and any other fixture", () => {
    document.body.innerHTML = `<section class="disclaimer-dialog" role="alertdialog" aria-modal="true"><button>Later</button></section>`;
    const appWindow = window as PublishedWindow;
    appWindow.__ATOOLS_PUBLISHED_ACTIVE_CASE__ = "converted-deepread-source";
    window.eval(operations);
    expect(() => appWindow.__ATOOLS_PUBLISHED_CASE_OPERATIONS__!.perform("accept-first-use-disclaimer"))
      .toThrow("original disclaimer consent button");
    document.body.innerHTML = `<section class="disclaimer-dialog" role="alertdialog" aria-modal="true"><button class="disclaimer-accept-button">Later</button></section>`;
    expect(() => appWindow.__ATOOLS_PUBLISHED_CASE_OPERATIONS__!.perform("accept-first-use-disclaimer"))
      .toThrow("did not match its fixed label");
    appWindow.__ATOOLS_PUBLISHED_ACTIVE_CASE__ = "converted-tetris-source";
    expect(() => appWindow.__ATOOLS_PUBLISHED_CASE_OPERATIONS__!.perform("accept-first-use-disclaimer"))
      .toThrow("Unapproved DeepRead fixture case");
  });
});

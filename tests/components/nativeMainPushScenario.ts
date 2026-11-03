import { assert, createNativeMainPushSupport, pause, phase, type Fixture } from "./nativeMainPushSupport";

type Run = { capabilityId: string; capability_id?: string; status: string; input: { operation?: string; runnerId?: string } };
export async function runNativeMainPushScenario(fixture: Fixture) {
  const support = createNativeMainPushSupport(fixture);
  const { until, input, search, rows, frame, observe, invoke } = support;
  const checks: Record<string, boolean> = {};
  const observations: Record<string, unknown> = {};
  function check(ok: unknown, label: string) { assert(ok, label); checks[label] = true; }
  async function quietPermissions() {
    await until(async () => !(await invoke<unknown[]>("list_pending_agent_requests")).length
      && !document.querySelector("[data-permission-dialog]"), "Reviewed permissions did not settle");
  }
  async function result(plugin: string, text: string) {
    return until(() => rows(plugin).find(row => row.querySelector(".result-title")?.textContent === text),
      `Actual native MainPush result missing: ${plugin}/${text}`);
  }
  try {
    await until(() => document.querySelector("[data-atools-search-input]"), "Actual App input missing");
    await phase("launcher-ready");
    check(fixture.capabilities.length === 3, "Native fixture imports exactly two originals and one explicit synthetic package");
    search("123+456");
    const calc = await result("calculation-paper", "579");
    await phase("original-calculator-result");
    await quietPermissions();
    const original = frame(calc);
    const before = await observe(original.frame);
    observations.originalCalcBeforeSelect = before;
    check(before.promotions === 0 && before.textareaValues.every(value => !value), "Original calculation-paper query does not enter the plugin");
    check(document.activeElement === input() && !before.hasFocus, "Hidden original calculation-paper does not take launcher focus");
    calc.click();
    const calcTool = fixture.capabilities.find(value => value.id === "calculation-paper")!.mainPush;
    await until(async () => (await invoke<Run[]>("list_task_runs", { limit: 1000 }))
      .some(run => (run.capabilityId ?? run.capability_id) === calcTool && run.input.operation === "select" && run.status === "succeeded"),
    "Original optional-select callback did not complete its actual native TaskRun");
    check(!original.wrapper.classList.contains("promoted"), "Original calculation-paper without a select callback remains in search");
    search("123+457");
    const next = await result("calculation-paper", "580");
    const reused = frame(next), afterQuery = await observe(reused.frame);
    check(reused.frame === original.frame && reused.window === original.window && before.documentId === afterQuery.documentId,
      "Repeated native queries reuse the exact original frame, Window and document");
    check(afterQuery.promotions === 0, "Repeated original queries still do not trigger plugin entry");
    const group = next.closest('[role="group"]');
    const open = group?.querySelector<HTMLButtonElement>(".group-enter");
    check(open, "Actual launcher group exposes the separate open-plugin action");
    open!.click();
    await until(() => original.wrapper.classList.contains("promoted"), "Original group action did not promote its current runner");
    const promotedCalc = await until(async () => {
      const state = await observe(original.frame);
      return state.promotions === 1 && state.textareaValues.some(value => value.includes("123+457")) ? state : null;
    }, "Original calculator did not receive exact current query on entry");
    check(original.frame.contentWindow === original.window && promotedCalc.documentId === before.documentId,
      "Original calculator promotion preserves its existing Window and document");
    observations.originalCalcPromoted = promotedCalc;
    await phase("original-calculator-promoted");
    document.querySelector<HTMLButtonElement>('[aria-label="返回搜索"]')!.click();
    await until(() => document.querySelector("[data-atools-search-input]"), "Return from original calculator did not restore search");

    search("fixture-needle");
    await until(() => rows("bookmarks").length === 2, "Original bookmarks did not read the two isolated browser files through actual Node");
    await phase("original-bookmarks-result");
    await quietPermissions();
    const bookmarkTexts = rows("bookmarks").map(row => row.querySelector(".result-title")?.textContent);
    check(bookmarkTexts.some(text => text?.includes("Chrome fixture-needle"))
      && bookmarkTexts.some(text => text?.includes("Edge fixture-needle")), "Original bookmarks preserves actual browser and URL fields in its source query result");
    const bookmarks = frame(rows("bookmarks")[0]);
    observations.originalBookmarks = { rows: bookmarkTexts, frame: await observe(bookmarks.frame) };
    check((await observe(bookmarks.frame)).promotions === 0, "Original bookmarks native query remains separate from plugin entry");
    check(support.delayedNode(), "A real visible Node permission wait exceeds five seconds without consuming the startup execution budget");

    search(fixture.privateQuery);
    const synthetic = await result("main-push-fixture", "Fixture same-page selection");
    await phase("synthetic-result");
    await quietPermissions();
    const selected = frame(synthetic), beforeSelection = await observe(selected.frame);
    check(beforeSelection.fixture?.ready === "1" && beforeSelection.fixture.enter === "0",
      "Query-only startup fires ready once and does not enter the synthetic plugin");
    check(document.activeElement === input() && !beforeSelection.hasFocus,
      "Startup window/input focus and autofocus do not steal focus from native launcher");
    synthetic.click(); synthetic.click();
    await until(() => selected.wrapper.classList.contains("promoted"), "Literal true selection did not promote the native runner");
    const entered = await until(async () => {
      const state = await observe(selected.frame);
      return state.fixture?.enter === "1" ? state : null;
    }, "Synthetic plugin did not observe exactly one entry");
    check(selected.frame.contentWindow === selected.window && entered.documentId === beforeSelection.documentId,
      "Literal true selection keeps the same actual Window, document and iframe location");
    check(entered.fixture?.select === "1" && entered.fixture.selectionVerified === "true"
      && entered.fixture.enterOptionVerified === "true" && entered.promotions === 1,
    "Double selection dispatches once and preserves the original option object closure through entry");
    observations.synthetic = { before: beforeSelection, after: entered };
    await phase("synthetic-promoted");
    document.querySelector<HTMLButtonElement>('[aria-label="返回搜索"]')!.click();
    await until(() => document.querySelector("[data-atools-search-input]"), "Synthetic plugin return did not restore search");
    search("");
    await until(() => !document.querySelector("[data-main-push-runner]"), "Returning and clearing search did not remove all runner documents");

    search(fixture.privateQuery);
    const removable = frame(await result("main-push-fixture", "Fixture same-page selection"));
    await invoke("toggle_plugin", { pluginId: "main-push-fixture", enabled: false });
    await until(() => !removable.frame.isConnected && rows("main-push-fixture").length === 0,
      "Disabling the plugin did not invalidate and detach its current native document");
    const candidates = await invoke<Array<{ pluginId: string }>>("search_plugin_main_push_candidates", { query: fixture.privateQuery });
    check(candidates.every(value => value.pluginId !== "main-push-fixture"), "Disabled plugin cannot remain an actual native MainPush candidate");
    await phase("disable-invalidated");
    search(""); await pause(100);
    observations.approvals = support.approvals;
    observations.scope = { guiInput: "programmatic fixture DOM events", hardwareHumanInputVerified: false,
      bookmarksSelection: "excluded from native smoke to avoid spawning browsers; original callback selection has separate browser sink coverage",
      nodePermissionDelayMs: 6500, timings: "Functional smoke includes explicit permission waits; not a matcher or paint benchmark" };
    return { passed: true, checks, observations };
  } catch (error) {
    observations.approvals = support.approvals;
    observations.bodyText = document.body.innerText.slice(0, 3000);
    return { passed: false, checks, observations, error: String(error instanceof Error ? error.stack : error) };
  }
}

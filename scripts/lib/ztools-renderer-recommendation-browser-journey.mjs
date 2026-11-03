import assert from "node:assert/strict";

export function createRendererRecommendationBrowserJourney({ page, evaluate, waitFor, settleRequests,
  origin, setDocumentKey, captureScreenshot, checks, diagnostics }) {
  const names = ["推荐夹具 A", "推荐夹具 B"];
  const section = "Array.from(document.querySelectorAll('.collapsible-section')).find(node => node.querySelector('.section-title')?.textContent?.trim() === '匹配推荐')";
  const rows = `Array.from((${section})?.querySelectorAll('.app-item .app-name') || []).map(node => node.textContent.trim())`;
  const state = () => evaluate("window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot()");
  async function navigate(version) {
    setDocumentKey(`recommendation-v${version}`);
    const loaded = page.waitForEvent("Page.loadEventFired", 20000);
    await page.send("Page.navigate", { url: `${origin}/?color=blue&scheme=dark&autoClear=never&recommendationFixture=1&recommendationVersion=${version}` });
    await loaded;
    await waitFor("document.querySelector('.search-input') && window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__?.snapshot()?.recommendation.active");
    await settleRequests();
    await evaluate("document.querySelector('.search-input').focus()");
    await page.send("Input.insertText", { text: "recommendation fixture" });
    await waitFor(`(${rows}).length === 2`);
  }
  async function choose(name, prefix, attempt) {
    const before = await state();
    const point = await evaluate(`(() => {
      const item = Array.from((${section})?.querySelectorAll('.app-item') || []).find(node => node.querySelector('.app-name')?.textContent.trim() === ${JSON.stringify(name)});
      if (!item) return null;
      item.scrollIntoView({ block: 'nearest' });
      const rect = item.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
    })()`);
    assert.ok(point && point.width > 0 && point.height > 0, "Original recommendation row must be rendered");
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "right", buttons: 2, clickCount: 1, x: point.x, y: point.y });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "right", buttons: 0, clickCount: 1, x: point.x, y: point.y });
    await waitFor(`window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot().contextMenus.length === ${before.contextMenus.length + 1}`);
    const menu = (await state()).contextMenus.at(-1);
    const action = menu.items.find(item => item.id?.startsWith(`${prefix}:`));
    assert.ok(action && action.enabled !== false, `Original ${prefix} menu must be enabled by the production bridge`);
    assert.ok(menu.replyPending, "Selection must precede the synthetic show reply");
    const payload = JSON.parse(action.id.slice(prefix.length + 1));
    assert.equal(payload.type, "plugin");
    assert.equal(payload.pluginName, "atools-recommendation-fixture");
    assert.equal(payload.name, name);
    assert.equal(await evaluate(`window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.chooseContextMenuAction(${JSON.stringify(action.id)})`), 1);
    await waitFor(`window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot().recommendation.attempts.length === ${attempt}`);
    await waitFor("window.__ATOOLS_ZTOOLS_HOST_ADAPTER__.snapshot().contextMenu.showInFlight === false");
    return payload;
  }
  async function assertOrder(expected) {
    await waitFor(`JSON.stringify(${rows}) === ${JSON.stringify(JSON.stringify(expected))}`);
    assert.deepEqual(await evaluate(rows), expected);
  }
  const storedNames = snapshot => (snapshot.recommendation.value ?? []).map(row => row.name);
  return { async run() {
    await navigate(1);
    await assertOrder(names);
    await choose(names[0], "pin-recommendation", 1);
    await waitFor("window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot().recommendation.value?.length === 1");
    assert.deepEqual(storedNames(await state()), [names[0]]);
    await choose(names[1], "pin-recommendation", 2);
    await waitFor("window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot().recommendation.value?.length === 2");
    await choose(names[1], "move-recommendation-to-front", 3);
    await assertOrder([names[1], names[0]]);
    const first = await state();
    assert.deepEqual(storedNames(first), [names[1], names[0]]);
    assert.equal(first.recommendation.attempts.filter(item => item.committed).length, 3);
    assert.deepEqual(first.recommendation.attempts.map(item => item.value.kind), ["append", "append", "moveToFront"]);
    assert.equal(first.recommendation.attempts[0].expected, null);
    assert.equal(first.recommendation.attempts[2].value.index, 1);
    assert.deepEqual(JSON.parse(first.recommendation.attempts[2].expected).map(row => row.name), names);
    await captureScreenshot("recommendation-moved-to-front");

    await navigate(2);
    await assertOrder([names[1], names[0]]);
    const reopened = await state();
    assert.equal(reopened.recommendation.path, "/fixture/plugins/recommendation-v2");
    assert.ok(reopened.recommendation.value.every(row => row.path === "/fixture/plugins/recommendation-v1"));
    await evaluate("window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.failNextRecommendationWrite()");
    const selected = await choose(names[1], "unpin-recommendation", 1);
    assert.equal(selected.path, "/fixture/plugins/recommendation-v2");
    await waitFor("window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot().recommendation.attempts[0]?.failed === true");
    await waitFor("window.__ATOOLS_ZTOOLS_HOST_ADAPTER__.snapshot().outstandingNativeCalls === 0");
    await assertOrder([names[1], names[0]]);
    assert.deepEqual(storedNames(await state()), [names[1], names[0]]);
    const failurePattern = entry => entry.documentKey === "recommendation-v2"
      && entry.text.includes("取消匹配推荐置顶失败:") && entry.text.includes("RECOMMENDATION_PINS_SAVE_FAILED");
    await waitFor("window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot().recommendation.attempts.length === 1");
    const index = diagnostics.errors.findIndex(failurePattern);
    assert.ok(index >= 0, "Original consumer must report the one deliberately failed write");
    const [expectedError] = diagnostics.errors.splice(index, 1);
    (diagnostics.expectedFailures ??= []).push({ scope: "recommendation-unpin-fixed-failure", ...expectedError });
    await captureScreenshot("recommendation-write-failure-rollback");

    await choose(names[1], "unpin-recommendation", 2);
    await assertOrder(names);
    await waitFor("window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot().recommendation.value?.length === 1");
    await choose(names[0], "unpin-recommendation", 3);
    await waitFor("window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot().recommendation.value?.length === 0");
    const final = await state();
    assert.equal(final.recommendation.attempts.filter(item => item.committed).length, 2);
    assert.equal(final.recommendation.attempts.filter(item => item.failed).length, 1);
    assert.deepEqual(final.recommendation.attempts.map(item => item.value), Array(3).fill({ kind: "remove", index: 0 }));
    assert.equal(final.recommendation.attempts[0].expected, final.recommendation.attempts[1].expected);
    assert.equal(final.recommendation.attempts[0].expected, JSON.stringify(first.recommendation.value));
    for (const item of [first, reopened, final]) {
      assert.equal(item.appState.values["command-history"], null);
      assert.equal(item.appState.values["pinned-commands"], null);
      assert.equal(item.agentToolIntents.length, 0);
      assert.equal(item.appLaunchIntents.length, 0);
      assert.equal(item.settingsBatchLoads, 1);
    }
    await captureScreenshot("recommendation-unpinned");
    checks.push("Original recommendation context menus persisted pin/move/unpin through the dedicated single-write bridge without app-state writes or plugin activation");
    checks.push("A fresh Main document with a changed plugin path retained stable recommendation identities/order; a deliberate write failure rolled back before a successful retry");
    checks.push("Original Store writes became append/move/remove operations with exact raw CAS baselines; a rejected write retained the baseline for retry");
    return { fixtureKind: "synthetic-native-transport/private-fixture-localStorage", native: false, rust: false,
      originalMenuAndStore: true, firstDocumentWrites: first.recommendation.attempts,
      reopenedStoredPaths: reopened.recommendation.value.map(row => row.path), currentPluginPath: reopened.recommendation.path,
      finalDocumentWrites: final.recommendation.attempts, committedWrites: 5, failedWrites: 1,
      failureRolledBack: true, independentAppStateUnchanged: true, pluginsActivated: 0 };
  } };
}

import assert from "node:assert/strict";

export function createRendererAppStateBrowserFlow({
  page,
  evaluate,
  waitFor,
  delay,
  checks,
  appName,
  aliasName,
  appPath,
  updatedAliasName,
}) {
  async function clickSearchAndReplace(text) {
    await evaluate("document.querySelector('.search-input')?.focus()");
    await page.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2,
    });
    await page.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2,
    });
    await page.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2,
    });
    await page.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17,
    });
    await page.send("Input.insertText", { text });
    await waitFor(`document.querySelector('.search-input')?.value === ${JSON.stringify(text)}`);
    await waitFor(`Array.from(document.querySelectorAll('.search-results .app-item')).some(item=>item.innerText.includes(${JSON.stringify(text)}))`);
  }

  async function pressKey(key, code, virtualKeyCode) {
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: virtualKeyCode });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtualKeyCode });
  }

  async function sectionItemBox(sectionTitle, appLabel) {
    const box = await evaluate(`(()=>{
      const section = Array.from(document.querySelectorAll('.content-section .collapsible-section'))
        .find(node => node.querySelector('.section-title')?.textContent?.trim() === ${JSON.stringify(sectionTitle)});
      const item = Array.from(section?.querySelectorAll('.app-item') || [])
        .find(node => node.querySelector('.app-name')?.textContent?.trim() === ${JSON.stringify(appLabel)});
      if (!item) return null;
      item.scrollIntoView({block:'nearest'});
      const rect = item.getBoundingClientRect();
      return {x:rect.left+rect.width/2,y:rect.top+rect.height/2,width:rect.width,height:rect.height,viewport:{width:innerWidth,height:innerHeight}};
    })()`);
    assert.ok(box && box.width > 0 && box.height > 0 && box.x >= 0 && box.x <= box.viewport.width
      && box.y >= 0 && box.y <= box.viewport.height, `Could not locate ${appLabel} under ${sectionTitle}`);
    return box;
  }

  async function rightClickSectionItem(sectionTitle, appLabel) {
    const box = await sectionItemBox(sectionTitle, appLabel);
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    await page.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: box.x, y: box.y, button: "right", buttons: 2, clickCount: 1,
    });
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: box.x, y: box.y, button: "right", buttons: 0, clickCount: 1,
    });
  }

  async function chooseNativeAction(sectionTitle, appLabel, actionPrefix, nextMutationCount) {
    const before = await evaluate("window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot().contextMenus.length");
    await rightClickSectionItem(sectionTitle, appLabel);
    await waitFor(`window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__?.snapshot().contextMenus.length===${before + 1}`);
    const menu = await evaluate(`window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot().contextMenus.at(-1)`);
    assert.equal(menu.replyPending, true, "Native menu selection must be exercised before its show reply resolves");
    const item = menu.items.find(entry => typeof entry.id === "string" && entry.id.startsWith(actionPrefix));
    assert.ok(item, `Original right-click menu did not expose ${actionPrefix}`);
    await waitFor("window.__ATOOLS_ZTOOLS_HOST_ADAPTER__?.snapshot().contextMenu?.whitelistedCommands > 0");
    const actionData = JSON.parse(item.id.slice(actionPrefix.length));
    assert.equal(actionData.path, appPath, `${actionPrefix} must retain the fixture catalog path`);
    if (appLabel === aliasName) assert.equal(actionData.name, aliasName, `${actionPrefix} must retain the same-path alias name`);
    const deliveries = await evaluate(`window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.chooseContextMenuAction(${JSON.stringify(item.id)})`);
    assert.equal(deliveries, 1, "A selected fixture menu action must reach exactly one registered native event handler");
    await waitFor(`window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__?.snapshot().appStateMutations.length===${nextMutationCount}`);
    await waitFor(`window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__?.snapshot().contextMenuRepliesResolved===${before + 1}`);
    await waitFor("window.__ATOOLS_ZTOOLS_HOST_ADAPTER__?.snapshot().contextMenu?.showInFlight === false");
    return { actionId: item.id, actionData };
  }

  async function homeSectionNames(sectionTitle) {
    return evaluate(`(()=>{
      const section = Array.from(document.querySelectorAll('.content-section .collapsible-section'))
        .find(node => node.querySelector('.section-title')?.textContent?.trim() === ${JSON.stringify(sectionTitle)});
      return Array.from(section?.querySelectorAll('.app-item .app-name') || []).map(node => node.textContent.trim());
    })()`);
  }

  async function pinFrom(section, appLabel, mutationIndex) {
    const result = await chooseNativeAction(section, appLabel, "pin-app:", mutationIndex);
    await waitFor(`(()=>Array.from(document.querySelectorAll('.content-section .collapsible-section'))
      .find(node=>node.querySelector('.section-title')?.textContent?.trim()==='已固定')
      ?.querySelectorAll('.app-item .app-name') && Array.from(Array.from(document.querySelectorAll('.content-section .collapsible-section'))
      .find(node=>node.querySelector('.section-title')?.textContent?.trim()==='已固定')
      ?.querySelectorAll('.app-item .app-name')||[]).some(node=>node.textContent.trim()===${JSON.stringify(appLabel)}))()`);
    return result;
  }

  async function tryPointerReorder(expectedMutationCount) {
    const first = await sectionItemBox("已固定", aliasName);
    const second = await sectionItemBox("已固定", appName);
    const steps = 8;
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: first.x, y: first.y });
    await page.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: first.x, y: first.y, button: "left", buttons: 1, clickCount: 1,
    });
    for (let step = 1; step <= steps; step += 1) {
      const progress = step / steps;
      await page.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: first.x + (second.x - first.x) * progress,
        y: first.y + (second.y - first.y) * progress,
        button: "left",
        buttons: 1,
      });
      await delay(35);
    }
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: second.x, y: second.y, button: "left", buttons: 0, clickCount: 1,
    });
    await delay(700);
    const state = await evaluate("window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot()");
    const mutation = state.appStateMutations[expectedMutationCount - 1];
    if (mutation?.request?.operation !== "reorder_pins") {
      return { attempted: true, confirmed: false, nativeReorderReceived: false };
    }
    assert.deepEqual(mutation.request.apps.map(app => app.name), [appName, aliasName],
      "A real pointer reorder must submit the changed same-path alias sequence");
    const displayed = await homeSectionNames("已固定");
    assert.deepEqual(displayed, [appName, aliasName], "Original draggable list must display the native-accepted order");
    return { attempted: true, confirmed: true, nativeReorderReceived: true, names: displayed };
  }

  async function run() {
    const initial = await evaluate("window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot()");
    const initialHistory = JSON.parse(initial.appState.values["command-history"]);
    assert.equal(initialHistory.length, 1,
      "The preceding direct and keyboard launches must share one native history identity");
    assert.deepEqual({ path: initialHistory[0].path, name: initialHistory[0].name },
      { path: appPath, name: appName });
    assert.equal(initialHistory[0].useCount, 2,
      "The direct receipt and the preceding keyboard launch must both update canonical app history");
    assert.equal(initial.appState.values["pinned-commands"], null);
    assert.equal(initial.appState.revision, 2);
    assert.deepEqual(initial.appStateReceipts.map(receipt => receipt.changed), [
      ["command-history"], ["command-history"],
    ]);
    assert.deepEqual(initial.appCatalog, [{ name: appName, path: appPath, icon: null }],
      "The native catalog must contain one canonical app record");
    const commandId = `direct:app:${appPath.replace(/\\/g, "/")}`;
    assert.deepEqual(initial.commandAliases, { [commandId]: [{ alias: aliasName }] },
      "The same-path name must be supplied by the original command-aliases preference");
    assert.deepEqual(initial.settingsBatchSummary.commandAliases, initial.commandAliases,
      "The batched renderer settings snapshot must preload the exact configured alias");

    await waitFor(`(()=>Array.from(document.querySelectorAll('.content-section .collapsible-section'))
      .find(section=>section.querySelector('.section-title')?.textContent?.trim()==='最近使用')
      ?.querySelector('.app-item .app-name')?.textContent?.trim()===${JSON.stringify(appName)})()`);
    let recent = await homeSectionNames("最近使用");
    assert.ok(recent.includes(appName), "The original launch must be visible in the original recent-use section");
    await clickSearchAndReplace(aliasName);
    await pressKey("ArrowDown", "ArrowDown", 40);
    await pressKey("Enter", "Enter", 13);
    await waitFor("window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__?.snapshot().appLaunchIntents.length===3");
    await waitFor("window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__?.snapshot().settingWrites.length===2");
    const afterAliasLaunch = await evaluate("window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot()");
    assert.deepEqual(afterAliasLaunch.appLaunchIntents.map(entry => entry.target), [
      { path: appPath, name: appName }, { path: appPath, name: appName }, { path: appPath, name: aliasName },
    ], "Original launcher must send the selected display name with the shared path");
    const launchHistory = JSON.parse(afterAliasLaunch.appState.values["command-history"]);
    assert.deepEqual(launchHistory.map(entry => entry.name).sort(), [appName, aliasName].sort(),
      "Native launch receipts must preserve both aliases by path and name");
    assert.equal(launchHistory.find(entry => entry.name === appName)?.useCount, 2);
    assert.equal(launchHistory.find(entry => entry.name === aliasName)?.useCount, 1);
    assert.ok(launchHistory[0].lastUsed >= launchHistory[1].lastUsed,
      "Recent rows must be sorted by last-used time");
    assert.deepEqual(afterAliasLaunch.settingWrites.map(write => write.entryCount), [1, 2],
      "The original preference store must persist the main and alias search records together");
    assert.ok(afterAliasLaunch.settingWrites.every(write => write.entriesMatchFixtureAppNames),
      "Every search preference must map to the canonical app or its configured alias");

    await pressKey("Escape", "Escape", 27);
    await waitFor("document.querySelector('.search-input')?.value === ''");
    await waitFor(`(()=>Array.from(document.querySelectorAll('.content-section .collapsible-section'))
      .find(section=>section.querySelector('.section-title')?.textContent?.trim()==='最近使用')
      ?.querySelectorAll('.app-item .app-name')?.length===2)()`);
    recent = await homeSectionNames("最近使用");
    assert.deepEqual(new Set(recent), new Set([appName, aliasName]),
      "The original home section must render both same-path name aliases");

    const pinAlias = await pinFrom("最近使用", aliasName, 1);
    const pinApp = await pinFrom("最近使用", appName, 2);
    assert.equal(pinAlias.actionData.name, aliasName);
    assert.equal(pinApp.actionData.name, appName);
    const pointerReorder = await tryPointerReorder(3);

    const unpin = await chooseNativeAction("已固定", aliasName, "unpin-app:", pointerReorder.confirmed ? 4 : 3);
    assert.equal(unpin.actionData.name, aliasName, "Unpin must identify one same-path alias");
    await waitFor(`!Array.from(document.querySelectorAll('.content-section .collapsible-section'))
      .find(node=>node.querySelector('.section-title')?.textContent?.trim()==='已固定')
      ?.querySelectorAll('.app-item .app-name')?.length
      || Array.from(Array.from(document.querySelectorAll('.content-section .collapsible-section'))
        .find(node=>node.querySelector('.section-title')?.textContent?.trim()==='已固定')
        ?.querySelectorAll('.app-item .app-name')||[]).every(node=>node.textContent.trim()!==${JSON.stringify(aliasName)})`);

    const remove = await chooseNativeAction("最近使用", aliasName, "remove-from-history:", pointerReorder.confirmed ? 5 : 4);
    assert.equal(remove.actionData.name, aliasName, "History removal must identify one same-path alias");
    await waitFor(`!Array.from(document.querySelectorAll('.content-section .collapsible-section'))
      .find(node=>node.querySelector('.section-title')?.textContent?.trim()==='最近使用')
      ?.querySelectorAll('.app-item .app-name')?.length
      || Array.from(Array.from(document.querySelectorAll('.content-section .collapsible-section'))
        .find(node=>node.querySelector('.section-title')?.textContent?.trim()==='最近使用')
        ?.querySelectorAll('.app-item .app-name')||[]).every(node=>node.textContent.trim()!==${JSON.stringify(aliasName)})`);

    const final = await evaluate("window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot()");
    const history = JSON.parse(final.appState.values["command-history"]);
    const pins = JSON.parse(final.appState.values["pinned-commands"]);
    assert.deepEqual(history.map(entry => entry.name), [appName], "Removing one alias must preserve its same-path sibling history");
    assert.deepEqual(pins.map(entry => entry.name), [appName], "Unpinning one alias must preserve its same-path sibling pin");
    assert.deepEqual(JSON.parse(final.pluginUsageSetting), [
      { path: "/fixture/plugins/usage-example", featureCode: "usage-example", useCount: 7 },
    ], "Direct app launches must leave existing plugin usage statistics untouched");
    assert.deepEqual(final.appStateReceipts.map(receipt => receipt.revision),
      final.appStateReceipts.map((_, index) => index + 1), "Native app-state revisions must advance once per changed transaction");
    assert.equal(final.calls.filter(call => call.command === "launch_renderer_app").length, 4,
      "One failed and three successful original launch attempts must each use one native coordinator call");
    assert.equal(final.calls.filter(call => call.command === "mutate_renderer_app_state").length,
      final.appStateMutations.length, "Each app-state mutation must be sent exactly once");
    assert.equal(final.calls.filter(call => call.command === "set_setting").length, 2,
      "The two original same-path names must each write one bounded search-preference snapshot");
    assert.equal(final.settingWrites.length, 2);
    assert.deepEqual(final.rejected, ["get_setting", "shell_open", "call_agent_tool", "call_agent_tool"],
      "Only the deliberate unsupported-route probes may be rejected by the fixture");
    assert.equal(final.emittedEvents["atools://renderer-app-state"], final.appStateReceipts.length);
    assert.equal(final.deliveredEvents["atools://renderer-app-state"], final.appStateReceipts.length,
      "Each native app-state event must reach the shared app-state listener once");
    assert.equal(final.deliveredEvents["atools://renderer-context-menu"], final.contextMenuSelections.length,
      "Each selected native-menu fixture action must reach the original event consumer");
    assert.equal(final.contextMenuRepliesResolved, final.contextMenuSelections.length,
      "Every context-menu show reply must resolve only after its fixture selection");
    assert.equal(final.contextMenus.length, final.contextMenuSelections.length);
    assert.ok(final.contextMenus.every(menu => menu.replyPending === false),
      "No fixture menu RPC may remain pending after the original handler completes");
    const expectedMutations = pointerReorder.confirmed
      ? ["pin", "pin", "reorder_pins", "unpin", "remove_history"]
      : ["pin", "pin", "unpin", "remove_history"];
    assert.deepEqual(final.appStateMutations.map(entry => entry.request.operation), expectedMutations,
      "The original app menus and optional drag must each submit exactly one bounded mutation");
    assert.deepEqual(final.appStateMutations[0].request.app, { path: appPath, name: aliasName });
    assert.deepEqual(final.appStateMutations[1].request.app, { path: appPath, name: appName });

    checks.push("Original Vue rendered a canonical app and its configured same-path alias in Recent, launched each through one native coordinator call, and persisted both names separately");
    checks.push("Original Vue app-item context menus selected fixture-native pin, unpin, and remove actions; the exact alias changed while its same-path sibling stayed intact");
    checks.push(pointerReorder.confirmed
      ? "A real CDP pointer drag reordered the original vuedraggable pin list and submitted the full new order"
      : "A real CDP pointer drag was attempted; Sortable did not submit a reorder, so drag ordering remains unverified");
    const beforeAliasRefresh = await evaluate(`({fixture:window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot(),adapter:window.__ATOOLS_ZTOOLS_HOST_ADAPTER__.snapshot()})`);
    const aliasEventReceipt = await evaluate(`window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.updateCommandAliases(${JSON.stringify(updatedAliasName)})`);
    assert.deepEqual(aliasEventReceipt, { delivered: 1, payloadIsNull: true },
      "The fixture must emit one strict-null synthetic alias-change notification");
    await waitFor(`window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__?.snapshot().settingsBatchLoads===${beforeAliasRefresh.fixture.settingsBatchLoads + 1}`);
    await clickSearchAndReplace(updatedAliasName);
    const aliasRefresh = await evaluate(`({
      fixture:window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot(),
      adapter:window.__ATOOLS_ZTOOLS_HOST_ADAPTER__.snapshot(),
      visible:Array.from(document.querySelectorAll('.search-results .app-item')).map(item=>item.innerText)
    })`);
    assert.deepEqual(aliasRefresh.fixture.commandAliases, {
      [`direct:app:${appPath.replace(/\\/g, "/")}`]: [{ alias: updatedAliasName }],
    });
    assert.ok(aliasRefresh.visible.some(text => text.includes(updatedAliasName)),
      "The original Main search must show the updated alias after the native notification");
    assert.equal(aliasRefresh.fixture.calls.filter(call => call.command === "list_launcher_apps").length, 1,
      "An alias event must not request or rescan the app catalog");
    assert.equal(aliasRefresh.adapter.appCatalog.invalidations, 0,
      "An alias event must leave the app-catalog cache valid");
    assert.equal(aliasRefresh.fixture.settingsBatchLoads, beforeAliasRefresh.fixture.settingsBatchLoads + 1,
      "The alias event should refresh one batched settings snapshot");
    assert.equal(aliasRefresh.adapter.commandAliasEvents.deliveredEvents, 1);
    checks.push("The original Vue Main search displayed an updated alias after one synthetic strict-null event; aliases refreshed through one new settings batch without another getApps/list_launcher_apps call");
    return {
      launchHistory,
      finalHistory: history,
      finalPins: pins,
      mutationOperations: final.appStateMutations.map(entry => entry.request.operation),
      revisions: final.appStateReceipts.map(receipt => receipt.revision),
      contextMenuSelections: final.contextMenuSelections.length,
      pointerReorder,
      finalAppStateDiagnostics: final.appState,
      aliasRefresh: {
        name: updatedAliasName,
        emitted: aliasRefresh.fixture.emittedEvents["atools://renderer-command-aliases"],
        delivered: aliasRefresh.fixture.deliveredEvents["atools://renderer-command-aliases"],
        settingsBatchDelta: aliasRefresh.fixture.settingsBatchLoads - beforeAliasRefresh.fixture.settingsBatchLoads,
        appCatalogReads: aliasRefresh.fixture.calls.filter(call => call.command === "list_launcher_apps").length,
        visible: aliasRefresh.visible,
      },
    };
  }

  return { run };
}

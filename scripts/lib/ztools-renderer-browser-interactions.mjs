import assert from "node:assert/strict";
import { createRendererAppStateBrowserFlow } from "./ztools-renderer-app-state-browser.mjs";
import {
  assertRendererCallbackCapabilities,
  assertRendererEventListeners,
} from "./ztools-renderer-browser-page.mjs";

export function createZtoolsRendererBrowserInteractions({
  page,
  evaluate,
  waitFor,
  delay,
  captureScreenshot,
  checks,
  fixtureAppName,
  fixtureAppAliasName,
  fixtureUpdatedAliasName,
  fixtureAppPath,
  eventNames,
}) {
  async function clickSelector(selector) {
    const box = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);return{x,y,width:r.width,height:r.height,hit:h===el||el.contains(h),disabled:el.disabled===true,inside:x>=0&&x<=innerWidth&&y>=0&&y<=innerHeight}})()`);
    assert.ok(box, `Missing renderer interaction target ${selector}`);
    assert.ok(box.width > 0 && box.height > 0 && box.hit && box.inside && !box.disabled,
      `Interaction target is not usable: ${JSON.stringify(box)}`);
    await page.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1,
    });
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: box.x, y: box.y, button: "left", buttons: 0, clickCount: 1,
    });
  }

  async function key(keyValue, code, virtualKeyCode) {
    await page.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: keyValue, code, windowsVirtualKeyCode: virtualKeyCode,
    });
    await page.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: keyValue, code, windowsVirtualKeyCode: virtualKeyCode,
    });
  }

  function assertFocusDiagnostics(adapterSnapshot, listenerState) {
    const focus = adapterSnapshot?.focusEvents;
    assert.ok(focus, "Adapter focus diagnostics were not available");
    assert.equal(focus.listenerState, listenerState,
      `Focus listener state should be ${listenerState}`);
    assert.equal(focus.registrationErrors, 0, "Focus listener registration must succeed");
    assert.equal(focus.registrationsPending, 0, "Focus listener registration must settle");
    assert.equal(focus.cleanupPending, 0, "Focus listener cleanup must settle");
    assert.equal(focus.cleanupErrors, 0, "Focus listener cleanup must not record errors");
    assert.equal(focus.callbackErrors, 0, "Focus callbacks must not record errors");
  }

  function assertAppEventDiagnostics(adapterSnapshot, listenerState) {
    const sources = [
      adapterSnapshot?.appState?.eventSource,
      adapterSnapshot?.contextMenu?.eventSource,
      adapterSnapshot?.appCatalog?.eventSource,
      adapterSnapshot?.appLaunched?.eventSource,
    ];
    assert.ok(sources.every(Boolean), "App-state, app-launch, app-catalog, and context-menu listener diagnostics must be exposed");
    for (const [index, source] of sources.entries()) {
      assert.equal(source.listenerState, listenerState);
      if (index < 2) {
        assert.equal(source.subscribers, listenerState === "listening" ? 1 : 0,
          "App-state and context-menu must keep one internal event subscriber");
      } else if (index === 2 && listenerState === "listening") {
        assert.ok(source.subscribers >= 1, "App catalog must retain its invalidation subscriber");
      } else assert.equal(source.subscribers, listenerState === "listening" ? 1 : 0);
      assert.equal(source.registrationErrors, 0);
      assert.equal(source.callbackErrors, 0);
      assert.equal(source.registrationsPending, 0);
      assert.equal(source.cleanupPending, 0);
      assert.equal(source.cleanupErrors, 0);
      if (listenerState === "listening") assert.ok(source.subscribers > 0);
      else assert.equal(source.subscribers, 0);
    }
    if (listenerState === "disposed") {
      assert.equal(adapterSnapshot.appState.queuedMutations, 0);
      assert.equal(adapterSnapshot.appState.callbackErrors, 0);
      assert.equal(adapterSnapshot.appState.invalidPayloads, 0);
      assert.equal(adapterSnapshot.appState.mutationFailures, 0);
      assert.equal(adapterSnapshot.contextMenu.showInFlight, false);
      assert.equal(adapterSnapshot.contextMenu.subscribers, 0);
      assert.equal(adapterSnapshot.contextMenu.callbackErrors, 0);
      assert.equal(adapterSnapshot.contextMenu.showFailures, 0);
      assert.equal(adapterSnapshot.contextMenu.ignoredEvents, 0);
      assert.equal(adapterSnapshot.contextMenu.invalidEvents, 0);
      assert.equal(adapterSnapshot.appCatalog.readPending, false);
      assert.equal(adapterSnapshot.settingsView.listenerState, "disposed");
      assert.equal(adapterSnapshot.appLaunched.invalidPayloads, 0);
    }
  }

  function assertOnlyFocusResizeDelta(before, after) {
    const commands = new Set([
      ...Object.keys(before.adapter.nativeCalls),
      ...Object.keys(after.adapter.nativeCalls),
    ]);
    const delta = {};
    for (const command of commands) {
      const amount = (after.adapter.nativeCalls[command] ?? 0)
        - (before.adapter.nativeCalls[command] ?? 0);
      if (amount !== 0) delta[command] = amount;
    }
    assert.ok(Object.keys(delta).every(command => command === "expand_window"),
      `Focus changed an unexpected native command count: ${JSON.stringify(delta)}`);
    const resizeDelta = delta.expand_window ?? 0;
    assert.ok(Number.isInteger(resizeDelta) && resizeDelta >= 0,
      "Focus layout resize count must be a non-negative integer");

    const beforeResizeCount = before.fixture.calls
      .filter(call => call.command === "expand_window").length;
    const afterResizeCalls = after.fixture.calls
      .filter(call => call.command === "expand_window").slice(beforeResizeCount);
    assert.equal(afterResizeCalls.length, resizeDelta,
      "Fixture resize records must match the expand_window native command delta");
    assert.ok(afterResizeCalls.every(call => Number.isInteger(call.args?.height)
      && call.args.height > 0 && call.args.height <= 10_000),
    "Every focus-related layout resize height must remain within the fixture bound");

    return {
      nativeCommandDelta: delta,
      expandWindowCalls: afterResizeCalls.length,
      resizeHeights: afterResizeCalls.map(call => call.args.height),
    };
  }

  async function settleLayoutAndNativeCalls() {
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await waitFor("window.__ATOOLS_ZTOOLS_HOST_ADAPTER__?.snapshot().outstandingNativeCalls === 0");
  }

  async function exerciseSearchAndWindowRoutes() {
    const fixtureAppTool = {
      name: "open_or_reveal_path",
      arguments: { path: fixtureAppPath, reveal: false },
      clientId: "atools-ui",
      confirmed: true,
    };
    const rejectedRoutes = await evaluate(`(async () => {
      const invoke = window.__ATOOLS_ZTOOLS_RENDERER_TRANSPORT__.invoke;
      const fixed = ${JSON.stringify(fixtureAppTool)};
      const rejected = async (command, args) => {
        try { await invoke(command, args); return false; } catch { return true; }
      };
      return [
        await rejected("get_setting", { key: "settings-general" }),
        await rejected("shell_open", { url: fixed.arguments.path }),
        await rejected("call_agent_tool", { ...fixed, name: "run_shell" }),
        await rejected("call_agent_tool", { ...fixed, extra: true }),
      ];
    })()`);
    assert.deepEqual(rejectedRoutes, [true, true, true, true],
      "Fixture must reject legacy get_setting, shell_open, arbitrary tools, and extra arguments");
    checks.push("The fixture rejected legacy get_setting, shell_open, an arbitrary agent tool, and extra route arguments");

    const initial = await evaluate(`({fixture:window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot(),adapter:window.__ATOOLS_ZTOOLS_HOST_ADAPTER__.snapshot()})`);
    assert.equal(initial.fixture.autoClear, "never",
      "Launch-return verification must run with autoClear=never");
    assertRendererEventListeners(initial.fixture, initial.adapter, eventNames, "listening");
    await clickSelector(".search-input");
    await page.send("Input.insertText", { text: fixtureAppName });
    await waitFor(`document.querySelector('.search-input')?.value === ${JSON.stringify(fixtureAppName)}`);
    await page.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: "f", code: "KeyF", windowsVirtualKeyCode: 70, modifiers: 4,
    });
    await page.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: "f", code: "KeyF", windowsVirtualKeyCode: 70, modifiers: 4,
    });
    await waitFor(`document.querySelector('.search-input')?.value === '' && document.querySelector('.pasted-text')?.innerText.includes(${JSON.stringify(fixtureAppName)})`);
    const failedLaunchWasRejected = await evaluate(`(()=>{
      const fixture = window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__;
      fixture.failNextLaunch();
      return window.ztools.launch({type:"app",path:${JSON.stringify(fixtureAppPath)},name:${JSON.stringify(fixtureAppName)}})
        .then(()=>false,()=>true);
    })()`);
    assert.equal(failedLaunchWasRejected, true, "The first bounded launch attempt must fail in the fixture");
    const afterFailure = await evaluate(`({fixture:window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot(),adapter:window.__ATOOLS_ZTOOLS_HOST_ADAPTER__.snapshot(),dom:{value:document.querySelector('.search-input')?.value,pastedText:document.querySelector('.pasted-text')?.innerText||''}})`);
    assert.equal(afterFailure.fixture.launchFailures, 1);
    assert.equal(afterFailure.fixture.emittedEvents["atools://renderer-app-launched"], 0);
    assert.equal(afterFailure.fixture.deliveredEvents["atools://renderer-app-launched"], 0);
    assert.deepEqual(afterFailure.dom, { value: "", pastedText: fixtureAppName },
      "A failed launch receipt must leave the original pasted search state intact");
    assert.equal(afterFailure.fixture.appLaunchIntents.length, 0);
    assert.equal(afterFailure.adapter.nativeCalls.launch_renderer_app, 1,
      "The failed direct coordinator attempt must be the only launch request before retry");

    const directLaunchSucceeded = await evaluate(`window.ztools.launch({type:"app",path:${JSON.stringify(fixtureAppPath)},name:${JSON.stringify(fixtureAppName)}}).then(()=>true,()=>false)`);
    assert.equal(directLaunchSucceeded, true, "The fixture must return one successful direct launch receipt");
    await waitFor(`window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__?.snapshot().appLaunchIntents.length===1 && window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__?.snapshot().deliveredEvents["atools://renderer-app-launched"]===1 && document.querySelector('.search-input')?.value === '' && !document.querySelector('.pasted-text') && !document.querySelector('.pasted-files') && !document.querySelector('.pasted-image-thumbnail')`);
    const afterDirectLaunch = await evaluate(`({fixture:window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot(),adapter:window.__ATOOLS_ZTOOLS_HOST_ADAPTER__.snapshot()})`);
    const canonicalIntent = {
      target: { path: fixtureAppPath, name: fixtureAppName },
      taskRunPersisted: false,
      processOpened: false,
    };
    assert.deepEqual(afterDirectLaunch.fixture.appLaunchIntents, [canonicalIntent],
      "The successful direct fixture receipt must represent one bounded catalog app launch");
    assert.equal(afterDirectLaunch.fixture.launchFailures, 1);
    assert.equal(afterDirectLaunch.adapter.nativeCalls.launch_renderer_app, 2,
      "One failed and one successful direct attempt must make two native coordinator calls");
    assert.equal(afterDirectLaunch.fixture.calls.filter(call => call.command === "launch_renderer_app").length, 2);
    assert.equal(afterDirectLaunch.fixture.appState.revision, 1);
    assert.deepEqual(afterDirectLaunch.fixture.appStateReceipts.map(receipt => receipt.revision), [1]);
    assert.equal(afterDirectLaunch.fixture.emittedEvents["atools://renderer-app-launched"], 1);
    assert.equal(afterDirectLaunch.fixture.deliveredEvents["atools://renderer-app-launched"], 1);
    assert.equal(afterDirectLaunch.adapter.appLaunched.eventSource.deliveredEvents, 1);
    assert.equal(afterDirectLaunch.adapter.appLaunched.invalidPayloads, 0);
    assertRendererEventListeners(afterDirectLaunch.fixture, afterDirectLaunch.adapter, eventNames, "listening");
    assertAppEventDiagnostics(afterDirectLaunch.adapter, "listening");
    assert.equal(afterDirectLaunch.adapter.outstandingNativeCalls, 0);

    await clickSelector(".search-input");
    await page.send("Input.insertText", { text: fixtureAppName });
    await waitFor(`document.querySelector('.search-input')?.value === ${JSON.stringify(fixtureAppName)}`);
    await waitFor(`Array.from(document.querySelectorAll('.app-item')).some(item=>item.innerText.includes(${JSON.stringify(fixtureAppName)}))`);
    await key("ArrowDown", "ArrowDown", 40);
    await waitFor(`Array.from(document.querySelectorAll('.app-item.selected')).some(item=>item.innerText.includes(${JSON.stringify(fixtureAppName)}))`);
    const selected = await evaluate("document.querySelector('.app-item.selected')?.innerText || ''");
    assert.ok(selected.includes(fixtureAppName), `Keyboard selection did not focus the fixture app: ${selected}`);
    await captureScreenshot("dark-blue-search-selected");
    await key("Enter", "Enter", 13);
    await waitFor(`window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__?.snapshot().appLaunchIntents.length===2 && window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__?.snapshot().deliveredEvents["atools://renderer-app-launched"]===2 && document.querySelector('.search-input')?.value === '' && !document.querySelector('.pasted-text') && !document.querySelector('.pasted-files') && !document.querySelector('.pasted-image-thumbnail')`);
    const afterLaunch = await evaluate(`({fixture:window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot(),adapter:window.__ATOOLS_ZTOOLS_HOST_ADAPTER__.snapshot()})`);
    assert.deepEqual(afterLaunch.fixture.appLaunchIntents, [canonicalIntent, canonicalIntent],
      "Enter must request a second catalog-validated app launch intent through original result selection");
    assert.equal(afterLaunch.fixture.launchFailures, 1);
    assert.equal(afterLaunch.adapter.nativeCalls.launch_renderer_app, 3,
      "One failed attempt and two successful launches must make three native coordinator calls");
    assert.equal(afterLaunch.adapter.nativeCalls.call_agent_tool ?? 0, 0,
      "Plain app launch must not use the generic agent tool route");
    assert.equal(afterLaunch.fixture.settingsBatchLoads, 1,
      "Original startup must read the settings snapshot once");
    assert.equal(afterLaunch.fixture.calls.filter(call => call.command === "list_launcher_apps").length, 1,
      "Original startup must load launcher apps once");
    assert.equal(afterLaunch.fixture.calls.filter(call => call.command === "list_plugins").length, 1,
      "Original startup must load plugins once");
    assert.equal(afterLaunch.fixture.calls.filter(call => call.command === "launch_renderer_app").length, 3,
      "The failed direct attempt and two successful launch paths must be coordinated exactly once each");
    assert.equal(afterLaunch.fixture.appState.revision, 2);
    assert.deepEqual(afterLaunch.fixture.appStateReceipts.map(receipt => receipt.revision), [1, 2]);
    assert.equal(afterLaunch.fixture.emittedEvents["atools://renderer-app-launched"], 2);
    assert.equal(afterLaunch.fixture.deliveredEvents["atools://renderer-app-launched"], 2);
    assert.equal(afterLaunch.adapter.appLaunched.eventSource.deliveredEvents, 2);
    assert.equal(afterLaunch.adapter.appLaunched.invalidPayloads, 0);
    assertRendererEventListeners(afterLaunch.fixture, afterLaunch.adapter, eventNames, "listening");
    assertAppEventDiagnostics(afterLaunch.adapter, "listening");
    assert.equal(afterLaunch.fixture.calls.filter(call => call.command === "get_setting").length, 1,
      "Only the explicit legacy-route rejection probe may call get_setting");
    assert.equal(afterLaunch.fixture.settingWrites.length, 1,
      "The original app may request only its bounded search-preference write");
    assert.deepEqual(afterLaunch.fixture.settingWrites[0], {
      key: "ztools-renderer:search-preference",
      valueBytes: afterLaunch.fixture.settingWrites[0].valueBytes,
      entryCount: 1,
      entriesMatchFixtureAppNames: true,
    });
    assert.ok(afterLaunch.fixture.settingWrites[0].valueBytes > 0
      && afterLaunch.fixture.settingWrites[0].valueBytes <= 128 * 1024);
    assert.ok(afterLaunch.fixture.calls.some(call => call.command === "set_setting"
      && call.outcome === "fixture-write-intent-not-persisted"));
    assert.equal(afterLaunch.adapter.outstandingNativeCalls, 0);
    checks.push("With autoClear=never, a failed direct launch preserved pasted search state and a successful direct receipt cleared it; the original typed-query ArrowDown/Enter launch then cleared query without creating a process");

    await clickSelector(".search-input");
    await page.send("Input.insertText", { text: "escape fixture query" });
    await waitFor("document.querySelector('.search-input')?.value === 'escape fixture query'");
    await key("Escape", "Escape", 27);
    await waitFor("document.querySelector('.search-input')?.value === ''");
    await key("Escape", "Escape", 27);
    await waitFor("window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__?.snapshot().calls.some(call=>call.command==='hide_main_window')");
    const final = await evaluate(`({fixture:window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot(),adapter:window.__ATOOLS_ZTOOLS_HOST_ADAPTER__.snapshot(),capabilities:window.__ATOOLS_ZTOOLS_HOST_ADAPTER__.capabilities()})`);
    const resizeCalls = final.fixture.calls.filter(call => call.command === "expand_window");
    assert.ok(resizeCalls.length > 0, "Original App must request its measured window height through resizeWindow");
    assert.ok(resizeCalls.every(call => Number.isInteger(call.args?.height)
      && call.args.height > 0 && call.args.height <= 10_000));
    assert.equal(final.adapter.nativeCalls.hide_main_window, 1,
      "Second Escape on the empty search must produce one hide intent");
    assert.deepEqual(final.fixture.rejected, [
      "get_setting", "shell_open", "call_agent_tool", "call_agent_tool",
    ]);
    assert.equal(final.adapter.outstandingNativeCalls, 0);
    assertRendererCallbackCapabilities(final.capabilities);
    assertRendererEventListeners(final.fixture, final.adapter, eventNames, "listening");
    assertAppEventDiagnostics(final.adapter, "listening");
    checks.push(`Original App measured window height and handled the two-step Escape path after a fresh query; all ${eventNames.length} shared native event channels stayed registered`);
    return final;
  }

  async function exerciseFocusReturn(autoClear, disposeAfter = false) {
    assert.ok(autoClear === "immediately" || autoClear === "never");
    const initial = await evaluate(`({fixture:window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot(),adapter:window.__ATOOLS_ZTOOLS_HOST_ADAPTER__.snapshot(),capabilities:window.__ATOOLS_ZTOOLS_HOST_ADAPTER__.capabilities()})`);
    assert.equal(initial.fixture.autoClear, autoClear, "Fixture settings must carry the selected autoClear mode");
    assert.equal(initial.fixture.settingsBatchLoads, 1, "Focus tests must start with one batch settings read");
    assertRendererEventListeners(initial.fixture, initial.adapter, eventNames, "listening");
    assertRendererCallbackCapabilities(initial.capabilities);
    assertFocusDiagnostics(initial.adapter, "listening");
    assertAppEventDiagnostics(initial.adapter, "listening");

    await clickSelector(".search-input");
    await page.send("Input.insertText", { text: "focus fixture query" });
    await waitFor("document.querySelector('.search-input')?.value === 'focus fixture query'");
    await evaluate("document.querySelector('.search-input')?.blur()");
    await waitFor("document.activeElement !== document.querySelector('.search-input')");
    await settleLayoutAndNativeCalls();
    const beforeFocus = await evaluate(`({fixture:window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot(),adapter:window.__ATOOLS_ZTOOLS_HOST_ADAPTER__.snapshot()})`);
    const expectedEmits = autoClear === "immediately" ? 2 : 1;
    const deliveries = await evaluate(`(()=>{const fixture=window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__;return Array.from({length:${expectedEmits}},()=>fixture.emitFocus())})()`);
    assert.deepEqual(deliveries, Array(expectedEmits).fill(1),
      "Each explicit fixture focus event must reach exactly one registered callback");

    if (autoClear === "immediately") {
      await waitFor("document.activeElement === document.querySelector('.search-input') && document.querySelector('.search-input')?.value === ''");
    } else {
      await waitFor("document.activeElement === document.querySelector('.search-input') && document.querySelector('.search-input')?.value === 'focus fixture query' && document.querySelector('.search-input')?.selectionStart === 0 && document.querySelector('.search-input')?.selectionEnd === 'focus fixture query'.length");
    }

    await settleLayoutAndNativeCalls();
    const afterFocus = await evaluate(`({fixture:window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot(),adapter:window.__ATOOLS_ZTOOLS_HOST_ADAPTER__.snapshot(),dom:{value:document.querySelector('.search-input')?.value,focused:document.activeElement===document.querySelector('.search-input'),selectionStart:document.querySelector('.search-input')?.selectionStart,selectionEnd:document.querySelector('.search-input')?.selectionEnd}})`);
    assert.equal(afterFocus.fixture.settingsBatchLoads, beforeFocus.fixture.settingsBatchLoads,
      "Native focus must not reload settings");
    const focusIpcDelta = assertOnlyFocusResizeDelta(beforeFocus, afterFocus);
    assert.equal(afterFocus.fixture.deliveredFocusEvents, expectedEmits);
    assertRendererEventListeners(afterFocus.fixture, afterFocus.adapter, eventNames, "listening");
    assertRendererCallbackCapabilities(await evaluate("window.__ATOOLS_ZTOOLS_HOST_ADAPTER__.capabilities()"));
    assertFocusDiagnostics(afterFocus.adapter, "listening");
    assertAppEventDiagnostics(afterFocus.adapter, "listening");

    let disposeResult;
    if (disposeAfter) {
      assert.equal(autoClear, "never", "Dispose verification belongs to the never variant");
      const beforeDisposeDom = afterFocus.dom;
      await evaluate("window.__ATOOLS_ZTOOLS_HOST_ADAPTER__.dispose()");
      const disposed = await evaluate(`({fixture:window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot(),adapter:window.__ATOOLS_ZTOOLS_HOST_ADAPTER__.snapshot()})`);
      assert.equal(disposed.adapter.disposed, true);
      assertRendererEventListeners(disposed.fixture, disposed.adapter, eventNames, "disposed");
      assertFocusDiagnostics(disposed.adapter, "disposed");
      assertAppEventDiagnostics(disposed.adapter, "disposed");
      const postDisposeDelivery = await evaluate("window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.emitFocus()");
      await evaluate("setTimeout(() => window.ztools.resizeWindow(61), 0)");
      await delay(50);
      const afterDisposeFocus = await evaluate(`(() => {
        const fixture = window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__;
        const input = document.querySelector('.search-input');
        return {
          fixture: fixture.snapshot(),
          adapter: window.__ATOOLS_ZTOOLS_HOST_ADAPTER__.snapshot(),
          dom: {
            value: input?.value,
            focused: document.activeElement === input,
            selectionStart: input?.selectionStart,
            selectionEnd: input?.selectionEnd,
          },
        };
      })()`);
      assert.equal(postDisposeDelivery, 0, "Disposed adapter must receive no later fixture focus callback");
      assert.equal(afterDisposeFocus.fixture.deliveredFocusEvents, expectedEmits,
        "A post-disposal fixture focus must not reach a native handler");
      assert.deepEqual(afterDisposeFocus.adapter.nativeCalls, disposed.adapter.nativeCalls,
        "A post-disposal focus event must not invoke another native command");
      assert.equal(afterDisposeFocus.adapter.outstandingNativeCalls, 0,
        "Native calls must settle after the post-disposal layout frame");
      assert.equal(afterDisposeFocus.adapter.windowNotifications?.failures, 0,
        "Post-disposal focus must not produce a failed window notification");
      assert.equal(afterDisposeFocus.adapter.windowNotifications?.pendingReplies, 0,
        "Post-disposal focus must leave no pending window-notification replies");
      assert.ok(afterDisposeFocus.adapter.windowNotifications?.dropped >= 1,
        "The explicitly scheduled late layout notification must be dropped after disposal");
      assert.deepEqual(afterDisposeFocus.dom, beforeDisposeDom,
        "DOM state must remain unchanged after focus emission following disposal");
      assertRendererEventListeners(afterDisposeFocus.fixture, afterDisposeFocus.adapter, eventNames, "disposed");
      assertFocusDiagnostics(afterDisposeFocus.adapter, "disposed");
      assertAppEventDiagnostics(afterDisposeFocus.adapter, "disposed");
      disposeResult = {
        delivered: postDisposeDelivery,
        activeListeners: afterDisposeFocus.fixture.activeListeners,
        focusEvents: afterDisposeFocus.adapter.focusEvents,
        windowNotifications: afterDisposeFocus.adapter.windowNotifications,
        outstandingNativeCalls: afterDisposeFocus.adapter.outstandingNativeCalls,
        dom: afterDisposeFocus.dom,
      };
    }

    checks.push(`Explicit fixture focus restored the search input with autoClear=${autoClear}; settings and non-layout native commands stayed unchanged, with ${focusIpcDelta.expandWindowCalls} bounded layout resize request(s)${disposeAfter ? ` and disposal removed all ${eventNames.length} event listeners` : ""}`);
    return { autoClear, initial, afterFocus, focusIpcDelta, disposeAfter, disposeResult };
  }

  async function exerciseAppStateFlows() {
    return createRendererAppStateBrowserFlow({
      page,
      evaluate,
      waitFor,
      delay,
      checks,
      appName: fixtureAppName,
      aliasName: fixtureAppAliasName,
      appPath: fixtureAppPath,
      updatedAliasName: fixtureUpdatedAliasName,
    }).run();
  }

  return { exerciseSearchAndWindowRoutes, exerciseFocusReturn, exerciseAppStateFlows };
}

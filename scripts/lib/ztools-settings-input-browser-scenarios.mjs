import assert from "node:assert/strict";
import { delay } from "../chrome-cdp-smoke-utils.mjs";
import { PAGEHIDE_WITNESS_PREFIX } from "./ztools-settings-input-browser-fixture.mjs";

export function createSettingsInputBrowserScenarios(context, runtime) {
  const {
    report, mainPage, childPage, currentDocument, outputDir, runId,
    APP_NAME, APP_PATH, APP_COMMAND_ID, CREATED_ALIAS, CONFLICT_ALIAS, server,
    childDriver,
  } = context;
  const {
    evaluate, waitFor, mainInputValue, dispatchInputEvent, captureScreenshot,
    snapshotPage, countRendererCalls,
  } = runtime;
let inputOperation = "acceptance-start";

async function captureInputFailureDiagnostics() {
  const main = await evaluate(mainPage, `(() => {
    const input = document.querySelector('.search-input');
    const active = document.activeElement;
    return {
      value: input?.value ?? null,
      selectionStart: input?.selectionStart ?? null,
      selectionEnd: input?.selectionEnd ?? null,
      activeElement: active ? {
        tagName: active.tagName || null,
        id: active.id || null,
        className: typeof active.className === 'string' ? active.className : null,
        isSearchInput: active === input,
      } : null,
      documentHasFocus: document.hasFocus(),
    };
  })()`).catch((error) => ({ captureError: String(error?.message || error) }));
  const child = await evaluate(childPage, `(() => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const commands = Array.from(document.querySelectorAll('.card.command-card')).filter(visible);
    const application73 = commands.filter(row => (row.innerText || '').includes('Application 73'));
    const aliases = Array.from(document.querySelectorAll('.alias-table-row')).filter(visible);
    return {
      route: location.hash,
      visibleCommandRows: commands.length,
      application73VisibleRows: application73.length,
      visibleAliasRows: aliases.length,
    };
  })()`).catch((error) => ({ captureError: String(error?.message || error) }));
  const native = runtime.activeSession?.state?.snapshot?.() ?? null;
  const nativeInputCalls = native?.operationCalls?.filter((call) =>
    call.source === "main" && call.operation === "notify_renderer_settings_input") ?? [];
  report.inputFailureDiagnostics = {
    stage: inputOperation,
    main,
    fakeNativeInputCount: native ? nativeInputCalls.length : null,
    fakeNativeRejectedInputCount: native
      ? native.rejected.filter((reason) => reason === "invalid-or-stale-main-input").length
      : null,
    fakeNativeOwner: native ? {
      generation: native.generation, revision: native.revision, valueVersion: native.valueVersion,
      sequence: native.sequence, visible: native.visible,
      controls: native.operationCalls.filter(call => call.source === "child").slice(-12)
        .map(call => ({ action: call.operation, generation: call.packet?.generation, revision: call.packet?.revision })),
    } : null,
    child,
  };
}

async function dispatchKey(page, key, code, modifiers = 0, text = undefined) {
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown", key, code, modifiers, ...(text === undefined ? {} : { text }),
  });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
}

async function replaceMainInput(text) {
  inputOperation = `replace-main-input:${text.length === 0 ? "clear" : "set"}:${text.length}`;
  await mainPage.send("Page.bringToFront");
  const prepared = await evaluate(mainPage, `(() => {
    const input = document.querySelector('.search-input');
    if (!input) return null;
    input.focus();
    input.select();
    return {
      activeElement: document.activeElement === input,
      valueLength: input.value.length,
      selectionStart: input.selectionStart,
      selectionEnd: input.selectionEnd,
      documentHasFocus: document.hasFocus(),
    };
  })()`);
  assert.ok(prepared, "Original Main search input must exist before replacement");
  assert.equal(prepared.activeElement, true, "Original Main input must own DOM focus before replacement");
  assert.equal(prepared.selectionStart, 0, "DOM select() must select the input from its first character");
  assert.equal(prepared.selectionEnd, prepared.valueLength, "DOM select() must select the entire current input value");
  assert.equal(prepared.documentHasFocus, true, "Main document must have focus before trusted input events");
  if (text) {
    await mainPage.send("Input.insertText", { text });
  } else if (prepared.valueLength > 0) {
    await mainPage.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8,
    });
    await mainPage.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8,
    });
  }
  await waitFor(mainPage, `document.querySelector('.search-input')?.value === ${JSON.stringify(text)}`, "original Main search input value");
  await waitFor(childPage, `window.__ATOOLS_SETTINGS_INPUT_CHILD__?.snapshot?.().pendingCount === 0`, "settled Child input bridge requests");
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && runtime.activeSession?.state.state.value !== text) await delay(40);
  assert.equal(runtime.activeSession?.state.state.value, text, "Main's original input value must reach the active child session");
}

async function openSettingsWithOriginalKey() {
  await waitFor(mainPage, "document.querySelector('.search-input')", "original Main search box");
  await mainPage.send("Page.bringToFront");
  runtime.setOpenedBy("original-Main-SearchBox-MetaComma");
  currentDocument.main = `open-${runId.slice(0, 8)}`;
  await dispatchKey(mainPage, ",", "Comma", 4, ",");
  await waitFor(mainPage, "window.__ATOOLS_SETTINGS_INPUT_TESTING__?.snapshot?.().requests.some(call=>call.command==='open_renderer_settings')",
    "original Main Cmd+, open request");
  await waitFor(childPage, "window.__ATOOLS_SETTINGS_ALIAS_FIXTURE__?.snapshot?.().calls.some(call=>call.operation==='ready')",
    "original Child ready handshake");
  await waitFor(mainPage, "document.querySelector('.search-input') && document.querySelector('.app-container')",
    "original Main app after settings opened");
  await waitFor(childPage, "document.querySelector('.sources-panel') && document.querySelector('.all-commands-container')",
    "original Child AllCommands page");
}

async function openAppAliasDialog() {
  await childPage.send("Page.bringToFront");
  const row = `Array.from(document.querySelectorAll(".card.command-card")).find(element=>element.title===${JSON.stringify(APP_PATH)}&&element.innerText.includes(${JSON.stringify(APP_NAME)}))`;
  const more = `${row}?.querySelector(".tag-dropdown .tag-wrapper > .card-more-btn")`;
  await waitFor(childPage, `${more} && ${more}.getBoundingClientRect().width>0`, "original app-row More menu");
  await childDriver.clickElement(more, "original app-row More menu after hover transition");
  await waitFor(childPage, `Array.from(document.querySelectorAll(".dropdown-menu .dropdown-item .item-label")).some(label=>label.textContent.trim()==="自定义别名")`,
    "original TagDropdown custom alias menu item");
  await childDriver.clickText("自定义别名", ".dropdown-menu .dropdown-item", "original custom alias action");
  await waitFor(childPage, `document.querySelector('.alias-dialog-container input[placeholder="输入自定义别名"]')`, "original alias editor");
  await waitFor(childPage, `document.querySelector(".alias-dialog-container .target-card")?.innerText.includes(${JSON.stringify(APP_NAME)})`,
    "original alias target card");
}

async function createAliasThroughOriginalUi() {
  await openAppAliasDialog();
  const before = await evaluate(childPage, "window.__ATOOLS_SETTINGS_ALIAS_FIXTURE__?.snapshot?.().operationCounts?.writeAliases || 0");
  const input = `document.querySelector('.alias-dialog-container input[placeholder="输入自定义别名"]')`;
  await childDriver.fillInput(input, CREATED_ALIAS, true, "original create alias input");
  await childDriver.clickText("保存", ".alias-dialog-container .dialog-footer button", "original alias save button");
  await waitFor(childPage, `((window.__ATOOLS_SETTINGS_ALIAS_FIXTURE__?.snapshot?.().operationCounts?.writeAliases)||0)>${before}`,
    "synthetic alias write receipt");
  await waitFor(childPage, `!document.querySelector('.alias-dialog-container')`, "original create alias dialog close");
  report.checks.push("Created a command alias through the original AllCommands row menu, dialog, and Child API write path.");
}

async function navigateToShortcutAliasTab() {
  // The original AllCommands alias action already jumps to Shortcuts.
  // Return through the real sidebar first so this test observes a new route owner.
  const routeAfterAlias = await evaluate(childPage, "location.hash");
  if (routeAfterAlias.startsWith("#/shortcuts")) {
    const shortcutGeneration = runtime.activeSession.state.state.generation;
    await childPage.send("Page.bringToFront");
    await childDriver.clickText("所有指令", ".menu-item", "original sidebar return to AllCommands");
    await waitFor(childPage, `location.hash==="#/allCommands" && document.querySelector(".all-commands-container")`,
      "original AllCommands route after alias creation");
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && runtime.activeSession.state.state.generation <= shortcutGeneration) await delay(40);
    assert.ok(runtime.activeSession.state.state.generation > shortcutGeneration,
      "Returning from Shortcuts must register the real AllCommands input owner");
    await waitFor(mainPage, `document.querySelector(".placeholder-text")?.textContent.trim()==="搜索指令..."`,
      "restored AllCommands SubInput placeholder");
  }
  const previousRoute = await evaluate(childPage, "location.hash");
  assert.equal(previousRoute, "#/allCommands", "Sidebar route-owner test must start from AllCommands");
  const previousGeneration = runtime.activeSession.state.state.generation;
  await childDriver.clickText("快捷键", ".menu-item", "original settings sidebar Shortcuts route");
  await waitFor(childPage, `location.hash.startsWith("#/shortcuts") && document.querySelector(".tab-btn")`, "original Shortcuts route");
  await childDriver.clickText("指令别名", "button.tab-btn", "original Shortcuts alias tab");
  await waitFor(childPage, `document.querySelector(".tab-btn.active")?.textContent.trim()==="指令别名"`, "original alias tab selection");
  await waitFor(childPage, `Array.from(document.querySelectorAll(".alias-table-row")).some(row=>row.innerText.includes(${JSON.stringify(CREATED_ALIAS)}))`,
    "created alias on the original Shortcuts page");
  const ownerDeadline = Date.now() + 10000;
  while (Date.now() < ownerDeadline && runtime.activeSession.state.state.generation <= previousGeneration) await delay(40);
  assert.ok(runtime.activeSession.state.state.generation > previousGeneration,
    `The route change must install the new page's SubInput owner: ${previousRoute}, ${previousGeneration} -> ${runtime.activeSession.state.state.generation}`);
  await waitFor(mainPage, `document.querySelector(".placeholder-text")?.textContent.trim()==="搜索快捷键或别名..."`,
    "new Shortcuts SubInput placeholder in original Main DOM");
  report.checks.push("Used the original settings sidebar route and original alias tab; the new owner changed the Main input placeholder.");
}

async function runCompositionInput() {
  const before = await evaluate(mainPage, "window.__ATOOLS_SETTINGS_INPUT_TESTING__.snapshot().requests.filter(call=>call.command==='notify_renderer_settings_input').length");
  await evaluate(mainPage, `(() => {
    const input=document.querySelector('.search-input'); if(!input) throw new Error('Main search input missing');
    input.focus(); input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(input,'intermediate composition text');
    input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'intermediate composition text',inputType:'insertCompositionText',isComposing:true}));
  })()`);
  await delay(140);
  const during = await evaluate(mainPage, "window.__ATOOLS_SETTINGS_INPUT_TESTING__.snapshot().requests.filter(call=>call.command==='notify_renderer_settings_input').length");
  assert.equal(during, before, "IME intermediate input must not reach Native while composition is active");
  await evaluate(mainPage, `(() => {
    const input=document.querySelector('.search-input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'legacy');
    input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'legacy'}));
  })()`);
  await waitFor(mainPage, "window.__ATOOLS_SETTINGS_INPUT_TESTING__.snapshot().requests.filter(call=>call.command==='notify_renderer_settings_input').length===1+" + before,
    "one final composition input notification");
  await waitFor(childPage, "document.body.innerText.includes('legacy current alias')", "final IME text filter in Shortcuts alias list");
  assert.equal(runtime.activeSession.state.state.value, "legacy", "Compositionend must deliver only the final Main input value");
  report.checks.push("IME input produced no intermediate Native notification and one final compositionend notification.");
}

async function editAliasConflictRetainsDraft() {
  await replaceMainInput("");
  const row = `Array.from(document.querySelectorAll(".alias-table-row")).find(element=>element.innerText.includes(${JSON.stringify(CREATED_ALIAS)}))`;
  await childDriver.clickElement(`${row}?.querySelector('button[title="编辑"]')`, "original created alias edit action");
  const input = `document.querySelector('.alias-dialog-container input[placeholder="输入自定义别名"]')`;
  await waitFor(childPage, input, "original alias edit dialog");
  await childDriver.fillInput(input, CONFLICT_ALIAS, true, "alias conflict draft input");
  await evaluate(childPage, "window.__ATOOLS_SETTINGS_ALIAS_FIXTURE__?.triggerAliasConflict?.()");
  runtime.markExpectedConflict();
  const writesBefore = await evaluate(childPage, "window.__ATOOLS_SETTINGS_ALIAS_FIXTURE__?.snapshot?.().operationCounts?.writeAliases || 0");
  await childDriver.clickText("保存", ".alias-dialog-container .dialog-footer button", "original alias conflict save button");
  await waitFor(childPage, `document.body.innerText.includes("保存指令别名失败") && (${input})?.value===${JSON.stringify(CONFLICT_ALIAS)}`,
    "visible alias conflict error and retained draft");
  await waitFor(childPage, `((window.__ATOOLS_SETTINGS_ALIAS_FIXTURE__?.snapshot?.().operationCounts?.writeAliases)||0)>${writesBefore}`,
    "synthetic alias revision conflict");
  const snapshot = await evaluate(childPage, "window.__ATOOLS_SETTINGS_ALIAS_FIXTURE__?.snapshot?.() ?? null");
  const failed = snapshot?.calls?.findLast((call) => call.operation === "writeAliases");
  assert.equal(failed?.status, "rejected");
  assert.equal(failed?.errorCode, "SETTINGS_ALIAS_REVISION_CONFLICT");
  const draft = await evaluate(childPage, `${input}.value`);
  assert.equal(draft, CONFLICT_ALIAS, "The original alias editor must preserve the rejected draft");
  report.checks.push("An injected synthetic alias revision conflict was surfaced by the original editor and retained the user's draft.");
}

async function runFindShortcut() {
  const oldGeneration = runtime.activeSession.state.state.generation;
  await childPage.send("Page.bringToFront");
  await dispatchKey(childPage, "f", "KeyF", 4);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && runtime.activeSession.state.state.generation <= oldGeneration) await delay(40);
  assert.ok(runtime.activeSession.state.state.generation > oldGeneration, "Original Child Cmd+F must register a fresh input owner");
  await waitFor(mainPage, `(() => {
    const input=document.querySelector('.search-input');
    return input && input.value==='legacy' && input.selectionStart===0 && input.selectionEnd===input.value.length;
  })()`, "original Cmd+F selection of the current Main query");
  assert.ok(runtime.activeSession.state.state.operationCalls.some(call => call.source === "child" &&
    call.operation === "select" && call.packet.generation > oldGeneration), "Cmd+F must use the new owner's select control");
  report.checks.push("Original Child Cmd+F registered a fresh owner and selected the existing Main query through the real hook and callback path.");
}

async function observeMainAndChildSnapshots(label) {
  const mainSnapshot = await evaluate(mainPage, `({
    fixture:window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__?.snapshot?.() ?? null,
    adapter:window.__ATOOLS_ZTOOLS_HOST_ADAPTER__?.snapshot?.() ?? null,
    input:window.__ATOOLS_SETTINGS_INPUT_TESTING__?.snapshot?.() ?? null,
    search:document.querySelector('.search-input')?.value ?? null,
    placeholder:document.querySelector('.placeholder-text')?.textContent?.trim() ?? null,
  })`);
  const childSnapshot = await evaluate(childPage, `({
    alias:window.__ATOOLS_SETTINGS_ALIAS_FIXTURE__?.snapshot?.() ?? null,
    input:window.__ATOOLS_SETTINGS_INPUT_CHILD__?.snapshot?.() ?? null,
    hookPresent:typeof window.__ATOOLS_SETTINGS_DELIVER_INPUT__ === 'function',
    route:location.hash,
  })`);
  report.documents.push({ page: "main", stage: label, search: mainSnapshot.search, placeholder: mainSnapshot.placeholder,
    adapter: mainSnapshot.adapter, fixtureCalls: mainSnapshot.fixture?.calls ?? [] });
  report.documents.push({ page: "child", stage: label, route: childSnapshot.route,
    operationCounts: childSnapshot.input?.operationCalls?.reduce((counts, call) => {
      counts[call.operation]=(counts[call.operation]||0)+1; return counts;
    }, {}) ?? {}, pageCalls: childSnapshot.input?.pageCalls ?? [], expectedSettings: childSnapshot.input?.commandSettings ?? null,
    aliasCalls: childSnapshot.alias?.calls ?? [], hookPresent: childSnapshot.hookPresent });
  report.rendererFixture.snapshot = mainSnapshot.fixture;
  report.rendererFixture.calls = mainSnapshot.fixture?.calls ?? [];
  report.rendererFixture.settingsBatch = mainSnapshot.fixture?.settingsBatchSummary ?? null;
  report.rendererFixture.input = mainSnapshot.input;
  report.rendererFixture.inputSnapshots.push({ label, ...mainSnapshot.input });
  report.childFixture.commandSettings = childSnapshot.input?.commandSettings ?? null;
  report.childFixture.snapshots.push({ label, ...childSnapshot.input });
  return { main: mainSnapshot, child: childSnapshot };
}

async function runAcceptance() {
  try {
    await runAcceptanceScenario();
  } catch (error) {
    try { await captureInputFailureDiagnostics(); }
    catch (diagnosticError) {
      report.inputFailureDiagnostics = {
        stage: inputOperation,
        captureError: String(diagnosticError?.message || diagnosticError),
      };
    }
    throw error;
  }
}

async function runAcceptanceScenario() {
  currentDocument.main = "initial-main";
  currentDocument.child = "initial-child";
  await openSettingsWithOriginalKey();
  await mainPage.send("Page.bringToFront");
  await snapshotPage(mainPage, "main", "Main original app after Cmd+,");
  await snapshotPage(childPage, "child", "Child original AllCommands after ready");
  await captureScreenshot(mainPage, "main-opened", currentDocument.main);
  await captureScreenshot(childPage, "child-allCommands", currentDocument.child);

  const initial = await observeMainAndChildSnapshots("allCommands-loaded");
  assert.equal(countRendererCalls(initial.main.fixture, "get_ztools_renderer_settings"), 1,
    "Original Main must perform one existing batched settings read");
  assert.equal(countRendererCalls(initial.main.fixture, "list_launcher_apps"), 1, "Main app catalog should load once");
  assert.equal(countRendererCalls(initial.main.fixture, "list_plugins"), 1, "Main plugin inventory should load once");
  assert.equal(countRendererCalls(initial.main.fixture, "get_setting"), 0, "Main must not use per-key startup reads");
  assert.equal(initial.child.input.settingsReadCount, 1,
    "Concurrent AllCommands reads of the five fixed setting keys should share one complete snapshot");
  const seed = initial.child.input.commandSettings;
  for (const key of ["disable-commands", "pinned-commands", "super-panel-pinned", "global-shortcuts", "app-shortcuts"]) {
    assert.ok(Array.isArray(seed[key]) && seed[key].length > 0, `Synthetic positive fixture must seed ${key} with records`);
  }
  assert.equal(seed["super-panel-pinned"][0].items.length, 1, "SuperPanel fixture must contain one bounded folder child");
  report.checks.push("Main used its unchanged one-call startup snapshot; AllCommands loaded all five non-empty command settings through one synthetic paged snapshot.");

  await replaceMainInput("Application 73");
  const filtered = await evaluate(childPage, `(() => Array.from(document.querySelectorAll(".card.command-card"))
    .map(row=>({text:(row.innerText||"").replace(/\\s+/g," ").trim(),title:row.title}))
    .filter(row=>row.text.includes("Application 73")))()`);
  assert.equal(filtered.length, 1, "Main's original shared input must filter the original AllCommands DOM to one row");
  await captureScreenshot(childPage, "child-command-filtered", currentDocument.child);
  await replaceMainInput("");
  const restored = await evaluate(childPage, `Array.from(document.querySelectorAll(".card.command-card"))
    .filter(row=>row.getBoundingClientRect().width>0).length`);
  assert.ok(restored > 1, "An empty Main query must restore the original AllCommands results");
  report.checks.push("Typing and clearing the original Main input filtered and restored the original Child command list.");

  const childValueResult = await evaluate(childPage, `window.ztools.setSubInputValue("Child public setter value")`, 10000);
  assert.equal(childValueResult, true, "Original Child public setSubInputValue must be applied by the synthetic transport");
  await waitFor(mainPage, "document.querySelector('.search-input')?.value==='Child public setter value'", "Child public setter echo in Main input");
  await waitFor(childPage, "document.body.innerText.includes('Application 73') === false", "Child public setter filters command data");
  assert.equal(runtime.activeSession.state.state.value, "Child public setter value");
  const selectResult = await evaluate(childPage, "window.ztools.subInputSelect()");
  assert.equal(selectResult, true, "Original Child subInputSelect must enter the existing Main callback path");
  await waitFor(mainPage, `(() => { const input=document.querySelector('.search-input'); return input && input.selectionStart===0 && input.selectionEnd===input.value.length; })()`,
    "original Main selection callback");
  await replaceMainInput("");
  const stalePacket = JSON.parse(JSON.stringify(runtime.activeSession.state.state.lastEvent));
  assert.ok(stalePacket && stalePacket.kind === "subInput");
  report.checks.push("Child public setSubInputValue and select callbacks updated/selected the same original Main input.");

  await createAliasThroughOriginalUi();
  const oldGeneration = runtime.activeSession.state.state.generation;
  await navigateToShortcutAliasTab();
  await replaceMainInput("legacy current alias");
  await waitFor(childPage, `Array.from(document.querySelectorAll(".alias-table-row")).filter(row=>row.innerText.includes("legacy current alias")).length===1`,
    "Main input filters the original Shortcuts alias tab");
  const staleEvent = { ...stalePacket, value: "STALE OLD OWNER" };
  const staleDelivery = {
    version: 1, sessionId: stalePacket.sessionId, bundleRevision: stalePacket.bundleRevision,
    generation: stalePacket.generation, revision: stalePacket.revision, text: "STALE OLD OWNER",
  };
  const deliveredMainListeners = await dispatchInputEvent(staleEvent, runtime.activeSession);
  assert.ok(Number.isInteger(deliveredMainListeners) && deliveredMainListeners > 0,
    "Late old-generation event must reach at least one actual Main renderer listener");
  const childAcceptedStale = await evaluate(childPage,
    `window.__ATOOLS_SETTINGS_DELIVER_INPUT__?.(${JSON.stringify(staleDelivery)}) ?? false`);
  const mainAfterStale = await mainInputValue();
  assert.ok(runtime.activeSession.state.state.generation > oldGeneration, "Shortcuts route must own a newer generation than AllCommands");
  assert.equal(childAcceptedStale, false, "Child must reject a late delivery from the retired route owner");
  assert.equal(mainAfterStale, "legacy current alias", "Main must ignore a late old-generation echo");
  await waitFor(childPage, `Array.from(document.querySelectorAll(".alias-table-row")).filter(row=>row.innerText.includes("legacy current alias")).length===1`,
    "Shortcuts alias filter remains intact after late echo");
  report.nativeInput.staleEcho = { oldGeneration: stalePacket.generation, currentGeneration: runtime.activeSession.state.state.generation,
    deliveredMainListeners,
    childAccepted: childAcceptedStale, mainValueAfter: mainAfterStale };
  report.checks.push("The actual route owner changed; an old-generation echo was rejected by both Main and Child without changing the current filter.");

  await runCompositionInput();
  await runFindShortcut();
  await captureScreenshot(childPage, "child-shortcuts-filtered", currentDocument.child);
  await editAliasConflictRetainsDraft();
  await childPage.send("Page.bringToFront");
  await waitFor(childPage, "window.__ATOOLS_SETTINGS_INPUT_CHILD__?.snapshot?.().pendingCount===0", "settled child transport before close");
  const beforeClose = await observeMainAndChildSnapshots("before-close-after-conflict");
  assert.equal(beforeClose.child.input.pagehideObserverInstalled, true,
    "Child pagehide witness must be installed after the production bridge attaches");
  assert.equal(runtime.activeSession.state.state.visible, true,
    "Close must start with an active input owner rather than a manually removed SubInput");
  const inputCallsBeforeClose = beforeClose.child.input.operationCalls.filter(call => call.operation === "updateSubInput").length;
  const outResult = await evaluate(childPage, "window.ztools.outPlugin()", 10000);
  assert.equal(outResult, undefined, "Original Child outPlugin must finish after Native close acknowledgement");
  await waitFor(mainPage, "document.querySelector('.app-container') && !document.querySelector('.app-container__plugin')",
    "original Main returned from settings child");
  const afterClose = await evaluate(childPage, "window.__ATOOLS_SETTINGS_INPUT_CHILD__.snapshot()");
  const inputCallsAfterClose = afterClose.operationCalls.filter(call => call.operation === "updateSubInput").length;
  assert.equal(inputCallsAfterClose, inputCallsBeforeClose, "Out callbacks and route unmount must admit no new input RPC");
  assert.equal(afterClose.pendingCount, 0, "Close acknowledgement must leave no pending Child transport");
  report.nativeInput.close = { inputCallsBeforeClose, inputCallsAfterClose, addedInputCalls: 0, childPending: afterClose.pendingCount };
  const inputSnapshot = await evaluate(mainPage, "window.__ATOOLS_ZTOOLS_HOST_ADAPTER__?.snapshot?.().settingsView?.input ?? null");
  assert.ok(inputSnapshot && !inputSnapshot.notifyPending && !inputSnapshot.notifyInFlight,
    "Closing the Child must clear Main's pending user-input delivery");
  assert.equal(beforeClose.child.input.pendingCount, 0, "No child transport request may be in flight before close");
  const oldSessionId = runtime.lastClosedSession.sessionId;
  const oldInjectionId = runtime.childInjectionId;
  await childPage.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: oldInjectionId });
  runtime.clearChildInjection();
  const retiredLoad = childPage.waitForEvent("Page.loadEventFired", 10000);
  await childPage.send("Page.navigate", { url: server.retiredUrl });
  await retiredLoad;
  await waitFor(childPage,
    `location.href===${JSON.stringify(server.retiredUrl)} && document.querySelector('main[data-atools-retired-target="true"]') && document.scripts.length===0`,
    "owned retired-target document after real Child navigation");
  assert.equal(server.state.retiredTargetRequests, 1, "Child must load exactly one owned retired-target document");
  const retiredDocument = await evaluate(childPage, `(() => {
    const raw = sessionStorage.getItem(${JSON.stringify(`${PAGEHIDE_WITNESS_PREFIX}${oldSessionId}`)});
    let witness = null;
    try { witness = raw ? JSON.parse(raw) : null; } catch { witness = { invalidJson: true }; }
    const bridgeGlobals = ["ztools", "utools", "__ATOOLS_SETTINGS_DELIVER_INPUT__", "__ATOOLS_SETTINGS_DELIVER_OUT__",
      "__ATOOLS_SETTINGS_VIEW_CONFIG__", "__ATOOLS_SETTINGS_INPUT_CHILD__", "__ATOOLS_SETTINGS_INPUT_SENTINEL__",
      "__ATOOLS_SETTINGS_ALIAS_FIXTURE__"].filter(name => typeof window[name] !== "undefined");
    return {
      retiredTarget: document.querySelector('main[data-atools-retired-target="true"]')?.dataset.atoolsRetiredTarget === "true",
      scriptCount: document.scripts.length,
      bridgeGlobals,
      witness,
    };
  })()`);
  assert.equal(retiredDocument.retiredTarget, true, "Owned retired-target marker must be present");
  assert.equal(retiredDocument.scriptCount, 0, "Retired-target document must contain no scripts");
  assert.deepEqual(retiredDocument.bridgeGlobals, [], "Retired document must not retain settings bridge globals");
  const pagehide = retiredDocument.witness;
  assert.ok(pagehide && !pagehide.invalidJson, "Trusted pagehide witness must survive same-origin navigation");
  assert.equal(pagehide.version, 1, "Stored pagehide witness version must be recognized");
  assert.equal(pagehide.sessionId, oldSessionId, "Stored pagehide witness must belong to the retired session");
  pagehide.witnessChannel = "session-storage-after-navigation";
  report.documents.push({ page: "child", stage: "pagehide-dispose", ...pagehide });
  assert.equal(pagehide.hookRestored, true, "Retired Child must restore its private input hook");
  assert.equal(pagehide.outRestored, true, "Retired Child must restore its private out hook");
  assert.equal(pagehide.pendingCount, 0, "Retired Child must clear all bridge callbacks");
  assert.equal(pagehide.observerInstalled, true, "Pagehide witness must have been installed after production bridge attachment");
  assert.equal(pagehide.trustedEvent, true, "Pagehide witness must come from a trusted navigation event");
  await waitFor(mainPage,
    `window.__ATOOLS_SETTINGS_INPUT_TESTING__?.snapshot?.().requests.every(call=>call.command!=='notify_renderer_settings_input'||call.id.startsWith('main-'))`,
    "Main binding queue settled after close", 3000);
  report.documents.push({ page: "child", stage: "closed-session", sessionId: oldSessionId,
    childTransportPending: 0, mainInput: inputSnapshot, childPagehideExpected: true });

  await openSettingsWithOriginalKey();
  assert.notEqual(runtime.activeSession.sessionId, oldSessionId, "Reopening must create a fresh v4 session id");
  assert.match(runtime.activeSession.bundleRevision, /^[0-9a-f]{64}$/, "Settings bundle revision must be a SHA-256 identity");
  const reopened = await observeMainAndChildSnapshots("fresh-session-reopened");
  assert.equal(reopened.child.input.settingsReadCount, 1, "Fresh session must start with exactly one command settings snapshot");
  assert.ok(reopened.child.input.pendingCount === 0, "Fresh child has no inherited transport requests");
  await snapshotPage(mainPage, "main", "Main after fresh settings session");
  await snapshotPage(childPage, "child", "Child fresh-session AllCommands");
  await captureScreenshot(mainPage, "main-fresh-session", currentDocument.main);
  await captureScreenshot(childPage, "child-fresh-session", currentDocument.child);

  const mainFixture = reopened.main.fixture;
  assert.equal(countRendererCalls(mainFixture, "get_ztools_renderer_settings"), 1);
  assert.equal(countRendererCalls(mainFixture, "list_launcher_apps"), 1);
  assert.equal(countRendererCalls(mainFixture, "list_plugins"), 1);
  const allChildCalls = [...report.childFixture.snapshots.flatMap((snapshot) => snapshot.operationCalls || []),
    ...(reopened.child.input.operationCalls || [])];
  assert.ok(allChildCalls.every((call) => call.operation !== "getApps" && call.operation !== "getCommandSettings"),
    "Child fixture must use only canonical typed operations, with no extra app/settings APIs");
  report.nativeInput.calls.push(...runtime.activeSession.state.snapshot().operationCalls);
  assert.ok(report.nativeInput.maxPayloadBytes <= 32 * 1024, "Synthetic input requests must remain within the 32 KiB request budget");
  assert.ok(report.rendererFixture.inputSnapshots.every((snapshot) => snapshot.maxPayloadBytes <= 32 * 1024),
    "Main browser transport must keep full serialized requests within the 32 KiB request budget");
  assert.ok(report.childFixture.snapshots.every((snapshot) => snapshot.maximumPayloadBytes <= 32 * 1024),
    "Child browser transport must keep full serialized requests within the 32 KiB request budget");
  assert.ok(report.nativeInput.maxReplyBytes <= 64 * 1024, "Synthetic input replies must remain within the 64 KiB reply budget");
  assert.equal(report.network.externalAttempts.length, 0, "Owned pages must make no external network requests");
  assert.equal(report.network.denied.length, 0, "No page request may escape the static dist whitelist");
  assert.equal(server.state.rejected, 0, "Strict static server must not reject required dist assets");
  report.checks.push("A closed Child disposed its private input hook before a fresh session reopened; the new session has its own identity and empty pending queues.");
}

async function runInspect() {
  await openSettingsWithOriginalKey();
  await snapshotPage(mainPage, "main", "inspect Main after original Cmd+,");
  await snapshotPage(childPage, "child", "inspect Child original AllCommands DOM");
  await captureScreenshot(mainPage, "main-inspect", currentDocument.main);
  await captureScreenshot(childPage, "child-inspect", currentDocument.child);
  await observeMainAndChildSnapshots("inspect-only");
  report.checks.push("Inspect mode opened the original Main and Child pages and captured both DOM trees and screenshots without alias writes or search mutations.");
}


  return { runAcceptance, runInspect };
}

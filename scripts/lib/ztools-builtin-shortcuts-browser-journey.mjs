import assert from "node:assert/strict";

const descriptions = { search: "固定搜索框的文本，进行二次筛选", esc: "清空输入/退出插件/隐藏窗口",
  closePlugin: "关闭插件/隐藏窗口", killPlugin: "终止当前插件运行" };
const row = key => `Array.from(document.querySelectorAll('.shortcut-item.built-in')).find(row => row.querySelector('.shortcut-desc')?.textContent.trim() === ${JSON.stringify(descriptions[key])})`;
const checkbox = key => `(${row(key)})?.querySelector('input[type="checkbox"]')`;

export function createBuiltinShortcutsBrowserJourney(context, runtime, fixture) {
  const { report, mainPage, childPage, childDriver, currentDocument, server } = context;
  const { evaluate, waitFor } = runtime;
  const info = report.builtinShortcuts;
  const expectedErrors = report.console.expectedBuiltinFailures;
  const key = async (value, code, modifiers = 0) => {
    await mainPage.send("Input.dispatchKeyEvent", { type: "keyDown", key: value, code, modifiers, windowsVirtualKeyCode: code === "Backspace" ? 8 : undefined });
    await mainPage.send("Input.dispatchKeyEvent", { type: "keyUp", key: value, code, modifiers });
  };
  async function input(text) {
    await mainPage.send("Page.bringToFront");
    await evaluate(mainPage, "document.querySelector('.search-input').focus();document.querySelector('.search-input').select()");
    if (text) await mainPage.send("Input.insertText", { text });
    else await key("Backspace", "Backspace");
    await waitFor(mainPage, `document.querySelector('.search-input').value === ${JSON.stringify(text)}`, "original Main query");
  }
  const mainState = () => evaluate(mainPage, `({query:document.querySelector('.search-input').value,
    pasted:document.querySelector('.pasted-text')?.innerText || '',
    hide:window.__ATOOLS_ZTOOLS_HOST_ADAPTER__.snapshot().nativeCalls.hide_main_window || 0,
    generalListeners:window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot().activeListenersByEvent['atools://renderer-general-settings']})`);
  async function open() {
    await mainPage.send("Page.bringToFront");
    await evaluate(mainPage, "document.querySelector('.search-input').focus()");
    runtime.setOpenedBy("R69-original-Main-CmdComma");
    await key(",", "Comma", 4);
    await waitFor(childPage, "window.__ATOOLS_BUILTIN_SHORTCUTS_CHILD__ && document.querySelector('.menu-item')", "original Settings ready");
    await childPage.send("Page.bringToFront");
    await childDriver.clickText("快捷键", ".menu-item", "original Shortcuts sidebar");
    await waitFor(childPage, "Array.from(document.querySelectorAll('button.tab-btn')).some(button => button.textContent.trim() === '应用快捷键')", "original Shortcuts route rendered");
    await childDriver.clickText("应用快捷键", "button.tab-btn", "original app-shortcuts tab");
    await waitFor(childPage, `${checkbox("search")} && ${checkbox("esc")}`, "original builtin controls");
    info.sessions.push(runtime.activeSession.sessionId);
  }
  async function close() {
    await waitFor(childPage, "window.__ATOOLS_BUILTIN_SHORTCUTS_CHILD__.pendingCount() === 0 && window.__ATOOLS_SETTINGS_INPUT_CHILD__.snapshot().pendingCount === 0", "all child requests settled");
    const sessionId = runtime.activeSession.sessionId;
    await evaluate(childPage, "window.ztools.outPlugin()");
    await waitFor(mainPage, "!document.querySelector('.app-container__plugin')", "Main returned from Settings");
    assert.equal(runtime.activeSession, null);
    await childPage.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: runtime.childInjectionId });
    runtime.clearChildInjection();
    const loaded = childPage.waitForEvent("Page.loadEventFired", 10000);
    await childPage.send("Page.navigate", { url: server.retiredUrl });
    await loaded;
    await waitFor(childPage, "document.querySelector('main[data-atools-retired-target]') && !window.ztools && !window.__ATOOLS_BUILTIN_SHORTCUTS_CHILD__", "retired Child with bridge globals removed");
    const state = await mainState();
    assert.equal(state.generalListeners, 1, "Close/reopen must reuse the single General event source");
    info.closed.push({ sessionId, retiredDocument: true, pending: 0, mainGeneralListeners: state.generalListeners });
  }
  async function enabled(keyName, expected) {
    await waitFor(childPage, `${checkbox(keyName)}?.checked === ${expected}`, `original ${keyName} checkbox`);
  }
  async function toggle(keyName, expected) {
    const before = fixture.snapshot();
    await childDriver.clickElement(`(${row(keyName)}).querySelector('.built-in-toggle')`, `original ${keyName} toggle`);
    await enabled(keyName, expected);
    await waitFor(childPage, "window.__ATOOLS_BUILTIN_SHORTCUTS_CHILD__.pendingCount() === 0", "confirmed General save");
    const after = fixture.snapshot();
    const writes = after.calls.slice(before.calls.length).filter(call => call.operation === "patchGeneral");
    assert.equal(writes.length, 1, "One original toggle must send exactly one existing patchGeneral call");
    assert.deepEqual(writes[0].payload.changes, { builtinAppShortcutsEnabled: { [keyName]: expected } });
    assert.equal(writes[0].status, "resolved");
    assert.equal(after.mutations - before.mutations, 1);
    assert.equal(after.notifications - before.notifications, 1);
    assert.equal(after.raw.closePlugin, false); assert.equal(after.raw.killPlugin, true);
    assert.deepEqual(after.raw.future, { keep: "opaque" });
    info.saves.push({ key: keyName, value: expected, patchCalls: 1, mutations: 1, notifications: 1 });
  }
  async function rejectedToggle(keyName, expected, code = null) {
    const before = fixture.snapshot();
    const errors = report.console.errors.length;
    if (code) fixture.failNext(code);
    await childDriver.clickElement(`(${row(keyName)}).querySelector('.built-in-toggle')`, `original ${keyName} failure boundary`);
    await waitFor(childPage, "document.body.innerText.includes('更新失败')", "original failure notice");
    await enabled(keyName, expected);
    await waitFor(childPage, "window.__ATOOLS_BUILTIN_SHORTCUTS_CHILD__.pendingCount() === 0", "failed save settled");
    assert.equal(report.console.errors.length, errors + 1);
    const error = report.console.errors.at(-1);
    assert.ok(error.text.startsWith("更新内置快捷键开关失败:"), error.text);
    expectedErrors.push(error);
    const after = fixture.snapshot();
    assert.deepEqual(after.raw, before.raw, "Rejected UI operation must leave stored values unchanged");
    assert.equal(after.mutations, before.mutations); assert.equal(after.notifications, before.notifications);
    const writes = after.calls.slice(before.calls.length).filter(call => call.operation === "patchGeneral");
    assert.equal(writes.length, code ? 1 : 0, "Unsupported plugin toggles must not reach the backend");
    if (code) assert.equal(writes[0].code, code);
    info.rejections.push({ key: keyName, code: code || "unsupported-before-write", patchCalls: writes.length, restored: true });
  }
  async function disabledKeys(label) {
    await input(label);
    const before = await mainState();
    await key("f", "KeyF", 4); await key("f", "KeyF", 2); await key("Escape", "Escape");
    const after = await mainState();
    assert.equal(after.query, label); assert.equal(after.pasted, ""); assert.equal(after.hide, before.hide);
    info.keyboard.push({ phase: "disabled", metaFUnchanged: true, ctrlFUnchanged: true, escapeUnchanged: true });
  }
  return { async run() {
    await disabledKeys("R69 cold-start event must win");
    report.checks.push("An early General event survived the deliberately delayed old startup read in the original Main DOM/cache/Pinia.");
    await input(""); await open(); await enabled("search", false); await enabled("esc", false);
    await toggle("search", true); await toggle("esc", true);
    await rejectedToggle("closePlugin", true); await rejectedToggle("killPlugin", true);
    await runtime.captureScreenshot(childPage, "r69-original-shortcuts-enabled", currentDocument.child);
    await close();
    await input("  R69 Meta fixed text  "); await key("f", "KeyF", 4);
    await waitFor(mainPage, "document.querySelector('.search-input').value === '' && document.querySelector('.pasted-text')?.innerText.includes('R69 Meta fixed text')", "original Meta+F fixed text");
    await runtime.captureScreenshot(mainPage, "main-r69-original-fixed-text", currentDocument.main);
    await key("Escape", "Escape");
    await waitFor(mainPage, "!document.querySelector('.pasted-text')", "original Escape clears fixed text");
    await input("  R69 Ctrl fixed text  "); await key("f", "KeyF", 2);
    await waitFor(mainPage, "document.querySelector('.search-input').value === '' && document.querySelector('.pasted-text')?.innerText.includes('R69 Ctrl fixed text')", "original Ctrl+F fixed text");
    await input("R69 composition query");
    const beforeEscape = await mainState();
    await evaluate(mainPage, "document.querySelector('.search-input').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))");
    await key("Escape", "Escape");
    assert.equal((await mainState()).query, "R69 composition query");
    await evaluate(mainPage, "document.querySelector('.search-input').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:''}))");
    await key("Escape", "Escape");
    await waitFor(mainPage, "document.querySelector('.search-input').value === ''", "first Escape clears query");
    assert.ok((await mainState()).pasted.includes("R69 Ctrl fixed text"));
    await key("Escape", "Escape"); await waitFor(mainPage, "!document.querySelector('.pasted-text')", "second Escape clears fixed text");
    assert.equal((await mainState()).hide, beforeEscape.hide);
    await key("Escape", "Escape");
    await waitFor(mainPage, `window.__ATOOLS_ZTOOLS_HOST_ADAPTER__.snapshot().nativeCalls.hide_main_window === ${beforeEscape.hide + 1}`, "third Escape hide intent");
    info.keyboard.push({ phase: "enabled", metaFFixedText: true, ctrlFFixedText: true, compositionSkipped: true,
      escapeQueryThenPastedThenHide: true, hideDelta: 1 });
    await runtime.captureScreenshot(mainPage, "main-r69-original-keyboard", currentDocument.main);
    await open(); await enabled("search", true); await enabled("esc", true);
    await toggle("search", false); await toggle("esc", false);
    await rejectedToggle("search", false, "GENERAL_SETTINGS_PATCH_FAILED");
    await rejectedToggle("esc", false, "SETTINGS_REVISION_CONFLICT");
    await close(); await open(); await enabled("search", false); await enabled("esc", false);
    await toggle("esc", true);
    await runtime.captureScreenshot(childPage, "r69-original-shortcuts-recovered", currentDocument.child);
    await close();
    await input("R69 search remains disabled"); await key("f", "KeyF", 4); await key("f", "KeyF", 2);
    assert.equal((await mainState()).query, "R69 search remains disabled");
    await key("Escape", "Escape"); await waitFor(mainPage, "document.querySelector('.search-input').value === ''", "recovered ESC enabled independently");
    assert.equal(new Set(info.sessions).size, 3);
    await evaluate(mainPage, "window.__ATOOLS_ZTOOLS_HOST_ADAPTER__.dispose()");
    await waitFor(mainPage, "window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot().activeListeners === 0", "all shared event subscriptions disposed");
    info.finalFixture = fixture.snapshot(); info.finalListeners = 0; info.syntheticTransport = true; info.nativeGuiRun = false;
    report.checks.push("Original Shortcuts controls persisted single-key search/esc intents, refreshed Main immediately, survived fresh-session reopening and recovered after write/CAS failure.");
    report.checks.push("Old close/kill controls showed failure and restored the checkbox without a patch or success; unknown stored keys survived.");
    report.checks.push("Original Meta/Ctrl+F fixed trimmed text; ESC cleared query, then pasted text, then emitted one hide intent; composing Escape was skipped.");
    report.checks.push("Three closed Child documents removed their globals and pending requests; one shared General listener stayed constant and all Main listeners disposed to zero.");
  } };
}

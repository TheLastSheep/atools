import assert from "node:assert/strict";
import { LOCAL_FILE_PATH, LOCAL_FOLDER_PATH, LOCAL_MISSING_PATH, LOCAL_COLLISION_B } from "./ztools-local-launch-browser-fixture.mjs";

const ALIAS = "ATools local alias";

export function createLocalLaunchBrowserJourney(context, runtime, nativeFixture) {
  const { report, mainPage, childPage, childDriver, currentDocument, server } = context;
  const evaluate = (page, expression) => runtime.evaluate(page, expression);
  const wait = (page, expression, label) => runtime.waitFor(page, expression, label);
  const row = path => `Array.from(document.querySelectorAll('.shortcut-item')).find(node => node.querySelector('.shortcut-path')?.textContent.trim() === ${JSON.stringify(path)})`;
  async function key(page, value, code, modifiers = 0) {
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: value, code, modifiers });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: value, code, modifiers });
  }
  async function localPage() {
    await childPage.send("Page.bringToFront");
    await childDriver.clickText("本地启动", ".menu-item", "original LocalLaunch sidebar entry");
    await wait(childPage, "location.hash.endsWith('/localLaunch') && document.querySelector('.panel-header .button-group')", "original LocalLaunch page");
    await wait(childPage, "window.__ATOOLS_SETTINGS_INPUT_CHILD__.snapshot().pendingCount === 0", "local list response");
  }
  async function add(type) {
    await childDriver.clickText(type === "folder" ? "添加文件夹" : "添加文件", ".panel-header button", `original add ${type} button`);
    await wait(childPage, "!Array.from(document.querySelectorAll('.panel-header button')).some(node => node.disabled)", "add operation settled");
  }
  async function confirm() {
    await childDriver.clickText("确定", ".dialog-footer button", "original confirmation action");
    await wait(childPage, "!document.querySelector('.dialog-overlay')", "original confirmation close");
  }
  async function search(text) {
    await mainPage.send("Page.bringToFront");
    await evaluate(mainPage, "document.querySelector('.search-input').focus(); document.querySelector('.search-input').select()");
    await mainPage.send("Input.insertText", { text });
    await wait(mainPage, `document.querySelector('.search-input').value === ${JSON.stringify(text)}`, "Main search input");
    await wait(mainPage, `Array.from(document.querySelectorAll('.app-name')).some(node => node.textContent.trim() === ${JSON.stringify(text)})`, "original Main local result");
  }
  async function closeChild() {
    const sessionId = runtime.activeSession.sessionId;
    await wait(childPage, "window.__ATOOLS_SETTINGS_INPUT_CHILD__.snapshot().pendingCount === 0", "settled local child before close");
    await evaluate(childPage, "window.ztools.outPlugin()");
    await wait(mainPage, "!document.querySelector('.app-container__plugin')", "Main returned from local settings");
    assert.equal(await evaluate(childPage, "window.__ATOOLS_SETTINGS_INPUT_CHILD__.snapshot().pendingCount"), 0);
    await childPage.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: runtime.childInjectionId });
    runtime.clearChildInjection();
    await runtime.settleNetwork();
    const loaded = childPage.waitForEvent("Page.loadEventFired", 10000);
    await childPage.send("Page.navigate", { url: server.retiredUrl });
    await loaded;
    await wait(childPage, "document.querySelector('main[data-atools-retired-target=\"true\"]') && document.scripts.length === 0 && typeof window.ztools === 'undefined'", "retired local child document");
    report.documents.push({ page:"child", stage:"local-launch-retired", sessionId, bridgeGlobalsRemoved:true, childPending:0 });
  }
  async function targetPoint(name) {
    return evaluate(mainPage, `(() => {
      const item = Array.from(document.querySelectorAll('.app-item')).find(node => node.querySelector('.app-name')?.textContent.trim() === ${JSON.stringify(name)});
      if (!item) return null;
      item.scrollIntoView({block:'nearest'}); const rect=item.getBoundingClientRect();
      return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};
    })()`);
  }
  async function chooseContext(name, prefix, expectedPath) {
    const point = await targetPoint(name); assert.ok(point);
    const count = await evaluate(mainPage, "window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot().contextMenus.length");
    for (const type of ["mousePressed", "mouseReleased"]) await mainPage.send("Input.dispatchMouseEvent", { type, button:"right", clickCount:1, ...point });
    await wait(mainPage, `window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot().contextMenus.length === ${count + 1}`, "original local target menu");
    const menu = await evaluate(mainPage, "window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot().contextMenus.at(-1)");
    const action = menu.items.find(item => item.id?.startsWith(prefix + ":"));
    assert.ok(action && action.enabled !== false, `Original local action ${prefix} must be enabled`);
    const payload = JSON.parse(action.id.slice(prefix.length + 1));
    if (expectedPath) assert.equal(payload.path, expectedPath, "A stored local shortcut must retain its path even with duplicate names");
    await evaluate(mainPage, `window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.chooseContextMenuAction(${JSON.stringify(action.id)})`);
    await wait(mainPage, "window.__ATOOLS_ZTOOLS_HOST_ADAPTER__.snapshot().contextMenu.showInFlight === false", "local context action settled");
    return payload;
  }
  return { async run() {
    await localPage();
    await wait(childPage, "document.querySelector('.empty-state')", "empty local launch list");
    await add("file");
    assert.equal(nativeFixture.snapshot().items.length, 0, "A cancelled native fixture selection must not write a record");
    await add("file");
    await wait(childPage, `Boolean(${row(LOCAL_FILE_PATH)})`, "added file row");
    await add("folder");
    await wait(childPage, `Boolean(${row(LOCAL_FOLDER_PATH)})`, "added folder row");
    await childDriver.clickElement(`(${row(LOCAL_FILE_PATH)}).querySelector('.alias-btn')`, "original alias editor");
    await childDriver.fillInput("document.querySelector('.alias-input')", ALIAS, true, "local alias value");
    await key(childPage, "Enter", "Enter");
    await wait(childPage, `(${row(LOCAL_FILE_PATH)})?.querySelector('.shortcut-name')?.textContent.includes(${JSON.stringify(ALIAS)})`, "saved local alias");
    await childDriver.clickElement(`(${row(LOCAL_FOLDER_PATH)}).querySelector('.open-btn')`, "original folder open action");
    await add("file");
    await wait(childPage, `Boolean(${row(LOCAL_MISSING_PATH)})`, "temporary missing candidate");
    nativeFixture.markMissing(LOCAL_MISSING_PATH);
    await childDriver.clickText("删除失效项", ".panel-header button", "original missing cleanup");
    await confirm();
    await wait(childPage, `!(${row(LOCAL_MISSING_PATH)})`, "missing record removed");
    await runtime.captureScreenshot(childPage, "child-local-launch-managed", currentDocument.child);
    const beforeClose = nativeFixture.snapshot();
    assert.equal(beforeClose.items.length, 2);
    assert.equal(beforeClose.items.find(item => item.path === LOCAL_FILE_PATH)?.alias, ALIAS);
    report.checks.push("Original LocalLaunch buttons handled selection cancel, file/folder add, alias editing, open, confirmation and missing-reference cleanup through the production Child bridge.");

    await closeChild();
    await search(ALIAS);
    await chooseContext(ALIAS, "pin-app");
    await wait(mainPage, `JSON.parse(window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot().appState.values['pinned-commands'] || '[]').some(row => row.path === ${JSON.stringify(LOCAL_FILE_PATH)} && row.subType === 'local-shortcut')`, "local shortcut pin type");
    await chooseContext(ALIAS, "reveal-in-finder");
    const point = await targetPoint(ALIAS); assert.ok(point);
    for (const type of ["mousePressed", "mouseReleased"]) await mainPage.send("Input.dispatchMouseEvent", { type, button:"left", clickCount:1, ...point });
    await wait(mainPage, "window.__ATOOLS_LOCAL_LAUNCH_FIXTURE__.launches.length === 1", "registered local launch intent");
    const history = await evaluate(mainPage, "JSON.parse(window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot().appState.values['command-history'] || '[]')");
    assert.ok(history.some(row => row.path === LOCAL_FILE_PATH && row.subType === "local-shortcut"));
    assert.equal(await evaluate(mainPage, "window.__ATOOLS_LOCAL_LAUNCH_FIXTURE__.reveals.length"), 1);
    await runtime.captureScreenshot(mainPage, "main-local-launch-history", currentDocument.main);
    report.checks.push("Main reloaded local shortcuts after bounded change events; the original search result pinned, revealed and launched with local-shortcut history semantics and no process opened by the fixture.");

    runtime.setOpenedBy("original-Main-local-launch-reopen");
    await mainPage.send("Page.bringToFront");
    const inputPoint = await evaluate(mainPage, `(() => {
      const rect = document.querySelector('.search-input').getBoundingClientRect();
      return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};
    })()`);
    for (const type of ["mousePressed", "mouseReleased"]) await mainPage.send("Input.dispatchMouseEvent", { type, button:"left", clickCount:1, ...inputPoint });
    await key(mainPage, ",", "Comma", 4);
    await wait(childPage, "document.querySelector('.sources-panel')", "fresh settings session");
    await localPage();
    await wait(childPage, `Boolean(${row(LOCAL_FILE_PATH)})`, "fresh local list retains file");
    await childDriver.clickElement(`(${row(LOCAL_FOLDER_PATH)}).querySelector('.delete-btn')`, "original delete folder reference");
    await confirm();
    await wait(childPage, `!(${row(LOCAL_FOLDER_PATH)})`, "deleted folder row");
    await runtime.captureScreenshot(childPage, "child-local-launch-reopened", currentDocument.child);
    assert.equal(nativeFixture.snapshot().items.length, 1);
    const publish = (items, revision) => evaluate(mainPage,
      `window.__ATOOLS_LOCAL_LAUNCH_FIXTURE__.accept(${JSON.stringify(items)},${revision})`);
    await nativeFixture.installCollisionPair(publish);
    await closeChild();
    await evaluate(mainPage, `window.__ATOOLS_ZTOOLS_HOST_ADAPTER__.api.launch({type:'direct',subType:'local-shortcut',path:${JSON.stringify(LOCAL_COLLISION_B)},name:'ATools-duplicate.txt'})`);
    await evaluate(mainPage, `window.__ATOOLS_ZTOOLS_HOST_ADAPTER__.api.pinApp({type:'direct',subType:'local-shortcut',path:${JSON.stringify(LOCAL_COLLISION_B)},name:'ATools-duplicate.txt'})`);
    await evaluate(mainPage, "document.querySelector('.search-input').focus(); document.querySelector('.search-input').select()");
    await key(mainPage, "Backspace", "Backspace");
    await wait(mainPage, "document.querySelector('.search-input').value === ''", "Main home for stored duplicate target");
    await wait(mainPage, "Array.from(document.querySelectorAll('.app-name')).some(node => node.textContent.trim() === 'ATools-duplicate.txt')", "stored duplicate identity visible");
    await chooseContext("ATools-duplicate.txt", "reveal-in-finder", LOCAL_COLLISION_B);
    await nativeFixture.renameCollision(publish);
    await wait(mainPage, "Array.from(document.querySelectorAll('.app-name')).some(node => node.textContent.trim() === 'ATools renamed duplicate')", "stored target follows alias change by path");
    const removed = await chooseContext("ATools renamed duplicate", "unpin-app", LOCAL_COLLISION_B);
    assert.equal(removed.name, "ATools-duplicate.txt", "Unpin must retain the stored name after display alias changes");
    await wait(mainPage, `!JSON.parse(window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot().appState.values['pinned-commands'] || '[]').some(row => row.path === ${JSON.stringify(LOCAL_COLLISION_B)})`, "renamed duplicate unpinned by persisted identity");
    await runtime.captureScreenshot(mainPage, "main-local-launch-duplicate-safe", currentDocument.main);
    report.localLaunch = { passed:true, backend:"synthetic-native-transport/in-memory", rust:false, sqlite:false,
      osSelection:false, nativeDrag:false, realProcessesOpened:0, cancelledSelection:true,
      reopened:true, changedEvents:nativeFixture.snapshot().revision, operations:nativeFixture.snapshot().calls };
    report.localLaunch.duplicatePathPreserved = true;
    report.localLaunch.renamedPinRemovedByPersistedName = true;
    report.rendererFixture.snapshot = await evaluate(mainPage, "window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot()");
    report.rendererFixture.calls = report.rendererFixture.snapshot.calls;
    report.localLaunch.finalMainState = await evaluate(mainPage, "({items:window.__ATOOLS_LOCAL_LAUNCH_FIXTURE__.items, revision:window.__ATOOLS_LOCAL_LAUNCH_FIXTURE__.revision, launches:window.__ATOOLS_LOCAL_LAUNCH_FIXTURE__.launches, reveals:window.__ATOOLS_LOCAL_LAUNCH_FIXTURE__.reveals})");
    report.checks.push("A fresh original LocalLaunch document retained prior configuration and deletion removed only a reference; actual OS selectors, dragging and native file opening remain separate acceptance.");
    report.checks.push("Two configured files with the same basename retained the stored path in the original history/pin UI; a renamed pinned item unpinned using its persisted identity.");
  } };
}

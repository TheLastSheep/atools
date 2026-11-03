import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CdpClient, createPageWebSocketUrl, delay, formatConsoleArgs, launchChrome } from "./chrome-cdp-smoke-utils.mjs";
import { buildStaticBrowserFixture, previewStaticBrowserFixture } from "./lib/static-browser-fixture.mjs";
import { launcherFrontendSourceFiles } from "./lib/launcher-source-binding.mjs";

const root = new URL("../", import.meta.url);
const runId = randomUUID();
const output = new URL(`output/launcher-ui-2026-10-16/home-grid-${runId}/`, root);
const sourceFiles = [...new Set([
  ...launcherFrontendSourceFiles,
  "src/App.svelte", "src/components/HomePanel.svelte", "src/components/SearchBar.svelte",
  "src/components/ShellFrame.svelte", "src/lib/homeNavigation.ts", "src/lib/homeSurface.ts",
  "src/lib/commandHistory.ts", "src/lib/launcherPins.ts", "src/lib/settings.ts", "src/styles/global.css",
  "tests/components/homeGridBrowserFixture.ts", "tests/components/home-grid-browser.html",
  "scripts/lib/static-browser-fixture.mjs", "scripts/test-plugin-open-outcome-browser.mjs",
  "scripts/test-home-grid-browser.mjs", "scripts/chrome-cdp-smoke-utils.mjs", "scripts/lib/owned-vite-server.mjs",
  "scripts/lib/owned-vite-cli-process.mjs", "scripts/lib/owned-vite-cli-worker.mjs",
])].sort();
const checks = [], screenshots = [], requests = [], navigations = [], consoleIssues = [], expectedActivationLogs = [];
const cleanupEvidence = { fixtureApp: "not_started", cdp: "not_started", chrome: "not_started", vitePreview: "not_started", fixtureBuild: "not_started" };
let server, chrome, page, fixtureBuildDir, report, compiledFixture, fixtureDocumentUrl, fixtureReloads = 0, stage = "setup";
let sourceHashesAtStart;

async function hashSources() {
  return Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [
    file, createHash("sha256").update(await readFile(resolve(process.cwd(), file))).digest("hex"),
  ])));
}
async function cdp(method, params = {}) {
  return page.send(method, params, { timeoutMs: 12000 });
}
async function evaluate(expression) {
  const response = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  assert.ok(!response.exceptionDetails, response.exceptionDetails?.exception?.description || response.exceptionDetails?.text);
  return response.result.value;
}
async function waitFor(expression, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(expression);
    if (value) return value;
    await delay(35);
  }
  assert.fail(`Timed out waiting for ${expression}`);
}
async function captureFixtureReadiness(expectedCounts) {
  return evaluate(`(()=>{
    const panel=document.querySelector('.home-panel'),input=document.querySelector('[data-atools-search-input]');
    const grids=Array.from(panel?.querySelectorAll('.recent-grid')||[]).slice(0,2);
    const selected=panel?.querySelector('.recent-item-shell.selected');
    const storedCount=key=>{try{const value=JSON.parse(localStorage.getItem(key)||'null');return Array.isArray(value)?value.length:null}catch{return -1}};
    const active=document.activeElement;
    const focusCategory=active===input?'search':active?.matches('.recent-item')?'home-item':active===document.body?'body':'other';
    return {expected:${JSON.stringify(expectedCounts)},actualTotal:panel?.querySelectorAll('.recent-item-shell').length||0,
      sections:grids.map(grid=>({kind:grid.classList.contains('pinned-grid')?'pinned':'recent',label:(grid.previousElementSibling?.textContent||'').trim().slice(0,24),count:grid.querySelectorAll(':scope > .recent-item-shell').length})),
      selectedIndex:Number(selected?.dataset.homeCommandIndex??-1),selectedLabel:(selected?.querySelector('.recent-label')?.textContent||'').trim().slice(0,48),
      searchFocused:active===input,focusCategory,storageCounts:{pinned:storedCount('atools:pinned-commands'),snapshots:storedCount('atools:launcher-pin-snapshots:v1'),history:storedCount('atools:command-history')},
      catalogCount:window.homeGridFixture?.features?.length||0,viewportWidth:innerWidth};
  })()`);
}
async function waitForFixtureReadiness(counts, label) {
  const expectedCount = counts.pinnedCount + counts.recentVisibleCount;
  try {
    await waitFor(`window.homeGridFixture && document.querySelector('.home-panel')?.querySelectorAll('.recent-item-shell').length===${expectedCount} && document.querySelector('[data-atools-search-input]')===document.activeElement`);
  } catch {
    const observed = await captureFixtureReadiness(counts).catch(() => ({ capture: "unavailable" }));
    assert.fail(`Home grid ${label} did not reach its seeded counts and search focus: ${JSON.stringify(observed)}`);
  }
}
async function key(keyValue, code, virtualKey, modifiers = 0, isComposing = false) {
  const params = { key: keyValue, code, windowsVirtualKeyCode: virtualKey, modifiers, isComposing };
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...params });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...params });
  await delay(70);
}
async function selectedIndex() {
  return evaluate("Number(document.querySelector('.recent-item-shell.selected')?.dataset.homeCommandIndex ?? -1)");
}
async function expectSelection(index, label) {
  await waitFor(`Number(document.querySelector('.recent-item-shell.selected')?.dataset.homeCommandIndex??-1)===${index}`);
  const state = await captureLayout(label);
  assert.equal(state.selectedIndex, index, `${label}: wrong selected home tile`);
  assert.equal(state.selectedVisible, true, `${label}: selected tile is outside HomePanel viewport: ${JSON.stringify(state)}`);
  assert.equal(state.searchFocused, true, `${label}: search input lost focus`);
  return state;
}
async function captureLayout(label) {
  const state = await evaluate(`(()=>{
    const label=${JSON.stringify(label)};
    const panel=document.querySelector('.home-panel'),shell=document.querySelector('.shell-frame'),surface=document.querySelector('.search-surface'),input=document.querySelector('[data-atools-search-input]'),selected=panel?.querySelector('.recent-item-shell.selected'),rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {top:r.top,left:r.left,width:r.width,height:r.height,bottom:r.bottom,right:r.right}};
    const pr=rect(panel),ir=rect(selected),sr=rect(shell),viewportTop=pr?pr.top+panel.clientTop:0,viewportBottom=viewportTop+(panel?.clientHeight||0),grids=Array.from(panel?.querySelectorAll('.recent-grid')||[]);
    const pinned=grids.find(grid=>grid.classList.contains('pinned-grid')),recent=grids.find(grid=>!grid.classList.contains('pinned-grid'));
    const recentCells=Array.from(recent?.querySelectorAll(':scope > .recent-item-shell')||[]),firstRecent=recentCells[0],firstLabel=firstRecent?.querySelector('.recent-label');
    const firstRect=firstRecent?.getBoundingClientRect(),firstRow=firstRect?recentCells.filter(cell=>Math.abs(cell.getBoundingClientRect().top-firstRect.top)<1):[];
    return {label,viewport:{width:innerWidth,height:innerHeight},selectedIndex:Number(selected?.dataset.homeCommandIndex??-1),selectedLabel:selected?.querySelector('.recent-label')?.textContent?.trim()||null,homeCount:panel?.querySelectorAll('.recent-item-shell').length||0,pinnedCount:pinned?.querySelectorAll(':scope > .recent-item-shell').length||0,recentCount:recent?.querySelectorAll(':scope > .recent-item-shell').length||0,gridColumns:grids.map(grid=>getComputedStyle(grid).gridTemplateColumns.split(' ').length),pinnedColumns:pinned?getComputedStyle(pinned).gridTemplateColumns.split(' ').length:0,recentColumns:recent?getComputedStyle(recent).gridTemplateColumns.split(' ').length:0,recentFirstRowItems:firstRow.length,minimumRecentTileWidth:firstRow.length?Math.min(...firstRow.map(cell=>cell.getBoundingClientRect().width)):0,firstRecentLabel:firstLabel?.textContent?.trim()||null,recentLabels:Array.from(recent?.querySelectorAll(':scope > .recent-item-shell .recent-label')||[]).slice(0,2).map(label=>label.textContent?.trim()||null),firstRecentLabelFits:Boolean(firstLabel&&firstLabel.scrollWidth<=firstLabel.clientWidth),homePanel:{rect:pr,clientHeight:panel?.clientHeight||0,scrollHeight:panel?.scrollHeight||0,scrollTop:panel?.scrollTop||0},selectedRect:ir,selectedVisible:Boolean(ir&&ir.top>=viewportTop-1&&ir.bottom<=viewportBottom+1),selectedCenterX:ir?ir.left+ir.width/2:null,shellFrame:sr,shellScrollTop:shell?.scrollTop||0,surfaceScrollTop:surface?.scrollTop||0,documentScrollTop:document.scrollingElement?.scrollTop||0,searchFocused:document.activeElement===input,searchValue:input?.value||'',unexpectedCommands:window.homeGridFixture?.unexpectedCommands||[]};
  })()`);
  return state;
}
async function screenshot(name) {
  await cdp("Page.bringToFront");
  await evaluate("Promise.race([new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))),new Promise(resolve=>setTimeout(resolve,1500))])");
  await delay(80);
  const capture = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const bytes = Buffer.from(capture.data, "base64");
  const file = `${name}-${runId}.png`;
  await writeFile(new URL(file, output), bytes);
  const evidence = { file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  screenshots.push(evidence);
  return evidence;
}
async function viewport(width, height = 280) {
  await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await waitFor(`innerWidth===${width}&&innerHeight===${height}`);
  await delay(100);
}
async function resetFixture(width, counts = { pinnedCount: 3, historyCount: 18, historyOffset: 0, recentVisibleCount: 18 }) {
  const reset = await evaluate(`window.homeGridFixture.resetFixture(${JSON.stringify(counts)}).then(()=>true)`);
  assert.equal(reset, true);
  const expectedCount = counts.pinnedCount + counts.recentVisibleCount;
  await waitForFixtureReadiness(counts, "remount");
  await viewport(width);
  await delay(220);
  const state = await captureLayout(`initial-${width}`);
  assert.equal(state.selectedIndex, 0);
  assert.equal(state.homeCount, expectedCount, `Synthetic home should contain ${counts.pinnedCount} pinned and ${counts.recentVisibleCount} visible recent commands`);
  if (width > 640) {
    assert.equal(state.recentColumns, 9, "The wide HomePanel should retain its nine-column layout");
    assert.equal(state.pinnedColumns, 9, "Wide pinned and recent grids should share nine columns");
  } else {
    assert.ok(state.recentColumns >= 3 && state.recentColumns < 9, `The compact HomePanel should fit useful tiles without reverting to nine columns: ${JSON.stringify(state)}`);
    assert.ok(state.minimumRecentTileWidth >= 64, `Compact recent tiles should meet the 64px minimum: ${JSON.stringify(state)}`);
    if (counts.historyCount > 0 && counts.historyOffset === 0) {
      assert.equal(state.firstRecentLabel, "结果中心");
      assert.equal(state.firstRecentLabelFits, true, `The long recent title should fit at compact width: ${JSON.stringify(state)}`);
    }
    assert.equal(state.pinnedColumns, state.recentColumns, `Pinned and recent grids should retain matching auto-fill tracks: ${JSON.stringify(state)}`);
  }
  assert.equal(state.searchFocused, true);
  assert.equal(state.selectedVisible, true);
  return state;
}
async function reloadFixture(width, counts, expectedRecentLabels) {
  assert.equal(await evaluate(`window.homeGridFixture.prepareReload(${JSON.stringify(counts)})`), true);
  const loaded = page.waitForEvent("Page.loadEventFired", 15000);
  await cdp("Page.navigate", { url: fixtureDocumentUrl });
  await loaded;
  fixtureReloads += 1;
  await waitForFixtureReadiness(counts, "fresh document");
  await viewport(width);
  await delay(220);
  const state = await captureLayout(`fresh-document-${width}-${counts.pinnedCount}-${counts.recentVisibleCount}`);
  assert.equal(state.homeCount, counts.pinnedCount + counts.recentVisibleCount, `Fresh fixture should contain the exact requested ${counts.pinnedCount}/${counts.recentVisibleCount} displayed counts`);
  assert.equal(state.pinnedCount, counts.pinnedCount, "Fresh fixture pinned section should match the requested size");
  assert.equal(state.recentCount, counts.recentVisibleCount, "Fresh fixture recent section should match the requested visible size");
  assert.deepEqual(state.recentLabels, expectedRecentLabels, "Fresh fixture should render the intended first recent item identities");
  assert.equal(state.firstRecentLabelFits, true, "Fresh fixture first recent label should fit at compact width");
  assert.equal(state.selectedIndex, 0);
  assert.equal(state.searchFocused, true);
  return state;
}
async function navigateAndCheck(width) {
  let before = await captureLayout(`navigation-start-${width}`);
  const initialShell = before.shellFrame;
  const columns = before.recentColumns;
  await key("ArrowLeft", "ArrowLeft", 37);
  await expectSelection(0, "left-boundary");
  await key("ArrowUp", "ArrowUp", 38);
  await expectSelection(0, "top-boundary");

  const inputPresent = await evaluate("Boolean(document.querySelector('[data-atools-search-input]'))");
  await evaluate("document.querySelector('[data-atools-search-input]').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}))");
  await key("ArrowDown", "ArrowDown", 40, 0, true);
  const composingSelection = await selectedIndex();
  await evaluate("document.querySelector('[data-atools-search-input]').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:''}))");
  assert.equal(composingSelection, 0, "ArrowDown during IME composition must not navigate");
  assert.equal(inputPresent, true, "Search input should exist throughout the flow");

  await key("ArrowDown", "ArrowDown", 40);
  await expectSelection(3, "pinned-first-row-down");
  const shortColumn = Math.min(2, columns - 1);
  for (let index = 0; index < shortColumn; index += 1) await key("ArrowRight", "ArrowRight", 39);
  await expectSelection(3 + shortColumn, "recent-first-row-column");
  await key("ArrowDown", "ArrowDown", 40);
  await expectSelection(3 + columns + shortColumn, "recent-row-two-same-column");

  await resetFixture(width);
  await key("ArrowDown", "ArrowDown", 40);
  const longColumn = Math.min(6, columns - 1);
  for (let index = 0; index < longColumn; index += 1) await key("ArrowRight", "ArrowRight", 39);
  await expectSelection(3 + longColumn, "recent-column-up-source");
  await key("ArrowUp", "ArrowUp", 38);
  await expectSelection(2, "recent-column-up-clamps-to-pinned-final-item");

  await resetFixture(width);
  await key("ArrowDown", "ArrowDown", 40);
  const recentRows = Math.ceil(18 / columns);
  for (let row = 1; row < recentRows; row += 1) await key("ArrowDown", "ArrowDown", 40);
  const lastRowLength = 18 - (recentRows - 1) * columns;
  for (let column = 1; column < lastRowLength; column += 1) await key("ArrowRight", "ArrowRight", 39);
  await expectSelection(20, "recent-last-item");
  await key("ArrowRight", "ArrowRight", 39);
  await key("ArrowDown", "ArrowDown", 40);
  before = await expectSelection(20, "right-and-bottom-boundary");
  assert.deepEqual(before.shellFrame, initialShell, "Keyboard navigation must not resize or move the outer shell");
  assert.equal(before.shellScrollTop, 0);
  assert.equal(before.surfaceScrollTop, 0);
  assert.equal(before.documentScrollTop, 0);
  return before;
}
async function captureStatesAtWidth(width) {
  const initial = await resetFixture(width);
  const initialShot = await screenshot(`home-first-selected-${width}x280-light`);
  const last = await navigateAndCheck(width);
  const lastShot = await screenshot(`home-last-selected-${width}x280-light`);
  assert.ok(last.homePanel.scrollTop > 0, `Selected last tile should scroll the HomePanel at ${width}px: ${JSON.stringify(last)}`);
  assert.deepEqual(last.shellFrame, initial.shellFrame, "HomePanel scrolling must preserve the ShellFrame viewport");
  assert.equal(last.documentScrollTop, initial.documentScrollTop);
  assert.equal(last.shellScrollTop, initial.shellScrollTop);
  assert.equal(last.surfaceScrollTop, initial.surfaceScrollTop);
  return { initial, last, screenshots: [initialShot, lastShot] };
}
async function checkTabAndEnter() {
  const width = 420;
  const initial = await resetFixture(width);
  const columns = initial.recentColumns;
  await key("Tab", "Tab", 9);
  await waitFor("document.activeElement?.matches('[data-home-command-index=\"0\"] .recent-item')");
  const tabFocus = await captureLayout("tab-focuses-current-home-selection");
  assert.equal(tabFocus.selectedIndex, 0);
  assert.equal(tabFocus.selectedVisible, true);
  assert.equal(tabFocus.searchFocused, false, "Tab should move focus from search to its selected Home card");
  await key("Tab", "Tab", 9, 8);
  await waitFor("document.activeElement?.getAttribute('aria-label')==='打开设置'");
  const settingsFocus = await captureLayout("shift-tab-follows-native-order-to-settings");
  assert.equal(await evaluate("document.activeElement?.getAttribute('aria-label')"), "打开设置");
  assert.equal(settingsFocus.selectedIndex, 0, "Shift+Tab to Settings should preserve Home selection");
  assert.equal(await evaluate("window.homeGridFixture.calls.filter(call=>call.command==='activate_feature').length"), 0);

  await key("Tab", "Tab", 9, 8);
  await waitFor("document.activeElement===document.querySelector('[data-atools-search-input]')");
  const shiftTabState = await captureLayout("shift-tab-returns-focus-to-search");
  assert.equal(shiftTabState.searchFocused, true, "Shift+Tab should return focus to search from its current Home card");
  assert.equal(shiftTabState.selectedIndex, 0, "Native reverse Tab traversal should not change Home selection");
  assert.equal(await evaluate("window.homeGridFixture.calls.filter(call=>call.command==='activate_feature').length"), 0);

  await resetFixture(width);

  await key("ArrowDown", "ArrowDown", 40);
  const recentColumn = Math.min(6, columns - 1);
  for (let index = 0; index < recentColumn; index += 1) await key("ArrowRight", "ArrowRight", 39);
  await expectSelection(3 + recentColumn, "history-command-before-enter");
  await key("Enter", "Enter", 13);
  await waitFor("window.homeGridFixture.activationPending===true");
  const activation = await evaluate("window.homeGridFixture.calls.filter(call=>call.command==='activate_feature').at(-1)");
  assert.deepEqual(activation.args, { code: `home-history-${recentColumn}`, payload: null, expectedPluginId: "synthetic-home-plugin" });
  assert.equal(await evaluate("Boolean(document.querySelector('iframe[title=Plugin]'))"), false);
  await evaluate("window.homeGridFixture.rejectActivation()");
  await waitFor("document.querySelector('.plugin-activation-error[role=alert]')?.textContent.includes('插件未能打开')");
  const failed = await evaluate(`(()=>({message:document.querySelector('.plugin-activation-error[role=alert]')?.textContent?.trim(),rawPrivateError:document.body.innerText.includes('Synthetic private activation failure'),pluginFrame:Boolean(document.querySelector('iframe[title="Plugin"]')),searchFocused:document.activeElement===document.querySelector('[data-atools-search-input]')}))()`);
  assert.deepEqual(failed, { message: "插件未能打开，请检查插件状态后重试。", rawPrivateError: false, pluginFrame: false, searchFocused: true });
  return { tabNavigation: { afterPlainTab: tabFocus.selectedIndex, afterFirstShiftTab: "settings", afterSecondShiftTab: shiftTabState.selectedIndex }, activation, failed };
}

async function checkUnequalSectionDensity() {
  const observations = [];
  for (const scenario of [
    { pinnedCount: 2, historyCount: 7, historyOffset: 1, recentVisibleCount: 9, expectedRecentLabels: ["最近 1", "最近 2"], label: "sparse-pinned" },
    { pinnedCount: 9, historyCount: 0, historyOffset: 0, recentVisibleCount: 2, expectedRecentLabels: ["结果中心", "设置"], label: "sparse-recent" },
  ]) {
    const before = await reloadFixture(420, scenario, scenario.expectedRecentLabels);
    assert.equal(before.pinnedColumns, before.recentColumns, `${scenario.label}: section grids should share compact tracks`);
    const sourceIndex = scenario.label === "sparse-pinned"
      ? 1
      : Math.floor((scenario.pinnedCount - 1) / before.pinnedColumns) * before.pinnedColumns;
    if (scenario.label === "sparse-pinned") {
      await key("ArrowRight", "ArrowRight", 39);
    } else {
      let reachedLastPinnedRow = await selectedIndex();
      while (reachedLastPinnedRow < sourceIndex) {
        await key("ArrowDown", "ArrowDown", 40);
        reachedLastPinnedRow = await selectedIndex();
      }
    }
    const source = await captureLayout(`${scenario.label}-source`);
    assert.equal(source.selectedIndex, sourceIndex);
    await key("ArrowDown", "ArrowDown", 40);
    const target = await captureLayout(`${scenario.label}-target`);
    assert.equal(target.selectedIndex, scenario.pinnedCount === 2 ? 3 : scenario.pinnedCount);
    assert.equal(source.selectedVisible, true, `${scenario.label}: source item must be visible`);
    assert.equal(target.selectedVisible, true, `${scenario.label}: target item must be visible`);
    assert.ok(Number.isFinite(source.selectedCenterX), `${scenario.label}: source center must be measurable`);
    assert.ok(Number.isFinite(target.selectedCenterX), `${scenario.label}: target center must be measurable`);
    assert.ok(Math.abs(source.selectedCenterX - target.selectedCenterX) <= 1,
      `${scenario.label}: adjacent section item should share the selected track center`);
    observations.push({ label: scenario.label, requestedCounts: { pinned: scenario.pinnedCount, recent: scenario.recentVisibleCount },
      seededHistoryCount: scenario.historyCount, historyOffset: scenario.historyOffset,
      actualHomeCount: before.homeCount, actualPinnedCount: before.pinnedCount, actualRecentCount: before.recentCount, actualRecentLabels: before.recentLabels,
      pinnedColumns: before.pinnedColumns, recentColumns: before.recentColumns,
      sourceCenterX: source.selectedCenterX, targetCenterX: target.selectedCenterX });
  }
  return observations;
}

try {
  await mkdir(output, { recursive: true });
  sourceHashesAtStart = await hashSources();
  fixtureBuildDir = await mkdtemp(join(tmpdir(), `atools-home-grid-${runId}-`));
  stage = "build-static-home-grid-fixture";
  compiledFixture = await buildStaticBrowserFixture({
    projectRoot: process.cwd(),
    entryHtml: "tests/components/home-grid-browser.html",
    outDir: join(fixtureBuildDir, "dist"),
  });
  assert.equal(compiledFixture.htmlFile, "tests/components/home-grid-browser.html");
  const staticSource = (await Promise.all(compiledFixture.outputFiles
    .filter((file) => file.endsWith(".html") || file.endsWith(".js"))
    .map((file) => readFile(join(fixtureBuildDir, "dist", file), "utf8")))).join("\n");
  assert.equal(staticSource.includes("@vite/client"), false, "Static fixture must not include Vite dev client output");
  assert.equal(staticSource.includes("import.meta.hot"), false, "Static fixture must not include HMR hooks");
  server = await previewStaticBrowserFixture({ projectRoot: process.cwd(), outDir: join(fixtureBuildDir, "dist"), host: "127.0.0.1", port: 1459 });
  chrome = await launchChrome();
  page = await CdpClient.connect(await createPageWebSocketUrl(chrome.webSocketUrl));
  await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Network.enable");
  page.on("Runtime.exceptionThrown", (event) => consoleIssues.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  page.on("Runtime.consoleAPICalled", ({ type, args }) => {
    if (!["error", "warning", "assert"].includes(type)) return;
    const entry = `${type}:${formatConsoleArgs(args)}`;
    if (type === "error" && entry === "error:Plugin activation failed.") expectedActivationLogs.push(entry);
    else consoleIssues.push(entry);
  });
  page.on("Network.requestWillBeSent", (event) => requests.push(event.request.url));
  page.on("Page.frameNavigated", (event) => { if (!event.frame.parentId) navigations.push(event.frame.url); });
  await cdp("Emulation.setDeviceMetricsOverride", { width: 800, height: 280, deviceScaleFactor: 1, mobile: false });
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  const loaded = page.waitForEvent("Page.loadEventFired", 15000);
  fixtureDocumentUrl = `http://127.0.0.1:1459/${compiledFixture.htmlFile}`;
  await cdp("Page.navigate", { url: fixtureDocumentUrl });
  await loaded;
  await waitFor("window.homeGridFixture && document.querySelector('.home-panel')?.querySelectorAll('.recent-item-shell').length===21 && document.activeElement===document.querySelector('[data-atools-search-input]')");
  checks.push("Prebuilt Vite HTML entry starts the real App HomePanel with 3 pinned and 18 recent synthetic catalog entries; unknown native IPC is rejected by the fixture");

  stage = "home-grid-800-width-navigation";
  const wide = await captureStatesAtWidth(800);
  checks.push("At 800×280, first and last selected tiles remain visible; 9-column navigation, IME guard, exact shell/window scroll invariance, and HomePanel-only scrolling pass");
  stage = "home-grid-420-width-navigation";
  const narrow = await captureStatesAtWidth(420);
  checks.push("At 420×280, the measured responsive column count matches ArrowUp/ArrowDown movement, long recent title fits a >=64px tile, and HomePanel scrolling preserves the outer shell and search focus");
  stage = "home-grid-unequal-section-density";
  const unequalSectionDensity = await checkUnequalSectionDensity();
  checks.push("At 420px, exact 2/9 and 9/2 visible section sizes retain shared auto-fill tracks and ArrowDown crosses aligned columns; the 2/9 fixture seeds seven distinct history entries plus the two existing panel recommendations, while 9/2 uses those two recommendations only");
  stage = "tab-and-enter-outcome";
  const activation = await checkTabAndEnter();
  checks.push("Tab focuses the selected Home card and Shift+Tab returns focus to search without activation; the independent Enter case sends the exact synthetic owner/code and renders only fixed failure copy after rejection");

  const external = requests.find((url) => { try { return new URL(url).origin !== "http://127.0.0.1:1459"; } catch { return true; } });
  assert.equal(external, undefined, `Unexpected external request: ${external}`);
  assert.equal(requests.some((url) => url.includes("@vite/client")), false, "Static preview must not load Vite dev client or HMR");
  assert.deepEqual(await evaluate("window.homeGridFixture.unexpectedCommands"), [], "Unknown IPC command was attempted");
  assert.deepEqual(consoleIssues, []);
  assert.deepEqual(expectedActivationLogs, ["error:Plugin activation failed."]);
  assert.equal(navigations.length, 1 + fixtureReloads, "Only the initial page and the explicitly requested fixture resets should navigate");
  assert.ok(navigations.every((url) => url === fixtureDocumentUrl), "Fixture reloads must stay on the same local static document");
  const sourceHashesAtEnd = await hashSources();
  assert.deepEqual(sourceHashesAtEnd, sourceHashesAtStart, "Sources changed while the browser fixture was running");
  report = {
    runId, passed: true, stage,
    scope: "Static Vite build/preview of the actual ATools HomePanel in headless Chromium. Synthetic localStorage/catalog/IPC only; activation is held and rejected with fixed fixture text. No plugin code, external network, OS operation, or native host is executed.",
    checks, compiledFixture, wide, narrow, unequalSectionDensity, activation,
    navigations, networkRequests: requests, consoleIssues, expectedActivationLogs,
    unexpectedCommands: [], sourceFilesSha256: sourceHashesAtStart, sourceFilesSha256AtEnd: sourceHashesAtEnd,
    sourceHashStable: true, screenshots,
  };
} catch (error) {
  report = {
    runId, passed: false, stage,
    error: error instanceof Error ? error.message : String(error),
    checks, compiledFixture, navigations, networkRequests: requests, consoleIssues, expectedActivationLogs, screenshots,
    sourceFilesSha256: sourceHashesAtStart ?? await hashSources().catch(() => ({})),
  };
  process.exitCode = 1;
} finally {
  cleanupEvidence.fixtureApp = page
    ? await evaluate("window.homeGridFixture?.disposeFixture().then(()=>true)").then((value) => value ? "fulfilled" : "failed", () => "not_ready")
    : "not_started";
  cleanupEvidence.cdp = page ? await Promise.resolve(page.close()).then(() => "fulfilled", () => "failed") : "not_started";
  cleanupEvidence.chrome = chrome ? await Promise.resolve(chrome.close()).then(() => "fulfilled", () => "failed") : "not_started";
  cleanupEvidence.vitePreview = server ? await Promise.resolve(server.close()).then(() => "fulfilled", () => "failed") : "not_started";
  cleanupEvidence.fixtureBuild = fixtureBuildDir ? await rm(fixtureBuildDir, { recursive: true, force: true }).then(() => "fulfilled", () => "failed") : "not_started";
  if (Object.values(cleanupEvidence).includes("failed")) {
    process.exitCode = 1;
    report ??= { runId, stage, error: "Runner exited before report creation" };
    report.passed = false;
    report.cleanupError = "One or more owned browser resources did not confirm cleanup";
  }
  report ??= { runId, passed: false, stage, error: "Runner exited before report creation" };
  report.cleanupEvidence = cleanupEvidence;
  report.processExitEvidence = { runnerPid: process.pid, exitCode: process.exitCode ?? 0, externallyObserved: false };
  await writeFile(new URL("report.json", output), JSON.stringify(report, null, 2) + "\n");
  await writeFile(new URL(`report-${runId}.json`, output), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ runId, passed: report.passed, stage: report.stage, checks, screenshots, cleanupEvidence }));
}

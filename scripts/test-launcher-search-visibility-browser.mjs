import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CdpClient, createPageWebSocketUrl, formatConsoleArgs, delay } from "./chrome-cdp-smoke-utils.mjs";
import { buildStaticBrowserFixture, previewStaticBrowserFixture } from "./lib/static-browser-fixture.mjs";
import { launchOwnedChrome } from "./lib/launcher-menu-browser-runtime.mjs";

const projectRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const runId = randomUUID();
const output = join(projectRoot, "output", "main-shell-refactor-2026-10-26", `browser-${runId}`);
const entryHtml = "tests/components/launcher-search-visibility-browser.html";
const previewPort = 1479;
const sourcePaths = [
  "src/App.svelte",
  "src/lib/launcherSearchController.ts",
  "src/lib/launcherInteractionRuntime.ts",
  "src/lib/launcherContentIntakeController.ts",
  "src/lib/launcherSurfacePresentation.svelte.ts",
  "src/lib/launcherHomeController.ts",
  "src/lib/launcherSearch.ts",
  "src/lib/launcherKeyboardController.ts",
  "src/lib/launcherRuntimeLifecycle.ts",
  "src/lib/launcherMainPush.ts",
  "src/lib/settings.ts",
  "src/lib/launcherTauriWindowRuntime.ts",
  "src/components/SearchBar.svelte",
  "src/components/ResultsList.svelte",
  "src/components/ResultRow.svelte",
  "src/components/LauncherPrimarySurface.svelte",
  "src/components/LauncherMainPushHost.svelte",
  "src/components/ShellFrame.svelte",
  "src/styles/global.css",
  "tests/components/launcherSearchVisibilityBrowserFixture.ts",
  "tests/components/launcherReturnContextFixture.ts",
  entryHtml,
  "scripts/test-launcher-search-visibility-browser.mjs",
  "scripts/chrome-cdp-smoke-utils.mjs",
  "scripts/lib/static-browser-fixture.mjs",
  "scripts/lib/launcher-menu-browser-runtime.mjs",
  "vite.config.ts",
];

let buildDirectory;
let server;
let chrome;
let mainPage;
let secondPage;
let origin = "";
let compiledFixture = null;
let sourceHashBefore = [];
let sourceHashAfter = [];
let finalFixtureSnapshot = null;
let status = "failed";
let failure = null;
let cleanupIncomplete = false;
const cleanup = [];
const checks = [];
const screenshots = [];
const screenshotErrors = [];
const requests = [];
const issues = [];
const visibilityTransitions = [];
const themeTransitionWaits = [];
const geometry = [];

async function fingerprintSources() {
  return Promise.all(sourcePaths.map(async (path) => ({
    path,
    sha256: createHash("sha256").update(await readFile(join(projectRoot, path))).digest("hex"),
  })));
}

async function evaluate(page, expression) {
  const response = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "CDP evaluation failed");
  }
  return response.result?.value;
}

async function waitFor(page, expression, description, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await evaluate(page, expression);
    if (lastValue) return lastValue;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${description}; last value=${JSON.stringify(lastValue)}`);
}

async function waitForFiniteThemeTransitions(theme, timeoutMs = 2000) {
  const state = await evaluate(mainPage, `(()=>new Promise(resolve=>{
    const nextFrame=()=>new Promise(done=>requestAnimationFrame(()=>done()));
    (async()=>{
      await nextFrame();
      await nextFrame();
      const transitions=document.getAnimations({subtree:true}).filter(animation=>
        animation.constructor?.name==='CSSTransition'&&animation.playState==='running'&&
        Number.isFinite(animation.effect?.getComputedTiming().iterations));
      const finish=(timedOut)=>resolve({
        theme:document.documentElement.dataset.atoolsTheme,
        transitionCount:transitions.length,
        timedOut,
      });
      if(transitions.length===0){finish(false);return;}
      let settled=false;
      const timer=setTimeout(()=>{if(!settled){settled=true;finish(true);}},${timeoutMs});
      Promise.allSettled(transitions.map(animation=>animation.finished)).then(()=>{
        if(settled)return;
        settled=true;
        clearTimeout(timer);
        finish(false);
      });
    })().catch(()=>resolve({theme:document.documentElement.dataset.atoolsTheme,transitionCount:0,timedOut:true}));
  }))()`);
  assert.equal(state.theme, theme, `Theme changed while waiting for CSS transitions: ${JSON.stringify(state)}`);
  assert.equal(state.timedOut, false, `Finite CSS theme transitions did not settle within ${timeoutMs}ms: ${JSON.stringify(state)}`);
  return state;
}

async function connectPage(webSocketUrl) {
  const page = await CdpClient.connect(webSocketUrl);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Network.enable");
  page.on("Runtime.exceptionThrown", (event) => {
    issues.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || "runtime exception");
  });
  page.on("Runtime.consoleAPICalled", ({ type, args }) => {
    if (type === "error") issues.push(`console.error:${formatConsoleArgs(args)}`);
  });
  page.on("Network.requestWillBeSent", (event) => requests.push({ url: event.request.url, type: event.type || "unknown" }));
  page.on("Network.loadingFailed", (event) => {
    issues.push(`network.loadingFailed:${event.errorText || "unknown"}:${event.requestId}`);
  });
  return page;
}

async function navigateMainPage() {
  const loaded = mainPage.waitForEvent("Page.loadEventFired", 30000);
  await mainPage.send("Page.navigate", { url: `${origin}/${entryHtml}` });
  await loaded;
  await waitFor(mainPage,
    "window.launcherSearchVisibilityBrowserReady === true || typeof window.launcherSearchVisibilityBrowserStartError === 'string'",
    "visibility fixture mount");
  const ready = await evaluate(mainPage, "window.launcherSearchVisibilityBrowserReady === true");
  assert.equal(ready, true, `Fixture startup failed: ${await evaluate(mainPage, "window.launcherSearchVisibilityBrowserStartError || 'unknown startup error'")}`);
  await waitFor(mainPage, "document.querySelector('.shell-frame') !== null", "real App shell");
  await waitFor(mainPage, "document.documentElement.dataset.atoolsTheme === 'light'", "initial fixture settings");
}

async function typeQuery(query) {
  await evaluate(mainPage, "document.querySelector('[data-atools-search-input]')?.focus()");
  await mainPage.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: "a", code: "KeyA", modifiers: 4, commands: ["selectAll"],
  });
  await mainPage.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 4 });
  if (query) await mainPage.send("Input.insertText", { text: query });
  else {
    await mainPage.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await mainPage.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  }
  await waitFor(mainPage,
    `document.querySelector('[data-atools-search-input]')?.value === ${JSON.stringify(query)}`,
    `real search input value ${query}`);
}

async function pressArrowDown() {
  await mainPage.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
  await mainPage.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
}

async function fixtureSnapshot() {
  return evaluate(mainPage, "window.launcherSearchVisibilityBrowserFixture.snapshot()");
}

function searchCount(snapshot, command, query) {
  return snapshot.searchCalls.filter((call) => call.command === command && call.query === query).length;
}

function commandCount(snapshot, command) {
  return snapshot.calls.filter((call) => call.command === command).length;
}

async function setViewport(width, height = 600) {
  await mainPage.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await delay(100);
}

async function assertGeometry(width, theme) {
  const value = await evaluate(mainPage, `(()=>{
    const shell=document.querySelector('.shell-frame');
    const input=document.querySelector('[data-atools-search-input]');
    const results=document.querySelector('.results-list');
    const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
    return{width:innerWidth,theme:document.documentElement.dataset.atoolsTheme,documentWidth:document.documentElement.scrollWidth,
      bodyWidth:document.body.scrollWidth,shell:rect(shell),input:rect(input),results:rect(results)};
  })()`);
  assert.ok(value?.shell && value.input, "Real App shell and search input must exist");
  assert.ok(value.results, "The query results surface must be visible during layout checks");
  assert.equal(value.width, width);
  assert.equal(value.theme, theme);
  assert.ok(value.documentWidth <= width + 1 && value.bodyWidth <= width + 1, `App page overflow: ${JSON.stringify(value)}`);
  for (const [name, rect] of [["shell", value.shell], ["input", value.input], ["results", value.results]]) {
    if (!rect) continue;
    assert.ok(rect.left >= -1 && rect.right <= width + 1, `${name} overflows ${width}px viewport: ${JSON.stringify(rect)}`);
  }
  geometry.push(value);
}

async function screenshot(name) {
  try {
    const result = await mainPage.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(join(output, `${name}.png`), Buffer.from(result.data, "base64"), { flag: "wx" });
    screenshots.push(name);
  } catch (error) {
    screenshotErrors.push({ name, error: error.stack || String(error) });
  }
}

async function closeOwned(name, close) {
  try {
    await close();
    cleanup.push({ resource: name, state: "closed" });
  } catch (error) {
    cleanupIncomplete = true;
    cleanup.push({ resource: name, state: "close_failed", error: error.stack || String(error) });
  }
}

async function removeBuildDirectory() {
  if (!buildDirectory) {
    cleanup.push({ resource: "fixture-build", state: "not_created" });
    return;
  }
  try {
    await rm(buildDirectory, { recursive: true, force: true });
    try {
      await access(buildDirectory);
      throw new Error("Static fixture build directory still exists");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    cleanup.push({ resource: "fixture-build", state: "removed" });
  } catch (error) {
    cleanupIncomplete = true;
    cleanup.push({ resource: "fixture-build", state: "remove_failed", error: error.stack || String(error) });
  }
}

await mkdir(output, { recursive: false });
try {
  sourceHashBefore = await fingerprintSources();
  await writeFile(join(output, "source-hash-before.json"), JSON.stringify(sourceHashBefore, null, 2) + "\n", { flag: "wx" });

  buildDirectory = await mkdtemp(join(tmpdir(), `atools-search-visibility-${runId}-`));
  compiledFixture = await buildStaticBrowserFixture({ projectRoot, entryHtml, outDir: join(buildDirectory, "dist") });
  assert.equal(compiledFixture.htmlFile, entryHtml);
  const bundleText = (await Promise.all(compiledFixture.outputFiles
    .filter((file) => file.endsWith(".html") || file.endsWith(".js"))
    .map((file) => readFile(join(buildDirectory, "dist", file), "utf8")))).join("\n");
  assert.equal(bundleText.includes("@vite/client"), false, "Static fixture must not include Vite dev client/HMR");
  assert.equal(bundleText.includes("import.meta.hot"), false, "Static fixture must not include HMR hooks");
  checks.push("The fixture is a static Vite bundle without dev-server or HMR hooks");

  server = await previewStaticBrowserFixture({ projectRoot, outDir: join(buildDirectory, "dist"), host: "127.0.0.1", port: previewPort });
  const address = server.httpServer.address();
  assert.ok(address && typeof address === "object" && address.port === previewPort, `Owned preview must bind fixed port ${previewPort}`);
  origin = `http://127.0.0.1:${previewPort}`;

  chrome = await launchOwnedChrome();
  mainPage = await connectPage(await createPageWebSocketUrl(chrome.webSocketUrl));
  await mainPage.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
  await mainPage.send("Page.bringToFront");
  await navigateMainPage();

  const fixtureInfo = await evaluate(mainPage, "({queries:window.launcherSearchVisibilityBrowserFixture.queries,codes:window.launcherSearchVisibilityBrowserFixture.codes})");
  const seed = fixtureInfo.queries.seed;
  const appCode = fixtureInfo.codes.localApp;
  await typeQuery(seed);
  await waitFor(mainPage, `(()=>{const f=window.launcherSearchVisibilityBrowserFixture,s=f.snapshot();return s.searchCalls.some(c=>c.command==='search_features'&&c.query===${JSON.stringify(seed)}&&c.attempt===1)&&s.searchCalls.some(c=>c.command==='search_local_apps'&&c.query===${JSON.stringify(seed)}&&c.attempt===1)&&s.resultRows.some(r=>r.code===${JSON.stringify(appCode)})&&s.calls.filter(c=>c.command==='load_local_app_icons').length===1})()`, "seed search and delayed icon call");
  await pressArrowDown();
  await waitFor(mainPage, `window.launcherSearchVisibilityBrowserFixture.snapshot().selectedCode === ${JSON.stringify(appCode)}`, "selection identity on the seed app result");
  const beforeHide = await fixtureSnapshot();
  assert.equal(beforeHide.query, seed);
  assert.deepEqual(beforeHide.resultRows.map((row) => row.code), [appCode], "The first feature reply remains pending while an ordinary app result is visible");
  assert.equal(beforeHide.selectedCode, appCode);
  const resizeCountBeforeHide = commandCount(beforeHide, "expand_window");
  checks.push("Real input starts feature/app search; an app row can be selected while the feature response and icon hydration are pending");

  const firstPageVisibility = await evaluate(mainPage, "document.visibilityState");
  assert.equal(firstPageVisibility, "visible", "Main tab must be visible before the controlled tab switch");
  secondPage = await connectPage(await createPageWebSocketUrl(chrome.webSocketUrl));
  await secondPage.send("Page.bringToFront");
  const hiddenState = await waitFor(mainPage, "document.visibilityState === 'hidden'", "real hidden visibility after bringing the second tab forward", 5000);
  const secondVisibleState = await waitFor(secondPage, "document.visibilityState === 'visible'", "second tab becoming visible", 5000);
  visibilityTransitions.push({ mainBefore: firstPageVisibility, mainAfter: hiddenState, secondAfter: secondVisibleState, trigger: "CDP Page.bringToFront on an owned second tab" });
  assert.equal(await evaluate(mainPage, "document.visibilityState"), "hidden", "The hidden branch requires the browser's actual visibilityState");

  const fixtureBeforeLateReplies = await fixtureSnapshot();
  await evaluate(mainPage, `window.launcherSearchVisibilityBrowserFixture.settleSearch('search_features',${JSON.stringify(seed)},1,[
    {code:'visibility-alpha',plugin_id:'visibility-fixture',plugin_name:'Visibility fixture',label:'Visibility Alpha',explain:'普通工具结果 Alpha',icon:null,score:240,match_type:'exact'},
    {code:'visibility-beta',plugin_id:'visibility-fixture',plugin_name:'Visibility fixture',label:'Visibility Beta',explain:'普通工具结果 Beta',icon:null,score:180,match_type:'exact'}
  ])`);
  await evaluate(mainPage, `window.launcherSearchVisibilityBrowserFixture.settleIcons(1,{${JSON.stringify("/fixture/Visibility QA.app")}:${JSON.stringify("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Crect%20width%3D%2232%22%20height%3D%2232%22%20fill%3D%22%23d33%22%2F%3E%3C%2Fsvg%3E")}})`);
  await delay(75);
  const hiddenSnapshot = await fixtureSnapshot();
  assert.equal(hiddenSnapshot.visibilityState, "hidden");
  assert.equal(hiddenSnapshot.query, seed);
  assert.deepEqual(hiddenSnapshot.resultRows, fixtureBeforeLateReplies.resultRows, "Late feature and icon replies must not change hidden results");
  assert.equal(hiddenSnapshot.selectedCode, appCode, "Hidden late replies must preserve the selected result identity");
  assert.equal(searchCount(hiddenSnapshot, "search_features", seed), 1, "No new feature search may run while hidden");
  assert.equal(searchCount(hiddenSnapshot, "search_local_apps", seed), 1, "No new app search may run while hidden");
  assert.equal(commandCount(hiddenSnapshot, "expand_window"), resizeCountBeforeHide, "No native resize IPC may run while hidden");
  checks.push("Actual hidden document ignores delayed feature/icon replies and issues no search or resize IPC");

  await mainPage.send("Page.bringToFront");
  const restoredState = await waitFor(mainPage, "document.visibilityState === 'visible'", "main tab returning to the foreground", 5000);
  await waitFor(mainPage, `(()=>{const s=window.launcherSearchVisibilityBrowserFixture.snapshot();return s.searchCalls.some(c=>c.command==='search_features'&&c.query===${JSON.stringify(seed)}&&c.attempt===2)&&s.searchCalls.some(c=>c.command==='search_local_apps'&&c.query===${JSON.stringify(seed)}&&c.attempt===2)&&s.resultRows.some(r=>r.code===${JSON.stringify(appCode)}&&r.selected&&r.iconSource)&&s.resultRows.some(r=>r.code===${JSON.stringify(fixtureInfo.codes.beta)})&&s.resultRows.some(r=>r.code===${JSON.stringify(fixtureInfo.codes.alpha)})})()`, "one resumed search, reordered results, retained identity, and fresh icon");
  visibilityTransitions.push({ mainAfter: restoredState, trigger: "CDP Page.bringToFront on the original tab" });
  const restoredSnapshot = await fixtureSnapshot();
  assert.equal(searchCount(restoredSnapshot, "search_features", seed), 2, "Returning visible must start exactly one new feature search");
  assert.equal(searchCount(restoredSnapshot, "search_local_apps", seed), 2, "Returning visible must start exactly one new app search");
  assert.equal(restoredSnapshot.selectedCode, appCode, "The selected app identity must survive moving behind newly returned tool rows");
  await mainPage.send("Page.bringToFront");
  await mainPage.send("Page.bringToFront");
  await evaluate(mainPage, "window.launcherSearchVisibilityBrowserFixture.dispatchDuplicateVisibleEvent()");
  await delay(100);
  const afterDuplicateVisible = await fixtureSnapshot();
  assert.equal(searchCount(afterDuplicateVisible, "search_features", seed), 2, "Duplicate visible notifications must not repeat feature search");
  assert.equal(searchCount(afterDuplicateVisible, "search_local_apps", seed), 2, "Duplicate visible notifications must not repeat app search");
  assert.equal(await evaluate(mainPage, "document.visibilityState"), "visible");
  checks.push("Returning visible refreshes once and keeps selected result identity after result reordering; repeated visible notifications are idempotent");

  await setViewport(800);
  themeTransitionWaits.push(await waitForFiniteThemeTransitions("light"));
  await assertGeometry(800, "light");
  await screenshot("light-800x600");
  await evaluate(mainPage, "window.launcherSearchVisibilityBrowserFixture.setTheme('dark')");
  await waitFor(mainPage, "document.documentElement.dataset.atoolsTheme === 'dark'", "dark theme update");
  themeTransitionWaits.push(await waitForFiniteThemeTransitions("dark"));
  await assertGeometry(800, "dark");
  await screenshot("dark-800x600");
  await setViewport(420);
  await assertGeometry(420, "dark");
  await screenshot("dark-420x600");
  assert.equal(screenshotErrors.length, 0, `App screenshots must be retained: ${JSON.stringify(screenshotErrors)}`);
  checks.push("Light, dark, and narrow screenshots capture the real main shell without horizontal overflow");

  const stale = fixtureInfo.queries.stale;
  await typeQuery(stale);
  await waitFor(mainPage, `(()=>{const s=window.launcherSearchVisibilityBrowserFixture.snapshot();return s.searchCalls.some(c=>c.command==='search_features'&&c.query===${JSON.stringify(stale)}&&c.attempt===1)&&s.searchCalls.some(c=>c.command==='search_local_apps'&&c.query===${JSON.stringify(stale)}&&c.attempt===1)})()`, "pending old-query feature and app requests");
  const latest = fixtureInfo.queries.latest;
  await typeQuery(latest);
  await waitFor(mainPage, `(()=>{const s=window.launcherSearchVisibilityBrowserFixture.snapshot();return s.query===${JSON.stringify(latest)}&&s.resultRows.some(r=>r.code===${JSON.stringify(fixtureInfo.codes.gamma)})})()`, "newest query results");
  await evaluate(mainPage, `window.launcherSearchVisibilityBrowserFixture.settleSearch('search_features',${JSON.stringify(stale)},1,[
    {code:'visibility-alpha',plugin_id:'visibility-fixture',plugin_name:'Visibility fixture',label:'Stale Alpha',explain:'stale result',icon:null,score:240,match_type:'exact'}
  ])`);
  await evaluate(mainPage, `window.launcherSearchVisibilityBrowserFixture.settleSearch('search_local_apps',${JSON.stringify(stale)},1,[
    {code:'local-app:/fixture/Stale.app',plugin_id:'local-app',plugin_name:'本地应用',label:'Stale App',explain:'/fixture/Stale.app',icon:null,score:80,match_type:'exact'}
  ])`);
  await delay(75);
  const latestSnapshot = await fixtureSnapshot();
  assert.equal(latestSnapshot.query, latest);
  assert.deepEqual(latestSnapshot.resultRows.map((row) => row.code), [fixtureInfo.codes.gamma], "Old query replies cannot replace the newest App state");
  checks.push("Changing the real input query fences late feature/app replies from the newer result state");

  const disposeQuery = fixtureInfo.queries.dispose;
  await typeQuery(disposeQuery);
  await waitFor(mainPage, `(()=>{const s=window.launcherSearchVisibilityBrowserFixture.snapshot();return s.searchCalls.some(c=>c.command==='search_features'&&c.query===${JSON.stringify(disposeQuery)}&&c.attempt===1)&&s.searchCalls.some(c=>c.command==='search_local_apps'&&c.query===${JSON.stringify(disposeQuery)}&&c.attempt===1)})()`, "pending requests before App unmount");
  await evaluate(mainPage, "window.launcherSearchVisibilityBrowserFixture.unmount()");
  await waitFor(mainPage, "window.launcherSearchVisibilityBrowserFixture.snapshot().mounted === false", "App unmount");
  await evaluate(mainPage, "window.launcherSearchVisibilityBrowserFixture.remount()");
  await waitFor(mainPage, "window.launcherSearchVisibilityBrowserFixture.snapshot().mounted === true && document.querySelector('.shell-frame')", "new App instance");
  const remountQuery = fixtureInfo.queries.remount;
  await typeQuery(remountQuery);
  await waitFor(mainPage, `(()=>{const s=window.launcherSearchVisibilityBrowserFixture.snapshot();return s.query===${JSON.stringify(remountQuery)}&&s.resultRows.some(r=>r.code===${JSON.stringify(fixtureInfo.codes.gamma)})})()`, "new App instance results");
  await evaluate(mainPage, `window.launcherSearchVisibilityBrowserFixture.settleSearch('search_features',${JSON.stringify(disposeQuery)},1,[
    {code:'visibility-beta',plugin_id:'visibility-fixture',plugin_name:'Visibility fixture',label:'Disposed Alpha',explain:'old App result',icon:null,score:300,match_type:'exact'}
  ])`);
  await evaluate(mainPage, `window.launcherSearchVisibilityBrowserFixture.settleSearch('search_local_apps',${JSON.stringify(disposeQuery)},1,[
    {code:'local-app:/fixture/Disposed.app',plugin_id:'local-app',plugin_name:'本地应用',label:'Disposed App',explain:'/fixture/Disposed.app',icon:null,score:80,match_type:'exact'}
  ])`);
  await delay(75);
  const remountSnapshot = await fixtureSnapshot();
  assert.equal(remountSnapshot.query, remountQuery);
  assert.deepEqual(remountSnapshot.resultRows.map((row) => row.code), [fixtureInfo.codes.gamma], "Late responses from a disposed App cannot mutate its replacement");
  checks.push("Unmounting and remounting the real App prevents the old instance's late replies from changing the new instance");

  const beforeHiddenClear = await fixtureSnapshot();
  const remountFeatureCalls = searchCount(beforeHiddenClear, "search_features", remountQuery);
  const remountAppCalls = searchCount(beforeHiddenClear, "search_local_apps", remountQuery);
  const resizeCallsBeforeHiddenClear = commandCount(beforeHiddenClear, "expand_window");
  await secondPage.send("Page.bringToFront");
  await waitFor(mainPage, "document.visibilityState === 'hidden'", "hidden state before current-query clear", 5000);
  await typeQuery("");
  const hiddenCleared = await fixtureSnapshot();
  assert.equal(hiddenCleared.visibilityState, "hidden");
  assert.equal(hiddenCleared.query, "", "A real hidden input clear becomes the current query");
  assert.equal(searchCount(hiddenCleared, "search_features", remountQuery), remountFeatureCalls);
  assert.equal(searchCount(hiddenCleared, "search_local_apps", remountQuery), remountAppCalls);
  await mainPage.send("Page.bringToFront");
  await waitFor(mainPage, "document.visibilityState === 'visible'", "visible state after current-query clear", 5000);
  await delay(100);
  const afterHiddenClear = await fixtureSnapshot();
  assert.equal(afterHiddenClear.query, "", "Returning visible must not resurrect the hidden-cleared query");
  assert.equal(searchCount(afterHiddenClear, "search_features", remountQuery), remountFeatureCalls);
  assert.equal(searchCount(afterHiddenClear, "search_local_apps", remountQuery), remountAppCalls);
  assert.equal(commandCount(afterHiddenClear, "expand_window"), resizeCallsBeforeHiddenClear, "No stale search resize should follow a cleared query");
  checks.push("A real input clear while hidden remains authoritative after return; this does not claim to execute the auto-clear timer");

  const finalSnapshot = await fixtureSnapshot();
  assert.deepEqual(finalSnapshot.unknownIpc, [], "Unknown IPC is fail-closed");
  assert.deepEqual(finalSnapshot.calls.filter((call) => /clipboard|copy_text|paste/i.test(call.command)), [], "This main-shell fixture must not invoke clipboard or paste capabilities");
  assert.deepEqual(finalSnapshot.calls.filter((call) => call.command === "activate_feature"), [], "The fixture must not activate plugins");
  assert.deepEqual(finalSnapshot.calls.filter((call) => call.command === "run_plugin_main_push"), [], "Empty MainPush candidate metadata must not start plugin runners");
  const foreignRequests = requests.filter(({ url }) => !/^(data:|blob:|about:)/.test(url) && new URL(url).origin !== origin);
  assert.deepEqual(foreignRequests, [], "Browser resources must stay on the owned loopback static fixture origin");
  assert.ok(requests.length > 0 && requests.every(({ url }) => /^(data:|blob:|about:)/.test(url) || new URL(url).origin === origin));
  assert.deepEqual(issues, [], "Runtime exceptions, console errors, and failed browser requests are unexpected");
  checks.push("Ordinary search, icons, settings/catalog reads, and resize stayed inside mocks; MainPush metadata returned empty, with no plugin activation, clipboard, unknown IPC, or external request");

  sourceHashAfter = await fingerprintSources();
  await writeFile(join(output, "source-hash-after.json"), JSON.stringify(sourceHashAfter, null, 2) + "\n", { flag: "wx" });
  assert.deepEqual(sourceHashAfter, sourceHashBefore, "App and fixture sources must remain stable during the browser run");
  status = "passed";
} catch (error) {
  failure = error.stack || String(error);
  if (mainPage) {
    const state = await evaluate(mainPage, "window.launcherSearchVisibilityBrowserFixture?.snapshot() || ({text:document.body.innerText,visibilityState:document.visibilityState})").catch(() => null);
    try {
      await writeFile(join(output, "browser-failure-state.json"), JSON.stringify({ failure, state, issues, visibilityTransitions }, null, 2) + "\n", { flag: "wx" });
    } catch { /* Keep the original failure intact. */ }
  }
  console.error(failure);
} finally {
  finalFixtureSnapshot = mainPage ? await evaluate(mainPage, "window.launcherSearchVisibilityBrowserFixture?.snapshot() || null").catch(() => null) : null;
  if (mainPage) await closeOwned("main-page-session", () => mainPage.close());
  if (secondPage) await closeOwned("second-page-session", () => secondPage.close());
  if (chrome) {
    await closeOwned("owned-chrome", async () => {
      await chrome.close();
      assert.ok(["closed", "exited"].includes(chrome.lifecycle.processState));
      assert.equal(chrome.lifecycle.profileState, "removed");
      assert.equal(chrome.lifecycle.cleanupState, "completed");
    });
  } else {
    cleanup.push({ resource: "owned-chrome", state: "not_started" });
  }
  if (server) await closeOwned("owned-static-preview", () => server.close());
  else cleanup.push({ resource: "owned-static-preview", state: "not_started" });
  await removeBuildDirectory();

  if (sourceHashBefore.length && !sourceHashAfter.length) {
    sourceHashAfter = await fingerprintSources().catch((error) => [{ error: String(error) }]);
    try { await writeFile(join(output, "source-hash-after.json"), JSON.stringify(sourceHashAfter, null, 2) + "\n", { flag: "wx" }); }
    catch (error) { cleanupIncomplete = true; cleanup.push({ resource: "source-hash-after", state: "write_failed", error: String(error) }); }
  }
  if (screenshotErrors.length) status = "failed";
  if (cleanupIncomplete) { status = "failed"; failure ??= "Owned resource cleanup could not be confirmed"; }
  const finalSnapshot = finalFixtureSnapshot;
  const report = {
    status, runId, previewPort, origin, entryHtml, checks, failure,
    sourceHashBefore, sourceHashAfter, screenshots, screenshotErrors,
    calls: finalSnapshot?.calls ?? [], searchCalls: finalSnapshot?.searchCalls ?? [],
    pluginCandidateCalls: finalSnapshot?.pluginCandidateCalls ?? [], unknownIpc: finalSnapshot?.unknownIpc ?? [],
    requests, issues, geometry, visibilityTransitions, themeTransitionWaits,
    fixtureConfig: { backgroundServices: false },
    ownedPIDs: chrome?.lifecycle?.pid ? [chrome.lifecycle.pid] : [],
    chromeLifecycle: chrome?.lifecycle ?? null,
    cleanup, cleanupConfirmed: !cleanupIncomplete && cleanup.every((item) => ["closed", "removed", "not_created", "not_started"].includes(item.state)),
    scope: "Real Svelte App main-shell lifecycle with controlled mock IPC. Ordinary search is limited to settings/catalog/search/icons/resize; MainPush candidate metadata is recorded and returns an empty array, and is not treated as paused by search visibility. Hidden state must come from Chromium tab visibility. No native backend, TaskRun, plugin activation, OS search, or clipboard capability is exercised.",
    visibilityEvidence: "The second target is created through the owned Chrome DevTools endpoint; the fixture does not override document.visibilityState. Duplicate visible notification is an explicitly synthetic event dispatched only after the original document is confirmed visible.",
    autoClearBoundary: "This fixture does not trigger an action that schedules the auto-clear timer. It tests a separate real input-clear while hidden; that is not auto-clear timer acceptance.",
    hiddenQueryClearEvidence: "The UI input is cleared while the original document is genuinely hidden; after bringing it back, the query remains empty and the previous ordinary search is not reissued. This is an input-clear path, not an auto-clear timer execution.",
  };
  try { await writeFile(join(output, "browser-result.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" }); }
  catch (error) { console.error(`Could not write browser-result.json: ${error.stack || String(error)}`); status = "failed"; }
}

if (status !== "passed") process.exitCode = 1;
else console.log(JSON.stringify({ status, checks, report: join(output, "browser-result.json") }));

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CdpClient, createPageWebSocketUrl, formatConsoleArgs, delay } from "./chrome-cdp-smoke-utils.mjs";
import { buildStaticBrowserFixture, previewStaticBrowserFixture } from "./lib/static-browser-fixture.mjs";
import { launchOwnedChrome } from "./lib/launcher-menu-browser-runtime.mjs";

const projectRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const runId = randomUUID();
const output = process.env.ATOOLS_SEARCH_RETRY_BROWSER_OUTPUT || `/private/tmp/atools-batch1470-search-feedback-scroll/browser-${runId}`;
const entryHtml = "tests/components/launcher-search-retry-browser.html";
const paths = [
  "src/App.svelte", "src/components/LauncherResultsSurface.svelte", "src/components/ResultRow.svelte", "src/components/ResultsList.svelte",
  "src/components/SearchBar.svelte", "src/components/ShellFrame.svelte", "src/components/PluginPanel.svelte", "src/components/PluginPanelBody.svelte",
  "src/styles/global.css", "src/lib/launcherControllerHost.ts", "src/lib/launcherInteractionRuntime.ts", "src/lib/launcherNavigationController.ts",
  "src/lib/launcherPluginSessionController.ts", "src/lib/launcherSearch.ts", "src/lib/launcherSearchController.ts", "src/lib/launcherSearchRetryController.ts",
  "src/lib/searchFeedback.ts", "tests/components/launcher-search-retry-app.test.ts", "tests/components/launcher-search-retry-controller.test.ts",
  "tests/components/launcher-search.test.ts", "tests/components/results-list-retry.test.ts", "tests/components/search-feedback-retry.test.ts",
  "tests/components/result-list-performance.test.ts", "tests/components/result-list-viewport.test.ts",
  "src/lib/launcherKeyboardHost.ts", "src/lib/launcherPendingPluginActivation.svelte.ts", "src/lib/launcherResultActionsController.ts",
  "src/lib/searchBehavior.ts", "src/lib/settings.ts", "tests/components/launcherReturnContextFixture.ts",
  "src/components/SettingsPanel.svelte", "src/components/ResultTypeIcon.svelte", "src/lib/resultPresentation.ts",
  "src/lib/resultListViewport.ts", "src/lib/resultListPaging.ts", "src/lib/resultIcons.ts", "tests/components/launcher-result-paging.test.ts",
  "tests/components/launcher-search-retry-browser-fixture.ts", entryHtml, "scripts/test-launcher-search-retry-browser.mjs",
  "scripts/chrome-cdp-smoke-utils.mjs", "scripts/lib/static-browser-fixture.mjs", "scripts/lib/launcher-menu-browser-runtime.mjs", "vite.config.ts",
];
const requiredPins = {
  "src/App.svelte": "d3aa6cf1344bd5ba3496a6262018d94d95f1ff9e0b1851af669d2323a1ea81f2",
  "src/components/LauncherResultsSurface.svelte": "d8d9448b65e7b893e7e70d05cba1a8998d9df5c221bc0dc0ced4cd2ba1c21444",
  "src/components/ResultRow.svelte": "57755235eb1d13a1ca02ec8181deac61564cd64fc7d9774bd1e20551d10cfc37",
  "src/components/ResultsList.svelte": "c41ffc9a076aed8e1196cb4a911dbaf71e5263272e32a22f00d78ef40a50d002",
  "src/components/SearchBar.svelte": "7de2d502a51eb975013eb6380399244e9c0fe77c2a848ca9bf071a8d610e712f",
  "src/components/ShellFrame.svelte": "c8e1ef2af650cf5f8bb47c049080de3eb1c05e470d249c49243ab5b6063a1516",
  "src/components/PluginPanel.svelte": "cd6db46ddf453d6119e3b5ae76399a4349ae789166f5dd5e8d91a26000d17d1c",
  "src/components/PluginPanelBody.svelte": "343bb2ce57e0d228b93ca4d709ee629d3f7828877fe52310ce4b9957824e46d9",
  "src/styles/global.css": "3082e82287f79eddc0a0d3fd822464ece8b2f86b2dc2b7e3131ede7099963fd2",
  "src/lib/launcherControllerHost.ts": "2325373423af3d3482bea0d72b43019f27d9c16e3cdf0c16bb81cc55575119cc",
  "src/lib/launcherInteractionRuntime.ts": "9ac41d174ff20560fc2b01a8aaf7871fe4c8ed6ffb77d769c0c38f034bdd42af",
  "src/lib/launcherNavigationController.ts": "602077ff7d9c9514ec9f286277aa16fc1dfe9db78db8852742571f71e12c1096",
  "src/lib/launcherPluginSessionController.ts": "e4461b64f8e414107ede14a3c4bd0487671593eb0d3c3e736e728b2efc7c3984",
  "src/lib/launcherSearch.ts": "eb9f7b67bbbd490cdd9613fefedee5ad769d83dffeb0474f8f55a014bc4767fe",
  "src/lib/launcherSearchController.ts": "41578e3339a2b8d207455ed7bdf5025f67bac59ffc9c0361197f50240883c3ac",
  "src/lib/launcherSearchRetryController.ts": "7c5e333d11e2c82a244125ba3c32ea64795c75ddef6dc34117f5279abb3c1c5d",
  "src/lib/searchFeedback.ts": "a0a96a50a10137256f46d2ceab80b09b3480acd7b814e76c08f496c6529f63dc",
  "tests/components/launcher-search-retry-app.test.ts": "43fa3db98f83abc3a130e7f9e525ae119ebc9efdcaaaf568296084df60ba5891",
  "tests/components/launcher-search-retry-controller.test.ts": "2bb41b5bc048d78fc55885204bc46cf7903ca001535b45e5f91e6d09754d8b8d",
  "tests/components/launcher-search.test.ts": "8b19f880d5f89c5c696aa52d5495a7039d45299270bdd3623a4cf2193fdee86d",
  "tests/components/results-list-retry.test.ts": "500ac173e0880e6b2c35cbe5181b9ddd33415135979b06c9517abf595dd772eb",
  "tests/components/launcher-result-paging.test.ts": "8bb44484898aa5103e82171b1e5b14e1a132637e97c51cdfe2351d7d8d4e461f",
  "tests/components/result-list-performance.test.ts": "501612598e424e065cab38d863f33d44884e96e41d24b42efa311e4cdd105b41",
  "tests/components/result-list-viewport.test.ts": "3d86596134fee66e3a0dc695b70dd855c60f8dcd0d8f9a77594c0860d42f7ba0",
  "tests/components/search-feedback-retry.test.ts": "4ef400d320dfa2aceb45b3eb715e530efa772317289982bcb51c354134ef8c2f",
  "src/lib/launcherKeyboardHost.ts": "dbcd7752746775de392e0fe4b30b47b3075aacd74f60a5bb421f736471072791",
  "src/lib/launcherPendingPluginActivation.svelte.ts": "c293e9247a556f5d7bf0175bad9a11915660d4c1ee166c1c86f18a14733b47e8",
  "src/lib/launcherResultActionsController.ts": "5e87b63a64226e4618c70321e7517e60d8219b426f1dd7a6fa013e93a4fd389c",
  "src/lib/searchBehavior.ts": "4ad3487a46679d0c505657c31bfeaab285d34cb53ca70722316a3534beff5679",
  "src/lib/settings.ts": "32fb27786f9d81bac5860dbaf199fc93eb3a41bcf6b324fcee31b84555fe918c",
  "tests/components/launcherReturnContextFixture.ts": "bbd2176ca391cd836cf88f34929310be16d9fee5002668d3e185cbd6729b88a7",
  "src/components/SettingsPanel.svelte": "3a9c13246310658a96e5b357d4511771b69e1bc2a70b00bd85cf68c35f3d5053",
  "src/components/ResultTypeIcon.svelte": "0019a6660f89094d240898f5161c9f47ea9ff21a31b9ac200ff1fe9df1e53a68",
  "src/lib/resultPresentation.ts": "a962591b1df32123058bfd7ed05ef0abc64fc8919ded989f2489cf16b09acd4e",
  "src/lib/resultListViewport.ts": "4f3db53874b3a61006cc9a413da2b2a14db910b2b17472e9b1c6de913d4cc2a7",
  "src/lib/resultListPaging.ts": "9887ee92fff39cfd4f8d4f5e98227d13d281d426f6ae8620245e905650e9d352",
  "src/lib/resultIcons.ts": "d1e9e9f6bb06f833b454fad7d824d24329a947540afc9bbc7cd57c4ca73dbfed",
  "tests/components/launcher-search-retry-browser-fixture.ts": "5d8a044fa7296a3f4230f0df04c8732756e985e0940138a37f8ed8b8a13735d0",
  "tests/components/launcher-search-retry-browser.html": "195065cf2b979d58e0ac78d690c2261c777577720a36d3aac0e4dbb1f58e93f7",
  "scripts/chrome-cdp-smoke-utils.mjs": "b2061b31d5b7cc19cd100f3db747785055dca16081589fea10408582002e3998",
  "scripts/lib/static-browser-fixture.mjs": "050b34da78df4060aeba71fa3f6441cff72dc5f4a688d1abcf1b88417328dd8f",
  "scripts/lib/launcher-menu-browser-runtime.mjs": "de657cfb7f05d95dee136ad0255addc8c7afd4a94c72683507e81541a811923d",
  "vite.config.ts": "f8eeaaa0d4f8763e5824db3cda57360e8c2ccb49c4b2614671938460e05462e3",
};
let server, chrome, page, buildDirectory, compiledFixture, origin;
const checks = [], issues = [], requests = [], geometry = [], scrollChecks = [], screenshots = [], screenshotErrors = [], cleanup = [], clickDiagnostics = [];
let status = "failed", failure, before = [];
let clickFailureDiagnostics;
const retryButtonSelector = 'button[aria-label="重试搜索"]';
const queryExpr = selector => `document.querySelector(${JSON.stringify(selector)})`;

async function fingerprint() {
  return Promise.all(paths.map(async path => ({ path, sha256: createHash("sha256").update(await readFile(new URL("../" + path, import.meta.url))).digest("hex") })));
}
async function evaluate(expression) {
  const result = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, { timeoutMs: 15000 });
  assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description || result.exceptionDetails?.text);
  return result.result.value;
}
async function waitFor(expression, timeoutMs = 12000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const value = await evaluate(expression); if (value) return value; await delay(30); }
  assert.fail("Timed out waiting for: " + expression);
}
async function key(keyValue, code = keyValue, virtual = keyValue === "Enter" ? 13 : keyValue === "ArrowDown" ? 40 : 32) {
  const params = { key: keyValue, code, windowsVirtualKeyCode: virtual };
  const text = code === "Enter" ? "\r" : code === "Space" ? " " : undefined;
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", ...params, ...(text === undefined ? {} : { text, unmodifiedText: text }) });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
  await delay(50);
}
async function input(value) {
  await evaluate(`(()=>{const e=document.querySelector('[data-atools-search-input]');if(!e)throw Error('search input missing');e.focus();e.value=${JSON.stringify(value)};e.dispatchEvent(new InputEvent('input',{bubbles:true}));})()`);
}
async function click(selector) {
  const selectorLiteral = JSON.stringify(selector);
  const scrolled = await evaluate(`(()=>{const e=document.querySelector(${selectorLiteral});if(!e)return false;e.scrollIntoView({block:'nearest',inline:'nearest'});return true})()`);
  assert.ok(scrolled, "CDP click target is missing: " + selector);
  const deadline = Date.now() + 2500;
  let previousGeometry = "", stableSamples = 0, point = null;
  while (Date.now() < deadline) {
    point = await evaluate(`(()=>{const e=document.querySelector(${selectorLiteral});if(!e)return null;const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y),ancestors=[];for(let n=e;n&&ancestors.length<8;n=n.parentElement){const a=n.getBoundingClientRect();ancestors.push({tag:n.tagName,id:n.id||'',className:typeof n.className==='string'?n.className:'',scrollTop:n.scrollTop,scrollLeft:n.scrollLeft,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,rect:{left:a.left,top:a.top,right:a.right,bottom:a.bottom}})}return{x,y,width:r.width,height:r.height,rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},inside:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,hit:!!hit&&e.contains(hit),hitNode:hit?{tag:hit.tagName,id:hit.id||'',className:typeof hit.className==='string'?hit.className:'',text:(hit.textContent||'').trim().slice(0,120)}:null,ancestors}})()`);
    const currentGeometry = point && JSON.stringify({ rect: point.rect, ancestors: point.ancestors.map(item => [item.scrollTop, item.scrollLeft]) });
    if (point?.inside && point.hit && currentGeometry === previousGeometry) stableSamples += 1;
    else stableSamples = 0;
    if (stableSamples >= 2) break;
    previousGeometry = currentGeometry || "";
    await delay(50);
  }
  clickDiagnostics.push({ selector, stableSamples, point });
  if (!point || !point.inside || !point.hit || stableSamples < 2) {
    clickFailureDiagnostics = { selector, stableSamples, point };
    await screenshot("retry-button-unreachable");
    assert.ok(false, "CDP click target remained unreachable after scroll and stable-hit wait: " + JSON.stringify(clickFailureDiagnostics));
  }
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: point.x, y: point.y });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: point.x, y: point.y });
  await delay(50);
}
async function setViewport(width) { await page.send("Emulation.setDeviceMetricsOverride", { width, height: 820, deviceScaleFactor: 1, mobile: false }); }
async function assertGeometry(width, theme) {
  const value = await evaluate(`(()=>{const shell=document.querySelector('.shell-frame'),list=document.querySelector('.results-list'),status=document.querySelector('.feedback-strip');if(!shell||!list)return null;const s=shell.getBoundingClientRect(),l=list.getBoundingClientRect(),f=status?.getBoundingClientRect();return{width:innerWidth,theme:document.documentElement.dataset.atoolsTheme,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,shell:{left:s.left,right:s.right,top:s.top,bottom:s.bottom},list:{left:l.left,right:l.right,top:l.top,bottom:l.bottom},status:f?{left:f.left,right:f.right,top:f.top,bottom:f.bottom}:null}})()`);
  assert.ok(value, "App shell geometry unavailable");
  assert.equal(value.width, width);
  assert.equal(value.theme, theme);
  assert.ok(value.documentWidth <= width + 1 && value.bodyWidth <= width + 1, `Page overflow at ${width}px: ${JSON.stringify(value)}`);
  assert.ok(value.shell.left >= 0 && value.shell.right <= width + 1, `Shell overflow at ${width}px: ${JSON.stringify(value)}`);
  assert.ok(value.list.left >= value.shell.left && value.list.right <= value.shell.right + 1, `Results overflow shell at ${width}px: ${JSON.stringify(value)}`);
  if (value.status) assert.ok(value.status.left >= 0 && value.status.right <= width + 1, `Status overflow at ${width}px: ${JSON.stringify(value)}`);
  geometry.push(value);
}
async function screenshot(name) {
  try {
    const result = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(`${output}/${name}.png`, Buffer.from(result.data, "base64"), { flag: "wx" });
    screenshots.push(name);
  } catch (error) { screenshotErrors.push({ name, error: error.stack || String(error) }); }
}
async function navigateFresh(scenario) {
  const loaded = page.waitForEvent("Page.loadEventFired", 30000);
  await page.send("Page.navigate", { url: `${origin}/tests/components/launcher-search-retry-browser.html?scenario=${scenario}` });
  await loaded;
  await waitFor("window.launcherSearchRetryBrowserReady === true || typeof window.launcherSearchRetryBrowserStartError === 'string'");
  assert.equal(await evaluate("window.launcherSearchRetryBrowserReady === true"), true,
    `Browser fixture failed to mount: ${await evaluate("window.launcherSearchRetryBrowserStartError || 'unknown startup error'")}`);
}
async function waitForResult(code) {
  await waitFor(`document.querySelector('[role="option"][data-result-code=${JSON.stringify(code)}]')`);
}
async function assertSelected(code) {
  await waitFor(`document.querySelector('[role="option"][data-result-code=${JSON.stringify(code)}]')?.getAttribute('aria-selected') === 'true'`);
}

await mkdir(output, { recursive: false });
try {
  before = await fingerprint();
  const pins = new Map(before.map(item => [item.path, item.sha256]));
  for (const [path, expected] of Object.entries(requiredPins)) assert.equal(pins.get(path), expected, `Unexpected launcher retry QA source: ${path}`);
  await writeFile(`${output}/source-before.json`, JSON.stringify(before, null, 2), { flag: "wx" });
  buildDirectory = await mkdtemp(join(tmpdir(), `atools-search-retry-${runId}-`));
  compiledFixture = await buildStaticBrowserFixture({ projectRoot, entryHtml, outDir: join(buildDirectory, "dist") });
  assert.equal(compiledFixture.htmlFile, entryHtml);
  const bundleText = (await Promise.all(compiledFixture.outputFiles.filter(file => file.endsWith(".html") || file.endsWith(".js")).map(file => readFile(join(buildDirectory, "dist", file), "utf8")))).join("\n");
  assert.equal(bundleText.includes("@vite/client"), false, "Static fixture must not include Vite dev client/HMR");
  assert.equal(bundleText.includes("import.meta.hot"), false, "Static fixture must not include HMR hooks");
  server = await previewStaticBrowserFixture({ projectRoot, outDir: join(buildDirectory, "dist"), host: "127.0.0.1", port: 0 });
  const address = server.httpServer.address();
  assert.ok(address && typeof address === "object" && address.port > 0, "Owned Vite preview must have a local bound port");
  origin = `http://127.0.0.1:${address.port}`;
  chrome = await launchOwnedChrome();
  page = await CdpClient.connect(await createPageWebSocketUrl(chrome.webSocketUrl));
  await page.send("Page.enable"); await page.send("Runtime.enable"); await page.send("Network.enable");
  page.on("Runtime.exceptionThrown", event => issues.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  page.on("Runtime.consoleAPICalled", ({ type, args }) => { if (type === "error") issues.push("console.error:" + formatConsoleArgs(args)); });
  page.on("Network.requestWillBeSent", event => requests.push(event.request.url));

  await navigateFresh("empty-error");
  const emptyCodes = await evaluate("window.launcherSearchRetryBrowserFixture.codes");
  await input(emptyCodes.emptyErrorQuery);
  await waitFor(`window.launcherSearchRetryBrowserFixture.calls('search_features',${JSON.stringify(emptyCodes.emptyErrorQuery)}).length===1&&window.launcherSearchRetryBrowserFixture.calls('search_local_apps',${JSON.stringify(emptyCodes.emptyErrorQuery)}).length===1`);
  await waitFor("document.querySelector('.empty-status[role=status]')?.textContent.includes('搜索暂不可用')");
  const emptyErrorSemantics = await evaluate(`(()=>{const listbox=document.querySelector('#launcher-results[role=listbox]'),status=document.querySelector('.empty-status[role=status]'),retry=document.querySelector(${JSON.stringify(retryButtonSelector)});return{listboxPresent:!!listbox,listboxChildren:listbox?.children.length,options:listbox?.querySelectorAll('[role=option]').length,statusOutsideListbox:!!status&&!listbox?.contains(status),retryOutsideListbox:!!retry&&!listbox?.contains(retry)}})()`);
  assert.deepEqual(emptyErrorSemantics, { listboxPresent: true, listboxChildren: 0, options: 0, statusOutsideListbox: true, retryOutsideListbox: true }, "Empty error status and retry control must remain outside the empty listbox");
  checks.push("An actual empty error keeps an empty listbox, status, and retry button in separate semantic regions");

  await navigateFresh("retry-flow");
  const codes = await evaluate("window.launcherSearchRetryBrowserFixture.codes");
  await input(codes.retryQuery);
  await waitFor(`window.launcherSearchRetryBrowserFixture.calls('search_features',${JSON.stringify(codes.retryQuery)}).length===1&&window.launcherSearchRetryBrowserFixture.calls('search_local_apps',${JSON.stringify(codes.retryQuery)}).length===1`);
  await waitFor(`${queryExpr(retryButtonSelector)} !== null`);
  await waitForResult(codes.alpha); await waitForResult(codes.custom); await waitForResult(codes.beta);
  await key("ArrowDown"); await key("ArrowDown"); await assertSelected(codes.beta);
  const betaScrollState = await evaluate(`(()=>{const list=document.querySelector('#launcher-results[role=listbox]'),feedback=document.querySelector('.feedback-strip'),row=document.querySelector('[role=option][data-result-code=${JSON.stringify(codes.beta)}]');if(!list||!row)return null;const l=list.getBoundingClientRect(),r=row.getBoundingClientRect();return{scrollTop:list.scrollTop,feedbackOutside:!!feedback&&!list.contains(feedback),rowVisible:r.top>=l.top-1&&r.bottom<=l.bottom+1,row:{top:r.top,bottom:r.bottom},scrollport:{top:l.top,bottom:l.bottom}}})()`);
  assert.ok(betaScrollState, "Selected result and scrollport must be mounted before retry");
  assert.ok(betaScrollState.scrollTop > 0, `Selecting Beta must scroll the row viewport: ${JSON.stringify(betaScrollState)}`);
  assert.equal(betaScrollState.feedbackOutside, true, "Feedback must remain outside the row scrollport");
  assert.equal(betaScrollState.rowVisible, true, `Selected Beta must remain visible in the row scrollport: ${JSON.stringify(betaScrollState)}`);
  assert.equal(await evaluate("window.launcherSearchRetryBrowserFixture.activations().length"), 0);

  await click(retryButtonSelector);
  assert.equal(clickDiagnostics[clickDiagnostics.length - 1]?.point?.hit, true, "Retry button must receive the real CDP hit test");
  scrollChecks.push({ ...betaScrollState, retryHit: clickDiagnostics[clickDiagnostics.length - 1]?.point?.hit === true });
  await waitFor(`window.launcherSearchRetryBrowserFixture.calls('search_features',${JSON.stringify(codes.retryQuery)}).length===2&&window.launcherSearchRetryBrowserFixture.calls('search_local_apps',${JSON.stringify(codes.retryQuery)}).length===2`);
  await waitFor(`document.querySelector(".feedback-strip")?.textContent.includes("正在补充插件结果")&&${queryExpr(retryButtonSelector)}===null`);
  await waitForResult(codes.alpha); await waitForResult(codes.custom); await assertSelected(codes.beta);
  assert.equal(await evaluate("window.launcherSearchRetryBrowserFixture.activations().length"), 0, "Retry click must not activate the selected result");
  checks.push("A real retry-button mouse click issues one features/apps search pair, keeps the selected row during pending, hides the button, and does not activate a result");

  for (const width of [480, 800]) {
    await setViewport(width);
    for (const theme of ["light", "dark"]) {
      await evaluate(`document.documentElement.dataset.atoolsTheme=${JSON.stringify(theme)}`);
      await assertGeometry(width, theme);
      await screenshot(`retry-pending-${width}-${theme}`);
    }
  }

  await evaluate(`window.launcherSearchRetryBrowserFixture.settle('search_features',${JSON.stringify(codes.retryQuery)},2,'reject')`);
  await evaluate(`window.launcherSearchRetryBrowserFixture.settle('search_local_apps',${JSON.stringify(codes.retryQuery)},2,'resolve',[{code:${JSON.stringify(codes.terminal)},plugin_id:'local-apps',plugin_name:'QA Terminal',label:'QA Terminal',icon:null,explain:'/Applications/QA-Terminal.app',score:40,match_type:'exact'}])`);
  await waitForResult(codes.terminal); await waitFor(`${queryExpr(retryButtonSelector)} !== null`);
  await waitForResult(codes.alpha); await waitForResult(codes.custom); await waitForResult(codes.beta); await assertSelected(codes.beta);
  checks.push("A failed feature source retains its same-query feature snapshot while the successful apps source contributes its current result");

  await evaluate(`${queryExpr(retryButtonSelector)}?.focus()`);
  await key("Enter");
  await waitFor(`window.launcherSearchRetryBrowserFixture.calls('search_features',${JSON.stringify(codes.retryQuery)}).length===3&&window.launcherSearchRetryBrowserFixture.calls('search_local_apps',${JSON.stringify(codes.retryQuery)}).length===3`);
  await waitFor(`document.querySelector(".feedback-strip")?.textContent.includes("正在补充插件结果")&&${queryExpr(retryButtonSelector)}===null`);
  await waitForResult(codes.alpha); await waitForResult(codes.custom); await assertSelected(codes.beta);
  assert.equal(await evaluate("window.launcherSearchRetryBrowserFixture.activations().length"), 0, "Retry button Enter must not activate the selected result");
  checks.push("A real retry-button Enter activation issues exactly one search pair, preserves the selected row while pending, and does not activate a result");

  await evaluate(`window.launcherSearchRetryBrowserFixture.settle('search_features',${JSON.stringify(codes.retryQuery)},3,'reject')`);
  await evaluate(`window.launcherSearchRetryBrowserFixture.settle('search_local_apps',${JSON.stringify(codes.retryQuery)},3,'resolve',[])`);
  await waitFor(`${queryExpr(retryButtonSelector)} !== null`);
  await waitForResult(codes.alpha); await waitForResult(codes.custom); await waitForResult(codes.beta); await assertSelected(codes.beta);
  assert.equal(await evaluate(`document.querySelector('[role="option"][data-result-code=${JSON.stringify(codes.terminal)}]')===null`), true,
    "A successful empty apps response must replace the stale app snapshot");

  await evaluate(`${queryExpr(retryButtonSelector)}?.focus()`);
  await key(" ", "Space", 32);
  await waitFor(`window.launcherSearchRetryBrowserFixture.calls('search_features',${JSON.stringify(codes.retryQuery)}).length===4&&window.launcherSearchRetryBrowserFixture.calls('search_local_apps',${JSON.stringify(codes.retryQuery)}).length===4`);
  await waitFor(`document.querySelector(".feedback-strip")?.textContent.includes("正在补充插件结果")`);
  assert.equal(await evaluate(`${queryExpr(retryButtonSelector)}===null`), true);
  assert.equal(await evaluate("window.launcherSearchRetryBrowserFixture.activations().length"), 0);
  // Resolve with an exact real fixture row, then let successful source snapshots replace prior rows.
  await evaluate(`window.launcherSearchRetryBrowserFixture.settle('search_features',${JSON.stringify(codes.retryQuery)},4,'resolve',[{code:${JSON.stringify(codes.beta)},plugin_id:'beta-plugin',plugin_name:'Beta 插件',label:'Beta 插件',icon:null,explain:'普通搜索往返 fixture',score:300,match_type:'exact'}])`);
  await evaluate(`window.launcherSearchRetryBrowserFixture.settle('search_local_apps',${JSON.stringify(codes.retryQuery)},4,'resolve',[])`);
  await waitForResult(codes.beta);
  await waitFor(`document.querySelectorAll('[role="option"]').length===1&&document.querySelector('[role="option"][data-result-code=${JSON.stringify(codes.beta)}]')`);
  assert.equal(await evaluate(`document.querySelector('[role="option"][data-result-code=${JSON.stringify(codes.alpha)}]')===null`), true);
  assert.equal(await evaluate(`document.querySelector('[role="option"][data-result-code=${JSON.stringify(codes.custom)}]')===null`), true);
  assert.equal(await evaluate(`document.querySelector('[role="option"][data-result-code=${JSON.stringify(codes.terminal)}]')===null`), true);
  assert.equal(await evaluate(`${queryExpr(retryButtonSelector)}===null`), true);
  assert.equal((await evaluate(`window.launcherSearchRetryBrowserFixture.calls('search_features',${JSON.stringify(codes.retryQuery)}).length`)), 4);
  checks.push("A real retry-button Space activation issues one search pair; successful feature/app responses replace their previous source snapshots");

  await input(codes.staleQuery);
  await waitFor(`window.launcherSearchRetryBrowserFixture.calls('search_features',${JSON.stringify(codes.staleQuery)}).length===1`);
  await input(codes.newestQuery);
  await waitForResult(codes.gamma);
  await evaluate(`window.launcherSearchRetryBrowserFixture.settle('search_features',${JSON.stringify(codes.staleQuery)},1,'resolve',[{code:${JSON.stringify(codes.alpha)},plugin_id:'alpha-plugin',plugin_name:'Alpha 插件',label:'Alpha 插件',icon:null,explain:'普通搜索往返 fixture',score:400,match_type:'exact'}])`);
  await delay(120);
  assert.equal(await evaluate(`document.querySelectorAll('[role="option"]').length===1&&document.querySelector('[role="option"][data-result-code=${JSON.stringify(codes.gamma)}]')!==null`), true, "A late old-query result must not replace the newest query");
  checks.push("Changing query invalidates a held prior response; the late old result cannot replace the latest result");

  await navigateFresh("activate-selected");
  const activation = await evaluate("window.launcherSearchRetryBrowserFixture.codes");
  await input(activation.activationQuery); await waitForResult(activation.alpha);
  await key("ArrowDown"); await assertSelected(activation.beta);
  await key("Enter");
  await waitFor("window.launcherSearchRetryBrowserFixture.activations().length===1&&document.querySelector('iframe')");
  assert.deepEqual(await evaluate("window.launcherSearchRetryBrowserFixture.activations()[0]"), { code: activation.beta, pluginId: "beta-plugin" });
  checks.push("The main search input Enter still activates the selected result with its exact plugin/code owner");

  const foreignRequests = requests.filter(url => !url.startsWith(origin) && !/^(data:|blob:|about:)/.test(url));
  assert.deepEqual(foreignRequests, [], "Browser QA must not request external app resources");
  assert.ok(requests.length > 0 && requests.every(url => new URL(url).origin === origin), "Browser resources must come only from the owned loopback static preview");
  assert.equal(requests.some(url => url.includes("@vite/client")), false, "Static preview must not request Vite dev client/HMR");
  assert.deepEqual(issues, [], "Runtime exceptions and console errors are unexpected");
  const after = await fingerprint();
  await writeFile(`${output}/source-after.json`, JSON.stringify(after, null, 2), { flag: "wx" });
  assert.deepEqual(after, before, "Pinned product and QA sources must remain unchanged during the browser run");
  status = screenshotErrors.length === 0 ? "passed" : "passed_with_screenshot_errors";
} catch (error) {
  failure = error.stack || String(error);
  const state = await evaluate("({text:document.body.innerText,activations:window.launcherSearchRetryBrowserFixture?.activations(),features:window.launcherSearchRetryBrowserFixture?.calls('search_features')})").catch(() => null);
  try { await writeFile(`${output}/browser-failure-state.json`, JSON.stringify({ failure, state, issues, clickFailureDiagnostics }, null, 2), { flag: "wx" }); } catch { /* Preserve the first failure. */ }
  console.error(failure);
} finally {
  const urls = await evaluate("performance.getEntriesByType('resource').map(entry=>entry.name)").catch(() => []);
  try { await writeFile(`${output}/runtime-resource-urls.json`, JSON.stringify(urls, null, 2), { flag: "wx" }); } catch (error) { cleanup.push("resource-url-write: " + String(error)); }
  for (const [name, close] of [["page", () => page?.close()], ["chrome", () => chrome?.close()], ["preview", () => server?.close()], ["build", () => buildDirectory ? rm(buildDirectory, { recursive: true, force: true }) : Promise.resolve()]]) {
    try { await close(); cleanup.push(name + ":closed"); } catch (error) { cleanup.push(name + ":" + String(error)); }
  }
  if (cleanup.some(item => !item.endsWith(":closed"))) { status = "failed"; failure ??= "One or more owned browser fixture resources did not close cleanly"; }
  if (before.length && !await readFile(`${output}/source-after.json`).then(() => true, () => false)) {
    const after = await fingerprint().catch(error => [{ error: String(error) }]);
    try { await writeFile(`${output}/source-after.json`, JSON.stringify(after, null, 2), { flag: "wx" }); } catch (error) { cleanup.push("source-after-write: " + String(error)); }
  }
  const report = { status, checks, issues, requests: requests.length, foreignRequests: requests.filter(url => !url.startsWith(origin) && !/^(data:|blob:|about:)/.test(url)), geometry, scrollChecks, screenshots, screenshotErrors, clickDiagnostics, clickFailureDiagnostics, failure, compiledFixture, cleanup,
    scope: "Real Chromium App + ResultsList + retry controller with narrow in-memory mocked IPC. No native backend, OS app search, or native activation claim." };
  try { await writeFile(`${output}/browser-result.json`, JSON.stringify(report, null, 2) + "\n", { flag: "wx" }); } catch (error) { console.error("Could not write browser-result.json: " + String(error)); status = "failed"; }
}
if (status !== "passed") process.exitCode = 1;
else console.log(JSON.stringify({ status, checks, report: `${output}/browser-result.json` }));

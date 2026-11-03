import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  CdpClient,
  createPageWebSocketUrl,
  delay,
  formatConsoleArgs,
} from "./chrome-cdp-smoke-utils.mjs";
import { launcherFrontendSourceFiles } from "./lib/launcher-source-binding.mjs";
import { isOwnedResourceClean, launchOwnedChrome, launchOwnedVite } from "./lib/launcher-menu-browser-runtime.mjs";
import { navigateFocusedLauncherFixture } from "./lib/launcher-menu-browser-readiness.mjs";
import { writeLauncherBrowserReport } from "./lib/launcher-menu-browser-report.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = 15132;
const origin = `http://127.0.0.1:${port}`;
const fixtureFiles = [
  "tests/components/launcher-actions-browser.html",
  "tests/components/launcherActionBrowserFixture.ts",
  "tests/components/launcher-menu-dismissal.test.ts",
  "scripts/chrome-cdp-smoke-utils.mjs",
  "scripts/lib/owned-vite-server.mjs",
  "scripts/lib/owned-vite-cli-process.mjs",
  "scripts/lib/owned-vite-cli-worker.mjs",
  "scripts/lib/launcher-source-binding.mjs",
  "scripts/lib/launcher-menu-browser-runtime.mjs",
  "scripts/lib/launcher-menu-browser-readiness.mjs",
  "scripts/lib/launcher-menu-browser-report.mjs",
  "scripts/test-launcher-menu-browser-runtime.mjs",
  "scripts/test-launcher-menu-browser-report.mjs",
  "vite.config.ts",
  "package.json",
];
const selectedSourceFiles = [...new Set([
  ...launcherFrontendSourceFiles,
  ...fixtureFiles,
  "scripts/probe-launcher-menu-dismissal-browser.mjs",
])].sort();
const testInputId = "atools-menu-dismissal-external-test-control";
function usage() {
  return "Usage: node scripts/probe-launcher-menu-dismissal-browser.mjs <new-output.json>\n"
    + "       node scripts/probe-launcher-menu-dismissal-browser.mjs --validate-only <new-output.json>\n"
    + "The driver uses only the local Chromium mock-IPC App fixture and fixed loopback port 15132.";
}
function parseArgs(args) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { help: true };
  const validateOnly = args[0] === "--validate-only";
  const values = validateOnly ? args.slice(1) : args;
  assert.equal(values.length, 1, usage());
  assert.ok(values[0] && !values[0].startsWith("-"), "Output path must be a JSON file path");
  const outputPath = resolve(values[0]);
  assert.ok(outputPath.toLowerCase().endsWith(".json"), "Output path must end in .json");
  assert.ok(isAbsolute(outputPath), "Output path must resolve to an absolute path");
  const relativeOutput = relative(root, outputPath);
  assert.ok(relativeOutput.startsWith(`..${sep}`) || relativeOutput === "..",
    "Output path must be outside the repository to protect source files");
  return { outputPath, validateOnly };
}
async function hashSources() {
  const files = [];
  for (const file of selectedSourceFiles) {
    const bytes = await readFile(resolve(root, file));
    files.push({ path: file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const digest = createHash("sha256");
  for (const file of files) digest.update(`${file.path}\0${file.sha256}\n`);
  return { sha256: digest.digest("hex"), files };
}
async function evaluate(page, expression) {
  const response = await page.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: false,
  }, { timeoutMs: 15000 });
  assert.ok(!response.exceptionDetails,
    response.exceptionDetails?.exception?.description || response.exceptionDetails?.text || "Browser evaluation failed");
  return response.result.value;
}

async function waitFor(page, expression, label = expression, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(page, expression);
    if (value) return value;
    await delay(25);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

async function dispatchKey(page, key, code, virtualKey, modifiers = 0) {
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown", key, code, windowsVirtualKeyCode: virtualKey, modifiers,
    ...(key === "a" && modifiers === 4 ? { commands: ["selectAll"] } : {}),
    ...(key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}),
  });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtualKey, modifiers });
  await delay(35);
}

async function click(page, point, button = "left") {
  const buttons = button === "left" ? 1 : button === "right" ? 2 : 0;
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button, buttons, clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button, buttons: 0, clickCount: 1 });
  await delay(35);
}

async function pointFor(page, selector, where = "center") {
  const point = await evaluate(page, `(()=>{
    const el=document.querySelector(${JSON.stringify(selector)});
    if(!el) return null;
    const r=el.getBoundingClientRect();
    if(r.width<=0||r.height<=0||r.left<0||r.top<0||r.right>innerWidth||r.bottom>innerHeight) return null;
    const p=${JSON.stringify(where)};
    return {x:p==='lower-center'?r.left+r.width/2:r.left+r.width/2,
      y:p==='lower-center'?r.bottom-3:r.top+r.height/2,
      rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
  })()`);
  assert.ok(point, `Visible in-viewport element required: ${selector}`);
  return point;
}

async function setSearchText(page, text, append = false) {
  const input = "document.querySelector('[role=combobox]')";
  const active = await evaluate(page, `document.activeElement===${input}`);
  if (!active) await click(page, await pointFor(page, "[role=combobox]"));
  if (!append) {
    await dispatchKey(page, "a", "KeyA", 65, 4);
    await waitFor(page, `${input}.selectionStart===0 && ${input}.selectionEnd===${input}.value.length`, "browser editing select-all range");
    await dispatchKey(page, "Backspace", "Backspace", 8);
    await waitFor(page, `${input}.value===''`, "search clearing through actual browser editing keys");
  }
  await page.send("Input.insertText", { text });
  await waitFor(page, `${input}.value===${JSON.stringify(text)} || ${append ? `${input}.value.endsWith(${JSON.stringify(text)})` : "false"}`,
    "search input to receive trusted CDP text");
}

async function rightClickElement(page, selector, lowerCenter = false) {
  const point = await pointFor(page, selector, lowerCenter ? "lower-center" : "center");
  await click(page, point, "right");
  await waitFor(page, "document.querySelector('[role=menu] button')===document.activeElement",
    "launcher action menu to own keyboard focus");
  return point;
}

async function findBlankPoint(page) {
  const point = await evaluate(page, `(()=>{
    const surface=document.querySelector('#launcher-results');
    if(!surface) return null;
    const r=surface.getBoundingClientRect();
    const blocked='button,input,select,textarea,a[href],area[href],summary,iframe,object,embed,audio[controls],video[controls],[tabindex],[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"],[role="option"],[role="status"],.result-row-window,.group-header,.search-container,.launcher-action-menu';
    for(let y=Math.ceil(r.top+8);y<r.bottom-8;y+=4) for(let x=Math.ceil(r.left+8);x<r.right-8;x+=4){
      const hit=document.elementFromPoint(x,y);
      if(!hit||hit.closest(blocked)) continue;
      return {x,y,hitTag:hit.tagName,hitClass:typeof hit.className==='string'?hit.className:'',
        hitRect:(()=>{const b=hit.getBoundingClientRect();return {left:b.left,top:b.top,right:b.right,bottom:b.bottom}})(),
        surfaceRect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},
        elementAtPoint:hit.tagName.toLowerCase(),nonFocusable:true,blankSurfaceGap:true};
    }
    return null;
  })()`);
  assert.ok(point, "No geometrically verified non-focusable blank gap exists in the launcher result surface");
  return point;
}

async function verifyLocalUrl(report, url, resourceType) {
  report.requests.push({ url, resourceType: resourceType || "unknown" });
  if (!/^(https?|wss?):/i.test(url)) return;
  const parsed = new URL(url);
  assert.ok(parsed.hostname === "127.0.0.1" && parsed.port === String(port), `Unexpected non-local browser request: ${url}`);
}

async function verifyLocalNetwork(report, event) {
  return verifyLocalUrl(report, event.request.url, event.type);
}
async function runBrowser(report) {
  let server;
  let chrome;
  let page;
  let browserVersion = null;
  let error = null;
  const cleanupErrors = [];
  report.cleanup = {
    page: "not_created",
    vite: { state: "not_started", closeState: "not_attempted", boundAddress: null },
    chrome: { state: "not_started", processState: "not_spawned", profileState: "not_created" },
    scratch: { state: "created" },
    errors: cleanupErrors,
    allOwnedResourcesClean: false,
  };
  report.browser = { version: null, fixture: "/tests/components/launcher-actions-browser.html", mode: "Chromium headless; explicit mock IPC; backgroundServices=false" };
  report.checks = [];
  report.consoleIssues = [];
  report.requests = [];
  report.navigations = [];
  report.testControl = { injectedExternalInput: false, purpose: "external focus handoff only; not a product element" };
  try {
    report.cleanup.vite.state = "starting";
    try {
      server = await launchOwnedVite({ host: "127.0.0.1", root, port });
      report.cleanup.vite = { ...server.lifecycle };
      report.cleanup.vite.state = "listening";
    } catch (failure) {
      if (failure.atoolsLifecycle?.vite) report.cleanup.vite = { ...failure.atoolsLifecycle.vite };
      throw failure;
    }
    report.cleanup.chrome.state = "starting";
    try {
      chrome = await launchOwnedChrome();
      report.cleanup.chrome = { ...chrome.lifecycle };
      report.cleanup.chrome.state = "ready";
    } catch (failure) {
      if (failure.atoolsLifecycle?.chrome) report.cleanup.chrome = { ...failure.atoolsLifecycle.chrome };
      throw failure;
    }
    page = await CdpClient.connect(await createPageWebSocketUrl(chrome.webSocketUrl));
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Network.enable");
    browserVersion = await page.send("Browser.getVersion");
    report.browser.version = browserVersion;
    page.on("Runtime.exceptionThrown", event => {
      report.consoleIssues.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || "runtime exception");
    });
    page.on("Runtime.consoleAPICalled", ({ type, args }) => {
      if (["error", "warning", "assert"].includes(type)) report.consoleIssues.push(`${type}:${formatConsoleArgs(args)}`);
    });
    page.on("Network.requestWillBeSent", event => { void verifyLocalNetwork(report, event).catch(failure => report.consoleIssues.push(failure.message)); });
    page.on("Network.webSocketCreated", event => { void verifyLocalUrl(report, event.url, "WebSocket").catch(failure => report.consoleIssues.push(failure.message)); });
    page.on("Page.frameNavigated", event => { if (!event.frame.parentId) report.navigations.push(event.frame.url); });
    report.browser.activation = await navigateFocusedLauncherFixture(page, {
      url: `${origin}/tests/components/launcher-actions-browser.html`, evaluate, waitFor,
    });
    const fixture = await evaluate(page, `({ready:!!window.launcherFixtureReady, calls:window.fixture.calls.map(c=>c.command),
      backgroundServices:false, mockIPC:typeof window.__TAURI_INTERNALS__?.invoke==='function'})`);
    assert.equal(fixture.ready, true);
    assert.equal(fixture.backgroundServices, false);
    report.fixture = fixture;
    report.checks.push("Real DOMContentLoaded and focused visible document precede browser input; actual App is mounted with mock IPC and background services disabled");

    await setSearchText(page, "字符转换");
    await waitFor(page, "document.querySelector('[role=option][data-result-code=\"convert\"]')", "fixture search result");
    await rightClickElement(page, '[role=option][data-result-code="convert"]');
    const menuState = await evaluate(page, `(()=>({query:document.querySelector('[role=combobox]').value,
      menu:!!document.querySelector('[role=menu]'),activeMenuButton:document.activeElement===document.querySelector('[role=menu] button'),
      point:window.__atoolsLastMenuPoint||null}))()`);
    assert.equal(menuState.query, "字符转换");
    assert.equal(menuState.activeMenuButton, true);
    report.checks.push("Actual right-click on the search result opens its menu and moves keyboard focus to the first menu action");

    const blank = await findBlankPoint(page);
    report.blankClick = blank;
    await click(page, blank);
    await waitFor(page, "!document.querySelector('[role=menu]') && document.activeElement===document.querySelector('[role=combobox]') && document.querySelector('[role=combobox]').value==='字符转换'",
      "blank click to close menu and restore query focus");
    report.checks.push("A real click on a hit-tested non-focusable blank gap dismisses the menu and restores search focus without changing the query");

    await rightClickElement(page, '[role=option][data-result-code="convert"]');
    await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: blank.x, y: blank.y, deltaX: 0, deltaY: 110, wheelTicksX: 0, wheelTicksY: 1 });
    await waitFor(page, "!document.querySelector('[role=menu]') && document.activeElement===document.querySelector('[role=combobox]')",
      "wheel to dismiss menu and restore search focus");
    await page.send("Input.insertText", { text: " 滚轮后输入" });
    await waitFor(page, "document.querySelector('[role=combobox]').value==='字符转换 滚轮后输入'", "typing after wheel dismissal");
    report.wheel = { deltaY: 110, point: blank, queryAfterTyping: "字符转换 滚轮后输入" };
    report.checks.push("A real wheel event closes the menu; subsequent CDP text reaches the retained search query");

    await evaluate(page, `(()=>{const old=document.getElementById(${JSON.stringify(testInputId)});old?.remove();
      const input=document.createElement('input');input.id=${JSON.stringify(testInputId)};input.type='text';input.setAttribute('aria-label','External browser test input');
      Object.assign(input.style,{position:'fixed',right:'12px',bottom:'12px',width:'220px',height:'34px',zIndex:'2147483647',
        border:'2px solid #7c3aed',background:'#fff',color:'#111',padding:'4px 8px'});
      window.__externalInputEventCount=0;input.addEventListener('input',()=>window.__externalInputEventCount++);document.body.append(input);})()`);
    report.testControl.injectedExternalInput = true;
    await setSearchText(page, "字符转换");
    await waitFor(page, "document.querySelector('[role=option][data-result-code=\"convert\"]')", "restored search result before external focus handoff");
    await rightClickElement(page, '[role=option][data-result-code="convert"]');
    const externalPoint = await pointFor(page, `#${testInputId}`);
    report.externalInput = { point: externalPoint, queryBefore: "字符转换" };
    await click(page, externalPoint);
    await waitFor(page, `!document.querySelector('[role=menu]') && document.activeElement===document.getElementById(${JSON.stringify(testInputId)})`,
      "external input to receive actual click focus without search reclaim");
    await page.send("Input.insertText", { text: "external-only" });
    await waitFor(page, `document.getElementById(${JSON.stringify(testInputId)}).value==='external-only'`, "external input to receive CDP text");
    await delay(120);
    const externalResult = await evaluate(page, `(()=>({active:document.activeElement?.id,
      externalValue:document.getElementById(${JSON.stringify(testInputId)}).value,
      externalInputEvents:window.__externalInputEventCount,
      searchValue:document.querySelector('[role=combobox]').value,
      menuClosed:!document.querySelector('[role=menu]')}))()`);
    assert.equal(externalResult.active, testInputId);
    assert.equal(externalResult.externalValue, "external-only");
    assert.ok(externalResult.externalInputEvents > 0);
    assert.equal(externalResult.searchValue, "字符转换");
    assert.equal(externalResult.menuClosed, true);
    report.externalInput.result = externalResult;
    report.checks.push("A real click on the temporary external input closes the menu and claims focus; later text stays in that input and search does not reclaim it");

    await setSearchText(page, "");
    await waitFor(page, `document.querySelector('[aria-label="最近使用"] .recent-item')`, "required seeded Home recent tile");
    const homeTile = await evaluate(page, `(()=>{const b=document.querySelector('[aria-label="最近使用"] .recent-item');
      if(!b)return null;const r=b.getBoundingClientRect();return {label:b.innerText.trim(),rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}}})()`);
    assert.ok(homeTile, "The fixture must seed a Home history tile; skipping this focus path is not a pass");
    {
      const rightPoint = { x: homeTile.rect.left + homeTile.rect.width / 2, y: homeTile.rect.bottom - 3 };
      await click(page, rightPoint, "right");
      await waitFor(page, "document.querySelector('[role=menu] button')===document.activeElement", "Home tile action menu focus");
      const hover = await evaluate(page, `(()=>{const tile=document.querySelector('[aria-label="最近使用"] .recent-item');
        const menu=document.querySelector('[role=menu]');const tr=tile.getBoundingClientRect(),mr=menu.getBoundingClientRect();
        for(let y=Math.ceil(tr.top+2);y<Math.min(tr.bottom,mr.top)-1;y+=2) for(let x=Math.ceil(tr.left+2);x<tr.right-1;x+=2){
          const hit=document.elementFromPoint(x,y);if(hit?.closest('button.recent-item')===tile&&!menu.contains(hit)) return {x,y,tileRect:{left:tr.left,top:tr.top,right:tr.right,bottom:tr.bottom},menuRect:{left:mr.left,top:mr.top,right:mr.right,bottom:mr.bottom},hitTag:hit.tagName};
        }return null;})()`);
      assert.ok(hover, "The Home tile has no hit-tested exposed area behind its menu for the hover check");
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: hover.x, y: hover.y, button: "none", buttons: 0 });
      await waitFor(page, "document.querySelector('[role=menu] button')===document.activeElement", "menu focus to survive Home tile hover");
      const hoverResult = await evaluate(page, `(()=>({menuFocused:document.activeElement===document.querySelector('[role=menu] button'),
        tileHovered:document.querySelector('[aria-label="最近使用"] .recent-item')?.matches(':hover'),
        activeQuery:document.querySelector('[role=combobox]')?.value,
        menuOpen:!!document.querySelector('[role=menu]')}))()`);
      assert.equal(hoverResult.menuFocused, true);
      assert.equal(hoverResult.tileHovered, true);
      await dispatchKey(page, "Escape", "Escape", 27);
      await waitFor(page, "!document.querySelector('[role=menu]') && document.activeElement===document.querySelector('[role=combobox]')",
        "Escape to close Home menu and restore search only");
      const afterEscape = await evaluate(page, `(()=>({shellPresent:!!document.querySelector('.shell-frame'),
        query:document.querySelector('[role=combobox]').value,menuOpen:!!document.querySelector('[role=menu]'),
        activated:window.fixture.calls.some(c=>c.command==='activate_feature'),
        hideRequests:window.fixture.calls.filter(c=>c.command==='hide_main_window').length,
        homeTiles:document.querySelectorAll('[aria-label="最近使用"] .recent-item').length}))()`);
      assert.equal(afterEscape.shellPresent, true);
      assert.equal(afterEscape.query, "");
      assert.equal(afterEscape.menuOpen, false);
      assert.equal(afterEscape.activated, false);
      assert.equal(afterEscape.hideRequests, 0, "Escape from the Home menu must not request hide_main_window");
      report.homeTile = { available: true, initial: homeTile, hoverPoint: hover, hover: hoverResult, escape: afterEscape };
      report.checks.push("A real pointer move over the exposed Home tile keeps menu keyboard focus; Escape closes only the menu without activating a plugin or hiding the App");
    }

    const finalFixtureState = await evaluate(page, `(()=>({commands:window.fixture.calls.map(c=>c.command),
      activated:window.fixture.calls.some(c=>c.command==='activate_feature'),
      pluginLike:window.fixture.calls.filter(c=>/plugin|activate/i.test(c.command)).map(c=>c.command),
      menuOpen:!!document.querySelector('[role=menu]'),shellPresent:!!document.querySelector('.shell-frame')}))()`);
    assert.equal(finalFixtureState.activated, false);
    assert.equal(finalFixtureState.menuOpen, false);
    assert.equal(finalFixtureState.shellPresent, true);
    assert.deepEqual(finalFixtureState.pluginLike, [], "The mock fixture must observe no plugin or activation capability calls");
    report.fixture.final = finalFixtureState;
    assert.deepEqual(report.consoleIssues, [], "No browser console warnings, errors, assertions, or runtime exceptions");
    assert.ok(report.navigations.every(url => url === `${origin}/tests/components/launcher-actions-browser.html`), "Unexpected main-frame navigation");
    await delay(50);
    assert.ok(report.requests.every(({ url }) => {
      if (!/^(https?|wss?):/i.test(url)) return true;
      try { const parsed = new URL(url); return parsed.hostname === "127.0.0.1" && parsed.port === String(port); } catch { return false; }
    }), "No request may leave the fixed local Vite origin");
    report.status = "passed";
  } catch (failure) {
    error = failure;
    report.status = "failed";
    report.error = { name: failure?.name || "Error", message: String(failure?.message || failure), stack: failure?.stack || null };
    if (page) {
      report.diagnostic = await evaluate(page, `(()=>({readyState:document.readyState,focused:document.hasFocus(),visibility:document.visibilityState,
        query:document.querySelector('[role=combobox]')?.value,active:document.activeElement?.outerHTML?.slice(0,500),
        menu:document.querySelector('[role=menu]')?.innerText||null,fixtureCalls:window.fixture?.calls?.map(c=>c.command)||[]}))()`)
        .catch(() => ({ browserContextUnavailable: true }));
    }
  } finally {
    try {
      await page?.close();
      report.cleanup.page = page ? "closed" : "not_created";
    } catch (failure) {
      report.cleanup.page = "close_failed";
      cleanupErrors.push(`page close: ${failure.message}`);
    }
    try {
      if (chrome) report.cleanup.chrome = { ...await chrome.close() };
      else if (report.cleanup.chrome.state === "starting") report.cleanup.chrome.state = "startup_failed_without_handle";
    } catch (failure) {
      if (failure.atoolsLifecycle?.chrome) report.cleanup.chrome = { ...failure.atoolsLifecycle.chrome };
      else report.cleanup.chrome.state = "close_failed";
      cleanupErrors.push(`owned Chrome process/profile cleanup: ${failure.message}`);
    }
    try {
      if (server) report.cleanup.vite = { ...await server.close() };
      else if (report.cleanup.vite.state === "starting") report.cleanup.vite.state = "startup_failed_without_handle";
    } catch (failure) {
      if (failure.atoolsLifecycle?.vite) report.cleanup.vite = { ...failure.atoolsLifecycle.vite };
      else report.cleanup.vite.state = "close_failed";
      cleanupErrors.push(`owned Vite listener cleanup: ${failure.message}`);
    }
    if (report.cleanup.chrome.cleanupState === "failed" || report.cleanup.chrome.state === "close_failed"
      || report.cleanup.chrome.processState === "close_failed_process_may_still_run"
      || report.cleanup.chrome.profileState === "remove_failed") cleanupErrors.push("Chrome startup/close lifecycle reports incomplete owned-resource cleanup");
    if (report.cleanup.vite.closeState === "failed" || report.cleanup.vite.closeState === "failed_still_listening") {
      cleanupErrors.push("Vite startup/close lifecycle reports an open owned listener");
    }
    report.cleanup.allOwnedResourcesClean = cleanupErrors.length === 0
      && isOwnedResourceClean(report.cleanup.vite.closeState)
      && isOwnedResourceClean(report.cleanup.vite.cacheState)
      && isOwnedResourceClean(report.cleanup.chrome.processState)
      && isOwnedResourceClean(report.cleanup.chrome.profileState)
      && ["closed", "not_created"].includes(report.cleanup.page);
    if (cleanupErrors.length) error ||= new AggregateError(cleanupErrors.map(message => new Error(message)), "Owned browser resources did not cleanly close");
  }
  if (error) throw error;
}
async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (failure) {
    console.error(failure.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  const report = {
    schemaVersion: 1,
    status: options.validateOnly ? "validated_only" : "not_started",
    scope: "Chromium mock-IPC App UI acceptance only; no OS input, native WebKit, competitor comparison, plugin execution, or startup-performance claim",
    startedAt: new Date().toISOString(),
    outputPath: options.outputPath,
    port,
    selectedInputsAreCompleteDependencyClosure: false,
    sourceBinding: { selection: "launcherFrontendSourceFiles plus the explicit browser fixture, CDP helper, Vite/package config, and this driver; selected inputs are not a complete dependency/compiler closure", before: null, after: null, stable: null },
  };
  try {
    if (!options.validateOnly) await mkdir(dirname(options.outputPath), { recursive: true });
    report.sourceBinding.before = await hashSources();
    if (options.validateOnly) {
      const existing = await readFile(options.outputPath).then(() => true, error => error.code === "ENOENT" ? false : Promise.reject(error));
      assert.equal(existing, false, "Output path already exists; refusing to overwrite it");
      report.status = "validated_only";
      report.validation = { arguments: "accepted", outputPathAvailable: true, selectedInputCount: selectedSourceFiles.length, browserStarted: false, serverStarted: false };
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const existing = await readFile(options.outputPath).then(() => true, error => error.code === "ENOENT" ? false : Promise.reject(error));
    assert.equal(existing, false, "Output path already exists; refusing to overwrite it");
    const scratch = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(resolve(tmpdir(), `atools-menu-dismissal-${randomUUID()}-`)));
    report.ownedTemporaryDirectory = scratch;
    let browserFailure = null;
    try { await runBrowser(report); } catch (failure) { browserFailure = failure; }
    try {
      report.sourceBinding.after = await hashSources();
      report.sourceBinding.stable = report.sourceBinding.before.sha256 === report.sourceBinding.after.sha256;
      assert.equal(report.sourceBinding.stable, true, "Selected source inputs changed during the browser run");
    } catch (failure) {
      report.sourceBinding.stable = false;
      report.sourceBinding.afterError = failure.message;
      browserFailure ||= failure;
    }
    try { await rm(scratch, { recursive: true, force: true }); }
    catch (failure) { report.cleanup.errors.push(`temporary directory cleanup: ${failure.message}`); report.cleanup.scratch = { state: "remove_failed", error: failure.message }; browserFailure ||= failure; }
    if (report.cleanup.scratch?.state !== "remove_failed") report.cleanup.scratch = { state: "removed" };
    report.cleanup.allOwnedResourcesClean = report.cleanup.allOwnedResourcesClean
      && report.cleanup.scratch.state === "removed" && report.cleanup.errors.length === 0;
    if (!report.cleanup.allOwnedResourcesClean) browserFailure ||= new Error("One or more owned browser resources were not confirmed clean");
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
    report.status = browserFailure ? "failed" : "passed";
    if (browserFailure && !report.error) report.error = { name: browserFailure.name || "Error", message: String(browserFailure.message || browserFailure), stack: browserFailure.stack || null };
    await writeLauncherBrowserReport(report, options.outputPath);
    console.log(JSON.stringify({ status: report.status, checks: report.checks?.length || 0, outputPath: report.outputFallbackPath || options.outputPath, sourceStable: report.sourceBinding.stable }));
    if (report.status !== "passed" || browserFailure) process.exitCode = 1;
  } catch (failure) {
    report.status = "failed_before_or_during_setup";
    report.finishedAt = new Date().toISOString();
    const details = { name: failure.name || "Error", message: String(failure.message || failure), stack: failure.stack || null };
    if (report.error) report.finalizationError = details;
    else report.error = details;
    report.cleanup ||= { page: "not_created", vite: { state: "not_started", closeState: "not_created" },
      chrome: { state: "not_started", processState: "not_spawned", profileState: "not_created" },
      scratch: { state: "not_created" }, allOwnedResourcesClean: true, errors: [],
      note: "No browser, server, or scratch handle had been acquired before setup failed" };
    if (!options.validateOnly && !report.outputWriteErrors?.length) {
      try {
        await writeLauncherBrowserReport(report, options.outputPath);
      } catch (writeFailure) {
        report.error.outputWriteError = String(writeFailure.message || writeFailure);
      }
    }
    console.error(JSON.stringify({ status: report.status, outputPath: report.outputFallbackPath || options.outputPath,
      error: report.error, finalizationError: report.finalizationError, outputWriteErrors: report.outputWriteErrors }));
    process.exitCode = 1;
  }
}

await main();

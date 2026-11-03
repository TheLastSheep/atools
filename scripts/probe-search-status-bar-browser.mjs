import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CdpClient, delay } from "./chrome-cdp-smoke-utils.mjs";
import { launchOwnedChrome, launchOwnedVite, isOwnedResourceClean } from "./lib/launcher-menu-browser-runtime.mjs";
import { boundedOriginalCdp, createOriginalPageTarget, navigateOriginalPage } from "./lib/original-plugin-browser-deadline.mjs";
import { connectOriginalCdpSocket } from "./lib/original-plugin-browser-websocket.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = process.argv[2];
assert(output && isAbsolute(output) && output.endsWith(".json") && relative(root, output).startsWith(`..${sep}`), "Pass fresh private absolute report.json");
await mkdir(dirname(output), { recursive: true });
await access(output).then(() => { throw Error("Report exists"); }, error => { if (error.code !== "ENOENT") throw error; });
const paths = ["src/components/SearchStatusBar.svelte", "src/lib/searchStatusBar.ts", "src/styles/global.css",
  "tests/components/searchStatusBarBrowserFixture.ts", "tests/components/search-status-bar-browser.html", "scripts/probe-search-status-bar-browser.mjs",
  "scripts/chrome-cdp-smoke-utils.mjs", "scripts/lib/owned-vite-server.mjs",
  "scripts/lib/owned-vite-cli-process.mjs", "scripts/lib/owned-vite-cli-worker.mjs",
  "scripts/lib/launcher-menu-browser-runtime.mjs", "scripts/lib/original-plugin-browser-deadline.mjs", "scripts/lib/original-plugin-browser-websocket.mjs", "vite.config.ts"];
async function fingerprints() { return Object.fromEntries(await Promise.all(paths.map(async path => { const b = await readFile(resolve(root, path));
  return [path, { bytes: b.length, sha256: createHash("sha256").update(b).digest("hex") }]; }))); }
const report = { scope: "Production status bar, real Chromium layout at 19 sampled container widths 900/899/881/880/860/800/721/720/641/640/561/560/521/520/480/420/400/399/360 inside a 1000px page (114 states across six fixture states). These are boundary samples, not coverage of every integer width. Generated local state only; no App/native IPC/macOS hardware input/competitor acceptance. 360px is extra robustness, not a production minimum-window claim. Selected inputs are not a dependency closure.",
  passed: false, checks: [], measurements: [], screenshots: [], before: await fingerprints(), cleanup: { errors: [], page: "not_created", chrome: {}, vite: {} } };
let server, chrome, page;
const runtimeErrors = [];
async function evaluate(expression) {
  const reply = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  assert(!reply.exceptionDetails, reply.exceptionDetails?.exception?.description || reply.exceptionDetails?.text);
  return reply.result.value;
}
async function shot(name) {
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  const b = Buffer.from(data, "base64"), path = resolve(dirname(output), name);
  await writeFile(path, b, { flag: "wx" }); report.screenshots.push({ path, bytes: b.length, sha256: createHash("sha256").update(b).digest("hex") });
}
function check(value, name) { report.checks.push({ name, passed: !!value }); }
function expectedHintCount(width, name) {
  if (name === "empty") return 1;
  if (width <= 520) return 3;
  if (width <= 640) return name === "feedback" ? 4 : 5;
  if (width <= 880) return name === "results" ? 6 : 5;
  return name === "home" || name === "pinned" ? 5 : 7;
}
try {
  server = await launchOwnedVite({ root, port: 15149 }); chrome = await launchOwnedChrome();
  page = boundedOriginalCdp(new CdpClient(await connectOriginalCdpSocket(await createOriginalPageTarget(chrome.webSocketUrl))), { totalMs: 60000, commandMs: 10000, closeMs: 1500 });
  await page.send("Page.enable"); await page.send("Runtime.enable");
  page.on("Runtime.exceptionThrown", event => runtimeErrors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 250, deviceScaleFactor: 1, mobile: false });
  await navigateOriginalPage(page, server.origin + "/tests/components/search-status-bar-browser.html");
  const deadline = Date.now() + 10000;
  while (!await evaluate("window.statusFixtureReady===true")) { assert(Date.now() < deadline, "Fixture ready deadline"); await delay(25); }
  for (const width of [900, 899, 881, 880, 860, 800, 721, 720, 641, 640, 561, 560, 521, 520, 480, 420, 400, 399, 360]) for (const name of ["results", "home", "pinned", "empty", "target", "feedback"]) {
    await evaluate(`window.statusFixture.show(${JSON.stringify(name)},${width})`);
    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    const measurement = await evaluate(`(() => {
      const footer=document.querySelector('footer'), b=footer.getBoundingClientRect(), host=footer.parentElement.getBoundingClientRect();
      const copyElement=footer.querySelector('.status-copy'),copyRect=copyElement.getBoundingClientRect();
      const visible=e=>!!e&&getComputedStyle(e).display!=='none'&&e.getClientRects().length>0;
      const parts=[...footer.querySelectorAll('.hint,.status-title,.status-detail,.status-position')].filter(visible).map(e=>{
        const r=e.getBoundingClientRect(), range=document.createRange();range.selectNodeContents(e);const text=range.getBoundingClientRect();
        const style=getComputedStyle(e),detail=e.classList.contains('status-detail'),targetLabel=e.querySelector('.full-tab-label');
        const statusText=e.classList.contains('status-title')||detail||e.classList.contains('status-position');
        const targetEllipsis=targetLabel&&visible(targetLabel)&&getComputedStyle(targetLabel).textOverflow==='ellipsis'&&getComputedStyle(targetLabel).overflow==='hidden'&&e.title;
        return {text:e.innerText.trim(),left:r.left,right:r.right,width:r.width,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,
          detailWidth:detail?e.clientWidth:null,
          withinStatusCopy:statusText?(r.left>=copyRect.left-0.5&&r.right<=copyRect.right+0.5):null,
          inside:r.left>=b.left-0.5&&r.right<=b.right+0.5,textFits:text.left>=r.left-0.5&&text.right<=r.right+0.5,
          explicitDetailEllipsis:detail&&style.textOverflow==='ellipsis'&&style.overflow==='hidden'&&e.clientWidth>=64,
          explicitTargetEllipsis:!!targetEllipsis,
          fullDescription:detail&&(e.title||e.parentElement.title)};});
      const hints=[...footer.querySelectorAll('.hint')].filter(visible).map(e=>e.innerText.trim().replace(/\\s+/g,' '));
      const pagingHint=footer.querySelector('.paging-hint'),pagingHintVisible=!!pagingHint&&visible(pagingHint);
      const buttons=[...footer.querySelectorAll('button')].filter(visible).map(e=>({label:e.getAttribute('aria-label'),title:e.title}));
      const tabHint=footer.querySelector('.target-tab-hint'),targetButton=footer.querySelector('[aria-label="设置 Tab 目标"]');
      const targetSettingsClass=footer.querySelector('.status-hints')?.classList.contains('has-target-settings')===true;
      const tabTarget=tabHint&&targetButton?{hintTag:tabHint.tagName,hintLabel:tabHint.querySelector('.full-tab-label')?.textContent,hintAccessibleName:tabHint.getAttribute('aria-label'),
        hintTitle:tabHint.title,buttonText:targetButton.textContent.trim(),buttonHasKeycap:Boolean(targetButton.querySelector('.keycap')),
        buttonSeparate:!tabHint.contains(targetButton),settingsClass:targetSettingsClass}:null;
      const statusBoxes=[...copyElement.querySelectorAll('.status-title,.status-detail,.status-position')].filter(visible).map(e=>e.getBoundingClientRect());
      const controlBoxes=[...footer.querySelectorAll('.hint,button')].filter(visible).map(e=>e.getBoundingClientRect());
      const lastStatusRight=statusBoxes.length?Math.max(...statusBoxes.map(r=>r.right)):null;
      const firstControlLeft=controlBoxes.length?Math.min(...controlBoxes.map(r=>r.left)):null;
      const statusChildrenInsideCopy=statusBoxes.every(r=>r.left>=copyRect.left-0.5&&r.right<=copyRect.right+0.5);
      const actualGap=lastStatusRight===null||firstControlLeft===null?null:firstControlLeft-lastStatusRight;
      const noOverlap=statusBoxes.length>0&&controlBoxes.length>0&&statusChildrenInsideCopy&&actualGap>=4;
      const keys=[...footer.querySelectorAll('.keycap')].filter(visible).map(e=>{const r=e.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(e);const t=range.getBoundingClientRect();return {key:e.textContent,inside:r.left>=b.left&&r.right<=b.right,textFits:t.left>=r.left&&t.right<=r.right};});
      const positionElement=copyElement.querySelector('.status-position'),feedbackElement=copyElement.querySelector('.target-feedback');
      const actionMenu=footer.querySelector('.action-menu-hint'),menuLabel=footer.querySelector('.action-menu-label'),menuCompact=footer.querySelector('.action-menu-compact');
      return {footerWidth:b.width,hostWidth:host.width,height:b.height,overflow:footer.scrollWidth>footer.clientWidth,hints,pagingHintVisible,parts,buttons,tabTarget,keys,
        statusTitleVisible:visible(copyElement.querySelector('.status-title')),
        statusDetailVisible:visible(copyElement.querySelector('.status-detail')),
        statusPosition:visible(positionElement)?positionElement.textContent.trim():null,
        feedbackStatus:feedbackElement?{text:feedbackElement.textContent.trim(),title:feedbackElement.title,role:feedbackElement.getAttribute('role'),width:feedbackElement.clientWidth}:null,
        actionMenuPresentation:{visible:visible(actionMenu),fullLabelVisible:visible(menuLabel),compactLabelVisible:visible(menuCompact)},
        statusGeometry:{childrenInsideCopy:statusChildrenInsideCopy,lastStatusRight,firstControlLeft,gap:actualGap},noOverlap};})()`);
    report.measurements.push({ width, name, ...measurement });
    check(measurement.footerWidth <= width + 0.5 && !measurement.overflow && measurement.height === 34, `${width} ${name}: bounded 34px footer`);
    check(measurement.parts.every(part => part.inside && (part.textFits || part.explicitDetailEllipsis && !!part.fullDescription || part.explicitTargetEllipsis)), `${width} ${name}: full keys/counts, long detail/target uses explicit ellipsis and full description`);
    check(measurement.parts.every(part => part.withinStatusCopy === null || part.withinStatusCopy), `${width} ${name}: each visible status text box stays inside the status-copy box`);
    if (name === "feedback" && width <= 640) {
      check(measurement.parts.some(part => part.detailWidth >= 64), `${width} feedback: status detail retains at least 64px`);
      check(measurement.feedbackStatus?.role === "status" && measurement.feedbackStatus.text.length > 0
        && measurement.feedbackStatus.title === measurement.feedbackStatus.text, `${width} feedback: full status and tooltip remain available`);
    }
    if (width <= 640) {
      check(measurement.statusTitleVisible === false, `${width} ${name}: secondary status title yields space`);
      if (name !== "feedback") {
        check(measurement.statusDetailVisible === false, `${width} ${name}: long detail yields to the full position counter`);
        check(typeof measurement.statusPosition === "string" && /\d/.test(measurement.statusPosition), `${width} ${name}: full result/empty counter remains visible`);
      }
      if (measurement.actionMenuPresentation.visible && width > 520) {
        check(!measurement.actionMenuPresentation.fullLabelVisible && measurement.actionMenuPresentation.compactLabelVisible,
          `${width} ${name}: secondary menu keeps its compact label`);
      }
    }
    if (width <= 520) check(measurement.actionMenuPresentation.visible === false, `${width} ${name}: secondary action-menu hint yields to primary actions`);
    if (width <= 640) check(measurement.pagingHintVisible === false, `${width} ${name}: paging hint yields while its keyboard behavior remains unchanged`);
    else if (width <= 880 && (name === "target" || name === "feedback")) check(measurement.pagingHintVisible === false, `${width} ${name}: paging hint yields only with the target settings action`);
    else if (width <= 880 && name === "results") check(measurement.pagingHintVisible, `${width} results: paging hint remains without a target settings action`);
    check(measurement.noOverlap && measurement.keys.every(key => key.inside && key.textFits), `${width} ${name}: status and shortcuts never overlap; keycaps show complete text`);
    check(measurement.hints.length === expectedHintCount(width, name), `${width} ${name}: shortcut count matches the sampled responsive state`);
    const requiredKeys = name === "empty" ? ["Esc"] : ["Enter", "Tab", "Esc"];
    check(requiredKeys.every(key => measurement.hints.some(text => text.includes(key))), `${width} ${name}: primary shortcuts remain discoverable`);
    if (name !== "empty") {
      const actionMenuVisible = width > 520 && !(name === "feedback" && width <= 640);
      check(measurement.hints.some(text => text.includes("更多操作")) === actionMenuVisible, `${width} ${name}: secondary action menu yields space only for compact feedback`);
    }
    if (name === "target" || name === "feedback") {
      check(measurement.tabTarget?.hintTag === "SPAN" && measurement.tabTarget.buttonText === "设置目标"
        && measurement.tabTarget.buttonHasKeycap === false && measurement.tabTarget.buttonSeparate === true
        && measurement.tabTarget.hintAccessibleName.startsWith("Tab：") && measurement.tabTarget.hintTitle.length > 0
        && measurement.tabTarget.settingsClass === true, `${width} ${name}: passive Tab hint and settings button stay distinct`);
      const before = await evaluate("window.statusFixture.settingsClicks");
      const point = await evaluate("(() => {const button=document.querySelector('[aria-label=\"设置 Tab 目标\"]'),r=button.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return {x,y,width:r.width,height:r.height,inside:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,hit:button.contains(document.elementFromPoint(x,y))};})()");
      check(point.inside && point.width >= 56 && point.height >= 24 && point.hit, `${width} ${name}: settings action has a 24px hit target and receives actual pointer hit`);
      await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
      await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
      check(await evaluate("window.statusFixture.settingsClicks") === before + 1, `${width} ${name}: target settings remains clickable`);
    }
    if ([900, 640, 560, 480, 420, 360].includes(width) && ["results", "target", "feedback"].includes(name)) await shot(`status-${width}-${name}.png`);
  }
  check(runtimeErrors.length === 0, "No browser runtime exceptions");
  report.passed = report.checks.every(check => check.passed);
} catch (error) { report.error = String(error.stack || error); if (error.atoolsLifecycle) Object.assign(report.cleanup, error.atoolsLifecycle); }
finally {
  for (const [name, resource] of [["page", page], ["chrome", chrome], ["vite", server]]) {
    try { if (resource) { const closed = await resource.close(); report.cleanup[name] = name === "page" ? "closed" : closed; if (name === "page") report.transport = closed; } }
    catch (error) { report.cleanup.errors.push(name + ": " + String(error)); if (error.atoolsLifecycle) report.cleanup[name] = error.atoolsLifecycle[name]; }
  }
  report.cleanup.allOwnedResourcesClean = report.cleanup.errors.length === 0 && ["closed", "not_created"].includes(report.cleanup.page)
    && isOwnedResourceClean(report.cleanup.vite?.closeState) && isOwnedResourceClean(report.cleanup.vite?.cacheState)
    && isOwnedResourceClean(report.cleanup.chrome?.processState) && isOwnedResourceClean(report.cleanup.chrome?.profileState)
    && (!page || report.transport?.socketDestroyed === true && report.transport.pendingAtClose === 0 && report.transport.eventWaitsAtClose === 0 && report.transport.deadlineTimerCleared === true);
  report.after = await fingerprints(); report.sourcesUnchanged = JSON.stringify(report.before) === JSON.stringify(report.after); report.runtimeErrors = runtimeErrors;
  report.passed = report.passed && report.sourcesUnchanged && report.cleanup.allOwnedResourcesClean;
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
}
console.log(JSON.stringify({ output, passed: report.passed, checks: report.checks.length, failures: report.checks.filter(check => !check.passed).length, cleanup: report.cleanup.allOwnedResourcesClean }));
if (!report.passed) process.exitCode = 1;

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { bundlePluginResourceLoader } from "./lib/bundle-plugin-resource-loader.mjs";
import { CdpClient, createPageWebSocketUrl, delay, formatConsoleArgs, launchChrome } from "./chrome-cdp-smoke-utils.mjs";

const root = new URL("../", import.meta.url);
const output = new URL("output/launcher-ui-2026-10-15/", root);
const baseline = process.argv.includes("--baseline");
const loaderPath = process.argv.find(arg => arg.startsWith("--loader="))?.slice(9) || new URL("src/lib/pluginResourceHtml.ts", root).pathname;
const runId = randomUUID();
const prefix = `${baseline ? "deferred-plugin-scripts-browser-baseline" : "deferred-plugin-scripts-browser"}-${runId}`;
const loaderSource = await readFile(loaderPath, "utf8");
const moduleUrl = (source, fileName) => `data:text/javascript;base64,${Buffer.from(transpileModule(source, {
  fileName, compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ESNext },
}).outputText).toString("base64")}`;
const loaderModule = `data:text/javascript;base64,${Buffer.from(await bundlePluginResourceLoader(loaderPath)).toString("base64")}`;
const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK7sAAAAASUVORK5CYII=", "base64");
const requests = [];
const scriptFiles = new Map();
const server = createServer((request, response) => {
  requests.push(request.url);
  if (request.method === "POST" && request.url === "/fixtures") {
    let body = "";
    request.on("data", chunk => { body += chunk; if (body.length > 64 * 1024) request.destroy(); });
    request.on("end", () => {
      try {
        for (const [path, source] of Object.entries(JSON.parse(body))) {
          assert.ok(path.startsWith("/virtual/synthetic/") && path.endsWith(".js") && typeof source === "string");
          scriptFiles.set(path, source);
        }
        response.writeHead(204); response.end();
      } catch { response.writeHead(400); response.end(); }
    });
    return;
  }
  if (scriptFiles.has(request.url)) { response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Access-Control-Allow-Origin": "*" }); response.end(scriptFiles.get(request.url)); return; }
  if (request.url?.endsWith("/lazy.png")) {
    response.writeHead(200, { "Content-Type": "image/png" }); response.end(imageBytes); return;
  }
  if (request.url === "/favicon.ico") { response.writeHead(204); response.end(); return; }
  if (request.url !== "/") { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(`<!doctype html><html><head><meta charset="UTF-8"><title>ATools deferred script regression</title><style>
    body{margin:0;padding:24px;background:#f6f7fa;color:#202631;font:13px system-ui}h1{font-size:21px;margin:0 0 8px}p{color:#657083;margin:0 0 16px}
    #status{padding:10px 12px;border-radius:8px;background:#e7eaf1;margin-bottom:16px;font-weight:600}.fixtures{display:flex;gap:14px}section{min-width:0;flex:1;background:white;border:1px solid #dde1e9;border-radius:10px;overflow:hidden}h2{font-size:13px;margin:0;padding:10px;border-bottom:1px solid #eee}iframe{display:block;width:100%;height:125px;border:0}pre{font:11px/1.65 monospace;white-space:pre-wrap;padding:12px;margin:14px 0 0;background:white;border:1px solid #dde1e9;border-radius:10px}
    </style></head><body><h1>Plugin script scheduling</h1><p>Production loader · synthetic package · sandbox="allow-scripts" · no community plugin execution</p><div id="status">Preparing fixtures</div><div class="fixtures" id="fixtures"></div><pre id="report"></pre></body></html>`);
});

let chrome, page;
let report;
const consoleIssues = [];
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  chrome = await launchChrome();
  page = await CdpClient.connect(await createPageWebSocketUrl(chrome.webSocketUrl));
  page.on("Runtime.consoleAPICalled", event => {
    if (["warning", "error", "assert"].includes(event.type)) consoleIssues.push(`${event.type}: ${formatConsoleArgs(event.args)}`);
  });
  page.on("Runtime.exceptionThrown", event => consoleIssues.push(`exception: ${event.exceptionDetails?.text}`));
  page.on("Log.entryAdded", ({ entry }) => { if (["warning", "error"].includes(entry.level)) consoleIssues.push(`${entry.source}/${entry.level}: ${entry.text}`); });
  await page.send("Runtime.enable", {}, { timeoutMs: 5000 });
  await page.send("Log.enable", {}, { timeoutMs: 5000 });
  await page.send("Page.enable", {}, { timeoutMs: 5000 });
  await page.send("Emulation.setDeviceMetricsOverride", { width: 960, height: 720, deviceScaleFactor: 1, mobile: false }, { timeoutMs: 5000 });
  const loaded = page.waitForEvent("Page.loadEventFired", 5000);
  await page.send("Page.navigate", { url: origin }, { timeoutMs: 5000 });
  await loaded;
  const result = await page.send("Runtime.evaluate", {
    awaitPromise: true, returnByValue: true,
    expression: `(${runFixtures.toString()})(${JSON.stringify({ loaderModule, baseline })})`,
  }, { timeoutMs: 20000 });
  assert.equal(result.exceptionDetails, undefined, `Synthetic fixture setup failed: ${JSON.stringify(result.exceptionDetails)}`);
  report = { ...result.result.value, runId, baseline, loaderPath, loaderSha256: createHash("sha256").update(loaderSource).digest("hex"), requests, consoleIssues };
  const failures = validateReport(report, origin);
  report = { ...report, passed: failures.length === 0, baseline, expectedBaselineFailure: baseline && failures.some(value => value.includes("defer")), failures,
    scope: "Synthetic source-bound loader under test in opaque Chromium iframes; loaderPath and SHA identify the production source or historical/custom comparator. No original plugin execution or native runtime acceptance.", screenshot: `${prefix}.png` };
  await page.send("Runtime.evaluate", { expression: `document.getElementById('status').textContent=${JSON.stringify(baseline ? `Baseline: ${failures.length} scheduling checks fail as expected` : failures.length ? `Failed: ${failures.join("; ")}` : "Passed: native defer ordering, globals, source URLs, relative assets and async boundary")};document.getElementById('status').style.background=${JSON.stringify(failures.length ? "#fff0d4" : "#ddf4e9")}` }, { timeoutMs: 5000 });
  await mkdir(output, { recursive: true });
  const screenshot = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, { timeoutMs: 5000 });
  await writeFile(new URL(`${prefix}.png`, output), Buffer.from(screenshot.data, "base64"));
  await writeFile(new URL(`${prefix}.json`, output), JSON.stringify(report, null, 2) + "\n");
  if (baseline) assert.equal(report.expectedBaselineFailure, true, "baseline should reproduce the lost external defer semantics");
  else assert.deepEqual(failures, [], "production deferred script browser contract");
} finally {
  const cleanup = await Promise.allSettled([
    page?.close(), chrome?.close(), new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  ].filter(Boolean));
  const failures = cleanup.filter(result => result.status === "rejected");
  assert.equal(failures.length, 0, `Owned browser/server cleanup failed: ${failures.map(result => result.reason)}`);
}
console.info(`${baseline ? "Baseline recorded" : "Deferred script browser regression passed"}; owned browser/server closed. ${new URL(`${prefix}.json`, output).pathname}`);

function validateReport(report, origin) {
  const failures = [], check = (condition, message) => { if (!condition) failures.push(message); };
  const events = report.ordered.events;
  check(report.ordered.origin === "null" && report.async.origin === "null", "sandbox must keep opaque origins");
  check(report.ordered.parentBlocked && report.async.parentBlocked, "sandbox must deny parent document access");
  check(report.ordered.sandbox === "allow-scripts", "sandbox must never include allow-same-origin");
  check(JSON.stringify(events.map(event => event.name)) === JSON.stringify(["inline-head", "blocking", "inline-tail", "inline-body", "defer-one", "module", "defer-two", "DOMContentLoaded"]), "defer/blocking/inline/module parser order");
  for (const name of ["defer-one", "defer-two"]) {
    const event = events.find(event => event.name === name);
    check(event?.body && event.targetExists, `${name} must run after body markup exists`);
    check(event?.readyState === "interactive" && !event.domContentLoaded, `${name} must precede DOMContentLoaded`);
    check(event?.src === `${origin}/virtual/synthetic/regex-editor/scripts/${name}.js`, `${name} currentScript.src must remain the original external source URL`);
    check(event?.marker === `${origin}/virtual/synthetic/regex-editor/scripts/${name}.js`, `${name} must retain original script marker`);
  }
  const second = events.find(event => event.name === "defer-two"), module = events.find(event => event.name === "module");
  check(second?.sharedVar === "var-one:two" && second.sharedLexical === "lexical-one:two" && !second.lexicalOnWindow, "defer scripts must share classic var and lexical globals");
  check(module?.sharedVar === "var-one" && module.sharedLexical === "lexical-one" && module.src === null, "module order and currentScript semantics must remain native");
  check(events.find(event => event.name === "blocking")?.body === false && events.find(event => event.name === "blocking")?.src === "", "blocking scripts must retain parser-blocking inline behavior");
  check(report.ordered.publicPath === `${origin}/virtual/synthetic/regex-editor/scripts/`, "defer Webpack publicPath must use original directory rather than blob directory");
  check(report.ordered.imageUrl === `${origin}/virtual/synthetic/regex-editor/scripts/lazy.png` && report.ordered.imageLoaded, "defer publicPath must load the synthetic relative image");
  check(report.ordered.directImageUrl === `${origin}/virtual/synthetic/regex-editor/scripts/lazy.png` && report.ordered.directImageLoaded, "new URL relative to currentScript.src must load an image without rewriting plugin source");
  const async = report.async.events.find(event => event.name === "async-defer");
  check(async?.src === `${origin}/virtual/synthetic/regex-editor/scripts/async-defer.js` && async.async && async.defer && async.marker.endsWith("/async-defer.js"), "async+defer must remain native external async, without a forced defer order");
  check(report.objectUrlCalls === 0, "direct external scripts must not allocate object URLs");
  if (!report.baseline) check(!report.ordered.reads.some(path => /defer-(one|two)\.js$/.test(path)) && report.async.reads.length === 0, "scheduled scripts should load from the source URL without a host text read");
  check(report.ordered.errors.length === 0 && report.async.errors.length === 0, "synthetic frame must have no script errors");
  check(report.consoleIssues.length === 0, "browser console must have no warnings or errors");
  return failures;
}

async function runFixtures({ loaderModule, baseline }) {
  const { preparePluginHtmlResources } = await import(loaderModule);
  let objectUrlCalls = 0;
  const createUrl = URL.createObjectURL.bind(URL);
  URL.createObjectURL = blob => { objectUrlCalls++; return createUrl(blob); };
  const snapshots = {}, pending = new Map();
  const onMessage = event => {
    const value = event.data;
    if (!value?.__deferred_fixture_done__) return;
    const entry = pending.get(value.id);
    if (!entry || event.source !== entry.frame.contentWindow) return;
    entry.resolve(value); pending.delete(value.id);
  };
  window.addEventListener("message", onMessage);
  const bootstrap = id => `var fixtureId=${JSON.stringify(id)},fixtureEvents=[],fixtureErrors=[],fixtureDcl=false;function mark(name,extra){var s=document.currentScript;fixtureEvents.push(Object.assign({name:name,readyState:document.readyState,body:!!document.body,targetExists:!!document.getElementById('app'),domContentLoaded:fixtureDcl,src:s?s.src:null,marker:s?s.getAttribute('data-atools-plugin-script-src'):null,async:s?s.async:null,defer:s?s.defer:null},extra||{}));}window.addEventListener('error',function(e){fixtureErrors.push(e.message||(e.target.tagName==='SCRIPT'?'Script resource failed: '+e.target.src:'resource load error'));},true);document.addEventListener('DOMContentLoaded',function(){mark('DOMContentLoaded');fixtureDcl=true;});window.addEventListener('load',function(){var blocked=false;try{void parent.document.body;}catch(e){blocked=true;}parent.postMessage({__deferred_fixture_done__:true,id:fixtureId,origin:origin,parentBlocked:blocked,events:fixtureEvents,errors:fixtureErrors,publicPath:window.fixturePublicPath||null,imageUrl:window.fixtureImage?window.fixtureImage.src:null,imageLoaded:!!window.fixtureImage&&window.fixtureImage.complete&&window.fixtureImage.naturalWidth===1,directImageUrl:window.fixtureDirectImage?window.fixtureDirectImage.src:null,directImageLoaded:!!window.fixtureDirectImage&&window.fixtureDirectImage.complete&&window.fixtureDirectImage.naturalWidth===1},'*');});mark('inline-head');`;
  const files = {
    "/synthetic/regex-editor/scripts/blocking.js": "mark('blocking');",
    "/synthetic/regex-editor/scripts/defer-one.js": `var e=document.currentScript.src;if(!e)throw new Error("Automatic publicPath is not supported in this browser");e=e.replace(/#.*$/,"").replace(/\\?.*$/,"").replace(/\\/[^\\/]+$/, "/");window.fixturePublicPath=e;window.fixtureImage=new Image();window.fixtureImage.src=e+'lazy.png';if(document.body)document.body.append(window.fixtureImage);if(document.currentScript.src){window.fixtureDirectImage=new Image();window.fixtureDirectImage.src=new URL('./lazy.png',document.currentScript.src).href;document.body?.append(window.fixtureDirectImage);}var sharedVar='var-one';let sharedLexical='lexical-one';mark('defer-one');`,
    "/synthetic/regex-editor/scripts/module.js": "mark('module',{sharedVar,sharedLexical});",
    "/synthetic/regex-editor/scripts/defer-two.js": "sharedVar+=':two';sharedLexical+=':two';mark('defer-two',{sharedVar,sharedLexical,lexicalOnWindow:Object.prototype.hasOwnProperty.call(window,'sharedLexical')});document.getElementById('app')?.setAttribute('data-deferred-ready','true');",
    "/synthetic/regex-editor/scripts/async-defer.js": "mark('async-defer');",
  };
  try {
    const registered = await fetch("/fixtures", { method: "POST", body: JSON.stringify(Object.fromEntries(Object.entries(files).map(([path, source]) => [`/virtual${path}`, source]))) });
    if (!registered.ok) throw new Error("Could not register synthetic original script bytes");
    for (const id of ["ordered", "async"]) {
      const reads = [];
      const tags = id === "ordered"
        ? `<script src="./scripts/blocking.js"></script><script defer src="./scripts/defer-one.js"></script><script type="module" src="./scripts/module.js"></script><script defer src="./scripts/defer-two.js"></script>`
        : `<script async defer src="./scripts/async-defer.js"></script>`;
      const html = `<!doctype html><html><head><meta charset="UTF-8"><script>${bootstrap(id)}</script>${tags}<script>mark('inline-tail');</script></head><body><main id="app"><h3>Synthetic ${id} plugin</h3><p>Body markup is available to deferred scripts.</p></main><script>mark('inline-body');</script></body></html>`;
      const prepared = await preparePluginHtmlResources(html, { pluginDir: "/synthetic/regex-editor", mainFile: "index.html",
        readTextFile: async path => { reads.push(path); if (!(path in files)) throw new Error(`Unexpected synthetic file: ${path}`); return files[path]; },
        convertFileSrc: path => `${location.origin}/virtual${path}`, warn: message => { throw new Error(message); },
      });
      const section = document.createElement("section"), heading = document.createElement("h2"), frame = document.createElement("iframe");
      heading.textContent = id === "ordered" ? "Classic defer + module" : "Async + defer boundary";
      frame.setAttribute("sandbox", "allow-scripts"); section.append(heading, frame); document.getElementById("fixtures").append(section);
      let timer;
      try {
        const done = new Promise((resolve, reject) => { pending.set(id, { frame, resolve }); timer = setTimeout(() => reject(new Error(`Timed out waiting for synthetic ${id} frame`)), 8000); });
        frame.srcdoc = prepared;
        const result = await done;
        snapshots[id] = { ...result, sandbox: frame.getAttribute("sandbox"), reads,
          preparedScripts: Array.from(new DOMParser().parseFromString(prepared, "text/html").scripts).map(script => ({ type: script.type, src: script.getAttribute("src"), defer: script.defer, async: script.async, marker: script.getAttribute("data-atools-plugin-script-src") })) };
      } finally { clearTimeout(timer); pending.delete(id); }
    }
    document.getElementById("report").textContent = Object.entries(snapshots).filter(([, value]) => value.events).map(([id, value]) => `${id}:\n${value.events.map(event => `  ${event.name.padEnd(17)} ${event.readyState.padEnd(11)} body=${String(event.body).padEnd(5)} ${event.src ? "original external URL" : event.src === null ? "native module/event" : "inline"}`).join("\n")}\n  parent access blocked=${value.parentBlocked} · host text reads=${value.reads.length}`).join("\n\n");
    return { ...snapshots, objectUrlCalls };
  } finally { window.removeEventListener("message", onMessage); URL.createObjectURL = createUrl; }
}

// Production HTML loader with a synthetic native ESM graph; no community code.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { bundlePluginResourceLoader } from './lib/bundle-plugin-resource-loader.mjs';
import { CdpClient, createPageWebSocketUrl, launchChrome } from './chrome-cdp-smoke-utils.mjs';

const root = new URL('../', import.meta.url), baseline = process.argv.includes('--baseline');
const runId = randomUUID(), loaderPath = new URL('src/lib/pluginResourceHtml.ts', root);
const source = await readFile(loaderPath, 'utf8');
const runnerSha256 = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
const loaderUrl = 'data:text/javascript;base64,' + Buffer.from(await bundlePluginResourceLoader(loaderPath.pathname)).toString('base64');
const files = {
  '/synthetic/module/assets/entry.js': `export const singleton={id:'original-entry'};
window.moduleEvaluations=(window.moduleEvaluations||0)+1;
const emit=(phase,extra)=>parent.postMessage({kind:'module-graph',phase,meta:import.meta.url,evaluations:window.moduleEvaluations,origin:location.origin,currentScript:document.currentScript,...extra},'*');
document.getElementById('root').textContent='entry mounted';
document.getElementById('lazy').onclick=async()=>{try{const child=await import('./lazy.js');emit('lazy',{sameSingleton:child.singleton===singleton,value:child.result,childMeta:child.source});}catch(error){emit('lazy-error',{error:String(error)});}};
emit('entry',{bodyReady:!!document.getElementById('root')});setTimeout(()=>document.getElementById('lazy').click(),30);`,
  '/synthetic/module/assets/lazy.js': `import {singleton} from './entry.js?cohort=one#keep';export{singleton};export const result=42;export const source=import.meta.url;`,
};
const requests = [], issues = [];
let server, chrome, page, report, failure;
try {
  server = createServer((request, response) => {
    requests.push(request.url);
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><meta charset="utf-8"><div id="fixture"></div>');
    } else if (pathname.startsWith('/virtual') && files[pathname.slice(8)]) {
      response.writeHead(200, { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' }); response.end(files[pathname.slice(8)]);
    } else if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); }
    else { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  chrome = await launchChrome();
  page = await CdpClient.connect(await createPageWebSocketUrl(chrome.webSocketUrl));
  page.on('Runtime.exceptionThrown', value => issues.push(value.exceptionDetails?.text));
  await page.send('Runtime.enable', {}, { timeoutMs: 5000 });
  await page.send('Page.enable', {}, { timeoutMs: 5000 });
  const loaded = page.waitForEvent('Page.loadEventFired', 5000);
  await page.send('Page.navigate', { url: origin }, { timeoutMs: 5000 }); await loaded;
  const response = await page.send('Runtime.evaluate', { awaitPromise: true, returnByValue: true,
    expression: `(${exercise.toString()})(${JSON.stringify({ loaderUrl, files, origin })})` }, { timeoutMs: 12000 });
  assert.equal(response.exceptionDetails, undefined);
  const observation = response.result.value, entry = observation.events.find(item => item.phase === 'entry');
  const lazy = observation.events.find(item => item.phase === 'lazy');
  const checks = {
    opaqueOrigin: entry?.origin === 'null',
    sourceUrlRetained: entry?.meta === origin + '/virtual/synthetic/module/assets/entry.js?cohort=one#keep',
    nativeDeferredBody: entry?.bodyReady === true && entry?.currentScript === null,
    lazyModuleLoaded: lazy?.value === 42,
    lazyModuleUrl: lazy?.childMeta === origin + '/virtual/synthetic/module/assets/lazy.js',
    nativeModuleSingleton: lazy?.sameSingleton === true && lazy.evaluations === 1,
    noModuleTextRead: observation.reads.length === 0,
    externalModuleTagRetained: observation.script.src === origin + '/virtual/synthetic/module/assets/entry.js?cohort=one#keep'
      && observation.script.type === 'module' && observation.script.crossOrigin === 'anonymous',
    noUnexpectedException: issues.length === 0,
  };
  report = { schemaVersion: 1, runId, recordedAt: new Date().toISOString(), baseline,
    loaderSha256: createHash('sha256').update(source).digest('hex'), runnerSha256, checks, observation, requests, issues,
    passed: Object.values(checks).every(Boolean),
    scope: 'Actual production loader source in opaque Chromium iframe; synthetic ESM package only, local HTTP/CORS fixture, no native asset-protocol or original plugin acceptance' };
  if (baseline) assert.equal(report.passed, false, 'Current comparator should reproduce module source/graph failure');
  else assert.equal(report.passed, true, 'Production native module graph contract');
} catch (error) { failure = error; if (report) report.failure = String(error); }
finally {
  const resources = [];
  if (page) resources.push(['cdp', () => page.close()]);
  if (chrome) resources.push(['chrome', () => chrome.close()]);
  if (server?.listening) resources.push(['server', () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))]);
  const cleanup = [];
  for (const [name, close] of resources) {
    try { await close(); cleanup.push({ name, status: 'fulfilled' }); }
    catch (error) { cleanup.push({ name, status: 'rejected', error: String(error) }); failure ||= error; }
  }
  if (report) {
    report.cleanup = cleanup;
    report.sourceHashStable = createHash('sha256').update(await readFile(loaderPath)).digest('hex') === report.loaderSha256
      && createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex') === runnerSha256;
    if (!report.sourceHashStable) failure ||= Error('Source changed during module graph verification');
    if (!report.sourceHashStable || cleanup.some(row => row.status !== 'fulfilled')) report.passed = false;
    const prefix = baseline ? 'plugin-module-graph-baseline' : 'plugin-module-graph';
    const output = new URL(`output/launcher-ui-2026-10-15/${prefix}-${runId}.json`, root);
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ output: output.pathname, baseline, passed: report.passed, checks: report.checks, cleanup }));
  }
}
if (failure) throw failure;

async function exercise({ loaderUrl, files, origin }) {
  const { preparePluginHtmlResources } = await import(loaderUrl), reads = [], events = [];
  const html = '<!doctype html><html><head><base href="./"><script type="module" crossorigin="anonymous" src="./assets/entry.js?cohort=one#keep"></script></head><body><main id="root"></main><button id="lazy">Load local module</button></body></html>';
  const prepared = await preparePluginHtmlResources(html, { pluginDir: '/synthetic/module', mainFile: 'index.html',
    readTextFile: async name => { reads.push(name); if (!(name in files)) throw Error('Unexpected synthetic file'); return files[name]; },
    convertFileSrc: name => origin + '/virtual' + name });
  const script = new DOMParser().parseFromString(prepared, 'text/html').querySelector('script');
  const frame = document.createElement('iframe'); frame.setAttribute('sandbox', 'allow-scripts');
  let timer, handler;
  try {
    const done = new Promise((resolve, reject) => {
      handler = event => {
        if (event.source !== frame.contentWindow || event.data?.kind !== 'module-graph') return;
        events.push(event.data); if (event.data.phase !== 'entry') resolve();
      };
      window.addEventListener('message', handler);
      timer = setTimeout(() => reject(Error('Synthetic module graph did not report')), 5000);
    });
    frame.srcdoc = prepared; document.getElementById('fixture').append(frame); await done;
    return { events, reads, script: { src: script.getAttribute('src'), type: script.type, crossOrigin: script.crossOrigin } };
  } finally { clearTimeout(timer); window.removeEventListener('message', handler); frame.remove(); }
}

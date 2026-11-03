import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { CdpClient, createPageWebSocketUrl, formatConsoleArgs, launchChrome, launchViteServer, delay } from './chrome-cdp-smoke-utils.mjs';
import { createMainPushBookmarkNodeHost } from './lib/main-push-bookmark-node-host.mjs';

const root = resolve('.'), port = 1487, origin = `http://127.0.0.1:${port}`;
const output = process.env.ATOOLS_MAIN_PUSH_OUTPUT || `/private/tmp/atools-batch37-mainpush-browser-delivery/browser-${Date.now()}`;
const report = { status: 'failed', checks: [], consoleIssues: [], requests: [], customResources: [], geometry: [],
  scope: 'Real Chromium App, production PluginPanel loader/bridge, complete unchanged original calculation-paper HTML/JS and bookmarks preload/bookmarks/mcp CJS. Native candidate, permission, path/session, activation, custom-resource lease are explicitly mocked services. No Rust TaskRun, actual browser launch, clipboard, native input or majority compatibility acceptance.' };
let server, chrome, page, nodeHost, before;
const resourceOperations = new Set();
async function files(directory) {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name); if (item.isDirectory()) result.push(...await files(path)); else if (item.isFile()) result.push(relative(root, path));
  }
  return result;
}
const ownFiles = ['scripts/test-launcher-main-push-browser.mjs', 'scripts/test-main-push-bookmark-node-host.mjs',
  'scripts/lib/main-push-bookmark-node-host.mjs', 'scripts/lib/main-push-bookmark-node-fixture.mjs', 'scripts/lib/main-push-bookmark-node-policy.mjs',
  'tests/components/launcherMainPushBrowserFixture.ts', 'tests/components/launcher-main-push-browser.html', 'tests/components/main-push-browser-observation.ts'];
const paths = [...await files(join(root, 'src')), ...await files(join(root, 'ZTools-plugins/plugins/calculation-paper')),
  ...await files(join(root, 'ZTools-plugins/plugins/bookmarks')), ...ownFiles,
  'crates/atools-plugin/src/legacy_node/codec.cjs', 'crates/atools-plugin/src/legacy_node/bootstrap.cjs'];
async function fingerprint() { return Promise.all([...new Set(paths)].sort().map(async path => { const bytes = await readFile(join(root, path)); return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; })); }
async function evaluate(expression) {
  const result = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, { timeoutMs: 15000 });
  assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description || result.exceptionDetails?.text);
  return result.result.value;
}
async function waitFor(expression, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await evaluate(expression); if (result) return result; await delay(40); }
  assert.fail('Timed out: ' + expression);
}
async function click(selector) {
  const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return{x,y,width:r.width,height:r.height,visible:r.width>0&&r.height>0&&r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,hit:e.contains(document.elementFromPoint(x,y))}})()`);
  assert.ok(point?.visible && point.hit, 'Reachable actual target: ' + selector + ': ' + JSON.stringify(point)); report.geometry.push({ selector, ...point });
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, x: point.x, y: point.y });
  await delay(40);
}
async function input(text) {
  await click('[data-atools-search-input]');
  await evaluate("document.querySelector('[data-atools-search-input]').select()");
  if (text) await page.send('Input.insertText', { text });
  else { await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }); await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }); }
  assert.equal(await evaluate("document.querySelector('[data-atools-search-input]').value"), text);
}
async function key(key, code, number) {
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: number });
  await delay(60);
}
async function rows() { return evaluate("Array.from(document.querySelectorAll('[data-result-code^=\"main-push:\"]')).map(e=>({code:e.dataset.resultCode,text:e.innerText}))"); }
async function screenshot(name) { const image = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(`${output}/${name}.png`, Buffer.from(image.data, 'base64'), { flag: 'wx' }); }
async function observed(owner, stage) { return evaluate(`fixture.snapshot().observations.filter(v=>v.owner===${JSON.stringify(owner)}&&v.stage===${JSON.stringify(stage)})`); }
await mkdir(output); // Never overwrite an earlier failed attempt.
try {
  before = await fingerprint(); await writeFile(`${output}/source-before.json`, JSON.stringify(before, null, 2), { flag: 'wx' });
  server = await launchViteServer({ port, probeUrl: origin }); chrome = await launchChrome();
  page = await CdpClient.connect(await createPageWebSocketUrl(chrome.webSocketUrl));
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable');
  nodeHost = await createMainPushBookmarkNodeHost(page, root, report);
  page.on('Runtime.exceptionThrown', event => report.consoleIssues.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  page.on('Runtime.consoleAPICalled', ({ type, args }) => { if (['error', 'warning', 'assert'].includes(type)) report.consoleIssues.push(type + ': ' + formatConsoleArgs(args)); });
  page.on('Network.requestWillBeSent', event => report.requests.push(event.request.url));
  await page.send('Fetch.enable', { patterns: [{ urlPattern: 'http://*.localhost/*', requestStage: 'Request' }] });
  page.on('Fetch.requestPaused', event => { const operation = (async () => {
    try {
      const path = await evaluate(`fixture.resolveLeaseUrl(${JSON.stringify(event.request.url)})`);
      assert.ok(path?.startsWith(root + '/ZTools-plugins/plugins/'));
      const bytes = await readFile(path); assert.ok(before.some(row => join(root, row.path) === path && row.sha256 === createHash('sha256').update(bytes).digest('hex')));
      report.customResources.push({ path: relative(root, path), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      await page.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: path.endsWith('.svg') ? 'image/svg+xml' : 'image/png' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: bytes.toString('base64') });
    } catch (error) { report.consoleIssues.push('custom-resource: ' + error.message); await page.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(() => {}); }
  })(); resourceOperations.add(operation); void operation.finally(() => resourceOperations.delete(operation)); });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 780, deviceScaleFactor: 1, mobile: false });
  const loaded = page.waitForEvent('Page.loadEventFired', 30000);
  await page.send('Page.navigate', { url: `${origin}/tests/components/launcher-main-push-browser.html?workspace=${encodeURIComponent(root)}` }); await loaded;
  await waitFor('window.launcherMainPushReady');

  await evaluate('fixture.deferNextPrepareCommit()'); await input('123+456');
  await waitFor("fixture.snapshot().pipeline.some(event=>event.operation==='prepare'&&event.stage==='receipt-accepted')");
  await delay(180);
  assert.equal(await evaluate("fixture.snapshot().calls.filter(call=>call.command==='run_plugin_main_push'&&call.args.operation==='query').length"), 0);
  assert.equal((await observed('calculation-paper', 'query')).length, 0);
  assert.equal((await rows()).length, 0);
  assert.equal(await evaluate("document.activeElement===document.querySelector('[data-atools-search-input]')"), true);
  await evaluate('fixture.releasePrepareCommits()');
  await waitFor("document.querySelector('[data-result-code^=\"main-push:\"]')?.innerText.includes('579')");
  report.checks.push('Prepare receipt acknowledgement alone never admits query: original callback and dynamic rows wait for separately released durable-success pipeline commit');
  const calcRows = await rows(); assert.equal(calcRows.length, 1); assert.match(calcRows[0].text, /579/);
  let calcProbe = (await observed('calculation-paper', 'query')).at(-1);
  assert.deepEqual(calcProbe.queries.at(-1), { code: 'expression', type: 'regex', payload: '123+456', from: 'main' });
  assert.equal(calcProbe.enters.length, 0); assert.equal(calcProbe.registrations[0].hasSelect, false);
  assert.equal(await evaluate("document.activeElement===document.querySelector('[data-atools-search-input]')"), true);
  await screenshot('main-push-original-calculation');
  report.checks.push('Trusted main-search input reaches original complete calculation-paper callback; 123+456 displays 579 without PluginEnter or focus stealing');
  await click('[data-result-code^="main-push:"]');
  await waitFor("fixture.snapshot().calls.some(v=>v.command==='complete_plugin_main_push'&&v.args.outcome==='handled')");
  assert.equal(await evaluate("fixture.snapshot().calls.filter(v=>v.command==='activate_feature').length"), 0);
  report.checks.push('Original calculation page has no select callback: selecting a result returns handled and never fabricates literal true or opens UI');
  await evaluate("window.__mainPushOriginalFrame=document.querySelector('.main-push-runner iframe');window.__mainPushOriginalWindow=window.__mainPushOriginalFrame.contentWindow");
  await click('.group-enter');
  await waitFor("document.querySelector('.main-push-runner.promoted iframe') && fixture.snapshot().observations.some(v=>v.owner==='calculation-paper'&&v.stage==='after-enter')");
  assert.equal(await evaluate("window.__mainPushOriginalFrame===document.querySelector('.main-push-runner.promoted iframe')&&window.__mainPushOriginalWindow===document.querySelector('.main-push-runner.promoted iframe').contentWindow"), true);
  const promoted = (await observed('calculation-paper', 'after-enter')).at(-1);
  assert.equal(promoted.identity, calcProbe.identity); assert.ok(promoted.sameDocument && promoted.sameWindow); assert.equal(promoted.enters.length, 1);
  assert.deepEqual(promoted.registrations, calcProbe.registrations, 'Original callback references remain the same registered functions');
  assert.equal(promoted.enters[0].payload, '123+456'); assert.ok(promoted.textareaValues.includes('123+456'));
  assert.deepEqual(await evaluate("fixture.snapshot().calls.filter(v=>v.command==='activate_feature').map(v=>v.args)"), [{ code: 'expression', payload: '123+456', expectedPluginId: 'calculation-paper' }]);
  await screenshot('main-push-original-calculation-promoted');
  report.checks.push('Group header uses normal owner-checked activation once and promotes the same iframe, WindowProxy, original document and callback closure; original PluginEnter runs once');
  await key('Escape', 'Escape', 27); await waitFor("!document.querySelector('.main-push-runner.promoted') && document.querySelector('[data-atools-search-input]')");

  await input('1 2 3'); await waitFor("document.querySelectorAll('[data-result-code^=\"main-push:\"]').length===2");
  const aggregate = await rows(); assert.ok(aggregate.some(row => /\b6\b/.test(row.text))); assert.ok(aggregate.some(row => /\b2\b/.test(row.text)));
  const aggregateCalls = await evaluate("fixture.snapshot().observations.filter(v=>v.owner==='calculation-paper'&&v.stage==='query'&&v.queries.at(-1).payload==='1 2 3').map(v=>v.queries.at(-1).code)");
  assert.deepEqual(aggregateCalls.sort(), ['average', 'sum']);
  assert.equal(await evaluate("document.querySelectorAll('.main-push-runner').length"), 2);
  report.checks.push('Original sum and average providers coexist under the two-runner cap and display independent 6 and 2 results');

  await input('Fixed Edge'); await waitFor("document.querySelectorAll('[data-result-code^=\"main-push:\"]').length===4");
  const edgeRows = await rows(); assert.ok(edgeRows.every(row => row.text.includes('Fixed Edge') && row.text.includes('https://fixture.invalid/edge/')));
  await click('[data-result-code^="main-push:"]');
  await waitFor("fixture.snapshot().observations.some(v=>v.owner==='bookmarks'&&v.stage==='select')");
  const bookmarkSelect = (await observed('bookmarks', 'select')).at(-1).selections.at(-1);
  assert.equal(bookmarkSelect.option.browser, 'edge'); assert.equal(bookmarkSelect.option.url, 'https://fixture.invalid/edge/1');
  const sinkDeadline = Date.now() + 2000; let sinks;
  do { sinks = await nodeHost.sinks(); if (sinks.some(item => item.type === 'spawn-sink')) break; await delay(30); } while (Date.now() < sinkDeadline);
  assert.deepEqual(sinks.find(item => item.type === 'spawn-sink').args, ['-a', '/Applications/Microsoft Edge.app', 'https://fixture.invalid/edge/1']);
  assert.equal(await evaluate("fixture.snapshot().calls.filter(v=>v.command==='activate_feature').length"), 1);
  report.checks.push('Complete original bookmarks preload/bookmarks/mcp reads eight isolated fixed bookmarks via real Node; Fixed Edge shows four and original selection preserves private browser/url into a recorded open sink');
  await input('Fixed'); await waitFor("document.querySelectorAll('[data-result-code^=\"main-push:\"]').length===6");
  const allRows = await rows(); assert.match(allRows.at(-1).text, /共搜索到 8 条书签，查看更多/); assert.ok(allRows.slice(0, 5).every(row => row.text.includes('Fixed')));
  await screenshot('main-push-original-bookmarks');
  report.checks.push('Original bookmarks truncation preserves five real entries plus the unchanged eight-results more row');
  await input('absent fixture'); await waitFor("document.querySelectorAll('[data-result-code^=\"main-push:\"]').length===0 && document.querySelectorAll('.main-push-runner').length===0");
  await input('Fixed'); await waitFor("document.querySelectorAll('[data-result-code^=\"main-push:\"]').length===6");
  await input(''); await waitFor("document.querySelectorAll('[data-result-code^=\"main-push:\"]').length===0 && document.querySelectorAll('.main-push-runner').length===0");
  report.checks.push('Absent and empty queries remove old rows, hidden documents and their real Node owners');

  await input('Promise fixture'); await waitFor("document.querySelector('[data-result-code^=\"main-push:\"]')?.innerText.includes('Fixed Promise result')");
  assert.equal(await evaluate("document.activeElement===document.querySelector('[data-atools-search-input]')"), true);
  const fixedBefore = (await observed('fixture-main-push', 'query')).at(-1); assert.equal(fixedBefore.enters.length, 0);
  await evaluate("window.__mainPushFixedFrame=document.querySelector('.main-push-runner iframe')");
  await click('[data-result-code^="main-push:"]');
  await waitFor("document.querySelector('.main-push-runner.promoted') && fixture.snapshot().observations.some(v=>v.owner==='fixture-main-push'&&v.stage==='after-enter')");
  const fixedAfter = (await observed('fixture-main-push', 'after-enter')).at(-1);
  assert.equal(fixedAfter.identity, fixedBefore.identity); assert.equal(fixedAfter.enters.length, 1); assert.equal(fixedAfter.enters[0].option.id, 'fixed-private-option');
  assert.equal(await evaluate("window.__mainPushFixedFrame===document.querySelector('.main-push-runner.promoted iframe')"), true);
  report.checks.push('Separate fixed contract page attempts startup window/input autofocus before registration; Promise rows still render without stealing search focus, literal true alone promotes the same document and passes its original option once');

  report.fixture = await evaluate('fixture.snapshot()');
  assert.deepEqual(report.fixture.rejected, []); assert.deepEqual(report.fixture.sink, []);
  assert.ok(report.fixture.events.some(event => event.target === 'main-search' && event.type === 'input' && event.trusted));
  const nativeOperations = report.fixture.calls.filter(call => call.command === 'run_plugin_main_push' || call.command === 'complete_plugin_main_push');
  assert.ok(nativeOperations.length > 10); assert.ok(nativeOperations.every(call => !['query', 'payload', 'option', 'url', 'browser'].some(key => key in call.args)));
  assert.ok(!report.fixture.pipeline.some(event => event.stage === 'admission-rejected'));
  for (const event of report.fixture.pipeline.filter(event => event.stage === 'dispatched' && event.operation !== 'prepare')) {
    const committed = report.fixture.pipeline.findIndex(item => item.runnerId === event.runnerId && item.operation === 'prepare' && item.stage === 'durable-commit' && item.status === 'succeeded');
    assert.ok(committed >= 0 && committed < report.fixture.pipeline.indexOf(event), 'Query/select must follow exact runner preparation commit');
  }
  const allowedEndpoints = [...nodeHost.endpoints];
  assert.ok(report.requests.every(url => url.startsWith(origin + '/') || url.startsWith('data:') || url.startsWith('blob:')
    || allowedEndpoints.some(endpoint => url === endpoint) || /^http:\/\/atools-plugin\.localhost\//.test(url)), 'No unowned or external app requests');
  assert.deepEqual(report.consoleIssues, []);
  report.status = 'passed';
} catch (error) {
  report.failure = error.stack || String(error); console.error(report.failure);
  report.failureState = await evaluate("({text:document.body.innerText,fixture:window.fixture?.snapshot()})").catch(() => null);
  if (page) await screenshot('failure').catch(() => {});
} finally {
  report.cleanup = {};
  if (page) report.cleanup.fixture = await evaluate('fixture.dispose()').catch(error => ({ error: error.message }));
  if (nodeHost) report.cleanup.nodeHost = await nodeHost.close().catch(error => ({ error: error.message }));
  report.runtimeUrls = await evaluate("performance.getEntriesByType('resource').map(value=>value.name).filter(value=>/svelte|chunk-|\\.js/.test(value))").catch(() => []);
  await Promise.allSettled([...resourceOperations]);
  try { const after = await fingerprint(); await writeFile(`${output}/source-after.json`, JSON.stringify(after, null, 2), { flag: 'wx' }); assert.deepEqual(after, before); report.sourceStable = true; }
  catch (error) { report.sourceStable = false; if (report.status === 'passed') { report.status = 'failed'; report.failure = error.stack || String(error); } }
  if (report.status === 'passed') {
    if (report.cleanup.fixture?.listeners !== 0 || report.cleanup.fixture?.pending !== 0 || report.cleanup.nodeHost?.activeOwners !== 0
      || report.cleanup.nodeHost?.activeSessions !== 0 || !report.cleanup.nodeHost?.isolatedEnvironmentRemoved) { report.status = 'failed'; report.failure = 'Cleanup boundary did not drain'; }
  }
  const closed = await Promise.allSettled([page?.close(), chrome?.close(), server?.close()]);
  report.cleanup.surfaces = closed.map((value, index) => ({ surface: ['CDP page', 'temporary Chrome', 'temporary Vite'][index], status: value.status, ...(value.status === 'rejected' ? { error: String(value.reason) } : {}) }));
  if (report.status === 'passed' && closed.some(value => value.status === 'rejected')) { report.status = 'failed'; report.failure = 'Browser/server cleanup failed'; }
  await writeFile(`${output}/browser-result.json`, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
if (report.status !== 'passed') process.exitCode = 1;
else console.log(JSON.stringify({ status: report.status, checks: report.checks, report: `${output}/browser-result.json` }));

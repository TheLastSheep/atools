#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpClient } from './chrome-cdp-smoke-utils.mjs';
import { boundedOriginalCdp, createOriginalPageTarget, navigateOriginalPage } from './lib/original-plugin-browser-deadline.mjs';
import { originalBrowserControls } from './lib/original-plugin-browser-cdp.mjs';
import { launchOwnedChrome, isOwnedResourceClean } from './lib/launcher-menu-browser-runtime.mjs';
import { createZtoolsRendererBrowserNetworkGuard } from './lib/ztools-renderer-browser-network-guard.mjs';
import { captureUpdaterBrowserIdentity } from './lib/ztools-updater-browser-identity.mjs';
import { startUpdaterBrowserServer } from './lib/ztools-updater-browser-server.mjs';
import { updaterBrowserBootstrap, updaterFixtureState } from './lib/ztools-updater-browser-fixture.mjs';
import { runUpdaterBrowserScenarios } from './lib/ztools-updater-browser-scenarios.mjs';
import { readUpdaterFacts, recordUpdaterJsDiagnostic } from './lib/ztools-updater-browser-observation.mjs';
import { sha256 } from '../packages/ztools-build/pinned-inputs.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const argv = process.argv.slice(2), preflight = argv.includes('--preflight'), run = argv.includes('--run');
assert.equal(preflight !== run, true, 'Choose --preflight (no server/browser) or separately authorized --run');
const receiptFlag = argv.indexOf('--receipt');
assert.ok(receiptFlag >= 0 && argv[receiptFlag + 1] && !argv[receiptFlag + 1].startsWith('--'), 'Explicit formal receipt required');
const receiptPath = resolve(argv[receiptFlag + 1]);
assert.deepEqual(argv.filter((_, i) => ![receiptFlag, receiptFlag + 1].includes(i)).filter(a => !['--preflight', '--run'].includes(a)), []);
assert.equal(await realpath(root), '/Users/harris/Desktop/atools');
const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
assert.equal(git(['branch', '--show-current']), 'codex/atools-ztools-parity');
assert.equal(git(['rev-parse', 'HEAD']), 'c34789c0e3d19b3bf7c05d396540d891ff126abc');
assert.equal(process.version, 'v22.23.3');
assert.equal(await realpath(process.execPath), await realpath(join(root, 'src-tauri/binaries/node-aarch64-apple-darwin')));
const authoredFiles = [
  'scripts/test-ztools-updater-browser.mjs',
  'scripts/lib/original-plugin-browser-cdp.test.mjs',
  ...['identity', 'server', 'fixture', 'scenarios', 'observation', 'alignment'].map(n => `scripts/lib/ztools-updater-browser-${n}.mjs`),
  'scripts/chrome-cdp-smoke-utils.mjs', 'scripts/lib/launcher-menu-browser-runtime.mjs',
  'scripts/lib/original-plugin-browser-deadline.mjs', 'scripts/lib/original-plugin-browser-cdp.mjs',
  'scripts/lib/ztools-renderer-browser-network-guard.mjs',
];
const report = { runId: randomUUID(), status: 'preflight', checks: [], inputs: [], documents: [], screenshots: [],
  network: { requests: [], blocked: [] }, cleanup: { errors: [] }, console: [],
  limitations: ['FakeNative/CDP proves original UI consumption only; no real Tauri authority, signature/download/install/restart, OS drag/material, physical device or cross-browser acceptance.'] };
const identityArgs = { root, receiptPath, authoredFiles };
// Fail closed BEFORE any listener, Chrome process, profile, or browser context is created.
const before = await captureUpdaterBrowserIdentity(identityArgs);
if (preflight) { console.log(JSON.stringify({ passed: true, mode: 'preflight-only', identity: before }, null, 2)); }
else {
  const outputDir = join(root, 'output/playwright/ztools-updater-browser', report.runId);
  await mkdir(outputDir, { recursive: true });
  let chrome, server, page, control, injectionId;
  const pendingFetch = new Set(); let failure;
  async function cleanup(label, fn) { try { await fn(); } catch (error) { report.cleanup.errors.push(`${label}: ${error.message}`); } }
  try {
    server = await startUpdaterBrowserServer({ distRoot: join(root, 'dist-ztools-updater'), identity: before });
    chrome = await launchOwnedChrome();
    page = boundedOriginalCdp(await CdpClient.connect(await createOriginalPageTarget(chrome.webSocketUrl)), { totalMs: 120000 });
    control = originalBrowserControls(page, report);
    page.on('Runtime.exceptionThrown', event => recordUpdaterJsDiagnostic(report, 'exception', event));
    page.on('Runtime.consoleAPICalled', event => recordUpdaterJsDiagnostic(report, 'console-api', event));
    await page.send('Runtime.enable'); await page.send('Page.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 500, height: 450, deviceScaleFactor: 1, mobile: false });
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    const allowed = new Set();
    for (const n of ['oracle', 'img', 'frame', 'css', 'svg', 'script']) allowed.add('/tripwire/' + n);
    const guard = createZtoolsRendererBrowserNetworkGuard({ pageProvider: () => page, origin: server.origin,
      distRoot: join(root, 'dist-ztools-updater'), network: report.network, pendingFetch,
      cleanup: report.cleanup, errorText: e => e.message });
    guard.installFetchInterception(allowed);
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    async function documentFor(windowId, candidateId, body) {
      server.activateWindow(windowId);
      for (const path of [...allowed]) if (!path.startsWith('/tripwire/')) allowed.delete(path);
      for (const path of before.servedPaths) allowed.add(`/${windowId}/${path}`);
      if (injectionId) await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injectionId });
      const options = updaterFixtureState(windowId, candidateId, body);
      options.snapshot.candidate.version = windowId === '1'.repeat(32) ? '3.0.1' : '3.0.2';
      ({ identifier: injectionId } = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: updaterBrowserBootstrap(options) }));
      await navigateOriginalPage(page, `${server.origin}/${windowId}/updater.html`);
      await control.wait(() => control.evaluate(`document.querySelector('.title')?.textContent.includes(${JSON.stringify(options.snapshot.candidate.version)}) && window.__UPDATER_BROWSER_FIXTURE__?.snapshot().nativeListeners===2`), 'real original updater startup');
      const state = await control.evaluate('window.__UPDATER_BROWSER_FIXTURE__.snapshot()');
      assert.equal(state.calls.filter(c => c.args?.request?.op === 'ready').length, 1);
      assert.equal(state.calls.filter(c => c.args?.request?.op === 'appearance').length, 1);
      report.documents.push({ windowId, candidateId, version: options.snapshot.candidate.version });
      return state;
    }
    async function screenshot(name) {
      const { data } = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const bytes = Buffer.from(data, 'base64'); assert.equal(bytes.readUInt32BE(16), 500); assert.equal(bytes.readUInt32BE(20), 450);
      await writeFile(join(outputDir, name + '.png'), bytes, { flag: 'wx' });
      report.screenshots.push({ file: name + '.png', sha256: sha256(bytes), bytes: bytes.length, width: 500, height: 450 });
    }
    await runUpdaterBrowserScenarios({ page, control, documentFor, screenshot, report, server });
    assert.deepEqual(report.console, [], 'No unexpected owned-page JS exception/error/warning');
    assert.equal(report.consoleOverflow ?? 0, 0, 'JS diagnostics cannot silently exceed the bounded collection');
    assert.deepEqual(report.network.blocked, [], 'No external or unlisted page requests');
    assert.deepEqual(server.state.tripwires, ['/tripwire/oracle'], 'Positive control only; malicious notes issue zero requests');
    report.status = 'passed';
  } catch (error) {
    failure = error; report.status = 'failed'; report.error = error.stack;
    // Capture bounded live facts BEFORE terminalizing FakeNative or dispatching pagehide.
    if (control) try { report.failureObservation = await readUpdaterFacts(control, true); }
    catch (diagnosticError) { report.failureObservationError = diagnosticError.message; }
  }
  finally {
    if (page) {
      page.beginCleanup({ totalMs: 8000 });
      await cleanup('fixture terminal + pagehide', async () => {
        const result = await control.evaluate(`(()=>{window.__UPDATER_BROWSER_KEY_OBSERVER__?.stop();const f=window.__UPDATER_BROWSER_FIXTURE__;if(!f)return null;while(f.snapshot().pending)f.complete({...f.snapshot().state,phase:'error',operationId:null,error:{code:'internal',message:'fixture cleanup'}});window.dispatchEvent(new Event('pagehide'));return {...f.snapshot(),keyObserverActive:window.__UPDATER_BROWSER_KEY_OBSERVER__?.active??false}})()`);
        await new Promise(resolve => setTimeout(resolve, 0));
        report.cleanup.fixture = result;
        assert.equal(result.pending, 0); assert.equal(result.nativeListeners, 0); assert.equal(result.callbacks, 0);
        assert.equal(result.keyObserverActive, false);
        assert.deepEqual(result.ownedListeners, { dom: 0, media: 0, pagehide: 0 });
      });
      await cleanup('network drain', async () => { await Promise.all([...pendingFetch]); assert.equal(pendingFetch.size, 0); });
      await cleanup('CDP', async () => { report.cleanup.cdp = await page.close(); });
    }
    if (chrome) await cleanup('Chrome/profile', async () => {
      report.cleanup.chrome = await chrome.close();
      assert.ok(isOwnedResourceClean(chrome.lifecycle.processState) && isOwnedResourceClean(chrome.lifecycle.profileState));
    });
    if (server) await cleanup('loopback', async () => { await server.close(); report.cleanup.server = server.state; assert.equal(server.state.closed, true); });
    await cleanup('source/dependency/dist after binding', async () => {
      const after = await captureUpdaterBrowserIdentity(identityArgs); assert.deepEqual(after, before);
      report.sourceIdentity = { before, after, stable: true };
    });
    if (report.cleanup.errors.length) report.status = 'failed';
    await writeFile(join(outputDir, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  }
  console.log(JSON.stringify({ status: report.status, report: join(outputDir, 'report.json') }));
  if (failure || report.status !== 'passed') process.exitCode = 1;
}

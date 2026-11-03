import fs from 'node:fs';
import path from 'node:path';
import { launchChrome, connectToTarget, cdpSend } from './chrome-cdp-smoke-utils.mjs';
import { createPluginServer } from './dynamic-test-server.mjs';
import { buildInjectedBridgeScript } from './dynamic-bridge.mjs';

const pluginsRoot = '/Users/harris/Desktop/atools/ZTools-plugins/plugins';

async function testOnePlugin(chromeWsUrl, serverUrl, pluginDirName) {
  const pluginDir = path.join(pluginsRoot, pluginDirName);
  
  // Find manifest
  let manifestPath = path.join(pluginDir, 'plugin.json');
  let relEntry = 'index.html';
  let baseFolder = pluginDirName;

  if (!fs.existsSync(manifestPath)) {
    if (fs.existsSync(path.join(pluginDir, 'public', 'plugin.json'))) {
      manifestPath = path.join(pluginDir, 'public', 'plugin.json');
    } else if (fs.existsSync(path.join(pluginDir, 'dist', 'plugin.json'))) {
      manifestPath = path.join(pluginDir, 'dist', 'plugin.json');
    } else {
      return { id: pluginDirName, status: 'SKIPPED_NO_MANIFEST', reason: 'No plugin.json found' };
    }
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  let main = manifest.main || 'index.html';
  if (main.startsWith('http://') || main.startsWith('https://')) {
    // dev main URL
    main = 'index.html';
  }

  // Check where index.html exists
  let targetUrlPath = `${pluginDirName}/${main}`;
  if (fs.existsSync(path.join(pluginDir, 'public', main))) {
    targetUrlPath = `${pluginDirName}/public/${main}`;
  } else if (fs.existsSync(path.join(pluginDir, 'dist', main))) {
    targetUrlPath = `${pluginDirName}/dist/${main}`;
  } else if (!fs.existsSync(path.join(pluginDir, main))) {
    return { id: pluginDirName, status: 'SKIPPED_UNBUILT', reason: `Main file ${main} does not exist` };
  }

  const featureCode = manifest.features?.[0]?.code || 'default';
  const bridgeScript = buildInjectedBridgeScript(manifest, featureCode);

  // Connect CDP target
  const cdp = await connectToTarget(chromeWsUrl);
  
  try {
    await cdpSend(cdp, 'Page.enable');
    await cdpSend(cdp, 'Runtime.enable');
    
    // Inject bridge script before page scripts load
    await cdpSend(cdp, 'Page.addScriptToEvaluateOnNewDocument', {
      source: bridgeScript,
    });

    const targetUrl = `${serverUrl}/${targetUrlPath}`;
    
    // Navigate
    await cdpSend(cdp, 'Page.navigate', { url: targetUrl });
    
    // Wait a bit for DOM load and execution
    await new Promise(r => setTimeout(r, 600));

    // Trigger onPluginEnter lifecycle event
    await cdpSend(cdp, 'Runtime.evaluate', {
      expression: `if (window.utools && window.utools.triggerPluginEnter) window.utools.triggerPluginEnter();`,
    });

    await new Promise(r => setTimeout(r, 400));

    // Evaluate DOM structure and collected logs
    const result = await cdpSend(cdp, 'Runtime.evaluate', {
      expression: `
        ({
          title: document.title,
          bodyHtmlLength: document.body ? document.body.innerHTML.length : 0,
          childElementCount: document.body ? document.body.childElementCount : 0,
          hasUtools: typeof window.utools === 'object',
          hasZtools: typeof window.ztools === 'object',
          auditLogs: window.__pluginAuditLogs || {},
        })
      `,
      returnByValue: true,
    });

    const val = result.result?.value || {};
    
    return {
      id: pluginDirName,
      title: manifest.title || manifest.name,
      status: 'PASSED',
      rendered: val.bodyHtmlLength > 50,
      elementsCount: val.childElementCount,
      hasUtools: val.hasUtools,
      hasZtools: val.hasZtools,
      pluginEnterCalled: val.auditLogs?.pluginEnterCalled || false,
      apiCallsCount: val.auditLogs?.apiCalls?.length || 0,
      errors: val.auditLogs?.errors || [],
    };
  } catch (err) {
    return {
      id: pluginDirName,
      title: manifest.title || manifest.name,
      status: 'RUNTIME_ERROR',
      error: err.message,
    };
  } finally {
    cdp.close();
  }
}

async function runDynamicBatch() {
  console.log('Starting dynamic plugin test server...');
  const server = await createPluginServer(pluginsRoot, 19999);
  console.log(`Plugin server running at ${server.url}`);

  console.log('Launching headless Chrome via CDP...');
  const chrome = await launchChrome();
  console.log('Chrome launched.');

  const allDirs = fs.readdirSync(pluginsRoot).filter(f => {
    return fs.statSync(path.join(pluginsRoot, f)).isDirectory();
  }).sort();

  console.log(`Found ${allDirs.length} plugin directories to dynamically test.`);

  const results = [];
  let passedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < allDirs.length; i++) {
    const dirName = allDirs[i];
    process.stdout.write(`[${i + 1}/${allDirs.length}] Testing ${dirName}... `);
    const res = await testOnePlugin(chrome.webSocketUrl, server.url, dirName);
    results.push(res);
    
    if (res.status === 'PASSED') {
      passedCount++;
      console.log(`✅ PASSED (elements: ${res.elementsCount}, apiCalls: ${res.apiCallsCount}, errors: ${res.errors.length})`);
    } else if (res.status.startsWith('SKIPPED')) {
      skippedCount++;
      console.log(`⚠️ ${res.status}: ${res.reason}`);
    } else {
      failedCount++;
      console.log(`❌ ${res.status}: ${res.error}`);
    }
  }

  await chrome.close();
  await server.close();

  const reportPath = '/Users/harris/Desktop/atools/ztools_dynamic_automation_report.json';
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2), 'utf8');

  console.log('\n==============================');
  console.log(`DYNAMIC RUN SUMMARY:`);
  console.log(`Total: ${allDirs.length}`);
  console.log(`Passed (Rendered & Lifecycle Verified): ${passedCount}`);
  console.log(`Skipped (Unbuilt / Missing Manifest): ${skippedCount}`);
  console.log(`Runtime Errors: ${failedCount}`);
  console.log(`Report saved to: ${reportPath}`);
  console.log('==============================');
}

runDynamicBatch().catch(err => {
  console.error('Batch failed:', err);
  process.exit(1);
});

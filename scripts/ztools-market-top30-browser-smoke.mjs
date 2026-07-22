import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CdpClient,
  createPageWebSocketUrl,
  delay,
  formatConsoleArgs,
  launchChrome,
  launchViteServer,
} from "./chrome-cdp-smoke-utils.mjs";
import { createZToolsUiHostFixtureServer } from "./serve-ztools-ui-host-fixtures.mjs";

async function evaluate(page, expression) {
  const response = await page.send("Runtime.evaluate", { returnByValue: true, expression });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || "browser evaluation failed");
  return response.result.value;
}

async function waitFor(page, reader, expectedCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let state;
  do {
    state = await reader(page);
    if (state.readyCount === expectedCount && state.errorCount === 0 && state.allReady === true) return state;
    await delay(250);
  } while (Date.now() < deadline);
  return state;
}

function readFixtureMatrix(page) {
  return evaluate(page, `(() => {
    const body = document.body;
    const matrix = window.__atoolsRealEntryFixtureMatrix || null;
    return {
      marker: body?.getAttribute('data-atools-real-entry-fixture-matrix') || '',
      expectedCount: Number(body?.getAttribute('data-atools-real-entry-matrix-expected-count') || 0),
      readyCount: Number(body?.getAttribute('data-atools-real-entry-matrix-ready-count') || 0),
      errorCount: Number(body?.getAttribute('data-atools-real-entry-matrix-error-count') || 0),
      allReady: body?.getAttribute('data-atools-real-entry-matrix-all-ready') === 'true',
      iframeCount: document.querySelectorAll('iframe[data-fixture-key]').length,
      rowCount: document.querySelectorAll('[data-fixture-status]').length,
      results: matrix?.results || []
    };
  })()`);
}

function readPluginPanelMatrix(page) {
  return evaluate(page, `(() => {
    const body = document.body;
    const matrix = window.__atoolsRealEntryPluginPanelMatrix || null;
    return {
      marker: body?.getAttribute('data-atools-real-entry-plugin-panel-matrix') || '',
      expectedCount: Number(body?.getAttribute('data-atools-real-entry-plugin-panel-matrix-expected-count') || 0),
      readyCount: Number(body?.getAttribute('data-atools-real-entry-plugin-panel-matrix-ready-count') || 0),
      errorCount: Number(body?.getAttribute('data-atools-real-entry-plugin-panel-matrix-error-count') || 0),
      allReady: body?.getAttribute('data-atools-real-entry-plugin-panel-matrix-all-ready') === 'true',
      iframeCount: document.querySelectorAll('iframe[data-panel-key]').length,
      rowCount: document.querySelectorAll('[data-panel-status]').length,
      results: matrix?.results || []
    };
  })()`);
}

function assertMatrix(label, state, expectedCount, marker) {
  const failures = [];
  if (state.marker !== marker) failures.push(`marker=${state.marker}`);
  if (state.expectedCount !== expectedCount) failures.push(`expected=${state.expectedCount}`);
  if (state.readyCount !== expectedCount) failures.push(`ready=${state.readyCount}`);
  if (state.errorCount !== 0) failures.push(`errors=${state.errorCount}`);
  if (!state.allReady) failures.push("allReady=false");
  if (state.iframeCount !== expectedCount) failures.push(`iframes=${state.iframeCount}`);
  if (state.rowCount !== expectedCount) failures.push(`rows=${state.rowCount}`);
  if (state.results.length !== expectedCount) failures.push(`results=${state.results.length}`);
  return failures;
}

async function navigateMatrix(page, url, reader, expectedCount, marker, timeoutMs) {
  const consoleIssues = [];
  const onConsole = (params) => {
    if (["warning", "error", "assert"].includes(params.type)) {
      consoleIssues.push(`${params.type}: ${formatConsoleArgs(params.args)}`);
    }
  };
  const onException = (params) => consoleIssues.push(`exception: ${params.exceptionDetails?.text || "Runtime exception"}`);
  page.on("Runtime.consoleAPICalled", onConsole);
  page.on("Runtime.exceptionThrown", onException);
  await page.send("Page.navigate", { url });
  const state = await waitFor(page, reader, expectedCount, timeoutMs);
  const failures = assertMatrix(marker, state, expectedCount, marker);
  await delay(300);
  return { url, ...state, failures, console_issues: consoleIssues };
}

export async function runZToolsTop30BrowserSmoke(options = {}) {
  const reportPath = resolve(options.report || "output/ztools-market-top30-ui-host-smoke-report.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const fixtureMatrix = report.real_entry_fixture_matrix;
  const panelMatrix = report.real_entry_plugin_panel_matrix;
  const expectedCount = Number(report.summary?.ui_host_samples || 0);
  if (!expectedCount) throw new Error("UI host report has no samples");
  const fixtureRoot = dirname(fixtureMatrix.path);
  let fixtureServer;
  let appServer;
  let chrome;
  try {
    fixtureServer = await createZToolsUiHostFixtureServer({ root: fixtureRoot, host: "127.0.0.1", port: 4177 });
    appServer = await launchViteServer();
    chrome = await launchChrome();
    const page = await CdpClient.connect(await createPageWebSocketUrl(chrome.webSocketUrl));
    try {
      await page.send("Runtime.enable");
      await page.send("Page.enable");
      const fixture = await navigateMatrix(
        page,
        `${fixtureServer.url}${fixtureMatrix.relative_path}`,
        readFixtureMatrix,
        expectedCount,
        "true",
        45_000,
      );
      const pluginPanel = await navigateMatrix(
        page,
        `${fixtureServer.url}${panelMatrix.relative_path}`,
        readPluginPanelMatrix,
        expectedCount,
        "true",
        90_000,
      );
      return {
        generated_at: new Date().toISOString(),
        report_path: reportPath,
        expected_count: expectedCount,
        fixture_matrix: fixture,
        plugin_panel_matrix: pluginPanel,
        passed: fixture.readyCount === expectedCount
          && pluginPanel.readyCount === expectedCount
          && fixture.failures.length === 0
          && pluginPanel.failures.length === 0
          && fixture.console_issues.length === 0
          && pluginPanel.console_issues.length === 0,
      };
    } finally {
      await page.close();
    }
  } finally {
    await Promise.allSettled([chrome?.close?.(), appServer?.close?.(), fixtureServer?.close?.()].filter(Boolean));
  }
}

function parseArgs(args) {
  const options = { report: "output/ztools-market-top30-ui-host-smoke-report.json", output: "" };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--report") options.report = args[++index] || options.report;
    else if (args[index] === "--output") options.output = args[++index] || "";
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  const result = await runZToolsTop30BrowserSmoke(options);
  if (options.output) await writeFile(resolve(options.output), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`ZTools Top ${result.expected_count} browser smoke: ${result.passed ? "passed" : "failed"}`);
  if (!result.passed) process.exitCode = 1;
}

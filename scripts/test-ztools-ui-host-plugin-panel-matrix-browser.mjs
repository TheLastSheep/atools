import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assertCheckedChecklistRow,
  CdpClient,
  createPageWebSocketUrl,
  delay,
  formatConsoleArgs,
  launchChrome,
  launchViteServer,
} from "./chrome-cdp-smoke-utils.mjs";
import { createZToolsUiHostFixtureServer } from "./serve-ztools-ui-host-fixtures.mjs";

const fixtureRoot = new URL("../output/ztools-ui-host-real-entry-fixtures", import.meta.url).pathname;
const reportUrl = new URL("../output/ztools-plugin-ui-host-smoke-report.json", import.meta.url);
const checklistUrl = new URL("../docs/macos-smoke-checklist.md", import.meta.url);
const matrixHtmlUrl = new URL("../output/ztools-ui-host-real-entry-fixtures/plugin-panel-matrix.html", import.meta.url);

async function main() {
  const report = JSON.parse(await readFile(reportUrl, "utf8"));
  const matrix = report.real_entry_plugin_panel_matrix;
  assert.equal(matrix?.status, "ready");
  assert.equal(matrix?.panel_count, 10);
  assert.equal(matrix?.browser_url, "http://127.0.0.1:1434/plugin-panel-matrix.html");

  let fixtureServer;
  let appServer;
  let chrome;
  try {
    fixtureServer = await createZToolsUiHostFixtureServer({
      root: fixtureRoot,
      host: "127.0.0.1",
      port: 1434,
    });
    appServer = await launchViteServer();
    chrome = await launchChrome();
    const pageWebSocketUrl = await createPageWebSocketUrl(chrome.webSocketUrl);
    const page = await CdpClient.connect(pageWebSocketUrl);
    const consoleIssues = [];
    try {
      page.on("Runtime.consoleAPICalled", (params) => {
        if (["warning", "error", "assert"].includes(params.type)) {
          consoleIssues.push(`${params.type}: ${formatConsoleArgs(params.args)}`);
        }
      });
      page.on("Runtime.exceptionThrown", (params) => {
        consoleIssues.push(`exception: ${params.exceptionDetails?.text || "Runtime exception"}`);
      });

      await page.send("Runtime.enable");
      await page.send("Page.enable");
      await page.send("Page.navigate", { url: matrix.browser_url });

      const state = await waitForPluginPanelMatrix(page);
      assertPluginPanelMatrixState(state);
      await delay(500);
      assert.deepEqual(consoleIssues, [], "PluginPanel matrix Browser smoke should have 0 console warn/error");
    } finally {
      await page.close();
    }

    const matrixHtml = await readFile(matrixHtmlUrl, "utf8");
    assert.match(matrixHtml, /messages=/, "PluginPanel matrix rows should surface fixture error messages when present");

    const checklist = await readFile(checklistUrl, "utf8");
    assertCheckedChecklistRow(
      checklist,
      "Browser smoke 应打开 `real_entry_plugin_panel_matrix.browser_url`，即 `http://127.0.0.1:1434/plugin-panel-matrix.html`，验证 `data-atools-real-entry-plugin-panel-matrix=true`、expected-count 10、ready-count 10、error-count 0、all-ready true、10 个 PluginPanel iframe、每行 `ready passed=15/15 failed=`、console 0 warn/error；若有失败，matrix 行应渲染 `messages=` 透传真实 fixture error。",
    );
  } finally {
    await Promise.allSettled([
      chrome?.close?.(),
      appServer?.close?.(),
      fixtureServer?.close?.(),
    ].filter(Boolean));
  }
}

function assertPluginPanelMatrixState(state) {
  assert.equal(state.title, "ATools real entry PluginPanel matrix");
  assert.equal(state.marker, "true");
  assert.equal(state.expectedCountAttr, 10);
  assert.equal(state.readyCountAttr, 10);
  assert.equal(state.errorCountAttr, 0);
  assert.equal(state.allReadyAttr, true);
  assert.equal(state.iframeCount, 10);
  assert.equal(state.rowCount, 10);
  assert.equal(state.matrix?.expectedCount, 10);
  assert.equal(state.matrix?.readyCount, 10);
  assert.equal(state.matrix?.errorCount, 0);
  assert.equal(state.matrix?.allReady, true);
  assert.equal(state.matrix?.results?.length, 10);

  for (const row of state.rows) {
    assert.equal(row.text, "ready passed=15/15 failed=", `PluginPanel matrix row ${row.key} should pass all probes`);
  }

  for (const result of state.matrix.results) {
    assert.equal(result.ready, true, `${result.key} should be ready`);
    assert.equal(result.status, "ready", `${result.key} should report ready status`);
    assert.equal(result.passed, 15, `${result.key} should pass 15 probes`);
    assert.equal(result.total, 15, `${result.key} should run 15 probes`);
    assert.deepEqual(result.failedIds, [], `${result.key} should have no failed probes`);
    assert.deepEqual(result.errorMessages, [], `${result.key} should have no fixture error messages`);
  }
}

async function waitForPluginPanelMatrix(page) {
  const deadline = Date.now() + 45000;
  let state;
  do {
    state = await readPluginPanelMatrixState(page);
    if (
      state.readyCountAttr === 10
      && state.errorCountAttr === 0
      && state.allReadyAttr === true
      && state.matrix?.allReady === true
      && state.matrix?.results?.length === 10
    ) {
      return state;
    }
    await delay(250);
  } while (Date.now() < deadline);
  return state;
}

async function readPluginPanelMatrixState(page) {
  const response = await page.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const body = document.body;
      const rows = Array.from(document.querySelectorAll("[data-panel-status]")).map((cell) => ({
        key: cell.getAttribute("data-panel-status"),
        text: cell.textContent || "",
      }));
      const frames = Array.from(document.querySelectorAll("iframe[data-panel-key]")).map((frame) => ({
        key: frame.getAttribute("data-panel-key"),
        src: frame.getAttribute("src"),
      }));
      return {
        title: document.title,
        marker: body && body.getAttribute("data-atools-real-entry-plugin-panel-matrix"),
        expectedCountAttr: Number(body && body.getAttribute("data-atools-real-entry-plugin-panel-matrix-expected-count") || 0),
        readyCountAttr: Number(body && body.getAttribute("data-atools-real-entry-plugin-panel-matrix-ready-count") || 0),
        errorCountAttr: Number(body && body.getAttribute("data-atools-real-entry-plugin-panel-matrix-error-count") || 0),
        allReadyAttr: (body && body.getAttribute("data-atools-real-entry-plugin-panel-matrix-all-ready")) === "true",
        iframeCount: frames.length,
        rowCount: rows.length,
        rows,
        frames,
        matrix: window.__atoolsRealEntryPluginPanelMatrix || null,
      };
    })()`,
  });
  if (response.exceptionDetails) {
    assert.fail(response.exceptionDetails.text || "Failed to evaluate PluginPanel matrix state");
  }
  return response.result.value;
}

await main();

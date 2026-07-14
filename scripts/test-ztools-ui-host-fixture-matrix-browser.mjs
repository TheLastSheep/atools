import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assertCheckedChecklistRow,
  CdpClient,
  createPageWebSocketUrl,
  delay,
  formatConsoleArgs,
  launchChrome,
} from "./chrome-cdp-smoke-utils.mjs";
import { createZToolsUiHostFixtureServer } from "./serve-ztools-ui-host-fixtures.mjs";

const fixtureRoot = new URL("../output/ztools-ui-host-real-entry-fixtures", import.meta.url).pathname;

async function main() {
  const fixtureServer = await createZToolsUiHostFixtureServer({
    root: fixtureRoot,
    host: "127.0.0.1",
    port: 1434,
  });

  let chrome;
  try {
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
      await page.send("Page.navigate", { url: `${fixtureServer.url}index.html` });

      const state = await waitForFixtureMatrix(page);
      assertFixtureMatrixState(state);
      await delay(500);
      assert.deepEqual(consoleIssues, [], "fixture matrix Browser smoke should have 0 console warn/error");
    } finally {
      await page.close();
    }

    const checklist = await readFile(new URL("../docs/macos-smoke-checklist.md", import.meta.url), "utf8");
    assertCheckedChecklistRow(
      checklist,
      "Browser smoke 应用本地 fixture server 打开生成目录的 matrix `index.html`，验证 `data-atools-real-entry-fixture-matrix=true`、expected-count 10、ready-count 10、error-count 0、all-ready true、10 个 fixture iframe、10 行，每行 fixture 的 ready/bridge/ztools/identity 均为 true，且每行 `bridgeApi=9/9 bridgeApiFailed= errors=0`，console 0 warn/error。",
    );
  } finally {
    await Promise.allSettled([
      fixtureServer.close(),
      chrome?.close?.(),
    ]);
  }
}

function assertFixtureMatrixState(state) {
  assert.equal(state.title, "ATools real entry fixture matrix");
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
    assert.match(row.text, /^ready /, `fixture row ${row.key} should be ready`);
    assert.match(row.text, /ready=true/, `fixture row ${row.key} should mark ready=true`);
    assert.match(row.text, /bridge=true/, `fixture row ${row.key} should mark bridge=true`);
    assert.match(row.text, /ztools=true/, `fixture row ${row.key} should mark ztools=true`);
    assert.match(row.text, /identity=true/, `fixture row ${row.key} should mark identity=true`);
    assert.match(row.text, /bridgeApi=9\/9/, `fixture row ${row.key} should pass all bridge API probes`);
    assert.match(row.text, /bridgeApiFailed= errors=0$/, `fixture row ${row.key} should have no bridge/API errors`);
  }

  for (const result of state.matrix.results) {
    assert.equal(result.ready, true, `${result.key} should be ready`);
    assert.equal(result.bridgePresent, true, `${result.key} should expose bridge`);
    assert.equal(result.ztoolsAlias, true, `${result.key} should expose ztools alias`);
    assert.equal(result.identity, true, `${result.key} should expose matching plugin identity`);
    assert.equal(result.errors, 0, `${result.key} should have no fixture errors`);
    assert.equal(result.bridgeApiPassed, 9, `${result.key} should pass 9 bridge API probes`);
    assert.equal(result.bridgeApiTotal, 9, `${result.key} should run 9 bridge API probes`);
    assert.deepEqual(result.bridgeApiFailedIds, [], `${result.key} should have no failed bridge API probes`);
  }
}

async function waitForFixtureMatrix(page) {
  const deadline = Date.now() + 20000;
  let state;
  do {
    state = await readFixtureMatrixState(page);
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

async function readFixtureMatrixState(page) {
  const response = await page.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const body = document.body;
      const rows = Array.from(document.querySelectorAll("[data-fixture-status]")).map((cell) => ({
        key: cell.getAttribute("data-fixture-status"),
        text: cell.textContent || "",
      }));
      const frames = Array.from(document.querySelectorAll("iframe[data-fixture-key]")).map((frame) => ({
        key: frame.getAttribute("data-fixture-key"),
        src: frame.getAttribute("src"),
      }));
      return {
        title: document.title,
        marker: body && body.getAttribute("data-atools-real-entry-fixture-matrix"),
        expectedCountAttr: Number(body && body.getAttribute("data-atools-real-entry-matrix-expected-count") || 0),
        readyCountAttr: Number(body && body.getAttribute("data-atools-real-entry-matrix-ready-count") || 0),
        errorCountAttr: Number(body && body.getAttribute("data-atools-real-entry-matrix-error-count") || 0),
        allReadyAttr: (body && body.getAttribute("data-atools-real-entry-matrix-all-ready")) === "true",
        iframeCount: frames.length,
        rowCount: rows.length,
        rows,
        frames,
        matrix: window.__atoolsRealEntryFixtureMatrix || null,
      };
    })()`,
  });
  if (response.exceptionDetails) {
    assert.fail(response.exceptionDetails.text || "Failed to evaluate fixture matrix state");
  }
  return response.result.value;
}

await main();

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
const reportUrl = new URL("../output/ztools-plugin-ui-host-smoke-report.json", import.meta.url);
const checklistUrl = new URL("../docs/macos-smoke-checklist.md", import.meta.url);

async function main() {
  const report = JSON.parse(await readFile(reportUrl, "utf8"));
  const firstPlan = report.ui_host_smoke_plans?.[0];
  assert.ok(firstPlan, "smoke report should contain at least one UI host plan");
  assert.equal(firstPlan.plugin_id, "calculation-paper");

  const fixture = firstPlan.real_entry_fixture;
  assert.equal(fixture?.status, "ready");
  assert.equal(fixture?.relative_path, "001-calculation-paper-calc.html");

  let fixtureServer;
  let chrome;
  try {
    fixtureServer = await createZToolsUiHostFixtureServer({
      root: fixtureRoot,
      host: "127.0.0.1",
      port: 1434,
    });
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
      await page.send("Page.navigate", { url: new URL(fixture.relative_path, fixtureServer.url).toString() });

      const state = await waitForFirstFixture(page);
      assertFirstFixtureState(state);
      await delay(500);
      assert.deepEqual(consoleIssues, [], "first real-entry fixture Browser smoke should have 0 console warn/error");
    } finally {
      await page.close();
    }

    const checklist = await readFile(checklistUrl, "utf8");
    assertCheckedChecklistRow(
      checklist,
      "Browser smoke 可用本地 HTTP 服务打开第一个生成 fixture `001-calculation-paper-calc.html`，验证真实 DOM 可见 `计算公式` 输入框、`data-atools-real-entry-fixture=true`、`data-atools-real-entry-ready=true`、`data-atools-real-entry-bridge-present=true`、`data-atools-real-entry-ztools-alias=true`、plugin id `calculation-paper`、feature code `calc`、console 0 warn/error；直接 `file://` 可能被 Browser URL policy 阻止，应用本地 HTTP 服务验证。",
    );
  } finally {
    await Promise.allSettled([
      chrome?.close?.(),
      fixtureServer?.close?.(),
    ].filter(Boolean));
  }
}

function assertFirstFixtureState(state) {
  assert.equal(state.marker, "true");
  assert.equal(state.ready, "true");
  assert.equal(state.bridgePresent, "true");
  assert.equal(state.ztoolsAlias, "true");
  assert.equal(state.pluginId, "calculation-paper");
  assert.equal(state.featureCode, "calc");
  assert.equal(state.errors, "0");
  assert.equal(state.hasFormulaField, true, `expected a visible 计算公式 input, saw fields: ${JSON.stringify(state.fields)}`);
  assert.equal(state.fixture?.pluginId, "calculation-paper");
  assert.equal(state.fixture?.featureCode, "calc");
  assert.deepEqual(state.fixture?.errors, []);
  assert.equal(state.bridgeApiPassed, "9");
  assert.equal(state.bridgeApiTotal, "9");
  assert.equal(state.bridgeApiFailed, "0");
  assert.equal(state.bridgeApiFailedIds, "");
}

async function waitForFirstFixture(page) {
  const deadline = Date.now() + 20000;
  let state;
  do {
    state = await readFirstFixtureState(page);
    if (
      state.ready === "true"
      && state.bridgePresent === "true"
      && state.ztoolsAlias === "true"
      && state.hasFormulaField === true
      && state.bridgeApiPassed === "9"
      && state.bridgeApiTotal === "9"
      && state.bridgeApiFailed === "0"
    ) {
      return state;
    }
    await delay(250);
  } while (Date.now() < deadline);
  return state;
}

async function readFirstFixtureState(page) {
  const response = await page.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const body = document.body;
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden"
          && style.display !== "none"
          && rect.width > 0
          && rect.height > 0;
      };
      const fields = Array.from(document.querySelectorAll("input, textarea, [contenteditable='true']")).map((element) => {
        const id = element.getAttribute("id") || "";
        const labelledBy = (element.getAttribute("aria-labelledby") || "")
          .split(/\\s+/)
          .filter(Boolean)
          .map((labelId) => document.getElementById(labelId)?.textContent || "")
          .join(" ");
        const explicitLabel = id ? document.querySelector(\`label[for="\${CSS.escape(id)}"]\`)?.textContent || "" : "";
        const fieldShell = element.closest("label, .MuiFormControl-root, .MuiInputBase-root, .MuiBox-root");
        const surroundingText = fieldShell?.textContent || "";
        return {
          tag: element.tagName.toLowerCase(),
          id,
          placeholder: element.getAttribute("placeholder") || "",
          ariaLabel: element.getAttribute("aria-label") || "",
          labelledBy,
          explicitLabel,
          surroundingText: surroundingText.replace(/\\s+/g, " ").trim().slice(0, 120),
          visible: isVisible(element),
        };
      });
      const hasFormulaField = fields.some((field) => (
        field.visible
        && [
          field.placeholder,
          field.ariaLabel,
          field.labelledBy,
          field.explicitLabel,
          field.surroundingText,
        ].some((text) => text.includes("计算公式"))
      ));
      return {
        title: document.title,
        marker: body?.getAttribute("data-atools-real-entry-fixture") || "",
        ready: body?.getAttribute("data-atools-real-entry-ready") || "",
        bridgePresent: body?.getAttribute("data-atools-real-entry-bridge-present") || "",
        ztoolsAlias: body?.getAttribute("data-atools-real-entry-ztools-alias") || "",
        pluginId: body?.getAttribute("data-atools-real-entry-plugin-id") || "",
        featureCode: body?.getAttribute("data-atools-real-entry-feature-code") || "",
        errors: body?.getAttribute("data-atools-real-entry-errors") || "0",
        bridgeApiPassed: body?.getAttribute("data-atools-real-entry-bridge-api-passed") || "",
        bridgeApiTotal: body?.getAttribute("data-atools-real-entry-bridge-api-total") || "",
        bridgeApiFailed: body?.getAttribute("data-atools-real-entry-bridge-api-failed") || "",
        bridgeApiFailedIds: body?.getAttribute("data-atools-real-entry-bridge-api-failed-ids") || "",
        hasFormulaField,
        fields,
        fixture: window.__atoolsRealEntryFixture || null,
      };
    })()`,
  });
  if (response.exceptionDetails) {
    assert.fail(response.exceptionDetails.text || "Failed to evaluate first fixture state");
  }
  return response.result.value;
}

await main();

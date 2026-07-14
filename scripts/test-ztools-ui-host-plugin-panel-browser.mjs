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

async function main() {
  const report = JSON.parse(await readFile(reportUrl, "utf8"));
  const firstPlan = report.ui_host_smoke_plans?.[0];
  assert.ok(firstPlan, "smoke report should contain at least one UI host plan");

  const panel = firstPlan.real_entry_plugin_panel;
  assert.equal(firstPlan.title, "计算稿纸");
  assert.equal(firstPlan.plugin_id, "calculation-paper");
  assert.equal(panel?.status, "ready");
  assert.equal(panel?.fixture_url, "http://127.0.0.1:1434/001-calculation-paper-calc.html");
  assert.ok(panel?.url, "first real_entry_plugin_panel should include an app URL");

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
      await page.send("Page.navigate", { url: panel.url });

      const state = await waitForPluginPanel(page);
      assertPluginPanelState(state);
      await delay(500);
      assert.deepEqual(consoleIssues, [], "PluginPanel real fixture Browser smoke should have 0 console warn/error");
    } finally {
      await page.close();
    }

    const checklist = await readFile(checklistUrl, "utf8");
    assertCheckedChecklistRow(
      checklist,
      "Browser smoke 应用本地 fixture server 在 `127.0.0.1:1434` serve fixture 目录，并打开第一个 `real_entry_plugin_panel.url`；应验证页面标题 `ATools 3.0`、插件名 `计算稿纸`、主插件 iframe `src=http://127.0.0.1:1434/001-calculation-paper-calc.html`、`srcdoc` 为空、sandbox `allow-scripts allow-popups`、runtime `iframe`、bridge capability strip、`宿主探针 15/15`、console 0 warn/error、无 Vite error overlay、无横向溢出。",
    );
  } finally {
    await Promise.allSettled([
      chrome?.close?.(),
      appServer?.close?.(),
      fixtureServer?.close?.(),
    ].filter(Boolean));
  }
}

function assertPluginPanelState(state) {
  assert.equal(state.title, "ATools 3.0");
  assert.equal(state.pluginTitle, "计算稿纸");
  assert.equal(state.iframeSrc, "http://127.0.0.1:1434/001-calculation-paper-calc.html");
  assert.equal(state.iframeSrcdoc, "");
  assert.equal(state.iframeSandbox, "allow-scripts allow-popups");
  assert.equal(state.iframeClass.includes("plugin-iframe"), true);
  assert.equal(state.runtimeStrip.includes("运行状态"), true, state.runtimeStrip);
  assert.equal(state.runtimeStrip.includes("iframe"), true, state.runtimeStrip);
  assert.equal(state.runtimeStrip.includes("桥接能力"), true, state.runtimeStrip);
  assert.equal(state.runtimeStrip.includes("utools/ztools"), true, state.runtimeStrip);
  assert.equal(state.runtimeStrip.includes("宿主探针"), true, state.runtimeStrip);
  assert.equal(state.runtimeStrip.includes("15/15"), true, state.runtimeStrip);
  assert.equal(state.viteOverlayCount, 0);
  assert.equal(state.documentOverflows, false);
  assert.equal(state.bodyOverflows, false);
}

async function waitForPluginPanel(page) {
  const deadline = Date.now() + 30000;
  let state;
  do {
    state = await readPluginPanelState(page);
    if (
      state.title === "ATools 3.0"
      && state.pluginTitle === "计算稿纸"
      && state.iframeSrc === "http://127.0.0.1:1434/001-calculation-paper-calc.html"
      && state.runtimeStrip.includes("宿主探针")
      && state.runtimeStrip.includes("15/15")
      && state.viteOverlayCount === 0
    ) {
      return state;
    }
    await delay(250);
  } while (Date.now() < deadline);
  return state;
}

async function readPluginPanelState(page) {
  const response = await page.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const iframe = document.querySelector('iframe[title="Plugin"]');
      const runtimeStrip = document.querySelector(".plugin-runtime-strip");
      const root = document.documentElement;
      const body = document.body;
      const overlaySelectors = [
        "vite-error-overlay",
        ".vite-error-overlay",
        ".svelte-error-overlay",
        "[data-sveltekit-error]",
      ];
      return {
        title: document.title,
        pluginTitle: document.querySelector(".plugin-title")?.textContent?.trim() || "",
        iframeSrc: iframe?.src || "",
        iframeSrcdoc: iframe?.getAttribute("srcdoc") || "",
        iframeSandbox: iframe?.getAttribute("sandbox") || "",
        iframeClass: iframe?.className || "",
        runtimeStrip: runtimeStrip?.textContent?.replace(/\\s+/g, " ").trim() || "",
        viteOverlayCount: overlaySelectors.reduce((count, selector) => count + document.querySelectorAll(selector).length, 0),
        documentOverflows: root.scrollWidth > root.clientWidth + 1,
        bodyOverflows: body.scrollWidth > body.clientWidth + 1,
      };
    })()`,
  });
  if (response.exceptionDetails) {
    assert.fail(response.exceptionDetails.text || "Failed to evaluate PluginPanel state");
  }
  return response.result.value;
}

await main();

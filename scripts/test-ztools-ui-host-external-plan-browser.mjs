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

const reportUrl = new URL("../output/ztools-plugin-ui-host-smoke-report.json", import.meta.url);
const checklistUrl = new URL("../docs/macos-smoke-checklist.md", import.meta.url);

async function main() {
  const report = JSON.parse(await readFile(reportUrl, "utf8"));
  const firstPlan = report.ui_host_smoke_plans?.[0];
  assert.ok(firstPlan, "smoke report should contain at least one UI host plan");
  assert.equal(firstPlan.title, "计算稿纸");
  assert.equal(firstPlan.plugin_id, "calculation-paper");

  const webPreview = firstPlan.web_preview;
  assert.equal(webPreview?.mode, "externalPlan");
  assert.match(webPreview?.url || "", /pluginHostSmoke=externalPlan/);
  assertExternalPlanPayload(webPreview?.url || "");

  let appServer;
  let chrome;
  try {
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
      await page.send("Page.navigate", { url: webPreview.url });

      const state = await waitForExternalPlanPluginPanel(page);
      assertExternalPlanPluginPanelState(state);
      await delay(500);
      assert.deepEqual(consoleIssues, [], "externalPlan Browser smoke should have 0 console warn/error");
    } finally {
      await page.close();
    }

    const checklist = await readFile(checklistUrl, "utf8");
    assertCheckedChecklistRow(
      checklist,
      "externalPlan `srcdoc` 应回传 `__atools_ui_host_probe_result__`，PluginPanel runtime strip 应显示 `宿主探针 5/5`。",
    );
    assertCheckedChecklistRow(
      checklist,
      "Browser smoke 可用第一个 `externalPlan` URL 验证页面标题 `ATools 3.0`、插件名 `计算稿纸`、iframe mode、bridge capability strip、`宿主探针 5/5`、主插件 iframe sandbox `allow-scripts allow-popups`、console 0 warn/error、无 framework overlay、无横向溢出。",
    );
  } finally {
    await Promise.allSettled([
      chrome?.close?.(),
      appServer?.close?.(),
    ].filter(Boolean));
  }
}

function assertExternalPlanPayload(url) {
  const encoded = new URL(url).searchParams.get("pluginHostSmokeAction");
  assert.ok(encoded, "externalPlan URL should include pluginHostSmokeAction");
  const decoded = JSON.parse(decodeBase64UrlUtf8(encoded));
  assert.equal(decoded.plugin_id, "calculation-paper");
  assert.equal(decoded.plugin_name, "计算稿纸");
  assert.equal(decoded.feature_code, "calc");
  assert.equal(decoded.payload?.iframeSrc, undefined);
  assert.match(decoded.payload?.srcdoc || "", /__atools_ui_host_probe_result__/);
  assert.match(decoded.payload?.srcdoc || "", /probeResults/);
}

function decodeBase64UrlUtf8(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
  return Buffer.from(padded, "base64").toString("utf8");
}

function assertExternalPlanPluginPanelState(state) {
  assert.equal(state.title, "ATools 3.0");
  assert.equal(state.pluginTitle, "计算稿纸");
  assert.equal(state.iframeSrc, "");
  assert.notEqual(state.iframeSrcdocLength, 0);
  assert.equal(state.iframeSandbox, "allow-scripts allow-popups");
  assert.equal(state.iframeClass.includes("plugin-iframe"), true);
  assert.equal(state.runtimeStrip.includes("运行状态"), true, state.runtimeStrip);
  assert.equal(state.runtimeStrip.includes("iframe"), true, state.runtimeStrip);
  assert.equal(state.runtimeStrip.includes("桥接能力"), true, state.runtimeStrip);
  assert.equal(state.runtimeStrip.includes("utools/ztools"), true, state.runtimeStrip);
  assert.equal(state.runtimeStrip.includes("宿主探针"), true, state.runtimeStrip);
  assert.equal(state.hostProbe?.label, "宿主探针");
  assert.equal(state.hostProbe?.value, "5/5");
  assert.equal(state.hostProbe?.detail, "iframe 已回传 bridge/lifecycle 探针");
  assert.equal(state.viteOverlayCount, 0);
  assert.equal(state.documentOverflows, false);
  assert.equal(state.bodyOverflows, false);
}

async function waitForExternalPlanPluginPanel(page) {
  const deadline = Date.now() + 30000;
  let state;
  do {
    state = await readExternalPlanPluginPanelState(page);
    if (
      state.title === "ATools 3.0"
      && state.pluginTitle === "计算稿纸"
      && state.runtimeStrip.includes("宿主探针")
      && state.hostProbe?.value === "5/5"
      && state.viteOverlayCount === 0
    ) {
      return state;
    }
    await delay(250);
  } while (Date.now() < deadline);
  return state;
}

async function readExternalPlanPluginPanelState(page) {
  const response = await page.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const iframe = document.querySelector('iframe[title="Plugin"]');
      const runtimeStrip = document.querySelector(".plugin-runtime-strip");
      const runtimeChips = Array.from(document.querySelectorAll(".runtime-chip")).map((chip) => ({
        label: chip.querySelector("span")?.textContent?.trim() || "",
        value: chip.querySelector("strong")?.textContent?.trim() || "",
        detail: chip.querySelector("small")?.textContent?.replace(/\\s+/g, " ").trim() || "",
        text: chip.textContent?.replace(/\\s+/g, " ").trim() || "",
      }));
      const hostProbe = runtimeChips.find((chip) => chip.label === "宿主探针") || null;
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
        iframeSrc: iframe?.getAttribute("src") || "",
        iframeSrcdocLength: iframe?.getAttribute("srcdoc")?.length || 0,
        iframeSandbox: iframe?.getAttribute("sandbox") || "",
        iframeClass: iframe?.className || "",
        runtimeStrip: runtimeStrip?.textContent?.replace(/\\s+/g, " ").trim() || "",
        hostProbe,
        viteOverlayCount: overlaySelectors.reduce((count, selector) => count + document.querySelectorAll(selector).length, 0),
        documentOverflows: root.scrollWidth > root.clientWidth + 1,
        bodyOverflows: body.scrollWidth > body.clientWidth + 1,
      };
    })()`,
  });
  if (response.exceptionDetails) {
    assert.fail(response.exceptionDetails.text || "Failed to evaluate externalPlan PluginPanel state");
  }
  return response.result.value;
}

await main();

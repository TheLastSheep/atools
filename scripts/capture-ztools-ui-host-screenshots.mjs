import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CdpClient,
  createPageWebSocketUrl,
  delay,
  formatConsoleArgs,
  launchChrome,
  launchViteServer,
} from "./chrome-cdp-smoke-utils.mjs";

const reportUrl = new URL("../output/ztools-plugin-ui-host-smoke-report.json", import.meta.url);
const outputRoot = new URL("../output/ztools-ui-host-screenshot-captures/", import.meta.url);
const manifestUrl = new URL("manifest.json", outputRoot);

export async function captureZToolsUiHostScreenshots(options = {}) {
  const report = JSON.parse(await readFile(options.reportUrl || reportUrl, "utf8"));
  const plans = Array.isArray(report.ui_host_smoke_plans) ? report.ui_host_smoke_plans : [];
  const expectedCount = plans.reduce((sum, plan) => sum + (Array.isArray(plan.screenshot_viewports) ? plan.screenshot_viewports.length : 0), 0);
  assert.equal(expectedCount, 20, "UI host report should expose 20 screenshot viewport checks");

  const outputDir = fileURLToPath(options.outputRoot || outputRoot);
  await mkdir(outputDir, { recursive: true });

  let appServer;
  let chrome;
  const manifest = {
    status: "pending",
    expected_count: expectedCount,
    captured_count: 0,
    output_dir: outputDir,
    manifest_path: fileURLToPath(options.manifestUrl || manifestUrl),
    console_issues: [],
    captures: [],
  };

  try {
    appServer = await launchViteServer();
    chrome = await launchChrome();
    const pageWebSocketUrl = await createPageWebSocketUrl(chrome.webSocketUrl);
    const page = await CdpClient.connect(pageWebSocketUrl);
    let activeCapture = "";
    try {
      page.on("Runtime.consoleAPICalled", (params) => {
        if (["warning", "error", "assert"].includes(params.type)) {
          manifest.console_issues.push(`${activeCapture || "unknown"} ${params.type}: ${formatConsoleArgs(params.args)}`);
        }
      });
      page.on("Runtime.exceptionThrown", (params) => {
        manifest.console_issues.push(`${activeCapture || "unknown"} exception: ${params.exceptionDetails?.text || "Runtime exception"}`);
      });

      await page.send("Runtime.enable");
      await page.send("Page.enable");

      for (const plan of plans) {
        const viewports = Array.isArray(plan.screenshot_viewports) ? plan.screenshot_viewports : [];
        for (const viewport of viewports) {
          const capture = await capturePlanViewport(page, plan, viewport, outputDir, (key) => {
            activeCapture = key;
          });
          manifest.captures.push(capture);
        }
      }
    } finally {
      await page.close();
    }
    manifest.captured_count = manifest.captures.length;
    manifest.status = manifest.console_issues.length === 0 && manifest.captured_count === manifest.expected_count ? "ready" : "error";
    await writeManifest(manifest, options.manifestUrl || manifestUrl);
    return manifest;
  } finally {
    await Promise.allSettled([
      chrome?.close?.(),
      appServer?.close?.(),
    ].filter(Boolean));
  }
}

async function capturePlanViewport(page, plan, viewport, outputDir, setActiveCapture) {
  const pluginId = String(plan.plugin_id || "plugin");
  const pluginTitle = String(plan.title || plan.name || pluginId);
  const viewportName = String(viewport.name || "viewport");
  const width = Number(viewport.width);
  const height = Number(viewport.height);
  assert.ok(Number.isInteger(width) && width > 0, `${pluginId} ${viewportName} should include a positive viewport width`);
  assert.ok(Number.isInteger(height) && height > 0, `${pluginId} ${viewportName} should include a positive viewport height`);

  const key = `${String(plan.order || 0).padStart(3, "0")}-${sanitizeFilePart(pluginId)}-${sanitizeFilePart(viewportName)}`;
  setActiveCapture(key);
  await page.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 600,
  });
  await page.send("Page.navigate", { url: plan.web_preview.url });
  const state = await waitForScreenshotReady(page, pluginTitle);
  assertScreenshotReadyState(state, pluginTitle);
  await delay(250);

  const screenshot = await page.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width, height, scale: 1 },
  }, { timeoutMs: 20000 });
  assert.ok(typeof screenshot.data === "string" && screenshot.data.length > 0, `${key} should return screenshot data`);
  const png = Buffer.from(screenshot.data, "base64");
  const pngInfo = inspectPng(png);
  assert.equal(pngInfo.signature, true, `${key} should be a PNG`);
  assert.equal(pngInfo.width, width, `${key} PNG width should match viewport`);
  assert.equal(pngInfo.height, height, `${key} PNG height should match viewport`);
  assert.ok(png.length > 4096, `${key} PNG should contain non-trivial bytes`);

  const path = join(outputDir, `${key}.png`);
  await writeFile(path, png);
  return {
    status: "ready",
    key,
    plugin_id: pluginId,
    plugin_title: pluginTitle,
    feature_code: String(plan.desktop_action?.feature_code || ""),
    viewport: { name: viewportName, width, height },
    path,
    url: pathToFileURL(path).toString(),
    bytes: png.length,
    png_signature: pngInfo.signature,
    png_width: pngInfo.width,
    png_height: pngInfo.height,
    title: state.title,
    rendered_plugin_title: state.pluginTitle,
    host_probe_value: state.hostProbe?.value || "",
    vite_overlay_count: state.viteOverlayCount,
    document_overflows: state.documentOverflows,
    body_overflows: state.bodyOverflows,
  };
}

async function waitForScreenshotReady(page, pluginTitle) {
  const deadline = Date.now() + 30000;
  let state;
  do {
    state = await readScreenshotState(page);
    if (
      state.title === "ATools 3.0"
      && state.pluginTitle === pluginTitle
      && state.hostProbe?.value === "5/5"
      && state.viteOverlayCount === 0
      && state.documentOverflows === false
      && state.bodyOverflows === false
    ) {
      return state;
    }
    await delay(250);
  } while (Date.now() < deadline);
  return state;
}

async function readScreenshotState(page) {
  const response = await page.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const runtimeChips = Array.from(document.querySelectorAll(".runtime-chip")).map((chip) => ({
        label: chip.querySelector("span")?.textContent?.trim() || "",
        value: chip.querySelector("strong")?.textContent?.trim() || "",
        detail: chip.querySelector("small")?.textContent?.replace(/\\s+/g, " ").trim() || "",
      }));
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
        hostProbe: runtimeChips.find((chip) => chip.label === "宿主探针") || null,
        viteOverlayCount: overlaySelectors.reduce((count, selector) => count + document.querySelectorAll(selector).length, 0),
        documentOverflows: root ? root.scrollWidth > root.clientWidth + 1 : false,
        bodyOverflows: body ? body.scrollWidth > body.clientWidth + 1 : false,
      };
    })()`,
  });
  if (response.exceptionDetails) {
    assert.fail(
      response.exceptionDetails.exception?.description
        || response.exceptionDetails.text
        || "Failed to evaluate screenshot capture state",
    );
  }
  return response.result.value;
}

function assertScreenshotReadyState(state, pluginTitle) {
  assert.equal(state.title, "ATools 3.0");
  assert.equal(state.pluginTitle, pluginTitle);
  assert.equal(state.hostProbe?.value, "5/5");
  assert.equal(state.viteOverlayCount, 0);
  assert.equal(state.documentOverflows, false);
  assert.equal(state.bodyOverflows, false);
}

function inspectPng(buffer) {
  const signature = buffer.length >= 24
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a;
  return {
    signature,
    width: signature ? buffer.readUInt32BE(16) : 0,
    height: signature ? buffer.readUInt32BE(20) : 0,
  };
}

async function writeManifest(manifest, manifestTargetUrl) {
  const manifestPath = fileURLToPath(manifestTargetUrl);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function sanitizeFilePart(value) {
  return String(value || "item")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).toString()) {
  captureZToolsUiHostScreenshots().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

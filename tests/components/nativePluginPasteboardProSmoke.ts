import { mount } from "svelte";
import { invoke } from "@tauri-apps/api/core";
import PluginPanel from "../../src/components/PluginPanel.svelte";
import type { FeatureAction, PluginOutput } from "../../src/lib/types";

type Fixture = { token: string; action: FeatureAction };
const fixtureId = "batch59-pasteboard-pro-native-image";
const fixtureName = "PasteboardPro native image consumer fixture";
const featureCode = "pasteboard-pro-cached-thumbnail";
const successTitle = "B59 native image consumer fixture";
const failureTitle = "B59 native image consumer fixture failure";
let token = "";
let finished = false;
let timer: number | undefined;
let topCspMeta: string | null = null;
let topCspViolationCount = 0;
let pluginFramePresent = false;
let iframeSandboxAllowsSameOrigin = false;
let iframeContentDocumentIsNull = false;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFixtureToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isFixtureAction(value: unknown): value is FeatureAction {
  if (!record(value)) return false;
  return value.plugin_id === fixtureId
    && value.plugin_name === fixtureName
    && value.feature_code === featureCode
    && value.feature_label === "Generate cached thumbnails"
    && value.feature_label_source === "declared"
    && value.main_url === "index.html"
    && typeof value.plugin_path === "string"
    && value.plugin_path.startsWith("/")
    && value.expand_height === 600
    && Array.isArray(value.plugin_permissions)
    && value.plugin_permissions.length === 0
    && value.payload === null;
}

function observePluginFrameProof() {
  const frame = document.querySelector("iframe[title=\"Plugin\"]");
  if (frame instanceof HTMLIFrameElement) {
    pluginFramePresent = true;
    iframeSandboxAllowsSameOrigin = frame.sandbox.contains("allow-same-origin");
    try { iframeContentDocumentIsNull = frame.contentDocument === null; } catch { iframeContentDocumentIsNull = false; }
  }
}

function isSuccessSummary(value: Record<string, unknown>): boolean {
  const imageDimensions = value.imageDimensions;
  const thumbnailDimensions = value.thumbnailDimensions;
  const jpegDimensions = value.jpegDecodeDimensions;
  const byteLengths = value.jpegPayloadByteLengths;
  const violationCount = value.iframeCspViolationCount;
  return value.passed === true
    && value.successfulRecords === 64
    && value.generateCallsBeforeCapacityProbe === 64
    && value.generateCallsAfterCapacityProbe === 65
    && value.cacheHitNoReplay === true
    && value.sixtyFifthIsNull === true
    && value.frameOriginOpaque === true
    && value.nodePathBootstrapVerified === true
    && value.sourceImageBytes === 241870
    && record(imageDimensions) && imageDimensions.width === 512 && imageDimensions.height === 512
    && value.thumbnailDecodeSucceeded === true
    && record(thumbnailDimensions) && thumbnailDimensions.width === 480 && thumbnailDimensions.height === 480
    && typeof value.iframeCspMeta === "string" && value.iframeCspMeta === topCspMeta
    && pluginFramePresent && !iframeSandboxAllowsSameOrigin && iframeContentDocumentIsNull
    && typeof violationCount === "number" && Number.isSafeInteger(violationCount) && violationCount >= 0
    && Array.isArray(jpegDimensions) && jpegDimensions.length === 64
    && jpegDimensions.every(size => record(size) && size.width === 480 && size.height === 480)
    && Array.isArray(byteLengths) && byteLengths.length === 64
    && byteLengths.every(length => typeof length === "number" && Number.isSafeInteger(length) && length > 0 && length <= 512 * 1024)
    && Array.isArray(value.imageOperationDurationsMs) && value.imageOperationDurationsMs.length === 64
    && value.imageOperationDurationsMs.every(duration => typeof duration === "number" && Number.isFinite(duration) && duration >= 0);
}

async function send(report: Record<string, unknown>) {
  if (finished || !token) return;
  observePluginFrameProof();
  finished = true;
  if (timer !== undefined) window.clearTimeout(timer);
  try {
    await invoke("native_pasteboard_consumer_report", {
      token,
      report: {
        ...report,
        topCspMeta,
        topCspViolationCount,
        pluginFramePresent,
        iframeSandboxAllowsSameOrigin,
        iframeContentDocumentIsNull,
      },
    });
  } catch {
    // The native side has its own bounded timeout; never emit a second report.
  }
}

function onoutput(output: PluginOutput) {
  observePluginFrameProof();
  if (!record(output) || output.plugin_id !== fixtureId || output.feature_code !== featureCode
      || !Array.isArray(output.items) || output.items.length !== 1) {
    void send({ passed: false, stage: "plugin-output", errorCode: "unexpected-plugin-identity" });
    return;
  }
  const item = output.items[0];
  if (!item || (item.title !== successTitle && item.title !== failureTitle)) {
    void send({ passed: false, stage: "plugin-output", errorCode: "unexpected-plugin-output" });
    return;
  }
  const data = item.data;
  if (typeof data !== "string" || data.length > 8192) {
    void send({ passed: false, stage: "plugin-output", errorCode: "invalid-consumer-summary" });
    return;
  }
  try {
    const report: unknown = JSON.parse(data || "{}");
    if (!record(report) || (item.title === successTitle && !isSuccessSummary(report))
        || (item.title === failureTitle && report.passed !== false)) {
      void send({ passed: false, stage: "plugin-output", errorCode: "invalid-consumer-summary" });
      return;
    }
    void send(report);
  } catch {
    void send({ passed: false, stage: "plugin-output", errorCode: "invalid-consumer-summary" });
  }
}

if (window === window.top) {
  window.addEventListener("securitypolicyviolation", () => {
    topCspViolationCount = Math.min(topCspViolationCount + 1, Number.MAX_SAFE_INTEGER);
  });
  topCspMeta = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? null;
  void (async () => {
  try {
    const fixture: unknown = await invoke("native_pasteboard_consumer_fixture");
    if (!record(fixture) || !isFixtureToken(fixture.token)) {
      return;
    }
    token = fixture.token;
    if (!isFixtureAction(fixture.action)) {
      void send({ passed: false, stage: "fixture-command", errorCode: "invalid-fixture-action" });
      return;
    }
    timer = window.setTimeout(() => void send({ passed: false, stage: "panel-timeout", errorCode: "consumer-timeout" }), 110000);
    mount(PluginPanel, {
      target: document.getElementById("app")!,
      props: {
        action: fixture.action,
        onclose: () => void send({ passed: false, stage: "panel-closed", errorCode: "panel-closed-before-result" }),
        onoutput,
        onloaderror: () => void send({ passed: false, stage: "plugin-load", errorCode: "plugin-panel-load-failed" }),
      },
    });
  } catch {
    void send({ passed: false, stage: "fixture-command", errorCode: "fixture-command-failed" });
  }
  })();
}

import { mount, tick } from "svelte";
import { invoke } from "@tauri-apps/api/core";
import PluginPanel from "../../src/components/PluginPanel.svelte";
import type { FeatureAction } from "../../src/lib/types";
import { listenForImageToolboxReport, parseNativeImageToolboxGeometry } from "./nativeImageToolboxReportListener";
import { createNativeImageToolboxPageProbe } from "./nativeImageToolboxPageProbe";
import { listenForNativeImageToolboxChildCheckpoints } from "./nativeImageToolboxChildCheckpoints";

type Fixture = { token: string; inputPath: string; pluginId: string; featureCode: string };
const fixtureId = "batch65-image-toolbox-original";
const featureCode = "image-edit";
const EXPECTED_FIXTURE_CSP = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' asset: http://asset.localhost https://asset.localhost atools-plugin://localhost http://atools-plugin.localhost https://atools-plugin.localhost; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: asset: http://asset.localhost https://asset.localhost; connect-src ipc: http://ipc.localhost http://127.0.0.1:*; frame-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'";
let token = "";
let done = false;
let timer: number | undefined;
let harnessStage = "before-fixture-command";
let stageCheckpointFailures = 0;
let stageQueue = Promise.resolve();
let removeReportListener: (() => void) | undefined;
const recordedObservations = new Set<string>();
let observationBudgetExhausted = false;
let removeChildCheckpointListener: (() => void) | undefined;
let topCspViolations = 0;
const parentViewportInitial = { innerWidth: window.innerWidth, innerHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio };
let activationWindowHeight: number | null = null;
const topCsp = document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')?.content ?? null;
window.addEventListener("securitypolicyviolation", () => { topCspViolations = Math.min(topCspViolations + 1, 1_000_000); });
const pageProbe = createNativeImageToolboxPageProbe(document, window, (code, observed) => {
  void recordObservation(code, observed ?? null);
});

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pluginFrameEvidence() {
  const frame = document.querySelector('iframe[title="Plugin"]');
  if (!(frame instanceof HTMLIFrameElement)) return { pluginFramePresent: false, iframeSandboxAllowsSameOrigin: false, iframeContentDocumentIsNull: false };
  let contentDocumentIsNull = false;
  try { contentDocumentIsNull = frame.contentDocument === null; } catch { contentDocumentIsNull = false; }
  return { pluginFramePresent: true, iframeSandboxAllowsSameOrigin: frame.sandbox.contains("allow-same-origin"), iframeContentDocumentIsNull: contentDocumentIsNull };
}

function pluginFrameWindow(): MessageEventSource | null {
  return document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]')?.contentWindow ?? null;
}

async function setHarnessStage(stage: string) {
  harnessStage = stage;
  if (!token) return;
  await enqueueCheckpoint({ stage, observation: null, observed: null });
}

async function enqueueCheckpoint(value: { stage: string | null; observation: string | null; observed: boolean | null }) {
  stageQueue = stageQueue.then(async () => {
    let timeout: number | undefined;
    try {
      await Promise.race([
        invoke("native_image_toolbox_stage", { token, ...value }),
        new Promise<never>((_, reject) => {
          timeout = window.setTimeout(() => reject(new Error("stage-timeout")), 500);
        }),
      ]);
    } catch {
      stageCheckpointFailures = Math.min(stageCheckpointFailures + 1, 100);
      console.error("[native-image-toolbox-smoke] stage checkpoint failed", { code: "fixture-stage-checkpoint-failed" });
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout);
    }
  });
  await stageQueue;
}

async function recordObservation(code: string, observed: boolean | null = null) {
  if (!token || done) return;
  const identity = `${code}:${observed === null ? "null" : observed ? "true" : "false"}`;
  if (recordedObservations.has(identity)) return;
  if (recordedObservations.size >= 20) { observationBudgetExhausted = true; return; }
  recordedObservations.add(identity);
  await enqueueCheckpoint({ stage: null, observation: code, observed });
}

function installFixtureObservers() {
  pageProbe.install();
  removeChildCheckpointListener = listenForNativeImageToolboxChildCheckpoints(
    window,
    pluginFrameWindow,
    checkpoint => { void recordObservation(checkpoint.code, checkpoint.observed); },
    () => { observationBudgetExhausted = true; },
  );
}

function stopFixtureObservers() {
  pageProbe.dispose();
  removeChildCheckpointListener?.();
  removeChildCheckpointListener = undefined;
}

async function send(value: Record<string, unknown>) {
  if (done || !token) return;
  done = true;
  if (timer !== undefined) window.clearTimeout(timer);
  removeReportListener?.();
  removeReportListener = undefined;
  stopFixtureObservers();
  await stageQueue;
  const outcomeStage = harnessStage;
  void invoke("native_image_toolbox_report", {
    token,
    report: { ...value, harnessStage: outcomeStage, stageCheckpointFailures, observationBudgetExhausted, topCspMeta: topCsp, topCspViolationCount: topCspViolations,
      parentViewportInitial, parentViewportFinal: { innerWidth: window.innerWidth, innerHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
      activationWindowHeight, ...pluginFrameEvidence() },
  }).catch(async () => {
    await setHarnessStage("report-send-failed");
    const diagnostic = { code: "fixture-report-invoke-failed", stage: harnessStage };
    console.error("[native-image-toolbox-smoke] report command failed", diagnostic);
    window.dispatchEvent(new CustomEvent("atools-image-toolbox-report-invoke-failed", { detail: diagnostic }));
  });
}

function validAction(action: FeatureAction, fixture: Fixture): boolean {
  return action.plugin_id === fixture.pluginId
    && action.feature_code === fixture.featureCode
    && action.entry_type === "files"
    && action.main_url === "src/index.html"
    && action.expand_height === 541
    && typeof action.plugin_path === "string" && action.plugin_path.startsWith("/")
    && Array.isArray(action.payload) && action.payload.length === 1
    && record(action.payload[0]) && action.payload[0].path === fixture.inputPath;
}

if (window === window.top) {
  void (async () => {
    try {
      const fixture = await invoke<Fixture>("native_image_toolbox_fixture");
      token = fixture.token;
      await setHarnessStage("fixture-command-complete");
      if (!fixture || fixture.pluginId !== fixtureId || fixture.featureCode !== featureCode || !fixture.inputPath.startsWith("/")) {
        await send({ passed: false, stage: "fixture-command", errorCode: "invalid-fixture-identity" });
        return;
      }
      installFixtureObservers();
      timer = window.setTimeout(() => {
        void (async () => {
          const stalledAtStage = harnessStage;
          await setHarnessStage("panel-timeout");
          await send({ passed: false, stage: "panel-timeout", stalledAtStage, errorCode: "image-toolbox-timeout" });
        })();
      }, 45_000);
      await setHarnessStage("activation-start");
      if (done) return;
      let action: FeatureAction;
      try {
        action = await invoke<FeatureAction>("activate_file_content_feature", {
          code: fixture.featureCode, paths: [fixture.inputPath], expectedPluginId: fixture.pluginId,
        });
      } catch {
        if (!done) {
          await setHarnessStage("activation-rejected");
          await send({ passed: false, stage: "activation", errorCode: "image-toolbox-activation-failed" });
        }
        return;
      }
      if (done) return;
      activationWindowHeight = action.expand_height;
      await setHarnessStage("activation-resolved");
      if (done) return;
      if (!validAction(action, fixture)) {
        await send({ passed: false, stage: "activation", errorCode: "unexpected-file-activation-action" });
        return;
      }
      await setHarnessStage("waiting-for-plugin-observer");
      if (done) return;
      removeReportListener = listenForImageToolboxReport(
        window,
        pluginFrameWindow,
        value => {
          void (async () => {
            await setHarnessStage("plugin-observer-received");
            const summary = value;
            if (!record(summary)) {
              await send({ passed: false, stage: "plugin-observer", errorCode: "invalid-original-plugin-summary" });
              return;
            }
            const geometry = parseNativeImageToolboxGeometry(summary.geometry);
            const frame = pluginFrameEvidence();
            const passed = summary.passed === true && geometry.valid
              && summary.entryObserved === true && summary.entryCode === featureCode && summary.entryType === "files"
              && summary.imageLoaded === true && summary.originalImagePresent === true && summary.imageWidth === 200 && summary.imageHeight === 200
              && summary.editVerified === true && summary.canvasObjectCountAfterEdit === 2
              && summary.exportDecoded === true && summary.exportFormat === "png"
              && summary.originalWriteImageFileAvailable === true && summary.originalWriteImageFileCalled === true
              && summary.outputFileWriteSucceeded === true
              && summary.imageFullyVisible === true && summary.annotationFullyVisible === true
              && summary.imageBounds !== null && summary.annotationBounds !== null
              && typeof summary.exportWidth === "number" && summary.exportWidth > 0
              && typeof summary.exportHeight === "number" && summary.exportHeight > 0
              && summary.exportWidth === geometry.geometry.canvas.width && summary.exportHeight === geometry.geometry.canvas.height
              && topCsp === EXPECTED_FIXTURE_CSP
              && summary.iframeCspMeta === topCsp && summary.iframeCspViolationCount === 0
              && topCspViolations === 0 && frame.pluginFramePresent && !frame.iframeSandboxAllowsSameOrigin && frame.iframeContentDocumentIsNull;
            await send({ ...summary, geometry: geometry.geometry, geometryPassed: geometry.valid, passed, stage: passed ? "complete" : "original-operation-validation" });
          })();
        },
      );
      await setHarnessStage("plugin-panel-mounting");
      if (done) return;
      pageProbe.markPanelLoadErrorHandlerInstalled();
      mount(PluginPanel, {
        target: document.getElementById("app")!,
        props: {
          action,
          onclose: () => { void send({ passed: false, stage: "panel-closed", errorCode: "panel-closed-before-export" }); },
          onloaderror: () => {
            void (async () => {
              pageProbe.markPanelLoadError();
              await stageQueue;
              await send({ passed: false, stage: "plugin-load", errorCode: "original-plugin-load-failed" });
            })();
          },
        },
      });
      if (!done) await setHarnessStage("panel-mount-returned");
      if (done) return;
      await tick();
      if (done) return;
      pageProbe.snapshotAfterTick();
      await stageQueue;
      await setHarnessStage("panel-svelte-flush-checkpoint");
    } catch {
      if (!done) await send({ passed: false, stage: "activation-or-mount", errorCode: "image-toolbox-activation-failed" });
    }
  })();
}

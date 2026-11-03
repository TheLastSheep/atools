import type { DesktopSmokeFilesActivation } from "../../src/lib/desktopSmokeFilesActivationContract";
import { createPublishedFilesActivationForwarder } from "./nativePublishedPluginFilesActivationForwarder";
import { mount } from "svelte";
import { invoke } from "@tauri-apps/api/core";
import App from "../../src/App.svelte";
import "../../src/styles/global.css";
import { recordPublishedPhase, runNativePublishedPluginScenario } from "./nativePublishedPluginScenario";

const report = (value: unknown) => invoke("native_published_report", { report: value });
async function commitPublishedGeneralSettings(changes: Record<string, unknown>): Promise<void> {
  const raw = await invoke<string | null>("get_setting", { key: "settings-general" });
  const receipt = await invoke<{ version: number; raw: string }>("save_general_settings", {
    expected: { raw }, changes, applyNative: false,
  });
  if (!receipt || receipt.version !== 1 || typeof receipt.raw !== "string") {
    throw new Error("General settings save returned an invalid committed receipt");
  }
  let committed: unknown;
  try {
    committed = JSON.parse(receipt.raw);
  } catch {
    throw new Error("General settings save returned invalid committed JSON");
  }
  if (!committed || typeof committed !== "object" || Array.isArray(committed)) {
    throw new Error("General settings save returned a non-object snapshot");
  }
  const committedSettings = committed as Record<string, unknown>;
  for (const [key, value] of Object.entries(changes)) {
    if (JSON.stringify(committedSettings[key]) !== JSON.stringify(value)) {
      throw new Error(`General settings save did not commit field: ${key}`);
    }
  }
  localStorage.setItem("atools:settings-general", receipt.raw);
}

if (window === window.top) void (async () => {
  recordPublishedPhase("frontend-entry");
  try {
    const settings = { autoPaste: "never", localAppSearch: false, localLaunchSearch: false,
      aiProvider: "disabled", aiDefaultModel: "", aiApiKey: "", pluginEscapeToSearch: true };
    await commitPublishedGeneralSettings(settings);
    recordPublishedPhase("frontend-settings-ready");
    recordPublishedPhase("frontend-mount-start");
    let activateFilesFeature: DesktopSmokeFilesActivation | undefined;
    mount(App, { target: document.getElementById("app")!, props: {
      backgroundServices: false,
      onDesktopSmokeFilesActivationReady: (activate: DesktopSmokeFilesActivation) => { activateFilesFeature = activate; },
    } });
    recordPublishedPhase("frontend-mounted");
    recordPublishedPhase("frontend-scenario-start");
    const result = await runNativePublishedPluginScenario(createPublishedFilesActivationForwarder(() => activateFilesFeature));
    recordPublishedPhase("frontend-report-submit");
    await report(result);
  } catch (error) {
    recordPublishedPhase("frontend-mount-failed");
    await report({ passed: false, phase: "app-mount", error: String(error instanceof Error ? error.stack : error) });
  }
})();

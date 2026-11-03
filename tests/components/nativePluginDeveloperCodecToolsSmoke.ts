import { mount } from "svelte";
import { invoke } from "@tauri-apps/api/core";
import App from "../../src/App.svelte";
import "../../src/styles/global.css";
import { nativeDeveloperCodecToolsFailureObservation, runNativeOriginalDeveloperCodecToolsHeadScenario,
  type ScenarioStage } from "./nativeOriginalDeveloperCodecToolsHeadScenario";

const report = (value: unknown) => invoke("native_panel_report", { report: value });
if (window === window.top) void (async () => {
  let stage: ScenarioStage = "bootstrap";
  try {
    await invoke("native_panel_perf_phase", { phase: "panel-bundle-executed" });
    localStorage.setItem("atools:settings-general", JSON.stringify({ autoPaste: "never", localAppSearch: false,
      localLaunchSearch: false, pluginEscapeToSearch: true }));
    mount(App, { target: document.getElementById("app")!, props: { backgroundServices: false } });
    stage = "fixture";
    await invoke("native_panel_perf_phase", { phase: "production-app-mounted" });
    await report(await runNativeOriginalDeveloperCodecToolsHeadScenario(value => { stage = value; }));
  } catch (error) {
    await report(nativeDeveloperCodecToolsFailureObservation(error, stage));
  }
})();

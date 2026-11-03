import { mount } from "svelte";
import { invoke } from "@tauri-apps/api/core";
import App from "../../src/App.svelte";
import "../../src/styles/global.css";
import { nativeOriginalFileTreeFailureObservation, runNativeOriginalFileTreeHeadScenario } from "./nativeOriginalFileTreeHeadScenario";
const report = (value: unknown) => invoke("native_panel_report", { report: value });
if (window === window.top) void (async () => {
  let stage = "panel-bundle-phase";
  try {
    await invoke("native_panel_perf_phase", { phase: "panel-bundle-executed" });
    localStorage.setItem("atools:settings-general", JSON.stringify({ autoPaste: "never", localAppSearch: false, localLaunchSearch: false, pluginEscapeToSearch: true }));
    mount(App, { target: document.getElementById("app")!, props: { backgroundServices: false } });
    stage = "app-mounted-phase";
    await invoke("native_panel_perf_phase", { phase: "production-app-mounted" });
    stage = "file-tree-scenario";
    await report(await runNativeOriginalFileTreeHeadScenario());
  } catch (error) {
    const observation = nativeOriginalFileTreeFailureObservation(error);
    await report({ ...observation, bootstrapStage: stage });
  }
})();

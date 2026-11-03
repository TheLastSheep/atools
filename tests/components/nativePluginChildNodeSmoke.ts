import { mount } from "svelte";
import { invoke } from "@tauri-apps/api/core";
import App from "../../src/App.svelte";
import "../../src/styles/global.css";
import { runNativePluginChildNodeScenario } from "./nativePluginChildNodeScenario";

if (window === window.top) void (async () => {
  let report: unknown;
  try {
    if (import.meta.env.VITE_ATOOLS_CHILD_NODE_ACCEPTANCE !== "true") throw Error("ChildNodeFixtureDisabled");
    localStorage.setItem("atools:settings-general", JSON.stringify({ autoPaste: "never", localAppSearch: false,
      localLaunchSearch: false, pluginEscapeToSearch: true }));
    mount(App, { target: document.getElementById("app")!, props: { backgroundServices: false } });
    report = await runNativePluginChildNodeScenario();
  } catch (error) { report = { passed: false, error: error instanceof Error ? error.name : "FixtureError" }; }
  await invoke("native_panel_report", { report });
})();

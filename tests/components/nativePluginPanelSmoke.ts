import { mount } from "svelte";
import { invoke } from "@tauri-apps/api/core";
import App from "../../src/App.svelte";
import "../../src/styles/global.css";
import { runNativePluginPanelScenario } from "./nativePluginPanelScenario";

// These affect only this incognito fixture's local settings, never user data.
const report=(value:unknown)=>invoke("native_panel_report", { report:value });
if(window===window.top) void (async()=>{
  try {
    await invoke("native_panel_perf_phase",{phase:"panel-bundle-executed"});
    localStorage.setItem("atools:settings-general", JSON.stringify({ autoPaste: "never", localAppSearch: false, localLaunchSearch: false, pluginEscapeToSearch: true }));
    mount(App, { target: document.getElementById("app")!, props: { backgroundServices: false } });
    await invoke("native_panel_perf_phase",{phase:"production-app-mounted"});
    await report(await runNativePluginPanelScenario());
  } catch(error) { await report({passed:false,error:String(error instanceof Error?error.stack:error)}); }
})();

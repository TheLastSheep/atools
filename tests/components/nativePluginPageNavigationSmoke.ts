import { mount } from "svelte";
import { invoke } from "@tauri-apps/api/core";
import App from "../../src/App.svelte";
import "../../src/styles/global.css";
import { runNativePluginPageNavigationScenario } from "./nativePluginPageNavigationScenario";

if(window===window.top)void(async()=>{
  let report:unknown;
  try {
    localStorage.setItem("atools:settings-general",JSON.stringify({autoPaste:"never",localAppSearch:false,
      localLaunchSearch:false,pluginEscapeToSearch:false}));
    mount(App,{target:document.getElementById("app")!,props:{backgroundServices:false}});
    report=await runNativePluginPageNavigationScenario();
  } catch(error){report={passed:false,error:String(error instanceof Error?error.stack:error)};}
  await invoke("native_panel_report",{report});
})();

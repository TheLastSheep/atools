import { mount } from "svelte";
import { invoke } from "@tauri-apps/api/core";
import App from "../../src/App.svelte";
import "../../src/styles/global.css";
import { runNativePluginBrowserWindowScenario } from "./nativePluginBrowserWindowScenario";

if(window===window.top)void(async()=>{
  let report:unknown;
  try {
    localStorage.setItem("atools:settings-general",JSON.stringify({autoPaste:"never",localAppSearch:false,
      localLaunchSearch:false,pluginEscapeToSearch:true}));
    mount(App,{target:document.getElementById("app")!,props:{backgroundServices:false}});
    report=await runNativePluginBrowserWindowScenario();
  } catch(error){report={passed:false,error:String(error instanceof Error?error.name:"FixtureError")};}
  await invoke("native_panel_report",{report});
})();

import { mount } from "svelte";
import { invoke } from "@tauri-apps/api/core";
import App from "../../src/App.svelte";
import "../../src/styles/global.css";
import { runNativePluginMutationScenario } from "./nativePluginMutationScenario";

const report=(value:unknown)=>invoke("native_mutation_report",{report:value});
if(window===window.top)void(async()=>{
  try{
    localStorage.setItem("atools:settings-general",JSON.stringify({autoPaste:"never",localAppSearch:false,localLaunchSearch:false,pluginEscapeToSearch:true}));
    mount(App,{target:document.getElementById("app")!,props:{backgroundServices:false}});
    await report(await runNativePluginMutationScenario());
  }catch(error){await report({passed:false,error:String(error instanceof Error?error.stack:error)});}
})();

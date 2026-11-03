import { mount } from "svelte";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import PermissionPromptHost from "../../src/components/PermissionPromptHost.svelte";
import { runNativePermissionScenario } from "./nativePermissionScenario";

const target=document.getElementById("permission-root");
if (!target) throw new Error("Native permission fixture has no mount target");
mount(PermissionPromptHost,{target,props:{invoke,listen}});
void runNativePermissionScenario().then((report)=>fetch("atools-smoke://localhost/report",{
  method:"POST",body:JSON.stringify({stage:"permission-ui-result",...report}),
}));

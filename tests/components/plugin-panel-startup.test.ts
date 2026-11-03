import { cleanup, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";

const mocks=vi.hoisted(()=>({invoke:vi.fn(),listen:vi.fn(async()=>()=>{}),readText:vi.fn()}));
vi.mock("@tauri-apps/api/core",async original=>({...await original<typeof import("@tauri-apps/api/core")>(),invoke:mocks.invoke}));
vi.mock("@tauri-apps/api/event",()=>({listen:mocks.listen}));
vi.mock("@tauri-apps/plugin-clipboard-manager",()=>({readText:mocks.readText}));
afterEach(()=>{cleanup();Reflect.deleteProperty(window,"__TAURI_INTERNALS__");localStorage.clear();});

it("mounts the production launcher with real search enabled while optional background services are disabled",async()=>{
  Object.assign(window,{__TAURI_INTERNALS__:{metadata:{currentWindow:{label:"main"}}}});
  mocks.invoke.mockImplementation(async command=>{
    if(command==="get_setting")return JSON.stringify({localAppSearch:false,autoPaste:"never"});
    if(command==="feature_catalog" || command==="list_pending_agent_requests" || command==="search_local_apps")return [];
    if(command==="search_features")return [{code:"char-transform",plugin_id:"char-transform",plugin_name:"字符转换",label:"字符转换",explain:"转换",score:100,match_type:"exact",icon:null}];
    return undefined;
  });
  render(App,{backgroundServices:false});
  const input=screen.getByRole("combobox");
  await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith("feature_catalog"));
  input.dispatchEvent(new Event("focus"));
  Object.assign(input,{value:"字符转换"});input.dispatchEvent(new Event("input",{bubbles:true}));
  await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith("search_features",{query:"字符转换"}));
  expect(mocks.readText).not.toHaveBeenCalled();
  expect(mocks.invoke.mock.calls.some(([command])=>["check_app_update","release_smoke_info"].includes(command))).toBe(false);
});

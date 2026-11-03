import {afterEach,expect,it,vi} from "vitest";
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn(()=>Promise.reject(Error("No native IPC allowed in this DOM unit test")))}));
import {measureSearch} from "./nativePluginPanelScenario";

afterEach(()=>{document.body.innerHTML="";});
function fixture(owner="old-owner",count=600,rows=1) {
  document.body.innerHTML='<input aria-label="搜索命令"><div id="launcher-results"></div>';
  const list=document.querySelector("#launcher-results")!;
  for(let index=0;index<rows;index++) {
    const row=document.createElement("button");row.setAttribute("role","option");row.setAttribute("aria-selected",index===0?"true":"false");
    row.setAttribute("aria-setsize",String(count));row.dataset.pluginId=owner;list.append(row);
  }
  return {input:document.querySelector("input")!,rows:[...list.children] as HTMLElement[]};
}
it("observes a different owner even when the selected DOM node and aria-selected stay reused",async()=>{
  const {input,rows}=fixture();input.addEventListener("input",()=>{rows[0].dataset.pluginId="new-owner";},{once:true});
  const sample=await measureSearch("新插件名称","new-owner",600);
  expect(sample.pluginId).toBe("new-owner");expect(sample.resultCount).toBe(600);expect(sample.renderedRows).toBe(1);
});
it("waits for the complete logical result count after an owner update",async()=>{
  const {input,rows}=fixture();input.addEventListener("input",()=>{
    rows[0].dataset.pluginId="new-owner";rows[0].setAttribute("aria-setsize","100");
    setTimeout(()=>rows[0].setAttribute("aria-setsize","600"),0);
  },{once:true});
  expect((await measureSearch("新插件名称","new-owner",600)).resultCount).toBe(600);
});
it("rejects an already selected target rather than timing a stale result",async()=>{
  fixture("same-owner");await expect(measureSearch("重复目标","same-owner",600)).rejects.toThrow("stale");
});
it("rejects an unbounded rendered result list even when ARIA reports 600",async()=>{
  const {input,rows}=fixture("old-owner",600,33);
  input.addEventListener("input",()=>rows.forEach(row=>{row.dataset.pluginId="new-owner";}),{once:true});
  await expect(measureSearch("新插件名称","new-owner",600)).rejects.toThrow("at most 32");
});
it("requires exactly 601 logical results when 600 synthetic entries coexist with an original over match",async()=>{
  const {input,rows}=fixture();input.addEventListener("input",()=>{
    rows[0].dataset.pluginId="new-owner";
    setTimeout(()=>rows[0].setAttribute("aria-setsize","601"),0);
  },{once:true});
  const sample=await measureSearch("新插件名称","new-owner",601);
  expect(sample.resultCount).toBe(601);expect(sample.pluginId).toBe("new-owner");expect(sample.renderedRows).toBe(1);
});

import { afterEach, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import PermissionConfirmDialog from "../../src/components/PermissionConfirmDialog.svelte";
import type { PendingAgentToolRequest } from "../../src/lib/types";

let component:ReturnType<typeof mount> | undefined;
afterEach(async()=>{if(component)await unmount(component);component=undefined;document.body.innerHTML="";});

it.each(["read","write"] as const)("renders a plugin-specific %s dialog without private argument content",async access=>{
  document.body.innerHTML='<input id="search"><div id="fixture"></div>';document.getElementById("search")!.focus();
  const request:PendingAgentToolRequest={id:"clipboard",run_id:"run",client_id:"atools-ui",tool_name:`atools.host.clipboard.hash.${access}`,
    arguments:{operation:"open",text:"/DO_NOT_RENDER_PRIVATE_TEXT"},scopes:[`clipboard_${access}`],created_at:"2026-10-15T00:00:00Z"};
  const allow=vi.fn();
  component=mount(PermissionConfirmDialog,{target:document.getElementById("fixture")!,props:{request,displayName:"示例插件",
    requestContext:{pluginName:"示例插件",kind:"host_clipboard",clipboardAccess:access},onallowonce:allow,onallowremember:vi.fn(),ondeny:vi.fn()}});
  await tick();
  expect(document.querySelector("h2")?.textContent).toBe(`示例插件 请求${access==="read"?"读取":"写入"}剪贴板`);
  expect(document.body.textContent).toContain("重新执行操作");
  expect(document.body.textContent).not.toContain("DO_NOT_RENDER");
  expect(document.querySelector(".summary")?.textContent).not.toContain("可能执行");
  expect(document.querySelector(".risk-box")?.textContent).not.toMatch(/文件|网络|启动进程/);
  expect(document.activeElement?.textContent).toBe("拒绝");
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="允许一次")!.click();
  expect(allow).toHaveBeenCalledTimes(1);expect(allow).toHaveBeenCalledWith(request);
});

it("renders the image grant as clipboard-image access while retaining ClipboardRead scope",async()=>{
  document.body.innerHTML='<input id="search"><div id="fixture"></div>';document.getElementById("search")!.focus();
  const request:PendingAgentToolRequest={id:"clipboard-image",run_id:"image-run",client_id:"atools-ui",tool_name:"atools.host.clipboard.hash.image",
    arguments:{operation:"open",dataUrl:"PRIVATE_IMAGE"},scopes:["clipboard_read"],created_at:"2026-10-19T00:00:00Z"};
  const allow=vi.fn();
  component=mount(PermissionConfirmDialog,{target:document.getElementById("fixture")!,props:{request,displayName:"涂改插件",
    requestContext:{pluginName:"涂改插件",kind:"host_clipboard",clipboardAccess:"image"},onallowonce:allow,onallowremember:vi.fn(),ondeny:vi.fn()}});
  await tick();
  expect(document.querySelector("h2")?.textContent).toBe("涂改插件 请求读取剪贴板图片");
  expect(document.querySelector(".risk-box")?.textContent).toContain("剪贴板图片内容");
  expect(document.body.textContent).not.toContain("PRIVATE_IMAGE");
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="允许一次")!.click();
  expect(allow).toHaveBeenCalledWith(request);
});

it("renders image-write permission distinctly under ClipboardWrite scope",async()=>{
  document.body.innerHTML='<input id="search"><div id="fixture"></div>';document.getElementById("search")!.focus();
  const request:PendingAgentToolRequest={id:"clipboard-image-write",run_id:"image-write-run",client_id:"atools-ui",tool_name:"atools.host.clipboard.image.write",
    arguments:{operation:"write",image:{dataUrl:"PRIVATE_IMAGE"}},scopes:["clipboard_write"],created_at:"2026-10-19T00:00:00Z"};
  const allow=vi.fn();
  component=mount(PermissionConfirmDialog,{target:document.getElementById("fixture")!,props:{request,displayName:"图像工具",
    requestContext:{pluginName:"图像工具",kind:"host_clipboard",clipboardAccess:"image_write"},onallowonce:allow,onallowremember:vi.fn(),ondeny:vi.fn()}});
  await tick();
  expect(document.querySelector("h2")?.textContent).toBe("图像工具 请求写入剪贴板图片");
  expect(document.querySelector(".risk-box")?.textContent).toContain("图片替换当前剪贴板");
  expect(document.body.textContent).not.toContain("PRIVATE_IMAGE");
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="允许一次")!.click();
  expect(allow).toHaveBeenCalledWith(request);
});

import { describe, expect, it } from "vitest";
import { permissionRequestContext, clipboardPermissionPresentation, pluginDataPermissionPresentation, pluginPathsPermissionPresentation, pluginSecretStoragePermissionPresentation, pluginFileDropPermissionPresentation, pluginAiPermissionPresentation, pluginBrowserWindowPermissionPresentation } from "../../src/lib/permissionPresentation";
import type { PendingAgentToolRequest } from "../../src/lib/types";

const request:PendingAgentToolRequest={id:"request",run_id:"run",client_id:"atools-ui",tool_name:"atools.host.clipboard.hash.read",
  arguments:{operation:"open"},scopes:["clipboard_read"],created_at:"2026-10-15T00:00:00Z"};
const browserWindowName = `atools.host.browser-window.${"a".repeat(24)}`;
const browserWindowIntent = "b".repeat(64);

describe("stored permission presentation context",()=>{
  it("accepts only display fields and never carries clipboard text or endpoint metadata",()=>{
    expect(permissionRequestContext({pluginName:"  示例插件 ",kind:"host_clipboard",clipboardAccess:"read",text:"PRIVATE",endpoint:"PRIVATE"}))
      .toEqual({pluginName:"示例插件",kind:"host_clipboard",clipboardAccess:"read"});
    expect(permissionRequestContext({pluginName:33,kind:"unknown",clipboardAccess:"both"}))
      .toEqual({pluginName:null,kind:"tool",clipboardAccess:null});
  });
  it("accepts only the backend BrowserWindow context kind and drops private context fields",()=>{
    expect(permissionRequestContext({ kind:"plugin_browser_window", pluginName:"Snipaste", source:"plugin-browser-window", url:"PRIVATE_URL", title:"PRIVATE_TITLE", html:"PRIVATE_HTML", token:"PRIVATE_TOKEN" }))
      .toEqual({ pluginName:"Snipaste", kind:"plugin_browser_window", clipboardAccess:null });
    expect(permissionRequestContext({ kind:"plugin-browser-window", pluginName:"Snipaste" }).kind).toBe("tool");
  });
  it("does not infer clipboard privileges from a tool name or a partial/mismatched context",()=>{
    for(const context of [null,permissionRequestContext({kind:"tool",clipboardAccess:"read"}),permissionRequestContext({kind:"host_clipboard",clipboardAccess:"write"})]) {
      expect(clipboardPermissionPresentation(request,context)).toBeNull();
    }
    const context=permissionRequestContext({kind:"host_clipboard",clipboardAccess:"read"});
    expect(clipboardPermissionPresentation({...request,scopes:["clipboard_read","shell"]},context)).toBeNull();
  });
  it("presents the image access as a distinct read request under the exact ClipboardRead scope",()=>{
    const context=permissionRequestContext({pluginName:"涂改插件",kind:"host_clipboard",clipboardAccess:"image",dataUrl:"PRIVATE"});
    expect(context).toEqual({pluginName:"涂改插件",kind:"host_clipboard",clipboardAccess:"image"});
    const display=clipboardPermissionPresentation({...request,scopes:["clipboard_read"]},context)!;
    expect(display.title).toBe("涂改插件 请求读取剪贴板图片");
    expect(display.riskHints.join(" ")).toContain("剪贴板图片内容");
    expect(JSON.stringify(display)).not.toContain("PRIVATE");
    expect(clipboardPermissionPresentation({...request,scopes:["clipboard_image"]},context)).toBeNull();
  });
  it("presents image writing separately while requiring only the exact ClipboardWrite scope",()=>{
    const context=permissionRequestContext({pluginName:"图像工具",kind:"host_clipboard",clipboardAccess:"image_write",dataUrl:"PRIVATE"});
    expect(context).toEqual({pluginName:"图像工具",kind:"host_clipboard",clipboardAccess:"image_write"});
    const display=clipboardPermissionPresentation({...request,scopes:["clipboard_write"]},context)!;
    expect(display.title).toBe("图像工具 请求写入剪贴板图片");
    expect(display.riskHints.join(" ")).toContain("图片替换当前剪贴板");
    expect(display.retryHint).toContain("重新执行操作");
    expect(JSON.stringify(display)).not.toContain("PRIVATE");
    expect(clipboardPermissionPresentation({...request,scopes:["clipboard_read"]},context)).toBeNull();
    expect(clipboardPermissionPresentation({...request,scopes:["clipboard_write","shell"]},context)).toBeNull();
  });
  it.each(["read","write"] as const)("describes only the requested %s operation and explicitly requires user retry",access=>{
    const context=permissionRequestContext({pluginName:"示例插件",kind:"host_clipboard",clipboardAccess:access});
    const display=clipboardPermissionPresentation({...request,scopes:[`clipboard_${access}`]},context)!;
    expect(display.title).toBe(`示例插件 请求${access==="read"?"读取":"写入"}剪贴板`);
    expect(display.riskHints.join("")).not.toMatch(/文件|网络|启动进程/);
    expect(display.retryHint).toContain("重新执行操作");
  });
  it("keeps history deletion distinct from read/write and names the destructive effect",()=>{
    const read=permissionRequestContext({pluginName:"剪贴板插件",kind:"host_clipboard",clipboardAccess:"history_read"});
    const remove=permissionRequestContext({pluginName:"剪贴板插件",kind:"host_clipboard",clipboardAccess:"history_delete"});
    expect(clipboardPermissionPresentation({...request,scopes:["clipboard_read"]},read)?.title)
      .toBe("剪贴板插件 请求读取剪贴板历史");
    const display=clipboardPermissionPresentation({...request,scopes:["clipboard_delete"]},remove)!;
    expect(display.title).toBe("剪贴板插件 请求删除剪贴板历史");
    expect(display.riskHints.join(" ")).toContain("清空剪贴板历史");
    expect(clipboardPermissionPresentation({...request,scopes:["clipboard_write"]},remove)).toBeNull();
    expect(clipboardPermissionPresentation({...request,scopes:["clipboard_read"]},remove)).toBeNull();
  });
  it("uses stored data context and one exact scope to explain own-plugin persistence", () => {
    const dataRequest = { ...request, scopes: ["plugin_data"] };
    const context = permissionRequestContext({ kind: "plugin_data", pluginName: "颜色助手" });
    const display = pluginDataPermissionPresentation(dataRequest, context)!;
    expect(display.title).toBe("颜色助手 请求访问自己的数据");
    expect(display.riskHints.join("")).toContain("不会写入执行历史");
    expect(display.retryHint).toContain("继续打开");
    expect(pluginDataPermissionPresentation(dataRequest, null)).toBeNull();
    expect(pluginDataPermissionPresentation({ ...request, scopes: ["plugin_data", "shell"] }, context)).toBeNull();
    expect(pluginDataPermissionPresentation(request, context)).toBeNull();
    expect(pluginDataPermissionPresentation(dataRequest, permissionRequestContext({ kind: "tool" }))).toBeNull();
  });
  it("selects the secret-storage prompt only for its exact backend context and scope", () => {
    const context = permissionRequestContext({ kind: "plugin_secret_storage", pluginName: "账号助手", pluginId: "private", endpoint: "private" });
    expect(context).toEqual({ pluginName: "账号助手", kind: "plugin_secret_storage", clipboardAccess: null });
    const display = pluginSecretStoragePermissionPresentation({ ...request, scopes: ["secret_storage"] }, context)!;
    expect(display.title).toBe("账号助手 请求加密保存凭据");
    expect(display.riskHints.join(" ")).toContain("不会写入执行历史");
    expect(pluginSecretStoragePermissionPresentation({ ...request, scopes: ["shell"] }, context)).toBeNull();
    expect(pluginSecretStoragePermissionPresentation({ ...request, scopes: ["secret_storage", "shell"] }, context)).toBeNull();
    expect(pluginSecretStoragePermissionPresentation({ ...request, scopes: ["secret_storage"] }, permissionRequestContext({ kind: "tool" }))).toBeNull();
  });
  it("shows the one-shot file-drop permission only for exact native capability context and FileRead", () => {
    const context = permissionRequestContext({ kind: "plugin_file_drop", pluginName: "文件工具", requestId: "PRIVATE" });
    const drop = { ...request, tool_name: "atools.host.file-drop.0123456789abcdef01234567", scopes: ["file_read"], arguments: { requestId: "PRIVATE" } };
    const presentation = pluginFileDropPermissionPresentation(drop, context)!;
    expect(context).toEqual({ pluginName: "文件工具", kind: "plugin_file_drop", clipboardAccess: null });
    expect(presentation.title).toBe("文件工具 请求读取拖入的文件");
    expect(presentation.riskHints.join(" ")).toContain("最多 16 个、每个 4 MiB、合计 8 MiB");
    expect(presentation.retryHint).toContain("重新拖入");
    expect(JSON.stringify(presentation)).not.toContain("PRIVATE");
    expect(pluginFileDropPermissionPresentation({ ...drop, scopes: ["file_write"] }, context)).toBeNull();
    expect(pluginFileDropPermissionPresentation({ ...drop, tool_name: "atools.host.file-drop.not-a-hash" }, context)).toBeNull();
    expect(pluginFileDropPermissionPresentation(drop, permissionRequestContext({ kind: "plugin_dialog_open", pluginName: "文件工具" }))).toBeNull();
  });
  it("shows a plain AI prompt only for the backend-validated plugin AI tool and exact Network scope", () => {
    const context = permissionRequestContext({ kind: "plugin_ai", pluginName: "写作助手", pluginId: "PRIVATE" });
    const aiRequest = { ...request, tool_name: "atools.plugin.ai.0123456789abcdef01234567", scopes: ["network"],
      arguments: { operation: "execute", requestId: "PRIVATE" } };
    const display = pluginAiPermissionPresentation(aiRequest, context)!;
    expect(context).toEqual({ pluginName: "写作助手", kind: "plugin_ai", clipboardAccess: null });
    expect(display.title).toBe("写作助手 请求使用已配置的 AI");
    expect(display.riskHints.join(" ")).toContain("对话内容和图片会发送到你已配置的 AI 服务");
    expect(display.riskHints.join(" ")).toContain("执行历史不包含 API 密钥或提示词正文");
    expect(JSON.stringify(display)).not.toContain("PRIVATE");
    expect(pluginAiPermissionPresentation({ ...aiRequest, scopes: ["network", "shell"] }, context)).toBeNull();
    expect(pluginAiPermissionPresentation({ ...aiRequest, tool_name: "atools.plugin.ai.not-a-hash" }, context)).toBeNull();
    expect(pluginAiPermissionPresentation(aiRequest, permissionRequestContext({ kind: "tool", pluginName: "写作助手" }))).toBeNull();
  });
  it("shows own-plugin native-window permission only for its exact tool, scope and intent schema",()=>{
    const context=permissionRequestContext({kind:"plugin_browser_window",pluginName:"Snipaste",url:"PRIVATE_URL",title:"PRIVATE_TITLE",html:"PRIVATE_HTML",token:"PRIVATE_TOKEN"});
    const windowRequest={...request,tool_name:browserWindowName,scopes:["plugin_window"],arguments:{operation:"open",intentId:browserWindowIntent}};
    const display=pluginBrowserWindowPermissionPresentation(windowRequest,context)!;
    expect(display.title).toBe("Snipaste 申请创建/管理独立窗口");
    expect(display.scopeLabel).toBe("仅管理此插件自己的独立窗口");
    expect(display.riskHints.join(" ")).toContain("其他插件、系统或其他应用的窗口");
    expect(display.riskHints.join(" ")).toContain("文件、网络或其他系统权限");
    expect(JSON.stringify(display)).not.toMatch(/PRIVATE_URL|PRIVATE_TITLE|PRIVATE_HTML|PRIVATE_TOKEN|[a-f0-9]{64}/);
    expect(pluginBrowserWindowPermissionPresentation(windowRequest,permissionRequestContext({kind:"tool",pluginName:"Snipaste"}))).toBeNull();
    expect(pluginBrowserWindowPermissionPresentation({...windowRequest,scopes:["plugin_window","shell"]},context)).toBeNull();
    expect(pluginBrowserWindowPermissionPresentation({...windowRequest,scopes:["plugin_data"]},context)).toBeNull();
    expect(pluginBrowserWindowPermissionPresentation({...windowRequest,tool_name:"atools.host.browser-window.not-a-hash"},context)).toBeNull();
    expect(pluginBrowserWindowPermissionPresentation({...windowRequest,tool_name:`atools.host.browser-window.${"A".repeat(24)}`},context)).toBeNull();
    expect(pluginBrowserWindowPermissionPresentation({...windowRequest,arguments:{operation:"close",intentId:browserWindowIntent}},context)).toBeNull();
    expect(pluginBrowserWindowPermissionPresentation({...windowRequest,arguments:{operation:"open",intentId:browserWindowIntent,url:"PRIVATE_URL"}},context)).toBeNull();
    expect(pluginBrowserWindowPermissionPresentation({...windowRequest,arguments:{operation:"open",intentId:"not-a-token"}},context)).toBeNull();
  });
  it.each([["plugin_paths_standard", "file_read", "请求读取常用目录路径"], ["plugin_paths_data", "plugin_data", "请求创建自己的数据目录"]])("shows readable %s path metadata permission without inferring privileges from the tool name", (kind, scope, title) => {
    const context = permissionRequestContext({ kind, pluginName: "正则工具", paths: { home: "PRIVATE" } });
    const display = pluginPathsPermissionPresentation({ ...request, scopes: [scope] }, context)!;
    expect(display.title).toBe(`正则工具 ${title}`);
    expect(display.riskHints.join("")).toContain("真实路径不会写入执行历史");
    expect(display.retryHint).toContain("手动重新打开");
    expect(JSON.stringify(context)).not.toContain("PRIVATE");
    expect(pluginPathsPermissionPresentation({ ...request, scopes: [scope, "shell"] }, context)).toBeNull();
    expect(pluginPathsPermissionPresentation({ ...request, scopes: [scope] }, permissionRequestContext({ kind: "tool" }))).toBeNull();
  });
});

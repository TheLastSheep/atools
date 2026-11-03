import { describe, expect, it, vi } from "vitest";
import { createPluginNativeDialogBridge, pluginNativeDialogBridgeScript } from "../../src/lib/pluginNativeDialogBridge";
import { createPluginDialogsController, dispatchPluginDialogsPermission } from "../../src/lib/pluginDialogsController";
import { createPluginElectronAdapter } from "../../src/lib/pluginElectronAdapter";
import { pluginDialogSmokeGuardEnabled } from "../../src/lib/pluginDialogBridge";
import { pluginDialogPermissionPresentation, permissionRequestContext } from "../../src/lib/permissionPresentation";
import { reopenPluginHost } from "../../src/lib/pluginHostReopen";
import { PluginFrameSourceRegistry } from "../../src/lib/pluginInvokePolicy";
const instanceId = "06a042c7-f1dd-4f5d-bb2d-74ac91a17571";
const endpoint = "http://127.0.0.1:1234/dialog/" + "a".repeat(64);
const config = { instanceId, endpoints: { open: endpoint, save: endpoint } };
const reply = (paths: string[]) => ({ ok: true, result: { canceled: !paths.length, paths } });
function transport(paths: string[] = ["/private/fixture.txt"]) { return { sync: vi.fn(() => reply(paths)), async: vi.fn(async () => reply(paths)) }; }

describe("native picker synchronous contracts", () => {
  it("returns an actual array/string immediately for original ztools/utools code with one request per action", () => {
    const tx = transport(), bridge = createPluginNativeDialogBridge(config, vi.fn(), false, tx);
    const result = bridge.showOpenDialog({ properties: ["openFile"] });
    expect(result.length).toBe(1); expect(result[0]).toBe("/private/fixture.txt"); expect(result).not.toBeInstanceOf(Promise);
    expect(bridge.showSaveDialog({ defaultPath: "fixed.png" })).toBe("/private/fixture.txt");
    expect(tx.sync).toHaveBeenCalledTimes(2); expect(tx.async).not.toHaveBeenCalled();
  });
  it("preserves distinct ZTools and Electron cancellation shapes and genuine async aliases", async () => {
    const tx = transport([]), bridge = createPluginNativeDialogBridge(config, vi.fn(), false, tx);
    const electron = createPluginElectronAdapter({ application: { name: "ATools", version: "test" }, dialog: bridge.electron });
    expect(bridge.showOpenDialog()).toEqual([]); expect(bridge.showSaveDialog()).toBeUndefined();
    expect(electron.dialog.showOpenDialogSync()).toBeUndefined(); expect(electron.dialog.showSaveDialogSync()).toBe("");
    const opened = electron.dialog.showOpenDialog(); expect(opened).toBeInstanceOf(Promise);
    await expect(opened).resolves.toEqual({ canceled: true, filePaths: [] });
    await expect(electron.dialog.showSaveDialog()).resolves.toEqual({ canceled: true, filePath: "" });
    expect(tx.sync).toHaveBeenCalledTimes(4); expect(tx.async).toHaveBeenCalledTimes(2);
    expect(() => electron.dialog.showOpenDialogSync({}, {})).toThrow("BaseWindow");
  });
  it("throws synchronously for missing permission, requests only a grant, and never replays original options", () => {
    const request = vi.fn(), tx = transport(); const bridge = createPluginNativeDialogBridge({ instanceId }, request, false, tx);
    for (let count = 0; count < 2; count++) expect(() => bridge.showSaveDialog({ defaultPath: "/private/must-not-queue" })).toThrow("手动重新打开");
    expect(request.mock.calls).toEqual([["save"]]); expect(tx.sync).not.toHaveBeenCalled(); expect(tx.async).not.toHaveBeenCalled();
    bridge.close(); expect(() => bridge.showOpenDialog()).toThrow("已关闭"); expect(request).toHaveBeenCalledTimes(1);
  });
  it("does not retry a dialog action whose transport response was lost", async () => {
    const tx = { sync: vi.fn(() => { throw new Error("response lost"); }), async: vi.fn(async () => { throw new Error("response lost"); }) };
    const bridge = createPluginNativeDialogBridge(config, vi.fn(), false, tx);
    expect(() => bridge.showSaveDialog()).toThrow("response lost"); await expect(bridge.electron.showSaveDialog()).rejects.toThrow("response lost");
    expect(tx.sync).toHaveBeenCalledTimes(1); expect(tx.async).toHaveBeenCalledTimes(1);
  });
  it("bounds options/results and rejects invalid private endpoint or response identity", () => {
    const tx = transport(); const bridge = createPluginNativeDialogBridge(config, vi.fn(), false, tx);
    expect(() => bridge.showOpenDialog({ title: "x".repeat(33000) })).toThrow("预算"); expect(tx.sync).not.toHaveBeenCalled();
    expect(() => createPluginNativeDialogBridge({ instanceId, endpoints: { open: "https://example.invalid" } },vi.fn(),false,tx).showOpenDialog()).toThrow("连接无效");
    tx.sync.mockReturnValue(reply(Array(129).fill("/file"))); expect(() => bridge.showOpenDialog()).toThrow("无效结果");
    tx.sync.mockReturnValue({ ok: true, result: { canceled: true, paths: ["/file"] } }); expect(() => bridge.showOpenDialog()).toThrow("无效结果");
  });
  it("keeps ordinary smoke noninteractive and only enables a dedicated reviewed acceptance build", () => {
    expect(pluginDialogSmokeGuardEnabled({ VITE_ATOOLS_DESKTOP_SMOKE: "true" })).toBe(true);
    expect(pluginDialogSmokeGuardEnabled({ VITE_ATOOLS_DESKTOP_SMOKE: "true", VITE_ATOOLS_NATIVE_DIALOG_ACCEPTANCE: "true" })).toBe(false);
    const tx = transport(); const bridge = createPluginNativeDialogBridge(config, vi.fn(), true, tx);
    expect(() => bridge.showOpenDialog()).toThrow("桌面测试"); expect(tx.sync).not.toHaveBeenCalled();
  });
  it("serializes an isolated reader before original preload without dependencies or actual calls", () => {
    const host: any = { utools: {}, ztools: {}, parent: { postMessage: vi.fn() }, addEventListener: vi.fn() };
    const script = pluginNativeDialogBridgeScript({ instanceId },false).replace(/^<script[^>]*>\n/, "").replace(/\n<\/script>$/, "");
    expect(script).not.toContain("</script>"); new Function("window", script)(host);
    expect(host.utools.showOpenDialog).toBe(host.ztools.showOpenDialog); expect(host.parent.postMessage).not.toHaveBeenCalled();
    expect(() => host.utools.showOpenDialog()).toThrow("手动重新打开");
    expect(host.parent.postMessage.mock.calls[0][0]).toEqual({ __atools_plugin_dialog_open__: true, instanceId, access: "open" });
  });
});

describe("picker authorization and generation lifecycle", () => {
  it("prepares only source-detected direction and reads private endpoint only after the matching TaskRun succeeded", async () => {
    const statuses: unknown[] = [];
    const invoke: any = vi.fn(async (command,args) => {
      if (command === "prepare_plugin_dialogs") return args.access === "save" ? { unavailable: true, usage: "not_detected" } : args.requestPermission ? { permission_required: true,runId:"run",tool:"tool" } : { unavailable:true,usage:"detected" };
      if (command === "get_task_run") return { id:"run",capabilityId:"tool",initiator:{clientId:"atools-ui"},status:"succeeded",output:{sessionId:"session"} };
      if (command === "get_plugin_dialog_session") return { endpoint,access:"open" };
    });
    const controller = createPluginDialogsController(invoke,"fixture",()=>true,status=>statuses.push(status),undefined,async()=>{});
    expect((await controller.prepare()).endpoints).toEqual({ open:endpoint });
    expect(invoke.mock.calls.filter(([name]:any)=>name==="prepare_plugin_dialogs").map(([,args]:any)=>[args.access,args.requestPermission])).toEqual([["open",false],["open",true],["save",false]]);
    expect(statuses.at(-1)).toBeNull(); await controller.close(); expect(invoke.mock.calls.at(-1)[0]).toBe("close_plugin_dialogs");
  });
  it("does not create a server, authorize, poll or invoke native pickers for unknown/unused source", async () => {
    const invoke: any = vi.fn(async()=>({ unavailable:true,usage:"unknown" })); const wait = vi.fn();
    const controller = createPluginDialogsController(invoke,"fixture",()=>true,vi.fn(),undefined,wait);
    expect((await controller.prepare()).endpoints).toEqual({}); expect(invoke).toHaveBeenCalledTimes(2); expect(wait).not.toHaveBeenCalled();
    expect(invoke.mock.calls.every(([,args]:any)=>args.requestPermission===false)).toBe(true); await controller.close();
  });
  it("drains late preparation after close and does not mount a returned bearer", async () => {
    let resolve!: (value: unknown)=>void;
    const invoke: any = vi.fn(command=>command==="prepare_plugin_dialogs"?new Promise(done=>resolve=done):Promise.resolve());
    const controller = createPluginDialogsController(invoke,"fixture",()=>true,vi.fn()); const pending = controller.prepare();
    await controller.close(); resolve({sessionId:"late"}); await expect(pending).rejects.toThrow("cancelled");
    expect(controller.configuration().endpoints).toEqual({}); expect(invoke.mock.calls.filter(([name]:any)=>name==="close_plugin_dialogs")).toHaveLength(2);
  });
  it("transfers session IDs to a new generation without exposing endpoint bearers in handoff", async () => {
    const invoke: any = vi.fn(async(command)=>command==="rotate_plugin_dialogs"?{sessions:{open:"next-session"}}:undefined);
    const controller = createPluginDialogsController(invoke,"fixture",()=>true,vi.fn(),{...config,sessions:{open:"old-session"}});
    const next = await controller.reopen(); expect(next.sessions).toEqual({open:"next-session"}); expect(next.endpoints).toBeUndefined();
    expect(next.instanceId).not.toBe(instanceId); await controller.close(); expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("cleans all fulfilled successors if dialog transfer fails", async () => {
    const invoke = vi.fn(async()=>undefined);
    await expect(reopenPluginHost({ pluginId:"fixture",invoke,current:()=>true,
      clipboard:{reopen:async()=>({instanceId:"clipboard"})}, paths:{reopen:async()=>({instanceId:"paths"})},
      dialogs:{reopen:async()=>{throw new Error("closed");}},
    })).rejects.toThrow("cancelled");
    expect(invoke.mock.calls.map(([command])=>command)).toEqual(["close_host_clipboard","close_plugin_paths"]);
  });
  it("accepts fallback permission hints only from current registered frame and exact instance", () => {
    const sources = new PluginFrameSourceRegistry(); const frame: any = { postMessage: vi.fn() };
    sources.setMain(frame); const identity = sources.identify(frame)!;
    const request = vi.fn(async()=>true); const controller:any={instanceId,request};
    const message={__atools_plugin_dialog_open__:true,instanceId,access:"open"};
    dispatchPluginDialogsPermission({controller,message,source:{} as Window,identity,sources}); expect(request).not.toHaveBeenCalled();
    dispatchPluginDialogsPermission({controller,message,source:frame,identity,sources}); expect(request).toHaveBeenCalledWith("open");
  });
  it("uses readable verified picker wording and does not mistake an ordinary file tool for a picker", () => {
    const request:any={scopes:["file_read"]}; const context=permissionRequestContext({kind:"plugin_dialog_open",pluginName:"目录树"});
    expect(pluginDialogPermissionPresentation(request,context)?.title).toBe("目录树 请求打开文件选择窗口");
    expect(pluginDialogPermissionPresentation({scopes:["file_write"]} as any,context)).toBeNull();
    expect(pluginDialogPermissionPresentation(request,permissionRequestContext({kind:"tool",pluginName:"目录树"}))).toBeNull();
  });
});

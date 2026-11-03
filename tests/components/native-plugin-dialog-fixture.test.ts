import { cleanup, render } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SearchBar from "../../src/components/SearchBar.svelte";
import ResultRow from "../../src/components/ResultRow.svelte";
import { assertOriginalExportDidNotCatchError, nativeDialogFrameOrigin, runNativePluginDialogScenario } from "./nativePluginDialogScenario";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), approve: vi.fn(), before: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke,
}));
vi.mock("./nativePanelPermissionGate", () => ({ approveNativePanelPermission: mocks.approve }));
vi.mock("./nativePanelWindowEvidence", () => ({ createPanelWindowEvidence: () => ({ before: mocks.before }) }));

const capabilities = { data: "reviewed-data", dialogOpen: "reviewed-open", dialogSave: "reviewed-save", node: "reviewed-node" };
let grants = 0,pageDocumentMode=false;
const PAGE_ORIGIN="atools-page://"+"a".repeat(32)+".localhost";
const PAGE_URL=PAGE_ORIGIN+"/"+"b".repeat(32)+"/bootstrap.html";
beforeEach(() => {
  vi.clearAllMocks();
  grants = 0;
  pageDocumentMode=false;
  mocks.before.mockResolvedValue(undefined);
  mocks.invoke.mockImplementation(async command => {
    if (command === "native_panel_fixture") return { token: "offline-guard-only", windowMode: "observe",pageDocumentMode };
    if (command === "native_panel_dialog_fixture") return { privateHomeGuard: true, capabilities };
    if (command === "native_panel_dialog_checkpoint") return undefined;
    if (command === "native_panel_dialog_evidence") return { offlineGuard: true };
    if (command === "native_panel_runtime_state") return {
      sessions: 0, dataSessions: 1, dialogSessions: Math.max(0, grants - 1), nativeDialogs: 0,
      hostSessions: 0, activePathSnapshots: 0,pageDocuments:pageDocumentMode?1:0,
    };
    throw Error("Unexpected native call in offline fixture guard: " + command);
  });
  mocks.approve.mockImplementation(async () => { throw Error("Offline guard stopped before permission or original execution"); });
});
afterEach(() => { cleanup(); });

function launcher() {
  const onchange = vi.fn();
  const { container } = render(SearchBar, { query: "", onchange, resultsId: "launcher-results" });
  const input = container.querySelector<HTMLInputElement>("input")!;
  const entered = vi.fn();
  input.addEventListener("keydown", entered);
  render(ResultRow, { result: {
    code: "file-tree", plugin_id: "file-tree", plugin_name: "目录树生成器", label: "目录树",
    explain: "生成目录树", icon: null, score: 1, match_type: "exact",
  }, index: 0, selected: true, query: "目录树", onselect: () => {}, onselectionchange: () => {} });
  return { input, onchange, entered };
}

it("finds the actual current SearchBar and sends one input/Enter before the permission boundary", async () => {
  const { input, onchange, entered } = launcher();
  expect(input.getAttribute("aria-label")).toBe("搜索应用和指令");
  expect(document.querySelector('input[aria-label="搜索命令"]')).toBeNull();
  const report = await runNativePluginDialogScenario();
  expect(report.passed).toBe(false);
  expect(report.error).toBe("Offline guard stopped before permission or original execution");
  expect(onchange.mock.calls).toEqual([["目录树"]]);
  expect(entered).toHaveBeenCalledTimes(1);
  expect(entered.mock.calls[0][0]).toMatchObject({ key: "Enter", bubbles: true, cancelable: true });
  expect(mocks.before.mock.calls).toEqual([["dialog-launcher"]]);
  expect(mocks.approve).toHaveBeenCalledTimes(1);
  expect(mocks.invoke.mock.calls.map(call => call[0])).toEqual([
    "native_panel_fixture", "native_panel_dialog_fixture", "native_panel_dialog_checkpoint",
    "native_panel_dialog_evidence", "native_panel_dialog_checkpoint",
  ]);
});

it("retains exact data/open/save/Node capability order and scopes before executing any original frame", async () => {
  launcher();
  mocks.approve.mockImplementation(async () => {
    grants++;
    if (grants === 4) throw Error("Offline guard stopped at Node boundary");
  });
  const report = await runNativePluginDialogScenario();
  expect(report.error).toBe("Offline guard stopped at Node boundary");
  expect(mocks.approve.mock.calls.map(([options]) => ({ title: options.title, tool: options.tool, scopes: options.scopes }))).toEqual([
    { title: "目录树生成器 请求访问自己的数据", tool: capabilities.data, scopes: ["plugin_data"] },
    { title: "目录树生成器 请求打开文件选择窗口", tool: capabilities.dialogOpen, scopes: ["file_read"] },
    { title: "目录树生成器 请求选择文件保存位置", tool: capabilities.dialogSave, scopes: ["file_write"] },
    { title: "目录树生成器 请求访问本机", tool: capabilities.node,
      scopes: ["file_read", "file_write", "network", "shell", "clipboard_read", "clipboard_write", "screenshot", "browser_context", "plugin_data", "system_settings"] },
  ]);
  expect(document.querySelector("iframe")).toBeNull();
});

it.each([[false,false],[false,true],[true,false],[true,true]])("retains exact origin and privacy guards in document mode=%s privacy=%s", async (documentMode,selectionPrivacyVerified) => {
  pageDocumentMode=documentMode;
  launcher();
  mocks.approve.mockImplementation(async () => { grants++; });
  const privacy = { readOnlyEvidence: true, privateHomeGuard: true, privateMarkersAbsent: false, selectionPrivacyVerified,
    privacyScan: { complete: true, truncated: false, queryLimitReached: false, matches: [
      { runId: "run-synthetic", capability: "plugin.feature.file-tree", field: "/output/plugin_path", markers: { fixtureRoot: true }, expectedInstallationMetadata: selectionPrivacyVerified },
    ] } };
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async command => command === "native_panel_dialog_evidence" ? privacy : original(command));
  const frame = document.createElement("iframe");
  frame.title = "Plugin";
  if(documentMode)frame.src=PAGE_URL;
  else frame.srcdoc = "<!doctype html><title>Synthetic observation guard only</title>";
  frame.setAttribute("sandbox", documentMode?"allow-scripts allow-same-origin":"allow-scripts allow-popups");
  document.body.append(frame);
  const operations: string[] = [];
  vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((message,targetOrigin) => {
    expect(targetOrigin).toBe(documentMode?PAGE_ORIGIN:"*");
    operations.push(message.operation);
    if(documentMode)window.dispatchEvent(new MessageEvent("message",{source:frame.contentWindow,origin:"null",data:{
      kind:"atools-dialog-probe-result",token:message.token,id:message.id,error:"Off-origin same-WindowProxy result must be ignored",
      state:{title:"目录树生成器",tree:"请选择文件夹",sourceOrigin:"null",sourceOpaque:true,noTauri:false},
    }}));
    window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow,origin:documentMode?PAGE_ORIGIN:"null", data: {
      kind: "atools-dialog-probe-result", token: message.token, id: message.id,
      error: message.operation === "state" ? undefined : "Offline guard stopped before a real OS picker",
      state: { title: "目录树生成器", tree: "请选择文件夹", noTauri: true,sourceOrigin:documentMode?PAGE_ORIGIN:"null", sourceOpaque: !documentMode, localCanvasLibrary: true,
        consoleErrors:[],consoleErrorCount:0,consoleErrorObserverInstalled:true },
    } }));
  });
  const report = await runNativePluginDialogScenario();
  expect(report.passed).toBe(false);
  expect(report.error).toBe(selectionPrivacyVerified ? "Offline guard stopped before a real OS picker"
    : "Pre-picker selection privacy excludes only exact reviewed activation installation metadata");
  expect(report.observations.prePickerPrivacyEvidence).toEqual(privacy);
  expect(report.observations.frameDocument).toEqual({pageDocumentMode:documentMode,sandbox:frame.getAttribute("sandbox"),
    src:documentMode?PAGE_URL:"",srcdocEmpty:documentMode,sourceOrigin:documentMode?PAGE_ORIGIN:"null",sourceOpaque:!documentMode,
    noTauri:true,pageDocuments:documentMode?1:0});
  expect(report.observations.failureLastFrameState).toMatchObject({title:"目录树生成器",consoleErrors:[],consoleErrorCount:0,
    consoleErrorObserverInstalled:true});
  expect(operations).toEqual(selectionPrivacyVerified ? ["state","click"] : ["state"]);
  frame.remove();
});

it("requires actual document frame attributes and preserves the opaque default",()=>{
  const frame=document.createElement("iframe");
  frame.setAttribute("sandbox","allow-scripts allow-same-origin");frame.src=PAGE_URL;
  expect(nativeDialogFrameOrigin(frame,true)).toBe(PAGE_ORIGIN);
  expect(()=>nativeDialogFrameOrigin(frame,false)).toThrow("opaque production iframe");
  for(const src of [PAGE_URL+"?query=1",PAGE_URL+"#fragment",PAGE_URL.replace("/bootstrap.html","/payload.html"),
    PAGE_URL.replace(".localhost/",":1234.localhost/"),"atools-page://a.localhost/"+"b".repeat(32)+"/bootstrap.html"]) {
    frame.src=src;expect(()=>nativeDialogFrameOrigin(frame,true)).toThrow("exact native bootstrap URL");
  }
  frame.src=PAGE_URL;frame.srcdoc="<p>authority-bearing srcdoc is forbidden</p>";
  expect(()=>nativeDialogFrameOrigin(frame,true)).toThrow("empty srcdoc");
  frame.srcdoc="";frame.setAttribute("sandbox","allow-scripts allow-popups");
  expect(()=>nativeDialogFrameOrigin(frame,true)).toThrow("isolated origin");
});

it("reports only an actual stopped export with new caught console evidence",()=>{
  const consoleErrors=[["导出图片失败:","Error: exact observed synthetic failure"]];
  expect(()=>assertOriginalExportDidNotCatchError({exporting:false,consoleErrors,consoleErrorCount:2},1))
    .toThrow('Observed original export console.error after #confirmExport: [["导出图片失败:","Error: exact observed synthetic failure"]]');
  expect(()=>assertOriginalExportDidNotCatchError({exporting:true,consoleErrors,consoleErrorCount:2},1)).not.toThrow();
  expect(()=>assertOriginalExportDidNotCatchError({exporting:false,consoleErrors,consoleErrorCount:1},1)).not.toThrow();
});

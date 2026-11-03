import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import { reviewedWindowGeometryOriginals } from "./native-window-geometry-originals.mjs";

export const tipsWindowSource="ZTools-plugins/plugins/pomodoro-timer/page/index/js/tipsWindow.js";
export const tipsWindowSha256="c30d5d96251165fcb63b01104c3f50b17cffd6049f937fbe0c8219ba60fb3909";
export async function reviewedTipsWindow(root){
  const bytes=await readFile(join(root,tipsWindowSource));
  if(createHash("sha256").update(bytes).digest("hex")!==tipsWindowSha256)throw Error("Reviewed TipsWindow source changed; repeat source review before execution");
  return bytes.toString("utf8");
}
export const contextMenuSources = [
  {path:"page/index/js/contextMenuWindow.js",sha256:"d36423148cf4b12de21047c1f905aa7d82adc5764b7d94740d938a35f4e55e7f"},
  {path:"page/contextMenu/contextMenu.html",sha256:"0515461ee22ca2d980f54b7438593f102e183f72cf3510fadac04005301e6213"},
  {path:"base/js/preload.js",sha256:"f150197317bcdf8e3bd8bf526fe391abddffe43c51cd33d64a976b8c44054bea"},
  {path:"base/css/color.css",sha256:"83b63eddd49e3867df597297b3d064587c32bc7d5821341369f1ead42ed32d68"},
];
export async function reviewedContextMenu(root){
  const prefix="ZTools-plugins/plugins/pomodoro-timer/",files=[];
  for(const pin of contextMenuSources){
    const bytes=await readFile(join(root,prefix,pin.path));
    if(createHash("sha256").update(bytes).digest("hex")!==pin.sha256)throw Error("Reviewed ContextMenu source changed: "+pin.path);
    files.push({...pin,bytes,source:prefix+pin.path});
  }
  return files;
}
export async function browserWindowIsolationContract(root){
  const filename=join(root,"src/lib/desktopBrowserWindowIsolationProbe.ts");
  const compiled=transpileModule(await readFile(filename,"utf8"),{fileName:filename,
    compilerOptions:{module:ModuleKind.ESNext,target:ScriptTarget.ESNext}}).outputText;
  return import("data:text/javascript;base64,"+Buffer.from(compiled).toString("base64"));
}
export async function createBrowserWindowFixturePackages(root,environmentRoot){
  const original=await reviewedTipsWindow(root),menu=await reviewedContextMenu(root);
  const operations=await readFile(join(root,"tests/components/nativePluginHostedIpcOperations.js"),"utf8");
  const geometryOriginals=await reviewedWindowGeometryOriginals(root);
  const geometryOperations=await readFile(join(root,"tests/components/nativePluginWindowGeometryOperations.js"),"utf8");
  const probe=await browserWindowIsolationContract(root);
  const isolation=probe.desktopBrowserWindowIsolationProbeSource({mainUrl:"page/Tips/successTips.html",sampleIndex:0});
  const directory=join(environmentRoot,"browser-window-packages");await mkdir(directory,{mode:0o700});
  for(const id of ["char-transform","file-tree"]){
    const plugin=join(directory,id);await mkdir(plugin,{mode:0o700});
    const active=id==="file-tree";
    const manifest={name:id,title:active?"子窗口契约探针":"未使用占位探针",version:"0.0.0-synthetic",main:"index.html",
      description:"Generated acceptance package; exact reviewed TipsWindow, ContextMenu and geometry function calling patterns only",
      permissions:active?["browserWindow"]:[],syntheticFixture:{generated:true,originalPackage:false,reviewedOriginalPartsOnly:active},
      features:[{code:active?"browser-contract":"unused",explain:active?"合成子窗口契约":"未使用占位",
        cmds:[active?"synthetic browser contract":"synthetic unused browser"]}]};
    await writeFile(join(plugin,"plugin.json"),JSON.stringify(manifest,null,2),{flag:"wx",mode:0o600});
    const menuSetup=`window.ipcRenderer=window.require("electron").ipcRenderer;
window.__AToolsMenuFixtureState={toggles:[]};
const settings={config:{autoHideAni:false,darkMode:'light'}};
const tomatoPile={getState:()=>true};
const settingsPageComponent=[{name:'showTomatoAnimation',component:{toggle:value=>window.__AToolsMenuFixtureState.toggles.push(value)}}];`;
    const script=active?`${original}\nwindow.__AToolsReviewedTipsWindow=TipsWindow;\n${menuSetup}\n${menu[0].bytes.toString("utf8")}\nwindow.__AToolsReviewedContextMenuWindow=ContextMenuWindow;\n${operations}\n${geometryOriginals.script}\n${geometryOperations}\nwindow.__AToolsBrowserWindowIsolation=function(){return ${isolation};};`:"";
    if(active)for(const source of menu){
      const destination=join(plugin,source.path);await mkdir(join(destination,".."),{recursive:true,mode:0o700});
      await writeFile(destination,source.bytes,{flag:"wx",mode:0o600});
    }
    await writeFile(join(plugin,"index.html"),`<!doctype html><html><head><meta charset="utf-8"><title>子窗口契约探针</title></head><body><p>Private BrowserWindow contract fixture</p><script>${script.replace(/<\/script/gi,"<\\/script")}</script></body></html>`,{flag:"wx",mode:0o600});
    await mkdir(join(plugin,"page/Tips"),{recursive:true,mode:0o700});
    await writeFile(join(plugin,"page/Tips/successTips.html"),"<!doctype html><meta charset=\"utf-8\"><title>Private child window</title><p>Generated local child; no original page or preload</p>",{flag:"wx",mode:0o600});
  }
  return {directory,originalClass:{source:tipsWindowSource,sha256:tipsWindowSha256,scope:"Complete unchanged original class; generated Tips page and manifest; not full original plugin"},
    originalGeometry:{files:geometryOriginals.pins,scope:"Exact unchanged typing getWinInfo/hasWinInstance declarations and paintbrush move/resize callbacks only; generated parent and child; no full original preload or plugin"},
    originalContextMenu:{files:menu.map(({bytes,...source})=>source),scope:"Complete unchanged original ContextMenu class, HTML, pure Electron child preload and color CSS; synthetic parent state; not full original plugin",queryConfigurationVerified:false}};
}

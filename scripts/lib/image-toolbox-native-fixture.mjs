import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import { insertImageToolboxCspCapture } from "./image-toolbox-csp-checkpoint.mjs";

export const IMAGE_TOOLBOX_FIXTURE_ID = "batch65-image-toolbox-original";
export const IMAGE_TOOLBOX_CSP = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' asset: http://asset.localhost https://asset.localhost atools-plugin://localhost http://atools-plugin.localhost https://atools-plugin.localhost; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: asset: http://asset.localhost https://asset.localhost; connect-src ipc: http://ipc.localhost http://127.0.0.1:*; frame-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'";

const INPUT_BYTES = 5031;
const INPUT_SHA256 = "390aaa92636d3b3811341f418ca05497bc8751f6df760fa64c3aa5de6c5f3353";
const sha256 = value => createHash("sha256").update(value).digest("hex");

async function treeHash(directory) {
  const hash = createHash("sha256");
  async function visit(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      const type = await lstat(path);
      if (type.isSymbolicLink()) throw new Error("Image-Toolbox source contains a symlink");
      if (type.isDirectory()) await visit(path);
      else if (type.isFile()) { hash.update(relative(directory, path).split(sep).join("/")); hash.update("\0"); hash.update(await readFile(path)); hash.update("\0"); }
      else throw new Error("Image-Toolbox source contains an unsupported entry");
    }
  }
  await visit(directory);
  return hash.digest("hex");
}

async function copyTree(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(destination, entry.name), type = await lstat(from);
    if (type.isSymbolicLink()) throw new Error("Image-Toolbox source contains a symlink");
    if (type.isDirectory()) await copyTree(from, to);
    else if (type.isFile()) await copyFile(from, to);
    else throw new Error("Image-Toolbox source contains an unsupported entry");
  }
}

export function observerScript(outputPath) {
  return `<script>
(function(){
  const summary={scope:"original Image-Toolbox App through PluginPanel",entryObserved:false,imageLoaded:false,editVerified:false,exportDecoded:false,originalWriteImageFileAvailable:false,originalWriteImageFileCalled:false,outputFileWriteSucceeded:false};
  let started=false,sent=false,runCompleted=false,violations=0;
  let appPresenceFalseSent=false,appPresenceTrueSent=false;
  function boundedNumber(value,min,max){return typeof value==="number"&&Number.isFinite(value)&&value>=min&&value<=max?value:null;}
  function captureObjectBounds(object){
    try{
      const rect=object?.getBoundingRect?.(false,true);
      if(!rect)return null;
      return {left:boundedNumber(rect.left,-8192,8192),top:boundedNumber(rect.top,-8192,8192),
        width:boundedNumber(rect.width,1,8192),height:boundedNumber(rect.height,1,8192),
        right:boundedNumber(rect.left+rect.width,-8192,16384),bottom:boundedNumber(rect.top+rect.height,-8192,16384)};
    }catch{return null;}
  }
  function fullyVisible(bounds,canvas){
    if(!bounds||!canvas)return false;
    const values=[bounds.left,bounds.top,bounds.right,bounds.bottom,bounds.width,bounds.height,canvas.width,canvas.height];
    if(!values.every(value=>typeof value==="number"&&Number.isFinite(value))||bounds.width<=0||bounds.height<=0||canvas.width<=0||canvas.height<=0)return false;
    return bounds.left>=0&&bounds.top>=0&&bounds.right>bounds.left&&bounds.bottom>bounds.top
      &&bounds.right<=canvas.width&&bounds.bottom<=canvas.height;
  }
  function captureGeometry(app,canvas,annotation){
    let rect=null;try{rect=canvas.wrapperEl?.parentElement?.getBoundingClientRect?.()??null;}catch{}
    const geometry={canvas:{width:boundedNumber(canvas.getWidth?.(),1,8192),height:boundedNumber(canvas.getHeight?.(),1,8192),zoom:boundedNumber(app.canvasManager?.zoomLevel,0.01,100)},
      container:{left:boundedNumber(rect?.left,-1000000,1000000),top:boundedNumber(rect?.top,-1000000,1000000),right:boundedNumber(rect?.right,-1000000,1000000),bottom:boundedNumber(rect?.bottom,-1000000,1000000),width:boundedNumber(rect?.width,1,32768),height:boundedNumber(rect?.height,1,32768)},
      child:{innerWidth:boundedNumber(window.innerWidth,1,32768),innerHeight:boundedNumber(window.innerHeight,1,32768),devicePixelRatio:boundedNumber(window.devicePixelRatio,0.1,16)}};
    summary.geometry=geometry;
    summary.imageBounds=captureObjectBounds(app.canvasManager?.originalImage);
    summary.annotationBounds=captureObjectBounds(annotation);
    summary.imageFullyVisible=fullyVisible(summary.imageBounds,geometry.canvas);
    summary.annotationFullyVisible=fullyVisible(summary.annotationBounds,geometry.canvas);
    summary.geometryValid=Object.values(geometry).every(group=>Object.values(group).every(value=>value!==null))
      &&summary.imageFullyVisible===true&&summary.annotationFullyVisible===true;
  }
  function checkpoint(code,observed=true){try{window.parent.postMessage({kind:"atools-image-toolbox-child-checkpoint",code,observed},"*");}catch{}}
  checkpoint("child-observer-started");
  const markDOMContentLoaded=()=>checkpoint("child-domcontentloaded");
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",markDOMContentLoaded,{once:true});else markDOMContentLoaded();
  window.addEventListener("securitypolicyviolation",()=>{violations=Math.min(violations+1,1000000);});
  function finish(){if(sent)return;sent=true;summary.iframeCspMeta=document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content??null;summary.iframeCspViolationCount=violations;summary.passed=runCompleted&&summary.geometryValid===true&&summary.entryObserved&&summary.imageLoaded&&summary.originalImagePresent===true&&summary.imageWidth===200&&summary.imageHeight===200&&summary.canvasObjectCountBeforeEdit===1&&summary.editVerified&&summary.canvasObjectCountAfterEdit===2&&summary.exportDecoded&&summary.exportWidth>0&&summary.exportHeight>0&&summary.outputFileWriteSucceeded&&summary.iframeCspMeta===${JSON.stringify(IMAGE_TOOLBOX_CSP)}&&violations===0;try{window.parent.postMessage({kind:"atools-image-toolbox-smoke",summary},"*");}catch{}}
  window.addEventListener("atools-plugin-enter",event=>{
    if(started)return;
    const detail=event&&event.detail&&typeof event.detail==="object"?event.detail:{};
    if(detail.code!=="image-edit"||detail.type!=="files")return;
    started=true;summary.entryObserved=true;summary.entryCode=detail.code;summary.entryType=detail.type;
    checkpoint("child-enter-received");
    run().catch(()=>{summary.stage="original-app-operation";finish();});
  },true);
  async function waitForAppImage(){
    for(let attempt=0;attempt<500;attempt++){
      const app=window.__imageToolboxApp,canvas=app?.canvasManager?.canvas,image=app?.canvasManager?.originalImage;
      if(app&&!appPresenceTrueSent){appPresenceTrueSent=true;checkpoint("child-app-instance-present",true);}
      else if(!app&&!appPresenceFalseSent&&!appPresenceTrueSent){appPresenceFalseSent=true;checkpoint("child-app-instance-present",false);}
      if(app&&canvas&&image)return {app,canvas,image};
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    throw new Error("app-image-timeout");
  }
  async function run(){
    const {app,canvas,image}=await waitForAppImage();
    summary.imageLoaded=true;summary.imageWidth=Math.round(image.width);summary.imageHeight=Math.round(image.height);
    summary.canvasObjectCountBeforeEdit=canvas.getObjects().length;
    summary.originalImagePresent=canvas.getObjects().includes(image);
    const textModule=app.toolManager?.getModule("text");
    const exportModule=app.toolManager?.getModule("export");
    if(!textModule||!exportModule)throw new Error("original-editor-modules-unavailable");
    app.toolManager.activateTool("text");
    const annotation=textModule.addText("ATools local fixture",12,12);
    textModule.setTextColor("#123456");
    await new Promise(resolve=>setTimeout(resolve,80));
    if(annotation?.isEditing)annotation.exitEditing();
    summary.canvasObjectCountAfterEdit=canvas.getObjects().length;
    summary.editVerified=canvas.getObjects().includes(annotation)&&annotation.text==="ATools local fixture"&&annotation.fill==="#123456";
    // Capture the same canvas/container dimensions synchronously immediately before
    // the synchronous default export, after any host/layout resize from app startup.
    captureGeometry(app,canvas,annotation);
    const exported=exportModule.exportToDataURL("png");
    if(typeof exported!=="string"||!/^data:image\\/png;base64,/i.test(exported)||exported.length>2*1024*1024)throw new Error("original-export-did-not-return-bounded-png");
    const decoded=new Image();decoded.src=exported;await decoded.decode();
    summary.exportDecoded=true;summary.exportFormat="png";summary.exportWidth=decoded.naturalWidth;summary.exportHeight=decoded.naturalHeight;summary.exportDataUrlCharacters=exported.length;
    summary.originalWriteImageFileAvailable=typeof window.writeImageFile==="function";
    if(!summary.originalWriteImageFileAvailable)throw new Error("original-write-image-file-unavailable");
    summary.originalWriteImageFileCalled=true;
    summary.outputFileWriteSucceeded=window.writeImageFile(${JSON.stringify(outputPath)},exported)===true;
    if(!summary.outputFileWriteSucceeded)throw new Error("original-write-image-file-failed");
    summary.programmaticEditorOperation=true;summary.physicalInputUsed=false;summary.nativeDialogUsed=false;summary.clipboardUsed=false;
    runCompleted=summary.geometryValid===true&&summary.exportWidth===canvas.getWidth()&&summary.exportHeight===canvas.getHeight();
    finish();
  }
})();
</script>`;
}

export async function prepareImageToolboxNativeFixture({ repositoryRoot, scratch, fixtureRoot }) {
  const sourcePlugin = join(repositoryRoot, "ZTools-plugins/plugins/Image-Toolbox");
  const sourceImage = join(repositoryRoot, "ZTools-plugins/plugins/calculation-paper/logo.png");
  const pluginSourceHash = await treeHash(sourcePlugin);
  const sourceBytes = await readFile(sourceImage);
  if (sourceBytes.length !== INPUT_BYTES || sha256(sourceBytes) !== INPUT_SHA256) throw new Error("Pinned Image-Toolbox input PNG mismatch");
  const pluginRoot = join(scratch, "plugin-sources", IMAGE_TOOLBOX_FIXTURE_ID);
  await copyTree(sourcePlugin, pluginRoot);
  if (await treeHash(pluginRoot) !== pluginSourceHash) throw new Error("Private Image-Toolbox copy changed during staging");
  const htmlPath = join(pluginRoot, "src/index.html");
  const originalEntryHtml = await readFile(join(sourcePlugin, "src/index.html"));
  const entryPath = join(scratch, "image-toolbox-original-entry.html");
  await writeFile(entryPath, originalEntryHtml, { flag: "wx" });
  const fixtureRootPath = join(scratch, "native-fixture");
  if (fixtureRoot && resolve(fixtureRoot) !== resolve(fixtureRootPath)) throw new Error("Image-Toolbox fixture root mismatch");
  const outputPath = join(fixtureRootPath, "image-toolbox-export.png");
  let html = originalEntryHtml.toString("utf8");
  if (!/<head\b[^>]*>/i.test(html) || !html.includes("</body>") || /http-equiv=["']Content-Security-Policy/i.test(html)) throw new Error("Unexpected Image-Toolbox entry HTML");
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${IMAGE_TOOLBOX_CSP}">`;
  html = html.replace(/<head\b[^>]*>/i, head => `${head}\n  ${cspMeta}`);
  html = insertImageToolboxCspCapture(html, IMAGE_TOOLBOX_CSP);
  html = html.replace("</body>", `${observerScript(outputPath)}\n</body>`);
  await writeFile(htmlPath, html, { flag: "w" });
  const fixtureEntryPath = join(scratch, "image-toolbox-fixture-entry.html");
  await writeFile(fixtureEntryPath, await readFile(htmlPath), { flag: "wx" });
  const inputSource = join(scratch, "image-toolbox-input.png");
  await writeFile(inputSource, sourceBytes, { flag: "wx" });
  return {
    pluginRoot,
    originalPluginSource: sourcePlugin,
    originalInputSource: sourceImage,
    stagedInputSource: inputSource,
    outputPath,
    entryPath,
    fixtureEntryPath,
    fixtureRoot: fixtureRootPath,
    sourcePins: {
      pluginTreeSha256: pluginSourceHash,
      pluginManifestSha256: sha256(await readFile(join(sourcePlugin, "plugin.json"))),
      pluginPreloadSha256: sha256(await readFile(join(sourcePlugin, "preload.js"))),
      originalEntryHtmlSha256: sha256(await readFile(join(sourcePlugin, "src/index.html"))),
      fixtureEntryHtmlSha256: sha256(await readFile(fixtureEntryPath)),
      originalAppSha256: sha256(await readFile(join(sourcePlugin, "core/src/app/App.js"))),
      originalTextModuleSha256: sha256(await readFile(join(sourcePlugin, "core/src/modules/TextModule.js"))),
      originalExportModuleSha256: sha256(await readFile(join(sourcePlugin, "core/src/modules/ExportModule.js"))),
      inputImageBytes: sourceBytes.length,
      inputImageSha256: sha256(sourceBytes),
      observerAddedToCopiedIndexHtml: true,
    },
  };
}

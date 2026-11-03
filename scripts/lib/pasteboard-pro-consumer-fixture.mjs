import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import ts from "typescript";

const PRELOAD_BYTES=258790, PRELOAD_SHA256="32e9946980595871917a2745f9ae66280ef1eebe28c383b6f3529e3c7c7f577c";
const CLASS_START=235396, CLASS_END=237405, CLASS_BYTES=2009;
const CLASS_SHA256="50348d0df5bceecac97fb9bf1a37f760898ab72c8116c9a709a30cd8716b12a1";
const IMAGE_BYTES=241870, IMAGE_SHA256="fd3e919353fb07c5ef8bb4c1214a50b308a96d1705d569e01797bcb950611ef0";
const FIXTURE_CSP="default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' asset:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: asset: http://asset.localhost https://asset.localhost; connect-src ipc: http://ipc.localhost http://127.0.0.1:*; frame-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'";
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");

function exactClass(source) {
  const file=ts.createSourceFile("pasteboard-pro-preload.js",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS), found=[];
  const visit=node=>{
    if(ts.isClassDeclaration(node)&&node.name?.text==="ja") {
      const start=node.getStart(file),end=node.end,text=source.slice(start,end);
      found.push({start,end,bytes:Buffer.from(text),text});
    }
    ts.forEachChild(node,visit);
  };
  visit(file);
  if(found.length!==1)throw Error("Expected exactly one original PasteboardPro ja class");
  const item=found[0];
  if(item.start!==CLASS_START||item.end!==CLASS_END||item.bytes.length!==CLASS_BYTES||sha(item.bytes)!==CLASS_SHA256)throw Error("Original PasteboardPro ja class source pin mismatch");
  return item;
}

export async function preparePasteboardProConsumerFixture({repositoryRoot,scratch,fixtureRoot}) {
  const preloadPath=join(repositoryRoot,"ZTools-plugins/plugins/pasteboard-pro/preload.js");
  const imagePath=join(repositoryRoot,"ZTools-plugins/plugins/pasteboard-pro/logo.png");
  const preload=await readFile(preloadPath),image=await readFile(imagePath);
  if(preload.length!==PRELOAD_BYTES||sha(preload)!==PRELOAD_SHA256)throw Error("Original PasteboardPro preload source pin mismatch");
  if(image.length!==IMAGE_BYTES||sha(image)!==IMAGE_SHA256)throw Error("Pinned consumer PNG source mismatch");
  const extracted=exactClass(preload.toString("utf8"));
  const pluginId="batch59-pasteboard-pro-native-image",pluginRoot=join(scratch,"plugin-sources",pluginId);
  await mkdir(pluginRoot,{recursive:true});
  const fixtureImage=join(fixtureRoot,"app-data","plugins",pluginId,"logo.png");
  await writeFile(join(pluginRoot,"plugin.json"),JSON.stringify({name:"PasteboardPro native image consumer fixture",version:"1.0.0",main:"index.html"}),{flag:"wx"});
  await writeFile(join(pluginRoot,"logo.png"),image,{flag:"wx"});
  const page='<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="'+FIXTURE_CSP+'"><script>'
    +'const Vn=480,zn=240,AB=1920,ka=72,xa=1048576,Ma=64,_a=2;\n'
    +extracted.text+'\n'
    +'(async function(){const stage="original-ja.cachedThumbnail/generate";try{'
    +'const fixturePath=require("node:path");if(!fixturePath||typeof fixturePath.resolve!=="function")throw new Error("Node path bootstrap unavailable");const imagePath=fixturePath.resolve('+JSON.stringify(fixtureImage)+');'
    +'const electron=require("electron"),nativeImage=electron.nativeImage,tracker={generate:0};'
    +'const consumer=new ja({},nativeImage),originalGenerate=consumer.generate;'
    +'consumer.generate=function(record){tracker.generate++;return Reflect.apply(originalGenerate,this,[record]);};'
    +'let iframeCspViolationCount=0;window.addEventListener("securitypolicyviolation",()=>{iframeCspViolationCount++;});'
    +'const results=[],imageOperationDurationsMs=[];for(let index=0;index<64;index++){const record={origin:{imagePath},item:{id:"fixture-"+index,payload:{revision:"rev-"+index}}};const started=performance.now();results.push(await consumer.cachedThumbnail(record));imageOperationDurationsMs.push(performance.now()-started);}'
    +'const first={origin:{imagePath},item:{id:"fixture-0",payload:{revision:"rev-0"}}},beforeCache=tracker.generate,cached=await consumer.cachedThumbnail(first),cacheHitNoReplay=tracker.generate===beforeCache&&cached===results[0];'
    +'const generateCallsBeforeCapacityProbe=tracker.generate,sixtyFifth=await consumer.cachedThumbnail({origin:{imagePath},item:{id:"fixture-64",payload:{revision:"rev-64"}}}),generateCallsAfterCapacityProbe=tracker.generate;'
    +'const valid=results.filter(value=>value&&value.mediaType==="image/jpeg"&&value.dataBase64&&value.originalWidth===512&&value.originalHeight===512);'
    +'const jpegPayloadByteLengths=valid.map(value=>{const text=value.dataBase64,padding=text.endsWith("==")?2:text.endsWith("=")?1:0;return Math.floor(text.length*3/4)-padding;});'
    +'const jpegDecodeDimensions=await Promise.all(valid.map(async value=>{const image=new Image();image.src="data:image/jpeg;base64,"+value.dataBase64;await image.decode();return {width:image.naturalWidth,height:image.naturalHeight};}));'
    +'const thumbnailDecodeSucceeded=jpegDecodeDimensions.length===64&&jpegDecodeDimensions.every(size=>size.width===480&&size.height===480),thumbnailDimensions=jpegDecodeDimensions[0]??null;'
    +'const iframeCspMeta=document.querySelector(\'meta[http-equiv="Content-Security-Policy"]\')?.content??null;'
    +'const summary={scope:"exact original PasteboardPro class ja.cachedThumbnail/generate in production opaque plugin iframe",frameOriginOpaque:location.origin==="null",nodePathBootstrapVerified:typeof imagePath==="string"&&imagePath.length>0,successfulRecords:valid.length,generateCallsBeforeCapacityProbe,generateCallsAfterCapacityProbe,cacheHitNoReplay,cacheHitItemId:cached?.itemId??null,sixtyFifthIsNull:sixtyFifth===null,sourceImageBytes:'+IMAGE_BYTES+',imageDimensions:valid.length===64?{width:valid[0].originalWidth,height:valid[0].originalHeight}:null,thumbnailDecodeSucceeded,thumbnailDimensions,jpegDecodeDimensions,jpegPayloadByteLengths,imageOperationDurationsMs,iframeCspMeta,iframeCspViolationCount};'
    +'summary.passed=summary.frameOriginOpaque&&summary.nodePathBootstrapVerified&&summary.successfulRecords===64&&summary.generateCallsBeforeCapacityProbe===64&&summary.generateCallsAfterCapacityProbe===65&&summary.cacheHitNoReplay&&summary.sixtyFifthIsNull&&summary.sourceImageBytes==='+IMAGE_BYTES+'&&summary.imageDimensions?.width===512&&summary.imageDimensions?.height===512&&summary.thumbnailDecodeSucceeded&&summary.thumbnailDimensions?.width===480&&summary.thumbnailDimensions?.height===480&&summary.jpegPayloadByteLengths.length===64&&summary.jpegPayloadByteLengths.every(length=>Number.isInteger(length)&&length>0&&length<=524288)&&summary.imageOperationDurationsMs.length===64&&summary.imageOperationDurationsMs.every(value=>Number.isFinite(value)&&value>=0)&&summary.iframeCspMeta==='+JSON.stringify(FIXTURE_CSP)+'&&summary.iframeCspViolationCount===0;'
    +'const data=JSON.stringify(summary);if(data.length>8192)throw new Error("bounded-summary-overflow");window.ztools.outPlugin({title:summary.passed?"B59 native image consumer fixture":"B59 native image consumer fixture failure",data});'
    +'}catch(error){try{window.ztools?.outPlugin?.({title:"B59 native image consumer fixture failure",data:JSON.stringify({passed:false,stage,errorCode:String(error?.code||"consumer-failed").slice(0,80)})});}catch{}}})();</script>';
  await writeFile(join(pluginRoot,"index.html"),page,{flag:"wx"});
  return {pluginId,pluginRoot,pagePath:join(pluginRoot,"index.html"),fixtureImage,sourceImage:imagePath,originalJaClass:extracted.bytes,sourcePins:{
    preload:{bytes:preload.length,sha256:sha(preload)},
    originalJaClass:{start:extracted.start,end:extracted.end,bytes:extracted.bytes.length,sha256:sha(extracted.bytes)},
    consumerPng:{bytes:image.length,sha256:sha(image),width:512,height:512},
  }};
}


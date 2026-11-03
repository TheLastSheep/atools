import { mkdtemp, mkdir, writeFile, rm, readFile, copyFile, lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { buildNativeSmoke, runNativeProcess } from "./lib/native-smoke-process.mjs";

const root=resolve(new URL("../",import.meta.url).pathname);
const argv=process.argv.slice(2);
let permissionUi=false,guiPath=false,packagedNode;
const positional=[];
for(let index=0;index<argv.length;index++) {
  const flag=argv[index];
  if(flag==="--permission-ui")permissionUi=true;
  else if(flag==="--gui-path")guiPath=true;
  else if(flag==="--packaged-node") {packagedNode=argv[++index];if(!packagedNode || !isAbsolute(packagedNode))throw new Error("--packaged-node requires an absolute executable path");}
  else if(flag.startsWith("--"))throw new Error(`Unknown native probe option: ${flag}`);
  else positional.push(flag);
}
if(positional.length>1 || (packagedNode && !permissionUi))throw new Error("Usage: probe-legacy-node-desktop.mjs [output.json] [--permission-ui] [--gui-path] [--packaged-node <absolute binary>]");
if(packagedNode)guiPath=true;
const output=resolve(positional[0] || join(root,`output/legacy-node-2026-10-15/${permissionUi?"tauri-permission-ui":"tauri-native-gate"}${packagedNode?"-packaged-node":guiPath?"-gui-path":""}-result.json`));
const scratch=await realpath(await mkdtemp(join(tmpdir(),"atools-native-gate-build-")));
try {
  const outDir=join(scratch,"bridge");
  await mkdir(outDir);
  await build({configFile:false,logLevel:"error",root,build:{outDir,emptyOutDir:false,minify:"esbuild",
    lib:{entry:join(root,"src/lib/nodeModuleBridge.ts"),formats:["es"],fileName:()=>"bridge.mjs"}}});
  const bridge=await import(pathToFileURL(join(outDir,"bridge.mjs")).href);
  const expression=join(scratch,"bridge-expression.js");
  await writeFile(expression,bridge.nodeModuleBridgeScript({endpoint:"__ATOOLS_NATIVE_ENDPOINT__"}));
  const args=["--bridge-script",expression,"--output",output,"--fixture-root",join(scratch,"native-fixture")];
  if(permissionUi) {
    const uiDir=join(scratch,"permission-ui");
    await build({configFile:false,logLevel:"error",root,plugins:[svelte({emitCss:false,compilerOptions:{css:"injected"}})],build:{outDir:uiDir,minify:"esbuild",target:"safari14",lib:{entry:join(root,"tests/components/nativePermissionSmoke.ts"),formats:["iife"],name:"NativePermissionSmoke",fileName:()=>"permission.js"}}});
    args.push("--permission-ui",join(uiDir,"permission.js"));
  }
  let executable=await buildNativeSmoke(root),packagedExecutable;
  if(packagedNode) {
    if(process.platform!=="darwin")throw new Error("Packaged layout fixture currently covers macOS only");
    const info=await lstat(packagedNode);
    if(!info.isFile() || info.size>160*1024*1024)throw new Error("Packaged Node must be a bounded regular executable");
    const binDir=join(scratch,"Packaged Runtime Layout/Contents/MacOS");await mkdir(binDir,{recursive:true});
    const nativeCopy=join(binDir,"native-smoke");packagedExecutable=join(binDir,"node");
    await copyFile(executable,nativeCopy);await copyFile(packagedNode,packagedExecutable);
    executable=nativeCopy;
  }
  const env={...process.env};
  if(guiPath) {
    if(process.platform==="win32")throw new Error("GUI PATH fixture currently models Unix desktop launch only");
    env.PATH="/usr/bin:/bin";delete env.ATOOLS_NODE_BINARY;
  }
  await runNativeProcess(executable,args,{cwd:root,env});
  const report=JSON.parse(await readFile(output,"utf8"));
  if(!report.passed)throw new Error("Native gate report did not pass");
  if(packagedExecutable) {
    const pin=JSON.parse(await readFile(join(root,"resources/node-runtime/pin.json"),"utf8"));
    if(report.nodeRuntime?.executable!==packagedExecutable || report.nodeRuntime?.version!==pin.version)throw new Error("Native probe did not use the pinned packaged Node executable");
    report.checks.packagedNodeChosen=true;
  }
  report.environment={...report.environment,guiPathFixture:guiPath,onlySystemPath:guiPath?"/usr/bin:/bin":null,
    packagedLayoutFixture:Boolean(packagedNode),installerAcceptance:false};
  await writeFile(output,JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:report.passed,output,checks:report.checks,nativeFrame:report.nativeFrame,observations:report.observations,temporaryDataRemoved:report.temporaryDataRemoved},null,2));
} finally { await rm(scratch,{recursive:true,force:true}); }

import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { buildNativeSmoke, runNativeProcess } from "./lib/native-smoke-process.mjs";
import { createPanelFixtureEnvironment, repositoryRoot } from "./probe-plugin-panel-native.mjs";

async function buildNavigationUi(root,scratch){
  const bundle=join(scratch,"navigation-panel");await mkdir(bundle);
  await build({configFile:false,logLevel:"error",root,
    plugins:[svelte({emitCss:false,compilerOptions:{css:"injected"}})],
    build:{outDir:bundle,minify:"esbuild",target:"safari14",cssCodeSplit:false,
      lib:{entry:join(root,"tests/components/nativePluginNavigationSmoke.ts"),formats:["iife"],name:"NativePluginNavigation",fileName:()=>"panel.js"},
      rollupOptions:{output:{inlineDynamicImports:true}}}});
  const css=join(scratch,"panel.css");
  const cssFiles=(await readdir(bundle)).filter(name=>name.endsWith(".css"));
  await writeFile(css,(await Promise.all(cssFiles.map(file=>readFile(join(bundle,file),"utf8")))).join("\n"));
  return {bundle,css,executable:await buildNativeSmoke(root)};
}

export async function runPluginNavigationNativeFixture({output,root=repositoryRoot}={}){
  if(!output)throw Error("Native plugin navigation fixture requires an absolute output path");
  output=resolve(output);
  const scratch=await mkdtemp(join(tmpdir(),"atools-plugin-navigation-native-"));
  const isolated=await createPanelFixtureEnvironment(root);
  try{
    const ui=await buildNavigationUi(root,scratch);const fixtureRoot=join(scratch,"native-fixture");let failure;
    try{
      await runNativeProcess(ui.executable,["--plugin-navigation-panel-ui","--panel-ui",join(ui.bundle,"panel.js"),"--panel-css",ui.css,
        "--panel-probe",join(root,"tests/components/nativePluginNavigationFrameProbe.js"),"--output",output,"--fixture-root",fixtureRoot],
      {cwd:root,env:isolated.env,timeoutMs:120000});
    }catch(error){failure=error;}
    let report;try{report=JSON.parse(await readFile(output,"utf8"));}catch(error){throw failure||error;}
    report.environment=isolated.evidence;
    report.fixture={generatedPureWebPackageOnly:true,importedOriginalSources:[],preload:null,sourcePathsRedacted:true};
    await writeFile(output,JSON.stringify(report,null,2));
    if(failure||report.passed!==true){const error=failure||Error("Native plugin navigation acceptance failed");error.navigationReport=report;throw error;}
    return report;
  }finally{await isolated.cleanup();await rm(scratch,{recursive:true,force:true});}
}

async function main(){
  const output=resolve(process.argv[2]||join(repositoryRoot,"output/legacy-node-2026-10-15/plugin-navigation-native.json"));
  const report=await runPluginNavigationNativeFixture({output});console.log(JSON.stringify({output,...report},null,2));
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))await main();

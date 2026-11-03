import { mkdtemp,mkdir,readFile,writeFile,rm,stat } from "node:fs/promises";
import { join,dirname,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash,randomUUID } from "node:crypto";
import { runNativeProcess } from "./lib/native-smoke-process.mjs";

const root=fileURLToPath(new URL("../",import.meta.url));
const execute=promisify(execFile);
const inputFiles=["Cargo.toml","Cargo.lock","src-tauri/Cargo.toml","src-tauri/tauri.conf.json","src-tauri/src/lib.rs",
  ...["plugin_loopback.rs","plugin_loopback_origin.rs","plugin_loopback_origin_tests.rs","plugin_loopback_dialog.rs","plugin_loopback_dialog_tests.rs",
    "plugin_dialog_runtime/transport.rs","legacy_runtime/http_tests.rs"].map(name=>"src-tauri/src/"+name),
  "src-tauri/examples/plugin_bootstrap_probe.rs",...['protocol','transport','validation','contract_tests'].map(name=>`src-tauri/examples/plugin_bootstrap_probe/${name}.rs`),
  "scripts/probe-plugin-bootstrap-native.mjs","scripts/test-plugin-bootstrap-fixture.mjs",
  ...['parent','bootstrap','payload','opaque'].map(name=>`tests/fixtures/plugin-bootstrap-smoke/${name}.html`),
  "scripts/lib/native-smoke-process.mjs","scripts/lib/native-smoke-descendants.mjs"];
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
async function fingerprints(){return Object.fromEntries(await Promise.all(inputFiles.map(async p=>[p,sha(await readFile(join(root,p)))])))}
const fingerprint=async p=>({bytes:(await stat(p)).size,sha256:sha(await readFile(p))});

async function main(){
  if(process.platform!=="darwin")throw Error("This experiment requires native macOS WKWebView");
  const args=process.argv.slice(2);
  if(args.length!==0&&(args.length!==2||args[0]!=="--output"||!args[1]||args[1].startsWith("--")))throw Error("Usage: probe-plugin-bootstrap-native.mjs [--output FRESH_JSON]");
  const output=resolve(args[1]||join(root,"output/legacy-node-2026-10-15",`native-bootstrap-${randomUUID()}.json`));
  await mkdir(dirname(output),{recursive:true});
  if(await stat(output).catch(()=>null))throw Error("Preserve existing evidence; use a fresh output");
  const sourceBefore=await fingerprints();
  const scratch=await mkdtemp("/private/tmp/atools-bootstrap-feasibility-");
  const report={schemaVersion:1,runId:randomUUID(),createdAt:new Date().toISOString(),status:"running",productionReady:false,
    scope:"Standalone synthetic one-use bootstrap and document-bound MessageChannel handoff with the real shared loopback transport; no original plugin, DB or system permission is loaded",
    sourceBinding:{scope:"Selected source and native executable, not full compiler closure",before:sourceBefore},
    runtimeOutputPolicy:"Native stdout/stderr are discarded; only the credential-free validated structured report is retained."};
  let executable;
  try{
    await runNativeProcess("cargo",["build","-p","atools","--example","plugin_bootstrap_probe","--features","legacy-node-smoke","--offline"],{cwd:root});
    const {stdout}=await execute("cargo",["metadata","--no-deps","--offline","--format-version","1"],{cwd:root,maxBuffer:4*1024*1024});
    executable=join(JSON.parse(stdout).target_directory,"debug/examples/plugin_bootstrap_probe");
    report.sourceBinding.executableBefore=await fingerprint(executable);
    for(const part of ["home","temp","config","cache","data"])await mkdir(join(scratch,part),{mode:0o700});
    const env={...process.env,HOME:join(scratch,"home"),TMPDIR:join(scratch,"temp"),XDG_CONFIG_HOME:join(scratch,"config"),XDG_CACHE_HOME:join(scratch,"cache"),XDG_DATA_HOME:join(scratch,"data")};
    const nativeOutput=join(scratch,"native-report.json");
    let failure;
    try{await runNativeProcess(executable,["--fixture-root",join(scratch,"fixture"),"--output",nativeOutput,
      "--pages-root",join(root,"tests/fixtures/plugin-bootstrap-smoke")],{cwd:root,env,stdio:"ignore",timeoutMs:45000})}
    catch(error){failure=error}
    report.native=JSON.parse(await readFile(nativeOutput,"utf8"));
    if(failure)throw failure;
    report.status=report.native.status==="pass"?"pass":"failed";
  }catch(error){report.status="failed";report.error=String(error instanceof Error?error.message:error)}
  finally{
    try{
      report.sourceBinding.after=await fingerprints();
      report.sourceBinding.sourcesUnchanged=JSON.stringify(report.sourceBinding.before)===JSON.stringify(report.sourceBinding.after);
      if(executable){report.sourceBinding.executableAfter=await fingerprint(executable);report.sourceBinding.executableUnchanged=JSON.stringify(report.sourceBinding.executableBefore)===JSON.stringify(report.sourceBinding.executableAfter)}
      if(!report.sourceBinding.sourcesUnchanged||report.sourceBinding.executableUnchanged!==true)report.status="failed";
    }catch(error){report.status="failed";report.sourceBindingError=String(error)}
    try{await rm(scratch,{recursive:true,force:true});report.scratchRemoved=true}catch(error){report.status="failed";report.cleanupError=String(error)}
    report.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2),{flag:"wx",mode:0o600});
  }
  console.log(JSON.stringify({status:report.status,output,nativeStatus:report.native?.status,errors:report.native?.errors,productionReady:false}));
  if(report.status!=="pass")process.exitCode=1;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))await main();

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream } from "node:fs";
import { appendFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { reviewedDialogAction } from "./control-native-dialog-acceptance.mjs";
import { validateDialogOutcome } from "./probe-plugin-dialog-native.mjs";

const execute=promisify(execFile);
const ROOT=fileURLToPath(new URL("../",import.meta.url));
export const FIRST_PANEL_HOLD_MS=15000;
const POLL_MS=100,STAGE_DEADLINE_MS=110000,STARTUP_DEADLINE_MS=180000;
const SEQUENCE=[
  {stage:"awaiting-open-cancel",actions:["inspect","cancel"]},
  {stage:"awaiting-open-select",actions:["inspect","goto","confirm"]},
  {stage:"awaiting-save-cancel",actions:["inspect","cancel"]},
  {stage:"awaiting-save-select",actions:["inspect","goto","name","confirm"]},
];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function parseAppleScriptAcceptanceOptions(argv) {
  let authorized=false,output,pageDocument=false;
  for(let index=0;index<argv.length;index++) {
    if(argv[index]==="--authorized-four-private-operations"&&!authorized)authorized=true;
    else if(argv[index]==="--page-document"&&!pageDocument)pageDocument=true;
    else if(argv[index]==="--output"&&!output&&argv[index+1]&&!argv[index+1].startsWith("--"))output=resolve(argv[++index]);
    else throw Error("Usage: run-native-dialog-applescript-acceptance.mjs --authorized-four-private-operations [--page-document] [--output FRESH_OUTPUT]");
  }
  if(!authorized)throw Error("Explicit --authorized-four-private-operations is required before starting any process");
  output??=join(ROOT,"output/legacy-node-2026-10-15",`published-file-tree-native-dialog-applescript-${randomUUID()}.json`);
  const prefix=output.replace(/\.json$/u,"");
  return {output,pageDocument,checkpoint:prefix+".checkpoint.json",session:prefix+".control-session.json",audit:prefix+".control-audit.jsonl",
    controlReport:prefix+".control-report.json",stdout:prefix+".stdout.log",stderr:prefix+".stderr.log"};
}

/** --page-document changes the fixture mode only; the four authorized private operations and helper scope stay identical. */
export function validateNativeDialogProbeOutcome(report,pageDocument=false) {
  if(report?.status!=="pass"||report.pageDocument!==pageDocument)
    throw Error("Native probe did not pass in the explicitly requested page mode");
  return validateDialogOutcome(report.outcome,{pageDocument});
}

/** Captures the first complete stdout JSON object containing nativeApplication, with a bounded parser buffer. */
export function createNativeApplicationCapture() {
  let pending="",candidate="",application,error;
  function line(value) {
    if(application||error)return;
    if(!candidate&&!value.trimStart().startsWith("{"))return;
    candidate+=value+"\n";
    if(candidate.length>65536){error=Error("Native application metadata exceeded its 64KiB budget");return;}
    try {
      const parsed=JSON.parse(candidate);candidate="";
      if(parsed?.nativeApplication)application=parsed;
    } catch { /* Pretty-printed JSON is parsed only when complete. */ }
  }
  return {
    feed(chunk) {
      if(application||error)return;
      pending+=String(chunk);
      let end;
      while((end=pending.indexOf("\n"))!==-1){line(pending.slice(0,end));pending=pending.slice(end+1);}
      if(pending.length>65536){error=Error("Native stdout line exceeded the metadata parser budget");pending="";}
    },
    end(){if(pending)line(pending);pending="";},
    get application(){return application;},get error(){return error;},
  };
}

function exactTargets(checkpoint,metadata) {
  if(checkpoint.treeDirectory!==metadata.treeDirectory||checkpoint.savePath!==metadata.savePath)
    throw Error("Checkpoint targets differ from this freshly launched fixture");
}

export function validateNativeDialogHelperRecord(value,stage,action) {
  if(value?.stage!==stage||value.action!==action||value.error||!Number.isSafeInteger(value.pid)||value.pid<1
    ||typeof value.output!=="string")throw Error("Native control helper returned incomplete or failed evidence");
  if(action==="cancel"&&value.output==="actual-native-cancel-button-clicked")return value.pid;
  if(action==="confirm"&&value.output==="actual-native-confirm-button-clicked")return value.pid;
  if(!["inspect","goto","name"].includes(action))throw Error("Native helper did not confirm the requested actual button action");
  const controls=value.output.split(",").map(item=>item.trim());
  const title=stage.startsWith("awaiting-open-")?"选择文件夹":"保存目录树图片";
  const confirm=stage.startsWith("awaiting-open-")?["Open","打开","选择","Choose"]:["Save","存储","保存"];
  if(![title,"AXSheet"].includes(controls[0])||!["Cancel","取消"].some(label=>controls.includes(label))
    ||!confirm.some(label=>controls.includes(label)))throw Error("Actual native title/buttons differ from the reviewed picker; stop for diagnosis");
  return value.pid;
}

/** Dependency injection is for offline scope tests; main always supplies the real child and strict helper. */
export async function orchestrateFourPrivateDialogOperations({readCheckpoint,runAction,isLive,metadata,record,
  now=()=>performance.now(),sleep=pause}) {
  const requireLive=()=>{if(!isLive())throw Error("Fresh probe process ended before the four operations completed");};
  const current=async(stage,action)=>{
    requireLive();const checkpoint=await readCheckpoint();exactTargets(checkpoint,metadata);
    reviewedDialogAction(checkpoint,stage,action);return checkpoint;
  };
  for(const [index,step] of SEQUENCE.entries()) {
    const deadline=now()+STAGE_DEADLINE_MS;
    while(true) {
      requireLive();if(now()>=deadline)throw Error("Native stage deadline exceeded: "+step.stage);
      const checkpoint=await readCheckpoint();
      if(["failed","complete"].includes(checkpoint.stage))throw Error("Native fixture ended at "+checkpoint.stage+" before "+step.stage);
      const seen=SEQUENCE.findIndex(item=>item.stage===checkpoint.stage);
      if(seen>index)throw Error("Native fixture skipped the required phase: "+step.stage);
      if(checkpoint.stage===step.stage&&checkpoint.control==="awaiting_root_native_picker_control"
        &&checkpoint.runtime?.nativeDialogs===1&&checkpoint.runtime?.dialogInvocations===1) {
        exactTargets(checkpoint,metadata);reviewedDialogAction(checkpoint,step.stage,"inspect");break;
      }
      requireLive();const remaining=deadline-now();
      if(remaining<=0)throw Error("Native stage deadline exceeded: "+step.stage);
      await sleep(Math.min(POLL_MS,remaining));
    }
    await record({kind:"stage-ready",stage:step.stage,elapsedMs:now(),deadlineMs:deadline});
    if(index===0) {
      const holdStarted=now(),holdUntil=holdStarted+FIRST_PANEL_HOLD_MS;
      while(now()<holdUntil) {
        if(now()>=deadline)throw Error("First native panel hold exceeded its stage deadline");
        await current(step.stage,"inspect");
        const remaining=holdUntil-now();if(remaining>0){requireLive();await sleep(Math.min(POLL_MS,remaining));}
      }
      await current(step.stage,"inspect");
      await record({kind:"first-native-panel-held",stage:step.stage,heldMs:now()-holdStarted,
        boundary:"Fresh nativeDialogs=1/dialogInvocations=1 checkpoint remained in the first real native stage for at least 15 seconds before inspection/cancel"});
    }
    for(const action of step.actions) {
      if(now()>=deadline)throw Error("Native stage deadline exceeded before action: "+step.stage+"/"+action);
      await current(step.stage,action);
      await record({kind:"action-start",stage:step.stage,action});
      await runAction(step.stage,action);
      if(now()>=deadline)throw Error("Native stage deadline exceeded after action: "+step.stage+"/"+action);
      await record({kind:"action-complete",stage:step.stage,action});
    }
    // The next iteration waits for a different checkpoint stage and one fresh active native invocation.
  }
}

async function freshPaths(paths) {
  for(const field of ["output","checkpoint","session","audit","controlReport","stdout","stderr"]) {
    const file=paths[field];
    await mkdir(dirname(file),{recursive:true});
    try {await lstat(file);}catch(error){if(error.code==="ENOENT")continue;throw error;}
    throw Error("Existing evidence must be preserved; choose a fresh output: "+file);
  }
}

async function main() {
  const paths=parseAppleScriptAcceptanceOptions(process.argv.slice(2));
  if(process.platform!=="darwin")throw Error("Authorized native dialog orchestration is macOS-only");
  await freshPaths(paths);
  const control={schemaVersion:1,status:"starting",createdAt:new Date().toISOString(),paths,
    authorization:"AppleScript-four-private-operations",firstPanelMinimumHoldMs:FIRST_PANEL_HOLD_MS,
    scope:"Only cancel directory, select exact private directory, cancel save, save exact private PNG; actions never retry or replay original business",
    cleanupBoundary:"The original probe owns its native/process deadline and temporary cleanup. This driver never kills it early."};
  await writeFile(paths.audit,"",{flag:"wx",mode:0o600});
  await writeFile(paths.session,JSON.stringify({schemaVersion:1,authorizedControl:"AppleScript-four-private-operations",
    checkpoint:paths.checkpoint,audit:paths.audit,status:"awaiting-fresh-native-application",createdAt:new Date().toISOString()},null,2),{flag:"wx",mode:0o600});
  const record=async event=>appendFile(paths.audit,JSON.stringify({time:new Date().toISOString(),...event})+"\n",{mode:0o600});
  const capture=createNativeApplicationCapture();
  const probe=fileURLToPath(new URL("./probe-plugin-dialog-native.mjs",import.meta.url));
  const probeArguments=[probe,"--output",paths.output,"--checkpoint",paths.checkpoint,...(paths.pageDocument?["--page-document"]:[])];
  const child=spawn(process.execPath,probeArguments,
    {cwd:ROOT,stdio:["ignore","pipe","pipe"]});
  let spawnError,exit;
  const completion=new Promise(resolve_=>{
    child.once("error",error=>{spawnError=error;exit={code:null,signal:null,spawnError:String(error)};resolve_(exit);});
    child.once("exit",(code,signal)=>{exit={code,signal};resolve_(exit);});
  });
  const isLive=()=>!spawnError&&child.exitCode===null&&child.signalCode===null&&!exit;
  child.stdout.on("data",chunk=>capture.feed(chunk.toString("utf8")));
  child.stdout.once("end",()=>capture.end());
  const logs=Promise.allSettled([
    pipeline(child.stdout,createWriteStream(paths.stdout,{flags:"wx",mode:0o600})),
    pipeline(child.stderr,createWriteStream(paths.stderr,{flags:"wx",mode:0o600})),
  ]);
  control.probePid=child.pid;
  let failure;
  try {
    await record({kind:"probe-started",pid:child.pid,arguments:probeArguments.slice(1),pageDocument:paths.pageDocument});
    const deadline=performance.now()+STARTUP_DEADLINE_MS;
    while(!capture.application) {
      if(capture.error)throw capture.error;
      if(!isLive())throw spawnError??Error("Probe ended before publishing its native application identity");
      if(performance.now()>=deadline)throw Error("Native application metadata startup deadline exceeded");
      const remaining=deadline-performance.now();
      if(remaining<=0)throw Error("Native application metadata startup deadline exceeded");
      if(!isLive())throw spawnError??Error("Probe ended before publishing its native application identity");
      await pause(Math.min(POLL_MS,remaining));
    }
    const metadata=capture.application;
    if(metadata.status!=="starting-real-native-dialog-acceptance"||metadata.output!==paths.output||metadata.checkpoint!==paths.checkpoint
      ||typeof metadata.runId!=="string"||metadata.pageDocument!==paths.pageDocument)throw Error("Native application metadata does not belong to this fresh probe and requested page mode");
    control.nativeApplication=metadata.nativeApplication;control.probeRunId=metadata.runId;
    const session={schemaVersion:1,authorizedControl:"AppleScript-four-private-operations",checkpoint:paths.checkpoint,audit:paths.audit,
      nativeApplication:metadata.nativeApplication,probePid:child.pid,probeRunId:metadata.runId,createdAt:new Date().toISOString(),
      treeDirectory:metadata.treeDirectory,savePath:metadata.savePath,pageDocument:paths.pageDocument};
    // Replace only this run's own initial marker after fresh stdout identity is available.
    await writeFile(paths.session,JSON.stringify(session,null,2),{flag:"w",mode:0o600});
    await record({kind:"native-application-captured",...session});
    console.log(JSON.stringify({status:"authorized-four-private-operations-started",session:paths.session,audit:paths.audit,
      output:paths.output,nativeApplication:metadata.nativeApplication}));
    const helper=fileURLToPath(new URL("./control-native-dialog-acceptance.mjs",import.meta.url));
    let nativePickerPid;
    await orchestrateFourPrivateDialogOperations({metadata,isLive,record,
      readCheckpoint:async()=>JSON.parse(await readFile(paths.checkpoint,"utf8")),
      runAction:async(stage,action)=>{
        // Each process re-reads the checkpoint and resolves exactly one matching fixture PID; it never launches an app.
        const result=await execute(process.execPath,[helper,paths.session,stage,action],{cwd:ROOT,timeout:20000,maxBuffer:32*1024});
        await record({kind:"helper-result",stage,action,stdout:result.stdout,stderr:result.stderr});
        const pid=validateNativeDialogHelperRecord(JSON.parse(result.stdout.trim()),stage,action);
        if(nativePickerPid!==undefined&&nativePickerPid!==pid)throw Error("Native fixture PID changed during the four reviewed operations");
        nativePickerPid=pid;control.nativePickerPid=pid;
      }});
    control.operationsCompleted=true;
  } catch(error) {
    failure=error;control.status="failed";control.error=String(error instanceof Error?error.message:error);
    await record({kind:"control-stopped",error:control.error,nextAction:"Wait for the original probe's own native deadline and cleanup; no further native action"});
    console.log(JSON.stringify({status:"control-stopped-awaiting-probe-cleanup",error:control.error,audit:paths.audit}));
  } finally {
    // Never terminate the probe here: its own bounded native/process deadlines drain panels and private files.
    control.probeExit=await completion;
    const results=await logs;
    control.logWriteErrors=results.filter(result=>result.status==="rejected").map(result=>String(result.reason));
    try {
      const outcome=JSON.parse(await readFile(paths.output,"utf8"));
      control.probeStatus=outcome.status;control.probeRunId??=outcome.runId;
      validateNativeDialogProbeOutcome(outcome,paths.pageDocument);
      if(!failure&&control.operationsCompleted&&exit?.code===0&&outcome.status==="pass"&&control.logWriteErrors.length===0)control.status="pass";
      else control.status="failed";
    }catch(error){control.status="failed";control.probeReportError=String(error);}
    control.finishedAt=new Date().toISOString();
    await record({kind:"control-finished",status:control.status,probeExit:control.probeExit,probeStatus:control.probeStatus});
    await writeFile(paths.controlReport,JSON.stringify(control,null,2),{flag:"wx",mode:0o600});
  }
  console.log(JSON.stringify({status:control.status,output:paths.output,controlReport:paths.controlReport,session:paths.session,audit:paths.audit}));
  if(control.status!=="pass")process.exitCode=1;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))await main();

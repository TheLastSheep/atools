import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { trackNativeDescendants } from "./native-smoke-descendants.mjs";
import { captureNativeProcessIdentity, createNativeProcessResourceSampler, summarizeProcessIdentity } from "./native-process-resource-sampler.mjs";

/** Run only this test's native process group, with bounded completion. */
export function runNativeProcess(executable,args,options={}) {
  return new Promise((resolve,reject)=>{
    const {timeoutMs=180000,onProcessStarted,...spawnOptions}=options;
    const tag=`atools-native-smoke-${randomUUID()}`;
    const child=spawn(executable,args,{stdio:"inherit",...spawnOptions,
      env:{...(spawnOptions.env || process.env),ATOOLS_NATIVE_SMOKE_PROCESS_TAG:tag},
      detached:process.platform!=="win32"});
    const stopDescendants=process.platform!=="win32" && child.pid ? trackNativeDescendants(child,tag) : null;
    let timer,settled=false;
    let processObserver,observerSetup;
    if (typeof onProcessStarted === "function" && child.pid) {
      observerSetup = captureNativeProcessIdentity(child.pid, { expectedPgid: child.pid, expectedExecutable: executable }).then(identity => onProcessStarted({
        pid: child.pid,
        identity: summarizeProcessIdentity(identity),
        createSampler: options => createNativeProcessResourceSampler({ rootIdentity: identity, ...options }),
      })).then(observer => { processObserver = observer; }).catch(error => {
        processObserver = { setupError: String(error) };
      });
    }
    const cleanup=()=>{clearTimeout(timer);process.removeListener("SIGINT",interrupt);process.removeListener("SIGTERM",interrupt);};
    const finish=async(error,terminate=false)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      const failures=[error].filter(Boolean);
      if(observerSetup)await observerSetup;
      if(processObserver?.stop)try { await processObserver.stop(); }
      catch(observerError) { processObserver.stopError=String(observerError); }
      try {
        // Capture descendants while the parent is alive, including setsid Node sidecars.
        if(stopDescendants)await stopDescendants();
      } catch(cleanupError) { failures.push(cleanupError); }
      if(terminate || failures.length) {
        try {
          if(process.platform==="win32" && child.pid && child.exitCode===null && child.signalCode===null) {
            await promisify(execFile)("taskkill",["/pid",String(child.pid),"/T","/F"],{timeout:2000});
          } else if(child.pid && child.exitCode===null && child.signalCode===null) {
            try {process.kill(-child.pid,"SIGKILL");}catch(killError){if(killError.code!=="ESRCH")throw killError;}
          }
        } catch(cleanupError) { failures.push(cleanupError); }
        // An in-progress spawn may have escaped the first snapshot just before
        // killing the app. Test-only Node tags find it after reparenting too.
        if(stopDescendants) {
          try {await stopDescendants();} catch(cleanupError){failures.push(cleanupError);}
        }
      }
      cleanup();
      const observerEvidence = { processObserver: processObserver?.report ?? null,
        processObserverError: processObserver?.setupError ?? processObserver?.stopError ?? null };
      if(failures.length>1) {
        const aggregate = new AggregateError(failures,"Native smoke cleanup failed");
        Object.assign(aggregate, observerEvidence); reject(aggregate);
      }
      else if(failures.length) {
        Object.assign(failures[0], observerEvidence); reject(failures[0]);
      }
      else resolve(observerEvidence);
    };
    const interrupt=()=>{void finish(new Error("Native smoke interrupted"),true);};
    process.on("SIGINT",interrupt);process.on("SIGTERM",interrupt);
    timer=setTimeout(()=>{void finish(new Error(`Native smoke exceeded ${timeoutMs} ms`),true);},timeoutMs);
    child.once("error",error=>{void finish(error);});
    child.once("exit",code=>{void finish(code===0?null:new Error(`Native smoke exited ${code}`),code!==0);});
  });
}

export function nativeSmokeBuildPlan(profile="debug") {
  if(profile!=="debug"&&profile!=="release")throw Error("Native smoke build profile must be debug or release");
  const cargoArgs=["build","-p","atools","--example","legacy_node_desktop_smoke","--features","legacy-node-smoke","--offline"];
  if(profile==="release")cargoArgs.push("--release");
  const timeoutMs=profile==="release"?600000:180000;
  return {profile,cargoArgs,timeoutMs,artifactRelativePath:join(profile,"examples","legacy_node_desktop_smoke"+(process.platform==="win32"?".exe":""))};
}

async function readCargoTargetDirectory(root) {
  const {stdout}=await promisify(execFile)("cargo",["metadata","--no-deps","--offline","--format-version","1"],{cwd:root,maxBuffer:4*1024*1024});
  const target=JSON.parse(stdout).target_directory;
  if(typeof target!=="string"||!target)throw Error("Cargo metadata did not provide target_directory");
  return target;
}

/** Build-only time budget; test seams replace executors, never timeout policy. */
export async function buildNativeSmokeWithProfile(root,{profile="debug",runBuildProcess=runNativeProcess,readTargetDirectory=readCargoTargetDirectory}={}) {
  const plan=nativeSmokeBuildPlan(profile);
  await runBuildProcess("cargo",plan.cargoArgs,{cwd:root,timeoutMs:plan.timeoutMs});
  const target=await readTargetDirectory(root);
  if(typeof target!=="string"||!target)throw Error("Cargo metadata did not provide target_directory");
  return {profile:plan.profile,cargoArgs:plan.cargoArgs,timeoutMs:plan.timeoutMs,targetDirectory:target,
    artifactRelativePath:plan.artifactRelativePath,executable:join(target,plan.artifactRelativePath)};
}

export async function buildNativeSmoke(root) {
  return (await buildNativeSmokeWithProfile(root,{profile:"debug"})).executable;
}

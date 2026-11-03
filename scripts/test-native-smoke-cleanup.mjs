import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runNativeProcess } from "./lib/native-smoke-process.mjs";

if (process.platform === "win32") {
  console.log("POSIX setsid cleanup regression is not applicable on Windows");
} else {
  const scratch = await mkdtemp(join(tmpdir(), "atools-native-cleanup-"));
  const marker = join(scratch, "owned-processes.json");
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  let owned = [];
  try {
    const script = `
      const {spawn}=require('node:child_process');
      const {writeFileSync}=require('node:fs');
      process.on('SIGTERM',()=>{});
      const isolated=spawn(process.execPath,['--title='+process.env.ATOOLS_NATIVE_SMOKE_PROCESS_TAG,'-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});
      writeFileSync(process.argv[1],JSON.stringify([process.pid,isolated.pid]));
      setInterval(()=>{},1000);
    `;
    const result = runNativeProcess(process.execPath, ["-e", script, marker], {
      stdio: "ignore", timeoutMs: 1500,
    });
    const failure = result.catch((error) => error);
    const deadline = Date.now() + 1200;
    while (!owned.length && Date.now() < deadline) {
      try { owned = JSON.parse(await readFile(marker, "utf8")); } catch {}
      if (!owned.length) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(owned.length, 2, "fixture must start an independent process group");
    assert.match((await failure).message, /exceeded 1500 ms/);
    for (const pid of owned) {
      let status = "";
      try { status = (await promisify(execFile)("/bin/ps", ["-p", String(pid), "-o", "stat="])).stdout.trim(); } catch {}
      assert.ok(!status || status.startsWith("Z"), `test-owned process ${pid} still running: ${status}`);
    }
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0), "cleanup must preserve unrelated processes");
    const fastExitScript = script.replace("setInterval(()=>{},1000);\n    ", "process.exit(1);\n    ");
    for (let iteration=0;iteration<3;iteration++) {
      const error = await runNativeProcess(process.execPath,["-e",fastExitScript,marker],{stdio:"ignore"}).catch((failure)=>failure);
      owned=JSON.parse(await readFile(marker,"utf8"));
      assert.match(error.message,/exited 1/);
      for(const pid of owned) {
        let status="";
        try{status=(await promisify(execFile)("/bin/ps",["-p",String(pid),"-o","stat="])).stdout.trim();}catch{}
        assert.ok(!status || status.startsWith("Z"),`fast-exit owned process ${pid} still running: ${status}`);
      }
      assert.doesNotThrow(()=>process.kill(unrelated.pid,0));
    }
    // Parent can disappear before the first ps capture. Ordinary descendants
    // retain the exclusively spawned PGID even after being reparented to PID 1.
    const sameGroupExitScript=fastExitScript.replace(
      "['--title='+process.env.ATOOLS_NATIVE_SMOKE_PROCESS_TAG,'-e',",
      "['-e',").replace("{detached:true,stdio:'ignore'}","{stdio:'ignore'}");
    for(let iteration=0;iteration<3;iteration++) {
      const error=await runNativeProcess(process.execPath,["-e",sameGroupExitScript,marker],{stdio:"ignore"}).catch(failure=>failure);
      owned=JSON.parse(await readFile(marker,"utf8"));
      assert.match(error.message,/exited 1/);
      for(const pid of owned) {
        let status="";
        try{status=(await promisify(execFile)("/bin/ps",["-p",String(pid),"-o","stat="])).stdout.trim();}catch{}
        assert.ok(!status || status.startsWith("Z"),`same-group fast-exit process ${pid} still running: ${status}`);
      }
      assert.doesNotThrow(()=>process.kill(unrelated.pid,0));
    }
    // The tagged sidecar remains alive while its TERM handler spawns an
    // untagged detached grandchild. The KILL snapshot must walk descendants too.
    const shutdownChild=`
      const {spawn}=require('node:child_process'),fs=require('node:fs');
      let spawned=false;
      process.on('SIGTERM',()=>{
        if(spawned)return;spawned=true;
        const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
        child.unref();
        const ids=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
        ids.push(child.pid);fs.writeFileSync(process.argv[1],JSON.stringify(ids));
      });setInterval(()=>{},1000);
    `;
    const shutdownScript=`
      const {spawn}=require('node:child_process'),fs=require('node:fs');
      process.on('SIGTERM',()=>{});
      const child=spawn(process.execPath,['--title='+process.env.ATOOLS_NATIVE_SMOKE_PROCESS_TAG,'-e',${JSON.stringify(shutdownChild)},process.argv[1]],{detached:true,stdio:'ignore'});
      fs.writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));
      setInterval(()=>{},1000);
    `;
    const shutdownError=await runNativeProcess(process.execPath,["-e",shutdownScript,marker],{stdio:"ignore",timeoutMs:1200}).catch(failure=>failure);
    owned=JSON.parse(await readFile(marker,"utf8"));
    assert.match(shutdownError.message,/exceeded 1200 ms/);
    assert.equal(owned.length,3,"TERM handler must spawn the untagged detached child");
    for(const pid of owned) {
      let status="";
      try{status=(await promisify(execFile)("/bin/ps",["-p",String(pid),"-o","stat="])).stdout.trim();}catch{}
      assert.ok(!status || status.startsWith("Z"),`shutdown-spawn process ${pid} still running: ${status}`);
    }
    assert.doesNotThrow(()=>process.kill(unrelated.pid,0));
    await rm(marker);
    const wrapperScript=`
      import {runNativeProcess} from ${JSON.stringify(new URL("./lib/native-smoke-process.mjs",import.meta.url).href)};
      await runNativeProcess(process.execPath,['-e',${JSON.stringify(script)},${JSON.stringify(marker)}],{stdio:'ignore'})
        .catch(error=>{if(error.message==='Native smoke interrupted')process.exitCode=7;else throw error;});
    `;
    const wrapper=spawn(process.execPath,["--input-type=module","-e",wrapperScript],{stdio:"ignore"});
    const wrapperExit=new Promise((resolve,reject)=>{wrapper.once("error",reject);wrapper.once("exit",(code,signal)=>resolve({code,signal}));});
    const ready=Date.now()+2000;
    owned=[];
    while(!owned.length && Date.now()<ready) {
      try{owned=JSON.parse(await readFile(marker,"utf8"));}catch{}
      if(!owned.length)await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(owned.length,2,"interrupt fixture must be ready");
    wrapper.kill("SIGINT");
    await new Promise(resolve=>setTimeout(resolve,30));
    wrapper.kill("SIGINT");
    assert.deepEqual(await wrapperExit,{code:7,signal:null},"repeated interrupts must wait for cleanup");
    for(const pid of owned) {
      let status="";
      try{status=(await promisify(execFile)("/bin/ps",["-p",String(pid),"-o","stat="])).stdout.trim();}catch{}
      assert.ok(!status || status.startsWith("Z"),`interrupted owned process ${pid} still running: ${status}`);
    }
    assert.doesNotThrow(()=>process.kill(unrelated.pid,0));
    console.log("Native smoke timeout, tagged and same-group fast exit, shutdown spawn, and repeated interrupts reclaimed owned descendants; unrelated processes preserved");
  } finally {
    for (const pid of owned) { try { process.kill(pid, "SIGKILL"); } catch {} }
    unrelated.kill("SIGKILL");
    await rm(scratch, { recursive: true, force: true });
  }
}

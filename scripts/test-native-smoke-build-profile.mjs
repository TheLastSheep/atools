import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { buildNativeSmokeWithProfile, nativeSmokeBuildPlan } from "./lib/native-smoke-process.mjs";

test("debug remains the default build profile and artifact location",()=>{
  const plan=nativeSmokeBuildPlan();
  assert.equal(plan.profile,"debug");
  assert.equal(plan.timeoutMs,180000);
  assert.deepEqual(plan.cargoArgs,["build","-p","atools","--example","legacy_node_desktop_smoke","--features","legacy-node-smoke","--offline"]);
  assert.equal(plan.artifactRelativePath,join("debug","examples","legacy_node_desktop_smoke"+(process.platform==="win32"?".exe":"")));
});

test("release selects Cargo release output without changing other build constraints",()=>{
  const plan=nativeSmokeBuildPlan("release");
  assert.equal(plan.profile,"release");
  assert.equal(plan.timeoutMs,600000);
  assert.deepEqual(plan.cargoArgs,["build","-p","atools","--example","legacy_node_desktop_smoke","--features","legacy-node-smoke","--offline","--release"]);
  assert.equal(plan.artifactRelativePath,join("release","examples","legacy_node_desktop_smoke"+(process.platform==="win32"?".exe":"")));
});

test("profile build passes only its fixed build deadline and records it in metadata",async()=>{
  for(const profile of ["debug","release"]) {
    const calls=[];
    const result=await buildNativeSmokeWithProfile("/private/test-workspace",{
      profile,
      runBuildProcess:async(...args)=>calls.push(args),
      readTargetDirectory:async()=>"/private/test-target",
    });
    const plan=nativeSmokeBuildPlan(profile);
    assert.equal(calls.length,1);
    assert.deepEqual(calls[0],["cargo",plan.cargoArgs,{cwd:"/private/test-workspace",timeoutMs:plan.timeoutMs}]);
    assert.equal(result.timeoutMs,plan.timeoutMs);
    assert.equal(result.executable,join("/private/test-target",plan.artifactRelativePath));
  }
});

test("unknown profiles fail closed before any build can be planned",()=>{
  for(const profile of ["", "optimized", "Release", "production", null]) {
    assert.throws(()=>nativeSmokeBuildPlan(profile),/profile must be debug or release/);
  }
});

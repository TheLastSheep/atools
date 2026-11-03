import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileDigest, verifiedNodeArchive, MAX_ARCHIVE_BYTES } from "./lib/node-runtime-archive.mjs";
import { prepareNodeRuntime } from "./lib/node-runtime-package.mjs";
import { inspectNodeRuntimeBundle, verifyPublisherSignatures } from "./lib/node-runtime-bundle.mjs";

const target="aarch64-apple-darwin";
async function fixture(run,{link=false}={}) {
  const root=await mkdtemp(join(tmpdir(),"atools-node-package-test-"));
  try {
    const folder="node-v22.23.3-darwin-arm64";
    await mkdir(join(root,folder,"bin"),{recursive:true});
    if(link)await symlink("../LICENSE",join(root,folder,"bin/node"));
    else await writeFile(join(root,folder,"bin/node"),Buffer.alloc(1024*1024,97));
    await writeFile(join(root,folder,"LICENSE"),"Test fixture license; fake binary must never execute");
    const archive=join(root,`${folder}.tar.gz`);
    await promisify(execFile)("tar",["-czf",archive,"-C",root,folder],{timeout:10000});
    const digest=value=>createHash("sha256").update(value).digest("hex");
    const pin={version:"v22.23.3",minimumMacOS:"11.0",targets:{[target]:{archive:`${folder}.tar.gz`,sha256:(await fileDigest(archive,MAX_ARCHIVE_BYTES)).sha256,
      binarySha256:digest(Buffer.alloc(1024*1024,97)),binaryBytes:1024*1024,
      licenseSha256:digest("Test fixture license; fake binary must never execute")}}};
    await run({root,archive,pin,target,destination:join(root,"output"),cacheDir:join(root,"cache")});
  } finally {await rm(root,{recursive:true,force:true});}
}

test("offline preparation copies only verified bytes, license and target metadata without executing input",async()=>fixture(async input=>{
  const result=await prepareNodeRuntime({...input,offline:true});
  assert.equal(result.version,input.pin.version);
  assert.equal(result.binaryBytes,1024*1024);
  assert.equal((await fileDigest(result.executable,2*1024*1024)).sha256,result.binarySha256);
  assert.equal((await readFile(join(input.destination,"node-runtime-metadata/NODE-LICENSE"),"utf8")),"Test fixture license; fake binary must never execute");
  const metadata=JSON.parse(await readFile(join(input.destination,`node-runtime-metadata/${target}.json`),"utf8"));
  assert.equal(metadata.archiveSha256,input.pin.targets[target].sha256);
}));

test("checksum mismatch never replaces an already prepared runtime",async()=>fixture(async input=>{
  const result=await prepareNodeRuntime(input);
  const pin=structuredClone(input.pin);pin.targets[target].sha256="0".repeat(64);
  await assert.rejects(prepareNodeRuntime({...input,pin}),/SHA-256 mismatch/);
  assert.equal((await fileDigest(result.executable,2*1024*1024)).sha256,result.binarySha256);
  for(const [field,value] of [["binarySha256","0".repeat(64)],["binaryBytes",1024*1024+1],["licenseSha256","0".repeat(64)]]) {
    const changed=structuredClone(input.pin);changed.targets[target][field]=value;
    await assert.rejects(prepareNodeRuntime({...input,pin:changed}),/trusted runtime pin/);
    assert.equal((await fileDigest(result.executable,2*1024*1024)).sha256,result.binarySha256);
  }
}));

test("offline cache misses never fetch, while a verified cache hit reuses exact bytes",async()=>fixture(async input=>{
  const options={...input,archive:undefined,offline:true,fetcher:()=>{throw Error("network must not run");}};
  await assert.rejects(verifiedNodeArchive(options),/absent from the offline cache/);
  await mkdir(input.cacheDir);
  await writeFile(join(input.cacheDir,input.pin.targets[target].archive),await readFile(input.archive));
  assert.equal(await verifiedNodeArchive(options),join(input.cacheDir,input.pin.targets[target].archive));
}));

test("downloads use fixed HTTPS origin and verify digest before publishing the cache",async()=>fixture(async input=>{
  let calls=0;
  const result=await verifiedNodeArchive({...input,archive:undefined,fetcher:async(url,options)=>{
    calls++;assert.equal(url,`https://nodejs.org/dist/${input.pin.version}/${input.pin.targets[target].archive}`);
    assert.equal(options.redirect,"error");assert.ok(options.signal);
    return new Response(await readFile(input.archive));
  }});
  assert.equal(calls,1);assert.equal((await fileDigest(result,MAX_ARCHIVE_BYTES)).sha256,input.pin.targets[target].sha256);
}));

test("oversized advertised downloads, redirects/errors, invalid targets and archive member links are rejected",async()=>fixture(async input=>{
  const remote={...input,archive:undefined};
  await assert.rejects(verifiedNodeArchive({...remote,fetcher:async()=>new Response("x",{headers:{"content-length":String(MAX_ARCHIVE_BYTES+1)}})}),/download budget/);
  await assert.rejects(verifiedNodeArchive({...remote,fetcher:async()=>new Response("missing",{status:404})}),/404/);
  await assert.rejects(verifiedNodeArchive({...input,target:"x86_64-unknown-linux-gnu"}),/invalid pinned runtime target/);
  const pin=structuredClone(input.pin);pin.targets[target].archive="../escape.tar.gz";
  await assert.rejects(verifiedNodeArchive({...input,pin}),/invalid pinned runtime target/);
}));

test("verified archives cannot publish a symlink as the Node executable",async()=>fixture(async input=>{
  await assert.rejects(prepareNodeRuntime(input),/regular file/);
},{link:true}));

test("bundle inspection binds target, OS profile, upstream bytes and license without executing a fixture",async()=>fixture(async input=>{
  const prepared=await prepareNodeRuntime(input),app=join(input.root,"Example.app");
  const bin=join(app,"Contents/MacOS/node"),resources=join(app,"Contents/Resources/runtime");
  await mkdir(join(app,"Contents/MacOS"),{recursive:true});await mkdir(resources,{recursive:true});
  const plist="<plist><dict><key>LSMinimumSystemVersion</key><string>11.0</string></dict></plist>";
  await writeFile(join(app,"Contents/Info.plist"),plist);await copyFile(prepared.executable,bin);
  for(const name of ["NODE-LICENSE",`${target}.json`])await copyFile(join(input.destination,"node-runtime-metadata",name),join(resources,name));
  const options={app,target,pin:input.pin};
  const result=await inspectNodeRuntimeBundle(options);
  assert.equal(result.passed,true);assert.equal(result.runtime,null);assert.match(result.scope,/Static/);
  await writeFile(bin,Buffer.alloc(1024*1024,98));
  await assert.rejects(inspectNodeRuntimeBundle(options),/bytes differ/);
  // The app's own metadata is not a trust anchor, even when altered together.
  const metadataPath=join(resources,`${target}.json`),originalMetadata=await readFile(metadataPath,"utf8");
  const changed=JSON.parse(originalMetadata);changed.binarySha256=(await fileDigest(bin,2*1024*1024)).sha256;
  await writeFile(metadataPath,JSON.stringify(changed));
  await assert.rejects(inspectNodeRuntimeBundle(options),/checked-in pin/);
  await writeFile(metadataPath,originalMetadata);await copyFile(prepared.executable,bin);
  await writeFile(join(app,"Contents/Info.plist"),plist.replace("11.0","10.15"));
  await assert.rejects(inspectNodeRuntimeBundle(options),/minimum macOS/);await writeFile(join(app,"Contents/Info.plist"),plist);
  await writeFile(join(resources,"NODE-LICENSE"),"wrong license");
  await assert.rejects(inspectNodeRuntimeBundle(options),/license checksum/);
}));

test("signed runtime verification requires the expected publisher on both app and Node",async()=>{
  let calls=[];
  const run=async(command,args)=>{calls.push([command,...args]);return {stderr:"TeamIdentifier=ABCDEFGHIJ\n",stdout:""};};
  await verifyPublisherSignatures("/fixture/App.app","/fixture/node","ABCDEFGHIJ",run);
  assert.equal(calls.length,4);
  await assert.rejects(verifyPublisherSignatures("/fixture/App.app","/fixture/node",undefined,run),/explicit valid/);
  for(const team of ["not set","ZZZZZZZZZZ",""]) {
    await assert.rejects(verifyPublisherSignatures("/fixture/App.app","/fixture/node","ABCDEFGHIJ",async()=>({stderr:`TeamIdentifier=${team}\n`})),/expected Apple Team ID/);
  }
  let displays=0;
  await assert.rejects(verifyPublisherSignatures("/fixture/App.app","/fixture/node","ABCDEFGHIJ",async(_,args)=>{
    return {stderr:args[0]==="--display"?`TeamIdentifier=${++displays===1?"ABCDEFGHIJ":"ZZZZZZZZZZ"}\n`:""};
  }),/expected Apple Team ID/);
});

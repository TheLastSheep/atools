import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const MAX_ARCHIVE_BYTES=80*1024*1024;

export async function fileDigest(file,maxBytes) {
  const info=await lstat(file);
  if(!info.isFile() || info.size>maxBytes)throw new Error("Runtime artifact is not a bounded regular file");
  const hash=createHash("sha256");let bytes=0;
  for await(const chunk of createReadStream(file)) {
    bytes+=chunk.length;
    if(bytes>maxBytes)throw new Error("Runtime artifact exceeded byte budget");
    hash.update(chunk);
  }
  return {sha256:hash.digest("hex"),bytes};
}

export async function verifiedNodeArchive({pin,target,cacheDir,archive,offline=false,fetcher=fetch}) {
  const selected=pin.targets[target];
  if(!["aarch64-apple-darwin","x86_64-apple-darwin"].includes(target) || !selected || !/^v22\.\d+\.\d+$/.test(pin.version)
      || !/^node-v22\.\d+\.\d+-darwin-(arm64|x64)\.tar\.gz$/.test(selected.archive)
      || !/^[a-f\d]{64}$/.test(selected.sha256))throw new Error("Unsupported or invalid pinned runtime target");
  const expected=`node-${pin.version}-darwin-${target==="aarch64-apple-darwin"?"arm64":"x64"}.tar.gz`;
  if(selected.archive!==expected)throw new Error("Runtime archive does not match the pinned target/version");
  const verify=async(file)=>{
    const info=await fileDigest(file,MAX_ARCHIVE_BYTES);
    if(info.sha256!==selected.sha256)throw new Error("Pinned Node archive SHA-256 mismatch");
    return file;
  };
  if(archive)return verify(archive);
  const destination=join(cacheDir,selected.archive);
  try{return await verify(destination);}catch(error){if(error.code!=="ENOENT")throw error;}
  if(offline)throw new Error("Pinned Node archive is absent from the offline cache");
  await mkdir(cacheDir,{recursive:true});
  const temporary=join(cacheDir,`.node-${randomUUID()}.download`);
  try {
    const url=`https://nodejs.org/dist/${pin.version}/${selected.archive}`;
    const response=await fetcher(url,{redirect:"error",signal:AbortSignal.timeout(60000)});
    if(!response.ok || !response.body)throw new Error(`Official Node download failed (${response.status})`);
    const length=Number(response.headers.get("content-length"));
    if(length>MAX_ARCHIVE_BYTES)throw new Error("Node archive exceeds download budget");
    let bytes=0;
    const bound=new Transform({transform(chunk,encoding,done){bytes+=chunk.length;done(bytes>MAX_ARCHIVE_BYTES?new Error("Node archive exceeds download budget"):null,chunk);}});
    await pipeline(Readable.fromWeb(response.body),bound,createWriteStream(temporary,{flags:"wx",mode:0o600}));
    await verify(temporary);
    await rename(temporary,destination);
    return destination;
  } finally {await rm(temporary,{force:true});}
}

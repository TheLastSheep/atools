import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileDigest, verifiedNodeArchive } from "./node-runtime-archive.mjs";

export const MAX_NODE_BYTES=160*1024*1024;

/** Stage official, checksum-pinned bytes only. Never execute an input binary. */
export async function prepareNodeRuntime({pin,target,destination,cacheDir,archive,offline=false,fetcher}) {
  const verified=await verifiedNodeArchive({pin,target,cacheDir,archive,offline,fetcher});
  const scratch=await mkdtemp(join(tmpdir(),"atools-node-package-"));
  const canonicalScratch=await realpath(scratch);
  const prefix=pin.targets[target].archive.replace(/\.tar\.gz$/,"");
  const id=randomUUID();
  await mkdir(destination,{recursive:true});
  const staged=join(destination,`.node-${id}`);
  try {
    await promisify(execFile)("tar",["-xzf",verified,"-C",scratch,"--",`${prefix}/bin/node`,`${prefix}/LICENSE`],{timeout:30000,maxBuffer:128*1024});
    const safeFile=async(name,maxBytes)=>{
      const file=join(scratch,prefix,name);
      if(!(await lstat(file)).isFile())throw new Error("Node archive member must be a regular file");
      const canonical=await realpath(file), location=relative(canonicalScratch,canonical);
      if(location===".." || location.startsWith(`..${sep}`))throw new Error("Node archive member escaped staging directory");
      return {file,info:await fileDigest(file,maxBytes)};
    };
    const binary=await safeFile("bin/node",MAX_NODE_BYTES);
    const license=await safeFile("LICENSE",5*1024*1024);
    if(binary.info.bytes<1024*1024)throw new Error("Pinned Node binary is unexpectedly small");
    const expected=pin.targets[target];
    if(binary.info.sha256!==expected.binarySha256 || binary.info.bytes!==expected.binaryBytes || license.info.sha256!==expected.licenseSha256) {
      throw new Error("Extracted Node binary/license does not match the trusted runtime pin");
    }
    const executable=join(destination,`node-${target}`);
    await copyFile(binary.file,staged);await chmod(staged,0o755);
    const metadata={version:pin.version,target,minimumMacOS:pin.minimumMacOS,
      archive:pin.targets[target].archive,archiveSha256:pin.targets[target].sha256,
      binarySha256:binary.info.sha256,binaryBytes:binary.info.bytes,licenseSha256:license.info.sha256,
      provenance:`https://nodejs.org/dist/${pin.version}/${pin.targets[target].archive}`};
    const metadataDir=join(destination,"node-runtime-metadata");
    await mkdir(metadataDir,{recursive:true});
    // Publish only after both selected archive members and their bounds passed.
    await rename(staged,executable);
    await writeFile(join(metadataDir,"NODE-LICENSE"),await readFile(license.file));
    await writeFile(join(metadataDir,`${target}.json`),JSON.stringify(metadata,null,2)+"\n");
    return {executable,...metadata};
  } finally {await rm(staged,{force:true});await rm(scratch,{recursive:true,force:true});}
}

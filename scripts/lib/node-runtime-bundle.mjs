import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileDigest } from "./node-runtime-archive.mjs";
import { MAX_NODE_BYTES } from "./node-runtime-package.mjs";

/** Validity alone accepts ad-hoc or an unrelated publisher's signature. */
export async function verifyPublisherSignatures(app, binary, expectedTeamId, run = promisify(execFile)) {
  if (typeof expectedTeamId !== "string" || !/^[A-Z0-9]{10}$/.test(expectedTeamId)) throw new Error("Signed runtime verification requires an explicit valid expected Apple Team ID");
  await run("codesign", ["--verify", "--deep", "--strict", app], { timeout: 10000, maxBuffer: 1024 * 1024 });
  await run("codesign", ["--verify", "--strict", binary], { timeout: 10000, maxBuffer: 1024 * 1024 });
  for (const file of [app, binary]) {
    const { stderr, stdout } = await run("codesign", ["--display", "--verbose=4", file], { timeout: 10000, maxBuffer: 1024 * 1024 });
    const teams = [...(`${stderr || ""}\n${stdout || ""}`).matchAll(/^TeamIdentifier=([^\r\n]+)$/gm)].map(match => match[1]);
    if (teams.length !== 1 || teams[0] !== expectedTeamId) throw new Error("Packaged app and Node must both be signed by the expected Apple Team ID");
  }
}

/** Inspect only unless execute is explicitly requested; never starts ATools. */
export async function inspectNodeRuntimeBundle({app,target,pin,execute=false,verifySigned=false,expectedTeamId}) {
  const selected=pin.targets[target];
  if(!selected)throw new Error("Unsupported packaged Node target");
  if (!/^[a-f\d]{64}$/.test(selected.binarySha256 || "") || !/^[a-f\d]{64}$/.test(selected.licenseSha256 || "")
      || !Number.isSafeInteger(selected.binaryBytes) || selected.binaryBytes < 1024 * 1024 || selected.binaryBytes > MAX_NODE_BYTES) {
    throw new Error("Trusted runtime pin is missing binary/license provenance");
  }
  if (verifySigned && (typeof expectedTeamId !== "string" || !/^[A-Z0-9]{10}$/.test(expectedTeamId))) throw new Error("Signed runtime verification requires an explicit valid expected Apple Team ID");
  if (expectedTeamId && !verifySigned) throw new Error("An expected Apple Team ID requires signature verification");
  const resources=join(app,"Contents/Resources/runtime");
  const metadata=JSON.parse(await readFile(join(resources,`${target}.json`),"utf8"));
  if(metadata.target!==target || metadata.version!==pin.version || metadata.archive!==selected.archive
      || metadata.archiveSha256!==selected.sha256 || metadata.minimumMacOS!==pin.minimumMacOS
      || metadata.binarySha256!==selected.binarySha256 || metadata.binaryBytes!==selected.binaryBytes
      || metadata.licenseSha256!==selected.licenseSha256) {
    throw new Error("Packaged Node metadata does not match the checked-in pin");
  }
  const plist=await readFile(join(app,"Contents/Info.plist"),"utf8");
  const minimum=/<key>LSMinimumSystemVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  if(minimum!==pin.minimumMacOS)throw new Error("Packaged app minimum macOS version does not match runtime profile");
  const binary=join(app,"Contents/MacOS/node");
  const actual=await fileDigest(binary,MAX_NODE_BYTES);
  if(actual.bytes<1024*1024 || Math.abs(actual.bytes-selected.binaryBytes)>1024*1024)throw new Error("Packaged Node executable size is invalid");
  const license=await fileDigest(join(resources,"NODE-LICENSE"),5*1024*1024);
  if(license.sha256!==selected.licenseSha256)throw new Error("Packaged Node license checksum mismatch");
  if(verifySigned) {
    if(process.platform!=="darwin")throw new Error("Apple signature verification requires macOS");
    await verifyPublisherSignatures(app, binary, expectedTeamId);
  } else if(actual.sha256!==selected.binarySha256 || actual.bytes!==selected.binaryBytes) {
    throw new Error("Packaged Node bytes differ from the verified upstream binary; signed bundles require --verify-signature");
  }
  let runtime=null;
  if(execute) {
    const script="process.stdout.write(JSON.stringify({version:process.version,arch:process.arch,platform:process.platform,sha256:require('node:crypto').createHash('sha256').update('abc').digest('hex')}))";
    const {stdout}=await promisify(execFile)(binary,["-e",script],{
      env:{PATH:"/usr/bin:/bin",LANG:"C"},timeout:5000,maxBuffer:4096,
    });
    runtime=JSON.parse(stdout);
    const expectedArch=target==="aarch64-apple-darwin"?"arm64":"x64";
    if(runtime.version!==pin.version || runtime.platform!=="darwin" || runtime.arch!==expectedArch
        || runtime.sha256!=="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")throw new Error("Packaged Node failed its actual runtime probe");
  }
  return {passed:true,scope:execute?"Packaged Node metadata/license/signature-or-upstream-bytes and exact binary execution; ATools is not launched":"Static packaged Node inspection only",
    version:metadata.version,target,minimumMacOS:metadata.minimumMacOS,binaryBytes:actual.bytes,
    upstreamBinarySha256:selected.binarySha256,packagedBinarySha256:actual.sha256,
    signingChangedBytes:actual.sha256!==selected.binarySha256,signatureVerified:verifySigned,expectedTeamId:verifySigned?expectedTeamId:null,
    licenseVerified:true,runtime};
}
